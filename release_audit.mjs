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
const modulesInvoicesJs = read('modules/invoices.js');

check('release package version is 24.22.1', pkg.version === '24.22.1', pkg.version);
check('frontend release is 24.22.1', html.includes("const FRONTEND_VERSION='24.22.1';") || html.includes('const FRONTEND_VERSION="24.22.1"'));
check('backend release is 24.22.1', server.includes('frontendExpected:"24.22.1",backend:"24.22.1"'));
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
check('part inventory lookup fills cost', html.includes("set('.ilCost',invCost.toFixed(2))"));
check('part inventory lookup fills selling price', html.includes("set('.ilPrice',invPrice.toFixed(2))"));
check('part inventory suggestions show availability', html.includes('Avail ${Number(x.available||0).toLocaleString()}'));


// v24.16.1 invoice tab / draft-preservation / runtime regression guards.
check('mechanic account renderer restored', html.includes('function renderMechanicAccounts()') && html.includes('mechanicAccountsTable'));
check('invoice opens exactly one noopener tab without same-tab fallback', html.includes("link.target='_blank'") && html.includes("link.rel='noopener noreferrer'") && !html.includes("Opening it here instead") && !html.includes("if(!tab){"));
check('invoice workspace same-origin auth handoff channel', html.includes("INVOICE_AUTH_CHANNEL='ittr_invoice_auth_v1'") && html.includes('new BroadcastChannel(INVOICE_AUTH_CHANNEL)'));
check('invoice workspace requests inherited session before login screen', html.includes('await inheritInvoiceWorkspaceSession()') && html.includes("sessionStorage.setItem('ittr_cloud_token',cloudToken)"));
check('invoice auth token is not added to workspace URL', !html.includes("searchParams.set('token'") && !html.includes("searchParams.set('auth'"));
check('manager account UI function restored', html.includes('function openManagerAccount()') && html.includes("managerAccountFormEl.onsubmit"));
check('manual library UI functions restored', html.includes('function openManualLibrary()') && html.includes('function loadManualLibrary(') && html.includes('function openManualDocument('));
check('manual library upload handler restored', html.includes('manualLibraryFormEl.onsubmit'));

check('server PDF is labor-first and ignores old job headings',
  server.includes("const laborDescription=s(labor.description)||'Labor'") &&
  server.includes("internal legacy job/service names are never printed") &&
  !server.includes("text(currentJob,L,y)"));
check('server PDF nests parts beneath labor',
  server.includes("PARTS & CHARGES FOR THIS LABOR") &&
  server.includes("String(c.parent_line_id||'')===String(labor.id)"));
check('server PDF footer stays inside printable area',
  server.includes("doc.page.height-doc.page.margins.bottom-9"));

check('PDF action saves current draft before download',
  html.includes("persistInvoiceDraftBeforeStructureChange('Saving invoice before PDF')"));
check('customer notes autosave on edit and blur',
  html.includes("id=\"invCustomerNote\" rows=\"3\" oninput=\"scheduleInvoiceHeaderAutosave()\" onblur=\"flushInvoiceHeaderAutosave()\"") &&
  html.includes("function scheduleInvoiceHeaderAutosave()") &&
  html.includes("function flushInvoiceHeaderAutosave()"));
check('server PDF prints exact saved customer note without generic fallback',
  server.includes("const customerNote=s(i.customer_note)") &&
  !server.includes("i.customer_note||'Thank you for your business!'"));
check('server PDF uses safe right-edge amount column',
  server.includes("const L=42,R=570,W=528") &&
  server.includes("text(money(laborTotal),L+444") &&
  server.includes("{width:82,align:'right'}"));
