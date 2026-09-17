let localAbort=null;
let voiceRecognition=null;
const SUPPORTED={"en-US":"en-US","uk-UA":"uk-UA","pl-PL":"pl-PL","es-ES":"es-ES","ru-RU":"ru-RU"};
function appVoiceLocale(){const chosen=document.getElementById("aiShopVoiceLanguage")?.value||"auto";if(chosen!=="auto")return SUPPORTED[chosen]||"en-US";const lang=String(document.documentElement.lang||navigator.language||"en-US").toLowerCase();if(lang.startsWith("uk"))return "uk-UA";if(lang.startsWith("pl"))return "pl-PL";if(lang.startsWith("es"))return "es-ES";if(lang.startsWith("ru"))return "ru-RU";return "en-US"}
function setBusy(busy,processingId){document.querySelectorAll("#proPanelAitools [data-ai-action]").forEach(b=>b.disabled=busy);document.getElementById(processingId)?.classList.toggle("hidden",!busy)}
async function aiCall(endpoint,payload,processingId){setBusy(true,processingId);try{const r=await fetch(endpoint,{method:"POST",headers:window.authHeaders?.({"Content-Type":"application/json"})||{"Content-Type":"application/json"},body:JSON.stringify(payload)});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`AI request failed (${r.status})`);return d.result??d.translation??""}finally{setBusy(false,processingId)}}
window.startVoiceNote=function(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){window.showToast?.("Live dictation requires Chrome or Edge with Web Speech support.","warning",7000);return}if(voiceRecognition){try{voiceRecognition.stop()}catch{}return}const textarea=document.getElementById("aiShopText"),btn=document.getElementById("aiShopMicButton"),state=document.getElementById("aiShopVoiceState");const r=new SR();voiceRecognition=r;r.lang=appVoiceLocale();r.continuous=true;r.interimResults=true;let committed=(textarea?.value||"").trim();r.onstart=()=>{btn?.classList.add("recording");btn?.setAttribute("aria-pressed","true");if(state)state.textContent=`Listening — ${r.lang}`};r.onresult=e=>{let finalChunk="",interim="";for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0]?.transcript||"";if(e.results[i].isFinal)finalChunk+=t+" ";else interim+=t}if(finalChunk.trim())committed=[committed,finalChunk.trim()].filter(Boolean).join(" ");if(textarea)textarea.value=[committed,interim.trim()].filter(Boolean).join(" ");if(state)state.textContent=`Listening — ${r.lang}`};r.onerror=e=>{if(e.error!=="no-speech")window.showToast?.(`Voice dictation: ${e.error}`,"warning",6000)};r.onend=()=>{voiceRecognition=null;btn?.classList.remove("recording");btn?.setAttribute("aria-pressed","false");if(state)state.textContent="Ready for dictation"};try{r.start()}catch(e){voiceRecognition=null;window.showToast?.(e.message,"error")}};
window.aiProfessionalNote=async function(mode="professional"){const el=document.getElementById("aiShopText"),out=document.getElementById("aiShopResult"),text=el?.value.trim();if(!text)return window.showToast?.("Enter or dictate a mechanic note first.","warning");try{const x=await aiCall("/api/ai/note",{text,mode},"aiShopProcessing");if(out)out.textContent=x||""}catch(e){if(out)out.textContent=e.message;window.showToast?.(e.message,"error",7000)}};
window.aiDiagnosticAssistant=async function(){const el=document.getElementById("aiDiagnosticInput"),out=document.getElementById("aiDiagnosticResult"),text=el?.value.trim();if(!text)return window.showToast?.("Enter symptoms or fault codes first.","warning");try{const x=await aiCall("/api/ai/diagnostic",{text},"aiDiagnosticProcessing");if(out)out.textContent=x||""}catch(e){if(out)out.textContent=e.message;window.showToast?.(e.message,"error",7000)}};
window.aiPartAssistant=async function(){const q=document.getElementById("aiPartQuery")?.value.trim(),vin=document.getElementById("aiPartVin")?.value.trim(),out=document.getElementById("aiPartResult");if(!q)return window.showToast?.("Enter a part number or description first.","warning");try{const x=await aiCall("/api/ai/part",{vin,query:q},"aiPartProcessing");if(out)out.textContent=x||""}catch(e){if(out)out.textContent=e.message;window.showToast?.(e.message,"error",7000)}};
export async function mount(scope){localAbort=new AbortController();scope.on(scope.host,"ittr:module-refresh",()=>window.renderProCenter?.(),{passive:true});await window.renderProCenter?.();setTimeout(()=>window.checkAIConnection?.(),0)}
export async function afterShow(){await window.renderProCenter?.()}
export function unmount(){localAbort?.abort();localAbort=null;if(voiceRecognition){try{voiceRecognition.stop()}catch{}voiceRecognition=null}}

