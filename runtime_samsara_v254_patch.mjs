import fs from 'node:fs';
const sp='server.js';let s=fs.readFileSync(sp,'utf8');
const start=s.indexOf("app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res)=>{");
const end=s.indexOf('function samsaraNormVin',start);
if(start<0||end<0)throw new Error('v24.25.4 fleet boundary not found');
const route=String.raw`app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res)=>{
 try{
  const vehicles=await samsaraPaged('/fleet/vehicles'),warnings=[];
  async function opt(label,path,params){try{return await samsaraPaged(path,params)}catch(e){warnings.push({source:label,status:Number(e?.status)||null,message:e?.message||String(e)});return []}}
  // Samsara permits max 3 stat types/request. GPS itself includes speed + reverseGeo.
  const [gpsRows,runRows,faultRows,drivers]=await Promise.all([
   opt('GPS / speed','/fleet/vehicles/stats',{types:'gps,ecuSpeedMph'}),
   opt('Mileage / engine hours','/fleet/vehicles/stats',{types:'obdOdometerMeters,obdEngineSeconds'}),
   opt('Fault codes','/fleet/vehicles/stats',{types:'faultCodes'}),
   opt('Drivers','/fleet/drivers')
  ]);
  const mapRows=rows=>new Map(rows.map(r=>[String(r.id||r.vehicle?.id||''),r]));
  const gm=mapRows(gpsRows),rm=mapRows(runRows),fm=mapRows(faultRows),dm=new Map(drivers.map(d=>[String(d.id),d]));
  const reading=x=>Array.isArray(x)?(x[x.length-1]||null):x;
  const numberReading=x=>{const r=reading(x),n=Number(r?.value??r);return Number.isFinite(n)?n:null};
  function j1939(read){const root=read?.value??read??{};const j=root.j1939??root.j1939Faults??root;const arr=j.diagnosticTroubleCodes??j.activeDiagnosticTroubleCodes??j.dtcs??[];return Array.isArray(arr)?arr:[]}
  const items=vehicles.map(v=>{
   const id=String(v.id),g=gm.get(id)||{},r=rm.get(id)||{},f=fm.get(id)||{};
   const gps=reading(g.gps),ecuSpeed=numberReading(g.ecuSpeedMph),obd=numberReading(r.obdOdometerMeters),secs=numberReading(r.obdEngineSeconds),fr=reading(f.faultCodes),faults=j1939(fr);
   const did=String(v.staticAssignedDriver?.id||v.driver?.id||''),driver=dm.get(did)||v.staticAssignedDriver||v.driver||null;
   const gpsSpeed=Number(gps?.speedMilesPerHour),speed=ecuSpeed??(Number.isFinite(gpsSpeed)?gpsSpeed:null);
   return {id:v.id,name:v.name||'',vin:v.vin||'',make:v.make||'',model:v.model||'',year:v.year||'',licensePlate:v.licensePlate||'',engineModel:v.engineModel||v.engine?.model||v.attributes?.engineModel||v.attributes?.engineType||'',driver:driver?{id:driver.id||did,name:driver.name||[driver.firstName,driver.lastName].filter(Boolean).join(' '),phone:driver.phone||''}:null,gps:gps?{time:gps.time||gps.timestamp||'',latitude:gps.latitude,longitude:gps.longitude,headingDegrees:gps.headingDegrees,reverseGeo:gps.reverseGeo||null,location:gps.reverseGeo?.formattedLocation||gps.formattedLocation||gps.address||''}:null,gpsSpeedMph:{value:speed,time:reading(g.ecuSpeedMph)?.time||gps?.time||''},odometerMiles:obd==null?null:Math.round(obd/160.9344)/10,odometerSource:obd==null?'':'ECU/OBD',engineHours:secs==null?null:Math.round(secs/360)/10,faultCount:faults.length,faultCodes:fr||null};
  });
  res.set('Cache-Control','no-store');res.json({ok:true,items,updatedAt:new Date().toISOString(),warnings});
 }catch(e){console.error('[Samsara fleet v24.25.4]',e);res.status(Number(e?.status)||500).json({ok:false,error:'Samsara vehicle list failed',detail:e?.message||String(e),build:'24.25.4'})}
});

app.get('/api/samsara/vehicle-faults',auth,async(req,res)=>{
 try{
  const vehicleId=String(req.query.vehicleId||'').trim();if(!vehicleId)return res.status(400).json({ok:false,error:'vehicleId is required'});
  const rows=await samsaraPaged('/fleet/vehicles/stats',{types:'faultCodes',vehicleIds:vehicleId});
  const row=rows.find(r=>String(r.id||r.vehicle?.id||'')===vehicleId)||rows[0]||null;
  const reading=Array.isArray(row?.faultCodes)?row.faultCodes[row.faultCodes.length-1]:row?.faultCodes||null,root=reading?.value??reading??{},j=root.j1939??root.j1939Faults??root,arr=j.diagnosticTroubleCodes??j.activeDiagnosticTroubleCodes??j.dtcs??[];
  const faults=(Array.isArray(arr)?arr:[]).map(z=>({spn:z.suspectParameterNumber??z.spn??null,fmi:z.failureModeIdentifier??z.fmi??null,description:z.description??z.name??z.label??z.faultDescription??'',occurrenceCount:z.occurrenceCount??z.count??null,sourceAddress:z.sourceAddress??null,active:z.active!==false})).filter(z=>z.spn!=null||z.fmi!=null||z.description);
  res.set('Cache-Control','no-store');res.json({ok:true,vehicleId,vehicleName:row?.name||'',time:reading?.time||reading?.timestamp||'',count:faults.length,faults,raw:reading});
 }catch(e){res.status(Number(e?.status)||500).json({ok:false,error:'Unable to load Samsara fault codes',detail:e?.message||String(e),build:'24.25.4'})}
});

`;
s=s.slice(0,start)+route+s.slice(end);fs.writeFileSync(sp,s);

