import fs from 'node:fs';

const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');
const MARK='ITTR_INVENTORY_RESERVE_FINALIZE_V1';

function replaceRoute(startToken,nextToken,newRoute,marker){
  if(s.includes(marker))return;
  const start=s.indexOf(startToken);
  if(start<0)throw new Error(`route start not found: ${startToken}`);
  const end=s.indexOf(nextToken,start+startToken.length);
  if(end<0)throw new Error(`route boundary not found after: ${startToken}`);
  s=s.slice(0,start)+newRoute.trimEnd()+'\n'+s.slice(end);
}

// Additive/idempotent schema migration. Existing production data is never reset.
if(!s.includes('ITTR_INVENTORY_POSTING_SCHEMA_V1')){
  const anchor=' CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_parent ON customer_invoice_lines(invoice_id,parent_line_id,sort_order,id);';
  const sql=` -- ITTR_INVENTORY_POSTING_SCHEMA_V1
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS inventory_part_id BIGINT;
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS stock_posted_qty NUMERIC NOT NULL DEFAULT 0;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS stock_posted_at TIMESTAMPTZ;
 CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_inventory_part ON customer_invoice_lines(inventory_part_id) WHERE inventory_part_id IS NOT NULL;
 DO $backfill$
 BEGIN
   IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_key='v285_invoice_inventory_backfill') THEN
     UPDATE customer_invoice_lines
       SET inventory_part_id=NULLIF(metadata->>'inventoryPartId','')::bigint
       WHERE inventory_part_id IS NULL AND coalesce(metadata->>'inventoryPartId','') ~ '^[0-9]+$';
     UPDATE customer_invoice_lines
       SET stock_posted_qty=quantity
       WHERE inventory_part_id IS NOT NULL;
     UPDATE customer_invoices i
       SET stock_posted_at=coalesce(i.finalized_at,i.sent_at,i.updated_at,now())
       WHERE i.status IN ('sent','partial','paid')
         AND EXISTS(SELECT 1 FROM customer_invoice_lines l WHERE l.invoice_id=i.id AND l.inventory_part_id IS NOT NULL);
     INSERT INTO schema_migrations(migration_key) VALUES('v285_invoice_inventory_backfill') ON CONFLICT DO NOTHING;
   END IF;
 END $backfill$;
 DO $ittr$
 DECLARE c record;
 BEGIN
   FOR c IN
     SELECT conname FROM pg_constraint
     WHERE conrelid='part_inventory_transactions'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) ILIKE '%transaction_type%'
   LOOP
     EXECUTE format('ALTER TABLE part_inventory_transactions DROP CONSTRAINT %I',c.conname);
   END LOOP;
 END $ittr$;
`;
  if(!s.includes(anchor))throw new Error('invoice schema migration anchor missing');
  s=s.replace(anchor,sql+anchor);
}

