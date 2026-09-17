import fs from 'node:fs';

const serverPath='server.js';
let s=fs.readFileSync(serverPath,'utf8');

// v24.24.8 — Samsara production telemetry + mechanic AI grounding.
// This patch deliberately PRESERVES the canonical /fleet/vehicles/stats route.

// 1) Parse Samsara names as TRUCK#/TRAILER# + label/driver.
const oldSnapshot="function samsaraSnapshot(v){const g=v?.location||v?.gps||{},d=v?.driver||v?.staticAssignedDriver||{};return{id:String(v?.id||''),name:String(v?.name||''),vin:samsaraNormVin(v?.vin),unit:String(v?.name||''),plate:String(v?.licensePlate||v?.licensePlateNumber||''),make:String(v?.make||''),model:String(v?.model||''),year:String(v?.year||''),driverName:String(d?.name||v?.driverName||''),location:String(g?.formattedLocation||g?.address||''),latitude:Number(g?.latitude??g?.lat??0)||null,longitude:Number(g?.longitude??g?.lng??0)||null,speedMph:Number(g?.speedMilesPerHour??g?.speedMph??0)||null,ignition:String(v?.engineState?.value||v?.engineState||v?.ignitionStatus||''),lastSeen:String(g?.time||g?.timestamp||v?.updatedAtTime||'')||null}}";
const newSnapshot="function samsaraParseUnitName(name){const raw=String(name||'').trim(),m=raw.match(/^([^\\s\\/]+)\\s*\\/\\s*([^\\s]+)(?:\\s+(.+))?$/);return m?{raw,truckNumber:String(m[1]||'').trim(),trailerNumber:String(m[2]||'').trim(),labelRemainder:String(m[3]||'').trim()}:{raw,truckNumber:raw.split(/\\s+/)[0]||raw,trailerNumber:'',labelRemainder:raw.split(/\\s+/).slice(1).join(' ')}}\nfunction samsaraSnapshot(v){const g=v?.location||v?.gps||{},d=v?.driver||v?.staticAssignedDriver||{},parsed=samsaraParseUnitName(v?.name);return{id:String(v?.id||''),name:String(v?.name||''),vin:samsaraNormVin(v?.vin),unit:parsed.truckNumber,truckNumber:parsed.truckNumber,trailerNumber:parsed.trailerNumber,labelRemainder:parsed.labelRemainder,plate:String(v?.licensePlate||v?.licensePlateNumber||''),make:String(v?.make||''),model:String(v?.model||''),year:String(v?.year||''),driverName:String(d?.name||v?.driverName||parsed.labelRemainder||''),location:String(g?.formattedLocation||g?.address||''),latitude:Number(g?.latitude??g?.lat??0)||null,longitude:Number(g?.longitude??g?.lng??0)||null,speedMph:Number(g?.speedMilesPerHour??g?.speedMph??0)||null,ignition:String(v?.engineState?.value||v?.engineState||v?.ignitionStatus||''),lastSeen:String(g?.time||g?.timestamp||v?.updatedAtTime||'')||null}}";
if(s.includes(oldSnapshot)) s=s.replace(oldSnapshot,newSnapshot);
else if(!s.includes('function samsaraParseUnitName(')) throw new Error('Samsara snapshot signature changed; refusing unsafe patch');

// 2) VIN first; when duplicate legacy VINs exist, resolve with parsed truck number.
const oldMatch="else if(v.vin.length===17&&(byVin.get(v.vin)||[]).length){a=byVin.get(v.vin);method='vin'}else if(v.unit&&(byUnit.get(samsaraNormUnit(v.unit))||[]).length){a=byUnit.get(samsaraNormUnit(v.unit));method='unit'}";
const newMatch="else if(v.vin.length===17&&(byVin.get(v.vin)||[]).length){const vinMatches=byVin.get(v.vin)||[],unitMatches=v.unit?(byUnit.get(samsaraNormUnit(v.unit))||[]):[];if(vinMatches.length===1){a=vinMatches;method='vin'}else{const unitIds=new Set(unitMatches.map(x=>String(x.id))),intersection=vinMatches.filter(x=>unitIds.has(String(x.id)));a=intersection.length===1?intersection:vinMatches;method=intersection.length===1?'vin+truck':'vin'}}else if(v.unit&&(byUnit.get(samsaraNormUnit(v.unit))||[]).length){a=byUnit.get(samsaraNormUnit(v.unit));method='truck'}";
if(s.includes(oldMatch)) s=s.replace(oldMatch,newMatch);
else if(!s.includes("method=intersection.length===1?'vin+truck':'vin'")) throw new Error('Samsara matcher signature changed; refusing unsafe patch');

