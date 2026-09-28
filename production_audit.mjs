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
const sw=exists('public/sw.js')?read('public/sw.js'):'';
const swRoot=exists('sw.js')?read('sw.js'):'';

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

check('runtime build identity uses package version',server.includes('const ITTR_APP_VERSION=String(process.env.npm_package_version')&&server.includes('frontendExpected:ITTR_APP_VERSION'));
check('legacy 24.24.5 identity removed from runtime server',!server.includes('24.24.5'));
check('legacy 24.24.5 identity removed from frontend',!root.includes('24.24.5'));
check('frontend release identity current',root.includes(pkg.version),pkg.version);
check('service worker version current',sw.includes(`v${pkg.version}`)&&sw.includes(`ittr-shopflow-v${pkg.version}`));
check('root/public service worker synchronized',sw&&sw===swRoot);
check('service worker uses network-first critical app code',sw.includes("u.pathname.startsWith('/modules/')")&&sw.includes("fetch(request,{cache:'no-store'})"));
check('service worker and modules served no-store',server.includes('filePath.endsWith("sw.js")')&&server.includes('filePath.endsWith("manifest.webmanifest")')&&server.includes('filePath.endsWith("invoice-workspace.css")'));
check('legacy unsafe sync queue is quarantined',root.includes('function quarantineUnsafeLegacySyncQueue(){')&&root.includes('ittr_sync_queue_quarantine_v1'));
check('startup no longer creates unsafe pre-login cloud save',!root.includes('\nsave();\n\nlet adminFilter="all";'));
check('sync badge reconciles stale in-memory pending keys',root.includes('function reconcileCloudPendingGhosts(){')&&root.includes('function updateSyncQueueBadge(){reconcileCloudPendingGhosts();'));
check('quarantine clears stale in-memory pending keys',root.includes('for(const key of Object.keys(unsafe)){cloudPending.delete(key)'));

check('state writes require current server version',server.includes('STATE_VERSION_REQUIRED')&&server.includes('STATE_VERSION_CONFLICT'));
check('mechanic whole-state replacement blocked',server.includes('Mechanics cannot replace shared administrative state.'));
check('legacy local import is owner-only',server.includes('app.post("/api/state/import-local",auth,ownerOnly'));
check('paid and void invoices stay locked',server.includes('Paid or void invoices are locked and cannot be reopened.'));
check('duplicate payment retry guard present',server.includes('DUPLICATE_PAYMENT')&&server.includes("interval '15 seconds'"));
check('mechanic timer guard scans all work orders',server.includes("Array.isArray(sf.workorders)?sf.workorders:[]")&&server.includes('Pause or complete your current task before starting another one.'));
check('offline queue stores base server version',root.includes('baseVersion:Number(cloudVersions[key]||0)'));
check('offline replay uses queued base version',root.includes('item?.baseVersion'));
check('manager cannot trigger legacy browser import',root.includes('remoteEmpty && localHasData && session?.role==="admin"'));

// v24.28.x security phase 2
check('CSP enabled',server.includes('contentSecurityPolicy:{directives:{')&&!server.includes('contentSecurityPolicy:false'));
check('frame embedding blocked',server.includes('frameAncestors:["\'none\'"]'));
check('browser permissions policy present',server.includes('Permissions-Policy'));
check('AI limiter present',server.includes('const aiLimiter=rateLimit')&&server.includes('app.use("/api/ai",aiLimiter)'));
check('upload limiter present',server.includes('const uploadLimiter=rateLimit')&&server.includes('app.use("/api/ai/import",uploadLimiter)'));
check('mechanic state reads are role-scoped',server.includes('role-scoped state reader')&&server.includes("req.user?.role==='mechanic'")&&server.includes('mechanicOwnsWorkOrder(req.user,w)'));
check('mechanic cannot cloud-save users',root.includes('if(session?.role!=="mechanic")queueCloudState("users",USERS)'));
check('mechanic cannot cloud-save pro state',root.includes('if(session?.role!=="mechanic")queueCloudState("pro",PRO)'));
check('generic mechanic queue blocks administrative state',root.includes('session?.role==="mechanic"&&key!=="shopflow"'));
check('mechanic stale administrative queue is discarded',root.includes('removePersistedState(key);cloudPending.delete(key);continue'));
check('Fullbay customer directory management-only',server.includes('app.get("/api/fullbay/customers",auth,managerPermission("customers")'));
check('Fullbay customer profile management-only',server.includes('app.get("/api/fullbay/customers/:id",auth,managerPermission("customers")'));
check('full backup owner-only',server.includes('app.get("/api/admin/backup",auth,ownerOnly'));
check('vendor resolver inventory-protected',server.includes("app.post('/api/parts/vendors/resolve',auth,managerPermission(\"inventory\")"));
check('inventory transaction inventory-protected',server.includes('app.post("/api/parts/:id/transaction",auth,managerPermission("inventory")'));
check('mechanic free-form inventory return removed',!server.includes('if(req.user.role!=="admin"&&!(["return"].includes(type)))'));
check('manager passwords minimum 12 chars',server.includes("password.length<12")&&server.includes('at least 12 characters are required'));
check('mechanic passwords minimum 10 chars',server.includes('password.length<10')&&server.includes('at least 10 characters are required'));
check('password reset revokes sessions',server.includes('DELETE FROM auth_sessions WHERE user_id=$1')&&server.includes('sessionsRevoked:true'));

