// ITTR customer document PDF (invoice now, estimate later) — one renderer, saved data only.
// Clean layout: brand header with logo + shop address, customer / document / vehicle cards,
// jobs with their parts underneath, totals card with a highlighted balance, pay-online link,
// warranty + safety notices and signature line. Pagination tracks a single `y` cursor.

export const LEGAL_NOTICE = "Any warranties on the parts and accessories sold hereby are made by the manufacturer. You understand and agree that we make no warranties of any kind unless expressed in writing. You hereby authorize us to perform the repair work herein set forth and to purchase the necessary material and parts to perform such repair work. You agree that we are not responsible for loss or damage to your vehicle or articles left in your vehicle in case of fire, theft, or any other cause beyond our control or for any delays caused by unavailability of parts or delays in part shipments by the supplier or transporter. In addition, you agree that we are not responsible for damages to your vehicle from freezing due to lack of antifreeze. You hereby grant our employees permission to operate your vehicle on streets, highways, or elsewhere for the purpose of testing and/or inspection. You acknowledge and agree that an express mechanic's lien on your vehicle is granted to secure payment of this invoice for the repair work detailed in this invoice.";
export const TIRE_NOTICE = "After tires or wheels are replaced or serviced, you must stop and recheck wheel nut torque after 50 miles of driving to ensure proper installation and safety. Failure to comply with this requirement releases Iron Team Truck & Trailer Repair from liability for tire or wheel loss or resulting damage.";

export function shopProfile(env = process.env) {
  return {
    name: String(env.SHOP_NAME || 'Iron Team Truck & Trailer Repair'),
    tagline: String(env.SHOP_TAGLINE || 'Heavy-Duty Truck & Trailer Service'),
    address1: String(env.SHOP_ADDRESS1 || '12161 S Central Ave'),
    address2: String(env.SHOP_ADDRESS2 || 'Alsip, IL 60803'),
    phone: String(env.SHOP_PHONE || '(847) 636-0852'),
    email: String(env.SHOP_EMAIL || 'contact@ironttr.com').replace(/^.*<([^>]+)>.*$/, '$1'),
    website: String(env.SHOP_WEBSITE || ''),
    payInstructions: String(env.SHOP_PAY_INSTRUCTIONS || ''),
  };
}

