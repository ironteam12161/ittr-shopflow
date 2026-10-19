import fs from 'node:fs';
import crypto from 'node:crypto';

const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
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
const syncQ=read('public/sync-queue.js');
// v24.67.0: the pending-save queue lives in public/sync-queue.js (per account, change sets, removed only once saved).
check('legacy unsafe sync queue is quarantined',syncQ.includes("LEGACY_KEY = 'ittr_sync_queue_v2'")&&syncQ.includes("archive('legacy', { key, item: it }, '_unowned')")&&root.includes('legacyOwner:restored'));
check('startup no longer creates unsafe pre-login cloud save',!root.includes('\nsave();\n\nlet adminFilter="all";'));
check('sync badge reconciles stale in-memory pending keys',root.includes('const st=ittrSync.status(),pending=st.pending')&&syncQ.includes('const keys = new Set([...pendingKeys(), ...Object.keys(flights).filter(k => flights[k])])'));
check('quarantine clears stale in-memory pending keys',syncQ.includes("o.storage.removeItem(LEGACY_KEY)")&&!root.includes('cloudPending'));

check('state writes require current server version',server.includes('STATE_VERSION_REQUIRED')&&server.includes('STATE_VERSION_CONFLICT'));
check('mechanic whole-state replacement blocked',server.includes('Mechanics cannot replace shared administrative state.'));
check('legacy local import is owner-only',server.includes('app.post("/api/state/import-local",auth,ownerOnly'));
check('paid and void invoices stay locked',server.includes('Paid or void invoices are locked and cannot be reopened.'));
check('duplicate payment retry guard present',server.includes('DUPLICATE_PAYMENT')&&server.includes("interval '15 seconds'"));
check('mechanic timer guard scans all work orders',server.includes("Array.isArray(sf.workorders)?sf.workorders:[]")&&server.includes('Pause or complete your current task before starting another one.'));
check('offline queue stores base server version',syncQ.includes('baseVersion: b.version, changes'));
check('offline replay uses queued base version',syncQ.includes('b.version === item.baseVersion')&&syncQ.includes('M.applyChanges(remote.payload, item.changes)'));
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
check('mechanic stale administrative queue is discarded',root.includes('allowKey:key=>session?.role==="mechanic"?key==="shopflow"')&&syncQ.includes("(o.allowKey && !o.allowKey(key))) { archive('unusable', { key, item }); const q = readQ(); delete q[ek]; writeQ(q); continue; }"));
check('Fullbay customer directory management-only',server.includes('app.get("/api/fullbay/customers",auth,managerPermission("customers")'));
check('Fullbay customer profile management-only',server.includes('app.get("/api/fullbay/customers/:id",auth,managerPermission("customers")'));
check('full backup owner-only',server.includes('app.get("/api/admin/backup",auth,ownerOnly'));
check('vendor resolver inventory-protected',server.includes("app.post('/api/parts/vendors/resolve',auth,managerPermission(\"inventory\")"));
check('inventory transaction inventory-protected',server.includes('app.post("/api/parts/:id/transaction",auth,managerPermission("inventory")'));
check('mechanic free-form inventory return removed',!server.includes('if(req.user.role!=="admin"&&!(["return"].includes(type)))'));
check('manager passwords minimum 12 chars',server.includes("password.length<12")&&server.includes('at least 12 characters are required'));
check('mechanic passwords minimum 10 chars',server.includes('password.length<10')&&server.includes('at least 10 characters are required'));
check('password reset revokes sessions',server.includes('DELETE FROM auth_sessions WHERE user_id=$1')&&server.includes('sessionsRevoked:true'));

