// ITTR ShopFlow v24.42.0: AI usage meter + budget, shared translation cache, vendor bills by vendor, invoice check.
// Pure rules are tested first; the DB part runs the real server against a local fake OpenRouter so no AI credit is used.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import assert from 'node:assert/strict';
import { estimateCost, featureForPath, cleanAIBudget } from './ai_usage.mjs';
import { analyzeVendors, checkInvoiceMath, normInvoiceNo } from './vendor_bills.mjs';
import { checkInvoice, parseWordingAnswer } from './invoice_check.mjs';

// ---------------------------------------------------------------- pure rules
assert.equal(featureForPath('/api/translate'), 'translate');
assert.equal(featureForPath('/api/vendor-invoices/scan'), 'vendor_bills');
assert.equal(featureForPath('/api/invoices/12/check/wording'), 'invoice_check');
assert.equal(featureForPath('/api/parts/receiving/scan-invoice'), 'vendor_scan');
assert.ok(Math.abs(estimateCost('google/gemini-2.5-flash-lite', 1_000_000, 1_000_000) - 0.5) < 1e-9);
assert.deepEqual(cleanAIBudget({ monthlyLimit: -5, warnAt: 3 }), { monthlyLimit: 25, warnAt: 0.8 });
assert.equal(normInvoiceNo('INV-000123'), normInvoiceNo('123'));
assert.deepEqual(checkInvoiceMath({ subtotal: 100, tax: 8, freight: 0, total: 108 }, [{ quantity: 2, unit_cost: 50, line_total: 100 }]), []);
assert.deepEqual(checkInvoiceMath({ subtotal: 100, tax: 8, freight: 0, total: 128 }, []).map(p => p.code), ['TOTAL_MISMATCH']);
assert.deepEqual(checkInvoiceMath({ subtotal: 150, total: 150 }, [{ quantity: 2, unit_cost: 50, line_total: 100 }]).map(p => p.code), ['LINES_NE_SUBTOTAL']);
{
  const inv = [
    { id: 1, vendor: 'FleetPride', invoice_number: 'A1', invoice_date: '2026-03-01', total: 100, status: 'received' },
    { id: 2, vendor: 'FleetPride', invoice_number: 'A2', invoice_date: '2026-05-01', total: 120, status: 'filed', due_date: '2026-05-15' },
    { id: 3, vendor: 'TruckPro', invoice_number: 'T1', invoice_date: '2026-04-01', total: 90, status: 'filed', paid_at: '2026-04-02' },
    { id: 4, vendor: 'TruckPro', invoice_number: 'INV-0T1', invoice_date: '2026-04-20', total: 10, status: 'filed', paid_at: '2026-04-21' },
  ];
  const lines = [
    { invoice_id: 1, vendor_part_number: 'WS-370', description: 'Wheel seal', quantity: 2, unit_cost: 50, line_total: 100 },
    { invoice_id: 2, vendor_part_number: 'ws370', description: 'Wheel seal', quantity: 2, unit_cost: 60, line_total: 120 },
    { invoice_id: 3, vendor_part_number: 'WS 370', description: 'Wheel seal', quantity: 2, unit_cost: 45, line_total: 90 },
  ];
  const a = analyzeVendors({ invoices: inv, lines, cores: [{ vendor: 'FleetPride', open_quantity: 1, open_amount: 40, due_date: '2026-04-01' }], from: '2026-01-01', to: '2026-12-31', today: '2026-06-01' });
  assert.equal(a.vendors[0].vendor, 'FleetPride'); assert.equal(a.vendors[0].total, 220); assert.equal(a.vendors[0].overdue, 120); assert.equal(a.vendors[0].coresValue, 40);
  assert.equal(a.alerts.priceIncreases.length, 1); assert.equal(a.alerts.priceIncreases[0].pct, 20); assert.equal(a.alerts.priceIncreases[0].extra, 20);
  assert.equal(a.alerts.cheaperElsewhere[0].cheaperVendor, 'TruckPro'); assert.equal(a.alerts.cheaperElsewhere[0].savings, 30);
  assert.equal(a.alerts.duplicates[0].reason, 'Same invoice number');
  assert.equal(a.alerts.unpaidPastDue[0].daysLate, 17); assert.equal(a.alerts.coresPastDue.length, 1);
  assert.equal(a.totals.unpaid, 120); // the received bill has no due date, so it does not count as owed
  const merged = analyzeVendors({ invoices: [{ id: 1, vendor: 'FleetPride', total: 10, invoice_date: '2026-02-01' }, { id: 2, vendor: 'FleetPride', total: 10, invoice_date: '2026-02-02' }, { id: 3, vendor: 'Fleetpride INC', total: 5, invoice_date: '2026-03-01' }], from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(merged.vendors.map(v => [v.vendor, v.bills]), [['FleetPride', 3]]);
}
{
  const standards = [{ key: 'wheel_seal', label: 'Wheel seal', keywords: ['wheel seal'], standard: 2.5, n: 12 }];
  const wo = { id: '2003', tasks: [{ t: 'Replace wheel seal LF', parts: [{ partNumber: 'WS-370', qty: 2 }, { partNumber: 'GR-1', qty: 1 }] }] };
  const lines = [
    { id: 1, line_type: 'labor', description: 'Replace wheel seal LF', quantity: 1, unit_price: 110 },
    { id: 2, line_type: 'part', part_number: 'ws370', description: 'Seal', quantity: 1, unit_price: 40, unit_cost: 50 },
  ];
  const r = checkInvoice({ invoice: { status: 'draft', unit_number: '12', vin: '', mileage: 0 }, lines, workOrder: wo, realHours: 3.2, standards });
  const codes = r.findings.map(f => f.code);
  for (const c of ['TIME_NOT_BILLED', 'PART_NOT_BILLED', 'PART_QTY_SHORT', 'LABOR_BELOW_USUAL', 'BELOW_COST', 'MISSING_INFO', 'NO_EMAIL']) assert.ok(codes.includes(c), `${c} missing in ${codes}`);
  assert.equal(r.findings.find(f => f.code === 'LABOR_BELOW_USUAL').suggestedHours, 2.5);
  assert.equal(r.findings[0].level, 'high');
  const clean = checkInvoice({ invoice: { status: 'sent', unit_number: '1', vin: 'X', mileage: 5 }, lines: [{ id: 1, line_type: 'labor', description: 'PM service', quantity: 1, unit_price: 110 }], standards });
  assert.equal(clean.ok, true);
}
assert.deepEqual(parseWordingAnswer('```json\n{"lines":[{"id":"5","text":"Replaced the LF wheel seal."},{"id":"9","text":"x"},{"id":"6","text":"As an AI I cannot"}]}\n```', [5, 6]), [{ id: '5', text: 'Replaced the LF wheel seal.' }]);
console.log('PASS AI center rules: usage cost + budget, vendor analysis (price up, cheaper elsewhere, duplicates, overdue, cores), bill math, invoice check, wording guard');

if (process.env.ITTR_INVENTORY_TEST_DB !== '1' || !process.env.DATABASE_URL) {
  console.log('SKIP AI center DB integration: ITTR_INVENTORY_TEST_DB/DATABASE_URL not set');
  process.exit(0);
}

// ---------------------------------------------------------------- fake OpenRouter
const COST = 0.004, calls = [];
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
    const j = JSON.parse(body || '{}'); const msgs = j.messages || [];
    const sys = typeof msgs[0]?.content === 'string' ? msgs[0].content : '';
    const userText = (m => typeof m?.content === 'string' ? m.content : (m?.content || []).map(c => c.text || '').join(' '))(msgs[msgs.length - 1]);
    let content = 'ok';
    if (/user-interface text/.test(sys)) { calls.push('translate'); content = JSON.stringify({ translations: JSON.parse(userText).texts.map(t => `UK ${t}`) }); }
    else if (/parts vendor invoice/.test(userText)) { calls.push('vendor'); content = JSON.stringify({ vendor: 'FleetPride Inc.', invoiceNumber: 'FP-1001', invoiceDate: '2026-10-01', terms: 'Net 30', poNumber: 'PO7', subtotal: 150, tax: 12, freight: 0, total: 162, lines: [{ partNumber: 'WS-370', description: 'Wheel seal', quantity: 2, unitCost: 50, lineTotal: 100 }, { partNumber: 'BRK-1', description: 'Brake shoe kit', quantity: 1, unitCost: 40, lineTotal: 40 }] }); }
    else if (/purchasing analyst/.test(sys)) { calls.push('summary'); content = '• Most money went to FleetPride.'; }
    else if (/invoice labor descriptions/.test(sys)) { calls.push('wording'); const inp = JSON.parse(userText); content = JSON.stringify({ lines: inp.lines.map(l => ({ id: l.id, text: `Replaced the left front wheel seal and checked hub for leaks.` })) }); }
    else calls.push('other');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: COST } }));
  });
});
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.once('error', reject); s.listen({ host: '127.0.0.1', port: 0 }, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const fakePort = await freePort(); await new Promise(r => fake.listen(fakePort, '127.0.0.1', r));

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const adminUser = 'aiadmin', adminPass = 'CI-AI-Admin-2026!';
let child = null, output = '', port = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, { method = 'GET', token, body, form, expect } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const text = await r.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (expect ? r.status !== expect : !r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 400)}\n${output.slice(-3000)}`);
  return data;
}
try {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  port = await freePort();
  child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'test', BOOTSTRAP_ADMIN_USERNAME: adminUser, BOOTSTRAP_ADMIN_PASSWORD: adminPass, OPENAI_API_KEY: '', OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${fakePort}`, SAMSARA_API_TOKEN: '', R2_BUCKET_NAME: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 150; i++) { try { const h = await call('/api/health'); if (h.db) break; } catch {} await sleep(100); }
  await sleep(400); // schema migrations after health
  const { token } = await call('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPass } });

  // Translation: batch, then served from the shared DB cache (no new AI call).
  const t1 = await call('/api/translate', { method: 'POST', token, body: { targetLanguage: 'Ukrainian', texts: ['Save bill', 'Vendor'] } });
  assert.deepEqual(t1.translations, ['UK Save bill', 'UK Vendor']);
  const cached = await db.query("SELECT count(*)::int n FROM ai_translation_cache WHERE target_language='Ukrainian'");
  assert.equal(cached.rows[0].n, 2);
  await call('/api/translate', { method: 'POST', token, body: { targetLanguage: 'Ukrainian', texts: ['Vendor'] } });
  assert.equal(calls.filter(c => c === 'translate').length, 1);
  console.log('PASS AI translation: one batch call, shared DB cache, repeat costs nothing');

  // Vendor bill: AI scan -> review draft -> save under the vendor; duplicates blocked.
  const form = new FormData(); form.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'fp-1001.pdf');
  const draft = await call('/api/vendor-invoices/scan', { method: 'POST', token, form });
  assert.equal(draft.invoice.invoiceNumber, 'FP-1001'); assert.equal(draft.invoice.dueDate, '2026-10-31'); assert.equal(draft.lines.length, 2);
  assert.deepEqual(draft.mathProblems.map(p => p.code), ['LINES_NE_SUBTOTAL']);
  const saved = await call('/api/vendor-invoices', { method: 'POST', token, body: { invoice: draft.invoice, lines: draft.lines, file: draft.file } });
  await call('/api/vendor-invoices', { method: 'POST', token, body: { invoice: draft.invoice, lines: draft.lines }, expect: 409 });
  await call('/api/vendor-invoices', { method: 'POST', token, body: { invoice: { vendor: 'FleetPride Inc.', invoiceNumber: 'FP-0900', invoiceDate: '2026-08-01', subtotal: 90, total: 90 }, lines: [{ partNumber: 'WS370', description: 'Wheel seal', quantity: 2, unitCost: 45, lineTotal: 90 }] } });
  await call('/api/vendor-invoices', { method: 'POST', token, body: { invoice: { vendor: 'TruckPro', invoiceNumber: 'TP-1', invoiceDate: '2026-09-15', dueDate: '2026-09-30', subtotal: 80, total: 80 }, lines: [{ partNumber: 'WS-370', description: 'Wheel seal', quantity: 2, unitCost: 40, lineTotal: 80 }] } });
  const an = await call('/api/vendor-invoices/analysis?from=2026-01-01&to=2026-12-31', { token });
  assert.equal(an.vendors.length, 2); assert.equal(an.vendors[0].bills, 2);
  assert.equal(an.alerts.priceIncreases.length, 1); assert.equal(an.alerts.priceIncreases[0].newCost, 50);
  assert.ok(an.alerts.cheaperElsewhere.some(c => /truckpro/i.test(c.cheaperVendor)));
  assert.equal(an.alerts.mathProblems.length, 1); assert.ok(an.alerts.unpaidPastDue.some(u => u.invoiceNumber === 'TP-1'));
  const tp = an.alerts.unpaidPastDue.find(u => u.invoiceNumber === 'TP-1');
  await call(`/api/vendor-invoices/${tp.invoiceId}`, { method: 'PATCH', token, body: { paid: true, paidOn: '2026-10-05', paidReference: 'CHK 1042' } });
  const an2 = await call('/api/vendor-invoices/analysis?from=2026-01-01&to=2026-12-31', { token });
  assert.equal(an2.alerts.unpaidPastDue.some(u => u.invoiceNumber === 'TP-1'), false);
  const one = await call(`/api/vendor-invoices/${saved.id}`, { token });
  assert.equal(one.lines.length, 2); assert.equal(one.invoice.source_method, 'ai_file');
  const list = await call('/api/vendor-invoices?from=2026-01-01&to=2026-12-31&q=brake', { token });
  assert.deepEqual(list.items.map(i => i.invoice_number), ['FP-1001']);
  const sum = await call('/api/vendor-invoices/analysis/summary', { method: 'POST', token, body: { from: '2026-01-01', to: '2026-12-31' } });
  assert.match(sum.summary, /FleetPride/i);
  console.log('PASS vendor bills: AI scan, filed by vendor, duplicates blocked, price increase, cheaper elsewhere, math check, paid/overdue, search, AI summary');

  // Invoice check + AI wording on a real invoice.
  const inv = (await db.query(`INSERT INTO customer_invoices(invoice_number,customer_name,unit_number,status,created_by) VALUES('AI-CHK-1','Check Co','77','draft','aiadmin') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO customer_invoice_lines(invoice_id,line_type,description,quantity,unit_price,line_total) VALUES($1,'labor','поміняв сальник ліве переднє колесо',2,110,220)`, [inv]);
  await db.query(`INSERT INTO customer_invoice_lines(invoice_id,line_type,description,part_number,quantity,unit_price,unit_cost,line_total) VALUES($1,'part','Wheel seal','WS-370',1,30,50,30)`, [inv]);
  const chk = await call(`/api/invoices/${inv}/check`, { token });
  assert.ok(chk.findings.some(f => f.code === 'BELOW_COST')); assert.ok(chk.findings.some(f => f.code === 'MISSING_INFO'));
  const wd = await call(`/api/invoices/${inv}/check/wording`, { method: 'POST', token, body: {} });
  assert.equal(wd.suggestions.length, 1); assert.match(wd.suggestions[0].suggested, /^Replaced/);
  console.log('PASS invoice check: below cost + missing info found; AI wording suggestion returned (not applied automatically)');

  // Usage meter and budget.
  await sleep(300);
  const u = await call('/api/ai/usage', { token });
  assert.equal(u.month.calls, calls.length); assert.equal(u.month.estimated, false);
  assert.ok(Math.abs(u.month.cost - COST * calls.length) < 1e-6, `cost ${u.month.cost}`);
  for (const f of ['translate', 'vendor_bills', 'invoice_check']) assert.ok(u.byFeature.some(x => x.feature === f), `feature ${f} not logged`);
  assert.ok(u.byUser.some(x => x.username === adminUser));
  await call('/api/ai/budget', { method: 'PUT', token, body: { monthlyLimit: 0.01 } });
  const blocked = await call('/api/translate', { method: 'POST', token, body: { targetLanguage: 'Ukrainian', texts: ['Brand new text'] }, expect: 429 });
  assert.equal(blocked.code, 'AI_BUDGET_REACHED');
  await call('/api/translate', { method: 'POST', token, body: { targetLanguage: 'Ukrainian', texts: ['Vendor'] } }); // cached text still works
  await call('/api/ai/budget', { method: 'PUT', token, body: { monthlyLimit: 25 } });
  await call('/api/translate', { method: 'POST', token, body: { targetLanguage: 'Ukrainian', texts: ['Brand new text'] } });
  console.log('PASS AI usage: every call logged with real cost by feature and user; monthly budget stops new AI calls, cached text still served');
  console.log('AI center integration: all scenarios passed');
} finally {
  if (child) child.kill('SIGTERM');
  fake.close(); await db.end();
}