check('invoice structural actions preserve current draft', html.includes("persistInvoiceDraftBeforeStructureChange('Preserving your invoice')"));
check('invoice draft preservation saves all line edits', html.includes('await saveAllInvoiceLines()') && html.includes('function invoiceHeaderPayload()'));
check('invoice line save preserves sibling unsaved rows', html.includes('async function saveInvoiceLine(id)') && html.includes("await saveAllInvoiceLines();const r=await fetch(`/api/invoices/${i.id}`"));
check('invoice delete preserves sibling unsaved rows', html.includes("deleteInvoiceLine(lineId)") && html.includes("persistInvoiceDraftBeforeStructureChange('Preserving your invoice')"));
check('invoice visible draft state indicator', html.includes('id="invoiceDraftState"') && modulesInvoicesHtml.includes('.invoiceDraftState'));
check('parts autocomplete remains wired after draft fix', html.includes('scheduleInvoicePartLookup') && html.includes('/api/parts?q=${encodeURIComponent(q)}&limit=12'));

check('invoice summary shows other charges separately',
  html.includes('id="invPreviewOtherCharges"') &&
  modulesInvoicesJs.includes("otherRows=rows.filter(x=>!['labor','part'].includes(x.type))"));
check('invoice summary shows additional fees separately',
  html.includes('id="invPreviewAdditionalFees"') &&
  modulesInvoicesJs.includes("fees=numberValue('invShopSupplies')+numberValue('invEnvFee')"));
check('additional fees autosave while editing',
  html.includes('id="invShopSupplies" type="number" min="0" step="0.01" oninput="scheduleInvoiceHeaderAutosave()"') &&
  html.includes('id="invEnvFee" type="number" min="0" step="0.01" oninput="scheduleInvoiceHeaderAutosave()"'));
check('PDF item summary exposes shop and environmental fees',
  server.includes("row('Shop Supplies',money(shopSupplies))") &&
  server.includes("row('Environmental / Other',money(environmentalFee))"));
check('customer invoice includes full warranty and repair authorization terms',
  html.includes('WARRANTY &amp; REPAIR AUTHORIZATION') &&
  html.includes('express mechanic\'s lien on your vehicle') &&
  server.includes('Any warranties on the parts and accessories sold hereby are made by the manufacturer') &&
  server.includes('express mechanic\\\'s lien on your vehicle'));
check('50-mile tire wheel re-torque notice appears on invoice and PDF',
  html.includes('recheck wheel nut torque after 50 miles of driving') &&
  server.includes('recheck wheel nut torque after 50 miles of driving'));
check('customer invoice includes signature lines',
  html.includes('Customer Signature: ______________________________') &&
  server.includes('Customer Signature: ______________________________'));
check('invoice email includes warranty and tire notice',
  server.includes('<b>Parts Warranty:</b>') &&
  server.includes('<b>Tire / Wheel Safety:</b>'));

check('Workshop AI groups current ITTR invoice history before prompting',
  server.includes('function compactInvoiceHistory(rows)') &&
  server.includes('recentIttrServices=compactInvoiceHistory(invoices)'));
check('Workshop AI explicitly includes draft/sent/paid ITTR records in history',
  server.includes('Current ITTR records are valid history even when their invoice status is draft, sent, partial, or paid'));
check('Workshop AI detects PM/oil/lube/filter history semantically',
  server.includes('function pmServiceIntent(q)') &&
  server.includes('pmMatches:{ittrInvoices:pmInvoiceMatches.slice(0,12)'));
check('Workshop AI guarantees newest matching ITTR PM invoice is surfaced',
  server.includes("if(pmServiceIntent(question)&&pmInvoiceMatches.length)") &&
  server.includes("Most recent ITTR PM/service record:"));


check('mechanic self-start lookup endpoint combines local DB and external sources',
  server.includes('app.get("/api/work-orders/self-start/lookup"') &&
  server.includes('localSelfStartMatches') &&
  server.includes('lookupFmcsaCarrier(dotNumber)') &&
  server.includes('lookupNhtsaVin(vin)'));
check('mechanic self-start can create missing customer and unit records',
  server.includes('async function resolveSelfStartCustomer') &&
  server.includes('async function resolveSelfStartUnit') &&
  server.includes("'mechanic_self_start'"));
check('mechanic self-start prevents duplicate VIN ownership conflicts',
  server.includes('VIN_CUSTOMER_CONFLICT') &&
  server.includes('This VIN already belongs to a different customer in ITTR'));
