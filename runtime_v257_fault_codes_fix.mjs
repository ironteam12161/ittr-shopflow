import fs from 'node:fs';

const files=['public/modules/procenter.js','modules/procenter.js'];
for(const fp of files){
  if(!fs.existsSync(fp)) continue;
  let s=fs.readFileSync(fp,'utf8');

  // Replace the module-scoped renderer (loadSamsaraFleet calls this lexical function,
  // so assigning window.renderSamsaraFleet alone does not change what the Fleet tab renders).
  const a=s.indexOf('function renderSamsaraFleet(){');
  const b=s.indexOf('async function auditDuplicateCustomers()',a);
  if(a>=0&&b>a){
    const renderer=`function renderSamsaraFleet(){
 const out=document.getElementById('samsaraFleetResults');if(!out)return;
 const q=String(document.getElementById('samsaraSearch')?.value||document.getElementById('samsaraFleetSearch')?.value||'').toLowerCase().trim();
 const rows=samsaraFleetCache.filter(v=>!q||[v.name,v.vin,v.licensePlate,v.driver?.name,v.gps?.location,v.make,v.model].join(' ').toLowerCase().includes(q));
 const faultCell=v=>{const n=Number(v.faultCount||0),has=!!v.hasDiagnosticData||!!v.faultCodes;if(!has)return 'None reported';const label=n>0?'⚠️ '+n+' Fault Code'+(n===1?'':'s'):'⚠️ View Diagnostics';return '<button type="button" class="ittr-fault-btn" data-fault-id="'+esc(v.id)+'" data-fault-name="'+esc(v.name||'Vehicle')+'" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:6px 9px;font-weight:700;cursor:pointer">'+label+'</button>'};
 out.innerHTML=rows.length?'<div class="tableWrap"><table><thead><tr><th>Vehicle</th><th>VIN / Plate</th><th>Driver</th><th>Engine</th><th>Speed</th><th>Mileage</th><th>Engine Hrs</th><th>Faults</th><th>Last Location</th><th>Updated</th></tr></thead><tbody>'+rows.map(v=>{const raw=v.gpsSpeedMph?.value,sp=(raw===null||raw===undefined||raw==='')?null:Number(raw),speed=Number.isFinite(sp)?Math.round(sp)+' mph':'—';return '<tr><td><b>'+esc(v.name||'—')+'</b><div class="muted">'+esc([v.year,v.make,v.model].filter(Boolean).join(' '))+'</div></td><td>'+esc(v.vin||'—')+'<div class="muted">'+esc(v.licensePlate||'')+'</div></td><td>'+esc(v.driver?.name||'—')+'</td><td>'+esc(v.engineModel||'—')+'</td><td>'+esc(speed)+'</td><td>'+(v.odometerMiles!=null?esc(Number(v.odometerMiles).toLocaleString(undefined,{maximumFractionDigits:1})+' mi'):'—')+(v.odometerSource?'<div class="muted">'+esc(v.odometerSource)+'</div>':'')+'</td><td>'+(v.engineHours!=null?esc(Number(v.engineHours).toLocaleString(undefined,{maximumFractionDigits:1})+' h'):'—')+'</td><td>'+faultCell(v)+'</td><td>'+esc(v.gps?.location||v.gps?.reverseGeo?.formattedLocation||((v.gps?.latitude!=null&&v.gps?.longitude!=null)?Number(v.gps.latitude).toFixed(5)+', '+Number(v.gps.longitude).toFixed(5):'—'))+'</td><td>'+esc(v.gps?.time?fmtDateTime(v.gps.time):'—')+'</td></tr>'}).join('')+'</tbody></table></div>':'<div class="muted">No Samsara vehicles match this search.</div>';
 out.querySelectorAll('[data-fault-id]').forEach(btn=>btn.onclick=()=>window.openSamsaraFaultModal?.(btn.dataset.faultId,btn.dataset.faultName));
}
`;
    s=s.slice(0,a)+renderer+s.slice(b);
  }
  fs.writeFileSync(fp,s);
}

// Fix Samsara's documented J1939 field names in the runtime-generated backend.
const sp='server.js';
let s=fs.readFileSync(sp,'utf8');
s=s.replace(
  "spn:z.suspectParameterNumber??z.spn??null,fmi:z.failureModeIdentifier??z.fmi??null,description:z.description??z.name??z.label??z.faultDescription??'',occurrenceCount:z.occurrenceCount??z.count??null",
  "spn:z.spnId??z.suspectParameterNumber??z.spn?.id??z.spn??null,fmi:z.fmiId??z.failureModeIdentifier??z.fmi?.id??z.fmi??null,description:z.spnDescription??z.fmiDescription??z.vendorDtcDescription??z.description??z.name??z.label??z.faultDescription??'',occurrenceCount:z.occurrenceCount??z.count??null"
);
fs.writeFileSync(sp,s);
console.log('ITTR v24.25.7 Samsara fault-code parser + clickable Fleet renderer applied');
