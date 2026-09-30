// ITTR v24.37.0 finance center integration test: estimates, tire fees, reports, Gmail Zelle matching.
// Runs against a disposable PostgreSQL database and a local fake Google API.
import {spawn} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {accountDay,zonedToUtc,cleanShopHours} from './mechanic_productivity.mjs';
import {serviceStatus,cleanItems,inspectionResult} from './compliance_center.mjs';
import {parseZelleEmail,parseVendorBillEmail,scoreZelleMatch,encryptToken,decryptToken,tireFeeQuantities,estimateTotals,vendorNameFromSender} from './finance_center.mjs';

const assert=(v,label)=>{if(!v)throw new Error(label)};
const near=(a,b,label)=>{if(Math.abs(Number(a)-Number(b))>0.005)throw new Error(`${label}: expected ${b}, got ${a}`)};

// ---------------------------------------------------------------- pure parser checks (always run)
{
 const chase=parseZelleEmail({subject:'You received money with Zelle®',body:'ACME TRUCKING LLC sent you $1,250.00\nMemo: Invoice IT-2026-00012 unit 77'});
 assert(chase?.kind==='zelle_in','Chase Zelle incoming kind');near(chase.amount,1250,'Chase amount');assert(chase.counterparty==='ACME TRUCKING LLC',`Chase counterparty ${chase?.counterparty}`);assert(chase.reference==='IT-2026-00012','Chase invoice reference');
 const wells=parseZelleEmail({subject:'You received $480.50 from John Smith',body:'Zelle® payment deposited to your account.'});
 assert(wells?.kind==='zelle_in'&&wells.counterparty==='John Smith','Wells counterparty');near(wells.amount,480.5,'Wells amount');
 const out=parseZelleEmail({subject:'You sent $300.00 to FleetPride',body:'Your Zelle® payment was sent.'});
 assert(out?.kind==='zelle_out'&&out.counterparty==='FleetPride','outgoing Zelle');near(out.amount,300,'outgoing amount');
 assert(parseZelleEmail({subject:'Your statement is ready',body:'no payment'})===null,'non-Zelle ignored');
 const bill=parseVendorBillEmail({subject:'Invoice #INV-55821 from FleetPride',body:'Amount due: $1,044.19',fromName:'FleetPride Billing',fromEmail:'billing@fleetpride.com',attachments:[{filename:'INV-55821.pdf',mimeType:'application/pdf'}]});
 assert(bill?.reference==='INV-55821','vendor invoice #');near(bill.amount,1044.19,'vendor amount');assert(bill.counterparty==='FleetPride Billing','vendor name');
 assert(vendorNameFromSender('noreply','ar@mail.truckpro.com')==='Truckpro','generic sender uses domain');
 assert(parseVendorBillEmail({subject:'Invoice IT-2026-00001 from Iron Team',body:'x'})===null,'own customer invoice skipped');
 const s=scoreZelleMatch({amount:1250,counterparty:'ACME TRUCKING LLC',memo:'Invoice IT-2026-00012',reference:'IT-2026-00012'},{invoice_number:'IT-2026-00012',balance_due:1250,total:1250,customer_name:'Acme Trucking'});
 assert(s.score>=180,'strong Zelle match score');
 const key=Buffer.alloc(32,7);assert(decryptToken(encryptToken('refresh-123',key),key)==='refresh-123','token round-trip');
 const q=tireFeeQuantities(4,2);assert(q.userQty===4&&q.disposalQty===6,'new tires get user+disposal, others disposal only');
 const t=estimateTotals({shop_supplies:0,environmental_fee:0,discount_type:'percent',discount_value:10,tax_rate:10},[{quantity:2,unit_price:50,discount:0,taxable:true},{quantity:1,unit_price:100,discount:0,taxable:false}]);
 near(t.discount,20,'estimate discount');near(t.tax,9,'estimate tax after discount');near(t.total,189,'estimate total');
 {const tz='America/Chicago',H=3600000,s0=zonedToUtc('2026-09-30','07:00',tz);assert(new Date(s0).toISOString()==='2026-09-30T12:00:00.000Z','7:00 Chicago = 12:00 UTC (CDT)');
  const w={start:s0,end:zonedToUtc('2026-09-30','17:00',tz)},r=accountDay({intervals:[{start:s0+H,end:s0+3*H,kind:'repair',label:'WO1'},{start:s0+2*H,end:s0+4*H,kind:'activity',code:'parts',label:'Parts'},{start:s0+5*H,end:s0+5.5*H,kind:'break',label:'Break'},{start:w.end,end:w.end+H,kind:'repair',label:'Late'}],window:w,dayStart:zonedToUtc('2026-09-30','00:00',tz),dayEnd:zonedToUtc('2026-10-01','00:00',tz),gapMinutes:15});
  near(r.repairMs/H,3,'repair hours incl. after-hours');near(r.overtimeMs/H,1,'after-hours repair');near(r.activityMs/H,1,'overlap goes to repair first');near(r.breakMs/H,.5,'break');near(r.unaccountedMs/H,6.5,'unaccounted in shop hours');
  assert(r.gaps.length===3&&r.gaps[1].before==='Parts'&&r.gaps[1].after==='Break','idle gaps know what came before/after');
  assert(cleanShopHours({start:'18:00',end:'06:00'}).end>'18:00','close time must be after open time');}
 {const st=serviceStatus({last_done_miles:100000,interval_miles:25000,warn_miles:1000,warn_days:30},{currentMiles:124500});assert(st.status==='due_soon'&&st.milesLeft===500,'oil change due soon by miles');
  assert(serviceStatus({last_done_date:'2025-01-01',interval_days:365,warn_days:30},{today:'2026-01-05'}).status==='overdue','CARB overdue by date');
  assert(serviceStatus({due_date:'2026-12-31',warn_days:30},{today:'2026-06-01'}).status==='ok','expiry far away is ok');
  const it=cleanItems({'10a':{status:'repair'}},'trailer');assert(it['4a'].status==='na'&&inspectionResult(it)==='needs_repair','trailer preset + needs repair');}
 console.log('PASS finance parsers: Zelle (in/out), vendor bills, match scoring, token crypto, tire quantities, estimate totals');
}

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'){console.log('SKIP finance center DB integration: disposable DB flag is not enabled');process.exit(0)}
const url=String(process.env.DATABASE_URL||'');if(!url)throw new Error('DATABASE_URL is required');
const db=new pg.Pool({connectionString:url,ssl:false});
const adminUser='finadmin',adminPass='CI-Finance-Admin-2026!',mechUser='finmech',mechPass='CI-Finance-Mech-2026!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let child=null,output='',port=0,token='',mechToken='';
const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p))})});