// v24.28.1 mechanic language preference
check('self-service language preference endpoint exists',server.includes('app.patch("/api/auth/preferences",auth')&&server.includes('language_preference_changed'));
check('language preference accepts only en/uk',server.includes('["en","uk"].includes(language)'));
check('login session keeps account language',root.includes('language:d.user.language||localStorage.getItem("ittr_language")||"en"'));
check('restore session keeps account language',root.includes('currentLanguage=session.language;localStorage.setItem("ittr_language",currentLanguage)'));
check('role application prefers session language',root.includes('if(session?.language){\n   currentLanguage=session.language;'));
check('language selector saves through self-service endpoint',root.includes('apiJSON("/api/auth/preferences",{method:"PATCH",body:{language:currentLanguage}})'));
check('mechanic language change does not write shared users state',root.includes('if(session?.role!=="mechanic")saveUsers();'));

const partsInsert=server.match(/INSERT INTO fullbay_import_parts\([\s\S]*?VALUES\(([^)]*)\)[\s\S]*?ON CONFLICT\(source_key\)/);
if(partsInsert){const refs=[...partsInsert[1].matchAll(/\$(\d+)/g)].map(m=>Number(m[1]));const max=refs.length?Math.max(...refs):0;check('Fullbay v23.7.1 max parameter remains $22',max===22,`max=$${max}`);check('Fullbay v23.7.1 has no $23',!refs.includes(23));}else check('Fullbay inventory INSERT regression target found',false);

for(const name of ['customers','invoices','parts','procenter','trucksearch']){
 for(const ext of ['html','js']){
  const a=`modules/${name}.${ext}`,b=`public/modules/${name}.${ext}`;
  check(`${name}.${ext} exists in both module trees`,exists(a)&&exists(b));
  if(exists(a)&&exists(b))check(`${name}.${ext} root/public synchronized`,read(a)===read(b));
 }
}

const runtime=['runtime_samsara_name_patch.mjs','runtime_samsara_realtime_patch.mjs','runtime_samsara_v251_patch.mjs','runtime_samsara_v252_patch.mjs','runtime_samsara_v253_patch.mjs','runtime_samsara_v254_patch.mjs','runtime_samsara_v255_patch.mjs','runtime_v256_procenter_recovery.mjs','runtime_v257_fault_codes_fix.mjs','runtime_v260_invoice_workspace_fix.mjs','runtime_v261_clean_invoice_print.mjs','runtime_v270_security_integrity_fix.mjs','runtime_v271_finish_cleanup.mjs','runtime_v272_sync_ghost_fix.mjs','runtime_v280_security_phase2.mjs','runtime_v281_mechanic_language_fix.mjs'];
for(const f of runtime)check(`runtime dependency exists: ${f}`,exists(f));
check('runtime preparation centralized',String(pkg.scripts?.start||'').startsWith('npm run prepare-runtime &&')&&pkg.scripts?.['prepare-runtime-check']==='npm run prepare-runtime');
check('start reaches server.js',String(pkg.scripts?.start||'').trim().endsWith('node server.js'),pkg.scripts?.start||'');
check('release check executes runtime preparation',String(pkg.scripts?.check||'').includes('npm run prepare-runtime-check'));
check('startup smoke test exists',exists('smoke_test.mjs'));
check('release check executes startup smoke test',String(pkg.scripts?.check||'').includes('node smoke_test.mjs'));
check('audit command uses production audit',pkg.scripts?.audit==='node production_audit.mjs',pkg.scripts?.audit||'');

const dupIds=[...root.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]).filter((x,i,a)=>a.indexOf(x)!==i);
check('no duplicate DOM ids in shell',dupIds.length===0,[...new Set(dupIds)].join(','));

const failed=results.filter(x=>!x.ok);
for(const r of results)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}${r.detail?'  '+r.detail:''}`);
console.log(`\nITTR production audit: ${results.length-failed.length}/${results.length} passed`);
if(failed.length){console.error(`FAILED: ${failed.length}`);process.exit(1)}
