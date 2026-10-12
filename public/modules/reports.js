// ITTR ShopFlow v24.42.0 Reports route module: accountant-ready finance reports, vendor bills by vendor, mechanic time clock + productivity, labor times, AI usage, Gmail money inbox.
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
function drawVbars({rows,series,stacked=true,height=230,fmt=usd,axis=compact,W=720}){
 const L=52,R=8,T=12,B=26,ph=height-T-B,pw=W-L-R,n=rows.length;
 const totals=rows.map(r=>stacked?series.reduce((a,s)=>a+Math.max(0,r[s.key]||0),0):Math.max(0,...series.map(s=>r[s.key]||0)));
 const max=niceMax(Math.max(...totals)),y=v=>T+ph-(v/max)*ph,slot=pw/n;
 const groupW=Math.min(56,slot*0.62),barW=stacked?groupW:Math.max(3,(groupW-2*(series.length-1))/series.length);
 let g='';for(let i=0;i<=4;i++){const v=max*i/4,yy=y(v);g+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="${i?'#eef0f3':'#d0d5dd'}" stroke-width="1"/><text x="${L-6}" y="${yy+4}" text-anchor="end">${axis(v)}</text>`}
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
 setTimeout(()=>{try{const t=S.scope?.host.querySelector('[data-rep="tab"].active'),bar=t?.parentElement;if(t&&bar)bar.scrollLeft=Math.max(0,t.offsetLeft-bar.offsetLeft-24)}catch(_){}},60);
 $('#repKpis').style.display=S.tab==='overview'?'':'none';
 if(S.tab==='inbox')loadInbox();
 if(S.tab==='mech')loadMech();
 if(S.tab==='clock')loadClock();
 if(S.tab==='labor')loadLabor();
 if(S.tab==='vendors')loadVendors();
 if(S.tab==='ai')loadAiUsage();
 requestAnimationFrame(drawCharts);
}

// ---------------------------------------------------------------- Mechanics productivity
const MK={repair:'var(--s1)',activity:'var(--s2)',break:'#98a2b3',idle:'var(--idle)'};
const hrs=ms=>`${(Number(ms||0)/3600000).toFixed(1)} h`;
const mins=ms=>{const m=Math.round(Number(ms||0)/60000);return m>=60?`${Math.floor(m/60)}h ${String(m%60).padStart(2,'0')}m`:`${m}m`};
const clock=(ms,tz)=>new Date(ms).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:tz});
const dayLabel=ymd=>new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
async function loadMech(){
 const box=$('#repMech');if(!box)return;const key=`${S.range.from}|${S.range.to}`;
 if(S.mech&&S.mechKey===key)return renderMech();
 box.innerHTML='<div class="repEmpty">Loading mechanic activity…</div>';
 try{S.mech=await api(`/api/reports/mechanics?from=${S.range.from}&to=${S.range.to}`);S.mechKey=key;if(!S.mech.mechanics.some(m=>m.username===S.mechSel))S.mechSel=S.mech.mechanics[0]?.username||'';renderMech()}
 catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
function splitBar(t){const total=Math.max(1,t.repairMs-t.overtimeMs+t.activityMs+t.breakMs+t.idleMs);const part=(k,ms,label)=>ms>0?`<span style="width:${ms/total*100}%;background:${MK[k]}" data-tip="${h(`${label}: ${mins(ms)}`)}"></span>`:'';
 return `<div class="mechBar">${part('repair',t.repairMs-t.overtimeMs,'Job work (timers + inspections)')}${part('activity',t.activityMs,'Other work')}${part('break',t.breakMs,'Break')}${part('idle',t.idleMs,'Idle / not recorded')}</div>`}
function timelineHtml(day,tz,range){
 const span=range.end-range.start,pos=ms=>Math.max(0,Math.min(100,(ms-range.start)/span*100));
 const segs=(day.segments||[]).filter(sg=>sg.end>range.start&&sg.start<range.end).map(sg=>{const k=sg.kind==='idle'?'idle':sg.kind;return `<span class="mechSeg" style="left:${pos(sg.start)}%;width:${Math.max(.3,pos(sg.end)-pos(sg.start))}%;background:${MK[k]}" data-tip="${h(`${clock(sg.start,tz)}–${clock(sg.end,tz)} · ${mins(sg.end-sg.start)}\n${sg.label}`)}"></span>`}).join('');
 const shift=(day.windows||(day.window?[day.window]:[])).map(w=>`<span class="mechShift" style="left:${pos(w.start)}%;width:${pos(w.end)-pos(w.start)}%"></span>`).join('');
 return `<div class="mechLane">${shift}${segs}</div>`;
}
function renderMech(){
 const d=S.mech,box=$('#repMech'),tz=d.settings.timezone,st=d.settings,owner=isOwner();
 if(!d.mechanics.length){box.innerHTML='<div class="repEmpty">No mechanic accounts found.</div>';return}
 const legendHtml=`<div class="repLegend"><span><i style="background:${MK.repair}"></i>Job work (task timers + inspections)</span><span><i style="background:${MK.activity}"></i>Other work (parts, yard, cleaning…)</span><span><i style="background:${MK.break}"></i>Break</span><span><i style="background:${MK.idle}"></i>Idle / nothing recorded</span></div>`;
 const sumCols=[{key:'display',label:'Mechanic'},{key:'daysWorked',label:'Days',num:true},{key:'repair',label:'Job work',num:true,fmt:v=>hrs(v)},{key:'activity',label:'Other work',num:true,fmt:v=>hrs(v)},{key:'break',label:'Break',num:true,fmt:v=>hrs(v)},{key:'idle',label:'Idle',num:true,html:r=>`<span class="${r.idlePct>=20?'repTag late':''}">${hrs(r.idle)}</span>`,csv:r=>(r.idle/3600000).toFixed(2)},{key:'utilizationPct',label:'On repairs',num:true,fmt:v=>`${v}%`},{key:'billedHours',label:'Billed hrs',num:true,fmt:v=>Number(v).toFixed(1)},{key:'efficiencyPct',label:'Billed ÷ clocked',num:true,fmt:v=>v==null?'—':`${v}%`},{key:'tasksCompleted',label:'Jobs done',num:true},{key:'inspections',label:'Inspections',num:true},{key:'longestIdle',label:'Longest idle',num:true,fmt:v=>v?mins(v):'—'},{key:'noActivityDays',label:'Days w/o any record',num:true},{key:'bar',label:'Shop day split',html:r=>splitBar(r.t),csv:()=>''}];
 const sumRows=d.mechanics.map(m=>{const t=m.totals;return {username:m.username,display:m.display,t,daysWorked:t.daysWorked,repair:t.repairMs,activity:t.activityMs,break:t.breakMs,idle:t.idleMs,idlePct:t.scheduledMs?Math.round(t.idleMs/t.scheduledMs*100):0,utilizationPct:t.utilizationPct,billedHours:t.billedHours,efficiencyPct:t.efficiencyPct,tasksCompleted:t.tasksCompleted,inspections:t.inspections||0,longestIdle:t.longestIdleMs,noActivityDays:t.noActivityDays,bar:0}});
 registerCsv('mechanics-summary',sumCols.filter(c=>c.key!=='bar'),sumRows);
 const m=d.mechanics.find(x=>x.username===S.mechSel)||d.mechanics[0],t=m.totals,worked=m.days.filter(x=>!x.noActivity);
 const dayCols=[{key:'date',label:'Day',fmt:v=>dayLabel(v)},{key:'clocked',label:'Clocked',html:r=>r.clockIn?`${clock(r.clockIn,tz)}–${clock(r.clockOut,tz)}`:'<span class="repTag">not clocked</span>',csv:r=>r.clockIn?`${clock(r.clockIn,tz)}-${clock(r.clockOut,tz)}`:''},{key:'scheduledMs',label:'Paid / shop time',num:true,fmt:v=>v?mins(v):'—'},{key:'first',label:'First record',fmt:v=>v?clock(v,tz):'—'},{key:'last',label:'Last record',fmt:v=>v?clock(v,tz):'—'},{key:'repairMs',label:'Job work',num:true,fmt:mins},{key:'activityMs',label:'Other work',num:true,fmt:mins},{key:'breakMs',label:'Break',num:true,fmt:mins},{key:'idleMs',label:'Idle',num:true,fmt:v=>v==null?'—':mins(v)},{key:'overtimeMs',label:'Off the clock',num:true,fmt:v=>v?mins(v):'—'},{key:'wos',label:'Work orders',html:r=>r.noActivity?'<span class="repTag late">No activity recorded</span>':h(r.wos),csv:r=>r.noActivity?'No activity recorded':r.wos}];
 const dayRows=[...m.days].reverse().map(x=>({...x,clocked:x.clockIn||0,first:x.firstEvent,last:x.lastEvent,wos:(x.workOrders||[]).map(w=>`#${w}`).join(', '),repairMs:x.repairMs||0,activityMs:x.activityMs||0,breakMs:x.breakMs||0,idleMs:x.noActivity?null:x.idleMs||0,overtimeMs:x.overtimeMs||0}));
 registerCsv('mechanic-days',dayCols,dayRows);
 const gaps=worked.flatMap(x=>(x.gaps||[]).map(g=>({...g,date:x.date}))).sort((a,b)=>b.minutes-a.minutes);
 const gapCols=[{key:'date',label:'Day',fmt:v=>dayLabel(v)},{key:'start',label:'From',fmt:v=>clock(v,tz)},{key:'end',label:'To',fmt:v=>clock(v,tz)},{key:'minutes',label:'Minutes',num:true},{key:'before',label:'Before the gap'},{key:'after',label:'After the gap'}];
 registerCsv('idle-gaps',gapCols,gaps);
 // Timeline: one lane per day, spanning shop hours widened to cover any early/late work.
 const lanes=worked.slice(-14).map(x=>{const ws=x.windows||(x.window?[x.window]:[]),lo=Math.min(x.firstEvent,...ws.map(w=>w.start)),hi=Math.max(x.lastEvent,...ws.map(w=>w.end));return {x,range:{start:lo,end:Math.max(hi,lo+3600000)}}});
 const act=Object.entries(t.byActivity||{}).map(([k,ms])=>({label:d.activityLabels[k]||k,value:ms/3600000,tip:`${d.activityLabels[k]||k}: ${mins(ms)}`}));
 const pauses=Object.entries(t.pauseReasons||{}).map(([k,n])=>({label:k,value:n,tip:`${k}: paused ${n} time${n===1?'':'s'}`}));
 box.innerHTML=`<div class="repNotice">Each day is measured from the mechanic's <b>clock-in to clock-out</b> (Time clock tab). Days without clock punches use shop hours (${h(st.start)}–${h(st.end)}, ${h(tz.replace('_',' '))}). The day is split into <b>job work</b> (task timers and vehicle inspections), <b>other work</b> (activities like getting parts or cleaning), <b>break</b>, and <b>idle</b> — time with nothing recorded. The first ${st.breakAllowanceMinutes} min of unrecorded time per day counts as lunch, not idle. Idle can also mean the mechanic forgot to press start.</div>
  ${card('Team summary','Click a mechanic to see their days, timeline and idle gaps.',legendHtml+table('mechsum',sumCols,sumRows,{rowAttr:r=>`data-mech="${h(r.username)}" class="${r.username===m.username?'mechSel':''}"`}),'mechanics-summary')}
  <div class="repKpis" style="grid-template-columns:repeat(6,minmax(0,1fr))">
   <div class="repKpi"><span>${h(m.display)} · on repairs</span><b>${t.utilizationPct}%</b><small>${hrs(t.repairMs)} on job timers of ${hrs(t.scheduledMs)} ${t.clockedDays?'paid':'shop'} time</small></div>
   <div class="repKpi"><span>Idle</span><b>${hrs(t.idleMs)}</b><small>${t.gaps} gap${t.gaps===1?'':'s'} ≥ ${st.idleGapMinutes} min</small></div>
   <div class="repKpi"><span>Other work</span><b>${hrs(t.activityMs)}</b><small>break ${hrs(t.breakMs)}</small></div>
   <div class="repKpi"><span>Billed hours</span><b>${Number(t.billedHours).toFixed(1)}</b><small>${t.efficiencyPct==null?'no billed labor yet':`${t.efficiencyPct}% of clocked time`}</small></div>
   <div class="repKpi"><span>Jobs finished</span><b>${t.tasksCompleted}</b><small>${t.workOrders} work order${t.workOrders===1?'':'s'} · ${t.inspections||0} inspection${t.inspections===1?'':'s'} (${hrs(t.inspectionMs||0)})</small></div>
   <div class="repKpi"><span>Job time off the clock</span><b>${hrs(t.overtimeMs)}</b><small>${t.noActivityDays} shop day${t.noActivityDays===1?'':'s'} with no record</small></div></div>
  ${card(`${m.display} — day by day`,`Timeline of the last ${lanes.length} day${lanes.length===1?'':'s'} with records. Hover a block for details; the light band is the clocked shift (or shop hours).`,legendHtml+(lanes.length?`<div class="mechTimeline">${lanes.map(l=>`<div class="mechRow"><div class="mechDay">${dayLabel(l.x.date)}<small>${clock(l.range.start,tz)} – ${clock(l.range.end,tz)}</small></div>${timelineHtml(l.x,tz,l.range)}</div>`).join('')}</div>`:'<div class="repEmpty">No recorded activity in this range.</div>')+'<div style="height:12px"></div>'+table('mechdays',dayCols,dayRows,{empty:'No shop days in this range.'}),'mechanic-days')}
  <div class="repGrid"><div>${card('Idle gaps',`Stretches of ${st.idleGapMinutes}+ minutes inside shop hours with nothing recorded, longest first.`,table('gaps',gapCols,gaps,{empty:'No idle gaps. 👍'}),'idle-gaps')}</div>
  <div>${card('Other work breakdown','Time logged with the Current Activity buttons.',hbars(act,{fmt:v=>`${v.toFixed(1)} h`,color:MK.activity}))}${card('Why jobs were paused','Reasons picked when pausing a task timer.',hbars(pauses,{fmt:v=>`${v}×`,color:'var(--q3)'}))}</div></div>
  ${owner?card('Shop hours used for this report','Change these if your shop opens, closes or takes lunch at different times.',`<div class="repForm">
   <div class="field"><label>Opens</label><input id="shOpen" type="time" value="${h(st.start)}"></div><div class="field"><label>Closes</label><input id="shClose" type="time" value="${h(st.end)}"></div>
   <div class="field"><label>Time zone</label><select id="shTz">${['America/Chicago','America/New_York','America/Denver','America/Los_Angeles','Europe/Kyiv'].map(z=>`<option ${z===tz?'selected':''}>${z}</option>`).join('')}</select></div>
   <div class="field"><label>Lunch allowance (min, not counted as idle)</label><input id="shLunch" type="number" min="0" max="180" value="${st.breakAllowanceMinutes}"></div>
   <div class="field"><label>Report idle gaps longer than (min)</label><input id="shGap" type="number" min="5" max="240" value="${st.idleGapMinutes}"></div>
   <div class="field"><label>Work days</label><div class="mechDays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((n,i)=>`<label><input type="checkbox" data-wd="${i}" ${st.workdays.includes(i)?'checked':''}> ${n}</label>`).join('')}</div></div>
   </div><div style="display:flex;justify-content:flex-end;margin-top:10px"><button data-rep="save-hours">Save shop hours</button></div>`):''}`;
}
// ---------------------------------------------------------------- Time clock (timesheets)
const fmtHM=ms=>{const m=Math.max(0,Math.round(Number(ms||0)/60000));return `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`};
// Punch times are shown and edited in the shop's time zone, whatever the viewer's device is set to.
const shopTz=()=>S.clock?.settings?.timezone||'America/Chicago';
const dt=v=>v?new Date(v).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:shopTz()}):'—';
const tzParts=(ms,tz)=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
const localInput=v=>{if(!v)return '';const p=tzParts(new Date(v).getTime(),shopTz());return `${p.year}-${p.month}-${p.day}T${p.hour==='24'?'00':p.hour}:${p.minute}`};
const fromShopInput=v=>{if(!v)return '';const [d,t]=v.split('T'),[y,m,dd]=d.split('-').map(Number),[H,M]=t.split(':').map(Number),guess=Date.UTC(y,m-1,dd,H,M);const off=ms=>{const p=tzParts(ms,shopTz());return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour%24,+p.minute)-ms};let x=guess-off(guess);x=guess-off(x);return new Date(x).toISOString()};
const FLAG={auto_in:['Auto clock-in','bill'],forgot_out:['Forgot to clock out','late'],edited:['Edited','out'],open:['Clocked in now','in']};
async function loadClock(){
 const box=$('#repClock');if(!box)return;const key=`${S.range.from}|${S.range.to}`;
 if(S.clock&&S.clockKey===key)return renderClock();
 box.innerHTML='<div class="repEmpty">Loading timesheets…</div>';
 try{S.clock=await api(`/api/timeclock/timesheet?from=${S.range.from}&to=${S.range.to}`);S.clockKey=key;renderClock()}catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
function renderClock(){
 const d=S.clock,box=$('#repClock'),owner=isOwner(),st=d.settings,ms=d.mechanics;
 const tot=ms.reduce((a,m)=>({paid:a.paid+m.totals.paidMs,ot:a.ot+m.totals.overtimeMs,flag:a.flag+m.flagged,open:a.open+m.shifts.filter(s=>s.open).length}),{paid:0,ot:0,flag:0,open:0});
 const allWeeks=[...new Set(ms.flatMap(m=>m.weeks.map(w=>w.weekStart)))].sort(),worked=allWeeks.filter(w=>ms.some(m=>m.weeks.some(x=>x.weekStart===w&&x.paidMs>0))),weeks=(worked.length?worked:allWeeks).slice(-8);
 const wkLabel=w=>`Week of ${new Date(`${w}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;
 const wkColsFor=list=>[{key:'display',label:'Mechanic'},...list.map(w=>({key:w,label:wkLabel(w),num:true,html:r=>{const x=r.byWeek[w];return x?`${fmtHM(x.paidMs)}${x.overtimeMs?` <span class="repTag late">OT ${fmtHM(x.overtimeMs)}</span>`:''}`:'—'},csv:r=>((r.byWeek[w]?.paidMs||0)/3600000).toFixed(2),sortVal:r=>r.byWeek[w]?.paidMs||0})),
  {key:'paid',label:'Total hours',num:true,fmt:v=>fmtHM(v),csv:r=>(r.paid/3600000).toFixed(2)},{key:'ot',label:'Overtime',num:true,fmt:v=>v?fmtHM(v):'—',csv:r=>(r.ot/3600000).toFixed(2)},{key:'days',label:'Days worked',num:true},{key:'flagged',label:'Needs a look',num:true,html:r=>r.flagged?`<span class="repTag late">${r.flagged}</span>`:'—',csv:r=>r.flagged}];
 const wkCols=wkColsFor(weeks);
 const wkRows=ms.map(m=>({username:m.username,display:m.display,byWeek:Object.fromEntries(m.weeks.map(w=>[w.weekStart,w])),paid:m.totals.paidMs,ot:m.totals.overtimeMs,days:m.totals.daysWorked,flagged:m.flagged}));
 registerCsv('timesheet-weeks',wkColsFor(allWeeks),wkRows);
 const sel=ms.find(m=>m.username===S.clockSel)||[...ms].sort((a,b)=>b.totals.paidMs-a.totals.paidMs)[0];
 const days=sel?sel.days.filter(x=>x.paidMs>0).reverse():[];
 const dayCols=[{key:'date',label:'Day',fmt:v=>dayLabel(v)},{key:'paidMs',label:'Hours',num:true,fmt:fmtHM,csv:r=>(r.paidMs/3600000).toFixed(2)},{key:'shifts',label:'Punches',num:true}];
 registerCsv('timesheet-days',dayCols,days);
 const shifts=ms.flatMap(m=>m.shifts.map(s=>({...s,display:m.display}))).filter(s=>!S.clockSel||s.username===S.clockSel).reverse();
 const shCols=[{key:'display',label:'Mechanic'},{key:'clockIn',label:'Clock in',fmt:dt},{key:'clockOut',label:'Clock out',html:r=>r.open?'<span class="repTag in">still clocked in</span>':h(dt(r.clockOut)),csv:r=>r.clockOut||''},{key:'durationMs',label:'Hours',num:true,fmt:fmtHM,csv:r=>(r.durationMs/3600000).toFixed(2)},
  {key:'flags',label:'Notes',html:r=>[...r.flags.map(f=>`<span class="repTag ${FLAG[f]?.[1]||''}">${h(FLAG[f]?.[0]||f)}</span>`),r.outNote&&!r.flags.includes('forgot_out')?h(r.outNote):''].join(' '),csv:r=>r.flags.map(f=>FLAG[f]?.[0]||f).join('; ')},
  {key:'acts',label:'',html:r=>`<span class="repNoPrint" style="white-space:nowrap">${owner?`<button class="secondary" data-rep="shift-edit" data-id="${r.id}">Edit</button> <button class="secondary" data-rep="shift-del" data-id="${r.id}">Delete</button> `:''}${r.edits?`<button class="secondary" data-rep="shift-hist" data-id="${r.id}">History</button>`:''}</span>`,csv:()=>''}];
 registerCsv('timesheet-shifts',shCols.filter(c=>c.key!=='acts'),shifts);
 box.innerHTML=`<div class="repNotice">Mechanics press <b>Clock In</b> / <b>Clock Out</b> on their My Work Orders screen. ${st.autoClockIn?'If a mechanic starts a job timer or an activity while clocked out, they are clocked in automatically (marked <b>Auto clock-in</b>).':''} A shift left open longer than ${st.maxShiftHours} h is closed at their last recorded work (or shop closing time) and marked <b>Forgot to clock out</b>. Clocking out pauses any running job timer. Overtime counts after ${st.weeklyOvertimeHours} h per week.</div>
 <div class="repKpis" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="repKpi"><span>Hours worked</span><b>${fmtHM(tot.paid)}</b><small>all mechanics, this range</small></div><div class="repKpi"><span>Overtime</span><b>${fmtHM(tot.ot)}</b><small>over ${st.weeklyOvertimeHours} h a week</small></div><div class="repKpi"><span>Clocked in now</span><b>${tot.open}</b><small>${ms.filter(m=>m.shifts.some(s=>s.open)).map(m=>h(m.display)).join(', ')||'nobody'}</small></div><div class="repKpi"><span>Shifts to check</span><b>${tot.flag}</b><small class="${tot.flag?'bad':''}">auto clock-in or forgot to clock out</small></div></div>
 ${card('Hours by week',`Paid time from clock-in to clock-out${allWeeks.length>weeks.length?`, latest ${weeks.length} weeks with hours (Export CSV has every week)`:''}. Click a mechanic to filter the days and punches below.`,table('clockweeks',wkCols,wkRows,{rowAttr:r=>`data-clock="${h(r.username)}" class="${r.username===S.clockSel?'mechSel':''}"`,empty:'No mechanics.'}),'timesheet-weeks')}
 <div class="repGrid"><div>${card(`Punches${S.clockSel&&sel?` · ${sel.display}`:''}`,'Every clock-in and clock-out. Edits and deletions need a reason and are kept in the history.',(owner?'<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px" class="repNoPrint">'+(S.clockSel?'<button class="secondary" data-rep="clock-all">Show everyone</button>':'')+'<button data-rep="shift-add">+ Add missed shift</button></div>':'')+table('clockshifts',shCols,shifts,{empty:'No punches in this range.'}),'timesheet-shifts')}</div>
 <div>${sel?card(`${sel.display} · day by day`,'Hours per day in this range.',table('clockdays',dayCols,days,{empty:'No hours in this range.'}),'timesheet-days'):''}
 ${owner?card('Time clock settings','',`<div class="repForm" style="grid-template-columns:1fr 1fr">
  <div class="field"><label>Auto clock-in when a job or activity starts</label><select id="tcAuto"><option value="yes" ${st.autoClockIn?'selected':''}>Yes</option><option value="no" ${!st.autoClockIn?'selected':''}>No</option></select></div>
  <div class="field"><label>Overtime after (hours / week)</label><input id="tcOt" type="number" min="0" max="80" value="${st.weeklyOvertimeHours}"></div>
  <div class="field"><label>Week starts on</label><select id="tcWeek"><option value="1" ${st.weekStartsOn===1?'selected':''}>Monday</option><option value="0" ${st.weekStartsOn===0?'selected':''}>Sunday</option></select></div>
  <div class="field"><label>Close a forgotten shift after (hours)</label><input id="tcMax" type="number" min="6" max="24" value="${st.maxShiftHours}"></div></div>
  <div style="display:flex;justify-content:flex-end;margin-top:10px"><button data-rep="clock-settings">Save</button></div>`):''}</div></div>`;
}
function repModal(html){const m=document.createElement('div');m.className='repModal';m.innerHTML=`<div>${html}</div>`;m.addEventListener('click',e=>{if(e.target===m||e.target.closest('[data-close]'))m.remove()});document.body.appendChild(m);return m}
function shiftForm(s){const ms=S.clock.mechanics,m=repModal(`<h2 style="margin-top:0">${s?'Edit shift':'Add missed shift'}</h2>
 <div class="repForm" style="grid-template-columns:1fr 1fr">${s?`<div class="field" style="grid-column:1/-1"><label>Mechanic</label><b>${h(ms.find(x=>x.username===s.username)?.display||s.username)}</b></div>`:`<div class="field" style="grid-column:1/-1"><label>Mechanic</label><select id="sfUser">${ms.map(x=>`<option value="${h(x.username)}" ${x.username===S.clockSel?'selected':''}>${h(x.display)}</option>`).join('')}</select></div>`}
 <div class="field" style="grid-column:1/-1"><small class="muted">Times are in shop time (${h(shopTz().replace('_',' '))}).</small></div><div class="field"><label>Clock in</label><input id="sfIn" type="datetime-local" value="${localInput(s?.clockIn)}"></div><div class="field"><label>Clock out ${s?.open?'(leave empty to keep clocked in)':''}</label><input id="sfOut" type="datetime-local" value="${localInput(s?.clockOut)}"></div>
 <div class="field" style="grid-column:1/-1"><label>Reason (kept in the history)</label><input id="sfReason" placeholder="e.g. forgot to clock out, left at 4:30"></div></div>
 <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="secondary" data-close>Cancel</button><button id="sfSave">Save</button></div>`);
 m.querySelector('#sfSave').onclick=async()=>{const v=id=>m.querySelector(id)?.value||'',iso=fromShopInput;
  try{const body={clockIn:iso(v('#sfIn')),clockOut:iso(v('#sfOut'))||null,reason:v('#sfReason')};
   if(s)await api(`/api/timeclock/shifts/${s.id}`,{method:'PUT',body});else await api('/api/timeclock/shifts',{method:'POST',body:{...body,username:v('#sfUser')}});
   m.remove();toast('Timesheet updated.','success');S.clock=null;S.mech=null;loadClock()}catch(e){toast(e.message,'error')}}}
// ---------------------------------------------------------------- Labor times
const hh=v=>v==null?'—':`${Number(v).toFixed(1)} h`;
const pctTag=p=>p==null?'—':`<span class="repTag ${p<=-10?'ok':p>=15?'late':''}">${p>0?'+':''}${p}%</span>`;
async function loadLabor(){
 const box=$('#repLabor');if(!box)return;const key=`${S.range.from}|${S.range.to}|${S.laborSrc||'all'}`;
 if(S.labor&&S.laborKey===key)return renderLabor();
 box.innerHTML='<div class="repEmpty">Analyzing labor lines…</div>';
 try{S.labor=await api(`/api/reports/labor-times?from=${S.range.from}&to=${S.range.to}&source=${S.laborSrc||'all'}`);S.laborKey=key;renderLabor()}catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
function renderLabor(){
 const d=S.labor,box=$('#repLabor'),owner=isOwner(),types=d.types.filter(t=>t.n),tl=Object.fromEntries(d.types.map(t=>[t.key,t.label]));
 const typeCols=[{key:'label',label:'Job type'},{key:'n',label:'Jobs',num:true},{key:'median',label:'Typical billed',num:true,fmt:hh,sortVal:r=>r.billed?.median||0},{key:'range',label:'Usual range',html:r=>r.billed?.n?`${hh(r.billed.p25)} – ${hh(r.billed.p75)}`:'—',csv:r=>r.billed?.n?`${r.billed.p25}-${r.billed.p75}`:''},{key:'actual',label:'Real time (timers)',num:true,fmt:hh,sortVal:r=>r.actual?.median||0},{key:'standard',label:'Standard used',num:true,html:r=>`${hh(r.standard)} <span class="repTag ${r.standardSource==='book'?'bill':''}">${r.standardSource==='book'?'set by you':r.standardSource==='billed'?'from invoices':'from timers'}</span>`,csv:r=>r.standard}];
 const typeRows=types.map(t=>({...t,median:t.billed?.median,actual:t.actual?.median}));
 registerCsv('labor-types',typeCols,typeRows);
 const topTypes=[...types].sort((a,b)=>b.n-a.n).slice(0,8).map(t=>t.key);
 const people=d.mechanics;
 const cell=(m,k)=>d.cells.find(c=>c.mechanic===m&&c.type===k);
 const effTag=v=>v==null?'—':`<span class="repTag ${v>=100?'ok':v<85?'late':''}">${v}%</span>`;
 const mxCols=[{key:'name',label:'Mechanic'},{key:'pct',label:'Speed vs shop',num:true,html:r=>pctTag(r.pct),csv:r=>r.pct},{key:'billedEff',label:'Billed ÷ real',num:true,html:r=>effTag(r.billedEff),csv:r=>r.billedEff??''},{key:'jobs',label:'Jobs',num:true},...topTypes.map(k=>({key:k,label:tl[k],num:true,html:r=>{const c=cell(r.mechanic,k);return c?`<span data-tip="${h(`${r.name} · ${tl[k]}: ${c.n} job${c.n===1?'':'s'}, median ${c.median} h`)}">${hh(c.median)} ${pctTag(c.pct)}</span>`:'—'},csv:r=>cell(r.mechanic,k)?.median??'',sortVal:r=>cell(r.mechanic,k)?.ratio??99}))];
 registerCsv('labor-mechanics',mxCols,people);
 const sel=S.laborType&&d.types.find(t=>t.key===S.laborType);
 const selCells=sel?d.cells.filter(c=>c.type===sel.key).sort((a,b)=>a.ratio-b.ratio):[];
 const uncCols=[{key:'text',label:'Description'},{key:'n',label:'Jobs',num:true},{key:'hours',label:'Hours',num:true,fmt:v=>Number(v).toFixed(1)}];
 registerCsv('labor-uncategorized',uncCols,d.uncategorized);
 box.innerHTML=`<div class="repNotice">Every labor line on your invoices${d.totals.fullbay?' and imported Fullbay history':''} is sorted into a <b>job type</b> by keywords. <b>Typical billed</b> is the median hours charged, and <b>usual range</b> is the middle half of jobs. Mechanics are compared on <b>real time from task timers</b> with how long the same job usually takes in your shop: <span class="repTag ok">−20%</span> means faster than usual, <span class="repTag late">+30%</span> slower. <b>Billed ÷ real</b> shows whether the hours you charge cover the time spent (over 100% = billed more than it took). Jobs shared by two mechanics count for the team, not one person. Fullbay history is compared only with other Fullbay jobs.</div>
 <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px" class="repRange repNoPrint">${[['all','All sources'],['shopflow','ShopFlow only'],['fullbay','Fullbay history only']].map(([k,l])=>`<button data-rep="labor-src" data-k="${k}" class="${(S.laborSrc||'all')===k?'active':''}">${l}</button>`).join('')}</div>
 <div class="repKpis" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="repKpi"><span>Labor jobs analyzed</span><b>${d.totals.jobs}</b><small>${S.range.from} → ${S.range.to}</small></div><div class="repKpi"><span>Sorted into a job type</span><b>${d.totals.jobs?Math.round(d.totals.categorized/d.totals.jobs*100):0}%</b><small>${d.totals.jobs-d.totals.categorized} not recognized</small></div><div class="repKpi"><span>With real timer hours</span><b>${d.totals.withTimer}</b><small>used to compare mechanics</small></div><div class="repKpi"><span>From Fullbay history</span><b>${d.totals.fullbay}</b><small>billed hours only</small></div></div>
 ${card('How long each job takes','Click a job type to see each mechanic and every job behind the numbers.',table('labortypes',typeCols,typeRows,{rowAttr:r=>`data-ltype="${h(r.key)}" class="${r.key===S.laborType?'mechSel':''}" style="cursor:pointer"`,empty:'No labor lines in this range. Try a longer range or include Fullbay history.'}),'labor-types')}
 ${sel?card(`${sel.label} · by mechanic`,`Usually takes ${hh(sel.peerTimer??sel.actual?.median)} of real time in your shop; billed ${hh(sel.billed?.median)}. Each mechanic's median real time, faster first.`,(selCells.length?selCells.map(c=>`<div class="repHbar" data-tip="${h(`${c.name}: ${c.n} job${c.n===1?'':'s'}, median ${c.median} h (${c.pct>0?'+':''}${c.pct}%)`)}"><span class="lbl">${h(c.name)} <small class="muted">· ${c.n} job${c.n===1?'':'s'}</small></span><span class="trk"><span class="bar" style="display:block;width:${Math.min(100,c.median/Math.max(...selCells.map(x=>x.median))*100)}%;background:${c.pct<=-10?'#17b26a':c.pct>=15?'#f04438':'var(--s1)'}"></span></span><span>${hh(c.median)} ${pctTag(c.pct)}${c.billedEff!=null?` <span class="muted" style="font-size:12px">billed ${c.billedEff}%</span>`:''}</span></div>`).join(''):'<div class="repEmpty">No single-mechanic jobs with timer hours yet.</div>')+`<div style="height:12px"></div><div id="laborJobs"><div class="repEmpty">Loading jobs…</div></div>`):''}
 ${card('Mechanics by job type','Median real time per job type and how it compares with the shop. Speed vs shop = all their jobs together.',table('labormx',mxCols,people,{empty:'No mechanic has finished a timed job of a known type in this range yet.'}),'labor-mechanics')}
 ${card('Not recognized yet','Labor descriptions that matched no job type. Add a keyword in the editor below so they are counted.',table('laborunc',uncCols,d.uncategorized,{empty:'Every job was recognized. 👍',max:15}),'labor-uncategorized')}
 ${owner?card('Job types and standard times','Keywords are matched against the job name and description (use * at the end to match word endings, e.g. lubricat*). The first type that matches wins, so specific jobs go first. Leave Standard empty to learn it from your invoices.','<div id="laborEditor"><button data-rep="labor-edit">Edit job types</button></div>'):''}`;
 if(sel)loadLaborJobs(sel.key);
}
async function loadLaborJobs(type){const box=$('#laborJobs');if(!box)return;
 try{const d=await api(`/api/reports/labor-times/jobs?from=${S.range.from}&to=${S.range.to}&source=${S.laborSrc||'all'}&type=${encodeURIComponent(type)}`);
  const cols=[{key:'date',label:'Date',fmt:v=>day(v)},{key:'ref',label:'Job'},{key:'unit',label:'Unit'},{key:'mechanicName',label:'Mechanic'},{key:'billed',label:'Billed',num:true,fmt:hh},{key:'actual',label:'Real (timer)',num:true,fmt:hh},{key:'text',label:'Description',html:r=>`<span title="${h(r.text)}">${h(String(r.text||'').slice(0,90))}</span>`}];
  registerCsv('labor-jobs',cols,d.items);box.innerHTML=`<div class="repCardHead"><div class="sub">${d.items.length} job${d.items.length===1?'':'s'}</div><button data-rep="csv" data-k="labor-jobs">Export CSV</button></div>`+table('laborjobs',cols,d.items,{empty:'No jobs.',max:150})}catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}}
async function openLaborEditor(prefill=''){const box=$('#laborEditor');if(!box)return;const d=await api('/api/reports/labor-times/job-types');S.jobTypes=d.types.map(t=>({...t}));if(prefill)S.jobTypes.unshift({key:'',label:'',keywords:[prefill],bookHours:null});paintLaborEditor()}
function paintLaborEditor(){const box=$('#laborEditor');if(!box)return;
 box.innerHTML=`<div class="repScroll"><table class="repTable"><thead><tr><th>#</th><th>Job type</th><th>Keywords (comma separated)</th><th class="n">Standard h</th><th>On</th><th></th></tr></thead><tbody>${S.jobTypes.map((t,i)=>`<tr><td>${i+1}</td><td><input data-jt="label" data-i="${i}" value="${h(t.label)}" style="min-width:150px"></td><td><input data-jt="keywords" data-i="${i}" value="${h((t.keywords||[]).join(', '))}" style="min-width:320px"></td><td><input data-jt="bookHours" data-i="${i}" type="number" step="0.1" min="0" value="${t.bookHours??''}" placeholder="auto" style="width:80px"></td><td><input type="checkbox" data-jt="on" data-i="${i}" ${t.disabled?'':'checked'}></td><td style="white-space:nowrap"><button class="secondary" data-rep="jt-up" data-i="${i}" title="Move up">↑</button> <button class="secondary" data-rep="jt-del" data-i="${i}">Remove</button></td></tr>`).join('')}</tbody></table></div>
 <div style="display:flex;justify-content:space-between;gap:8px;margin-top:10px;flex-wrap:wrap"><div><button class="secondary" data-rep="jt-add">+ Add job type</button> <button class="secondary" data-rep="jt-reset">Reset to defaults</button></div><button data-rep="jt-save">Save job types</button></div>`}
function readLaborEditor(){S.scope.host.querySelectorAll('[data-jt]').forEach(el=>{const t=S.jobTypes[Number(el.dataset.i)];if(!t)return;const k=el.dataset.jt;if(k==='keywords')t.keywords=el.value.split(',').map(x=>x.trim()).filter(Boolean);else if(k==='on')t.disabled=!el.checked;else if(k==='bookHours')t.bookHours=el.value===''?null:Number(el.value);else t.label=el.value})}
// ---------------------------------------------------------------- Vendors (v24.42.0): bills by vendor + analysis
async function loadVendors(force=false){
 const box=$('#repVendors');if(!box)return;const key=`${S.range.from}|${S.range.to}`;
 if(!force&&S.vend&&S.vendKey===key)return renderVendors();
 box.innerHTML='<div class="repEmpty">Loading vendor bills…</div>';
 try{S.vend=await api(`/api/vendor-invoices/analysis?from=${S.range.from}&to=${S.range.to}`);S.vendKey=key;S.vendBills=null;renderVendors();if(S.vendSel)loadVendorBills()}
 catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
const pctUp=v=>`<span class="repTag late">+${Number(v).toFixed(1)}%</span>`;
function vendorQueueHtml(){
 const q=S.vbQueue||[];if(!q.length)return '';
 return card('Scanned bills — check and save',`AI read ${q.length} bill${q.length===1?'':'s'}. Check the vendor, number, date and total, then save. Nothing is saved until you click Save.`,q.map((x,i)=>{
  if(x.status==='scanning')return `<div class="repMsg"><div><b>${h(x.name)}</b><div class="meta">Reading with AI…</div></div></div>`;
  if(x.status==='error')return `<div class="repMsg"><div><b>${h(x.name)}</b><div class="meta" style="color:#b42318">${h(x.error)}</div></div><div class="acts"><button class="secondary" data-rep="vbq-drop" data-i="${i}">Remove</button></div></div>`;
  if(x.status==='saved')return `<div class="repMsg"><div><span class="repTag ok">Saved</span> <b>${h(x.draft.invoice.vendor)}</b> · #${h(x.draft.invoice.invoiceNumber||'—')} · ${usd(x.draft.invoice.total)}</div></div>`;
  const d=x.draft,inv=d.invoice,warn=[...(d.mathProblems||[]).map(p=>p.message),...(d.alreadyFiled?[`This vendor and invoice number are already saved (${d.alreadyFiled.status}).`]:[])];
  return `<div class="repMsg" style="grid-template-columns:1fr"><div><b>${h(x.name)}</b> <span class="muted">· ${d.lines.length} line${d.lines.length===1?'':'s'}${d.gmailMessageId?' · from Gmail':''}</span></div>
   <div class="repForm vbqForm">
    <div class="field vbqVendor"><label>Vendor</label><input data-vbq="vendor" data-i="${i}" value="${h(inv.vendor)}" list="vbVendorList"></div>
    <div class="field"><label>Invoice #</label><input data-vbq="invoiceNumber" data-i="${i}" value="${h(inv.invoiceNumber)}"></div>
    <div class="field"><label>Date</label><input type="date" data-vbq="invoiceDate" data-i="${i}" value="${h(inv.invoiceDate)}"></div>
    <div class="field"><label>Due</label><input type="date" data-vbq="dueDate" data-i="${i}" value="${h(inv.dueDate)}"></div>
    <div class="field"><label>Total $</label><input type="number" step="0.01" data-vbq="total" data-i="${i}" value="${Number(inv.total||0)}"></div>
   </div>
   ${warn.length?`<div class="repNotice warn" style="margin:8px 0 0">${warn.map(h).join('<br>')}</div>`:''}
   ${d.lines.length?`<details style="margin-top:6px"><summary class="muted">Lines</summary>${table('vbq'+i,[{key:'partNumber',label:'Part #'},{key:'description',label:'Description'},{key:'quantity',label:'Qty',num:true},{key:'unitCost',label:'Unit',num:true,fmt:usd},{key:'lineTotal',label:'Total',num:true,fmt:usd}],d.lines)}</details>`:''}
   <div class="acts"><button data-rep="vbq-save" data-i="${i}">Save bill</button><button class="secondary" data-rep="vbq-drop" data-i="${i}">Discard</button></div></div>`}).join(''));
}
function renderVendors(){
 const d=S.vend,box=$('#repVendors');if(!d||!box)return;const t=d.totals,al=d.alerts;
 const vCols=[{key:'vendor',label:'Vendor'},{key:'bills',label:'Bills',num:true},{key:'total',label:'Spend',num:true,fmt:usd},{key:'share',label:'Share',num:true,fmt:v=>`${v}%`},{key:'avgBill',label:'Avg bill',num:true,fmt:usd},{key:'lastBill',label:'Last bill',fmt:v=>day(v)},{key:'unpaid',label:'Unpaid',num:true,fmt:usd},{key:'overdue',label:'Overdue',num:true,html:r=>r.overdue>0?`<span class="repTag late">${usd(r.overdue)}</span>`:'—',csv:r=>r.overdue},{key:'coresValue',label:'Cores owed',num:true,fmt:usd},{key:'priceIncreases',label:'Price ↑',num:true,html:r=>r.priceIncreases?`<span class="repTag late">${r.priceIncreases}</span>`:'—',csv:r=>r.priceIncreases}];
 registerCsv('vendors',vCols,d.vendors);
 const piCols=[{key:'vendor',label:'Vendor'},{key:'partNumber',label:'Part #'},{key:'description',label:'Description'},{key:'oldCost',label:'Was',num:true,fmt:usd},{key:'newCost',label:'Now',num:true,fmt:usd},{key:'pct',label:'Change',num:true,html:r=>pctUp(r.pct),csv:r=>r.pct},{key:'newDate',label:'Bill date',fmt:v=>day(v)},{key:'extra',label:'Extra paid',num:true,fmt:usd}];
 const ceCols=[{key:'partNumber',label:'Part #'},{key:'description',label:'Description'},{key:'vendor',label:'Bought at'},{key:'cost',label:'Paid',num:true,fmt:usd},{key:'cheaperVendor',label:'Cheaper at'},{key:'cheaperCost',label:'Price there',num:true,fmt:usd},{key:'cheaperDate',label:'On',fmt:v=>day(v)},{key:'savings',label:'Could save',num:true,fmt:usd}];
 const upCols=[{key:'vendor',label:'Vendor'},{key:'invoiceNumber',label:'Invoice #'},{key:'dueDate',label:'Due',fmt:v=>day(v)},{key:'daysLate',label:'Days late',num:true},{key:'total',label:'Amount',num:true,fmt:usd}];
 registerCsv('vendor-price-increases',piCols,al.priceIncreases);registerCsv('vendor-cheaper',ceCols,al.cheaperElsewhere);registerCsv('vendor-unpaid',upCols,al.unpaidPastDue);
 const checks=al.priceIncreases.length+al.cheaperElsewhere.length+al.mathProblems.length+al.duplicates.length+al.unpaidPastDue.length+al.coresPastDue.length;
 box.innerHTML=`<div class="repNotice">Every vendor bill in one place, <b>separated by vendor</b>: parts you received with Smart Receiving, bills you upload here (AI reads them) and vendor-bill emails from Gmail (<b>Money inbox → Vendor bills → Scan &amp; file</b>). ShopFlow then checks for price increases, parts that were cheaper at another vendor, bills whose numbers don't add up, possible double bills, bills past due and cores to return.</div>
  <div class="repNoPrint" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><label class="button" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;background:#2563eb;color:#fff;border-radius:10px;padding:9px 14px;font-weight:700">+ Add vendor bills (PDF / photo)<input type="file" id="vbFiles" accept="application/pdf,image/*" multiple hidden></label><button class="secondary" data-rep="vb-ai">✦ AI summary</button><input id="vbSearch" placeholder="Search bills: invoice #, part #, description" value="${h(S.vendQ||'')}" style="flex:1;min-width:200px"></div>
  <datalist id="vbVendorList">${d.vendors.map(v=>`<option value="${h(v.vendor)}">`).join('')}</datalist>
  ${vendorQueueHtml()}
  <div id="vbAiOut"></div>
  <div class="repKpis"><div class="repKpi"><span>Spent with vendors</span><b>${usd0(t.spend)}</b><small>${t.bills} bill${t.bills===1?'':'s'} · ${t.vendors} vendor${t.vendors===1?'':'s'}</small></div>
   <div class="repKpi" title="Bills you added here, and received bills once they have a due date. Mark a bill paid from its details."><span>Owed to vendors</span><b>${usd0(t.unpaid)}</b><small class="${t.overdue>0?'bad':''}">${t.overdue>0?`${usd0(t.overdue)} overdue`:'nothing overdue'}</small></div>
   <div class="repKpi"><span>Cores to return</span><b>${usd0(t.coresValue)}</b><small>${al.coresPastDue.length?`${al.coresPastDue.length} past due`:'credit waiting'}</small></div>
   <div class="repKpi"><span>Price increases</span><b>${al.priceIncreases.length}</b><small>${usd0(t.priceIncreaseCost)} extra paid</small></div>
   <div class="repKpi"><span>Cheaper elsewhere</span><b>${usd0(t.possibleSavings)}</b><small>${al.cheaperElsewhere.length} part${al.cheaperElsewhere.length===1?'':'s'}</small></div>
   <div class="repKpi"><span>Bills to check</span><b>${al.mathProblems.length+al.duplicates.length}</b><small>math or possible duplicate</small></div></div>
  <div class="repGrid">${card('Spending by vendor','Click a vendor in the table to see its bills and top parts.',hbars(d.vendors.slice(0,12).map(v=>({label:v.vendor,value:v.total,tip:`${v.vendor}: ${usd(v.total)} · ${v.bills} bills · ${v.share}%`}))))}
   ${card('Monthly spend, top vendors','',(()=>{const top=d.vendors.slice(0,4),months=[...new Set(top.flatMap(v=>Object.keys(v.byMonth)))].sort();const cols=['var(--s1)','var(--s2)','var(--s3)','#7a5af8'];const series=top.map((v,i)=>({key:'v'+i,name:v.vendor,color:cols[i]}));return legend(series)+vbars({rows:months.map(m=>Object.assign({label:monthLabel(m)},...top.map((v,i)=>({['v'+i]:v.byMonth[m]||0})))),series})})())}</div>
  ${card('Vendors','',table('vendors',vCols,d.vendors,{rowAttr:r=>`data-vend="${h(r.vendor)}" class="${r.vendor===S.vendSel?'mechSel':''}" style="cursor:pointer"`,empty:'No vendor bills in this range yet. Add bills above, receive parts with Smart Receiving, or scan vendor-bill emails.'}),'vendors')}
  ${S.vendSel||S.vendQ?`<div id="vbBills"><div class="repEmpty">Loading bills…</div></div>`:''}
  ${checks?`<h2 style="margin:18px 0 8px">Things to check</h2>`:card('Things to check','','<div class="repEmpty">Nothing unusual in this range. 👍</div>')}
  ${al.priceIncreases.length?card('Price increases','The same part from the same vendor costs at least 5% more than last time.',table('vpi',piCols,al.priceIncreases,{rowAttr:r=>`data-vbill="${r.invoiceId}" style="cursor:pointer"`}),'vendor-price-increases'):''}
  ${al.cheaperElsewhere.length?card('Cheaper at another vendor','You paid more than another vendor charged you for the same part number in the 180 days before.',table('vce',ceCols,al.cheaperElsewhere,{rowAttr:r=>`data-vbill="${r.invoiceId}" style="cursor:pointer"`}),'vendor-cheaper'):''}
  ${al.mathProblems.length?card("Bills that don't add up",'Lines, subtotal, tax, freight and total on the bill do not match (more than $1). Ask the vendor or check the scan.',al.mathProblems.map(m=>`<div class="repMsg" data-vbill="${m.invoiceId}" style="cursor:pointer"><div><b>${h(m.vendor)}</b> · #${h(m.invoiceNumber||'—')} · ${day(m.date)}<div class="meta">${m.problems.map(p=>h(p.message)).join('<br>')}</div></div><div class="amt">${usd(m.total)}</div></div>`).join('')):''}
  ${al.duplicates.length?card('Possible double bills','Two bills from the same vendor with the same invoice number written differently, or the same total within 7 days.',al.duplicates.map(x=>`<div class="repMsg"><div><b>${h(x.vendor)}</b> · ${h(x.reason)}<div class="acts">${x.bills.map(b=>`<button class="secondary" data-rep="vb-open" data-id="${b.invoiceId}">#${h(b.invoiceNumber||'—')} · ${day(b.date)}</button>`).join('')}</div></div><div class="amt">${usd(x.total)}</div></div>`).join('')):''}
  ${al.unpaidPastDue.length?card('Unpaid bills past due','Mark a bill paid from its details when you pay it.',table('vup',upCols,al.unpaidPastDue,{rowAttr:r=>`data-vbill="${r.invoiceId}" style="cursor:pointer"`}),'vendor-unpaid'):''}
  ${al.coresPastDue.length?card('Cores past due','Return these cores to get the core charge back (Parts → Cores).',table('vcp',[{key:'vendor',label:'Vendor'},{key:'partNumber',label:'Part #'},{key:'qty',label:'Qty',num:true},{key:'value',label:'Value',num:true,fmt:usd},{key:'dueDate',label:'Due',fmt:v=>day(v)}],al.coresPastDue)):''}`;
 if(S.vendSel||S.vendQ)paintVendorBills();
 requestAnimationFrame(drawCharts);
}
async function loadVendorBills(){
 try{S.vendBills=(await api(`/api/vendor-invoices?from=${S.range.from}&to=${S.range.to}&vendor=${encodeURIComponent(S.vendSel||'')}&q=${encodeURIComponent(S.vendQ||'')}`)).items;paintVendorBills()}
 catch(e){const b=$('#vbBills');if(b)b.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
function paintVendorBills(){
 const box=$('#vbBills');if(!box)return;if(!S.vendBills){loadVendorBills();return}
 const v=S.vendSel&&S.vend.vendors.find(x=>x.vendor===S.vendSel);
 const src={scan:'Received',ai_file:'Uploaded',gmail:'Gmail',manual:'Typed'};
 const bCols=[{key:'invoice_date',label:'Date',fmt:x=>day(x)},{key:'vendor',label:'Vendor'},{key:'invoice_number',label:'Invoice #'},{key:'po_number',label:'PO'},{key:'line_count',label:'Lines',num:true},{key:'total',label:'Total',num:true,fmt:usd},{key:'source_method',label:'From',fmt:x=>src[x]||x||''},{key:'paid',label:'Paid',html:r=>r.paid_at?`<span class="repTag ok">Paid</span>`:r.due_date&&r.due_date<new Date().toISOString().slice(0,10)?`<span class="repTag late">Due ${day(r.due_date)}</span>`:r.due_date?`<span class="repTag">Due ${day(r.due_date)}</span>`:'<span class="repTag">Unpaid</span>',csv:r=>r.paid_at?'paid':'unpaid'}];
 registerCsv('vendor-bills-list',bCols,S.vendBills);
 const tp=v?.topParts||[];
 box.innerHTML=`${v&&tp.length?card(`${v.vendor} · top parts`,`What you buy most from ${v.vendor} in this range.`,table('vtp',[{key:'partNumber',label:'Part #'},{key:'description',label:'Description'},{key:'qty',label:'Qty',num:true,fmt:qty},{key:'lastCost',label:'Last cost',num:true,fmt:usd},{key:'spend',label:'Spend',num:true,fmt:usd}],tp)):''}
  ${card(`${S.vendSel?`${S.vendSel} bills`:'Bills'}${S.vendQ?` matching “${S.vendQ}”`:''}`,'Click a bill to see its lines, open the file or mark it paid.',`<div class="repNoPrint" style="text-align:right;margin-bottom:6px">${S.vendSel?`<button class="secondary" data-rep="vend-clear">Show all vendors</button>`:''}</div>`+table('vbills',bCols,S.vendBills,{rowAttr:r=>`data-vbill="${r.id}" style="cursor:pointer"`,empty:'No bills match.'}),'vendor-bills-list')}`;
}
async function openVendorBill(id){
 const d=await api(`/api/vendor-invoices/${id}`),i=d.invoice;
 const m=repModal(`<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><h2 style="margin:0">${h(i.vendor||'Vendor')} · #${h(i.invoice_number||'—')}</h2><div class="muted">${day(i.invoice_date)}${i.po_number?` · PO ${h(i.po_number)}`:''} · ${h(({scan:'Received into stock',ai_file:'Uploaded',gmail:'From Gmail',manual:'Typed'})[i.source_method]||i.source_method||'')}</div></div><button class="secondary" data-close>✕</button></div>
  ${d.mathProblems.length?`<div class="repNotice warn" style="margin-top:10px">${d.mathProblems.map(p=>h(p.message)).join('<br>')}</div>`:''}
  ${table('vbd',[{key:'vendor_part_number',label:'Part #'},{key:'description',label:'Description'},{key:'quantity',label:'Qty',num:true,fmt:qty},{key:'unit_cost',label:'Unit',num:true,fmt:usd},{key:'core_cost',label:'Core',num:true,fmt:v=>Number(v)?usd(v):'—'},{key:'line_total',label:'Total',num:true,fmt:usd}],d.lines,{empty:'No lines were saved for this bill.'})}
  <div style="display:grid;grid-template-columns:1fr auto;gap:4px 16px;margin:12px 0;font-variant-numeric:tabular-nums"><span>Subtotal</span><b>${usd(i.subtotal)}</b><span>Tax</span><b>${usd(i.tax)}</b><span>Freight</span><b>${usd(i.freight)}</b><span>Total</span><b>${usd(i.total)}</b></div>
  <div class="repForm" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="field"><label>Due date</label><input type="date" id="vbdDue" value="${h(i.due_date||'')}"></div><div class="field"><label>Paid on</label><input type="date" id="vbdPaidOn" value="${h(i.paid_at?String(i.paid_at).slice(0,10):'')}"></div><div class="field"><label>Payment ref (check #, ACH…)</label><input id="vbdRef" value="${h(i.paid_reference||'')}"></div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px">${i.has_file?`<button class="secondary" data-vb="file">Open file</button>`:''}${i.status!=='received'&&i.status!=='void'?`<button class="secondary" data-vb="void" style="color:#b42318">Void bill</button>`:''}${i.paid_at?`<button class="secondary" data-vb="unpaid">Mark unpaid</button>`:''}<button data-vb="save">${i.paid_at?'Save':'Save / Mark paid'}</button></div>`);
 m.addEventListener('click',async e=>{const b=e.target.closest('[data-vb]');if(!b)return;const a=b.dataset.vb;try{
  if(a==='file'){const w=window.open('','_blank');const r=await fetch(`/api/vendor-invoices/${id}/file`,{headers:window.authHeaders()});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'File not available');const url=URL.createObjectURL(await r.blob());if(w)w.location=url;else location.href=url;return}
  if(a==='void'){if(!confirm('Void this vendor bill? It stops counting in spending and money owed.'))return;await api(`/api/vendor-invoices/${id}`,{method:'PATCH',body:{void:true}})}
  if(a==='unpaid')await api(`/api/vendor-invoices/${id}`,{method:'PATCH',body:{paid:false}});
  if(a==='save'){const paidOn=m.querySelector('#vbdPaidOn').value,ref=m.querySelector('#vbdRef').value.trim();await api(`/api/vendor-invoices/${id}`,{method:'PATCH',body:{dueDate:m.querySelector('#vbdDue').value||null,...(paidOn||ref?{paid:true,paidOn,paidReference:ref}:{})}})}
  m.remove();toast('Vendor bill updated.','success');loadVendors(true)}catch(err){toast(err.message,'error')}});
}
async function scanVendorFiles(files){
 S.vbQueue=S.vbQueue||[];const start=S.vbQueue.length;
 for(const f of files)S.vbQueue.push({name:f.name,status:'scanning'});renderVendors();
 // One at a time: keeps AI cost predictable and avoids provider rate limits.
 for(let k=0;k<files.length;k++){const x=S.vbQueue[start+k];try{const fd=new FormData();fd.append('file',files[k]);const r=await fetch('/api/vendor-invoices/scan',{method:'POST',headers:window.authHeaders(),body:fd});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Scan failed (${r.status})`);x.draft=d;x.status='ready'}catch(e){x.status='error';x.error=e.message}renderVendors()}
}
async function scanGmailBill(id,btn){
 if(btn){btn.disabled=true;btn.textContent='Reading…'}
 try{const d=await api(`/api/vendor-invoices/gmail/${id}/scan`,{method:'POST',body:{}});S.vbQueue=S.vbQueue||[];S.vbQueue.push({name:d.file?.name||'Gmail bill',status:'ready',draft:d});S.tab='vendors';try{sessionStorage.setItem('ittr_reports_tab','vendors')}catch(_){}applyTab();toast('Bill read. Check it and click Save.','success')}
 catch(e){toast(e.message,'error');if(btn){btn.disabled=false;btn.textContent='✦ Scan & file'}}
}
function readQueue(i){const x=S.vbQueue[i];S.scope.host.querySelectorAll(`[data-vbq][data-i="${i}"]`).forEach(el=>{x.draft.invoice[el.dataset.vbq]=el.type==='number'?Number(el.value||0):el.value.trim()});return x}

// ---------------------------------------------------------------- AI usage (v24.42.0)
async function loadAiUsage(){
 const box=$('#repAi');if(!box)return;box.innerHTML='<div class="repEmpty">Loading AI usage…</div>';
 try{S.ai=await api(`/api/ai/usage?days=${S.aiDays||30}`);renderAiUsage()}catch(e){box.innerHTML=`<div class="repEmpty">${h(e.message)}</div>`}
}
const usd4=v=>{const n=Number(v)||0;return n>0&&n<0.01?`$${n.toFixed(4)}`:usd(n)};
function renderAiUsage(){
 const d=S.ai,box=$('#repAi'),owner=isOwner(),b=d.budget,m=d.month,pct=b.monthlyLimit>0?Math.min(100,Math.round(d.spentThisMonth/b.monthlyLimit*100)):0;
 const fCols=[{key:'label',label:'Feature'},{key:'calls',label:'Calls',num:true},{key:'cost',label:'Cost',num:true,fmt:usd4},{key:'perCall',label:'Per call',num:true,fmt:usd4},{key:'avgTokens',label:'Avg tokens',num:true,fmt:qty},{key:'failed',label:'Failed',num:true,html:r=>r.failed?`<span class="repTag late">${r.failed}</span>`:'0',csv:r=>r.failed}];
 registerCsv('ai-features',fCols,d.byFeature);
 const bar=`<div style="height:10px;background:#f2f4f7;border-radius:6px;overflow:hidden;margin-top:8px"><div style="height:100%;width:${pct}%;background:${pct>=100?'#d92d20':pct>=b.warnAt*100?'#f79009':'#12b76a'}"></div></div>`;
 box.innerHTML=`<div class="repNotice">Every AI request is counted here with its real cost from the provider (OpenRouter${d.ai?.provider==='openai'?' / OpenAI estimate':''}). When the <b>monthly budget</b> is used up, AI features pause until next month or until the owner raises the budget; everything else keeps working. AI in use: <b>${h(d.ai?.provider||'none')}</b> · text ${h(d.ai?.textModel||'—')} · invoices ${h(d.ai?.invoiceModel||'—')}.</div>
  <div class="repKpis"><div class="repKpi" style="grid-column:span 2"><span>This month</span><b>${usd4(d.spentThisMonth)} <small style="display:inline;font-size:13px">of ${b.monthlyLimit>0?usd(b.monthlyLimit):'no limit'}</small></b>${b.monthlyLimit>0?bar:''}<small class="${pct>=b.warnAt*100?'bad':''}">${b.monthlyLimit>0?`${pct}% of the budget`:''}${m.estimated?' · some costs estimated':''}</small></div>
   <div class="repKpi"><span>Month forecast</span><b>${usd4(m.projected)}</b><small>at this month's pace</small></div>
   <div class="repKpi"><span>Last month</span><b>${usd4(d.lastMonth.cost)}</b><small>${d.lastMonth.calls} calls</small></div>
   <div class="repKpi"><span>AI calls this month</span><b>${m.calls}</b><small class="${m.failed?'bad':''}">${m.failed} failed</small></div>
   <div class="repKpi"><span>Shared translations</span><b>${qty(d.translationPhrasesCached)}</b><small>phrases paid for once</small></div></div>
  <div class="repNoPrint" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${[7,30,90].map(n=>`<button class="filterbtn ${(S.aiDays||30)===n?'active':''}" data-rep="ai-days" data-k="${n}">Last ${n} days</button>`).join('')}</div>
  <div class="repGrid">${card('Cost by day','',vbars({rows:d.byDay.map(x=>({label:day(x.day),short:x.day.slice(5),cost:x.cost})),series:[{key:'cost',name:'Cost',color:C.one}],fmt:usd4,axis:v=>v>=10?compact(v):`$${v.toFixed(v>=1?1:v>=0.1?2:3)}`}))}
   ${card('By feature','Which parts of ShopFlow use AI and what each costs.',table('aif',fCols,d.byFeature,{empty:'No AI calls in this period.'}),'ai-features')}</div>
  <div class="repGrid">${card('By person','',table('aiu',[{key:'username',label:'User'},{key:'calls',label:'Calls',num:true},{key:'cost',label:'Cost',num:true,fmt:usd4}],d.byUser,{empty:'No AI calls.'}))}
   ${card('By model','',table('aim',[{key:'model',label:'Model'},{key:'calls',label:'Calls',num:true},{key:'cost',label:'Cost',num:true,fmt:usd4}],d.byModel,{empty:'No AI calls.'}))}</div>
  ${d.recentErrors.length?card('Recent AI errors','Failed calls usually mean the provider was busy or the key or credit ran out.',table('aie',[{key:'created_at',label:'When',fmt:v=>new Date(v).toLocaleString('en-US')},{key:'feature',label:'Feature',fmt:v=>d.features?.[v]||v},{key:'username',label:'User'},{key:'error',label:'Error'}],d.recentErrors)):''}
  ${owner?card('Monthly AI budget','AI stops for the rest of the month when this amount is reached. 0 = no limit (not recommended).',`<div class="repForm"><div class="field"><label>Monthly limit $</label><input id="aiBudget" type="number" min="0" step="1" value="${b.monthlyLimit}"></div><div class="field"><label>Warn at</label><select id="aiWarn">${[0.5,0.7,0.8,0.9].map(x=>`<option value="${x}" ${b.warnAt===x?'selected':''}>${Math.round(x*100)}%</option>`).join('')}</select></div><div class="field" style="align-self:end"><button data-rep="ai-budget">Save budget</button></div></div>`):''}`;
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
  const atts=(m.attachments||[]).filter(a=>a&&a.filename).map(a=>`<button class="secondary" data-rep="gmail-att" data-id="${m.id}" data-i="${a.index}">📎 ${h(a.filename)}</button>`).join('')+(m.kind==='vendor_bill'&&(m.attachments||[]).some(a=>/pdf|image/i.test(a?.mimeType||'')||/\.pdf$/i.test(a?.filename||''))?`<button data-rep="vb-gmail" data-id="${m.id}">✦ Scan &amp; file</button>`:'');
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
 const mr=ev.target.closest('tr[data-mech]');if(mr&&!ev.target.closest('[data-rep]')){S.mechSel=mr.dataset.mech;renderMech();return}
 const cr=ev.target.closest('tr[data-clock]');if(cr&&!ev.target.closest('[data-rep]')){S.clockSel=S.clockSel===cr.dataset.clock?'':cr.dataset.clock;renderClock();return}
 const lr=ev.target.closest('tr[data-ltype]');if(lr&&!ev.target.closest('[data-rep]')){S.laborType=S.laborType===lr.dataset.ltype?'':lr.dataset.ltype;renderLabor();return}
 const vr=ev.target.closest('tr[data-vend]');if(vr&&!ev.target.closest('[data-rep]')){S.vendSel=S.vendSel===vr.dataset.vend?'':vr.dataset.vend;S.vendBills=null;renderVendors();return}
 const vb=ev.target.closest('[data-vbill]');if(vb&&!ev.target.closest('[data-rep]')){try{await openVendorBill(vb.dataset.vbill)}catch(e){toast(e.message,'error')}return}
 const inv=ev.target.closest('tr[data-inv]');if(inv){await window.showView('invoices');window.openInvoiceWorkspace?.(Number(inv.dataset.inv));return}
 const b=ev.target.closest('[data-rep]');if(!b)return;const a=b.dataset.rep;
 try{
  if(a==='preset'){S.preset=b.dataset.p;S.range=presetRange(S.preset);return load()}
  if(a==='tab'){S.tab=b.dataset.t;try{sessionStorage.setItem('ittr_reports_tab',S.tab)}catch(_){}return applyTab()}
  if(a==='sort'){const cur=S.sort[b.dataset.table];S.sort[b.dataset.table]={key:b.dataset.key,dir:cur?.key===b.dataset.key?-cur.dir:-1};return S.tab==='mech'?renderMech():S.tab==='clock'?renderClock():S.tab==='labor'?renderLabor():S.tab==='vendors'?(renderVendors()):S.tab==='ai'?renderAiUsage():render()}
  if(a==='csv')return downloadCsv(b.dataset.k);
  if(a==='save-hours'){const wd=[...S.scope.host.querySelectorAll('[data-wd]')].filter(x=>x.checked).map(x=>Number(x.dataset.wd));await api('/api/reports/mechanics/settings',{method:'PUT',body:{start:$('#shOpen').value,end:$('#shClose').value,timezone:$('#shTz').value,breakAllowanceMinutes:$('#shLunch').value,idleGapMinutes:$('#shGap').value,workdays:wd}});S.mech=null;toast('Shop hours saved.','success');return loadMech()}
  if(a==='print')return window.print();
  if(a==='clock-all'){S.clockSel='';return renderClock()}
  if(a==='shift-add')return shiftForm(null);
  if(a==='shift-edit')return shiftForm(S.clock.mechanics.flatMap(m=>m.shifts).find(x=>String(x.id)===b.dataset.id));
  if(a==='shift-del'){const reason=prompt('Why delete this shift? (kept in the history)');if(!reason)return;await api(`/api/timeclock/shifts/${b.dataset.id}`,{method:'DELETE',body:{reason}});toast('Shift deleted.','success');S.clock=null;S.mech=null;return loadClock()}
  if(a==='shift-hist'){const d=await api(`/api/timeclock/shifts/${b.dataset.id}/history`);const f=x=>x?`${dt(x.clockIn)} → ${x.clockOut?dt(x.clockOut):'open'}`:'—';repModal(`<h2 style="margin-top:0">Shift history</h2>${d.items.map(e=>`<div style="padding:8px 0;border-bottom:1px solid #eef0f3"><b>${h(e.action)}</b> by ${h(e.edited_by)} · ${h(dt(e.edited_at))}<div class="muted">${h(f(e.before))} ⟶ ${h(f(e.after))}</div><div>Reason: ${h(e.reason)}</div></div>`).join('')||'<div class="repEmpty">No changes.</div>'}<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="secondary" data-close>Close</button></div>`);return}
  if(a==='clock-settings'){await api('/api/timeclock/settings',{method:'PUT',body:{autoClockIn:$('#tcAuto').value==='yes',weeklyOvertimeHours:$('#tcOt').value,weekStartsOn:$('#tcWeek').value,maxShiftHours:$('#tcMax').value}});toast('Time clock settings saved.','success');S.clock=null;return loadClock()}
  if(a==='labor-src'){S.laborSrc=b.dataset.k;return loadLabor()}
  if(a==='labor-edit')return openLaborEditor();
  if(a==='jt-add'){readLaborEditor();S.jobTypes.unshift({key:'',label:'',keywords:[],bookHours:null});return paintLaborEditor()}
  if(a==='jt-del'){readLaborEditor();S.jobTypes.splice(Number(b.dataset.i),1);return paintLaborEditor()}
  if(a==='jt-up'){readLaborEditor();const i=Number(b.dataset.i);if(i>0)[S.jobTypes[i-1],S.jobTypes[i]]=[S.jobTypes[i],S.jobTypes[i-1]];return paintLaborEditor()}
  if(a==='jt-reset'){if(!confirm('Go back to the built-in job types? Your changes will be lost.'))return;await api('/api/reports/labor-times/job-types',{method:'PUT',body:{reset:true}});toast('Job types reset.','success');S.labor=null;return loadLabor()}
  if(a==='jt-save'){readLaborEditor();await api('/api/reports/labor-times/job-types',{method:'PUT',body:{types:S.jobTypes}});toast('Job types saved.','success');S.labor=null;return loadLabor()}
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
  if(a==='vb-gmail')return scanGmailBill(b.dataset.id,b);
  if(a==='vb-open')return openVendorBill(b.dataset.id);
  if(a==='vend-clear'){S.vendSel='';S.vendBills=null;return renderVendors()}
  if(a==='vbq-drop'){S.vbQueue.splice(Number(b.dataset.i),1);return renderVendors()}
  if(a==='vbq-save'){const x=readQueue(Number(b.dataset.i));b.disabled=true;const r=await api('/api/vendor-invoices',{method:'POST',body:{invoice:x.draft.invoice,lines:x.draft.lines,file:x.draft.file,gmailMessageId:x.draft.gmailMessageId||null}});x.status='saved';x.draft.invoice.vendor=r.vendor;toast(`Saved under ${r.vendor}.`,'success');S.vbQueue=S.vbQueue.filter(q=>q.status!=='saved'||q===x);return loadVendors(true)}
  if(a==='vb-ai'){const out=$('#vbAiOut');b.disabled=true;out.innerHTML='<div class="repNotice">✦ AI is reading your vendor numbers…</div>';try{const d=await api('/api/vendor-invoices/analysis/summary',{method:'POST',body:{from:S.range.from,to:S.range.to}});out.innerHTML=card('AI summary',`${day(S.range.from)} – ${day(S.range.to)}`,`<div style="white-space:pre-wrap;line-height:1.55">${h(d.summary)}</div>`)}catch(e){out.innerHTML='';throw e}finally{b.disabled=false}return}
  if(a==='ai-days'){S.aiDays=Number(b.dataset.k);return loadAiUsage()}
  if(a==='ai-budget'){const d=await api('/api/ai/budget',{method:'PUT',body:{monthlyLimit:Number($('#aiBudget').value),warnAt:Number($('#aiWarn').value)}});toast(`AI budget set to ${usd(d.budget.monthlyLimit)} a month.`,'success');return loadAiUsage()}
  if(a==='gmail-queries'){await api('/api/finance/settings/gmail-queries',{method:'PUT',body:{zelle:$('#gqZelle').value,vendor:$('#gqVendor').value}});toast('Gmail searches saved.','success');return}
 }catch(e){b.disabled=false;toast(e.message,'error');if(a==='gmail-sync')loadInbox()}
}
function onChange(ev){if(ev.target.id==='vbFiles'){const f=[...ev.target.files];ev.target.value='';if(f.length)scanVendorFiles(f);return}
 if(ev.target.id==='vbSearch'){S.vendQ=ev.target.value.trim();S.vendBills=null;return renderVendors()}
 if(ev.target.id==='repFrom'||ev.target.id==='repTo'){const f=$('#repFrom').value,t=$('#repTo').value;if(f&&t){S.preset='';S.range={from:f,to:t};load()}}}
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
