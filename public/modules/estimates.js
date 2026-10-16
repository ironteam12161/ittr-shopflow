// ITTR ShopFlow v24.37.0 Estimates route module.
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)||0);
const day=v=>{if(!v)return '—';const d=new Date(String(v).length===10?`${v}T12:00:00`:v);return Number.isFinite(d.getTime())?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'};
const iso=v=>v?String(v).slice(0,10):'';
const api=(url,opt)=>window.apiJSON(url,opt);
const toast=(m,t='info')=>window.showToast?.(m,t);
const STATUS=[['draft','Draft'],['sent','Sent'],['approved','Approved'],['declined','Declined'],['converted','Invoiced']];
const LABEL=Object.fromEntries([...STATUS,['expired','Expired']]);

let S={filter:'',q:'',items:[],stats:[],cur:null,scope:null,searchTimer:0,lookupTimer:0,partTimer:0,partResults:[],lookupResults:[]};
const $=sel=>S.scope?.host.querySelector(sel);

async function loadList(){
 try{const d=await api(`/api/estimates?status=${encodeURIComponent(S.filter)}&q=${encodeURIComponent(S.q)}`);S.items=d.items||[];S.stats=d.stats||[];renderList()}
 catch(e){const b=$('#estRows');if(b)b.innerHTML=`<tr><td colspan="7" class="empty">${h(e.message)}</td></tr>`}
}
function renderList(){
 const stats=$('#estStats');if(stats)stats.innerHTML=STATUS.map(([k,l])=>{const s=S.stats.find(x=>x.status===k);return `<button class="estStat ${S.filter===k?'active':''}" data-est="filter" data-status="${k}"><span>${l}</span><b>${s?.n||0}</b><small>${usd(s?.total||0)}</small></button>`}).join('');
 const body=$('#estRows');if(!body)return;
 if(!S.items.length){body.innerHTML=`<tr><td colspan="7" class="empty">${S.filter||S.q?'No estimates match.':'No estimates yet. Click “+ New Estimate” to quote a job.'}</td></tr>`;return}
 body.innerHTML=S.items.map(e=>`<tr data-open="${e.id}"><td><b>${h(e.estimate_number)}</b></td><td>${h(e.customer_name)}</td><td>${h(e.unit_number||'—')}</td><td>${day(e.estimate_date)}</td><td>${day(e.valid_until)}</td><td class="estNum">${usd(e.total)}</td><td><span class="estPill ${h(e.status)}">${h(LABEL[e.status]||e.status)}</span></td></tr>`).join('');
}

// ---------------------------------------------------------------- editor
function openEditor(html){const ed=$('#estEditor'),box=$('#estEditorBox');if(!ed||!box)return;box.innerHTML=html;ed.classList.remove('hidden');document.body.classList.add('modalOpen')}
function closeEditor(){$('#estEditor')?.classList.add('hidden');document.body.classList.remove('modalOpen');S.cur=null;loadList()}
function startNew(){
 S.cur=null;
 openEditor(`<div class="estHead"><div><h2>New estimate</h2><div class="muted">Find the truck or customer, or type a customer name.</div></div><div class="estHeadActions"><button class="secondary" data-est="close">Close</button></div></div>
 <div style="padding:18px 22px">
  <div class="field estLookup"><label for="estNewLookup">Unit #, customer, VIN, plate or DOT</label><input id="estNewLookup" data-est-input="lookup" autocomplete="off" placeholder="Start typing…"><div id="estLookupDrop" class="estLookupDrop hidden"></div></div>
  <div class="estFields"><div class="field wide"><label>Customer</label><input id="estNewCustomer" placeholder="Customer / company"></div><div class="field"><label>Unit #</label><input id="estNewUnit"></div><div class="field"><label>VIN</label><input id="estNewVin"></div>
  <div class="field"><label>Email</label><input id="estNewEmail" type="email"></div><div class="field"><label>Mileage</label><input id="estNewMiles" inputmode="numeric"></div><div class="field"><label>Valid for (days)</label><input id="estNewDays" type="number" min="1" max="180" value="30"></div><div class="field"><label>Tax rate %</label><input id="estNewTax" type="number" step="0.001" min="0" value="0"></div></div>
  <input type="hidden" id="estNewCustomerId"><input type="hidden" id="estNewUnitId">
  <div style="display:flex;justify-content:flex-end;gap:8px"><button class="secondary" data-est="close">Cancel</button><button data-est="create">Create estimate →</button></div>
 </div>`);
 setTimeout(()=>$('#estNewLookup')?.focus(),30);
}
async function lookup(q){
 const drop=$('#estLookupDrop');if(!drop)return;if(q.trim().length<2){drop.classList.add('hidden');return}
 try{const d=await api(`/api/customer-units/suggest?q=${encodeURIComponent(q.trim())}`);S.lookupResults=d.items||[];
  drop.innerHTML=S.lookupResults.length?S.lookupResults.map((u,i)=>`<button type="button" data-est="pick" data-i="${i}">Unit ${h(u.unit_number)} · ${h(u.customer_name||'')}<small>${h([u.year,u.make,u.model].filter(Boolean).join(' '))}${u.vin?` · VIN ${h(u.vin)}`:''}</small></button>`).join(''):`<button type="button" disabled>No match — type the customer below.</button>`;drop.classList.remove('hidden')}
 catch(e){toast(e.message,'error')}
}
function pickLookup(i){
 const u=S.lookupResults[i];if(!u)return;
 const set=(id,v)=>{const el=$(id);if(el)el.value=v??''};
 set('#estNewCustomer',u.customer_name);set('#estNewUnit',u.unit_number);set('#estNewVin',u.vin);set('#estNewEmail',u.customer_email);set('#estNewMiles',u.mileage||'');set('#estNewCustomerId',u.customer_id||'');set('#estNewUnitId',u.id||'');
 $('#estLookupDrop')?.classList.add('hidden');
}
async function createEstimate(btn){
 const v=id=>String($(id)?.value||'').trim();
 if(!v('#estNewCustomer'))return toast('Customer name is required.','error');
 btn.disabled=true;
 try{const d=await api('/api/estimates',{method:'POST',body:{customerName:v('#estNewCustomer'),customerId:v('#estNewCustomerId')||null,unitId:v('#estNewUnitId')||null,unitNumber:v('#estNewUnit'),vin:v('#estNewVin'),customerEmail:v('#estNewEmail'),mileage:v('#estNewMiles'),validDays:v('#estNewDays'),taxRate:v('#estNewTax')}});await openEstimate(d.id)}
 catch(e){btn.disabled=false;toast(e.message,'error')}
}
async function openEstimate(id){
 try{S.cur=await api(`/api/estimates/${id}`);renderEditor()}catch(e){toast(e.message,'error')}
}
async function reload(){if(S.cur)await openEstimate(S.cur.estimate.id)}

// v24.68.0: part lines show the buy price (with the markup under it) next to the sell price, like the invoice (staff only; the
// customer PDF and approval page show only the sell price).
const mk=(cost,price)=>{cost=Number(cost||0);price=Number(price||0);return cost>0?(((price-cost)/cost)*100).toFixed(1):''};
const mkText=(cost,price)=>{const m=mk(cost,price);return m===''?'no buy price':`${Number(m)>=0?'+':''}${Math.round(Number(m))}% markup`};
function lineRow(l,locked,isLabor){
 const isPart=l.line_type==='part';
 const dis=locked||l.metadata?.feeCode?'disabled':'',fu=['gal','qt'].includes(l.metadata?.unit)?l.metadata.unit:l.part_in_gallons?'gal':'';
 // v24.59.0: a part with no sell price is flagged so it is not quoted at $0 by mistake.
 const noPrice=l.line_type==='part'&&!locked&&Number(l.unit_price)<=0;
 return `<div class="estRow" data-line="${l.id}">
  <span class="t">${isLabor?'Labor':h(l.line_type)}</span>
  <input class="desc" data-f="description" value="${h(l.description)}" ${dis} aria-label="Description" placeholder="${isLabor?'Labor description':'Description'}">
  ${isLabor?'<span></span>':`<input data-f="partNumber" value="${h(l.part_number||'')}" ${dis} aria-label="Part number" placeholder="Part #">`}
  ${fu?`<span class="estQtyU"><input data-f="quantity" type="number" step="0.25" min="0" value="${Number(l.quantity)}" ${dis} aria-label="Quantity"><select data-f="unit" ${dis} aria-label="Gallons or quarts" title="Gallons or quarts (price converts: per quart = per gallon ÷ 4)"><option value="gal" ${fu==='gal'?'selected':''}>gal</option><option value="qt" ${fu==='qt'?'selected':''}>qt</option></select></span>`:`<input data-f="quantity" type="number" step="${isLabor?'0.1':'0.01'}" min="0" value="${Number(l.quantity)}" ${dis} aria-label="${isLabor?'Hours':'Quantity'}">`}
  ${isPart?`<span class="estBuy"><input data-f="unitCost" type="number" step="0.01" min="0" value="${Number(l.unit_cost||0)}" ${dis} aria-label="${fu?`Buy price per ${fu}`:'Buy price each'}" title="Buy price (our cost)${fu?` per ${fu==='qt'?'quart':'gallon'}`:''} — not shown to the customer"><small data-mk-out>${mkText(l.unit_cost,l.unit_price)}</small></span>`:'<span></span>'}
  <input data-f="unitPrice" type="number" step="0.01" min="0" value="${Number(l.unit_price)}" ${dis} class="${noPrice?'estNoPrice':''}" aria-label="${isLabor?'Rate per hour':fu?`Price per ${fu}`:'Price each'}" title="${noPrice?'This part has no sell price — type one here, and set it on the part in Parts.':fu?`Price per ${fu==='qt'?'quart':'gallon'}`:''}">
  <label class="tx" title="Taxable"><input data-f="taxable" type="checkbox" ${l.taxable?'checked':''} ${dis}><span>Tax</span></label>
  <span class="amt">${usd(l.line_total)}${l.part_fluid_not_gallons&&!locked?`<button type="button" class="estGalHint" onclick="window.openFluidsTool?.()" title="This fluid is not counted in gallons yet. Switch it in Parts → Fluids in gallons, then pick gal or qt here.">🛢 count in gallons</button>`:''}</span>
  ${locked||l.metadata?.feeCode?'<span></span>':`<button class="del" data-est="del-line" data-id="${l.id}" title="Remove line" aria-label="Remove line">✕</button>`}
 </div>`;
}
// v24.70.0: same column words as the invoice editor (Qty / Hrs · Buy · Sell / Rate · Line Total).
const ROW_HEAD='<div class="estRow estRowHead"><span>Type</span><span>Description</span><span>Part #</span><span>Qty / Hrs</span><span>Buy</span><span>Sell / Rate</span><span>Tax</span><span class="amt">Line Total</span><span></span></div>';
function renderEditor(){
 const {estimate:e,lines,invoice}=S.cur,locked=!['draft','sent'].includes(e.status),hdrLocked=['declined','converted'].includes(e.status),dis=hdrLocked?'disabled':'';
 const labors=lines.filter(l=>l.line_type==='labor'),used=new Set();
 const jobs=labors.map((lab,n)=>{const kids=lines.filter(l=>l.line_type!=='labor'&&String(l.parent_line_id||'')===String(lab.id));kids.forEach(k=>used.add(k.id));used.add(lab.id);
  const sum=[lab,...kids].reduce((a,l)=>a+Number(l.line_total||0),0);
  return `<div class="estJob"><div class="estJobHead"><span class="estNo">${n+1}</span><b style="flex:1">${h(lab.description||lab.job_name||'Job')}${lab.customer_decision?` <span class="estPill ${lab.customer_decision==='approved'?'approved':'declined'}" title="Customer answer from the online link">${lab.customer_decision==='approved'?'Customer approved':'Customer declined'}</span>`:''}</b><span class="estNum">${usd(sum)}</span></div>
   ${lineRow(lab,locked,true)}${kids.map(k=>lineRow(k,locked,false)).join('')}
   ${locked?'':`<div class="estJobFoot"><span class="estPartDrop"><input data-est-input="part" data-parent="${lab.id}" placeholder="+ Add part: search inventory or type…" style="min-width:260px;padding:7px 10px;border:1px solid #d0d5dd;border-radius:8px"><span class="estLookupDrop hidden" data-part-drop="${lab.id}"></span></span><button class="secondary" data-est="add-other" data-parent="${lab.id}">+ Other charge</button></div>`}</div>`}).join('');
 const others=lines.filter(l=>!used.has(l.id));
 const pill=`<span class="estPill ${h(e.status)}">${h(LABEL[e.status]||e.status)}</span>`;
 const actions=[];
 actions.push(`<button class="secondary" data-est="pdf">PDF</button>`);
 if(e.status!=='converted')actions.push(`<button class="secondary" data-est="email">Email</button>`);
 if(['draft','sent'].includes(e.status)&&lines.length)actions.push(`<button class="secondary" data-est="share" title="Private link: the customer approves or declines each job and signs">📤 Send for approval</button>`);
 if(e.status==='draft')actions.push(`<button class="secondary" data-est="status" data-to="sent">Mark sent</button>`);
 if(['draft','sent'].includes(e.status))actions.push(`<button class="success" data-est="status" data-to="approved">Approved</button><button class="danger" data-est="status" data-to="declined">Declined</button>`);
 if(e.work_order_id)actions.push(`<button class="secondary" data-est="open-wo" data-id="${h(e.work_order_id)}">🔧 Work order #${h(e.work_order_id)}</button>`);
 else if(['approved','sent','draft'].includes(e.status)&&lines.some(l=>l.line_type==='labor'&&l.customer_decision!=='declined'))actions.push(`<button data-est="to-wo" title="Put the approved jobs on a work order so mechanics can start">🔧 Create work order</button>`);
 if(['approved','sent','draft'].includes(e.status))actions.push(`<button data-est="convert">Convert to invoice →</button>`);
 if(['approved','declined'].includes(e.status))actions.push(`<button class="secondary" data-est="status" data-to="draft">Back to draft</button>`);
 if(e.status==='converted'&&invoice)actions.push(`<button data-est="open-invoice" data-id="${invoice.id}">Open invoice ${h(invoice.invoice_number)}</button>`);
 if(e.status!=='converted')actions.push(`<button class="secondary danger" data-est="delete">Delete</button>`);
 actions.push(`<button class="secondary" data-est="close">Close</button>`);
 const f=(label,key,val,type='text',extra='')=>`<div class="field ${extra}"><label>${label}</label><input data-h="${key}" type="${type}" value="${h(val??'')}" ${dis}></div>`;
 openEditor(`<div class="estHead"><div><h2>${h(e.estimate_number)} ${pill}</h2><div class="muted">${h(e.customer_name)}${e.unit_number?` · Unit ${h(e.unit_number)}`:''} · created by ${h(e.created_by)}${e.decided_by?` · ${h(LABEL[e.status]||e.status)} by ${h(e.decided_by)}`:''}</div></div><div class="estHeadActions">${actions.join('')}</div></div>
 <div class="estBody"><div>
  ${e.status==='approved'?'<div class="estLockNote">Approved — lines are locked. Convert to an invoice, or move it back to draft to change the work.</div>':''}
  ${e.status==='converted'?`<div class="estLockNote">This estimate became invoice ${h(invoice?.invoice_number||'')}. Make any further changes on the invoice.</div>`:''}
  <div class="estFields">${f('Customer','customerName',e.customer_name,'text','wide')}${f('Customer email','customerEmail',e.customer_email,'email')}${f('PO #','poNumber',e.po_number)}
   ${f('Unit #','unitNumber',e.unit_number)}${f('VIN','vin',e.vin)}${f('Mileage','mileage',e.mileage,'number')}${f('Valid until','validUntil',iso(e.valid_until),'date')}</div>
  ${lines.length?`<div class="estJob" style="margin-bottom:6px;border:0">${ROW_HEAD}</div>`:''}
  ${jobs||'<div class="empty" style="border:1px dashed #cbd5e1;border-radius:12px;margin-bottom:12px">No jobs yet. Add the first labor operation below.</div>'}
  ${others.length?`<div class="estJob"><div class="estJobHead"><b style="flex:1">Other items & fees</b><span class="estNum">${usd(others.reduce((a,l)=>a+Number(l.line_total||0),0))}</span></div>${others.map(l=>lineRow(l,locked,false)).join('')}</div>`:''}
  ${locked?'':`<div class="estAddJob"><input id="estNewJob" placeholder="New job, e.g. Replace front brakes" aria-label="New job description"><input id="estNewJobHours" type="number" step="0.1" min="0" value="1" style="max-width:90px" aria-label="Hours"><button data-est="add-job">+ Add job</button><button type="button" class="secondary" data-est="canned" title="Add a saved job package (labor + parts)">+ Canned job</button></div>`}
 </div>
 <aside class="estSide">
  <div class="estTotals"><div><span>Subtotal</span><b>${usd(Number(e.subtotal)+Number(e.discount||0))}</b></div>${Number(e.discount)?`<div><span>Discount</span><span>−${usd(e.discount)}</span></div>`:''}<div><span>Tax (${Number(e.tax_rate||0)}%)</span><span>${usd(e.tax)}</span></div><div class="grand"><span>Total</span><span>${usd(e.total)}</span></div>${partsProfit(lines)}</div>
  ${locked?'':`<button class="secondary" data-est="tire-fees">Tire fees (user + disposal)</button>`}
  <div class="field"><label>Tax rate %</label><input data-h="taxRate" type="number" step="0.001" min="0" value="${Number(e.tax_rate||0)}" ${dis}></div>
  <div class="field"><label>Shop supplies $</label><input data-h="shopSupplies" type="number" step="0.01" min="0" value="${Number(e.shop_supplies||0)}" ${dis}></div>
  <div class="field"><label>Discount</label><div style="display:flex;gap:6px"><select data-h="discountType" ${dis} style="max-width:90px"><option value="fixed" ${e.discount_type!=='percent'?'selected':''}>$</option><option value="percent" ${e.discount_type==='percent'?'selected':''}>%</option></select><input data-h="discountValue" type="number" step="0.01" min="0" value="${Number(e.discount_value||0)}" ${dis}></div></div>
  <div class="field"><label>Note to customer (prints on PDF)</label><textarea data-h="customerNote" ${dis}>${h(e.customer_note||'')}</textarea></div>
  <div class="field"><label>Internal note</label><textarea data-h="internalNote" ${dis}>${h(e.internal_note||'')}</textarea></div>
  ${e.decision_note?`<div class="muted">Decision note: ${h(e.decision_note)}</div>`:''}
 </aside></div>`);
}
// Internal only: what the parts cost us and what they earn (the customer never sees this).
function partsProfit(lines){
 const parts=(lines||[]).filter(l=>l.line_type==='part');if(!parts.length)return '';
 const cost=parts.reduce((a,l)=>a+Number(l.quantity||0)*Number(l.unit_cost||0),0),sell=parts.reduce((a,l)=>a+Number(l.line_total||0),0),profit=sell-cost,missing=parts.filter(l=>!(Number(l.unit_cost)>0)).length;
 return `<div class="estProfit" title="Internal — not on the estimate the customer sees"><div><span>Parts buy</span><span>${usd(cost)}</span></div><div><span>Parts profit</span><b>${usd(profit)}${sell>0?` (${Math.round(profit/sell*100)}%)`:''}</b></div>${missing?`<div class="muted">${missing} part${missing===1?' has':'s have'} no buy price</div>`:''}</div>`;
}
async function saveHeader(input){
 if(!S.cur)return;const key=input.dataset.h;let val=input.type==='checkbox'?input.checked:input.value;
 try{await api(`/api/estimates/${S.cur.estimate.id}`,{method:'PUT',body:{[key]:val}});await reload()}catch(e){toast(e.message,'error')}
}
async function saveLine(row){
 if(!S.cur)return;const id=row.dataset.line,l=S.cur.lines.find(x=>String(x.id)===String(id));if(!l)return;
 const v=f=>row.querySelector(`[data-f="${f}"]`);
 const body={lineType:l.line_type,description:v('description')?.value??l.description,partNumber:v('partNumber')?.value??l.part_number,quantity:v('quantity')?.value??l.quantity,unitPrice:v('unitPrice')?.value??l.unit_price,unit:v('unit')?.value||undefined,
  taxable:v('taxable')?v('taxable').checked:!!l.taxable,unitCost:v('unitCost')?.value??l.unit_cost,inventoryPartId:l.inventory_part_id,parentLineId:l.parent_line_id,discount:l.discount};
 try{await api(`/api/estimates/${S.cur.estimate.id}/lines/${id}`,{method:'PUT',body});await reload()}catch(e){toast(e.message,'error')}
}
async function addLine(body){try{await api(`/api/estimates/${S.cur.estimate.id}/lines`,{method:'POST',body});await reload()}catch(e){toast(e.message,'error')}}
const gal=u=>/^\s*(gal|gallon|gallons)\s*$/i.test(String(u||''));
async function partSearch(input){
 const parent=input.dataset.parent,drop=S.scope.host.querySelector(`[data-part-drop="${parent}"]`),q=input.value.trim();if(!drop)return;
 if(q.length<2){drop.classList.add('hidden');return}
 try{const d=await api(`/api/parts?q=${encodeURIComponent(q)}&limit=8`);S.partResults=d.items||[];
  drop.innerHTML=S.partResults.map((p,i)=>`<button type="button" data-est="pick-part" data-i="${i}" data-parent="${parent}">${h(p.part_number||'')} · ${h(p.description||'')}<small>${Number(p.price)>0?`${usd(p.price)}${gal(p.uom)?'/gal':''}`:'<b class="estNoPriceTag">no price set</b>'} · ${Number(p.available??p.quantity??0)} ${gal(p.uom)?'gal ':''}available${p.location?` · ${h(p.location)}`:''}</small></button>`).join('')+`<button type="button" data-est="custom-part" data-parent="${parent}">Add “${h(q)}” as a custom part</button>`;
  drop.classList.remove('hidden')}catch(e){toast(e.message,'error')}
}
function defaultRate(){const lab=S.cur?.lines?.find(l=>l.line_type==='labor'&&Number(l.unit_price)>0);return Number(lab?.unit_price||window.invoiceDefaultLaborRate?.()||115)}
// v24.58.0: choose the mechanic before the approved jobs go on a work order.
function woDialog(){document.getElementById('estWoDlg')?.remove();let users={};try{users=USERS||{}}catch(_){users=window.USERS||{}}const e=S.cur.estimate;
 const mechs=Object.entries(users).filter(([,u])=>u?.role==='mechanic').map(([k,u])=>[k,u.display||k]).sort((a,b)=>a[1].localeCompare(b[1]));
 const jobs=(S.cur.lines||[]).filter(l=>l.line_type==='labor'&&l.customer_decision!=='declined');
 const d=document.createElement('div');d.id='estWoDlg';d.className='estWoDlg';d.setAttribute('role','dialog');
 d.innerHTML=`<div class="estWoBox"><h3 style="margin:0 0 4px">Create work order</h3><div class="muted" style="margin-bottom:10px">${h(e.customer_name||'')}${e.unit_number?` · Unit ${h(e.unit_number)}`:''} · ${jobs.length} job${jobs.length===1?'':'s'}${(S.cur.lines||[]).some(l=>l.customer_decision==='declined')?' (declined jobs left out)':''}</div>
  <ul style="margin:0 0 10px;padding-left:18px">${jobs.map(l=>`<li>${h(l.job_name||l.description)}</li>`).join('')}</ul>
  <label class="estWoF">Mechanic<select id="estWoMech"><option value="">Assign later</option>${mechs.map(([k,n])=>`<option value="${h(k)}">${h(n)}</option>`).join('')}</select></label>
  <label class="estWoF">Priority<select id="estWoPri"><option>Normal</option><option>High</option><option>Urgent</option><option>Low</option></select></label>
  <label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="estWoHere" checked style="width:auto;min-height:auto"> The truck is here</label>
  <div style="display:flex;gap:8px;justify-content:flex-end"><button class="secondary" data-est="wo-cancel">Cancel</button><button data-est="wo-create">Create work order</button></div></div>`;
 S.scope.host.appendChild(d)}
async function openEmail(id){
 const d=await api(`/api/estimates/${id}/email-draft`);
 if(!d.configured)return toast('Email is not connected yet. The owner can connect the shop Google email in Reports → Gmail inbox → Email sending.','error',8000);
 $('#estEmailBox')?.remove();
 const box=document.createElement('div');box.id='estEmailBox';box.className='estEditor';box.style.zIndex='60';
 box.innerHTML=`<div class="estEditorBox" style="max-width:640px"><div class="estHead"><h2>Email estimate</h2><div class="estHeadActions"><button class="secondary" data-est="email-close">Cancel</button></div></div><div style="padding:16px 22px">
  <div class="field"><label>To</label><input id="estMailTo" value="${h(d.to)}" placeholder="customer@example.com"></div>
  <div class="field"><label>CC (optional)</label><input id="estMailCc"></div>
  <div class="field"><label>Subject</label><input id="estMailSubject" value="${h(d.subject)}"></div>
  <div class="field"><label>Message</label><textarea id="estMailMsg" style="min-height:180px">${h(d.message)}</textarea></div>
  <div class="muted" style="margin-bottom:12px">The estimate PDF is attached automatically. A draft estimate is marked Sent.</div>
  <div style="display:flex;justify-content:flex-end"><button data-est="email-send">Send estimate</button></div></div></div>`;
 S.scope.host.appendChild(box);
}
async function sendEmail(id,btn){
 btn.disabled=true;btn.textContent='Sending…';
 try{await api(`/api/estimates/${id}/email`,{method:'POST',body:{to:$('#estMailTo').value,cc:$('#estMailCc').value,subject:$('#estMailSubject').value,message:$('#estMailMsg').value,requestId:crypto.randomUUID?.()||String(Date.now())}});
  $('#estEmailBox')?.remove();toast('Estimate emailed.','success');await reload()}
 catch(e){btn.disabled=false;btn.textContent='Send estimate';toast(e.message,'error')}
}
async function openPdf(){
 const w=window.open('','_blank');
 try{const r=await fetch(`/api/estimates/${S.cur.estimate.id}/pdf`,{headers:window.authHeaders()});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'PDF failed');const url=URL.createObjectURL(await r.blob());if(w)w.location=url;else location.href=url;setTimeout(()=>URL.revokeObjectURL(url),60000)}
 catch(e){w?.close();toast(e.message,'error')}
}
async function onClick(ev){
 const row=ev.target.closest('tr[data-open]');if(row){openEstimate(row.dataset.open);return}
 const b=ev.target.closest('[data-est]');if(!b)return;const act=b.dataset.est;
 if(ev.target.id==='estEditor'&&act!=='close')return;
 try{
  if(act==='new')return startNew();
  if(act==='filter'){S.filter=S.filter===b.dataset.status?'':b.dataset.status;return loadList()}
  if(act==='close')return closeEditor();
  if(act==='pick')return pickLookup(Number(b.dataset.i));
  if(act==='create')return createEstimate(b);
  const id=S.cur?.estimate?.id;if(!id)return;
  if(act==='pdf')return openPdf();
  if(act==='email')return openEmail(id);
  if(act==='email-send')return sendEmail(id,b);
  if(act==='email-close'){$('#estEmailBox')?.remove();return}
  if(act==='status'){let note='';if(b.dataset.to==='declined'){note=prompt('Why was it declined? (optional)')??null;if(note===null)return}
   await api(`/api/estimates/${id}`,{method:'PUT',body:{status:b.dataset.to,decisionNote:note}});toast(`Estimate marked ${LABEL[b.dataset.to]||b.dataset.to}.`,'success');return reload()}
  if(act==='open-wo'){const w=b.dataset.id;closeEditor();await window.showView?.('workorders');setTimeout(()=>window.openDetail?.(Number(w)),300);return}
  if(act==='to-wo')return woDialog();
  if(act==='wo-cancel'){document.getElementById('estWoDlg')?.remove();return}
  if(act==='wo-create'){const dlg=document.getElementById('estWoDlg');b.disabled=true;
   try{const d=await api(`/api/estimates/${id}/work-order`,{method:'POST',body:{mechanic:dlg.querySelector('#estWoMech').value,truckHere:dlg.querySelector('#estWoHere').checked,priority:dlg.querySelector('#estWoPri').value}});
    dlg.remove();toast(`Work order #${d.workOrderId} created with ${d.jobs} job${d.jobs===1?'':'s'}.`,'success');try{await window.refreshCloudStateSilently?.()}catch(_){}await reload()}
   catch(err){b.disabled=false;toast(err.message,'error')}return}
  if(act==='convert'){if(!confirm('Create a draft invoice from this estimate?'))return;b.disabled=true;const d=await api(`/api/estimates/${id}/convert`,{method:'POST',body:{}});toast(`Draft invoice ${d.invoiceNumber||''} created.`,'success');return goInvoice(d.id)}
  if(act==='open-invoice')return goInvoice(b.dataset.id);
  if(act==='delete'){if(!confirm(`Delete ${S.cur.estimate.estimate_number}? This cannot be undone.`))return;await api(`/api/estimates/${id}`,{method:'DELETE'});toast('Estimate deleted.');return closeEditor()}
  if(act==='del-line')return api(`/api/estimates/${id}/lines/${b.dataset.id}`,{method:'DELETE'}).then(reload);
  if(act==='share')return window.shareCustomerLink?.({kind:'estimate',refId:String(S.cur.estimate.id),title:`Estimate ${S.cur.estimate.estimate_number}`,customerId:S.cur.estimate.customer_id,onDone:reload});
  if(act==='canned')return window.openCannedJobs?.({target:'estimate',id:S.cur.estimate.id,onDone:reload});
  if(act==='add-job'){const d=String($('#estNewJob')?.value||'').trim();if(!d)return toast('Describe the job first.','error');return addLine({lineType:'labor',description:d,quantity:Number($('#estNewJobHours')?.value||1),unitPrice:defaultRate(),taxable:false})}
  if(act==='add-other')return addLine({lineType:'other',description:'Other charge',quantity:1,unitPrice:0,parentLineId:b.dataset.parent});
  if(act==='pick-part'){const p=S.partResults[Number(b.dataset.i)];if(p&&!(Number(p.price)>0))toast(`${p.part_number||p.description||'This part'} has no sell price yet — type the price on the line (and set it in Parts).`,'warning');if(p)return addLine({lineType:'part',parentLineId:b.dataset.parent,inventoryPartId:p.id,partNumber:p.part_number,description:p.description,quantity:1,unitPrice:Number(p.price||0),unitCost:Number(p.cost||0),taxable:p.sell_taxable!==false});return}
  if(act==='custom-part'){const q=S.scope.host.querySelector(`[data-est-input="part"][data-parent="${b.dataset.parent}"]`)?.value||'Part';return addLine({lineType:'part',parentLineId:b.dataset.parent,description:q,quantity:1,unitPrice:0,taxable:true})}
  if(act==='tire-fees')return window.openTireFeeDialog({kind:'estimate',id,lines:S.cur.lines,onDone:reload});
 }catch(e){b.disabled=false;toast(e.message,'error')}
}
async function goInvoice(id){$('#estEditor')?.classList.add('hidden');document.body.classList.remove('modalOpen');await window.showView('invoices');await window.loadInvoices?.();window.openInvoiceWorkspace?.(Number(id))}
function onChange(ev){
 const t=ev.target;
 if(t.dataset.h)return saveHeader(t);
 const row=t.closest('.estRow[data-line]');if(row&&t.dataset.f)return saveLine(row);
}
// The markup under the buy price follows what is typed in Buy or Sell.
function costInput(t){
 const row=t.closest('.estRow[data-line]');if(!row)return;const q=f=>row.querySelector(f),cost=q('[data-f="unitCost"]'),out=q('[data-mk-out]'),price=q('[data-f="unitPrice"]');if(!cost||!out||!price)return;
 out.textContent=mkText(cost.value,price.value);
}
function onInput(ev){
 const t=ev.target;
 if(t.dataset.f==='unitCost'||t.dataset.f==='unitPrice'){costInput(t);return}
 if(t.id==='estSearch'){clearTimeout(S.searchTimer);S.searchTimer=setTimeout(()=>{S.q=t.value.trim();loadList()},250);return}
 if(t.dataset.estInput==='lookup'){clearTimeout(S.lookupTimer);S.lookupTimer=setTimeout(()=>lookup(t.value),220);return}
 if(t.dataset.estInput==='part'){clearTimeout(S.partTimer);S.partTimer=setTimeout(()=>partSearch(t),220)}
}
function onKey(ev){
 if(ev.key==='Escape'&&!$('#estEditor')?.classList.contains('hidden')){ev.preventDefault();closeEditor()}
 if(ev.key==='Enter'&&ev.target.id==='estNewJob'){ev.preventDefault();S.scope.host.querySelector('[data-est="add-job"]')?.click()}
}
export async function mount(scope){
 S={...S,scope,cur:null};
 scope.on(scope.host,'click',onClick);scope.on(scope.host,'change',onChange);scope.on(scope.host,'input',onInput);scope.on(document,'keydown',onKey);
 scope.on(scope.host,'ittr:module-refresh',()=>loadList(),{passive:true});
 await loadList();
}
export async function afterShow(){await loadList()}
export function unmount(){document.body.classList.remove('modalOpen');S.cur=null;S.scope=null}
