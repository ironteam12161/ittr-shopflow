import fs from 'node:fs';

const VERSION='24.28.4';
const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');

// Fresh databases exposed a legacy schema-order defect: Samsara ALTER statements
// for customer_units run before the later CREATE TABLE customer_units statement.
// Existing production databases are unaffected, but CI must prove a new database
// can boot. Create the base table idempotently before the first ALTER.
const samsaraAlter=' ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS samsara_vehicle_id TEXT;';
const earlyMarker='ITTR v24.28.4 early customer_units bootstrap';
if(!s.includes(earlyMarker)){
  const i=s.indexOf(samsaraAlter);
  if(i<0)throw new Error('customer_units Samsara ALTER anchor not found');
  const early=` -- ${earlyMarker}\n CREATE TABLE IF NOT EXISTS customer_units(\n   id BIGSERIAL PRIMARY KEY,\n   customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,\n   customer_name TEXT,\n   unit_number TEXT NOT NULL,\n   vin TEXT,\n   year TEXT,\n   make TEXT,\n   model TEXT,\n   plate TEXT,\n   mileage BIGINT,\n   engine TEXT,\n   transmission TEXT,\n   notes TEXT,\n   source TEXT DEFAULT 'manual',\n   created_at TIMESTAMPTZ DEFAULT now(),\n   updated_at TIMESTAMPTZ DEFAULT now()\n );\n CREATE INDEX IF NOT EXISTS idx_customer_units_unit ON customer_units(lower(unit_number));\n CREATE INDEX IF NOT EXISTS idx_customer_units_customer ON customer_units(customer_id);\n `;
  s=s.slice(0,i)+early+s.slice(i);
}

s=s.replaceAll('24.28.3',VERSION);
fs.writeFileSync(serverPath,s,'utf8');

for(const fp of ['index.html','public/index.html','sw.js','public/sw.js']){
 if(!fs.existsSync(fp))continue;
 fs.writeFileSync(fp,fs.readFileSync(fp,'utf8').replaceAll('24.28.3',VERSION),'utf8');
}

console.log(`ITTR v${VERSION} fresh-database schema-order fix applied`);
