import fs from 'node:fs';

const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');

function replaceOnce(label,oldText,newText,alreadyMarker=''){
  if(alreadyMarker && s.includes(alreadyMarker))return;
  const i=s.indexOf(oldText);
  if(i<0)throw new Error(`${label} target not found`);
  s=s.slice(0,i)+newText+s.slice(i+oldText.length);
}

// 1) Replace the generic cloud-state writer with optimistic concurrency + role-aware merging.
if(!s.includes('ITTR v24.27.0 state integrity hardening')){
  const startNeedle='app.put("/api/state/:key",auth,async(req,res,next)=>{try{';
  const start=s.indexOf(startNeedle);
  if(start<0)throw new Error('state writer route not found');
  const endToken='}catch(e){next(e)}});';
  const endAt=s.indexOf(endToken,start);
  if(endAt<0)throw new Error('state writer route end not found');
  const end=endAt+endToken.length;
  const route=`// ITTR v24.27.0 state integrity hardening\napp.put("/api/state/:key",auth,async(req,res,next)=>{\n const db=await requireDb().connect();\n try{\n  const key=String(req.params.key);\n  if(!["users","shopflow","pro"].includes(key)){db.release();return res.status(400).json({error:"Invalid state key"})}\n  if(key==="users"&&req.user?.role!=="admin"){db.release();return res.status(403).json({error:"Owner/Admin access required."})}\n  if(key==="pro"&&!['admin','manager'].includes(req.user?.role)){db.release();return res.status(403).json({error:"Manager access required."})}\n  if(req.user?.role==="mechanic"&&key!=="shopflow"){db.release();return res.status(403).json({error:"Mechanics cannot replace shared administrative state."})}\n  const payload=req.body?.payload;if(payload===undefined){db.release();return res.status(400).json({error:"payload required"})}\n  const expectedVersion=Number(req.body?.expectedVersion||0);\n  if(!Number.isInteger(expectedVersion)||expectedVersion<=0){db.release();return res.status(409).json({error:"A current server version is required before saving. Refresh first to protect newer shop data.",code:"STATE_VERSION_REQUIRED"})}\n  await db.query('BEGIN');\n  const curQ=await db.query("SELECT payload,version FROM app_state WHERE state_key=$1 FOR UPDATE",[key]);\n  if(!curQ.rowCount){await db.query('ROLLBACK');db.release();return res.status(404).json({error:"State record not found."})}\n  const currentVersion=Number(curQ.rows[0].version||0);\n  if(currentVersion!==expectedVersion){await db.query('ROLLBACK');db.release();return res.status(409).json({error:"This data changed on another device before your save. The newer server copy was protected. Refresh and try again.",serverVersion:currentVersion,code:"STATE_VERSION_CONFLICT"})}\n  let nextPayload=payload;\n  if(req.user?.role==="mechanic"){\n    const current=(curQ.rows[0].payload&&typeof curQ.rows[0].payload==='object')?curQ.rows[0].payload:{workorders:[],issues:[]};\n    const incoming=(payload&&typeof payload==='object')?payload:{workorders:[],issues:[]};\n    const clean=(v,depth=0)=>{if(depth>10)return null;if(typeof v==='string')return v.replace(/[<>]/g,'').slice(0,20000);if(Array.isArray(v))return v.slice(0,5000).map(x=>clean(x,depth+1));if(v&&typeof v==='object'){const o={};for(const [k,x] of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k))continue;o[k]=clean(x,depth+1)}return o}return v};\n    const currentW=Array.isArray(current.workorders)?current.workorders:[],incomingW=Array.isArray(incoming.workorders)?incoming.workorders:[];\n    const incomingById=new Map(incomingW.map(w=>[String(w?.id||''),w]));\n    const ownedIds=new Set(currentW.filter(w=>mechanicOwnsWorkOrder(req.user,w)).map(w=>String(w?.id||'')));\n    const protectedKeys=['id','unit','customer','customerId','unitRecordId','vin','dotNumber','year','make','model','plate','mechanic','helpers','priority','parking','unitType','truckHere','date','time','createdAt','createdBy','createdVia'];\n    const workorders=currentW.map(old=>{\n      if(!ownedIds.has(String(old?.id||'')))return old;\n      const proposed=incomingById.get(String(old?.id||''));if(!proposed)return old;\n      const merged=clean(proposed);for(const k of protectedKeys)merged[k]=old[k];\n      const oldHistory=Array.isArray(old.history)?old.history:[],newHistory=Array.isArray(merged.history)?merged.history:[];\n      merged.history=[...oldHistory,...newHistory.slice(oldHistory.length).map(x=>clean(x))];\n      if(Array.isArray(merged.tasks)){const oldTasks=new Map((Array.isArray(old.tasks)?old.tasks:[]).map(t=>[String(t?.uid||''),t]));merged.tasks=merged.tasks.map(t=>{const prior=oldTasks.get(String(t?.uid||''));if(!prior||!prior.findingId)return t;return {...t,findingId:prior.findingId,source:prior.source,findingDecision:prior.findingDecision,approvalChangedAt:prior.approvalChangedAt,approvalChangedBy:prior.approvalChangedBy,cancelled:prior.cancelled,declinedAt:prior.declinedAt,declinedBy:prior.declinedBy}})}\n      return merged;\n    });\n    const currentI=Array.isArray(current.issues)?current.issues:[],incomingI=Array.isArray(incoming.issues)?incoming.issues:[];\n    const incomingIssues=new Map(incomingI.map(i=>[String(i?.id||''),i]));\n    const existingIds=new Set(currentI.map(i=>String(i?.id||'')));\n    const issues=currentI.map(old=>{\n      if(!ownedIds.has(String(old?.wo||'')))return old;const proposed=incomingIssues.get(String(old?.id||''));if(!proposed)return old;const x=clean(proposed);\n      for(const k of ['id','wo','createdAt','created','mechanic','approval','adminNote','decisionAt','decisionBy','convertedToTask'])x[k]=old[k];return x;\n    });\n    for(const proposed of incomingI){const id=String(proposed?.id||'');if(existingIds.has(id)||!ownedIds.has(String(proposed?.wo||'')))continue;const x=clean(proposed);x.mechanic=req.user.username;x.approval='Waiting for Customer';x.adminNote='';x.decisionAt='';x.decisionBy='';x.convertedToTask=false;issues.push(x)}\n    nextPayload={...current,workorders,issues};\n  }\n  const q=await db.query("UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1 AND version=$4 RETURNING version,updated_at",[key,JSON.stringify(nextPayload),req.user.username,expectedVersion]);\n  if(!q.rowCount){await db.query('ROLLBACK');db.release();return res.status(409).json({error:"This data changed before the save completed. Refresh and try again.",code:"STATE_VERSION_CONFLICT"})}\n  await db.query('COMMIT');\n  await audit(req.user.username,"state_save",{key,expectedVersion,role:req.user?.role});\n  if(key==="shopflow")broadcastShopStatus("shopflow_changed",{by:req.user.username,version:Number(q.rows[0].version)});\n  db.release();res.json({ok:true,version:Number(q.rows[0].version),updatedAt:q.rows[0].updated_at});\n }catch(e){try{await db.query('ROLLBACK')}catch(_){};db.release();next(e)}\n});`;
  s=s.slice(0,start)+route+s.slice(end);
}

