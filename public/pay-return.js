/* v24.74.0: public page Stripe returns to after a card payment (or a cancelled one). It shows the invoice's payment
   state as the shop's server recorded it, looked up by the random reference made with the checkout. Text is escaped. */
(function(){
 const app=document.getElementById('app'),q=new URLSearchParams(location.search),ref=q.get('ref')||'',back=q.get('status')==='success'?'success':'cancel';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const usd=n=>`$${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const head=s=>`<header class="shop"><img src="/assets/iron-team-logo.png" alt=""><div><b>${esc(s.name)}</b><span>${esc(s.phone)}</span></div></header>`;
 const foot=s=>`<footer>Questions? Call ${esc(s.phone)}${s.email?` or email ${esc(s.email)}`:''}.</footer>`;
 let tries=0;
 async function load(){
  try{if(!/^[A-Za-z0-9_-]{30,64}$/.test(ref))throw new Error('This payment page is not available.');
   const r=await fetch(`/api/public/pay/${encodeURIComponent(ref)}`,{cache:'no-store'}),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'This payment page is not available.');
   document.title=`${d.shop.name} — Invoice ${d.invoiceNumber}`;
   const body=d.paid?`<div class="card done" id="payState" data-state="paid"><div class="big" aria-hidden="true">✓</div><h1>Payment received</h1><p>Invoice ${esc(d.invoiceNumber)} is paid. Thank you!</p><p class="muted">The shop sees this payment. You can close this page.</p></div>`
    :back==='success'?`<div class="card done" id="payState" data-state="pending"><h1>Payment is being confirmed</h1><p>Invoice ${esc(d.invoiceNumber)} — balance ${usd(d.balance)}.</p><p class="muted">Card payments usually confirm within a minute. This page checks again by itself; you do not need to pay again.</p><button type="button" class="submit" id="recheck">Check again</button></div>`
    :`<div class="card done" id="payState" data-state="cancel"><h1>Payment not completed</h1><p>Invoice ${esc(d.invoiceNumber)} still has a balance of ${usd(d.balance)}. No charge was made.</p><p class="muted">Use the payment link from your invoice email again when you are ready, or call the shop.</p></div>`;
   app.innerHTML=`${head(d.shop)}${body}${foot(d.shop)}`;
   if(!d.paid&&back==='success'&&tries++<10)setTimeout(load,6000);
  }catch(x){app.innerHTML=`<div class="card"><h1>Payment page not available</h1><p>${esc(x.message)}</p><p class="muted">If you paid, your payment is still recorded by the shop. Please call them to confirm.</p></div>`}
 }
 app.addEventListener('click',e=>{if(e.target.id==='recheck'){tries=0;load()}});
 load();
})();
