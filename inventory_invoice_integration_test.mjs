import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'&&process.env.ITTR_INVENTORY_TEST_DB!=='1'){
 console.log('SKIP inventory invoice integration test: disposable DB flag is not enabled');
 process.exit(0);
}
const url=String(process.env.DATABASE_URL||'');
if(!url)throw new Error('DATABASE_URL is required for inventory invoice integration test');
const {Pool}=pg;
const db=new Pool({connectionString:url,ssl:false});
const adminUser='invadmin',adminPass='CI-Inventory-Admin-2026!',mechanicUser='invmech',mechanicPass='CI-Inventory-Mechanic-2026!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let child=null,output='',port=0,adminToken='',mechanicToken='',partId=0;

async function getFreePort(){return await new Promise((resolve,reject)=>{const server=net.createServer();server.unref();server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},()=>{const a=server.address(),p=typeof a==='object'&&a?Number(a.port):0;server.close(err=>err?reject(err):resolve(p))})})}
async function request(path,{method='GET',token,body,allowError=false}={}){
 const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined,cache:'no-store'});
 const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
 if(!r.ok&&!allowError)throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(data)}`);
 return {status:r.status,ok:r.ok,...data};
}
async function waitHealth(){for(let i=0;i<120;i++){if(child?.exitCode!=null)throw new Error(`server exited early (${child.exitCode})\n${output}`);try{const d=await request('/api/health');if(d?.ok&&d?.db)return}catch{}await sleep(100)}throw new Error(`server did not become DB-ready\n${output}`)}
async function startServer(){
 output='';port=await getFreePort();if(!port)throw new Error('Could not allocate test port');
 const env={...process.env,PORT:String(port),NODE_ENV:'test',BOOTSTRAP_ADMIN_USERNAME:adminUser,BOOTSTRAP_ADMIN_PASSWORD:adminPass,OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',SAMSARA_API_TOKEN:''};
 child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{output+=d.toString();if(output.length>50000)output=output.slice(-50000)});child.stderr.on('data',d=>{output+=d.toString();if(output.length>50000)output=output.slice(-50000)});await waitHealth();
}
async function stopServer(){if(child&&child.exitCode==null){child.kill('SIGTERM');await sleep(180);if(child.exitCode==null)child.kill('SIGKILL');await sleep(80)}child=null}
function assertEq(actual,expected,label){if(Number.isFinite(expected)){if(Math.abs(Number(actual)-expected)>0.00001)throw new Error(`${label}: expected ${expected}, got ${actual}`)}else if(actual!==expected)throw new Error(`${label}: expected ${expected}, got ${actual}`)}
function ok(value,label){if(!value)throw new Error(label)}
async function part(){return (await db.query('SELECT * FROM fullbay_import_parts WHERE id=$1',[partId])).rows[0]}
async function invoice(id){return (await db.query('SELECT * FROM customer_invoices WHERE id=$1',[id])).rows[0]}
async function lines(id){return (await db.query('SELECT * FROM customer_invoice_lines WHERE invoice_id=$1 ORDER BY id',[id])).rows}
async function setShopflow(workorders){
 await db.query(`UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by='inventory_test' WHERE state_key=$1`,['shopflow',JSON.stringify({workorders,issues:[]})]);
}
async function workOrder(id,status='Open',parts=[]){
 return {id,unit:`T${id}`,customer:'Inventory Test',status,mechanic:mechanicUser,helpers:[],truckHere:true,date:'2026-09-28',time:'12:00',tasks:[{uid:`task-${id}`,t:'Inventory repair',done:status==='Completed',parts}]};
}
async function completeWo(id){
 const r=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'"),sf=r.rows[0].payload,w=sf.workorders.find(x=>String(x.id)===String(id));w.status='Completed';w.tasks.forEach(t=>t.done=true);await setShopflow(sf.workorders);
}
async function reset({quantity=10,allocated=0,workorders=[]}={}){
 await db.query('DELETE FROM customer_invoice_payments');
 await db.query('DELETE FROM customer_invoice_lines');
 await db.query('DELETE FROM customer_invoices');
 await db.query('DELETE FROM part_inventory_transactions');
 await db.query('UPDATE fullbay_import_parts SET quantity=$2::numeric,allocated=$3::numeric,inventory_value=($2::numeric*coalesce(cost,0)),updated_at=now() WHERE id=$1',[partId,quantity,allocated]);
 await setShopflow(workorders);
}
async function addReserved(woId,qty=2){
 const uid=`task-${woId}`;
 const d=await request(`/api/work-orders/${woId}/tasks/by-uid/${encodeURIComponent(uid)}/parts`,{method:'POST',token:mechanicToken,body:{inventoryPartId:partId,partNumber:'TEST-PART',description:'Integration Part',qty,method:'integration_test'}});
 return d.part;
}
async function createWoInvoice(woId){
 const d=await request(`/api/invoices/from-work-order/${woId}`,{method:'POST',token:adminToken,body:{taxRate:0}});
 return Number(d.id);
}
async function createManualInvoice(){
 const d=await request('/api/invoices',{method:'POST',token:adminToken,body:{customerName:'Inventory Test',unitNumber:'MANUAL',taxRate:0}});
 return Number(d.id);
}
async function addManualPartLine(invoiceId,qty){
 const d=await request(`/api/invoices/${invoiceId}/lines`,{method:'POST',token:adminToken,body:{lineType:'part',description:'Integration Part',partNumber:'TEST-PART',quantity:qty,unitPrice:25,unitCost:10,taxable:false,jobName:'Parts',inventoryPartId:partId}});
 return Number(d.id);
}
async function txForInvoice(invoiceNumber,type){
 return (await db.query('SELECT * FROM part_inventory_transactions WHERE reference=$1 AND transaction_type=$2 ORDER BY id',[invoiceNumber,type])).rows;
}

try{
 await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
 await startServer();
 const admin=await request('/api/auth/login',{method:'POST',body:{username:adminUser,password:adminPass}});adminToken=admin.token;
 await request('/api/admin/users',{method:'POST',token:adminToken,body:{username:mechanicUser,display:'Inventory Test Mechanic',password:mechanicPass}});
 mechanicToken=(await request('/api/auth/login',{method:'POST',body:{username:mechanicUser,password:mechanicPass}})).token;
 const ins=await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,allocated,cost,price,inventory_value,sell_taxable,status,uom)
   VALUES('inventory-test-part','TEST-PART','Integration Part',10,0,10,25,100,true,'Active','EA') RETURNING id`);
 partId=Number(ins.rows[0].id);

 // 1. Reserve only: on-hand unchanged, allocated rises, available uses quantity-allocated.
 await reset({workorders:[await workOrder(1001)]});
 let added=await addReserved(1001,2),p=await part();
 assertEq(p.quantity,10,'1 on-hand after mechanic reserve');assertEq(p.allocated,2,'1 allocated after reserve');assertEq(Number(p.quantity)-Number(p.allocated),8,'1 available after reserve');
 assertEq(added.reservedQty,2,'1 task reservedQty');assertEq(added.stockMode,'reserve','1 task stockMode');
 console.log('PASS inventory 1: mechanic add reserves without reducing on-hand');

 // 2. Remove reservation.
 let sf=(await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'")).rows[0].payload;
 const reservedPart=sf.workorders[0].tasks[0].parts[0];
 await request(`/api/work-orders/1001/tasks/by-uid/task-1001/parts/${encodeURIComponent(reservedPart.id)}`,{method:'DELETE',token:mechanicToken});
 p=await part();assertEq(p.quantity,10,'2 on-hand after release');assertEq(p.allocated,0,'2 allocated after release');
 console.log('PASS inventory 2: mechanic remove releases allocation');

 // 3. Reserve -> completed WO -> invoice -> finalize posts one sale and releases allocation.
 await reset({workorders:[await workOrder(1002)]});await addReserved(1002,2);await completeWo(1002);
 const invoiceA=await createWoInvoice(1002);p=await part();assertEq(p.quantity,10,'3 invoice create on-hand');assertEq(p.allocated,2,'3 invoice create allocated');
 let finalize=await request(`/api/invoices/${invoiceA}/finalize`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,8,'3 finalize on-hand');assertEq(p.allocated,0,'3 finalize releases allocation');
 const invA=await invoice(invoiceA),salesA=await txForInvoice(invA.invoice_number,'invoice_sale');assertEq(salesA.length,1,'3 invoice_sale count');assertEq(salesA[0].quantity_delta,-2,'3 invoice sale delta');
 ok(salesA[0].reference===invA.invoice_number,'3 invoice transaction reference must be invoice number');
 console.log('PASS inventory 3: finalize posts sale and releases reservation');

 // 4. Finalize again is idempotent.
 await request(`/api/invoices/${invoiceA}/finalize`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,8,'4 second finalize on-hand');assertEq((await txForInvoice(invA.invoice_number,'invoice_sale')).length,1,'4 second finalize sale count');
 console.log('PASS inventory 4: finalize is idempotent');

 // 5. Edit finalized qty 2 -> 3 then delete, posting delta then returning all posted stock.
 let lineA=(await lines(invoiceA)).find(x=>x.line_type==='part');
 await request(`/api/invoices/${invoiceA}/lines/${lineA.id}`,{method:'PUT',token:adminToken,body:{lineType:'part',description:lineA.description,partNumber:lineA.part_number,quantity:3,unitPrice:Number(lineA.unit_price),unitCost:Number(lineA.unit_cost),taxable:Boolean(lineA.taxable),discountType:'fixed',discountValue:0,jobName:lineA.job_name,jobUid:lineA.job_uid,parentLineId:lineA.parent_line_id,inventoryPartId:partId}});
 p=await part();assertEq(p.quantity,7,'5 finalized qty edit on-hand');
 await request(`/api/invoices/${invoiceA}/lines/${lineA.id}`,{method:'DELETE',token:adminToken});p=await part();assertEq(p.quantity,10,'5 finalized line delete returns stock');
 console.log('PASS inventory 5: finalized line edit/delete posts matching stock adjustments');

 // 6. Hand-added linked part on draft does not move stock until finalize.
 await reset();const invoiceB=await createManualInvoice();await addManualPartLine(invoiceB,2);p=await part();assertEq(p.quantity,10,'6 manual draft on-hand');
 finalize=await request(`/api/invoices/${invoiceB}/finalize`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,8,'6 manual finalize on-hand');
 console.log('PASS inventory 6: manual linked part waits for finalize');

 // 7. Sync finalized WO invoice carries posted qty and does not double-post.
 await reset({workorders:[await workOrder(1007)]});await addReserved(1007,2);await completeWo(1007);
 const invoiceC=await createWoInvoice(1007);await request(`/api/invoices/${invoiceC}/finalize`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,8,'7 before sync on-hand');
 const salesBefore=(await txForInvoice((await invoice(invoiceC)).invoice_number,'invoice_sale')).length;
 await request(`/api/invoices/${invoiceC}/sync-work-order`,{method:'POST',token:adminToken,body:{workOrderId:'1007'}});
 p=await part();assertEq(p.quantity,8,'7 after finalized sync on-hand');assertEq((await txForInvoice((await invoice(invoiceC)).invoice_number,'invoice_sale')).length,salesBefore,'7 no duplicate sale');
 console.log('PASS inventory 7: finalized Work Order sync does not double-post');

 // 8. Void returns posted stock.
 await request(`/api/invoices/${invoiceC}/void`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,10,'8 void returns stock');
 const invC=await invoice(invoiceC);assertEq(invC.status,'void','8 invoice void status');
 console.log('PASS inventory 8: void returns posted stock');

 // 9. Legacy WO part without stockMode is treated as already posted.
 const oldPart={id:'legacy-part-1',partNumber:'TEST-PART',description:'Integration Part',qty:2,inventoryPartId:partId,unitCost:10,unitPrice:25,sellTaxable:true,addedBy:mechanicUser};
 await reset({quantity:8,workorders:[await workOrder(1009,'Completed',[oldPart])]});
 const invoiceD=await createWoInvoice(1009);let oldLine=(await lines(invoiceD)).find(x=>x.line_type==='part');assertEq(oldLine.stock_posted_qty,2,'9 legacy invoice line posted qty');
 await request(`/api/invoices/${invoiceD}/finalize`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,8,'9 legacy finalize must not deduct twice');
 console.log('PASS inventory 9: legacy already-consumed WO part is not deducted twice');

 // 10. Negative stock does not block finalize and returns warnings.
 await reset({quantity:1});const invoiceE=await createManualInvoice();await addManualPartLine(invoiceE,3);
 finalize=await request(`/api/invoices/${invoiceE}/finalize`,{method:'POST',token:adminToken});p=await part();assertEq(p.quantity,-2,'10 negative stock allowed');ok(Array.isArray(finalize.warnings)&&finalize.warnings.length>0,'10 negative stock warning missing');
 console.log('PASS inventory 10: negative stock finalize succeeds with warnings');

 // Cleanup reconciliation: stale imported allocated values are replaced by sum(reservedQty).
 const manualReserve={id:'reserve-cleanup',partNumber:'TEST-PART',description:'Integration Part',qty:2,inventoryPartId:partId,stockMode:'reserve',reservedQty:2,unitCost:10,unitPrice:25};
 await setShopflow([await workOrder(1011,'Open',[manualReserve])]);await db.query('UPDATE fullbay_import_parts SET quantity=10,allocated=99 WHERE id=$1',[partId]);
 await stopServer();await startServer();p=await part();assertEq(p.allocated,2,'cleanup recomputed allocated');
 console.log('PASS inventory cleanup: allocated is rebuilt from active reservations');

 console.log('Inventory invoice integration: 10/10 required scenarios passed + cleanup reconciliation passed');
}finally{
 await stopServer().catch(()=>{});
 await db.end().catch(()=>{});
}