// Core helpers: stock posting, reservation release, and startup allocation reconciliation.
if(!s.includes('ITTR_INVENTORY_POSTING_HELPERS_V1')){
  const anchor='function invoiceMoney(v){';
  const helpers=`// ITTR_INVENTORY_POSTING_HELPERS_V1
function stockNum(v){const n=Number(v);return Number.isFinite(n)?n:0}
function invoiceMeta(v){if(v&&typeof v==='object')return v;try{return JSON.parse(String(v||'{}'))||{}}catch{return {}}}
function invoiceStockIsPosted(inv){return Boolean(inv?.stock_posted_at)}
async function postInvoiceLineStock(db,inv,line,username,warnings=[],targetQty=null,reason='Invoice stock posting'){
 if(!line?.inventory_part_id)return {posted:false};
 const target=targetQty==null?Math.max(0,stockNum(line.quantity)):Math.max(0,stockNum(targetQty));
 const posted=Math.max(0,stockNum(line.stock_posted_qty));
 const delta=target-posted;
 if(Math.abs(delta)<0.000001){
   if(targetQty==null&&Math.abs(stockNum(line.stock_posted_qty)-target)>0.000001)await db.query('UPDATE customer_invoice_lines SET stock_posted_qty=$2::numeric WHERE id=$1::bigint',[line.id,target]);
   return {posted:false,delta:0};
 }
 const pr=await db.query('SELECT id,part_number,description,quantity,allocated,cost FROM fullbay_import_parts WHERE id=$1::bigint FOR UPDATE',[line.inventory_part_id]);
 if(!pr.rowCount)throw Object.assign(new Error('Linked inventory part no longer exists.'),{status:409,code:'INVENTORY_PART_MISSING'});
 const p=pr.rows[0],before=stockNum(p.quantity),after=before-delta;
 await db.query('UPDATE fullbay_import_parts SET quantity=$2::numeric,inventory_value=($2::numeric*coalesce(cost,0::numeric)),updated_at=now() WHERE id=$1::bigint',[p.id,after]);
 const typ=delta>0?'invoice_sale':'invoice_return',qtyDelta=-delta;
 await db.query(\`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,reason,username,metadata)
 VALUES($1,$2,$3::numeric,$4::numeric,$5::numeric,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)\`,[
   p.id,typ,qtyDelta,before,after,String(inv?.work_order_id||''),String(line.job_uid||''),String(line.job_name||''),
   String(inv?.unit_number||''),String(inv?.customer_name||''),String(inv?.invoice_number||''),reason,String(username||'system'),
   JSON.stringify({invoiceId:Number(inv?.id||0)||null,invoiceNumber:String(inv?.invoice_number||''),lineId:Number(line.id||0)||null,postedBefore:posted,targetQty:target,inventoryPartId:Number(p.id)})
 ]);
 if(line?.id)await db.query('UPDATE customer_invoice_lines SET stock_posted_qty=$2::numeric WHERE id=$1::bigint',[line.id,target]);
 line.stock_posted_qty=target;
 if(after<0)warnings.push(\`\${p.part_number||p.description||'Part'}: on hand is \${after} after invoice \${inv?.invoice_number||''}.\`);
 return {posted:true,delta,after};
}
async function releaseInvoiceReservations(db,inv,lines,username){
 if(!inv?.work_order_id)return {released:0,version:null};
 const linked=(lines||[]).filter(l=>l?.inventory_part_id&&invoiceMeta(l.metadata).sourcePartId);
 if(!linked.length)return {released:0,version:null};
 const sq=await db.query("SELECT payload,version FROM app_state WHERE state_key='shopflow' FOR UPDATE");
 if(!sq.rowCount)return {released:0,version:null};
 const sf=sq.rows[0].payload&&typeof sq.rows[0].payload==='object'?sq.rows[0].payload:{workorders:[],issues:[]};
 const w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===String(inv.work_order_id));
 if(!w)return {released:0,version:null};
 let released=0;
 for(const line of linked){
   const meta=invoiceMeta(line.metadata),sourcePartId=String(meta.sourcePartId||'');
   let source=null,task=null;
   for(const t of (Array.isArray(w.tasks)?w.tasks:[])){
     const p=(Array.isArray(t.parts)?t.parts:[]).find(x=>String(x?.id||'')===sourcePartId);
     if(p){source=p;task=t;break}
   }
   if(!source||source.stockMode!=='reserve')continue;
   const qty=Math.max(0,stockNum(source.reservedQty));
   if(qty<=0)continue;
   const pr=await db.query('SELECT quantity,allocated FROM fullbay_import_parts WHERE id=$1::bigint FOR UPDATE',[line.inventory_part_id]);
   if(!pr.rowCount)continue;
   const beforeAllocated=Math.max(0,stockNum(pr.rows[0].allocated)),afterAllocated=Math.max(0,beforeAllocated-qty),onHand=stockNum(pr.rows[0].quantity);
   await db.query('UPDATE fullbay_import_parts SET allocated=$2::numeric,updated_at=now() WHERE id=$1::bigint',[line.inventory_part_id,afterAllocated]);
   await db.query(\`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,reason,username,metadata)
    VALUES($1,'release',0,$2::numeric,$2::numeric,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)\`,[
      line.inventory_part_id,onHand,String(inv.work_order_id),String(task?.uid||line.job_uid||''),String(task?.t||line.job_name||''),
      String(w.unit||inv.unit_number||''),String(w.customer||inv.customer_name||''),String(inv.invoice_number||''),
      'Reservation consumed by finalized invoice',String(username||'system'),
      JSON.stringify({invoiceId:Number(inv.id)||null,invoiceNumber:String(inv.invoice_number||''),sourcePartId,reservedQty:qty,allocatedBefore:beforeAllocated,allocatedAfter:afterAllocated})
   ]);
   source.reservedQty=0;released++;
 }
 if(!released)return {released:0,version:Number(sq.rows[0].version||0)};
 const uq=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version",[JSON.stringify(sf),String(username||'system')]);
 return {released,version:Number(uq.rows[0]?.version||0)};
}
async function reconcileReservedInventoryAllocations(){
 if(!pool)return;
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const sr=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");
  const sf=sr.rows[0]?.payload||{},wanted=new Map();
  for(const w of (Array.isArray(sf.workorders)?sf.workorders:[]))for(const t of (Array.isArray(w?.tasks)?w.tasks:[]))for(const p of (Array.isArray(t?.parts)?t.parts:[])){
    if(p?.stockMode!=='reserve'||!p?.inventoryPartId)continue;
    const qty=Math.max(0,stockNum(p.reservedQty));
    if(qty>0)wanted.set(Number(p.inventoryPartId),(wanted.get(Number(p.inventoryPartId))||0)+qty);
  }
  const rows=(await db.query('SELECT id,allocated FROM fullbay_import_parts FOR UPDATE')).rows;
  let changed=0;
  for(const row of rows){
    const next=stockNum(wanted.get(Number(row.id))||0),cur=stockNum(row.allocated);
    if(Math.abs(next-cur)<0.000001)continue;
    await db.query('UPDATE fullbay_import_parts SET allocated=$2::numeric,updated_at=now() WHERE id=$1',[row.id,next]);changed++;
  }
  await db.query('COMMIT');
  console.log(\`ITTR inventory reservation reconciliation: \${changed} part(s) changed\`);
  try{await audit('system','inventory_reservations_reconciled',{changed,reservedParts:wanted.size})}catch(e){console.warn('inventory reconciliation audit warning:',e?.message||e)}
 }catch(e){try{await db.query('ROLLBACK')}catch{};throw e}finally{db.release()}
}
`;
  if(!s.includes(anchor))throw new Error('invoice helper anchor missing');
  s=s.replace(anchor,helpers+anchor);
}

// Recompute imported/stale Fullbay allocated values from active ITTR reservations on every boot.
if(!s.includes('.then(()=>reconcileReservedInventoryAllocations())')){
  const anchor='.then(()=>ensurePartsSearchPerformance())';
  if(!s.includes(anchor))throw new Error('startup reconciliation anchor missing');
  s=s.replace(anchor,'.then(()=>reconcileReservedInventoryAllocations())\n  '+anchor);
}