// 2) Legacy whole-database browser import is owner-only.
s=s.replace('app.post("/api/state/import-local",auth,adminOnly,async(req,res,next)=>{try{','app.post("/api/state/import-local",auth,ownerOnly,async(req,res,next)=>{try{');

// 3) Prevent a mechanic from running timers on multiple work orders at once.
const oldTimer=`const another=w.tasks.findIndex(t=>String(t?.uid||"")!==uid && taskRunning(t) && taskRunningMechanic(t,w)===String(req.user.username||"").toLowerCase());`;
const newTimer=`const another=(Array.isArray(sf.workorders)?sf.workorders:[]).findIndex(ow=>(Array.isArray(ow?.tasks)?ow.tasks:[]).some(t=>!(String(ow?.id||'')===workOrderId&&String(t?.uid||'')===uid)&&taskRunning(t)&&taskRunningMechanic(t,ow)===String(req.user.username||'').toLowerCase()));`;
if(s.includes(oldTimer))s=s.replace(oldTimer,newTimer);
else if(!s.includes(newTimer))throw new Error('global mechanic timer guard target not found');

// 4) Paid/void invoices cannot be reopened by finalize.
if(!s.includes('ITTR v24.27.0 invoice finalize integrity')){
  const fStart=s.indexOf("app.post('/api/invoices/:id/finalize'");
  if(fStart<0)throw new Error('invoice finalize route not found');
  const fEnd=s.indexOf("app.post('/api/invoices/:id/payments'",fStart);
  if(fEnd<0)throw new Error('invoice finalize route boundary not found');
  const finalize=`// ITTR v24.27.0 invoice finalize integrity\napp.post('/api/invoices/:id/finalize',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const before=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[req.params.id])).rows[0];if(!before){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(['void','paid'].includes(String(before.status||'').toLowerCase())){await db.query('ROLLBACK');return res.status(409).json({error:'Paid or void invoices are locked and cannot be reopened.'})}const inv=await recalcInvoice(db,req.params.id);if(invoiceMoney(inv.total)<=0){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice total must be greater than zero.'})}await db.query("UPDATE customer_invoices SET status=CASE WHEN amount_paid>0 THEN 'partial' ELSE 'sent' END,finalized_at=coalesce(finalized_at,now()),sent_at=coalesce(sent_at,now()),updated_at=now() WHERE id=$1::bigint",[req.params.id]);await db.query('COMMIT');await audit(req.user.username,'invoice_finalized',{invoiceId:req.params.id});res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});\n`;
  s=s.slice(0,fStart)+finalize+s.slice(fEnd);
}