// Fake Google: OAuth token endpoint + Gmail list/get/profile.
const zelleBody=amount=>Buffer.from(`ACME TRUCKING LLC sent you $${amount}\nMemo: IT-INVOICE-PLACEHOLDER`).toString('base64url');
let fakeInvoiceNumber='';
const fake=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://x');const json=d=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(d))};
 if(u.pathname==='/token')return json({access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600});
 if(u.pathname==='/gmail/users/me/profile')return json({emailAddress:'shop@example.com'});
 if(u.pathname==='/gmail/users/me/messages'){const q=u.searchParams.get('q')||'';return json({messages:/zelle -in/.test(q)?[{id:'z1'}]:[{id:'v1'}]})}
 if(u.pathname==='/gmail/users/me/messages/z1')return json({id:'z1',threadId:'t1',internalDate:String(Date.now()),snippet:'sent you money',payload:{mimeType:'text/plain',headers:[{name:'From',value:'Chase <no.reply.alerts@chase.com>'},{name:'Subject',value:'You received money with Zelle®'}],body:{data:Buffer.from(`ACME TRUCKING LLC sent you $500.00\nMemo: ${fakeInvoiceNumber}`).toString('base64url')}}});
 if(u.pathname==='/gmail/users/me/messages/v1')return json({id:'v1',threadId:'t2',internalDate:String(Date.now()),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'"FleetPride" <billing@fleetpride.com>'},{name:'Subject',value:'Invoice #FP-9001'}],parts:[{mimeType:'text/plain',body:{data:Buffer.from('Amount due: $812.40').toString('base64url')}},{mimeType:'application/pdf',filename:'FP-9001.pdf',body:{attachmentId:'att1',size:10}}]}});
 if(u.pathname==='/gmail/users/me/messages/v1/attachments/att1')return json({data:Buffer.from('%PDF-1.4 fake').toString('base64url')});
 res.statusCode=404;res.end('{}');
});
void zelleBody;