check('mechanic self-start validates existing unit ownership',
  server.includes('code:"UNIT_CUSTOMER_CONFLICT"') &&
  server.includes('String(row.customer_id)!==String(customerRow.id)'));
check('mechanic wizard automatically looks up USDOT and VIN',
  html.includes('scheduleMechanicLookup()') &&
  html.includes('/api/work-orders/self-start/lookup?') &&
  html.includes('FMCSA + NHTSA lookup'));
check('mechanic wizard captures decoded vehicle fields',
  html.includes('id="mechStartEngine"') &&
  html.includes('id="mechStartTransmission"') &&
  html.includes('carrierSource:d.sources?.carrier') &&
  html.includes('vehicleSource:d.sources?.vehicle'));
check('FMCSA key remains server-side only',
  server.includes('const FMCSA_WEBKEY=String(process.env.FMCSA_WEBKEY||"").trim()') &&
  !html.includes('FMCSA_WEBKEY'));


check('inventory part selection autofills stored selling price', html.includes("set('.ilPrice',invPrice.toFixed(2))") && html.includes('Number(item.price||0)'));
check('invoice part rows expose markup percent control', html.includes('class=\"ilMarkup\"') && html.includes('invoiceApplyPartMarkup'));
check('manual selling price recalculates effective markup', html.includes('function invoicePartPriceChanged') && html.includes('invoiceMarkupFromCostPrice'));
check('cost plus markup recalculates selling price', html.includes('function invoicePartCostChanged') && html.includes('cost*(1+markup/100)'));


check('invoice part lookup is viewport-positioned and not clipped by service rows',
  html.includes('function positionInvoicePartLookup(lineId)') &&
  html.includes("position:'fixed'") &&
  modulesInvoicesHtml.includes('z-index:5000!important') &&
  modulesInvoicesHtml.includes('overflow:visible!important'));
check('invoice part search result has full description and pricing layout',
  modulesInvoicesHtml.includes('grid-template-columns:minmax(300px,1fr) 220px!important') &&
  modulesInvoicesHtml.includes('text-overflow:clip!important'));
check('print invoice uses one consistent five-column labor-parts grid',
  modulesInvoicesHtml.includes('grid-template-columns:48px minmax(0,1fr) 58px 78px 82px!important') &&
  server.includes('const tableCuts=[L+48,L+296,L+361,L+442]') &&
  server.includes('function drawTableGuides'));
check('print invoice legal block is customer-ready and page-safe',
  modulesInvoicesHtml.includes('.invoiceLegalBlock{display:block!important;break-inside:avoid!important') &&
  server.includes('const noticeH=Math.max(150,legalH+tireH+82)') &&
  server.includes('ensure(noticeH+8)'));


check('desktop invoice editor uses a ten-column aligned accounting grid',
  modulesInvoicesHtml.includes('grid-template-columns:72px minmax(300px,1fr) 64px 78px 72px 84px 52px 92px 78px 38px!important'));
check('labor rate control spans cost markup and price columns',
  modulesInvoicesHtml.includes('.invoiceServiceLaborRow .invoiceLaborRateField{grid-column:4 / span 3!important'));
check('invoice editor uses compact 32px controls and smaller desktop typography',
  modulesInvoicesHtml.includes('min-height:32px!important') &&
  modulesInvoicesHtml.includes('font-size:12px!important'));
check('invoice markup percent stays inline instead of wrapping below input',
  modulesInvoicesHtml.includes('.invoiceMarkupCell{') &&
  modulesInvoicesHtml.includes('grid-template-columns:minmax(0,1fr) auto!important'));


check('print uses dedicated customer-only five-column header',
  html.includes('invoicePrintOnly invoicePrintLineHeader') &&
  modulesInvoicesHtml.includes('.invoiceGridHeader{display:none!important}') &&
  modulesInvoicesHtml.includes('grid-template-columns:48px minmax(0,1fr) 58px 82px 82px!important'));
