import fs from 'node:fs';

const file='server.js';
if(!fs.existsSync(file))throw new Error('server.js missing');
let s=fs.readFileSync(file,'utf8');
const marker=' -- ITTR_INVENTORY_POSTING_SCHEMA_V1';
const anchor=' CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_parent ON customer_invoice_lines(invoice_id,parent_line_id,sort_order,id);';
const schema=` -- ITTR_INVENTORY_POSTING_SCHEMA_V1
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS inventory_part_id BIGINT;
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS stock_posted_qty NUMERIC NOT NULL DEFAULT 0;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS stock_posted_at TIMESTAMPTZ;
 CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_inventory_part ON customer_invoice_lines(inventory_part_id) WHERE inventory_part_id IS NOT NULL;
 DO $backfill$
 BEGIN
   IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_key='v285_invoice_inventory_backfill') THEN
     UPDATE customer_invoice_lines
       SET inventory_part_id=NULLIF(metadata->>'inventoryPartId','')::bigint
       WHERE inventory_part_id IS NULL AND coalesce(metadata->>'inventoryPartId','') ~ '^[0-9]+$';
     UPDATE customer_invoice_lines
       SET stock_posted_qty=quantity
       WHERE inventory_part_id IS NOT NULL;
     UPDATE customer_invoices i
       SET stock_posted_at=coalesce(i.finalized_at,i.sent_at,i.updated_at,now())
       WHERE i.status IN ('sent','partial','paid')
         AND EXISTS(SELECT 1 FROM customer_invoice_lines l WHERE l.invoice_id=i.id AND l.inventory_part_id IS NOT NULL);
     INSERT INTO schema_migrations(migration_key) VALUES('v285_invoice_inventory_backfill') ON CONFLICT DO NOTHING;
   END IF;
 END $backfill$;
 DO $ittr$
 DECLARE c record;
 BEGIN
   FOR c IN
     SELECT conname FROM pg_constraint
     WHERE conrelid='part_inventory_transactions'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) ILIKE '%transaction_type%'
   LOOP
     EXECUTE format('ALTER TABLE part_inventory_transactions DROP CONSTRAINT %I',c.conname);
   END LOOP;
 END $ittr$;
`;

const start=s.indexOf(marker);
if(start<0)throw new Error('v285 inventory schema marker missing');
const lastAnchor=s.lastIndexOf(anchor);
if(lastAnchor<=start)throw new Error('v285 invoice schema anchor missing after marker');
const prefix=s.slice(0,start);
const suffix=s.slice(lastAnchor+anchor.length);
const normalized=prefix+schema+anchor+suffix;
if(normalized!==s){
 s=normalized;
 fs.writeFileSync(file,s,'utf8');
 console.log('ITTR v286 normalized v285 inventory schema insertion safely');
}else{
 console.log('ITTR v286 inventory schema insertion already normalized');
}