async function request(path,{method='GET',tok=token,body,allowError=false,redirect='follow'}={}){
 const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,redirect,headers:{...(tok?{Authorization:`Bearer ${tok}`}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
 if(redirect==='manual')return r;
 const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch{d={raw:text}}
 if(!r.ok&&!allowError)throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0,400)}`);
 return {status:r.status,...d};
}
try{
 const fakePort=await freePort();await new Promise(r=>fake.listen(fakePort,'127.0.0.1',r));
 port=await freePort();
 await db.query("INSERT INTO auth_users(username,display_name,password_hash,role) VALUES($1,'Finance Admin',$2,'admin') ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,active=true,role='admin'",[adminUser,await bcrypt.hash(adminPass,4)]).catch(()=>{});
 const env={...process.env,PORT:String(port),NODE_ENV:'test',BOOTSTRAP_ADMIN_USERNAME:adminUser,BOOTSTRAP_ADMIN_PASSWORD:adminPass,OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',SAMSARA_API_TOKEN:'',
  GOOGLE_CLIENT_ID:'cid',GOOGLE_CLIENT_SECRET:'secret',APP_PUBLIC_URL:`http://127.0.0.1:${port}`,GMAIL_TOKEN_KEY:'ci-finance-token-key-0123456789',
  GOOGLE_OAUTH_AUTH_URL:`http://127.0.0.1:${fakePort}/auth`,GOOGLE_OAUTH_TOKEN_URL:`http://127.0.0.1:${fakePort}/token`,GOOGLE_OAUTH_REVOKE_URL:`http://127.0.0.1:${fakePort}/revoke`,GMAIL_API_BASE:`http://127.0.0.1:${fakePort}/gmail`};
 child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{output+=d});
 for(let i=0;i<150;i++){try{const h=await request('/api/health',{tok:''});if(h.ok&&h.db)break}catch{}if(child.exitCode!=null)throw new Error(output);await sleep(100)}
 token=(await request('/api/auth/login',{method:'POST',tok:'',body:{username:adminUser,password:adminPass}})).token;
 await request('/api/admin/users',{method:'POST',body:{username:mechUser,display:'Finance Mechanic',password:mechPass}}).catch(()=>{});
 mechToken=(await request('/api/auth/login',{method:'POST',tok:'',body:{username:mechUser,password:mechPass}})).token;
 await db.query("DELETE FROM gmail_finance_messages");await db.query("DELETE FROM gmail_accounts");await db.query("DELETE FROM customer_estimates");
 await db.query("DELETE FROM customer_invoice_payments");await db.query("DELETE FROM customer_invoice_lines");await db.query("DELETE FROM customer_invoices");await db.query("DELETE FROM shop_settings");

 // --- tire fee settings (owner) + mechanic is blocked
 await request('/api/finance/settings/tire-fees',{method:'PUT',body:{userFee:2.5,disposalFee:4,userFeeRetainedPerTire:0.1}});
 const denied=await request('/api/estimates',{tok:mechToken,allowError:true});assert(denied.status===403,'mechanic cannot read estimates');
 const deniedReports=await request('/api/reports/finance',{tok:mechToken,allowError:true});assert(deniedReports.status===403,'mechanic cannot read reports');

 // --- estimate lifecycle
 const est=await request('/api/estimates',{method:'POST',body:{customerName:'Acme Trucking',unitNumber:'77',taxRate:10,validDays:15}});
 assert(/^EST-\d{4}-00001$/.test(est.estimateNumber),`estimate number ${est.estimateNumber}`);
 const labor=await request(`/api/estimates/${est.id}/lines`,{method:'POST',body:{lineType:'labor',description:'Replace steer tires',quantity:2,unitPrice:120}});
 await request(`/api/estimates/${est.id}/lines`,{method:'POST',body:{lineType:'part',parentLineId:labor.id,description:'295/75R22.5 steer tire',partNumber:'TIRE-295',quantity:2,unitPrice:400,unitCost:280,taxable:true}});
 await request(`/api/estimates/${est.id}/tire-fees`,{method:'POST',body:{newTires:2,otherDisposed:1}});
 let e=await request(`/api/estimates/${est.id}`);
 const fees=e.lines.filter(l=>l.metadata?.feeCode);assert(fees.length===2,'two tire fee lines');
 near(fees.find(l=>l.metadata.feeCode==='tire_user_fee').quantity,2,'user fee qty');near(fees.find(l=>l.metadata.feeCode==='tire_disposal_fee').quantity,3,'disposal qty');
 // 240 labor + 800 parts + 5 user + 12 disposal = 1057; tax 10% of 800 = 80
 near(e.estimate.subtotal,1057,'estimate subtotal');near(e.estimate.tax,80,'estimate tax');near(e.estimate.total,1137,'estimate total');
 await request(`/api/estimates/${est.id}/tire-fees`,{method:'POST',body:{newTires:2,otherDisposed:0}});
 e=await request(`/api/estimates/${est.id}`);near(e.lines.find(l=>l.metadata?.feeCode==='tire_disposal_fee').quantity,2,'tire fees are set, not duplicated');
 const pdf=await fetch(`http://127.0.0.1:${port}/api/estimates/${est.id}/pdf`,{headers:{Authorization:`Bearer ${token}`}});
 assert(pdf.ok&&(await pdf.arrayBuffer()).byteLength>2000&&pdf.headers.get('content-type')==='application/pdf','estimate PDF renders');
 await request(`/api/estimates/${est.id}`,{method:'PUT',body:{status:'approved',decisionNote:'Approved by phone'}});
 const conv=await request(`/api/estimates/${est.id}/convert`,{method:'POST',body:{}});
 const again=await request(`/api/estimates/${est.id}/convert`,{method:'POST',body:{}});assert(again.existing&&again.id===conv.id,'convert is idempotent');
 const inv=await request(`/api/invoices/${conv.id}`);
 assert(inv.invoice.status==='draft','converted invoice starts as draft');near(inv.invoice.total,1133,'invoice total matches estimate');
 const part=inv.lines.find(l=>l.line_type==='part'),lab=inv.lines.find(l=>l.line_type==='labor');assert(String(part.parent_line_id)===String(lab.id),'part stays under its labor job');
 const locked=await request(`/api/estimates/${est.id}/lines`,{method:'POST',body:{lineType:'other',description:'x',quantity:1,unitPrice:1},allowError:true});assert(locked.status===409,'converted estimate is locked');
 console.log('PASS estimates: create, lines, tire fees (set semantics), PDF, approve, convert to invoice once');

 // --- invoice tire fees + finalize paid draft => paid (audit fix)
 await request(`/api/invoices/${conv.id}/tire-fees`,{method:'POST',body:{newTires:2,otherDisposed:0}});
 const invAfter=await request(`/api/invoices/${conv.id}`);assert(invAfter.lines.filter(l=>l.metadata?.feeCode).length===2,'invoice tire fees not duplicated');
 await request(`/api/invoices/${conv.id}/payments`,{method:'POST',body:{amount:invAfter.invoice.total,method:'Check',reference:'1001'}});
 await request(`/api/invoices/${conv.id}/finalize`,{method:'POST',body:{}});
 const fin=await request(`/api/invoices/${conv.id}`);assert(fin.invoice.status==='paid',`paid draft finalizes as paid (got ${fin.invoice.status})`);
 console.log('PASS invoices: tire fees + fully paid draft finalizes as paid');

 // --- v24.38.0: tire fees per tire line, placed under the tire, disposal optional per customer
 const tc=(await db.query("INSERT INTO fullbay_import_customers(source_key,customer_name) VALUES('tire-test-cust','Tire Keeper Freight') ON CONFLICT(source_key) DO UPDATE SET tire_disposal_exempt=false RETURNING id")).rows[0].id;
 const ti=await request('/api/invoices',{method:'POST',body:{customerId:tc,customerName:'Tire Keeper Freight',unitNumber:'55'}});
 const tl=await request(`/api/invoices/${ti.id}/lines`,{method:'POST',body:{lineType:'labor',description:'Mount steer tires',quantity:1,unitPrice:100}});
 const tp=await request(`/api/invoices/${ti.id}/lines`,{method:'POST',body:{lineType:'part',parentLineId:tl.id,description:'Michelin X Line Energy Z 295/75R22.5',partNumber:'MICH-295',quantity:2,unitPrice:450,taxable:true}});
 const ctx=await request(`/api/invoices/${ti.id}/tire-fees`);assert(ctx.parts.find(p=>p.id==tp.id)?.isTire===true,'Michelin line recognized as a tire');assert(ctx.customer?.disposalExempt===false,'customer not exempt yet');
 await request(`/api/invoices/${ti.id}/tire-fees`,{method:'POST',body:{items:[{partLineId:tp.id,quantity:2,userFee:true,disposalFee:false}],rememberDisposalExempt:true}});
 let tb=await request(`/api/invoices/${ti.id}`);const feeRows=tb.lines.filter(l=>l.metadata?.forLineId==tp.id);
 assert(feeRows.length===1&&feeRows[0].metadata.feeCode==='tire_user_fee'&&Number(feeRows[0].quantity)===2,'only the user fee for 2 tires');
 assert(String(feeRows[0].parent_line_id)===String(tl.id),'fee sits in the same job as the tire');
 const ord=tb.lines.map(l=>String(l.id));assert(ord.indexOf(String(feeRows[0].id))===ord.indexOf(String(tp.id))+1,'fee is listed right under the tire');
 assert((await db.query('SELECT tire_disposal_exempt FROM fullbay_import_customers WHERE id=$1',[tc])).rows[0].tire_disposal_exempt===true,'customer remembered as keeping old tires');
 await request(`/api/invoices/${ti.id}/tire-fees`,{method:'POST',body:{items:[{partLineId:tp.id,quantity:2,userFee:true,disposalFee:true}]}});
 tb=await request(`/api/invoices/${ti.id}`);near(tb.invoice.subtotal,100+900+2*2.5+2*4,'user + disposal fee per tire (test settings: $2.50 + $4)');
 await request(`/api/invoices/${ti.id}/lines/${tp.id}`,{method:'DELETE'});
 tb=await request(`/api/invoices/${ti.id}`);assert(!tb.lines.some(l=>l.metadata?.forLineId),'deleting the tire deletes its fees');
 await request(`/api/invoices/${ti.id}/void`,{method:'POST',body:{}});
 console.log('PASS tire fees: per tire line, under the tire, disposal optional + remembered per customer, removed with the tire');

 // --- open invoice for A/R and Zelle
 const open=await request('/api/invoices',{method:'POST',body:{customerName:'Acme Trucking',unitNumber:'77',terms:'Net 30'}});
 await request(`/api/invoices/${open.id}/lines`,{method:'POST',body:{lineType:'labor',description:'Brake job',quantity:5,unitPrice:100}});
 await request(`/api/invoices/${open.id}/finalize`,{method:'POST',body:{}});
 fakeInvoiceNumber=(await request(`/api/invoices/${open.id}`)).invoice.invoice_number;

 // --- reports
 const r=await request('/api/reports/finance?from=2000-01-01&to=2100-12-31');
 near(r.kpis.outstanding,500,'A/R outstanding');near(r.kpis.labor,740,'labor revenue');near(r.kpis.parts,800,'parts revenue');near(r.kpis.partsCost,560,'parts cost');
 near(r.tireFees.userFeeQty,2,'tire user fee qty');near(r.tireFees.userFeeAmount,5,'tire user fee $');near(r.tireFees.disposalQty,2,'disposal qty');near(r.tireFees.userFeeToRemit,4.8,'user fee to remit');
 assert(r.customersOwing[0]?.customerName==='Acme Trucking','customer owing list');assert(r.partsUsage[0]?.timesUsed===1&&r.partsUsage[0].qty===2,'parts usage count');
 assert(r.aging.reduce((a,b)=>a+b.amount,0)===500,'aging sums to A/R');assert(r.monthly.length>=1,'monthly series');
 console.log('PASS reports: KPIs, revenue mix, A/R aging, customers owing, parts usage, tire fee remit');

 // --- Gmail OAuth + sync + apply Zelle
 const c=await request('/api/gmail/connect',{method:'POST',body:{}});const state=new URL(c.url).searchParams.get('state');assert(state,'OAuth state issued');
 const bad=await request(`/api/gmail/oauth/callback?state=forged&code=x`,{tok:'',redirect:'manual'});assert(/gmail=error/.test(bad.headers.get('location')||''),'forged state rejected');
 const cb=await request(`/api/gmail/oauth/callback?state=${state}&code=abc`,{tok:'',redirect:'manual'});assert(/gmail=connected/.test(cb.headers.get('location')||''),`OAuth callback connects (${cb.headers.get('location')})`);
 const stored=(await db.query('SELECT refresh_token_enc FROM gmail_accounts')).rows[0];assert(stored&&!stored.refresh_token_enc.includes('fake-refresh'),'refresh token stored encrypted');
 const replay=await request(`/api/gmail/oauth/callback?state=${state}&code=abc`,{tok:'',redirect:'manual'});assert(/gmail=error/.test(replay.headers.get('location')||''),'OAuth state is single-use');
 const sync=await request('/api/gmail/sync',{method:'POST',body:{}});assert(sync.results[0].added===2,`sync added 2 (${JSON.stringify(sync.results)})`);
 const again2=await request('/api/gmail/sync',{method:'POST',body:{}});assert(again2.results[0].added===0,'sync is incremental');
 const msgs=await request('/api/gmail/messages');const z=msgs.items.find(m=>m.kind==='zelle_in'),v=msgs.items.find(m=>m.kind==='vendor_bill');
 assert(z&&v,'Zelle + vendor bill classified');near(v.amount,812.4,'vendor bill amount');assert(z.suggestions?.[0]?.invoice?.id==open.id,'Zelle suggests the right invoice');
 const att=await fetch(`http://127.0.0.1:${port}/api/gmail/messages/${v.id}/attachments/0`,{headers:{Authorization:`Bearer ${token}`}});assert(att.ok&&(await att.text()).startsWith('%PDF'),'vendor PDF attachment downloads');
 await request(`/api/gmail/messages/${z.id}/apply-payment`,{method:'POST',body:{invoiceId:open.id}});
 const twice=await request(`/api/gmail/messages/${z.id}/apply-payment`,{method:'POST',body:{invoiceId:open.id},allowError:true});assert(twice.status===409,'Zelle cannot be applied twice');
 const paidInv=await request(`/api/invoices/${open.id}`);assert(paidInv.invoice.status==='paid'&&paidInv.payments[0].method==='Zelle','Zelle payment recorded and invoice paid');
 const mechGmail=await request('/api/gmail/messages',{tok:mechToken,allowError:true});assert(mechGmail.status===403,'mechanic cannot read Gmail inbox');
 console.log('PASS gmail: OAuth state (forged/replay blocked), encrypted token, incremental sync, classify, suggest, apply Zelle once');

 // --- audit fix: mechanics do not see part costs
 await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,allocated,cost,price,inventory_value,status,uom) VALUES('fin-test-part','FIN-1','Finance test part',5,0,12.5,30,62.5,'Active','ea') ON CONFLICT(source_key) DO NOTHING`);
 const mp=await request('/api/parts?q=FIN-1',{tok:mechToken});assert(mp.items?.length&&mp.items[0].cost===undefined&&mp.items[0].price!==undefined,'mechanic part search hides cost');
 const ap=await request('/api/parts?q=FIN-1');assert(Number(ap.items[0].cost)===12.5,'admin still sees cost');
 console.log('PASS audit: mechanics no longer receive part buy cost');
 // --- v24.37.1: deleted work orders leave vehicle history (inspection rows included)
 const unitRow=(await db.query("INSERT INTO customer_units(unit_number,customer_name) VALUES('DEL-UNIT-1','Delete Test Co') RETURNING id")).rows[0];
 const sfRow=(await db.query("SELECT payload,version FROM app_state WHERE state_key='shopflow'")).rows[0];
 const keepWos=(sfRow.payload?.workorders||[]).filter(w=>!['9901','9902'].includes(String(w?.id)));
 const mkWo=id=>({id,unit:'DEL-UNIT-1',unitRecordId:unitRow.id,customer:'Delete Test Co',status:'Completed',mechanic:mechUser,helpers:[],date:'2026-09-28',tasks:[{uid:`t-${id}`,t:`Job ${id}`,done:true}]});
 await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1 WHERE state_key='shopflow'",[JSON.stringify({...sfRow.payload,workorders:[...keepWos,mkWo(9901),mkWo(9902)],issues:sfRow.payload?.issues||[]})]);
 for(const id of ['9901','9902','9903'])await db.query(`INSERT INTO mechanic_inspections(work_order_id,unit_id,unit_number_snapshot,inspection_type,status,completed_at) VALUES($1,$2,'DEL-UNIT-1','truck','completed',now()) ON CONFLICT(work_order_id) DO NOTHING`,[id,unitRow.id]);
 const inspIds=async()=>(await request(`/api/customer-units/${unitRow.id}/profile`)).history.filter(h=>h.source==='inspection').map(h=>String(h.workOrderId)).sort().join(',');
 assert(await inspIds()==='9901,9902',`orphan inspection (WO deleted earlier) is hidden, got ${await inspIds()}`);
 const mechDel=await request('/api/work-orders/9901',{method:'DELETE',tok:mechToken,allowError:true});assert(mechDel.status===403,'mechanic cannot delete work orders');
 await request('/api/work-orders/9901',{method:'DELETE'});
 assert((await db.query("SELECT 1 FROM mechanic_inspections WHERE work_order_id='9901'")).rowCount===0,'deleting a WO removes its inspection');
 const hist=(await request(`/api/customer-units/${unitRow.id}/profile`)).history;
 assert(!hist.some(h=>String(h.id)==='9901'||String(h.workOrderId)==='9901'),'deleted WO gone from vehicle history');
 assert((await db.query("SELECT 1 FROM server_audit WHERE action='work_order_deleted' AND details->>'workOrderId'='9901'")).rowCount===1,'deleted WO snapshot kept in audit log');
 const cur=(await request('/api/state')).shopflow;
 await request('/api/state/shopflow',{method:'PUT',body:{expectedVersion:cur.version,payload:{...cur.payload,workorders:cur.payload.workorders.filter(w=>String(w.id)!=='9902')}}});
 assert((await db.query("SELECT 1 FROM mechanic_inspections WHERE work_order_id='9902'")).rowCount===0,'removing a WO through a normal save also removes its inspection');
 console.log('PASS work orders: delete endpoint + normal save remove the WO and its inspection from vehicle history');
 // --- v24.37.1: mechanics can change their own Current Activity
 const badAct=await request('/api/mechanic/activity',{method:'POST',tok:mechToken,body:{action:'start',code:'hacking'},allowError:true});assert(badAct.status===400,'unknown activity rejected');
 const act=await request('/api/mechanic/activity',{method:'POST',tok:mechToken,body:{action:'start',code:'parts',note:'NAPA run'}});
 assert(act.user.currentActivity.code==='parts','activity saved for mechanic');
 const adminView=await request('/api/state');assert(adminView.users.payload[mechUser]?.currentActivity?.code==='parts','admin sees mechanic activity');
 const mechView=await request('/api/state',{tok:mechToken});const keys=Object.keys(mechView.users?.payload||{});
 assert(keys.length===1&&keys[0]===mechUser&&mechView.users.payload[mechUser].currentActivity.note==='NAPA run','mechanic reads only their own activity');
 await request('/api/mechanic/activity',{method:'POST',tok:mechToken,body:{action:'stop'}});
 const after=(await request('/api/state')).users.payload[mechUser];assert(!after.currentActivity.code&&after.activityHistory[0].endedAt,'stop closes the activity in history');
 await db.query("INSERT INTO auth_users(username,display_name,password_hash,role) VALUES('ghostmech','Ghost Mechanic','x','mechanic') ON CONFLICT(username) DO NOTHING");
 assert((await request('/api/state')).users.payload.ghostmech?.role==='mechanic','mechanic login missing from users record still shows on dashboard');
 const mr=await request('/api/reports/mechanics?from=2026-01-01&to=2026-12-31');assert(Array.isArray(mr.mechanics)&&mr.mechanics.some(m=>m.username===mechUser),'productivity report lists mechanics');
 const mm=mr.mechanics.find(m=>m.username===mechUser);assert(mm.totals.byActivity.parts>0,'activity time counted in productivity report');
 const deniedP=await request('/api/reports/mechanics',{tok:mechToken,allowError:true});assert(deniedP.status===403,'mechanics cannot read the productivity report');
 console.log('PASS mechanic activity: start/stop saved on server, visible to admin, mechanic sees only self');
 // --- v24.39.0 compliance: annual inspections, fleet PM/CARB, owner reset
 const lk=await request('/api/annual-inspections/lookup?q=Tire Keeper');assert(lk.customers.some(c=>c.customer_name==='Tire Keeper Freight'),'carrier lookup finds customers');
 const ai=await request('/api/annual-inspections',{method:'POST',body:{carrierName:'HOBO TRANSPORTATION',carrierAddress:'1460 N RENAISSANCE DR #307',carrierCityStateZip:'PARK RIDGE, IL 60068',vehicleType:'trailer',fleetUnitNumber:'9500',vin:'7KYAF5323RED39599',inspectorName:'Eli M',items:{'1a':{status:'repaired',repairedDate:'2026-09-29'}}}});
 assert(/^AI-\d{4}-00001$/.test(ai.report_number),'inspection report number');
 const aiRow=(await request(`/api/annual-inspections/${ai.id}`)).item;assert(aiRow.items['4a'].status==='na'&&aiRow.items['1a'].status==='repaired'&&aiRow.result==='passed','trailer defaults + repaired item still passes');
 const aiPdf=await fetch(`http://127.0.0.1:${port}/api/annual-inspections/${ai.id}/pdf`,{headers:{Authorization:`Bearer ${token}`}});const pdfTxt=Buffer.from(await aiPdf.arrayBuffer()).toString('latin1');
 assert(aiPdf.ok&&(pdfTxt.match(/\/Type\s*\/Page[^s]/g)||[]).length===1,'annual inspection PDF is exactly one page');
 const mechAi=await request('/api/annual-inspections',{tok:mechToken,allowError:true});assert(mechAi.status===403,'mechanics cannot open inspections');
 const fu=(await db.query("INSERT INTO customer_units(unit_number,customer_name,mileage,odometer_miles,odometer_source) VALUES('FLEET-1','Iron Team Fleet',124500,124500,'samsara') RETURNING id")).rows[0].id;
 await request('/api/fleet-maintenance',{method:'POST',body:{unitId:fu,serviceType:'oil_change',lastDoneMiles:100000,lastDoneDate:'2026-06-01'}});
 await request('/api/fleet-maintenance',{method:'POST',body:{items:[{serviceType:'carb_test',unitLabel:'FLEET-1',lastDoneDate:'2025-09-01',dueDate:'2025-12-31'}]}});
 let fm=await request('/api/fleet-maintenance');const oil=fm.items.find(i=>i.service_type==='oil_change'),carb=fm.items.find(i=>i.service_type==='carb_test');
 assert(oil.status==='due_soon'&&oil.milesLeft===500&&oil.milesSource==='Samsara','oil change due soon from Samsara miles');assert(carb.status==='overdue'&&String(carb.unit_id)===String(fu),'CARB overdue, matched by unit #');
 const sum=await request('/api/fleet-maintenance/summary');assert(sum.overdue===1&&sum.dueSoon===1,'dashboard badge counts');
 await request(`/api/fleet-maintenance/${carb.id}/done`,{method:'POST',body:{doneDate:'2026-09-30',nextDueDate:'2027-09-30'}});
 fm=await request('/api/fleet-maintenance');assert(fm.items.find(i=>i.id===carb.id).status==='ok','marking done clears the alert');
 await request('/api/estimates',{method:'POST',body:{customerName:'Reset Test'}});
 const pv=await request('/api/admin/reset-data/preview');assert(pv.scopes.billing.rows>0,'reset preview counts billing rows');
 const noConfirm=await request('/api/admin/reset-data',{method:'POST',body:{scopes:['billing'],confirm:'yes'},allowError:true});assert(noConfirm.status===400,'reset needs typed confirmation');
 const mechReset=await request('/api/admin/reset-data',{method:'POST',tok:mechToken,body:{scopes:['billing'],confirm:'START FRESH'},allowError:true});assert(mechReset.status===403,'mechanics cannot reset');
 const rs=await request('/api/admin/reset-data',{method:'POST',body:{scopes:['billing','productivity'],confirm:'START FRESH'}});
 assert((await db.query('SELECT count(*)::int n FROM customer_invoices')).rows[0].n===0&&(await db.query('SELECT count(*)::int n FROM customer_estimates')).rows[0].n===0,'billing wiped');
 assert((await db.query('SELECT count(*)::int n FROM task_time_sessions')).rows[0].n===0,'timers wiped');
 const snap=(await db.query('SELECT snapshot FROM data_reset_snapshots ORDER BY id DESC LIMIT 1')).rows[0].snapshot;assert(Array.isArray(snap.customer_estimates)&&snap.customer_estimates.length>0,'deleted rows kept in snapshot');
 assert((await db.query("SELECT count(*)::int n FROM customer_units WHERE unit_number='FLEET-1'")).rows[0].n===1,'units are kept');
 console.log('PASS compliance: annual inspection + 1-page PDF, fleet PM/CARB status + done, owner reset with snapshot');
 console.log('Finance center integration: all scenarios passed');
}catch(e){console.error(e.message);console.error(output.slice(-4000));process.exitCode=1}
finally{if(child&&child.exitCode==null){child.kill('SIGTERM');await sleep(200)}fake.close();await db.end()}