// v24.28.x mechanic language preference + deterministic switch
check('self-service language preference endpoint exists',server.includes('app.patch("/api/auth/preferences",auth')&&server.includes('language_preference_changed'));
check('language preference accepts only en/uk',server.includes('["en","uk"].includes(language)'));
check('login session keeps account language',root.includes('language:u.language||localStorage.getItem("ittr_language")||"en"')&&root.includes('session=ittrSessionFromUser(d.user)'));
check('login session keeps manager permissions',root.includes('permissions:u.role==="manager"&&u.permissions'));
check('restore session keeps account language',root.includes('currentLanguage=session.language;localStorage.setItem("ittr_language",currentLanguage)'));
check('role application prefers session language',root.includes('if(session?.language){\n   currentLanguage=session.language;'));
check('language selector saves through self-service endpoint',root.includes('apiJSON("/api/auth/preferences",{method:"PATCH",body:{language:next}})'));
check('language switch performs clean reload',root.includes('A clean reload is intentional: it rebuilds the UI from the English source')&&root.includes('location.reload();'));
check('language switch rolls back on save failure',root.includes('session.language=priorSessionLanguage')&&root.includes('currentLanguage=previous'));
check('language selector locked while preference saves',root.includes('selector.disabled=true')&&root.includes('selector.disabled=false'));
check('language role-sync marker present',root.includes('ITTR_LANGUAGE_ROLE_SYNC'));

const partsInsert=server.match(/INSERT INTO fullbay_import_parts\([\s\S]*?VALUES\(([^)]*)\)[\s\S]*?ON CONFLICT\(source_key\)/);
if(partsInsert){const refs=[...partsInsert[1].matchAll(/\$(\d+)/g)].map(m=>Number(m[1]));const max=refs.length?Math.max(...refs):0;check('Fullbay v23.7.1 max parameter remains $22',max===22,`max=$${max}`);check('Fullbay v23.7.1 has no $23',!refs.includes(23));}else check('Fullbay inventory INSERT regression target found',false);

for(const name of ['customers','invoices','parts','procenter','trucksearch','estimates','reports','compliance','bills','purchaseorders']){
 for(const ext of ['html','js']){
  const a=`modules/${name}.${ext}`,b=`public/modules/${name}.${ext}`;
  check(`${name}.${ext} exists in both module trees`,exists(a)&&exists(b));
  if(exists(a)&&exists(b))check(`${name}.${ext} root/public synchronized`,read(a)===read(b));
 }
}

