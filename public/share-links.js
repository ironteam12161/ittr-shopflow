/* v24.54.0: shop side of customer links. shareCustomerLink({kind:'estimate'|'inspection', refId, title, phone})
   creates a private link for the customer and shows it with Copy, Text (when texting is set up) and the
   earlier links for the same estimate / work order (opened how often, signed by, turn off). */
(function(){
 const E=s=>typeof esc==='function'?esc(s):String(s??''),T=s=>typeof tr==='function'?tr(s):s;
 const when=d=>d?new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
 let ctx={};
 function modal(){let m=document.getElementById('shareLinkModal');if(!m){m=document.createElement('div');m.className='modal';m.id='shareLinkModal';document.body.appendChild(m)}return m}
 async function history(){const box=document.getElementById('shareLinkHistory');if(!box)return;try{const d=await apiJSON(`/api/customer-links?kind=${ctx.kind}&refId=${encodeURIComponent(ctx.refId)}`);
  box.innerHTML=d.items.length?`<table class="shareTbl"><thead><tr><th>${T('Sent')}</th><th>${T('Opened')}</th><th>${T('Answer')}</th><th></th></tr></thead><tbody>${d.items.map(l=>{const dead=l.revoked_at||new Date(l.expires_at)<new Date();
   return `<tr class="${dead?'dead':''}"><td>${E(when(l.created_at))}<div class="muted">${E(l.created_by)}</div></td><td>${l.view_count?`${l.view_count}× · ${E(when(l.last_viewed_at))}`:`<span class="muted">${T('not yet')}</span>`}</td><td>${l.decided_at?`✓ ${E(l.signed_name||'')}<div class="muted">${E(when(l.decided_at))}</div>`:'—'}</td><td>${dead?`<span class="muted">${l.revoked_at?T('turned off'):T('expired')}</span>`:`<button type="button" class="secondary" data-share="revoke" data-id="${Number(l.id)}">${T('Turn off')}</button>`}</td></tr>`}).join('')}</tbody></table>`:`<div class="muted">${T('No links sent yet.')}</div>`}catch(e){box.textContent=e.message}}
 async function create(){const out=document.getElementById('shareLinkOut');out.innerHTML=`<div class="muted">${T('Creating link…')}</div>`;
  try{const d=await apiJSON('/api/customer-links',{method:'POST',body:JSON.stringify({kind:ctx.kind,refId:ctx.refId,days:Number(document.getElementById('shareDays')?.value||14)})});
   out.innerHTML=`<label class="shareUrl">${T('Private link for the customer')}<input id="shareUrlInput" readonly value="${E(d.url)}"></label>
    <div class="shareActs"><button type="button" data-share="copy">${T('Copy link')}</button>${window.ITTR_SMS?.enabled?`<button type="button" class="secondary" data-share="text">${T('Text to customer')}</button>`:''}<a class="button secondary" href="${E(d.url)}" target="_blank" rel="noopener noreferrer">${T('Preview')}</a></div>
    <div class="muted" style="font-size:12px">${T('Works until')} ${E(when(d.expiresAt))}. ${T('Anyone with this link can see this page, so send it only to the customer.')}</div>`;
   ctx.url=d.url;try{await navigator.clipboard.writeText(d.url);showToast(T('Link copied. Paste it in a text or email to the customer.'),'success')}catch(_){}
   history();ctx.onDone?.()}catch(e){out.innerHTML=`<div class="err">${E(e.message)}</div>`}}
 document.addEventListener('click',async e=>{const b=e.target.closest('#shareLinkModal [data-share]');if(!b)return;const a=b.dataset.share;
  if(a==='close')return closeModal('shareLinkModal');
  if(a==='create')return create();
  if(a==='copy'){const i=document.getElementById('shareUrlInput');try{await navigator.clipboard.writeText(i.value);showToast(T('Copied.'),'success')}catch(_){i.select()}return}
  if(a==='text')return window.ITTR_SMS?.compose?.({phone:ctx.phone,customerId:ctx.customerId,body:`${ctx.title}: ${ctx.url}`});
  if(a==='revoke'){if(!confirm(T('Turn off this link? The customer will no longer be able to open it.')))return;try{await apiJSON(`/api/customer-links/${b.dataset.id}`,{method:'DELETE'});history()}catch(err){alert(err.message)}}});
 window.shareCustomerLink=(opts={})=>{ctx={...opts};const m=modal();
  const portal=ctx.kind==='portal';
  const what=portal?T('The customer sees their units, estimates and invoices, approves estimates and pays online. One link for the whole account; turn it off any time.'):ctx.kind==='estimate'?T('The customer sees the estimate, approves or declines each job and signs. Declined jobs are left off the invoice.'):T('The customer sees the inspection results and photos and approves or declines each recommended repair. Their answer updates the work order right away.');
  m.innerHTML=`<div class="modalbox" style="max-width:600px"><div class="modalhead"><h2>${E(portal?T('Customer portal link'):ctx.kind==='estimate'?T('Send estimate for approval'):T('Send inspection to customer'))}</h2><button class="x" type="button" data-share="close">×</button></div>
   <p class="muted" style="margin-top:0">${E(what)}</p>
   <div class="shareActs"><label>${T('Link works for')} <select id="shareDays">${(portal?[[30,0],[90,0],[180,1],[365,0]]:[[3,0],[7,0],[14,1],[30,0]]).map(([d,on])=>`<option value="${d}" ${on?'selected':''}>${d} ${T('days')}</option>`).join('')}</select></label><button type="button" data-share="create">${T('Create link')}</button></div>
   <div id="shareLinkOut" style="margin:12px 0"></div><h3 style="margin:14px 0 6px;font-size:15px">${T('Links sent')}</h3><div id="shareLinkHistory"></div></div>`;
  m.classList.add('open');history()};
 // A customer answered: tell everyone in the shop right away (arrives over the live connection).
 window.addEventListener('ittr:customer-decision',e=>{const d=e.detail||{};const txt=d.kind==='estimate'?`${d.label}: ${d.name} ${d.approved?`${T('approved')} ${d.approved}/${d.of} ${T('jobs')}`:T('declined')}`:`${d.label}: ${d.name} ${T('approved')} ${d.approved}/${d.of} ${T('repairs')}`;showToast(`🔔 ${txt}`,d.approved?'success':'warning',12000)});
})();
