// ITTR ShopFlow v24.37.0 Reports route module: accountant-ready finance reports + Gmail money inbox.
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)||0);
const usd0=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(v)||0);
const compact=v=>{const n=Number(v)||0,a=Math.abs(n);return a>=1e6?`$${(n/1e6).toFixed(1)}M`:a>=1e4?`$${Math.round(n/1e3)}k`:a>=1e3?`$${(n/1e3).toFixed(1)}k`:`$${Math.round(n)}`};
const qty=v=>Number(v||0).toLocaleString('en-US',{maximumFractionDigits:2});
const day=v=>{if(!v)return '—';const d=new Date(String(v).length===10?`${v}T12:00:00`:v);return Number.isFinite(d.getTime())?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'};
const monthLabel=m=>{const [y,mo]=String(m).split('-').map(Number);return new Date(y,mo-1,1).toLocaleDateString('en-US',{month:'short'})+(mo===1?` ’${String(y).slice(2)}`:'')};
const api=(u,o)=>window.apiJSON(u,o);
const toast=(m,t='info')=>window.showToast?.(m,t);
const isOwner=()=>{try{return session?.role==='admin'}catch(_){return false}};
const C={labor:'var(--s1)',parts:'var(--s2)',other:'var(--s3)',billed:'var(--s1)',collected:'var(--s2)',one:'var(--s1)'};

let S={charts:new Map(),scope:null,tab:'overview',range:null,preset:'ytd',data:null,sort:{},inbox:{kind:'',status:'new'},gmail:null,msgs:[]};
const $=sel=>S.scope?.host.querySelector(sel);
const pad=n=>String(n).padStart(2,'0'),ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
function presetRange(p){const t=new Date(),y=t.getFullYear(),m=t.getMonth();
 if(p==='month')return {from:ymd(new Date(y,m,1)),to:ymd(t)};
 if(p==='lastmonth')return {from:ymd(new Date(y,m-1,1)),to:ymd(new Date(y,m,0))};
 if(p==='quarter')return {from:ymd(new Date(y,Math.floor(m/3)*3,1)),to:ymd(t)};
 if(p==='lastyear')return {from:`${y-1}-01-01`,to:`${y-1}-12-31`};
 return {from:`${y}-01-01`,to:ymd(t)}}

// ---------------------------------------------------------------- charts (SVG, one y-axis, thin marks, hover tips)
function niceMax(v){if(v<=0)return 100;const p=Math.pow(10,Math.floor(Math.log10(v))),f=v/p;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p}
function topRounded(x,y,w,hh,r){r=Math.min(r,w/2,hh);if(hh<=0)return '';return `M${x},${y+hh}V${y+r}Q${x},${y} ${x+r},${y}H${x+w-r}Q${x+w},${y} ${x+w},${y+r}V${y+hh}Z`}
let chartSeq=0;
function vbars(spec){if(!spec.rows.length)return '<div class="repEmpty">No data in this range.</div>';const id=`c${++chartSeq}`;S.charts.set(id,spec);return `<div class="repChart" data-chart="${id}" style="min-height:${spec.height||230}px"></div>`}
function drawCharts(){if(!S.scope)return;S.scope.host.querySelectorAll('.repPanel.active [data-chart]').forEach(el=>{const spec=S.charts.get(el.dataset.chart),w=Math.round(el.clientWidth);if(!spec||!w||el.dataset.w===String(w))return;el.dataset.w=String(w);el.innerHTML=drawVbars({...spec,W:w})})}
function drawVbars({rows,series,stacked=true,height=230,fmt=usd,W=720}){
 const L=52,R=8,T=12,B=26,ph=height-T-B,pw=W-L-R,n=rows.length;
 const totals=rows.map(r=>stacked?series.reduce((a,s)=>a+Math.max(0,r[s.key]||0),0):Math.max(0,...series.map(s=>r[s.key]||0)));
 const max=niceMax(Math.max(...totals)),y=v=>T+ph-(v/max)*ph,slot=pw/n;
 const groupW=Math.min(56,slot*0.62),barW=stacked?groupW:Math.max(3,(groupW-2*(series.length-1))/series.length);
 let g='';for(let i=0;i<=4;i++){const v=max*i/4,yy=y(v);g+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="${i?'#eef0f3':'#d0d5dd'}" stroke-width="1"/><text x="${L-6}" y="${yy+4}" text-anchor="end">${compact(v)}</text>`}
 const every=Math.max(1,Math.ceil(n/Math.max(2,Math.floor(pw/54))));
 rows.forEach((r,i)=>{const x0=L+slot*i+(slot-groupW)/2;let acc=0;
  const tip=[r.label,...series.map(s=>`${s.name}: ${fmt(r[s.key]||0)}`),...(stacked&&series.length>1?[`Total: ${fmt(totals[i])}`]:[])].join('\n');
  series.forEach((s,k)=>{const v=Math.max(0,r[s.key]||0);if(!v)return;
   if(stacked){const top=y(acc+v),bottom=y(acc);const isTop=series.slice(k+1).every(s2=>!(r[s2.key]>0));const hh=Math.max(0,bottom-top-(acc>0?2:0));
    g+=isTop?`<path d="${topRounded(x0,top,barW,hh,4)}" fill="${s.color}"/>`:`<rect x="${x0}" y="${top}" width="${barW}" height="${hh}" fill="${s.color}"/>`;acc+=v}
   else{const xx=x0+k*(barW+2),top=y(v);g+=`<path d="${topRounded(xx,top,barW,y(0)-top,4)}" fill="${s.color}"/>`}});
  if(i%every===0)g+=`<text x="${L+slot*i+slot/2}" y="${height-8}" text-anchor="middle">${h(r.short||r.label)}</text>`;
  g+=`<rect x="${L+slot*i}" y="${T}" width="${slot}" height="${ph}" fill="transparent" data-tip="${h(tip)}"/>`});
 return `<svg width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${h(series.map(s=>s.name).join(', '))} by month">${g}</svg>`;
}
function legend(series){return series.length<2?'':`<div class="repLegend">${series.map(s=>`<span><i style="background:${s.color}"></i>${h(s.name)}</span>`).join('')}</div>`}
function hbars(items,{fmt=usd,color=C.one}={}){
 const list=items.filter(x=>Number(x.value)>0);if(!list.length)return '<div class="repEmpty">Nothing to show for this range.</div>';
 const max=Math.max(...list.map(x=>x.value));
 return list.map(x=>`<div class="repHbar" data-tip="${h(x.tip||`${x.label}: ${fmt(x.value)}`)}"><span class="lbl" title="${h(x.label)}">${h(x.label)}</span><span class="trk"><span class="bar" style="display:block;width:${Math.max(0.5,x.value/max*100)}%;background:${x.color||color}"></span></span><span class="num">${fmt(x.value)}</span></div>`).join('');
}
// ---------------------------------------------------------------- tables + CSV
function table(id,cols,rows,{rowAttr=()=>'',empty='No rows.',max=0}={}){
 const st=S.sort[id];let list=[...rows];
 if(st){const c=cols.find(x=>x.key===st.key);if(c)list.sort((a,b)=>{const av=c.sortVal?c.sortVal(a):a[c.key],bv=c.sortVal?c.sortVal(b):b[c.key];return (typeof av==='number'||c.num?(Number(av)||0)-(Number(bv)||0):String(av??'').localeCompare(String(bv??'')))*(st.dir)})}
 if(max)list=list.slice(0,max);
 if(!list.length)return `<div class="repEmpty">${h(empty)}</div>`;
 return `<div class="repScroll"><table class="repTable"><thead><tr>${cols.map(c=>`<th class="${c.num?'n':''}" data-rep="sort" data-table="${id}" data-key="${c.key}" aria-sort="${st?.key===c.key?(st.dir>0?'ascending':'descending'):'none'}">${h(c.label)}${st?.key===c.key?(st.dir>0?' ▲':' ▼'):''}</th>`).join('')}</tr></thead><tbody>${list.map(r=>`<tr ${rowAttr(r)}>${cols.map(c=>`<td class="${c.num?'n':''}">${c.html?c.html(r):h(c.fmt?c.fmt(r[c.key],r):r[c.key]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const CSV={};
function registerCsv(key,cols,rows){CSV[key]={cols,rows}}
function downloadCsv(key){const x=CSV[key];if(!x)return;const esc=v=>{const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s};
 const text=[x.cols.map(c=>esc(c.label)).join(','),...x.rows.map(r=>x.cols.map(c=>esc(c.csv?c.csv(r):r[c.key])).join(','))].join('\n');
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv'}));a.download=`ittr-${key}-${S.range.from}-to-${S.range.to}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000)}
const card=(title,sub,body,csvKey='')=>`<section class="repCard"><div class="repCardHead"><div><h3>${h(title)}</h3>${sub?`<div class="sub">${h(sub)}</div>`:''}</div>${csvKey?`<button data-rep="csv" data-k="${csvKey}">Export CSV</button>`:''}</div>${body}</section>`;

// ---------------------------------------------------------------- data + render
async function load(){
 const {from,to}=S.range;$('#repFrom').value=from;$('#repTo').value=to;
 S.scope.host.querySelectorAll('[data-rep="preset"]').forEach(b=>b.classList.toggle('active',b.dataset.p===S.preset));
 const pr=$('#repPrintRange');if(pr)pr.textContent=`${day(from)} – ${day(to)} · generated ${new Date().toLocaleString('en-US')}`;
 $('#repKpis').innerHTML='<div class="repKpi"><span>Loading…</span><b>—</b></div>';
 try{S.data=await api(`/api/reports/finance?from=${from}&to=${to}`);render()}
 catch(e){$('#repKpis').innerHTML=`<div class="repEmpty" style="grid-column:1/-1">${h(e.message)}</div>`}
}
function render(){
 const d=S.data,k=d.kpis;S.charts=new Map();
 $('#repKpis').innerHTML=[
  ['Billed (invoiced)',usd0(k.billed),`${k.invoices} invoice${k.invoices===1?'':'s'} · tax ${usd0(k.tax)}`],
  ['Collected',usd0(k.collected),`${k.payments} payment${k.payments===1?'':'s'}`],
  ['Customers owe',usd0(k.outstanding),k.overdue>0?`<small class="bad">${usd0(k.overdue)} overdue</small>`:`${k.openInvoices} open invoice${k.openInvoices===1?'':'s'}`,true],
  ['Parts profit',usd0(k.partsMargin),`${k.partsMarginPct}% margin on ${usd0(k.parts)}`],
  ['Tire fees',usd0(d.tireFees.totalAmount),`${qty(d.tireFees.userFeeQty)} new · ${qty(d.tireFees.disposalQty)} disposed`],
  ['Parts purchased',usd0(k.partsPurchased),`${d.vendorSpend.length} vendor${d.vendorSpend.length===1?'':'s'}`]
 ].map(([l,v,s,raw])=>`<div class="repKpi"><span>${l}</span><b>${v}</b>${raw?s:`<small>${s}</small>`}</div>`).join('');
 const fullMonth=m=>{const [y,mo]=String(m).split('-').map(Number);return new Date(y,mo-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'})};
 const months=d.monthly.map(m=>({...m,label:fullMonth(m.month),short:monthLabel(m.month)}));
 // Overview
 const revSeries=[{key:'labor',name:'Labor',color:C.labor},{key:'parts',name:'Parts',color:C.parts},{key:'other',name:'Fees & other',color:C.other}];
 const flowSeries=[{key:'billed',name:'Billed',color:C.billed},{key:'collected',name:'Collected',color:C.collected}];
 registerCsv('monthly',[{key:'month',label:'Month'},{key:'labor',label:'Labor'},{key:'parts',label:'Parts'},{key:'other',label:'Fees & other (net of discounts)'},{key:'tax',label:'Sales tax'},{key:'billed',label:'Total billed'},{key:'collected',label:'Collected'},{key:'partsPurchased',label:'Parts purchased'}],d.monthly);
 registerCsv('customers',[{key:'customerName',label:'Customer'},{key:'invoices',label:'Invoices'},{key:'billed',label:'Billed'},{key:'balance',label:'Current balance'}],d.topCustomers);
 const mixTotal=d.revenueMix.reduce((a,x)=>a+x.amount,0);
 $('#repOverview').innerHTML=`<div class="repGrid"><div>
   ${card('Sales by month','Labor, parts and fees on finalized invoices (before tax).',legend(revSeries)+vbars({rows:months,series:revSeries}),'monthly')}
   ${card('Billed vs. collected','What was invoiced each month next to what actually came in.',legend(flowSeries)+vbars({rows:months,series:flowSeries,stacked:false}))}
  </div><div>
   ${card('Where the money comes from',`${usd(mixTotal)} in sales for this range.`,hbars(d.revenueMix.map(x=>({label:x.label,value:x.amount,tip:`${x.label}: ${usd(x.amount)} (${mixTotal?Math.round(x.amount/mixTotal*100):0}%)`}))))}
   ${card('How customers paid','Payments received in this range.',hbars(d.paymentMethods.map(p=>({label:p.method,value:p.amount,tip:`${p.method}: ${usd(p.amount)} · ${p.count} payment${p.count===1?'':'s'}`}))))}
   ${card('Top customers',`By amount billed in this range.`,table('top',[{key:'customerName',label:'Customer'},{key:'billed',label:'Billed',num:true,fmt:usd},{key:'balance',label:'Owes now',num:true,fmt:usd}],d.topCustomers,{empty:'No invoices in this range.'}),'customers')}
   ${card('Estimates','Estimates written in this range.',hbars(d.estimates.filter(e=>e.count).map(e=>({label:e.status==='converted'?'Invoiced':e.status[0].toUpperCase()+e.status.slice(1),value:e.total,tip:`${e.count} estimate${e.count===1?'':'s'} · ${usd(e.total)}`}))))}
  </div></div>`;
 // Receivables
 const agingLabels={current:'Not due yet','1-30':'1–30 days late','31-60':'31–60 days late','61-90':'61–90 days late','90+':'Over 90 days late'},agingColors=['var(--q1)','var(--q2)','var(--q3)','var(--q4)','var(--q5)'];
 const custCols=[{key:'customerName',label:'Customer'},{key:'invoices',label:'Open invoices',num:true},{key:'balance',label:'Owes',num:true,fmt:usd},{key:'overdue',label:'Overdue',num:true,fmt:usd},{key:'daysPastDue',label:'Oldest (days late)',num:true,html:r=>r.daysPastDue>0?`<span class="repTag ${r.daysPastDue>30?'late':''}">${r.daysPastDue}</span>`:'<span class="repTag ok">on time</span>',csv:r=>r.daysPastDue}];
 const invCols=[{key:'invoice_number',label:'Invoice'},{key:'customer_name',label:'Customer'},{key:'unit_number',label:'Unit'},{key:'invoice_date',label:'Date',fmt:day,csv:r=>String(r.invoice_date||'').slice(0,10)},{key:'due_date',label:'Due',fmt:day,csv:r=>String(r.due_date||'').slice(0,10)},{key:'total',label:'Total',num:true,fmt:usd},{key:'amount_paid',label:'Paid',num:true,fmt:usd},{key:'balance_due',label:'Balance',num:true,fmt:usd},{key:'days_past_due',label:'Days late',num:true,html:r=>r.days_past_due>0?`<span class="repTag ${r.days_past_due>30?'late':''}">${r.days_past_due}</span>`:'—',csv:r=>Math.max(0,r.days_past_due)}];
 registerCsv('receivables-customers',custCols,d.customersOwing);registerCsv('open-invoices',invCols,d.openInvoices);registerCsv('aging',[{key:'bucket',label:'Bucket'},{key:'count',label:'Invoices'},{key:'amount',label:'Amount'}],d.aging);
 $('#repAr').innerHTML=`<div class="repGrid"><div>${card('Who owes you money',`${usd(k.outstanding)} across ${k.openInvoices} open invoice${k.openInvoices===1?'':'s'} (as of today, all dates).`,table('owing',custCols,d.customersOwing,{empty:'Nobody owes you money right now. 🎉'}),'receivables-customers')}</div>
  <div>${card('How late are the payments','Unpaid balance by days past the due date.',hbars(d.aging.map((a,i)=>({label:agingLabels[a.bucket],value:a.amount,color:agingColors[i],tip:`${agingLabels[a.bucket]}: ${usd(a.amount)} · ${a.count} invoice${a.count===1?'':'s'}`}))),'aging')}
  ${d.kpis.draftInvoices?`<div class="repNotice warn">${d.kpis.draftInvoices} draft invoice${d.kpis.draftInvoices===1?'':'s'} (${usd(d.kpis.draftValue)}) not finalized yet — they are not counted as owed until you finalize them.</div>`:''}</div></div>
  ${card('Open invoices','Click an invoice to open it.',table('openinv',invCols,d.openInvoices,{rowAttr:r=>`data-inv="${r.id}"`,empty:'No open invoices.'}),'open-invoices')}`;
 // Parts
 const puCols=[{key:'partNumber',label:'Part #'},{key:'description',label:'Description'},{key:'timesUsed',label:'Times used',num:true},{key:'qty',label:'Qty',num:true,fmt:qty},{key:'cost',label:'Our cost',num:true,fmt:usd},{key:'revenue',label:'Sold for',num:true,fmt:usd},{key:'margin',label:'Profit',num:true,fmt:usd},{key:'lastUsed',label:'Last used',fmt:day,csv:r=>String(r.lastUsed||'').slice(0,10)}];
 const vsCols=[{key:'vendor',label:'Vendor'},{key:'bills',label:'Bills',num:true},{key:'subtotal',label:'Parts',num:true,fmt:usd},{key:'tax',label:'Tax',num:true,fmt:usd},{key:'freight',label:'Freight',num:true,fmt:usd},{key:'total',label:'Total',num:true,fmt:usd},{key:'lastBill',label:'Last bill',fmt:day,csv:r=>String(r.lastBill||'').slice(0,10)}];
 const vbCols=[{key:'invoice_date',label:'Date',fmt:day,csv:r=>String(r.invoice_date||'').slice(0,10)},{key:'vendor',label:'Vendor'},{key:'invoice_number',label:'Vendor invoice #'},{key:'subtotal',label:'Parts',num:true,fmt:usd},{key:'tax',label:'Tax',num:true,fmt:usd},{key:'freight',label:'Freight',num:true,fmt:usd},{key:'total',label:'Total',num:true,fmt:usd}];
 registerCsv('parts-usage',puCols,d.partsUsage);registerCsv('vendor-spend',vsCols,d.vendorSpend);registerCsv('vendor-bills',vbCols,d.vendorBills);
 const mostUsed=[...d.partsUsage].sort((a,b)=>b.timesUsed-a.timesUsed||b.qty-a.qty).slice(0,10);
 $('#repParts').innerHTML=`<div class="repGrid"><div>
   ${card('Parts purchased by month','Received vendor bills (Smart Receiving), including tax and freight.',vbars({rows:months,series:[{key:'partsPurchased',name:'Parts purchased',color:C.one}]}))}
   ${card('Spending by vendor',`${usd(k.partsPurchased)} in parts bills this range.`,hbars(d.vendorSpend.slice(0,12).map(v=>({label:v.vendor,value:v.total,tip:`${v.vendor}: ${usd(v.total)} · ${v.bills} bill${v.bills===1?'':'s'}`})))+'<div style="height:10px"></div>'+table('vs',vsCols,d.vendorSpend,{empty:'No vendor bills received in this range.'}),'vendor-spend')}
  </div><div>
   ${card('Most-used parts','How many invoices each part went on.',hbars(mostUsed.map(p=>({label:p.partNumber||p.description,value:p.timesUsed,tip:`${p.partNumber||''} ${p.description||''}\nUsed on ${p.timesUsed} invoice${p.timesUsed===1?'':'s'} · qty ${qty(p.qty)}`})),{fmt:v=>`${v}×`}))}
   ${card('Parts profit',`Sold for ${usd(k.parts)} · cost ${usd(k.partsCost)}.`,`<div class="repHbar"><span class="lbl">Profit</span><span></span><span class="num">${usd(k.partsMargin)}</span></div><div class="repHbar"><span class="lbl">Margin</span><span></span><span class="num">${k.partsMarginPct}%</span></div>`)}
  </div></div>
  ${card('Parts used on invoices','Every part billed in this range — how many times, how many, what it cost you and what you charged.',table('pu',puCols,d.partsUsage,{empty:'No parts billed in this range.'}),'parts-usage')}
  ${card('Vendor bills','Each received parts invoice.',table('vb',vbCols,d.vendorBills,{empty:'No vendor bills.'}),'vendor-bills')}`;
 // Tires
 const t=d.tireFees,ts=d.tireSettings,byMonth={};
 t.monthly.forEach(x=>{const m=byMonth[x.month]||(byMonth[x.month]={month:x.month,label:fullMonth(x.month),short:monthLabel(x.month),userQty:0,userAmt:0,dispQty:0,dispAmt:0});if(x.category==='tire_user_fee'){m.userQty+=x.qty;m.userAmt+=x.amount}else{m.dispQty+=x.qty;m.dispAmt+=x.amount}});
 const tRows=Object.values(byMonth);
 const tCols=[{key:'month',label:'Month',fmt:(v,r)=>r.label,sortVal:r=>r.month},{key:'userQty',label:'New tires (user fee)',num:true,fmt:qty},{key:'userAmt',label:'User fee collected',num:true,fmt:usd},{key:'dispQty',label:'Tires disposed',num:true,fmt:qty},{key:'dispAmt',label:'Disposal collected',num:true,fmt:usd}];
 registerCsv('tire-fees',tCols,tRows);
 const tireSeries=[{key:'userAmt',name:ts.userFeeLabel,color:C.labor},{key:'dispAmt',name:ts.disposalLabel,color:C.parts}];
 $('#repTires').innerHTML=`<div class="repKpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
   <div class="repKpi"><span>New tires sold</span><b>${qty(t.userFeeQty)}</b><small>${h(ts.userFeeLabel)} × ${usd(ts.userFee)}</small></div>
   <div class="repKpi"><span>${h(ts.userFeeLabel)} collected</span><b>${usd(t.userFeeAmount)}</b><small>You keep ${usd(t.userFeeRetained)} (${usd(ts.userFeeRetainedPerTire)}/tire)</small></div>
   <div class="repKpi"><span>User fee to send to the state</span><b>${usd(t.userFeeToRemit)}</b><small>Collected minus your allowance</small></div>
   <div class="repKpi"><span>${h(ts.disposalLabel)}</span><b>${usd(t.disposalAmount)}</b><small>${qty(t.disposalQty)} tires × ${usd(ts.disposalFee)}</small></div></div>
  ${card('Tire fees by month','From tire fee lines on finalized invoices.',legend(tireSeries)+vbars({rows:tRows,series:tireSeries})+'<div style="height:10px"></div>'+table('tires',tCols,tRows,{empty:'No tire fees billed in this range. Use the “Tire Fees” button on an invoice.'}),'tire-fees')}
  ${isOwner()?card('Tire fee amounts','Used by the “Tire Fees” button on invoices and estimates. Confirm the current amounts with your accountant.',`<div class="repForm">
   <div class="field"><label>User fee label</label><input id="tfsUserLabel" value="${h(ts.userFeeLabel)}"></div><div class="field"><label>User fee per new tire $</label><input id="tfsUser" type="number" step="0.01" min="0" value="${ts.userFee}"></div><div class="field"><label>Shop keeps per tire $ (allowance)</label><input id="tfsRetained" type="number" step="0.01" min="0" value="${ts.userFeeRetainedPerTire}"></div>
   <div class="field"><label>Disposal fee label</label><input id="tfsDispLabel" value="${h(ts.disposalLabel)}"></div><div class="field"><label>Disposal fee per tire $</label><input id="tfsDisp" type="number" step="0.01" min="0" value="${ts.disposalFee}"></div><div class="field"><label>Taxable?</label><select id="tfsTax"><option value="no" ${ts.taxable?'':'selected'}>No</option><option value="yes" ${ts.taxable?'selected':''}>Yes</option></select></div>
   </div><div style="display:flex;justify-content:flex-end;margin-top:10px"><button data-rep="save-tires">Save tire fees</button></div>`):''}`;
 applyTab();
}
function applyTab(){
 S.scope.host.querySelectorAll('[data-rep="tab"]').forEach(b=>{b.classList.toggle('active',b.dataset.t===S.tab);b.setAttribute('aria-selected',b.dataset.t===S.tab)});
 S.scope.host.querySelectorAll('.repPanel').forEach(p=>p.classList.toggle('active',p.dataset.panel===S.tab));
 $('#repKpis').style.display=S.tab==='overview'?'':'none';
 if(S.tab==='inbox')loadInbox();
 requestAnimationFrame(drawCharts);
}

// ---------------------------------------------------------------- Gmail money inbox
async function loadInbox(){
 const box=$('#repInbox');if(!box)return;box.innerHTML='<div class="repEmpty">Loading Gmail…</div>';
 try{S.gmail=await api('/api/gmail/status');S.msgs=S.gmail.accounts?.length?(await api(`/api/gmail/messages?kind=${S.inbox.kind}&status=${S.inbox.status}`)).items:[];renderInbox()}
 catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
function renderInbox(){
 const g=S.gmail,box=$('#repInbox'),owner=isOwner();
 const setup=!g.configured?`<div class="repNotice warn"><b>Gmail is not set up on the server yet.</b> Missing: ${h(g.missing.join(', '))}.<br>1) In Google Cloud Console create an OAuth client (Web application) and enable the Gmail API. 2) Add this redirect URI: <code>${h(g.redirectUri||'https://YOUR-APP/api/gmail/oauth/callback')}</code> 3) Put GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_TOKEN_KEY (any long random text) and APP_PUBLIC_URL in Railway, then redeploy.</div>`:'';
 const accounts=(g.accounts||[]).map(a=>`<div class="repHbar" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="lbl"><b>${h(a.email)}</b> <span class="muted">· ${a.last_sync_at?`synced ${new Date(a.last_sync_at).toLocaleString('en-US')}`:'never synced'}</span>${a.last_sync_error?` <span class="repTag late">${h(a.last_sync_error)}</span>`:''}</span><span></span>${owner?`<button class="secondary" style="min-height:30px;padding:4px 10px;font-size:12px" data-rep="gmail-disconnect" data-id="${a.id}">Disconnect</button>`:''}</div>`).join('');
 const cnt=(kind,status)=>(g.counts||[]).filter(c=>c.kind===kind&&(!status||c.status===status)).reduce((a,c)=>a+c.n,0);
 const chips=[['','All'],['zelle_in','Zelle received'],['zelle_out','Zelle sent'],['vendor_bill','Vendor bills']].map(([k,l])=>`<button class="filterbtn ${S.inbox.kind===k?'active':''}" data-rep="inbox-kind" data-k="${k}">${l}${k?` (${cnt(k,'new')} new)`:''}</button>`).join('');
 const stChips=[['new','New'],['matched','Applied'],['reviewed','Reviewed'],['ignored','Ignored'],['','Everything']].map(([k,l])=>`<button class="filterbtn ${S.inbox.status===k?'active':''}" data-rep="inbox-status" data-k="${k}">${l}</button>`).join('');
 const msgs=S.msgs.map(m=>{
  const tag=m.kind==='zelle_in'?'<span class="repTag in">Zelle received</span>':m.kind==='zelle_out'?'<span class="repTag out">Zelle sent</span>':'<span class="repTag bill">Vendor bill</span>';
  const atts=(m.attachments||[]).filter(a=>a&&a.filename).map(a=>`<button class="secondary" data-rep="gmail-att" data-id="${m.id}" data-i="${a.index}">📎 ${h(a.filename)}</button>`).join('');
  const sugg=m.kind==='zelle_in'&&m.status==='new'?(m.suggestions?.length?`<div class="repSugg"><div class="meta">Looks like it pays:</div>${m.suggestions.map(s=>`<button data-rep="gmail-apply" data-id="${m.id}" data-inv="${s.invoice.id}" data-num="${h(s.invoice.invoice_number)}"><span>${h(s.invoice.invoice_number)} · ${h(s.invoice.customer_name)}${s.invoice.unit_number?` · Unit ${h(s.invoice.unit_number)}`:''}<br><small>${h(s.reasons.join(' · '))}</small></span><span>${usd(s.invoice.balance_due)} due · Apply</span></button>`).join('')}</div>`:'<div class="meta" style="margin-top:6px">No matching open invoice found — use “Apply to invoice #…”.</div>'):'';
  const acts=m.status==='matched'?`<span class="repTag ok">Applied to ${h(m.matched_invoice_number||'invoice')}</span>`:`${m.kind==='zelle_in'?`<button data-rep="gmail-apply-manual" data-id="${m.id}">Apply to invoice #…</button>`:''}${m.status!=='reviewed'?`<button class="secondary" data-rep="gmail-status" data-id="${m.id}" data-to="reviewed">Mark reviewed</button>`:''}${m.status!=='ignored'?`<button class="secondary" data-rep="gmail-status" data-id="${m.id}" data-to="ignored">Ignore</button>`:`<button class="secondary" data-rep="gmail-status" data-id="${m.id}" data-to="new">Restore</button>`}`;
  return `<div class="repMsg"><div>${tag} <b>${h(m.counterparty||m.from_name||m.from_email)}</b>${m.reference?` · <span class="muted">#${h(m.reference)}</span>`:''}<div class="meta">${h(m.subject)} · ${m.received_at?new Date(m.received_at).toLocaleString('en-US'):''} · ${h(m.account_email)}</div>${m.memo?`<div class="meta">Memo: ${h(m.memo)}</div>`:''}${sugg}<div class="acts">${atts}${acts}</div></div><div class="amt">${m.amount!=null?usd(m.amount):'—'}</div></div>`}).join('');
 box.innerHTML=`${setup}
  ${card('Connected Gmail accounts','ITTR reads Zelle notices and vendor bills (read-only). Nothing is sent or deleted.',(accounts||'<div class="repEmpty">No Gmail connected yet.</div>')+`<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">${owner&&g.configured?'<button class="secondary" data-rep="gmail-connect">+ Connect Gmail</button>':''}${g.accounts?.length&&g.configured?'<button data-rep="gmail-sync">Check email now</button>':''}</div>`)}
  ${g.accounts?.length?`<div class="filterbar">${chips}</div><div class="filterbar">${stChips}</div>${msgs||'<div class="repEmpty">Nothing here. Click “Check email now” to scan for new Zelle payments and vendor bills.</div>'}`:''}
  ${owner&&g.accounts?.length?card('What to look for','Gmail search used when checking email. Add vendor senders like from:fleetpride.com to catch more bills.',`<div class="repForm" style="grid-template-columns:1fr"><div class="field"><label>Zelle search</label><input id="gqZelle" value="${h(g.zelle)}"></div><div class="field"><label>Vendor bill search</label><input id="gqVendor" value="${h(g.vendor)}"></div></div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="secondary" data-rep="gmail-queries">Save searches</button></div>`):''}`;
}
async function gmailAttachment(id,i){const w=window.open('','_blank');try{const r=await fetch(`/api/gmail/messages/${id}/attachments/${i}`,{headers:window.authHeaders()});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Download failed');const url=URL.createObjectURL(await r.blob());if(w)w.location=url;else location.href=url;setTimeout(()=>URL.revokeObjectURL(url),60000)}catch(e){w?.close();toast(e.message,'error')}}

// ---------------------------------------------------------------- events
async function onClick(ev){
 const inv=ev.target.closest('tr[data-inv]');if(inv){await window.showView('invoices');window.openInvoiceWorkspace?.(Number(inv.dataset.inv));return}
 const b=ev.target.closest('[data-rep]');if(!b)return;const a=b.dataset.rep;
 try{
  if(a==='preset'){S.preset=b.dataset.p;S.range=presetRange(S.preset);return load()}
  if(a==='tab'){S.tab=b.dataset.t;try{sessionStorage.setItem('ittr_reports_tab',S.tab)}catch(_){}return applyTab()}
  if(a==='sort'){const cur=S.sort[b.dataset.table];S.sort[b.dataset.table]={key:b.dataset.key,dir:cur?.key===b.dataset.key?-cur.dir:-1};return render()}
  if(a==='csv')return downloadCsv(b.dataset.k);
  if(a==='print')return window.print();
  if(a==='save-tires'){const v=id=>$(id)?.value;await api('/api/finance/settings/tire-fees',{method:'PUT',body:{userFeeLabel:v('#tfsUserLabel'),userFee:v('#tfsUser'),userFeeRetainedPerTire:v('#tfsRetained'),disposalLabel:v('#tfsDispLabel'),disposalFee:v('#tfsDisp'),taxable:v('#tfsTax')==='yes'}});toast('Tire fee amounts saved.','success');return load()}
  if(a==='inbox-kind'){S.inbox.kind=b.dataset.k;return loadInbox()}
  if(a==='inbox-status'){S.inbox.status=b.dataset.k;return loadInbox()}
  if(a==='gmail-connect'){const d=await api('/api/gmail/connect',{method:'POST',body:{}});location.href=d.url;return}
  if(a==='gmail-disconnect'){if(!confirm('Disconnect this Gmail account? Saved Zelle/bill records stay, but ITTR stops reading new email.'))return;await api(`/api/gmail/accounts/${b.dataset.id}`,{method:'DELETE'});return loadInbox()}
  if(a==='gmail-sync'){b.disabled=true;b.textContent='Checking…';const d=await api('/api/gmail/sync',{method:'POST',body:{}});const added=d.results.reduce((x,r)=>x+(r.added||0),0),errs=d.results.filter(r=>r.error);toast(errs.length?`Gmail: ${errs.map(e=>`${e.email}: ${e.error}`).join('; ')}`:`Found ${added} new Zelle/bill email${added===1?'':'s'}.`,errs.length?'error':'success');return loadInbox()}
  if(a==='gmail-apply'){if(!confirm(`Record this Zelle payment on invoice ${b.dataset.num}?`))return;await api(`/api/gmail/messages/${b.dataset.id}/apply-payment`,{method:'POST',body:{invoiceId:Number(b.dataset.inv)}});toast('Payment recorded.','success');return loadInbox()}
  if(a==='gmail-apply-manual'){const num=prompt('Invoice number to apply this Zelle payment to (e.g. IT-2026-00012):');if(!num)return;const list=(await api('/api/invoices')).items||[];const hit=list.find(x=>String(x.invoice_number).toLowerCase()===num.trim().toLowerCase());if(!hit)return toast('Invoice not found.','error');await api(`/api/gmail/messages/${b.dataset.id}/apply-payment`,{method:'POST',body:{invoiceId:hit.id}});toast('Payment recorded.','success');return loadInbox()}
  if(a==='gmail-status'){await api(`/api/gmail/messages/${b.dataset.id}/status`,{method:'POST',body:{status:b.dataset.to}});return loadInbox()}
  if(a==='gmail-att')return gmailAttachment(b.dataset.id,b.dataset.i);
  if(a==='gmail-queries'){await api('/api/finance/settings/gmail-queries',{method:'PUT',body:{zelle:$('#gqZelle').value,vendor:$('#gqVendor').value}});toast('Gmail searches saved.','success');return}
 }catch(e){b.disabled=false;toast(e.message,'error');if(a==='gmail-sync')loadInbox()}
}
function onChange(ev){if(ev.target.id==='repFrom'||ev.target.id==='repTo'){const f=$('#repFrom').value,t=$('#repTo').value;if(f&&t){S.preset='';S.range={from:f,to:t};load()}}}
function onMove(ev){const tip=$('#repTip');if(!tip)return;const el=ev.target.closest?.('[data-tip]');if(!el){tip.style.display='none';return}
 tip.textContent=el.getAttribute('data-tip');tip.style.display='block';const w=tip.offsetWidth,hh=tip.offsetHeight;let x=ev.clientX+14,y=ev.clientY+14;if(x+w>innerWidth-8)x=ev.clientX-w-14;if(y+hh>innerHeight-8)y=ev.clientY-hh-14;tip.style.left=`${x}px`;tip.style.top=`${y}px`}
export async function mount(scope){
 S={...S,scope,data:null};
 try{const t=sessionStorage.getItem('ittr_reports_tab');if(t)S.tab=t}catch(_){}
 S.range=S.range||presetRange(S.preset);
 scope.on(scope.host,'click',onClick);scope.on(scope.host,'change',onChange);scope.on(scope.host,'mousemove',onMove,{passive:true});scope.on(scope.host,'mouseleave',()=>{const t=$('#repTip');if(t)t.style.display='none'});
 scope.on(scope.host,'ittr:module-refresh',()=>load(),{passive:true});
 let rt=0;scope.on(window,'resize',()=>{clearTimeout(rt);rt=setTimeout(drawCharts,120)},{passive:true});scope.on(window,'beforeprint',()=>{S.scope.host.querySelectorAll('.repPanel').forEach(p=>p.classList.add('active'));S.scope.host.querySelectorAll('[data-chart]').forEach(el=>el.dataset.w='');drawCharts()});scope.on(window,'afterprint',()=>applyTab());
 await load();
}
export async function afterShow(){if(!S.data)await load()}
export function unmount(){S.scope=null}
