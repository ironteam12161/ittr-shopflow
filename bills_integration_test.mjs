import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import {dbSuiteGuard} from './test_harness.mjs';

dbSuiteGuard('bills integration test'); // v24.67.0: any disposable-DB flag; a required suite that cannot run fails (test_harness.mjs)
const url=String(process.env.DATABASE_URL||'');if(!url)throw new Error('DATABASE_URL is required');
const {Pool}=pg,schema=`ittr_bills_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g,''),bootstrap=new Pool({connectionString:url,ssl:false});
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
 await request('/api/admin/users',{method:'POST',token:admin,body:{username:'billmech',display:'Bill Mechanic',password:'CI-Bill-Mechanic-2026!'}});
 const mechanic=(await request('/api/auth/login',{method:'POST',body:{username:'billmech',password:'CI-Bill-Mechanic-2026!'}})).token;
 const today=new Date().toISOString().slice(0,10),past='2026-01-05';

 const meta=await request('/api/bills/meta',{token:admin});ok(meta.categories.some(c=>c.key==='shop_supplies'&&c.qb_account),'default categories with QuickBooks accounts');ok(meta.paymentMethods.card,'payment methods');
 eq((await request('/api/bills',{token:mechanic,allowError:true})).status,403,'mechanics cannot see bills');
 eq((await request('/api/bills',{method:'POST',token:admin,body:{billDate:today,lines:[{description:'Rags',amount:10,category:'shop_supplies'}]},allowError:true})).status,400,'vendor required');
 eq((await request('/api/bills',{method:'POST',token:admin,body:{vendor:'X',billDate:today,lines:[{description:'Rags',amount:10}]},allowError:true})).status,400,'category required');
 const mism=await request('/api/bills',{method:'POST',token:admin,body:{vendor:'X',billDate:today,total:99,lines:[{description:'Rags',amount:10,category:'shop_supplies'}]},allowError:true});eq(mism.status,400,'total mismatch rejected');ok(/add up to \$10\.00/.test(mism.error),'mismatch message names the real total');
 console.log('PASS validation: vendor, category, total check, mechanics blocked');

 // Bill to pay later: 2 categories, discount, tax and freight.
 const bill={vendor:'Fastenal',billNumber:'FA-1001',billDate:past,dueDate:'2026-02-04',terms:'Net 30',notes:'Monthly supplies',discount:5,tax:8.25,freight:12,
  lines:[{description:'Shop towels',quantity:10,unitCost:4.5,category:'shop_supplies'},{description:'1/2" impact socket set',quantity:1,unitCost:120,category:'tools'}]};
 const created=await request('/api/bills',{method:'POST',token:admin,body:bill});ok(created.id,'bill created');
 let one=await request(`/api/bills/${created.id}`,{token:admin});
 eq(one.bill.total,180.25,'total = 45 + 120 - 5 + 8.25 + 12');eq(one.bill.status,'overdue','past due date → overdue');eq(one.lines.length,2,'two lines');
 const qb=one.quickBooks;eq(qb.object,'Bill','QuickBooks object');eq(qb.missing.length,0,'nothing missing for QuickBooks');
 eq(Math.round(qb.payload.Line.reduce((a,l)=>a+l.Amount,0)*100)/100,180.25,'QuickBooks lines add up to the bill total');eq(qb.payload.DocNumber,'FA-1001','QB DocNumber');eq(qb.payload.DueDate,'2026-02-04','QB due date');
 ok(qb.payload.Line.some(l=>l.AccountBasedExpenseLineDetail.AccountRef.name==='Freight & Delivery'&&l.Amount===12),'freight to its own account');
 eq((await request('/api/bills',{method:'POST',token:admin,body:bill,allowError:true})).status,409,'duplicate bill number blocked');
 let list=await request('/api/bills?from=2026-01-01&to=2026-12-31&status=overdue',{token:admin});ok(list.items.some(b=>b.id===created.id),'overdue filter');eq(list.totals.overdueCount>=1,true,'overdue count');
 list=await request('/api/bills?from=2026-01-01&to=2026-12-31&category=tools',{token:admin});ok(list.items.some(b=>b.id===created.id),'category filter');
 console.log('PASS bill with categories, discount, tax, freight → QuickBooks Bill adds up');

 // Pay it, then undo.
 eq((await request(`/api/bills/${created.id}/payment`,{method:'POST',token:admin,body:{paidOn:'2026-02-01'},allowError:true})).status,400,'payment method required');
 await request(`/api/bills/${created.id}/payment`,{method:'POST',token:admin,body:{paidOn:'2026-02-01',method:'check',reference:'Check 1043'}});
 one=await request(`/api/bills/${created.id}`,{token:admin});eq(one.bill.status,'paid','paid');eq(one.bill.paymentReference,'Check 1043','reference');
 await request(`/api/bills/${created.id}/payment`,{method:'DELETE',token:admin});eq((await request(`/api/bills/${created.id}`,{token:admin})).bill.status,'overdue','payment removed');
 console.log('PASS mark paid / undo');

 // Expense paid on the spot with a card.
 eq((await request('/api/bills',{method:'POST',token:admin,body:{kind:'expense',vendor:'Shell',billDate:today,lines:[{description:'Diesel for shop truck',amount:85.4,category:'fuel'}]},allowError:true})).status,400,'expense needs payment method');
 const exp=await request('/api/bills',{method:'POST',token:admin,body:{kind:'expense',vendor:'Shell',billDate:today,paymentMethod:'card',paymentReference:'Visa 4421',lines:[{description:'Diesel for shop truck',amount:85.4,category:'fuel'}]}});
 one=await request(`/api/bills/${exp.id}`,{token:admin});eq(one.bill.status,'paid','expense is paid');eq(one.quickBooks.object,'Purchase','expense → QuickBooks Purchase');eq(one.quickBooks.payload.PaymentType,'CreditCard','card payment type');
 console.log('PASS expense (already paid) → QuickBooks Purchase');
 eq((await request('/api/bills',{method:'POST',token:admin,body:{vendor:'Napa',billDate:today,file:{key:'../etc/passwd',mime:'application/pdf'},lines:[{description:'Filters',amount:20,category:'parts'}]},allowError:true})).status,400,'bad file key rejected');
 const scanned=await request('/api/bills',{method:'POST',token:admin,body:{vendor:'Napa',billNumber:'NP-5',billDate:today,file:{key:'vendor-bills/123-abc.pdf',mime:'application/pdf',name:'napa.pdf'},lines:[{description:'Filters',partNumber:'WIX-1',amount:20}]}});
 one=await request(`/api/bills/${scanned.id}`,{token:admin});ok(one.bill.hasFile,'scanned bill keeps its file');eq(one.bill.source,'ai_file','scanned source');eq(one.lines[0].category,'parts','part-number line defaults to Parts');
 const draft=await request(`/api/vendor-invoices/${scanned.id}/receiving-draft`,{token:admin});eq(Number(draft.filedBillId),scanned.id,'parts bill from Bills can be received into stock');
 console.log('PASS scanned bill keeps file; parts bill can be received into stock');
 // v24.61.0: a core deposit line on a bill goes back onto its part when received; "15 OCT 26" dates are fixed.
 const mk=await request('/api/bills',{method:'POST',token:admin,body:{kind:'expense',vendor:'M&K Truck Centers',billNumber:'1273549CA',billDate:today,paymentMethod:'card',paperTotal:284.33,lines:[{description:'TRL-08CK ABSORBER',partNumber:'RF-23288403',quantity:4,unitCost:48,amount:192,category:'parts'},{description:'16-52 R CARTRIDGE',partNumber:'85151066',quantity:1,unitCost:62.33,amount:62.33,category:'parts'},{description:'Core deposit – 85151066',quantity:1,unitCost:30,amount:30,category:'parts'}]}});
 const d2=await request(`/api/vendor-invoices/${mk.id}/receiving-draft`,{token:admin});
 ok(d2.extract.lines.length===2&&Number(d2.extract.lines[1].coreCost)===30&&!d2.extract.lines.some(l=>/core deposit/i.test(l.description||'')),'core deposit line folded onto its part as a core charge');
 const vb=await import('./vendor_bills.mjs');eq(vb.fixInvoiceDate('2015-10-26','2026-10-15'),'2026-10-15','“15 OCT 26” read as 2015-10-26 is turned around');eq(vb.fixInvoiceDate('2026-09-30','2026-10-15'),'2026-09-30','normal date unchanged');eq(vb.fixInvoiceDate('2019-03-04','2026-10-15'),'2019-03-04','old date that cannot be swapped unchanged');
 console.log('PASS core deposit lines fold onto their part when received; swapped 2-digit-year dates fixed');
 // v24.63.0: the vendor is never the shop itself; core charges are part of the subtotal in the math check.
 eq((await request('/api/bills',{method:'POST',token:admin,body:{vendor:'IRON TEAM Truck AND Trailer Repair LLC',billNumber:'114P795304',billDate:today,lines:[{description:'Filters',amount:20,category:'parts'}]},allowError:true})).status,400,'own shop refused as vendor');
 eq(vb.checkInvoiceMath({subtotal:284.33,total:284.33},[{quantity:4,unit_cost:48,line_total:192},{quantity:1,unit_cost:62.33,core_cost:30,line_total:62.33}]).length,0,'core charge counted in the subtotal check');
 eq(vb.checkInvoiceMath({subtotal:300,total:300},[{quantity:4,unit_cost:48,line_total:192},{quantity:1,unit_cost:62.33,core_cost:30,line_total:62.33}])[0]?.code,'LINES_NE_SUBTOTAL','a real gap is still reported');
 console.log('PASS own shop is never the vendor; core charges counted in the bill math');

 // Edit: replace lines; QuickBooks marked for update once synced.
 await db.query(`UPDATE parts_vendor_invoices SET qb_status='synced',qb_id='77' WHERE id=$1`,[created.id]);
 await request(`/api/bills/${created.id}`,{method:'PUT',token:admin,body:{...bill,discount:0,tax:0,freight:0,lines:[{description:'Shop towels',quantity:10,unitCost:5,category:'shop_supplies'}]}});
 one=await request(`/api/bills/${created.id}`,{token:admin});eq(one.bill.total,50,'edited total');eq(one.lines.length,1,'lines replaced');eq(one.bill.qbStatus,'needs_update','synced bill flagged for QuickBooks update');
 console.log('PASS edit bill (QuickBooks re-sync flag)');

 // A parts bill received into stock: only categories/details can change, it can't be voided here.
 const rec=await request('/api/vendor-invoices',{method:'POST',token:admin,body:{invoice:{vendor:'FleetPride',invoiceNumber:'FP-9',invoiceDate:today,total:200},lines:[{partNumber:'BRK-1',description:'Brake shoe',quantity:2,unitCost:100,lineTotal:200}]}});
 await db.query(`UPDATE parts_vendor_invoices SET status='received' WHERE id=$1`,[rec.id]);
 one=await request(`/api/bills/${rec.id}`,{token:admin});eq(one.lines[0].category,'parts','parts bill defaults to Parts');ok(one.bill.receivedIntoStock,'received flag');
 await request(`/api/bills/${rec.id}`,{method:'PUT',token:admin,body:{notes:'checked',lines:[{id:one.lines[0].id,category:'tires',amount:1}]}});
 one=await request(`/api/bills/${rec.id}`,{token:admin});eq(one.lines[0].category,'tires','category changed');eq(one.lines[0].amount,200,'amount of a received line unchanged');
 eq((await request(`/api/bills/${rec.id}/void`,{method:'POST',token:admin,body:{reason:'x'},allowError:true})).status,409,'received bill not voidable here');
 console.log('PASS received parts bill: categories only');

 // Void needs a reason; void bills drop out of totals.
 eq((await request(`/api/bills/${exp.id}/void`,{method:'POST',token:admin,body:{},allowError:true})).status,400,'void reason required');
 const before=(await request(`/api/bills?from=2026-01-01&to=2026-12-31`,{token:admin})).totals.total;
 await request(`/api/bills/${exp.id}/void`,{method:'POST',token:admin,body:{reason:'Entered twice'}});
 const after=await request(`/api/bills?from=2026-01-01&to=2026-12-31`,{token:admin});eq(Math.round((before-after.totals.total)*100)/100,85.4,'void removed from totals');
 console.log('PASS void');

 // CSV for the accountant: lines add up to the non-void bills.
 const r=await fetch(`http://127.0.0.1:${port}/api/bills/export.csv?from=2026-01-01&to=2026-12-31`,{headers:{Authorization:`Bearer ${admin}`}});eq(r.status,200,'csv status');
 const csv=(await r.text()).replace(/^﻿/,'').trim().split('\r\n');ok(csv[0].startsWith('Bill No,Vendor,Bill Date'),'csv header');
 const amtIdx=csv[0].split(',').indexOf('Line Amount'),sumCsv=csv.slice(1).reduce((a,l)=>a+Number(l.split(',')[amtIdx]),0);
 eq(Math.round(sumCsv*100)/100,after.totals.total,'csv lines add up to bill totals');
 eq(Math.round(Object.values(after.byCategory).reduce((a,v)=>a+v,0)*100)/100,after.totals.total,'category totals add up to the period total (tax/discount spread, freight separate)');
 console.log('PASS CSV export');

 // Owner maps categories to QuickBooks accounts and adds one.
 const cats=meta.categories.map(c=>({key:c.key,name:c.name,qbAccount:c.key==='tools'?'Small Tools':c.qb_account,kind:c.kind,active:c.active}));cats.push({name:'Waste disposal',qbAccount:'Waste Removal',kind:'expense'});
 const saved=await request('/api/bills/categories',{method:'PUT',token:admin,body:{categories:cats}});ok(saved.categories.some(c=>c.key==='waste_disposal'&&c.qb_account==='Waste Removal'),'new category');ok(saved.categories.some(c=>c.key==='tools'&&c.qb_account==='Small Tools'),'remapped');
 eq((await request('/api/bills/categories',{method:'PUT',token:mechanic,body:{categories:cats},allowError:true})).status,403,'only owner edits categories');
 ok((await request('/api/bills/vendors?q=fast',{token:admin})).vendors.some(v=>v.name==='Fastenal'),'vendor autocomplete');
 console.log('PASS categories ↔ QuickBooks accounts, vendor autocomplete');
 console.log('Bills integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