check('main inline script is not cut by an injected </script>',(()=>{const h=read('public/index.html');const i=h.indexOf('<script>');const j=h.indexOf('</script>',i);return i>0&&h.indexOf('<script src="./inspection-workflow.js',i)>j;})());
check('work-order numbers are never reused',server.includes('async function highestUsedWorkOrderId')&&server.includes('/api/work-orders/next-id')&&root.includes('await nextWorkOrderId()')&&!server.includes('Math.max(...numericIds):1000'));
check('reused work-order number links are repaired',server.includes('repairWorkOrderNumberCollisions()')&&server.includes('serviceOrderBelongsToOtherVehicle(ex,w)'));
check('all PDFs use Unicode fonts',server.includes('class PDFDocument extends PDFKitDocument')&&fs.existsSync('assets/fonts/DejaVuSansCondensed.ttf')&&fs.existsSync('assets/fonts/DejaVuSansCondensed-Bold.ttf'));
check('PDF footers never create blank pages',!/switchToPage\(i\);(?!doc\.page\.margins\.bottom=0)/.test(server));
check('labor-time adjustment needs no reason',!server.includes("Reason for labor-time adjustment is required.")&&!root.includes("Reason for changing completed mechanic time (required)"));
check('inventory reset is owner-only and confirmed',server.includes('/api/parts/inventory/reset-to-zero')&&server.includes('Type RESET to confirm.')&&server.includes("transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username,metadata) VALUES($1,'inventory_reset'"));
check('customer invoice PDF uses the branded renderer with shop address and contact',fs.existsSync('invoice_pdf.mjs')&&server.includes('renderCustomerDocumentPdf(')&&fs.readFileSync('invoice_pdf.mjs','utf8').includes('12161 S Central Ave')&&fs.readFileSync('invoice_pdf.mjs','utf8').includes('contact@ironttr.com'));
check('invoice email is an editable draft with the PDF attached',server.includes("/api/invoices/:id/email-draft")&&server.includes("attachments")&&root.includes('function openInvoiceEmailComposer('));
check('invoice Print uses the saved PDF, not the editing screen',root.includes('function printInvoicePdf(')&&!root.includes('<button class="secondary" onclick="window.print()">Print</button>'));
check('workshop manuals are indexed page by page and read only the needed pages',fs.existsSync('manual_library.mjs')&&server.includes('workshop_manual_pages')&&server.includes('async function readManualPages(')&&fs.readFileSync('shop_assistant.mjs','utf8').includes("name: 'manual_read'"));
check('manual uploads accept large PDFs and verify the PDF signature',server.includes('limits:{fileSize:250*1024*1024}')&&server.includes("head.toString()!=='%PDF-'"));
check('Workshop AI v2 uses role-safe lookups with conversation memory',fs.existsSync('shop_assistant.mjs')&&server.includes('runShopAssistant(')&&root.includes('history:c.history.slice(-8)')&&fs.readFileSync('shop_assistant.mjs','utf8').includes("!/^MANAGERS ONLY/.test(t.description)"));
check('keyword shortcuts no longer hijack real questions',server.includes("const shortCmd=m.length<=40")&&!server.includes("/\\b(check|audit|diagnos|bug|lag|slow|error)/.test(m)"));
check('main search finds parts and invoices',server.includes('Smart search parts warning')&&root.includes('<div class="smartResultType">Part</div>'));
check('cores screen has a button on the Parts page',read('public/modules/parts.html').includes('onclick="openCoreReport()"'));
check('owner-only inventory repair with preview',server.includes('/api/inventory/repair/preview')&&server.includes('app.post("/api/inventory/repair/apply",auth,ownerOnly'));
check('shop state loader reads query rows (truck/customer history sync)',server.includes(`const rows=(await requireDb().query("SELECT state_key,payload FROM app_state WHERE state_key IN ('shopflow','pro')")).rows;`));
check('service order to invoice keeps the inventory link',/INSERT INTO customer_invoice_lines\(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,line_total,parent_line_id,inventory_part_id,metadata\)/.test(server));
check('deleting an invoice returns posted stock',server.includes("Invoice ${inv.invoice_number} deleted")&&server.includes('serviceOrderReopened'));
check('partial core returns stay owed',server.includes('to=left>0?"outstanding":"returned"')&&server.includes("x.owed_quantity=openQ"));
check('core returns support date and attachments',server.includes('/api/inventory/cores/:id/attachments')&&server.includes('CORE_ATTACHMENT_TYPES')&&root.includes('function openCoreReturn('));
check('truck profile has an Inspections tab',root.includes('vehicleTab_inspections')&&root.includes('function vehicleInspectionsMarkup('));
check('work order PDF page breaks continue from the current line',!server.includes('ensure(135);y=doc.y=Math.max(doc.y,y)'));
check('start reaches server.js',String(pkg.scripts?.start||'').trim().endsWith('node server.js'),pkg.scripts?.start||'');
check('startup smoke test exists',exists('smoke_test.mjs'));
check('release check executes startup smoke test',String(pkg.scripts?.check||'').includes('node smoke_test.mjs'));
check('dedicated language-switch audit exists',exists('language_switch_audit.mjs'));
check('release check executes language-switch audit',String(pkg.scripts?.check||'').includes('node language_switch_audit.mjs'));
check('audit command uses production audit',pkg.scripts?.audit==='node production_audit.mjs',pkg.scripts?.audit||'');

