// ITTR ShopFlow v24.40.0 Fleet & Compliance route module: fleet PM/CARB tracking + annual inspection form filler.
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=(u,o)=>window.apiJSON(u,o);
const toast=(m,t='info')=>window.showToast?.(m,t);
const day=v=>{if(!v)return '—';const d=new Date(String(v).slice(0,10)+'T12:00:00');return Number.isFinite(d.getTime())?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'};
const mi=v=>v==null||v===''?'—':`${Math.round(Number(v)).toLocaleString()} mi`;
const today=()=>new Date().toISOString().slice(0,10);
const isOwner=()=>{try{return session?.role==='admin'}catch(_){return false}};
const STATUS={overdue:'Overdue',due_soon:'Due soon',ok:'OK',no_data:'Needs dates/miles'};
let S={scope:null,tab:'fleet',fleet:null,meta:null,list:[],form:null,lookupTimer:0,unitTimer:0,lookup:{customers:[],fmcsa:null},units:[],prevTimer:0,prevUrl:null};
const $=sel=>S.scope?.host.querySelector(sel);

// ================================================================ fleet maintenance
async function loadFleet(){const box=$('#cmpFleet');box.innerHTML='<div class="cmpEmpty">Loading fleet maintenance…</div>';try{S.fleet=await api('/api/fleet-maintenance');renderFleet()}catch(e){box.innerHTML=`<div class="cmpEmpty">${h(e.message)}</div>`}}
function dueText(i){const parts=[];if(i.milesLeft!=null)parts.push(i.milesLeft<=0?`${Math.abs(i.milesLeft).toLocaleString()} mi past due`:`${i.milesLeft.toLocaleString()} mi left`);if(i.daysLeft!=null)parts.push(i.daysLeft<0?`${Math.abs(i.daysLeft)} days late`:`${i.daysLeft} days left`);return parts.join(' · ')||'—'}
function renderFleet(){
 const d=S.fleet,items=d.items,c=k=>items.filter(i=>i.status===k).length,owner=isOwner();
 const order={overdue:0,due_soon:1,no_data:2,ok:3};const sorted=[...items].sort((a,b)=>order[a.status]-order[b.status]||String(a.unit_display).localeCompare(String(b.unit_display)));
 const typeOpts=Object.entries(d.types).map(([k,t])=>`<option value="${k}">${h(t.name)}</option>`).join('');
 const unitOpts=d.units.map(u=>`<option value="${u.id}">${h(`Unit ${u.unit_number}${u.customer_name?` · ${u.customer_name}`:''}${u.odometer_miles!=null?` · ${Math.round(u.odometer_miles).toLocaleString()} mi`:''}`)}</option>`).join('');
 $('#cmpFleet').innerHTML=`<div class="cmpKpis"><div class="cmpKpi overdue"><span>Overdue</span><b>${c('overdue')}</b></div><div class="cmpKpi due"><span>Due soon</span><b>${c('due_soon')}</b></div><div class="cmpKpi ok"><span>OK</span><b>${c('ok')}</b></div><div class="cmpKpi"><span>Needs dates / miles</span><b>${c('no_data')}</b></div></div>
 <section class="cmpCard"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start"><div><h3>Service schedule</h3><div class="sub">Current miles come from Samsara (synced every 6 hours) or the last recorded mileage. A reminder email goes out when something becomes due soon or overdue.</div></div>
  <div class="cmpBar" style="margin:0">${d.samsara?'<button class="secondary" data-c="sync">Sync miles from Samsara</button>':'<span class="muted">Samsara not connected — miles come from work orders.</span>'}${owner?'<button class="secondary" data-c="send-alerts">Email reminders now</button>':''}</div></div>
  ${sorted.length?`<div class="cmpScroll"><table class="cmpTable"><thead><tr><th>Unit</th><th>Service</th><th>Every</th><th>Last done</th><th>Next due</th><th class="n">Current miles</th><th>Status</th><th></th></tr></thead><tbody>${sorted.map(i=>`<tr class="${i.status}">
   <td><b>${h(i.unit_display)}</b><div class="muted">${h(i.vin||i.unit_vin||'')}</div></td><td>${h(i.name)}${i.notes?`<div class="muted">${h(i.notes)}</div>`:''}</td>
   <td>${[i.interval_miles?`${Number(i.interval_miles).toLocaleString()} mi`:'',i.interval_days?`${i.interval_days} days`:''].filter(Boolean).join(' / ')||(i.due_date?'Expiry date':'—')}</td>
   <td>${day(i.last_done_date)}${i.last_done_miles!=null?`<div class="muted">${mi(i.last_done_miles)}</div>`:''}</td>
   <td>${i.dueDate?day(i.dueDate):''}${i.dueMiles!=null?`<div class="${i.dueDate?'muted':''}">${mi(i.dueMiles)}</div>`:''}${!i.dueDate&&i.dueMiles==null?'—':''}</td>
   <td class="n">${mi(i.currentMiles)}<div class="muted">${h(i.milesSource||'')}</div></td>
   <td><span class="cmpPill ${i.status}">${STATUS[i.status]}</span><div class="muted">${h(dueText(i))}</div></td>
   <td class="acts"><button data-c="done" data-id="${i.id}">Mark done</button> <button class="secondary" data-c="edit" data-id="${i.id}">Edit</button> <button class="secondary" data-c="hist" data-id="${i.id}">History</button> <button class="secondary danger" data-c="remove" data-id="${i.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="cmpEmpty">No services tracked yet. Add your trucks below — for example an oil change every 25,000 miles and the yearly CARB test.</div>'}
 </section>
 <section class="cmpCard" id="cmpAddCard"><h3 id="cmpAddTitle">Add a service to track</h3><div class="sub">Pick the truck, what needs doing, how often (miles and/or days), and when it was last done. For CARB tests you can type the expiry date instead.</div>
  <input type="hidden" id="fsId"><div class="cmpGrid">
  <div class="field span2"><label>Truck</label><select id="fsUnit"><option value="">— pick a unit, or type VIN / unit # →</option>${unitOpts}</select></div>
  <div class="field"><label>…or VIN</label><input id="fsVin" maxlength="17" placeholder="17-character VIN"></div><div class="field"><label>…or unit #</label><input id="fsLabel"></div>
  <div class="field span2"><label>Service</label><select id="fsType">${typeOpts}</select></div><div class="field span2"><label>Name shown</label><input id="fsName" placeholder="e.g. Oil change + filters"></div>
  <div class="field"><label>Every (miles)</label><input id="fsMiles" type="number" min="0" step="500"></div><div class="field"><label>Every (days)</label><input id="fsDays" type="number" min="0"></div>
  <div class="field"><label>Warn miles before</label><input id="fsWarnMiles" type="number" min="0" value="1000"></div><div class="field"><label>Warn days before</label><input id="fsWarnDays" type="number" min="0" value="30"></div>
  <div class="field"><label>Last done (date)</label><input id="fsLastDate" type="date"></div><div class="field"><label>Last done (miles)</label><input id="fsLastMiles" type="number" min="0"></div>
  <div class="field"><label>Expires / due date (optional)</label><input id="fsDue" type="date"></div><div class="field"><label>Notes</label><input id="fsNotes"></div>
  </div><div class="cmpBar"><button class="secondary" data-c="cancel-edit" id="fsCancel" style="display:none">Cancel edit</button><button data-c="save-item">Save service</button></div></section>
 <section class="cmpCard"><h3>Add many at once (e.g. CARB tests for every truck)</h3><div class="sub">One truck per line: <b>VIN or unit #, last done date, expiry date</b> — dates as YYYY-MM-DD or MM/DD/YYYY. Expiry is optional (the interval is used instead).</div>
  <div class="cmpGrid"><div class="field span2"><label>Service</label><select id="fbType">${typeOpts}</select></div></div>
  <div class="field" style="margin-top:10px"><textarea id="fbLines" placeholder="1FUJHHDR8MLML6600, 2026-01-15, 2027-01-15&#10;Unit 25, 03/02/2026"></textarea></div><div class="cmpBar"><button data-c="bulk">Add all</button></div></section>
 ${owner?`<section class="cmpCard"><h3>Reminder emails</h3><div class="sub">Sent when a service becomes due soon or overdue (once per change). Uses your Resend email setup.</div><div class="cmpGrid"><div class="field span2"><label>Send to</label><input id="faEmail" type="email" value="${h(d.alerts.email||'')}" placeholder="${h(d.alerts.defaultEmail||'you@yourshop.com')}"></div><div class="field"><label>Enabled</label><select id="faOn"><option value="1" ${d.alerts.enabled!==false?'selected':''}>Yes</option><option value="0" ${d.alerts.enabled===false?'selected':''}>No</option></select></div></div><div class="cmpBar"><button class="secondary" data-c="save-alerts">Save</button></div></section>`:''}`;
 applyTypeDefaults(false);
}
function applyTypeDefaults(force=true){const t=S.fleet?.types?.[$('#fsType')?.value];if(!t)return;if(force||!$('#fsMiles').value)$('#fsMiles').value=t.miles??'';if(force||!$('#fsDays').value)$('#fsDays').value=t.days??'';if(force||!$('#fsName').value)$('#fsName').placeholder=t.name}
const normDate=v=>{v=String(v||'').trim();if(!v)return '';let m=v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(m)return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;m=v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);if(m)return `${m[3].length===2?'20'+m[3]:m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;return ''};
function itemBody(){const v=id=>$(id)?.value??'';return {unitId:v('#fsUnit')||null,vin:v('#fsVin'),unitLabel:v('#fsLabel'),serviceType:v('#fsType'),name:v('#fsName'),intervalMiles:v('#fsMiles'),intervalDays:v('#fsDays'),warnMiles:v('#fsWarnMiles'),warnDays:v('#fsWarnDays'),lastDoneDate:v('#fsLastDate'),lastDoneMiles:v('#fsLastMiles'),dueDate:v('#fsDue'),notes:v('#fsNotes')}}
function editItem(id){const i=S.fleet.items.find(x=>String(x.id)===String(id));if(!i)return;const set=(k,v)=>{const el=$(k);if(el)el.value=v??''};
 set('#fsId',i.id);set('#fsUnit',i.unit_id||'');set('#fsVin',i.unit_id?'':i.vin);set('#fsLabel',i.unit_id?'':i.unit_label);set('#fsType',i.service_type);set('#fsName',i.name);set('#fsMiles',i.interval_miles);set('#fsDays',i.interval_days);set('#fsWarnMiles',i.warn_miles);set('#fsWarnDays',i.warn_days);set('#fsLastDate',String(i.last_done_date||'').slice(0,10));set('#fsLastMiles',i.last_done_miles);set('#fsDue',String(i.due_date||'').slice(0,10));set('#fsNotes',i.notes);
 $('#cmpAddTitle').textContent=`Edit: ${i.unit_display} — ${i.name}`;$('#fsCancel').style.display='';$('#cmpAddCard').scrollIntoView({behavior:'smooth',block:'start'})}
function modal(html){const m=document.createElement('div');m.className='cmpModal';m.innerHTML=`<div>${html}</div>`;m.addEventListener('click',e=>{if(e.target===m||e.target.dataset.close!==undefined)m.remove()});S.scope.host.appendChild(m);return m}
function markDone(id){const i=S.fleet.items.find(x=>String(x.id)===String(id));if(!i)return;const carb=/carb|annual/.test(i.service_type);
 const m=modal(`<h2 style="margin-top:0">Mark done: ${h(i.unit_display)}</h2><div class="muted" style="margin-bottom:12px">${h(i.name)}</div><div class="cmpGrid" style="grid-template-columns:1fr 1fr"><div class="field"><label>Date done</label><input id="mdDate" type="date" value="${today()}"></div><div class="field"><label>Odometer (miles)</label><input id="mdMiles" type="number" value="${i.currentMiles!=null?Math.round(i.currentMiles):''}"></div>
  <div class="field"><label>${carb?'New expiry date':'Next due date (optional)'}</label><input id="mdNext" type="date"></div><div class="field"><label>Work order # (optional)</label><input id="mdWo"></div><div class="field span4" style="grid-column:1/-1"><label>Note</label><input id="mdNote"></div></div>
  <div class="cmpBar"><button class="secondary" data-close>Cancel</button><button id="mdSave">Save</button></div>`);
 m.querySelector('#mdSave').onclick=async()=>{try{await api(`/api/fleet-maintenance/${id}/done`,{method:'POST',body:{doneDate:m.querySelector('#mdDate').value,doneMiles:m.querySelector('#mdMiles').value,nextDueDate:m.querySelector('#mdNext').value,workOrderId:m.querySelector('#mdWo').value,note:m.querySelector('#mdNote').value}});m.remove();toast('Service recorded.','success');loadFleet()}catch(e){toast(e.message,'error')}}}
async function history(id){const i=S.fleet.items.find(x=>String(x.id)===String(id));const d=await api(`/api/fleet-maintenance/${id}/history`);
 modal(`<h2 style="margin-top:0">History: ${h(i?.unit_display||'')}</h2><div class="muted" style="margin-bottom:10px">${h(i?.name||'')}</div>${d.items.length?`<table class="cmpTable"><thead><tr><th>Date</th><th class="n">Miles</th><th>WO</th><th>Note</th><th>By</th></tr></thead><tbody>${d.items.map(x=>`<tr><td>${day(x.done_date)}</td><td class="n">${mi(x.done_miles)}</td><td>${h(x.work_order_id||'')}</td><td>${h(x.note||'')}</td><td>${h(x.recorded_by)}</td></tr>`).join('')}</tbody></table>`:'<div class="cmpEmpty">Not recorded yet.</div>'}<div class="cmpBar"><button class="secondary" data-close>Close</button></div>`)}

// ================================================================ annual inspections (fill-in over the shop's own PDF forms)
const FIELD_ORDER=[['carrierName','span2'],['address','span2'],['cityStateZip','span2'],['reportNumber',''],['date',''],['unitNumber',''],['vin',''],['inspectorName','span2'],['agency','span2'],['otherConditions','span2']];
const usDate=(d=new Date())=>`${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
async function loadAnnual(){
 const box=$('#cmpAnnual');if(!S.meta){try{S.meta=await api('/api/inspection-docs/templates')}catch(e){box.innerHTML=`<div class="cmpEmpty">${h(e.message)}</div>`;return}}
 try{S.list=(await api('/api/inspection-docs')).items}catch(e){box.innerHTML=`<div class="cmpEmpty">${h(e.message)}</div>`;return}
 if(!S.form)return renderAnnualList();renderAnnualForm();
}
function renderAnnualList(){
 const tl=k=>S.meta.templates.find(t=>t.key===k)?.label||k;
 $('#cmpAnnual').innerHTML=`<section class="cmpCard"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><h3>Annual inspection forms</h3><div class="sub">Your own truck and trailer inspection forms. Fill in the carrier, address, date and VIN, then print or download.</div></div><div class="cmpBar" style="margin:0"><button data-c="new-insp" data-tpl="truck">+ Truck / tractor form</button><button data-c="new-insp" data-tpl="trailer">+ Trailer form</button></div></div>
 ${S.list.length?`<div class="cmpScroll"><table class="cmpTable"><thead><tr><th>Date</th><th>Form</th><th>Carrier</th><th>Unit</th><th>VIN</th><th></th></tr></thead><tbody>${S.list.map(r=>`<tr><td>${h(r.doc_date||'')}</td><td>${h(tl(r.template))}</td><td>${h(r.carrier_name)}</td><td>${h(r.unit_number||'—')}</td><td>${h(r.vin||'')}</td>
  <td class="acts"><button class="secondary" data-c="pdf" data-id="${r.id}">Print</button> <button class="secondary" data-c="download" data-id="${r.id}">Download</button> <button class="secondary" data-c="edit-insp" data-id="${r.id}">Edit</button> <button class="secondary" data-c="copy-insp" data-id="${r.id}">Copy for next unit</button> <button class="secondary" data-c="del-insp" data-id="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="cmpEmpty">No filled forms yet.</div>'}</section>`;
}
function blankForm(template='truck'){const shop=S.meta.shop||{};let inspector='';try{inspector=localStorage.getItem('ittr_last_inspector')||''}catch(_){}
 return {id:null,template,customerId:null,unitId:null,fields:{carrierName:'',address:'',cityStateZip:'',reportNumber:'',unitNumber:'',date:usDate(),inspectorName:inspector,vin:'',agency:[shop.name,shop.address2].filter(Boolean).join(', ').toUpperCase(),otherConditions:'NONE'}}}
function renderAnnualForm(){
 const f=S.form,L=S.meta.fields;
 const fld=([k,cls])=>`<div class="field ${cls}"><label>${h(L[k]||k)}</label><input data-f="${k}" value="${h(f.fields[k]??'')}" ${k==='vin'?'maxlength="17" style="text-transform:uppercase"':''} ${k==='date'?'placeholder="M/D/YYYY"':''}></div>`;
 $('#cmpAnnual').innerHTML=`<div class="cmpEditor"><section class="cmpCard"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><h3>${f.id?'Edit form':'Fill in form'}</h3><div class="sub">Only the header and "other conditions" change. The checklist on your form stays as it is.</div></div><button class="secondary" data-c="back">← All forms</button></div>
  <div class="cmpTypes" style="margin-bottom:12px">${S.meta.templates.map(t=>`<label class="${f.template===t.key?'on':''}"><input type="radio" name="cmpTpl" data-c-tpl="${t.key}" ${f.template===t.key?'checked':''}> ${h(t.label)}</label>`).join('')}</div>
  <div class="cmpGrid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
   <div class="field span2 cmpDrop"><label>Find carrier: USDOT # or company name</label><input id="cmpLookup" data-c-input="lookup" autocomplete="off" placeholder="e.g. 3182456 or HOBO Transportation"><div id="cmpLookupList" class="cmpDropList hidden"></div></div>
   <div class="field span2 cmpDrop"><label>Pick unit (fills unit # and VIN)</label><input id="cmpUnitSearch" data-c-input="unit" autocomplete="off" placeholder="Search unit # or VIN${f.customerId?' for this carrier':''}"><div id="cmpUnitList" class="cmpDropList hidden"></div></div>
   ${FIELD_ORDER.map(fld).join('')}</div>
  <div class="cmpBar"><button class="secondary" data-c="back">Cancel</button><button class="secondary" data-c="save-insp">Save</button><button class="secondary" data-c="save-dl">Save &amp; download</button><button data-c="save-pdf">Save &amp; print</button></div></section>
  <section class="cmpCard cmpPreview"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3>Preview</h3><span class="muted" id="cmpPrevState"></span></div><iframe id="cmpPrevFrame" title="Inspection form preview"></iframe></section></div>`;
 schedulePreview(0);
}
function readForm(){const f=S.form;S.scope.host.querySelectorAll('#cmpAnnual [data-f]').forEach(el=>{f.fields[el.dataset.f]=el.dataset.f==='vin'?el.value.toUpperCase():el.value});return f}
function schedulePreview(ms=600){clearTimeout(S.prevTimer);S.prevTimer=setTimeout(refreshPreview,ms)}
async function refreshPreview(){const fr=$('#cmpPrevFrame'),st=$('#cmpPrevState');if(!fr||!S.form)return;const f=readForm();
 const fields=f.fields;st&&(st.textContent='Updating…');
 try{const r=await fetch('/api/inspection-docs/preview',{method:'POST',headers:{...window.authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({template:f.template,fields})});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Preview failed');
  const url=URL.createObjectURL(await r.blob());if(S.prevUrl)URL.revokeObjectURL(S.prevUrl);S.prevUrl=url;fr.src=url+'#toolbar=0&navpanes=0&view=Fit';st&&(st.textContent='')}catch(e){st&&(st.textContent=e.message)}}
async function lookupCarrier(q){const list=$('#cmpLookupList');if(!list)return;if(q.trim().length<2){list.classList.add('hidden');return}
 try{S.lookup=await api(`/api/annual-inspections/lookup?q=${encodeURIComponent(q.trim())}`);const L=S.lookup,fm=L.fmcsa;
  list.innerHTML=`${fm?`<button type="button" data-c="pick-fmcsa"><span class="tag">FMCSA</span>${h(fm.legalName||fm.dbaName)}<small>USDOT ${h(fm.dotNumber)} · ${h([fm.address,fm.city,fm.state,fm.zip].filter(Boolean).join(', '))}</small></button>`:''}${L.customers.map((c,i)=>`<button type="button" data-c="pick-cust" data-i="${i}"><span class="tag" style="background:#ecfdf3;color:#067647">Customer</span>${h(c.customer_name)}<small>${c.dot_number?`USDOT ${h(c.dot_number)} · `:''}${h([c.address,c.city,c.state,c.postal_code].filter(Boolean).join(', '))}</small></button>`).join('')}${!fm&&!L.customers.length?`<button type="button" disabled>No match.${L.fmcsaError?` ${h(L.fmcsaError)}`:''}</button>`:''}`;
  list.classList.remove('hidden')}catch(e){toast(e.message,'error')}}
async function searchUnits(q){const list=$('#cmpUnitList');if(!list)return;try{const d=await api(`/api/annual-inspections/units?q=${encodeURIComponent(q)}${S.form.customerId?`&customerId=${S.form.customerId}`:''}`);S.units=d.items;
 list.innerHTML=d.items.map((u,i)=>`<button type="button" data-c="pick-unit" data-i="${i}">Unit ${h(u.unit_number)}<small>${h([u.year,u.make,u.model].filter(Boolean).join(' '))}${u.vin?` · VIN ${h(u.vin)}`:''}${u.plate?` · ${h(u.plate)}`:''}</small></button>`).join('')||'<button type="button" disabled>No units found.</button>';list.classList.remove('hidden')}catch(e){toast(e.message,'error')}}
function setFields(o){readForm();Object.assign(S.form.fields,o);for(const [k,v] of Object.entries(o)){const el=$(`#cmpAnnual [data-f="${k}"]`);if(el)el.value=v}S.scope.host.querySelectorAll('.cmpDropList').forEach(x=>x.classList.add('hidden'));schedulePreview(0)}
async function saveInspection(then){const f=readForm();if(!f.fields.carrierName.trim())return toast('Motor carrier name is required.','error');
 const w=then==='print'?window.open('','_blank'):null;
 try{const d=await api('/api/inspection-docs',{method:'POST',body:{id:f.id,template:f.template,fields:f.fields,customerId:f.customerId,unitId:f.unitId}});f.id=d.id;try{localStorage.setItem('ittr_last_inspector',f.fields.inspectorName||'')}catch(_){}
  toast('Form saved.','success');if(then)await openInspectionPdf(d.id,then==='download',w);S.form=null;await loadAnnual()}catch(e){w?.close();toast(e.message,'error')}}
async function openInspectionPdf(id,download=false,win=null){const w=win||(download?null:window.open('','_blank'));
 try{const r=await fetch(`/api/inspection-docs/${id}/pdf${download?'?download=1':''}`,{headers:window.authHeaders()});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'PDF failed');const blob=await r.blob(),url=URL.createObjectURL(blob);
  if(download){const a=document.createElement('a');a.href=url;a.download=(r.headers.get('content-disposition')||'').match(/filename="([^"]+)"/)?.[1]||'annual-inspection.pdf';document.body.appendChild(a);a.click();a.remove()}else if(w)w.location=url;else location.href=url;setTimeout(()=>URL.revokeObjectURL(url),60000)}
 catch(e){w?.close();toast(e.message,'error')}}

// ================================================================ events
async function onClick(ev){
 const b=ev.target.closest('[data-c]');if(!b)return;const a=b.dataset.c;
 try{
  if(a==='tab'){S.tab=b.dataset.t;try{sessionStorage.setItem('ittr_compliance_tab',S.tab)}catch(_){}return applyTab()}
  // fleet
  if(a==='sync'){b.disabled=true;const d=await api('/api/fleet-maintenance/sync-miles',{method:'POST',body:{}});toast(`Samsara: ${d.updated} unit odometer${d.updated===1?'':'s'} updated.`,'success');return loadFleet()}
  if(a==='send-alerts'){const d=await api('/api/fleet-maintenance/alerts/send',{method:'POST',body:{}});return toast(d.count?(d.sent?`Reminder email sent to ${d.to} (${d.count} item${d.count===1?'':'s'}).`:`Not sent: ${d.error||'no email address set'}`):'Nothing is due soon or overdue.',d.count&&!d.sent?'error':'success')}
  if(a==='save-item'){const id=$('#fsId').value,body=itemBody();id?await api(`/api/fleet-maintenance/${id}`,{method:'PUT',body}):await api('/api/fleet-maintenance',{method:'POST',body});toast('Service saved.','success');return loadFleet()}
  if(a==='cancel-edit')return loadFleet();
  if(a==='edit')return editItem(b.dataset.id);
  if(a==='done')return markDone(b.dataset.id);
  if(a==='hist')return history(b.dataset.id);
  if(a==='remove'){if(!confirm('Stop tracking this service?'))return;await api(`/api/fleet-maintenance/${b.dataset.id}`,{method:'DELETE'});return loadFleet()}
  if(a==='bulk'){const type=$('#fbType').value,lines=$('#fbLines').value.split(/\n+/).map(l=>l.trim()).filter(Boolean);if(!lines.length)return toast('Paste at least one line.','error');
   const items=lines.map(l=>{const [id,last,exp]=l.split(/[,\t;]+/).map(x=>x.trim());const vin=/^[A-HJ-NPR-Z0-9]{17}$/i.test(id||'')?id:'';return {serviceType:type,vin,unitLabel:vin?'':String(id||'').replace(/^unit\s*/i,''),lastDoneDate:normDate(last),dueDate:normDate(exp)}});
   const d=await api('/api/fleet-maintenance',{method:'POST',body:{items}});toast(`${d.ids.length} service${d.ids.length===1?'':'s'} added.${d.errors?.length?` Skipped line${d.errors.length===1?'':'s'} ${d.errors.map(x=>x.line).join(', ')} (no VIN or unit #).`:''}`,d.errors?.length?'error':'success',8000);return loadFleet()}
  if(a==='save-alerts'){await api('/api/fleet-maintenance/settings/alerts',{method:'PUT',body:{email:$('#faEmail').value,enabled:$('#faOn').value==='1'}});return toast('Reminder settings saved.','success')}
  // annual
  if(a==='new-insp'){S.form=blankForm(b.dataset.tpl);return renderAnnualForm()}
  if(a==='back'){S.form=null;return renderAnnualList()}
  if(a==='edit-insp'||a==='copy-insp'){const r=(await api(`/api/inspection-docs/${b.dataset.id}`)).item;S.form={id:r.id,template:r.template,customerId:r.customer_id,unitId:r.unit_id,fields:{...blankForm(r.template).fields,...(r.fields||{})}};
   if(a==='copy-insp')Object.assign(S.form,{id:null,unitId:null}),Object.assign(S.form.fields,{unitNumber:'',vin:'',reportNumber:'',date:usDate()});return renderAnnualForm()}
  if(a==='del-insp'){if(!confirm('Delete this saved form?'))return;await api(`/api/inspection-docs/${b.dataset.id}`,{method:'DELETE'});return loadAnnual()}
  if(a==='pdf')return openInspectionPdf(b.dataset.id);
  if(a==='download')return openInspectionPdf(b.dataset.id,true);
  if(a==='pick-fmcsa'){const fm=S.lookup.fmcsa;return setFields({carrierName:(fm.legalName||fm.dbaName||'').toUpperCase(),address:(fm.address||'').toUpperCase(),cityStateZip:`${fm.city||''}${fm.state?`, ${fm.state}`:''} ${fm.zip||''}`.trim().toUpperCase()})}
  if(a==='pick-cust'){const c=S.lookup.customers[Number(b.dataset.i)];S.form.customerId=c.id;return setFields({carrierName:String(c.customer_name||'').toUpperCase(),address:String(c.address||'').toUpperCase(),cityStateZip:`${c.city||''}${c.state?`, ${c.state}`:''} ${c.postal_code||''}`.trim().toUpperCase()})}
  if(a==='pick-unit'){const u=S.units[Number(b.dataset.i)];S.form.unitId=u.id;return setFields({unitNumber:u.unit_number||'',vin:String(u.vin||'').toUpperCase()})}
  if(a==='save-insp')return saveInspection(null);
  if(a==='save-dl')return saveInspection('download');
  if(a==='save-pdf')return saveInspection('print');
 }catch(e){b.disabled=false;toast(e.message,'error')}
}
function onChange(ev){const t=ev.target;
 if(t.id==='fsType')return applyTypeDefaults(true);
 if(t.dataset.cTpl){readForm();S.form.template=t.dataset.cTpl;S.scope.host.querySelectorAll('#cmpAnnual .cmpTypes label').forEach(l=>l.classList.toggle('on',l.querySelector('input')?.dataset.cTpl===S.form.template));return schedulePreview(0)}
}
function onInput(ev){const t=ev.target;
 if(t.dataset.cInput==='lookup'){clearTimeout(S.lookupTimer);S.lookupTimer=setTimeout(()=>lookupCarrier(t.value),300)}
 if(t.dataset.cInput==='unit'){clearTimeout(S.unitTimer);S.unitTimer=setTimeout(()=>searchUnits(t.value),250)}
 if(t.dataset.f&&S.form)schedulePreview();
}
function applyTab(){S.scope.host.querySelectorAll('[data-c="tab"]').forEach(b=>b.classList.toggle('active',b.dataset.t===S.tab));S.scope.host.querySelectorAll('.cmpPanel').forEach(p=>p.classList.toggle('active',p.dataset.panel===S.tab));return S.tab==='fleet'?loadFleet():loadAnnual()}
export async function mount(scope){S={...S,scope,form:null};try{S.tab=sessionStorage.getItem('ittr_compliance_tab')||'fleet'}catch(_){}
 scope.on(scope.host,'click',onClick);scope.on(scope.host,'change',onChange);scope.on(scope.host,'input',onInput);
 scope.on(document,'click',e=>{if(!e.target.closest?.('.cmpDrop'))S.scope?.host.querySelectorAll('.cmpDropList').forEach(x=>x.classList.add('hidden'))});
 await applyTab()}
export async function afterShow(){}
export function unmount(){clearTimeout(S.prevTimer);if(S.prevUrl)URL.revokeObjectURL(S.prevUrl);S.prevUrl=null;S.scope=null}
