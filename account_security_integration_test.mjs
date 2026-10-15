import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import http from 'node:http';
import {totpCode,totpStep} from './security_mfa.mjs';

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'&&process.env.ITTR_OPERATIONS_TEST_DB!=='1'){console.log('SKIP account security integration test: disposable DB flag is not enabled');process.exit(0)}
const url=String(process.env.DATABASE_URL||'');if(!url)throw new Error('DATABASE_URL is required');
const {Pool}=pg,schema=`ittr_acctsec_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g,''),bootstrap=new Pool({connectionString:url,ssl:false});
await bootstrap.query(`CREATE SCHEMA ${schema}`);await bootstrap.end();
const db=new Pool({connectionString:url,ssl:false,options:`-c search_path=${schema}`});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let child=null,port=0,output='';
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.unref();s.once('error',reject);s.listen({host:'127.0.0.1',port:0},()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p))})})}
async function request(path,{method='GET',token,body,allowError=false}={}){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}if(!r.ok&&!allowError)throw new Error(`${method} ${path} -> ${r.status}: ${text}`);return {status:r.status,...data}}
async function start(){port=await freePort();child=spawn(process.execPath,['server.js'],{env:{...process.env,PGOPTIONS:`-c search_path=${schema}`,PORT:String(port),NODE_ENV:'test',BOOTSTRAP_ADMIN_USERNAME:'opsadmin',BOOTSTRAP_ADMIN_PASSWORD:'CI-Ops-Admin-2026!',OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',SAMSARA_API_TOKEN:''},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);for(let i=0;i<150;i++){if(child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${output}`);try{const h=await request('/api/health');if(h.ok&&h.db)return}catch{}await sleep(100)}throw new Error(`server did not start\n${output}`)}
async function stop(){if(child&&child.exitCode==null){child.kill('SIGTERM');await sleep(150);if(child.exitCode==null)child.kill('SIGKILL')}child=null}
function ok(v,msg){if(!v)throw new Error(msg)}function eq(a,b,msg){if(a!==b)throw new Error(`${msg}: expected ${b}, got ${a}`)}

