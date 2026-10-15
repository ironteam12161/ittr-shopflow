// ITTR ShopFlow v24.48.0 Bills route module: type in every purchase (parts, supplies, tools, rent, …) with an expense
// category per line, pay / void, CSV for the accountant, and the QuickBooks account mapping for the future sync.
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=(u,o)=>window.apiJSON(u,o);
const toast=(m,t='info')=>window.showToast?.(m,t);
const money=v=>Math.round((Number(v)||0)*100)/100;
const usd=v=>{const m=money(v);return `${m<0?'−':''}$${Math.abs(m).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`};
const day=v=>{if(!v)return '—';const d=new Date(String(v).slice(0,10)+'T12:00:00');return Number.isFinite(d.getTime())?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const isOwner=()=>{try{return window.session?.role==='admin'||session?.role==='admin'}catch(_){return false}};
const STATUS={paid:'Paid',unpaid:'Unpaid',overdue:'Overdue',void:'Void'};
// v24.62.0: vendor credits (core returned) and "core not returned" entries come from Parts → Cores.
const KIND_TAG={expense:'Expense',credit:'Vendor credit',journal:'Core not returned'};
const statusText=b=>b.kind==='credit'?(b.status==='void'?'Void':b.paidAt?'Applied':'Open credit'):b.kind==='journal'?(b.status==='void'?'Void':'Recorded'):STATUS[b.status];
const fromCores=b=>b.kind==='credit'||b.kind==='journal';
const QB={not_synced:'Not sent',pending:'Sending',synced:'In QuickBooks',needs_update:'Needs update',error:'Error'};
const TERMS=[['','—'],['Due on receipt',0],['Net 10',10],['Net 15',15],['Net 30',30],['Net 45',45],['Net 60',60]];
let S={scope:null,meta:null,filters:{range:'year',from:'',to:'',status:'',category:'',q:''},data:null,qTimer:0,modal:null,form:null,vendTimer:0};
const $=sel=>S.scope?.host.querySelector(sel);

function rangeDates(){const f=S.filters,d=new Date(),y=d.getFullYear(),m=d.getMonth(),iso=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
 switch(f.range){case 'month':return [iso(new Date(y,m,1)),today()];case 'last_month':return [iso(new Date(y,m-1,1)),iso(new Date(y,m,0))];
  case 'quarter':return [iso(new Date(y,Math.floor(m/3)*3,1)),today()];case 'last_year':return [`${y-1}-01-01`,`${y-1}-12-31`];case 'all':return ['2000-01-01','2100-12-31'];
  case 'custom':return [f.from||`${y}-01-01`,f.to||today()];default:return [`${y}-01-01`,today()]}}
const qs=()=>{const [from,to]=rangeDates(),f=S.filters;return new URLSearchParams({from,to,status:f.status,category:f.category,q:f.q}).toString()};
const catName=k=>S.meta?.categories.find(c=>c.key===k)?.name||k;
const activeCats=()=>(S.meta?.categories||[]).filter(c=>c.active);

// ================================================================ list
async function load(){
 const rows=$('#blRows');if(!rows)return;
 try{S.data=await api(`/api/bills?${qs()}`);render()}catch(e){rows.innerHTML=`<tr><td colspan="8" class="blEmpty">${h(e.message)}</td></tr>`}
}
function render(){
 const d=S.data;if(!d)return;const t=d.totals;
 $('#blKpis').innerHTML=`<button class="blKpi" data-b="status" data-s=""><span>Spent in period</span><b>${usd(t.total)}</b><span>${t.count} bill${t.count===1?'':'s'}</span></button>
  <button class="blKpi unpaid" data-b="status" data-s="unpaid"><span>Unpaid</span><b>${usd(t.unpaid)}</b><span>to pay</span></button>
  <button class="blKpi overdue" data-b="status" data-s="overdue"><span>Overdue</span><b>${usd(t.overdue)}</b><span>${t.overdueCount} past due</span></button>
  <button class="blKpi qb" data-b="noop"><span>Not in QuickBooks yet</span><b>${t.notSynced}</b><span>sent once QuickBooks is connected</span></button>`;
 const cats=Object.entries(d.byCategory||{}).sort((a,b)=>b[1]-a[1]);
 $('#blCats').innerHTML=cats.length?`<button class="blCat ${!S.filters.category?'on':''}" data-b="cat" data-c="">All categories</button>`+cats.map(([k,v])=>`<button class="blCat ${S.filters.category===k?'on':''}" data-b="cat" data-c="${h(k)}">${h(catName(k))}<i>${usd(v)}</i></button>`).join(''):'';
 S.scope.host.querySelectorAll('#blStatus button').forEach(b=>b.classList.toggle('on',b.dataset.s===S.filters.status));
 $('#blRows').innerHTML=d.items.length?d.items.map(b=>`<tr data-b="open" data-id="${b.id}">
   <td>${day(b.billDate)}</td><td><b>${h(b.vendor||'—')}</b>${KIND_TAG[b.kind]?` <span class="blTag">${KIND_TAG[b.kind]}</span>`:''}${b.receivedIntoStock?' <span class="blTag" title="Received into parts stock">In stock</span>':''}</td>
   <td>${h(b.billNumber||'—')}</td><td>${(b.categories||[]).map(c=>`<span class="blTag">${h(catName(c))}</span>`).join('')}</td>
   <td class="muted">${b.kind==='bill'?day(b.dueDate):'—'}</td><td class="n"><b>${usd(b.total)}</b>${b.appliedCredits&&b.status!=='paid'?`<div class="muted" title="Vendor credit applied">to pay ${usd(b.balanceDue)}</div>`:''}</td>
   <td><span class="blPill ${b.status}">${statusText(b)}</span>${b.status==='paid'&&b.paymentMethod?`<div class="muted">${h(S.meta?.paymentMethods?.[b.paymentMethod]||'')}</div>`:''}</td>
   <td><span class="blPill qb ${h(b.qbStatus)}">${QB[b.qbStatus]||h(b.qbStatus)}</span></td></tr>`).join('')
  :`<tr><td colspan="8" class="blEmpty">No bills here yet. Use <b>+ New bill</b> to type one in.</td></tr>`;
}

// ================================================================ modal helpers
function openModal(html,small=false){closeModal();const m=document.createElement('div');m.className='blModal';m.innerHTML=`<div class="box${small?' small':''}" role="dialog" aria-modal="true">${html}</div>`;
 document.body.appendChild(m);S.modal=m;
 m.addEventListener('click',onModalClick);m.addEventListener('input',onModalInput);m.addEventListener('change',onModalChange);
 m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();tryClose()}});
 setTimeout(()=>m.querySelector('[autofocus]')?.focus(),30);return m}