const INK = '#0f172a', MUTED = '#64748b', LINE = '#e2e8f0', SOFT = '#f8fafc', ACCENT = String(process.env.SHOP_ACCENT_COLOR || '#c2410c'), NAVY = '#1e293b';
const money = v => { const n = Number(v || 0); return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
const qtyText = v => { const n = Number(v || 0); return Number.isInteger(n) ? String(n) : n.toFixed(2); };

export async function renderCustomerDocumentPdf({ PDFDocument, kind = 'INVOICE', invoice: i, lines = [], payments = [], shop, logoPath, text = s => String(s ?? ''), dateText = d => String(d || '') }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36, bufferPages: true, info: { Title: `${kind === 'ESTIMATE' ? 'Estimate' : 'Invoice'} ${i.invoice_number || i.estimate_number || ''}` } });
  const chunks = []; doc.on('data', c => chunks.push(c)); const done = new Promise(r => doc.on('end', r));
  const L = 36, R = doc.page.width - 36, W = R - L, BOTTOM = doc.page.height - 54;
  let y = 36;
  const t = (s, x, yy, o = {}) => doc.text(String(s ?? ''), x, yy, { lineBreak: o.lineBreak !== false, ...o });
  const box = (x, yy, w, h, fill, stroke = LINE, r = 6) => { doc.save(); doc.roundedRect(x, yy, w, h, r); if (fill && stroke) doc.fillAndStroke(fill, stroke); else if (fill) doc.fill(fill); else doc.strokeColor(stroke).lineWidth(0.7).stroke(); doc.restore(); };
  const hline = (yy, x1 = L, x2 = R, c = LINE) => doc.save().moveTo(x1, yy).lineTo(x2, yy).strokeColor(c).lineWidth(0.6).stroke().restore();
  const newPage = () => { doc.addPage(); y = 36; tableHead(); };
  const ensure = h => { if (y + h > BOTTOM) newPage(); };
  const label = (s, x, yy, w) => { doc.font('Helvetica-Bold').fontSize(6.8).fillColor(MUTED); t(String(s).toUpperCase(), x, yy, { width: w, characterSpacing: 0.4 }); };

  // ---------- header
  let logoW = 0;
  try { if (logoPath) { doc.image(logoPath, L, y - 2, { fit: [76, 58] }); logoW = 88; } } catch (_) {}
  doc.font('Helvetica-Bold').fontSize(16.5).fillColor(INK); t(shop.name.toUpperCase(), L + logoW, y + 2, { width: 330 - logoW });
  doc.font('Helvetica').fontSize(8.4).fillColor(MUTED);
  const contact = [shop.address1, shop.address2, [shop.phone, shop.email].filter(Boolean).join('  ·  '), shop.website].filter(Boolean);
  t(shop.tagline, L + logoW, doc.y + 1, { width: 330 - logoW });
  doc.fillColor('#334155'); contact.forEach(c => t(c, L + logoW, doc.y + 1, { width: 330 - logoW }));
  const headBottom = Math.max(doc.y, y + 58);
  // title block
  const title = kind === 'ESTIMATE' ? 'ESTIMATE' : 'INVOICE';
  doc.font('Helvetica-Bold').fontSize(24).fillColor(INK); t(title, R - 200, y, { width: 200, align: 'right', characterSpacing: 2 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT); t(i.invoice_number || i.estimate_number || '', R - 200, y + 30, { width: 200, align: 'right' });
  const status = String(i.status || '').toLowerCase(), bal = Number(i.balance_due ?? i.total ?? 0);
  const pill = kind === 'ESTIMATE' ? (status || 'draft').toUpperCase() : status === 'paid' || (bal <= 0.004 && Number(i.total || 0) > 0) ? 'PAID' : status === 'void' ? 'VOID' : status === 'draft' ? 'DRAFT' : 'PAYMENT DUE';
  const pillColor = pill === 'PAID' ? '#047857' : pill === 'VOID' ? '#991b1b' : pill === 'DRAFT' ? '#475569' : ACCENT;
  doc.font('Helvetica-Bold').fontSize(7.5); const pw = doc.widthOfString(pill) + 16;
  box(R - pw, y + 48, pw, 15, pillColor, null, 7.5); doc.fillColor('#fff'); t(pill, R - pw, y + 52, { width: pw, align: 'center' });
  y = headBottom + 10;
  doc.save().rect(L, y, W, 3).fill(ACCENT).restore(); y += 13;

  // ---------- info cards
  const cardH = 86, gap = 10, c1 = 196, c3 = 156, c2 = W - c1 - c3 - gap * 2;
  const billAddr = [i.billing_address || i.customer_billing_address || i.customer_address, [i.billing_city || i.customer_billing_city || i.customer_city, i.billing_state || i.customer_billing_state || i.customer_state, i.billing_postal_code || i.customer_billing_postal_code || i.customer_postal_code].filter(Boolean).join(', ').replace(/, (\d{5})/, ' $1')].filter(Boolean);
  box(L, y, c1, cardH, SOFT); label(kind === 'ESTIMATE' ? 'Prepared for' : 'Bill to', L + 10, y + 9, c1 - 20);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK); t(text(i.customer_name || 'Customer'), L + 10, y + 21, { width: c1 - 20, height: 28, ellipsis: true });
  doc.font('Helvetica').fontSize(8.2).fillColor('#334155'); let by = doc.y + 1; billAddr.forEach(a => { t(text(a), L + 10, by, { width: c1 - 20, height: 11, ellipsis: true }); by += 11; });
  if (i.customer_dot_number || i.dot_number) { t(`DOT ${i.dot_number || i.customer_dot_number}`, L + 10, by, { width: c1 - 20 }); }
  const x2 = L + c1 + gap; box(x2, y, c2, cardH, SOFT);
  const dRows = kind === 'ESTIMATE'
    ? [['Estimate date', dateText(i.estimate_date || i.created_at)], ['Valid until', dateText(i.valid_until)], ['Prepared by', i.created_by || '']]
    : [['Invoice date', dateText(i.invoice_date || i.created_at)], ['Due date', dateText(i.due_date)], ['Terms', i.terms || 'Due on Receipt'], ['PO number', i.po_number || ''], ['Work order', i.work_order_id ? `#${String(i.work_order_id).replace(/-old-.*/, '')}` : '']];
  let dy = y + 10; for (const [k, v] of dRows.filter(r => r[1])) { label(k, x2 + 10, dy + 1, 64); doc.font('Helvetica').fontSize(8.6).fillColor(INK); t(v, x2 + 70, dy, { width: c2 - 80, align: 'right', height: 11, ellipsis: true }); dy += 14.5; }
  const x3 = x2 + c2 + gap; box(x3, y, c3, cardH, SOFT); label('Vehicle', x3 + 10, y + 9, c3 - 20);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK); t(i.unit_number ? `Unit ${i.unit_number}` : 'Unit —', x3 + 10, y + 21, { width: c3 - 20, height: 14, ellipsis: true });
  doc.font('Helvetica').fontSize(7.8).fillColor('#334155');
  let vy = y + 38; [i.vin ? `VIN ${i.vin}` : '', i.mileage ? `${Number(i.mileage).toLocaleString('en-US')} mi` : ''].filter(Boolean).forEach(v => { t(v, x3 + 10, vy, { width: c3 - 20, height: 11, ellipsis: true }); vy += 12; });
  y += cardH + 16;

  // ---------- jobs table
  const COL = { desc: L + 10, qty: R - 222, rate: R - 150, amt: R - 78 };
  function tableHead() {
    doc.save().rect(L, y, W, 20).fill(NAVY).restore();
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor('#fff');
    t('DESCRIPTION', COL.desc, y + 7, { width: 300 }); t('QTY / HRS', COL.qty, y + 7, { width: 64, align: 'right' }); t('RATE', COL.rate, y + 7, { width: 64, align: 'right' }); t('AMOUNT', COL.amt, y + 7, { width: 68, align: 'right' });
    y += 24;
  }
  tableHead();
  const netOf = l => Number(l.line_total ?? (Number(l.quantity || 0) * Number(l.unit_price || 0)));
  const labors = lines.filter(l => l.line_type === 'labor');
  const used = new Set();
  const childrenOf = (lab, idx) => lines.filter(l => l.line_type !== 'labor' && !used.has(l.id) && (String(l.parent_line_id || '') === String(lab.id) || (!l.parent_line_id && l.job_uid && lab.job_uid && String(l.job_uid) === String(lab.job_uid))));
  let jobNo = 0;
  for (const lab of labors) {
    const kids = childrenOf(lab); kids.forEach(k => used.add(k.id)); used.add(lab.id);
    const name = text(lab.description || lab.job_name || 'Labor');
    doc.font('Helvetica-Bold').fontSize(9.2); const nameH = doc.heightOfString(name, { width: COL.qty - COL.desc - 34 });
    ensure(nameH + 26 + kids.length * 16);
    jobNo++;
    doc.save().rect(L, y - 2, W, nameH + 12).fill('#f1f5f9').restore();
    box(COL.desc, y + 1, 18, 14, ACCENT, null, 3); doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff'); t(String(jobNo), COL.desc, y + 4.5, { width: 18, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9.2).fillColor(INK); t(name, COL.desc + 26, y + 3, { width: COL.qty - COL.desc - 34 });
    doc.font('Helvetica').fontSize(8.6).fillColor('#334155');
    const hrs = Number(lab.quantity || 0);
    t(hrs ? `${hrs.toFixed(2)} hr` : '—', COL.qty, y + 3, { width: 64, align: 'right' });
    t(hrs ? money(lab.unit_price) : '', COL.rate, y + 3, { width: 64, align: 'right' });
    doc.font('Helvetica-Bold').fillColor(INK); t(hrs || netOf(lab) ? money(netOf(lab)) : 'Included', COL.amt, y + 3, { width: 68, align: 'right' });
    y += nameH + 12;
    for (const p of kids) {
      const d = [p.part_number ? `${p.part_number}` : '', text(p.description || '')].filter(Boolean).join(' — ') || 'Item';
      doc.font('Helvetica').fontSize(8.2); const h = Math.max(14, doc.heightOfString(d, { width: COL.qty - COL.desc - 44 }) + 4);
      ensure(h + 2);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.6); t(p.line_type === 'part' ? 'PART' : String(p.line_type || 'ITEM').toUpperCase(), COL.desc + 26, y + 2, { width: 30 });
      doc.fillColor('#334155').font('Helvetica').fontSize(8.2); t(d, COL.desc + 56, y + 1, { width: COL.qty - COL.desc - 64 });
      t(qtyText(p.quantity), COL.qty, y + 1, { width: 64, align: 'right' }); t(money(p.unit_price), COL.rate, y + 1, { width: 64, align: 'right' });
      doc.fillColor(INK); t(money(netOf(p)), COL.amt, y + 1, { width: 68, align: 'right' });
      y += h;
    }
    if (kids.length) { const jt = netOf(lab) + kids.reduce((a, k) => a + netOf(k), 0); ensure(16); doc.font('Helvetica').fontSize(7.6).fillColor(MUTED); t(`Job ${jobNo} total`, COL.rate - 60, y + 2, { width: 124, align: 'right' }); doc.font('Helvetica-Bold').fillColor(INK); t(money(jt), COL.amt, y + 2, { width: 68, align: 'right' }); y += 15; }
    hline(y + 2); y += 8;
  }
  const others = lines.filter(l => !used.has(l.id));
  if (others.length) {
    ensure(40); doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED); t('OTHER ITEMS', COL.desc, y + 2, { width: 200 }); y += 16;
    for (const p of others) {
      const d = [p.part_number || '', text(p.description || '')].filter(Boolean).join(' — ') || 'Item';
      doc.font('Helvetica').fontSize(8.4); const h = Math.max(15, doc.heightOfString(d, { width: COL.qty - COL.desc - 10 }) + 4); ensure(h);
      doc.fillColor('#334155'); t(d, COL.desc, y + 1, { width: COL.qty - COL.desc - 10 }); t(qtyText(p.quantity), COL.qty, y + 1, { width: 64, align: 'right' }); t(money(p.unit_price), COL.rate, y + 1, { width: 64, align: 'right' }); doc.fillColor(INK); t(money(netOf(p)), COL.amt, y + 1, { width: 68, align: 'right' });
      y += h;
    }
    hline(y + 2); y += 8;
  }
  if (!lines.length) { ensure(24); doc.font('Helvetica').fontSize(9).fillColor(MUTED); t('No line items.', COL.desc, y + 4); y += 24; }

  // ---------- totals + notes
  const laborSum = lines.filter(l => l.line_type === 'labor').reduce((a, l) => a + netOf(l), 0);
  const partsSum = lines.filter(l => l.line_type === 'part').reduce((a, l) => a + netOf(l), 0);
  const otherSum = lines.filter(l => !['labor', 'part'].includes(l.line_type)).reduce((a, l) => a + netOf(l), 0);
  const rows = [['Labor', laborSum], ['Parts', partsSum]];
  if (Math.abs(otherSum) > 0.004) rows.push(['Other charges', otherSum]);
  if (Number(i.shop_supplies || 0)) rows.push(['Shop supplies', Number(i.shop_supplies)]);
  if (Number(i.environmental_fee || 0)) rows.push(['Environmental fee', Number(i.environmental_fee)]);
  if (Number(i.discount || 0)) rows.push(['Discount', -Number(i.discount)]);
  rows.push([`Tax${Number(i.tax_rate || 0) ? ` (${Number(i.tax_rate).toFixed(3).replace(/\.?0+$/, '')}%)` : ''}`, Number(i.tax || 0)]);
  const paid = Number(i.amount_paid || 0);
  const totW = 220, totX = R - totW, totH = rows.length * 15 + 32 + (kind === 'ESTIMATE' ? 0 : 48);
  ensure(totH + 10);
  const topY = y + 4;
  box(totX, topY, totW, totH, '#fff');
  let ty = topY + 10;
  for (const [k, v] of rows) { doc.font('Helvetica').fontSize(8.6).fillColor('#334155'); t(k, totX + 12, ty, { width: 110 }); t(money(v), totX + 110, ty, { width: totW - 122, align: 'right' }); ty += 15; }
  hline(ty + 2, totX + 12, R - 12); ty += 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK); t(kind === 'ESTIMATE' ? 'Estimated total' : 'Total', totX + 12, ty, { width: 110 }); t(money(i.total), totX + 110, ty, { width: totW - 122, align: 'right' }); ty += 20;
  if (kind !== 'ESTIMATE') {
    doc.font('Helvetica').fontSize(8.6).fillColor('#334155'); t('Paid', totX + 12, ty, { width: 110 }); t(money(paid), totX + 110, ty, { width: totW - 122, align: 'right' }); ty += 14;
    doc.save().roundedRect(totX + 6, ty, totW - 12, 26, 5).fill(bal > 0.004 ? ACCENT : '#047857').restore();
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#fff'); t(bal > 0.004 ? 'BALANCE DUE' : 'PAID IN FULL', totX + 16, ty + 8, { width: 110 }); t(money(Math.max(0, bal)), totX + 110, ty + 8, { width: totW - 126, align: 'right' });
  }
  // left side: notes + how to pay
  let ny = topY; const nw = W - totW - 16;
  const note = text(i.customer_note || '');
  if (note) { label('Notes', L, ny + 2, nw); doc.font('Helvetica').fontSize(8.4).fillColor('#334155'); t(note, L, ny + 14, { width: nw }); ny = doc.y + 10; }
  if (kind !== 'ESTIMATE' && bal > 0.004) {
    label('How to pay', L, ny + 2, nw); doc.font('Helvetica').fontSize(8.4).fillColor('#334155');
    const ways = [];
    if (i.payment_url) ways.push('Pay online (card or bank transfer) using the secure link:');
    if (shop.payInstructions) ways.push(shop.payInstructions);
    if (!ways.length) ways.push('Please contact the shop to arrange payment.');
    t(ways.join('\n'), L, ny + 14, { width: nw }); ny = doc.y + 2;
    if (i.payment_url) { doc.fillColor(ACCENT).font('Helvetica-Bold'); t(String(i.payment_url), L, ny, { width: nw, link: String(i.payment_url), underline: true }); ny = doc.y; }
  }
  if (payments.length) { ny += 8; label('Payments received', L, ny, nw); ny += 12; doc.font('Helvetica').fontSize(8).fillColor('#334155'); for (const p of payments.slice(0, 6)) { t(`${dateText(p.paid_at)} · ${String(p.method || 'payment').replace(/_/g, ' ')}${p.reference ? ` · ${p.reference}` : ''}`, L, ny, { width: nw - 70 }); t(money(p.amount), L + nw - 70, ny, { width: 70, align: 'right' }); ny += 11; } }
  y = Math.max(topY + totH, ny) + 16;

  // ---------- legal
  doc.font('Helvetica').fontSize(7); const legalH = doc.heightOfString(LEGAL_NOTICE, { width: W - 20, lineGap: 1.2 });
  doc.font('Helvetica-Bold').fontSize(7.1); const tireH = doc.heightOfString(TIRE_NOTICE, { width: W - 44, lineGap: 1.2 });
  const legalBox = legalH + tireH + 88;
  if (y + legalBox > BOTTOM) { doc.addPage(); y = 36; }
  label(kind === 'ESTIMATE' ? 'Authorization & warranty' : 'Warranty & repair authorization', L, y, W); y += 12;
  doc.font('Helvetica').fontSize(7).fillColor('#475569'); t(LEGAL_NOTICE, L, y, { width: W, lineGap: 1.2 }); y = doc.y + 8;
  box(L, y, W, tireH + 22, '#fff7ed', '#fdba74', 5);
  doc.font('Helvetica-Bold').fontSize(7.4).fillColor('#9a3412'); t('⚠  IMPORTANT SAFETY NOTICE', L + 10, y + 6, { width: W - 20 });
  doc.font('Helvetica-Bold').fontSize(7.1).fillColor('#7c2d12'); t(TIRE_NOTICE, L + 22, y + 16, { width: W - 44, lineGap: 1.2 }); y += tireH + 34;
  doc.font('Helvetica').fontSize(8).fillColor('#334155');
  const sw = (W - 24) / 3;
  ['Customer signature', 'Printed name', 'Date'].forEach((s, k) => { const x = L + k * (sw + 12); hline(y + 16, x, x + sw, '#94a3b8'); doc.fontSize(7).fillColor(MUTED); t(s, x, y + 20, { width: sw }); });

  // ---------- footer
  const range = doc.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    doc.switchToPage(range.start + p); doc.page.margins.bottom = 0;
    const fy = doc.page.height - 34; hline(fy - 6);
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    t(`${shop.name} · ${shop.address1}, ${shop.address2}${shop.phone ? ` · ${shop.phone}` : ''}`, L, fy, { width: W * 0.7, lineBreak: false });
    t(`${i.invoice_number || i.estimate_number || ''} · Page ${p + 1} of ${range.count}`, L + W * 0.7, fy, { width: W * 0.3, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return Buffer.concat(chunks);
}
