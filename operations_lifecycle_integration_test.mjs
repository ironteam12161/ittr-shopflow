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

 let bad=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{jobs:['PM service']},allowError:true});eq(bad.status,400,'truck identity must be required');
 bad=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{unit:'REQ-200',jobs:[]},allowError:true});eq(bad.status,400,'at least one job must be required');
 const started=await request('/api/work-orders/self-start',{method:'POST',token:mechanic,body:{unit:'REQ-200',customer:'Required Fields Fleet',jobs:['PM service'],inspectionRequired:true,inspectionType:'truck'}});ok(started.workOrder.unitRecordId,'work order must carry stable unit id');
 let state=await request('/api/state',{token:mechanic}),sf=state.shopflow.payload,w=sf.workorders[0];w.inspection={...w.inspection,status:'Completed',startedAt:'2026-09-01T10:00:00Z',completedAt:'2026-09-01T11:00:00Z',completedBy:'opsmech',summary:{total:2,answered:2,ok:1,attention:0,repair:1,na:0},findings:[{id:'brakes',label:'Brake condition',status:'repair',note:'Left steer worn'}],results:{brakes:{status:'repair',note:'Left steer worn'},lights:{status:'ok'}}};
 await request('/api/state/shopflow',{method:'PUT',token:mechanic,body:{payload:sf,expectedVersion:state.shopflow.version}});
 const inspection=(await db.query('SELECT * FROM mechanic_inspections WHERE work_order_id=$1',[String(w.id)])).rows[0];eq(String(inspection.unit_id),String(started.unit.id),'inspection stable unit link');eq(inspection.status,'Completed','inspection status');
 const profile=await request(`/api/customer-units/${started.unit.id}/profile`,{token:admin});ok(profile.history.some(x=>x.source==='inspection'&&String(x.workOrderId)===String(w.id)),'vehicle history must include inspection');
 console.log('PASS required WO fields + inspection-to-vehicle history');

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
 console.log('PASS purchase price analytics + core balance lifecycle');console.log('Operations lifecycle integration: all scenarios passed');
}finally{await stop().catch(()=>{});await db.end().catch(()=>{})}
