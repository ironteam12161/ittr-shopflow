import fs from 'node:fs';

// v24.26.2 - print-only compatibility patch.
// Keep this non-fatal and idempotent. It changes CSS only; no HTML or database data.
const fp='public/invoice-workspace.css';
const marker='/* ITTR v24.26.2 clean invoice print */';
const css=`\n${marker}\n@media print{\n  /* Chrome suppresses its URL/date header/footer when the page itself owns the full sheet. */\n  @page{size:letter;margin:0!important}\n  html,body{margin:0!important;padding:0!important;background:#fff!important}\n  #invoiceModal{inset:0!important;margin:0!important;padding:0!important}\n  #invoiceModal .modalbox{box-sizing:border-box!important;width:100%!important;min-height:100vh!important;margin:0!important;padding:.45in!important}\n}\n`;
try{
  if(!fs.existsSync(fp)){
    console.warn('[ITTR startup] invoice print stylesheet missing; clean-print patch skipped');
    process.exit(0);
  }
  const current=fs.readFileSync(fp,'utf8');
  if(current.includes(marker)){
    console.log('[ITTR startup] clean invoice print CSS already present');
    process.exit(0);
  }
  fs.appendFileSync(fp,css,'utf8');
  console.log('[ITTR startup] v24.26.2 clean invoice print CSS applied');
}catch(e){
  console.warn('[ITTR startup] clean invoice print patch skipped safely:',e?.message||e);
}