function closeModal(){S.modal?.remove();S.modal=null;S.form=null}
function tryClose(){if(S.form?.dirty&&!confirm('Close without saving this bill?'))return;closeModal()}
const M=sel=>S.modal?.querySelector(sel);

// ================================================================ bill form (new / edit)
const blankLine=()=>({description:'',partNumber:'',category:'',quantity:1,unitCost:'',amount:'',amountTyped:false});
function newForm(kind){return {id:null,kind,vendor:'',billNumber:'',billDate:today(),terms:kind==='bill'?'Net 30':'',dueDate:'',poNumber:'',notes:'',discount:'',tax:'',freight:'',paperTotal:'',
 paymentMethod:kind==='expense'?'card':'',paymentReference:'',paidOn:today(),lines:[blankLine(),blankLine()],received:false,dirty:false}}
function dueFromTerms(f){const t=TERMS.find(x=>x[0]===f.terms);if(!t||t[0]===''||!f.billDate)return;const d=new Date(f.billDate+'T12:00:00');d.setDate(d.getDate()+Number(t[1]));f.dueDate=d.toISOString().slice(0,10)}
function lineAmount(l){return l.amountTyped||l.amount!==''&&(l.unitCost===''||l.unitCost==null)?money(l.amount):money((Number(l.quantity)||0)*(Number(l.unitCost)||0))}
function sums(f){const sub=money(f.lines.reduce((a,l)=>a+lineAmount(l),0)),total=money(sub-Math.abs(Number(f.discount)||0)+(Number(f.tax)||0)+(Number(f.freight)||0));return {sub,total}}
function catOptions(sel){return `<option value="">Choose…</option>`+activeCats().map(c=>`<option value="${h(c.key)}" ${c.key===sel?'selected':''}>${h(c.name)}</option>`).join('')}
function formHtml(){const f=S.form,locked=f.received;
 const lines=f.lines.map((l,i)=>`<tr data-i="${i}">
  <td class="d"><input data-l="description" value="${h(l.description)}" placeholder="What was bought" ${locked?'disabled':''}>${l.partNumber?`<div class="muted" style="font-size:11px;margin-top:2px">Part # ${h(l.partNumber)}</div>`:''}</td>
  <td class="c"><select data-l="category" aria-label="Category">${catOptions(l.category)}</select></td>
  <td><input class="q n" data-l="quantity" type="number" min="0" step="any" value="${h(l.quantity)}" aria-label="Quantity" ${locked?'disabled':''}></td>
  <td><input class="m n" data-l="unitCost" type="number" step="0.01" min="0" value="${h(l.unitCost)}" placeholder="0.00" aria-label="Unit cost" ${locked?'disabled':''}></td>
  <td><input class="m n" data-l="amount" type="number" step="0.01" min="0" value="${l.amountTyped?h(l.amount):(lineAmount(l)||'')}" placeholder="0.00" aria-label="Amount" ${locked?'disabled':''}></td>
  <td>${locked||f.lines.length<2?'':`<button type="button" class="rm" data-m="rmline" title="Remove line" aria-label="Remove line">×</button>`}</td></tr>`).join('');
 const {sub,total}=sums(f),paper=f.paperTotal===''?null:money(f.paperTotal),off=paper!=null&&Math.abs(paper-total)>0.01;
 const kindBtns=locked?'':`<div class="blKind"><button type="button" data-m="kind" data-k="bill" class="${f.kind==='bill'?'on':''}">Bill — pay later</button><button type="button" data-m="kind" data-k="expense" class="${f.kind==='expense'?'on':''}">Expense — already paid</button></div>`;
 return `<div class="blBoxHead"><div><h2>${f.id?'Edit':'New'} ${f.kind==='expense'?'expense':'bill'}</h2><div class="sub">${locked?'This parts bill was received into stock, so its lines and amounts stay as received. You can change categories, terms, due date and notes.':'Type it in from the paper or email bill. Each line gets a category, which decides the QuickBooks account.'}</div></div><button type="button" class="x" data-m="close" aria-label="Close">×</button></div>
 ${kindBtns}
 <div class="blGrid">
  <label class="span2 blVend">Vendor *<input data-v="vendor" value="${h(f.vendor)}" placeholder="Who you bought from" autocomplete="off" ${locked?'disabled':'autofocus'}><div class="blVendList hidden" id="blVendList"></div></label>
  <label>${f.kind==='expense'?'Receipt #':'Bill #'}<input data-v="billNumber" value="${h(f.billNumber)}" placeholder="${f.kind==='expense'?'optional':'Vendor invoice number'}" ${locked?'disabled':''}></label>
  <label>${f.kind==='expense'?'Date':'Bill date'} *<input type="date" data-v="billDate" value="${h(f.billDate)}" ${locked?'disabled':''}></label>
  ${f.kind==='bill'?`<label>Terms<select data-v="terms">${TERMS.map(t=>`<option value="${h(t[0])}" ${t[0]===f.terms?'selected':''}>${h(t[0]||'—')}</option>`).join('')}</select></label>
  <label>Due date<input type="date" data-v="dueDate" value="${h(f.dueDate)}"></label>`:`<label>Paid with *<select data-v="paymentMethod">${Object.entries(S.meta.paymentMethods).map(([k,v])=>`<option value="${k}" ${k===f.paymentMethod?'selected':''}>${h(v)}</option>`).join('')}</select></label>
  <label>Card / check / ref.<input data-v="paymentReference" value="${h(f.paymentReference)}" placeholder="e.g. Visa 4421, check 1043"></label>`}
  <label>PO #<input data-v="poNumber" value="${h(f.poNumber)}" placeholder="optional" ${locked?'disabled':''}></label>
  <label>Notes<input data-v="notes" value="${h(f.notes)}" placeholder="optional memo"></label>
 </div>
 <div style="overflow:auto"><table class="blLines"><thead><tr><th>Description</th><th>Category</th><th>Qty</th><th>Unit cost</th><th>Amount</th><th></th></tr></thead><tbody>${lines}</tbody></table></div>
 ${locked?'':`<button type="button" class="secondary" data-m="addline">+ Add line</button>`}
 <div class="blFoot"><div class="blHelp">Discounts and credits on the bill go in <b>Discount</b>. Tax and discount are spread over the lines when sent to QuickBooks; freight goes to <i>${h(catName('freight'))}</i>.</div>
  <div class="blSums"><div><span>Lines</span><b>${usd(sub)}</b></div>
   <div><span>Discount / credit</span><input type="number" step="0.01" min="0" data-v="discount" value="${h(f.discount)}" placeholder="0.00" ${locked?'disabled':''}></div>
   <div><span>Tax</span><input type="number" step="0.01" min="0" data-v="tax" value="${h(f.tax)}" placeholder="0.00" ${locked?'disabled':''}></div>
   <div><span>Freight</span><input type="number" step="0.01" min="0" data-v="freight" value="${h(f.freight)}" placeholder="0.00" ${locked?'disabled':''}></div>
   <div class="tot"><span>Total</span><span id="blTotal">${usd(total)}</span></div>
   ${locked?'':`<div><span>Total on the paper bill</span><input type="number" step="0.01" data-v="paperTotal" value="${h(f.paperTotal)}" placeholder="to double-check"></div>`}
   <span class="warn" id="blWarn">${off?`Doesn't match: lines + tax + freight − discount = ${usd(total)}`:''}</span></div></div>
 <div class="blBar"><button type="button" class="secondary" data-m="close">Cancel</button><button type="button" data-m="save">${f.id?'Save changes':f.kind==='expense'?'Save expense':'Save bill'}</button></div>`;
}
function drawForm(keepFocus){const a=document.activeElement,key=a?.dataset?.v||a?.dataset?.l,row=a?.closest?.('tr')?.dataset?.i;M('.box').innerHTML=formHtml();
 if(keepFocus&&key){const el=row!=null?M(`tr[data-i="${row}"] [data-l="${key}"]`):M(`[data-v="${key}"]`);if(el){el.focus();try{const n=el.value.length;el.setSelectionRange?.(n,n)}catch(_){}}}}
function updateTotals(){const f=S.form,{sub,total}=sums(f);const t=M('#blTotal');if(t)t.textContent=usd(total);const lines=M('.blSums div span+b');if(lines)lines.textContent=usd(sub);
 const paper=f.paperTotal===''?null:money(f.paperTotal),w=M('#blWarn');if(w)w.textContent=paper!=null&&Math.abs(paper-total)>0.01?`Doesn't match: lines + tax + freight − discount = ${usd(total)}`:'';
 f.lines.forEach((l,i)=>{const a=M(`tr[data-i="${i}"] [data-l="amount"]`);if(a&&!l.amountTyped&&document.activeElement!==a)a.value=lineAmount(l)||''})}
// v24.61.0: a core charge read with a part becomes its own line ("Core deposit – part #"), like on the paper bill, so the
// lines add up to the bill total. Receiving into stock puts it back on the part as a core owed.
function scanLines(list){const out=[];for(const l of list){const q=Number(l.quantity)||1,u=Number(l.unitCost)||0,core=Number(l.coreCost)||0;let amt=Number(l.lineTotal)||0;
 if(core>0&&amt&&Math.abs(amt-(q*u+q*core))<0.02)amt=Math.round(q*u*100)/100;
 out.push({description:l.description||'',partNumber:l.partNumber||'',category:l.partNumber?'parts':'',quantity:l.quantity||1,unitCost:l.unitCost||'',amount:amt||'',amountTyped:!!amt});
 if(core>0)out.push({description:`Core deposit – ${l.partNumber||l.description||'part'}`,partNumber:'',category:'core_deposits',quantity:q,unitCost:core,amount:Math.round(q*core*100)/100,amountTyped:true})}
 return out}
async function startForm(kind,bill,lines,scan){
 openModal('');S.form=newForm(kind);
 if(scan){const i=scan.invoice||{};Object.assign(S.form,{vendor:i.vendor||'',billNumber:i.invoiceNumber||'',billDate:i.invoiceDate||today(),dueDate:i.dueDate||'',poNumber:i.poNumber||'',
  discount:i.discount||'',tax:i.tax||'',freight:i.freight||'',paperTotal:i.total||'',file:scan.file?.key?scan.file:null,gmailMessageId:scan.gmailMessageId||null,dirty:true,
  lines:(scan.lines||[]).length?scanLines(scan.lines):S.form.lines});
  if(!i.dueDate)dueFromTerms(S.form)}
 if(bill){Object.assign(S.form,{id:bill.id,kind:bill.kind,vendor:bill.vendor,billNumber:bill.billNumber,billDate:bill.billDate||today(),terms:bill.terms,dueDate:bill.dueDate||'',poNumber:bill.poNumber,notes:bill.notes,
  discount:bill.discount||'',tax:bill.tax||'',freight:bill.freight||'',paymentMethod:bill.paymentMethod||(bill.kind==='expense'?'card':''),paymentReference:bill.paymentReference||'',paidOn:(bill.paidAt||'').slice(0,10)||today(),received:bill.receivedIntoStock,
  lines:lines.map(l=>({id:l.id,description:l.description,partNumber:l.partNumber,category:l.category,quantity:l.quantity,unitCost:l.unitCost,amount:l.amount,amountTyped:true,workOrderId:l.workOrderId,unitNumber:l.unitNumber}))})}
 else if(!scan)dueFromTerms(S.form);
 drawForm();
}
function payload(){const f=S.form;return {kind:f.kind,vendor:f.vendor,billNumber:f.billNumber,billDate:f.billDate,dueDate:f.kind==='bill'?f.dueDate:'',terms:f.kind==='bill'?f.terms:'',poNumber:f.poNumber,notes:f.notes,
 discount:f.discount||0,tax:f.tax||0,freight:f.freight||0,paymentMethod:f.paymentMethod,paymentReference:f.paymentReference,paidOn:f.paidOn,file:f.file||undefined,gmailMessageId:f.gmailMessageId||undefined,
 lines:f.lines.map(l=>({id:l.id,description:l.description,partNumber:l.partNumber,category:l.category,quantity:l.quantity===''?1:l.quantity,unitCost:l.unitCost,amount:lineAmount(l),workOrderId:l.workOrderId,unitNumber:l.unitNumber}))}}
async function saveForm(btn){const f=S.form;
 if(f.paperTotal!==''&&Math.abs(money(f.paperTotal)-sums(f).total)>0.01&&!confirm(`The total you typed (${usd(f.paperTotal)}) doesn't match the lines (${usd(sums(f).total)}). Save anyway?`))return;
 btn.disabled=true;try{
  const r=f.id?await api(`/api/bills/${f.id}`,{method:'PUT',body:payload()}):await api('/api/bills',{method:'POST',body:payload()});
  const id=f.id||r.id;toast(f.id?'Bill updated.':f.kind==='expense'?'Expense saved.':'Bill saved.','success');closeModal();await load();openDetail(id);
 }catch(e){toast(e.message,'warning');btn.disabled=false}}

async function vendorSuggest(q){const box=M('#blVendList');if(!box)return;if(!q.trim()){box.classList.add('hidden');return}
 try{const d=await api(`/api/bills/vendors?q=${encodeURIComponent(q)}`);const list=d.vendors.filter(v=>v.name.toLowerCase()!==q.trim().toLowerCase());
  box.innerHTML=list.map(v=>`<button type="button" data-m="vendor" data-name="${h(v.name)}">${h(v.name)}<small>${v.bills?`${v.bills} bill${v.bills===1?'':'s'}`:''}</small></button>`).join('');box.classList.toggle('hidden',!list.length)}catch(_){box.classList.add('hidden')}}

// ================================================================ detail
async function openDetail(id){
 try{const d=await api(`/api/bills/${id}`),b=d.bill,qb=d.quickBooks;
  const lines=d.lines.map(l=>`<tr><td>${h(l.description||'—')}${l.partNumber?`<div class="muted">Part # ${h(l.partNumber)}</div>`:''}</td><td><span class="blTag">${h(catName(l.category))}</span></td><td class="n">${l.quantity}</td><td class="n">${usd(l.unitCost)}</td><td class="n"><b>${usd(l.amount)}</b></td></tr>`).join('');
  const qbRows=qb.payload.Line.map(l=>{const je=l.JournalEntryLineDetail,acc=(je||l.AccountBasedExpenseLineDetail).AccountRef.name;return `<tr><td>${h(acc)}${je?` <span class="muted">${je.PostingType==='Debit'?'debit':'credit'}</span>`:''}</td><td>${h(l.Description||'')}</td><td class="n">${usd(l.Amount)}</td></tr>`}).join('');
  const pm=S.meta.paymentMethods;
  openModal(`<div class="blBoxHead"><div><h2>${h(b.vendor)} ${b.billNumber?`· #${h(b.billNumber)}`:''}</h2><div class="sub">${b.kind==='expense'?'Expense (paid at purchase)':b.kind==='credit'?'Vendor credit — core returned (from Parts → Cores)':b.kind==='journal'?'Core not returned — deposit moved to parts cost (from Parts → Cores)':'Bill'} · entered by ${h(b.createdBy||'—')}${b.receivedIntoStock?' · received into parts stock':''}</div></div><button type="button" class="x" data-m="close" aria-label="Close">×</button></div>
   <div><span class="blPill ${b.status}">${statusText(b)}</span> <span class="blPill qb ${h(b.qbStatus)}">QuickBooks: ${QB[b.qbStatus]||h(b.qbStatus)}</span></div>
   <div class="blInfo"><div><span>${b.kind==='expense'?'Date':'Bill date'}</span><b>${day(b.billDate)}</b></div><div><span>Due</span><b>${b.kind==='expense'?'—':day(b.dueDate)}</b>${b.terms?`<div class="muted">${h(b.terms)}</div>`:''}</div>
    <div><span>Total</span><b>${usd(b.total)}</b></div><div><span>Paid</span><b>${b.paidAt?day(b.paidAt):'Not yet'}</b>${b.paidAt?`<div class="muted">${b.kind==='credit'&&b.appliedToBillId?'':h(pm[b.paymentMethod]||'')}${b.paymentReference?`${b.kind==='credit'&&b.appliedToBillId?'':' · '}${h(b.paymentReference)}`:''}</div>`:''}</div></div>
   <div class="blScroll"><table class="blTable"><thead><tr><th>Description</th><th>Category</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead><tbody>${lines}</tbody>
    <tfoot>${b.discount?`<tr><td colspan="4" class="n">Discount</td><td class="n">−${usd(b.discount)}</td></tr>`:''}${b.tax?`<tr><td colspan="4" class="n">Tax</td><td class="n">${usd(b.tax)}</td></tr>`:''}${b.freight?`<tr><td colspan="4" class="n">Freight</td><td class="n">${usd(b.freight)}</td></tr>`:''}<tr><td colspan="4" class="n"><b>Total</b></td><td class="n"><b>${usd(b.total)}</b></td></tr>${b.appliedCredits?`<tr><td colspan="4" class="n">Vendor credit applied</td><td class="n">${usd(b.appliedCredits)}</td></tr><tr><td colspan="4" class="n"><b>${b.paidAt?'Paid':'Left to pay'}</b></td><td class="n"><b>${usd(b.balanceDue)}</b></td></tr>`:''}</tfoot></table></div>
   ${b.poNumber||b.notes?`<div class="blHelp" style="margin-top:8px">${b.poNumber?`PO ${h(b.poNumber)}`:''}${b.poNumber&&b.notes?' · ':''}${h(b.notes)}</div>`:''}
   <details class="blQb"><summary>QuickBooks preview — ${h(qb.object)} ${qb.missing.length?`<span class="miss">· missing: ${h(qb.missing.join(', '))}</span>`:'· ready'}</summary>
    <div class="blHelp">What will be sent when QuickBooks is connected. Accounts come from <b>Categories &amp; QuickBooks</b>.</div><table><tbody>${qbRows}</tbody></table></details>
   <div class="blBar">
    ${b.hasFile?`<button type="button" class="secondary" data-m="file" data-id="${b.id}">View original</button>`:''}
    ${fromCores(b)?`<div class="blHelp" style="flex:1">To change it, use Parts → Cores (Reopen the core).</div>`:''}
    ${b.status!=='void'&&!b.receivedIntoStock&&!fromCores(b)?`<button type="button" class="secondary" data-m="void" data-id="${b.id}">Void</button>`:''}
    ${b.paidAt&&b.kind!=='expense'&&b.kind!=='journal'&&b.status!=='void'?`<button type="button" class="secondary" data-m="unpay" data-id="${b.id}">${b.kind==='credit'?'Undo applied':'Undo payment'}</button>`:''}
    ${b.status!=='void'&&!fromCores(b)?`<button type="button" class="secondary" data-m="edit" data-id="${b.id}">Edit</button>`:''}
    ${b.status!=='void'&&!b.receivedIntoStock&&!fromCores(b)&&d.lines.some(l=>l.partNumber||l.category==='parts')?`<button type="button" class="secondary" data-m="receive" data-id="${b.id}" title="Match these parts to inventory and put them on the shelf">📦 Receive into stock</button>`:''}
    ${!b.paidAt&&b.status!=='void'?`<button type="button" data-m="pay" data-id="${b.id}" ${b.kind==='credit'?'title="Mark it used when the credit is taken off a payment to this vendor"':''}>${b.kind==='credit'?'Mark applied':'Mark paid'}</button>`:''}
   </div>`);
  S.modal.dataset.bill=JSON.stringify({b,lines:d.lines});
 }catch(e){toast(e.message,'warning')}
}
// v24.63.0: a vendor credit is used on one of that vendor's unpaid bills (it then shows "Left to pay"), or refunded.
async function applyDialog(id,credit){
 let bills=[];try{const d=await api(`/api/bills?${new URLSearchParams({from:'2000-01-01',to:'2100-12-31',vendor:credit.vendor,status:'unpaid'})}`);bills=(d.items||[]).filter(x=>x.kind==='bill'||x.kind==='expense')}catch(_){}
 const pm=S.meta.paymentMethods;
 openModal(`<div class="blBoxHead"><div><h2>Use vendor credit</h2><div class="sub">${usd(Math.abs(credit.total))} from ${h(credit.vendor)}</div></div><button type="button" class="x" data-m="close" aria-label="Close">×</button></div>
  <div class="blHelp">Take it off a bill you still owe this vendor — that bill then shows what is left to pay.</div>
  <div class="blApplyList">${bills.length?bills.map(x=>`<label class="blApplyRow"><input type="radio" name="blApply" value="${x.id}"><span><b>#${h(x.billNumber||x.id)}</b> · ${day(x.billDate)}</span><span class="n">${usd(x.balanceDue)} left</span></label>`).join(''):'<div class="muted">No unpaid bills from this vendor.</div>'}
   <label class="blApplyRow"><input type="radio" name="blApply" value="refund"><span>Vendor refunded it (check, card or bank)</span><span></span></label></div>
  <div class="blGrid" style="grid-template-columns:1fr 1fr"><label>Date<input type="date" id="blApplyOn" value="${today()}"></label><label>Refund paid with<select id="blApplyM">${Object.entries(pm).map(([k,v])=>`<option value="${k}" ${k==='check'?'selected':''}>${h(v)}</option>`).join('')}</select></label>
  <label class="span2">Refund reference<input id="blApplyRef" placeholder="optional"></label></div>
  <div class="blBar"><button type="button" class="secondary" data-m="back" data-id="${id}">Cancel</button><button type="button" data-m="applysave" data-id="${id}">Save</button></div>`,true);
}
function payDialog(id,total){
 const pm=S.meta.paymentMethods;
 openModal(`<div class="blBoxHead"><div><h2>Mark paid</h2><div class="sub">${usd(total)}</div></div><button type="button" class="x" data-m="close" aria-label="Close">×</button></div>
  <div class="blGrid" style="grid-template-columns:1fr 1fr"><label>Paid on<input type="date" id="blPayOn" value="${today()}"></label><label>Paid with<select id="blPayM">${Object.entries(pm).map(([k,v])=>`<option value="${k}" ${k==='check'?'selected':''}>${h(v)}</option>`).join('')}</select></label>
  <label class="span2">Check # / reference<input id="blPayRef" placeholder="optional" autofocus></label></div>
  <div class="blBar"><button type="button" class="secondary" data-m="back" data-id="${id}">Cancel</button><button type="button" data-m="paysave" data-id="${id}">Save payment</button></div>`,true);
}

// ================================================================ categories ↔ QuickBooks accounts (owner)
function catsDialog(){
 const rows=S.meta.categories.map(c=>catRow(c)).join('');
 openModal(`<div class="blBoxHead"><div><h2>Categories &amp; QuickBooks accounts</h2><div class="sub">Type each category's account name exactly as it appears in your QuickBooks Chart of Accounts. Your accountant can check this once; the sync uses it for every bill.</div></div><button type="button" class="x" data-m="close" aria-label="Close">×</button></div>
  <div class="blScroll"><table class="blTable blCatTable"><thead><tr><th>Category</th><th>QuickBooks account</th><th>Type</th><th>Show</th></tr></thead><tbody id="blCatRows">${rows}</tbody></table></div>
  <button type="button" class="secondary" data-m="addcat" style="margin-top:8px">+ Add category</button>
  <div class="blBar"><button type="button" class="secondary" data-m="close">Cancel</button><button type="button" data-m="savecats">Save</button></div>`);
}
function catRow(c={}){return `<tr data-key="${h(c.key||'')}"><td><input data-cat="name" value="${h(c.name||'')}" placeholder="e.g. Waste disposal"></td><td><input data-cat="qb" value="${h(c.qb_account||'')}" placeholder="QuickBooks account name"></td>
 <td><select data-cat="kind">${[['cogs','Cost of goods (job costs)'],['expense','Shop expense'],['asset','Equipment / asset']].map(([k,v])=>`<option value="${k}" ${k===(c.kind||'expense')?'selected':''}>${v}</option>`).join('')}</select></td>
 <td style="text-align:center"><input type="checkbox" data-cat="active" ${c.active!==false?'checked':''} style="width:auto;min-height:auto"></td></tr>`}

// ================================================================ events
async function onModalClick(e){
 if(e.target===S.modal)return tryClose();
 const b=e.target.closest('[data-m]');if(!b)return;const m=b.dataset.m,id=b.dataset.id;
 if(m==='close')return tryClose();
 if(m==='kind'){S.form.kind=b.dataset.k;if(S.form.kind==='expense'&&!S.form.paymentMethod)S.form.paymentMethod='card';if(S.form.kind==='bill'&&!S.form.terms){S.form.terms='Net 30';dueFromTerms(S.form)}S.form.dirty=true;return drawForm()}
 if(m==='addline'){S.form.lines.push(blankLine());S.form.dirty=true;drawForm();const last=M(`tr[data-i="${S.form.lines.length-1}"] [data-l="description"]`);last?.focus();return}
 if(m==='rmline'){const i=Number(b.closest('tr').dataset.i);S.form.lines.splice(i,1);S.form.dirty=true;return drawForm()}
 if(m==='vendor'){S.form.vendor=b.dataset.name;S.form.dirty=true;M('[data-v="vendor"]').value=b.dataset.name;M('#blVendList').classList.add('hidden');return}
 if(m==='save')return saveForm(b);
 if(m==='receive'){closeModal();return window.receiveFiledBill?.(Number(id))}
 if(m==='edit'){const {b:bill,lines}=JSON.parse(S.modal.dataset.bill);return startForm(bill.kind,bill,lines)}
 if(m==='pay'){const {b:bill}=JSON.parse(S.modal.dataset.bill);return bill.kind==='credit'?applyDialog(id,bill):payDialog(id,bill.balanceDue??bill.total)}
 if(m==='applysave'){const pick=M('input[name="blApply"]:checked')?.value;if(!pick)return toast('Choose the bill the credit was taken off, or “Vendor refunded it”.','warning');b.disabled=true;
  const body=pick==='refund'?{paidOn:M('#blApplyOn').value,method:M('#blApplyM').value,reference:M('#blApplyRef').value}:{paidOn:M('#blApplyOn').value,applyToBillId:Number(pick)};
  try{await api(`/api/bills/${id}/payment`,{method:'POST',body});toast(pick==='refund'?'Refund recorded.':'Credit applied to the bill.','success');await load();return openDetail(pick==='refund'?id:Number(pick))}catch(err){toast(err.message,'warning');b.disabled=false}return}
 if(m==='back')return openDetail(id);
 if(m==='paysave'){b.disabled=true;try{await api(`/api/bills/${id}/payment`,{method:'POST',body:{paidOn:M('#blPayOn').value,method:M('#blPayM').value,reference:M('#blPayRef').value}});toast('Marked paid.','success');await load();return openDetail(id)}catch(err){toast(err.message,'warning');b.disabled=false}return}
 if(m==='unpay'){if(!confirm('Mark this bill as not paid?'))return;try{await api(`/api/bills/${id}/payment`,{method:'DELETE'});await load();return openDetail(id)}catch(err){return toast(err.message,'warning')}}
 if(m==='void'){const reason=prompt('Why is this bill voided? (e.g. entered twice, vendor credited it)');if(!reason?.trim())return;try{await api(`/api/bills/${id}/void`,{method:'POST',body:{reason}});toast('Bill voided.','success');await load();return openDetail(id)}catch(err){return toast(err.message,'warning')}}
 if(m==='file'){try{const r=await fetch(`/api/vendor-invoices/${id}/file`,{headers:window.authHeaders?.()||{}});if(!r.ok)throw new Error('File not found.');const url=URL.createObjectURL(await r.blob());window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000)}catch(err){toast(err.message,'warning')}return}
 if(m==='addcat'){M('#blCatRows').insertAdjacentHTML('beforeend',catRow());M('#blCatRows tr:last-child input')?.focus();return}
 if(m==='savecats'){const cats=[...S.modal.querySelectorAll('#blCatRows tr')].map(tr=>({key:tr.dataset.key,name:tr.querySelector('[data-cat="name"]').value,qbAccount:tr.querySelector('[data-cat="qb"]').value,kind:tr.querySelector('[data-cat="kind"]').value,active:tr.querySelector('[data-cat="active"]').checked})).filter(c=>c.key||c.name.trim());
  b.disabled=true;try{const d=await api('/api/bills/categories',{method:'PUT',body:{categories:cats}});S.meta.categories=d.categories;toast('Categories saved.','success');closeModal();render()}catch(err){toast(err.message,'warning');b.disabled=false}}
}
function onModalInput(e){const t=e.target,f=S.form;if(!f)return;
 if(t.dataset.v){f[t.dataset.v]=t.value;f.dirty=true;if(t.dataset.v==='vendor'){clearTimeout(S.vendTimer);S.vendTimer=setTimeout(()=>vendorSuggest(t.value),200)}if(['discount','tax','freight','paperTotal'].includes(t.dataset.v))updateTotals();return}
 if(t.dataset.l){const l=f.lines[Number(t.closest('tr').dataset.i)];l[t.dataset.l]=t.value;f.dirty=true;
  if(t.dataset.l==='amount'){l.amountTyped=t.value!=='';if(l.amountTyped&&Number(l.quantity)>0)l.unitCost=money(Number(t.value)/Number(l.quantity));const u=t.closest('tr').querySelector('[data-l="unitCost"]');if(u&&l.amountTyped)u.value=l.unitCost}
  if(t.dataset.l==='quantity'||t.dataset.l==='unitCost')l.amountTyped=false;
  updateTotals()}}
function onModalChange(e){const t=e.target,f=S.form;if(!f)return;
 if(t.dataset.v==='terms'||t.dataset.v==='billDate'){f[t.dataset.v]=t.value;if(f.kind==='bill')dueFromTerms(f);const due=M('[data-v="dueDate"]');if(due)due.value=f.dueDate}
 if(t.dataset.l==='category'){f.lines[Number(t.closest('tr').dataset.i)].category=t.value;f.dirty=true}}

async function downloadCsv(){const [from,to]=rangeDates();try{const r=await fetch(`/api/bills/export.csv?${qs()}`,{headers:window.authHeaders?.()||{}});if(!r.ok)throw new Error('Export failed.');const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download=`bills-${from}-to-${to}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000)}catch(e){toast(e.message,'warning')}}

function onClick(e){const b=e.target.closest('[data-b],#blStatus button');if(!b)return;
 if(b.matches('#blStatus button')||b.dataset.b==='status'){S.filters.status=b.dataset.s||'';return load()}
 const a=b.dataset.b;
 if(a==='new')return startForm(b.dataset.kind);
 if(a==='open')return openDetail(b.dataset.id);
 if(a==='cat'){S.filters.category=b.dataset.c||'';return load()}
 if(a==='csv')return downloadCsv();
 if(a==='cats')return catsDialog();
 if(a==='receive')return window.openSmartReceiving?.();
 if(a==='scan')return S.scope.host.querySelector('#blScanFile')?.click();
}
// v24.48.2: scan a bill or receipt (photo/PDF) — AI reads it, the form opens filled in to check and save.
async function scanBill(file){if(!file)return;const btn=S.scope.host.querySelector('[data-b="scan"]');if(btn){btn.disabled=true;btn.textContent='Reading bill…'}
 try{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/vendor-invoices/scan',{method:'POST',headers:window.authHeaders?.()||{},body:fd}),d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||`Scan failed (${r.status})`);
  if(d.alreadyFiled&&!confirm(`This vendor already has bill #${d.invoice?.invoiceNumber||''} saved. Open the form anyway?`))return openDetail(d.alreadyFiled.id);
  await startForm('bill',null,null,d);toast('Check what the AI read, choose a category for each line, then save.','info')}
 catch(e){toast(e.message,'warning')}finally{if(btn){btn.disabled=false;btn.textContent='📷 Scan bill'}const i=S.scope?.host.querySelector('#blScanFile');if(i)i.value=''}}
function onFilter(e){const t=e.target;if(!t.dataset.f)return;S.filters[t.dataset.f]=t.value;
 if(t.dataset.f==='range'){S.scope.host.querySelectorAll('[data-f="from"],[data-f="to"]').forEach(x=>x.classList.toggle('hidden',t.value!=='custom'))}
 try{sessionStorage.setItem('ittr_bills_range',S.filters.range)}catch(_){}
 if(t.dataset.f==='q'){clearTimeout(S.qTimer);S.qTimer=setTimeout(load,250);return}load()}

export async function mount(scope){S={...S,scope,data:null};
 try{const r=sessionStorage.getItem('ittr_bills_range');if(r){S.filters.range=r;const sel=scope.host.querySelector('[data-f="range"]');if(sel)sel.value=r;if(r==='custom')scope.host.querySelectorAll('[data-f="from"],[data-f="to"]').forEach(x=>x.classList.remove('hidden'))}}catch(_){}
 if(!isOwner())scope.host.querySelectorAll('.ownerOnlyBills').forEach(x=>x.remove());
 scope.on(scope.host,'click',onClick);scope.on(scope.host,'input',e=>{if(e.target.dataset.f==='q')onFilter(e)});scope.on(scope.host,'change',e=>{if(e.target.dataset.f&&e.target.dataset.f!=='q')onFilter(e)});
 scope.on(document,'click',e=>{if(S.modal&&!e.target.closest?.('.blVend'))S.modal.querySelector('#blVendList')?.classList.add('hidden')});
 scope.on(scope.host,'change',e=>{if(e.target.id==='blScanFile')scanBill(e.target.files?.[0])});
 scope.on(window,'ittr:bills-changed',()=>{if(S.meta)load()});
 // v24.51.0: a vendor-bill email scanned from Reports → Gmail inbox opens here, filled in.
 scope.on(window,'ittr:bill-draft',()=>openPendingDraft());
 try{S.meta=await api('/api/bills/meta')}catch(e){scope.host.querySelector('#blRows').innerHTML=`<tr><td colspan="8" class="blEmpty">${h(e.message)}</td></tr>`;return}
 await load();openPendingDraft()}
function openPendingDraft(){const d=window.__ittrBillDraft;if(!d||!S.meta)return;window.__ittrBillDraft=null;startForm('bill',null,null,d)}
export async function afterShow(){if(S.meta){load();openPendingDraft()}}
export function unmount(){closeModal();clearTimeout(S.qTimer);clearTimeout(S.vendTimer);S.scope=null}
