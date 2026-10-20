/* v24.55.0: texting with customers. ITTR_SMS.inbox() lists conversations; ITTR_SMS.compose({phone,customerId,body})
   opens one conversation with the message box ready. Hidden when Twilio is not set up. */
(function(){
 const E=s=>typeof esc==='function'?esc(s):String(s??''),T=s=>typeof tr==='function'?tr(s):s;
 const when=d=>new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
 const fmt=p=>{const d=String(p||'').replace(/\D/g,'');return d.length===11&&d[0]==='1'?`(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`:p};
 const S=window.ITTR_SMS={enabled:false,unread:0};let cur=null,gen=0;
 function modal(){let m=document.getElementById('smsModal');if(!m){m=document.createElement('div');m.className='modal';m.id='smsModal';document.body.appendChild(m)}return m}
 function badge(){const b=document.getElementById('smsUnread'),btn=document.getElementById('smsNavBtn');if(btn)btn.classList.toggle('hidden',!S.enabled);if(b){b.textContent=S.unread;b.classList.toggle('hidden',!S.unread)}}
 async function refresh(){try{const d=await apiJSON('/api/sms/config');S.enabled=d.enabled;S.unread=d.unread||0;S.missing=d.missing||[]}catch(_){S.enabled=false}badge()}
 S.inbox=async()=>{const m=modal();cur=null;gen++;let items=[];try{items=(await apiJSON('/api/sms/threads')).items||[]}catch(e){return alert(e.message)}
  m.innerHTML=`<div class="modalbox" style="max-width:620px"><div class="modalhead"><h2>${T('Text messages')}</h2><button class="x" type="button" data-sms="close">×</button></div>
   <div class="shareActs" style="margin-bottom:10px"><input id="smsNewPhone" placeholder="${E(T('New text: mobile number'))}" inputmode="tel" style="flex:1 1 200px"><button type="button" data-sms="new">${T('Open')}</button></div>
   <div class="smsThreads">${items.length?items.map(t=>`<button type="button" class="smsThread" data-sms="open" data-phone="${E(t.phone)}"><span><b>${E(t.customer_name||fmt(t.phone))}${t.opted_out?` <span class="muted">· ${T('opted out')}</span>`:''}</b><span class="muted">${t.direction==='out'?T('You')+': ':''}${E(t.body)}</span></span><span style="text-align:right"><span class="muted" style="font-size:11px">${E(when(t.created_at))}</span>${t.unread?`<br><span class="smsUnread">${t.unread}</span>`:''}</span></button>`).join(''):`<div class="muted">${T('No texts yet. Text a customer from their profile, an estimate or an inspection link.')}</div>`}</div></div>`;
  m.classList.add('open')};
 const bubbles=d=>d.items.map(x=>`<div class="smsB ${x.direction}">${E(x.body)}<small>${E(when(x.created_at))}${x.direction==='out'?` · ${E(x.created_by||'')} · ${E(x.error?T('failed'):x.status||'')}`:''}</small></div>`).join('')||`<div class="muted">${T('No messages yet.')}</div>`;
 // v24.76.2: only the newest opened conversation is drawn (a slow answer for an earlier one is ignored).
 S.compose=async({phone,customerId,body}={})=>{const m=modal(),my=++gen;let d={items:[],optedOut:false,customer:null};
  if(phone){try{d=await apiJSON(`/api/sms/thread?phone=${encodeURIComponent(phone)}`)}catch(e){if(my===gen)alert(e.message);return}}
  if(my!==gen)return;
  cur={phone:d.phone||phone||'',customerId:customerId||d.customer?.id||null,optedOut:!!d.optedOut};
  m.innerHTML=`<div class="modalbox" style="max-width:560px"><div class="modalhead"><h2>${E(d.customer?.customer_name||fmt(cur.phone)||T('New text'))}</h2><button class="x" type="button" data-sms="close">×</button></div>
   <div class="shareActs" style="margin-bottom:8px"><button type="button" class="secondary" data-sms="back">← ${T('All texts')}</button><span class="muted">${E(fmt(cur.phone))}</span></div>
   <div class="smsBubbles" id="smsBubbles">${bubbles(d)}</div>
   ${d.optedOut?`<div class="err">${T('This customer replied STOP. Texting is off until they text START.')}</div>`:`<div class="smsCompose">${cur.phone?'':`<input id="smsTo" inputmode="tel" placeholder="${E(T('Mobile number'))}">`}<textarea id="smsBody" maxlength="1200" placeholder="${E(T('Type a message…'))}">${E(body||'')}</textarea><div class="shareActs" style="justify-content:space-between"><span class="muted" id="smsCount"></span><button type="button" data-sms="send">${T('Send text')}</button></div></div>`}</div>`;
  m.classList.add('open');const bb=document.getElementById('smsBubbles');if(bb)bb.scrollTop=bb.scrollHeight;count();setTimeout(()=>document.getElementById('smsBody')?.focus(),40);refresh()};
 // v24.76.2: a new text in the open conversation updates the messages only; the reply being typed (text, cursor,
 // focus) is left alone. If the customer's STOP/START changed, the box is redrawn with the draft kept.
 S.refreshThread=async phone=>{const my=gen;let d;try{d=await apiJSON(`/api/sms/thread?phone=${encodeURIComponent(phone)}`)}catch(_){return}
  if(my!==gen||!cur||cur.phone!==phone)return;
  if(!!d.optedOut!==cur.optedOut)return S.compose({phone,customerId:cur.customerId,body:document.getElementById('smsBody')?.value||''});
  const bb=document.getElementById('smsBubbles');if(!bb)return;const atEnd=bb.scrollHeight-bb.scrollTop-bb.clientHeight<40;bb.innerHTML=bubbles(d);if(atEnd)bb.scrollTop=bb.scrollHeight};
 function count(){const t=document.getElementById('smsBody'),c=document.getElementById('smsCount');if(t&&c){const n=t.value.length;c.textContent=`${n} ${T('characters')}${n>160?` · ${Math.ceil(n/153)} ${T('texts')}`:''}`}}
 document.addEventListener('input',e=>{if(e.target.id==='smsBody')count()});
 document.addEventListener('click',async e=>{const b=e.target.closest('#smsModal [data-sms]');if(!b)return;const a=b.dataset.sms;
  if(a==='close')return closeModal('smsModal');if(a==='back')return S.inbox();
  if(a==='open')return S.compose({phone:b.dataset.phone});
  if(a==='new'){const p=document.getElementById('smsNewPhone').value.trim();if(!p)return;return S.compose({phone:p})}
  if(a==='send'){const body=document.getElementById('smsBody').value.trim(),to=cur.phone||document.getElementById('smsTo')?.value.trim();if(!to||!body)return;b.disabled=true;
   try{await apiJSON('/api/sms',{method:'POST',body:JSON.stringify({to,body,customerId:cur.customerId})});showToast(T('Text sent.'),'success');
    // Clears only what was sent: anything typed while it was sending stays in the box.
    const now=document.getElementById('smsBody')?.value||'';S.compose({phone:to,customerId:cur.customerId,body:now.trim()===body?'':now})}catch(err){alert(err.message);b.disabled=false}}});
 window.addEventListener('ittr:sms',e=>{const d=e.detail||{};S.unread++;badge();showToast(`💬 ${d.customer||fmt(d.phone)}: ${d.preview||''}`,'info',12000);if(cur&&cur.phone===d.phone&&document.getElementById('smsModal')?.classList.contains('open'))S.refreshThread(d.phone)});
 // Start once someone from the office is signed in.
 const boot=setInterval(()=>{if(typeof session!=='undefined'&&session&&session.role!=='mechanic'&&typeof cloudToken!=='undefined'&&cloudToken){clearInterval(boot);refresh()}},1500);
})();