// 5) Reject accidental duplicate payment submissions within a short retry window.
if(!s.includes('ITTR v24.27.0 payment idempotency guard')){
  const pStart=s.indexOf("app.post('/api/invoices/:id/payments'");
  if(pStart<0)throw new Error('invoice payments route not found');
  const pEnd=s.indexOf("app.post('/api/invoices/:id/void'",pStart);
  if(pEnd<0)throw new Error('invoice payments route boundary not found');
  const payments=`// ITTR v24.27.0 payment idempotency guard\napp.post('/api/invoices/:id/payments',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const id=req.params.id,amount=invoiceMoney(req.body?.amount);if(amount<=0){await db.query('ROLLBACK');return res.status(400).json({error:'Payment amount must be greater than zero.'})}const inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];if(!inv||inv.status==='void'){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is missing or void.'})}if(String(inv.status||'').toLowerCase()==='paid'||invoiceMoney(inv.balance_due)<=0.009){await db.query('ROLLBACK');return res.status(409).json({error:'This invoice is already paid.'})}if(amount>invoiceMoney(inv.balance_due)+.01){await db.query('ROLLBACK');return res.status(409).json({error:'Payment cannot exceed the balance due.'})}const method=String(req.body?.method||'Other').trim().slice(0,80),reference=String(req.body?.reference||'').trim().slice(0,160),note=String(req.body?.note||'').replace(/[<>]/g,'').slice(0,2000);const dup=await db.query("SELECT id FROM customer_invoice_payments WHERE invoice_id=$1::bigint AND amount=$2::numeric AND lower(coalesce(method,''))=lower($3) AND coalesce(reference,'')=$4 AND received_by=$5 AND paid_at>now()-interval '15 seconds' LIMIT 1",[id,amount,method,reference,req.user.username]);if(dup.rowCount){await db.query('ROLLBACK');return res.status(409).json({error:'This payment was already recorded. Refresh the invoice before trying again.',code:'DUPLICATE_PAYMENT'})}await db.query('INSERT INTO customer_invoice_payments(invoice_id,amount,method,reference,note,paid_at,received_by) VALUES($1::bigint,$2::numeric,$3,$4,$5,coalesce($6::timestamptz,now()),$7)',[id,amount,method,reference,note,req.body?.paidAt||null,req.user.username]);await db.query('UPDATE customer_invoices SET amount_paid=amount_paid+$2::numeric,updated_at=now() WHERE id=$1::bigint',[id,amount]);await recalcInvoice(db,id);await db.query('COMMIT');await audit(req.user.username,'invoice_payment',{invoiceId:id,amount,method});res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});\n`;
  s=s.slice(0,pStart)+payments+s.slice(pEnd);
}

fs.writeFileSync(serverPath,s,'utf8');

// 6) Protect offline sync from replaying a stale whole-state snapshot against a newer server version.
for(const fp of ['index.html','public/index.html']){
  if(!fs.existsSync(fp))continue;
  let h=fs.readFileSync(fp,'utf8');
  h=h.replace('function persistQueuedState(key,payload){const q=readPersistentSyncQueue();q[key]={payload,queuedAt:new Date().toISOString()};writePersistentSyncQueue(q);',
`function persistQueuedState(key,payload){const q=readPersistentSyncQueue();q[key]={payload,queuedAt:new Date().toISOString(),baseVersion:Number(cloudVersions[key]||0)};writePersistentSyncQueue(q);`);
  h=h.replace('async function pushQueuedState(key,payload){const d=await apiJSON(`/api/state/${key}`,{method:"PUT",body:JSON.stringify({payload,expectedVersion:Number(cloudVersions[key]||0)})});if(d?.version!=null)cloudVersions[key]=Number(d.version);removePersistedState(key)}',
`async function pushQueuedState(key,payload,baseVersion=null){const expected=baseVersion==null?Number(cloudVersions[key]||0):Number(baseVersion||0);if(expected<=0)throw new Error("This offline change has no safe server version. Refresh before syncing so newer shop data is protected.");const d=await apiJSON(\`/api/state/\${key}\`,{method:"PUT",body:JSON.stringify({payload,expectedVersion:expected})});if(d?.version!=null)cloudVersions[key]=Number(d.version);removePersistedState(key)}`);
  h=h.replace('try{await pushQueuedState(key,item?.payload)}catch(e){showSyncError(e.message);break}',
`try{await pushQueuedState(key,item?.payload,Number(item?.baseVersion||0))}catch(e){showSyncError(e.message);break}`);
  h=h.replace('if(remoteEmpty && localHasData && ["admin","manager"].includes(session?.role)){','if(remoteEmpty && localHasData && session?.role==="admin"){');
  fs.writeFileSync(fp,h,'utf8');
}

console.log('ITTR v24.27.0 security/data-integrity hardening applied');
