import fs from 'fs';

const source=fs.readFileSync('server.js','utf8');
if(source.includes('invoice_customer_text.mjs')&&source.includes('INSPECTION / SAFETY CHECK - INCLUDED')){
  console.log('Invoice PDF source preparation already applied.');
}else{
  await import('./.github/scripts/apply-invoice-pdf-fix.mjs');
}
