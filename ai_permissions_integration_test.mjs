// v24.67.0: Workshop AI data policy (shop_assistant.mjs) — role / permission matrix against a disposable database.
// For each account: which lookups are offered to the model, what each lookup returns (fields), whether restricted
// database queries run at all, and what happens when the model asks for a lookup that was not offered.
import { dbSuiteGuard, startTestServer, ok, eq } from './test_harness.mjs';
import { assistantRole, assistantCan, createAssistantTools, runShopAssistant } from './shop_assistant.mjs';
dbSuiteGuard('Workshop AI permission matrix');
const srv = await startTestServer({ prefix: 'ittr_aiperm' });

try {
  const { db } = srv;
  const cust = (await db.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,phone,dot_number,raw) VALUES('mx-c','Matrix Fleet','312-555-0100','7654321','{}'::jsonb) RETURNING id`)).rows[0].id;
  const unit = (await db.query(`INSERT INTO customer_units(customer_id,customer_name,unit_number,vin) VALUES($1,'Matrix Fleet','M-77','1XKYD49X8PJ000777') RETURNING id`, [cust])).rows[0].id;
  await db.query(`INSERT INTO fullbay_service_history(source_key,unit_number,vin,customer_name,service_order,invoice_number,complaint,actual_correction,action_completed_at,tech) VALUES('mx-h','M-77','1XKYD49X8PJ000777','Matrix Fleet','SO-77','FB-INV-77','brake noise','replaced brake shoes',now()-interval '20 days','tech1')`);
  const inv = (await db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,unit_id,unit_number,status,invoice_date,due_date,total,balance_due,created_by) VALUES('IT-MATRIX-1',$1,'Matrix Fleet',$2,'M-77','sent',CURRENT_DATE,CURRENT_DATE,987.65,987.65,'seed') RETURNING id`, [cust, unit])).rows[0].id;
  await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,line_type,description,quantity,unit_price,line_total) VALUES($1,1,'labor','Brake shoes replaced',2,125,250)`, [inv]);
  const part = (await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,cost,price,has_core,default_core_charge,status,raw) VALUES('mx-1','BRK-MX','Brake shoe kit',4,40,95.5,true,30,'Active','{}'::jsonb) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO parts_vendor_invoices(vendor,invoice_number,invoice_date,total,status,created_by) VALUES('MatrixParts','VB-1',CURRENT_DATE,412.10,'received','seed')`);
  const vendor = (await db.query(`INSERT INTO parts_vendors(canonical_name,aliases) VALUES('MatrixParts','[]'::jsonb) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO part_core_obligations(part_id,vendor_id,vendor_name_snapshot,quantity,open_quantity,unit_core_charge,original_amount,open_amount,status,due_date,created_by,updated_by) VALUES($1,$2,'MatrixParts',2,2,30,60,60,'outstanding',CURRENT_DATE+30,'seed','seed')`, [part, vendor]);
  const shop = { workorders: [{ id: '9001', unit: 'M-77', unitRecordId: String(unit), customer: 'Matrix Fleet', status: 'Open', mechanic: 'mech1', tasks: [{ uid: 'x', t: 'Brakes', parts: [{ partNumber: 'BRK-MX', qty: 1, unitPrice: 95.5 }] }] }, { id: '9002', unit: 'OTHER', customer: 'Other', status: 'Open', mechanic: 'mech2', tasks: [] }] };

  // Every query a lookup runs is recorded, so "a restricted query did not run" can be checked, not just the output.
  let sql = [];
  const spy = { query: (text, params) => { sql.push(String(text)); return db.query(text, params); } };
  const ranInvoiceQuery = () => sql.some(q => /customer_invoices|customer_invoice_lines/.test(q));
  const ranVendorQuery = () => sql.some(q => /parts_vendor_invoices/.test(q));
  const ranCustomerQuery = () => sql.some(q => /FROM fullbay_import_customers/.test(q));
  const ranCoreQuery = () => sql.some(q => /part_core_obligations c JOIN/.test(q));
  const tools = who => createAssistantTools({ db: spy, who, getShopflow: async () => shop, searchManuals: async () => [], readManual: async () => ({}), samsaraVehicle: async () => null });
  const call = async (who, name, args) => { sql = []; const r = await tools(who)[name](args); return { r, json: JSON.stringify(r) }; };
  const denied = r => /not have access/.test(r?.error || '');

  const P = (...k) => Object.fromEntries(['invoices', 'financials', 'inventory', 'customers', 'reports', 'employees'].map(x => [x, k.includes(x)]));
  // inv: invoice records · money: dollar amounts · cust: customer contact details · inv+money: vendor bills · inventory: cores
  const matrix = [
    { name: 'owner', user: { role: 'admin', username: 'opsadmin' }, inv: true, money: true, cust: true, vendors: true, cores: true },
    { name: 'mechanic', user: { role: 'mechanic', username: 'mech1' }, inv: false, money: false, cust: false, vendors: false, cores: false },
    { name: 'manager (no permissions)', user: { role: 'manager', username: 'm0', permissions: P() }, inv: false, money: false, cust: false, vendors: false, cores: false },
    { name: 'manager (Invoices)', user: { role: 'manager', username: 'm1', permissions: P('invoices') }, inv: true, money: false, cust: false, vendors: false, cores: false },
    { name: 'manager (Financial totals)', user: { role: 'manager', username: 'm2', permissions: P('financials') }, inv: false, money: true, cust: false, vendors: false, cores: false },
    { name: 'manager (Invoices + Financial totals)', user: { role: 'manager', username: 'm3', permissions: P('invoices', 'financials') }, inv: true, money: true, cust: false, vendors: true, cores: false },
    { name: 'manager (Customers)', user: { role: 'manager', username: 'm4', permissions: P('customers') }, inv: false, money: false, cust: true, vendors: false, cores: false },
    { name: 'manager (Parts & inventory)', user: { role: 'manager', username: 'm5', permissions: P('inventory') }, inv: false, money: false, cust: false, vendors: false, cores: true },
    { name: 'manager (Reports + Employees only)', user: { role: 'manager', username: 'm6', permissions: P('reports', 'employees') }, inv: false, money: false, cust: false, vendors: false, cores: false },
  ];

  for (const row of matrix) {
    const who = assistantRole(row.user), tag = row.name;
    eq(assistantCan(who, 'invoices'), row.inv, `${tag}: invoices`); eq(assistantCan(who, 'money'), row.money, `${tag}: money`); eq(assistantCan(who, 'customers'), row.cust, `${tag}: customers`);

    // truck_history: Fullbay repair history is always there; invoice numbers, ITTR invoices and totals follow policy.
    let { r, json } = await call(who, 'truck_history', { unit_id: String(unit) });
    ok(r.fullbayHistory?.length === 1 && /replaced brake shoes/.test(json), `${tag}: repair history visible`);
    eq(json.includes('FB-INV-77'), row.inv, `${tag}: Fullbay invoice number in truck history`);
    eq(json.includes('IT-MATRIX-1'), row.inv, `${tag}: ITTR invoice in truck history`);
    eq(json.includes('987.65'), row.inv && row.money, `${tag}: invoice total in truck history`);
    eq(ranInvoiceQuery(), row.inv, `${tag}: invoice query executed by truck_history`);
    ok(r.ittrWorkOrders.some(w => w.workOrder === '9001'), `${tag}: this truck's work order (mech1's) in its history`);
    ({ r } = await call(who, 'work_orders', { status: 'all' }));
    // v24.75.0 policy: every mechanic may read every shop work order (the app shows them all); acting stays assignment-only.
    ok(r.workOrders.some(w => w.workOrder === '9002'), `${tag}: other mechanics' work orders listed`);

    ({ r, json } = await call(who, 'search_repair_history', { text: 'brake' }));
    ok(/replaced brake shoes/.test(json), `${tag}: repair search works`);
    eq(json.includes('FB-INV-77'), row.inv, `${tag}: Fullbay invoice number in repair search`);
    eq(json.includes('IT-MATRIX-1'), row.inv, `${tag}: ITTR invoice lines in repair search`);
    eq(ranInvoiceQuery(), row.inv, `${tag}: invoice query executed by repair search`);
    eq(json.includes('Matrix Fleet'), row.user.role !== 'mechanic', `${tag}: customer name in cross-fleet search`);

    ({ r, json } = await call(who, 'invoices', {}));
    eq(denied(r), !row.inv, `${tag}: invoices tool refused`); eq(ranInvoiceQuery(), row.inv, `${tag}: invoices tool query executed`);
    if (row.inv) eq(json.includes('987.65'), row.money, `${tag}: invoice amounts`);

    ({ r, json } = await call(who, 'vendor_bills', {}));
    eq(denied(r), !row.vendors, `${tag}: vendor bills refused`); eq(ranVendorQuery(), row.vendors, `${tag}: vendor query executed`);

    ({ r, json } = await call(who, 'search_customers', { query: 'matrix' }));
    eq(denied(r), !row.cust, `${tag}: customer lookup refused`); eq(ranCustomerQuery(), row.cust, `${tag}: customer query executed`);
    if (row.cust) ok(json.includes('312-555-0100'), `${tag}: contact details for Customers permission`);

    ({ r, json } = await call(who, 'cores_owed', {}));
    eq(denied(r), !row.cores, `${tag}: cores refused`); eq(ranCoreQuery(), row.cores, `${tag}: core query executed`);
    if (row.cores && r.items?.length) eq(json.includes('"value"'), row.money, `${tag}: core dollar value`);

    ({ r, json } = await call(who, 'search_parts', { query: 'BRK-MX' }));
    ok(r.parts?.[0]?.onHand === 4, `${tag}: parts stock visible`); eq(json.includes('95.5'), row.money, `${tag}: part price`);

    ({ r, json } = await call(who, 'work_order_details', { id: '9001' }));
    eq(json.includes('95.5'), row.money, `${tag}: price of a part on a work order`);

    // The model is offered only allowed lookups, and asking for one that was not offered is refused at execution.
    const offered = []; const forced = [];
    const out = await runShopAssistant({ question: 'list unpaid invoices and customer phones', who, tools: tools(who), today: '2026-10-16', chat: async (messages, defs) => {
      if (!offered.length) offered.push(...(defs || []).map(d => d.function.name));
      const asked = messages.filter(m => m.role === 'tool');
      if (!asked.length) { sql = []; return { choices: [{ message: { content: '', tool_calls: ['invoices', 'search_customers', 'vendor_bills', 'cores_owed', 'nonexistent_tool', '__proto__'].map((n, i) => ({ id: `c${i}`, type: 'function', function: { name: n, arguments: '{}' } })) } }] }; }
      forced.push(...asked.map(m => m.content)); return { choices: [{ message: { content: 'done' } }] };
    } });
    eq(offered.includes('invoices'), row.inv, `${tag}: invoices offered`); eq(offered.includes('search_customers'), row.cust, `${tag}: customers offered`);
    eq(offered.includes('vendor_bills'), row.vendors, `${tag}: vendor bills offered`); eq(offered.includes('cores_owed'), row.cores, `${tag}: cores offered`);
    eq(/not have access/.test(forced[0]), !row.inv, `${tag}: model-requested invoices`); eq(/not have access/.test(forced[1]), !row.cust, `${tag}: model-requested customers`);
    eq(/not have access/.test(forced[2]), !row.vendors, `${tag}: model-requested vendor bills`); eq(/not have access/.test(forced[3]), !row.cores, `${tag}: model-requested cores`);
    ok(/Unknown tool/.test(forced[4]) && /Unknown tool/.test(forced[5]), `${tag}: unknown or prototype tool names are not run`);
    if (!row.inv) ok(!ranInvoiceQuery(), `${tag}: no invoice query ran for model-requested lookups`);
    if (!row.cust) ok(!ranCustomerQuery(), `${tag}: no customer query ran for model-requested lookups`);
    if (!row.vendors) ok(!ranVendorQuery(), `${tag}: no vendor query ran for model-requested lookups`);
    eq(out.answer, 'done', `${tag}: conversation finishes`);
    console.log(`PASS ${tag}`);
  }
  console.log('Workshop AI permission matrix: all roles passed');
} finally { await srv.cleanup(); }