// Mechanic adds an inventory part: reserve allocated only. On-hand is unchanged.
replaceRoute(
 'app.post("/api/work-orders/:id/tasks/by-uid/:taskUid/parts"',
 'app.delete("/api/work-orders/:id/tasks/by-uid/:taskUid/parts/:partId"',
 `// ${MARK}_WO_ADD
app.post("/api/work-orders/:id/tasks/by-uid/:taskUid/parts",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  const workOrderId=String(req.params.id),uid=String(req.params.taskUid||"");
  const partNumber=String(req.body?.partNumber||"").trim().slice(0,120),description=String(req.body?.description||"").trim().slice(0,500);
  const qty=Math.max(.01,Math.min(99999,Number(req.body?.qty||1))),inventoryPartId=req.body?.inventoryPartId?Number(req.body.inventoryPartId):null;
  if(!partNumber&&!description&&!inventoryPartId)return res.status(400).json({error:"Enter or scan a part."});
  await db.query("BEGIN");
  const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
  if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."})}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
  const w=sf.workorders.find(x=>String(x?.id)===workOrderId);if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."})}
  if(req.user?.role!=="admin"&&!mechanicOwnsWorkOrder(req.user,w)){await db.query("ROLLBACK");return res.status(403).json({error:"You do not have access to this work order."})}
  if(String(w.status)==="Completed"){await db.query("ROLLBACK");return res.status(409).json({error:"Completed work orders are locked."})}
  const matches=(Array.isArray(w.tasks)?w.tasks:[]).filter(t=>String(t?.uid||"")===uid);if(matches.length!==1){await db.query("ROLLBACK");return res.status(409).json({error:"Task identity could not be resolved."})}
  const t=matches[0];t.parts=Array.isArray(t.parts)?t.parts:[];
  let inv=null,finalPartNumber=partNumber,finalDescription=description;
  if(inventoryPartId){
    const ir=await db.query("SELECT * FROM fullbay_import_parts WHERE id=$1 FOR UPDATE",[inventoryPartId]);if(!ir.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Inventory part not found."})}
    inv=ir.rows[0];const onHand=stockNum(inv.quantity),allocated=Math.max(0,stockNum(inv.allocated)),available=onHand-allocated;
    if(available<qty){
      const refs=[];for(const ow of sf.workorders)for(const ot of (Array.isArray(ow?.tasks)?ow.tasks:[]))for(const op of (Array.isArray(ot?.parts)?ot.parts:[]))if(Number(op?.inventoryPartId)===inventoryPartId&&op?.stockMode==='reserve'&&stockNum(op?.reservedQty)>0)refs.push(String(ow.id));
      const unique=[...new Set(refs)].slice(0,6),detail=unique.length?\` Reserved for WO #\${unique.join(', #')}.\`:'';
      await db.query("ROLLBACK");return res.status(409).json({error:\`Only \${available} available (\${allocated} reserved).\${detail}\`,available,reserved:allocated,reservedWorkOrders:unique});
    }
    const nextAllocated=allocated+qty;
    await db.query("UPDATE fullbay_import_parts SET allocated=$2::numeric,updated_at=now() WHERE id=$1",[inventoryPartId,nextAllocated]);
    finalPartNumber=inv.part_number||partNumber;finalDescription=inv.description||description;
    await db.query(\`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,reason,username,metadata)
      VALUES($1,'reserve',0,$2::numeric,$2::numeric,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)\`,[
      inventoryPartId,onHand,workOrderId,uid,String(t.t||""),String(w.unit||""),String(w.customer||""),\`WO \${workOrderId}\`,'Reserved for work order',req.user.username,
      JSON.stringify({method:req.body?.method||"work_order",reservedQty:qty,allocatedBefore:allocated,allocatedAfter:nextAllocated})
    ]);
  }
  const part={id:\`part_\${Date.now()}_\${Math.random().toString(36).slice(2,8)}\`,partNumber:finalPartNumber,description:finalDescription,qty,inventoryPartId:inventoryPartId||null,unitCost:inv?.cost??null,unitPrice:inv?.price??null,sellTaxable:inv?.sell_taxable!==false,barcode:inv?await ensurePartBarcode(db,inventoryPartId):null,stockMode:inventoryPartId?'reserve':null,reservedQty:inventoryPartId?qty:0,addedBy:req.user.username,addedAt:new Date().toISOString()};
  t.parts.push(part);w.history=Array.isArray(w.history)?w.history:[];w.history.push({type:"part_added",at:part.addedAt,by:req.user.username,task:t.t,partNumber:finalPartNumber,description:finalDescription,qty,stockMode:part.stockMode});
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");await audit(req.user.username,"task_part_reserved",{workOrderId,taskUid:uid,partId:part.id,inventoryPartId,qty});
  res.json({ok:true,part,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at});
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}next(e)}finally{db.release()}
});`,
 `${MARK}_WO_ADD`
);

// Mechanic removes a part: release new reservations; legacy parts keep the old stock-return behavior.
replaceRoute(
 'app.delete("/api/work-orders/:id/tasks/by-uid/:taskUid/parts/:partId"',
 'app.post("/api/work-orders/:id/tasks/by-uid/:taskUid/action"',
 `// ${MARK}_WO_REMOVE
app.delete("/api/work-orders/:id/tasks/by-uid/:taskUid/parts/:partId",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  const workOrderId=String(req.params.id),uid=String(req.params.taskUid||""),partId=String(req.params.partId||"");
  await db.query("BEGIN");const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."})}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]},w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===workOrderId);
  if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."})}if(String(w.status)==="Completed"){await db.query("ROLLBACK");return res.status(409).json({error:"Completed work orders are locked."})}
  const t=(Array.isArray(w.tasks)?w.tasks:[]).find(x=>String(x?.uid||"")===uid);if(!t){await db.query("ROLLBACK");return res.status(404).json({error:"Task not found."})}
  t.parts=Array.isArray(t.parts)?t.parts:[];const p=t.parts.find(x=>String(x?.id||"")===partId);if(!p){await db.query("ROLLBACK");return res.status(404).json({error:"Part not found."})}
  if(req.user.role!=="admin"&&String(p.addedBy||"").toLowerCase()!==String(req.user.username||"").toLowerCase()){await db.query("ROLLBACK");return res.status(403).json({error:"Only the mechanic who added this part or an admin can remove it."})}
  if(p.inventoryPartId){
    const ir=await db.query("SELECT quantity,allocated FROM fullbay_import_parts WHERE id=$1 FOR UPDATE",[p.inventoryPartId]);
    if(ir.rowCount){
      const onHand=stockNum(ir.rows[0].quantity);
      if(p.stockMode==='reserve'){
        const reserved=Math.max(0,stockNum(p.reservedQty||p.qty)),beforeAllocated=Math.max(0,stockNum(ir.rows[0].allocated)),afterAllocated=Math.max(0,beforeAllocated-reserved);
        await db.query("UPDATE fullbay_import_parts SET allocated=$2::numeric,updated_at=now() WHERE id=$1",[p.inventoryPartId,afterAllocated]);
        await db.query(\`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,reason,username,metadata)
          VALUES($1,'release',0,$2::numeric,$2::numeric,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)\`,[
          p.inventoryPartId,onHand,workOrderId,uid,String(t.t||""),String(w.unit||""),String(w.customer||""),\`WO \${workOrderId}\`,'Removed reservation from work order',req.user.username,
          JSON.stringify({originalPartId:partId,reservedQty:reserved,allocatedBefore:beforeAllocated,allocatedAfter:afterAllocated})
        ]);
      }else{
        const qty=Math.max(0,stockNum(p.qty||1)),after=onHand+qty;
        await db.query("UPDATE fullbay_import_parts SET quantity=$2::numeric,inventory_value=($2::numeric*coalesce(cost,0::numeric)),updated_at=now() WHERE id=$1",[p.inventoryPartId,after]);
        await db.query(\`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,reason,username,metadata)
          VALUES($1,'returned',$2::numeric,$3::numeric,$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)\`,[
          p.inventoryPartId,qty,onHand,after,workOrderId,uid,String(t.t||""),String(w.unit||""),String(w.customer||""),\`WO \${workOrderId}\`,'Removed legacy pre-reservation part from work order',req.user.username,JSON.stringify({originalPartId:partId,legacyStockMode:true})
        ]);
      }
    }
  }
  t.parts=t.parts.filter(x=>String(x?.id||"")!==partId);
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");await audit(req.user.username,"task_part_removed",{workOrderId,taskUid:uid,partId,stockMode:p.stockMode||"legacy"});
  res.json({ok:true,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at});
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}next(e)}finally{db.release()}
});`,
 `${MARK}_WO_REMOVE`
);

