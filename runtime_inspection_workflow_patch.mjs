import fs from 'node:fs';

const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');

// Mechanic self-start: customer/company and real unit number are optional.
// We still require at least one useful identifier (VIN, USDOT, or a typed unit).
// If a real unit number is absent, create an internal identifier so the work order
// and inspection can be persisted without pretending it is the customer's unit #.
const decl='  const b=req.body||{},customer=String(b.customer||"").trim(),unit=String(b.unit||"").trim(),vin=cleanVin(b.vin||""),dotNumber=cleanUsdot(b.dotNumber||""),jobs=Array.isArray(b.jobs)?b.jobs.map(x=>String(x||"").trim()).filter(Boolean):[];';
if(!s.includes('// ITTR_INSPECTION_OPTIONAL_IDENTITY')){
 if(!s.includes(decl))throw new Error('mechanic self-start declaration anchor missing');
 s=s.replace(decl,`${decl}\n  // ITTR_INSPECTION_OPTIONAL_IDENTITY\n  if(!unit){b.unit=vin?\`VIN-\${vin}\`:\`WALKIN-\${Date.now().toString(36).toUpperCase()}-\${crypto.randomBytes(2).toString("hex").toUpperCase()}\`;b.unitGenerated=true}`);
}

const oldValidation='  if(!customer||!unit||!jobs.length||(!vin&&!dotNumber))return res.status(400).json({error:"Customer, unit, at least one job, and VIN or USDOT are required."});';
const newValidation='  if(!jobs.length||(!vin&&!dotNumber&&!unit))return res.status(400).json({error:"At least one job and VIN, USDOT, or unit number are required. Customer/company and unit number may be left blank when VIN or USDOT identifies the walk-in."});';
if(s.includes(oldValidation))s=s.replace(oldValidation,newValidation);
if(!s.includes(newValidation))throw new Error('optional self-start validation was not applied');

const vinValidation='  if(vin&&!vinCoreValid(vin))return res.status(400).json({error:"VIN must be 17 characters and cannot contain I, O, or Q.",code:"VIN_INVALID"});';
const inspectionValidation=`${vinValidation}\n  const inspectionRequired=b.inspectionRequired===true||String(b.inspectionRequired||"").toLowerCase()==="true";\n  const inspectionType=inspectionRequired?String(b.inspectionType||"").trim().toLowerCase():"";\n  const inspectionSubtype=inspectionRequired?String(b.inspectionSubtype||"").trim().toLowerCase():"";\n  if(inspectionRequired&&!(["truck","trailer"].includes(inspectionType)))return res.status(400).json({error:"Choose Truck or Trailer inspection."});\n  if(inspectionRequired&&inspectionType==="trailer"&&!(["dry_van","reefer","conestoga"].includes(inspectionSubtype)))return res.status(400).json({error:"Choose Dry Van, Reefer, or Conestoga trailer inspection."});`;
if(!s.includes('const inspectionRequired=b.inspectionRequired')){
 if(!s.includes(vinValidation))throw new Error('VIN validation anchor missing');
 s=s.replace(vinValidation,inspectionValidation);
}

const oldResolve=`  const customerResolved=await resolveSelfStartCustomer(db,b,req.user);\n  if(!customerResolved.row)throw Object.assign(new Error("Customer could not be resolved."),{status:400});\n  const unitResolved=await resolveSelfStartUnit(db,b,customerResolved.row);\n  if(!unitResolved.row)throw Object.assign(new Error("Unit could not be resolved."),{status:400});\n\n  const customerRow=customerResolved.row,unitRow=unitResolved.row;`;
const newResolve=`  const customerResolved=await resolveSelfStartCustomer(db,b,req.user);\n  const customerRow=customerResolved.row||{id:"",customer_name:"",dot_number:dotNumber||""};\n  const unitResolved=await resolveSelfStartUnit(db,b,customerRow);\n  if(!unitResolved.row)throw Object.assign(new Error("Vehicle could not be resolved."),{status:400});\n  const unitRow=unitResolved.row;`;
if(s.includes(oldResolve))s=s.replace(oldResolve,newResolve);
if(!s.includes('const customerRow=customerResolved.row||{id:"",customer_name:"",dot_number:dotNumber||""};'))throw new Error('optional customer resolution was not applied');