async function reconcileFullbayHistory(){
 if(!requireAdmin())return;
 const box=document.getElementById("fullbayImportStatus");if(box)box.textContent="Auditing customer/unit/history links…";
 try{
  const d=await apiJSON("/api/fullbay/history/reconcile",{method:"POST",body:"{}"}),r=d.report||{};
  alert(`History audit complete.\n\nCustomer links repaired: ${r.customerLinks||0}\nUnit links repaired: ${r.unitLinks||0}\nMetadata backfilled: ${r.metadataBackfill||0}\nHistory rows still without a unit: ${r.orphanHistory||0}\nUnits with non-standard/short VIN or serial: ${r.invalidVinUnits||0}\nDuplicate customer + unit-number groups: ${r.duplicateCustomerUnits||0}\n\nNo records were deleted.`);
  await renderFullbayImportStatus();
 }catch(e){alert(e.message||"History audit failed.");if(box)box.textContent=e.message||"History audit failed."}
}

let samsaraFleetCache=[];
async function loadSamsaraFleet(){const status=document.getElementById('samsaraStatus'),out=document.getElementById('samsaraFleetResults');if(status)status.textContent='Connecting to Samsara…';try{const s=await apiJSON('/api/samsara/status');if(!s.configured){status.innerHTML='<b>Samsara is ready but the token is not configured.</b> Add SAMSARA_API_TOKEN in Railway Variables.';if(out)out.innerHTML='';return}if(!s.connected)throw new Error(s.error||'Samsara connection failed.');const d=await apiJSON('/api/samsara/fleet');samsaraFleetCache=d.items||[];status.textContent=`Connected · ${samsaraFleetCache.length} vehicles · Updated ${fmtDateTime(d.updatedAt)}`;renderSamsaraFleet()}catch(e){if(status)status.innerHTML=`<span class="error">${esc(e.message||'Samsara unavailable.')}</span>`}}
function renderSamsaraFleet(){const out=document.getElementById('samsaraFleetResults');if(!out)return;const q=String(document.getElementById('samsaraSearch')?.value||'').toLowerCase().trim();const rows=samsaraFleetCache.filter(v=>!q||[v.name,v.vin,v.licensePlate,v.driver?.name,v.gps?.location,v.make,v.model].join(' ').toLowerCase().includes(q));out.innerHTML=rows.length?`<div class="tableWrap"><table><thead><tr><th>Vehicle</th><th>VIN / Plate</th><th>Driver</th><th>Engine</th><th>Speed</th><th>Last Location</th><th>Updated</th></tr></thead><tbody>${rows.map(v=>`<tr><td><b>${esc(v.name||'—')}</b><div class="muted">${esc([v.year,v.make,v.model].filter(Boolean).join(' '))}</div></td><td>${esc(v.vin||'—')}<div class="muted">${esc(v.licensePlate||'')}</div></td><td>${esc(v.driver?.name||'—')}</td><td>${esc(typeof v.engineState==='string'?v.engineState:(v.engineState?.value||'—'))}</td><td>${Number(v.gps?.speedMilesPerHour||0).toFixed(0)} mph</td><td>${esc(v.gps?.location||'—')}</td><td>${esc(v.gps?.time?fmtDateTime(v.gps.time):'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">No Samsara vehicles match this search.</div>'}
async function auditDuplicateCustomers(){
 const out=document.getElementById('duplicateCustomerResults');if(out)out.textContent='Scanning customers…';
 try{
  const d=await apiJSON('/api/customers/duplicate-audit'),groups=d.candidates||[];
  out.innerHTML=groups.length?groups.map((g,gi)=>`<div class="card" style="margin:10px 0">
   <b>${esc(g.normalized)}</b><div class="muted">${esc(g.reason)}</div>
   ${g.customers.map((c,ci)=>`<label style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line,#ddd)">
    <input type="radio" name="dupMaster${gi}" value="${Number(c.id)}" ${ci===0?'checked':''}>
    <span><b>${esc(c.customer_name)}</b><div class="muted">DOT ${esc(c.usdot||'—')} · ${c.units||0} units · ${c.history||0} history records · Fullbay ${esc(c.fullbay_id||'—')}</div></span>
   </label>`).join('')}
   <div class="actions" style="margin-top:10px"><button class="secondary" onclick="previewDuplicateMerge(${gi})">Review Merge</button></div>
   <div id="dupMergePreview${gi}"></div>
  </div>`).join(''):`<div class="success">No normalized-name duplicates found. Scanned ${d.scanned||0} customers.</div>`;
  window.__duplicateAuditGroups=groups;
 }catch(e){if(out)out.innerHTML=`<div class="error">${esc(e.message||'Duplicate audit failed.')}</div>`}
}
async function previewDuplicateMerge(groupIndex){
 const g=(window.__duplicateAuditGroups||[])[groupIndex];if(!g)return;
 const masterId=Number(document.querySelector(`input[name="dupMaster${groupIndex}"]:checked`)?.value||0);
 const duplicateIds=g.customers.filter(c=>Number(c.id)!==masterId).map(c=>Number(c.id));
 const box=document.getElementById(`dupMergePreview${groupIndex}`);
 if(duplicateIds.length!==1){box.innerHTML='<div class="error">This group has more than two records. Merge one pair at a time.</div>';return}
 const duplicateId=duplicateIds[0];
 try{
  const p=await apiJSON('/api/customers/merge-preview',{method:'POST',body:JSON.stringify({masterId,duplicateId})});
  const master=p.customers.find(c=>Number(c.id)===masterId),dup=p.customers.find(c=>Number(c.id)===duplicateId),dc=p.counts[duplicateId]||{};
  box.innerHTML=`<div class="notice" style="margin-top:10px"><b>MERGE PREVIEW — nothing changed yet</b><br>
   Keep: <b>${esc(master?.customer_name||masterId)}</b><br>
   Merge into it: <b>${esc(dup?.customer_name||duplicateId)}</b><br>
   Will relink: ${dc.units||0} units · ${dc.history||0} history records · ${dc.invoices||0} invoices · ${dc.service_orders||0} service orders.
   <div style="margin-top:8px"><input id="dupConfirm${groupIndex}" placeholder="Type MERGE" style="max-width:150px">
   <button class="danger" onclick="commitDuplicateMerge(${groupIndex},${masterId},${duplicateId})">Merge Customer</button></div></div>`;
 }catch(e){box.innerHTML=`<div class="error"><b>Merge preview could not load.</b><br>${esc(e.message||'Merge preview failed.')}</div>`}
}
async function commitDuplicateMerge(groupIndex,masterId,duplicateId){
 const typed=String(document.getElementById(`dupConfirm${groupIndex}`)?.value||'').trim().toUpperCase();
 if(typed!=='MERGE'){alert('Type MERGE exactly before continuing.');return}
 if(!confirm('This will relink the duplicate customer records to the selected master. Continue?'))return;
 try{
  const r=await apiJSON('/api/customers/merge',{method:'POST',body:JSON.stringify({masterId,duplicateId})});
  alert(`Merge complete. ${r.movedUnits||0} units moved, ${r.mergedUnits||0} duplicate units consolidated, ${r.historyMoved||0} history rows, ${r.invoicesMoved||0} invoices, ${r.serviceOrdersMoved||0} service orders relinked.`);
  await auditDuplicateCustomers();
 }catch(e){alert(e.message||'Customer merge failed.')}
}

// v24.24.0 lazy-route global action exports
window.loadSamsaraFleet = loadSamsaraFleet;
window.renderSamsaraFleet = renderSamsaraFleet;
window.auditDuplicateCustomers = auditDuplicateCustomers;
window.previewDuplicateMerge = previewDuplicateMerge;
window.commitDuplicateMerge = commitDuplicateMerge;

async function auditImportedFullbayHistory(){
 const out=document.getElementById('fullbayHistoryResetResults');if(out)out.textContent='Auditing imported Fullbay history…';
 try{const d=await apiJSON('/api/fullbay/history/import-audit');
 out.innerHTML=`<div class="notice"><b>${d.imported||0} imported Fullbay history rows found.</b><br>${d.incomplete||0} appear incomplete.<br>${d.aiHistory||0} AI-added history rows are protected from this cleanup.
 <div style="margin-top:10px"><input id="fullbayDeleteConfirm" placeholder="Type DELETE FULLBAY HISTORY" style="min-width:270px"><button class="danger" onclick="deleteImportedFullbayHistory()">Delete Imported Fullbay History</button></div>
 <div class="muted" style="margin-top:7px">Customers, units, ITTR invoices, ITTR work orders and inventory are preserved.</div></div>`}
 catch(e){out.innerHTML=`<div class="error">${esc(e.message||'Fullbay history audit failed.')}</div>`}
}
async function deleteImportedFullbayHistory(){
 const confirmation=String(document.getElementById('fullbayDeleteConfirm')?.value||'').trim();
 if(confirmation!=='DELETE FULLBAY HISTORY'){alert('Type DELETE FULLBAY HISTORY exactly.');return}
 if(!confirm('Delete ONLY the previously imported Fullbay service-history rows? Customers, units, ITTR invoices/work orders and inventory will remain.'))return;
 try{const r=await apiJSON('/api/fullbay/history/delete-imported',{method:'POST',body:JSON.stringify({confirmation})});
 alert(`${r.deleted||0} imported Fullbay history rows deleted. Customers, units and ITTR records were preserved.`);await auditImportedFullbayHistory()}
 catch(e){alert(e.message||'Fullbay history cleanup failed.')}
}
window.auditImportedFullbayHistory=auditImportedFullbayHistory;
window.deleteImportedFullbayHistory=deleteImportedFullbayHistory;
