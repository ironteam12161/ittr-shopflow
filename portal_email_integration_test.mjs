// v24.74.0: regression suite for the October 17, 2026 portal, email and Operations audit — real server, disposable
// database, fake Google/Resend servers on 127.0.0.1 (no real provider, never production).
// P1  portal "You owe" / overdue count every unpaid invoice, not only the latest 150 rows; an unlinked invoice is matched
//     by name only when exactly one customer has that name.
// REV estimate links opened from a portal stop working when the portal is turned off.
// P2  an inspection answer where one repair cannot be recorded still records the others and says which were not.
// E1  Gmail accepted the email, then our own bookkeeping failed: the Resend backup must NOT send it a second time.
// E2  "Email link" builds the address on the server; a link with another host is refused and nothing is sent.
// E3  the invoice email does not say a PDF is attached when it is not.
// P4  Stripe returns the customer to a public receipt page that shows the server's payment state.
// P5  (browser) choosing Approve/Decline keeps the typed name, note and tick box. P2 page shows the per-repair outcome.
// O1  (browser) the AI CSV shortcut opens Operations → Fullbay instead of an unknown page.
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
import { documentEmailHtml } from './email_templates.mjs';
const NAME = 'portal email integration';
dbSuiteGuard(NAME);

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const gmailSent = [], resendSent = [];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = d => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(d)); };
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (u.pathname === '/token') return json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.send openid email', id_token: `x.${Buffer.from(JSON.stringify({ email: 'shop@example.com' })).toString('base64url')}.y` });
    if (u.pathname === '/gmail/users/me/messages/send') { gmailSent.push(Buffer.from(JSON.parse(b).raw, 'base64url').toString('utf8')); return json({ id: `g${gmailSent.length}` }); }
    if (u.pathname === '/resend') { resendSent.push(JSON.parse(b)); return json({ id: `r${resendSent.length}` }); }
    res.statusCode = 404; res.end('{}');
  });
});
const fakePort = await freePort(); await new Promise(r => fake.listen(fakePort, '127.0.0.1', r));
const F = `http://127.0.0.1:${fakePort}`;

const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_portal', admin: OWNER, env: {
  STRIPE_SECRET_KEY: '', RESEND_API_KEY: 're_test', INVOICE_FROM_EMAIL: 'billing@shop.example', RESEND_API_URL: `${F}/resend`,
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'http://127.0.0.1/api/gmail/oauth/callback', GMAIL_TOKEN_KEY: 'ci-portal-token-key-0123456789',
  GOOGLE_OAUTH_AUTH_URL: `${F}/auth`, GOOGLE_OAUTH_TOKEN_URL: `${F}/token`, GOOGLE_OAUTH_REVOKE_URL: `${F}/revoke`, GMAIL_API_BASE: `${F}/gmail` } });
