let localAbort=null;
let editorAbort=null;
let customerCache=[];
let unitCache=[];
let activePaid=0;

const money=n=>`$${Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const byId=id=>document.getElementById(id);
const numberValue=id=>Math.max(0,Number(byId(id)?.value||0));

function termsDays(terms){return {'Due on Receipt':0,'Net 15':15,'Net 30':30,'Net 60':60}[terms]??0}
function isoPlusDays(iso,days){if(!iso)return '';const d=new Date(`${iso}T12:00:00`);if(Number.isNaN(d.getTime()))return '';d.setDate(d.getDate()+days);return d.toISOString().slice(0,10)}
function syncDueDate(){const date=byId('invDate')?.value,terms=byId('invTerms')?.value;if(byId('invDue'))byId('invDue').value=isoPlusDays(date,termsDays(terms))}

async function loadCustomers(active){
 const select=byId('invCustomerSelect');if(!select||select.disabled)return;
 try{
   const d=await window.apiJSON('/api/customers?q=');customerCache=d.items||[];
   const currentId=String(active?.invoice?.customer_id||select.dataset.currentId||'');
   const currentName=active?.invoice?.customer_name||select.dataset.currentName||'Customer';
   const rows=[`<option value="${currentId}">${window.esc(currentName)}</option>`];
   for(const c of customerCache){if(String(c.id)===currentId)continue;rows.push(`<option value="${c.id}">${window.esc(c.customer_name||'Customer')}</option>`)}
   select.innerHTML=rows.join('');select.value=currentId;
   await loadUnitsForCustomer(currentId,active);
 }catch(e){window.showToast?.(`Customer list: ${e.message}`,'warning',5000)}
}

async function loadUnitsForCustomer(customerId,active=null){
 const select=byId('invUnitSelect');if(!select)return;
 const currentUnit=active?.invoice?.unit_number||select.dataset.currentUnit||'';
 const currentId=String(active?.invoice?.unit_id||select.dataset.currentId||'');
 if(!customerId){select.innerHTML=`<option value="">${window.esc(currentUnit||'—')}</option>`;return}
 try{
   const d=await window.apiJSON(`/api/customers/${encodeURIComponent(customerId)}/profile`);unitCache=d.units||[];
   const opts=[`<option value="">No unit / truck</option>`];
   for(const u of unitCache)opts.push(`<option value="${u.id}">${window.esc(u.unit_number||'Unit')} · ${window.esc([u.year,u.make,u.model].filter(Boolean).join(' '))}</option>`);
   select.innerHTML=opts.join('');
   if(currentId&&unitCache.some(u=>String(u.id)===currentId))select.value=currentId;else if(currentUnit){const hit=unitCache.find(u=>String(u.unit_number||'')===String(currentUnit));if(hit)select.value=String(hit.id)}
 }catch(e){window.showToast?.(`Unit list: ${e.message}`,'warning',5000)}
}

async function customerChanged(){
 const select=byId('invCustomerSelect'),id=select?.value||'',c=customerCache.find(x=>String(x.id)===String(id));
 byId('invCustomerId').value=id;byId('invCustomer').value=c?.customer_name||select?.selectedOptions?.[0]?.textContent||'';byId('invDot').value=c?.dot_number||'';
 byId('invUnitId').value='';byId('invUnit').value='';byId('invVin').value='';
 await loadUnitsForCustomer(id);
 const terms=['Due on Receipt','Net 15','Net 30','Net 60'].includes(c?.credit_terms)?c.credit_terms:null;if(terms&&byId('invTerms')){byId('invTerms').value=terms;syncDueDate()}
 previewTotals();
}
function preferredLaborRate(){
 const selected=customerCache.find(x=>String(x.id)===String(byId('invCustomerId')?.value||''));
 const customerRate=Number(selected?.default_labor_rate||0);
 const firstLabor=(window.activeInvoice?.lines||[]).find?.(x=>x.line_type==='labor'&&Number(x.unit_price)>0);
 if(Number(firstLabor?.unit_price)>0)return Number(firstLabor.unit_price);
 if(customerRate>0)return customerRate;
 return 115;
}

function unitChanged(){
 const select=byId('invUnitSelect'),u=unitCache.find(x=>String(x.id)===String(select?.value));
 byId('invUnitId').value=u?.id||'';byId('invUnit').value=u?.unit_number||'';byId('invVin').value=u?.vin||'';if(u?.mileage!=null&&byId('invMileage'))byId('invMileage').value=Number(u.mileage)||'';
 const cid=byId('invCustomerId')?.value,c=customerCache.find(x=>String(x.id)===String(cid));if(c&&byId('invDot'))byId('invDot').value=c.dot_number||'';
}

function linePreviewRows(){return [...document.querySelectorAll('[data-invoice-line]')].map(row=>{const type=row.querySelector('.ilType')?.value||'other',qty=Math.max(0,Number(row.querySelector('.ilQty')?.value||0)),rate=Math.max(0,Number(row.querySelector('.ilPrice')?.value||0)),discountType=row.querySelector('.ilDiscountType')?.value||'fixed',discountValue=Math.max(0,Number(row.querySelector('.ilDiscountValue')?.value||0)),gross=qty*rate,discount=Math.min(gross,discountType==='percent'?gross*Math.min(100,discountValue)/100:discountValue);return {type,qty,net:Math.max(0,gross-discount),taxable:Boolean(row.querySelector('.ilTax')?.checked)}})}
export function previewTotals(){
 if(!byId('invPreviewTotal'))return;
 const rows=linePreviewRows(),laborRows=rows.filter(x=>x.type==='labor'),partRows=rows.filter(x=>x.type==='part'),otherRows=rows.filter(x=>!['labor','part'].includes(x.type));
 const labor=laborRows.reduce((a,x)=>a+x.net,0),parts=partRows.reduce((a,x)=>a+x.net,0),otherCharges=otherRows.reduce((a,x)=>a+x.net,0),hours=laborRows.reduce((a,x)=>a+x.qty,0),taxable=rows.filter(x=>x.taxable).reduce((a,x)=>a+x.net,0),fees=numberValue('invShopSupplies')+numberValue('invEnvFee'),preDiscount=labor+parts+otherCharges+fees,dType=byId('invDiscountType')?.value||'fixed',dValue=numberValue('invDiscountValue'),discount=Math.min(preDiscount,dType==='percent'?preDiscount*Math.min(100,dValue)/100:dValue),discountRatio=preDiscount>0?discount/preDiscount:0,taxBase=Math.max(0,taxable*(1-discountRatio)),tax=taxBase*numberValue('invTaxRate')/100,total=Math.max(0,preDiscount-discount+tax),paid=Number(activePaid||0),balance=Math.max(0,total-paid);
 const set=(id,val)=>{const el=byId(id);if(el)el.textContent=val};set('invPreviewLaborHours',hours.toFixed(2));set('invPreviewLabor',money(labor));set('invPreviewParts',money(parts));set('invPreviewOtherCharges',money(otherCharges));set('invPreviewAdditionalFees',money(fees));set('invPreviewSubtotal',money(Math.max(0,preDiscount-discount)));set('invPreviewDiscount',money(discount));set('invPreviewTax',money(tax));set('invPreviewTotal',money(total));set('invPreviewBalance',money(balance));
}

export function attachEditor(active){
 activePaid=Number(active?.invoice?.amount_paid||0);
 editorAbort?.abort();editorAbort=new AbortController();const signal=editorAbort.signal;
 const customer=byId('invCustomerSelect'),unit=byId('invUnitSelect'),date=byId('invDate'),terms=byId('invTerms');
 customer?.addEventListener('change',customerChanged,{signal});unit?.addEventListener('change',unitChanged,{signal});date?.addEventListener('change',syncDueDate,{signal});terms?.addEventListener('change',syncDueDate,{signal});
 for(const id of ['invTaxRate','invDiscountType','invDiscountValue','invShopSupplies','invEnvFee'])byId(id)?.addEventListener('input',previewTotals,{signal});
 document.getElementById('invoiceEditor')?.addEventListener('input',e=>{if(e.target.closest('[data-invoice-line]'))previewTotals();window.invoiceSetSaveState?.('dirty','Unsaved changes')},{signal});
 document.getElementById('invoiceEditor')?.addEventListener('change',e=>{if(e.target.classList?.contains('ilTax'))previewTotals();window.invoiceSetSaveState?.('dirty','Unsaved changes')},{signal});
 loadCustomers(active);previewTotals();
}

window.InvoiceUX={attachEditor,previewTotals,syncDueDate,preferredLaborRate};
export async function mount(scope){localAbort=new AbortController();scope.on(scope.host,'ittr:module-refresh',()=>window.loadInvoices?.(),{passive:true});document.body.classList.add('invoice-module-mounted');await window.loadInvoices?.()}
export async function afterShow(){await window.loadInvoices?.()}
export function unmount(){editorAbort?.abort();editorAbort=null;localAbort?.abort();localAbort=null;document.body.classList.remove('invoice-module-mounted')}
