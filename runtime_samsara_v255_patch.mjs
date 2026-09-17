import fs from 'node:fs';
const sp='server.js';let s=fs.readFileSync(sp,'utf8');
const start=s.indexOf("app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res)=>{");
const end=s.indexOf('function samsaraNormVin',start);
if(start<0||end<0)throw new Error('v24.25.5 fleet boundary not found');
const route=String.raw`app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res)=>{
 try{
  const vehicles=await samsaraPaged('/fleet/vehicles'),warnings=[];
  async function opt(label,path,params){try{return await samsaraPaged(path,params)}catch(e){console.warn('[Samsara '+label+']',e?.status||'',e?.message||e);warnings.push({source:label,status:Number(e?.status)||null,message:e?.message||String(e)});return []}}
  const now=new Date(),startTime=new Date(now.getTime()-7*86400000).toISOString(),endTime=now.toISOString();
  const [gpsStats,odoStats,diagStats,drivers,assignments]=await Promise.all([
   opt('GPS / ECU speed','/fleet/vehicles/stats',{types:'gps,ecuSpeedMph'}),
   opt('Mileage / engine hours','/fleet/vehicles/stats',{types:'obdOdometerMeters,obdEngineSeconds'}),
   opt('Fault codes','/fleet/vehicles/stats',{types:'faultCodes'}),
   opt('Drivers','/fleet/drivers'),
   opt('Driver assignments','/fleet/driver-vehicle-assignments',{filterBy:'vehicles',startTime,endTime})
  ]);
  const by=rows=>new Map(rows.map(x=>[String(x.id||x.vehicle?.id||''),x]));
  const gm=by(gpsStats),om=by(odoStats),xm=by(diagStats),dm=new Map(drivers.map(d=>[String(d.id),d])),am=new Map();
  for(const a of assignments){const vid=String(a.vehicleId||a.vehicle?.id||''),did=String(a.driverId||a.driver?.id||'');if(!vid||!did)continue;const t=Date.parse(a.assignedAtTime||a.startTime||0)||0,p=am.get(vid);if(!p||t>=p.t)am.set(vid,{driverId:did,t,type:a.assignmentType||a.type||''})}
  const last=x=>Array.isArray(x)?(x[x.length-1]||null):x;
  const num=x=>{const z=last(x),v=Number(z?.value??z);return Number.isFinite(v)?v:null};
  const reading=x=>last(x?.faultCodes)||null;
  const j1939=r=>{const root=r?.value??r??{},j=root.j1939?.diagnosticTroubleCodes??root.j1939?.dtcs??root.j1939??root.diagnosticTroubleCodes??root.activeDiagnosticTroubleCodes??[];return Array.isArray(j)?j:[]};
  const items=vehicles.map(v=>{const id=String(v.id),g=gm.get(id)||{},o=om.get(id)||{},x=xm.get(id)||{},gps=last(g.gps),ecu=num(g.ecuSpeedMph),obd=num(o.obdOdometerMeters),sec=num(o.obdEngineSeconds),fr=reading(x),faults=j1939(fr),as=am.get(id),did=String(as?.driverId||v.staticAssignedDriver?.id||v.driver?.id||''),driver=dm.get(did)||v.staticAssignedDriver||v.driver||null,gpsSp=Number(gps?.speedMilesPerHour);const speed=ecu!=null?ecu:(Number.isFinite(gpsSp)?gpsSp:null);return{id:v.id,name:v.name||'',vin:v.vin||'',make:v.make||'',model:v.model||'',year:v.year||'',licensePlate:v.licensePlate||'',driver:driver?{id:driver.id||did,name:driver.name||[driver.firstName,driver.lastName].filter(Boolean).join(' '),phone:driver.phone||'',assignmentType:as?.type||''}:null,engineModel:v.engineModel||v.engine?.model||v.attributes?.engineModel||v.attributes?.engineType||'',gps:gps?{time:gps.time||gps.timestamp||'',latitude:gps.latitude,longitude:gps.longitude,headingDegrees:gps.headingDegrees,speedMilesPerHour:Number.isFinite(gpsSp)?gpsSp:null,reverseGeo:gps.reverseGeo||null,location:gps.reverseGeo?.formattedLocation||gps.address||gps.formattedLocation||''}:null,gpsSpeedMph:{value:speed,time:last(g.ecuSpeedMph)?.time||gps?.time||''},odometerMiles:obd==null?null:Math.round(obd/160.9344)/10,odometerSource:obd==null?'':'ECU/OBD',engineHours:sec==null?null:Math.round(sec/360)/10,faultCount:faults.length,faultCodes:fr,hasDiagnosticData:!!fr};});
  res.set('Cache-Control','no-store');res.json({ok:true,items,updatedAt:new Date().toISOString(),warnings});
 }catch(e){console.error('[Samsara fleet v24.25.5]',e);res.status(Number(e?.status)||500).json({ok:false,error:'Samsara vehicle list failed',detail:e?.message||String(e),build:'24.25.5'})}
});

app.get('/api/samsara/vehicle-faults',auth,async(req,res)=>{
 try{const vehicleId=String(req.query.vehicleId||'').trim();if(!vehicleId)return res.status(400).json({ok:false,error:'vehicleId is required'});const rows=await samsaraPaged('/fleet/vehicles/stats',{types:'faultCodes',vehicleIds:vehicleId}),row=rows.find(r=>String(r.id||r.vehicle?.id||'')===vehicleId)||rows[0]||null,reading=Array.isArray(row?.faultCodes)?row.faultCodes[row.faultCodes.length-1]:row?.faultCodes||null,root=reading?.value??reading??{},j=root.j1939?.diagnosticTroubleCodes??root.j1939?.dtcs??root.j1939??root.diagnosticTroubleCodes??root.activeDiagnosticTroubleCodes??[],arr=Array.isArray(j)?j:[],faults=arr.map(z=>({spn:z.suspectParameterNumber??z.spn??null,fmi:z.failureModeIdentifier??z.fmi??null,description:z.description??z.name??z.label??z.faultDescription??'',occurrenceCount:z.occurrenceCount??z.count??null,sourceAddress:z.sourceAddress??null,active:z.active!==false})).filter(z=>z.spn!=null||z.fmi!=null||z.description);res.set('Cache-Control','no-store');res.json({ok:true,vehicleId,time:reading?.time||reading?.timestamp||'',count:faults.length,faults,hasDiagnosticData:!!reading,raw:reading});}catch(e){res.status(Number(e?.status)||500).json({ok:false,error:'Unable to load Samsara fault codes',detail:e?.message||String(e),build:'24.25.5'})}
});

`;
s=s.slice(0,start)+route+s.slice(end);fs.writeFileSync(sp,s);
const fp='public/modules/procenter.js';let f=fs.readFileSync(fp,'utf8');
f+=String.raw`
function ittrSamsaraV255FaultButton(v){const n=Number(v.faultCount||0),has=!!v.hasDiagnosticData||!!v.faultCodes;if(!has)return 'None reported';const label=n>0?'⚠️ '+n+' Fault Code'+(n===1?'':'s'):'⚠️ View Diagnostics';return '<button type="button" onclick="openSamsaraFaultModal(\''+esc(v.id)+'\',\''+esc(String(v.name||'Vehicle').replace(/'/g,'&#39;'))+'\')" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:6px 9px;font-weight:700;cursor:pointer">'+label+'</button>'}
window.renderSamsaraFleet=function(){const out=document.getElementById('samsaraFleetResults');if(!out)return;const cache=(typeof samsaraFleetCache!=='undefined'?samsaraFleetCache:(window.samsaraFleetCache||[])),q=String(document.getElementById('samsaraFleetSearch')?.value||'').trim().toLowerCase(),rows=cache.filter(v=>!q||[v.name,v.vin,v.licensePlate,v.driver?.name,ittrSamsaraLocation(v)].join(' ').toLowerCase().includes(q));out.innerHTML='<div style="overflow:auto"><table class="table"><thead><tr><th>Vehicle</th><th>VIN / Plate</th><th>Driver</th><th>Engine</th><th>Speed</th><th>Mileage</th><th>Engine Hrs</th><th>Faults</th><th>Last Location</th><th>Updated</th></tr></thead><tbody>'+rows.map(v=>{const raw=v.gpsSpeedMph?.value,sp=(raw===null||raw===undefined||raw==='')?null:Number(raw),speed=Number.isFinite(sp)?(Math.round(sp*10)/10)+' mph':'—';return '<tr><td><b>'+esc(v.name||'—')+'</b><br><span class="muted">'+esc([v.year,v.make,v.model].filter(Boolean).join(' '))+'</span></td><td>'+esc(v.vin||'—')+(v.licensePlate?'<br>'+esc(v.licensePlate):'')+'</td><td>'+esc(v.driver?.name||'—')+'</td><td>'+esc(v.engineModel||'—')+'</td><td>'+esc(speed)+'</td><td>'+(v.odometerMiles!=null?esc(Number(v.odometerMiles).toLocaleString(undefined,{maximumFractionDigits:1})+' mi'):'—')+'</td><td>'+(v.engineHours!=null?esc(Number(v.engineHours).toLocaleString(undefined,{maximumFractionDigits:1})+' h'):'—')+'</td><td>'+ittrSamsaraV255FaultButton(v)+'</td><td>'+esc(ittrSamsaraLocation(v))+'</td><td>'+esc(ittrFmtSamsaraTime(v.gps?.time||v.gpsSpeedMph?.time))+'</td></tr>'}).join('')+'</tbody></table></div>'}
`;
fs.writeFileSync(fp,f);if(fs.existsSync('modules/procenter.js'))fs.copyFileSync(fp,'modules/procenter.js');console.log('ITTR Samsara v24.25.5 applied');