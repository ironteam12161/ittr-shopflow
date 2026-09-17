import fs from 'fs';
const h=fs.readFileSync('index.html','utf8'),s=fs.readFileSync('server.js','utf8');
let p=0,f=0;const ck=(n,v)=>{console.log((v?'PASS ':'FAIL ')+n);v?p++:f++};
const scriptEnd=h.lastIndexOf('</script>'),bodyEnd=h.lastIndexOf('</body>');
for(const id of ['invoiceHistoryDetailModal','invoiceHistoryDetailTitle','invoiceHistoryDetailBody','vehicleProfileModal','vehicleProfileBody','woModal','detailModal','detailTitle','serviceOrderModal']){
 const at=h.indexOf(`id="${id}"`); ck(`live DOM contains ${id}`,at>=0 && (id.startsWith('invoiceHistory') ? at>scriptEnd&&at<bodyEnd : true));
}
ck('invoice history opener guarded',h.includes('if(!body||!title||!modal)'));
ck('invoice history uses read-only modal',h.includes('Service history is read-only.'));
ck('invoice history edit goes to original invoice',h.includes('Edit Original Invoice'));
ck('work order open function present',h.includes('function openWorkOrder()'));
ck('work order detail function present',h.includes('function openDetail('));
ck('vehicle profile function present',h.includes('function openVehicleProfile('));
ck('invoice history real schema fix retained',s.includes('i.tax AS tax_amount'));
ck('invoice history all non-void statuses retained',s.includes("WHERE i.status<>'void'"));
ck('barcode indexed alias optimization retained',s.includes('barcode_aliases'));
ck('Samsara integration retained',s.includes('/api/samsara/fleet'));
ck('Fullbay cleanup retained',s.includes('/api/fullbay/history/delete-imported'));
ck('Fullbay $22 guard retained',s.includes('$22')&&!/fullbay_import_parts[\s\S]{0,1200}\$23/.test(s));
console.log(`PRODUCTION READINESS AUDIT ${p}/${p+f} passed`);if(f)process.exit(1);