// v24.37.0 finance center
const finance=exists('finance_center.mjs')?read('finance_center.mjs'):'';
check('finance center routes registered before API 404',server.includes('registerFinanceRoutes(app,')&&server.indexOf('registerFinanceRoutes(app,')<server.indexOf('app.use("/api",(req,res)=>res.status(404)'));
check('finance schema prepared at startup',server.includes('.then(()=>ensureFinanceSchema(pool))'));
check('estimates, reports and tire fees API present',finance.includes("'/api/estimates/:id/convert'")&&finance.includes("'/api/reports/finance'")&&finance.includes("'/api/invoices/:id/tire-fees'"));
check('reports require reports + invoices permission',finance.includes("app.get('/api/reports/finance', auth, reportsPerm, invoicesPerm"));
check('Gmail OAuth uses single-use state and encrypted refresh tokens',finance.includes('DELETE FROM gmail_oauth_states WHERE state=$1 AND expires_at>now()')&&finance.includes("createCipheriv('aes-256-gcm'")&&finance.includes('gmail.readonly'));
check('Gmail connect/disconnect owner-only',finance.includes("app.post('/api/gmail/connect', auth, ownerOnly")&&finance.includes("app.delete('/api/gmail/accounts/:id', auth, ownerOnly"));
check('Estimates and Reports tabs routed',root.includes('estimates:{html:routeAsset("/modules/estimates.html")')&&root.includes('reports:{html:routeAsset("/modules/reports.html")')&&root.includes('data-view="estimates"')&&root.includes('data-view="reports"'));
check('invoice editor has Tire Fees button',root.includes('onclick="openInvoiceTireFees()"')&&exists('public/finance-shared.js'));
check('mechanics never receive part buy cost',server.includes('function hidePartCostsFromMechanics(')&&server.includes('app.get("/api/parts",auth,hidePartCostsFromMechanics,'));
check('shop-floor stylesheet lives in the page head, not the label popup',root.includes('<style id="ittrShopFloorV2416">')&&!/<title>\$\{esc\(partNo[\s\S]{0,4000}v24\.16\.0 shop-floor/.test(root));
check('finalize recalculates paid status',server.includes("a draft paid in full before finalizing must land on 'paid'"));
check('release check executes finance integration test',String(pkg.scripts?.check||'').includes('node finance_center_integration_test.mjs'));

// v24.38.0 productivity, per-tire fees, stage colors
const prod=exists('mechanic_productivity.mjs')?read('mechanic_productivity.mjs'):'';
check('mechanic productivity report registered and reports-protected',server.includes('registerProductivityRoutes(app,')&&prod.includes("app.get('/api/reports/mechanics', auth, reportsPerm"));
check('tire fee dialog sits above the invoice workspace',read('public/finance-shared.js').includes('z-index:6000'));
check('tire fees attach to their tire line',finance.includes("metadata->>'forLineId'")&&server.includes("metadata->>'forLineId'=$1::text"));
check('work orders share one stage color scheme',root.includes('function woStage(w)')&&root.includes('class="woStageLegend"'));

// v24.39.0 compliance center, email template, reset
const comp=exists('compliance_center.mjs')?read('compliance_center.mjs'):'';
check('compliance routes registered before API 404',server.includes('registerComplianceRoutes(app,')&&server.indexOf('registerComplianceRoutes(app,')<server.indexOf('app.use("/api",(req,res)=>res.status(404)'));
check('data reset is owner-only, typed-confirmed and snapshotted',comp.includes("app.post('/api/admin/reset-data', auth, ownerOnly")&&comp.includes("'START FRESH'")&&comp.includes('INSERT INTO data_reset_snapshots'));
check('annual inspections fill the shop\'s own PDF forms',comp.includes('export async function renderInspectionTemplate')&&exists('assets/inspection-templates/annual-truck.pdf')&&exists('assets/inspection-templates/annual-trailer.pdf'));
check('customer emails use the branded template',server.includes('documentEmailHtml({kind:\'invoice\''));
check('Fullbay imports accept large CSV exports',server.includes('const csvUploadRaw=multer(')&&server.includes('fileSize:80*1024*1024')&&server.includes('"/api/fullbay/import/service-history",auth,managerPermission("customers"),csvUpload'));

const dupIds=[...root.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]).filter((x,i,a)=>a.indexOf(x)!==i);
check('no duplicate DOM ids in shell',dupIds.length===0,[...new Set(dupIds)].join(','));

// v24.41.0 time clock, labor times, audit fixes
const tc=exists('time_clock.mjs')?read('time_clock.mjs'):'',lt=exists('labor_times.mjs')?read('labor_times.mjs'):'';
check('time clock + labor routes registered before API 404',server.indexOf('registerTimeClockRoutes(app,')>0&&server.indexOf('registerLaborTimeRoutes(app,')>0&&server.indexOf('registerLaborTimeRoutes(app,')<server.indexOf('app.use("/api",(req,res)=>res.status(404)'));
check('clocking out pauses running task timers',server.includes('async function stopMechanicWork(')&&tc.includes("stopMechanicWork(db, username"));
check('one open shift per mechanic (database rule)',tc.includes('uq_mechanic_shift_open'));
check('timesheet changes are owner-only and need a reason',tc.includes("app.put('/api/timeclock/shifts/:id', auth, ownerOnly")&&tc.includes('needReason(b)')&&tc.includes('INSERT INTO mechanic_shift_edits'));
check('forgotten shifts close automatically',tc.includes('export async function closeForgottenShifts')&&server.includes('startTimeClockScheduler({pool'));
check('mechanic screen has the time clock',root.includes('id="mechanicClockCard"')&&root.includes('function punchMechanicClock()'));
check('labor times compare mechanics with the shop, not with padded billing',lt.includes('export function typicalTimes')&&lt.includes("basisOf(j)"));
check('startup log shows the real version',server.includes('console.log(`ITTR v${ITTR_APP_VERSION} Online running on port'));
check('vendor list does not resync on every request',server.includes('vendorSyncAt'));

check('mileage boxes accept 304,538 and save whole miles',root.includes('function enhanceMileageInput(')&&root.includes('document.addEventListener("submit"')&&read('finance_center.mjs').includes('export const cleanMiles')&&server.includes('mileage=mileage*1000 WHERE'));
check('payments have a type list, transaction IDs and search',root.includes('function paymentDialog(')&&!root.includes("prompt('Payment method (Check")&&server.includes("app.get('/api/payments/search'")&&server.includes("code:'DUPLICATE_REFERENCE'"));
check('vehicle inspections count as mechanic job work',read('mechanic_productivity.mjs').includes('FROM mechanic_inspections')&&read('labor_times.mjs').includes("T('vehicle_inspection'"));
check('dashboard shows a mechanic doing an inspection as working',root.includes('function mechanicInspectionInProgress(')&&server.includes('autoClockInSafe(req.user,"inspection")'));
check('mechanic time clock loads its real status on page refresh',root.includes('// v24.41.5: load the time clock on every page load/refresh')&&root.includes('id="mechClockBtn" class="mechClockBtn" onclick="punchMechanicClock()" disabled>Loading…'));
check('inspection time reaches the service order and invoice',server.includes('async function inspectionLabor(')&&(server.match(/inspectionLabor\(db,/g)||[]).length>=5);
check('activity tiles ask before changing the activity',root.includes('function confirmBox(')&&root.includes('const yes=await confirmBox('));
check('owner can list and manage manager accounts',server.includes('app.get("/api/admin/managers",auth,ownerOnly')&&root.includes('async function loadStaffAccounts(')&&root.includes('minlength="12"'));
check('inspection actions wait for the latest save',root.includes('window.syncNow=async function'));
check('work orders are cards on phones',root.includes('data-label="Scheduled"')&&root.includes('#workorders tr.woRow td[data-label]:before'));
check('Stripe online payments are recorded automatically (signed webhook)',server.includes('app.post("/api/stripe/webhook",express.raw(')&&server.indexOf('app.post("/api/stripe/webhook"')<server.indexOf('app.use(express.json(')&&server.includes('timingSafeEqual'));
check('invoice statuses have one color each and overdue days',root.includes('function invStatusPill(')&&root.includes('.invoiceStatus.is-overdue'));
check('work orders: one status pill, search and mechanic filter',root.includes('id="woSearch"')&&root.includes('id="woMechFilter"')&&!root.includes('<th>Availability</th>'));
check('Bills: every purchase by expense category, QuickBooks account mapping and sync fields, nav + route',exists('bills.mjs')&&read('bills.mjs').includes('export function quickBooksPayload(')&&read('bills.mjs').includes('qb_status')&&server.includes('registerBillRoutes(app,')&&server.indexOf('registerBillRoutes(app,')<server.indexOf('app.use("/api",(req,res)=>res.status(404)')&&pub.includes('data-view="bills"')&&pub.includes('bills:{html:routeAsset("/modules/bills.html")'));
check('Fullbay Details check: read-only compare shares the import key; junk VINs never written onto units',server.includes('function parseFullbayDetailRow(')&&server.includes('/api/fullbay/check/service-history')&&server.includes('const key=parseFullbayDetailRow(row).key;')&&server.includes('vin:realVin(vin)?vin:""')&&read('public/modules/procenter.html').includes('checkFullbayFiles()'));
check('Vendor invoices are entered in Bills: Parts has no vendor-bills tab; Bills scans and receives parts into stock',!read('public/modules/parts.html').includes('Receive Vendor Invoice')&&!pub.includes("['bills','Vendor bills',null]")&&pub.includes('function partsReceiveEntry(')&&read('public/modules/bills.js').includes('window.receiveFiledBill')&&read('public/modules/bills.js').includes('/api/vendor-invoices/scan'));
check('Zelle from Gmail: the bank confirmation number becomes the payment transaction ID (stored, re-read, backfilled)',read('finance_center.mjs').includes('export function zelleConfirmation(')&&read('finance_center.mjs').includes('str(conf || `Zelle ${m.counterparty')&&server.includes('backfillZelleConfirmations(pool)'));
check('Receive one payment for several invoices; leftover kept as customer credit and applied later (customer profile + Gmail Zelle)',exists('customer_payments.mjs')&&server.includes('registerCustomerPaymentRoutes(app,')&&server.indexOf('registerCustomerPaymentRoutes(app,')<server.indexOf('app.use("/api",(req,res)=>res.status(404)')&&pub.includes('function openReceivePayment(')&&pub.includes('$ Receive payment')&&read('public/modules/reports.js').includes('gmail-split'));
check('Gmail Zelle bigger than the invoice opens Receive payment (invoice paid in full, rest to other invoices or credit)',read('public/modules/reports.js').includes('async function zelleToInvoice(')&&pub.includes('opts.prefill'));
check('A/R aging by company (Fullbay-style buckets) with customer credit and net balance',read('customer_payments.mjs').includes("'/api/reports/ar-aging'")&&read('public/modules/reports.js').includes('function renderArAging(')&&read('public/modules/reports.js').includes("registerCsv('ar-aging'"));
check('Reports rebuilt: 5 report tabs (Overview, Customers owe, Spending, Mechanics with sub-tabs, Tire fees) + tools; no duplicate cards or bill upload in Reports',(()=>{const html=read('public/modules/reports.html'),js=read('public/modules/reports.js');return ['overview','ar','spend','mech','tires','inbox','ai'].every(t=>html.includes(`data-t="${t}"`))&&html.includes('id="repSubTabs"')&&!html.includes('data-t="parts"')&&!html.includes('data-t="vendors"')&&!js.includes("card('Who owes you money'")&&!js.includes("card('Sales by month'")&&!js.includes('function scanVendorFiles(')&&js.includes("card('Spending by category'")})());
check('page titles match the menu',root.includes('<div class="toolbar"><h1>Findings</h1></div>')&&read('public/modules/procenter.html').includes('<h1>Operations</h1>')&&read('public/modules/compliance.html').includes('<h1>Compliance</h1>'));
check('mechanic screen: clock, jobs, then activities; one-row phone header',root.includes('id="ittrV24418Phone"')&&root.indexOf('id="mechanicJobs"')<root.indexOf('id="mechanicActivityPanel"'));
check('delete work order sits apart from other actions',root.includes('class="dangerZone"'));
check('AI translation: batch, validated answers, no jumping',server.includes('parseBatchTranslations(src,raw)')&&root.includes('function applyKnownTranslations(')&&root.includes('ittr_ai_translation_cache_v2')&&root.includes('function aiValidTranslation('));
{const usage=read('ai_usage.mjs'),vb=read('vendor_bills.mjs'),ic=read('invoice_check.mjs'),rep=read('public/modules/reports.js');
check('AI usage meter wraps every AI client + monthly budget',server.includes('aiMeter.meterAIClient(rawOpenAIClient,"openai")')&&server.includes('aiMeter.meterAIClient(rawOpenRouterClient,"openrouter")')&&!/new OpenAI\([^)]*\)\.chat/.test(server)&&usage.includes("e.code = 'AI_BUDGET_REACHED'")&&server.includes('aiContext.run({feature:featureForPath(req.path),req},next)'));
check('AI translations shared in the database',server.includes('INSERT INTO ai_translation_cache')&&usage.includes('CREATE TABLE IF NOT EXISTS ai_translation_cache'));
check('Vendor bills: by vendor + price/duplicate/math/overdue analysis',vb.includes('export function analyzeVendors(')&&vb.includes('cheaperElsewhere')&&vb.includes("app.post('/api/vendor-invoices/gmail/:messageId/scan'")&&rep.includes('function renderVendors(')&&read('public/modules/reports.html').includes('data-t="spend"'));
check('Received vendor bill replaces a filed one (no duplicate block)',server.includes("DELETE FROM parts_vendor_invoices WHERE status='filed'"));
check('Invoice check: rules + optional AI wording, never auto-applied',ic.includes("'PART_NOT_BILLED'")&&ic.includes("'TIME_NOT_BILLED'")&&pub.includes('function checkInvoiceNow(')&&pub.includes('data-ic="use"'));
check('Receiving: description match, stock-unit conversion, filed bill receive',server.includes('await matchInvoiceLines(db,parsed.lines);')&&server.includes('stockQty=Number(l.stockQty)>0')&&read('vendor_bills.mjs').includes("'/api/vendor-invoices/:id/receiving-draft'")&&pub.includes('function receiveFiledBill(')&&pub.includes('id="recvStock${i}"'));
check('Fluids in gallons/quarts: stock moves 0.25 gal per qt, WO + invoice + PDF units',server.includes('const spu=Number(invoiceMeta(line?.metadata).stockPerUnit)>0')&&server.includes('registerFluidRoutes(app,')&&server.indexOf('registerFluidRoutes(app,')<server.indexOf('app.get("/api/parts/:id",')&&pub.includes('function openFluidsTool(')&&pub.includes('function invoiceFluidUnitChanged(')&&read('invoice_pdf.mjs').includes('fluidUnit(p)'));
check('Parts center: in stock grouped, fluids, need-to-order, vendor bills, use on work order in gal/qt',pub.includes('function partsGrouped(')&&pub.includes('function fluidCards(')&&pub.includes('function openUsePartDialog(')&&pub.includes('function openStockPicker(')&&pub.includes('async function partsVendorBills(')&&server.includes('if(filter==="instock")')&&server.includes('never_stocked'));
check('Clock-in required before work (server + mechanic prompt)',read('time_clock.mjs').includes('export async function assertClockedIn(')&&(server.match(/assertClockedIn\(/g)||[]).length>=3&&pub.includes('async function ensureClockedIn(')&&pub.includes('miniField.partUnitHidden{display:none!important}'));
check('Quart price = gallon price ÷ 4 to the cent (WO, invoice editor, unit switch)',server.includes('const unitPriceFor=(perStock,spu)=>Math.round(Number(perStock||0)*spu*100)/100')&&pub.includes('function invoiceFluidBase(')&&pub.includes('data-gal-price'));
check('Parts cleanup: undo gallons, not a fluid, delete/archive/restore, WO empty text',pub.includes('function undoFluidGallons(')&&pub.includes('function deleteSelectedParts(')&&read('fluids.mjs').includes("'/api/parts/delete'")&&read('fluids.mjs').includes('/fluids/revert')&&!pub.includes("'<tr><td colspan=\"7\" class=\"empty\">$"+"{esc("));
check('Vendor bill discount lowers the bill, not part cost',read('vendor_bills.mjs').includes('export function splitDiscountLines(')&&server.includes('splitDiscountLines(parsed)')&&pub.includes('id="recvDiscount"')&&read('public/modules/bills.js').includes('data-v="discount"'));
check('Vendor invoice can be typed in by hand (manual receiving + line matching)',pub.includes('function startManualReceiving(')&&server.includes('"/api/parts/receiving/match"')&&pub.includes('id="receiveLayoutFix"'));
check('Phone app: Capacitor shell, Android build workflow, /app download page, login kept in app',read('mobile/capacitor.config.json').includes('web-production-44bc4.up.railway.app')&&read('.github/workflows/android-app.yml').includes('assembleRelease')&&server.includes('app.get("/app"')&&pub.includes('ittr_app_')&&!/BEGIN|PRIVATE KEY/.test(read('mobile/android/app/build.gradle')));
check('Mechanic jobs/notes typed in Ukrainian are translated to English (button + on create), AI limit per user',pub.includes('function translateFieldToEnglish(')&&pub.includes('mechStartJobsTrBtn')&&pub.includes('reactivateTasksTrBtn')&&server.includes(' jobs:"The input is a list of repair jobs')&&server.includes('keyGenerator:req=>'));
check('Start a Truck draft survives outside tap, screen lock and reload; typed forms do not close on outside tap',pub.includes('ittr_mech_start_draft_')&&pub.includes('window.confirmCloseMechanicStartWizard=')&&pub.includes('window.clearMechStartDraft?.()')&&pub.includes('m.dataset.dirty==="1"'));
check('Work-order part number suggestions use our own high-contrast list (not the faint phone datalist)',pub.includes('function renderPartSuggest(')&&pub.includes('id="partSuggestStyles"')&&!pub.includes('list="fullbayPartNumberList" placeholder="Part Number"'));
check('Email: shop Google account sends invoices/estimates/reminders (send-only scope, encrypted token), customer PM reminders',read('email_templates.mjs').includes('export async function sendShopEmail(')&&read('finance_center.mjs').includes("gmail.send openid email")&&read('finance_center.mjs').includes('encryptToken(tok.refresh_token)')&&server.includes('await sendShopEmail({to,cc,replyTo')&&read('compliance_center.mjs').includes('export async function sendCustomerReminders(')&&read('public/modules/reports.js').includes('function emailSendingCard('));
check('Inspection / job timer end the mechanic activity on the server; mechanic card matches owner board',pub.includes('async function endMechanicActivityForWork(')&&!pub.includes('closeCurrentMechanicActivity(au,session.username);try{saveUsers(au)}')&&read('public/inspection-workflow.js').includes('window.focusMechanicOnInspection(id)')&&pub.includes('inspection-workflow.js?v=8'));
check('One thing at a time: inspection/activity pause the job timer, job ends the activity, most recent wins on both screens',server.includes('app.post("/api/mechanic/focus-inspection"')&&server.includes('"Switched to activity"')&&server.includes('async function endMechanicActivity(')&&pub.includes('function mechanicFocusKind(')&&read('public/inspection-workflow.js').includes('focusMechanicOnInspection'));
check('Workshop AI can answer live Samsara questions (location, miles, fuel, engine hours, codes) for mechanics too',read('samsara_assistant.mjs').includes('export function createSamsaraLookup(')&&read('shop_assistant.mjs').includes("name: 'samsara_vehicle', description: 'LIVE Samsara")&&server.includes('samsaraVehicle:createSamsaraLookup({paged:samsaraPaged'));
check('Inspection answers save on their own endpoint (no cloud-sync conflicts), survive background refresh; conflicts recover',server.includes('app.post("/api/work-orders/:id/inspection"')&&read('public/inspection-workflow.js').includes('window.reapplyInspectionEdits=')&&pub.includes('window.reapplyInspectionEdits?.()')&&pub.includes('onConflicts:(key,list)=>showToast(')&&pub.includes('<script src="./sync-queue.js?v='));
check('Reports AI usage tab',rep.includes('function renderAiUsage(')&&server.includes('registerAICenterRoutes(app,'));}
const failed=results.filter(x=>!x.ok);
for(const r of results)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}${r.detail?'  '+r.detail:''}`);
console.log(`\nITTR production audit: ${results.length-failed.length}/${results.length} passed`);
if(failed.length){console.error(`FAILED: ${failed.length}`);process.exit(1)}
