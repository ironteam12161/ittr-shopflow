import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

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
 console.log('Account security integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
