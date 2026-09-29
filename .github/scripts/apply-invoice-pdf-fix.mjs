import fs from 'fs';

const file='server.js';
let s=fs.readFileSync(file,'utf8');
function once(oldText,newText,label){
  const i=s.indexOf(oldText);
  if(i<0)throw new Error(`Patch anchor missing: ${label}`);
  if(s.indexOf(oldText,i+1)>=0)console.warn(`Patch anchor appears more than once: ${label}`);
  s=s.slice(0,i)+newText+s.slice(i+oldText.length);
}
function all(oldText,newText,label,min=1){
  const count=s.split(oldText).length-1;
  if(count<min)throw new Error(`Patch anchor missing/short (${count}): ${label}`);
  s=s.split(oldText).join(newText);
  console.log(`${label}: ${count}`);
}

once('import PDFKitDocument from "pdfkit";','import PDFKitDocument from "pdfkit";\nimport {invoiceEnglishText,invoiceDateText} from "./invoice_customer_text.mjs";','invoice helper import');

all("const job=String(t.t||'Repair')","const job=invoiceEnglishText(t.t||'Repair')",'WO to invoice English job titles',2);

once("async function getInvoiceBundle(db,id){const inv=(await db.query(`SELECT i.*,c.dot_number AS customer_dot_number,c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,c.postal_code AS customer_postal_code,c.billing_address AS customer_billing_address,c.billing_city AS customer_billing_city,c.billing_state AS customer_billing_state,c.billing_postal_code AS customer_billing_postal_code,c.email AS profile_customer_email FROM customer_invoices i LEFT JOIN fullbay_import_customers c ON c.id::text=i.customer_id::text WHERE i.id=$1::bigint`,[id])).rows[0];if(!inv)return null;const lines=(await db.query('SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint ORDER BY sort_order,id',[id])).rows;const payments=(await db.query('SELECT * FROM customer_invoice_payments WHERE invoice_id=$1::bigint ORDER BY paid_at,id',[id])).rows;return {invoice:inv,lines,payments}}",
"async function getInvoiceBundle(db,id){const inv=(await db.query(`SELECT i.*,c.dot_number AS customer_dot_number,c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,c.postal_code AS customer_postal_code,c.billing_address AS customer_billing_address,c.billing_city AS customer_billing_city,c.billing_state AS customer_billing_state,c.billing_postal_code AS customer_billing_postal_code,c.email AS profile_customer_email FROM customer_invoices i LEFT JOIN fullbay_import_customers c ON c.id::text=i.customer_id::text WHERE i.id=$1::bigint`,[id])).rows[0];if(!inv)return null;const lines=(await db.query('SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint ORDER BY sort_order,id',[id])).rows.map(l=>({...l,description:invoiceEnglishText(l.description,l.line_type==='part'?'Part / material':'Repair / service'),job_name:invoiceEnglishText(l.job_name||'','Repair / service')}));const payments=(await db.query('SELECT * FROM customer_invoice_payments WHERE invoice_id=$1::bigint ORDER BY paid_at,id',[id])).rows;return {invoice:inv,lines,payments}}",'English invoice API bundle');

once("const i=x.invoice,rawLines=Array.isArray(x.lines)?x.lines:[],lines=rawLines.filter(l=>l.line_type==='labor'||String(l.part_number||'').trim()||String(l.description||'').trim()||Number(l.unit_price||0)!==0||Number(l.quantity||0)!==1);",
"const i=x.invoice,rawLines=Array.isArray(x.lines)?x.lines:[],lines=rawLines.filter(l=>l.line_type==='labor'||String(l.part_number||'').trim()||String(l.description||'').trim()||Number(l.unit_price||0)!==0||Number(l.quantity||0)!==1).map(l=>({...l,description:invoiceEnglishText(l.description,l.line_type==='part'?'Part / material':'Repair / service'),job_name:invoiceEnglishText(l.job_name||'','Repair / service')}));",'PDF English line normalization');

once("['INVOICE DATE',String(i.invoice_date||'').slice(0,10)||'—'],\n   ['DUE DATE',String(i.due_date||'').slice(0,10)||'—'],",
"['INVOICE DATE',invoiceDateText(i.invoice_date)],\n   ['DUE DATE',invoiceDateText(i.due_date)],",'professional invoice dates');

