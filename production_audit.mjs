import fs from 'node:fs';
import crypto from 'node:crypto';

const read=p=>fs.readFileSync(p,'utf8');
const exists=p=>fs.existsSync(p);
const results=[];
const check=(name,ok,detail='')=>results.push({name,ok:!!ok,detail:String(detail||'')});
const pkg=JSON.parse(read('package.json'));
const server=read('server.js');
const root=read('index.html');
const pub=read('public/index.html');

check('package version present',/^24\.\d+\.\d+$/.test(pkg.version),pkg.version);
check('production server exists',server.length>10000,server.length);
check('root/public index byte-identical',root===pub,crypto.createHash('sha256').update(root).digest('hex').slice(0,12));
check('static serving restricted to public',server.includes('express.static(publicDir')&&!server.includes('express.static(webRoot'));
check('production errors are sanitized',server.includes('isProd?"An unexpected server error occurred.":safe'));
check('login limiter present',server.includes('const loginLimiter=rateLimit')&&server.includes('/api/auth/login'));
check('manager permission middleware present',server.includes('function managerPermission(key)'));
check('owner invoice delete preserved',server.includes("app.delete('/api/invoices/:id',auth,ownerOnly")||server.includes('app.delete("/api/invoices/:id",auth,ownerOnly'));
check('mechanic self-start preserved',server.includes('/api/work-orders/self-start'));
check('AI shop chat preserved',server.includes('/api/ai/shop-chat'));
check('Fullbay customers import preserved',server.includes('/api/fullbay/import/customers'));
check('Fullbay parts import preserved',server.includes('/api/fullbay/import/parts'));
check('Fullbay history import preserved',server.includes('/api/fullbay/import/service-history'));

// v24.27.0 critical security/data-integrity regression checks.
check('state writes require current server version',server.includes('STATE_VERSION_REQUIRED')&&server.includes('STATE_VERSION_CONFLICT'));
check('mechanic whole-state replacement blocked',server.includes('Mechanics cannot replace shared administrative state.'));
check('legacy local import is owner-only',server.includes('app.post("/api/state/import-local",auth,ownerOnly'));
check('paid and void invoices stay locked',server.includes('Paid or void invoices are locked and cannot be reopened.'));
check('duplicate payment retry guard present',server.includes('DUPLICATE_PAYMENT')&&server.includes("interval '15 seconds'"));
check('mechanic timer guard scans all work orders',server.includes("Array.isArray(sf.workorders)?sf.workorders:[]")&&server.includes('Pause or complete your current task before starting another one.'));
check('offline queue stores base server version',root.includes('baseVersion:Number(cloudVersions[key]||0)'));
check('offline replay uses queued base version',root.includes('item?.baseVersion'));
check('manager cannot trigger legacy browser import',root.includes('remoteEmpty && localHasData && session?.role==="admin"'));

const partsInsert=server.match(/INSERT INTO fullbay_import_parts\([\s\S]*?VALUES\(([^)]*)\)[\s\S]*?ON CONFLICT\(source_key\)/);
if(partsInsert){const refs=[...partsInsert[1].matchAll(/\$(\d+)/g)].map(m=>Number(m[1]));const max=refs.length?Math.max(...refs):0;check('Fullbay v23.7.1 max parameter remains $22',max===22,`max=$${max}`);check('Fullbay v23.7.1 has no $23',!refs.includes(23));}else check('Fullbay inventory INSERT regression target found',false);

for(const name of ['customers','invoices','parts','procenter','trucksearch']){
 for(const ext of ['html','js']){
  const a=`modules/${name}.${ext}`,b=`public/modules/${name}.${ext}`;
  check(`${name}.${ext} exists in both module trees`,exists(a)&&exists(b));
  if(exists(a)&&exists(b))check(`${name}.${ext} root/public synchronized`,read(a)===read(b));
 }
}

const runtime=['runtime_samsara_name_patch.mjs','runtime_samsara_realtime_patch.mjs','runtime_samsara_v251_patch.mjs','runtime_samsara_v252_patch.mjs','runtime_samsara_v253_patch.mjs','runtime_samsara_v254_patch.mjs','runtime_samsara_v255_patch.mjs','runtime_v256_procenter_recovery.mjs','runtime_v257_fault_codes_fix.mjs','runtime_v260_invoice_workspace_fix.mjs','runtime_v261_clean_invoice_print.mjs','runtime_v270_security_integrity_fix.mjs'];
for(const f of runtime)check(`runtime dependency exists: ${f}`,exists(f));
check('start reaches server.js',String(pkg.scripts?.start||'').trim().endsWith('node server.js'),pkg.scripts?.start||'');
check('release check executes runtime preparation',String(pkg.scripts?.check||'').includes('npm run prepare-runtime-check'));
check('audit command uses production audit',pkg.scripts?.audit==='node production_audit.mjs',pkg.scripts?.audit||'');

const dupIds=[...root.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]).filter((x,i,a)=>a.indexOf(x)!==i);
check('no duplicate DOM ids in shell',dupIds.length===0,[...new Set(dupIds)].join(','));

const failed=results.filter(x=>!x.ok);
for(const r of results)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}${r.detail?'  '+r.detail:''}`);
console.log(`\nITTR production audit: ${results.length-failed.length}/${results.length} passed`);
if(failed.length){console.error(`FAILED: ${failed.length}`);process.exit(1)}
