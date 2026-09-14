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
const modulesInvoicesHtml = read('modules/invoices.html');

check('release package version is 24.17.2', pkg.version === '24.17.2', pkg.version);
check('frontend release is 24.17.2', html.includes("const FRONTEND_VERSION='24.17.2';") || html.includes('const FRONTEND_VERSION="24.17.2";'));
check('backend release is 24.17.2', server.includes('frontendExpected:"24.17.2",backend:"24.17.2"'));
check('static web root restricted to public directory', server.includes('app.use(express.static(publicDir') && !server.includes('app.use(express.static(webRoot'));
check('parts search is read-only (no per-result barcode write loop)', !server.includes('for(const x of r.rows)if(!x.internal_barcode)x.internal_barcode=await ensurePartBarcode'));
check('production 500 responses hide internal error detail', server.includes('isProd?"An unexpected server error occurred.":safe'));
check('dedicated login failure limiter enabled', server.includes('const loginLimiter=rateLimit') && server.includes('app.post("/api/auth/login",loginLimiter'));
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
 ['offline sync queue badge', 'id="sync-queue-badge"'],
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



// v24.9.1 dynamic-route regression guards.
const lazyViews=['invoices','trucksearch','parts','customers','procenter'];
for (const view of lazyViews) {
  check(`lazy host present: ${view}`, html.includes(`id="${view}"`) && html.includes(`data-route-module="${view}"`));
  check(`module HTML present: ${view}`, fs.existsSync(`modules/${view}.html`) && read(`modules/${view}.html`).trim().length > 0);
  check(`module JS present: ${view}`, fs.existsSync(`modules/${view}.js`) && read(`modules/${view}.js`).includes('export async function mount'));
}
check('route loader uses dynamic import', html.includes('import(cfg.js)'));
check('route unmount aborts module listeners', html.includes('instance.scope.cleanup()'));
check('heavy view DOM not embedded at startup', !html.includes('<div id="invoiceKpis"') && !html.includes('<div id="partsStats"') && !html.includes('<div id="vehicleProfileResults"'));

// v24.13.0 mechanic/mobile/AI/receiving/resilience regression guards.
check('mechanic self-start wizard UI', html.includes('id="mechanicStartModal"') && html.includes('openMechanicStartWizard()'));
check('mechanic self-start mobile entry', html.includes('Start Job') && html.includes('onclick="openMechanicStartWizard()"'));
check('mechanic self-start backend endpoint', server.includes('app.post("/api/work-orders/self-start",auth'));
check('self-start restricted to mechanic role', server.includes('req.user?.role!=="mechanic"'));
check('self-start forces current mechanic assignment', server.includes('mechanic:req.user.username') && server.includes('createdVia:"mechanic_self_start"'));
check('self-start marks truck here', server.includes('truckHere:true') && server.includes('arrivedBy:req.user.username'));
check('DOT included in mechanic unit lookup', server.includes("coalesce(c.dot_number,'') ILIKE $1"));
check('touch-first mechanic target 52px', html.includes('min-height:52px!important'));
check('job state color tokens', html.includes('--job-active:') && html.includes('--job-paused:') && html.includes('--job-hold:') && html.includes('--job-completed:'));
check('AI FAB hidden while chat open', html.includes('body.aiChatOpen #shopAiFab') && html.includes('document.body.classList.toggle("aiChatOpen",open)'));
check('AI mobile full screen 100dvh', html.includes('height:100dvh!important'));
check('AI voice Web Speech API', html.includes('window.SpeechRecognition||window.webkitSpeechRecognition') && html.includes('r.interimResults=true'));
for(const lang of ['en-US','uk-UA','pl-PL','es-ES','ru-RU']) check(`AI voice language ${lang}`,html.includes(`value="${lang}"`));
check('persistent offline mutation queue', html.includes('ittr_sync_queue_v2') && html.includes('flushPersistentSyncQueue()'));
check('sync badge exact requested id', html.includes('id="sync-queue-badge"'));
check('online restores queued POST sync', html.includes('window.addEventListener("online",()=>{updateOnlineState();flushPersistentSyncQueue();connectLiveStatusSocket()})'));
check('receiving 50/50 dual pane', html.includes('.receiveVerifyShell{grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important'));
check('receiving viewer zoom and rotate', html.includes('function receivingZoom') && html.includes('function receivingRotate') && html.includes('↻ 90°'));
check('receiving supports price warning over 5 percent', html.includes("rise>5?'receivePriceWarning'") && html.includes('rise>5?`<div class="costRise">'));
check('receiving missing part validation', html.includes('Part number required.'));
check('receiving unlinked vendor validation', html.includes('Vendor profile is not linked yet'));
check('receiving Save Draft', html.includes('saveReceivingDraft()') && html.includes('Save Draft'));
check('receiving Commit to Stock Inventory', html.includes('Commit to Stock Inventory'));
check('global toast region', html.includes('id="toastRegion"') && html.includes('function showToast'));
check('runtime errors use toast', html.includes('window.addEventListener("unhandledrejection",e=>{showToast'));
check('WebSocket server status feed', server.includes('new WebSocketServer({server:httpServer,path:"/ws/shop-status"})'));
check('WebSocket auth uses session token hash', server.includes('s.token_hash=$1') && server.includes('[hashToken(token)]'));
check('WebSocket client reconnect wrapper', html.includes('function connectLiveStatusSocket') && html.includes('2**Math.min(5,liveReconnectAttempt-1)'));
check('WebSocket reconnect max 30 seconds', html.includes('Math.min(30000'));
check('ws package dependency', pkg.dependencies?.ws === '8.18.3');

