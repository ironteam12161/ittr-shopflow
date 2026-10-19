/* v24.54.0: customer page for /c/<token>: estimate approval, inspection report with photos, fleet portal.
   Everything shown comes from /api/public/link/<token>; text is always inserted escaped. */
(function(){
 const token=(location.pathname.match(/^\/c\/([A-Za-z0-9_-]{30,80})/)||[])[1]||'';
 const app=document.getElementById('app');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usd=n=>`$${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const day=d=>{if(!d)return'';const x=new Date(String(d).length===10?`${d}T12:00:00`:d);return isNaN(x)?'':x.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})};
 let V=null;const pick={};
 const shopHead=s=>`<header class="shop"><img src="/assets/iron-team-logo.png" alt=""><div><b>${esc(s.name)}</b><span>${esc(s.phone)}${s.address?` · ${esc(s.address)}`:''}</span></div></header>`;
 const foot=s=>`<footer>Questions? Call ${esc(s.phone)}${s.email?` or email ${esc(s.email)}`:''}.<br>This private link is for you only. Please don't forward it.</footer>`;
 const tag=d=>d==='approved'?'<span class="tag ok">Approved</span>':d==='declined'?'<span class="tag no">Declined</span>':'<span class="tag wait">Waiting for you</span>';
 function choice(key,cur){return `<div class="choice" role="group" aria-label="Approve or decline"><button type="button" class="yes" data-k="${esc(key)}" data-v="approve" aria-pressed="${cur==='approve'}">✓ Approve</button><button type="button" class="no" data-k="${esc(key)}" data-v="decline" aria-pressed="${cur==='decline'}">✕ Decline</button></div>`}
 function signBox(label){return `<div class="card"><h2>Sign</h2>
  <label class="f">Your full name<input type="text" id="signName" autocomplete="name" maxlength="80" placeholder="First and last name"></label>
  <label class="f">Note for the shop (optional)<textarea id="signNote" rows="2" maxlength="1000"></textarea></label>
  <label class="agree"><input type="checkbox" id="signAgree"><span>${esc(label)}</span></label>
  <div class="err" id="err" role="alert"></div><button type="button" class="submit" id="submitBtn">Send my answer</button></div>`}
 function renderEstimate(){const e=V.estimate,can=V.canDecide;
  const approvedSum=V.jobs.reduce((a,j)=>a+((can?pick[j.key]==='approve':j.decision==='approved')?j.total:0),0);
  app.innerHTML=`${shopHead(V.shop)}
  <div class="card"><h1>Estimate ${esc(e.number)}</h1><div class="meta"><span>${esc(e.customer)}</span>${e.unit?`<span>Unit ${esc(e.unit)}</span>`:''}${e.vin?`<span>VIN ${esc(e.vin)}</span>`:''}${e.mileage?`<span>${Number(e.mileage).toLocaleString('en-US')} mi</span>`:''}<span>${esc(day(e.date))}</span>${e.validUntil?`<span>Valid until ${esc(day(e.validUntil))}</span>`:''}</div>
  ${e.note?`<div class="muted">${esc(e.note)}</div>`:''}
  ${can?'<div class="muted">Choose <b>Approve</b> or <b>Decline</b> for each job, then sign at the bottom. Declined jobs will not be done or charged.</div>':e.signedName?`<div class="muted">Answered by <b>${esc(e.signedName)}</b> on ${esc(day(e.decidedAt))}. Call the shop to change anything.</div>`:V.expired?'<div class="err">This estimate has expired. Please call the shop for an updated one.</div>':`<div class="muted">Status: ${esc(e.status)}.</div>`}</div>
  ${V.jobs.map(j=>{const st=can?(pick[j.key]==='approve'?'approved':pick[j.key]==='decline'?'declined':''):j.decision||'';
   return `<div class="job ${st}"><div class="jobHead"><b>${esc(j.name)}</b><span class="amt">${usd(j.total)}</span></div>
   <ul class="lines">${j.lines.map(l=>`<li><span>${esc(l.description)}${l.type==='labor'?` · ${l.quantity} hr`:l.unit?` · ${l.quantity} ${l.unit==='qt'?(l.quantity===1?'qt':'qts'):'gal'}`:l.quantity!==1?` × ${l.quantity}`:''}</span><span>${usd(l.total)}</span></li>`).join('')}</ul>
   ${can?choice(j.key,pick[j.key]):tag(j.decision)}</div>`}).join('')}
  ${V.other.length?`<div class="job"><div class="jobHead"><b>Other charges</b><span class="amt">${usd(V.otherTotal)}</span></div><ul class="lines">${V.other.map(l=>`<li><span>${esc(l.description)}</span><span>${usd(l.total)}</span></li>`).join('')}</ul></div>`:''}
  <div class="card totals"><div><span>Estimate subtotal</span><span class="amt">${usd(e.subtotal)}</span></div>${e.discount?`<div><span>Discount</span><span class="amt">−${usd(e.discount)}</span></div>`:''}${e.shopSupplies?`<div><span>Shop supplies</span><span class="amt">${usd(e.shopSupplies)}</span></div>`:''}${e.environmentalFee?`<div><span>Environmental fee</span><span class="amt">${usd(e.environmentalFee)}</span></div>`:''}${e.tax?`<div><span>Tax</span><span class="amt">${usd(e.tax)}</span></div>`:''}
   <div class="big"><span>Estimate total</span><span class="amt">${usd(e.total)}</span></div>${V.jobs.length?`<div><span>Jobs you approve${can?'':'d'}</span><span class="amt">${usd(approvedSum)}</span></div><div class="muted">Tax and fees are figured on the final invoice for the approved work only.</div>`:''}</div>
  ${can?signBox('I authorize the approved work at the prices shown and agree to the shop\'s repair terms. Final amounts can change only with my approval.'):''}${foot(V.shop)}`}
 function renderInspection(){const v=V.vehicle,i=V.inspection,can=V.canDecide;
  app.innerHTML=`${shopHead(V.shop)}
  <div class="card"><h1>Inspection report</h1><div class="meta">${v.unit?`<span>Unit ${esc(v.unit)}</span>`:''}${v.description?`<span>${esc(v.description)}</span>`:''}${v.vin?`<span>VIN ${esc(v.vin)}</span>`:''}${v.date?`<span>${esc(day(v.date))}</span>`:''}</div>
  <div class="muted">${i.okCount} item${i.okCount===1?'':'s'} passed${i.flagged.length?` · ${i.flagged.length} need attention`:''}.</div></div>
  ${V.findings.length?`<div class="card"><h2>Recommended repairs</h2>${can?'<div class="muted">Approve the repairs you want done. Anything you decline will not be done or charged.</div>':''}</div>`:''}
  ${V.findings.map(f=>{const st=f.canDecide?(pick[f.id]==='approve'?'approved':pick[f.id]==='decline'?'declined':''):f.decision;
   return `<div class="job ${st}"><div class="jobHead"><b>${esc(f.title||'Repair')}</b>${f.severity?`<span class="tag wait">${esc(f.severity)}</span>`:''}</div>${f.detail?`<div class="muted">${esc(f.detail)}</div>`:''}
   ${f.photos.length?`<div class="photos">${f.photos.map((u,n)=>`<button type="button" class="photoBtn" data-photo-finding="${esc(f.id)}" data-photo-index="${n}" aria-label="Open photo ${n+1} of ${f.photos.length}: ${esc(f.title||'Repair')}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join('')}</div>`:''}
   ${f.canDecide?choice(f.id,pick[f.id]):tag(f.decision)}</div>`}).join('')}
  ${i.flagged.length?`<div class="card"><h2>Inspection notes</h2>${i.flagged.map(x=>`<div class="flag"><b>${esc(x.label)}</b>${x.note?`<span class="muted">${esc(x.note)}</span>`:''}</div>`).join('')}</div>`:''}
  ${can?signBox('I authorize the approved repairs. The shop will call me before doing anything else.'):''}${foot(V.shop)}`}
 const PTAB={tab:'invoices'};
 function renderPortal(){const open=V.invoices.filter(i=>i.balance>0.004),waiting=V.estimates.filter(e=>e.canApprove);
  const tabs=[['invoices',`Invoices${open.length?` (${open.length} open)`:''}`],['estimates',`Estimates${waiting.length?` (${waiting.length} to answer)`:''}`],['units',`Units (${V.units.length})`]];
  const st=s=>s==='paid'?'<span class="tag ok">Paid</span>':s==='approved'?'<span class="tag ok">Approved</span>':s==='declined'?'<span class="tag no">Declined</span>':s==='sent'?'<span class="tag wait">Waiting for you</span>':`<span class="tag wait">${esc(s)}</span>`;
  const body=PTAB.tab==='invoices'?(V.invoices.length?V.invoices.map(i=>`<div class="job"><div class="jobHead"><b>Invoice ${esc(i.number)}</b><span class="amt">${usd(i.total)}</span></div>
     <div class="meta">${i.unit?`<span>Unit ${esc(i.unit)}</span>`:''}<span>${esc(day(i.date))}</span>${i.balance>0.004?`<span>Balance <b>${usd(i.balance)}</b></span>`:''}${i.overdueDays?`<span class="err">${i.overdueDays} days overdue</span>`:i.dueDate&&i.balance>0.004?`<span>Due ${esc(day(i.dueDate))}</span>`:''}</div>
     <div class="choice" style="grid-template-columns:${i.payUrl?'1fr 1fr':'1fr'}"><button type="button" data-pdf="${i.id}">View PDF</button>${i.payUrl?`<button type="button" class="yes" aria-pressed="true" data-pay="${esc(i.payUrl)}">Pay online</button>`:''}</div>${i.status==='paid'?st('paid'):''}</div>`).join(''):'<div class="card muted">No invoices yet.</div>')
   :PTAB.tab==='estimates'?(V.estimates.length?V.estimates.map(e=>`<div class="job"><div class="jobHead"><b>Estimate ${esc(e.number)}</b><span class="amt">${usd(e.total)}</span></div><div class="meta">${e.unit?`<span>Unit ${esc(e.unit)}</span>`:''}<span>${esc(day(e.date))}</span></div>
     ${e.canApprove?`<button type="button" class="submit" data-est="${e.id}">Review &amp; approve</button>`:st(e.status)}</div>`).join(''):'<div class="card muted">No estimates.</div>')
   :(V.units.length?`<div class="card">${V.units.map(u=>`<div class="flag"><b>Unit ${esc(u.unit)}</b><span class="muted">${esc([u.description,u.vin?`VIN ${u.vin}`:''].filter(Boolean).join(' · '))}</span><span class="muted">${u.lastService?`Last service ${esc(day(u.lastService))}`:'No service on record yet'}</span></div>`).join('')}</div>`:'<div class="card muted">No units on file.</div>');
  app.innerHTML=`${shopHead(V.shop)}<div class="card"><h1>${esc(V.customer.name)}</h1><div class="totals"><div><span>You owe</span><span class="amt">${usd(V.owed)}</span></div>${V.overdue?`<div class="err"><span>Overdue</span><span class="amt">${usd(V.overdue)}</span></div>`:''}</div></div>
   <div class="choice" style="grid-template-columns:repeat(3,1fr)">${tabs.map(([k,l])=>`<button type="button" data-tab="${k}" aria-pressed="${PTAB.tab===k}" class="${PTAB.tab===k?'yes':''}">${esc(l)}</button>`).join('')}</div>
   ${body}${foot(V.shop)}`}
 app.addEventListener('click',async e=>{if(!V||V.kind!=='portal')return;const t=e.target.closest('[data-tab]');if(t){PTAB.tab=t.dataset.tab;render();return}
  const pay=e.target.closest('[data-pay]');if(pay){location.href=pay.dataset.pay;return}
  const pdf=e.target.closest('[data-pdf]');if(pdf){window.open(`/api/public/link/${token}/invoice/${pdf.dataset.pdf}/pdf`,'_blank','noopener');return}
  const es=e.target.closest('[data-est]');if(es){es.disabled=true;try{const r=await fetch(`/api/public/link/${token}/estimate/${es.dataset.est}/open`,{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error);location.href=d.url}catch(x){alert(x.message||'Could not open the estimate.');es.disabled=false}}});
 // v24.74.0: choosing Approve/Decline redraws the page; the typed name, note, tick box and the focused button are kept.
 function draftOf(){const g=id=>document.getElementById(id),a=document.activeElement;
  return {name:g('signName')?.value,note:g('signNote')?.value,agree:g('signAgree')?.checked,
   focus:a&&a!==document.body&&app.contains(a)?(a.id?`#${CSS.escape(a.id)}`:a.dataset?.k!=null?`[data-k="${CSS.escape(a.dataset.k)}"][data-v="${CSS.escape(a.dataset.v||'')}"]`:a.dataset?.tab?`[data-tab="${CSS.escape(a.dataset.tab)}"]`:''):''}}
 function restoreDraft(d){const g=id=>document.getElementById(id);
  if(d.name!=null&&g('signName'))g('signName').value=d.name;if(d.note!=null&&g('signNote'))g('signNote').value=d.note;if(d.agree!=null&&g('signAgree'))g('signAgree').checked=d.agree;
  if(d.focus){const f=app.querySelector(d.focus);if(f)try{f.focus({preventScroll:true})}catch{}}}
 function openPhotos(btn){
  const f=(V?.findings||[]).find(x=>String(x.id)===btn.dataset.photoFinding);if(!f||!f.photos?.length)return;
  const fid=btn.dataset.photoFinding,idx=Number(btn.dataset.photoIndex)||0;
  const items=f.photos.map((u,n)=>({id:`${fid}-${n}`,load:async()=>u,caption:f.title||'',meta:{finding:f.title||''},marks:[],editable:false}));
  const opener=()=>app.querySelector(`[data-photo-finding="${CSS.escape(fid)}"][data-photo-index="${idx}"]`);
  if(window.ITTRPhotoViewer)window.ITTRPhotoViewer.open({items,index:idx,opener});
  else window.open(f.photos[idx],'_blank','noopener');
 }
 function render(){if(!V)return;const d=draftOf();V.kind==='estimate'?renderEstimate():V.kind==='inspection'?renderInspection():renderPortal();restoreDraft(d)}
 function done(msg){app.innerHTML=`${shopHead(V.shop)}<div class="card done"><div class="big" aria-hidden="true">✓</div><h1>Thank you</h1><p>${esc(msg)}</p><p class="muted">The shop got your answer right away. You can close this page.</p></div>${foot(V.shop)}`}
 app.addEventListener('click',async e=>{
  // v24.76.0: photos open in the shop's accessible viewer (dialog with Close, Escape, zoom, keyboard, focus back on
  // the thumbnail). Before, thumbnails were plain images and the overlay could only be closed with a mouse/tap.
  const pb=e.target.closest('[data-photo-finding]');if(pb){openPhotos(pb);return}
  const b=e.target.closest('.choice button');if(b){pick[b.dataset.k]=b.dataset.v;const y=window.scrollY;render();window.scrollTo(0,y);return}
  if(e.target.id!=='submitBtn')return;
  const err=document.getElementById('err'),btn=e.target,name=document.getElementById('signName').value.trim(),agree=document.getElementById('signAgree').checked,note=document.getElementById('signNote').value.trim();
  const body=V.kind==='estimate'?{jobs:pick}:{findings:pick};
  if(V.kind==='estimate'){const left=V.jobs.filter(j=>!pick[j.key]);if(left.length){err.textContent=`Choose Approve or Decline for: ${left.map(j=>j.name).join(', ')}.`;return}}
  else if(!Object.keys(pick).length){err.textContent='Choose Approve or Decline for at least one repair.';return}
  if(name.length<2){err.textContent='Type your full name to sign.';return}if(!agree){err.textContent='Tick the box to authorize the work.';return}
  btn.disabled=true;btn.textContent='Sending…';err.textContent='';
  try{const r=await fetch(`/api/public/link/${token}/decide`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,name,note,agree})});const d=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(d.error||'Your answer was not sent. Please try again or call the shop.');
   if(V.kind==='inspection'&&d.partial){partialDone(d);return}
   done(V.kind==='estimate'?(d.approved?`You approved ${d.approved} of ${d.of} job${d.of===1?'':'s'}.`:'You declined the estimate.'):`You approved ${d.approved} of ${d.of} repair${d.of===1?'':'s'}.`)}
  catch(x){err.textContent=x.message;btn.disabled=false;btn.textContent='Send my answer'}});
 // v24.74.0: some repairs were recorded and some were not (the shop changed them meanwhile): say which, per repair.
 function partialDone(d){const name=id=>(V.findings.find(f=>String(f.id)===String(id))||{}).title||'Repair';
  const row=r=>`<li><b>${esc(name(r.id))}</b> — ${r.ok?(r.decision==='approve'?'approved':'declined'):`<span class="err">not recorded${r.error?`: ${esc(r.error)}`:''}</span>`}</li>`;
  app.innerHTML=`${shopHead(V.shop)}<div class="card done" id="partialResult"><h1>Part of your answer was recorded</h1><p>${d.recorded} of ${d.of} repair${d.of===1?'':'s'} recorded. Please call the shop about the rest.</p><ul class="lines">${(d.results||[]).map(row).join('')}</ul></div>${foot(V.shop)}`}
 (async()=>{try{if(!token)throw new Error('This link is not complete. Please open the full link from your message.');
  const r=await fetch(`/api/public/link/${token}`),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'This page could not be opened.');V=d;
  document.title=`${d.shop.name} — ${d.kind==='estimate'?`Estimate ${d.estimate.number}`:d.kind==='inspection'?'Inspection report':'Customer portal'}`;render()}
  catch(x){app.innerHTML=`<div class="card"><h1>Link not available</h1><p>${esc(x.message)}</p></div>`}})();
 window.ITTRCustomerPage={reload:async()=>{const r=await fetch(`/api/public/link/${token}`);V=await r.json();render()},token:()=>token};
})();
