import fs from 'node:fs';

const serverPath='server.js';
let s=fs.readFileSync(serverPath,'utf8');

// 1) Parse Samsara vehicle names as TRUCK#/TRAILER# + label/driver.
const oldSnapshot="function samsaraSnapshot(v){const g=v?.location||v?.gps||{},d=v?.driver||v?.staticAssignedDriver||{};return{id:String(v?.id||''),name:String(v?.name||''),vin:samsaraNormVin(v?.vin),unit:String(v?.name||''),plate:String(v?.licensePlate||v?.licensePlateNumber||''),make:String(v?.make||''),model:String(v?.model||''),year:String(v?.year||''),driverName:String(d?.name||v?.driverName||''),location:String(g?.formattedLocation||g?.address||''),latitude:Number(g?.latitude??g?.lat??0)||null,longitude:Number(g?.longitude??g?.lng??0)||null,speedMph:Number(g?.speedMilesPerHour??g?.speedMph??0)||null,ignition:String(v?.engineState?.value||v?.engineState||v?.ignitionStatus||''),lastSeen:String(g?.time||g?.timestamp||v?.updatedAtTime||'')||null}}";
const newSnapshot="function samsaraParseUnitName(name){const raw=String(name||'').trim(),m=raw.match(/^([^\\s\\/]+)\\s*\\/\\s*([^\\s]+)(?:\\s+(.+))?$/);return m?{raw,truckNumber:String(m[1]||'').trim(),trailerNumber:String(m[2]||'').trim(),labelRemainder:String(m[3]||'').trim()}:{raw,truckNumber:raw.split(/\\s+/)[0]||raw,trailerNumber:'',labelRemainder:raw.split(/\\s+/).slice(1).join(' ')}}\nfunction samsaraSnapshot(v){const g=v?.location||v?.gps||{},d=v?.driver||v?.staticAssignedDriver||{},parsed=samsaraParseUnitName(v?.name);return{id:String(v?.id||''),name:String(v?.name||''),vin:samsaraNormVin(v?.vin),unit:parsed.truckNumber,truckNumber:parsed.truckNumber,trailerNumber:parsed.trailerNumber,labelRemainder:parsed.labelRemainder,plate:String(v?.licensePlate||v?.licensePlateNumber||''),make:String(v?.make||''),model:String(v?.model||''),year:String(v?.year||''),driverName:String(d?.name||v?.driverName||parsed.labelRemainder||''),location:String(g?.formattedLocation||g?.address||''),latitude:Number(g?.latitude??g?.lat??0)||null,longitude:Number(g?.longitude??g?.lng??0)||null,speedMph:Number(g?.speedMilesPerHour??g?.speedMph??0)||null,ignition:String(v?.engineState?.value||v?.engineState||v?.ignitionStatus||''),lastSeen:String(g?.time||g?.timestamp||v?.updatedAtTime||'')||null}}";
if(s.includes(oldSnapshot)) s=s.replace(oldSnapshot,newSnapshot);
else if(!s.includes('function samsaraParseUnitName(')) throw new Error('Samsara snapshot signature changed; refusing unsafe patch');

// 2) If a VIN exists more than once in legacy ITTR data, use parsed truck number to disambiguate that VIN set.
const oldMatch="else if(v.vin.length===17&&(byVin.get(v.vin)||[]).length){a=byVin.get(v.vin);method='vin'}else if(v.unit&&(byUnit.get(samsaraNormUnit(v.unit))||[]).length){a=byUnit.get(samsaraNormUnit(v.unit));method='unit'}";
const newMatch="else if(v.vin.length===17&&(byVin.get(v.vin)||[]).length){const vinMatches=byVin.get(v.vin)||[],unitMatches=v.unit?(byUnit.get(samsaraNormUnit(v.unit))||[]):[];if(vinMatches.length===1){a=vinMatches;method='vin'}else{const unitIds=new Set(unitMatches.map(x=>String(x.id))),intersection=vinMatches.filter(x=>unitIds.has(String(x.id)));a=intersection.length===1?intersection:vinMatches;method=intersection.length===1?'vin+truck':'vin'}}else if(v.unit&&(byUnit.get(samsaraNormUnit(v.unit))||[]).length){a=byUnit.get(samsaraNormUnit(v.unit));method='truck'}";
if(s.includes(oldMatch)) s=s.replace(oldMatch,newMatch);
else if(!s.includes("method=intersection.length===1?'vin+truck':'vin'")) throw new Error('Samsara matcher signature changed; refusing unsafe patch');

