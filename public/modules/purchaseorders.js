// ITTR ShopFlow v24.55.0 Purchase orders route module: order parts from a vendor, email the order, receive what
// arrived (stock goes on the shelf at the PO cost), close short, and hand the vendor's bill to Bills already filled in.
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=(u,o)=>window.apiJSON(u,o);
const toast=(m,t='info')=>window.showToast?.(m,t);
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const usd=v=>`$${(Math.round(num(v)*100)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const day=v=>{if(!v)return '—';const d=new Date(String(v).slice(0,10)+'T12:00:00');return Number.isFinite(d.getTime())?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'};
const LABEL={draft:'Draft',ordered:'Ordered',partial:'Partly received',received:'Received',cancelled:'Cancelled'};
let S={scope:null,status:'',q:'',items:[],modal:null,form:null,cur:null,qt:0,ft:0};
const $=sel=>S.modal?.querySelector(sel);

async function load(){const body=S.scope?.host.querySelector('#poRows');if(!body)return;
 try{S.items=(await api(`/api/purchase-orders?status=${S.status}&q=${encodeURIComponent(S.q)}`)).items||[]}catch(e){body.innerHTML=`<tr><td colspan="7" class="poEmpty">${h(e.message)}</td></tr>`;return}
 body.innerHTML=S.items.length?S.items.map(o=>{const pct=num(o.qty_ordered)?Math.min(100,Math.round(num(o.qty_received)/num(o.qty_ordered)*100)):0;
  return `<tr data-open="${Number(o.id)}"><td><b>${h(o.po_number)}</b>${o.work_order_id?`<div class="muted">WO #${h(o.work_order_id)}</div>`:''}</td><td>${h(o.vendor)}</td><td>${day(o.created_at)}</td><td>${day(o.expected_date)}</td>
   <td><div class="poBar" title="${num(o.qty_received)} of ${num(o.qty_ordered)}"><i style="width:${pct}%"></i></div><span class="muted">${num(o.qty_received)}/${num(o.qty_ordered)}</span></td><td class="n">${usd(o.total)}</td><td><span class="poPill ${h(o.status)}">${h(LABEL[o.status]||o.status)}</span></td></tr>`}).join('')
  :`<tr><td colspan="7" class="poEmpty">${S.q||S.status?'Nothing matches.':'No purchase orders yet. Start one with “+ New purchase order”, or let “Low-stock reorder” fill it from parts that are running low.'}</td></tr>`}

function openModal(html){closeModal();const m=document.createElement('div');m.className='poModal';m.innerHTML=`<div class="box" role="dialog" aria-modal="true">${html}</div>`;
 m.addEventListener('click',onModalClick);m.addEventListener('input',onModalInput);document.body.appendChild(m);S.modal=m}
function closeModal(){S.modal?.remove();S.modal=null}

// ---- editor -------------------------------------------------------------------------------------------------
function lineRow(l,i){return `<tr data-i="${i}"><td>${h(l.partNumber||'—')}${l.inventoryPartId?'':' <span class="muted" title="Not linked to a stock part: it will not be added to stock when received">(non-stock)</span>'}</td><td><input data-l="description" value="${h(l.description)}"></td>
 <td class="q"><input data-l="qty" type="number" min="0" step="1" value="${num(l.qty)}"></td><td class="c"><input data-l="unitCost" type="number" min="0" step="0.01" value="${num(l.unitCost)}"></td><td class="n">${usd(num(l.qty)*num(l.unitCost))}</td><td><button type="button" class="secondary" data-po="rmline" aria-label="Remove">×</button></td></tr>`}
function editor(){const f=S.form,total=f.lines.reduce((a,l)=>a+num(l.qty)*num(l.unitCost),0);
 openModal(`<div class="poBoxHead"><div><h2>${f.id?`Edit ${h(f.poNumber)}`:'New purchase order'}</h2><div class="muted">Add the parts you are ordering. Parts linked to stock go on the shelf when you receive them.</div></div><button class="x" data-po="close" aria-label="Close">×</button></div>
  <div class="poGrid"><label class="span2">Vendor<input id="poVendor" list="poVendorList" value="${h(f.vendor)}" placeholder="FleetPride, TruckPro…"></label><label>Vendor email<input id="poEmail" type="email" value="${h(f.vendorEmail)}"></label><label>Needed by<input id="poDate" type="date" value="${h(f.expectedDate||'')}"></label>
   <label>For work order #<input id="poWo" value="${h(f.workOrderId||'')}"></label><label class="span2">Notes<input id="poNotes" value="${h(f.notes||'')}"></label></div>
  <datalist id="poVendorList">${(S.vendors||[]).map(v=>`<option value="${h(v)}">`).join('')}</datalist>
  <div class="poFind"><input id="poFind" placeholder="+ Add part: type part # or description" autocomplete="off"><div id="poFindList" class="poFindList hidden"></div></div>
  <div style="overflow-x:auto"><table class="poLines"><thead><tr><th>Part #</th><th>Description</th><th>Qty</th><th>Unit cost</th><th class="n">Line</th><th></th></tr></thead><tbody id="poLineRows">${f.lines.map(lineRow).join('')||'<tr><td colspan="6" class="muted">No parts yet.</td></tr>'}</tbody></table></div>
  <div class="poFoot"><div><button type="button" class="secondary" data-po="addlow">+ Low-stock parts${f.vendor?` from ${h(f.vendor)}`:''}</button> <button type="button" class="secondary" data-po="addfree">+ Non-stock line</button></div><b id="poTotal">Total ${usd(total)}</b></div>
  <div class="poFoot"><span></span><div class="acts"><button type="button" class="secondary" data-po="close">Cancel</button><button type="button" data-po="save">${f.id?'Save changes':'Save purchase order'}</button></div></div>`)}
function readHeader(){const f=S.form;f.vendor=$('#poVendor')?.value.trim()||'';f.vendorEmail=$('#poEmail')?.value.trim()||'';f.expectedDate=$('#poDate')?.value||'';f.workOrderId=$('#poWo')?.value.trim()||'';f.notes=$('#poNotes')?.value.trim()||''}
function redrawLines(){readHeader();const tb=$('#poLineRows');if(tb)tb.innerHTML=S.form.lines.map(lineRow).join('')||'<tr><td colspan="6" class="muted">No parts yet.</td></tr>';const t=$('#poTotal');if(t)t.textContent=`Total ${usd(S.form.lines.reduce((a,l)=>a+num(l.qty)*num(l.unitCost),0))}`}
function addLine(l){const ex=l.inventoryPartId&&S.form.lines.find(x=>x.inventoryPartId===l.inventoryPartId);if(ex)ex.qty=num(ex.qty)+num(l.qty||1);else S.form.lines.push({qty:1,unitCost:0,...l});redrawLines()}
async function newForm(seed={}){try{S.vendors=((await api('/api/parts/vendors')).items||[]).map(v=>v.canonical_name).filter(Boolean)}catch(_){S.vendors=[]}
 S.form={id:null,vendor:'',vendorEmail:'',expectedDate:'',workOrderId:'',notes:'',lines:[],...seed};editor()}

// ---- detail -------------------------------------------------------------------------------------------------
async function openPo(id){let d;try{d=await api(`/api/purchase-orders/${id}`)}catch(e){return toast(e.message,'error')}S.cur=d;const o=d.po,L=d.lines;
 const anyRec=L.some(l=>num(l.qty_received)>0),canRecv=['draft','ordered','partial'].includes(o.status)&&L.some(l=>num(l.qty_received)<num(l.qty_ordered));
 const acts=[];
 if(['draft','ordered'].includes(o.status)&&!anyRec)acts.push('<button type="button" class="secondary" data-po="edit">Edit</button>');
 if(o.status==='draft')acts.push('<button type="button" class="secondary" data-po="mark-ordered">Mark ordered</button>');
 if(['draft','ordered','partial'].includes(o.status))acts.push('<button type="button" class="secondary" data-po="email">Email to vendor</button>');
 if(o.status==='partial')acts.push('<button type="button" class="secondary" data-po="close-short" title="The rest of this order is not coming">Close (rest not coming)</button>');
 if(['draft','ordered'].includes(o.status)&&!anyRec)acts.push('<button type="button" class="secondary danger" data-po="cancel">Cancel order</button>');
 if(anyRec)acts.push('<button type="button" data-po="bill">Create vendor bill →</button>');
 openModal(`<div class="poBoxHead"><div><h2>${h(o.po_number)} <span class="poPill ${h(o.status)}">${h(LABEL[o.status])}</span></h2><div class="poInfo"><span><b>${h(o.vendor)}</b></span>${o.vendor_email?`<span>${h(o.vendor_email)}</span>`:''}<span>Created ${day(o.created_at)} by ${h(o.created_by)}</span>${o.ordered_at?`<span>Ordered ${day(o.ordered_at)}</span>`:''}${o.expected_date?`<span>Needed by ${day(o.expected_date)}</span>`:''}${o.work_order_id?`<span>WO #${h(o.work_order_id)}</span>`:''}</div>${o.notes?`<div class="muted">${h(o.notes)}</div>`:''}</div><button class="x" data-po="close" aria-label="Close">×</button></div>
  <div style="overflow-x:auto"><table class="poLines"><thead><tr><th>Part #</th><th>Description</th><th class="n">Ordered</th><th class="n">Received</th><th class="n">On hand</th><th class="n">Unit cost</th>${canRecv?'<th class="q">Arrived now</th>':''}</tr></thead><tbody>
  ${L.map(l=>{const left=num(l.qty_ordered)-num(l.qty_received);return `<tr><td>${h(l.part_number||'—')}</td><td>${h(l.description)}${l.inventory_part_id?'':' <span class="muted">(non-stock)</span>'}</td><td class="n">${num(l.qty_ordered)}</td><td class="n">${num(l.qty_received)}</td><td class="n">${l.inventory_part_id?num(l.on_hand):'—'}</td><td class="n">${usd(l.unit_cost)}</td>${canRecv?`<td class="q">${left>0?`<input type="number" min="0" max="${left}" step="1" data-recv="${Number(l.id)}" value="${left}" aria-label="How many arrived">`:'✓'}</td>`:''}</tr>`}).join('')}</tbody></table></div>
  ${canRecv?`<div class="poFoot"><label class="muted">Vendor invoice / packing slip # <input id="poRef" style="max-width:200px"></label><button type="button" data-po="receive">Receive into stock</button></div>`:''}
  <div class="poFoot"><b>Total ${usd(o.total)}</b><div class="acts">${acts.join('')}</div></div>`)}

async function receive(){const lines=[...S.modal.querySelectorAll('[data-recv]')].map(i=>({id:Number(i.dataset.recv),qty:num(i.value)})).filter(x=>x.qty>0);
 if(!lines.length)return toast('Enter how many arrived.','error');
 try{const d=await api(`/api/purchase-orders/${S.cur.po.id}/receive`,{method:'POST',body:JSON.stringify({lines,reference:$('#poRef')?.value.trim()||''})});
  toast(d.status==='received'?'All parts received and put in stock.':'Received. The rest is still on order.','success');await load();openPo(S.cur.po.id)}catch(e){toast(e.message,'error')}}
function billFromPo(){const o=S.cur.po,lines=S.cur.lines.filter(l=>num(l.qty_received)>0);
 window.__ittrBillDraft={invoice:{vendor:o.vendor,poNumber:o.po_number,invoiceDate:'',invoiceNumber:''},lines:lines.map(l=>({description:l.description,partNumber:l.part_number||'',quantity:num(l.qty_received),unitCost:num(l.unit_cost),lineTotal:Math.round(num(l.qty_received)*num(l.unit_cost)*100)/100}))};
 closeModal();toast(`Type the vendor's invoice # on the bill. The parts from ${o.po_number} are already in stock — don't receive them again.`,'info');window.showView?.('bills');setTimeout(()=>window.dispatchEvent(new Event('ittr:bill-draft')),300)}

async function onModalClick(e){const b=e.target.closest('[data-po]');const pick=e.target.closest('[data-pick]');
 if(pick){const p=JSON.parse(pick.dataset.pick);addLine({inventoryPartId:p.id,partNumber:p.part_number||'',description:p.description||p.part_number||'',qty:1,unitCost:num(p.last_purchase_cost??p.cost)});$('#poFind').value='';$('#poFindList').classList.add('hidden');return}
 if(!b)return;const a=b.dataset.po;
 if(a==='close')return closeModal();
 if(a==='rmline'){readHeader();S.form.lines.splice(Number(b.closest('tr').dataset.i),1);return redrawLines()}
 if(a==='addfree'){const d=prompt('Describe the item (it will not be added to stock):');if(d)addLine({description:d,partNumber:'',qty:1,unitCost:0});return}
 if(a==='addlow'){readHeader();try{const d=await api(`/api/purchase-orders/suggestions?vendor=${encodeURIComponent(S.form.vendor)}`);if(!d.items.length)return toast(S.form.vendor?`Nothing from ${S.form.vendor} is below its reorder point.`:'No parts are below their reorder point.','info');
  d.items.forEach(p=>addLine({inventoryPartId:p.inventoryPartId,partNumber:p.partNumber,description:p.description,qty:p.suggestQty,unitCost:p.unitCost}));toast(`${d.items.length} low-stock part(s) added.`,'success')}catch(err){toast(err.message,'error')}return}
 if(a==='save'){readHeader();const f=S.form;if(!f.vendor)return toast('Choose the vendor.','error');if(!f.lines.length)return toast('Add at least one part.','error');
  const body={vendor:f.vendor,vendorEmail:f.vendorEmail,expectedDate:f.expectedDate,workOrderId:f.workOrderId,notes:f.notes,lines:f.lines};
  try{const d=f.id?await api(`/api/purchase-orders/${f.id}`,{method:'PUT',body:JSON.stringify(body)}):await api('/api/purchase-orders',{method:'POST',body:JSON.stringify(body)});toast(f.id?'Saved.':`${d.poNumber} saved.`,'success');await load();openPo(f.id||d.id)}catch(err){toast(err.message,'error')}return}
 const id=S.cur?.po?.id;
 if(a==='edit'){const o=S.cur.po;return newForm({id:o.id,poNumber:o.po_number,vendor:o.vendor,vendorEmail:o.vendor_email||'',expectedDate:o.expected_date?String(o.expected_date).slice(0,10):'',workOrderId:o.work_order_id||'',notes:o.notes||'',lines:S.cur.lines.map(l=>({inventoryPartId:l.inventory_part_id?Number(l.inventory_part_id):null,partNumber:l.part_number||'',description:l.description,qty:num(l.qty_ordered),unitCost:num(l.unit_cost)}))})}
 const status=async(to,msg)=>{try{await api(`/api/purchase-orders/${id}/status`,{method:'POST',body:JSON.stringify({status:to})});toast(msg,'success');await load();openPo(id)}catch(err){toast(err.message,'error')}};
 if(a==='mark-ordered')return status('ordered','Marked as ordered.');
 if(a==='cancel'){if(confirm('Cancel this purchase order?'))return status('cancelled','Purchase order cancelled.');return}
 if(a==='close-short'){if(confirm('Close this order? The parts not received yet will not be expected anymore.'))return status('received','Order closed.');return}
 if(a==='email'){const to=prompt('Vendor email:',S.cur.po.vendor_email||'');if(!to)return;try{await api(`/api/purchase-orders/${id}/email`,{method:'POST',body:JSON.stringify({to})});toast('Purchase order emailed to the vendor.','success');await load();openPo(id)}catch(err){toast(err.message,'error')}return}
 if(a==='receive')return receive();
 if(a==='bill')return billFromPo()}
function onModalInput(e){const t=e.target;
 if(t.dataset.l){const i=Number(t.closest('tr').dataset.i),l=S.form.lines[i];if(!l)return;l[t.dataset.l]=t.dataset.l==='description'?t.value:num(t.value);const cell=t.closest('tr').querySelector('td.n');if(cell)cell.textContent=usd(num(l.qty)*num(l.unitCost));$('#poTotal').textContent=`Total ${usd(S.form.lines.reduce((a,x)=>a+num(x.qty)*num(x.unitCost),0))}`;return}
 if(t.id==='poFind'){clearTimeout(S.ft);const q=t.value.trim(),list=$('#poFindList');if(q.length<2){list.classList.add('hidden');return}
  S.ft=setTimeout(async()=>{try{const d=await api(`/api/parts?q=${encodeURIComponent(q)}&limit=20`);const items=(d.items||d.parts||[]).slice(0,20);
   list.innerHTML=items.length?items.map(p=>`<button type="button" data-pick="${h(JSON.stringify({id:p.id,part_number:p.part_number,description:p.description,cost:p.cost,last_purchase_cost:p.last_purchase_cost}))}"><b>${h(p.part_number||'')}</b> ${h(p.description||'')} <span class="muted">· ${num(p.quantity)} on hand</span></button>`).join(''):'<div class="muted" style="padding:8px">No stock part found. Use “+ Non-stock line”.</div>';list.classList.remove('hidden')}catch(_){}},250)}}

function onClick(e){const row=e.target.closest('tr[data-open]');if(row)return openPo(row.dataset.open);
 const chip=e.target.closest('#poStatus button');if(chip){S.status=chip.dataset.s;S.scope.host.querySelectorAll('#poStatus button').forEach(x=>x.classList.toggle('on',x===chip));return load()}
 const b=e.target.closest('[data-po]');if(!b)return;
 if(b.dataset.po==='new')return newForm();
 if(b.dataset.po==='reorder')return(async()=>{try{const d=await api('/api/purchase-orders/suggestions');if(!d.items.length)return toast('No parts are below their reorder point.','info');
  const byVendor={};d.items.forEach(p=>(byVendor[p.vendor||'']||(byVendor[p.vendor||'']=[])).push(p));const vendors=Object.keys(byVendor).sort((a,b)=>byVendor[b].length-byVendor[a].length);
  const v=vendors.length>1?prompt(`Low-stock parts by vendor:\n${vendors.map(x=>`• ${x||'(no vendor)'}: ${byVendor[x].length}`).join('\n')}\n\nType the vendor to order from:`,vendors[0]):vendors[0];if(v==null)return;
  const pick=byVendor[v]||byVendor[Object.keys(byVendor).find(k=>k.toLowerCase()===String(v).trim().toLowerCase())]||[];
  await newForm({vendor:v,lines:pick.map(p=>({inventoryPartId:p.inventoryPartId,partNumber:p.partNumber,description:p.description,qty:p.suggestQty,unitCost:p.unitCost}))})}catch(err){toast(err.message,'error')}})()}

export async function mount(scope){S={...S,scope};
 scope.on(scope.host,'ittr:module-refresh',()=>load(),{passive:true});
 scope.on(scope.host,'click',onClick);
 scope.on(scope.host,'input',e=>{if(e.target.dataset.f!=='q')return;clearTimeout(S.qt);S.qt=setTimeout(()=>{S.q=e.target.value.trim();load()},250)});
 scope.on(document,'keydown',e=>{if(e.key==='Escape'&&S.modal)closeModal()});
 await load()}
export async function afterShow(){load()}
export function unmount(){closeModal();clearTimeout(S.qt);S.scope=null}