// Invoice created directly from a completed work order carries inventory ids and legacy posted state.
replaceRoute(
 "app.post('/api/invoices/from-work-order/:woId'",
 "app.post('/api/invoices',auth",
 `// ${MARK}_FROM_WO
app.post('/api/invoices/from-work-order/:woId',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const woId=String(req.params.woId);
  const ex=await db.query("SELECT id FROM customer_invoices WHERE work_order_id=$1::text AND status<>'void'",[woId]);if(ex.rowCount){await db.query('ROLLBACK');return res.json({ok:true,id:ex.rows[0].id,existing:true})}
  const sq=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");const sf=sq.rows[0]?.payload||{},w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===woId);
  if(!w){await db.query('ROLLBACK');return res.status(404).json({error:'Work order not found.'})}if(String(w.status)!=='Completed'){await db.query('ROLLBACK');return res.status(409).json({error:'Complete the work order before creating its invoice.'})}
  let cust=null;if(w.customerId)cust=(await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint',[w.customerId])).rows[0]||null;if(!cust&&w.customer)cust=(await db.query('SELECT * FROM fullbay_import_customers WHERE lower(customer_name)=lower($1::text) LIMIT 1',[w.customer])).rows[0]||null;
  const num=await nextInvoiceNumber(db),rate=invoiceMoney(cust?.default_labor_rate||req.body?.laborRate||0),terms=String(cust?.credit_terms||'Due on Receipt'),days=/30/.test(terms)?30:/15/.test(terms)?15:/45/.test(terms)?45:0;
  const ins=await db.query(\`INSERT INTO customer_invoices(invoice_number,work_order_id,customer_id,customer_name,unit_number,vin,po_number,invoice_date,due_date,terms,tax_rate,created_by) VALUES($1,$2,$3::bigint,$4,$5,$6,$7,CURRENT_DATE,CURRENT_DATE+$8::int,$9,$10::numeric,$11) RETURNING id\`,[num,woId,cust?.id||null,w.customer||cust?.customer_name||'Customer',w.unit||'',w.vin||'',w.poNumber||'',days,terms,Number(req.body?.taxRate||0),req.user.username]);
  const id=ins.rows[0].id,sessions=(await db.query(\`SELECT task_uid,sum(extract(epoch from (coalesce(ended_at,now())-started_at))/3600.0) hours FROM task_time_sessions WHERE work_order_id=$1::text AND ended_at IS NOT NULL GROUP BY task_uid\`,[woId])).rows,hm=new Map(sessions.map(x=>[String(x.task_uid),Number(x.hours||0)]));let order=0;
  for(const t of (Array.isArray(w.tasks)?w.tasks:[])){
   const job=String(t.t||'Repair'),hours=Math.round((hm.get(String(t.uid||''))||0)*100)/100;
   const labor=(await db.query(\`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,quantity,unit_price,unit_cost,taxable,line_total,metadata,parent_line_id) VALUES($1,$2,$3,$4,'labor',$5,$6::numeric,$7::numeric,0,false,$6::numeric*$7::numeric,$8::jsonb,NULL) RETURNING id\`,[id,++order,String(t.uid||''),job,job,hours,rate,JSON.stringify({outcome:t.outcome||'',note:t.outcomeNote||''})])).rows[0];
   for(const p of (Array.isArray(t.parts)?t.parts:[])){
    const qty=Math.max(.01,stockNum(p.qty||1)),inventoryPartId=p.inventoryPartId?Number(p.inventoryPartId):null,legacyPosted=inventoryPartId&&p.stockMode!=='reserve'?qty:0;
    await db.query(\`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,line_total,metadata,parent_line_id,inventory_part_id,stock_posted_qty)
      VALUES($1,$2,$3,$4,'part',$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$7::numeric*$8::numeric,$11::jsonb,$12::bigint,$13::bigint,$14::numeric)\`,[
      id,++order,String(t.uid||''),job,String(p.description||p.partNumber||'Part'),String(p.partNumber||''),qty,Number(p.unitPrice||0),Number(p.unitCost||0),p.sellTaxable!==false,
      JSON.stringify({inventoryPartId,sourcePartId:p.id||null,workOrderId:woId,stockMode:p.stockMode||'legacy'}),labor.id,inventoryPartId,legacyPosted
    ]);
   }
  }
  await recalcInvoice(db,id);await db.query('COMMIT');await audit(req.user.username,'invoice_created',{invoiceId:id,workOrderId:woId});res.json({ok:true,id});
 }catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}
});`,
 `${MARK}_FROM_WO`
);

