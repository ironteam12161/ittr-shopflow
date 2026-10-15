/* v24.54.0: canned jobs: pick a saved job package and add it to an estimate, an invoice or a work order, or
   create and edit packages. One window shared by every screen.
   openCannedJobs({target:'estimate'|'invoice'|'workorder', id, textarea, onDone}) */
(function(){
 const T=s=>typeof tr==='function'?tr(s):s,E=s=>typeof esc==='function'?esc(s):String(s??'');
 const money=n=>`$${Number(n||0).toFixed(2)}`;
 const TYPES=[['labor','Labor'],['part','Part'],['fee','Fee'],['sublet','Sublet'],['other','Other']];
 let ctx={},items=[],editing=null;
 function modal(){let m=document.getElementById('cannedJobsModal');if(!m){m=document.createElement('div');m.className='modal';m.id='cannedJobsModal';document.body.appendChild(m)}return m}
 async function load(q=''){try{items=(await apiJSON(`/api/canned-jobs?q=${encodeURIComponent(q)}`)).items||[]}catch(e){items=[];showToast(e.message,'error')}}
 function listHtml(){
  const pick=ctx.target&&ctx.target!=='manage';
  return items.length?items.map(j=>{const stale=j.lines.some(l=>l.currentPrice!=null&&Math.abs(l.currentPrice-l.unitPrice)>=0.01);
   return `<div class="cjRow"><div class="cjMain"><b>${E(j.name)}</b>${j.category?` <span class="cjCat">${E(j.category)}</span>`:''}
    <div class="muted">${j.lines.length} ${T(j.lines.length===1?'line':'lines')} · ${money(j.total)}${j.useCount?` · ${T('used')} ${j.useCount}×`:''}${stale?` · <span class="cjWarn">${T('a part price changed in stock')}</span>`:''}</div>
    <div class="cjLines">${j.lines.slice(0,4).map(l=>`${E(l.lineType==='labor'?'⏱':'•')} ${E(l.description)}${l.quantity!==1?` ×${l.quantity}`:''}`).join(' &nbsp; ')}${j.lines.length>4?' …':''}</div></div>
    <div class="cjActs">${pick?`<button type="button" data-cj="use" data-id="${Number(j.id)}">${T('Add')}</button>`:''}<button type="button" class="secondary" data-cj="edit" data-id="${Number(j.id)}">${T('Edit')}</button></div></div>`}).join('')
   :`<div class="empty">${T('No canned jobs yet. Save the jobs you do every week (PM service, brakes, tires) once, then add them in one click.')}</div>`}
 function render(){const m=modal(),title=ctx.target==='estimate'?T('Add a canned job to this estimate'):ctx.target==='invoice'?T('Add a canned job to this invoice'):ctx.target==='workorder'?T('Add a canned job to this work order'):T('Canned jobs');
  m.innerHTML=`<div class="modalbox" style="max-width:760px"><div class="modalhead"><h2>${E(title)}</h2><button class="x" type="button" data-cj="close">×</button></div>
   <div class="cjBar"><input id="cjSearch" type="search" placeholder="${E(T('Search canned jobs…'))}" value="${E(ctx.q||'')}"><button type="button" class="secondary" data-cj="new">+ ${T('New canned job')}</button></div>
   <div id="cjBody">${editing?editorHtml():listHtml()}</div></div>`;
  m.classList.add('open')}
 function lineRow(l={lineType:'part',description:'',partNumber:'',quantity:1,unitPrice:0,taxable:false},i){
  return `<tr data-i="${i}"><td><select data-f="lineType">${TYPES.map(([v,n])=>`<option value="${v}" ${l.lineType===v?'selected':''}>${T(n)}</option>`).join('')}</select></td>
   <td><input data-f="description" value="${E(l.description)}" placeholder="${E(T('Description'))}"></td>
   <td><input data-f="partNumber" value="${E(l.partNumber||'')}" placeholder="${E(T('Part #'))}" ${l.lineType==='part'?'':'disabled'}></td>
   <td><input data-f="quantity" type="number" step="0.1" min="0" value="${Number(l.quantity??1)}" title="${E(T('Hours for labor'))}"></td>
   <td><input data-f="unitPrice" type="number" step="0.01" min="0" value="${Number(l.unitPrice||0)}"></td>
   <td style="text-align:center"><input data-f="taxable" type="checkbox" ${l.taxable?'checked':''} aria-label="${E(T('Taxable'))}"></td>
   <td><button type="button" class="secondary" data-cj="rmline" aria-label="${E(T('Remove line'))}">×</button></td></tr>`}
 function editorHtml(){const j=editing;return `<div class="cjEdit">
   <div class="cjGrid"><label>${T('Name')}<input id="cjName" value="${E(j.name||'')}" placeholder="${E(T('e.g. PM service – Freightliner Cascadia'))}"></label><label>${T('Category')}<input id="cjCat" value="${E(j.category||'')}" placeholder="${E(T('PM, Brakes, Tires…'))}"></label></div>
   <div class="cjScroll"><table class="cjTable"><thead><tr><th>${T('Type')}</th><th>${T('Description')}</th><th>${T('Part #')}</th><th>${T('Qty / hrs')}</th><th>${T('Price')}</th><th>${T('Tax')}</th><th></th></tr></thead><tbody id="cjLines">${(j.lines?.length?j.lines:[{lineType:'labor',description:'',quantity:1,unitPrice:0}]).map(lineRow).join('')}</tbody></table></div>
   <button type="button" class="secondary" data-cj="addline">+ ${T('Line')}</button>
   <label class="cjNotes">${T('Notes (shop only)')}<textarea id="cjNotes" rows="2">${E(j.notes||'')}</textarea></label>
   <div class="cjFoot">${j.id?`<button type="button" class="secondary danger" data-cj="delete">${T('Delete')}</button>`:'<span></span>'}<span><button type="button" class="secondary" data-cj="back">${T('Cancel')}</button> <button type="button" data-cj="save">${T('Save canned job')}</button></span></div></div>`}
 function readEditor(){return {name:document.getElementById('cjName').value,category:document.getElementById('cjCat').value,notes:document.getElementById('cjNotes').value,
  lines:[...document.querySelectorAll('#cjLines tr')].map(tr=>{const g=f=>tr.querySelector(`[data-f="${f}"]`);return {lineType:g('lineType').value,description:g('description').value,partNumber:g('partNumber').value,quantity:Number(g('quantity').value||0),unitPrice:Number(g('unitPrice').value||0),taxable:g('taxable').checked}}).filter(l=>l.description.trim())}}
 async function apply(j){
  try{
   if(ctx.target==='workorder'){const ta=ctx.textarea;if(!ta)return;const add=j.lines.filter(l=>l.lineType==='labor').map(l=>l.description);const lines=(add.length?add:[j.name]);ta.value=[ta.value.trim(),...lines].filter(Boolean).join('\n');ta.dispatchEvent(new Event('input',{bubbles:true}))}
   else{const base=ctx.target==='estimate'?`/api/estimates/${ctx.id}/lines`:`/api/invoices/${ctx.id}/lines`,warnings=[];
    if(ctx.target==='invoice'&&typeof persistInvoiceDraftBeforeStructureChange==='function'&&!(await persistInvoiceDraftBeforeStructureChange('Saving invoice before adding a canned job')))return;
    let parent=null;
    for(const l of [...j.lines.filter(x=>x.lineType==='labor'),...j.lines.filter(x=>x.lineType!=='labor')]){
     const unitPrice=l.currentPrice!=null?l.currentPrice:l.unitPrice;
     const d=await apiJSON(base,{method:'POST',body:JSON.stringify({lineType:l.lineType,description:l.description,partNumber:l.partNumber||'',quantity:l.quantity,unitPrice,taxable:l.taxable,inventoryPartId:l.inventoryPartId||null,jobName:j.name,...(l.lineType!=='labor'&&parent?{parentLineId:parent}:{})})});
     if(l.lineType==='labor'&&!parent)parent=d.id;(d.warnings||[]).forEach(w=>warnings.push(w))}
    if(warnings.length)showToast(warnings.map(w=>w.message||w).join(' '),'warning',9000)}
   apiJSON(`/api/canned-jobs/${j.id}/used`,{method:'POST',body:'{}'}).catch(()=>{});
   showToast(`${T('Added')}: ${j.name}`,'success');closeModal('cannedJobsModal');ctx.onDone?.();
  }catch(e){alert(e.message||T('The canned job was not added.'))}}
 document.addEventListener('click',async e=>{const b=e.target.closest('#cannedJobsModal [data-cj]');if(!b)return;const a=b.dataset.cj;
  if(a==='close')return closeModal('cannedJobsModal');
  if(a==='new'){editing={lines:[]};return render()}
  if(a==='edit'){editing=JSON.parse(JSON.stringify(items.find(x=>String(x.id)===b.dataset.id)||{}));return render()}
  if(a==='back'){editing=null;return render()}
  if(a==='use'){const j=items.find(x=>String(x.id)===b.dataset.id);if(j){b.disabled=true;await apply(j);b.disabled=false}return}
  if(a==='addline'){const tb=document.getElementById('cjLines');tb.insertAdjacentHTML('beforeend',lineRow(undefined,tb.children.length));return}
  if(a==='rmline'){b.closest('tr')?.remove();return}
  if(a==='save'){try{const body=readEditor();const d=await apiJSON(editing.id?`/api/canned-jobs/${editing.id}`:'/api/canned-jobs',{method:editing.id?'PUT':'POST',body:JSON.stringify(body)});showToast(T('Canned job saved.'),'success');editing=null;await load(ctx.q||'');render()}catch(err){alert(err.message)}return}
  if(a==='delete'){if(!confirm(T('Delete this canned job? Estimates and invoices that already used it are not changed.')))return;try{await apiJSON(`/api/canned-jobs/${editing.id}`,{method:'DELETE'});editing=null;await load(ctx.q||'');render()}catch(err){alert(err.message)}}});
 document.addEventListener('change',e=>{const s=e.target.closest('#cannedJobsModal select[data-f="lineType"]');if(s){const pn=s.closest('tr').querySelector('[data-f="partNumber"]');pn.disabled=s.value!=='part';if(pn.disabled)pn.value=''}});
 let qt=0;document.addEventListener('input',e=>{if(e.target.id!=='cjSearch')return;clearTimeout(qt);qt=setTimeout(async()=>{ctx.q=e.target.value;await load(ctx.q);const body=document.getElementById('cjBody');if(body&&!editing)body.innerHTML=listHtml()},250)});
 window.openCannedJobs=async(opts={})=>{ctx={target:'manage',...opts};editing=null;await load('');render();setTimeout(()=>document.getElementById('cjSearch')?.focus(),40)};
})();