const R = srv.request, db = srv.db;
const failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
const decoded = raw => raw + raw.split(/\r?\n\r?\n/).map(p => { try { return Buffer.from(p.split(/\r?\n--/)[0].replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return ''; } }).join('\n');
const tokenOf = url => String(url || '').split('/c/')[1];
let browser = null, inspToken = '';

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  const cust = async name => (await db.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,email) VALUES($1,$2,'') RETURNING id`, [`t-${name}-${Math.random()}`, name])).rows[0].id;
  let invN = 0;
  const invoice = (customerId, name, { date, due, total, balance }) => db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,status,invoice_date,due_date,total,balance_due,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'test') RETURNING id`, [`T-${++invN}`, customerId, name, balance > 0 ? 'sent' : 'paid', date, due, total, balance]).then(r => r.rows[0].id);
  const portalFor = async id => (await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'portal', refId: String(id) } }));

  await scenario('P1 portal totals count every unpaid invoice, including ones older than the latest 150', async () => {
    const id = await cust('Big Fleet LLC');
    await invoice(id, 'Big Fleet LLC', { date: '2024-01-10', due: '2024-02-09', total: 900, balance: 900 });                 // old unpaid, overdue
    for (let i = 0; i < 160; i++) await invoice(id, 'Big Fleet LLC', { date: '2026-09-01', due: '2026-10-01', total: 100, balance: 0 }); // recent paid
    await invoice(id, 'Big Fleet LLC', { date: '2026-10-10', due: '2099-01-01', total: 250, balance: 250 });                 // recent unpaid, not due
    const v = await R(`/api/public/link/${tokenOf((await portalFor(id)).url)}`);
    eq(v.owed, 1150, 'You owe includes the old unpaid invoice');
    eq(v.overdue, 900, 'overdue includes the old unpaid invoice');
    ok(v.invoices.some(i => i.balance === 900), 'the old unpaid invoice is listed');
  });

  await scenario('P1 an unlinked invoice is matched by name only when one customer has that name', async () => {
    const a = await cust('Same Name Trucking'); await cust('Same Name Trucking');
    await invoice(null, 'Same Name Trucking', { date: '2026-10-01', due: '2026-10-31', total: 777, balance: 777 });
    const v = await R(`/api/public/link/${tokenOf((await portalFor(a)).url)}`);
    ok(!v.invoices.some(i => i.total === 777), 'the other company\'s unlinked invoice is not shown'); eq(v.owed, 0, 'and not counted');
    const solo = await cust('Only One Hauling');
    await invoice(null, 'Only One Hauling', { date: '2026-10-01', due: '2099-01-01', total: 55, balance: 55 });
    eq((await R(`/api/public/link/${tokenOf((await portalFor(solo)).url)}`)).owed, 55, 'a unique name still finds its older unlinked invoice');
  });

  await scenario('REV turning a portal off also ends estimate links opened from it', async () => {
    const id = await cust('Revoke Fleet');
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Revoke Fleet' } });
    await R(`/api/estimates/${e.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'PM service', quantity: 1, unitPrice: 100 } });
    await db.query(`UPDATE customer_estimates SET customer_id=$2,status='sent' WHERE id=$1`, [e.id, id]);
    const p = await portalFor(id), pt = tokenOf(p.url);
    const child = tokenOf((await R(`/api/public/link/${pt}/estimate/${e.id}/open`, { method: 'POST' })).url);
    eq((await R(`/api/public/link/${child}`, { allowError: true })).status, 200, 'estimate link from the portal opens');
    await R(`/api/customer-links/${p.id}`, { method: 'DELETE', token: owner });
    ok((await R(`/api/public/link/${child}`, { allowError: true })).status >= 400, 'estimate link stops after the portal is turned off');
    ok((await R(`/api/public/link/${child}/decide`, { method: 'POST', body: { name: 'Pat Driver', agree: true, jobs: {} }, allowError: true })).status >= 400, 'and cannot be answered');
  });

  // Work order with two recommended repairs; the second has no repair text, so the shop cannot turn it into a job.
  const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
  sf.workorders = [{ id: 701, unit: 'T-701', customer: 'Decide Fleet', status: 'In Progress', mechanic: '', helpers: [], tasks: [], inspection: { required: true, type: 'truck', status: 'Completed', results: {} } }];
  sf.issues = [{ id: 'f-ok', wo: 701, recommendation: 'Replace front brake pads', approval: 'Waiting for Customer' }, { id: 'f-bad', wo: 701, recommendation: '', description: '', approval: 'Waiting for Customer' }];
  await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  inspToken = tokenOf((await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'inspection', refId: '701' } })).url);

  await scenario('P2 a partly recorded inspection answer says which repairs were recorded', async () => {
    const r = await R(`/api/public/link/${inspToken}/decide`, { method: 'POST', body: { name: 'Pat Driver', agree: true, findings: { 'f-ok': 'approve', 'f-bad': 'approve' } }, allowError: true });
    eq(r.status, 200, 'answer accepted'); eq(r.partial, true, 'marked partial'); eq(r.recorded, 1, 'one recorded');
    eq(JSON.stringify((r.results || []).map(x => [x.id, x.ok]).sort()), JSON.stringify([['f-bad', false], ['f-ok', true]]), 'per-repair outcome');
    const after = (await R('/api/state', { token: owner })).shopflow.payload;
    eq(after.issues.find(i => i.id === 'f-ok').approval, 'Proceed', 'the good repair is approved in the shop');
    ok(after.workorders[0].tasks.some(t => String(t.findingId) === 'f-ok'), 'and became a job');
    const link = (await db.query(`SELECT meta FROM customer_links WHERE kind='inspection' AND ref_id='701'`)).rows[0];
    eq(link.meta.recorded, 1, 'link records how many were recorded');
  });

  // Connect the shop's Google email through the fake Google server.
  const ec = await R('/api/email/google/connect', { method: 'POST', token: owner, body: {} });
  await fetch(`${srv.base()}/api/gmail/oauth/callback?state=${new URL(ec.url).searchParams.get('state')}&code=x`, { redirect: 'manual' });
  eq((await R('/api/email/status', { token: owner })).provider, 'gmail', 'Gmail sender connected for the email scenarios');
  const emInv = await invoice(null, 'Mail Fleet', { date: '2026-10-01', due: '2026-10-31', total: 120, balance: 120 });
  await db.query(`INSERT INTO customer_invoice_lines(invoice_id,line_type,description,quantity,unit_price) VALUES($1,'labor','Brake job',1,120)`, [emInv]);

  await scenario('E1 Gmail accepted the email, bookkeeping then failed: no second copy through Resend', async () => {
    await db.query(`CREATE OR REPLACE FUNCTION ittr_test_fail_sender() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.last_sent_at IS DISTINCT FROM OLD.last_sent_at THEN RAISE EXCEPTION 'simulated status write failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ittr_test_fail_sender BEFORE UPDATE ON email_sender FOR EACH ROW EXECUTE FUNCTION ittr_test_fail_sender()`);
    try {
      const g0 = gmailSent.length, r0 = resendSent.length;
      const r = await R(`/api/invoices/${emInv}/email`, { method: 'POST', token: owner, body: { to: 'customer@example.com', subject: 'Invoice', message: 'Hello' }, allowError: true });
      eq(gmailSent.length - g0, 1, 'Gmail sent it once'); eq(resendSent.length - r0, 0, 'the backup sent nothing');
      eq(r.status, 200, 'answer says sent');
    } finally { await db.query('DROP TRIGGER IF EXISTS ittr_test_fail_sender ON email_sender'); }
  });

  await scenario('E1 the invoice is not reported as failed when only our record of the send fails', async () => {
    await db.query(`CREATE OR REPLACE FUNCTION ittr_test_fail_inv() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.email_sent_at IS DISTINCT FROM OLD.email_sent_at THEN RAISE EXCEPTION 'simulated invoice write failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ittr_test_fail_inv BEFORE UPDATE ON customer_invoices FOR EACH ROW EXECUTE FUNCTION ittr_test_fail_inv()`);
    try {
      const g0 = gmailSent.length;
      const r = await R(`/api/invoices/${emInv}/email`, { method: 'POST', token: owner, body: { to: 'customer@example.com', subject: 'Invoice', message: 'Hello', requestId: 'e1-book' }, allowError: true });
      eq(gmailSent.length - g0, 1, 'sent once'); eq(r.status, 200, 'answer says sent'); ok(/Do not send it again/.test(r.warning || ''), 'with a warning about the record');
      const d = (await db.query(`SELECT status FROM invoice_email_deliveries WHERE idempotency_key=$1`, [`invoice-${emInv}-e1-book`])).rows[0];
      eq(d?.status, 'sent', 'the delivery is not marked failed');
    } finally { await db.query('DROP TRIGGER IF EXISTS ittr_test_fail_inv ON customer_invoices'); }
  });

  await scenario('E3 invoice email without a PDF does not claim one is attached', async () => {
    const g0 = gmailSent.length;
    await R(`/api/invoices/${emInv}/email`, { method: 'POST', token: owner, body: { to: 'customer@example.com', attachPdf: false, requestId: 'e3' } });
    const raw = gmailSent.slice(g0).join('\n'), text = decoded(raw);
    ok(!/application\/pdf/.test(raw), 'no PDF part'); ok(!/attached as a PDF/.test(text), 'no "attached as a PDF" line'); ok(!/is attached\./.test(text), 'default message does not say attached');
    ok(/attached as a PDF/.test(documentEmailHtml({ kind: 'invoice', doc: {}, shop: { name: 'S' } })), 'with a PDF the line is still there');
  });

  await scenario('E2 Email link refuses a link on another host and sends nothing', async () => {
    const l = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'inspection', refId: '701' } }), t = tokenOf(l.url);
    const g0 = gmailSent.length, r0 = resendSent.length;
    const bad = await R('/api/customer-links/email', { method: 'POST', token: owner, body: { kind: 'inspection', refId: '701', url: `https://evil.example/c/${t}`, to: 'customer@example.com' }, allowError: true });
    eq(bad.status, 400, 'foreign host refused'); eq(gmailSent.length + resendSent.length - g0 - r0, 0, 'nothing sent');
    const good = await R('/api/customer-links/email', { method: 'POST', token: owner, body: { kind: 'inspection', refId: '701', url: l.url, to: 'customer@example.com' } });
    ok(good.ok && decoded(gmailSent.at(-1)).includes(`${srv.base()}/c/${t}`), 'the shop\'s own link is emailed');
  });

  await scenario('P4 Stripe returns to a public receipt page with the server\'s payment state', async () => {
    const src = readFileSync('server.js', 'utf8');
    ok(/success_url',`\$\{base\}\/pay\/return\?ref=/.test(src) && /cancel_url',`\$\{base\}\/pay\/return\?ref=/.test(src), 'checkout return URLs point at /pay/return');
    const id = await invoice(null, 'Pay Fleet', { date: '2026-10-01', due: '2026-10-31', total: 300, balance: 300 }), ref = 'r'.repeat(10) + 'Abc_-0123456789xyzXYZ0123456789';
    await db.query('UPDATE customer_invoices SET payment_return_ref=$2 WHERE id=$1', [id, ref]);
    const page = await fetch(`${srv.base()}/pay/return?ref=${ref}&status=success`);
    ok(page.ok && /pay-return\.js/.test(await page.text()), 'receipt page served without signing in');
    let s = await R(`/api/public/pay/${ref}`); eq(s.paid, false, 'not paid yet'); eq(s.balance, 300, 'balance shown');
    ok(!('customer' in s) && !('id' in s), 'no account details');
    await db.query(`UPDATE customer_invoices SET balance_due=0,status='paid' WHERE id=$1`, [id]);
    s = await R(`/api/public/pay/${ref}`); eq(s.paid, true, 'paid after the webhook records it');
    eq((await R('/api/public/pay/not-a-real-reference-0000000000000', { allowError: true })).status, 404, 'unknown reference');
  });

  // ---------- browser ----------
  const require = createRequire(import.meta.url);
  let chromium = null; try { ({ chromium } = require('playwright')); } catch (_) {}
  const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  if (chromium) browser = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!browser) {
    if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { failures.push('browser (Chromium not available)'); console.error('FAIL browser scenarios: Chromium not available'); }
    else console.log('SKIP browser scenarios: Chromium not available (P5, O1 not checked)');
  } else {
    // Fresh repair to decide in the browser.
    const s2 = await R('/api/state', { token: owner }), sf2 = s2.shopflow.payload;
    sf2.issues.push({ id: 'f-two', wo: 701, recommendation: 'Replace wiper blades', approval: 'Waiting for Customer' }, { id: 'f-bad2', wo: 701, recommendation: '', description: '', approval: 'Waiting for Customer' });
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf2, expectedVersion: s2.shopflow.version } });
    await scenario('P5 choosing Approve/Decline keeps the typed name, note, tick box and focus; P2 page lists outcomes', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await ctx.newPage(); page.setDefaultTimeout(5000);
      await page.goto(`${srv.base()}/c/${inspToken}`); await page.waitForSelector('#signName');
      await page.fill('#signName', 'Pat Driver'); await page.fill('#signNote', 'Call me first'); await page.check('#signAgree');
      await page.click('button[data-k="f-two"][data-v="approve"]');
      eq(await page.inputValue('#signName'), 'Pat Driver', 'name kept'); eq(await page.inputValue('#signNote'), 'Call me first', 'note kept');
      eq(await page.isChecked('#signAgree'), true, 'tick box kept');
      eq(await page.evaluate(() => document.activeElement?.dataset?.k || ''), 'f-two', 'focus stays on the chosen button');
      await page.click('button[data-k="f-bad2"][data-v="approve"]');
      eq(await page.inputValue('#signName'), 'Pat Driver', 'name kept after a second choice');
      await page.click('#submitBtn'); await page.waitForSelector('#partialResult');
      const txt = await page.textContent('#partialResult');
      ok(/1 of 2/.test(txt) && /Replace wiper blades/.test(txt) && /not recorded/.test(txt), `outcome per repair shown (${txt.slice(0, 120)})`);
      await ctx.close();
    });
    await scenario('O1 AI CSV shortcut opens Operations → Fullbay', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' }), page = await ctx.newPage(); page.setDefaultTimeout(8000);
      await page.goto(srv.base()); await page.fill('#loginUser', OWNER.username); await page.fill('#loginPass', OWNER.password); await page.click('#loginForm button[type="submit"]');
      await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady, null, { timeout: 15000 });
      await page.evaluate(() => analyzeShopAiAttachment({}, new File(['a,b\n1,2'], 'customers.csv', { type: 'text/csv' }), ''));
      await page.waitForFunction(() => currentView === 'procenter' && !document.getElementById('procenter')?.classList.contains('hidden'), null, { timeout: 8000 });
      await sleep(1200);
      ok(await page.evaluate(() => { const el = document.querySelector('#procenter [data-pro-panel="fullbay"], #procenter #proPanel-fullbay, #procenter #fullbayPanel'); return !el || el.offsetParent !== null; }), 'Fullbay panel visible');
      await ctx.close();
    });
  }
} catch (e) { failures.push(`setup: ${e.message.split('\n')[0]}`); console.error(e); }
finally { if (browser) await browser.close().catch(() => {}); await srv.cleanup(); fake.close(); }

if (failures.length) { reportSuite(NAME, 'FAILED', failures.join('; ')); console.error(`FAIL ${NAME}: ${failures.length} scenario(s)`); process.exit(1); }
reportSuite(NAME, 'PASSED'); console.log(`PASS ${NAME}`);