// Line POST: draft changes do not affect stock; finalized invoices post immediately.
replaceRoute(
 "app.post('/api/invoices/:id/lines'",
 "app.put('/api/invoices/:id/lines/:lineId'",
 `// ${MARK}_LINE_POST
app.post('/api/invoices/:id/lines',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const id=req.params.id,b=req.body||{},inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];
  if(!inv){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked.'})}
  const typ=['labor','part','fee','sublet','other'].includes(b.lineType)?b.lineType:'other';let parentLineId=b.parentLineId?Number(b.parentLineId):null,jobUid=String(b.jobUid||''),jobName=String(b.jobName||'');
  if(parentLineId){const p=(await db.query(\`SELECT id,job_uid,job_name FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint AND line_type='labor'\`,[parentLineId,id])).rows[0];if(!p){await db.query('ROLLBACK');return res.status(409).json({error:'Parent labor operation not found.'})}jobUid=String(p.job_uid||'');jobName=String(p.job_name||'');if(typ==='labor')parentLineId=null}
  const qty=Math.max(0,Number(b.quantity||0)),price=Math.max(0,Number(b.unitPrice||0)),discountType=String(b.discountType||'fixed')==='percent'?'percent':'fixed',discountValue=Math.max(0,Number(b.discountValue??b.discount??0)),discount=invoiceLineDiscount(qty,price,discountType,discountValue),inventoryPartId=typ==='part'&&b.inventoryPartId?Number(b.inventoryPartId):null;
  const q=await db.query(\`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,discount,discount_type,discount_value,line_total,parent_line_id,inventory_part_id,stock_posted_qty,metadata)
    VALUES($1::bigint,(SELECT coalesce(max(sort_order),0)+1 FROM customer_invoice_lines WHERE invoice_id=$1::bigint),$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$11::numeric,$12,$13::numeric,greatest(0,$7::numeric*$8::numeric-$11::numeric),$14::bigint,$15::bigint,0,$16::jsonb) RETURNING *\`,[
    id,jobUid,jobName,typ,String(b.description??''),String(b.partNumber||''),qty,price,Number(b.unitCost||0),b.taxable===true,discount,discountType,discountValue,parentLineId,inventoryPartId,
    JSON.stringify(inventoryPartId?{inventoryPartId,sourcePartId:b.sourcePartId||null,workOrderId:inv.work_order_id||null}:{})
  ]);
  const warnings=[];if(invoiceStockIsPosted(inv)&&inventoryPartId)await postInvoiceLineStock(db,inv,q.rows[0],req.user.username,warnings,null,'Part line added after invoice finalization');
  await recalcInvoice(db,id);await db.query('COMMIT');res.json({ok:true,id:q.rows[0].id,warnings});
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(e?.status)return res.status(e.status).json({error:e.message,code:e.code});next(e)}finally{db.release()}
});`,
 `${MARK}_LINE_POST`
);

// Line PUT: after finalization, post only the quantity/link difference.
replaceRoute(
 "app.put('/api/invoices/:id/lines/:lineId'",
 "app.delete('/api/invoices/:id/lines/:lineId'",
 `// ${MARK}_LINE_PUT
app.put('/api/invoices/:id/lines/:lineId',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const b=req.body||{},id=req.params.id,inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];
  if(!inv||!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked or missing.'})}
  const old=(await db.query('SELECT * FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint FOR UPDATE',[req.params.lineId,id])).rows[0];if(!old){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice line not found.'})}
  const typ=['labor','part','fee','sublet','other'].includes(b.lineType)?b.lineType:'other';let parentLineId=typ==='labor'?null:(b.parentLineId?Number(b.parentLineId):null),jobName=String(b.jobName||''),jobUid=String(b.jobUid||'');
  if(parentLineId){const p=(await db.query(\`SELECT job_uid,job_name FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint AND line_type='labor'\`,[parentLineId,id])).rows[0];if(!p){await db.query('ROLLBACK');return res.status(409).json({error:'Parent labor operation not found.'})}jobName=String(p.job_name||jobName);jobUid=String(p.job_uid||jobUid)}
  const qty=Math.max(0,Number(b.quantity||0)),price=Math.max(0,Number(b.unitPrice||0)),discountType=String(b.discountType||'fixed')==='percent'?'percent':'fixed',discountValue=Math.max(0,Number(b.discountValue??b.discount??0)),discount=invoiceLineDiscount(qty,price,discountType,discountValue),newInventoryPartId=typ==='part'?(b.inventoryPartId?Number(b.inventoryPartId):null):null,warnings=[];
  if(invoiceStockIsPosted(inv)&&old.inventory_part_id&&Number(old.inventory_part_id)!==Number(newInventoryPartId||0))await postInvoiceLineStock(db,inv,old,req.user.username,warnings,0,'Invoice line inventory link changed');
  const keepPosted=Number(old.inventory_part_id||0)===Number(newInventoryPartId||0)?Math.max(0,stockNum(old.stock_posted_qty)):0;
  const meta={...invoiceMeta(old.metadata)};if(newInventoryPartId)meta.inventoryPartId=newInventoryPartId;else delete meta.inventoryPartId;
  await db.query(\`UPDATE customer_invoice_lines SET job_uid=$3,job_name=$4,line_type=$5,description=$6,part_number=$7,quantity=$8::numeric,unit_price=$9::numeric,unit_cost=$10::numeric,taxable=$11::boolean,discount=$12::numeric,discount_type=$13,discount_value=$14::numeric,line_total=greatest(0,$8::numeric*$9::numeric-$12::numeric),parent_line_id=$15::bigint,inventory_part_id=$16::bigint,stock_posted_qty=$17::numeric,metadata=$18::jsonb WHERE id=$2::bigint AND invoice_id=$1::bigint\`,[
    id,req.params.lineId,jobUid,jobName,typ,String(b.description||''),String(b.partNumber||''),qty,price,Number(b.unitCost||0),b.taxable===true,discount,discountType,discountValue,parentLineId,newInventoryPartId,keepPosted,JSON.stringify(meta)
  ]);
  const fresh=(await db.query('SELECT * FROM customer_invoice_lines WHERE id=$1::bigint',[req.params.lineId])).rows[0];if(invoiceStockIsPosted(inv)&&fresh?.inventory_part_id)await postInvoiceLineStock(db,inv,fresh,req.user.username,warnings,null,'Invoice line edited after finalization');
  await recalcInvoice(db,id);await db.query('COMMIT');res.json({ok:true,warnings});
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(e?.status)return res.status(e.status).json({error:e.message,code:e.code});next(e)}finally{db.release()}
});`,
 `${MARK}_LINE_PUT`
);

