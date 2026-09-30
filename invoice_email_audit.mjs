import assert from 'node:assert/strict';
import fs from 'node:fs';

const server=fs.readFileSync('server.js','utf8');
assert.match(server,/app\.get\('\/api\/invoices\/:id\/email-draft'/,'invoice email review endpoint missing');
assert.match(server,/invoiceEmailHtml\(i,message(,x\.lines)?\)/,'branded HTML invoice email missing');
assert.match(server,/View &amp; Pay Invoice/,'secure payment call-to-action missing');
assert.match(server,/attachments=attachPdf\?/,'optional current invoice PDF attachment missing');
assert.match(server,/CREATE TABLE IF NOT EXISTS invoice_email_deliveries/,'delivery audit schema missing');
assert.match(server,/'Idempotency-Key':idempotencyKey/,'Resend idempotency header missing');
assert.match(server,/invoice_email_failed/,'failed delivery audit event missing');
assert.match(server,/invoice_emailed/,'successful delivery audit event missing');
assert.match(server,/replace\(\/\[\\r\\n\]\+\/g,' '\)/,'email subject must strip header newlines');
assert.match(server,/i\.profile_customer_email/,'saved customer email fallback missing');

const migration=fs.readFileSync('031_invoice_email_delivery.sql','utf8');
const mirroredMigration=fs.readFileSync('database/migrations/031_invoice_email_delivery.sql','utf8');
assert.equal(mirroredMigration,migration,'invoice email migration copies must remain synchronized');
assert.match(migration,/CREATE TABLE IF NOT EXISTS invoice_email_deliveries/);
assert.match(migration,/idempotency_key TEXT UNIQUE NOT NULL/);

const ui=fs.readFileSync('public/index.html','utf8');
const invoiceWorkspaceCss=fs.readFileSync('public/invoice-workspace.css','utf8');
assert.match(ui,/Send invoice/,'invoice email review dialog missing');
assert.match(ui,/Attach invoice PDF/,'invoice attachment control missing');
assert.match(ui,/invEmailSubject/,'editable invoice email subject missing');
assert.match(ui,/invEmailCc/,'invoice CC recipient control missing');
assert.match(ui,/crypto\?\.randomUUID/,'client request id missing');
assert.match(ui,/id="invoiceEmailButton"/,'invoice email launch button needs a stable loading-state target');
assert.match(ui,/Opening email…/,'invoice email launch must provide immediate feedback');
assert.match(invoiceWorkspaceCss,/body\.invoiceWorkspaceMode #invoiceEmailModal\{z-index:1400!important\}/,'invoice email dialog must render above the full-screen invoice workspace');

console.log('Invoice email audit: review UI, branded payment email, PDF attachment, delivery audit, and idempotency passed');