// 3) Live per-vehicle telemetry helper. Samsara limits snapshot requests to 3 stat types,
// so use two requests and merge them. OBD odometer is preferred, GPS odometer is fallback.
if(!s.includes('async function samsaraLiveTelemetry(')){
 const marker="app.get('/api/samsara/status',auth,managerPermission('customers')";
 const at=s.indexOf(marker);if(at<0)throw new Error('Samsara status route not found; refusing unsafe patch');
 const helper=`async function samsaraLiveTelemetry(vehicleId){\n const id=String(vehicleId||'').trim();if(!id)return null;\n const [primary,diagnostic]=await Promise.all([\n  samsaraPaged('/fleet/vehicles/stats',{vehicleIds:id,types:'gps,engineStates,obdOdometerMeters'}),\n  samsaraPaged('/fleet/vehicles/stats',{vehicleIds:id,types:'faultCodes,gpsOdometerMeters,obdEngineSeconds'})\n ]);\n const a=primary.find(x=>String(x.id)===id)||{},b=diagnostic.find(x=>String(x.id)===id)||{};\n const gps=a.gps||null,obd=Number(a.obdOdometerMeters?.value),gpsOdo=Number(b.gpsOdometerMeters?.value),engineSec=Number(b.obdEngineSeconds?.value);\n const meters=Number.isFinite(obd)&&obd>0?obd:(Number.isFinite(gpsOdo)&&gpsOdo>0?gpsOdo:null);\n return {vehicleId:id,gps:gps?{time:gps.time||'',latitude:gps.latitude,longitude:gps.longitude,headingDegrees:gps.headingDegrees,speedMilesPerHour:Number(gps.speedMilesPerHour||0),location:gps.reverseGeo?.formattedLocation||gps.address||''}:null,engineState:a.engineStates?.value??a.engineStates??null,odometerMiles:meters==null?null:Math.round((meters/1609.344)*10)/10,odometerSource:Number.isFinite(obd)&&obd>0?'ECU/OBD':meters!=null?'GPS':'',engineHours:Number.isFinite(engineSec)&&engineSec>=0?Math.round((engineSec/3600)*10)/10:null,faultCodes:b.faultCodes||null,faultTime:b.faultCodes?.time||null};\n}\n\n`;
 s=s.slice(0,at)+helper+s.slice(at);
}

// 4) Enhance the canonical Fleet route; DO NOT replace it with /fleet/vehicles-only data.
const oldPromise="const [vehicles,stats,drivers]=await Promise.all([\n   samsaraPaged('/fleet/vehicles'),\n   samsaraPaged('/fleet/vehicles/stats',{types:'gps,engineStates,obdOdometerMeters'}),\n   samsaraPaged('/fleet/drivers')\n  ]);\n  const sm=new Map(stats.map(x=>[String(x.id),x])),dm=new Map(drivers.map(x=>[String(x.id),x]));";
const newPromise="const [vehicles,stats,drivers,diagnostics]=await Promise.all([\n   samsaraPaged('/fleet/vehicles'),\n   samsaraPaged('/fleet/vehicles/stats',{types:'gps,engineStates,obdOdometerMeters'}),\n   samsaraPaged('/fleet/drivers'),\n   samsaraPaged('/fleet/vehicles/stats',{types:'faultCodes,gpsOdometerMeters,obdEngineSeconds'})\n  ]);\n  const sm=new Map(stats.map(x=>[String(x.id),x])),dx=new Map(diagnostics.map(x=>[String(x.id),x])),dm=new Map(drivers.map(x=>[String(x.id),x]));";
if(s.includes(oldPromise))s=s.replace(oldPromise,newPromise);
else if(!s.includes('dx=new Map(diagnostics.map'))throw new Error('Canonical Samsara Fleet Promise.all signature changed');

