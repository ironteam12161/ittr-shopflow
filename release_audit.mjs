import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const read = p => fs.readFileSync(p, 'utf8');
const checks = [];
const check = (name, ok, detail='') => checks.push({name, ok:Boolean(ok), detail});
const html = read('index.html');
const pub = read('public/index.html');
const server = read('server.js');
const pkg = JSON.parse(read('package.json'));

check('release package version is 24.9.0', pkg.version === '24.9.0', pkg.version);
check('frontend release is 24.9.0', html.includes('const FRONTEND_VERSION="24.9.0";'));
check('backend release is 24.9.0', server.includes('frontendExpected:"24.9.0",backend:"24.9.0"'));
check('root/public frontend byte-identical', html === pub, crypto.createHash('sha256').update(html).digest('hex').slice(0,12));

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
const dupIds = [...new Set(ids.filter((x,i,a)=>a.indexOf(x)!==i))];
check('no duplicate DOM IDs', dupIds.length === 0, dupIds.join(', '));

const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
let inlineSyntax = true, inlineErr='';
for (const code of inlineScripts) {
  try { new vm.Script(code); } catch (e) { inlineSyntax=false; inlineErr=e.message; break; }
}
check('frontend inline JavaScript syntax', inlineSyntax, inlineErr);

const routeKeys = [...server.matchAll(/app\.(get|post|put|patch|delete)\((['"`])([^'"`]+)\2/g)].map(m=>`${m[1].toUpperCase()} ${m[3]}`);
const dupRoutes = [...new Set(routeKeys.filter((x,i,a)=>a.indexOf(x)!==i))];
check('no duplicate Express method/path routes', dupRoutes.length === 0, dupRoutes.join(', '));

// Critical regression manifest: these are intentionally hard failures.
const critical = [
 ['manager create backend', 'app.post("/api/admin/managers"'],
 ['manager delete backend', 'app.delete("/api/admin/managers/:username"'],
 ['manager add UI', 'openManagerAccount()'],
 ['permanent invoice delete backend', "app.delete('/api/invoices/:id',auth,ownerOnly"],
 ['permanent invoice delete UI', 'permanentlyDeleteInvoice'],
 ['invoice void workflow', 'voidInvoice'],
 ['AI floating button', 'id="shopAiFab"'],
 ['AI shop chat endpoint', '/api/ai/shop-chat'],
 ['multilingual AI voice selector', 'id="shopAiVoiceLanguage"'],
 ['mechanic Truck Is Here', 'Truck Is Here'],
 ['complete work order flow', 'Complete Work Order'],
 ['Fullbay customers import', '/api/fullbay/import/customers'],
 ['Fullbay parts import', '/api/fullbay/import/parts'],
 ['Fullbay service history import', '/api/fullbay/import/service-history'],
 ['barcode scanner', 'id="partsScannerModal"'],
 ['smart receiving', 'id="smartReceivingModal"'],
 ['side-by-side receiving preview', 'receiveVerifyShell'],
 ['offline banner', 'id="offlineBanner"'],
 ['offline sync queue badge', 'id="syncQueueBadge"'],
 ['manager permission middleware', 'function managerPermission(key)'],
];
for (const [name, needle] of critical) check(name, html.includes(needle) || server.includes(needle));

// Preserve the v23.7.1 Fullbay inventory import parameter fix.
const partsInsert = server.match(/INSERT INTO fullbay_import_parts\([\s\S]*?VALUES\(([^)]*)\)[\s\S]*?ON CONFLICT\(source_key\)/);
if (partsInsert) {
  const refs = [...partsInsert[1].matchAll(/\$(\d+)/g)].map(m=>Number(m[1]));
  check('Fullbay inventory INSERT max SQL parameter remains $22', Math.max(...refs) === 22, `max=$${Math.max(...refs)}`);
  check('Fullbay inventory INSERT does not reference $23', !refs.includes(23));
} else check('Fullbay inventory INSERT located for regression guard', false);

// High-risk RBAC checks added in 24.9.0.
check('manager employee management gated by employees permission', server.includes('app.post("/api/admin/users",auth,managerPermission("employees")'));
check('Fullbay parts import gated by inventory permission', server.includes('app.post("/api/fullbay/import/parts",auth,managerPermission("inventory")'));
check('Fullbay customer import gated by customer permission', server.includes('app.post("/api/fullbay/import/customers",auth,managerPermission("customers")'));
check('invoice APIs gated by invoices permission', server.includes('managerPermission("invoices")'));
check('customer APIs gated by customers permission', server.includes('managerPermission("customers")'));
check('inventory APIs gated by inventory permission', server.includes('managerPermission("inventory")'));


const failed = checks.filter(x=>!x.ok);
for (const x of checks) console.log(`${x.ok?'PASS':'FAIL'}  ${x.name}${x.detail?` — ${x.detail}`:''}`);
console.log(`\n${checks.length-failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
