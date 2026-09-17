import fs from 'node:fs';

const targets=['index.html','public/index.html'];
const css=`
/* v24.25.9 — invoice-backed service-history cleanup */
.ittr-history-clean .ittrHistorySummary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0}
.ittr-history-clean .ittrHistoryMetric{background:#fff;border:1px solid #dbe3ec;border-radius:12px;padding:12px 14px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.ittr-history-clean .ittrHistoryMetric small{display:block;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.ittr-history-clean .ittrHistoryMetric strong{font-size:18px;color:#0f172a}
.ittr-history-clean .ittrHistoryJob{background:#fff;border:1px solid #dbe3ec;border-radius:14px;padding:16px;margin:10px 0;box-shadow:0 2px 8px rgba(15,23,42,.05)}
.ittr-history-clean .ittrHistoryJobHead{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;border-bottom:1px solid #eef2f6;padding-bottom:10px;margin-bottom:10px}
.ittr-history-clean .ittrHistoryJobTitle{font-size:16px;font-weight:800;color:#0f172a}.ittr-history-clean .ittrHistoryJobMeta{font-size:12px;color:#64748b;margin-top:3px}
.ittr-history-clean .ittrHistoryAmount{font-size:16px;font-weight:800;color:#0f172a;white-space:nowrap}
.ittr-history-clean .ittrHistoryParts{margin-top:10px}.ittr-history-clean .ittrHistoryPartsTitle{font-size:12px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
.ittr-history-clean .ittrHistoryPart{display:grid;grid-template-columns:minmax(100px,.8fr) minmax(180px,2fr) 70px 90px 95px;gap:10px;align-items:center;padding:7px 0;border-top:1px solid #eef2f6;font-size:13px}
.ittr-history-clean .ittrHistoryPart:first-of-type{border-top:0}.ittr-history-clean .ittrHistoryPartTotal{text-align:right;font-weight:800}
.ittr-history-clean .ittrHistoryReadOnly{background:#fff7db;border:1px solid #f1c75b;border-radius:10px;padding:10px 12px;color:#8a4b08;font-size:12px;margin-top:12px}
@media(max-width:760px){.ittr-history-clean .ittrHistorySummary{grid-template-columns:repeat(2,minmax(0,1fr))}.ittr-history-clean .ittrHistoryPart{grid-template-columns:1fr 1fr}.ittr-history-clean .ittrHistoryPart>*:nth-child(n+3){text-align:left}}
`;
const js=`
/* v24.25.9 — non-destructive service-history presentation cleanup.
   Source invoice remains authoritative; this only removes placeholder rows/IDs from rendered history. */
(function(){
 const money=n=>'$'+Number(n||0).toFixed(2);
 const txt=v=>String(v??'').trim();
 const junkPart=p=>{const pn=txt(p?.partNumber||p?.part_number||p?.part),d=txt(p?.description||p?.name);const q=Number(p?.quantity??p?.qty??0),u=Number(p?.unitPrice??p?.price??p?.sellPrice??0),t=Number(p?.total??p?.lineTotal??q*u);return (!pn||pn==='—')&&(!d||/^part$/i.test(d))&&Math.abs(t)<.0001&&Math.abs(u)<.0001};
 const cleanTitle=(a,i)=>{let s=txt(a?.title||a?.service||a?.description||a?.complaint||a?.correction);if(!s||/^labor\s+\d{7,}$/i.test(s)||/^action\s*\d*$/i.test(s)){const c=txt(a?.complaint),r=txt(a?.correction);s=c||r||('Service '+(i+1))}return s.replace(/^labor\s+\d{7,}\s*[-:]?\s*/i,'').trim()||('Service '+(i+1))};
 window.ittrCleanInvoiceHistoryRecord=function(record){if(!record||typeof record!=='object')return record;const x=structuredClone(record),actions=Array.isArray(x.actions)?x.actions:[];x.actions=actions.map((a,i)=>{a={...a};a.displayTitle=cleanTitle(a,i);if(Array.isArray(a.parts))a.parts=a.parts.filter(p=>!junkPart(p));return a});return x};
 window.ittrRenderInvoiceHistoryClean=function(record){const x=window.ittrCleanInvoiceHistoryRecord(record),actions=x?.actions||[];const escf=window.esc||((v)=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])));const labor=Number(x?.laborAmount||0),parts=Number(x?.partAmount||0),fees=Number(x?.feesAmount||x?.otherAmount||0),total=Number(x?.totalAmount||labor+parts+fees);return '<div class="ittr-history-clean"><div class="ittrHistorySummary"><div class="ittrHistoryMetric"><small>Labor</small><strong>'+money(labor)+'</strong></div><div class="ittrHistoryMetric"><small>Parts</small><strong>'+money(parts)+'</strong></div><div class="ittrHistoryMetric"><small>Fees / Other</small><strong>'+money(fees)+'</strong></div><div class="ittrHistoryMetric"><small>Total</small><strong>'+money(total)+'</strong></div></div>'+actions.map((a,i)=>{const ps=(a.parts||[]).filter(p=>!junkPart(p)),amt=Number(a.laborAmount||a.totalAmount||0);return '<div class="ittrHistoryJob"><div class="ittrHistoryJobHead"><div><div class="ittrHistoryJobTitle">'+escf(a.displayTitle||cleanTitle(a,i))+'</div><div class="ittrHistoryJobMeta">'+(Number(a.hours||0)>0?Number(a.hours).toFixed(2)+' hr':'')+(Number(a.rate||a.laborRate||0)>0?' · Rate '+money(a.rate||a.laborRate):'')+'</div></div><div class="ittrHistoryAmount">'+money(amt)+'</div></div>'+(ps.length?'<div class="ittrHistoryParts"><div class="ittrHistoryPartsTitle">Parts used</div>'+ps.map(p=>{const q=Number(p.quantity??p.qty??0),u=Number(p.unitPrice??p.price??p.sellPrice??0),t=Number(p.total??p.lineTotal??q*u);return '<div class="ittrHistoryPart"><b>'+escf(txt(p.partNumber||p.part_number||p.part)||'—')+'</b><span>'+escf(txt(p.description||p.name)||'Part')+'</span><span>Qty '+q+'</span><span>'+money(u)+'</span><span class="ittrHistoryPartTotal">'+money(t)+'</span></div>'}).join('')+'</div>':'')+'</div>'}).join('')+'<div class="ittrHistoryReadOnly"><b>Invoice service history is read-only.</b> Edit the original invoice to correct labor, parts, pricing, mileage or billing information.</div></div>'};
 // DOM safety-net for legacy invoice-history modal markup already produced by older code.
 const scrub=root=>{if(!root||root.dataset?.ittrHistoryCleaned==='1')return;const text=root.textContent||'';if(!/Service history is read-only|Edit Original Invoice/i.test(text))return;root.classList.add('ittr-history-clean');root.dataset.ittrHistoryCleaned='1';root.querySelectorAll('tr').forEach(tr=>{const t=(tr.textContent||'').replace(/\s+/g,' ').trim();if((/^—\s+Part\s+Qty\s+1\s+\$0\.00\s+\$0\.00$/i.test(t)||(/^[-—]?\s*Part\b/i.test(t)&&/\$0\.00/.test(t)))&&tr.querySelectorAll('td').length)tr.remove()});root.querySelectorAll('b,strong,h3,h4').forEach(el=>{const t=(el.textContent||'').trim();if(/^Action\s+\d+\s*·\s*Labor\s+\d{7,}$/i.test(t))el.textContent=t.replace(/Action\s+\d+\s*·\s*Labor\s+\d{7,}/i,'Additional Labor');else if(/^Labor\s+\d{7,}$/i.test(t))el.textContent='Additional Labor'});};
 const scan=()=>document.querySelectorAll('.modal,.modalbox,[role="dialog"]').forEach(scrub);new MutationObserver(scan).observe(document.documentElement,{subtree:true,childList:true});setTimeout(scan,0);
})();
`;
for(const fp of targets){if(!fs.existsSync(fp))continue;let s=fs.readFileSync(fp,'utf8');if(!s.includes('v24.25.9 — invoice-backed service-history cleanup'))s=s.replace('</style>',css+'\n</style>');if(!s.includes('v24.25.9 — non-destructive service-history presentation cleanup'))s=s.replace('</body>','<script>'+js+'</script>\n</body>');fs.writeFileSync(fp,s)}
console.log('ITTR v24.25.9 service-history cleanup + UX applied');