const oldReturn="engineState:st.engineStates?.value??st.engineStates??null,odometerMeters:st.obdOdometerMeters?.value??st.obdOdometerMeters??null};";
const newReturn="engineState:st.engineStates?.value??st.engineStates??null,odometerMeters:st.obdOdometerMeters?.value??st.obdOdometerMeters??null,odometerMiles:(()=>{const d=dx.get(String(v.id))||{},m=Number(st.obdOdometerMeters?.value),g=Number(d.gpsOdometerMeters?.value),x=Number.isFinite(m)&&m>0?m:(Number.isFinite(g)&&g>0?g:null);return x==null?null:Math.round((x/1609.344)*10)/10})(),odometerSource:(()=>{const d=dx.get(String(v.id))||{},m=Number(st.obdOdometerMeters?.value),g=Number(d.gpsOdometerMeters?.value);return Number.isFinite(m)&&m>0?'ECU/OBD':Number.isFinite(g)&&g>0?'GPS':''})(),engineHours:(()=>{const d=dx.get(String(v.id))||{},sec=Number(d.obdEngineSeconds?.value);return Number.isFinite(sec)&&sec>=0?Math.round((sec/3600)*10)/10:null})(),faultCodes:(dx.get(String(v.id))||{}).faultCodes||null};";
if(s.includes(oldReturn))s=s.replace(oldReturn,newReturn);
else if(!s.includes('odometerSource:(()=>'))throw new Error('Canonical Samsara Fleet return signature changed');

// 5) Ground Workshop AI in live Samsara data. /api/ai/shop-chat is auth-only already,
// so mechanics can ask read-only questions without receiving manager/admin controls.
const contextMarker=" const context={\n  unit:unit?{unitNumber:unit.unit_number,vin:unit.vin,year:unit.year,make:unit.make,model:unit.model,mileage:unit.mileage,engine:unit.engine,transmission:unit.transmission}:null,";
if(s.includes(contextMarker)){
 const replacement=" let samsaraLive=null;if(unit?.samsara_vehicle_id){try{samsaraLive=await samsaraLiveTelemetry(unit.samsara_vehicle_id)}catch(e){console.warn('[Workshop AI Samsara]',e?.status||'',e?.message||e)}}\n const context={\n  unit:unit?{unitNumber:unit.unit_number,vin:unit.vin,year:unit.year,make:unit.make,model:unit.model,mileage:unit.mileage,engine:unit.engine,transmission:unit.transmission}:null,\n  samsaraLive,";
 s=s.replace(contextMarker,replacement);
}else if(!s.includes('samsaraLive=await samsaraLiveTelemetry'))throw new Error('Workshop AI context signature changed');

const systemNeedle='Keep answers concise and mechanic-friendly, with bullets when useful.`;';
const systemReplacement='For CURRENT mileage, location, speed, engine state, engine hours or fault-code questions, use samsaraLive when available and clearly identify it as live/last-known Samsara telemetry with its timestamp. Prefer Samsara ECU/OBD odometer over stored ITTR mileage when the user asks for current mileage. Never invent a location or fault code when Samsara did not report one. Keep answers concise and mechanic-friendly, with bullets when useful.`;';
if(s.includes(systemNeedle))s=s.replace(systemNeedle,systemReplacement);
else if(!s.includes('Prefer Samsara ECU/OBD odometer'))throw new Error('Workshop AI system prompt signature changed');

const sourceNeedle=" const sources=[];if(unit){if(history.length)sources.push({type:'history',label:`Fullbay history · Unit ${unit.unit_number}`});";
const sourceReplacement=" const sources=[];if(unit&&samsaraLive)sources.push({type:'samsara',label:`Samsara live telemetry · Unit ${unit.unit_number}`});if(unit){if(history.length)sources.push({type:'history',label:`Fullbay history · Unit ${unit.unit_number}`});";
if(s.includes(sourceNeedle))s=s.replace(sourceNeedle,sourceReplacement);
else if(!s.includes("type:'samsara'"))throw new Error('Workshop AI sources signature changed');

s=s.replaceAll("build:'24.24.5'","build:'24.24.8'").replaceAll("build:'24.24.6'","build:'24.24.8'").replaceAll("build:'24.24.7'","build:'24.24.8'");
fs.writeFileSync(serverPath,s);