const oldIdentity=`    unit:unitRow.unit_number||unit,\n    customer:customerRow.customer_name||customer,\n    customerId:String(customerRow.id||""),\n    unitRecordId:String(unitRow.id||""),`;
const newIdentity=`    unit:unitRow.unit_number||String(b.unit||unit||""),\n    unitGenerated:Boolean(b.unitGenerated),\n    customer:customerRow.customer_name||customer||"Walk-in / Unknown",\n    customerUnknown:!String(customerRow.customer_name||customer||"").trim(),\n    customerId:String(customerRow.id||""),\n    unitRecordId:String(unitRow.id||""),`;
if(s.includes(oldIdentity))s=s.replace(oldIdentity,newIdentity);
if(!s.includes('unitGenerated:Boolean(b.unitGenerated)'))throw new Error('generated unit marker was not applied');

const workflowAnchor='    createdVia:"mechanic_self_start",outcomeWorkflowVersion:1,';
const workflowWithInspection=`    createdVia:"mechanic_self_start",outcomeWorkflowVersion:1,\n    inspection:inspectionRequired?{required:true,type:inspectionType,subtype:inspectionType==="trailer"?inspectionSubtype:"",status:"Not Started",currentSection:0,results:{},requestedAt:now.toISOString(),requestedBy:req.user.username}:{required:false,type:"",subtype:"",status:"Not Required",currentSection:0,results:{}},`;
if(!s.includes('inspection:inspectionRequired?{required:true')){
 if(!s.includes(workflowAnchor))throw new Error('work-order inspection anchor missing');
 s=s.replace(workflowAnchor,workflowWithInspection);
}
fs.writeFileSync(serverPath,s,'utf8');

// Load the inspection UI as small external assets after the existing app shell.
for(const fp of ['index.html','public/index.html']){
 if(!fs.existsSync(fp))throw new Error(`${fp} missing`);
 let h=fs.readFileSync(fp,'utf8');
 if(!h.includes('inspection-workflow.css')){
  if(!h.includes('</head>'))throw new Error(`${fp}: head close missing`);
  h=h.replace('</head>','<link rel="stylesheet" href="./inspection-workflow.css?v=1">\n</head>');
 }
 if(!h.includes('inspection-workflow.js')){
  if(!h.includes('</body>'))throw new Error(`${fp}: body close missing`);
  h=h.replace('</body>','<script src="./inspection-workflow.js?v=1"></script>\n</body>');
 }
 fs.writeFileSync(fp,h,'utf8');
}

// Make the inspection assets part of the PWA shell and network-first critical code.
for(const fp of ['sw.js','public/sw.js']){
 if(!fs.existsSync(fp))continue;
 let sw=fs.readFileSync(fp,'utf8');
 if(!sw.includes("'/inspection-workflow.js'")){
  const logo="'/assets/iron-team-logo.png'";
  if(!sw.includes(logo))throw new Error(`${fp}: shell asset anchor missing`);
  sw=sw.replace(logo,"'/inspection-workflow.css','/inspection-workflow.js',"+logo);
 }
 if(!sw.includes("u.pathname==='/inspection-workflow.js'")){
  const crit="u.pathname==='/invoice-workspace.css'||u.pathname==='/manifest.webmanifest'";
  if(!sw.includes(crit))throw new Error(`${fp}: critical fetch anchor missing`);
  sw=sw.replace(crit,"u.pathname==='/invoice-workspace.css'||u.pathname==='/inspection-workflow.css'||u.pathname==='/inspection-workflow.js'||u.pathname==='/manifest.webmanifest'");
 }
 fs.writeFileSync(fp,sw,'utf8');
}

console.log('ITTR optional mechanic identity + inspection workflow patch applied');
