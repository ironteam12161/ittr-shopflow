import fs from 'node:fs';

const read=p=>fs.readFileSync(p,'utf8');
const checks=[];
const check=(name,ok)=>checks.push({name,ok:!!ok});
const server=read('server.js');
const root=read('index.html');
const pub=read('public/index.html');
const ui=read('public/inspection-workflow.js');
const css=read('public/inspection-workflow.css');
const sw=read('public/sw.js');

check('root/public shell remains synchronized',root===pub);
check('inspection stylesheet loaded',root.includes('inspection-workflow.css?v=1'));
check('inspection script loaded',root.includes('inspection-workflow.js?v=1'));
check('mechanic self-start no longer requires customer and unit',server.includes('Customer/company and unit number may be left blank'));
check('server creates internal identifier for missing unit',server.includes('ITTR_INSPECTION_OPTIONAL_IDENTITY')&&server.includes('b.unitGenerated=true'));
check('server persists inspection metadata on work order',server.includes('inspection:inspectionRequired?{required:true'));
check('server validates truck/trailer inspection choice',server.includes('Choose Truck or Trailer inspection.'));
check('server validates trailer subtype',server.includes('Choose Dry Van, Reefer, or Conestoga trailer inspection.'));
check('truck checklist shipped',ui.includes("id:'engine'")&&ui.includes("id:'emissions'")&&ui.includes("id:'final'"));
check('trailer checklist shipped',ui.includes("id:'reefer'")&&ui.includes("id:'conestoga'")&&ui.includes('Trailer / Трейлер'));
check('inspection records OK/attention/repair/NA',ui.includes("ok:'✓ OK'")&&ui.includes("attention:'⚠ Attention'")&&ui.includes("repair:'✕ Repair'")&&ui.includes("na:'N/A'"));
check('inspection completion enters work-order history',ui.includes("workOrderHistoryEntry('inspection_completed'"));
check('truck search inspection history decorator present',ui.includes('Inspection History')&&ui.includes('decorateTruckSearch'));
check('tablet inspection CSS present',css.includes('.inspectionStatusGrid')&&css.includes('@media(max-width:760px)'));
check('inspection assets included in PWA shell',sw.includes("'/inspection-workflow.css'")&&sw.includes("'/inspection-workflow.js'"));
check('inspection assets are network-first PWA critical code',sw.includes("u.pathname==='/inspection-workflow.css'")&&sw.includes("u.pathname==='/inspection-workflow.js'"));

const failed=checks.filter(x=>!x.ok);
for(const c of checks)console.log(`${c.ok?'PASS':'FAIL'}  ${c.name}`);
console.log(`\nInspection workflow audit: ${checks.length-failed.length}/${checks.length} passed`);
if(failed.length)process.exit(1);