const fp='public/modules/procenter.js';let f=fs.readFileSync(fp,'utf8');
f+=String.raw`
(function(){
 const css='.ittr-fault-btn{background:#fee2e2!important;color:#b91c1c!important;border:1px solid #fecaca!important;font-weight:700}.ittr-fault-overlay{position:fixed;inset:0;background:rgba(15,23,42,.58);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px}.ittr-fault-card{background:#fff;color:#111827;width:min(920px,96vw);max-height:88vh;overflow:auto;border-radius:16px;padding:20px;box-shadow:0 24px 80px #0006}.ittr-fault-table{width:100%;border-collapse:collapse}.ittr-fault-table th,.ittr-fault-table td{padding:10px;border-bottom:1px solid #e5e7eb;text-align:left}';if(!document.getElementById('ittrSamsaraFaultCss')){const st=document.createElement('style');st.id='ittrSamsaraFaultCss';st.textContent=css;document.head.appendChild(st)}
 window.openFaultModal=window.openSamsaraFaultModal=async function(vehicleId,vehicleName){let m=document.getElementById('samsaraFaultModal');if(!m){m=document.createElement('div');m.id='samsaraFaultModal';m.className='ittr-fault-overlay';m.innerHTML='<div class="ittr-fault-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h2 id="samsaraFaultTitle" style="margin:0">Fault Codes</h2><button class="btn" id="samsaraFaultClose">Close</button></div><div id="samsaraFaultBody" style="margin-top:14px"></div></div>';document.body.appendChild(m);m.onclick=e=>{if(e.target===m)m.remove()};m.querySelector('#samsaraFaultClose').onclick=()=>m.remove()}document.getElementById('samsaraFaultTitle').textContent=(vehicleName||'Vehicle')+' · Active J1939 Fault Codes';const body=document.getElementById('samsaraFaultBody');body.innerHTML='<div class="muted">Loading current Samsara diagnostics…</div>';try{const d=await apiJSON('/api/samsara/vehicle-faults?vehicleId='+encodeURIComponent(vehicleId));if(!d.faults?.length){body.innerHTML='<div class="notice">No active J1939 SPN/FMI codes in the latest Samsara fault reading.</div>';return}body.innerHTML='<div class="muted" style="margin-bottom:10px">Updated '+esc(d.time?new Date(d.time).toLocaleString():'—')+'</div><div style="overflow:auto"><table class="ittr-fault-table"><thead><tr><th>SPN</th><th>FMI</th><th>Description</th><th>Occurrence Count</th><th>Status</th></tr></thead><tbody>'+d.faults.map(z=>'<tr><td><b>SPN '+esc(z.spn??'—')+'</b></td><td>FMI '+esc(z.fmi??'—')+'</td><td>'+esc(z.description||'—')+'</td><td>'+esc(z.occurrenceCount??'—')+'</td><td>'+(z.active===false?'Inactive':'Active')+'</td></tr>').join('')+'</tbody></table></div>'}catch(e){body.innerHTML='<div class="notice error">'+esc(e.message||String(e))+'</div>'}}
 const loc=v=>v?.gps?.reverseGeo?.formattedLocation||v?.gps?.location||((v?.gps?.latitude!=null&&v?.gps?.longitude!=null)?Number(v.gps.latitude).toFixed(5)+', '+Number(v.gps.longitude).toFixed(5):'—');
 const tm=x=>{if(!x)return'—';const d=new Date(x);return Number.isNaN(d.getTime())?'—':d.toLocaleString()};
 window.renderSamsaraFleet=function(){const out=document.getElementById('samsaraFleetResults');if(!out)return;const cache=window.samsaraFleetCache||(typeof samsaraFleetCache!=='undefined'?samsaraFleetCache:[]),q=String(document.getElementById('samsaraFleetSearch')?.value||'').trim().toLowerCase(),rows=cache.filter(v=>!q||[v.name,v.vin,v.licensePlate,v.driver?.name,loc(v)].join(' ').toLowerCase().includes(q));out.innerHTML='<div style="overflow:auto"><table class="table"><thead><tr><th>Vehicle</th><th>VIN / Plate</th><th>Driver</th><th>Engine</th><th>Speed</th><th>Mileage</th><th>Engine Hrs</th><th>Faults</th><th>Last Location</th><th>Updated</th></tr></thead><tbody>'+rows.map(v=>{const n=Number(v.gpsSpeedMph?.value),speed=Number.isFinite(n)?Math.round(n)+' mph':'—',count=Number(v.faultCount||0),fault=v.faultCodes?'<button class="btn btn-sm ittr-fault-btn" data-fault-id="'+esc(v.id)+'" data-fault-name="'+esc(v.name||'Vehicle')+'">⚠️ '+(count||'View')+' Fault Code'+(count===1?'':'s')+'</button>':'None reported';return '<tr><td><b>'+esc(v.name||'—')+'</b><br><span class="muted">'+esc([v.year,v.make,v.model].filter(Boolean).join(' '))+'</span></td><td>'+esc(v.vin||'—')+(v.licensePlate?'<br>'+esc(v.licensePlate):'')+'</td><td>'+esc(v.driver?.name||'—')+'</td><td>'+esc(v.engineModel||'—')+'</td><td>'+esc(speed)+'</td><td>'+(v.odometerMiles!=null?esc(Number(v.odometerMiles).toLocaleString(undefined,{maximumFractionDigits:1})+' mi'):'—')+'</td><td>'+(v.engineHours!=null?esc(Number(v.engineHours).toLocaleString(undefined,{maximumFractionDigits:1})+' h'):'—')+'</td><td>'+fault+'</td><td>'+esc(loc(v))+'</td><td>'+esc(tm(v.gps?.time||v.gpsSpeedMph?.time))+'</td></tr>'}).join('')+'</tbody></table></div>';out.querySelectorAll('[data-fault-id]').forEach(b=>b.onclick=()=>openFaultModal(b.dataset.faultId,b.dataset.faultName))}
})();
`;
fs.writeFileSync(fp,f);if(fs.existsSync('modules/procenter.js'))fs.copyFileSync(fp,'modules/procenter.js');console.log('ITTR Samsara v24.25.4 hardened telemetry/fault UI applied');