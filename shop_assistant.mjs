// ITTR Workshop AI v2 — the model looks up exactly what each question needs (read-only lookups),
// instead of receiving a large data dump. Cheaper per question and able to answer about parts,
// stock, cores, work orders, invoices, customers, mechanics and truck history.
// Every lookup respects the user's role: mechanics never see prices/invoices or other mechanics'
// work orders; only admins/managers see customers, invoices and cores.

const MAX_ROUNDS = 5;
const MAX_TOOL_CHARS = 7000;
const lc = v => String(v ?? '').trim().toLowerCase();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clip = (v, n = 240) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const day = v => { const d = new Date(v || ''); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const likeTerms = q => String(q || '').toLowerCase().split(/[\s,;/]+/).map(x => x.replace(/[%_\\]/g, '')).filter(x => x.length >= 2).slice(0, 6);

export function assistantRole(user) {
  const role = String(user?.role || '');
  const manager = role === 'admin' || role === 'manager';
  return {
    role, manager, username: lc(user?.username),
    financial: role === 'admin' || (role === 'manager' && user?.permissions?.financials !== false),
  };
}

function woMechanics(w) { return [w?.mechanic, ...(Array.isArray(w?.helpers) ? w.helpers : [])].map(lc).filter(Boolean); }
function woVisible(w, who) { return who.manager || woMechanics(w).includes(who.username); }
function woSummary(w, who) {
  const tasks = (Array.isArray(w?.tasks) ? w.tasks : []).filter(t => !t?.cancelled);
  return {
    workOrder: w.id, unit: w.unitGenerated ? '' : (w.unit || ''), customer: w.customer || '', status: w.status || '',
    mechanic: w.mechanic || '', helpers: Array.isArray(w.helpers) ? w.helpers : [], date: w.date || '', completedAt: day(w.completedAt),
    jobs: tasks.map(t => ({ job: clip(t.t, 120), done: !!t.done, runningBy: t.runningBy || '', paused: !!t.paused,
      parts: (Array.isArray(t.parts) ? t.parts : []).map(p => ({ partNumber: p.partNumber || '', qty: num(p.qty), ...(who.financial ? { price: num(p.unitPrice) } : {}) })) })),
    inspection: w.inspection?.required ? { type: w.inspection.type, status: w.inspection.status } : undefined,
  };
}

export const ASSISTANT_TOOLS = [
  { name: 'shop_status', description: 'Live overview of the shop right now: open work orders by status, which mechanic is working on which job, trucks waiting, low-stock parts count and cores owed. Use for "what is going on", "who is working on what", "what is waiting".', parameters: { type: 'object', properties: {} } },
  { name: 'find_truck', description: 'Find a truck or trailer by unit number, full VIN, last digits of the VIN, or license plate. Always use this first when the user mentions a truck, then use truck_history.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Unit number, VIN, last 6-8 VIN digits, or plate' } }, required: ['query'] } },
  { name: 'truck_history', description: 'Repair history of one truck: ITTR work orders, ITTR invoices, imported Fullbay history and inspections, newest first. Optionally filter by a keyword such as "oil", "brake", "DPF", "PM".', parameters: { type: 'object', properties: { unit_id: { type: 'string', description: 'id returned by find_truck' }, keyword: { type: 'string' }, limit: { type: 'integer', description: 'max rows per source, default 8' } }, required: ['unit_id'] } },
  { name: 'search_parts', description: 'Search the parts inventory by part number, description, brand or barcode. Returns on-hand, reserved and available stock and shelf location. Use for "do we have …", "how many …", "where is …".', parameters: { type: 'object', properties: { query: { type: 'string' }, low_stock_only: { type: 'boolean' } }, required: ['query'] } },
  { name: 'work_orders', description: 'List work orders, filtered by status (open, completed, all), mechanic username, unit number or customer name.', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'completed', 'all'] }, mechanic: { type: 'string' }, unit: { type: 'string' }, customer: { type: 'string' } } } },
  { name: 'work_order_details', description: 'Full details of one work order: jobs, who worked on them, parts, inspection results and notes.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'search_repair_history', description: 'Search ALL repair history across every truck (Fullbay history and ITTR invoices) for a repair, part or complaint, e.g. "DPF cleaning", "turbo", "air leak". Use when no single truck is given.', parameters: { type: 'object', properties: { text: { type: 'string' }, since_days: { type: 'integer' } }, required: ['text'] } },
  { name: 'search_customers', description: 'MANAGERS ONLY. Find a customer by name, phone, email or DOT number; returns contact details and how many trucks they have.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'invoices', description: 'MANAGERS ONLY. Find invoices by customer, unit or invoice number, or list unpaid invoices.', parameters: { type: 'object', properties: { query: { type: 'string' }, unpaid_only: { type: 'boolean' } } } },
  { name: 'cores_owed', description: 'MANAGERS ONLY. Cores still owed back to vendors (quantity and dollar amount), optionally for one vendor or part.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
];

export function createAssistantTools({ db, who, getShopflow, findManuals }) {
  let sfCache = null;
  const sf = async () => (sfCache ||= (await getShopflow()) || {});
  const allWo = async () => (Array.isArray((await sf()).workorders) ? (await sf()).workorders : []).filter(w => w && typeof w === 'object');
  const denied = { error: 'This information is only available to managers.' };

  return {
    async shop_status() {
      const wos = (await allWo()).filter(w => woVisible(w, who));
      const open = wos.filter(w => String(w.status) !== 'Completed');
      const byStatus = {}; for (const w of open) byStatus[w.status || 'Unknown'] = (byStatus[w.status || 'Unknown'] || 0) + 1;
      const working = [];
      for (const w of open) for (const t of (w.tasks || [])) if (t?.runningBy && !t.done) working.push({ mechanic: t.runningBy, workOrder: w.id, unit: w.unit, job: clip(t.t, 80) });
      const out = { openWorkOrders: open.length, byStatus, mechanicsWorkingNow: working, waiting: open.filter(w => /wait|hold|parts/i.test(String(w.status))).map(w => ({ workOrder: w.id, unit: w.unit, status: w.status })).slice(0, 15) };
      const low = await db.query("SELECT count(*)::int n FROM fullbay_import_parts WHERE coalesce(reorder_point,0)>0 AND coalesce(quantity,0)-coalesce(allocated,0)<=reorder_point");
      out.lowStockParts = low.rows[0]?.n || 0;
      if (who.manager) { try { const c = await db.query("SELECT coalesce(sum(open_quantity),0) q FROM part_core_obligations WHERE status NOT IN ('closed','credited')"); out.coresOwed = num(c.rows[0]?.q); } catch (_) {} }
      return out;
    },

    async find_truck({ query }) {
      const q = String(query || '').trim(); if (!q) return { error: 'Give a unit number, VIN or plate.' };
      const r = await db.query(`SELECT id,unit_number,vin,year,make,model,plate,customer_name,mileage FROM customer_units
        WHERE lower(unit_number)=lower($1) OR upper(vin)=upper($1) OR (length($1)>=6 AND upper(vin) LIKE '%'||upper($1)) OR lower(coalesce(plate,''))=lower($1) OR lower(coalesce(fleet_number,''))=lower($1)
        ORDER BY (lower(unit_number)=lower($1)) DESC, updated_at DESC NULLS LAST LIMIT 5`, [q]);
      if (!r.rowCount) return { found: 0, note: `No truck matches "${q}". Ask the user to check the number.` };
      return { found: r.rowCount, trucks: r.rows.map(u => ({ unit_id: String(u.id), unit: u.unit_number, vin: u.vin, vehicle: [u.year, u.make, u.model].filter(Boolean).join(' '), plate: u.plate || '', customer: u.customer_name || '', mileage: u.mileage != null ? num(u.mileage) : null })) };
    },

    async truck_history({ unit_id, keyword = '', limit = 8 }) {
      const u = (await db.query('SELECT * FROM customer_units WHERE id::text=$1', [String(unit_id)])).rows[0];
      if (!u) return { error: 'Unknown unit_id — call find_truck first.' };
      const lim = Math.min(20, Math.max(1, num(limit) || 8)), kw = String(keyword || '').trim(), terms = likeTerms(kw);
      const match = txt => !terms.length || terms.some(t => lc(txt).includes(t));
      const wos = (await allWo()).filter(w => woVisible(w, who) && (String(w.unitRecordId || '') === String(u.id) || (u.vin && lc(w.vin) === lc(u.vin)) || lc(w.unit) === lc(u.unit_number)))
        .filter(w => match(JSON.stringify((w.tasks || []).map(t => t.t)) + ' ' + (w.notes || '') + ' ' + (w.completionNotes || '')))
        .sort((a, b) => String(b.completedAt || b.date || '').localeCompare(String(a.completedAt || a.date || ''))).slice(0, lim).map(w => woSummary(w, who));
      const kwSql = terms.length ? `AND (${terms.map((_, i) => `lower(coalesce(complaint,'')||' '||coalesce(actual_correction,'')||' '||coalesce(component,'')||' '||coalesce(system,'')) LIKE $${i + 3}`).join(' OR ')})` : '';
      const fb = (await db.query(`SELECT service_order,invoice_number,action_completed_at,unit_miles,hours,complaint,actual_correction,component,tech FROM fullbay_service_history
        WHERE (lower(coalesce(unit_number,''))=lower($1) OR ($2<>'' AND upper(coalesce(vin,''))=upper($2))) ${kwSql} ORDER BY action_completed_at DESC NULLS LAST LIMIT ${lim}`,
        [u.unit_number || '', u.vin || '', ...terms.map(t => `%${t}%`)])).rows.map(h => ({ date: day(h.action_completed_at), serviceOrder: h.service_order, invoice: h.invoice_number, miles: h.unit_miles, hours: h.hours, complaint: clip(h.complaint, 160), correction: clip(h.actual_correction, 200), tech: h.tech }));
      let inv = [];
      if (who.financial || who.manager) {
        const ir = await db.query(`SELECT i.invoice_number,i.invoice_date,i.status,i.mileage,i.total,string_agg(DISTINCT l.description,' | ') jobs FROM customer_invoices i LEFT JOIN customer_invoice_lines l ON l.invoice_id=i.id
          WHERE (i.unit_id::text=$1 OR lower(coalesce(i.unit_number,''))=lower($2) OR ($3<>'' AND upper(coalesce(i.vin,''))=upper($3))) AND i.status<>'void' GROUP BY i.id ORDER BY i.invoice_date DESC NULLS LAST LIMIT ${lim}`, [String(u.id), u.unit_number || '', u.vin || '']);
        inv = ir.rows.filter(r => match(r.jobs)).map(r => ({ invoice: r.invoice_number, date: day(r.invoice_date), status: r.status, mileage: r.mileage, jobs: clip(r.jobs, 300), ...(who.financial ? { total: num(r.total) } : {}) }));
      }
      let insp = [];
      try { insp = (await db.query(`SELECT work_order_id,inspection_type,status,mechanic_username,completed_at,summary,findings FROM mechanic_inspections WHERE unit_id=$1 OR lower(coalesce(unit_number_snapshot,''))=lower($2) ORDER BY coalesce(completed_at,updated_at) DESC LIMIT 5`, [u.id, u.unit_number || ''])).rows
        .map(x => ({ workOrder: x.work_order_id, date: day(x.completed_at), type: x.inspection_type, mechanic: x.mechanic_username, repair: num(x.summary?.repair), attention: num(x.summary?.attention), findings: (Array.isArray(x.findings) ? x.findings : []).slice(0, 8).map(f => clip(`${f.status}: ${f.label || f.id}${f.note ? ` — ${f.note}` : ''}`, 140)) })); } catch (_) {}
      return { truck: { unit: u.unit_number, vin: u.vin, vehicle: [u.year, u.make, u.model].filter(Boolean).join(' '), customer: u.customer_name, mileage: u.mileage != null ? num(u.mileage) : null, engine: u.engine || '' }, keyword: kw || undefined, ittrWorkOrders: wos, ittrInvoices: inv, fullbayHistory: fb, inspections: insp };
    },

    async search_parts({ query, low_stock_only = false }) {
      const terms = likeTerms(query); if (!terms.length && !low_stock_only) return { error: 'Give a part number or description.' };
      const where = terms.map((_, i) => `lower(coalesce(part_number,'')||' '||coalesce(description,'')||' '||coalesce(manufacturer,'')||' '||coalesce(internal_barcode,'')||' '||coalesce(barcode_aliases::text,'')) LIKE $${i + 1}`);
      const r = await db.query(`SELECT part_number,description,manufacturer,quantity,allocated,location,uom,has_core,default_core_charge,price,reorder_point,on_order FROM fullbay_import_parts
        WHERE ${where.length ? where.join(' AND ') : 'TRUE'} ${low_stock_only ? "AND coalesce(reorder_point,0)>0 AND coalesce(quantity,0)-coalesce(allocated,0)<=reorder_point" : ''}
        ORDER BY (lower(part_number)=lower($${terms.length + 1})) DESC, coalesce(quantity,0) DESC LIMIT 12`, [...terms.map(t => `%${t}%`), String(query || '').trim()]);
      return { found: r.rowCount, parts: r.rows.map(p => ({ partNumber: p.part_number, description: clip(p.description, 120), brand: p.manufacturer || '', onHand: num(p.quantity), reserved: num(p.allocated), available: num(p.quantity) - num(p.allocated), location: p.location || '', unit: p.uom || '', onOrder: num(p.on_order) || undefined, hasCore: !!p.has_core || undefined, ...(who.financial ? { price: num(p.price), coreCharge: p.has_core ? num(p.default_core_charge) : undefined } : {}) })) };
    },

    async work_orders({ status = 'open', mechanic = '', unit = '', customer = '' }) {
      let list = (await allWo()).filter(w => woVisible(w, who));
      if (status === 'open') list = list.filter(w => String(w.status) !== 'Completed'); else if (status === 'completed') list = list.filter(w => String(w.status) === 'Completed');
      if (mechanic) list = list.filter(w => woMechanics(w).some(m => m.includes(lc(mechanic))) || (w.tasks || []).some(t => lc(t.runningBy).includes(lc(mechanic))));
      if (unit) list = list.filter(w => lc(w.unit) === lc(unit) || lc(w.vin).endsWith(lc(unit)));
      if (customer) list = list.filter(w => lc(w.customer).includes(lc(customer)));
      list.sort((a, b) => String(b.completedAt || b.date || '').localeCompare(String(a.completedAt || a.date || '')));
      return { count: list.length, workOrders: list.slice(0, 15).map(w => woSummary(w, who)) };
    },

    async work_order_details({ id }) {
      const w = (await allWo()).find(x => String(x.id) === String(id).replace(/^#/, ''));
      if (!w || !woVisible(w, who)) return { error: `Work order ${id} not found${who.manager ? '' : ' among your work orders'}.` };
      const res = w.inspection?.results || {};
      return { ...woSummary(w, who), notes: clip(w.notes, 400), completionNotes: clip(w.completionNotes, 400), futureRepairs: clip(w.futureNotes, 300), mileage: w.mileage || null,
        jobDetails: (w.tasks || []).filter(t => !t?.cancelled).map(t => ({ job: clip(t.t, 160), outcome: t.taskOutcome || '', outcomeNote: clip(t.outcomeNote, 200), addedBy: t.addedBy || '', minutes: Math.round(num(t.elapsedMs) / 60000) })),
        inspectionFlags: Object.entries(res).filter(([, r]) => ['repair', 'attention'].includes(r?.status)).map(([k, r]) => `${r.status}: ${k}${r.note ? ` — ${clip(r.note, 100)}` : ''}`).slice(0, 20) };
    },

    async search_repair_history({ text, since_days = 0 }) {
      const terms = likeTerms(text); if (!terms.length) return { error: 'Give words to search for.' };
      const since = num(since_days) > 0 ? `AND action_completed_at >= now() - ($${terms.length + 1}::int * interval '1 day')` : '';
      const params = [...terms.map(t => `%${t}%`), ...(since ? [num(since_days)] : [])];
      const fb = await db.query(`SELECT unit_number,customer_name,action_completed_at,unit_miles,complaint,actual_correction,tech,invoice_number FROM fullbay_service_history
        WHERE ${terms.map((_, i) => `lower(coalesce(complaint,'')||' '||coalesce(actual_correction,'')||' '||coalesce(component,'')||' '||coalesce(system,'')) LIKE $${i + 1}`).join(' AND ')} ${since}
        ORDER BY action_completed_at DESC NULLS LAST LIMIT 12`, params);
      const out = { fullbay: fb.rows.map(h => ({ unit: h.unit_number, customer: who.manager ? h.customer_name : undefined, date: day(h.action_completed_at), miles: h.unit_miles, complaint: clip(h.complaint, 140), correction: clip(h.actual_correction, 180), tech: h.tech, invoice: who.manager ? h.invoice_number : undefined })) };
      if (who.manager) {
        const il = await db.query(`SELECT i.invoice_number,i.unit_number,i.customer_name,i.invoice_date,l.description FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id
          WHERE i.status<>'void' AND ${terms.map((_, i) => `lower(coalesce(l.description,'')||' '||coalesce(l.part_number,'')) LIKE $${i + 1}`).join(' AND ')} ORDER BY i.invoice_date DESC NULLS LAST LIMIT 10`, terms.map(t => `%${t}%`));
        out.ittrInvoices = il.rows.map(r => ({ invoice: r.invoice_number, unit: r.unit_number, customer: r.customer_name, date: day(r.invoice_date), line: clip(r.description, 140) }));
      }
      return out;
    },

    async search_customers({ query }) {
      if (!who.manager) return denied;
      const terms = likeTerms(query); if (!terms.length) return { error: 'Give a name, phone, email or DOT.' };
      const r = await db.query(`SELECT c.id,c.customer_name,c.phone,c.email,c.dot_number,c.city,c.state,c.contact_name,(SELECT count(*)::int FROM customer_units u WHERE u.customer_id::text=c.id::text) trucks FROM fullbay_import_customers c
        WHERE c.deleted_at IS NULL AND ${terms.map((_, i) => `lower(coalesce(c.customer_name,'')||' '||coalesce(c.phone,'')||' '||coalesce(c.email,'')||' '||coalesce(c.dot_number,'')||' '||coalesce(c.contact_name,'')) LIKE $${i + 1}`).join(' AND ')} ORDER BY c.customer_name LIMIT 8`, terms.map(t => `%${t}%`));
      return { found: r.rowCount, customers: r.rows.map(c => ({ name: c.customer_name, contact: c.contact_name || '', phone: c.phone || '', email: c.email || '', dot: c.dot_number || '', location: [c.city, c.state].filter(Boolean).join(', '), trucks: c.trucks })) };
    },

    async invoices({ query = '', unpaid_only = false }) {
      if (!who.financial) return denied;
      const terms = likeTerms(query);
      const r = await db.query(`SELECT invoice_number,customer_name,unit_number,status,invoice_date,due_date,total,balance_due FROM customer_invoices
        WHERE status<>'void' ${unpaid_only ? "AND coalesce(balance_due,0)>0 AND status<>'draft'" : ''} ${terms.length ? `AND ${terms.map((_, i) => `lower(coalesce(invoice_number,'')||' '||coalesce(customer_name,'')||' '||coalesce(unit_number,'')) LIKE $${i + 1}`).join(' AND ')}` : ''}
        ORDER BY invoice_date DESC NULLS LAST, id DESC LIMIT 15`, terms.map(t => `%${t}%`));
      const rows = r.rows.map(i => ({ invoice: i.invoice_number, customer: i.customer_name, unit: i.unit_number, status: i.status, date: day(i.invoice_date), due: day(i.due_date), total: num(i.total), balance: num(i.balance_due) }));
      return { count: rows.length, totalBalance: Math.round(rows.reduce((a, x) => a + x.balance, 0) * 100) / 100, invoices: rows };
    },

    async cores_owed({ query = '' }) {
      if (!who.manager) return denied;
      const terms = likeTerms(query);
      const r = await db.query(`SELECT c.vendor_name_snapshot vendor,p.part_number,p.description,c.open_quantity,c.unit_core_charge,c.due_date,c.purchase_reference FROM part_core_obligations c JOIN fullbay_import_parts p ON p.id=c.part_id
        WHERE c.status NOT IN ('closed','credited') AND c.open_quantity>0 ${terms.length ? `AND ${terms.map((_, i) => `lower(coalesce(c.vendor_name_snapshot,'')||' '||coalesce(p.part_number,'')||' '||coalesce(p.description,'')) LIKE $${i + 1}`).join(' AND ')}` : ''} ORDER BY c.due_date NULLS LAST LIMIT 20`, terms.map(t => `%${t}%`));
      const rows = r.rows.map(x => ({ vendor: x.vendor, partNumber: x.part_number, description: clip(x.description, 80), owed: num(x.open_quantity), value: Math.round(num(x.open_quantity) * num(x.unit_core_charge) * 100) / 100, due: day(x.due_date), reference: x.purchase_reference || '' }));
      return { coresOwed: rows.reduce((a, x) => a + x.owed, 0), value: Math.round(rows.reduce((a, x) => a + x.value, 0) * 100) / 100, items: rows };
    },

    async workshop_manuals({ unit_id, topic }) {
      if (!findManuals) return { note: 'No workshop manual library is configured.' };
      const u = unit_id ? (await db.query('SELECT * FROM customer_units WHERE id::text=$1', [String(unit_id)])).rows[0] : null;
      const m = await findManuals(u, String(topic || ''));
      return { manuals: (m || []).slice(0, 5).map(x => ({ title: x.title, category: x.category, source: x.source_name, vehicle: [x.year_from, x.year_to, x.make, x.model, x.engine].filter(Boolean).join(' ') })) };
    },
  };
}

export function assistantSystemPrompt(who, today) {
  return `You are the ITTR Workshop AI for Iron Team Truck & Trailer Repair, a heavy-duty truck and trailer repair shop. Today is ${today}. You are talking to ${who.username || 'a user'} (role: ${who.role || 'user'}).
LANGUAGE: Always reply in the language the user writes in (Ukrainian, Russian or English). Mechanics usually write Ukrainian and may mix in English part names — keep part numbers and part names exactly as in the records.
HOW TO WORK:
- Use the lookup tools to get facts. Never guess a repair, date, mileage, stock quantity, price, part number, torque or spec. If the tools return nothing, say so plainly.
- When a truck is mentioned, call find_truck first, then truck_history (with a keyword when the question is about one system, e.g. "brake", "oil", "PM").
- For stock questions use search_parts and report available = on hand minus reserved, plus shelf location.
- If several trucks or parts match, list them briefly and ask which one.
- Remember the earlier messages in this conversation ("it", "that truck", "the same part").
- For technical procedures you may give general professional guidance, but exact torque values and specs only from a verified manual — otherwise say a manual is needed.
- You cannot change records. If the user asks you to add a part, create or close a work order, tell them exactly where to do it in ShopFlow.
- ${who.manager ? 'This user is a manager: customers, invoices, prices and cores are allowed.' : 'This user is a mechanic: do not reveal prices, invoice totals or customer contact details; if asked, say a manager can see that.'}
STYLE: Short, practical, mechanic-friendly. Lead with the answer. Use short bullets for lists. Mention work order, invoice or service-order numbers and dates so the user can find the record. No filler.`;
}

// chat(messages, tools) -> OpenAI-compatible completion (choices[0].message with optional tool_calls, usage)
export async function runShopAssistant({ question, history = [], who, tools, chat, today, extraContext = '' }) {
  const messages = [{ role: 'system', content: assistantSystemPrompt(who, today) }];
  for (const h of (Array.isArray(history) ? history : []).slice(-8)) {
    const role = h?.role === 'assistant' ? 'assistant' : h?.role === 'user' ? 'user' : null;
    const content = clip(h?.content, 1500);
    if (role && content) messages.push({ role, content });
  }
  messages.push({ role: 'user', content: extraContext ? `${question}\n\n(${extraContext})` : question });
  const toolDefs = ASSISTANT_TOOLS.filter(t => who.manager || !/^MANAGERS ONLY/.test(t.description)).map(t => ({ type: 'function', function: t }));
  const usage = { prompt: 0, completion: 0, rounds: 0 }, used = [];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const res = await chat(messages, round === MAX_ROUNDS ? undefined : toolDefs);
    usage.rounds++; usage.prompt += num(res?.usage?.prompt_tokens); usage.completion += num(res?.usage?.completion_tokens);
    const msg = res?.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return { answer: String(msg.content || '').trim(), usage, used };
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls.slice(0, 6)) {
      const name = call?.function?.name, fn = tools[name];
      let args = {}; try { args = JSON.parse(call?.function?.arguments || '{}') || {}; } catch (_) {}
      let result;
      try { result = fn ? await fn(args) : { error: `Unknown tool ${name}` }; } catch (e) { result = { error: `Lookup failed: ${clip(e?.message, 160)}` }; }
      used.push(name);
      let text = JSON.stringify(result); if (text.length > MAX_TOOL_CHARS) text = `${text.slice(0, MAX_TOOL_CHARS)}…(truncated)`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }
  return { answer: '', usage, used };
}