try{
 await start();
 const login=async(u,p)=>(await request('/api/auth/login',{method:'POST',body:{username:u,password:p},allowError:true}));
 const a1=(await login('opsadmin','CI-Ops-Admin-2026!')).token,a2=(await login('opsadmin','CI-Ops-Admin-2026!')).token;ok(a1&&a2,'owner signs in on two devices');
 eq((await request('/api/auth/sessions',{token:a1})).others,1,'owner sees one other device');
 const pw=body=>request('/api/auth/password',{method:'POST',token:a1,body,allowError:true});
 eq((await pw({currentPassword:'wrong-password',newPassword:'Brand-New-Owner-Pass-1'})).code,'BAD_CURRENT_PASSWORD','wrong current password refused');
 eq((await pw({currentPassword:'CI-Ops-Admin-2026!',newPassword:'short'})).status,400,'owner password needs 12+ characters');
 eq((await pw({currentPassword:'CI-Ops-Admin-2026!',newPassword:'opsadmin-long-password'})).status,400,'password may not contain the username');
 const ch=await pw({currentPassword:'CI-Ops-Admin-2026!',newPassword:'Brand-New-Owner-Pass-1'});eq(ch.otherSessionsSignedOut,1,'changing the password signs out the other device');
 eq((await request('/api/auth/me',{token:a2,allowError:true})).status,401,'the other device is signed out');
 ok((await request('/api/auth/me',{token:a1})).user.username==='opsadmin','this device stays signed in');
 eq((await login('opsadmin','CI-Ops-Admin-2026!')).status,401,'old password no longer works');
 const a3=(await login('opsadmin','Brand-New-Owner-Pass-1')).token;ok(a3,'new password works');
 eq((await request('/api/auth/sessions/revoke-others',{method:'POST',token:a1,body:{}})).signedOut,1,'sign out other devices');
 eq((await request('/api/auth/me',{token:a3,allowError:true})).status,401,'revoked device is signed out');
 await request('/api/admin/users',{method:'POST',token:a1,body:{username:'mech1',display:'Mech One',password:'Mechanic-Pass-1'}});
 const m=(await login('mech1','Mechanic-Pass-1')).token;
 eq((await request('/api/auth/password',{method:'POST',token:m,body:{currentPassword:'Mechanic-Pass-1',newPassword:'Shop-Floor-22'}})).ok,true,'a mechanic changes their own password (10+ characters)');
 console.log('PASS account security: own password change (checks, other devices signed out), sign out other devices, mechanic self-service');
 eq((await request('/api/admin/backup',{token:m,allowError:true})).status,403,'mechanics cannot download the backup');
 await db.query(`INSERT INTO customer_invoices(invoice_number,customer_name,status,invoice_date,created_by) VALUES('BK-1','Backup Fleet','sent',CURRENT_DATE,'test')`);
 const r=await fetch(`http://127.0.0.1:${port}/api/admin/backup`,{headers:{Authorization:`Bearer ${a1}`}});ok(r.ok&&/attachment/.test(r.headers.get('content-disposition')||''),'backup downloads as a file');
 const b=JSON.parse(await r.text());
 ok(b.format==='ittr-full-backup-v2'&&b.tables.customer_invoices?.some(x=>x.invoice_number==='BK-1'),'backup includes invoices');
 for(const t of ['customer_invoice_payments','customer_payments','parts_vendor_invoices','fullbay_import_customers','app_state','mechanic_shifts'])ok(Array.isArray(b.tables[t]),`backup includes ${t}`);
 ok(!('auth_sessions' in b.tables)&&!('gmail_oauth_states' in b.tables),'sign-in sessions are not in the backup');
 ok(b.tables.auth_users.every(u=>u.password_hash==='[removed]'),'password hashes are not in the backup');
 ok(Object.keys(b.tables).length>=40&&b.rowCounts.customer_invoices>=1,`backup covers the whole database (${Object.keys(b.tables).length} tables)`);
 console.log(`PASS full backup: ${Object.keys(b.tables).length} tables, secrets removed, owner only`);
 // v24.53.0: 2-step login. A fresh server process starts with a fresh per-network login counter.
 await stop();await start();
 const OWNER_PW='Brand-New-Owner-Pass-1';
 eq((await request('/api/auth/2fa',{token:a1})).enabled,false,'2-step login starts off');
 eq((await request('/api/auth/2fa/setup',{method:'POST',token:a1,body:{password:'nope'},allowError:true})).code,'BAD_PASSWORD','setup needs the password');
 const su=await request('/api/auth/2fa/setup',{method:'POST',token:a1,body:{password:OWNER_PW}});ok(/^otpauth:\/\/totp\//.test(su.uri)&&su.qrSvg.startsWith('<svg'),'setup returns a QR code for the authenticator app');
 const secret=su.secret.replace(/\s/g,'');
 eq((await request('/api/auth/2fa/enable',{method:'POST',token:a1,body:{code:'000000'===totpCode(secret,totpStep())?'111111':'000000'},allowError:true})).code,'BAD_CODE','wrong code does not turn it on');
 const a4=(await login('opsadmin',OWNER_PW)).token;
 const en=await request('/api/auth/2fa/enable',{method:'POST',token:a1,body:{code:totpCode(secret,totpStep())}});
 eq(en.recoveryCodes.length,10,'ten recovery codes');ok(en.otherSessionsSignedOut>=1,'turning it on signs out other devices');
 eq((await request('/api/auth/me',{token:a4,allowError:true})).status,401,'a device signed in before 2-step login was turned on must sign in again');
 eq((await request('/api/auth/me',{token:a1})).user.mfa,true,'account shows 2-step login on');
 const pwOnly=await login('opsadmin',OWNER_PW);ok(pwOnly.mfaRequired===true&&!pwOnly.token,'the password alone gives no access, only a request for the code');
 eq((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:OWNER_PW,code:'123456'===totpCode(secret,totpStep())?'654321':'123456'},allowError:true})).code,'BAD_CODE','wrong code refused');
 const nextCode=totpCode(secret,totpStep()+1);
 ok((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:OWNER_PW,code:nextCode}})).token,'password + code signs in');
 eq((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:OWNER_PW,code:nextCode},allowError:true})).status,401,'the same code cannot be used twice');
 const rc=en.recoveryCodes[0],viaRc=await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:OWNER_PW,code:rc.toUpperCase()}});
 ok(viaRc.token&&viaRc.recoveryLeft===9,'a recovery code works once and says how many are left');
 await stop();await start();
 eq((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:OWNER_PW,code:rc},allowError:true})).status,401,'a used recovery code does not work again');
 const nc=await request('/api/auth/2fa/recovery-codes',{method:'POST',token:a1,body:{password:OWNER_PW}});eq(nc.recoveryCodes.length,10,'new recovery codes replace the old ones');
 ok((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:OWNER_PW,code:en.recoveryCodes[1]},allowError:true})).status===401,'old recovery codes stop working');
 const bk=JSON.parse(await (await fetch(`http://127.0.0.1:${port}/api/admin/backup`,{headers:{Authorization:`Bearer ${a1}`}})).text());
 ok(bk.tables.auth_users.every(u=>u.totp_secret==='[removed]'&&u.totp_recovery==='[removed]'),'2-step secrets are not in the backup');
 // Manager lost their phone: the owner resets it.
 await request('/api/admin/managers',{method:'POST',token:a1,body:{username:'mgr1',display:'Manager One',password:'Manager-Pass-2026',permissions:{invoices:true}}});
 const mg=(await login('mgr1','Manager-Pass-2026')).token,ms=(await request('/api/auth/2fa/setup',{method:'POST',token:mg,body:{password:'Manager-Pass-2026'}})).secret.replace(/\s/g,'');
 await request('/api/auth/2fa/enable',{method:'POST',token:mg,body:{code:totpCode(ms,totpStep())}});
 ok((await login('mgr1','Manager-Pass-2026')).mfaRequired,'manager now needs a code');
 ok((await request('/api/admin/managers',{token:a1})).items.find(x=>x.username==='mgr1').totp_enabled===true,'owner sees the manager has 2-step login');
 await request('/api/admin/managers/mgr1/2fa',{method:'DELETE',token:a1});
 ok((await login('mgr1','Manager-Pass-2026')).token,'after the owner resets it, the manager signs in with the password and sets it up again');
 eq((await request('/api/auth/2fa/disable',{method:'POST',token:a1,body:{password:OWNER_PW,code:'000000'},allowError:true})).code,'BAD_CODE','turning it off needs a valid code');
 eq((await request('/api/auth/2fa/disable',{method:'POST',token:a1,body:{password:OWNER_PW,code:nc.recoveryCodes[0]}})).ok,true,'turned off with password + recovery code');
 ok((await login('opsadmin',OWNER_PW)).token,'password alone works again once it is off');
 console.log('PASS 2-step login: QR setup, code required, no replay, recovery codes once, new codes, owner reset for a manager, turn off, kept out of the backup');
 // Manager permissions are "denied unless ticked".
 const mgt=(await login('mgr1','Manager-Pass-2026')).token;
 eq((await request('/api/admin/managers',{token:a1})).items.find(x=>x.username==='mgr1').permissions.reports,false,'unticked areas are saved as off');
 ok((await request('/api/invoices',{token:mgt,allowError:true})).status!==403,'manager can open a ticked area');
 eq((await request('/api/admin/server-audit',{token:mgt,allowError:true})).status,403,'manager cannot open an area that was not ticked (Reports)');
 await db.query(`UPDATE auth_users SET permissions='{"invoices":true,"brandNewArea":true}'::jsonb WHERE username='mgr1'`);
 eq((await request('/api/parts/inventory-count/current',{token:mgt,allowError:true})).status,403,'an area missing from the saved permissions is denied');
 console.log('PASS manager permissions: denied unless ticked');
 // Account lock after repeated wrong passwords (fresh server, so the per-network limit is not what stops it).
 await stop();await start();
 for(let i=0;i<8;i++)await request('/api/auth/login',{method:'POST',body:{username:'mech1',password:`wrong-${i}`},allowError:true});
 await stop();await start();
 const locked=await request('/api/auth/login',{method:'POST',body:{username:'mech1',password:'Shop-Floor-22'},allowError:true});
 ok(locked.status===429&&locked.code==='ACCOUNT_LOCKED','8 wrong passwords lock the account, even for the right password, for 15 minutes');
 await db.query("UPDATE auth_users SET locked_until=now()-interval '1 second' WHERE username='mech1'");
 ok((await login('mech1','Shop-Floor-22')).token,'the account opens again after the lock time');
 eq((await request('/api/auth/login',{method:'POST',body:{username:'nobody-here',password:'x'},allowError:true})).status,401,'unknown username gives the same answer as a wrong password');
 console.log('PASS sign-in lock: 8 wrong attempts lock the account for 15 minutes, then it opens');
 // Managers saved before v24.53.0 keep what they had: all areas not unticked, Employees only where ticked.
 await db.query(`INSERT INTO auth_users(username,display_name,password_hash,role,permissions) VALUES('oldmgr1','Old 1','x','manager','{}'::jsonb),('oldmgr2','Old 2','x','manager','{"reports":false,"employees":true}'::jsonb)`);
 await db.query("DELETE FROM shop_settings WHERE setting_key='manager_permissions_default_deny'");
 await stop();await start();
 const pm=Object.fromEntries((await db.query("SELECT username,permissions FROM auth_users WHERE username IN ('oldmgr1','oldmgr2')")).rows.map(r=>[r.username,r.permissions]));
 ok(pm.oldmgr1.invoices===true&&pm.oldmgr1.inventory===true&&pm.oldmgr1.reports===true&&pm.oldmgr1.employees===false,'old manager with no settings keeps every area except Employees');
 ok(pm.oldmgr2.reports===false&&pm.oldmgr2.employees===true&&pm.oldmgr2.customers===true,'old manager keeps their unticked and ticked areas');
 await stop();await start();
 eq((await db.query("SELECT count(*)::int n FROM shop_settings WHERE setting_key='manager_permissions_default_deny'")).rows[0].n,1,'the carry-over runs only once');
 console.log('PASS manager permissions carry-over: existing managers keep their access, runs once');
 // Live status connection: token in the first message, not in the address.
 const {WebSocket:WS}=await import('ws');
 const live=await new Promise((resolve,reject)=>{const w=new WS(`ws://127.0.0.1:${port}/ws/shop-status`);w.on('open',()=>w.send(JSON.stringify({type:'auth',token:a1})));w.on('message',d=>{resolve(JSON.parse(String(d)).type);w.close()});w.on('error',reject);setTimeout(()=>reject(new Error('live socket timeout')),5000)});
 eq(live,'connected','live connection signs in with the token in the first message');
 const refused=await new Promise(resolve=>{const w=new WS(`ws://127.0.0.1:${port}/ws/shop-status`);w.on('open',()=>w.send(JSON.stringify({type:'auth',token:'bogus'})));w.on('close',code=>resolve(code));setTimeout(()=>resolve(0),5000)});
 eq(refused,1008,'a bad token is refused');
 console.log('PASS live connection: token sent in the first message, bad token refused');
 // v24.57.0: email codes + remembered devices (fake Resend).
 const mails=[];const fakeMail=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{mails.push(JSON.parse(b));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:`m${mails.length}`}))})});
 await new Promise(r=>fakeMail.listen(0,'127.0.0.1',r));
 Object.assign(process.env,{RESEND_API_KEY:'re_test',INVOICE_FROM_EMAIL:'ShopFlow <shop@ironttr.test>',RESEND_API_URL:`http://127.0.0.1:${fakeMail.address().port}/emails`});
 await stop();await start();
 const PW='Brand-New-Owner-Pass-1',codeOf=m=>String(m.subject).match(/^(\d{3}) (\d{3})/).slice(1).join(''),older=()=>db.query("UPDATE mfa_email_codes SET created_at=created_at-interval '1 minute'");
 const o1=(await login('opsadmin',PW)).token;ok(o1,'owner signs in with the password only (2-step was turned off)');
 eq((await request('/api/auth/2fa/email/setup',{method:'POST',token:o1,body:{password:'nope',email:'owner@gmail.test'},allowError:true})).code,'BAD_PASSWORD','email setup needs the password');
 eq((await request('/api/auth/2fa/email/setup',{method:'POST',token:o1,body:{password:PW,email:'not-an-email'},allowError:true})).status,400,'bad email refused');
 const es=await request('/api/auth/2fa/email/setup',{method:'POST',token:o1,body:{password:PW,email:'Owner@Gmail.test'}});
 ok(es.sentTo==='ow•••@gmail.test'&&mails.length===1&&mails[0].to[0]==='owner@gmail.test'&&/sign-in code/.test(mails[0].subject),'a confirmation code is emailed and the address is masked on screen');
 eq((await request('/api/auth/2fa/email/setup',{method:'POST',token:o1,body:{password:PW,email:'owner@gmail.test'},allowError:true})).status,429,'no second code within 30 seconds');
 eq((await request('/api/auth/2fa/email/enable',{method:'POST',token:o1,body:{code:codeOf(mails[0])==='000000'?'111111':'000000'},allowError:true})).code,'BAD_CODE','wrong code does not turn it on');
 const ee=await request('/api/auth/2fa/email/enable',{method:'POST',token:o1,body:{code:codeOf(mails[0])}});ok(ee.ok&&ee.recoveryCodes.length===10,'email 2-step login on, with recovery codes');
 ok((await db.query("SELECT 1 FROM mfa_email_codes WHERE code_hash LIKE '%' AND code_hash !~ '^[0-9]{6}$'")).rowCount>=1,'codes are stored only as hashes');
 await older();const l1=await login('opsadmin',PW);ok(l1.mfaRequired&&l1.method==='email'&&l1.sentTo==='ow•••@gmail.test'&&!l1.token&&mails.length===2,'password alone emails a sign-in code and gives no access');
 eq((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW,code:codeOf(mails[1])==='999999'?'888888':'999999'},allowError:true})).code,'BAD_CODE','wrong emailed code refused');
 const l2=await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW,code:codeOf(mails[1]),rememberDevice:true}});ok(l2.token&&/^[A-Za-z0-9_-]{40,}$/.test(l2.deviceToken)&&l2.deviceDays===30,'right code signs in and remembers the device');
 eq((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW,code:codeOf(mails[1])},allowError:true})).status,401,'an emailed code works only once');
 const n0=mails.length,l3=await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW,deviceToken:l2.deviceToken}});ok(l3.token&&mails.length===n0,'remembered device signs in with the password only, no email sent');
 ok((await request('/api/auth/login',{method:'POST',body:{username:'nobody-here',password:PW,deviceToken:l2.deviceToken},allowError:true})).status===401,'a device key never helps another account');
 await older();ok((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW,deviceToken:'x'.repeat(43)}})).mfaRequired,'unknown device still needs the code');
 await db.query("UPDATE mfa_email_codes SET expires_at=now()-interval '1 second' WHERE used_at IS NULL");
 eq((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW,code:codeOf(mails.at(-1))},allowError:true})).code,'BAD_CODE','an expired code is refused');
 eq((await request('/api/auth/devices',{token:l2.token})).items.length,1,'remembered devices are listed');
 eq((await request('/api/auth/2fa',{token:l2.token})).rememberedDevices,1,'2-step status shows the remembered device');
 await stop();await start();
 const PW2='Brand-New-Owner-Pass-2';await request('/api/auth/password',{method:'POST',token:l2.token,body:{currentPassword:PW,newPassword:PW2}});
 await older();ok((await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW2,deviceToken:l2.deviceToken}})).mfaRequired,'changing the password forgets remembered devices');
 const l4=await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:PW2,code:ee.recoveryCodes[0],rememberDevice:true}});ok(l4.token&&l4.deviceToken,'recovery code works with email codes too');
 eq((await request('/api/auth/devices',{method:'DELETE',token:l4.token})).forgotten,1,'forget remembered devices');
 eq((await request('/api/auth/2fa/disable',{method:'POST',token:l4.token,body:{password:PW2,code:ee.recoveryCodes[1]}})).ok,true,'turned off with password + recovery code');
 ok((await login('opsadmin',PW2)).token,'password alone works once 2-step login is off');
 fakeMail.close();for(const k of ['RESEND_API_KEY','INVOICE_FROM_EMAIL','RESEND_API_URL'])delete process.env[k];
 console.log('PASS email sign-in codes: confirm address, 30-second resend limit, code once/expires, hashed, remember device 30 days (password only, no email), wrong/foreign device keys refused, password change forgets devices, recovery codes, turn off');
 console.log('Account security integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