once("   // Strong labor header; internal legacy job/service names are never printed.\n   rect(L,y,W,34,NAVY,null);drawTableGuides(y,34,'#526477');\n   rect(L+9,y+5,25,24,'#ffffff',null);\n   doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9);\n   text(String(index+1),L+9,y+12,{width:25,align:'center'});\n   doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);\n   text('LABOR',L+48,y+11,{width:42});\n   doc.fontSize(9);\n   text(laborDescription,L+91,y+10,{width:205,ellipsis:true});\n   doc.font('Helvetica').fontSize(8.2);\n   text(Number(labor.quantity||0).toFixed(2),L+300,y+11,{width:58,align:'right'});\n   text(money(labor.unit_price),L+363,y+11,{width:76,align:'right'});\n   doc.font('Helvetica-Bold');\n   text(money(laborTotal),L+444,y+11,{width:82,align:'right'});\n   y+=34;",
"   // Clean customer-facing labor row with a restrained accent instead of a heavy dark block.\n   rect(L,y,W,36,'#f8fafc',LINE);\n   doc.save().rect(L,y,4,36).fill(NAVY).restore();drawTableGuides(y,36,'#dbe3ea');\n   rect(L+10,y+7,22,22,NAVY,null);\n   doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);\n   text(String(index+1),L+10,y+13,{width:22,align:'center'});\n   doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5);\n   text('LABOR',L+48,y+12,{width:42});\n   doc.fillColor(INK).fontSize(9);\n   text(laborDescription,L+91,y+10,{width:205,ellipsis:true});\n   doc.font('Helvetica').fontSize(8.2);\n   text(Number(labor.quantity||0).toFixed(2),L+300,y+12,{width:58,align:'right'});\n   text(money(labor.unit_price),L+363,y+12,{width:76,align:'right'});\n   doc.font('Helvetica-Bold');\n   text(money(laborTotal),L+444,y+12,{width:82,align:'right'});\n   y+=36;",'professional labor row');

once("  labors.forEach((labor,index)=>drawLabor(labor,index));\n\n  const orphan=other.filter(r=>!used.has(r.id));",
"  const includedInspections=[];\n  labors.forEach((labor,index)=>{\n   const children=childrenFor(labor,index);\n   const desc=s(labor.description);\n   const included=/^Inspection:/i.test(desc)&&children.length===0&&Number(labor.quantity||0)===0&&Number(labor.unit_price||0)===0&&Number(labor.line_total||0)===0;\n   if(included)includedInspections.push({labor,index});else drawLabor(labor,index);\n  });\n  if(includedInspections.length){\n   const blockH=24+includedInspections.length*17+8;ensure(blockH);\n   rect(L,y,W,23,'#eef4f8',LINE);\n   doc.save().rect(L,y,4,23).fill(NAVY).restore();\n   doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8);\n   text('INSPECTION / SAFETY CHECK - INCLUDED',L+12,y+8,{width:330});\n   doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);\n   text('No additional labor charge',L+355,y+8,{width:160,align:'right'});\n   y+=23;\n   for(const entry of includedInspections){\n    ensure(17);\n    const label=s(entry.labor.description).replace(/^Inspection:\\s*/i,'');\n    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text('•',L+12,y+4,{width:10});\n    doc.fillColor('#334155').font('Helvetica').fontSize(8);\n    text(label,L+25,y+4,{width:W-37});\n    y+=17;\n   }\n   y+=8;\n  }\n\n  const orphan=other.filter(r=>!used.has(r.id));",'compact included inspections');

once("  const customerNote=s(i.customer_note);","  const customerNote=invoiceEnglishText(s(i.customer_note),'');",'English customer note');
once("  const bottomPanelH=Math.max(158,Math.min(240,Math.max(noteTextHeight+48,summaryRows*20+20)));","  const bottomPanelH=customerNote?Math.max(148,Math.min(220,Math.max(noteTextHeight+44,summaryRows*19+18))):Math.max(142,summaryRows*19+16);",'compact totals panel');

