// ITTR ShopFlow v24.37.0 shared finance UI: tire fee dialog used by invoices and estimates.
(function(){
 const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usd=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)||0);
// v24.38.0: z-index sits above the invoice workspace (1200) and its menus (5000) — the old 700 hid the dialog.
 const css=`.tfBackdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:6000;display:flex;align-items:center;justify-content:center;padding:16px}
.tfBox{background:#fff;border-radius:16px;max-width:680px;width:100%;max-height:92dvh;overflow:auto;padding:20px 20px 16px;box-shadow:0 24px 60px rgba(15,23,42,.3)}
.tfBox h2{margin:0 0 4px;font-size:20px}.tfBox p{margin:0 0 12px;color:#64748b;font-size:13px}
.tfRow{display:grid;grid-template-columns:minmax(0,1fr) 78px auto auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px}
.tfRow.off{opacity:.55}.tfRow b{display:block;font-size:14px}.tfRow small{color:#64748b}
.tfRow input[type=number]{width:100%;padding:8px;border:1px solid #cfd6dc;border-radius:8px;font:inherit;min-height:38px}
.tfChk{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;white-space:nowrap}.tfChk input{width:18px;height:18px;min-height:auto}
.tfCust{display:flex;flex-wrap:wrap;gap:14px;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:13px}
.tfSummary{margin:12px 0;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;font-size:14px}
.tfSummary div{display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e2e8f0}.tfSummary div:last-child{border-bottom:0;font-weight:800}
.tfHint{font-size:12px;color:#b54708;background:#fffaeb;border:1px solid #fedf89;border-radius:9px;padding:8px 10px;margin-bottom:12px}
.tfActions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
@media(max-width:560px){.tfRow{grid-template-columns:1fr 70px}.tfRow .tfChk{grid-column:span 1}}`;
 function ensureStyle(){let s=document.getElementById('finance-shared-style');if(!s){s=document.createElement('style');s.id='finance-shared-style';document.head.appendChild(s)}s.textContent=css}
 // One dialog for invoices and estimates: each tire part line gets its own user fee + disposal fee, placed right under it.
 window.openTireFeeDialog=async function({kind='invoice',id,onDone}={}){
  ensureStyle();const base=`/api/${kind==='estimate'?'estimates':'invoices'}/${encodeURIComponent(id)}/tire-fees`;
  let ctx;try{ctx=await apiJSON(base)}catch(e){showToast?.(e.message,'error');return}
  if(ctx.locked)return showToast?.('This document is locked — tire fees can no longer change.','error');
  const st=ctx.settings,exempt=!!ctx.customer?.disposalExempt;
  let parts=ctx.parts.filter(p=>p.isTire||p.hasFees);const guessed=!parts.length;if(guessed)parts=ctx.parts;
  if(!parts.length)return showToast?.('Add the tire as a part line first, then press Tire Fees.','error',7000);
  const rows=parts.map(p=>({...p,on:p.hasFees||p.isTire,qty:p.hasFees?Math.max(p.userQty,p.disposalQty):Math.max(1,Math.round(p.quantity)),user:p.hasFees?p.userQty>0:true,disp:p.hasFees?p.disposalQty>0:!exempt}));
  const wrap=document.createElement('div');wrap.className='tfBackdrop';
  const draw=()=>{let u=0,d=0;for(const r of rows)if(r.on){if(r.user)u+=r.qty;if(r.disp)d+=r.qty}
   wrap.innerHTML=`<div class="tfBox" role="dialog" aria-modal="true" aria-label="Tire fees"><h2>Tire fees</h2><p>Fees are added right under each tire line. Turn off the disposal fee when the customer keeps their old tires.</p>
   ${guessed?'<div class="tfHint">No tire lines were recognized, so every part is listed. Tick only the tires.</div>':''}
   ${ctx.legacyFeeLines?'<div class="tfHint">This document has older tire fee lines at the bottom. Apply replaces them with fees under each tire, so nothing is charged twice.</div>':''}
   <div class="tfCust"><b>${h(ctx.customer?.name||'Customer')}</b><label class="tfChk"><input type="checkbox" data-tf="noDisp" ${rows.every(r=>!r.on||!r.disp)?'checked':''}> Customer keeps old tires — no disposal fee</label>${ctx.customer?`<label class="tfChk"><input type="checkbox" data-tf="remember" ${exempt?'checked':''}> Remember for this customer</label>`:''}</div>
   ${rows.map((r,i)=>`<div class="tfRow ${r.on?'':'off'}"><label class="tfChk" style="white-space:normal"><input type="checkbox" data-tf="on" data-i="${i}" ${r.on?'checked':''}><span><b>${h(r.description||'Part')}</b><small>${h(r.partNumber||'')} · ${r.quantity} on invoice</small></span></label>
     <input type="number" min="0" max="500" step="1" data-tf="qty" data-i="${i}" value="${r.qty}" aria-label="Tires" title="Number of tires" ${r.on?'':'disabled'}>
     <label class="tfChk"><input type="checkbox" data-tf="user" data-i="${i}" ${r.user?'checked':''} ${r.on?'':'disabled'}> User fee</label>
     <label class="tfChk"><input type="checkbox" data-tf="disp" data-i="${i}" ${r.disp?'checked':''} ${r.on?'':'disabled'}> Disposal</label></div>`).join('')}
   <div class="tfSummary"><div><span>${h(st.userFeeLabel)} · ${u} × ${usd(st.userFee)}</span><b>${usd(u*st.userFee)}</b></div><div><span>${h(st.disposalLabel)} · ${d} × ${usd(st.disposalFee)}</span><b>${usd(d*st.disposalFee)}</b></div><div><span>Total tire fees</span><span>${usd(u*st.userFee+d*st.disposalFee)}</span></div></div>
   <div class="tfActions"><button class="secondary" data-tf="cancel">Cancel</button><button data-tf="save">Apply</button></div></div>`};
  draw();document.body.appendChild(wrap);
  const close=()=>{wrap.remove();document.removeEventListener('keydown',esc,true)};const esc=e=>{if(e.key==='Escape'){e.stopPropagation();close()}};document.addEventListener('keydown',esc,true);
  wrap.addEventListener('change',e=>{const t=e.target,i=Number(t.dataset.i),k=t.dataset.tf;
   if(k==='on')rows[i].on=t.checked;else if(k==='qty')rows[i].qty=Math.max(0,Math.floor(Number(t.value)||0));else if(k==='user')rows[i].user=t.checked;else if(k==='disp')rows[i].disp=t.checked;
   else if(k==='noDisp')rows.forEach(r=>r.disp=!t.checked);else if(k==='remember'){wrap.dataset.remember=t.checked?'1':'0';return}else return;
   const rem=wrap.querySelector('[data-tf="remember"]')?.checked;draw();const rb=wrap.querySelector('[data-tf="remember"]');if(rb)rb.checked=rem});
  wrap.addEventListener('click',async e=>{const k=e.target.dataset?.tf;if(e.target===wrap||k==='cancel')return close();if(k!=='save')return;
   const noDisp=wrap.querySelector('[data-tf="noDisp"]')?.checked,remember=wrap.querySelector('[data-tf="remember"]');
   const items=rows.map(r=>({partLineId:r.id,quantity:r.on?r.qty:0,userFee:r.user,disposalFee:r.disp})).filter(it=>it.quantity>0||parts.find(p=>p.id===it.partLineId)?.hasFees);
   e.target.disabled=true;
   try{await apiJSON(base,{method:'POST',body:{items,...(remember?{rememberDisposalExempt:remember.checked?!!noDisp:false}:{})}});close();showToast?.('Tire fees updated.','success');await onDone?.()}
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