// 3) Replace the older multi-endpoint Fleet implementation with the same proven vehicle source used by Preview.
const fleetStart=s.indexOf("app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res,next)=>{");
const normStart=s.indexOf('function samsaraNormVin',fleetStart);
if(fleetStart<0||normStart<0) throw new Error('Samsara Fleet route boundary not found');
const fleetRoute=`app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res)=>{\n try{\n  const vehicles=await samsaraAllVehicles();\n  const items=vehicles.map(raw=>{const v=samsaraSnapshot(raw);return{id:v.id,name:v.name,truckNumber:v.truckNumber,trailerNumber:v.trailerNumber,vin:v.vin,licensePlate:v.plate,year:v.year,make:v.make,model:v.model,driver:{name:v.driverName},engineState:v.ignition,gps:{location:v.location,latitude:v.latitude,longitude:v.longitude,speedMilesPerHour:v.speedMph,time:v.lastSeen}}});\n  res.set('Cache-Control','no-store');res.json({ok:true,items,updatedAt:new Date().toISOString(),source:'fleet/vehicles'});\n }catch(e){console.error('[Samsara fleet]',e);res.status(Number(e.status)||500).json({ok:false,error:'Samsara Fleet failed',detail:e.message||String(e),build:'24.24.7'})}\n});\n`;
s=s.slice(0,fleetStart)+fleetRoute+s.slice(normStart);

s=s.replaceAll("build:'24.24.5'","build:'24.24.7'").replaceAll("build:'24.24.6'","build:'24.24.7'");
fs.writeFileSync(serverPath,s);

// 4) Make Preview visibly show parsed truck/trailer and candidate ITTR records.
const frontPath='public/modules/procenter.js';
let f=fs.readFileSync(frontPath,'utf8');
const oldCard="<b>${esc(x.name||x.unit||'Unnamed')}</b> · VIN ${esc(x.vin||'—')} · ${x.matchStatus}";
const newCard="<b>Truck ${esc(x.truckNumber||x.unit||'—')}</b>${x.trailerNumber?` / Trailer ${esc(x.trailerNumber)}`:''}${x.driverName?` · ${esc(x.driverName)}`:''} · VIN ${esc(x.vin||'—')} · <b>${esc(x.matchStatus)}</b>${x.matchMethod?` · via ${esc(x.matchMethod)}`:''}${x.matches?.length?`<div class=\"muted\" style=\"margin-top:5px\">ITTR candidate${x.matches.length>1?'s':''}: ${x.matches.map(m=>`${esc(m.customer||'Unknown customer')} · Unit ${esc(m.unit||'—')} · VIN ${esc(m.vin||'—')}`).join(' | ')}</div>`:''}";
if(f.includes(oldCard)) f=f.replace(oldCard,newCard);
else if(!f.includes('ITTR candidate')) throw new Error('Samsara Preview UI signature changed; refusing unsafe patch');
fs.writeFileSync(frontPath,f);

// Keep duplicate module tree synchronized if it exists.
if(fs.existsSync('modules/procenter.js')) fs.copyFileSync(frontPath,'modules/procenter.js');

console.log('ITTR Samsara v24.24.7 patch applied: truck/trailer parser, VIN+truck disambiguation, Fleet route, review UI');