once("  const notesW=300,gap2=14,summaryX=L+notesW+gap2,summaryW=W-notesW-gap2,top=y;\n  rect(L,top,notesW,bottomPanelH,'#ffffff',LINE);\n  doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);\n  text('CUSTOMER NOTES',L+10,top+10,{width:notesW-20});\n  if(customerNote){\n   doc.fillColor('#334155').font('Helvetica').fontSize(8);\n   text(customerNote,L+10,top+29,{width:notesW-20,height:bottomPanelH-39,lineGap:2});\n  }\n\n  rect(summaryX,top,summaryW,bottomPanelH,'#ffffff',LINE);",
"  const notesW=customerNote?300:0,gap2=customerNote?14:0,summaryW=customerNote?W-notesW-gap2:228,summaryX=customerNote?L+notesW+gap2:R-summaryW,top=y;\n  if(customerNote){\n   rect(L,top,notesW,bottomPanelH,'#ffffff',LINE);\n   doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);\n   text('CUSTOMER NOTES',L+10,top+10,{width:notesW-20});\n   doc.fillColor('#334155').font('Helvetica').fontSize(8);\n   text(customerNote,L+10,top+29,{width:notesW-20,height:bottomPanelH-39,lineGap:2});\n  }else{\n   doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.2);\n   text('Thank you for your business.',L,top+12,{width:W-summaryW-18});\n   doc.fillColor(MUTED).font('Helvetica').fontSize(8);\n   text('Please contact Iron Team Truck & Trailer Repair with any questions about this invoice.',L,top+31,{width:W-summaryW-18,lineGap:2});\n  }\n\n  rect(summaryX,top,summaryW,bottomPanelH,'#ffffff',LINE);",'remove empty notes box');

once("  const noticeH=Math.max(150,legalH+tireH+82);","  const noticeH=Math.max(132,legalH+tireH+68);",'compact legal section');

once(' const ensure=h=>{if(doc.y+h>735){doc.addPage();doc.y=40;}};\n doc.fillColor("#111").font("Helvetica-Bold").fontSize(20).text("IRON TEAM TRUCK & TRAILER REPAIR",L,36,{width:W,align:"center"});\n doc.fontSize(11).text("TRUCK REPAIR WORK ORDER",L,62,{width:W,align:"center"});\n doc.font("Helvetica").fontSize(8).fillColor("#555").text("Completed work order summary for invoice preparation",L,78,{width:W,align:"center"});\n let y=98;',
' let y=98;\n const ensure=h=>{if(y+h>735){doc.addPage();y=40;doc.y=40;}};\n doc.fillColor("#111").font("Helvetica-Bold").fontSize(20).text("IRON TEAM TRUCK & TRAILER REPAIR",L,36,{width:W,align:"center"});\n doc.fontSize(11).text("TRUCK REPAIR WORK ORDER",L,62,{width:W,align:"center"});\n doc.font("Helvetica").fontSize(8).fillColor("#555").text("Completed work order summary for invoice preparation",L,78,{width:W,align:"center"});','work-order explicit pagination cursor');

once(' box(L,y,W,78);doc.fillColor("#222").font("Helvetica").fontSize(8.5).text(notes,L+6,y+7,{width:W-12,height:66});y+=88;\n field("PRIMARY MECHANIC",mech(w.mechanic),L,y,180);field("HELPER MECHANICS",(Array.isArray(w.helpers)?w.helpers:[]).map(mech).join(", ")||"—",L+180,y,220);field("COMPLETED BY",mech(w.completedBy),L+400,y,144);doc.y=y+36;',
' box(L,y,W,78);doc.fillColor("#222").font("Helvetica").fontSize(8.5).text(notes,L+6,y+7,{width:W-12,height:66});y+=88;\n ensure(36);\n field("PRIMARY MECHANIC",mech(w.mechanic),L,y,180);field("HELPER MECHANICS",(Array.isArray(w.helpers)?w.helpers:[]).map(mech).join(", ")||"—",L+180,y,220);field("COMPLETED BY",mech(w.completedBy),L+400,y,144);y+=36;doc.y=y;','work-order mechanic summary on one page');

fs.writeFileSync(file,s);

const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
if(!pkg.scripts?.check)throw new Error('package check script missing');
if(!pkg.scripts.check.includes('invoice_pdf_audit.mjs')){
  pkg.scripts.check=pkg.scripts.check.replace('node --check inspection_workflow_audit.mjs','node --check inspection_workflow_audit.mjs && node --check invoice_customer_text.mjs && node --check invoice_pdf_audit.mjs').replace('node inspection_workflow_audit.mjs','node inspection_workflow_audit.mjs && node invoice_pdf_audit.mjs');
}
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');

console.log('Applied professional invoice PDF / English customer-output patch.');