check('invoice compact labor row', html.includes('invoiceGridItemLabel is-labor'));
check('invoice compact part row', html.includes('invoiceGridItemLabel is-part'));
check('invoice per-line discount type', html.includes('ilDiscountType'));
check('invoice per-line taxable control', html.includes('Taxable'));
check('invoice print stylesheet', read('public/modules/invoices.html').includes('@media print'));
check('old paid/void invoice permanent delete visible to admin', html.includes("session?.role==='admin'?`<button class=\"danger\" onclick=\"permanentlyDeleteInvoice"));
check('shop AI send implementation restored', html.includes('async function sendShopAI()'));
check('AI writing live speech recognition', read('public/modules/procenter.js').includes('webkitSpeechRecognition'));
check('AI processing state', read('public/modules/procenter.html').includes('AI Analyzing Fault Codes'));
check('AI part verification banner', read('public/modules/procenter.html').includes('AI suggestion only. Verify fitment in OEM catalog before ordering.'));

check('invoice customer selector', html.includes('id="invCustomerSelect"'));
check('invoice unit selector', html.includes('id="invUnitSelect"'));
check('invoice VIN autofill field', html.includes('id="invVin"'));
check('invoice USDOT autofill field', html.includes('id="invDot"'));
check('invoice payment terms controlled options', html.includes('Net 15') && html.includes('Net 30') && html.includes('Net 60'));
check('invoice global discount percent/fixed', html.includes('id="invDiscountType"') && html.includes('id="invDiscountValue"'));
check('invoice due-date live module logic', read('public/modules/invoices.js').includes('syncDueDate') && read('public/modules/invoices.js').includes('termsDays'));
check('invoice live total preview', read('public/modules/invoices.js').includes('previewTotals') && read('public/modules/invoices.js').includes('taxable'));
check('invoice tax only taxable lines', server.includes('CASE WHEN taxable THEN') && server.includes('taxableAfterDiscount'));
check('invoice snapshot USDOT schema', server.includes('ADD COLUMN IF NOT EXISTS dot_number TEXT'));
check('invoice global discount schema', server.includes('ADD COLUMN IF NOT EXISTS discount_type TEXT') && server.includes('ADD COLUMN IF NOT EXISTS discount_value NUMERIC'));
check('invoice professional print branding', html.includes('IRON TEAM TRUCK &amp; TRAILER REPAIR'));


// v24.13.0 service-card invoice workflow regression guards.
check('invoice service-card grouping', html.includes('invoiceServiceCard') && html.includes('invoiceServiceGroups'));
check('invoice labor shown before attached parts', html.includes('invoiceLaborPartsFor') && html.includes("${invoiceLaborRowHtml(anchor,locked)}") && html.includes("${parts.map(x=>invoicePartRowHtml(x,locked)).join('')}"));
for(const rate of ['115','110','100','60']) check(`legacy labor rate preset ${rate}`, html.includes(`value=\"${rate}\"`) || html.includes(`value="${rate}"`));
check('legacy labor rate labels restored', html.includes('New Client — $115/hr') && html.includes('Our Client — $110/hr') && html.includes('Old Client — $100/hr') && html.includes('Owner — $60/hr'));
check('customer default labor rate supported', read('public/modules/invoices.js').includes('default_labor_rate') && read('public/modules/invoices.js').includes('preferredLaborRate'));
check('service supports direct part add', html.includes('+ Add Part') && html.includes('addInvoiceChildLine'));
check('service supports additional labor', html.includes('+ Add Labor') && html.includes('addInvoiceService()'));
check('new service workflow', html.includes('+ Add Labor') && html.includes('addInvoiceService()'));


