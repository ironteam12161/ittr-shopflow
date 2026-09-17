import fs from 'node:fs';

// Compatibility-only startup patch.
// Newer releases already contain the Samsara fleet implementation, so this old
// v24.24.9 string-rewrite must NEVER prevent the production server from booting.
const serverPath='server.js';
if(!fs.existsSync(serverPath)){
  console.warn('[ITTR startup] server.js missing; skipping legacy Samsara patch');
  process.exit(0);
}
let s=fs.readFileSync(serverPath,'utf8');
const fleetNeedle="app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res,next)=>{";
const fleetStart=s.indexOf(fleetNeedle);
const normStart=fleetStart>=0?s.indexOf('function samsaraNormVin',fleetStart):-1;

if(fleetStart<0||normStart<0){
  console.log('[ITTR startup] legacy Samsara v24.24.9 patch not applicable; current canonical/newer route preserved');
  process.exit(0);
}

// The legacy route shape still exists. Preserve the previously deployed patch,
// but keep all boundary checks non-fatal so a future route refactor cannot crash Railway.
try{
  const fleetRoute=`app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res)=>{\n try{\n  const vehicles=await samsaraPaged('/fleet/vehicles'),warnings=[];\n  async function optional(label,fn){try{return await fn()}catch(e){console.warn('[Samsara '+label+']',e?.status||'',e?.message||e);warnings.push({source:label,status:Number(e?.status)||null,message:e?.message||String(e)});return []}}\n  const [gpsStats,odoStats,diagStats,drivers]=await Promise.all([optional('GPS / engine state',()=>samsaraPaged('/fleet/vehicles/stats',{types:'gps,engineStates'})),optional('Mileage',()=>samsaraPaged('/fleet/vehicles/stats',{types:'obdOdometerMeters,gpsOdometerMeters'})),optional('Fault codes / engine hours',()=>samsaraPaged('/fleet/vehicles/stats',{types:'faultCodes,obdEngineSeconds'})),optional('Drivers',()=>samsaraPaged('/fleet/drivers'))]);\n  const gm=new Map(gpsStats.map(x=>[String(x.id),x])),om=new Map(odoStats.map(x=>[String(x.id),x])),xm=new Map(diagStats.map(x=>[String(x.id),x])),dm=new Map(drivers.map(x=>[String(x.id),x]));\n  const items=vehicles.map(v=>{const g=gm.get(String(v.id))||{},o=om.get(String(v.id))||{},x=xm.get(String(v.id))||{},gps=g.gps||null,did=String(v.staticAssignedDriver?.id||v.driver?.id||''),driver=dm.get(did)||v.staticAssignedDriver||v.driver||null,obd=Number(o.obdOdometerMeters?.value),go=Number(o.gpsOdometerMeters?.value),meters=Number.isFinite(obd)&&obd>0?obd:(Number.isFinite(go)&&go>0?go:null),sec=Number(x.obdEngineSeconds?.value);return{id:v.id,name:v.name||'',vin:v.vin||'',make:v.make||'',model:v.model||'',year:v.year||'',licensePlate:v.licensePlate||'',driver:driver?{id:driver.id,name:driver.name||''}:null,gps:gps?{time:gps.time||'',latitude:gps.latitude,longitude:gps.longitude,headingDegrees:gps.headingDegrees,speedMilesPerHour:Number(gps.speedMilesPerHour||0),location:gps.reverseGeo?.formattedLocation||gps.address||''}:null,engineState:g.engineStates?.value??g.engineStates??null,odometerMiles:meters==null?null:Math.round((meters/1609.344)*10)/10,odometerSource:Number.isFinite(obd)&&obd>0?'ECU/OBD':meters!=null?'GPS':'',engineHours:Number.isFinite(sec)&&sec>=0?Math.round((sec/3600)*10)/10:null,faultCodes:x.faultCodes||null};});\n  res.set('Cache-Control','no-store');res.json({ok:true,items,updatedAt:new Date().toISOString(),warnings});\n }catch(e){console.error('[Samsara fleet vehicles]',e);res.status(Number(e?.status)||500).json({ok:false,error:'Samsara vehicle list failed',detail:e?.message||String(e),build:'24.24.9'})}\n});\n`;
  s=s.slice(0,fleetStart)+fleetRoute+s.slice(normStart);
  fs.writeFileSync(serverPath,s);
  console.log('[ITTR startup] legacy Samsara v24.24.9 compatibility patch applied');
}catch(e){
  console.warn('[ITTR startup] legacy Samsara patch skipped safely:',e?.message||e);
}
