import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'&&process.env.ITTR_OPERATIONS_TEST_DB!=='1'){console.log('SKIP customer payments integration test: disposable DB flag is not enabled');process.exit(0)}
const url=String(process.env.DATABASE_URL||'');if(!url)throw new Error('DATABASE_URL is required');
const {Pool}=pg,schema=`ittr_custpay_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g,''),bootstrap=new Pool({connectionString:url,ssl:false});
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
 const admin=(await request('/api/auth/login',{method:'POST',body:{username:'opsadmin',password:'CI-Ops-Admin-2026!'}})).token;
 const cust=(await db.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,active) VALUES('cp-test','Split Pay Fleet LLC',true) RETURNING id`)).rows[0].id;
 const other=(await db.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,active) VALUES('cp-other','Other Fleet',true) RETURNING id`)).rows[0].id;
 const mk=async(num,custId,name,price,status='sent',date='2026-09-01')=>{const id=(await db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,status,invoice_date,created_by) VALUES($1,$2,$3,$4,$5,'test') RETURNING id`,[num,custId,name,status,date])).rows[0].id;
  await db.query(`INSERT INTO customer_invoice_lines(invoice_id,line_type,description,quantity,unit_price) VALUES($1,'labor','Repair',1,$2)`,[id,price]);await db.query(`UPDATE customer_invoices SET total=$2,balance_due=$2 WHERE id=$1`,[id,price]);return Number(id)};
 const a=await mk('CP-1',cust,'Split Pay Fleet LLC',300,'sent','2026-08-01'),b=await mk('CP-2',cust,'Split Pay Fleet LLC',500,'partial','2026-08-15'),c=await mk('CP-3',null,'Split Pay Fleet LLC',200,'sent','2026-09-01'),x=await mk('CP-X',other,'Other Fleet',100);
 await mk('CP-PAID',cust,'Split Pay Fleet LLC',50,'paid');await db.query(`UPDATE customer_invoices SET balance_due=0,amount_paid=50 WHERE invoice_number='CP-PAID'`);
 let r=await request(`/api/customers/${cust}/receivables`,{token:admin});
 eq(r.openInvoices.map(i=>i.invoiceNumber).join(','),'CP-1,CP-2,CP-3','open invoices oldest first, incl. one linked only by name, no paid ones');eq(r.openBalance,1000,'open balance');eq(r.creditTotal,0,'no credit yet');
 // Validation
 eq((await request(`/api/customers/${cust}/receive-payment`,{method:'POST',token:admin,body:{amount:100,method:'Zelle',allocations:[{invoiceId:x,amount:50}]},allowError:true})).status,409,'another customer\'s invoice rejected');
 eq((await request(`/api/customers/${cust}/receive-payment`,{method:'POST',token:admin,body:{amount:100,method:'Zelle',allocations:[{invoiceId:a,amount:150}]},allowError:true})).status,400,'cannot apply more than received');
 eq((await request(`/api/customers/${cust}/receive-payment`,{method:'POST',token:admin,body:{amount:400,method:'Zelle',allocations:[{invoiceId:a,amount:350}]},allowError:true})).status,409,'cannot apply more than the invoice owes');
 // One Zelle of $900: pays CP-1 in full, $450 on CP-2, $150 left as credit.
 r=await request(`/api/customers/${cust}/receive-payment`,{method:'POST',token:admin,body:{amount:900,method:'Zelle',reference:'22198765432',paidAt:'2026-10-01',note:'Sept invoices',allocations:[{invoiceId:a,amount:300},{invoiceId:b,amount:450}]}});
 eq(r.applied,750,'applied');eq(r.credit,150,'left as credit');eq(r.creditTotal,150,'credit shown');
 const inv=async id=>(await request(`/api/invoices/${id}`,{token:admin}));
 let ia=await inv(a),ib=await inv(b);eq(ia.invoice.status,'paid','CP-1 paid');eq(Number(ib.invoice.balance_due),50,'CP-2 balance 50');eq(ia.payments[0].reference,'22198765432','split payment keeps the transaction ID');ok(/Part of one \$900\.00 payment/.test(ia.payments[0].note),'note says it is part of one payment');
 eq((await request(`/api/customers/${cust}/receive-payment`,{method:'POST',token:admin,body:{amount:10,method:'Zelle',reference:'22198765432',allocations:[]},allowError:true})).code,'DUPLICATE_REFERENCE','same Zelle cannot be recorded twice');
 // Apply the $150 credit: $50 finishes CP-2, $100 on CP-3.
 eq((await request(`/api/customers/${cust}/apply-credit`,{method:'POST',token:admin,body:{allocations:[{invoiceId:c,amount:200}]},allowError:true})).status,400,'cannot apply more credit than available');
 r=await request(`/api/customers/${cust}/apply-credit`,{method:'POST',token:admin,body:{allocations:[{invoiceId:b,amount:50},{invoiceId:c,amount:100}]}});
 eq(r.applied,150,'credit applied');eq(r.creditTotal,0,'credit used up');ib=await inv(b);eq(ib.invoice.status,'paid','CP-2 paid with credit');eq(Number((await inv(c)).invoice.balance_due),100,'CP-3 balance 100');
 ok(/Customer credit from Zelle 22198765432/.test((await inv(c)).payments[0].note),'credit payment says where it came from');
 // Lump sum with nothing applied → all credit. Editing the reference on one part updates every part.
 r=await request(`/api/customers/${cust}/receive-payment`,{method:'POST',token:admin,body:{amount:60,method:'Check',reference:'1043',allocations:[]}});eq(r.credit,60,'lump sum kept as credit');
 const p=(await inv(a)).payments[0];await request(`/api/invoices/${a}/payments/${p.id}`,{method:'PATCH',token:admin,body:{reference:'22198765433'}});
 eq((await inv(b)).payments.find(x=>x.customer_payment_id===p.customer_payment_id||String(x.customer_payment_id)===String(p.customer_payment_id))?.reference,'22198765433','reference edit applies to every part of the payment');
 console.log('PASS customer payment: split over invoices, leftover credit, apply credit later, validations, duplicate guard');
 console.log('Customer payments integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