// v24.14.0 compact Fullbay-inspired service-grid invoice guards.
check('invoice compact grid header', modulesInvoicesHtml.includes('invoiceGridHeader'));
check('invoice grid shows Cost column', html.includes('<span>Cost</span>'));
check('invoice grid shows Selling Price column', html.includes('<span>Selling Price</span>'));
check('invoice part cost remains editable', html.includes('class="ilCost" type="number"'));
check('invoice bottom Add Labor Line', html.includes('+ Add Labor') && html.includes('addInvoiceService()'));
check('invoice bottom Add a Service', html.includes('Labor & Parts') && !html.includes('Add a Service'));
check('invoice bottom Add Misc Charge', html.includes('+ Other Charge'));
check('invoice service quick Add Part', html.includes('Parts used for this labor'));
check('invoice service subtotal row', modulesInvoicesHtml.includes('invoiceServiceSubtotal'));
check('invoice old rate presets all preserved', ['115','110','100','60'].every(v=>html.includes(`value="${v}"`)));

// v24.15.0 dedicated invoice workspace and inventory autocomplete guards.
check('invoice list opens dedicated workspace', html.includes('openInvoiceWorkspace(${i.id})'));
check('invoice workspace URL supported', html.includes("searchParams.set('invoiceWorkspace'"));
check('invoice workspace activates after login', html.includes('activateInvoiceWorkspaceFromURL'));
check('invoice workspace uses full viewport class', modulesInvoicesHtml.includes('body.invoiceWorkspaceMode #invoiceModal'));
check('part rows query live inventory', html.includes('/api/parts?q=${encodeURIComponent(q)}&limit=12'));
check('part inventory lookup fills part number', html.includes("set('.ilPart',cleanPartField(item.part_number,''))"));
check('part inventory lookup fills description', html.includes("set('.ilDesc',cleanPartField(item.description,''))"));
check('part inventory lookup fills cost', html.includes("set('.ilCost',Number(item.cost||0).toFixed(2))"));
check('part inventory lookup fills selling price', html.includes("set('.ilPrice',Number(item.price||0).toFixed(2))"));
check('part inventory suggestions show availability', html.includes('Avail ${Number(x.available||0).toLocaleString()}'));


// v24.16.1 invoice tab / draft-preservation / runtime regression guards.
check('mechanic account renderer restored', html.includes('function renderMechanicAccounts()') && html.includes('mechanicAccountsTable'));
check('invoice opens exactly one noopener tab without same-tab fallback', html.includes("link.target='_blank'") && html.includes("link.rel='noopener noreferrer'") && !html.includes("Opening it here instead") && !html.includes("if(!tab){"));
check('manager account UI function restored', html.includes('function openManagerAccount()') && html.includes("managerAccountFormEl.onsubmit"));
check('manual library UI functions restored', html.includes('function openManualLibrary()') && html.includes('function loadManualLibrary(') && html.includes('function openManualDocument('));
check('manual library upload handler restored', html.includes('manualLibraryFormEl.onsubmit'));

check('server PDF is labor-first and ignores old job headings',
  server.includes("const laborDesc=safeText(labor.description)||'Labor'") &&
  server.includes("job_name is intentionally not printed") &&
  !server.includes("text(currentJob,L,y)"));
check('server PDF nests parts beneath labor',
  server.includes("Parts used for this labor") &&
  server.includes("String(c.parent_line_id||'')===String(labor.id)"));
check('server PDF footer stays inside printable area',
  server.includes("doc.page.height-doc.page.margins.bottom-10"));
check('invoice structural actions preserve current draft', html.includes("persistInvoiceDraftBeforeStructureChange('Preserving your invoice')"));
check('invoice draft preservation saves all line edits', html.includes('await saveAllInvoiceLines()') && html.includes('function invoiceHeaderPayload()'));
check('invoice line save preserves sibling unsaved rows', html.includes('async function saveInvoiceLine(id)') && html.includes("await saveAllInvoiceLines();const r=await fetch(`/api/invoices/${i.id}`"));
check('invoice delete preserves sibling unsaved rows', html.includes("deleteInvoiceLine(lineId)") && html.includes("persistInvoiceDraftBeforeStructureChange('Preserving your invoice')"));
check('invoice visible draft state indicator', html.includes('id="invoiceDraftState"') && modulesInvoicesHtml.includes('.invoiceDraftState'));
check('parts autocomplete remains wired after draft fix', html.includes('scheduleInvoicePartLookup') && html.includes('/api/parts?q=${encodeURIComponent(q)}&limit=12'));
const failed = checks.filter(x=>!x.ok);
for (const x of checks) console.log(`${x.ok?'PASS':'FAIL'}  ${x.name}${x.detail?` — ${x.detail}`:''}`);
console.log(`\n${checks.length-failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
