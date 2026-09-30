// ITTR ShopFlow v24.39.0 branded, colorful customer email templates (table layout + inline styles for email clients).
export const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => { const n = Number(v || 0); return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
const day = v => { if (!v) return ''; const d = new Date(String(v).length === 10 ? `${v}T12:00:00` : v); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : String(v).slice(0, 10); };

const PALETTE = {
  navy: '#0f172a', navy2: '#1e293b', ink: '#0f172a', muted: '#64748b', line: '#e2e8f0', soft: '#f8fafc', page: '#eef2f7',
  due: { bg: '#fff7ed', border: '#fdba74', ink: '#c2410c', label: 'Amount due' },
  paid: { bg: '#ecfdf3', border: '#86efac', ink: '#047857', label: 'Paid in full' },
  quote: { bg: '#eff6ff', border: '#93c5fd', ink: '#1d4ed8', label: 'Estimated total' }
};

function detailCell(label, value) {
  if (!value) return '';
  return `<td style="padding:10px 12px;vertical-align:top;width:33%"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${PALETTE.muted};font-weight:700">${escHtml(label)}</div><div style="font-size:15px;color:${PALETTE.ink};font-weight:700;margin-top:3px">${escHtml(value)}</div></td>`;
}

// kind: 'invoice' | 'estimate'. doc: invoice/estimate row. lines: document lines. message: the editable note.
export function documentEmailHtml({ kind = 'invoice', doc = {}, lines = [], message = '', shop, logoUrl = '', payUrl = '', payLabel = 'View &amp; Pay Invoice', accent = '#c2410c' }) {
  const isEst = kind === 'estimate', number = doc.invoice_number || doc.estimate_number || '';
  const balance = Number(doc.balance_due ?? doc.total ?? 0), total = Number(doc.total || 0);
  const tone = isEst ? PALETTE.quote : balance > 0.004 ? PALETTE.due : PALETTE.paid;
  const bigAmount = isEst ? total : balance > 0.004 ? balance : total;
  const subLine = isEst ? (doc.valid_until ? `Valid until ${day(doc.valid_until)}` : 'Quote for approval')
    : balance > 0.004 ? `Due ${doc.due_date ? day(doc.due_date) : 'on receipt'}` : 'Thank you — no balance due';
  const labors = lines.filter(l => l.line_type === 'labor');
  const jobRows = (labors.length ? labors : lines.filter(l => l.line_type !== 'part').slice(0, 8)).slice(0, 12).map((l, i) => {
    const kids = lines.filter(k => k.line_type !== 'labor' && String(k.parent_line_id || '') === String(l.id));
    const sum = Number(l.line_total || 0) + kids.reduce((a, k) => a + Number(k.line_total || 0), 0);
    const parts = kids.filter(k => k.line_type === 'part').length;
    return `<tr><td style="padding:10px 0;border-bottom:1px solid ${PALETTE.line};vertical-align:top;width:34px"><div style="width:24px;height:24px;border-radius:7px;background:${accent};color:#fff;font-size:12px;font-weight:800;text-align:center;line-height:24px">${i + 1}</div></td>
      <td style="padding:10px 8px;border-bottom:1px solid ${PALETTE.line};font-size:14px;color:${PALETTE.ink}"><b>${escHtml(l.description || l.job_name || 'Service')}</b>${parts ? `<div style="font-size:12px;color:${PALETTE.muted};margin-top:2px">${parts} part${parts === 1 ? '' : 's'} included</div>` : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${PALETTE.line};font-size:14px;color:${PALETTE.ink};text-align:right;white-space:nowrap;font-weight:700">${money(sum)}</td></tr>`;
  }).join('');
  const totals = [['Subtotal', Number(doc.subtotal || 0)], Number(doc.tax || 0) ? ['Tax', Number(doc.tax)] : null, ['Total', total],
    !isEst && Number(doc.amount_paid || 0) ? ['Paid', -Number(doc.amount_paid)] : null].filter(Boolean)
    .map(([k, v], i, a) => `<tr><td style="padding:4px 0;font-size:${i === a.length - 1 ? 15 : 13}px;color:${i === a.length - 1 ? PALETTE.ink : PALETTE.muted};${i === a.length - 1 ? 'font-weight:800' : ''}">${k}</td><td style="padding:4px 0;text-align:right;font-size:${i === a.length - 1 ? 15 : 13}px;color:${PALETTE.ink};font-weight:${i === a.length - 1 ? 800 : 600}">${money(v)}</td></tr>`).join('');
  const button = (href, label, bg, fg = '#fff', border = bg) => `<a href="${escHtml(href)}" style="display:inline-block;background:${bg};color:${fg};border:2px solid ${border};padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;margin:4px 6px 4px 0">${label}</a>`;
  const ctas = [
    payUrl && !isEst && balance > 0.004 ? button(payUrl, payLabel, accent) : '',
    shop.phone ? button(`tel:${String(shop.phone).replace(/[^\d+]/g, '')}`, `Call ${escHtml(shop.phone)}`, '#ffffff', PALETTE.ink, PALETTE.line) : ''
  ].join('');
  const preheader = isEst ? `Estimate ${number} — ${money(total)}` : balance > 0.004 ? `Invoice ${number} — ${money(balance)} due` : `Invoice ${number} — paid in full`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escHtml(preheader)}</title></head>
<body style="margin:0;padding:0;background:${PALETTE.page};font-family:Arial,Helvetica,sans-serif;color:${PALETTE.ink}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.page};padding:26px 10px"><tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.10)">
 <tr><td bgcolor="${PALETTE.navy}" style="background:${PALETTE.navy};background-image:linear-gradient(135deg,${PALETTE.navy} 0%,${PALETTE.navy2} 60%,#334155 100%);padding:22px 26px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
   <td style="vertical-align:middle">${logoUrl ? `<img src="${escHtml(logoUrl)}" alt="" height="48" style="vertical-align:middle;margin-right:12px;border-radius:8px">` : ''}<span style="vertical-align:middle;display:inline-block"><span style="display:block;color:#fff;font-size:19px;font-weight:800">${escHtml(shop.name)}</span><span style="display:block;color:#cbd5e1;font-size:12px;margin-top:2px">${escHtml(shop.tagline || '')}</span></span></td>
   <td align="right" style="vertical-align:middle"><span style="display:inline-block;background:${accent};color:#fff;font-weight:800;font-size:12px;letter-spacing:.08em;padding:7px 12px;border-radius:999px">${isEst ? 'ESTIMATE' : 'INVOICE'} ${escHtml(number)}</span></td>
  </tr></table></td></tr>
 <tr><td style="height:5px;background:${accent};background-image:linear-gradient(90deg,${accent},#f59e0b,#16a34a)"></td></tr>
 <tr><td style="padding:26px 26px 6px;font-size:15px;line-height:1.6;color:#1f2937">${escHtml(message).replace(/\n/g, '<br>')}</td></tr>
 <tr><td style="padding:14px 26px 6px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${tone.bg};border:2px solid ${tone.border};border-radius:14px"><tr>
   <td style="padding:18px 20px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${tone.ink};font-weight:800">${tone.label}</div><div style="font-size:34px;line-height:1.1;font-weight:800;color:${tone.ink};margin-top:4px">${money(bigAmount)}</div><div style="font-size:13px;color:${PALETTE.muted};margin-top:4px">${escHtml(subLine)}</div></td>
   <td align="right" style="padding:18px 20px">${ctas ? '' : ''}${doc.unit_number ? `<div style="font-size:12px;color:${PALETTE.muted};font-weight:700;text-transform:uppercase;letter-spacing:.06em">Unit</div><div style="font-size:22px;font-weight:800;color:${PALETTE.ink}">${escHtml(doc.unit_number)}</div>` : ''}</td>
  </tr></table></td></tr>
 ${ctas ? `<tr><td style="padding:12px 26px 4px">${ctas}</td></tr>` : ''}
 <tr><td style="padding:14px 18px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.soft};border-radius:12px"><tr>
  ${detailCell(isEst ? 'Estimate date' : 'Invoice date', day(doc.invoice_date || doc.estimate_date))}${detailCell('Customer', doc.customer_name)}${detailCell(doc.po_number ? 'PO number' : 'VIN', doc.po_number || doc.vin)}
 </tr></table></td></tr>
 ${jobRows ? `<tr><td style="padding:20px 26px 0"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.muted};font-weight:800;margin-bottom:4px">${isEst ? 'Work quoted' : 'Work performed'}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${jobRows}</table>
  <table role="presentation" width="260" align="right" cellpadding="0" cellspacing="0" style="margin-top:10px">${totals}</table></td></tr>` : ''}
 <tr><td style="padding:22px 26px 6px;font-size:13px;color:${PALETTE.muted}">📎 The full ${isEst ? 'estimate' : 'invoice'} is attached as a PDF. Questions? Just reply to this email${shop.phone ? ` or call <b style="color:${PALETTE.ink}">${escHtml(shop.phone)}</b>` : ''}.</td></tr>
 <tr><td style="padding:16px 26px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px"><tr><td style="padding:10px 12px;font-size:12px;color:#92400e">🛞 <b>Safety reminder:</b> after tire or wheel service, re-torque wheel nuts after the first 50 miles.</td></tr></table></td></tr>
 <tr><td bgcolor="${PALETTE.navy}" style="background:${PALETTE.navy};padding:18px 26px;color:#cbd5e1;font-size:12px;line-height:1.6">
  <b style="color:#fff;font-size:13px">${escHtml(shop.name)}</b><br>${escHtml([shop.address1, shop.address2].filter(Boolean).join(', '))}<br>${[shop.phone, shop.email, shop.website].filter(Boolean).map(escHtml).join(' &nbsp;·&nbsp; ')}
 </td></tr>
