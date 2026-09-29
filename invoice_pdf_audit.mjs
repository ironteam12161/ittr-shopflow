import fs from 'fs';
import assert from 'assert/strict';
import {invoiceEnglishText,invoiceDateText,invoiceContainsCyrillic} from './invoice_customer_text.mjs';

const cases=[
  ['Inspection: Steer tires LH/RH — протектор / пошкодження / тиск','Inspection: Steer tires LH/RH — tread / damage / pressure'],
  ['Inspection: Drive axle 1 — колодки / барабани LH/RH','Inspection: Drive axle 1 — brake linings / drums LH/RH'],
  ['Inspection: Steer axle — колодки / барабани або ротори LH/RH — Left side','Inspection: Steer axle — brake linings / drums or rotors LH/RH - Left side'],
  ['Inspection: Drive axle 1 — шини / протектор / тиск','Inspection: Drive axle 1 tires — tread / pressure'],
  ['Inspection: Drive axle 2 — шини / протектор / тиск','Inspection: Drive axle 2 tires — tread / pressure']
];
for(const [source,expected] of cases){
  const got=invoiceEnglishText(source);
  assert.equal(got,expected,`invoice English mismatch for: ${source}`);
  assert.equal(invoiceContainsCyrillic(got),false,`Cyrillic leaked into invoice text: ${got}`);
}
assert.equal(invoiceEnglishText('PM service'),'PM service');
assert.equal(invoiceEnglishText('Заміна масла'),'oil change');
assert.equal(invoiceDateText('2026-09-29'),'Sep 29, 2026');
assert.equal(invoiceDateText('Tue Sep 29 2026 00:00:00 GMT+0000 (UTC)'),'Sep 29, 2026');

const server=fs.readFileSync('server.js','utf8');
const pdfStart=server.indexOf("app.get('/api/invoices/:id/pdf'");
const pdfEnd=server.indexOf('\nconst stripeSecret=',pdfStart);
assert.ok(pdfStart>0&&pdfEnd>pdfStart,'invoice PDF route missing');
const pdf=server.slice(pdfStart,pdfEnd);
assert.ok(pdf.includes('invoiceEnglishText'),'invoice PDF must normalize customer-facing text to English');
assert.ok(pdf.includes('invoiceDateText'),'invoice PDF must use professional English date formatting');
assert.ok(pdf.includes('INSPECTION / SAFETY CHECK'),'invoice PDF should group inspection lines professionally');
assert.ok(!pdf.includes("String(i.invoice_date||'').slice(0,10)"),'legacy truncated invoice date formatting returned');

const woStart=server.indexOf('app.get("/api/work-orders/:id/pdf"');
const woEnd=server.indexOf('app.get("/api/work-orders/:id/task-sessions"',woStart);
assert.ok(woStart>0&&woEnd>woStart,'work-order PDF route missing');
const woPdf=server.slice(woStart,woEnd);
assert.ok(!woPdf.includes('invoiceEnglishText'),'work-order PDF must preserve mechanic language independently from invoice English');

const checklist=fs.readFileSync('public/inspection-checklist.js','utf8');
assert.ok(checklist.includes('Передні шини LH/RH'),'Ukrainian mechanic inspection text must remain available');
assert.ok(checklist.includes('Steer tires LH/RH'),'English inspection source must remain available');
console.log('Invoice PDF audit: English customer invoice + mechanic Ukrainian separation passed');
