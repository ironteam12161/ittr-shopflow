import fs from 'node:fs';

const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let server=fs.readFileSync(serverPath,'utf8');

// The UI still contains legacy inline onclick/onchange/oninput handlers.
// Helmet merges custom CSP directives with its defaults, including
// script-src-attr 'none'. Explicitly allow inline handler attributes until
// those handlers are migrated to addEventListener.
const scriptSrcLine='  scriptSrc:["\'self\'","\'unsafe-inline\'","blob:"],\n';
const scriptAttrLine='  scriptSrcAttr:["\'unsafe-inline\'"],\n';
if(!server.includes('scriptSrcAttr:[')){
 if(!server.includes(scriptSrcLine))throw new Error('CSP script-src anchor not found');
 server=server.replace(scriptSrcLine,scriptSrcLine+scriptAttrLine);
}
if(!server.includes('scriptSrcAttr:["\'unsafe-inline\'"]'))throw new Error('CSP inline-handler compatibility fix was not applied');
fs.writeFileSync(serverPath,server,'utf8');

const proDefaults='{vehicles:[],maintenance:[],audit:[],notifications:[],delays:[]}';
const initialProLine=" PRO=fresh.pro?.payload??(session?.role==='mechanic'?{}:PRO);";
const initialLegacyLine=' PRO=fresh.pro?.payload||{};';
const normalizeProLine=` PRO=Object.assign(${proDefaults},PRO||{});for(const k of ['vehicles','maintenance','audit','notifications','delays'])if(!Array.isArray(PRO[k]))PRO[k]=[];`;
const refreshOld='apply("pro",payload=>{PRO=payload||{};localStorage.setItem(PRO_KEY,JSON.stringify(PRO))})';
const refreshNew=`apply("pro",payload=>{PRO=Object.assign(${proDefaults},payload||{});for(const k of ['vehicles','maintenance','audit','notifications','delays'])if(!Array.isArray(PRO[k]))PRO[k]=[];localStorage.setItem(PRO_KEY,JSON.stringify(PRO))})`;

for(const fp of ['index.html','public/index.html']){
 if(!fs.existsSync(fp))throw new Error(`${fp} missing`);
 let html=fs.readFileSync(fp,'utf8');

 if(!html.includes(normalizeProLine)){
  if(html.includes(initialProLine))html=html.replace(initialProLine,`${initialProLine}\n${normalizeProLine}`);
  else if(html.includes(initialLegacyLine))html=html.replace(initialLegacyLine,`${initialLegacyLine}\n${normalizeProLine}`);
  else throw new Error(`${fp}: Operations initial-state anchor not found`);
 }

 if(html.includes(refreshOld))html=html.replace(refreshOld,refreshNew);
 if(!html.includes(refreshNew))throw new Error(`${fp}: Operations refresh-state normalization fix was not applied`);

 fs.writeFileSync(fp,html,'utf8');
}

console.log('ITTR button/CSP + Operations state hotfix applied');