check('print labor row aligns to same five customer columns',
  modulesInvoicesHtml.includes('.invoiceLaborBlockHead{') &&
  modulesInvoicesHtml.includes(".invoiceServiceIndex::after{content:'Labor'"));
check('print hides empty draft part placeholders',
  html.includes('invoicePrintEmptyLine') && modulesInvoicesHtml.includes('.invoiceServicePartRow.invoicePrintEmptyLine{display:none!important}'));
check('print collapses empty customer notes',
  html.includes('invoicePrintEmptyNotes') && modulesInvoicesHtml.includes('.invoiceNotesCard.invoicePrintEmptyNotes{display:none!important}'));
check('server PDF filters empty placeholder invoice lines',
  server.includes('rawLines=Array.isArray(x.lines)?x.lines:[]') && server.includes("l.line_type==='labor'||String(l.part_number||'').trim()"));


check('CustomersUnits CSV import endpoint exists', server.includes('/api/fullbay/import/customer-units') && server.includes('fullbay_unit_id'));
check('repairOrders CSV import endpoint exists', server.includes('/api/fullbay/import/repair-orders') && server.includes('repair-order:'));
check('repair order import is idempotent by source key', server.includes('ON CONFLICT(source_key) DO UPDATE SET customer_id=EXCLUDED.customer_id'));
check('repair order metadata fields preserved', server.includes('service_writer') && server.includes('service_status') && server.includes('parts_status') && server.includes('unit_return'));
check('customer unit import UI exists', html.includes('fullbayCustomerUnitsFile') && html.includes('uploadFullbayCustomerUnits'));
check('repair order import UI exists', html.includes('fullbayRepairOrdersFile') && html.includes('uploadFullbayRepairOrders'));

check('v24.22.1 route modules use explicit cache-busting version', html.includes('ROUTE_MODULE_VERSION="24.22.1"') && html.includes('routeAsset("/modules/procenter.html")'));
check('lazy module HTML fetch bypasses stale browser cache', html.includes('fetch(cfg.html,{cache:"no-store"})'));
check('server disables cache for public module assets', server.includes('filePath.includes(`${path.sep}modules${path.sep}`)'));
const procenterHtml=fs.readFileSync('public/modules/procenter.html','utf8');
check('Customers + Units importer is rendered in actual ProCenter module', procenterHtml.includes('fullbayCustomerUnitsFile') && procenterHtml.includes('uploadFullbayCustomerUnits()') && procenterHtml.includes('CustomersUnits.csv'));
check('Repair Orders importer is rendered in actual ProCenter module', procenterHtml.includes('fullbayRepairOrdersFile') && procenterHtml.includes('uploadFullbayRepairOrders()') && procenterHtml.includes('repairOrders.csv'));

check('AI Copilot attachment input exists', html.includes('id="shopAiFile"') && html.includes('analyzeShopAiAttachment'));
check('AI legacy invoice analysis API exists', server.includes("/api/ai/import/analyze") && server.includes('multimodalInvoiceExtract'));
check('AI import is review-first draft commit', server.includes("/api/ai/import/commit-invoice") && server.includes('Review before finalizing'));
check('AI Copilot controlled action API exists', server.includes("/api/ai/copilot/action") && html.includes('tryShopAiAction'));
check('AI invoice import matches customers units and parts', server.includes('enrichLegacyInvoiceDraft') && server.includes('fullbay_import_parts'));
check('AI invoice import supports images and PDF', server.includes("'image/jpeg','image/png','image/webp','application/pdf'"));
check('AI CSV attachment routes to safe import center', html.includes('CSV detected. Opening Fullbay Data Center'));
const failed = checks.filter(x=>!x.ok);
for (const x of checks) console.log(`${x.ok?'PASS':'FAIL'}  ${x.name}${x.detail?` — ${x.detail}`:''}`);