// Line DELETE: return posted stock for the line and any child lines before deletion.
replaceRoute(
 "app.delete('/api/invoices/:id/lines/:lineId'",
 "app.post('/api/invoices/:id/sync-work-order'",
 `// ${MARK}_LINE_DELETE
app.delete('/api/invoices/:id/lines/:lineId',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const id=req.params.id,inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];
  if(!inv||!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked or missing.'})}
  const target=(await db.query('SELECT * FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint FOR UPDATE',[req.params.lineId,id])).rows[0];if(!target){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice line not found.'})}
  const rows=target.line_type==='labor'?(await db.query('SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint AND (id=$2::bigint OR parent_line_id=$2::bigint) ORDER BY id FOR UPDATE',[id,req.params.lineId])).rows:[target],warnings=[];
  if(invoiceStockIsPosted(inv))for(const line of rows)if(line.inventory_part_id&&stockNum(line.stock_posted_qty)>0)await postInvoiceLineStock(db,inv,line,req.user.username,warnings,0,'Invoice line deleted after finalization');
  if(target.line_type==='labor')await db.query('DELETE FROM customer_invoice_lines WHERE parent_line_id=$1::bigint AND invoice_id=$2::bigint',[req.params.lineId,id]);
  await db.query('DELETE FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint',[req.params.lineId,id]);await recalcInvoice(db,id);await db.query('COMMIT');res.json({ok:true,warnings});
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(e?.status)return res.status(e.status).json({error:e.message,code:e.code});next(e)}finally{db.release()}
});`,
 `${MARK}_LINE_DELETE`
);

// Sync from work order preserves posted quantities by inventory id + source part id and posts only differences.
replaceRoute(
 "app.post('/api/invoices/:id/sync-work-order'",
 "app.post('/api/invoices/:id/finalize'",
 `// ${MARK}_SYNC_WO
app.post('/api/invoices/:id/sync-work-order',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const id=req.params.id,inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];
  if(!inv){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked.'})}
  const requested=String(req.body?.workOrderId||inv.work_order_id||'').trim();if(!requested){await db.query('ROLLBACK');return res.status(400).json({error:'Work Order is required.'})}
  const sq=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");const sf=sq.rows[0]?.payload||{},w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===requested);if(!w){await db.query('ROLLBACK');return res.status(404).json({error:'Work order not found.'})}
  const oldParts=(await db.query("SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint AND line_type='part' FOR UPDATE",[id])).rows;
  const oldMap=new Map();for(const l of oldParts){const m=invoiceMeta(l.metadata),key=\`\${Number(l.inventory_part_id||m.inventoryPartId||0)}|\${String(m.sourcePartId||'')}\`;if(!oldMap.has(key))oldMap.set(key,[]);oldMap.get(key).push(l)}
  const desiredKeys=new Set();for(const t of (Array.isArray(w.tasks)?w.tasks:[]))for(const p of (Array.isArray(t.parts)?t.parts:[]))desiredKeys.add(\`\${Number(p.inventoryPartId||0)}|\${String(p.id||'')}\`);
  const warnings=[];if(invoiceStockIsPosted(inv))for(const l of oldParts){const m=invoiceMeta(l.metadata),key=\`\${Number(l.inventory_part_id||m.inventoryPartId||0)}|\${String(m.sourcePartId||'')}\`;if(!desiredKeys.has(key)&&l.inventory_part_id&&stockNum(l.stock_posted_qty)>0)await postInvoiceLineStock(db,inv,l,req.user.username,warnings,0,'Removed by finalized Work Order sync')}
  await db.query('DELETE FROM customer_invoice_lines WHERE invoice_id=$1::bigint',[id]);
  const sessions=(await db.query(\`SELECT task_uid,sum(extract(epoch from (coalesce(ended_at,now())-started_at))/3600.0) hours FROM task_time_sessions WHERE work_order_id=$1::text AND ended_at IS NOT NULL GROUP BY task_uid\`,[requested])).rows,hm=new Map(sessions.map(x=>[String(x.task_uid),Number(x.hours||0)]));
  const rate=Number(req.body?.laborRate||0)||Number((await db.query('SELECT default_labor_rate FROM fullbay_import_customers WHERE id::text=$1::text',[inv.customer_id||'0'])).rows[0]?.default_labor_rate||0);let order=0,jobs=0,parts=0,hoursTotal=0,newPartLines=[];
  for(const t of (Array.isArray(w.tasks)?w.tasks:[])){
   const uid=String(t.uid||''),job=String(t.t||'Repair'),hours=Math.round((hm.get(uid)||0)*100)/100;hoursTotal+=hours;jobs++;
   const labor=(await db.query(\`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,quantity,unit_price,unit_cost,taxable,line_total,metadata,parent_line_id) VALUES($1,$2,$3,$4,'labor',$5,$6::numeric,$7::numeric,0,false,$6::numeric*$7::numeric,$8::jsonb,NULL) RETURNING id\`,[id,++order,uid,job,job,hours,rate,JSON.stringify({syncedFromWorkOrder:requested,outcome:t.outcome||'',note:t.outcomeNote||'',status:t.done?'completed':t.paused?'paused':'active'})])).rows[0];
   for(const p of (Array.isArray(t.parts)?t.parts:[])){
    const inventoryPartId=p.inventoryPartId?Number(p.inventoryPartId):null,qty=Math.max(.01,stockNum(p.qty||1)),key=\`\${Number(inventoryPartId||0)}|\${String(p.id||'')}\`,priorList=oldMap.get(key)||[],prior=priorList.shift()||null;
    const carried=prior?Math.max(0,stockNum(prior.stock_posted_qty)):(inventoryPartId&&p.stockMode!=='reserve'?qty:0),cost=Math.max(0,Number(p.unitCost||0)),price=Math.max(0,Number(p.unitPrice||0));
    const row=(await db.query(\`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,line_total,metadata,parent_line_id,inventory_part_id,stock_posted_qty)
      VALUES($1,$2,$3,$4,'part',$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$7::numeric*$8::numeric,$11::jsonb,$12::bigint,$13::bigint,$14::numeric) RETURNING *\`,[
      id,++order,uid,job,String(p.description||p.partNumber||'Part'),String(p.partNumber||''),qty,price,cost,p.sellTaxable!==false,
      JSON.stringify({syncedFromWorkOrder:requested,inventoryPartId,sourcePartId:p.id||null,workOrderId:requested,stockMode:p.stockMode||'legacy'}),labor.id,inventoryPartId,carried
    ])).rows[0];newPartLines.push(row);parts++;
   }
  }
  const currentInv={...inv,work_order_id:requested};if(invoiceStockIsPosted(inv)){for(const l of newPartLines)if(l.inventory_part_id)await postInvoiceLineStock(db,currentInv,l,req.user.username,warnings,null,'Finalized invoice Work Order sync');await releaseInvoiceReservations(db,currentInv,newPartLines,req.user.username)}
  await db.query('UPDATE customer_invoices SET work_order_id=$2,updated_at=now() WHERE id=$1::bigint',[id,requested]);await recalcInvoice(db,id);await db.query('COMMIT');
  await audit(req.user.username,'invoice_work_order_synced',{invoiceId:id,workOrderId:requested,jobs,parts,hours:hoursTotal,stockPosted:invoiceStockIsPosted(inv)});res.json({ok:true,workOrderId:requested,jobs,parts,hours:hoursTotal,warnings});
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(e?.status)return res.status(e.status).json({error:e.message,code:e.code});next(e)}finally{db.release()}
});`,
 `${MARK}_SYNC_WO`
);

