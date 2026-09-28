import fs from 'node:fs';

const VERSION='24.27.1';
const BUILD=`ITTR-${VERSION}-FINAL-HARDENING-20260928`;

// Finalize server-facing version/cache behavior after all earlier compatibility patches.
const serverPath='server.js';
if(fs.existsSync(serverPath)){
  let s=fs.readFileSync(serverPath,'utf8');

  if(!s.includes('ITTR v24.27.1 runtime identity hardening')){
    const oldBuild='app.get("/api/build",(req,res)=>res.json({frontendExpected:"24.24.5",backend:"24.24.5",build:"ITTR-24.24.5-PRINT-LEGAL-PART-LOOKUP-20260914"}));';
    const newBuild=`// ITTR v24.27.1 runtime identity hardening\nconst ITTR_APP_VERSION=String(process.env.npm_package_version||"${VERSION}");\napp.get("/api/build",(req,res)=>res.json({frontendExpected:ITTR_APP_VERSION,backend:ITTR_APP_VERSION,build:\`ITTR-\${ITTR_APP_VERSION}-FINAL-HARDENING-20260928\`}));`;
    if(s.includes(oldBuild)) s=s.replace(oldBuild,newBuild);
    else if(!s.includes('const ITTR_APP_VERSION=')) console.warn('[ITTR startup] build endpoint signature changed; current implementation preserved');

    const oldHealth='app.get("/api/health",async(req,res)=>{let db=false;try{if(pool){await pool.query("SELECT 1");db=true}}catch{}res.json({ok:true,db,aiConfigured:Boolean(openRouterClient||client),aiProvider:openRouterClient?"openrouter":client?"openai":"none",version:"24.24.5",photoStorageConfigured:r2Configured})});';
    const newHealth='app.get("/api/health",async(req,res)=>{let db=false;try{if(pool){await pool.query("SELECT 1");db=true}}catch{}res.json({ok:true,db,aiConfigured:Boolean(openRouterClient||client),aiProvider:openRouterClient?"openrouter":client?"openai":"none",version:typeof ITTR_APP_VERSION!=="undefined"?ITTR_APP_VERSION:"'+VERSION+'",photoStorageConfigured:r2Configured})});';
    if(s.includes(oldHealth)) s=s.replace(oldHealth,newHealth);

    const oldStatic='if(filePath.endsWith("index.html") || filePath.includes(`${path.sep}modules${path.sep}`)){';
    const newStatic='if(filePath.endsWith("index.html") || filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest") || filePath.endsWith("invoice-workspace.css") || filePath.includes(`${path.sep}modules${path.sep}`)){';
    if(s.includes(oldStatic)) s=s.replace(oldStatic,newStatic);

    s=s.replaceAll('24.24.5',VERSION);
    s=s.replaceAll('ITTR-24.9.1-DYNAMIC-MODULES-20260914',BUILD);
    s='// ITTR v24.27.1 runtime identity hardening\n'+s;
    fs.writeFileSync(serverPath,s,'utf8');
  }
}

// Keep the visible build identity current and safely retire legacy offline queue entries
// that predate optimistic-concurrency baseVersion metadata. Preserve them in quarantine
// instead of silently deleting potentially useful local edits.
for(const fp of ['index.html','public/index.html']){
  if(!fs.existsSync(fp))continue;
  let h=fs.readFileSync(fp,'utf8');
  h=h.replaceAll('24.24.5',VERSION);
  h=h.replaceAll('ITTR-24.9.1-DYNAMIC-MODULES-20260914',BUILD);

  if(!h.includes('function quarantineUnsafeLegacySyncQueue(){')){
    const anchor='function persistentSyncCount(){return Object.keys(readPersistentSyncQueue()).length}';
    const helper=`function persistentSyncCount(){return Object.keys(readPersistentSyncQueue()).length}\nfunction quarantineUnsafeLegacySyncQueue(){\n try{\n  const q=readPersistentSyncQueue(),safe={},unsafe={};\n  for(const [key,item] of Object.entries(q||{})){if(Number(item?.baseVersion||0)>0)safe[key]=item;else unsafe[key]=item}\n  const count=Object.keys(unsafe).length;if(!count)return 0;\n  let archive={};try{archive=JSON.parse(localStorage.getItem("ittr_sync_queue_quarantine_v1")||"{}")||{}}catch(_){archive={}}\n  archive[new Date().toISOString()]={reason:"legacy_missing_base_version",items:unsafe};\n  const keys=Object.keys(archive).sort();while(keys.length>8){delete archive[keys.shift()]}\n  localStorage.setItem("ittr_sync_queue_quarantine_v1",JSON.stringify(archive));\n  writePersistentSyncQueue(safe);return count;\n }catch(_){return 0}\n}`;
    if(h.includes(anchor))h=h.replace(anchor,helper);
    else console.warn(`[ITTR startup] ${fp}: sync queue helper anchor changed; preserving current code`);
  }

  const oldTail='cloudReady=true;updateSyncQueueBadge();flushPersistentSyncQueue();connectLiveStatusSocket();';
  const newTail='cloudReady=true;const legacyQuarantined=quarantineUnsafeLegacySyncQueue();if(legacyQuarantined)showToast(`${legacyQuarantined} old offline change${legacyQuarantined===1?" was":"s were"} set aside because it had no safe server version. Current server data was kept.`,"warning",9000);updateSyncQueueBadge();flushPersistentSyncQueue();connectLiveStatusSocket();';
  if(h.includes(oldTail))h=h.replace(oldTail,newTail);

  fs.writeFileSync(fp,h,'utf8');
}

console.log(`ITTR v${VERSION} final version/cache/sync cleanup applied`);
