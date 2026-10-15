import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'&&process.env.ITTR_OPERATIONS_TEST_DB!=='1'){console.log('SKIP operations lifecycle integration test: disposable DB flag is not enabled');process.exit(0)}
const url=String(process.env.DATABASE_URL||'');if(!url)throw new Error('DATABASE_URL is required');
const {Pool}=pg,schema=`ittr_ops_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/g,''),bootstrap=new Pool({connectionString:url,ssl:false});
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
 await request('/api/admin/users',{method:'POST',token:admin,body:{username:'opsmech',display:'Ops Mechanic',password:'CI-Ops-Mechanic-2026!'}});
 const mechanic=(await request('/api/auth/login',{method:'POST',body:{username:'opsmech',password:'CI-Ops-Mechanic-2026!'}})).token;

 const customer=(await request('/api/customers',{method:'POST',token:admin,body:{customer_name:'Delete Safety Fleet'}})).item;
 const unit=(await request(`/api/customers/${customer.id}/units`,{method:'POST',token:admin,body:{unit_number:'DEL-100',vin:'1M1AW07Y7FM001234'}})).item;
 await request('/api/invoices',{method:'POST',token:admin,body:{customerId:customer.id,customerName:customer.customer_name,unitId:unit.id,unitNumber:unit.unit_number}});
 const preview=await request(`/api/customers/${customer.id}/deletion-preview`,{token:admin});ok(preview.references.invoices===1&&preview.references.units===1,'delete preview must count references');
 const archived=await request(`/api/customers/${customer.id}`,{method:'DELETE',token:admin,body:{mode:'soft',reason:'duplicate test fleet'}});eq(archived.mode,'soft','safe delete mode');
 ok((await db.query('SELECT deleted_at FROM fullbay_import_customers WHERE id=$1',[customer.id])).rows[0].deleted_at,'soft delete timestamp missing');
 const blocked=await request(`/api/customers/${customer.id}`,{method:'DELETE',token:admin,body:{mode:'hard',force:true,confirmation:'wrong',reason:'test cleanup'},allowError:true});eq(blocked.status,409,'hard delete must require exact confirmation');
 await request(`/api/customers/${customer.id}`,{method:'DELETE',token:admin,body:{mode:'hard',force:true,confirmation:`DELETE ${customer.customer_name}`,reason:'test cleanup'}});
 eq(Number((await db.query('SELECT count(*) n FROM fullbay_import_customers WHERE id=$1',[customer.id])).rows[0].n),0,'customer hard delete');eq(Number((await db.query('SELECT count(*) n FROM customer_deletion_events WHERE customer_id=$1',[customer.id])).rows[0].n),2,'deletion audit events');
 console.log('PASS customer deletion safety + audit trail');

 // v24.45.0: a mechanic must clock in before starting work.
 let clockBlocked=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{unit:'REQ-199',jobs:['PM service']},allowError:true});eq(clockBlocked.status,409,'starting a job before clock-in is blocked');eq(clockBlocked.code,'CLOCK_IN_REQUIRED','clock-in required code');
 clockBlocked=await request('/api/mechanic/activity',{method:'POST',token:mechanic,body:{action:'start',code:'cleaning'},allowError:true});eq(clockBlocked.status,409,'starting an activity before clock-in is blocked');
 await request('/api/timeclock/punch',{method:'POST',token:mechanic,body:{action:'in'}});
 console.log('PASS clock-in required: job and activity blocked until the mechanic clocks in');
 let bad=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{jobs:['PM service']},allowError:true});eq(bad.status,400,'truck identity must be required');
 bad=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{unit:'REQ-200',jobs:[]},allowError:true});eq(bad.status,400,'at least one job must be required');
 const started=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{unit:'REQ-200',customer:'Required Fields Fleet',jobs:['PM service'],inspectionRequired:true,inspectionType:'truck'}});ok(started.workOrder.unitRecordId,'work order must carry stable unit id');
 let state=await request('/api/state',{token:mechanic}),sf=state.shopflow.payload,w=sf.workorders[0];w.inspection={...w.inspection,status:'Completed',startedAt:'2026-09-01T10:00:00Z',completedAt:'2026-09-01T11:00:00Z',completedBy:'opsmech',summary:{total:2,answered:2,ok:1,attention:0,repair:1,na:0},findings:[{id:'brakes',label:'Brake condition',status:'repair',note:'Left steer worn'}],results:{brakes:{status:'repair',note:'Left steer worn'},lights:{status:'ok'}}};
 await request('/api/state/shopflow',{method:'PUT',token:mechanic,body:{payload:sf,expectedVersion:state.shopflow.version}});
 const inspection=(await db.query('SELECT * FROM mechanic_inspections WHERE work_order_id=$1',[String(w.id)])).rows[0];eq(String(inspection.unit_id),String(started.unit.id),'inspection stable unit link');eq(inspection.status,'Completed','inspection status');
 const profile=await request(`/api/customer-units/${started.unit.id}/profile`,{token:admin});ok(profile.history.some(x=>x.source==='inspection'&&String(x.workOrderId)===String(w.id)),'vehicle history must include inspection');
 console.log('PASS required WO fields + inspection-to-vehicle history');
 state=await request('/api/state',{token:mechanic});sf=state.shopflow.payload;const stale=sf.workorders.find(x=>String(x.id)===String(w.id));stale.inspection={...stale.inspection,status:'In Progress',completedAt:''};
 await request('/api/state/shopflow',{method:'PUT',token:mechanic,body:{payload:sf,expectedVersion:state.shopflow.version}});
 const after=(await request('/api/state',{token:admin})).shopflow.payload.workorders.find(x=>String(x.id)===String(w.id));eq(after.inspection.status,'Completed','a stale whole-shop save must not reopen a completed inspection');ok(after.inspection.completedAt,'completedAt kept');
 console.log('PASS completed inspection is not put back to In Progress by a stale save');
 {
  // v24.47.6: leaving an unfinished inspection (job, activity, Available) clears "Inspecting"; reopening sets it again.
  const st=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{unit:'AWAY-1',customer:'Required Fields Fleet',jobs:['Brake adjust'],inspectionRequired:true,inspectionType:'truck'}});
  const woId=String(st.workOrder.id),now=()=>new Date().toISOString();
  const insp=async()=>(await request('/api/state',{token:admin})).shopflow.payload.workorders.find(x=>String(x.id)===woId).inspection;
  const open=async()=>{await request('/api/mechanic/focus-inspection',{method:'POST',token:mechanic,body:{workOrderId:woId}});await request(`/api/work-orders/${woId}/inspection`,{method:'POST',token:mechanic,body:{inspection:{status:'In Progress',startedAt:now(),startedBy:'opsmech',lastOpenedAt:now(),lastOpenedBy:'opsmech',away:false}}})};
  await open();eq((await insp()).away,false,'open inspection is active');
  await request('/api/mechanic/activity',{method:'POST',token:mechanic,body:{action:'start',code:'cleaning'}});eq((await insp()).away,true,'starting an activity leaves the inspection');
  await open();eq((await insp()).away,false,'reopening makes it active again');
  await request('/api/mechanic/activity',{method:'POST',token:mechanic,body:{action:'stop'}});eq((await insp()).away,true,'Available leaves the inspection');
  await open();const task=(await request('/api/state',{token:mechanic})).shopflow.payload.workorders.find(x=>String(x.id)===woId).tasks[0];
  await request(`/api/work-orders/${woId}/tasks/by-uid/${encodeURIComponent(task.uid)}/action`,{method:'POST',token:mechanic,body:{action:'start'}});const i1=await insp();eq(i1.away,true,'starting a job leaves the inspection');eq(i1.status,'In Progress','answers/status kept');
  await open();eq((await insp()).away,false,'reopen while job paused by focus');
  await request(`/api/work-orders/${woId}/tasks/by-uid/${encodeURIComponent(task.uid)}/action`,{method:'POST',token:mechanic,body:{action:'resume'}});
  await request(`/api/work-orders/${woId}/tasks/by-uid/${encodeURIComponent(task.uid)}/action`,{method:'POST',token:mechanic,body:{action:'pause',reason:'Waiting for parts'}});eq((await insp()).away,true,'after job pause the inspection stays left');
  console.log('PASS leaving an unfinished inspection clears Inspecting (activity, Available, job start/pause)');
 }
 const added=await request(`/api/work-orders/${w.id}/inspection/items/brakes/add-to-work-order`,{method:'POST',token:mechanic,body:{}});
 const repairTask=added.shopflow.workorders.find(x=>String(x.id)===String(w.id)).tasks.find(t=>t.uid===added.taskUid);
 eq(repairTask.t,'Brake condition — Left steer worn','inspection repair task name has no "Inspection:" prefix');eq(repairTask.source,'inspection','inspection repair task source');
 console.log('PASS inspection finding -> repair task named without prefix');
 await db.query(`UPDATE app_state SET payload=jsonb_set(payload,'{workorders,0,tasks}',(payload#>'{workorders,0,tasks}')||'[{"uid":"legacy-insp-1","t":"Inspection: Front LH hubcap — oil level / leaks","source":"inspection"}]'::jsonb) WHERE state_key='shopflow'`);
 await stop();await start();
 for(let i=0;i<40;i++){const t=(await db.query(`SELECT payload#>'{workorders,0,tasks}' tasks FROM app_state WHERE state_key='shopflow'`)).rows[0].tasks.find(x=>x.uid==='legacy-insp-1');if(t.t==='Front LH hubcap — oil level / leaks')break;if(i===39)throw new Error(`legacy inspection task was not renamed: ${t.t}`);await sleep(150)}
 console.log('PASS legacy "Inspection:" task names cleaned at startup');

 const part=(await request('/api/parts',{method:'POST',token:admin,body:{partNumber:'CORE-TRANS-1',description:'Reman transmission',quantity:0,cost:0,price:2500,hasCore:true,defaultCoreCharge:400}})).item;
 async function receive(number,date,cost,{core=false}={}){return request('/api/parts/receiving/receive',{method:'POST',token:admin,body:{invoice:{vendor:'TransChicago',vendorBranch:'Elmhurst',invoiceNumber:number,invoiceDate:date,total:cost},lines:[{matchedPartId:part.id,partNumber:'CORE-TRANS-1',description:'Reman transmission',quantity:1,unitCost:cost,coreCost:core?400:0,hasCore:core,coreDueDate:'2026-12-31',taxable:false}]}})}
 await receive('TC-100','2026-06-01',1000,{core:true});await receive('TC-101','2026-09-01',1200);
 const history=(await db.query('SELECT unit_cost FROM part_purchase_cost_history WHERE part_id=$1 ORDER BY purchased_at',[part.id])).rows.map(x=>Number(x.unit_cost));eq(history.join(','),'1000,1200','immutable purchase prices');
 const analytics=await request(`/api/parts/${part.id}/purchase-analytics`,{token:admin});eq(Number(analytics.vendors[0].lastPrice),1200,'last vendor price');eq(Number(analytics.vendors[0].bestPrice),1000,'best vendor price');eq(Math.round(Number(analytics.vendors[0].percentChange)),20,'vendor price percent change');
 await request(`/api/parts/${part.id}/transaction`,{method:'POST',token:admin,body:{type:'receive',qty:1,reference:'CIT-200',method:'parts_center',vendor:'CIT',vendorBranch:'Gary',unitCost:900,purchaseDate:'2026-09-15'}});
 const afterManualReceive=await request(`/api/parts/${part.id}/purchase-analytics`,{token:admin});ok(afterManualReceive.vendors.some(v=>v.vendor==='CIT'&&v.branch==='Gary'&&Number(v.bestPrice)===900),'manual receiving must preserve vendor branch and buy cost');eq(afterManualReceive.items.length,3,'every purchase path must append immutable price history');
 let cores=await request('/api/inventory/cores?status=open',{token:admin});eq(Number(cores.totals.outstandingQuantity),1,'outstanding core quantity');eq(Number(cores.totals.outstandingAmount),400,'outstanding core amount');const core=cores.items[0];ok(core.vendor_location_id&&core.branch_name==='Elmhurst','core vendor branch relation');
 await request(`/api/inventory/cores/${core.id}`,{method:'PATCH',token:admin,body:{action:'returned',quantity:1,reference:'RMA-55'}});cores=await request('/api/inventory/cores?status=open',{token:admin});eq(Number(cores.totals.returnedPendingCredit),400,'returned core pending credit');
 await request(`/api/inventory/cores/${core.id}`,{method:'PATCH',token:admin,body:{action:'credited',amount:400,reference:'CM-88'}});await request(`/api/inventory/cores/${core.id}`,{method:'PATCH',token:admin,body:{action:'closed',notes:'Credit applied'}});
 eq(Number((await db.query('SELECT count(*) n FROM part_core_events WHERE core_obligation_id=$1',[core.id])).rows[0].n),4,'core lifecycle audit events');eq((await db.query('SELECT status FROM part_core_obligations WHERE id=$1',[core.id])).rows[0].status,'closed','core closed status');
 // v24.62.0: core money in Bills — the received bill shows the $400 core on Core deposits; the credit became a vendor credit.
 const tc=(await db.query("SELECT id FROM parts_vendor_invoices WHERE invoice_number='TC-100'")).rows[0].id,tcb=await request(`/api/bills/${tc}`,{token:admin});
 ok(tcb.lines.some(l=>l.category==='core_deposits'&&l.amount===400&&l.virtual),'received bill shows its core on Core deposits');
 ok(tcb.quickBooks.payload.Line.some(l=>l.Amount===400&&/Core Deposits/.test(l.AccountBasedExpenseLineDetail.AccountRef.name)),'QuickBooks bill sends the core to Core Deposits');
 let cr=(await db.query("SELECT * FROM parts_vendor_invoices WHERE raw_extract->>'coreObligationId'=$1 ORDER BY id",[String(core.id)])).rows;
 ok(cr.length===1&&cr[0].bill_kind==='credit'&&Number(cr[0].total)===-400&&/transchicago/i.test(cr[0].vendor),'credited core → vendor credit −$400 (closing after full credit adds nothing)');
 const crb=await request(`/api/bills/${cr[0].id}`,{token:admin});eq(crb.quickBooks.object,'VendorCredit','QuickBooks vendor credit');eq(crb.quickBooks.payload.Line[0].Amount,400,'credit line amount');
 eq((await request(`/api/bills/${cr[0].id}`,{method:'PUT',token:admin,body:{vendor:'X',billDate:'2026-09-01',lines:[{description:'x',amount:1,category:'other'}]},allowError:true})).status,409,'core entries are changed from Parts → Cores only');
 // v24.63.0: the credit is used on one of the vendor's unpaid bills (TC-101 $1,200 → $800 left to pay).
 const tc101=(await db.query("SELECT id FROM parts_vendor_invoices WHERE invoice_number='TC-101'")).rows[0].id;
 const otherBill=await request('/api/bills',{method:'POST',token:admin,body:{vendor:'Napa Auto Parts',billNumber:'NAPA-1',billDate:'2026-09-01',lines:[{description:'Filters',amount:50,category:'parts'}]}});
 eq((await request(`/api/bills/${cr[0].id}/payment`,{method:'POST',token:admin,body:{applyToBillId:otherBill.id},allowError:true})).status,400,'credit cannot go on another vendor\'s bill');
 const unpaidBefore=(await request('/api/bills?from=2026-01-01&to=2026-12-31',{token:admin})).totals.unpaid;
 await request(`/api/bills/${cr[0].id}/payment`,{method:'POST',token:admin,body:{applyToBillId:tc101,paidOn:'2026-09-15'}});
 const crApplied=(await request(`/api/bills/${cr[0].id}`,{token:admin})).bill;ok(crApplied.paidAt&&crApplied.appliedToBillId===Number(tc101)&&/TC-101/.test(crApplied.paymentReference),'vendor credit applied to bill TC-101');
 const b101=(await request(`/api/bills/${tc101}`,{token:admin})).bill;eq(b101.appliedCredits,-400,'bill shows the credit');eq(b101.balanceDue,800,'left to pay $800');
 eq((await request('/api/bills?from=2026-01-01&to=2026-12-31',{token:admin})).totals.unpaid,unpaidBefore,'unpaid total unchanged: the open −$400 credit became $400 less to pay on TC-101');
 const tcList=(await request('/api/bills?from=2026-01-01&to=2026-12-31&category=core_deposits',{token:admin})).items;ok(tcList.some(x=>x.billNumber==='TC-100'&&x.categories.includes('core_deposits')&&x.hasCore),'received bill with a core is tagged and filtered as Core deposits');
 await request(`/api/bills/${cr[0].id}/payment`,{method:'DELETE',token:admin});eq((await request(`/api/bills/${tc101}`,{token:admin})).bill.balanceDue,1200,'undo applied: bill back to $1,200');
 await request(`/api/bills/${cr[0].id}/payment`,{method:'POST',token:admin,body:{applyToBillId:tc101}});
 // A second core never returned: closed → deposit moved to parts cost ($0 entry); reopened → entry voided.
 await receive('TC-102','2026-09-20',1100,{core:true});const core2=(await request('/api/inventory/cores?status=open',{token:admin})).items.find(x=>x.purchase_reference==='TC-102'||x.id!==core.id);
 const cl=await request(`/api/inventory/cores/${core2.id}`,{method:'PATCH',token:admin,body:{action:'closed',notes:'Core kept'}});ok(cl.billEntryId,'closed unreturned core → entry in Bills');
 const jb=await request(`/api/bills/${cl.billEntryId}`,{token:admin});eq(jb.bill.kind,'journal','core not returned entry');eq(jb.bill.total,0,'entry totals $0');eq(jb.quickBooks.object,'JournalEntry','QuickBooks journal entry');
 ok(jb.quickBooks.payload.Line.some(l=>l.JournalEntryLineDetail.PostingType==='Debit'&&l.Amount===400)&&jb.quickBooks.payload.Line.some(l=>l.JournalEntryLineDetail.PostingType==='Credit'&&/Core Deposits/.test(l.JournalEntryLineDetail.AccountRef.name)),'debit parts cost, credit Core Deposits');
 const cats=(await request('/api/bills?from=2026-01-01&to=2026-12-31',{token:admin})).byCategory;eq(cats.core_deposits||0,0,'Core deposits net to $0 when every core is credited or written off (TC-100 +400 −400 credit, TC-102 +400 −400 kept)');
 await request(`/api/inventory/cores/${core2.id}`,{method:'PATCH',token:admin,body:{action:'reopened'}});eq((await db.query('SELECT status FROM parts_vendor_invoices WHERE id=$1',[cl.billEntryId])).rows[0].status,'void','reopened core voids its entry');
 eq((await request('/api/bills?from=2026-01-01&to=2026-12-31',{token:admin})).byCategory.core_deposits,400,'reopened core: its $400 deposit is open again');

 {
  // v24.48.1: Fullbay Details check — read-only compare, then import fills only what was missing; junk "VINs" never land on units.
  const hdr='"Customer","Unit Status","Unit #","VIN","Unit Type","Unit Subtype","SO","Lead Tech","PO #","Inv #","Action","Action Completed Date","Tech","Complaint","Actual Correction","Hours","Labor $","Part $","Total Parts & Labor","Unit Miles","Component","System"';
  const line=(so,act,unit,vin,txt,miles)=>`="Check Fleet LLC",="Active",="${unit}",="${vin}",="Tractor",,="${so}",="[unassigned]",,="9${so}",${act},="6:58PM 8/6/2025",,="${txt}",="${txt}",1.00000,"$60.00","$10.00","$70.00",${miles},="Chassis",="Chassis"`;
  const fileA=[hdr,line('7001',1,'77','1FUJGLDR5GLV76481','Oil change',500000),line('7001',2,'77','1FUJGLDR5GLV76481','Grease chassis',500000)].join('\n');
  const fileB=[fileA,line('7002',1,'78','ACCOUNT','Brake adjust',300000)].join('\n');
  const send=async(path,parts)=>{const fd=new FormData();for(const [k,name,txt] of parts)fd.append(k,new Blob([txt],{type:'text/csv'}),name);const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${admin}`},body:fd});const d=await r.json();if(!r.ok)throw new Error(`${path} ${r.status} ${JSON.stringify(d)}`);return d};
  let chk=await send('/api/fullbay/check/service-history',[['files','a.csv',fileA]]);eq(chk.files[0].status,'customer_missing','new customer reported');eq(chk.files[0].linesMissing,2,'both lines missing before import');
  eq(Number((await db.query(`SELECT count(*) n FROM fullbay_service_history WHERE customer_name='Check Fleet LLC'`)).rows[0].n),0,'check is read-only');
  await send('/api/fullbay/import/service-history',[['file','a.csv',fileA]]);
  chk=await send('/api/fullbay/check/service-history',[['files','a.csv',fileA],['files','b.csv',fileB]]);
  eq(chk.files[0].status,'ok','imported file is complete');eq(chk.files[0].linesMissing,0,'no lines missing after import');
  eq(chk.files[1].linesMissing,1,'file B: one line missing');eq(chk.files[1].soMissing[0].so,'7002','missing SO named');ok(chk.files[1].units.missing.some(u=>u.unit==='78'),'missing unit named');ok(chk.files[1].fileIssues.badVins.some(v=>v.includes('ACCOUNT')),'junk VIN flagged in file');
  await send('/api/fullbay/import/service-history',[['file','b.csv',fileB]]);
  eq((await db.query(`SELECT vin FROM customer_units WHERE customer_name='Check Fleet LLC' AND unit_number='78'`)).rows[0].vin,null,'junk VIN not written onto the unit');
  eq((await send('/api/fullbay/check/service-history',[['files','b.csv',fileB]])).totals.linesMissing,0,'everything saved after importing B');
  console.log('PASS Fullbay Details check: read-only compare, missing SOs/units, import fills gaps, junk VINs kept off units');
 }
 console.log('PASS purchase price analytics + core balance lifecycle');console.log('Operations lifecycle integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
