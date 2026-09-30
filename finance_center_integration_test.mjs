// ITTR v24.37.0 finance center integration test: estimates, tire fees, reports, Gmail Zelle matching.
// Runs against a disposable PostgreSQL database and a local fake Google API.
import {spawn} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import bcrypt from 'bcryptjs';
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
 console.log('Finance center integration: all scenarios passed');
}catch(e){console.error(e.message);console.error(output.slice(-4000));process.exitCode=1}
finally{if(child&&child.exitCode==null){child.kill('SIGTERM');await sleep(200)}fake.close();await db.end()}