// Finalize: post each line's difference, consume reservations, allow/log negative stock, idempotent.
replaceRoute(
 "app.post('/api/invoices/:id/finalize'",
 "app.post('/api/invoices/:id/payments'",
 `// ${MARK}_FINALIZE
app.post('/api/invoices/:id/finalize',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const id=req.params.id,before=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];
  if(!before){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(['void','paid'].includes(String(before.status||'').toLowerCase())){await db.query('ROLLBACK');return res.status(409).json({error:'Paid or void invoices are locked and cannot be reopened.'})}
  const inv=await recalcInvoice(db,id);if(invoiceMoney(inv.total)<=0){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice total must be greater than zero.'})}
  const lines=(await db.query("SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint AND line_type='part' ORDER BY id FOR UPDATE",[id])).rows,warnings=[];
  for(const line of lines)if(line.inventory_part_id)await postInvoiceLineStock(db,inv,line,req.user.username,warnings,null,'Invoice finalized');
  const released=await releaseInvoiceReservations(db,inv,lines,req.user.username);
  const uq=await db.query("UPDATE customer_invoices SET status=CASE WHEN amount_paid>0 THEN 'partial' ELSE 'sent' END,finalized_at=coalesce(finalized_at,now()),sent_at=coalesce(sent_at,now()),stock_posted_at=coalesce(stock_posted_at,now()),updated_at=now() WHERE id=$1::bigint RETURNING stock_posted_at",[id]);
  await db.query('COMMIT');await audit(req.user.username,'invoice_finalized',{invoiceId:id,invoiceNumber:inv.invoice_number,warnings:warnings.length,reservationsReleased:released.released});
  res.json({ok:true,warnings,stockPostedAt:uq.rows[0]?.stock_posted_at||null});
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(e?.status)return res.status(e.status).json({error:e.message,code:e.code});next(e)}finally{db.release()}
});`,
 `${MARK}_FINALIZE`
);

// Void returns every posted invoice quantity to stock before changing status.
replaceRoute(
 "app.post('/api/invoices/:id/void'",
 "app.delete('/api/invoices/:id'",
 `// ${MARK}_VOID
app.post('/api/invoices/:id/void',auth,managerPermission("invoices"),async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  await db.query('BEGIN');const id=req.params.id,inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];
  if(!inv){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(stockNum(inv.amount_paid)>0){await db.query('ROLLBACK');return res.status(409).json({error:'Paid invoices cannot be voided until payments are reconciled.'})}
  const lines=(await db.query("SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint AND line_type='part' ORDER BY id FOR UPDATE",[id])).rows,warnings=[];
  for(const line of lines)if(line.inventory_part_id&&stockNum(line.stock_posted_qty)>0)await postInvoiceLineStock(db,inv,line,req.user.username,warnings,0,'Invoice voided');
  await db.query("UPDATE customer_invoices SET status='void',updated_at=now() WHERE id=$1::bigint",[id]);await db.query('COMMIT');await audit(req.user.username,'invoice_voided',{invoiceId:id,invoiceNumber:inv.invoice_number});
  res.json({ok:true,warnings});
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(e?.status)return res.status(e.status).json({error:e.message,code:e.code});next(e)}finally{db.release()}
});`,
 `${MARK}_VOID`
);

