import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import http from 'node:http';
import {twilioSignature} from './customer_sms.mjs';
import {findComebacks,unitKey} from './warranty.mjs';
import {totpCode,totpStep} from './security_mfa.mjs';

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'&&process.env.ITTR_OPERATIONS_TEST_DB!=='1'){console.log('SKIP shop features integration test: disposable DB flag is not enabled');process.exit(0)}
const url=String(process.env.DATABASE_URL||'');if(!url)throw new Error('DATABASE_URL is required');
const {Pool}=pg,schema=`ittr_shopfeat_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g,''),bootstrap=new Pool({connectionString:url,ssl:false});
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
 const owner=(await login('opsadmin','CI-Ops-Admin-2026!')).token;ok(owner,'owner signs in');
 await request('/api/admin/users',{method:'POST',token:owner,body:{username:'mech1',display:'Mech One',password:'Mechanic-Pass-1'}});
 const mech=(await login('mech1','Mechanic-Pass-1')).token;
 await request('/api/admin/managers',{method:'POST',token:owner,body:{username:'mgr0',display:'Manager Zero',password:'Manager-Pass-2026',permissions:{invoices:true}}});const mgt0=(await login('mgr0','Manager-Pass-2026')).token;
 // ---------------------------------------------------------------- canned jobs
 const pad=(await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,cost,price,status,inventory_managed,raw) VALUES('cj-pad','BP-100','Brake pad set',8,40,95,'Active',true,'{}'::jsonb) RETURNING id`)).rows[0].id;
 const cj=(await request('/api/canned-jobs',{method:'POST',token:owner,body:{name:'Front brakes',category:'Brakes',lines:[{lineType:'labor',description:'Replace front brake pads',quantity:2,unitPrice:135},{lineType:'part',description:'Brake pad set',partNumber:'bp-100',quantity:1,unitPrice:90,taxable:true},{lineType:'fee',description:'Shop supplies',quantity:1,unitPrice:15}]}})).item;
 eq(cj.lines.length,3,'canned job saved with its lines');eq(cj.total,375,'canned job total');
 eq(Number(cj.lines[1].inventoryPartId),Number(pad),'typed part number is linked to the stock part');eq(cj.lines[1].currentPrice,95,'today\'s stock price is shown');
 eq((await request('/api/canned-jobs',{method:'POST',token:owner,body:{name:'front BRAKES',lines:[{lineType:'labor',description:'x'}]},allowError:true})).status,409,'duplicate name refused');
 eq((await request('/api/canned-jobs',{method:'POST',token:owner,body:{name:'Empty',lines:[]},allowError:true})).status,400,'a canned job needs lines');
 eq((await request('/api/canned-jobs',{token:mech,allowError:true})).status,403,'mechanics do not manage canned jobs');
 ok((await request('/api/canned-jobs?q=brak',{token:owner})).items.some(x=>x.id===cj.id),'search finds it');
 // Apply the way the screen does: labor first, then the rest under it.
 const est=await request('/api/estimates',{method:'POST',token:owner,body:{customerName:'Canned Fleet',unitNumber:'12'}});const estId=est.estimate?.id||est.id;
 let parent=null;for(const l of [cj.lines[0],cj.lines[1],cj.lines[2]]){const d=await request(`/api/estimates/${estId}/lines`,{method:'POST',token:owner,body:{lineType:l.lineType,description:l.description,partNumber:l.partNumber,quantity:l.quantity,unitPrice:l.currentPrice??l.unitPrice,taxable:l.taxable,inventoryPartId:l.inventoryPartId,jobName:cj.name,...(l.lineType!=='labor'&&parent?{parentLineId:parent}:{})}});if(l.lineType==='labor')parent=d.id}
 await request(`/api/canned-jobs/${cj.id}/used`,{method:'POST',token:owner,body:{}});
 const eb=await request(`/api/estimates/${estId}`,{token:owner});
 ok(eb.lines.length===3&&eb.lines.every(l=>l.job_name==='Front brakes'),'all lines land under one job on the estimate');eq(Number(eb.estimate.subtotal),380,'estimate subtotal uses today\'s part price');
 eq((await request('/api/canned-jobs',{token:owner})).items.find(x=>x.id===cj.id).useCount,1,'use is counted');
 await request(`/api/canned-jobs/${cj.id}`,{method:'PUT',token:owner,body:{name:'Front brakes',category:'Brakes',lines:cj.lines.slice(0,2)}});
 eq((await request('/api/canned-jobs',{token:owner})).items.find(x=>x.id===cj.id).lines.length,2,'canned job edited');
 await request(`/api/canned-jobs/${cj.id}`,{method:'DELETE',token:owner});ok(!(await request('/api/canned-jobs',{token:owner})).items.some(x=>x.id===cj.id),'deleted canned job is hidden');
 console.log('PASS canned jobs: save with lines, stock part linked, duplicate/empty refused, apply under one job, use count, edit, delete, mechanics blocked');
 // ---------------------------------------------------------------- customer links: estimate approval
 const pub=(t,opt={})=>request(`/api/public/link/${t}${opt.path||''}`,{...opt,allowError:true});
 const e2=await request('/api/estimates',{method:'POST',token:owner,body:{customerName:'Link Fleet',unitNumber:'55',customerNote:'Thanks for choosing us',internalNote:'SECRET-INTERNAL-NOTE'}});const e2id=e2.id;
 const j1=await request(`/api/estimates/${e2id}/lines`,{method:'POST',token:owner,body:{lineType:'labor',description:'Replace air dryer',quantity:1.5,unitPrice:140}});
 await request(`/api/estimates/${e2id}/lines`,{method:'POST',token:owner,body:{lineType:'part',parentLineId:j1.id,description:'Air dryer cartridge',quantity:1,unitPrice:80,unitCost:31.17}});
 const j2=await request(`/api/estimates/${e2id}/lines`,{method:'POST',token:owner,body:{lineType:'labor',description:'Replace mud flaps',quantity:0.5,unitPrice:140}});
 await request(`/api/estimates/${e2id}/lines`,{method:'POST',token:owner,body:{lineType:'fee',description:'Shop supplies',quantity:1,unitPrice:12}});
 eq((await request('/api/customer-links',{method:'POST',token:mech,body:{kind:'estimate',refId:String(e2id)},allowError:true})).status,403,'mechanics cannot send customer links');
 const L1=await request('/api/customer-links',{method:'POST',token:owner,body:{kind:'estimate',refId:String(e2id)}});
 ok(/\/c\/[A-Za-z0-9_-]{40,}$/.test(L1.url),'link has a long random token');const t1=L1.url.split('/c/')[1];
 ok((await db.query("SELECT count(*)::int n FROM customer_links WHERE token_hash=$1",[t1])).rows[0].n===0,'the raw token is not stored');
 const page=await fetch(`http://127.0.0.1:${port}/c/${t1}`);ok(page.ok&&/customer\.js/.test(await page.text())&&/noindex/.test(page.headers.get('x-robots-tag')||''),'customer page opens without login and is not indexed');
 const v1=await pub(t1);eq(v1.kind,'estimate','public view');eq(v1.jobs.length,2,'two jobs to decide');eq(v1.other.length,1,'fee shown as other charges');ok(v1.canDecide,'customer can decide');
 const raw=JSON.stringify(v1);ok(!/unit_cost|unitCost|31\.17|SECRET-INTERNAL-NOTE|created_by/.test(raw),'no costs, internal notes or staff names on the customer page');
 eq((await request(`/api/estimates/${e2id}`,{token:owner})).estimate.status,'sent','creating the link marks the estimate sent');
 eq((await pub('x'.repeat(43))).code,'LINK_GONE','unknown token');eq((await pub('bad token!')).status,404,'malformed token');
 const [ja,jb]=v1.jobs.map(j=>j.key);
 eq((await pub(t1,{path:'/decide',method:'POST',body:{name:'Pat Driver',agree:true,jobs:{[ja]:'approve'}}})).status,400,'every job must be answered');
 eq((await pub(t1,{path:'/decide',method:'POST',body:{name:'P',agree:true,jobs:{[ja]:'approve',[jb]:'decline'}}})).status,400,'name required');
 eq((await pub(t1,{path:'/decide',method:'POST',body:{name:'Pat Driver',jobs:{[ja]:'approve',[jb]:'decline'}}})).status,400,'authorization box required');
 const d1=await pub(t1,{path:'/decide',method:'POST',body:{name:'Pat Driver',agree:true,note:'Do it Friday',jobs:{[ja]:'approve',[jb]:'decline'}}});
 ok(d1.ok&&d1.approved===1&&d1.of===2,'customer approved 1 of 2 jobs');
 let eb2=await request(`/api/estimates/${e2id}`,{token:owner});
 ok(eb2.estimate.status==='approved'&&/Pat Driver/.test(eb2.estimate.decision_note)&&eb2.estimate.decided_by==='customer:Pat Driver','estimate approved with the signer recorded');
 ok(eb2.lines.filter(l=>l.customer_decision==='declined').length===1&&eb2.lines.filter(l=>l.customer_decision==='approved').length===2,'each line carries the customer answer');
 eq((await pub(t1,{path:'/decide',method:'POST',body:{name:'Pat Driver',agree:true,jobs:{[ja]:'decline',[jb]:'decline'}}})).status,409,'answer cannot be changed from the link');
 ok((await pub(t1)).canDecide===false&&(await pub(t1)).estimate.signedName==='Pat Driver','page shows who answered');
 ok((await db.query("SELECT 1 FROM server_audit WHERE action='estimate_customer_decision'")).rowCount===1,'customer decision is in the audit log');
 // Back to draft clears it; a new link can be answered again.
 await request(`/api/estimates/${e2id}`,{method:'PUT',token:owner,body:{status:'draft'}});eb2=await request(`/api/estimates/${e2id}`,{token:owner});
 ok(!eb2.lines.some(l=>l.customer_decision)&&!eb2.estimate.customer_signed_name,'back to draft clears the customer answer');
 const t2=(await request('/api/customer-links',{method:'POST',token:owner,body:{kind:'estimate',refId:String(e2id)}})).url.split('/c/')[1];
 await pub(t2,{path:'/decide',method:'POST',body:{name:'Pat Driver',agree:true,jobs:{[ja]:'approve',[jb]:'decline'}}});
 const conv=await request(`/api/estimates/${e2id}/convert`,{method:'POST',token:owner,body:{}});const inv=await request(`/api/invoices/${conv.id}`,{token:owner});
 ok(inv.lines.length===3&&!inv.lines.some(l=>/mud flaps/i.test(l.description)),'invoice leaves out the declined job and keeps other charges');
 const links=(await request(`/api/customer-links?kind=estimate&refId=${e2id}`,{token:owner})).items;ok(links.length===2&&links.some(l=>l.view_count>=1&&l.signed_name==='Pat Driver'),'shop sees opens and who signed');
 await request(`/api/customer-links/${links[0].id}`,{method:'DELETE',token:owner});eq((await pub(t2)).code,'LINK_GONE','turned-off link stops working');
 await db.query("UPDATE customer_links SET expires_at=now()-interval '1 minute' WHERE id=$1",[links[1].id]);eq((await pub(t1)).code,'LINK_GONE','expired link stops working');
 console.log('PASS customer links (estimate): private token, no costs or notes shown, per-job approve/decline with signature, audit, locked after answer, back-to-draft reset, declined jobs left off the invoice, revoke, expiry');
 // ---------------------------------------------------------------- customer links: inspection
 const st=(await request('/api/state',{token:owner})).shopflow;
 const wo={id:'7701',status:'Open',unit:'TR-9',customer:'Link Fleet',vin:'1FUJGLDR9CLBP8834',year:'2019',make:'Freightliner',model:'Cascadia',mechanic:'mech1',tasks:[],inspection:{required:true,type:'truck',status:'Completed',completedAt:new Date().toISOString(),results:{engine_oil:{status:'repair',note:'Oil leak at rear main seal'},brakes_front:{status:'ok'}}}};
 const issue={id:'f-7701-1',wo:'7701',description:'Oil leak rear main seal',recommendation:'Replace rear main seal',severity:'High',approval:'Waiting for Customer',mechanic:'mech1'};
 await request('/api/state/shopflow',{method:'PUT',token:owner,body:{expectedVersion:st.version,payload:{...st.payload,workorders:[...(st.payload.workorders||[]),wo],issues:[...(st.payload.issues||[]),issue]}}});
 const ti=(await request('/api/customer-links',{method:'POST',token:owner,body:{kind:'inspection',refId:'7701'}})).url.split('/c/')[1];
 const vi=await pub(ti);eq(vi.kind,'inspection','inspection view');ok(vi.inspection.flagged.some(f=>/Engine oil/i.test(f.label)&&f.status==='Needs repair'),'flagged item shown in plain words');
 ok(vi.findings.length===1&&vi.findings[0].canDecide&&vi.findings[0].title==='Replace rear main seal','recommended repair waiting for the customer');ok(!/mech1/.test(JSON.stringify(vi)),'mechanic username not shown');
 eq((await pub(ti,{path:'/decide',method:'POST',body:{name:'Pat Driver',agree:true,findings:{'other-wo-finding':'approve'}}})).status,400,'cannot decide findings from another work order');
 const di=await pub(ti,{path:'/decide',method:'POST',body:{name:'Pat Driver',agree:true,findings:{'f-7701-1':'approve'}}});ok(di.ok&&di.approved===1,'customer approved the repair');
 const sf2=(await request('/api/state',{token:owner})).shopflow.payload,iss=sf2.issues.find(i=>i.id==='f-7701-1'),w2=sf2.workorders.find(w=>w.id==='7701');
 ok(iss.approval==='Proceed'&&iss.decisionBy==='customer:Pat Driver','finding approved by the customer');
 ok(w2.tasks.some(t=>t.findingId==='f-7701-1'&&t.findingDecision==='Proceed'),'approved repair became a task on the work order');
 eq((await pub(ti)).canDecide,false,'nothing left to decide');
 console.log('PASS customer links (inspection): flagged items and repairs shown in plain words, no staff names, customer approval adds the task to the work order');
 // ---------------------------------------------------------------- fleet customer portal
 const cA=(await db.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,active) VALUES('pt-a','Portal Fleet LLC',true) RETURNING id`)).rows[0].id;
 const cB=(await db.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,active) VALUES('pt-b','Other Fleet Inc',true) RETURNING id`)).rows[0].id;
 await db.query(`INSERT INTO customer_units(customer_id,customer_name,unit_number,vin,year,make,model) VALUES($1,'Portal Fleet LLC','P-1','3AKJHHDR5KSKA1234','2019','Freightliner','Cascadia')`,[cA]);
 const mkInv=async(num,cid,name,total,status,due='CURRENT_DATE')=>(await db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,status,invoice_date,due_date,total,balance_due,unit_number,created_by) VALUES($1,$2,$3,$4,CURRENT_DATE-40,${due},$5,$5,'P-1','test') RETURNING id`,[num,cid,name,status,total])).rows[0].id;
 const iA=await mkInv('PT-1',cA,'Portal Fleet LLC',500,'sent','CURRENT_DATE-10');await mkInv('PT-2',null,'portal fleet llc',200,'sent');
 await mkInv('PT-DRAFT',cA,'Portal Fleet LLC',999,'draft');const iB=await mkInv('PT-OTHER',cB,'Other Fleet Inc',777,'sent');
 const eA=(await db.query(`INSERT INTO customer_estimates(estimate_number,status,customer_id,customer_name,total,created_by) VALUES('PT-E1','sent',$1,'Portal Fleet LLC',350,'test') RETURNING id`,[cA])).rows[0].id;
 const eB=(await db.query(`INSERT INTO customer_estimates(estimate_number,status,customer_id,customer_name,total,created_by) VALUES('PT-E2','sent',$1,'Other Fleet Inc',100,'test') RETURNING id`,[cB])).rows[0].id;
 eq((await request('/api/customer-links',{method:'POST',token:mech,body:{kind:'portal',refId:String(cA)},allowError:true})).status,403,'mechanics cannot make portal links');
 const PL=await request('/api/customer-links',{method:'POST',token:owner,body:{kind:'portal',refId:String(cA)}});const tp=PL.url.split('/c/')[1];
 ok(new Date(PL.expiresAt)-Date.now()>170*86400000,'portal link lasts about 180 days by default');
 const pv=await pub(tp);eq(pv.kind,'portal','portal view');eq(pv.customer.name,'Portal Fleet LLC','customer name');
 ok(pv.invoices.length===2&&pv.invoices.every(i=>/^PT-[12]$/.test(i.number)),'only this customer\'s sent invoices (incl. older name-only ones), no drafts, no other customers');
 eq(pv.owed,700,'what they owe');eq(pv.overdue,500,'what is overdue');ok(pv.invoices.find(i=>i.number==='PT-1').overdueDays===10,'days overdue');
 ok(pv.units.length===1&&pv.units[0].lastService,'units with last service');ok(pv.estimates.length===1&&pv.estimates[0].canApprove,'their estimate waiting for an answer');
 ok(!/Other Fleet|PT-OTHER|PT-E2|777/.test(JSON.stringify(pv)),'nothing from another customer');
 const op=await pub(tp,{path:`/estimate/${eA}/open`,method:'POST',body:{}});ok(/\/c\//.test(op.url),'portal opens their estimate for approval');eq((await pub(op.url.split('/c/')[1])).kind,'estimate','estimate link from the portal works');
 eq((await pub(tp,{path:`/estimate/${eB}/open`,method:'POST',body:{}})).status,404,'cannot open another customer\'s estimate');
 const pdfA=await fetch(`http://127.0.0.1:${port}/api/public/link/${tp}/invoice/${iA}/pdf`);ok(pdfA.ok&&(await pdfA.arrayBuffer()).byteLength>500&&/pdf/.test(pdfA.headers.get('content-type')),'invoice PDF from the portal');
 eq((await fetch(`http://127.0.0.1:${port}/api/public/link/${tp}/invoice/${iB}/pdf`)).status,404,'cannot download another customer\'s invoice');
 eq((await pub(t2.replace(/./,'Z'),{path:`/invoice/${iA}/pdf`})).status,404,'a non-portal or wrong token cannot download invoices');
 console.log('PASS fleet portal: own units, invoices (owed/overdue, PDF), estimates to approve; another customer\'s data never shown or downloadable');
 // ---------------------------------------------------------------- texting (fake Twilio)
 eq((await request('/api/sms/config',{token:owner})).enabled,false,'texting is off until Twilio keys are set');
 eq((await request('/api/sms',{method:'POST',token:owner,body:{to:'3125550199',body:'hi'},allowError:true})).code,'SMS_NOT_CONFIGURED','sending without Twilio is refused clearly');
 const sent=[];const fake=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{const f=Object.fromEntries(new URLSearchParams(b));sent.push({path:req.url,auth:req.headers.authorization,f});
  if(f.To==='+15550000000'){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'Invalid To number'}))}
  res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({sid:`SM${sent.length}x${Date.now()}`,status:'queued'}))})});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));
 Object.assign(process.env,{TWILIO_ACCOUNT_SID:'ACtest123',TWILIO_AUTH_TOKEN:'twilio-secret',TWILIO_FROM:'+13125550100',TWILIO_API_BASE:`http://127.0.0.1:${fake.address().port}`});
 await stop();await start();
 await db.query("UPDATE fullbay_import_customers SET phone='(312) 555-0199' WHERE id=$1",[cA]);
 eq((await request('/api/sms/config',{token:owner})).enabled,true,'texting on with Twilio keys');
 eq((await request('/api/sms/threads',{token:mech,allowError:true})).status,403,'mechanics do not see texts');
 eq((await request('/api/sms',{method:'POST',token:owner,body:{to:'123',body:'hi'},allowError:true})).status,400,'bad number refused');
 const s1=await request('/api/sms',{method:'POST',token:owner,body:{to:'312-555-0199',body:'Your truck is ready.'}});ok(s1.ok&&s1.sid,'text sent');
 const tw=sent.at(-1);ok(tw.path==='/2010-04-01/Accounts/ACtest123/Messages.json'&&tw.f.To==='+13125550199'&&tw.f.From==='+13125550100'&&tw.f.Body==='Your truck is ready.'&&/\/api\/sms\/status$/.test(tw.f.StatusCallback),'Twilio got the right number, sender, text and status callback');
 ok(tw.auth===`Basic ${Buffer.from('ACtest123:twilio-secret').toString('base64')}`,'Twilio account auth');
 eq((await db.query("SELECT customer_id FROM sms_messages WHERE twilio_sid=$1",[s1.sid])).rows[0].customer_id,String(cA),'text linked to the customer by phone');
 eq((await request('/api/sms',{method:'POST',token:owner,body:{to:'5550000000',body:'x'},allowError:true})).status,502,'a Twilio error is shown');
 const twPost=async(path,params,sign=true)=>{const url=`http://127.0.0.1:${port}${path}`;return fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...(sign?{'X-Twilio-Signature':twilioSignature('twilio-secret',url,params)}:{})},body:new URLSearchParams(params)})};
 const inb={From:'+13125550199',To:'+13125550100',Body:'Thanks, coming at 3',MessageSid:'SMin1'};
 eq((await twPost('/api/sms/inbound',inb,false)).status,403,'unsigned incoming text refused');
 eq((await twPost('/api/sms/inbound',{...inb,Body:'tampered'},false)).status,403,'forged incoming text refused');
 const ir=await twPost('/api/sms/inbound',inb);ok(ir.ok&&/<Response\/>/.test(await ir.text()),'signed incoming text accepted');
 await twPost('/api/sms/inbound',inb);eq((await db.query("SELECT count(*)::int n FROM sms_messages WHERE twilio_sid='SMin1'")).rows[0].n,1,'Twilio retry is not stored twice');
 eq((await request('/api/sms/config',{token:owner})).unread,1,'unread count');
 const th=(await request('/api/sms/threads',{token:owner})).items[0];ok(th.customer_name==='Portal Fleet LLC'&&th.unread===1,'conversation matched to the customer');
 const conv2=await request(`/api/sms/thread?phone=${encodeURIComponent('+13125550199')}`,{token:owner});ok(conv2.items.length===2&&conv2.items[0].direction==='out','conversation in order');
 eq((await request('/api/sms/config',{token:owner})).unread,0,'opening it marks it read');
 await twPost('/api/sms/status',{MessageSid:s1.sid,MessageStatus:'delivered'});eq((await db.query("SELECT status FROM sms_messages WHERE twilio_sid=$1",[s1.sid])).rows[0].status,'delivered','delivery status updated');
 await twPost('/api/sms/inbound',{From:'+13125550199',Body:'STOP',MessageSid:'SMin2'});
 eq((await request('/api/sms',{method:'POST',token:owner,body:{to:'3125550199',body:'x'},allowError:true})).code,'SMS_OPTED_OUT','STOP turns texting off for that number');
 await twPost('/api/sms/inbound',{From:'+13125550199',Body:'Start',MessageSid:'SMin3'});
 ok((await request('/api/sms',{method:'POST',token:owner,body:{to:'3125550199',body:'Welcome back'}})).ok,'START turns it back on');
 ok((await db.query("SELECT 1 FROM server_audit WHERE action='sms_sent'")).rowCount>=2,'texts are in the audit log');
 fake.close();for(const k of ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM','TWILIO_API_BASE'])delete process.env[k];
 console.log('PASS texting: off until set up, send through Twilio, linked to customer, signed incoming only, no duplicates, unread/read, delivery status, STOP/START');
 // ---------------------------------------------------------------- purchase orders
 const filt=(await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,cost,last_purchase_cost,price,status,inventory_managed,reorder_point,max_qty,vendor,raw) VALUES('po-f','FF-55','Fuel filter',2,20,20,45,'Active',true,5,10,'FleetPride','{}'::jsonb) RETURNING id`)).rows[0].id;
 const sug=(await request('/api/purchase-orders/suggestions?vendor=FleetPride',{token:owner})).items.find(x=>x.inventoryPartId===Number(filt));ok(sug&&sug.suggestQty===8&&sug.unitCost===20,'low-stock suggestion fills up to max');
 eq((await request('/api/purchase-orders',{token:mech,allowError:true})).status,403,'mechanics do not see purchase orders');
 eq((await request('/api/purchase-orders',{method:'POST',token:owner,body:{vendor:'FleetPride',lines:[]},allowError:true})).status,400,'a PO needs lines');
 const po=await request('/api/purchase-orders',{method:'POST',token:owner,body:{vendor:'FleetPride',vendorEmail:'orders@fleetpride.test',workOrderId:'7701',lines:[{partNumber:'ff-55',qty:8,unitCost:22},{description:'Shop rags (box)',qty:1,unitCost:30}]}});
 ok(/^PO-\d{4}-00001$/.test(po.poNumber),'PO number');let pb=await request(`/api/purchase-orders/${po.id}`,{token:owner});
 ok(Number(pb.lines[0].inventory_part_id)===Number(filt)&&pb.lines[0].description==='Fuel filter'&&!pb.lines[1].inventory_part_id,'part number linked to stock; non-stock line kept');eq(Number(pb.po.total),206,'PO total');
 await request(`/api/purchase-orders/${po.id}/status`,{method:'POST',token:owner,body:{status:'ordered'}});
 const r1=await request(`/api/purchase-orders/${po.id}/receive`,{method:'POST',token:owner,body:{reference:'FP-INV-1',lines:[{id:pb.lines[0].id,qty:5},{id:pb.lines[1].id,qty:1}]}});eq(r1.status,'partial','partly received');
 const pp=(await db.query('SELECT quantity,cost,last_purchase_cost,previous_purchase_cost FROM fullbay_import_parts WHERE id=$1',[filt])).rows[0];
 ok(Number(pp.quantity)===7&&Math.abs(Number(pp.cost)-150/7)<0.001&&Number(pp.last_purchase_cost)===22&&Number(pp.previous_purchase_cost)===20,'stock and average cost updated on receive');
 ok((await db.query("SELECT 1 FROM part_inventory_transactions WHERE part_id=$1 AND transaction_type='receive' AND reference='FP-INV-1'",[filt])).rowCount===1&&(await db.query("SELECT 1 FROM part_purchase_cost_history WHERE part_id=$1 AND unit_cost=22",[filt])).rowCount===1,'receive is in the part history and purchase history');
 eq((await request(`/api/purchase-orders/${po.id}/receive`,{method:'POST',token:owner,body:{lines:[{id:pb.lines[0].id,qty:4}]},allowError:true})).status,400,'cannot receive more than is still due');
 ok(!(await request('/api/purchase-orders/suggestions?vendor=FleetPride',{token:owner})).items.some(x=>x.inventoryPartId===Number(filt)),'parts still on order are not suggested again');
 eq((await request(`/api/purchase-orders/${po.id}`,{method:'PUT',token:owner,body:{vendor:'FleetPride',lines:[{partNumber:'FF-55',qty:20,unitCost:1}]},allowError:true})).status,409,'lines locked after parts arrived');
 eq((await request(`/api/purchase-orders/${po.id}/status`,{method:'POST',token:owner,body:{status:'cancelled'},allowError:true})).status,409,'cannot cancel after parts arrived');
 eq((await request(`/api/purchase-orders/${po.id}/status`,{method:'POST',token:owner,body:{status:'received'}})).status,'received','close short');
 ok((await request('/api/purchase-orders?q=ff-55',{token:owner})).items.some(x=>x.po_number===po.poNumber),'search by part number');
 const po2=await request('/api/purchase-orders',{method:'POST',token:owner,body:{vendor:'TruckPro',lines:[{description:'Wiper blades',qty:2,unitCost:9}]}});
 eq((await request(`/api/purchase-orders/${po2.id}/status`,{method:'POST',token:owner,body:{status:'cancelled'}})).status,'cancelled','cancel an untouched order');
 console.log('PASS purchase orders: low-stock suggestions, stock-linked lines, partial receive with average cost and history, over-receive refused, locked after receipt, close short, cancel, search');
 // ---------------------------------------------------------------- warranty & comebacks
 ok(unitKey('Acme Trucking LLC','Unit #101')===unitKey('ACME trucking','101')&&unitKey('Acme','101')!==unitKey('Beta Freight','101'),'unit identity: same fleet matches, same number at another fleet does not');
 eq(findComebacks([{source:'invoice',type:'brakes',customer:'A',unit:'1',date:'2026-01-01',ref:'I1'},{source:'invoice',type:'brakes',customer:'A',unit:'1',date:'2026-02-01',ref:'I2'}],{within:90}).length,1,'pure: repeat within window is a comeback');
 eq(findComebacks([{source:'invoice',type:'pm_service',customer:'A',unit:'1',date:'2026-01-01',ref:'I1'},{source:'invoice',type:'pm_service',customer:'A',unit:'1',date:'2026-02-01',ref:'I2'}],{within:90,ignore:['pm_service']}).length,0,'pure: PM repeating is not a comeback');
 const wDay=n=>`CURRENT_DATE-${n}`;
 const wInv=async(num,cust,unit,ago,desc)=>{const id=(await db.query(`INSERT INTO customer_invoices(invoice_number,customer_name,status,invoice_date,unit_number,created_by) VALUES($1,$2,'sent',${wDay(ago)},$3,'test') RETURNING id`,[num,cust,unit])).rows[0].id;
  await db.query(`INSERT INTO customer_invoice_lines(invoice_id,job_uid,job_name,line_type,description,quantity,unit_price) VALUES($1,$2,$3,'labor',$3,1.5,140)`,[id,`w-${num}`,desc]);return id};
 await wInv('W-1','Warranty Fleet','W9',60,'Replace wheel seal LH');await wInv('W-2','Warranty Fleet','W9',10,'Replace wheel seal LH again, leaking');
 await wInv('W-3','Other Carrier','W9',5,'Replace wheel seal RH');await wInv('W-4','Warranty Fleet','W9',300,'Replace wheel seal RH');
 await wInv('W-5','Warranty Fleet','W9',40,'PM service A');await wInv('W-6','Warranty Fleet','W9',8,'PM service A');
 const iso=d=>new Date(Date.now()-d*86400000).toISOString().slice(0,10);
 const cb=await request(`/api/reports/comebacks?from=${iso(30)}&to=${iso(0)}`,{token:owner});
 const mine=cb.items.filter(c=>c.unit==='W9');ok(mine.length===1&&mine[0].days===50&&/wheel seal/i.test(mine[0].label)&&mine[0].first.ref==='Invoice W-1','one comeback: the wheel seal 50 days later (PM and the other carrier\'s unit W9 not counted)');
 ok(cb.repairs>=2&&cb.rate>0&&cb.byType.length>=1,'comeback rate and breakdowns');
 const wu=await request(`/api/warranty/unit?unit=W9&customer=${encodeURIComponent('Warranty Fleet LLC')}`,{token:owner});
 ok(wu.items.some(x=>x.ref==='Invoice W-2'&&x.laborWarranty)&&!wu.items.some(x=>x.ref==='Invoice W-3')&&!wu.items.some(x=>/PM service/.test(x.text)),'unit warranty lists this fleet\'s repairs still covered');
 ok(wu.items.some(x=>x.ref==='Invoice W-4'&&!x.laborWarranty&&x.partsWarranty),'older repair still under parts warranty only');
 await request('/api/warranty/settings',{method:'PUT',token:owner,body:{laborDays:30,partsDays:200,comebackDays:45}});
 const cb2=await request(`/api/reports/comebacks?from=${iso(30)}&to=${iso(0)}`,{token:owner});ok(!cb2.items.some(c=>c.unit==='W9'),'shorter comeback window drops the 50-day repeat');
 eq((await request('/api/warranty/settings',{method:'PUT',token:mgt0,body:{laborDays:1},allowError:true})).status,403,'only the owner sets warranty terms');
 console.log('PASS warranty & comebacks: same repair on the same fleet unit within the window, routine work and other fleets excluded, unit warranty lookup, owner-set terms');
 // ---------------------------------------------------------------- work orders in their own table + recycle bin
 const mir=(await db.query("SELECT payload,removed_at FROM work_orders WHERE id='7701'")).rows[0];ok(mir&&mir.payload.unit==='TR-9'&&!mir.removed_at,'every work order is copied into its own row');
 const before=(await db.query("SELECT updated_at FROM work_orders WHERE id='7701'")).rows[0].updated_at;
 await db.query("UPDATE app_state SET updated_at=now() WHERE state_key='shopflow'");eq(String((await db.query("SELECT updated_at FROM work_orders WHERE id='7701'")).rows[0].updated_at),String(before),'unchanged work orders are not rewritten');
 await request('/api/work-orders/7701',{method:'DELETE',token:owner});
 ok((await db.query("SELECT removed_at FROM work_orders WHERE id='7701'")).rows[0].removed_at,'deleted work order kept in the recycle bin');
 ok((await request('/api/work-orders/removed',{token:owner})).items.some(w=>w.id==='7701'&&w.unit==='TR-9'),'recycle bin lists it');
 eq((await request('/api/work-orders/7701/restore',{method:'POST',token:mgt0,body:{},allowError:true})).status,403,'only the owner restores');
 await request('/api/work-orders/7701/restore',{method:'POST',token:owner,body:{}});
 ok((await request('/api/state',{token:owner})).shopflow.payload.workorders.some(w=>w.id==='7701'&&w.tasks.some(t=>t.findingId==='f-7701-1')),'restored with its jobs');
 ok(!(await db.query("SELECT removed_at FROM work_orders WHERE id='7701'")).rows[0].removed_at,'out of the recycle bin again');
 eq((await request('/api/work-orders/7701/restore',{method:'POST',token:owner,body:{},allowError:true})).status,404,'cannot restore twice');
 console.log('PASS work orders: one row per work order kept in sync by the database, recycle bin, owner restore');
 // ---------------------------------------------------------------- error alerts
 const alerts=[];const hook=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{alerts.push(JSON.parse(b));res.end('ok')})});await new Promise(r=>hook.listen(0,'127.0.0.1',r));
 Object.assign(process.env,{ALERT_WEBHOOK_URL:`http://127.0.0.1:${hook.address().port}/hook`,ALERT_WEBHOOK_ALLOW_HTTP:'1'});await stop();await start();
 const boom=await request('/api/invoices/not-a-number',{token:owner,allowError:true});ok(boom.status>=500&&boom.incident,'a server error shows an incident number');
 await request('/api/invoices/not-a-number',{token:owner,allowError:true});await new Promise(r=>setTimeout(r,400));
 ok(alerts.length===1&&alerts[0].text.includes(boom.incident)&&alerts[0].content===alerts[0].text,'one alert with the incident number (Slack and Discord format); the repeat is held back');
 eq((await request('/api/invoices/999999',{token:owner,allowError:true})).status,404,'normal not-found is not an alert');await new Promise(r=>setTimeout(r,200));eq(alerts.length,1,'no alert for a 404');
 hook.close();delete process.env.ALERT_WEBHOOK_URL;delete process.env.ALERT_WEBHOOK_ALLOW_HTTP;
 console.log('PASS error alerts: 500s go to the webhook with the incident number, repeats throttled, 404s ignored');
 console.log('Shop features integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