check('AI inventory enrichment uses real cost/price schema', server.includes('cost AS buy_price,price AS sell_price') && !server.includes('description,buy_price,sell_price,quantity'));
check('Workshop AI supports clipboard screenshot paste', html.includes('onpaste="shopAiHandlePaste(event)"') && html.includes('function shopAiHandlePaste(event)'));
check('Workshop AI supports drag and drop attachments', html.includes('ondrop="shopAiHandleDrop(event)"') && html.includes('function shopAiHandleDrop(event)'));
check('Workshop AI attachment validation is shared', html.includes('function shopAiAcceptFile(file'));

check('AI legacy import can commit completed history', server.includes("/api/ai/import/commit-history") && html.includes("Add to Completed History"));
check('AI completed history requires matched customer and unit', server.includes("Match the legacy document to an existing ITTR customer and unit"));
check('AI history preserves individual parts in raw detail', server.includes("aiParts:parts") && server.includes("x.raw?.aiParts"));
check('Fullbay history reconciliation endpoint exists', server.includes("/api/fullbay/history/reconcile") && server.includes("reconcileFullbayHistoryLinks"));
check('Fullbay service order lookup normalizes SO variants', server.includes("canonicalFullbaySo") && server.includes("Quick SO"));
check('AI review uses real line breaks instead of literal slash-n', html.includes("LEGACY FULLBAY HISTORY REVIEW") && !html.includes("AI IMPORT REVIEW\\\\nCustomer"));

check('lazy route CSS is promoted to document head', html.includes("route-style-${view}-${i}") && html.includes("document.head.appendChild(style)"));
check('invoice v24.22.1 layout hardening exists', modulesInvoicesHtml.includes("invoice-v24211-layout-hardening"));
check('invoice print hides editable customer vehicle form', modulesInvoicesHtml.includes("body.invoiceWorkspaceMode .invoiceCustomerVehicleCard") && modulesInvoicesHtml.includes("display:none!important"));
check('invoice print forces stable five-column service rows', modulesInvoicesHtml.includes("grid-template-columns:56px minmax(0,1fr) 54px 66px 72px"));

const invoiceStaticCss=fs.readFileSync('public/invoice-workspace.css','utf8');
check('invoice workspace has authoritative static CSS file', invoiceStaticCss.includes('authoritative invoice workspace stylesheet') && invoiceStaticCss.includes('.invoiceServiceLaborRow'));
check('app shell globally loads invoice workspace CSS', html.includes('/invoice-workspace.css?v=24.22.1'));
check('app shell contains emergency invoice grid fallback', html.includes('invoice-shell-emergency-layout'));
check('canonical root and public invoice HTML are synchronized', fs.readFileSync('modules/invoices.html','utf8')===modulesInvoicesHtml);

check('Samsara token stays server-side', server.includes('process.env.SAMSARA_API_TOKEN') && !html.includes('SAMSARA_API_TOKEN'));
check('Samsara current fleet endpoints exist', server.includes("/api/samsara/fleet") && server.includes("/fleet/vehicles/stats") && server.includes("/fleet/drivers"));
check('Samsara historical stats endpoint exists', server.includes("/api/samsara/vehicle/:id/history") && server.includes("/fleet/vehicles/stats/history"));
check('duplicate customer audit exists', server.includes("/api/customers/duplicate-audit") && server.includes("normalizeCustomerCompanyName"));
check('customer merge is owner-only', server.includes("/api/customers/merge") && server.includes("ownerOnly"));
check('customer merge is transactional and relinks history', server.includes("customer_merged") && server.includes("UPDATE fullbay_service_history SET customer_id=$1"));

check('lazy ProCenter exports duplicate audit handler globally', fs.readFileSync('public/modules/procenter.js','utf8').includes('window.auditDuplicateCustomers = auditDuplicateCustomers'));
check('lazy ProCenter exports Samsara handlers globally', fs.readFileSync('public/modules/procenter.js','utf8').includes('window.loadSamsaraFleet = loadSamsaraFleet') && fs.readFileSync('public/modules/procenter.js','utf8').includes('window.renderSamsaraFleet = renderSamsaraFleet'));
console.log(`\n${checks.length-failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