</table>
<div style="font-size:11px;color:${PALETTE.muted};margin-top:12px">Thank you for choosing ${escHtml(shop.name)}.</div>
</td></tr></table></body></html>`;
}

// Internal digest (e.g. fleet PM / CARB reminders) sent to the shop.
export function alertEmailHtml({ title, intro = '', rows = [], shop, appUrl = '', accent = '#c2410c' }) {
  const color = s => s === 'overdue' ? ['#fef2f2', '#b91c1c', 'OVERDUE'] : ['#fffbeb', '#b45309', 'DUE SOON'];
  return `<!doctype html><html><body style="margin:0;background:${PALETTE.page};font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:22px 10px"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border-radius:14px;overflow:hidden">
 <tr><td bgcolor="${PALETTE.navy}" style="background:${PALETTE.navy};padding:18px 22px;color:#fff;font-size:18px;font-weight:800">${escHtml(title)}<div style="font-size:12px;color:#cbd5e1;font-weight:400;margin-top:3px">${escHtml(shop.name)}</div></td></tr>
 <tr><td style="height:4px;background:${accent}"></td></tr>
 <tr><td style="padding:18px 22px 6px;font-size:14px;color:#1f2937">${escHtml(intro)}</td></tr>
 <tr><td style="padding:6px 22px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(r => { const [bg, fg, lbl] = color(r.status); return `<tr><td style="padding:10px 0;border-bottom:1px solid ${PALETTE.line}"><span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px">${lbl}</span> <b style="font-size:14px;color:${PALETTE.ink}">${escHtml(r.unit)}</b> <span style="font-size:14px;color:${PALETTE.ink}">— ${escHtml(r.service)}</span><div style="font-size:12px;color:${PALETTE.muted};margin-top:3px">${escHtml(r.detail)}</div></td></tr>`; }).join('')}</table></td></tr>
 ${appUrl ? `<tr><td style="padding:0 22px 22px"><a href="${escHtml(appUrl)}" style="display:inline-block;background:${accent};color:#fff;padding:11px 18px;border-radius:9px;text-decoration:none;font-weight:800">Open fleet maintenance</a></td></tr>` : ''}
</table></td></tr></table></body></html>`;
}

export async function sendResendEmail({ to, cc, subject, html, text, attachments = [], replyTo, idempotencyKey, tags }) {
  const key = String(process.env.RESEND_API_KEY || '').trim(), from = String(process.env.INVOICE_FROM_EMAIL || '').trim();
  if (!key || !from) return { ok: false, error: 'Email is not configured (RESEND_API_KEY / INVOICE_FROM_EMAIL).' };
  const r = await fetch(String(process.env.RESEND_API_URL || 'https://api.resend.com/emails'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: JSON.stringify({ from, to, cc: cc?.length ? cc : undefined, reply_to: replyTo || undefined, subject, html, text, attachments, tags })
  });
  const d = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: d.id } : { ok: false, status: r.status, error: String(d?.message || `Email failed (${r.status})`).slice(0, 400) };
}