// Frontend: persist inventory links, show negative-stock warnings, and clarify stock columns.
for(const fp of ['index.html','public/index.html']){
 if(!fs.existsSync(fp))throw new Error(`${fp} missing`);
 let h=fs.readFileSync(fp,'utf8');
 if(!h.includes('ITTR_INVENTORY_UI_V1')){
  const payloadOld=`function invoiceLinePayload(id){const el=document.querySelector(\`[data-invoice-line="\${id}"]\`);if(!el)return null;const old=activeInvoice.lines.find(x=>String(x.id)===String(id))||{},lineType=el.querySelector('.ilType')?.value||old.line_type||'other',parentLineId=Number(el.querySelector('.ilParent')?.value||0)||null;return {lineType,description:el.querySelector('.ilDesc')?.value||'',partNumber:lineType==='part'?(el.querySelector('.ilPart')?.value||''):'',quantity:Number(el.querySelector('.ilQty')?.value||0),unitPrice:Number(el.querySelector('.ilPrice')?.value||0),unitCost:Number(el.querySelector('.ilCost')?.value||old.unit_cost||0),taxable:Boolean(el.querySelector('.ilTax')?.checked),discountType:el.querySelector('.ilDiscountType')?.value||'fixed',discountValue:Number(el.querySelector('.ilDiscountValue')?.value||0),jobName:String(el.querySelector('.ilJob')?.value||old.job_name||'Service').trim()||'Service',jobUid:String(old.job_uid||''),parentLineId}}`;
  const payloadNew=`// ITTR_INVENTORY_UI_V1
function invoiceLinePayload(id){const el=document.querySelector(\`[data-invoice-line="\${id}"]\`);if(!el)return null;const old=activeInvoice.lines.find(x=>String(x.id)===String(id))||{},lineType=el.querySelector('.ilType')?.value||old.line_type||'other',parentLineId=Number(el.querySelector('.ilParent')?.value||0)||null,inventoryPartId=lineType==='part'?(Number(el.dataset.inventoryPartId||old.inventory_part_id||0)||null):null;return {lineType,description:el.querySelector('.ilDesc')?.value||'',partNumber:lineType==='part'?(el.querySelector('.ilPart')?.value||''):'',quantity:Number(el.querySelector('.ilQty')?.value||0),unitPrice:Number(el.querySelector('.ilPrice')?.value||0),unitCost:Number(el.querySelector('.ilCost')?.value||old.unit_cost||0),taxable:Boolean(el.querySelector('.ilTax')?.checked),discountType:el.querySelector('.ilDiscountType')?.value||'fixed',discountValue:Number(el.querySelector('.ilDiscountValue')?.value||0),jobName:String(el.querySelector('.ilJob')?.value||old.job_name||'Service').trim()||'Service',jobUid:String(old.job_uid||''),parentLineId,inventoryPartId}}`;
  if(!h.includes(payloadOld))throw new Error(`${fp}: invoiceLinePayload anchor missing`);
  h=h.replace(payloadOld,payloadNew);
  h=h.replace('data-invoice-line="${l.id}"><div class="invoiceGridItemLabel is-part">','data-invoice-line="${l.id}" data-inventory-part-id="${l.inventory_part_id||(l.metadata&&typeof l.metadata===\'object\'?l.metadata.inventoryPartId:\'\')||\'\'}"><div class="invoiceGridItemLabel is-part">');
  const finalOld=`async function finalizeInvoice(id){if(!confirm('Finalize this invoice and mark it sent/open? Review prices, tax and customer PO first.'))return;if(!(await saveInvoiceHeader()))return;const r=await fetch(\`/api/invoices/\${id}/finalize\`,{method:'POST',headers:authHeaders()}),d=await r.json();if(!r.ok)return alert(d.error||'Unable to finalize');await openInvoice(id);await loadInvoices()}`;
  const finalNew=`async function finalizeInvoice(id){if(!confirm('Finalize this invoice and mark it sent/open? Review prices, tax and customer PO first.'))return;if(!(await saveInvoiceHeader()))return;const r=await fetch(\`/api/invoices/\${id}/finalize\`,{method:'POST',headers:authHeaders()}),d=await r.json();if(!r.ok)return alert(d.error||'Unable to finalize');if(Array.isArray(d.warnings)&&d.warnings.length)showToast?.('Inventory warning: '+d.warnings.join(' · '),'warning',12000);await openInvoice(id);await loadInvoices()}`;
  if(!h.includes(finalOld))throw new Error(`${fp}: finalize UI anchor missing`);
  h=h.replace(finalOld,finalNew);
  h=h.replace('<th>Part</th><th>Description</th><th>Available</th><th>Allocated</th><th>Location</th><th>Sell</th><th></th>','<th>Part</th><th>Description</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Location</th><th>Sell</th><th></th>');
  h=h.replace('<td data-label="Available" class="${partStockClass(x)}">${Number(x.available||0).toLocaleString()} ${esc(cleanImportedDisplayText(x.uom)||\'\')}</td><td data-label="Allocated">${Number(x.allocated||0).toLocaleString()}</td><td data-label="Location">','<td data-label="On hand">${Number(x.quantity||0).toLocaleString()} ${esc(cleanImportedDisplayText(x.uom)||\'\')}</td><td data-label="Reserved">${Number(x.allocated||0).toLocaleString()}</td><td data-label="Available" class="${partStockClass(x)}">${Number(x.available||0).toLocaleString()} ${esc(cleanImportedDisplayText(x.uom)||\'\')}</td><td data-label="Location">');
  h=h.replace('#partsList .partsTable td[data-label="Allocated"],#partsList .partsTable td[data-label="Sell"]{display:none!important}','#partsList .partsTable td[data-label="Sell"]{display:none!important}');
  h=h.replace('<span>Allocated</span><b>${Number(x.allocated||0).toLocaleString()}</b>','<span>Reserved</span><b>${Number(x.allocated||0).toLocaleString()}</b>');
 }
 fs.writeFileSync(fp,h,'utf8');
}

fs.writeFileSync(serverPath,s,'utf8');
console.log('ITTR inventory reserve-on-WO / post-on-invoice-finalize patch applied');