// 6) Frontend: keep parsed preview and expose live mileage/engine hours/fault status.
const frontPath='public/modules/procenter.js';
let f=fs.readFileSync(frontPath,'utf8');
const oldCard="<b>${esc(x.name||x.unit||'Unnamed')}</b> · VIN ${esc(x.vin||'—')} · ${x.matchStatus}";
const newCard="<b>Truck ${esc(x.truckNumber||x.unit||'—')}</b>${x.trailerNumber?` / Trailer ${esc(x.trailerNumber)}`:''}${x.driverName?` · ${esc(x.driverName)}`:''} · VIN ${esc(x.vin||'—')} · <b>${esc(x.matchStatus)}</b>${x.matchMethod?` · via ${esc(x.matchMethod)}`:''}${x.matches?.length?`<div class=\"muted\" style=\"margin-top:5px\">ITTR candidate${x.matches.length>1?'s':''}: ${x.matches.map(m=>`${esc(m.customer||'Unknown customer')} · Unit ${esc(m.unit||'—')} · VIN ${esc(m.vin||'—')}`).join(' | ')}</div>`:''}";
if(f.includes(oldCard))f=f.replace(oldCard,newCard);

const fleetStart=f.indexOf('function renderSamsaraFleet(){');
const fleetEnd=f.indexOf('\nasync function auditDuplicateCustomers()',fleetStart);
if(fleetStart<0||fleetEnd<0)throw new Error('Samsara Fleet renderer boundary not found');
const renderer=`function samsaraFaultSummary(fc){if(!fc)return 'None reported';const text=JSON.stringify(fc);const codes=[...new Set((text.match(/\\b(?:P|C|B|U)[0-9A-F]{4}\\b/gi)||[]).map(x=>x.toUpperCase()))];const j1939=[...new Set((text.match(/(?:SPN\\s*[:#]?\\s*\\d+[^0-9]+FMI\\s*[:#]?\\s*\\d+)/gi)||[]))];const all=[...codes,...j1939];return all.length?all.slice(0,5).join(', '):(/checkEngineLightIsOn\\\":true/i.test(text)?'Check engine light / fault reported':'None reported')}\nfunction renderSamsaraFleet(){const out=document.getElementById('samsaraFleetResults');if(!out)return;const q=String(document.getElementById('samsaraSearch')?.value||'').toLowerCase().trim();const rows=samsaraFleetCache.filter(v=>!q||[v.name,v.vin,v.licensePlate,v.driver?.name,v.gps?.location,v.make,v.model,samsaraFaultSummary(v.faultCodes)].join(' ').toLowerCase().includes(q));out.innerHTML=rows.length?\`<div class="tableWrap"><table><thead><tr><th>Vehicle</th><th>VIN / Plate</th><th>Driver</th><th>Engine</th><th>Speed</th><th>Mileage</th><th>Engine Hrs</th><th>Faults</th><th>Last Location</th><th>Updated</th></tr></thead><tbody>\${rows.map(v=>\`<tr><td><b>\${esc(v.name||'—')}</b><div class="muted">\${esc([v.year,v.make,v.model].filter(Boolean).join(' '))}</div></td><td>\${esc(v.vin||'—')}<div class="muted">\${esc(v.licensePlate||'')}</div></td><td>\${esc(v.driver?.name||'—')}</td><td>\${esc(typeof v.engineState==='string'?v.engineState:(v.engineState?.value||'—'))}</td><td>\${Number(v.gps?.speedMilesPerHour||0).toFixed(0)} mph</td><td>\${v.odometerMiles!=null?Number(v.odometerMiles).toLocaleString()+' mi':'—'}<div class="muted">\${esc(v.odometerSource||'')}</div></td><td>\${v.engineHours!=null?Number(v.engineHours).toLocaleString():'—'}</td><td>\${esc(samsaraFaultSummary(v.faultCodes))}</td><td>\${esc(v.gps?.location||'—')}</td><td>\${esc(v.gps?.time?fmtDateTime(v.gps.time):'—')}</td></tr>\`).join('')}</tbody></table></div>\`:'<div class="muted">No Samsara vehicles match this search.</div>'}\n`;
f=f.slice(0,fleetStart)+renderer+f.slice(fleetEnd);
fs.writeFileSync(frontPath,f);
if(fs.existsSync('modules/procenter.js'))fs.copyFileSync(frontPath,'modules/procenter.js');

console.log('ITTR Samsara v24.24.8 verified/applied: live GPS/speed, ECU/GPS mileage, engine state/hours, faults, truck/trailer parsing, mechanic AI grounding');
