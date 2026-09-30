// ITTR ShopFlow v24.37.0 shared finance UI: tire fee dialog used by invoices and estimates.
(function(){
 const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usd=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)||0);
 const css=`.tfBackdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:700;display:flex;align-items:center;justify-content:center;padding:16px}
.tfBox{background:#fff;border-radius:16px;max-width:460px;width:100%;padding:20px 20px 16px;box-shadow:0 24px 60px rgba(15,23,42,.3)}
.tfBox h2{margin:0 0 4px;font-size:20px}.tfBox p{margin:0 0 14px;color:#64748b;font-size:13px}
.tfGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.tfGrid label{display:block;font-size:12px;font-weight:800;color:#475467;margin-bottom:5px}
.tfGrid input{width:100%;padding:10px;border:1px solid #cfd6dc;border-radius:9px;font:inherit}
.tfSummary{margin:14px 0;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;font-size:14px}
.tfSummary div{display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e2e8f0}.tfSummary div:last-child{border-bottom:0;font-weight:800}
.tfHint{font-size:12px;color:#b54708;background:#fffaeb;border:1px solid #fedf89;border-radius:9px;padding:8px 10px;margin-bottom:12px}
.tfActions{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:520px){.tfGrid{grid-template-columns:1fr}}`;
 function ensureStyle(){if(!document.getElementById('finance-shared-style')){const s=document.createElement('style');s.id='finance-shared-style';s.textContent=css;document.head.appendChild(s)}}
 const TIRE_WORDS=/\btires?\b|\b\d{3}\/\d{2}r\d{2}(\.\d)?\b|\b11r22\.5\b|\b11r24\.5\b/i,NOT_TIRE=/tube|valve|chain|gauge|iron|patch|plug|repair kit|sealant|balanc|rotation|mount(ing)? fee|user fee|disposal/i;
 function currentCounts(lines){
  const fee=code=>Number((lines||[]).find(l=>l?.metadata?.feeCode===code)?.quantity||0);
  const u=fee('tire_user_fee'),d=fee('tire_disposal_fee');
  if(u||d)return {newTires:u,other:Math.max(0,d-u),detected:false};
  const n=(lines||[]).filter(l=>l.line_type==='part'&&TIRE_WORDS.test(`${l.description||''} ${l.part_number||''}`)&&!NOT_TIRE.test(l.description||'')).reduce((a,l)=>a+Math.max(0,Math.round(Number(l.quantity||0))),0);
  return {newTires:n,other:0,detected:n>0};
 }
 window.openTireFeeDialog=async function({kind='invoice',id,lines=[],onDone}={}){
  ensureStyle();
  let settings;try{settings=(await apiJSON('/api/finance/settings')).tireFees}catch(e){showToast?.(e.message,'error');return}
  const start=currentCounts(lines),wrap=document.createElement('div');wrap.className='tfBackdrop';
  wrap.innerHTML=`<div class="tfBox" role="dialog" aria-modal="true" aria-label="Tire fees"><h2>Tire fees</h2><p>Every new tire sold gets the ${h(settings.userFeeLabel)} and the ${h(settings.disposalLabel)}. Tires you only dispose of get the disposal fee.</p>
   ${start.detected?`<div class="tfHint">Found ${start.newTires} tire${start.newTires===1?'':'s'} in the part lines — please confirm.</div>`:''}
   <div class="tfGrid"><div><label for="tfNew">New tires sold</label><input id="tfNew" type="number" min="0" max="500" step="1" inputmode="numeric" value="${start.newTires}"></div>
   <div><label for="tfOther">Other tires disposed</label><input id="tfOther" type="number" min="0" max="500" step="1" inputmode="numeric" value="${start.other}"></div></div>
   <div class="tfSummary" id="tfSummary"></div>
   <div class="tfActions"><button class="secondary" data-tf="cancel">Cancel</button><button data-tf="save">Apply to ${kind==='estimate'?'estimate':'invoice'}</button></div></div>`;
  document.body.appendChild(wrap);
  const nEl=wrap.querySelector('#tfNew'),oEl=wrap.querySelector('#tfOther'),sum=wrap.querySelector('#tfSummary');
  const counts=()=>({n:Math.max(0,Math.floor(Number(nEl.value)||0)),o:Math.max(0,Math.floor(Number(oEl.value)||0))});
  const draw=()=>{const {n,o}=counts(),u=n*settings.userFee,d=(n+o)*settings.disposalFee;sum.innerHTML=`<div><span>${h(settings.userFeeLabel)} · ${n} × ${usd(settings.userFee)}</span><b>${usd(u)}</b></div><div><span>${h(settings.disposalLabel)} · ${n+o} × ${usd(settings.disposalFee)}</span><b>${usd(d)}</b></div><div><span>Total tire fees</span><span>${usd(u+d)}</span></div>`};
  draw();nEl.addEventListener('input',draw);oEl.addEventListener('input',draw);nEl.focus();nEl.select();
  const close=()=>wrap.remove();
  wrap.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
  wrap.addEventListener('click',async e=>{if(e.target===wrap||e.target.dataset.tf==='cancel')return close();if(e.target.dataset.tf!=='save')return;
   const {n,o}=counts();e.target.disabled=true;
   try{await apiJSON(`/api/${kind==='estimate'?'estimates':'invoices'}/${encodeURIComponent(id)}/tire-fees`,{method:'POST',body:{newTires:n,otherDisposed:o}});close();showToast?.(n||o?'Tire fees updated.':'Tire fees removed.','success');await onDone?.()}
   catch(err){e.target.disabled=false;showToast?.(err.message,'error')}});
 };
 window.ittrFinanceFormat={h,usd};
 // Google sends the owner back to /?gmail=connected|error after the Gmail consent screen.
 try{
  const u=new URL(location.href),g=u.searchParams.get('gmail');
  if(g){const msg=u.searchParams.get('gmailMessage')||'';u.searchParams.delete('gmail');u.searchParams.delete('gmailMessage');history.replaceState(history.state,'',u.pathname+(u.search||'')+u.hash);
   sessionStorage.setItem('ittr_reports_tab','inbox');let tries=0;
   const go=()=>{if(++tries>60)return;let ready=false;try{ready=!!session&&typeof showView==='function'}catch(_){}if(!ready)return setTimeout(go,250);
    showToast?.(g==='connected'?`Gmail connected${msg?`: ${msg}`:''}. Click “Check email now”.`:`Gmail was not connected. ${msg}`,g==='connected'?'success':'error',9000);setTimeout(()=>showView('reports'),400)};
   go()}
 }catch(_){}
})();
