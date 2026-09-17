import express from "express";
import http from "http";
import {WebSocketServer,WebSocket} from "ws";
import OpenAI from "openai";
import path from "path";
import multer from "multer";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import bwipjs from "bwip-js";
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,HeadBucketCommand} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import { fileURLToPath } from "url";

dotenv.config();
const {Pool}=pg;
const FMCSA_WEBKEY=String(process.env.FMCSA_WEBKEY||"").trim();
const FMCSA_API_BASE="https://mobile.fmcsa.dot.gov/qc/services";
const fmcsaCache=new Map();
const NHTSA_VPIC_BASE="https://vpic.nhtsa.dot.gov/api/vehicles";
const vinDecodeCache=new Map();
const app=express();
const httpServer=http.createServer(app);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});
const photoUpload=multer({
 storage:multer.memoryStorage(),
 limits:{fileSize:25*1024*1024,files:1},
 fileFilter:(req,file,cb)=>{
   const type=String(file?.mimetype||"").toLowerCase();
   if(type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(String(file?.originalname||"")))return cb(null,true);
   const e=new Error("Only image files are allowed.");e.code="PHOTO_TYPE";cb(e);
 }
});
const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const port=Number(process.env.PORT||3000);
const isProd=process.env.NODE_ENV==="production";

const configuredApiKey=String(process.env.OPENAI_API_KEY||"").trim();
const apiKeyLooksConfigured=Boolean(configuredApiKey && configuredApiKey!=="your_server_side_key" && !configuredApiKey.toLowerCase().includes("replace") && !configuredApiKey.toLowerCase().includes("your_"));
const client=apiKeyLooksConfigured?new OpenAI({apiKey:configuredApiKey}):null;
const configuredOpenRouterKey=String(process.env.OPENROUTER_API_KEY||"").trim();
const openRouterKeyLooksConfigured=Boolean(configuredOpenRouterKey && !configuredOpenRouterKey.toLowerCase().includes("replace") && !configuredOpenRouterKey.toLowerCase().includes("your_"));
const openRouterClient=openRouterKeyLooksConfigured?new OpenAI({apiKey:configuredOpenRouterKey,baseURL:"https://openrouter.ai/api/v1",defaultHeaders:{"HTTP-Referer":String(process.env.APP_PUBLIC_URL||"").trim()||"https://ittr-shopflow.invalid","X-Title":"ITTR ShopFlow"}}):null;
const aiProvider=String(process.env.AI_PROVIDER||"auto").trim().toLowerCase();
const openRouterModel=String(process.env.OPENROUTER_MODEL||"google/gemini-2.5-flash-lite").trim()||"google/gemini-2.5-flash-lite";
const openRouterInvoiceModel=String(process.env.OPENROUTER_INVOICE_MODEL||"google/gemini-2.5-flash-lite").trim()||"google/gemini-2.5-flash-lite";
const openRouterInvoiceFallbackModel=String(process.env.OPENROUTER_INVOICE_FALLBACK_MODEL||"google/gemini-2.5-flash").trim()||"google/gemini-2.5-flash";
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:isProd?{rejectUnauthorized:false}:undefined}):null;

const r2Bucket=String(process.env.R2_BUCKET_NAME||"").trim();
const r2Endpoint=String(process.env.R2_ENDPOINT||"").trim();
const r2AccessKeyId=String(process.env.R2_ACCESS_KEY_ID||"").trim();
const r2SecretAccessKey=String(process.env.R2_SECRET_ACCESS_KEY||"").trim();
const r2Region=String(process.env.R2_REGION||"auto").trim()||"auto";
const r2Configured=Boolean(r2Bucket&&r2Endpoint&&r2AccessKeyId&&r2SecretAccessKey);
const r2=r2Configured?new S3Client({region:r2Region,endpoint:r2Endpoint,credentials:{accessKeyId:r2AccessKeyId,secretAccessKey:r2SecretAccessKey}}):null;
function requireR2(){if(!r2Configured||!r2){const e=new Error("Photo storage is not configured. Check the R2 variables in Railway.");e.code="R2_NOT_CONFIGURED";throw e;}return r2;}
function safeObjectPart(v){return String(v||"").trim().replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,100)||"unknown";}
async function normalizeFindingImage(buffer){
 try{
  const out=await sharp(buffer,{failOn:"none"}).rotate().resize({width:1920,height:1920,fit:"inside",withoutEnlargement:true}).jpeg({quality:82,mozjpeg:true}).toBuffer({resolveWithObject:true});
  if(!out?.data?.length)throw new Error("Image conversion produced an empty file.");
  if(out.data.length>10*1024*1024)throw new Error("Processed photo is still too large.");
  return {buffer:out.data,mime:"image/jpeg",width:Number(out.info?.width||0),height:Number(out.info?.height||0),bytes:out.data.length};
 }catch(err){
  const e=new Error("This phone photo could not be converted. Try taking the picture again or choose JPEG/Most Compatible camera format.");
  e.code="PHOTO_PROCESSING";e.cause=err;throw e;
 }
}
async function putFindingPhoto({buffer,findingId,workOrderId,uploader,originalName="photo.jpg",db=requireDb()}){
 const normalized=await normalizeFindingImage(buffer);
 const photoId=crypto.randomUUID();
 const d=new Date();
 const key=`findings/${safeObjectPart(workOrderId)}/${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${photoId}.jpg`;
 await requireR2().send(new PutObjectCommand({Bucket:r2Bucket,Key:key,Body:normalized.buffer,ContentType:normalized.mime,CacheControl:"private, max-age=3600",Metadata:{finding_id:safeObjectPart(findingId),work_order_id:safeObjectPart(workOrderId),uploader:safeObjectPart(uploader)}}));
 await db.query(`INSERT INTO finding_photos(id,finding_id,work_order_id,uploader_username,r2_key,content_type,size_bytes,width,height,original_name)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[photoId,String(findingId),String(workOrderId),String(uploader||""),key,normalized.mime,normalized.bytes,normalized.width,normalized.height,String(originalName||"photo.jpg").slice(0,255)]);
 return {photoId,width:normalized.width,height:normalized.height,size:normalized.bytes};
}


app.set("trust proxy",1);
app.use(helmet({
 contentSecurityPolicy:false, // Inline legacy UI handlers still require a CSP migration before strict enforcement.
 crossOriginEmbedderPolicy:false
}));
app.use(express.json({limit:"3mb"}));

// ITTR v24.16.1 hardened frontend path:
// Only files inside /public are web-addressable. Server source, SQL, audit files,
// package metadata and deployment files remain outside the static web root.
app.get("/vendor/html5-qrcode.min.js",(req,res)=>res.sendFile(path.join(__dirname,"node_modules","html5-qrcode","html5-qrcode.min.js")));
const publicDir=path.join(__dirname,"public");
const authoritativeIndex=path.join(publicDir,"index.html");
console.log("ITTR public web root:",publicDir);
app.use(express.static(publicDir,{
 index:false,
 dotfiles:"deny",
 fallthrough:true,
 setHeaders:(res,filePath)=>{
  if(filePath.endsWith("index.html") || filePath.includes(`${path.sep}modules${path.sep}`)){
   res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
   res.setHeader("Pragma","no-cache");
   res.setHeader("Expires","0");
  }
 }
}));

const authLimiter=rateLimit({windowMs:15*60*1000,max:100,standardHeaders:true,legacyHeaders:false});
const loginLimiter=rateLimit({
 windowMs:15*60*1000,
 max:10,
 standardHeaders:true,
 legacyHeaders:false,
 skipSuccessfulRequests:true,
 message:{error:"Too many login attempts. Please try again later."}
});
app.use("/api/auth",authLimiter);

function requireDb(){if(!pool){const e=new Error("DATABASE_URL is not configured. Add PostgreSQL to the deployment and set DATABASE_URL.");e.code="DB_NOT_CONFIGURED";throw e;}return pool;}
function hashToken(t){return crypto.createHash("sha256").update(t).digest("hex")}
function cleanUsername(v){return String(v||"").trim().toLowerCase().replace(/[^a-z0-9._-]/g,"").slice(0,64)}
function publicUser(row){return {username:row.username,role:row.role,display:row.display_name||row.username,language:row.language||"en",email:row.email||"",permissions:row.permissions||{}}}

async function initDb(){
 if(!pool){console.warn("ITTR: DATABASE_URL missing. Cloud state/auth unavailable.");return;}
 await pool.query(`
 CREATE TABLE IF NOT EXISTS auth_users(
   id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
   password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','mechanic','manager')),
   permissions JSONB NOT NULL DEFAULT '{}'::jsonb, email TEXT,
   language TEXT DEFAULT 'en', active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
 ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email TEXT;
 DO $$ DECLARE c text; BEGIN SELECT conname INTO c FROM pg_constraint WHERE conrelid='auth_users'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%role%'; IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE auth_users DROP CONSTRAINT %I',c); END IF; EXCEPTION WHEN others THEN NULL; END $$;
 DO $$ BEGIN ALTER TABLE auth_users ADD CONSTRAINT auth_users_role_check CHECK(role IN ('admin','manager','mechanic')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
 CREATE TABLE IF NOT EXISTS workshop_manuals(
   id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, make TEXT, model TEXT, year_from INTEGER, year_to INTEGER, engine TEXT,
   category TEXT DEFAULT 'service_manual', source_name TEXT, source_url TEXT, r2_key TEXT, original_name TEXT, mime_type TEXT,
   size_bytes BIGINT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_workshop_manuals_vehicle ON workshop_manuals(lower(coalesce(make,'')),lower(coalesce(model,'')),year_from,year_to);
 CREATE TABLE IF NOT EXISTS auth_sessions(
   id BIGSERIAL PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id BIGINT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
   expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS app_state(
   state_key TEXT PRIMARY KEY, payload JSONB NOT NULL DEFAULT '{}'::jsonb, version BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ DEFAULT now(), updated_by TEXT
 );
 CREATE TABLE IF NOT EXISTS server_audit(
   id BIGSERIAL PRIMARY KEY, username TEXT, action TEXT NOT NULL, details JSONB, created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS schema_migrations(
   migration_key TEXT PRIMARY KEY,
   applied_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS app_state_history(
   id BIGSERIAL PRIMARY KEY,
   state_key TEXT NOT NULL,
   version BIGINT NOT NULL,
   payload JSONB NOT NULL,
   updated_by TEXT,
   captured_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_app_state_history_key_time
   ON app_state_history(state_key,captured_at DESC);
 CREATE TABLE IF NOT EXISTS fullbay_import_customers(
   id BIGSERIAL PRIMARY KEY,
   source_key TEXT UNIQUE NOT NULL,
   fullbay_id TEXT, customer_name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, city TEXT, state TEXT, postal_code TEXT,
   raw JSONB NOT NULL DEFAULT '{}'::jsonb, source_file TEXT, imported_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_fullbay_customers_name ON fullbay_import_customers(lower(customer_name));
 CREATE TABLE IF NOT EXISTS fullbay_import_parts(
   id BIGSERIAL PRIMARY KEY,
   source_key TEXT UNIQUE NOT NULL,
   fullbay_id TEXT, part_number TEXT, description TEXT, quantity NUMERIC, cost NUMERIC, price NUMERIC, location TEXT, vendor TEXT,
   raw JSONB NOT NULL DEFAULT '{}'::jsonb, source_file TEXT, imported_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_fullbay_parts_number ON fullbay_import_parts(lower(part_number));
 CREATE INDEX IF NOT EXISTS idx_fullbay_parts_description ON fullbay_import_parts(lower(description));
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS internal_barcode TEXT;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS barcode_aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS reorder_point NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS on_order NUMERIC DEFAULT 0;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS inventory_managed BOOLEAN DEFAULT TRUE;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS purchase_taxable BOOLEAN DEFAULT TRUE;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS sell_taxable BOOLEAN DEFAULT TRUE;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS purchase_tax_rate NUMERIC DEFAULT 0;
 CREATE TABLE IF NOT EXISTS parts_vendors(
   id BIGSERIAL PRIMARY KEY, canonical_name TEXT UNIQUE NOT NULL, aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
   website_domain TEXT, phone TEXT, notes TEXT, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE UNIQUE INDEX IF NOT EXISTS idx_fullbay_parts_internal_barcode ON fullbay_import_parts(internal_barcode) WHERE internal_barcode IS NOT NULL;
 CREATE TABLE IF NOT EXISTS part_inventory_transactions(
   id BIGSERIAL PRIMARY KEY, part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT,
   transaction_type TEXT NOT NULL, quantity_delta NUMERIC NOT NULL, quantity_before NUMERIC, quantity_after NUMERIC,
   work_order_id TEXT, task_uid TEXT, task_name TEXT, unit_number TEXT, customer_name TEXT,
   reference TEXT, reason TEXT, username TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
   created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_part_tx_part_time ON part_inventory_transactions(part_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS idx_part_tx_work_order ON part_inventory_transactions(work_order_id);
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS last_purchase_cost NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS previous_purchase_cost NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ;
 CREATE TABLE IF NOT EXISTS parts_vendor_invoices(
   id BIGSERIAL PRIMARY KEY, vendor TEXT, invoice_number TEXT, invoice_date DATE, po_number TEXT,
   subtotal NUMERIC, tax NUMERIC, freight NUMERIC, total NUMERIC, tax_rate NUMERIC DEFAULT 0, tax_included_in_cost BOOLEAN DEFAULT FALSE, source_filename TEXT,
   source_method TEXT DEFAULT 'scan', status TEXT DEFAULT 'draft', raw_extract JSONB NOT NULL DEFAULT '{}'::jsonb,
   created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), received_at TIMESTAMPTZ
 );
 CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_vendor_invoice_unique ON parts_vendor_invoices(lower(coalesce(vendor,'')),lower(coalesce(invoice_number,''))) WHERE invoice_number IS NOT NULL;
 CREATE TABLE IF NOT EXISTS parts_vendor_invoice_lines(
   id BIGSERIAL PRIMARY KEY, invoice_id BIGINT NOT NULL REFERENCES parts_vendor_invoices(id) ON DELETE CASCADE,
   line_no INTEGER, vendor_part_number TEXT, manufacturer TEXT, description TEXT, quantity NUMERIC,
   unit_cost NUMERIC, core_cost NUMERIC DEFAULT 0, line_total NUMERIC, taxable BOOLEAN DEFAULT TRUE, tax_amount NUMERIC DEFAULT 0, matched_part_id BIGINT REFERENCES fullbay_import_parts(id) ON DELETE SET NULL,
   match_status TEXT DEFAULT 'unmatched', received_quantity NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_vendor_invoice_lines_invoice ON parts_vendor_invoice_lines(invoice_id,line_no);
 CREATE TABLE IF NOT EXISTS part_purchase_cost_history(
   id BIGSERIAL PRIMARY KEY, part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT,
   vendor TEXT, invoice_number TEXT, invoice_id BIGINT REFERENCES parts_vendor_invoices(id) ON DELETE SET NULL,
   purchased_at TIMESTAMPTZ DEFAULT now(), quantity NUMERIC NOT NULL, unit_cost NUMERIC NOT NULL, core_cost NUMERIC DEFAULT 0,
   username TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_part_cost_history_part ON part_purchase_cost_history(part_id,purchased_at DESC);

 CREATE TABLE IF NOT EXISTS inventory_count_sessions(
   id BIGSERIAL PRIMARY KEY,
   status TEXT NOT NULL DEFAULT 'open',
   mode TEXT NOT NULL DEFAULT 'shelf',
   notes TEXT,
   started_by TEXT NOT NULL,
   started_at TIMESTAMPTZ DEFAULT now(),
   completed_by TEXT,
   completed_at TIMESTAMPTZ
 );
 CREATE TABLE IF NOT EXISTS inventory_count_lines(
   id BIGSERIAL PRIMARY KEY,
   session_id BIGINT NOT NULL REFERENCES inventory_count_sessions(id) ON DELETE CASCADE,
   part_id BIGINT NOT NULL REFERENCES fullbay_import_parts(id) ON DELETE RESTRICT,
   system_qty NUMERIC NOT NULL DEFAULT 0,
   counted_qty NUMERIC NOT NULL DEFAULT 0,
   last_barcode TEXT,
   counted_by TEXT,
   first_counted_at TIMESTAMPTZ DEFAULT now(),
   updated_at TIMESTAMPTZ DEFAULT now(),
   UNIQUE(session_id,part_id)
 );
 CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_session ON inventory_count_lines(session_id,updated_at DESC);
 ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS tax_rate NUMERIC DEFAULT 0;
 ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS tax_included_in_cost BOOLEAN DEFAULT FALSE;
 ALTER TABLE parts_vendor_invoice_lines ADD COLUMN IF NOT EXISTS taxable BOOLEAN DEFAULT TRUE;
 ALTER TABLE parts_vendor_invoice_lines ADD COLUMN IF NOT EXISTS tax_amount NUMERIC DEFAULT 0;


 CREATE TABLE IF NOT EXISTS customer_invoices(
   id BIGSERIAL PRIMARY KEY, invoice_number TEXT UNIQUE NOT NULL, work_order_id TEXT,
   customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,
   customer_name TEXT NOT NULL, unit_number TEXT, vin TEXT, po_number TEXT,
   status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','partial','paid','void')),
   invoice_date DATE NOT NULL DEFAULT CURRENT_DATE, due_date DATE, terms TEXT,
   labor_taxable BOOLEAN DEFAULT FALSE, parts_taxable BOOLEAN DEFAULT TRUE, tax_rate NUMERIC DEFAULT 0,
   shop_supplies NUMERIC DEFAULT 0, environmental_fee NUMERIC DEFAULT 0, discount NUMERIC DEFAULT 0,
   subtotal NUMERIC DEFAULT 0, taxable_subtotal NUMERIC DEFAULT 0, tax NUMERIC DEFAULT 0, total NUMERIC DEFAULT 0,
   amount_paid NUMERIC DEFAULT 0, balance_due NUMERIC DEFAULT 0,
   customer_note TEXT, internal_note TEXT, finalized_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
   created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_customer_invoices_customer ON customer_invoices(customer_id,invoice_date DESC);
 CREATE INDEX IF NOT EXISTS idx_customer_invoices_status ON customer_invoices(status,due_date);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_invoice_work_order ON customer_invoices(work_order_id) WHERE work_order_id IS NOT NULL AND status<>'void';
 CREATE TABLE IF NOT EXISTS customer_invoice_lines(
   id BIGSERIAL PRIMARY KEY, invoice_id BIGINT NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
   sort_order INTEGER DEFAULT 0, job_uid TEXT, job_name TEXT, line_type TEXT NOT NULL CHECK(line_type IN ('labor','part','fee','sublet','other')),
   description TEXT NOT NULL, part_number TEXT, quantity NUMERIC NOT NULL DEFAULT 1, unit_price NUMERIC NOT NULL DEFAULT 0,
   unit_cost NUMERIC DEFAULT 0, taxable BOOLEAN DEFAULT FALSE, discount NUMERIC DEFAULT 0, discount_type TEXT DEFAULT 'fixed', discount_value NUMERIC DEFAULT 0, line_total NUMERIC DEFAULT 0,
   metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_invoice ON customer_invoice_lines(invoice_id,sort_order,id);
 CREATE TABLE IF NOT EXISTS customer_invoice_payments(
   id BIGSERIAL PRIMARY KEY, invoice_id BIGINT NOT NULL REFERENCES customer_invoices(id) ON DELETE RESTRICT,
   amount NUMERIC NOT NULL CHECK(amount>0), method TEXT, reference TEXT, note TEXT, paid_at TIMESTAMPTZ DEFAULT now(), received_by TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_customer_invoice_payments_invoice ON customer_invoice_payments(invoice_id,paid_at DESC);

 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS mileage NUMERIC;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS unit_id BIGINT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS service_order_id BIGINT;
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS parent_line_id BIGINT;
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'fixed';
 ALTER TABLE customer_invoice_lines ADD COLUMN IF NOT EXISTS discount_value NUMERIC DEFAULT 0;
 UPDATE customer_invoice_lines SET discount_type='fixed', discount_value=coalesce(discount,0) WHERE discount_value IS NULL OR (discount_value=0 AND coalesce(discount,0)<>0);
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS customer_email TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS payment_url TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS dot_number TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'fixed';
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS discount_value NUMERIC DEFAULT 0;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_address TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_city TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_state TEXT;
 ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS billing_postal_code TEXT;
 UPDATE customer_invoices SET discount_type='fixed',discount_value=coalesce(discount,0) WHERE discount_value IS NULL OR (discount_value=0 AND coalesce(discount,0)<>0);
 CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_parent ON customer_invoice_lines(invoice_id,parent_line_id,sort_order,id);
 UPDATE customer_invoice_lines c
 SET parent_line_id=(
   SELECT l.id FROM customer_invoice_lines l
   WHERE l.invoice_id=c.invoice_id AND l.line_type='labor'
     AND (coalesce(l.job_uid,'')=coalesce(c.job_uid,'') OR lower(coalesce(l.job_name,''))=lower(coalesce(c.job_name,'')))
     AND l.sort_order<=c.sort_order
   ORDER BY l.sort_order DESC,l.id DESC LIMIT 1
 )
 WHERE c.line_type<>'labor' AND c.parent_line_id IS NULL
   AND EXISTS(SELECT 1 FROM customer_invoice_lines l WHERE l.invoice_id=c.invoice_id AND l.line_type='labor' AND (coalesce(l.job_uid,'')=coalesce(c.job_uid,'') OR lower(coalesce(l.job_name,''))=lower(coalesce(c.job_name,''))));
 CREATE TABLE IF NOT EXISTS service_orders(
   id BIGSERIAL PRIMARY KEY, service_order_number TEXT UNIQUE NOT NULL, work_order_id TEXT UNIQUE NOT NULL,
   customer_id BIGINT, customer_name TEXT, unit_id BIGINT, unit_number TEXT, vin TEXT, mileage NUMERIC, po_number TEXT,
   status TEXT NOT NULL DEFAULT 'review' CHECK(status IN ('review','invoiced','void')),
   created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS task_time_adjustments(
   id BIGSERIAL PRIMARY KEY, work_order_id TEXT NOT NULL, task_uid TEXT NOT NULL, mechanic_username TEXT NOT NULL,
   adjusted_hours NUMERIC NOT NULL CHECK(adjusted_hours>=0), original_hours NUMERIC NOT NULL DEFAULT 0,
   reason TEXT NOT NULL, adjusted_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_time_adjustments_wo ON task_time_adjustments(work_order_id,task_uid,created_at DESC);
 CREATE TABLE IF NOT EXISTS fullbay_import_log(
   id BIGSERIAL PRIMARY KEY, import_type TEXT NOT NULL, source_file TEXT, rows_received INTEGER DEFAULT 0, rows_imported INTEGER DEFAULT 0, rows_skipped INTEGER DEFAULT 0, username TEXT, created_at TIMESTAMPTZ DEFAULT now()
 );
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS active BOOLEAN;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS created_fullbay TIMESTAMPTZ;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS customer_group TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS secondary_phone TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS dot_number TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS external_id TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS country TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS assigned_shop TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS taxable BOOLEAN;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS tax_exempt_number TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS credit_terms TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS credit_limit NUMERIC;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS billing_contact TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS payment_method TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS default_labor_rate NUMERIC;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS price_level TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS access_method TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS billing_address TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS billing_city TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS billing_state TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS billing_postal_code TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS ext_accounting TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_dba_name TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_mc_number TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_allowed_to_operate TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_out_of_service TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_power_units INTEGER;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_drivers INTEGER;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_snapshot JSONB;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS fmcsa_last_checked TIMESTAMPTZ;

 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS status TEXT;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS uom TEXT;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS allocated NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS min_qty NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS max_qty NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS track_quantity BOOLEAN;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS category TEXT;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS cost_floor NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS inventory_value NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS inventory_balance NUMERIC;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS manufacturer TEXT;
 ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS notes TEXT;
 CREATE INDEX IF NOT EXISTS idx_fullbay_customers_dot ON fullbay_import_customers(dot_number);
 CREATE TABLE IF NOT EXISTS customer_units(
   id BIGSERIAL PRIMARY KEY,
   customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,
   customer_name TEXT,
   unit_number TEXT NOT NULL,
   vin TEXT,
   year TEXT,
   make TEXT,
   model TEXT,
   plate TEXT,
   mileage BIGINT,
   engine TEXT,
   transmission TEXT,
   notes TEXT,
   source TEXT DEFAULT 'manual',
   created_at TIMESTAMPTZ DEFAULT now(),
   updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_customer_units_unit ON customer_units(lower(unit_number));
 CREATE INDEX IF NOT EXISTS idx_customer_units_customer ON customer_units(customer_id);
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_status TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_type TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_subtype TEXT;
 CREATE TABLE IF NOT EXISTS fullbay_service_history(
   id BIGSERIAL PRIMARY KEY,
   source_key TEXT UNIQUE NOT NULL,
   customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,
   customer_name TEXT NOT NULL,
   unit_record_id BIGINT REFERENCES customer_units(id) ON DELETE SET NULL,
   unit_number TEXT, vin TEXT, unit_status TEXT, unit_type TEXT, unit_subtype TEXT,
   service_order TEXT, invoice_number TEXT, po_number TEXT, action_number TEXT,
   action_completed_at TIMESTAMPTZ, lead_tech TEXT, tech TEXT,
   complaint TEXT, actual_correction TEXT, hours NUMERIC, labor_amount NUMERIC, part_amount NUMERIC, total_amount NUMERIC,
   unit_miles BIGINT, component TEXT, system TEXT, raw JSONB NOT NULL DEFAULT '{}'::jsonb,
   source_file TEXT, imported_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_fullbay_service_customer ON fullbay_service_history(customer_id,action_completed_at DESC);
 CREATE INDEX IF NOT EXISTS idx_fullbay_service_unit ON fullbay_service_history(lower(unit_number),action_completed_at DESC);
 CREATE INDEX IF NOT EXISTS idx_fullbay_service_vin ON fullbay_service_history(lower(vin));
 CREATE INDEX IF NOT EXISTS idx_fullbay_service_so ON fullbay_service_history(service_order);
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS service_writer TEXT;
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS invoiced BOOLEAN;
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS service_status TEXT;
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS parts_status TEXT;
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS unit_return TEXT;
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS notes_count INTEGER;
 ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS severity TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS fullbay_unit_id TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS fleet_number TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS license_plate_state TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS access_method TEXT;
 ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS track_pm BOOLEAN;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_units_fullbay_unit_id ON customer_units(fullbay_unit_id) WHERE fullbay_unit_id IS NOT NULL;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS notes TEXT;
 ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS contact_name TEXT;

 CREATE INDEX IF NOT EXISTS idx_fullbay_parts_manufacturer ON fullbay_import_parts(lower(manufacturer));
 CREATE TABLE IF NOT EXISTS task_time_sessions(
   id BIGSERIAL PRIMARY KEY,
   work_order_id TEXT NOT NULL,
   task_index INTEGER NOT NULL,
   task_uid TEXT,
   task_name TEXT,
   mechanic_username TEXT NOT NULL,
   started_at TIMESTAMPTZ NOT NULL,
   ended_at TIMESTAMPTZ,
   end_reason TEXT,
   pause_reason TEXT,
   pause_note TEXT,
   created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS idx_task_sessions_workorder
   ON task_time_sessions(work_order_id,task_index,started_at DESC);
 CREATE INDEX IF NOT EXISTS idx_task_sessions_mechanic
   ON task_time_sessions(mechanic_username,started_at DESC);
 CREATE TABLE IF NOT EXISTS data_exports(
   id BIGSERIAL PRIMARY KEY,
   created_by TEXT,
   created_at TIMESTAMPTZ DEFAULT now(),
   note TEXT
 );
 CREATE TABLE IF NOT EXISTS finding_photos(
   id TEXT PRIMARY KEY,
   finding_id TEXT NOT NULL,
   work_order_id TEXT NOT NULL,
   uploader_username TEXT NOT NULL,
   r2_key TEXT UNIQUE NOT NULL,
   content_type TEXT NOT NULL DEFAULT 'image/jpeg',
   size_bytes BIGINT NOT NULL DEFAULT 0,
   width INTEGER NOT NULL DEFAULT 0,
   height INTEGER NOT NULL DEFAULT 0,
   original_name TEXT,
   created_at TIMESTAMPTZ DEFAULT now(),
   deleted_at TIMESTAMPTZ
 );
 CREATE INDEX IF NOT EXISTS idx_finding_photos_finding ON finding_photos(finding_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_finding_photos_workorder ON finding_photos(work_order_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_finding_photos_uploader ON finding_photos(uploader_username,created_at);
 `);

 // v23.8.3 CRM schema hardening: CREATE TABLE IF NOT EXISTS does not repair
 // an older table that already exists with missing columns. Add each CRM column
 // independently so upgrades from experimental/older deployments remain safe.
 await pool.query(`
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS customer_id BIGINT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS customer_name TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_number TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS vin TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS year TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS make TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS model TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS plate TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS mileage BIGINT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS engine TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS transmission TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS notes TEXT;
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
   ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
 `);
 await pool.query("CREATE INDEX IF NOT EXISTS idx_customer_units_unit ON customer_units(lower(unit_number))");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_customer_units_customer ON customer_units(customer_id)");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_status TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_type TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS unit_subtype TEXT");
 await pool.query(`CREATE TABLE IF NOT EXISTS fullbay_service_history(
   id BIGSERIAL PRIMARY KEY,source_key TEXT UNIQUE NOT NULL,customer_id BIGINT REFERENCES fullbay_import_customers(id) ON DELETE SET NULL,customer_name TEXT NOT NULL,unit_record_id BIGINT REFERENCES customer_units(id) ON DELETE SET NULL,unit_number TEXT,vin TEXT,unit_status TEXT,unit_type TEXT,unit_subtype TEXT,service_order TEXT,invoice_number TEXT,po_number TEXT,action_number TEXT,action_completed_at TIMESTAMPTZ,lead_tech TEXT,tech TEXT,complaint TEXT,actual_correction TEXT,hours NUMERIC,labor_amount NUMERIC,part_amount NUMERIC,total_amount NUMERIC,unit_miles BIGINT,component TEXT,system TEXT,raw JSONB NOT NULL DEFAULT '{}'::jsonb,source_file TEXT,imported_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())`);
 await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_service_customer ON fullbay_service_history(customer_id,action_completed_at DESC)");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_service_unit ON fullbay_service_history(lower(unit_number),action_completed_at DESC)");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_service_vin ON fullbay_service_history(lower(vin))");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_service_so ON fullbay_service_history(service_order)");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS service_writer TEXT");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS invoiced BOOLEAN");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS service_status TEXT");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS parts_status TEXT");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS unit_return TEXT");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS notes_count INTEGER");
 await pool.query("ALTER TABLE fullbay_service_history ADD COLUMN IF NOT EXISTS severity TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS fullbay_unit_id TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS fleet_number TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS license_plate_state TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS access_method TEXT");
 await pool.query("ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS track_pm BOOLEAN");
 await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_units_fullbay_unit_id ON customer_units(fullbay_unit_id) WHERE fullbay_unit_id IS NOT NULL");
 await pool.query("INSERT INTO schema_migrations(migration_key) VALUES($1) ON CONFLICT(migration_key) DO NOTHING",["026_customer_crm_hardening"]);

 await pool.query(`
 CREATE OR REPLACE FUNCTION ittr_capture_state_history() RETURNS trigger AS $$
 BEGIN
   INSERT INTO app_state_history(state_key,version,payload,updated_by,captured_at)
   VALUES(OLD.state_key,OLD.version,OLD.payload,OLD.updated_by,now());
   RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS trg_ittr_app_state_history ON app_state;
 CREATE TRIGGER trg_ittr_app_state_history
 BEFORE UPDATE ON app_state
 FOR EACH ROW EXECUTE FUNCTION ittr_capture_state_history();
 `);
 await pool.query(
   "INSERT INTO schema_migrations(migration_key) VALUES($1) ON CONFLICT(migration_key) DO NOTHING",
   ["022_data_safe_pause_resume_findings"]
 );
 await pool.query("ALTER TABLE task_time_sessions ADD COLUMN IF NOT EXISTS task_name TEXT");
 await pool.query("CREATE INDEX IF NOT EXISTS idx_task_sessions_uid ON task_time_sessions(work_order_id,task_uid,started_at DESC)");
 await pool.query(
   "INSERT INTO schema_migrations(migration_key) VALUES($1) ON CONFLICT(migration_key) DO NOTHING",
   ["023_stable_task_records"]
 );
 await pool.query(
   "INSERT INTO schema_migrations(migration_key) VALUES($1) ON CONFLICT(migration_key) DO NOTHING",
   ["025_mobile_collaboration"]
 );

 const c=await pool.query("SELECT count(*)::int c FROM auth_users WHERE role='admin' AND active=true");
 if(c.rows[0].c===0){
   const username=cleanUsername(process.env.BOOTSTRAP_ADMIN_USERNAME||"admin");
   const password=String(process.env.BOOTSTRAP_ADMIN_PASSWORD||"");
   if(!password || password.length<10){console.warn("ITTR SETUP REQUIRED: set BOOTSTRAP_ADMIN_PASSWORD to at least 10 characters before first login.");}
   else{
     const h=await bcrypt.hash(password,12);
     await pool.query("INSERT INTO auth_users(username,display_name,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(username) DO NOTHING",[username,"Admin",h]);
     console.log(`ITTR: bootstrap admin created: ${username}`);
   }
 }
 for(const k of ["users","shopflow","pro"]){await pool.query("INSERT INTO app_state(state_key,payload) VALUES($1,$2::jsonb) ON CONFLICT(state_key) DO NOTHING",[k,JSON.stringify(k==="shopflow"?{workorders:[],issues:[]}:{})]);}
 await pool.query("DELETE FROM auth_sessions WHERE expires_at<now()");
}

async function auth(req,res,next){
 try{
   const h=String(req.headers.authorization||""); const token=h.startsWith("Bearer ")?h.slice(7).trim():"";
   if(!token)return res.status(401).json({error:"Please sign in."});
   const q=await requireDb().query(`SELECT s.id session_id,u.* FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[hashToken(token)]);
   if(!q.rowCount)return res.status(401).json({error:"Session expired. Please sign in again."});
   req.user=q.rows[0]; req.sessionToken=token; next();
 }catch(e){next(e)}
}
const liveWss=new WebSocketServer({server:httpServer,path:"/ws/shop-status"});
const liveClients=new Set();
function broadcastShopStatus(type,payload={}){const msg=JSON.stringify({type,at:new Date().toISOString(),...payload});for(const ws of liveClients){if(ws.readyState===WebSocket.OPEN)try{ws.send(msg)}catch(_){}}}
liveWss.on("connection",async(ws,req)=>{try{const u=new URL(req.url,"http://localhost"),token=String(u.searchParams.get("token")||"").trim();if(!token){ws.close(1008,"Authentication required");return}const q=await requireDb().query(`SELECT u.username,u.display_name,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[hashToken(token)]);if(!q.rowCount){ws.close(1008,"Session expired");return}ws.ittrUser=q.rows[0];ws.isAlive=true;ws.on("pong",()=>{ws.isAlive=true});liveClients.add(ws);ws.send(JSON.stringify({type:"connected",at:new Date().toISOString()}));ws.on("close",()=>liveClients.delete(ws))}catch(e){console.error("WebSocket auth",e.message);try{ws.close(1011,"Connection error")}catch(_){}}});
const liveHeartbeat=setInterval(()=>{for(const ws of liveClients){if(ws.isAlive===false){liveClients.delete(ws);try{ws.terminate()}catch(_){}continue}ws.isAlive=false;try{ws.ping()}catch(_){}}},25000);liveHeartbeat.unref?.();

async function ensurePartsSearchPerformance(){
 if(!pool)return;
 try{
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_parts_number_trgm ON fullbay_import_parts USING gin (part_number gin_trgm_ops)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_parts_description_trgm ON fullbay_import_parts USING gin (description gin_trgm_ops)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_parts_manufacturer_trgm ON fullbay_import_parts USING gin (manufacturer gin_trgm_ops)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_parts_vendor_trgm ON fullbay_import_parts USING gin (vendor gin_trgm_ops)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_fullbay_parts_location_trgm ON fullbay_import_parts USING gin (location gin_trgm_ops)");
 }catch(e){
  console.warn("Parts search optimization warning:",e?.message||e);
 }
}

function adminOnly(req,res,next){if(!["admin","manager"].includes(req.user?.role))return res.status(403).json({error:"Manager access required."});next()}
function ownerOnly(req,res,next){if(req.user?.role!=="admin")return res.status(403).json({error:"Owner/Admin access required."});next()}
function can(req,key){return req.user?.role==="admin" || (req.user?.role==="manager" && req.user?.permissions?.[key]!==false)}
function managerPermission(key){return (req,res,next)=>{if(req.user?.role==="admin")return next();if(req.user?.role!=="manager")return res.status(403).json({error:"Manager access required."});if(req.user?.permissions?.[key]===false)return res.status(403).json({error:`Manager permission required: ${key}.`});next()}}
async function audit(username,action,details={}){try{if(pool)await pool.query("INSERT INTO server_audit(username,action,details) VALUES($1,$2,$3::jsonb)",[username||null,action,JSON.stringify(details)])}catch(e){console.error("audit",e.message)}}


function csvRows(text){
 const rows=[];let row=[],field="",quoted=false;
 const src=String(text||"").replace(/^\uFEFF/,"");
 for(let i=0;i<src.length;i++){
  const c=src[i];
  if(quoted){if(c==='"'){if(src[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;}
  else if(c==='"')quoted=true;
  else if(c===','){row.push(field);field="";}
  else if(c==='\n'){row.push(field);rows.push(row);row=[];field="";}
  else if(c==='\r'){} else field+=c;
 }
 if(field.length||row.length){row.push(field);rows.push(row)}
 return rows.filter(r=>r.some(v=>String(v||"").trim()!==""));
}
function csvObjects(buffer){
 const rows=csvRows(Buffer.isBuffer(buffer)?buffer.toString("utf8"):String(buffer||""));
 if(rows.length<2)return [];
 const headers=rows[0].map((h,i)=>String(h||`column_${i+1}`).trim()||`column_${i+1}`);
 return rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,String(r[i]??"").trim()])));
}
function normHeader(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"")}
function cleanFullbayCell(v){
 let s=String(v??"").replace(/^\uFEFF/,"").trim();
 if(!s)return "";
 // Fullbay CSV exports often use Excel formulas: ="value". Different parsers can leave =, quotes, or both.
 for(let i=0;i<3;i++){
  const m=s.match(/^=+\s*"([\s\S]*)"$/);
  if(m){s=m[1].replace(/""/g,'"').trim();continue}
  if(/^"[\s\S]*"$/.test(s)){s=s.slice(1,-1).replace(/""/g,'"').trim();continue}
  break;
 }
 s=s.replace(/^=+\s*/,"");
 s=s.replace(/(^|[\s|;,])=+(?=[A-Za-z0-9#])/g,"$1");
 return s.replace(/\s{2,}/g," ").trim();
}
function pickField(row,names){const m=new Map(Object.entries(row||{}).map(([k,v])=>[normHeader(k),cleanFullbayCell(v)]));for(const n of names){const v=m.get(normHeader(n));if(v!=null&&String(v).trim()!=="")return String(v).trim()}return ""}
function numOrNull(v){const n=Number(cleanFullbayCell(v).replace(/[$,%\s,]/g,""));return Number.isFinite(n)?n:null}
function boolOrNull(v){const s=cleanFullbayCell(v).toLowerCase();if(["yes","true","1","active","on"].includes(s))return true;if(["no","false","0","inactive","off"].includes(s))return false;return null}
function dateOrNull(v){const s=cleanFullbayCell(v);if(!s)return null;const d=new Date(s.replace(" ","T"));return Number.isFinite(d.getTime())?d.toISOString():null}
function fullbayDateOrNull(v){
 const s=cleanFullbayCell(v);if(!s)return null;
 // Fullbay Details exports dates like: ="2:55PM 5/2/2023".
 const m=s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i);
 if(m){let h=Number(m[1])%12;if(m[3].toUpperCase()==="PM")h+=12;const d=new Date(Date.UTC(Number(m[6]),Number(m[4])-1,Number(m[5]),h,Number(m[2]),0));return Number.isFinite(d.getTime())?d.toISOString():null}
 let d=new Date(s);if(Number.isFinite(d.getTime()))return d.toISOString();
 const m2=s.match(/^(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+(\d{1,2}\/\d{1,2}\/\d{4})$/i);if(m2){d=new Date(`${m2[2]} ${m2[1]}`);if(Number.isFinite(d.getTime()))return d.toISOString()}
 return null;
}
function cleanRawRow(row){const out={};for(const [k,v] of Object.entries(row||{})){if(normHeader(k)==="portalcode")continue;out[k]=cleanFullbayCell(v)}return out}
function sourceKey(prefix,...vals){const raw=vals.map(v=>String(v||"").trim().toLowerCase()).filter(Boolean).join("|");return prefix+":"+crypto.createHash("sha256").update(raw||crypto.randomUUID()).digest("hex")}

async function repairFullbayServiceDatesAtStartup(){
 if(!pool)return {checked:0,repaired:0};
 const r=await pool.query(`SELECT id,raw FROM fullbay_service_history WHERE action_completed_at IS NULL ORDER BY id`);
 let repaired=0;
 for(const row of r.rows){const raw=row.raw||{};const value=raw["Action Completed Date"]||raw["Completed Date"]||raw["Date"]||"";const parsed=fullbayDateOrNull(value);if(!parsed)continue;await pool.query("UPDATE fullbay_service_history SET action_completed_at=$2,updated_at=now() WHERE id=$1 AND action_completed_at IS NULL",[row.id,parsed]);repaired++}
 return {checked:r.rowCount,repaired};
}

async function repairFullbayTextArtifactsAtStartup(){
 if(!pool)return {units:0,history:0,customers:0,parts:0};
 const client=await pool.connect(),counts={units:0,history:0,customers:0,parts:0};
 const cleanRow=(row,fields)=>{const out={};let changed=false;for(const f of fields){const old=row[f],next=old==null?old:cleanFullbayCell(old);out[f]=next;if(old!=null&&String(old)!==String(next))changed=true}return {out,changed}};
 try{
  await client.query("BEGIN");
  const unitFields=["customer_name","unit_number","vin","year","make","model","plate","engine","transmission","notes","unit_status","unit_type","unit_subtype"];
  const ur=await client.query(`SELECT id,${unitFields.join(",")} FROM customer_units`);
  for(const row of ur.rows){const {out,changed}=cleanRow(row,unitFields);if(!changed)continue;await client.query(`UPDATE customer_units SET customer_name=$2,unit_number=$3,vin=$4,year=$5,make=$6,model=$7,plate=$8,engine=$9,transmission=$10,notes=$11,unit_status=$12,unit_type=$13,unit_subtype=$14,updated_at=now() WHERE id=$1`,[row.id,...unitFields.map(f=>out[f])]);counts.units++}
  const historyFields=["customer_name","unit_number","vin","unit_status","unit_type","unit_subtype","service_order","invoice_number","po_number","action_number","lead_tech","tech","complaint","actual_correction","component","system"];
  const hr=await client.query(`SELECT id,${historyFields.join(",")} FROM fullbay_service_history`);
  for(const row of hr.rows){const {out,changed}=cleanRow(row,historyFields);if(!changed)continue;await client.query(`UPDATE fullbay_service_history SET customer_name=$2,unit_number=$3,vin=$4,unit_status=$5,unit_type=$6,unit_subtype=$7,service_order=$8,invoice_number=$9,po_number=$10,action_number=$11,lead_tech=$12,tech=$13,complaint=$14,actual_correction=$15,component=$16,system=$17,updated_at=now() WHERE id=$1`,[row.id,...historyFields.map(f=>out[f])]);counts.history++}
  const customerFields=["customer_name","phone","address","city","state","postal_code","customer_group","secondary_phone","dot_number","external_id","country","assigned_shop","tax_exempt_number","credit_terms","billing_contact","payment_method","price_level","access_method","billing_address","billing_city","billing_state","billing_postal_code","ext_accounting","contact_name"];
  const cr=await client.query(`SELECT id,${customerFields.join(",")} FROM fullbay_import_customers`);
  for(const row of cr.rows){const {out,changed}=cleanRow(row,customerFields);if(!changed)continue;await client.query(`UPDATE fullbay_import_customers SET customer_name=$2,phone=$3,address=$4,city=$5,state=$6,postal_code=$7,customer_group=$8,secondary_phone=$9,dot_number=$10,external_id=$11,country=$12,assigned_shop=$13,tax_exempt_number=$14,credit_terms=$15,billing_contact=$16,payment_method=$17,price_level=$18,access_method=$19,billing_address=$20,billing_city=$21,billing_state=$22,billing_postal_code=$23,ext_accounting=$24,contact_name=$25,updated_at=now() WHERE id=$1`,[row.id,...customerFields.map(f=>out[f])]);counts.customers++}
  const partFields=["part_number","description","location","vendor","status","uom","category","manufacturer","notes"];
  const pr=await client.query(`SELECT id,${partFields.join(",")} FROM fullbay_import_parts`);
  for(const row of pr.rows){const {out,changed}=cleanRow(row,partFields);if(!changed)continue;await client.query(`UPDATE fullbay_import_parts SET part_number=$2,description=$3,location=$4,vendor=$5,status=$6,uom=$7,category=$8,manufacturer=$9,notes=$10,updated_at=now() WHERE id=$1`,[row.id,...partFields.map(f=>out[f])]);counts.parts++}
  await client.query("COMMIT");return counts;
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}


function importedMoney(v){const n=Number(String(cleanFullbayCell(v)||'').replace(/[$,]/g,''));return Number.isFinite(n)?n:null}
function importedInt(v){const n=parseInt(String(cleanFullbayCell(v)||'').replace(/[^0-9-]/g,''),10);return Number.isFinite(n)?n:null}
async function findImportedCustomer(db,fullbayId,name){
 const fid=String(cleanFullbayCell(fullbayId)||'').trim(),nm=String(cleanFullbayCell(name)||'').trim();
 if(fid){const r=await db.query("SELECT * FROM fullbay_import_customers WHERE fullbay_id=$1 ORDER BY id LIMIT 1",[fid]);if(r.rowCount)return r.rows[0]}
 if(nm){const r=await db.query("SELECT * FROM fullbay_import_customers WHERE lower(trim(customer_name))=lower(trim($1)) ORDER BY active DESC NULLS LAST,id LIMIT 1",[nm]);if(r.rowCount)return r.rows[0]}
 return null;
}
async function findImportedUnit(db,unitId,customerId,unitNumber,vin){
 const uid=String(cleanFullbayCell(unitId)||'').trim(),un=String(cleanFullbayCell(unitNumber)||'').trim(),vv=String(cleanFullbayCell(vin)||'').trim();
 if(uid){const r=await db.query("SELECT * FROM customer_units WHERE fullbay_unit_id=$1 ORDER BY id LIMIT 1",[uid]);if(r.rowCount)return r.rows[0]}
 if(vv){const r=await db.query("SELECT * FROM customer_units WHERE lower(trim(vin))=lower(trim($1)) ORDER BY id LIMIT 1",[vv]);if(r.rowCount)return r.rows[0]}
 if(un&&customerId){const r=await db.query("SELECT * FROM customer_units WHERE customer_id=$1 AND lower(trim(unit_number))=lower(trim($2)) ORDER BY id LIMIT 1",[customerId,un]);if(r.rowCount)return r.rows[0]}
 return null;
}

app.post("/api/fullbay/import/customer-units",auth,managerPermission("customers"),upload.single("file"),async(req,res,next)=>{try{
 if(!req.file)return res.status(400).json({error:"Choose CustomersUnits.csv first."});
 const rows=csvObjects(req.file.buffer);if(!rows.length)return res.status(400).json({error:"No data rows found in CustomersUnits.csv."});
 const db=requireDb(),client=await db.connect();let customers=0,units=0,updated=0,skipped=0;
 try{await client.query("BEGIN");for(const row of rows){
  const custId=pickField(row,["Cust ID","Customer ID","customer id"]),name=pickField(row,["Customer","Customer Name","Company Name"]),unitId=pickField(row,["Unit ID","unit id"]),unitNo=pickField(row,["Number","Unit","Unit #"]);
  if(!name||(!unitId&&!unitNo)){skipped++;continue}
  let cust=await findImportedCustomer(client,custId,name);
  if(!cust){const key=custId?`customer:id:${String(custId).toLowerCase()}`:sourceKey("customer-roster",name);const cr=await client.query(`INSERT INTO fullbay_import_customers(source_key,fullbay_id,customer_name,active,customer_group,access_method,raw,source_file) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(source_key) DO UPDATE SET customer_name=EXCLUDED.customer_name,active=EXCLUDED.active,customer_group=EXCLUDED.customer_group,access_method=EXCLUDED.access_method,raw=EXCLUDED.raw,source_file=EXCLUDED.source_file,updated_at=now() RETURNING *`,[key,custId||null,name,boolOrNull(pickField(row,["Customer Active"])),pickField(row,["Customer Group"])||null,pickField(row,["Access Method"])||null,JSON.stringify(cleanRawRow(row)),String(req.file.originalname||"CustomersUnits.csv")]);cust=cr.rows[0];customers++}
  const vin=pickField(row,["Serial Number / VIN","VIN"]),year=pickField(row,["Chassis Year","Year"]),make=pickField(row,["Chassis Make","Make"]),model=pickField(row,["Chassis Model","Model"]),plate=pickField(row,["License Plate","Plate"]),mileage=importedInt(pickField(row,["Mileage"]));
  const engine=[pickField(row,["Engine Year"]),pickField(row,["Engine Make"]),pickField(row,["Engine Model"]),pickField(row,["Engine Serial #"])].filter(Boolean).join(" ");
  const trans=[pickField(row,["Transmission Year"]),pickField(row,["Transmission Make"]),pickField(row,["Transmission Model"]),pickField(row,["Transmission Serial #"])].filter(Boolean).join(" ");
  let unit=await findImportedUnit(client,unitId,cust.id,unitNo,vin);
  const vals=[cust.id,name,unitNo||null,vin||null,year||null,make||null,model||null,plate||null,mileage,engine||null,trans||null,pickField(row,["New Note","Display Notes on SO"])||null,pickField(row,["Unit Active"])||null,pickField(row,["Type"])||null,pickField(row,["Subtype"])||null,unitId||null,pickField(row,["Fleet #"])||null,pickField(row,["License Plate State"])||null,pickField(row,["Access Method"])||null,boolOrNull(pickField(row,["Track Preventive Maintenance"]))];
  if(unit){await client.query(`UPDATE customer_units SET customer_id=$1,customer_name=$2,unit_number=coalesce($3,unit_number),vin=coalesce(nullif($4,''),vin),year=coalesce(nullif($5,''),year),make=coalesce(nullif($6,''),make),model=coalesce(nullif($7,''),model),plate=coalesce(nullif($8,''),plate),mileage=coalesce($9,mileage),engine=coalesce(nullif($10,''),engine),transmission=coalesce(nullif($11,''),transmission),notes=coalesce(nullif($12,''),notes),unit_status=coalesce(nullif($13,''),unit_status),unit_type=coalesce(nullif($14,''),unit_type),unit_subtype=coalesce(nullif($15,''),unit_subtype),fullbay_unit_id=coalesce(nullif($16,''),fullbay_unit_id),fleet_number=coalesce(nullif($17,''),fleet_number),license_plate_state=coalesce(nullif($18,''),license_plate_state),access_method=coalesce(nullif($19,''),access_method),track_pm=coalesce($20,track_pm),source='fullbay_customer_units',updated_at=now() WHERE id=$21`,[...vals,unit.id]);updated++}
  else{await client.query(`INSERT INTO customer_units(customer_id,customer_name,unit_number,vin,year,make,model,plate,mileage,engine,transmission,notes,unit_status,unit_type,unit_subtype,fullbay_unit_id,fleet_number,license_plate_state,access_method,track_pm,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'fullbay_customer_units')`,vals);units++}
 }
 await client.query("INSERT INTO fullbay_import_log(import_type,source_file,rows_received,rows_imported,rows_skipped,username) VALUES('customer_units',$1,$2,$3,$4,$5)",[String(req.file.originalname||"CustomersUnits.csv"),rows.length,units+updated,skipped,req.user.username]);await client.query("COMMIT");
 res.json({ok:true,rows:rows.length,customersCreated:customers,unitsCreated:units,unitsUpdated:updated,skipped});
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}catch(e){next(e)}});

app.post("/api/fullbay/import/repair-orders",auth,managerPermission("customers"),upload.single("file"),async(req,res,next)=>{try{
 if(!req.file)return res.status(400).json({error:"Choose repairOrders.csv first."});
 const rows=csvObjects(req.file.buffer);if(!rows.length)return res.status(400).json({error:"No repair orders found in this CSV."});
 const db=requireDb(),client=await db.connect();let imported=0,updated=0,skipped=0,customerMatches=0,unitMatches=0;
 try{await client.query("BEGIN");for(const row of rows){
  const so=pickField(row,["SO","Service Order","Service Order #"]),customerName=pickField(row,["Customer"]),unitNo=pickField(row,["Unit"]);if(!so||!customerName){skipped++;continue}
  const cust=await findImportedCustomer(client,null,customerName);if(cust)customerMatches++;
  const unit=await findImportedUnit(client,null,cust?.id||null,unitNo,null);if(unit)unitMatches++;
  const key=`repair-order:${String(so).trim().toLowerCase()}`,completed=fullbayDateOrNull(pickField(row,["Completed"])),total=importedMoney(pickField(row,["Total"]));
  const existing=await client.query("SELECT id FROM fullbay_service_history WHERE source_key=$1",[key]);
  await client.query(`INSERT INTO fullbay_service_history(source_key,customer_id,customer_name,unit_record_id,unit_number,vin,unit_status,unit_type,unit_subtype,service_order,po_number,action_completed_at,lead_tech,complaint,total_amount,raw,source_file,service_writer,invoiced,service_status,parts_status,unit_return,notes_count,severity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(source_key) DO UPDATE SET customer_id=EXCLUDED.customer_id,customer_name=EXCLUDED.customer_name,unit_record_id=EXCLUDED.unit_record_id,unit_number=EXCLUDED.unit_number,vin=EXCLUDED.vin,unit_status=EXCLUDED.unit_status,unit_type=EXCLUDED.unit_type,unit_subtype=EXCLUDED.unit_subtype,service_order=EXCLUDED.service_order,po_number=EXCLUDED.po_number,action_completed_at=EXCLUDED.action_completed_at,lead_tech=EXCLUDED.lead_tech,complaint=EXCLUDED.complaint,total_amount=EXCLUDED.total_amount,raw=EXCLUDED.raw,source_file=EXCLUDED.source_file,service_writer=EXCLUDED.service_writer,invoiced=EXCLUDED.invoiced,service_status=EXCLUDED.service_status,parts_status=EXCLUDED.parts_status,unit_return=EXCLUDED.unit_return,notes_count=EXCLUDED.notes_count,severity=EXCLUDED.severity,updated_at=now()`,[key,cust?.id||null,customerName,unit?.id||null,unitNo||unit?.unit_number||null,unit?.vin||null,unit?.unit_status||null,unit?.unit_type||null,unit?.unit_subtype||null,so,pickField(row,["Parts PO No."])||null,completed,pickField(row,["Lead Tech"])||null,pickField(row,["1st Complaint","Complaint"])||null,total,JSON.stringify(cleanRawRow(row)),String(req.file.originalname||"repairOrders.csv"),pickField(row,["Service Writer"])||null,boolOrNull(pickField(row,["Invoiced"])),pickField(row,["Service Status"])||null,pickField(row,["Parts Status"])||null,pickField(row,["Unit Return"])||null,importedInt(pickField(row,["# SO Notes"])),pickField(row,["Severity"])||null]);
  if(existing.rowCount)updated++;else imported++;
 }
 await client.query("INSERT INTO fullbay_import_log(import_type,source_file,rows_received,rows_imported,rows_skipped,username) VALUES('repair_orders',$1,$2,$3,$4,$5)",[String(req.file.originalname||"repairOrders.csv"),rows.length,imported+updated,skipped,req.user.username]);await client.query("COMMIT");
 res.json({ok:true,rows:rows.length,imported,updated,skipped,customerMatches,unitMatches});
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}catch(e){next(e)}});

app.get("/api/fullbay/import/status",auth,adminOnly,async(req,res,next)=>{try{
 const db=requireDb();const [c,p,srv,u,l]=await Promise.all([db.query("SELECT count(*)::int n,max(updated_at) last FROM fullbay_import_customers"),db.query("SELECT count(*)::int n,max(updated_at) last FROM fullbay_import_parts"),db.query("SELECT count(*)::int n,count(DISTINCT service_order)::int orders,max(updated_at) last FROM fullbay_service_history"),db.query("SELECT count(*)::int n FROM customer_units"),db.query("SELECT * FROM fullbay_import_log ORDER BY created_at DESC LIMIT 10")]);
 res.json({customers:c.rows[0],parts:p.rows[0],service:srv.rows[0],units:u.rows[0],recent:l.rows});
}catch(e){next(e)}});

app.post("/api/fullbay/import/customers",auth,managerPermission("customers"),upload.single("file"),async(req,res,next)=>{try{
 if(!req.file)return res.status(400).json({error:"Choose a Fullbay customer CSV file."});
 const rows=csvObjects(req.file.buffer);if(!rows.length)return res.status(400).json({error:"No data rows found in this CSV."});
 const db=requireDb();let imported=0,skipped=0;
 for(const row of rows){
  const fullbayId=pickField(row,["ID","customer id","customerid"]),name=pickField(row,["Company Name","customer","customer name","company"]);
  if(!name){skipped++;continue}
  const phone=pickField(row,["Customer Main Phone","phone","main phone"]),secondaryPhone=pickField(row,["Customer Secondary Phone","secondary phone"]),dot=pickField(row,["DOT #","dot","dot number"]),externalId=pickField(row,["External Id","external id"]);
  const address=pickField(row,["Physical Address Line 1","address","address 1"]),city=pickField(row,["Physical Address City","city"]),state=pickField(row,["Physical Address State","state"]),postal=pickField(row,["Physical Address Zip/Postal Code","zip","postal code"]),country=pickField(row,["Physical Address Country","country"]);
  const billingAddress=pickField(row,["Billing Address Line 1"]),billingCity=pickField(row,["Billing Address City"]),billingState=pickField(row,["Billing Address State"]),billingPostal=pickField(row,["Billing Address Zip/Postal Code"]);
  const key=fullbayId?`customer:id:${String(fullbayId).toLowerCase()}`:sourceKey("customer",name,phone,dot,address);
  await db.query(`INSERT INTO fullbay_import_customers(source_key,fullbay_id,customer_name,phone,email,address,city,state,postal_code,active,created_fullbay,customer_group,secondary_phone,dot_number,external_id,country,assigned_shop,taxable,tax_exempt_number,credit_terms,credit_limit,billing_contact,payment_method,default_labor_rate,price_level,access_method,billing_address,billing_city,billing_state,billing_postal_code,ext_accounting,contact_name,raw,source_file) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34) ON CONFLICT(source_key) DO UPDATE SET fullbay_id=EXCLUDED.fullbay_id,customer_name=EXCLUDED.customer_name,phone=EXCLUDED.phone,email=coalesce(EXCLUDED.email,fullbay_import_customers.email),address=EXCLUDED.address,city=EXCLUDED.city,state=EXCLUDED.state,postal_code=EXCLUDED.postal_code,active=EXCLUDED.active,created_fullbay=EXCLUDED.created_fullbay,customer_group=EXCLUDED.customer_group,secondary_phone=EXCLUDED.secondary_phone,dot_number=EXCLUDED.dot_number,external_id=EXCLUDED.external_id,country=EXCLUDED.country,assigned_shop=EXCLUDED.assigned_shop,taxable=EXCLUDED.taxable,tax_exempt_number=EXCLUDED.tax_exempt_number,credit_terms=EXCLUDED.credit_terms,credit_limit=EXCLUDED.credit_limit,billing_contact=EXCLUDED.billing_contact,payment_method=EXCLUDED.payment_method,default_labor_rate=EXCLUDED.default_labor_rate,price_level=EXCLUDED.price_level,access_method=EXCLUDED.access_method,billing_address=EXCLUDED.billing_address,billing_city=EXCLUDED.billing_city,billing_state=EXCLUDED.billing_state,billing_postal_code=EXCLUDED.billing_postal_code,ext_accounting=EXCLUDED.ext_accounting,contact_name=coalesce(fullbay_import_customers.contact_name,EXCLUDED.contact_name),raw=EXCLUDED.raw,source_file=EXCLUDED.source_file,updated_at=now()`,[key,fullbayId||null,name,phone||null,null,address||null,city||null,state||null,postal||null,boolOrNull(pickField(row,["Customer Active"])),dateOrNull(pickField(row,["Created"])),pickField(row,["Customer Group"])||null,secondaryPhone||null,dot||null,externalId||null,country||null,pickField(row,["Assigned Shop"])||null,boolOrNull(pickField(row,["Taxable"])),pickField(row,["Tax Exempt #"])||null,pickField(row,["Credit Terms"])||null,numOrNull(pickField(row,["Credit Limit"])),pickField(row,["Billing Contact"])||null,pickField(row,["Payment Method"])||null,numOrNull(pickField(row,["Default Labor Rate"])),pickField(row,["Price Level"])||null,pickField(row,["Access Method"])||null,billingAddress||null,billingCity||null,billingState||null,billingPostal||null,pickField(row,["Ext Accounting"])||null,pickField(row,["Repair Authorizer","Billing Contact","Day to Day Decisions","Overall Decisions"])||null,JSON.stringify(cleanRawRow(row)),String(req.file.originalname||"customers.csv")]);imported++;
 }
 await db.query("INSERT INTO fullbay_import_log(import_type,source_file,rows_received,rows_imported,rows_skipped,username) VALUES('customers',$1,$2,$3,$4,$5)",[String(req.file.originalname||"customers.csv"),rows.length,imported,skipped,req.user.username]);
 await audit(req.user.username,"fullbay_customers_import",{file:req.file.originalname,received:rows.length,imported,skipped});res.json({ok:true,received:rows.length,imported,skipped});
}catch(e){next(e)}});

app.post("/api/fullbay/import/parts",auth,managerPermission("inventory"),upload.single("file"),async(req,res,next)=>{try{
 if(!req.file)return res.status(400).json({error:"Choose a Fullbay parts/inventory CSV file."});
 const rows=csvObjects(req.file.buffer);if(!rows.length)return res.status(400).json({error:"No data rows found in this CSV."});
 const db=requireDb();let imported=0,skipped=0;
 for(const row of rows){
  const partNumber=pickField(row,["Part #","part number","partnumber","sku"]),description=pickField(row,["Description","part description","name"]);
  if(!partNumber&&!description){skipped++;continue}
  const vendor=pickField(row,["Preferred Vendor","vendor"]),manufacturer=pickField(row,["Manufacturer"]);
  const key=partNumber?sourceKey("part",partNumber):sourceKey("part",description,vendor,manufacturer);
  await db.query(`INSERT INTO fullbay_import_parts(source_key,fullbay_id,part_number,description,quantity,cost,price,location,vendor,status,uom,allocated,min_qty,max_qty,track_quantity,category,cost_floor,inventory_value,inventory_balance,manufacturer,notes,raw,source_file) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22) ON CONFLICT(source_key) DO UPDATE SET part_number=EXCLUDED.part_number,description=EXCLUDED.description,quantity=EXCLUDED.quantity,cost=EXCLUDED.cost,price=EXCLUDED.price,location=EXCLUDED.location,vendor=EXCLUDED.vendor,status=EXCLUDED.status,uom=EXCLUDED.uom,allocated=EXCLUDED.allocated,min_qty=EXCLUDED.min_qty,max_qty=EXCLUDED.max_qty,track_quantity=EXCLUDED.track_quantity,category=EXCLUDED.category,cost_floor=EXCLUDED.cost_floor,inventory_value=EXCLUDED.inventory_value,inventory_balance=EXCLUDED.inventory_balance,manufacturer=EXCLUDED.manufacturer,notes=EXCLUDED.notes,raw=EXCLUDED.raw,source_file=EXCLUDED.source_file,updated_at=now()`,[key,partNumber||null,description||null,numOrNull(pickField(row,["In Stock"])),numOrNull(pickField(row,["Average Cost"])),numOrNull(pickField(row,["Selling Price"])),pickField(row,["Default Location"])||null,vendor||null,pickField(row,["Status"])||null,pickField(row,["UOM"])||null,numOrNull(pickField(row,["Allocated"])),numOrNull(pickField(row,["Min Qty"])),numOrNull(pickField(row,["Max Qty"])),boolOrNull(pickField(row,["Track Quantity"])),pickField(row,["Category"])||null,numOrNull(pickField(row,["Cost Floor"])),numOrNull(pickField(row,["Value"])),numOrNull(pickField(row,["Current Inventory Balance"])),manufacturer||null,pickField(row,["Notes"])||null,JSON.stringify(cleanRawRow(row)),String(req.file.originalname||"inventory.csv")]);imported++;
 }
 await db.query("INSERT INTO fullbay_import_log(import_type,source_file,rows_received,rows_imported,rows_skipped,username) VALUES('parts',$1,$2,$3,$4,$5)",[String(req.file.originalname||"inventory.csv"),rows.length,imported,skipped,req.user.username]);
 await audit(req.user.username,"fullbay_parts_import",{file:req.file.originalname,received:rows.length,imported,skipped});res.json({ok:true,received:rows.length,imported,skipped});
}catch(e){next(e)}});

app.post("/api/fullbay/import/service-history",auth,managerPermission("customers"),upload.single("file"),async(req,res,next)=>{
 try{
  if(!req.file)return res.status(400).json({error:"Choose the Fullbay Details / Service History CSV file."});
  const rows=csvObjects(req.file.buffer);if(!rows.length)return res.status(400).json({error:"No data rows found in this CSV."});
  const required=["Customer","Unit #","SO","Complaint","Actual Correction"],headers=new Set(Object.keys(rows[0]||{}).map(normHeader));
  const missing=required.filter(x=>!headers.has(normHeader(x)));if(missing.length)return res.status(400).json({error:`This does not look like the Fullbay Details export. Missing: ${missing.join(", ")}`});
  const db=requireDb(),client=await db.connect();let imported=0,skipped=0,unitsTouched=new Set(),customersTouched=new Set();
  try{
   await client.query("BEGIN");
   for(const row of rows){
    const customerName=pickField(row,["Customer","Company Name","Customer Name"]),unit=pickField(row,["Unit #","Unit","Unit Number"]),vin=pickField(row,["VIN"]).toUpperCase(),so=pickField(row,["SO","Service Order","Service Order #"]),action=pickField(row,["Action"]),complaint=pickField(row,["Complaint"]),correction=pickField(row,["Actual Correction","Correction"]);
    if(!customerName||(!unit&&!vin)||!so){skipped++;continue}
    let cr=await client.query("SELECT id,customer_name FROM fullbay_import_customers WHERE lower(trim(customer_name))=lower(trim($1)) ORDER BY id LIMIT 1",[customerName]);
    if(!cr.rowCount){const ck=sourceKey("details-customer",customerName);cr=await client.query(`INSERT INTO fullbay_import_customers(source_key,customer_name,active,source_file) VALUES($1,$2,true,$3) ON CONFLICT(source_key) DO UPDATE SET customer_name=EXCLUDED.customer_name,updated_at=now() RETURNING id,customer_name`,[ck,customerName,String(req.file.originalname||"details.csv")])}
    const customer=cr.rows[0];customersTouched.add(String(customer.id));
    const milesRaw=numOrNull(pickField(row,["Unit Miles","Mileage","Miles"]));const miles=milesRaw!=null?Math.max(0,Math.round(milesRaw)):null;
    let unitRecord=null;
    if(unit){unitRecord=await upsertDirectoryUnit(client,{customerId:customer.id,customerName:customer.customer_name,unit,vin,mileage:miles,source:"fullbay_details"});if(unitRecord){unitsTouched.add(String(unitRecord.id));await client.query(`UPDATE customer_units SET vin=coalesce(nullif($2,''),vin),mileage=CASE WHEN $3::bigint IS NULL THEN mileage WHEN mileage IS NULL OR $3::bigint>mileage THEN $3::bigint ELSE mileage END,unit_status=coalesce(nullif($4,''),unit_status),unit_type=coalesce(nullif($5,''),unit_type),unit_subtype=coalesce(nullif($6,''),unit_subtype),source=CASE WHEN source='manual' THEN source ELSE 'fullbay_details' END,updated_at=now() WHERE id=$1`,[unitRecord.id,vin||"",miles,pickField(row,["Unit Status"]),pickField(row,["Unit Type"]),pickField(row,["Unit Subtype"])])}}
    const completed=fullbayDateOrNull(pickField(row,["Action Completed Date","Completed Date","Date"]));
    const invoice=pickField(row,["Inv #","Invoice #","Invoice"]),po=pickField(row,["PO #","PO"]);
    const stable=[customerName,vin||unit,so,invoice,action,completed||pickField(row,["Action Completed Date"]),complaint,correction].map(x=>String(x||"").trim().toLowerCase()).join("|");
    const key="service:"+crypto.createHash("sha256").update(stable).digest("hex");
    await client.query(`INSERT INTO fullbay_service_history(source_key,customer_id,customer_name,unit_record_id,unit_number,vin,unit_status,unit_type,unit_subtype,service_order,invoice_number,po_number,action_number,action_completed_at,lead_tech,tech,complaint,actual_correction,hours,labor_amount,part_amount,total_amount,unit_miles,component,system,raw,source_file) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27) ON CONFLICT(source_key) DO UPDATE SET customer_id=EXCLUDED.customer_id,customer_name=EXCLUDED.customer_name,unit_record_id=EXCLUDED.unit_record_id,unit_number=EXCLUDED.unit_number,vin=EXCLUDED.vin,unit_status=EXCLUDED.unit_status,unit_type=EXCLUDED.unit_type,unit_subtype=EXCLUDED.unit_subtype,service_order=EXCLUDED.service_order,invoice_number=EXCLUDED.invoice_number,po_number=EXCLUDED.po_number,action_number=EXCLUDED.action_number,action_completed_at=EXCLUDED.action_completed_at,lead_tech=EXCLUDED.lead_tech,tech=EXCLUDED.tech,complaint=EXCLUDED.complaint,actual_correction=EXCLUDED.actual_correction,hours=EXCLUDED.hours,labor_amount=EXCLUDED.labor_amount,part_amount=EXCLUDED.part_amount,total_amount=EXCLUDED.total_amount,unit_miles=EXCLUDED.unit_miles,component=EXCLUDED.component,system=EXCLUDED.system,raw=EXCLUDED.raw,source_file=EXCLUDED.source_file,updated_at=now()`,[key,customer.id,customer.customer_name,unitRecord?.id||null,unit||null,vin||null,pickField(row,["Unit Status"])||null,pickField(row,["Unit Type"])||null,pickField(row,["Unit Subtype"])||null,so,invoice||null,po||null,action||null,completed,pickField(row,["Lead Tech"])||null,pickField(row,["Tech"])||null,complaint||null,correction||null,numOrNull(pickField(row,["Hours"])),numOrNull(pickField(row,["Labor $"])),numOrNull(pickField(row,["Part $"])),numOrNull(pickField(row,["Total Parts & Labor"])),miles,pickField(row,["Component"])||null,pickField(row,["System"])||null,JSON.stringify(cleanRawRow(row)),String(req.file.originalname||"details.csv")]);imported++;
   }
   await client.query("INSERT INTO fullbay_import_log(import_type,source_file,rows_received,rows_imported,rows_skipped,username) VALUES('service_history',$1,$2,$3,$4,$5)",[String(req.file.originalname||"details.csv"),rows.length,imported,skipped,req.user.username]);
   await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
  await audit(req.user.username,"fullbay_service_history_import",{file:req.file.originalname,received:rows.length,imported,skipped,customers:customersTouched.size,units:unitsTouched.size});
  res.json({ok:true,received:rows.length,imported,skipped,customers:customersTouched.size,units:unitsTouched.size});
 }catch(e){next(e)}
});


function canonicalFullbaySo(v){
 const x=String(cleanFullbayCell(v)||'').trim().replace(/\s*\(Quick SO\)\s*$/i,'').trim();
 return x.replace(/^SO[\s#-]*/i,'').trim();
}
async function reconcileFullbayHistoryLinks(db){
 const result={customerLinks:0,unitLinks:0,metadataBackfill:0,invalidVinUnits:0,duplicateCustomerUnits:0,orphanHistory:0};
 const c=await db.query(`UPDATE fullbay_service_history h SET customer_id=c.id,customer_name=c.customer_name,updated_at=now()
   FROM fullbay_import_customers c
   WHERE h.customer_id IS NULL AND lower(trim(h.customer_name))=lower(trim(c.customer_name)) RETURNING h.id`);
 result.customerLinks=c.rowCount;
 const u=await db.query(`UPDATE fullbay_service_history h SET unit_record_id=u.id,vin=coalesce(nullif(h.vin,''),u.vin),customer_id=coalesce(h.customer_id,u.customer_id),customer_name=coalesce(nullif(h.customer_name,''),u.customer_name),updated_at=now()
   FROM customer_units u
   WHERE h.unit_record_id IS NULL AND (
     (coalesce(h.vin,'')<>'' AND length(trim(h.vin))=17 AND lower(trim(h.vin))=lower(trim(u.vin)))
     OR (coalesce(h.unit_number,'')<>'' AND lower(trim(h.unit_number))=lower(trim(u.unit_number)) AND (h.customer_id::text=u.customer_id::text OR lower(trim(h.customer_name))=lower(trim(u.customer_name))))
   ) RETURNING h.id`);
 result.unitLinks=u.rowCount;
 const b=await db.query(`UPDATE fullbay_service_history h SET vin=coalesce(nullif(h.vin,''),u.vin),unit_number=coalesce(nullif(h.unit_number,''),u.unit_number),customer_id=coalesce(h.customer_id,u.customer_id),customer_name=coalesce(nullif(h.customer_name,''),u.customer_name),updated_at=now()
   FROM customer_units u WHERE h.unit_record_id=u.id AND (
     (coalesce(h.vin,'')='' AND coalesce(u.vin,'')<>'') OR (coalesce(h.unit_number,'')='' AND coalesce(u.unit_number,'')<>'') OR h.customer_id IS NULL
   ) RETURNING h.id`);
 result.metadataBackfill=b.rowCount;
 result.invalidVinUnits=Number((await db.query(`SELECT count(*)::int n FROM customer_units WHERE coalesce(trim(vin),'')<>'' AND trim(vin) !~ '^[A-HJ-NPR-Z0-9]{17}$'`)).rows[0]?.n||0);
 result.duplicateCustomerUnits=Number((await db.query(`SELECT count(*)::int n FROM (SELECT customer_id,lower(trim(unit_number)) u FROM customer_units WHERE coalesce(trim(unit_number),'')<>'' GROUP BY customer_id,lower(trim(unit_number)) HAVING count(*)>1) x`)).rows[0]?.n||0);
 result.orphanHistory=Number((await db.query(`SELECT count(*)::int n FROM fullbay_service_history WHERE unit_record_id IS NULL`)).rows[0]?.n||0);
 return result;
}
app.post("/api/fullbay/history/reconcile",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const db=requireDb(),report=await reconcileFullbayHistoryLinks(db);
 await audit(req.user.username,"fullbay_history_reconciled",report);
 res.json({ok:true,report});
}catch(e){next(e)}});

app.get("/api/fullbay/service-orders/:so",auth,async(req,res,next)=>{try{
 const db=requireDb(),so=String(req.params.so||"").trim(),canonical=canonicalFullbaySo(so),customerId=String(req.query.customerId||"").trim(),unit=String(req.query.unit||"").trim();
 if(!canonical)return res.status(400).json({error:"Service order is required."});
 const params=[canonical];let where="regexp_replace(regexp_replace(coalesce(service_order,''),'\\s*\\(Quick SO\\)\\s*$','','i'),'^SO[\\s#-]*','','i')=$1";
 if(customerId){params.push(customerId);where+=` AND customer_id::text=$${params.length}::text`}
 if(unit){params.push(unit);where+=` AND lower(trim(coalesce(unit_number,'')))=lower(trim($${params.length}))`}
 const r=await db.query(`SELECT * FROM fullbay_service_history WHERE ${where} ORDER BY action_completed_at NULLS LAST,action_number,id`,params);
 if(!r.rowCount)return res.status(404).json({error:"Service order not found."});
 const rows=r.rows,first=rows[0],detailRows=rows.filter(x=>x.action_number||x.actual_correction||Number(x.hours||0)||Number(x.labor_amount||0)||Number(x.part_amount||0));
 const used=detailRows.length?detailRows:rows;
 const sum=k=>used.reduce((n,x)=>n+Number(x[k]||0),0);
 res.json({order:{source:"fullbay",serviceOrder:first.service_order,invoice:rows.map(x=>x.invoice_number).find(Boolean)||null,po:rows.map(x=>x.po_number).find(Boolean)||null,customerId:first.customer_id,customer:first.customer_name,unit:first.unit_number,vin:first.vin,status:first.unit_status,unitType:first.unit_type,unitSubtype:first.unit_subtype,completedAt:rows.map(x=>x.action_completed_at).filter(Boolean).sort().pop()||null,mileage:Math.max(0,...rows.map(x=>Number(x.unit_miles||0))),leadTech:rows.map(x=>x.lead_tech).find(Boolean)||"",technicians:[...new Set(rows.map(x=>x.tech).filter(Boolean))],hours:sum("hours"),laborAmount:sum("labor_amount"),partAmount:sum("part_amount"),totalAmount:sum("total_amount"),actions:used.map(x=>({action:x.action_number,complaint:x.complaint,correction:x.actual_correction,hours:Number(x.hours||0),laborAmount:Number(x.labor_amount||0),partAmount:Number(x.part_amount||0),totalAmount:Number(x.total_amount||0),tech:x.tech||x.lead_tech||"",component:x.component||"",system:x.system||"",parts:Array.isArray(x.raw?.aiParts)?x.raw.aiParts:[],labor:Array.isArray(x.raw?.aiLabor)?x.raw.aiLabor:[],sourceFile:x.source_file||""}))}});
}catch(e){next(e)}});

app.get("/api/fullbay/customers",auth,async(req,res,next)=>{try{
 const q=String(req.query.q||"").trim(),limit=Math.min(200,Math.max(1,Number(req.query.limit)||50)),offset=Math.max(0,Number(req.query.offset)||0),like=`%${q}%`;
 const r=await requireDb().query(`SELECT id,fullbay_id,customer_name,active,created_fullbay,customer_group,phone,secondary_phone,dot_number,external_id,address,city,state,postal_code,country,assigned_shop,taxable,tax_exempt_number,credit_terms,credit_limit,billing_contact,payment_method,default_labor_rate,price_level,access_method,billing_address,billing_city,billing_state,billing_postal_code,ext_accounting,updated_at FROM fullbay_import_customers WHERE $1='' OR customer_name ILIKE $2 OR coalesce(phone,'') ILIKE $2 OR coalesce(secondary_phone,'') ILIKE $2 OR coalesce(dot_number,'') ILIKE $2 OR coalesce(city,'') ILIKE $2 ORDER BY active DESC NULLS LAST,customer_name LIMIT $3 OFFSET $4`,[q,like,limit,offset]);
 const c=await requireDb().query(`SELECT count(*)::int n FROM fullbay_import_customers WHERE $1='' OR customer_name ILIKE $2 OR coalesce(phone,'') ILIKE $2 OR coalesce(secondary_phone,'') ILIKE $2 OR coalesce(dot_number,'') ILIKE $2 OR coalesce(city,'') ILIKE $2`,[q,like]);res.json({items:r.rows,total:c.rows[0].n,limit,offset});
}catch(e){next(e)}});

app.get("/api/fullbay/customers/:id",auth,async(req,res,next)=>{try{const r=await requireDb().query(`SELECT * FROM fullbay_import_customers WHERE id=$1`,[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Customer not found."});const item=r.rows[0];delete item.raw?.['Portal Code'];res.json({item});}catch(e){next(e)}});

function partBarcodeForId(id){return `ITTR-P-${String(id).padStart(6,"0")}`}
async function ensurePartBarcode(db,id){const r=await db.query("SELECT id,internal_barcode FROM fullbay_import_parts WHERE id=$1",[id]);if(!r.rowCount)return null;let code=r.rows[0].internal_barcode;if(!code){code=partBarcodeForId(id);await db.query("UPDATE fullbay_import_parts SET internal_barcode=$2,updated_at=now() WHERE id=$1",[id,code])}return code}
function vendorKey(v){return String(v||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\.(com|net|org|us|co)(\/.*)?$/,'').replace(/[^a-z0-9]+/g,' ').replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b/g,' ').replace(/\s+/g,' ').replace(/ /g,'').trim()}
function prettyVendor(v){let x=String(v||'').trim().replace(/^https?:\/\//i,'').replace(/^www\./i,'').replace(/\/.*$/,'').replace(/\.(com|net|org|us|co)$/i,'').replace(/[._-]+/g,' ').replace(/([a-z0-9])(trucks|truck|parts)$/i,'$1 $2').trim();if(!x)return '';return x.split(/\s+/).map(w=>w.length<=4?w.toUpperCase():w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ')}
async function resolveVendor(db,raw,create=true){const original=String(raw||'').trim();if(!original)return '';const key=vendorKey(original);const r=await db.query(`SELECT canonical_name,aliases FROM parts_vendors WHERE active IS DISTINCT FROM FALSE ORDER BY canonical_name`);for(const row of r.rows){const vals=[row.canonical_name,...(Array.isArray(row.aliases)?row.aliases:[])];if(vals.some(v=>vendorKey(v)===key))return row.canonical_name}const imported=await db.query(`SELECT vendor,count(*)::int n FROM fullbay_import_parts WHERE vendor IS NOT NULL AND trim(vendor)<>'' GROUP BY vendor ORDER BY n DESC`);for(const row of imported.rows){if(vendorKey(row.vendor)===key){const name=prettyVendor(row.vendor);if(create)await db.query(`INSERT INTO parts_vendors(canonical_name,aliases) VALUES($1,$2::jsonb) ON CONFLICT(canonical_name) DO UPDATE SET aliases=(SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements_text(parts_vendors.aliases || EXCLUDED.aliases) x)`,[name,JSON.stringify([original,row.vendor])]);return name}}const name=prettyVendor(original);if(create&&name)await db.query(`INSERT INTO parts_vendors(canonical_name,aliases,website_domain) VALUES($1,$2::jsonb,$3) ON CONFLICT(canonical_name) DO UPDATE SET aliases=(SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements_text(parts_vendors.aliases || EXCLUDED.aliases) x),updated_at=now()`,[name,JSON.stringify([original]),/\.[a-z]{2,}$/i.test(original)?original.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0]:null]);return name}
app.get('/api/parts/vendors',auth,async(req,res,next)=>{try{const db=requireDb();const imported=await db.query(`SELECT vendor,count(*)::int n FROM fullbay_import_parts WHERE vendor IS NOT NULL AND trim(vendor)<>'' GROUP BY vendor ORDER BY n DESC`);for(const x of imported.rows.slice(0,100)){await resolveVendor(db,x.vendor,true)}const r=await db.query(`SELECT id,canonical_name,aliases,website_domain,active FROM parts_vendors WHERE active IS DISTINCT FROM FALSE ORDER BY canonical_name`);res.json({items:r.rows})}catch(e){next(e)}});
app.post('/api/parts/vendors/resolve',auth,async(req,res,next)=>{try{const db=requireDb();const canonical=await resolveVendor(db,req.body?.vendor,true);res.json({canonical})}catch(e){next(e)}});
app.post('/api/parts',auth,managerPermission("inventory"),async(req,res,next)=>{try{const db=requireDb(),b=req.body||{},pn=String(b.partNumber||'').trim();if(!pn)return res.status(400).json({error:'Part number is required.'});const vendor=await resolveVendor(db,b.vendor,true);const key='manual:'+crypto.createHash('sha256').update(pn.toLowerCase()+'|'+Date.now()).digest('hex').slice(0,24);const qty=Math.max(0,Number(b.quantity||0));const r=await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,cost,price,location,vendor,min_qty,max_qty,reorder_point,manufacturer,category,purchase_taxable,sell_taxable,purchase_tax_rate,source_file,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ITTR Manual',$17::jsonb) RETURNING *`,[key,pn,String(b.description||'').trim()||null,qty,Number(b.cost||0),Number(b.price||0),String(b.location||'').trim()||null,vendor||null,Number(b.minQty||0),Number(b.maxQty||0),Number(b.reorderPoint??b.minQty??0),String(b.manufacturer||'').trim()||null,String(b.category||'').trim()||null,b.purchaseTaxable!==false,b.sellTaxable!==false,Number(b.purchaseTaxRate||0),JSON.stringify({createdManually:true})]);const x=r.rows[0];x.internal_barcode=await ensurePartBarcode(db,x.id);if(qty>0)await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username) VALUES($1,'initial_stock',$2,0,$2,'Manual part creation','Initial stock', $3)`,[x.id,qty,req.user.username]);await audit(req.user.username,'part_created',{partId:x.id,partNumber:pn});res.json({ok:true,item:x})}catch(e){next(e)}});
app.get("/api/parts/summary",auth,async(req,res,next)=>{try{const db=requireDb();const r=await db.query(`SELECT count(*)::int total,count(*) FILTER (WHERE coalesce(quantity,0)<=0)::int out_of_stock,count(*) FILTER (WHERE coalesce(quantity,0)>0 AND coalesce(quantity,0)<=coalesce(reorder_point,min_qty,0) AND coalesce(reorder_point,min_qty,0)>0)::int low_stock,coalesce(sum(coalesce(inventory_value,coalesce(quantity,0)*coalesce(cost,0))),0)::numeric inventory_value,coalesce(sum(coalesce(on_order,0)),0)::numeric on_order FROM fullbay_import_parts`);res.json(r.rows[0])}catch(e){next(e)}});
app.get("/api/parts",auth,async(req,res,next)=>{try{
 const q=String(req.query.q||"").trim(),filter=String(req.query.filter||"all"),limit=Math.min(200,Math.max(1,Number(req.query.limit||100))),like=`%${q}%`,prefix=`${q}%`;
 let extra="";
 if(filter==="low")extra=" AND (coalesce(quantity,0)<=0 OR (coalesce(quantity,0)<=coalesce(reorder_point,min_qty,0) AND coalesce(reorder_point,min_qty,0)>0))";
 if(filter==="out")extra=" AND coalesce(quantity,0)<=0";
 if(filter==="order")extra=" AND coalesce(on_order,0)>0";
 const db=requireDb();
 // Search is read-only: missing display barcodes are derived from the part id instead of
 // issuing one SELECT/UPDATE per result. This removes the previous N+1 database pattern.
 const r=await db.query(`SELECT id,part_number,description,status,uom,quantity,allocated,cost,price,min_qty,max_qty,reorder_point,on_order,location,vendor,category,manufacturer,notes,
   coalesce(nullif(internal_barcode,''),'ITTR-P-'||lpad(id::text,6,'0')) internal_barcode,
   barcode_aliases,purchase_taxable,sell_taxable,purchase_tax_rate,updated_at,
   (coalesce(quantity,0)-coalesce(allocated,0)) available
   FROM fullbay_import_parts
   WHERE ($1='' OR coalesce(part_number,'') ILIKE $2 OR coalesce(description,'') ILIKE $2 OR coalesce(manufacturer,'') ILIKE $2 OR coalesce(vendor,'') ILIKE $2 OR coalesce(location,'') ILIKE $2 OR coalesce(internal_barcode,'') ILIKE $2 OR barcode_aliases::text ILIKE $2)
   ${extra}
   ORDER BY CASE
     WHEN lower(coalesce(part_number,''))=lower($1) THEN 0
     WHEN lower(coalesce(internal_barcode,''))=lower($1) THEN 0
     WHEN coalesce(part_number,'') ILIKE $4 THEN 1
     WHEN coalesce(description,'') ILIKE $4 THEN 2
     ELSE 3 END,
     part_number NULLS LAST
   LIMIT $3`,[q,like,limit,prefix]);
 res.json({items:r.rows})
}catch(e){next(e)}});
app.get("/api/parts/scan/:code",auth,async(req,res,next)=>{try{const code=String(req.params.code||"").trim();const db=requireDb();let r=await db.query(`SELECT *,coalesce(quantity,0)-coalesce(allocated,0) available FROM fullbay_import_parts WHERE lower(coalesce(internal_barcode,''))=lower($1) OR lower(coalesce(part_number,''))=lower($1) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(barcode_aliases,'[]'::jsonb)) a WHERE lower(a)=lower($1)) LIMIT 1`,[code]);if(!r.rowCount&&/^ITTR-P-0*([0-9]+)$/i.test(code)){const id=Number(code.match(/^ITTR-P-0*([0-9]+)$/i)[1]);r=await db.query(`SELECT *,coalesce(quantity,0)-coalesce(allocated,0) available FROM fullbay_import_parts WHERE id=$1`,[id])}if(!r.rowCount)return res.status(404).json({error:"Barcode is not assigned to an inventory part."});if(!r.rows[0].internal_barcode)r.rows[0].internal_barcode=await ensurePartBarcode(db,r.rows[0].id);res.json({item:r.rows[0]})}catch(e){next(e)}});

app.post("/api/parts/:id/barcodes",auth,managerPermission("inventory"),async(req,res,next)=>{try{
 const code=String(req.body?.code||'').trim();if(!code)return res.status(400).json({error:'Scan or enter a manufacturer barcode.'});if(code.length>160)return res.status(400).json({error:'Barcode is too long.'});
 const db=requireDb(),id=Number(req.params.id);const cur=await db.query('SELECT id,part_number,internal_barcode,barcode_aliases FROM fullbay_import_parts WHERE id=$1',[id]);if(!cur.rowCount)return res.status(404).json({error:'Part not found.'});
 const conflict=await db.query(`SELECT id,part_number FROM fullbay_import_parts WHERE id<>$1 AND (lower(coalesce(internal_barcode,''))=lower($2) OR lower(coalesce(part_number,''))=lower($2) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(barcode_aliases,'[]'::jsonb)) a WHERE lower(a)=lower($2))) LIMIT 1`,[id,code]);
 if(conflict.rowCount)return res.status(409).json({error:`This barcode is already assigned to part ${conflict.rows[0].part_number||conflict.rows[0].id}.`,code:'BARCODE_CONFLICT'});
 const aliases=Array.isArray(cur.rows[0].barcode_aliases)?cur.rows[0].barcode_aliases.map(String):[];if(!aliases.some(x=>x.toLowerCase()===code.toLowerCase())&&String(cur.rows[0].internal_barcode||'').toLowerCase()!==code.toLowerCase()&&String(cur.rows[0].part_number||'').toLowerCase()!==code.toLowerCase())aliases.push(code);
 await db.query('UPDATE fullbay_import_parts SET barcode_aliases=$2::jsonb,updated_at=now() WHERE id=$1',[id,JSON.stringify(aliases.slice(0,50))]);await audit(req.user.username,'part_barcode_added',{partId:id,code});res.json({ok:true,aliases});
}catch(e){next(e)}});

app.get("/api/parts/inventory-count/current",auth,managerPermission("inventory"),async(req,res,next)=>{try{const db=requireDb();const r=await db.query(`SELECT s.*,count(l.id)::int scanned_parts,count(l.id) FILTER (WHERE l.counted_qty<>l.system_qty)::int variances FROM inventory_count_sessions s LEFT JOIN inventory_count_lines l ON l.session_id=s.id WHERE s.status='open' GROUP BY s.id ORDER BY s.started_at DESC LIMIT 1`);res.json({session:r.rows[0]||null})}catch(e){next(e)}});
app.post("/api/parts/inventory-count",auth,managerPermission("inventory"),async(req,res,next)=>{try{const db=requireDb();const open=await db.query(`SELECT * FROM inventory_count_sessions WHERE status='open' ORDER BY started_at DESC LIMIT 1`);if(open.rowCount)return res.json({ok:true,session:open.rows[0],existing:true});const mode=String(req.body?.mode||'each')==='shelf'?'shelf':'each';const r=await db.query(`INSERT INTO inventory_count_sessions(status,mode,notes,started_by) VALUES('open',$1,$2,$3) RETURNING *`,[mode,String(req.body?.notes||'').trim()||null,req.user.username]);await audit(req.user.username,'inventory_count_started',{sessionId:r.rows[0].id,mode});res.json({ok:true,session:r.rows[0]})}catch(e){next(e)}});
app.get("/api/parts/inventory-count/:sessionId",auth,managerPermission("inventory"),async(req,res,next)=>{try{const db=requireDb();const sr=await db.query('SELECT * FROM inventory_count_sessions WHERE id=$1',[req.params.sessionId]);if(!sr.rowCount)return res.status(404).json({error:'Inventory count session not found.'});const lr=await db.query(`SELECT l.*,p.part_number,p.description,p.location,p.internal_barcode,p.barcode_aliases FROM inventory_count_lines l JOIN fullbay_import_parts p ON p.id=l.part_id WHERE l.session_id=$1 ORDER BY l.updated_at DESC,l.id DESC`,[req.params.sessionId]);res.json({session:sr.rows[0],lines:lr.rows})}catch(e){next(e)}});
app.post("/api/parts/inventory-count/:sessionId/scan",auth,managerPermission("inventory"),async(req,res,next)=>{try{
 const code=String(req.body?.code||'').trim();if(!code)return res.status(400).json({error:'Barcode is required.'});const db=requireDb();const sr=await db.query(`SELECT * FROM inventory_count_sessions WHERE id=$1 AND status='open'`,[req.params.sessionId]);if(!sr.rowCount)return res.status(409).json({error:'This inventory count is no longer open.'});
 let pr=await db.query(`SELECT *,coalesce(quantity,0) system_qty FROM fullbay_import_parts WHERE lower(coalesce(internal_barcode,''))=lower($1) OR lower(coalesce(part_number,''))=lower($1) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(barcode_aliases,'[]'::jsonb)) a WHERE lower(a)=lower($1)) LIMIT 1`,[code]);
 if(!pr.rowCount&&/^ITTR-P-0*([0-9]+)$/i.test(code)){const id=Number(code.match(/^ITTR-P-0*([0-9]+)$/i)[1]);pr=await db.query(`SELECT *,coalesce(quantity,0) system_qty FROM fullbay_import_parts WHERE id=$1`,[id])}
 if(!pr.rowCount)return res.status(404).json({error:'Barcode is not assigned to an inventory part.',code:'UNKNOWN_BARCODE',barcode:code});const p=pr.rows[0],each=sr.rows[0].mode==='each';
 const existing=await db.query('SELECT * FROM inventory_count_lines WHERE session_id=$1 AND part_id=$2',[req.params.sessionId,p.id]);let counted;if(existing.rowCount)counted=each?Number(existing.rows[0].counted_qty||0)+1:Number(existing.rows[0].counted_qty||0);else counted=each?1:Number(p.quantity||0);
 const lr=await db.query(`INSERT INTO inventory_count_lines(session_id,part_id,system_qty,counted_qty,last_barcode,counted_by,first_counted_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,now(),now()) ON CONFLICT(session_id,part_id) DO UPDATE SET counted_qty=$4,last_barcode=$5,counted_by=$6,updated_at=now() RETURNING *`,[req.params.sessionId,p.id,Number(p.quantity||0),counted,code,req.user.username]);res.json({ok:true,part:{id:p.id,part_number:p.part_number,description:p.description,location:p.location,system_qty:Number(p.quantity||0)},line:lr.rows[0],mode:sr.rows[0].mode});
}catch(e){next(e)}});
app.patch("/api/parts/inventory-count/:sessionId/parts/:partId",auth,managerPermission("inventory"),async(req,res,next)=>{try{const qty=Number(req.body?.countedQty);if(!Number.isFinite(qty)||qty<0)return res.status(400).json({error:'Enter a valid physical quantity.'});const db=requireDb();const r=await db.query(`UPDATE inventory_count_lines SET counted_qty=$3,counted_by=$4,updated_at=now() WHERE session_id=$1 AND part_id=$2 RETURNING *`,[req.params.sessionId,req.params.partId,qty,req.user.username]);if(!r.rowCount)return res.status(404).json({error:'Counted part not found in this session.'});res.json({ok:true,line:r.rows[0]})}catch(e){next(e)}});
app.post("/api/parts/inventory-count/:sessionId/complete",auth,managerPermission("inventory"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const sr=await db.query(`SELECT * FROM inventory_count_sessions WHERE id=$1 AND status='open' FOR UPDATE`,[req.params.sessionId]);if(!sr.rowCount){await db.query('ROLLBACK');return res.status(409).json({error:'Inventory count is already closed.'})}const lines=await db.query(`SELECT l.*,p.part_number,p.quantity AS current_qty FROM inventory_count_lines l JOIN fullbay_import_parts p ON p.id=l.part_id WHERE l.session_id=$1 ORDER BY l.id FOR UPDATE`,[req.params.sessionId]);const conflicts=lines.rows.filter(l=>Number(l.current_qty||0)!==Number(l.system_qty||0)).map(l=>({partNumber:l.part_number,was:Number(l.system_qty||0),now:Number(l.current_qty||0)}));if(conflicts.length){await db.query('ROLLBACK');return res.status(409).json({error:`${conflicts.length} counted part(s) changed in inventory after they were counted. Recheck those parts before applying the count.`,code:'COUNT_STOCK_MOVED',conflicts:conflicts.slice(0,20)})}let adjusted=0;for(const l of lines.rows){const before=Number(l.current_qty||0),after=Number(l.counted_qty||0),delta=after-before;if(delta===0)continue;await db.query('UPDATE fullbay_import_parts SET quantity=$2::numeric,inventory_value=($2::numeric*coalesce(cost,0::numeric)),updated_at=now() WHERE id=$1',[l.part_id,after]);await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username,metadata) VALUES($1,'inventory_count',$2,$3,$4,$5,$6,$7,$8::jsonb)`,[l.part_id,delta,before,after,`Inventory Count #${req.params.sessionId}`,'Physical inventory count',req.user.username,JSON.stringify({sessionId:Number(req.params.sessionId),countedFrom:Number(l.system_qty||0)})]);adjusted++}await db.query(`UPDATE inventory_count_sessions SET status='completed',completed_by=$2,completed_at=now() WHERE id=$1`,[req.params.sessionId,req.user.username]);await db.query('COMMIT');await audit(req.user.username,'inventory_count_completed',{sessionId:req.params.sessionId,lines:lines.rowCount,adjusted});res.json({ok:true,lines:lines.rowCount,adjusted})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post("/api/parts/inventory-count/:sessionId/cancel",auth,managerPermission("inventory"),async(req,res,next)=>{try{const r=await requireDb().query(`UPDATE inventory_count_sessions SET status='cancelled',completed_by=$2,completed_at=now() WHERE id=$1 AND status='open' RETURNING id`,[req.params.sessionId,req.user.username]);res.json({ok:true,cancelled:Boolean(r.rowCount)})}catch(e){next(e)}});

app.get("/api/parts/:id",auth,async(req,res,next)=>{try{const db=requireDb();const r=await db.query(`SELECT *,coalesce(quantity,0)-coalesce(allocated,0) available FROM fullbay_import_parts WHERE id=$1`,[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Part not found."});r.rows[0].internal_barcode=await ensurePartBarcode(db,r.rows[0].id);const tx=await db.query("SELECT * FROM part_inventory_transactions WHERE part_id=$1 ORDER BY created_at DESC LIMIT 100",[req.params.id]);res.json({item:r.rows[0],transactions:tx.rows})}catch(e){next(e)}});
app.get("/api/parts/:id/barcode.svg",auth,async(req,res,next)=>{try{const db=requireDb(),code=await ensurePartBarcode(db,req.params.id);if(!code)return res.status(404).send("Part not found");const svg=bwipjs.toSVG({bcid:"code128",text:code,scale:3,height:12,includetext:false});res.type("image/svg+xml").send(svg)}catch(e){next(e)}});
app.patch("/api/parts/:id",auth,managerPermission("inventory"),async(req,res,next)=>{try{const db=requireDb(),cur=await db.query("SELECT * FROM fullbay_import_parts WHERE id=$1",[req.params.id]);if(!cur.rowCount)return res.status(404).json({error:"Part not found."});const c=cur.rows[0],aliases=Array.isArray(req.body?.barcodeAliases)?req.body.barcodeAliases.map(x=>String(x||"").trim()).filter(Boolean).slice(0,20):(Array.isArray(c.barcode_aliases)?c.barcode_aliases:[]);const val=(k,old)=>Object.prototype.hasOwnProperty.call(req.body||{},k)?String(req.body[k]??"").trim()||null:old,num=(k,old)=>Object.prototype.hasOwnProperty.call(req.body||{},k)?(Number.isFinite(Number(req.body[k]))?Number(req.body[k]):null):old;const vendorRaw=val("vendor",c.vendor),vendor=vendorRaw?await resolveVendor(db,vendorRaw,true):null;const bool=(k,old)=>Object.prototype.hasOwnProperty.call(req.body||{},k)?Boolean(req.body[k]):old;const vals=[val("location",c.location),vendor,num("minQty",c.min_qty),num("maxQty",c.max_qty),num("reorderPoint",c.reorder_point),JSON.stringify(aliases),num("price",c.price),bool("purchaseTaxable",c.purchase_taxable),bool("sellTaxable",c.sell_taxable),num("purchaseTaxRate",c.purchase_tax_rate),req.params.id];const r=await db.query(`UPDATE fullbay_import_parts SET location=$1,vendor=$2,min_qty=$3,max_qty=$4,reorder_point=$5,barcode_aliases=$6::jsonb,price=$7,purchase_taxable=$8,sell_taxable=$9,purchase_tax_rate=$10,updated_at=now() WHERE id=$11 RETURNING *`,vals);await audit(req.user.username,"part_profile_updated",{partId:req.params.id});res.json({ok:true,item:r.rows[0]})}catch(e){next(e)}});
app.post("/api/parts/:id/transaction",auth,async(req,res,next)=>{const db=await requireDb().connect();try{const type=String(req.body?.type||"").toLowerCase(),qty=Math.abs(Number(req.body?.qty||0));if(!qty||qty>999999)return res.status(400).json({error:"Enter a valid quantity."});if(!["receive","return","adjust_add","adjust_remove"].includes(type))return res.status(400).json({error:"Unsupported inventory transaction."});if(req.user.role!=="admin"&&!(["return"].includes(type)))return res.status(403).json({error:"Admin access required."});const delta=["receive","return","adjust_add"].includes(type)?qty:-qty;await db.query("BEGIN");const r=await db.query("SELECT * FROM fullbay_import_parts WHERE id=$1 FOR UPDATE",[req.params.id]);if(!r.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Part not found."})}const before=Number(r.rows[0].quantity||0),after=before+delta;if(after<0){await db.query("ROLLBACK");return res.status(409).json({error:`Only ${before} in stock.`})}await db.query("UPDATE fullbay_import_parts SET quantity=$2::numeric,inventory_value=($2::numeric*coalesce(cost,0::numeric)),updated_at=now() WHERE id=$1",[req.params.id,after]);await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[req.params.id,type,delta,before,after,String(req.body?.reference||"").trim()||null,String(req.body?.reason||"").trim()||null,req.user.username,JSON.stringify({method:req.body?.method||"manual"})]);await db.query("COMMIT");await audit(req.user.username,"inventory_transaction",{partId:req.params.id,type,delta});res.json({ok:true,quantity:after})}catch(e){try{await db.query("ROLLBACK")}catch{}next(e)}finally{db.release()}});
app.get("/api/fullbay/parts",auth,async(req,res,next)=>{try{
 const q=String(req.query.q||"").trim(),limit=Math.min(200,Math.max(1,Number(req.query.limit)||50)),offset=Math.max(0,Number(req.query.offset)||0),like=`%${q}%`;
 const r=await requireDb().query(`SELECT id,part_number,description,status,uom,quantity,allocated,cost,price,min_qty,max_qty,location,vendor,track_quantity,category,cost_floor,inventory_value,inventory_balance,manufacturer,notes,updated_at FROM fullbay_import_parts WHERE $1='' OR coalesce(part_number,'') ILIKE $2 OR coalesce(description,'') ILIKE $2 OR coalesce(vendor,'') ILIKE $2 OR coalesce(manufacturer,'') ILIKE $2 OR coalesce(category,'') ILIKE $2 ORDER BY CASE WHEN lower(coalesce(part_number,'')) LIKE lower($3) THEN 0 ELSE 1 END,part_number NULLS LAST,description LIMIT $4 OFFSET $5`,[q,like,`${q}%`,limit,offset]);
 const c=await requireDb().query(`SELECT count(*)::int n FROM fullbay_import_parts WHERE $1='' OR coalesce(part_number,'') ILIKE $2 OR coalesce(description,'') ILIKE $2 OR coalesce(vendor,'') ILIKE $2 OR coalesce(manufacturer,'') ILIKE $2 OR coalesce(category,'') ILIKE $2`,[q,like]);res.json({items:r.rows,total:c.rows[0].n,limit,offset});
}catch(e){next(e)}});

app.get("/api/fullbay/parts/:id",auth,async(req,res,next)=>{try{const r=await requireDb().query(`SELECT * FROM fullbay_import_parts WHERE id=$1`,[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Part not found."});res.json({item:r.rows[0]});}catch(e){next(e)}});



function normCustomerName(v){return String(v||"").trim().toLowerCase()}
async function getCoreState(){
 const rows=await requireDb().query("SELECT state_key,payload FROM app_state WHERE state_key IN ('shopflow','pro')");
 const out={shopflow:{workorders:[],issues:[]},pro:{vehicles:[]}};for(const r of rows)out[r.state_key]=r.payload||out[r.state_key];return out;
}
async function findCustomerByName(name){
 if(!name)return null;const q=await requireDb().query("SELECT * FROM fullbay_import_customers WHERE lower(customer_name)=lower($1) ORDER BY id LIMIT 1",[String(name).trim()]);return q.rows[0]||null;
}
async function upsertDirectoryUnit(db,{customerId=null,customerName="",unit="",vin="",year="",make="",model="",plate="",mileage=null,engine="",transmission="",notes="",source="state"}){
 unit=String(unit||"").trim();if(!unit)return null;
 let cid=(String(customerId??"").trim().match(/^\d+$/)?Number(customerId):null),cname=String(customerName||"").trim();
 // Never trust a numeric customerId from legacy WO/state as an internal CRM primary key.
 // Older records can contain Fullbay/external IDs. Validate it first so FK errors cannot block unit sync.
 if(cid){const c=await db.query("SELECT id,customer_name FROM fullbay_import_customers WHERE id=$1 LIMIT 1",[cid]);if(c.rowCount){cid=c.rows[0].id;cname=c.rows[0].customer_name||cname}else cid=null}
 if(!cid&&cname){const c=await db.query("SELECT id,customer_name FROM fullbay_import_customers WHERE lower(trim(customer_name))=lower(trim($1)) ORDER BY id LIMIT 1",[cname]);if(c.rowCount){cid=c.rows[0].id;cname=c.rows[0].customer_name}}
 const existing=await db.query(`SELECT * FROM customer_units WHERE lower(coalesce(unit_number,''))=lower($1) AND ((customer_id::text=$2::text) OR ($2::text IS NULL AND customer_id IS NULL AND lower(coalesce(customer_name,''))=lower($3))) ORDER BY id LIMIT 1`,[unit,cid,cname]);
 const vals=[cid,cname||null,unit,String(vin||"").trim().toUpperCase()||null,String(year||"").trim()||null,String(make||"").trim()||null,String(model||"").trim()||null,String(plate||"").trim()||null,Number.isFinite(Number(mileage))?Number(mileage):null,String(engine||"").trim()||null,String(transmission||"").trim()||null,String(notes||"").trim()||null,String(source||"state")];
 if(existing.rowCount){const old=existing.rows[0];const r=await db.query(`UPDATE customer_units SET customer_id=coalesce($1,customer_id),customer_name=coalesce(nullif($2,''),customer_name),unit_number=coalesce(nullif($3,''),unit_number),vin=coalesce(nullif($4,''),vin),year=coalesce(nullif($5,''),year),make=coalesce(nullif($6,''),make),model=coalesce(nullif($7,''),model),plate=coalesce(nullif($8,''),plate),mileage=coalesce($9,mileage),engine=coalesce(nullif($10,''),engine),transmission=coalesce(nullif($11,''),transmission),notes=CASE WHEN source='manual' THEN notes ELSE coalesce(nullif($12,''),notes) END,source=CASE WHEN source='manual' THEN source ELSE coalesce(nullif($13,''),source) END,updated_at=now() WHERE id=$14 RETURNING *`,[...vals,old.id]);return r.rows[0]}
 const r=await db.query(`INSERT INTO customer_units(customer_id,customer_name,unit_number,vin,year,make,model,plate,mileage,engine,transmission,notes,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,vals);return r.rows[0];
}
let lastCustomerUnitDirectorySync=0;
async function syncCustomerUnitDirectory(force=false){
 if(!force && Date.now()-lastCustomerUnitDirectorySync<60000)return {ok:true,skipped:true,errors:[]};
 const db=requireDb(),core=await getCoreState(),vehicles=(Array.isArray(core.pro?.vehicles)?core.pro.vehicles:[]).filter(v=>v&&typeof v==="object"),workorders=(Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders:[]).filter(w=>w&&typeof w==="object");
 const errors=[];
 for(const v of vehicles){try{await upsertDirectoryUnit(db,{customerName:v.customer,unit:v.unit,vin:v.vin,year:v.year,make:v.make,model:v.model,plate:v.plate,mileage:v.mileage,engine:v.engine,transmission:v.transmission,notes:v.notes,source:"vehicle_profile"})}catch(e){errors.push({source:"vehicle_profile",unit:String(v?.unit||""),error:String(e?.message||e).slice(0,220)});console.error("Customer unit sync skipped vehicle profile",v?.unit,e?.message)}}
 for(const w of workorders){try{await upsertDirectoryUnit(db,{customerId:w.customerId||null,customerName:w.customer,unit:w.unit,vin:w.vin,year:w.year,make:w.make,model:w.model,plate:w.plate,mileage:w.mileage,source:"work_order"})}catch(e){errors.push({source:"work_order",unit:String(w?.unit||""),workOrderId:String(w?.id||""),error:String(e?.message||e).slice(0,220)});console.error("Customer unit sync skipped work order",w?.id,w?.unit,e?.message)}}
 if(errors.length===0)lastCustomerUnitDirectorySync=Date.now();
 return {ok:errors.length===0,skipped:false,errors};
}
function cleanUsdot(value){return String(value||"").replace(/\D/g,"").slice(0,10)}
function fmcsaCarrierFromPayload(payload){
 const candidates=[payload?.content?.carrier,payload?.carrier,payload?.content,payload];
 return candidates.find(x=>x&&typeof x==="object"&&!Array.isArray(x)&&(x.legalName||x.dotNumber||x.phyStreet))||null;
}
function nOrNull(v){const n=Number(v);return Number.isFinite(n)?n:null}
function normalizeFmcsaCarrier(raw,dot){
 if(!raw)return null;
 const pick=(...keys)=>{for(const k of keys){if(raw[k]!==undefined&&raw[k]!==null&&String(raw[k]).trim()!=="")return raw[k]}return null};
 return {
  dotNumber:String(pick("dotNumber","usdotNumber")||dot||""),
  legalName:String(pick("legalName")||""),dbaName:String(pick("dbaName")||""),mcNumber:String(pick("mcNumber")||""),
  address:String(pick("phyStreet","physicalAddress")||""),city:String(pick("phyCity")||""),state:String(pick("phyState")||""),zip:String(pick("phyZip")||""),country:String(pick("phyCountry")||""),phone:String(pick("telephone")||""),
  allowedToOperate:String(pick("allowToOperate")||""),outOfService:String(pick("outOfService")||""),outOfServiceDate:String(pick("outOfServiceDate")||""),
  powerUnits:nOrNull(pick("totalPowerUnits","powerUnits","nbrPowerUnit")),drivers:nOrNull(pick("totalDrivers","drivers","driverTotal")),
  entityType:String(pick("carrierOperation","entityType")||""),mcs150Date:String(pick("mcs150UpdateDate","mcs150Date")||""),raw
 };
}
async function lookupFmcsaCarrier(dot){
 const usdot=cleanUsdot(dot);if(!usdot)throw Object.assign(new Error("Enter a valid USDOT number."),{status:400});
 if(!FMCSA_WEBKEY)throw Object.assign(new Error("FMCSA integration is not configured. Add FMCSA_WEBKEY in Railway Variables."),{status:503,code:"FMCSA_NOT_CONFIGURED"});
 const cached=fmcsaCache.get(usdot);if(cached&&Date.now()-cached.at<15*60*1000)return cached.data;
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),10000);
 try{
  const url=`${FMCSA_API_BASE}/carriers/${encodeURIComponent(usdot)}?webKey=${encodeURIComponent(FMCSA_WEBKEY)}`;
  const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"ITTR-ShopFlow/23.10"},signal:ctl.signal});
  let data=null;try{data=await r.json()}catch{}
  if(r.status===404)throw Object.assign(new Error(`No FMCSA carrier found for USDOT ${usdot}.`),{status:404,code:"FMCSA_NOT_FOUND"});
  if(r.status===401||r.status===403)throw Object.assign(new Error("FMCSA rejected the WebKey. Check FMCSA_WEBKEY in Railway."),{status:502,code:"FMCSA_AUTH"});
  if(!r.ok)throw Object.assign(new Error(`FMCSA service returned ${r.status}. Try again shortly.`),{status:502,code:"FMCSA_UPSTREAM"});
  const carrier=fmcsaCarrierFromPayload(data),normalized=normalizeFmcsaCarrier(carrier,usdot);
  if(!normalized||(!normalized.legalName&&!normalized.dotNumber))throw Object.assign(new Error(`FMCSA returned no carrier record for USDOT ${usdot}.`),{status:404,code:"FMCSA_EMPTY"});
  fmcsaCache.set(usdot,{at:Date.now(),data:normalized});return normalized;
 }catch(e){if(e?.name==="AbortError")throw Object.assign(new Error("FMCSA lookup timed out. Try again."),{status:504,code:"FMCSA_TIMEOUT"});throw e}finally{clearTimeout(timer)}
}
app.get("/api/fmcsa/status",auth,managerPermission("customers"),(req,res)=>res.json({configured:Boolean(FMCSA_WEBKEY),provider:"FMCSA QCMobile / SAFER",official:true}));
app.get("/api/fmcsa/carriers/:dotNumber",auth,managerPermission("customers"),async(req,res)=>{try{const item=await lookupFmcsaCarrier(req.params.dotNumber);res.json({item,source:"FMCSA QCMobile API",official:true,checkedAt:new Date().toISOString()})}catch(e){res.status(e.status||500).json({error:e.message||"FMCSA lookup failed.",code:e.code||"FMCSA_LOOKUP"})}});
function cleanVin(value){return String(value||"").trim().toUpperCase().replace(/\s+/g,"")}
function vinCoreValid(vin){return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)}
function textOrEmpty(v){return v==null?"":String(v).trim()}
function normalizeNhtsaVin(raw,vin){
 const transmission=[textOrEmpty(raw.TransmissionStyle),raw.TransmissionSpeeds?`${textOrEmpty(raw.TransmissionSpeeds)}-speed`:""].filter(Boolean).join(" ").trim();
 const engineParts=[];
 if(raw.EngineManufacturer)engineParts.push(textOrEmpty(raw.EngineManufacturer));
 if(raw.EngineModel)engineParts.push(textOrEmpty(raw.EngineModel));
 if(raw.DisplacementL)engineParts.push(`${textOrEmpty(raw.DisplacementL)}L`);
 if(raw.EngineCylinders)engineParts.push(`${textOrEmpty(raw.EngineCylinders)} cyl`);
 const errorCode=textOrEmpty(raw.ErrorCode),errorText=textOrEmpty(raw.ErrorText);
 return {
  vin,
  year:textOrEmpty(raw.ModelYear),make:textOrEmpty(raw.Make),model:textOrEmpty(raw.Model),manufacturer:textOrEmpty(raw.Manufacturer),
  vehicleType:textOrEmpty(raw.VehicleType),bodyClass:textOrEmpty(raw.BodyClass),series:textOrEmpty(raw.Series),trim:textOrEmpty(raw.Trim),cabType:textOrEmpty(raw.CabType),
  gvwr:textOrEmpty(raw.GVWR),driveType:textOrEmpty(raw.DriveType),fuelType:textOrEmpty(raw.FuelTypePrimary),
  engine:engineParts.join(" ").trim(),engineManufacturer:textOrEmpty(raw.EngineManufacturer),engineModel:textOrEmpty(raw.EngineModel),engineCylinders:textOrEmpty(raw.EngineCylinders),displacementL:textOrEmpty(raw.DisplacementL),
  transmission,transmissionStyle:textOrEmpty(raw.TransmissionStyle),transmissionSpeeds:textOrEmpty(raw.TransmissionSpeeds),
  plantCity:textOrEmpty(raw.PlantCity),plantState:textOrEmpty(raw.PlantState),plantCountry:textOrEmpty(raw.PlantCountry),
  errorCode,errorText,valid:errorCode==="0" || (!errorCode && Boolean(raw.Make||raw.ModelYear)),raw
 };
}
async function lookupNhtsaVin(value){
 const vin=cleanVin(value);
 if(!vinCoreValid(vin))throw Object.assign(new Error("Enter a valid 17-character VIN. VINs cannot contain I, O, or Q."),{status:400,code:"VIN_INVALID"});
 const cached=vinDecodeCache.get(vin);if(cached&&Date.now()-cached.at<24*60*60*1000)return cached.data;
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),10000);
 try{
  const url=`${NHTSA_VPIC_BASE}/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
  const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"ITTR-ShopFlow/23.10"},signal:ctl.signal});
  if(!r.ok)throw Object.assign(new Error(`NHTSA VIN service returned ${r.status}. Try again shortly.`),{status:502,code:"NHTSA_UPSTREAM"});
  const data=await r.json(),raw=Array.isArray(data?.Results)?data.Results[0]:null;
  if(!raw)throw Object.assign(new Error("NHTSA returned no VIN decode record."),{status:502,code:"NHTSA_EMPTY"});
  const item=normalizeNhtsaVin(raw,vin);
  if(!item.year&&!item.make&&!item.model)throw Object.assign(new Error(item.errorText||"NHTSA could not identify this VIN."),{status:422,code:"VIN_NOT_DECODED",details:item});
  vinDecodeCache.set(vin,{at:Date.now(),data:item});return item;
 }catch(e){if(e?.name==="AbortError")throw Object.assign(new Error("NHTSA VIN lookup timed out. Try again."),{status:504,code:"NHTSA_TIMEOUT"});throw e}finally{clearTimeout(timer)}
}
app.get("/api/vin/status",auth,(req,res)=>res.json({configured:true,provider:"NHTSA vPIC",official:true,keyRequired:false}));
app.get("/api/vin/:vin",auth,async(req,res)=>{try{const item=await lookupNhtsaVin(req.params.vin);res.json({item,source:"NHTSA vPIC",official:true,decodedAt:new Date().toISOString()})}catch(e){res.status(e.status||500).json({error:e.message||"VIN decode failed.",code:e.code||"VIN_LOOKUP",details:e.details||undefined})}});
function customerPublic(row){if(!row)return null;const x={...row};delete x.raw;return x}
app.get("/api/customers",auth,managerPermission("customers"),async(req,res)=>{
 const warnings=[];
 try{
  const q=String(req.query.q||"").trim(),like=`%${q}%`,db=requireDb();
  // Reconcile before counting so the Customers page reflects newly saved Vehicle Profiles immediately.
  // Individual bad legacy records are isolated inside syncCustomerUnitDirectory and returned as warnings.
  try{
   const syncResult=await syncCustomerUnitDirectory(false);
   if(syncResult?.errors?.length)warnings.push(`Unit reconciliation skipped ${syncResult.errors.length} legacy record(s). Run Diagnostics for details.`);
  }catch(e){warnings.push(`Unit reconciliation failed (${e.code||"SYNC"}).`);console.error("Customer/unit reconciliation warning:",e)}
  // Customer list must never depend on the unit-directory table being perfect.
  const rows=await db.query(`SELECT c.* FROM fullbay_import_customers c WHERE $1::text='' OR c.customer_name ILIKE $2::text OR coalesce(c.phone,'') ILIKE $2::text OR coalesce(c.email,'') ILIKE $2::text OR coalesce(c.dot_number,'') ILIKE $2::text OR coalesce(c.city,'') ILIKE $2::text ORDER BY c.active DESC NULLS LAST,c.customer_name LIMIT 500`,[q,like]);
  const unitCounts=new Map();
  try{
   const ur=await db.query(`SELECT customer_id::text AS customer_id,customer_name FROM customer_units`);
   for(const u of ur.rows){const key=u.customer_id?`id:${u.customer_id}`:`name:${normCustomerName(u.customer_name)}`;unitCounts.set(key,(unitCounts.get(key)||0)+1)}
  }catch(e){warnings.push(`Unit directory unavailable (${e.code||"DB"}).`);console.error("Customer list unit-count warning:",e)}
  let workorders=[];const importedServiceCounts=new Map();
  try{const core=await getCoreState();workorders=(Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders:[]).filter(w=>w&&typeof w==="object")}
  catch(e){warnings.push(`ITTR service history unavailable (${e.code||"DB"}).`);console.error("Customer list history warning:",e)}
  try{const sr=await db.query(`SELECT customer_id::text AS customer_id,lower(customer_name) AS customer_name,count(DISTINCT service_order)::int AS n FROM fullbay_service_history GROUP BY customer_id,lower(customer_name)`);for(const x of sr.rows){if(x.customer_id)importedServiceCounts.set(`id:${x.customer_id}`,Number(x.n||0));else importedServiceCounts.set(`name:${x.customer_name}`,Number(x.n||0))}}catch(e){warnings.push(`Imported Fullbay history unavailable (${e.code||"DB"}).`);console.error("Customer list imported history warning:",e)}
  const items=rows.rows.map(r=>{
   const keyById=`id:${String(r.id)}`,keyByName=`name:${normCustomerName(r.customer_name)}`;
   const unit_count=(unitCounts.get(keyById)||0)+(unitCounts.get(keyByName)||0);
   const service_count=workorders.filter(w=>String(w?.customerId||"")===String(r.id)||normCustomerName(w?.customer)===normCustomerName(r.customer_name)).length+(importedServiceCounts.get(keyById)||importedServiceCounts.get(keyByName)||0);
   return {...customerPublic(r),unit_count,service_count};
  });
  res.json({items,total:items.length,warnings});
 }catch(e){console.error("Customer directory fatal error:",e);res.status(500).json({error:`Customer directory database error${e?.code?` [${e.code}]`:""}.`,code:e?.code||"CUSTOMER_DIRECTORY"})}
});
app.post("/api/customers",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const b=req.body||{},name=String(b.customer_name||"").trim();if(!name)return res.status(400).json({error:"Customer / company name is required."});
 const key=`manual:${crypto.randomUUID()}`;const r=await requireDb().query(`INSERT INTO fullbay_import_customers(source_key,customer_name,phone,secondary_phone,email,dot_number,address,city,state,postal_code,country,contact_name,notes,active,source_file) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,'ITTR manual') RETURNING *`,[key,name,b.phone||null,b.secondary_phone||null,b.email||null,b.dot_number||null,b.address||null,b.city||null,b.state||null,b.postal_code||null,b.country||null,b.contact_name||null,b.notes||null]);if(b.fmcsa_checked_at){await requireDb().query(`UPDATE fullbay_import_customers SET fmcsa_dba_name=$2,fmcsa_mc_number=$3,fmcsa_allowed_to_operate=$4,fmcsa_out_of_service=$5,fmcsa_power_units=$6,fmcsa_drivers=$7,fmcsa_snapshot=$8::jsonb,fmcsa_last_checked=$9 WHERE id=$1`,[r.rows[0].id,b.fmcsa_dba_name||null,b.fmcsa_mc_number||null,b.fmcsa_allowed_to_operate||null,b.fmcsa_out_of_service||null,nOrNull(b.fmcsa_power_units),nOrNull(b.fmcsa_drivers),JSON.stringify(b.fmcsa_snapshot||{}),b.fmcsa_checked_at]);const rr=await requireDb().query("SELECT * FROM fullbay_import_customers WHERE id=$1",[r.rows[0].id]);r.rows[0]=rr.rows[0]}await audit(req.user.username,"customer_created",{customerId:r.rows[0].id,name});res.json({item:customerPublic(r.rows[0])});
}catch(e){next(e)}});
app.put("/api/customers/:id",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const b=req.body||{},name=String(b.customer_name||"").trim();if(!name)return res.status(400).json({error:"Customer / company name is required."});
 const r=await requireDb().query(`UPDATE fullbay_import_customers SET customer_name=$2,contact_name=$3,phone=$4,secondary_phone=$5,email=$6,dot_number=$7,address=$8,city=$9,state=$10,postal_code=$11,country=$12,billing_contact=$13,billing_address=$14,billing_city=$15,billing_state=$16,billing_postal_code=$17,credit_terms=$18,credit_limit=$19,payment_method=$20,notes=$21,active=$22,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,name,b.contact_name||null,b.phone||null,b.secondary_phone||null,b.email||null,b.dot_number||null,b.address||null,b.city||null,b.state||null,b.postal_code||null,b.country||null,b.billing_contact||null,b.billing_address||null,b.billing_city||null,b.billing_state||null,b.billing_postal_code||null,b.credit_terms||null,numOrNull(b.credit_limit),b.payment_method||null,b.notes||null,b.active!==false]);if(!r.rowCount)return res.status(404).json({error:"Customer not found."});if(b.fmcsa_checked_at){await requireDb().query(`UPDATE fullbay_import_customers SET fmcsa_dba_name=$2,fmcsa_mc_number=$3,fmcsa_allowed_to_operate=$4,fmcsa_out_of_service=$5,fmcsa_power_units=$6,fmcsa_drivers=$7,fmcsa_snapshot=$8::jsonb,fmcsa_last_checked=$9 WHERE id=$1`,[req.params.id,b.fmcsa_dba_name||null,b.fmcsa_mc_number||null,b.fmcsa_allowed_to_operate||null,b.fmcsa_out_of_service||null,nOrNull(b.fmcsa_power_units),nOrNull(b.fmcsa_drivers),JSON.stringify(b.fmcsa_snapshot||{}),b.fmcsa_checked_at]);const rr=await requireDb().query("SELECT * FROM fullbay_import_customers WHERE id=$1",[req.params.id]);r.rows[0]=rr.rows[0]}try{await requireDb().query("UPDATE customer_units SET customer_name=$2,updated_at=now() WHERE customer_id::text=$1::text",[req.params.id,name])}catch(e){console.error("Customer unit-name sync warning:",e?.message)};await audit(req.user.username,"customer_updated",{customerId:req.params.id,name});res.json({item:customerPublic(r.rows[0])});
}catch(e){next(e)}});
app.get("/api/customers/:id/profile",auth,managerPermission("customers"),async(req,res)=>{
 const warnings=[];
 try{
  const db=requireDb();syncCustomerUnitDirectory().catch(e=>console.error("Customer profile sync warning:",e?.message));
  const c=await db.query("SELECT * FROM fullbay_import_customers WHERE id::text=$1::text",[req.params.id]);if(!c.rowCount)return res.status(404).json({error:"Customer not found."});const customer=c.rows[0];
  let units=[];
  try{const ur=await db.query(`SELECT * FROM customer_units WHERE customer_id::text=$1::text OR (customer_id IS NULL AND lower(coalesce(customer_name,''))=lower($2::text)) ORDER BY unit_number`,[customer.id,customer.customer_name]);units=ur.rows}
  catch(e){warnings.push(`Unit directory unavailable (${e.code||"DB"}).`);console.error("Customer profile unit warning:",e)}
  let workorders=[];
  try{const core=await getCoreState();workorders=(Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders:[]).filter(w=>w&&typeof w==="object"&& (String(w?.customerId||"")===String(customer.id)||normCustomerName(w?.customer)===normCustomerName(customer.customer_name))).sort((a,b)=>String(b?.completedAt||b?.date||"").localeCompare(String(a?.completedAt||a?.date||"")))}
  catch(e){warnings.push(`Service history unavailable (${e.code||"DB"}).`);console.error("Customer profile history warning:",e)}
  const ittrHistory=workorders.slice(0,300).map(w=>({source:"ittr",id:w?.id,unit:w?.unit,date:w?.date,time:w?.time,status:w?.status,completedAt:w?.completedAt,mechanic:w?.mechanic,helpers:Array.isArray(w?.helpers)?w.helpers:[],tasks:(Array.isArray(w?.tasks)?w.tasks:[]).filter(Boolean).map(t=>({t:t?.t,done:t?.done,outcome:t?.outcome,outcomeNote:t?.outcomeNote})),notes:w?.notes,completionNotes:w?.completionNotes,futureNotes:w?.futureNotes,revisitMiles:w?.revisitMiles,vin:w?.vin,year:w?.year,make:w?.make,model:w?.model,plate:w?.plate,mileage:w?.mileage}));
  let fullbayHistory=[];try{const sr=await db.query(`SELECT service_order,invoice_number,unit_number,vin,max(action_completed_at) completed_at,max(unit_miles) unit_miles,max(lead_tech) lead_tech,max(tech) tech,sum(coalesce(hours,0)) hours,sum(coalesce(labor_amount,0)) labor_amount,sum(coalesce(part_amount,0)) part_amount,sum(coalesce(total_amount,0)) total_amount,json_agg(json_build_object('action',action_number,'complaint',complaint,'correction',actual_correction,'hours',hours,'component',component,'system',system,'tech',tech,'laborAmount',labor_amount,'partAmount',part_amount,'totalAmount',total_amount) ORDER BY action_completed_at,action_number) actions FROM fullbay_service_history WHERE customer_id::text=$1::text OR (customer_id IS NULL AND lower(customer_name)=lower($2)) GROUP BY service_order,invoice_number,unit_number,vin ORDER BY max(action_completed_at) DESC NULLS LAST LIMIT 1000`,[customer.id,customer.customer_name]);fullbayHistory=sr.rows.map(x=>({source:"fullbay",id:x.service_order,invoice:x.invoice_number,unit:x.unit_number,vin:x.vin,completedAt:x.completed_at,status:"Completed (Fullbay)",mechanic:x.tech||x.lead_tech||"",mileage:x.unit_miles,hours:Number(x.hours||0),laborAmount:Number(x.labor_amount||0),partAmount:Number(x.part_amount||0),totalAmount:Number(x.total_amount||0),tasks:(Array.isArray(x.actions)?x.actions:[]).map(a=>({t:a.complaint||a.correction||`Action ${a.action||""}`,done:true,outcome:"Completed",outcomeNote:a.correction||"",hours:a.hours,component:a.component,system:a.system,tech:a.tech,laborAmount:Number(a.laborAmount||0),partAmount:Number(a.partAmount||0),totalAmount:Number(a.totalAmount||0)}))}))}catch(e){warnings.push(`Imported Fullbay history unavailable (${e.code||"DB"}).`);console.error("Customer profile Fullbay history warning:",e)}
  const history=[...ittrHistory,...fullbayHistory].sort((a,b)=>new Date(b.completedAt||b.date||0)-new Date(a.completedAt||a.date||0)).slice(0,1200);
  res.json({customer:customerPublic(customer),units,history,warnings});
 }catch(e){console.error("Customer profile fatal error:",e);res.status(500).json({error:`Customer profile database error${e?.code?` [${e.code}]`:""}.`,code:e?.code||"CUSTOMER_PROFILE"})}
});
app.post("/api/customers/:id/units",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const db=requireDb(),c=await db.query("SELECT id,customer_name FROM fullbay_import_customers WHERE id::text=$1::text",[req.params.id]);if(!c.rowCount)return res.status(404).json({error:"Customer not found."});const b=req.body||{};if(!String(b.unit_number||"").trim())return res.status(400).json({error:"Unit number is required."});const item=await upsertDirectoryUnit(db,{customerId:c.rows[0].id,customerName:c.rows[0].customer_name,unit:cleanFullbayCell(b.unit_number),vin:cleanFullbayCell(b.vin),year:cleanFullbayCell(b.year),make:cleanFullbayCell(b.make),model:cleanFullbayCell(b.model),plate:cleanFullbayCell(b.plate),mileage:b.mileage,engine:cleanFullbayCell(b.engine),transmission:cleanFullbayCell(b.transmission),notes:cleanFullbayCell(b.notes),source:"manual"});await audit(req.user.username,"customer_unit_saved",{customerId:req.params.id,unit:item.unit_number});res.json({item});
}catch(e){next(e)}});
app.put("/api/customer-units/:id",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const b=req.body||{},unit=cleanFullbayCell(b.unit_number);if(!unit)return res.status(400).json({error:"Unit number is required."});const r=await requireDb().query(`UPDATE customer_units SET unit_number=$2,vin=$3,year=$4,make=$5,model=$6,plate=$7,mileage=$8,engine=$9,transmission=$10,notes=$11,source='manual',updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,unit,cleanFullbayCell(b.vin).toUpperCase()||null,cleanFullbayCell(b.year)||null,cleanFullbayCell(b.make)||null,cleanFullbayCell(b.model)||null,cleanFullbayCell(b.plate)||null,Number.isFinite(Number(b.mileage))?Number(b.mileage):null,cleanFullbayCell(b.engine)||null,cleanFullbayCell(b.transmission)||null,cleanFullbayCell(b.notes)||null]);if(!r.rowCount)return res.status(404).json({error:"Unit not found."});res.json({item:r.rows[0]});
}catch(e){next(e)}});
app.delete("/api/customer-units/:id",auth,managerPermission("customers"),async(req,res,next)=>{try{await requireDb().query("DELETE FROM customer_units WHERE id=$1",[req.params.id]);res.json({ok:true})}catch(e){next(e)}});
app.post("/api/customer-units/from-vehicle-profile",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const b=req.body||{},unit=String(b.unit||b.unit_number||"").trim();if(!unit)return res.status(400).json({error:"Unit number is required."});
 const db=requireDb();let customerId=null,customerName=String(b.customer||b.customer_name||"").trim();
 if(customerName){const c=await db.query("SELECT id,customer_name FROM fullbay_import_customers WHERE lower(trim(customer_name))=lower(trim($1)) ORDER BY id LIMIT 1",[customerName]);if(c.rowCount){customerId=c.rows[0].id;customerName=c.rows[0].customer_name}}
 const item=await upsertDirectoryUnit(db,{customerId,customerName,unit,vin:b.vin,year:b.year,make:b.make,model:b.model,plate:b.plate,mileage:b.mileage,engine:b.engine,transmission:b.transmission,notes:b.notes,source:"vehicle_profile"});
 if(!item)return res.status(500).json({error:"Unit directory did not save the vehicle."});
 const verify=await db.query("SELECT * FROM customer_units WHERE id=$1",[item.id]);if(!verify.rowCount)return res.status(500).json({error:"Unit save could not be verified."});
 await audit(req.user.username,"vehicle_profile_unit_synced",{unit:item.unit_number,customerId:item.customer_id,customerName:item.customer_name});res.json({ok:true,item:verify.rows[0],matchedCustomer:Boolean(item.customer_id)});
}catch(e){next(e)}});

app.post("/api/customer-units/decode-missing-vins",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const db=requireDb(),limit=Math.max(1,Math.min(100,Number(req.body?.limit||75)));
 const rows=(await db.query(`SELECT id,vin,year,make,model,engine,transmission FROM customer_units WHERE vin ~ '^[A-HJ-NPR-Z0-9]{17}$' AND (coalesce(year,'')='' OR coalesce(make,'')='' OR coalesce(model,'')='') ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT $1`,[limit])).rows;
 let updated=0,failed=0;const errors=[];
 for(const u of rows){try{const d=await lookupNhtsaVin(u.vin);await db.query(`UPDATE customer_units SET year=coalesce(nullif(year,''),$2),make=coalesce(nullif(make,''),$3),model=coalesce(nullif(model,''),$4),engine=coalesce(nullif(engine,''),$5),transmission=coalesce(nullif(transmission,''),$6),updated_at=now() WHERE id=$1`,[u.id,d.year||null,d.make||null,d.model||null,d.engine||null,d.transmission||null]);updated++}catch(e){failed++;if(errors.length<10)errors.push({vin:u.vin,error:String(e?.message||e)})}}
 await audit(req.user.username,"unit_vin_bulk_decode",{requested:rows.length,updated,failed});res.json({ok:true,checked:rows.length,updated,failed,errors});
}catch(e){next(e)}});

app.get("/api/customer-units/:id/profile",auth,managerPermission("customers"),async(req,res,next)=>{try{
 const db=requireDb();
 const ur=await db.query(`SELECT u.*,c.customer_name AS canonical_customer,c.dot_number,c.phone AS customer_phone,c.email AS customer_email FROM customer_units u LEFT JOIN fullbay_import_customers c ON c.id::text=u.customer_id::text WHERE u.id=$1`,[req.params.id]);
 if(!ur.rowCount)return res.status(404).json({error:"Vehicle not found."});
 const unit={...ur.rows[0],customer_name:ur.rows[0].canonical_customer||ur.rows[0].customer_name};
 let fullbayHistory=[];
 try{const hr=await db.query(`SELECT service_order,invoice_number,unit_number,vin,max(action_completed_at) completed_at,max(unit_miles) unit_miles,max(lead_tech) lead_tech,max(tech) tech,sum(coalesce(hours,0)) hours,sum(coalesce(labor_amount,0)) labor_amount,sum(coalesce(part_amount,0)) part_amount,sum(coalesce(total_amount,0)) total_amount,json_agg(json_build_object('action',action_number,'complaint',complaint,'correction',actual_correction,'hours',hours,'component',component,'system',system,'tech',tech,'laborAmount',labor_amount,'partAmount',part_amount,'totalAmount',total_amount) ORDER BY action_completed_at,action_number) actions FROM fullbay_service_history WHERE (unit_record_id=$1 OR (lower(coalesce(unit_number,''))=lower($2) AND (customer_id::text=$3::text OR lower(coalesce(customer_name,''))=lower($4)))) GROUP BY service_order,invoice_number,unit_number,vin ORDER BY max(action_completed_at) DESC NULLS LAST LIMIT 1000`,[unit.id,unit.unit_number||"",unit.customer_id,unit.customer_name||""]);fullbayHistory=hr.rows.map(x=>({source:"fullbay",id:x.service_order,invoice:x.invoice_number,unit:x.unit_number,vin:x.vin,completedAt:x.completed_at,status:"Completed (Fullbay)",mechanic:x.tech||x.lead_tech||"",mileage:x.unit_miles,hours:Number(x.hours||0),laborAmount:Number(x.labor_amount||0),partAmount:Number(x.part_amount||0),totalAmount:Number(x.total_amount||0),tasks:(Array.isArray(x.actions)?x.actions:[]).map(a=>({t:a.complaint||a.correction||`Action ${a.action||""}`,outcomeNote:a.correction||"",hours:a.hours,component:a.component,system:a.system,tech:a.tech,laborAmount:Number(a.laborAmount||0),partAmount:Number(a.partAmount||0),totalAmount:Number(a.totalAmount||0)}))}))}catch(e){console.error("Vehicle Fullbay history warning:",e?.message)}
 let ittrHistory=[];
 try{const core=await getCoreState(),unitKey=String(unit.unit_number||"").trim().toLowerCase(),customerKey=normCustomerName(unit.customer_name);ittrHistory=(Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders:[]).filter(w=>w&&typeof w==="object"&&String(w.unit||"").trim().toLowerCase()===unitKey&&(!customerKey||!w.customer||normCustomerName(w.customer)===customerKey)).map(w=>({source:"ittr",id:w.id,unit:w.unit,date:w.date,time:w.time,status:w.status,completedAt:w.completedAt,mechanic:w.mechanic,mileage:w.mileage,tasks:(Array.isArray(w.tasks)?w.tasks:[]).filter(Boolean).map(t=>({t:t.t,outcome:t.outcome,outcomeNote:t.outcomeNote})),notes:w.notes,completionNotes:w.completionNotes,futureNotes:w.futureNotes})).sort((a,b)=>new Date(b.completedAt||b.date||0)-new Date(a.completedAt||a.date||0))}catch(e){console.error("Vehicle ITTR history warning:",e?.message)}
 let invoiceHistory=[];
 try{
  const ir=await db.query(`SELECT i.id,i.invoice_number,i.status,i.invoice_date,i.created_at,i.finalized_at,i.sent_at,i.unit_number,i.vin,i.mileage,i.total,i.subtotal,i.tax_amount,i.discount,i.additional_fees,i.other_charges,i.work_order_id,i.service_order_id,
    coalesce(json_agg(json_build_object('id',l.id,'type',l.line_type,'description',l.description,'partNumber',l.part_number,'jobName',l.job_name,'jobUid',l.job_uid,'parentLineId',l.parent_line_id,'quantity',l.quantity,'unitPrice',l.unit_price,'unitCost',l.unit_cost,'lineTotal',l.line_total,'taxable',l.taxable,'discountType',l.discount_type,'discountValue',l.discount_value,'tech',null) ORDER BY l.sort_order,l.id) FILTER (WHERE l.id IS NOT NULL),'[]'::json) lines
    FROM customer_invoices i LEFT JOIN customer_invoice_lines l ON l.invoice_id=i.id
    WHERE i.status<>'void' AND (i.unit_id=$1::bigint OR (lower(coalesce(i.unit_number,''))=lower($2) AND (i.customer_id::text=$3::text OR lower(coalesce(i.customer_name,''))=lower($4))))
    GROUP BY i.id ORDER BY i.invoice_date DESC,i.id DESC LIMIT 1000`,[unit.id,unit.unit_number||"",unit.customer_id,unit.customer_name||""]);
  invoiceHistory=ir.rows.map(x=>({source:"invoice",id:x.id,invoice:x.invoice_number,unit:x.unit_number,vin:x.vin,completedAt:x.finalized_at||x.sent_at||x.invoice_date||x.created_at,status:"Completed",invoiceStatus:x.status,mileage:x.mileage,totalAmount:Number(x.total||0),subtotal:Number(x.subtotal||0),taxAmount:Number(x.tax_amount||0),discount:Number(x.discount||0),additionalFees:Number(x.additional_fees||0),otherCharges:Number(x.other_charges||0),workOrderId:x.work_order_id,serviceOrderId:x.service_order_id,tasks:(Array.isArray(x.lines)?x.lines:[]).map(l=>({id:l.id,t:[l.jobName,l.description].filter(Boolean).join(" · "),description:l.description,jobName:l.jobName,jobUid:l.jobUid,parentLineId:l.parentLineId,lineType:l.type,partNumber:l.partNumber,quantity:l.quantity,unitPrice:l.unitPrice,unitCost:l.unitCost,lineTotal:l.lineTotal,taxable:l.taxable,discountType:l.discountType,discountValue:l.discountValue,tech:l.tech}))}))
 }catch(e){console.error("Vehicle invoice history warning:",e?.message)}
 const history=[...invoiceHistory,...fullbayHistory,...ittrHistory].sort((a,b)=>new Date(b.completedAt||b.date||0)-new Date(a.completedAt||a.date||0));
 const active=ittrHistory.filter(x=>x.status!=="Completed");
 res.json({unit,customer:unit.customer_id?{id:unit.customer_id,customer_name:unit.customer_name,dot_number:unit.dot_number,phone:unit.customer_phone,email:unit.customer_email}:null,history,active});
}catch(e){next(e)}});

app.get("/api/customer-units/suggest",auth,async(req,res,next)=>{try{
 try{await syncCustomerUnitDirectory()}catch(e){console.error("Unit suggest sync warning:",e?.message)}const q=String(req.query.q||"").trim();if(q.length<1)return res.json({items:[]});const like=`%${q}%`,db=requireDb();
 const r=await db.query(`SELECT u.*,c.customer_name AS canonical_customer,c.phone AS customer_phone,c.email AS customer_email,c.dot_number FROM customer_units u LEFT JOIN fullbay_import_customers c ON c.id::text=u.customer_id::text WHERE u.unit_number ILIKE $1 OR coalesce(u.vin,'') ILIKE $1 OR coalesce(u.plate,'') ILIKE $1 OR coalesce(c.dot_number,'') ILIKE $1 OR coalesce(c.customer_name,u.customer_name,'') ILIKE $1 ORDER BY CASE WHEN lower(u.unit_number)=lower($2) THEN 0 WHEN lower(u.unit_number) LIKE lower($3) THEN 1 ELSE 2 END,u.unit_number LIMIT 20`,[like,q,`${q}%`]);res.json({items:r.rows.map(x=>({...x,customer_name:x.canonical_customer||x.customer_name}))});
}catch(e){next(e)}});


// v24.1 unified shop search: customer + vehicle + ITTR/Fullbay service history.
app.get("/api/smart-search",auth,adminOnly,async(req,res,next)=>{try{
 const q=String(req.query.q||"").trim();if(q.length<2)return res.json({customers:[],units:[],workorders:[]});
 const limit=Math.max(1,Math.min(50,Number(req.query.limit||20))),like=`%${q}%`,db=requireDb();
 const customers=(await db.query(`SELECT id,customer_name,contact_name,phone,email,dot_number,address,city,state,postal_code,active FROM fullbay_import_customers WHERE customer_name ILIKE $1 OR coalesce(contact_name,'') ILIKE $1 OR coalesce(phone,'') ILIKE $1 OR coalesce(email,'') ILIKE $1 OR coalesce(dot_number,'') ILIKE $1 OR coalesce(address,'') ILIKE $1 OR coalesce(city,'') ILIKE $1 ORDER BY active DESC NULLS LAST,customer_name LIMIT $2`,[like,limit])).rows;
 const units=(await db.query(`SELECT u.id,u.customer_id::text AS customer_id,coalesce(c.customer_name,u.customer_name) AS customer_name,u.unit_number,u.vin,u.year,u.make,u.model,u.plate,u.mileage,u.engine,u.transmission,u.notes FROM customer_units u LEFT JOIN fullbay_import_customers c ON c.id::text=u.customer_id::text WHERE u.unit_number ILIKE $1 OR coalesce(u.vin,'') ILIKE $1 OR coalesce(u.plate,'') ILIKE $1 OR coalesce(u.make,'') ILIKE $1 OR coalesce(u.model,'') ILIKE $1 OR coalesce(u.engine,'') ILIKE $1 OR coalesce(u.notes,'') ILIKE $1 OR coalesce(c.customer_name,u.customer_name,'') ILIKE $1 ORDER BY u.unit_number LIMIT $2`,[like,limit])).rows;
 let workorders=[];try{const core=await getCoreState(),needle=q.toLowerCase();workorders=(Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders:[]).filter(w=>{if(!w||typeof w!=="object")return false;const tasks=(Array.isArray(w.tasks)?w.tasks:[]).map(t=>[t?.t,t?.outcomeNote,t?.completionNote].filter(Boolean).join(" ")).join(" "),hay=[w.id,w.unit,w.customer,w.status,w.notes,w.completionNotes,w.futureNotes,w.parking,tasks].filter(v=>v!=null).join(" ").toLowerCase();return hay.includes(needle)}).sort((a,b)=>Number(b.id||0)-Number(a.id||0)).slice(0,limit).map(w=>({source:"ittr",id:w.id,unit:w.unit,customer:w.customer,status:w.status,date:w.date,time:w.time,completedAt:w.completedAt,summary:(w.tasks||[]).map(t=>t?.t).filter(Boolean).slice(0,3).join(", ")||w.notes||w.completionNotes||w.futureNotes||""}))}catch(e){console.error("Smart search work-order warning:",e?.message)}
 try{const sr=await db.query(`SELECT customer_id::text AS customer_id,customer_name,service_order,invoice_number,unit_number,max(action_completed_at) completed_at,count(*)::int job_count,(array_agg(nullif(complaint,'') ORDER BY action_completed_at NULLS LAST,action_number) FILTER (WHERE coalesce(complaint,'')<>''))[1] first_complaint,(array_agg(nullif(actual_correction,'') ORDER BY action_completed_at NULLS LAST,action_number) FILTER (WHERE coalesce(actual_correction,'')<>''))[1] first_correction FROM fullbay_service_history WHERE customer_name ILIKE $1 OR coalesce(unit_number,'') ILIKE $1 OR coalesce(vin,'') ILIKE $1 OR coalesce(service_order,'') ILIKE $1 OR coalesce(invoice_number,'') ILIKE $1 OR coalesce(complaint,'') ILIKE $1 OR coalesce(actual_correction,'') ILIKE $1 OR coalesce(component,'') ILIKE $1 OR coalesce(system,'') ILIKE $1 GROUP BY customer_id,customer_name,service_order,invoice_number,unit_number ORDER BY max(action_completed_at) DESC NULLS LAST LIMIT $2`,[like,limit]);for(const x of sr.rows){const first=x.first_complaint||x.first_correction||"Service record";workorders.push({source:"fullbay",id:x.service_order,invoice:x.invoice_number,unit:x.unit_number,customer:x.customer_name,customer_id:x.customer_id,status:"Fullbay History",completedAt:x.completed_at,jobCount:Number(x.job_count||0),summary:`${first}${Number(x.job_count||0)>1?` + ${Number(x.job_count)-1} more job${Number(x.job_count)-1===1?"":"s"}`:""}`})}}catch(e){console.error("Smart search Fullbay history warning:",e?.message)}
 workorders.sort((a,b)=>new Date(b.completedAt||b.date||0)-new Date(a.completedAt||a.date||0));res.json({customers,units,workorders:workorders.slice(0,limit),q});
}catch(e){next(e)}});

app.get("/api/admin/customer-crm-diagnostics",auth,adminOnly,async(req,res)=>{
 const out={ok:false,version:"24.23.1",tables:{},columns:{},counts:{},sync:null,error:""};
 try{
  const db=requireDb();
  for(const table of ["fullbay_import_customers","customer_units"]){const t=await db.query("SELECT to_regclass($1) AS name",[`public.${table}`]);out.tables[table]=Boolean(t.rows[0]?.name)}
  const cols=await db.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('fullbay_import_customers','customer_units') ORDER BY table_name,ordinal_position");
  out.columns=cols.rows.reduce((a,r)=>{(a[r.table_name]??=[]).push({name:r.column_name,type:r.data_type});return a},{});
  const cc=await db.query("SELECT count(*)::int n FROM fullbay_import_customers");
  try{out.sync=await syncCustomerUnitDirectory(true)}catch(e){out.sync={ok:false,fatal:String(e?.message||e),code:e?.code||null}}
  // Count AFTER reconciliation. Older diagnostics counted before sync and could falsely report Units: 0.
  const uc=await db.query("SELECT count(*)::int n FROM customer_units");out.counts={customers:cc.rows[0].n,units:uc.rows[0].n};
  out.unitSamples=(await db.query(`SELECT id,unit_number,customer_id::text AS customer_id,customer_name,vin,make,model,source FROM customer_units ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 10`)).rows;
  out.unitSourceCounts=(await db.query(`SELECT coalesce(source,'(none)') source,count(*)::int count FROM customer_units GROUP BY coalesce(source,'(none)') ORDER BY count(*) DESC`)).rows;
  out.unlinkedUnits=(await db.query(`SELECT id,unit_number,customer_id::text AS customer_id,customer_name,vin,source FROM customer_units WHERE customer_id IS NULL ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 25`)).rows;
  try{const core=await getCoreState();out.stateCounts={vehicleProfiles:Array.isArray(core.pro?.vehicles)?core.pro.vehicles.filter(v=>v&&typeof v==='object'&&String(v.unit||'').trim()).length:0,workOrders:Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders.filter(w=>w&&typeof w==='object'&&String(w.unit||'').trim()).length:0}}catch(e){out.stateCounts={error:String(e?.message||e)}}
  const bad=await db.query(`SELECT id,unit_number,customer_id::text AS customer_id,customer_name FROM customer_units WHERE coalesce(unit_number,'')='' OR (customer_id IS NULL AND coalesce(customer_name,'')='') LIMIT 50`).catch(()=>({rows:[]}));out.suspiciousUnits=bad.rows;
  out.ok=true;res.json(out);
 }catch(e){out.error=String(e?.message||e).slice(0,500);console.error("Customer CRM diagnostics failed:",e);res.status(500).json(out)}
});
async function reconcileDuplicateImportedCustomers(){
 if(!pool)return {merged:0};let merged=0;
 const r=await pool.query(`SELECT id,customer_name,fullbay_id FROM fullbay_import_customers ORDER BY id`);
 const groups=new Map();for(const c of r.rows){const k=normCustomerName(String(c.customer_name||"").replace(/^=+/,""));if(!k)continue;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c)}
 for(const items of groups.values()){
  if(items.length<2)continue;const canonical=items.slice().sort((a,b)=>(b.fullbay_id?1:0)-(a.fullbay_id?1:0)||Number(a.id)-Number(b.id))[0];
  for(const dupe of items){if(String(dupe.id)===String(canonical.id))continue;
   await pool.query("UPDATE customer_units SET customer_id=$1,customer_name=$2,updated_at=now() WHERE customer_id::text=$3::text OR (customer_id IS NULL AND lower(customer_name)=lower($4))",[canonical.id,canonical.customer_name,dupe.id,dupe.customer_name]);
   await pool.query("UPDATE fullbay_service_history SET customer_id=$1,customer_name=$2,updated_at=now() WHERE customer_id::text=$3::text OR (customer_id IS NULL AND lower(customer_name)=lower($4))",[canonical.id,canonical.customer_name,dupe.id,dupe.customer_name]);
   await pool.query("DELETE FROM fullbay_import_customers WHERE id=$1",[dupe.id]);merged++;
  }
 }
 return {merged};
}


// ===== v24.23.1: Samsara + duplicate customer management =====
const SAMSARA_API_BASE='https://api.samsara.com';
async function samsaraRequest(pathname,query={}){
 const token=String(process.env.SAMSARA_API_TOKEN||'').trim();
 if(!token){const e=new Error('Samsara is not configured. Add SAMSARA_API_TOKEN in Railway Variables.');e.status=503;throw e}
 const u=new URL(SAMSARA_API_BASE+pathname);
 for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null&&String(v)!=='')u.searchParams.set(k,String(v));
 const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
 const body=await r.json().catch(()=>({}));
 if(!r.ok){const e=new Error(body.message||body.error||`Samsara request failed (${r.status})`);e.status=r.status;throw e}
 return body;
}
async function samsaraPaged(pathname,query={}){
 const all=[];let after='',guard=0;
 do{const b=await samsaraRequest(pathname,{...query,...(after?{after}:{})});all.push(...(Array.isArray(b.data)?b.data:[]));after=b.pagination?.hasNextPage?String(b.pagination?.endCursor||''):''}while(after&&++guard<100);
 return all;
}
app.get('/api/samsara/status',auth,managerPermission('customers'),async(req,res)=>{
 const configured=!!String(process.env.SAMSARA_API_TOKEN||'').trim();
 if(!configured)return res.json({configured:false,connected:false});
 try{const s=await samsaraRequest('/fleet/vehicles');res.json({configured:true,connected:true,vehiclesOnFirstPage:(s.data||[]).length})}
 catch(e){res.status(e.status||502).json({configured:true,connected:false,error:e.message})}
});
app.get('/api/samsara/fleet',auth,managerPermission('customers'),async(req,res,next)=>{
 try{
  const [vehicles,stats,drivers]=await Promise.all([
   samsaraPaged('/fleet/vehicles'),
   samsaraPaged('/fleet/vehicles/stats',{types:'gps,engineStates,obdOdometerMeters'}),
   samsaraPaged('/fleet/drivers')
  ]);
  const sm=new Map(stats.map(x=>[String(x.id),x])),dm=new Map(drivers.map(x=>[String(x.id),x]));
  const items=vehicles.map(v=>{const st=sm.get(String(v.id))||{},gps=st.gps||null;
   const did=String(v.staticAssignedDriver?.id||v.driver?.id||''),driver=dm.get(did)||v.staticAssignedDriver||v.driver||null;
   return {id:v.id,name:v.name||'',vin:v.vin||'',serial:v.serial||'',make:v.make||'',model:v.model||'',year:v.year||'',licensePlate:v.licensePlate||'',externalIds:v.externalIds||{},
    driver:driver?{id:driver.id,name:driver.name||''}:null,
    gps:gps?{time:gps.time||'',latitude:gps.latitude,longitude:gps.longitude,headingDegrees:gps.headingDegrees,speedMilesPerHour:gps.speedMilesPerHour,location:gps.reverseGeo?.formattedLocation||''}:null,
    engineState:st.engineStates?.value??st.engineStates??null,odometerMeters:st.obdOdometerMeters?.value??st.obdOdometerMeters??null};
  });
  res.json({items,updatedAt:new Date().toISOString()});
 }catch(e){next(e)}
});
app.get('/api/samsara/vehicle/:id/history',auth,managerPermission('customers'),async(req,res,next)=>{
 try{const startTime=String(req.query.startTime||''),endTime=String(req.query.endTime||'');
  if(!startTime||!endTime)return res.status(400).json({error:'startTime and endTime are required.'});
  res.json(await samsaraRequest('/fleet/vehicles/stats/history',{vehicleIds:req.params.id,types:'gps,engineStates,obdOdometerMeters',startTime,endTime}));
 }catch(e){next(e)}
});
function normalizeCustomerCompanyName(v){
 return String(v||'').toUpperCase().replace(/&/g,' AND ').replace(/[.,'"()\/_-]/g,' ')
  .replace(/\b(CORPORATION|CORP|INCORPORATED|INC|LIMITED|LTD|LLC|L L C|COMPANY|CO)\b/g,' ').replace(/\s+/g,' ').trim();
}
app.get('/api/customers/duplicate-audit',auth,managerPermission('customers'),async(req,res)=>{
 try{
  const db=requireDb();
  const q=await db.query(`SELECT c.id,c.customer_name,c.phone,c.email,c.dot_number AS usdot,c.fullbay_id,
   count(DISTINCT u.id)::int AS units,
   count(DISTINCT h.id)::int AS history
   FROM fullbay_import_customers c
   LEFT JOIN customer_units u ON u.customer_id=c.id
   LEFT JOIN fullbay_service_history h ON h.customer_id=c.id
   GROUP BY c.id,c.customer_name,c.phone,c.email,c.dot_number,c.fullbay_id
   ORDER BY c.customer_name`);
  const g=new Map();
  for(const c of q.rows){const k=normalizeCustomerCompanyName(c.customer_name);if(!k)continue;if(!g.has(k))g.set(k,[]);g.get(k).push(c)}
  const candidates=[...g.entries()].filter(([,a])=>a.length>1).map(([normalized,customers])=>({
   normalized,reason:'Normalized company name match',
   customers:customers.sort((a,b)=>(Number(b.history||0)+Number(b.units||0))-(Number(a.history||0)+Number(a.units||0)))
  }));
  res.json({ok:true,count:candidates.length,candidates,scanned:q.rowCount});
 }catch(e){
  console.error('duplicate customer audit failed',e);
  res.status(500).json({error:'Duplicate customer audit failed.',detail:process.env.NODE_ENV==='production'?undefined:e.message});
 }
});

app.post('/api/customers/merge-preview',auth,ownerOnly,async(req,res)=>{
 let stage='validate';
 try{
  const db=requireDb(),masterId=Number(req.body?.masterId),duplicateId=Number(req.body?.duplicateId);
  if(!Number.isSafeInteger(masterId)||!Number.isSafeInteger(duplicateId)||masterId<=0||duplicateId<=0||masterId===duplicateId)
   return res.status(400).json({error:'Select two different customer records.'});

  stage='load customers';
  const master=(await db.query('SELECT id,customer_name,dot_number,fullbay_id FROM fullbay_import_customers WHERE id=$1',[masterId])).rows[0];
  const duplicate=(await db.query('SELECT id,customer_name,dot_number,fullbay_id FROM fullbay_import_customers WHERE id=$1',[duplicateId])).rows[0];
  if(!master||!duplicate)return res.status(404).json({error:'One or both customer records were not found.'});

  async function safeCustomerCount(table,id){
   const allowed=new Set(['customer_units','fullbay_service_history','customer_invoices','service_orders']);
   if(!allowed.has(table))throw new Error('Unsupported merge preview table.');
   const exists=(await db.query('SELECT to_regclass($1) AS name',[`public.${table}`])).rows[0]?.name;
   if(!exists)return 0;
   return Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE customer_id=$1`,[id])).rows[0]?.n||0);
  }
  stage='count master';
  const masterCounts={
   units:await safeCustomerCount('customer_units',masterId),
   history:await safeCustomerCount('fullbay_service_history',masterId),
   invoices:await safeCustomerCount('customer_invoices',masterId),
   service_orders:await safeCustomerCount('service_orders',masterId)
  };
  stage='count duplicate';
  const duplicateCounts={
   units:await safeCustomerCount('customer_units',duplicateId),
   history:await safeCustomerCount('fullbay_service_history',duplicateId),
   invoices:await safeCustomerCount('customer_invoices',duplicateId),
   service_orders:await safeCustomerCount('service_orders',duplicateId)
  };
  res.json({ok:true,customers:[master,duplicate],counts:{[masterId]:masterCounts,[duplicateId]:duplicateCounts}});
 }catch(e){
  console.error('customer merge preview failed at '+stage,e);
  res.status(500).json({error:`Customer merge preview failed during ${stage}.`});
 }
});
app.post('/api/customers/merge',auth,ownerOnly,async(req,res,next)=>{
 const pool=requireDb(),db=await pool.connect();
 try{const masterId=Number(req.body?.masterId),duplicateId=Number(req.body?.duplicateId);
  if(!masterId||!duplicateId||masterId===duplicateId)return res.status(400).json({error:'Select two different customer records.'});
  await db.query('BEGIN');
  const m=await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1 FOR UPDATE',[masterId]);
  const d=await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1 FOR UPDATE',[duplicateId]);
  if(!m.rowCount||!d.rowCount){const e=new Error('Customer not found.');e.status=404;throw e}
  const master=m.rows[0],dup=d.rows[0],units=(await db.query('SELECT * FROM customer_units WHERE customer_id=$1 ORDER BY id',[duplicateId])).rows;
  let movedUnits=0,mergedUnits=0;
  for(const u of units){let target=null;
   if(String(u.vin||'').trim())target=(await db.query(`SELECT * FROM customer_units WHERE customer_id=$1 AND lower(trim(vin))=lower(trim($2)) LIMIT 1`,[masterId,u.vin])).rows[0]||null;
   if(!target&&String(u.unit_number||'').trim())target=(await db.query(`SELECT * FROM customer_units WHERE customer_id=$1 AND lower(trim(unit_number))=lower(trim($2)) LIMIT 1`,[masterId,u.unit_number])).rows[0]||null;
   if(target){await db.query(`UPDATE fullbay_service_history SET unit_record_id=$1,customer_id=$2,customer_name=$3,unit_number=coalesce(nullif(unit_number,''),$4),vin=coalesce(nullif(vin,''),$5),updated_at=now() WHERE unit_record_id=$6`,[target.id,masterId,master.customer_name,target.unit_number,target.vin,u.id]);await db.query('DELETE FROM customer_units WHERE id=$1',[u.id]);mergedUnits++}
   else{await db.query('UPDATE customer_units SET customer_id=$1,customer_name=$2,updated_at=now() WHERE id=$3',[masterId,master.customer_name,u.id]);movedUnits++}
  }
  const hist=await db.query('UPDATE fullbay_service_history SET customer_id=$1,customer_name=$2,updated_at=now() WHERE customer_id=$3 RETURNING id',[masterId,master.customer_name,duplicateId]);
  let invoices={rowCount:0},serviceOrders={rowCount:0};
  if((await db.query("SELECT to_regclass('public.customer_invoices') AS name")).rows[0]?.name)
   invoices=await db.query('UPDATE customer_invoices SET customer_id=$1,customer_name=$2,updated_at=now() WHERE customer_id=$3 RETURNING id',[masterId,master.customer_name,duplicateId]);
  if((await db.query("SELECT to_regclass('public.service_orders') AS name")).rows[0]?.name)
   serviceOrders=await db.query('UPDATE service_orders SET customer_id=$1,customer_name=$2,updated_at=now() WHERE customer_id=$3 RETURNING id',[masterId,master.customer_name,duplicateId]);
  await db.query(`UPDATE fullbay_import_customers SET phone=coalesce(nullif(phone,''),$2),email=coalesce(nullif(email,''),$3),dot_number=coalesce(nullif(dot_number,''),$4),updated_at=now() WHERE id=$1`,[masterId,dup.phone||null,dup.email||null,dup.usdot||null]);
  await db.query('DELETE FROM fullbay_import_customers WHERE id=$1',[duplicateId]);
  await db.query('COMMIT');
  try{await audit(req.user.username,'customer_merged',{masterId,duplicateId,movedUnits,mergedUnits,historyMoved:hist.rowCount,invoicesMoved:invoices.rowCount,serviceOrdersMoved:serviceOrders.rowCount})}catch{}
  res.json({ok:true,masterId,duplicateId,movedUnits,mergedUnits,historyMoved:hist.rowCount,invoicesMoved:invoices.rowCount,serviceOrdersMoved:serviceOrders.rowCount});
 }catch(e){try{await db.query('ROLLBACK')}catch{};next(e)}finally{db.release()}
});

// v24.23.1 — safe cleanup of incomplete imported Fullbay service history only.
app.get('/api/fullbay/history/import-audit',auth,ownerOnly,async(req,res,next)=>{
 try{
  const db=requireDb();
  const imported=Number((await db.query(`SELECT count(*)::int n FROM fullbay_service_history WHERE coalesce(source_key,'') LIKE 'fullbay:%'`)).rows[0]?.n||0);
  const aiHistory=Number((await db.query(`SELECT count(*)::int n FROM fullbay_service_history WHERE coalesce(source_key,'') LIKE 'ai-history:%'`)).rows[0]?.n||0);
  const incomplete=Number((await db.query(`SELECT count(*)::int n FROM fullbay_service_history WHERE coalesce(source_key,'') LIKE 'fullbay:%' AND (coalesce(trim(correction),'')='' OR coalesce(parts_amount,0)=0)`)).rows[0]?.n||0);
  res.json({ok:true,imported,aiHistory,incomplete,scope:'Imported Fullbay service-history rows only.'});
 }catch(e){next(e)}
});
app.post('/api/fullbay/history/delete-imported',auth,ownerOnly,async(req,res,next)=>{
 try{
  const db=requireDb(),confirmation=String(req.body?.confirmation||'').trim();
  if(confirmation!=='DELETE FULLBAY HISTORY')return res.status(400).json({error:'Type DELETE FULLBAY HISTORY exactly.'});
  const deleted=await db.query(`DELETE FROM fullbay_service_history WHERE coalesce(source_key,'') LIKE 'fullbay:%' RETURNING id`);
  try{await audit(req.user.username,'fullbay_imported_history_deleted',{deleted:deleted.rowCount,scope:'fullbay_service_history/fullbay source keys only'})}catch{}
  res.json({ok:true,deleted:deleted.rowCount,customersPreserved:true,unitsPreserved:true,invoicesPreserved:true,workOrdersPreserved:true});
 }catch(e){next(e)}
});
app.get("/api/build",(req,res)=>res.json({frontendExpected:"24.23.1",backend:"24.23.1",build:"ITTR-24.23.1-PRINT-LEGAL-PART-LOOKUP-20260914"}));
app.get("/api/health",async(req,res)=>{let db=false;try{if(pool){await pool.query("SELECT 1");db=true}}catch{}res.json({ok:true,db,aiConfigured:Boolean(openRouterClient||client),aiProvider:openRouterClient?"openrouter":client?"openai":"none",version:"24.23.1",photoStorageConfigured:r2Configured})});

app.post("/api/auth/login",loginLimiter,async(req,res,next)=>{try{
 const username=cleanUsername(req.body?.username),password=String(req.body?.password||"");
 const q=await requireDb().query("SELECT * FROM auth_users WHERE username=$1 AND active=true",[username]);
 if(!q.rowCount || !(await bcrypt.compare(password,q.rows[0].password_hash)))return res.status(401).json({error:"Invalid username or password."});
 const raw=crypto.randomBytes(32).toString("base64url"),days=Math.max(1,Math.min(30,Number(process.env.SESSION_TTL_DAYS||7)));
 await pool.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3||' days')::interval)",[hashToken(raw),q.rows[0].id,String(days)]);
 await audit(username,"login",{}); res.json({token:raw,user:publicUser(q.rows[0])});
}catch(e){next(e)}});
app.post("/api/auth/logout",auth,async(req,res,next)=>{try{await requireDb().query("DELETE FROM auth_sessions WHERE token_hash=$1",[hashToken(req.sessionToken)]);res.json({ok:true})}catch(e){next(e)}});
app.get("/api/auth/me",auth,(req,res)=>res.json({user:publicUser(req.user)}));

app.get("/api/state",auth,async(req,res,next)=>{try{const q=await requireDb().query("SELECT state_key,payload,version,updated_at FROM app_state ORDER BY state_key");const d={};for(const r of q.rows)d[r.state_key]={payload:r.payload,version:Number(r.version),updatedAt:r.updated_at};res.json(d)}catch(e){next(e)}});
app.put("/api/state/:key",auth,async(req,res,next)=>{try{
 const key=String(req.params.key);
 if(!["users","shopflow","pro"].includes(key))return res.status(400).json({error:"Invalid state key"});
 const payload=req.body?.payload;
 if(payload===undefined)return res.status(400).json({error:"payload required"});
 const expectedVersion=Number(req.body?.expectedVersion||0);
 let q;
 if(expectedVersion>0){
   q=await requireDb().query(
     "UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1 AND version=$4 RETURNING version,updated_at",
     [key,JSON.stringify(payload),req.user.username,expectedVersion]
   );
   if(!q.rowCount){
     const cur=await requireDb().query("SELECT version FROM app_state WHERE state_key=$1",[key]);
     return res.status(409).json({
       error:"This data changed on another device before your save. The newer server copy was protected. Refresh and try again.",
       code:"VERSION_CONFLICT",
       currentVersion:Number(cur.rows[0]?.version||0)
     });
   }
 }else{
   q=await requireDb().query(
     "UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1 RETURNING version,updated_at",
     [key,JSON.stringify(payload),req.user.username]
   );
 }
 await audit(req.user.username,"state_save",{key,expectedVersion});
 if(key==="shopflow")broadcastShopStatus("shopflow_changed",{by:req.user.username,version:Number(q.rows[0].version)});
 res.json({ok:true,version:Number(q.rows[0].version),updatedAt:q.rows[0].updated_at});
}catch(e){next(e)}});


function taskRunning(task){
  return Boolean(task?.startedAt && !task?.stoppedAt && !task?.done);
}
function ensureTaskUid(task,workOrderId,taskIndex){
  if(!task.uid)task.uid=`wo-${String(workOrderId)}-task-${taskIndex}-${crypto.randomBytes(4).toString("hex")}`;
  return task.uid;
}
function assignedMechanicUsernames(w){
  const primary=String(w?.mechanic||"").trim().toLowerCase();
  const helpers=Array.isArray(w?.helpers)?w.helpers.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean):[];
  return [...new Set([primary,...helpers].filter(Boolean))];
}
function mechanicOwnsWorkOrder(user,w){
  if(user?.role==="admin")return true;
  return user?.role==="mechanic" && assignedMechanicUsernames(w).includes(String(user.username||"").trim().toLowerCase());
}
function taskRunningMechanic(task,w){return String(task?.runningBy||((task?.startedAt&&!task?.stoppedAt&&!task?.done)?w?.mechanic||"":"")).trim().toLowerCase()}

async function closeOpenTaskSession(db,workOrderId,taskUid,mechanic,endReason,pauseReason="",pauseNote=""){
  await db.query(
    `UPDATE task_time_sessions
     SET ended_at=now(),end_reason=$4,pause_reason=$5,pause_note=$6
     WHERE id=(
       SELECT id FROM task_time_sessions
       WHERE work_order_id=$1 AND task_uid=$2 AND mechanic_username=$3 AND ended_at IS NULL
       ORDER BY started_at DESC,id DESC LIMIT 1
     )`,
    [String(workOrderId),String(taskUid),String(mechanic),endReason,pauseReason,pauseNote]
  );
}



function selfStartLookupAllowed(req){
 return req.user?.role==="mechanic"||req.user?.role==="admin"||req.user?.role==="manager";
}
async function localSelfStartMatches(db,{dotNumber="",vin="",unit=""}={}){
 const usdot=cleanUsdot(dotNumber),cleanedVin=cleanVin(vin),unitQ=String(unit||"").trim();
 const where=[],params=[];
 const add=(sql,value)=>{params.push(value);where.push(sql.replace(/\$(\d+)/g,()=>`$${params.length}`))};
 if(cleanedVin){params.push(cleanedVin);where.push(`upper(coalesce(u.vin,''))=upper($${params.length})`)}
 if(unitQ){params.push(unitQ);where.push(`lower(coalesce(u.unit_number,''))=lower($${params.length})`)}
 if(usdot){params.push(usdot);where.push(`regexp_replace(coalesce(c.dot_number,''),'\\D','','g')=$${params.length}`)}
 if(!where.length)return [];
 const r=await db.query(`
   SELECT u.id,u.customer_id::text AS customer_id,coalesce(c.customer_name,u.customer_name) AS customer_name,
          c.dot_number,c.phone AS customer_phone,c.email AS customer_email,c.address,c.city,c.state,c.postal_code,
          u.unit_number,u.vin,u.year,u.make,u.model,u.plate,u.mileage,u.engine,u.transmission,u.source
   FROM customer_units u
   LEFT JOIN fullbay_import_customers c ON c.id::text=u.customer_id::text
   WHERE ${where.join(" OR ")}
   ORDER BY
     CASE WHEN $${params.length+1}<>'' AND upper(coalesce(u.vin,''))=upper($${params.length+1}) THEN 0
          WHEN $${params.length+2}<>'' AND regexp_replace(coalesce(c.dot_number,''),'\\D','','g')=$${params.length+2} THEN 1
          WHEN $${params.length+3}<>'' AND lower(coalesce(u.unit_number,''))=lower($${params.length+3}) THEN 2 ELSE 3 END,
     u.updated_at DESC NULLS LAST,u.id DESC
   LIMIT 25`,
   [...params,cleanedVin,usdot,unitQ]
 );
 return r.rows;
}
app.get("/api/work-orders/self-start/lookup",auth,async(req,res)=>{
 if(!selfStartLookupAllowed(req))return res.status(403).json({error:"Shop account required."});
 const dotNumber=cleanUsdot(req.query.dotNumber||req.query.dot||"");
 const vin=cleanVin(req.query.vin||"");
 const unit=String(req.query.unit||"").trim().slice(0,80);
 if(!dotNumber&&!vin&&!unit)return res.status(400).json({error:"Enter USDOT, VIN, or unit number."});
 if(vin && !vinCoreValid(vin))return res.status(400).json({error:"VIN must be 17 characters and cannot contain I, O, or Q.",code:"VIN_INVALID"});
 try{
   const db=requireDb();
   const matches=await localSelfStartMatches(db,{dotNumber,vin,unit});
   let carrier=null,vehicle=null;
   const warnings=[];
   let carrierSource="",vehicleSource="";
   const existingByVin=vin?matches.find(x=>cleanVin(x.vin)===vin):null;
   const existingByDot=dotNumber?matches.find(x=>cleanUsdot(x.dot_number)===dotNumber):null;

   if(dotNumber){
     if(existingByDot){
       carrier={
         dotNumber,
         legalName:existingByDot.customer_name||"",
         address:existingByDot.address||"",
         city:existingByDot.city||"",
         state:existingByDot.state||"",
         zip:existingByDot.postal_code||"",
         phone:existingByDot.customer_phone||"",
         existingCustomerId:existingByDot.customer_id||""
       };
       carrierSource="ITTR database";
     }
     try{
       const live=await lookupFmcsaCarrier(dotNumber);
       carrier={...(carrier||{}),...live,existingCustomerId:carrier?.existingCustomerId||""};
       carrierSource="FMCSA QCMobile API";
     }catch(e){
       if(e?.code==="FMCSA_NOT_CONFIGURED")warnings.push("FMCSA live lookup is not configured yet. Add FMCSA_WEBKEY in Railway Variables.");
       else warnings.push(e?.message||"FMCSA carrier lookup was unavailable.");
     }
   }

   if(vin){
     if(existingByVin){
       vehicle={
         vin,
         year:existingByVin.year||"",
         make:existingByVin.make||"",
         model:existingByVin.model||"",
         engine:existingByVin.engine||"",
         transmission:existingByVin.transmission||"",
         unitNumber:existingByVin.unit_number||"",
         mileage:existingByVin.mileage||"",
         plate:existingByVin.plate||"",
         existingUnitId:String(existingByVin.id||""),
         existingCustomerId:String(existingByVin.customer_id||"")
       };
       vehicleSource="ITTR database";
     }
     try{
       const decoded=await lookupNhtsaVin(vin);
       vehicle={...(vehicle||{}),...decoded,unitNumber:vehicle?.unitNumber||"",mileage:vehicle?.mileage||"",plate:vehicle?.plate||"",existingUnitId:vehicle?.existingUnitId||"",existingCustomerId:vehicle?.existingCustomerId||""};
       vehicleSource=vehicle?.existingUnitId?"ITTR database + NHTSA vPIC":"NHTSA vPIC";
     }catch(e){warnings.push(e?.message||"NHTSA VIN lookup was unavailable.")}
   }

   res.json({
     ok:true,
     query:{dotNumber,vin,unit},
     matches,
     carrier,
     vehicle,
     sources:{carrier:carrierSource,vehicle:vehicleSource},
     fmcsaConfigured:Boolean(FMCSA_WEBKEY),
     warnings,
     checkedAt:new Date().toISOString()
   });
 }catch(e){
   console.error("Mechanic self-start lookup failed:",e);
   res.status(500).json({error:"Unable to look up this customer/unit right now."});
 }
});

async function resolveSelfStartCustomer(db,b,user){
 const requestedId=String(b.customerId||"").trim();
 const dotNumber=cleanUsdot(b.dotNumber||"");
 const customerName=String(b.customer||"").trim().slice(0,220);
 if(requestedId){
   const q=await db.query("SELECT * FROM fullbay_import_customers WHERE id::text=$1 LIMIT 1",[requestedId]);
   if(q.rowCount)return {row:q.rows[0],created:false};
 }
 if(dotNumber){
   const q=await db.query("SELECT * FROM fullbay_import_customers WHERE regexp_replace(coalesce(dot_number,''),'\\D','','g')=$1 ORDER BY id LIMIT 1",[dotNumber]);
   if(q.rowCount)return {row:q.rows[0],created:false};
 }
 if(customerName){
   const q=await db.query("SELECT * FROM fullbay_import_customers WHERE lower(customer_name)=lower($1) ORDER BY id LIMIT 1",[customerName]);
   if(q.rowCount)return {row:q.rows[0],created:false};
 }
 if(!customerName)return {row:null,created:false};
 const carrier=(b.carrier&&typeof b.carrier==="object")?b.carrier:{};
 const sourceKey=dotNumber?`mechanic_usdot_${dotNumber}`:`mechanic_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
 const raw={createdVia:"mechanic_self_start",createdBy:user?.username||"",carrierSource:String(b.carrierSource||""),carrier};
 const q=await db.query(`
   INSERT INTO fullbay_import_customers(
     source_key,customer_name,phone,address,city,state,postal_code,dot_number,active,
     fmcsa_dba_name,fmcsa_mc_number,fmcsa_allowed_to_operate,fmcsa_out_of_service,
     fmcsa_power_units,fmcsa_drivers,fmcsa_snapshot,fmcsa_last_checked,raw,source_file,updated_at
   ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13,$14,$15::jsonb,CASE WHEN $16 THEN now() ELSE NULL END,$17::jsonb,'mechanic-self-start',now())
   ON CONFLICT(source_key) DO UPDATE SET
     customer_name=coalesce(nullif(EXCLUDED.customer_name,''),fullbay_import_customers.customer_name),
     phone=coalesce(nullif(EXCLUDED.phone,''),fullbay_import_customers.phone),
     address=coalesce(nullif(EXCLUDED.address,''),fullbay_import_customers.address),
     city=coalesce(nullif(EXCLUDED.city,''),fullbay_import_customers.city),
     state=coalesce(nullif(EXCLUDED.state,''),fullbay_import_customers.state),
     postal_code=coalesce(nullif(EXCLUDED.postal_code,''),fullbay_import_customers.postal_code),
     dot_number=coalesce(nullif(EXCLUDED.dot_number,''),fullbay_import_customers.dot_number),
     fmcsa_dba_name=coalesce(nullif(EXCLUDED.fmcsa_dba_name,''),fullbay_import_customers.fmcsa_dba_name),
     fmcsa_mc_number=coalesce(nullif(EXCLUDED.fmcsa_mc_number,''),fullbay_import_customers.fmcsa_mc_number),
     fmcsa_snapshot=CASE WHEN EXCLUDED.fmcsa_snapshot<>'{}'::jsonb THEN EXCLUDED.fmcsa_snapshot ELSE fullbay_import_customers.fmcsa_snapshot END,
     fmcsa_last_checked=coalesce(EXCLUDED.fmcsa_last_checked,fullbay_import_customers.fmcsa_last_checked),
     updated_at=now()
   RETURNING *`,
   [
     sourceKey,customerName,String(carrier.phone||"").slice(0,80),String(carrier.address||"").slice(0,260),
     String(carrier.city||"").slice(0,120),String(carrier.state||"").slice(0,40),String(carrier.zip||"").slice(0,40),dotNumber,
     String(carrier.dbaName||"").slice(0,220),String(carrier.mcNumber||"").slice(0,80),String(carrier.allowedToOperate||"").slice(0,40),
     String(carrier.outOfService||"").slice(0,40),Number.isFinite(Number(carrier.powerUnits))?Number(carrier.powerUnits):null,
     Number.isFinite(Number(carrier.drivers))?Number(carrier.drivers):null,JSON.stringify(carrier),
     Boolean(b.carrierSource&&String(b.carrierSource).includes("FMCSA")),JSON.stringify(raw)
   ]
 );
 return {row:q.rows[0],created:true};
}
async function resolveSelfStartUnit(db,b,customerRow){
 const requestedId=String(b.unitRecordId||"").trim(),vin=cleanVin(b.vin||""),unitNumber=String(b.unit||"").trim().slice(0,120);
 if(requestedId){
   const q=await db.query("SELECT * FROM customer_units WHERE id::text=$1 LIMIT 1",[requestedId]);
   if(q.rowCount){
     const row=q.rows[0];
     if(customerRow?.id && row.customer_id && String(row.customer_id)!==String(customerRow.id)){
       throw Object.assign(new Error("This unit belongs to a different customer in ITTR. Ask a manager to review the unit before creating a work order."),{status:409,code:"UNIT_CUSTOMER_CONFLICT"});
     }
     if(customerRow?.id && !row.customer_id){
       const u=await db.query("UPDATE customer_units SET customer_id=$1,customer_name=$2,updated_at=now() WHERE id=$3 RETURNING *",[customerRow.id,customerRow.customer_name,row.id]);
       return {row:u.rows[0],created:false};
     }
     return {row,created:false};
   }
 }
 if(vin){
   const q=await db.query("SELECT * FROM customer_units WHERE upper(coalesce(vin,''))=upper($1) ORDER BY id LIMIT 1",[vin]);
   if(q.rowCount){
     const row=q.rows[0];
     if(customerRow?.id && row.customer_id && String(row.customer_id)!==String(customerRow.id)){
       throw Object.assign(new Error("This VIN already belongs to a different customer in ITTR. Ask a manager to review the unit before creating a work order."),{status:409,code:"VIN_CUSTOMER_CONFLICT"});
     }
     if(customerRow?.id && !row.customer_id){
       const u=await db.query("UPDATE customer_units SET customer_id=$1,customer_name=$2,updated_at=now() WHERE id=$3 RETURNING *",[customerRow.id,customerRow.customer_name,row.id]);
       return {row:u.rows[0],created:false};
     }
     return {row,created:false};
   }
 }
 if(!unitNumber)throw Object.assign(new Error("Unit number is required."),{status:400});
 const same=await db.query("SELECT * FROM customer_units WHERE lower(unit_number)=lower($1) AND ($2::bigint IS NULL OR customer_id=$2::bigint) ORDER BY id LIMIT 1",[unitNumber,customerRow?.id||null]);
 if(same.rowCount)return {row:same.rows[0],created:false};
 const vehicle=(b.vehicle&&typeof b.vehicle==="object")?b.vehicle:{};
 const q=await db.query(`
   INSERT INTO customer_units(customer_id,customer_name,unit_number,vin,year,make,model,plate,mileage,engine,transmission,notes,source,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'mechanic_self_start',now())
   RETURNING *`,
   [
     customerRow?.id||null,customerRow?.customer_name||String(b.customer||"").trim(),unitNumber,vin||null,
     String(b.year||vehicle.year||"").slice(0,20),String(b.make||vehicle.make||"").slice(0,120),String(b.model||vehicle.model||"").slice(0,160),
     String(b.plate||"").slice(0,80),Number(b.mileage||0)||null,String(b.engine||vehicle.engine||"").slice(0,240),
     String(b.transmission||vehicle.transmission||"").slice(0,240),
     JSON.stringify({createdVia:"mechanic_self_start",vehicleSource:String(b.vehicleSource||""),decodedVehicle:vehicle}).slice(0,4000)
   ]
 );
 return {row:q.rows[0],created:true};
}

app.post("/api/work-orders/self-start",auth,async(req,res,next)=>{
 if(req.user?.role!=="mechanic")return res.status(403).json({error:"Mechanic account required."});
 const db=await requireDb().connect();
 try{
  const b=req.body||{},customer=String(b.customer||"").trim(),unit=String(b.unit||"").trim(),vin=cleanVin(b.vin||""),dotNumber=cleanUsdot(b.dotNumber||""),jobs=Array.isArray(b.jobs)?b.jobs.map(x=>String(x||"").trim()).filter(Boolean):[];
  if(!customer||!unit||!jobs.length||(!vin&&!dotNumber))return res.status(400).json({error:"Customer, unit, at least one job, and VIN or USDOT are required."});
  if(vin&&!vinCoreValid(vin))return res.status(400).json({error:"VIN must be 17 characters and cannot contain I, O, or Q.",code:"VIN_INVALID"});
  await db.query("BEGIN");

  const customerResolved=await resolveSelfStartCustomer(db,b,req.user);
  if(!customerResolved.row)throw Object.assign(new Error("Customer could not be resolved."),{status:400});
  const unitResolved=await resolveSelfStartUnit(db,b,customerResolved.row);
  if(!unitResolved.row)throw Object.assign(new Error("Unit could not be resolved."),{status:400});

  const customerRow=customerResolved.row,unitRow=unitResolved.row;
  const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
  if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."});}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
  const numericIds=sf.workorders.map(x=>Number(x?.id)).filter(Number.isFinite);const id=(numericIds.length?Math.max(...numericIds):1000)+1;const now=new Date();
  const w={
    id,
    unit:unitRow.unit_number||unit,
    customer:customerRow.customer_name||customer,
    customerId:String(customerRow.id||""),
    unitRecordId:String(unitRow.id||""),
    vin:unitRow.vin||vin,
    dotNumber:customerRow.dot_number||dotNumber,
    year:unitRow.year||String(b.year||""),
    make:unitRow.make||String(b.make||""),
    model:unitRow.model||String(b.model||""),
    plate:unitRow.plate||String(b.plate||""),
    mileage:Number(b.mileage||unitRow.mileage||0)||"",
    date:now.toISOString().slice(0,10),time:now.toTimeString().slice(0,5),
    mechanic:req.user.username,helpers:[],priority:String(b.priority||"Normal"),parking:String(b.parking||""),
    unitType:"customer",truckHere:true,status:"Open",notes:String(b.notes||""),
    arrivedAt:now.toISOString(),arrivedBy:req.user.username,createdAt:now.toISOString(),createdBy:req.user.username,
    createdVia:"mechanic_self_start",outcomeWorkflowVersion:1,
    history:[{
      type:"mechanic_self_start",at:now.toISOString(),by:req.user.username,byDisplay:req.user.display_name||req.user.username,
      customerCreated:Boolean(customerResolved.created),unitCreated:Boolean(unitResolved.created),
      carrierSource:String(b.carrierSource||""),vehicleSource:String(b.vehicleSource||"")
    }],
    tasks:jobs.map((text,i)=>({uid:`wo-${id}-task-${i}-${crypto.randomBytes(4).toString("hex")}`,t:text,done:false,startedAt:"",stoppedAt:"",runningBy:"",elapsedMs:0,completedAt:"",taskOutcome:"",outcomeNote:"",outcomeAt:"",outcomeBy:"",paused:false,pausedAt:"",pauseReason:"",pauseNote:""}))
  };
  sf.workorders.push(w);
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");
  lastCustomerUnitDirectorySync=0;
  await audit(req.user.username,"mechanic_work_order_self_created",{workOrderId:id,unit:w.unit,vin:w.vin,dotNumber:w.dotNumber,jobs:jobs.length,customerId:w.customerId,unitRecordId:w.unitRecordId,customerCreated:Boolean(customerResolved.created),unitCreated:Boolean(unitResolved.created),carrierSource:String(b.carrierSource||""),vehicleSource:String(b.vehicleSource||"")});
  broadcastShopStatus("work_order_created",{workOrderId:id,by:req.user.username,version:Number(u.rows[0].version)});
  res.status(201).json({ok:true,workOrder:w,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at,customer:{id:customerRow.id,name:customerRow.customer_name,created:Boolean(customerResolved.created)},unit:{id:unitRow.id,unitNumber:unitRow.unit_number,created:Boolean(unitResolved.created)}});
 }catch(e){
  try{await db.query("ROLLBACK")}catch(_){}
  if(e?.status)return res.status(e.status).json({error:e.message,code:e.code||"SELF_START"});
  next(e)
 }finally{db.release()}
});
app.post("/api/work-orders/:id/helpers",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  const workOrderId=String(req.params.id),target=cleanUsername(req.body?.username);
  if(!target)return res.status(400).json({error:"Choose a mechanic."});
  await db.query("BEGIN");
  const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
  if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."});}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
  sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
  const w=sf.workorders.find(x=>String(x?.id)===workOrderId);
  if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."});}
  if(req.user.role!=="admin"&&!mechanicOwnsWorkOrder(req.user,w)){await db.query("ROLLBACK");return res.status(403).json({error:"You must already be assigned to this work order to add a helper."});}
  if(w.status==="Completed"){await db.query("ROLLBACK");return res.status(409).json({error:"Completed work orders cannot add helpers."});}
  const uq=await db.query("SELECT username,display_name FROM auth_users WHERE username=$1 AND role='mechanic' AND active=true",[target]);
  if(!uq.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Mechanic account not found."});}
  w.helpers=Array.isArray(w.helpers)?w.helpers:[];
  if(String(w.mechanic||"").toLowerCase()===target||w.helpers.map(x=>String(x).toLowerCase()).includes(target)){await db.query("ROLLBACK");return res.status(409).json({error:"This mechanic is already assigned to the work order."});}
  w.helpers.push(target);
  w.history=Array.isArray(w.history)?w.history:[];
  w.history.push({type:"helper_added",at:new Date().toISOString(),by:req.user.username,byDisplay:req.user.display_name||req.user.username,helper:target,helperDisplay:uq.rows[0].display_name||target});
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");await audit(req.user.username,"work_order_helper_added",{workOrderId,helper:target});
  res.json({ok:true,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at});
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}next(e)}finally{db.release()}
});
app.delete("/api/work-orders/:id/helpers/:username",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  const workOrderId=String(req.params.id),target=cleanUsername(req.params.username);
  await db.query("BEGIN");
  const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
  if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."});}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
  const w=sf.workorders.find(x=>String(x?.id)===workOrderId);if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."});}
  const primary=String(w.mechanic||"").toLowerCase();
  if(req.user.role!=="admin"&&String(req.user.username||"").toLowerCase()!==primary){await db.query("ROLLBACK");return res.status(403).json({error:"Only the primary mechanic or admin can remove a helper."});}
  const open=await db.query("SELECT 1 FROM task_time_sessions WHERE work_order_id=$1 AND mechanic_username=$2 AND ended_at IS NULL LIMIT 1",[workOrderId,target]);
  if(open.rowCount){await db.query("ROLLBACK");return res.status(409).json({error:"This mechanic has a running task on the work order. Pause or complete it first."});}
  w.helpers=(Array.isArray(w.helpers)?w.helpers:[]).filter(x=>String(x).toLowerCase()!==target);
  w.history=Array.isArray(w.history)?w.history:[];w.history.push({type:"helper_removed",at:new Date().toISOString(),by:req.user.username,byDisplay:req.user.display_name||req.user.username,helper:target});
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");await audit(req.user.username,"work_order_helper_removed",{workOrderId,helper:target});res.json({ok:true,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at});
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}next(e)}finally{db.release()}
});


app.post("/api/work-orders/:id/tasks/by-uid/:taskUid/parts",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  const workOrderId=String(req.params.id),uid=String(req.params.taskUid||"");
  const partNumber=String(req.body?.partNumber||"").trim().slice(0,120);
  const description=String(req.body?.description||"").trim().slice(0,500);
  const qty=Math.max(.01,Math.min(99999,Number(req.body?.qty||1)));
  const inventoryPartId=req.body?.inventoryPartId?Number(req.body.inventoryPartId):null;
  if(!partNumber&&!description&&!inventoryPartId)return res.status(400).json({error:"Enter or scan a part."});
  await db.query("BEGIN");
  const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
  if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."});}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
  sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
  const w=sf.workorders.find(x=>String(x?.id)===workOrderId);
  if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."});}
  if(!mechanicOwnsWorkOrder(req.user,w)){await db.query("ROLLBACK");return res.status(403).json({error:"You do not have access to this work order."});}
  if(String(w.status)==="Completed"){await db.query("ROLLBACK");return res.status(409).json({error:"Completed work orders are locked."});}
  const matches=(Array.isArray(w.tasks)?w.tasks:[]).filter(t=>String(t?.uid||"")===uid);
  if(matches.length!==1){await db.query("ROLLBACK");return res.status(409).json({error:"Task identity could not be resolved."});}
  const t=matches[0];t.parts=Array.isArray(t.parts)?t.parts:[];
  let inv=null,finalPartNumber=partNumber,finalDescription=description;
  if(inventoryPartId){const ir=await db.query("SELECT * FROM fullbay_import_parts WHERE id=$1 FOR UPDATE",[inventoryPartId]);if(!ir.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Inventory part not found."})}inv=ir.rows[0];const before=Number(inv.quantity||0);if(before<qty){await db.query("ROLLBACK");return res.status(409).json({error:`Only ${before} ${inv.uom||""} in stock.`})}const after=before-qty;await db.query("UPDATE fullbay_import_parts SET quantity=$2::numeric,inventory_value=($2::numeric*coalesce(cost,0::numeric)),updated_at=now() WHERE id=$1",[inventoryPartId,after]);finalPartNumber=inv.part_number||partNumber;finalDescription=inv.description||description;await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,username,metadata) VALUES($1,'used',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,[inventoryPartId,-qty,before,after,workOrderId,uid,String(t.t||""),String(w.unit||""),String(w.customer||""),`WO ${workOrderId}`,req.user.username,JSON.stringify({method:req.body?.method||"work_order"})]);}
  const part={id:`part_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,partNumber:finalPartNumber,description:finalDescription,qty,inventoryPartId:inventoryPartId||null,unitCost:inv?.cost??null,unitPrice:inv?.price??null,sellTaxable:inv?.sell_taxable!==false,barcode:inv?await ensurePartBarcode(db,inventoryPartId):null,addedBy:req.user.username,addedAt:new Date().toISOString()};
  t.parts.push(part);
  w.history=Array.isArray(w.history)?w.history:[];w.history.push({type:"part_added",at:part.addedAt,by:req.user.username,task:t.t,partNumber,description,qty});
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");await audit(req.user.username,"task_part_added",{workOrderId,taskUid:uid,partId:part.id});
  res.json({ok:true,part,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at});
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}next(e)}finally{db.release()}
});
app.delete("/api/work-orders/:id/tasks/by-uid/:taskUid/parts/:partId",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
  const workOrderId=String(req.params.id),uid=String(req.params.taskUid||""),partId=String(req.params.partId||"");
  await db.query("BEGIN");
  const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
  if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."});}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
  const w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===workOrderId);
  if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."});}
  if(!mechanicOwnsWorkOrder(req.user,w)){await db.query("ROLLBACK");return res.status(403).json({error:"You do not have access to this work order."});}
  if(String(w.status)==="Completed"){await db.query("ROLLBACK");return res.status(409).json({error:"Completed work orders are locked."});}
  const t=(Array.isArray(w.tasks)?w.tasks:[]).find(x=>String(x?.uid||"")===uid);
  if(!t){await db.query("ROLLBACK");return res.status(404).json({error:"Task not found."});}
  t.parts=Array.isArray(t.parts)?t.parts:[];
  const p=t.parts.find(x=>String(x?.id||"")===partId);
  if(!p){await db.query("ROLLBACK");return res.status(404).json({error:"Part not found."});}
  if(req.user.role!=="admin"&&String(p.addedBy||"").toLowerCase()!==String(req.user.username||"").toLowerCase()){
    await db.query("ROLLBACK");return res.status(403).json({error:"Only the mechanic who added this part or an admin can remove it."});
  }
  if(p.inventoryPartId){const ir=await db.query("SELECT quantity FROM fullbay_import_parts WHERE id=$1 FOR UPDATE",[p.inventoryPartId]);if(ir.rowCount){const before=Number(ir.rows[0].quantity||0),qty=Number(p.qty||1),after=before+qty;await db.query("UPDATE fullbay_import_parts SET quantity=$2::numeric,inventory_value=($2::numeric*coalesce(cost,0::numeric)),updated_at=now() WHERE id=$1",[p.inventoryPartId,after]);await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,work_order_id,task_uid,task_name,unit_number,customer_name,reference,reason,username,metadata) VALUES($1,'returned',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,[p.inventoryPartId,qty,before,after,workOrderId,uid,String(t.t||""),String(w.unit||""),String(w.customer||""),`WO ${workOrderId}`,"Removed from work order",req.user.username,JSON.stringify({originalPartId:partId})]);}}
  t.parts=t.parts.filter(x=>String(x?.id||"")!==partId);
  const u=await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",[JSON.stringify(sf),req.user.username]);
  await db.query("COMMIT");await audit(req.user.username,"task_part_removed",{workOrderId,taskUid:uid,partId});
  res.json({ok:true,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at});
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}next(e)}finally{db.release()}
});

app.post("/api/work-orders/:id/tasks/by-uid/:taskUid/action",auth,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
   const workOrderId=String(req.params.id);
   const requestedUid=String(req.params.taskUid||"");
   const action=String(req.body?.action||"");
   if(!requestedUid)return res.status(400).json({error:"Task ID is required."});
   if(!["start","pause","resume","complete"].includes(action))
     return res.status(400).json({error:"Invalid task action."});

   await db.query("BEGIN");
   const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
   if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop data not found."});}
   const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
   sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
   const w=sf.workorders.find(x=>String(x?.id)===workOrderId);
   if(!w){await db.query("ROLLBACK");return res.status(404).json({error:"Work order not found."});}
   if(!mechanicOwnsWorkOrder(req.user,w)){await db.query("ROLLBACK");return res.status(403).json({error:"You do not have access to this work order."});}
   w.tasks=Array.isArray(w.tasks)?w.tasks:[];

   const matches=w.tasks.map((t,i)=>({t,i})).filter(x=>String(x.t?.uid||"")===requestedUid);
   if(matches.length!==1){
     await db.query("ROLLBACK");
     return res.status(409).json({error:matches.length===0?"Task no longer exists. Refresh the work order.":"Duplicate task identity detected. Refresh; server repair is required."});
   }
   const task=matches[0].t;
   const taskIndex=matches[0].i;
   const uid=ensureTaskUid(task,workOrderId,taskIndex);

   if(task.findingDecision==="Do Not Proceed"){
     await db.query("ROLLBACK");return res.status(409).json({error:"This repair was declined. Do not perform this task."});
   }
   if(task.findingDecision==="Waiting for Customer"){
     await db.query("ROLLBACK");return res.status(409).json({error:"This repair is waiting for customer approval."});
   }

   const now=new Date();

   if(action==="start" || action==="resume"){
     if(task.done || String(task.taskOutcome||"")==="completed"){
       await db.query("ROLLBACK");return res.status(409).json({error:"This task is already completed."});
     }
     const another=w.tasks.findIndex(t=>String(t?.uid||"")!==uid && taskRunning(t) && taskRunningMechanic(t,w)===String(req.user.username||"").toLowerCase());
     if(another!==-1){
       await db.query("ROLLBACK");return res.status(409).json({error:"Pause or complete your current task before starting another one."});
     }
     if(taskRunning(task)){
       await db.query("ROLLBACK");return res.status(409).json({error:"This task is already running."});
     }

     task.startedAt=now.toISOString();
     task.stoppedAt="";
     task.runningBy=req.user.username;
     task.paused=false;
     task.pausedAt="";
     task.pauseReason="";
     task.pauseNote="";
     task.done=false;
     task.completedAt="";
     task.taskOutcome="";
     task.outcomeNote="";
     task.outcomeAt="";
     task.outcomeBy="";
     if(w.status==="Open")w.status="In Progress";

     await db.query(
       `INSERT INTO task_time_sessions(work_order_id,task_index,task_uid,task_name,mechanic_username,started_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
       [workOrderId,taskIndex,uid,String(task.t||""),req.user.username,now.toISOString()]
     );
   }

   if(action==="pause"){
     if(!taskRunning(task)){
       await db.query("ROLLBACK");return res.status(409).json({error:"This task is not currently running."});
     }
     if(taskRunningMechanic(task,w)!==String(req.user.username||"").toLowerCase()){await db.query("ROLLBACK");return res.status(409).json({error:"Only the mechanic who started this task can pause it."});}
     const reason=String(req.body?.reason||"").trim();
     const note=String(req.body?.note||"").trim().slice(0,1000);
     if(!reason){
       await db.query("ROLLBACK");return res.status(400).json({error:"Choose a pause reason."});
     }
     const started=new Date(task.startedAt);
     task.elapsedMs=Number(task.elapsedMs||0)+Math.max(0,now.getTime()-started.getTime());
     task.stoppedAt=now.toISOString();
     task.runningBy="";
     task.paused=true;
     task.pausedAt=now.toISOString();
     task.pauseReason=reason;
     task.pauseNote=note;
     task.done=false;
     task.completedAt="";
     task.taskOutcome="";
     task.outcomeAt="";
     task.outcomeBy="";
     await closeOpenTaskSession(db,workOrderId,uid,req.user.username,"paused",reason,note);
   }

   if(action==="complete"){
     if(!taskRunning(task)){
       await db.query("ROLLBACK");return res.status(409).json({error:"Start or resume this task before completing it."});
     }
     if(taskRunningMechanic(task,w)!==String(req.user.username||"").toLowerCase()){await db.query("ROLLBACK");return res.status(409).json({error:"Only the mechanic who started this task can complete it."});}
     const started=new Date(task.startedAt);
     task.elapsedMs=Number(task.elapsedMs||0)+Math.max(0,now.getTime()-started.getTime());
     task.stoppedAt=now.toISOString();
     task.runningBy="";
     task.paused=false;
     task.pausedAt="";
     task.pauseReason="";
     task.pauseNote="";
     task.done=true;
     task.completedAt=now.toISOString();
     task.taskOutcome="completed";
     task.outcomeNote="";
     task.outcomeAt=now.toISOString();
     task.outcomeBy=req.user.username;
     await closeOpenTaskSession(db,workOrderId,uid,req.user.username,"completed");
   }

   const u=await db.query(
     "UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",
     [JSON.stringify(sf),req.user.username]
   );
   await db.query("COMMIT");
   await audit(req.user.username,"task_action",{workOrderId,taskUid:uid,taskName:String(task.t||""),action,pauseReason:req.body?.reason||""});
   res.json({ok:true,shopflow:sf,version:Number(u.rows[0].version),updatedAt:u.rows[0].updated_at,taskUid:uid});
 }catch(e){
   try{await db.query("ROLLBACK")}catch(_){}
   next(e);
 }finally{db.release();}
});


app.get("/api/work-orders/:id/pdf",auth,async(req,res,next)=>{try{
 const workOrderId=String(req.params.id),db=requireDb();
 const q=await db.query("SELECT state_key,payload FROM app_state WHERE state_key IN ('shopflow','pro')");
 const states=Object.fromEntries(q.rows.map(r=>[r.state_key,r.payload]));
 const sf=states.shopflow&&typeof states.shopflow==="object"?states.shopflow:{workorders:[],issues:[]};
 const pro=states.pro&&typeof states.pro==="object"?states.pro:{vehicles:[]};
 const w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===workOrderId);
 if(!w)return res.status(404).json({error:"Work order not found."});
 if(req.user?.role!=="admin"&&!mechanicOwnsWorkOrder(req.user,w))return res.status(403).json({error:"You do not have access to this work order."});
 if(String(w.status)!=="Completed")return res.status(409).json({error:"Work order PDF is available after the work order is completed."});
 const profileVehicle=(Array.isArray(pro.vehicles)?pro.vehicles:[]).find(v=>String(v?.unit||"").toLowerCase()===String(w.unit||"").toLowerCase())||{}; const vehicle={year:w.year||profileVehicle.year,make:w.make||profileVehicle.make,model:w.model||profileVehicle.model,vin:w.vin||profileVehicle.vin,plate:w.plate||profileVehicle.plate,mileage:w.mileage||profileVehicle.mileage,engine:w.engine||profileVehicle.engine,transmission:w.transmission||profileVehicle.transmission,customer:w.customer||profileVehicle.customer};
 const sessions=(await db.query(`SELECT task_uid,task_name,mechanic_username,started_at,ended_at,end_reason,pause_reason,pause_note FROM task_time_sessions WHERE work_order_id=$1 ORDER BY started_at,id`,[workOrderId])).rows||[];
 const findings=(Array.isArray(sf.issues)?sf.issues:[]).filter(i=>String(i?.wo)===workOrderId);
 const users=(await db.query("SELECT username,display_name FROM auth_users")).rows;
 const names=Object.fromEntries(users.map(r=>[String(r.username).toLowerCase(),r.display_name||r.username]));
 const mech=u=>names[String(u||"").toLowerCase()]||String(u||"—");
 const safe=v=>String(v??"").replace(/\r/g,"").trim();
 const fmt=d=>{try{return d?new Date(d).toLocaleString("en-US",{timeZone:"America/Chicago"}):"—"}catch(_){return safe(d)||"—"}};
 const ms=(a,b)=>a&&b?Math.max(0,new Date(b)-new Date(a)):0;
 const duration=n=>{const m=Math.round(n/60000),h=Math.floor(m/60);return h?`${h}h ${m%60}m`:`${m}m`};
 const fileUnit=safe(w.unit).replace(/[^a-zA-Z0-9_-]/g,"_")||"unit";
 res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename="ITTR-WO-${workOrderId}-${fileUnit}.pdf"`);res.setHeader("Cache-Control","private, no-store");
 const doc=new PDFDocument({size:"LETTER",margin:34,bufferPages:true,info:{Title:`ITTR Work Order ${workOrderId}`}});
 doc.pipe(res);
 const L=34,R=578,W=544;
 const box=(x,y,wid,hei)=>doc.rect(x,y,wid,hei).strokeColor("#444").lineWidth(.7).stroke();
 const band=(title,y)=>{doc.rect(L,y,W,20).fill("#202833");doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10).text(title,L+6,y+5,{width:W-12,align:"center"});return y+20};
 const field=(label,value,x,y,wid,hei=28)=>{box(x,y,wid,hei);doc.fillColor("#222").font("Helvetica-Bold").fontSize(7.5).text(label,x+5,y+4);doc.font("Helvetica").fontSize(9).text(safe(value)||"—",x+5,y+14,{width:wid-10,height:hei-15,ellipsis:true});};
 const ensure=h=>{if(doc.y+h>735){doc.addPage();doc.y=40;}};
 doc.fillColor("#111").font("Helvetica-Bold").fontSize(20).text("IRON TEAM TRUCK & TRAILER REPAIR",L,36,{width:W,align:"center"});
 doc.fontSize(11).text("TRUCK REPAIR WORK ORDER",L,62,{width:W,align:"center"});
 doc.font("Helvetica").fontSize(8).fillColor("#555").text("Completed work order summary for invoice preparation",L,78,{width:W,align:"center"});
 let y=98;
 field("REPAIR ORDER NUMBER",`#${workOrderId}`,L,y,210);field("DATE IN",`${safe(w.date)} ${safe(w.time)}`,L+210,y,167);field("DATE OUT",fmt(w.completedAt),L+377,y,167);y+=36;
 y=band("VEHICLE INFORMATION",y);
 field("UNIT",w.unit,L,y,136);field("TRUCK MAKE / MODEL",[vehicle.make,vehicle.model].filter(Boolean).join(" "),L+136,y,210);field("YEAR",vehicle.year,L+346,y,80);field("LICENSE PLATE",vehicle.plate,L+426,y,118);y+=28;
 field("VIN (VEHICLE IDENTIFICATION NUMBER)",vehicle.vin,L,y,346);field("MILEAGE",vehicle.mileage?Number(vehicle.mileage).toLocaleString()+" mi":"—",L+346,y,198);y+=36;
 y=band("CUSTOMER / WORK ORDER INFORMATION",y);
 field("CUSTOMER / COMPANY",w.customer||vehicle.customer,L,y,272);field("PARKING",w.parking,L+272,y,90);field("PRIORITY",w.priority,L+362,y,90);field("STATUS",w.status,L+452,y,92);y+=36;
 y=band("REPAIR / SERVICE & PARTS",y);
 const cols=[28,176,100,38,62,140], heads=["#","DESCRIPTION OF REPAIR / SERVICE","PART NUMBER","QTY","LABOR","MECHANIC / RESULT"];
 let x=L;heads.forEach((h,i)=>{box(x,y,cols[i],24);doc.fillColor("#111").font("Helvetica-Bold").fontSize(7).text(h,x+3,y+7,{width:cols[i]-6,align:i===0?"center":"left"});x+=cols[i]});y+=24;
 (Array.isArray(w.tasks)?w.tasks:[]).forEach((t,i)=>{
   const ts=sessions.filter(s=>String(s.task_uid||"")===String(t.uid||""));
   const labor=ts.reduce((a,s)=>a+ms(s.started_at,s.ended_at),0);
   const mechanics=[...new Set(ts.map(s=>mech(s.mechanic_username)))].join(", ")||mech(t.outcomeBy);
   const result=String(t.taskOutcome||"").replaceAll("_"," ")||(t.done?"completed":"—");
   const parts=Array.isArray(t.parts)&&t.parts.length?t.parts:[{partNumber:"",description:"",qty:""}];
   parts.forEach((p,pi)=>{
     ensure(42); if(doc.y!==y) y=doc.y;
     const desc=pi===0?safe(t.t):safe(p.description);
     const pn=safe(p.partNumber);
     const partDesc=pi===0&&p.description?`\nPart: ${safe(p.description)}`:"";
     const mechResult=pi===0?`${mechanics}\n${result}${t.outcomeNote?` — ${safe(t.outcomeNote)}`:""}`:"";
     const h=Math.max(38, 14+Math.max(desc.length/28,pn.length/15,mechResult.length/24)*7);
     x=L;
     const vals=[pi===0?String(i+1):"",desc+partDesc,pn,p.qty?String(p.qty):"",pi===0?duration(labor):"",mechResult];
     vals.forEach((v,ci)=>{box(x,y,cols[ci],h);doc.fillColor("#222").font(ci===1&&pi===0?"Helvetica-Bold":"Helvetica").fontSize(7.5).text(v,x+3,y+5,{width:cols[ci]-6,height:h-8,ellipsis:true});x+=cols[ci]});
     y+=h;doc.y=y;
   });
 });
 y+=10;doc.y=y;ensure(120);y=doc.y;
 y=band("MECHANIC LABOR SUMMARY",y);
 const by={};sessions.forEach(s=>{const u=String(s.mechanic_username||"unknown");by[u]=(by[u]||0)+ms(s.started_at,s.ended_at)});
 const laborText=Object.keys(by).length?Object.entries(by).map(([u,n])=>`${mech(u)} — ${duration(n)}`).join("    |    "):"No recorded timed labor.";
 box(L,y,W,28);doc.fillColor("#222").font("Helvetica").fontSize(9).text(laborText,L+6,y+8,{width:W-12});y+=36;
 ensure(120);y=doc.y=Math.max(doc.y,y);y=band("FINDINGS / RECOMMENDATIONS",y);
 const findText=findings.length?findings.map((f,i)=>`${i+1}. ${safe(f.description)||"Finding"}${f.recommendation?` — ${safe(f.recommendation)}`:""} [${safe(f.approval)||"Waiting for Customer"}]`).join("\n"):"No findings recorded.";
 const fh=Math.max(42,Math.min(130,28+findText.length/70*9));box(L,y,W,fh);doc.fillColor("#222").font("Helvetica").fontSize(8.5).text(findText,L+6,y+7,{width:W-12,height:fh-12});y+=fh+8;
 ensure(135);y=doc.y=Math.max(doc.y,y);y=band("NOTES / NEXT VISIT",y);
 const notes=`Initial notes: ${safe(w.notes)||"—"}\nCompletion notes: ${safe(w.completionNotes)||"—"}\nFuture repair / next visit: ${safe(w.futureNotes)||"—"}${w.revisitMiles?`\nRecommended recheck mileage: ${safe(w.revisitMiles)} miles`:""}`;
 box(L,y,W,78);doc.fillColor("#222").font("Helvetica").fontSize(8.5).text(notes,L+6,y+7,{width:W-12,height:66});y+=88;
 field("PRIMARY MECHANIC",mech(w.mechanic),L,y,180);field("HELPER MECHANICS",(Array.isArray(w.helpers)?w.helpers:[]).map(mech).join(", ")||"—",L+180,y,220);field("COMPLETED BY",mech(w.completedBy),L+400,y,144);doc.y=y+36;
 const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.font("Helvetica").fontSize(6.8).fillColor("#777").text(`ITTR ShopFlow · Work Order #${workOrderId} · Page ${i+1} of ${pages.count}`,L,756,{width:W,align:"center"})}
 doc.end();
}catch(e){next(e)}});

app.get("/api/work-orders/:id/task-sessions",auth,async(req,res,next)=>{try{
  const workOrderId=String(req.params.id);
  const stateQ=await requireDb().query("SELECT payload FROM app_state WHERE state_key='shopflow'");
  if(!stateQ.rowCount)return res.status(404).json({error:"Shop data not found."});
  const sf=stateQ.rows[0].payload&&typeof stateQ.rows[0].payload==="object"?stateQ.rows[0].payload:{workorders:[]};
  const w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===workOrderId);
  if(!w)return res.status(404).json({error:"Work order not found."});
  if(!mechanicOwnsWorkOrder(req.user,w) && req.user?.role!=="admin")
    return res.status(403).json({error:"You do not have access to this work order."});

  const tasks=Array.isArray(w.tasks)?w.tasks:[];
  const validUids=[...new Set(tasks.map(t=>String(t?.uid||"")).filter(Boolean))];
  if(!validUids.length)return res.json({ok:true,workOrderId,sessions:[]});

  const q=await requireDb().query(
    `SELECT id,work_order_id,task_index,task_uid,task_name,mechanic_username,
            started_at,ended_at,end_reason,pause_reason,pause_note,created_at
     FROM task_time_sessions
     WHERE work_order_id=$1
       AND task_uid = ANY($2::text[])
     ORDER BY started_at,id`,
    [workOrderId,validUids]
  );
  res.json({ok:true,workOrderId,sessions:q.rows});
}catch(e){next(e)}});

app.get("/api/admin/productivity",auth,adminOnly,async(req,res,next)=>{try{
  const start=new Date(String(req.query.start||"")),end=new Date(String(req.query.end||""));
  if(isNaN(start)||isNaN(end)||end<=start)return res.status(400).json({error:"Valid start and end timestamps are required."});
  if(end-start>1000*60*60*24*62)return res.status(400).json({error:"Productivity range cannot exceed 62 days."});
  const mechanic=cleanUsername(req.query.mechanic||"");
  const params=[start.toISOString(),end.toISOString()];
  let mechSql="";if(mechanic){params.push(mechanic);mechSql=" AND mechanic_username=$3";}
  const q=await requireDb().query(`SELECT id,work_order_id,task_index,task_uid,task_name,mechanic_username,started_at,ended_at,end_reason,pause_reason,pause_note
    FROM task_time_sessions
    WHERE started_at < $2::timestamptz
      AND COALESCE(ended_at,now()) > $1::timestamptz${mechSql}
    ORDER BY started_at,id`,params);
  const stateQ=await requireDb().query("SELECT payload FROM app_state WHERE state_key='shopflow'");
  const sf=stateQ.rows[0]?.payload&&typeof stateQ.rows[0].payload==="object"?stateQ.rows[0].payload:{workorders:[]};
  const woMap=new Map((Array.isArray(sf.workorders)?sf.workorders:[]).map(w=>[String(w.id),w]));
  const sessions=q.rows.map(r=>{const w=woMap.get(String(r.work_order_id))||{};return {id:r.id,workOrderId:String(r.work_order_id),taskUid:r.task_uid||"",taskName:r.task_name||"",mechanicUsername:r.mechanic_username,startedAt:r.started_at,endedAt:r.ended_at,endReason:r.end_reason||"",pauseReason:r.pause_reason||"",pauseNote:r.pause_note||"",unit:String(w.unit||""),customer:String(w.customer||"")}});
  res.json({ok:true,start:start.toISOString(),end:end.toISOString(),mechanic:mechanic||"all",sessions});
}catch(e){next(e)}});

app.get("/api/admin/backup",auth,adminOnly,async(req,res,next)=>{try{
  const states=await requireDb().query("SELECT state_key,payload,version,updated_at,updated_by FROM app_state ORDER BY state_key");
  const users=await requireDb().query("SELECT username,display_name,role,language,active,created_at,updated_at FROM auth_users ORDER BY username");
  const sessions=await requireDb().query("SELECT work_order_id,task_index,task_uid,task_name,mechanic_username,started_at,ended_at,end_reason,pause_reason,pause_note FROM task_time_sessions ORDER BY started_at");
  const migrations=await requireDb().query("SELECT migration_key,applied_at FROM schema_migrations ORDER BY applied_at");
  await requireDb().query("INSERT INTO data_exports(created_by,note) VALUES($1,$2)",[req.user.username,"manual JSON backup"]);
  res.setHeader("Content-Disposition",`attachment; filename="ittr-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.json({exportedAt:new Date().toISOString(),version:"22.4.0",states:states.rows,users:users.rows,taskTimeSessions:sessions.rows,migrations:migrations.rows});
}catch(e){next(e)}});

app.get("/api/admin/data-safety",auth,adminOnly,async(req,res,next)=>{try{
  const [h,sess,mig]=await Promise.all([
    requireDb().query("SELECT count(*)::int c FROM app_state_history"),
    requireDb().query("SELECT count(*)::int c FROM task_time_sessions"),
    requireDb().query("SELECT migration_key,applied_at FROM schema_migrations ORDER BY applied_at DESC")
  ]);
  res.json({historySnapshots:h.rows[0].c,taskSessions:sess.rows[0].c,migrations:mig.rows});
}catch(e){next(e)}});


function findingTaskText(issue){
  return String(issue?.recommendation||"").trim() || String(issue?.description||"").trim();
}
function reconcileApprovedFindingsInShopflow(shopflow){
  const sf=shopflow&&typeof shopflow==="object"?shopflow:{workorders:[],issues:[]};
  sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
  sf.issues=Array.isArray(sf.issues)?sf.issues:[];
  let changed=false,added=0;
  for(const issue of sf.issues){
    if(String(issue?.approval||"")!=="Proceed")continue;
    const wo=sf.workorders.find(w=>String(w?.id)===String(issue?.wo));
    if(!wo)continue;
    wo.tasks=Array.isArray(wo.tasks)?wo.tasks:[];
    const text=findingTaskText(issue);
    if(!text)continue;
    const exists=wo.tasks.some(t=>
      String(t?.findingId??"")===String(issue?.id??"") ||
      String(t?.t||"").trim().toLowerCase()===text.toLowerCase()
    );
    if(!exists){
      wo.tasks.push({
        uid:`wo-${String(wo.id)}-finding-${String(issue.id)}-${crypto.randomBytes(4).toString("hex")}`,
        t:text,done:false,startedAt:"",stoppedAt:"",elapsedMs:0,completedAt:"",
        source:"inspection",findingId:issue.id,taskOutcome:"",outcomeNote:"",
        outcomeAt:"",outcomeBy:""
      });
      added++;changed=true;
    }
    if(issue.convertedToTask!==true){issue.convertedToTask=true;changed=true;}
  }
  return {shopflow:sf,changed,added};
}


async function repairTaskUidsAtStartup(){
  if(!pool)return;
  const db=await pool.connect();
  try{
    await db.query("BEGIN");
    const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
    if(!q.rowCount){await db.query("COMMIT");return;}

    const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[]};
    sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
    let changed=false,missingCreated=0,duplicateReassigned=0,recovered=0;

    for(const w of sf.workorders){
      w.tasks=Array.isArray(w.tasks)?w.tasks:[];
      const seen=new Map();

      for(let i=0;i<w.tasks.length;i++){
        const t=w.tasks[i];
        if(!t)continue;
        let uid=String(t.uid||"").trim();

        if(!uid){
          const hasPriorWork=Boolean(
            t.startedAt || t.stoppedAt || t.completedAt ||
            Number(t.elapsedMs||0)>0 || t.done ||
            ["completed","not_completed","next_visit"].includes(String(t.taskOutcome||""))
          );
          let recoveredUid="";
          if(hasPriorWork){
            const sq=await db.query(
              `SELECT DISTINCT task_uid
               FROM task_time_sessions
               WHERE work_order_id=$1
                 AND task_index=$2
                 AND task_uid IS NOT NULL
                 AND task_uid<>''
               LIMIT 2`,
              [String(w.id),i]
            );
            if(sq.rowCount===1)recoveredUid=String(sq.rows[0].task_uid||"");
          }
          uid=recoveredUid || `wo-${String(w.id)}-task-${i}-${crypto.randomBytes(12).toString("hex")}`;
          t.uid=uid;
          if(recoveredUid)recovered++; else missingCreated++;
          changed=true;
        }

        if(seen.has(uid)){
          const firstIndex=seen.get(uid);
          const first=w.tasks[firstIndex];

          // Preserve the old UID on the task that has stronger evidence of historical work.
          const score=x=>
            (Number(x?.elapsedMs||0)>0?8:0)+
            (x?.startedAt?4:0)+(x?.stoppedAt?2:0)+(x?.completedAt?4:0)+
            (x?.done?4:0)+(x?.findingId?1:0);

          if(score(t)>score(first)){
            const replacement=`wo-${String(w.id)}-task-${firstIndex}-${crypto.randomBytes(12).toString("hex")}`;
            first.uid=replacement;
            seen.set(replacement,firstIndex);
            seen.set(uid,i);
          }else{
            const replacement=`wo-${String(w.id)}-task-${i}-${crypto.randomBytes(12).toString("hex")}`;
            t.uid=replacement;
            seen.set(replacement,i);
          }
          duplicateReassigned++;
          changed=true;
        }else{
          seen.set(uid,i);
        }
      }
    }

    if(changed){
      await db.query(
        "UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by='system-task-identity-repair' WHERE state_key='shopflow'",
        [JSON.stringify(sf)]
      );
      console.log(`ITTR task identity repair: ${recovered} recovered, ${missingCreated} missing created, ${duplicateReassigned} duplicate reassigned.`);
    }
    await db.query("COMMIT");
  }catch(e){
    try{await db.query("ROLLBACK")}catch(_){}
    console.error("Task UID repair failed:",e);
  }finally{db.release();}
}

async function migrateLegacyFindingPhotosAtStartup(){
 if(!pool||!r2Configured)return;
 const db=await pool.connect();
 try{
   await db.query("BEGIN");
   const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
   if(!q.rowCount){await db.query("ROLLBACK");return;}
   const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
   const issues=Array.isArray(sf.issues)?sf.issues:[];
   let migrated=0;
   for(const issue of issues){
     if(issue?.photoId || typeof issue?.photo!=="string" || !issue.photo.startsWith("data:image/"))continue;
     const m=issue.photo.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
     if(!m)continue;
     try{
       const buffer=Buffer.from(m[1],"base64");
       if(!buffer.length)continue;
       const saved=await putFindingPhoto({buffer,findingId:issue.id,workOrderId:issue.wo,uploader:issue.mechanic||"legacy",originalName:"legacy-finding-photo",db});
       issue.photoId=saved.photoId;
       issue.photo="";
       migrated++;
     }catch(e){console.error("Legacy finding photo migration skipped:",issue?.id,e?.message);}
   }
   if(migrated){
     await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by='system-photo-migration' WHERE state_key='shopflow'",[JSON.stringify(sf)]);
     console.log(`ITTR migrated ${migrated} legacy finding photo(s) to R2.`);
   }
   await db.query("COMMIT");
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}console.error("Legacy photo migration failed:",e)}
 finally{db.release()}
}

async function normalizeCollaborationAtStartup(){
 if(!pool)return;
 const db=await pool.connect();
 try{
  await db.query("BEGIN");const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");if(!q.rowCount){await db.query("ROLLBACK");return;}
  const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};let changed=false;
  for(const w of (Array.isArray(sf.workorders)?sf.workorders:[])){
   if(!Array.isArray(w.helpers)){w.helpers=[];changed=true}
   const primary=String(w.mechanic||"").toLowerCase(),clean=[...new Set(w.helpers.map(x=>String(x||"").trim().toLowerCase()).filter(x=>x&&x!==primary))];if(JSON.stringify(clean)!==JSON.stringify(w.helpers)){w.helpers=clean;changed=true}
   for(const t of (Array.isArray(w.tasks)?w.tasks:[])){if(typeof t.runningBy==="undefined"){t.runningBy=taskRunning(t)?(w.mechanic||""):"";changed=true}}
  }
  if(changed)await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by='system-collaboration-normalize' WHERE state_key='shopflow'",[JSON.stringify(sf)]);
  await db.query("COMMIT");
 }catch(e){try{await db.query("ROLLBACK")}catch(_){}console.error("Collaboration normalization failed:",e.message)}finally{db.release()}
}

async function repairApprovedFindingsAtStartup(){
  if(!pool)return;
  const clientDb=await pool.connect();
  try{
    await clientDb.query("BEGIN");
    const q=await clientDb.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
    if(q.rowCount){
      const result=reconcileApprovedFindingsInShopflow(q.rows[0].payload);
      if(result.changed){
        await clientDb.query(
          "UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by='system-reconcile' WHERE state_key='shopflow'",
          [JSON.stringify(result.shopflow)]
        );
        console.log(`ITTR finding reconciliation repaired ${result.added} approved finding task(s).`);
      }
    }
    await clientDb.query("COMMIT");
  }catch(e){
    await clientDb.query("ROLLBACK");
    console.error("Approved finding reconciliation failed:",e);
  }finally{clientDb.release();}
}

async function getShopflowPayload(db=requireDb()){
 const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");
 return q.rows[0]?.payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
}
function canAccessPhotoWorkOrder(user,w){
 if(user?.role==="admin")return true;
 return user?.role==="mechanic"&&assignedMechanicUsernames(w).includes(String(user?.username||"").trim().toLowerCase());
}
async function photoAccessRow(photoId,user){
 const q=await requireDb().query("SELECT * FROM finding_photos WHERE id=$1 AND deleted_at IS NULL",[String(photoId)]);
 if(!q.rowCount)return {status:404,error:"Photo not found."};
 const row=q.rows[0],sf=await getShopflowPayload(),w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===String(row.work_order_id));
 if(!w && user?.role!=="admin")return {status:403,error:"Photo access denied."};
 if(w&&!canAccessPhotoWorkOrder(user,w))return {status:403,error:"Photo access denied."};
 return {row,w};
}

app.get("/api/photos/status",auth,adminOnly,async(req,res)=>{
 let storageReachable=false,error="";
 try{
   if(r2Configured){
     await requireR2().send(new HeadBucketCommand({Bucket:r2Bucket}));
     const probe=await requireDb().query("SELECT COUNT(*)::int AS count FROM finding_photos WHERE deleted_at IS NULL");
     storageReachable=true;
     return res.json({configured:true,storageReachable:true,bucket:r2Bucket,photoCount:Number(probe.rows[0]?.count||0)});
   }
 }catch(e){error=String(e?.message||e).slice(0,300)}
 res.status(r2Configured?500:503).json({configured:r2Configured,storageReachable,error:error||"R2 is not configured."});
});

app.post("/api/findings/:findingId/photo",auth,photoUpload.single("photo"),async(req,res,next)=>{
 try{
   requireR2();
   if(!req.file?.buffer?.length)return res.status(400).json({error:"Choose or take a photo first."});
   const findingId=String(req.params.findingId||"").trim();
   const workOrderId=String(req.body?.workOrderId||"").trim();
   if(!findingId||!workOrderId)return res.status(400).json({error:"Finding ID and work order are required."});
   const sf=await getShopflowPayload();
   const w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===workOrderId);
   if(!w)return res.status(404).json({error:"Work order not found. Refresh the app and try again."});
   if(!canAccessPhotoWorkOrder(req.user,w))return res.status(403).json({error:"You do not have access to upload a photo to this work order."});
   const saved=await putFindingPhoto({buffer:req.file.buffer,findingId,workOrderId,uploader:req.user.username,originalName:req.file.originalname});
   await audit(req.user.username,"finding_photo_uploaded",{findingId,workOrderId,photoId:saved.photoId,size:saved.size,width:saved.width,height:saved.height});
   res.json({ok:true,...saved});
 }catch(e){next(e)}
});

app.get("/api/photos/:photoId/url",auth,async(req,res,next)=>{
 try{
   requireR2();
   const access=await photoAccessRow(req.params.photoId,req.user);
   if(access.error)return res.status(access.status).json({error:access.error});
   const url=await getSignedUrl(requireR2(),new GetObjectCommand({Bucket:r2Bucket,Key:access.row.r2_key}),{expiresIn:600});
   res.setHeader("Cache-Control","private, max-age=240");
   res.json({url,expiresIn:600});
 }catch(e){next(e)}
});

app.delete("/api/photos/:photoId",auth,async(req,res,next)=>{
 try{
   requireR2();
   const access=await photoAccessRow(req.params.photoId,req.user);
   if(access.error)return res.status(access.status).json({error:access.error});
   if(req.user.role!=="admin"&&String(access.row.uploader_username)!==String(req.user.username))return res.status(403).json({error:"Only the uploader or an admin can remove this photo."});
   await requireR2().send(new DeleteObjectCommand({Bucket:r2Bucket,Key:access.row.r2_key}));
   await requireDb().query("UPDATE finding_photos SET deleted_at=now() WHERE id=$1",[String(req.params.photoId)]);
   await audit(req.user.username,"finding_photo_deleted",{photoId:String(req.params.photoId),findingId:access.row.finding_id,workOrderId:access.row.work_order_id});
   res.json({ok:true});
 }catch(e){next(e)}
});

app.post("/api/findings/:id/decision",auth,adminOnly,async(req,res,next)=>{
 const db=await requireDb().connect();
 try{
   const id=String(req.params.id);
   const value=String(req.body?.value||"");
   if(!["Proceed","Waiting for Customer","Do Not Proceed"].includes(value))
     return res.status(400).json({error:"Invalid finding decision."});

   await db.query("BEGIN");
   const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
   if(!q.rowCount){await db.query("ROLLBACK");return res.status(404).json({error:"Shop state not found."});}

   const sf=q.rows[0].payload&&typeof q.rows[0].payload==="object"?q.rows[0].payload:{workorders:[],issues:[]};
   sf.workorders=Array.isArray(sf.workorders)?sf.workorders:[];
   sf.issues=Array.isArray(sf.issues)?sf.issues:[];
   const issue=sf.issues.find(i=>String(i?.id)===id);
   if(!issue){await db.query("ROLLBACK");return res.status(404).json({error:"Finding not found."});}
   const wo=sf.workorders.find(w=>String(w?.id)===String(issue?.wo));
   if(!wo){await db.query("ROLLBACK");return res.status(409).json({error:"This finding is not linked to an existing work order."});}
   wo.tasks=Array.isArray(wo.tasks)?wo.tasks:[];

   issue.approval=value;
   issue.decisionAt=new Date().toISOString();
   issue.decisionBy=req.user.username;

   const text=findingTaskText(issue);
   let taskIndex=wo.tasks.findIndex(t=>String(t?.findingId??"")===id);
   if(taskIndex<0 && text){
     taskIndex=wo.tasks.findIndex(t=>String(t?.t||"").trim().toLowerCase()===text.toLowerCase());
   }
   let taskAdded=false;

   if(value==="Proceed"){
     if(!text){await db.query("ROLLBACK");return res.status(409).json({error:"Finding has no repair description or recommendation."});}
     if(taskIndex<0){
       wo.tasks.push({
         uid:`wo-${String(wo.id)}-finding-${String(issue.id)}-${crypto.randomBytes(4).toString("hex")}`,
         t:text,done:false,startedAt:"",stoppedAt:"",elapsedMs:0,completedAt:"",
         source:"inspection",findingId:issue.id,taskOutcome:"",outcomeNote:"",
         outcomeAt:"",outcomeBy:"",findingDecision:"Proceed",
         approvalChangedAt:issue.decisionAt,approvalChangedBy:req.user.username,
         paused:false,pausedAt:"",pauseReason:"",pauseNote:"",cancelled:false
       });
       taskIndex=wo.tasks.length-1;
       taskAdded=true;
     }else{
       const task=wo.tasks[taskIndex];
       task.findingId=issue.id;
       task.source="inspection";
       task.findingDecision="Proceed";
       task.approvalChangedAt=issue.decisionAt;
       task.approvalChangedBy=req.user.username;
       task.cancelled=false;
       task.declinedAt="";
       task.declinedBy="";
       if(["declined","waiting_customer"].includes(String(task.taskOutcome||""))){
         task.taskOutcome="";
         task.outcomeNote="";
         task.outcomeAt="";
         task.outcomeBy="";
         task.done=false;
         task.completedAt="";
       }
       if(task.pauseReason==="Waiting for Customer Approval"){
         task.paused=false;
         task.pausedAt="";
         task.pauseReason="";
         task.pauseNote="";
       }
     }
     issue.convertedToTask=true;
   }

   if(value==="Waiting for Customer" && taskIndex>=0){
     const task=wo.tasks[taskIndex];
     if(taskRunning(task)){
       const now=new Date(),started=new Date(task.startedAt);
       task.elapsedMs=Number(task.elapsedMs||0)+Math.max(0,now.getTime()-started.getTime());
       task.stoppedAt=now.toISOString();
       if(task.uid)await closeOpenTaskSession(db,wo.id,task.uid,taskRunningMechanic(task,wo)||wo.mechanic||req.user.username,"approval_hold","Waiting for Customer Approval","");
       task.runningBy="";
     }
     task.findingDecision="Waiting for Customer";
     task.approvalChangedAt=issue.decisionAt;
     task.approvalChangedBy=req.user.username;
     task.paused=true;
     task.pausedAt=issue.decisionAt;
     task.pauseReason="Waiting for Customer Approval";
     task.pauseNote="";
     task.taskOutcome="waiting_customer";
     task.outcomeNote="Waiting for customer approval";
     task.outcomeAt=issue.decisionAt;
     task.outcomeBy=req.user.username;
     task.done=false;
     task.completedAt="";
     issue.convertedToTask=true;
   }

   if(value==="Do Not Proceed" && taskIndex>=0){
     const task=wo.tasks[taskIndex];
     if(taskRunning(task)){
       const now=new Date(),started=new Date(task.startedAt);
       task.elapsedMs=Number(task.elapsedMs||0)+Math.max(0,now.getTime()-started.getTime());
       task.stoppedAt=now.toISOString();
       if(task.uid)await closeOpenTaskSession(db,wo.id,task.uid,taskRunningMechanic(task,wo)||wo.mechanic||req.user.username,"declined","Do Not Proceed","");
       task.runningBy="";
     }
     task.findingDecision="Do Not Proceed";
     task.approvalChangedAt=issue.decisionAt;
     task.approvalChangedBy=req.user.username;
     task.cancelled=true;
     task.declinedAt=issue.decisionAt;
     task.declinedBy=req.user.username;
     task.paused=false;
     task.pausedAt="";
     task.pauseReason="";
     task.pauseNote="";
     task.done=false;
     task.completedAt="";
     task.taskOutcome="declined";
     task.outcomeNote="Admin / customer changed decision to Do Not Proceed";
     task.outcomeAt=issue.decisionAt;
     task.outcomeBy=req.user.username;
     issue.convertedToTask=true;
   }

   if((value==="Waiting for Customer" || value==="Do Not Proceed") && taskIndex<0){
     issue.convertedToTask=false;
   }

   const u=await db.query(
     "UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version,updated_at",
     [JSON.stringify(sf),req.user.username]
   );
   await db.query("COMMIT");
   await audit(req.user.username,"finding_decision",{findingId:id,value,workOrderId:String(wo.id),taskIndex,taskAdded});
   res.json({ok:true,shopflow:sf,version:Number(u.rows[0].version),taskAdded,taskIndex});
 }catch(e){
   try{await db.query("ROLLBACK")}catch(_){}
   next(e);
 }finally{db.release();}
});

app.post("/api/state/import-local",auth,adminOnly,async(req,res,next)=>{try{
 const users=req.body?.users||{},shopflow=req.body?.shopflow||{workorders:[],issues:[]},pro=req.body?.pro||{};
 const sanitized={};
 for(const [username0,u] of Object.entries(users)){
   const username=cleanUsername(username0);if(!username)continue;
   sanitized[username]={...u};delete sanitized[username].password;
   if(u?.password && String(u.password).length>=6){
     const h=await bcrypt.hash(String(u.password),12),role=u.role==="admin"?"admin":"mechanic";
     await pool.query(`INSERT INTO auth_users(username,display_name,password_hash,role,language,active) VALUES($1,$2,$3,$4,$5,true)
       ON CONFLICT(username) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,language=EXCLUDED.language,active=true,updated_at=now()`,[username,u.display||username,h,role,u.language||"en"]);
   }
 }
 await pool.query("UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1",["users",JSON.stringify(sanitized),req.user.username]);
 await pool.query("UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1",["shopflow",JSON.stringify(shopflow),req.user.username]);
 await pool.query("UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1",["pro",JSON.stringify(pro),req.user.username]);
 await audit(req.user.username,"import_local_data",{users:Object.keys(sanitized).length,workorders:Array.isArray(shopflow?.workorders)?shopflow.workorders.length:0});res.json({ok:true});
}catch(e){next(e)}});

app.get("/api/admin/staff",auth,managerPermission("employees"),async(req,res,next)=>{try{const q=await requireDb().query("SELECT username,display_name,role,email,permissions,language,active,created_at FROM auth_users ORDER BY role,display_name");res.json({items:q.rows.map(publicUser)})}catch(e){next(e)}});
app.post("/api/admin/managers",auth,ownerOnly,async(req,res,next)=>{try{const username=cleanUsername(req.body?.username),display=String(req.body?.display||'').trim(),email=String(req.body?.email||'').trim(),password=String(req.body?.password||''),permissions=req.body?.permissions&&typeof req.body.permissions==='object'?req.body.permissions:{};if(!username||!display||password.length<8)return res.status(400).json({error:'Username, name and password of at least 8 characters are required.'});const hash=await bcrypt.hash(password,12);await requireDb().query("INSERT INTO auth_users(username,display_name,password_hash,role,email,permissions) VALUES($1,$2,$3,'manager',$4,$5::jsonb)",[username,display,hash,email||null,JSON.stringify(permissions)]);await audit(req.user.username,'manager_created',{username,permissions});res.json({ok:true})}catch(e){if(e?.code==='23505')return res.status(409).json({error:'That username already exists.'});next(e)}});
app.put("/api/admin/managers/:username",auth,ownerOnly,async(req,res,next)=>{try{const username=cleanUsername(req.params.username),permissions=req.body?.permissions&&typeof req.body.permissions==='object'?req.body.permissions:{},display=String(req.body?.display||'').trim(),email=String(req.body?.email||'').trim();const q=await requireDb().query("UPDATE auth_users SET display_name=coalesce(nullif($2,''),display_name),email=nullif($3,''),permissions=$4::jsonb,updated_at=now() WHERE username=$1 AND role='manager' RETURNING *",[username,display,email,JSON.stringify(permissions)]);if(!q.rowCount)return res.status(404).json({error:'Manager not found.'});await audit(req.user.username,'manager_permissions_updated',{username,permissions});res.json({user:publicUser(q.rows[0])})}catch(e){next(e)}});
app.delete("/api/admin/managers/:username",auth,ownerOnly,async(req,res,next)=>{try{const q=await requireDb().query("DELETE FROM auth_users WHERE username=$1 AND role='manager' RETURNING username",[cleanUsername(req.params.username)]);if(!q.rowCount)return res.status(404).json({error:'Manager not found.'});await audit(req.user.username,'manager_deleted',{username:req.params.username});res.json({ok:true})}catch(e){next(e)}});
app.post("/api/admin/users",auth,managerPermission("employees"),async(req,res,next)=>{try{
 const username=cleanUsername(req.body?.username),display=String(req.body?.display||"").trim(),password=String(req.body?.password||"");
 if(!username||!display||password.length<6)return res.status(400).json({error:"Username, display name, and password of at least 6 characters are required."});
 const h=await bcrypt.hash(password,12);
 await pool.query("INSERT INTO auth_users(username,display_name,password_hash,role) VALUES($1,$2,$3,'mechanic')",[username,display,h]);
 await audit(req.user.username,"mechanic_created",{username});res.json({user:{username,display,role:"mechanic"}});
}catch(e){if(e?.code==="23505")return res.status(409).json({error:"That username already exists."});next(e)}});
app.patch("/api/admin/users/:username/password",auth,managerPermission("employees"),async(req,res,next)=>{try{const username=cleanUsername(req.params.username),password=String(req.body?.password||"");if(password.length<6)return res.status(400).json({error:"Password must be at least 6 characters."});const h=await bcrypt.hash(password,12);const q=await pool.query("UPDATE auth_users SET password_hash=$2,updated_at=now() WHERE username=$1 AND role='mechanic' RETURNING username",[username,h]);if(!q.rowCount)return res.status(404).json({error:"Mechanic account not found."});await audit(req.user.username,"mechanic_password_changed",{username});res.json({ok:true})}catch(e){next(e)}});
app.delete("/api/admin/users/:username",auth,managerPermission("employees"),async(req,res,next)=>{try{const username=cleanUsername(req.params.username);const q=await pool.query("DELETE FROM auth_users WHERE username=$1 AND role='mechanic' RETURNING username",[username]);if(!q.rowCount)return res.status(404).json({error:"Mechanic account not found."});await audit(req.user.username,"mechanic_deleted",{username});res.json({ok:true})}catch(e){next(e)}});

function parseAiJson(text){let t=String(text||'').trim();t=t.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');return JSON.parse(t)}
async function openRouterInvoiceExtract(file){
 const or=requireOpenRouterClient();
 const mime=String(file.mimetype||'');
 const b64=file.buffer.toString('base64');
 const prompt=`Extract this heavy-duty truck parts vendor invoice. Return ONLY strict JSON with this shape: {"vendor":"","invoiceNumber":"","invoiceDate":"YYYY-MM-DD or empty","poNumber":"","subtotal":0,"tax":0,"freight":0,"total":0,"lines":[{"partNumber":"","manufacturer":"","description":"","quantity":0,"unitCost":0,"coreCost":0,"lineTotal":0}]}. Preserve part numbers exactly. Never invent missing values. Costs and quantities must be numbers. If a quantity or cost is unclear use 0. Carefully distinguish unit cost, core charge, tax, freight and line total.`;
 const content=[{type:'text',text:prompt}];
 if(mime==='application/pdf') content.push({type:'file',file:{filename:file.originalname||'invoice.pdf',file_data:`data:application/pdf;base64,${b64}`}});
 else content.push({type:'image_url',image_url:{url:`data:${mime};base64,${b64}`}});
 const extra={models:[openRouterInvoiceFallbackModel],response_format:{type:'json_object'}};
 if(mime==='application/pdf')extra.plugins=[{id:'file-parser',pdf:{engine:'cloudflare-ai'}}];
 const r=await or.chat.completions.create({model:openRouterInvoiceModel,messages:[{role:'user',content}],temperature:0,max_tokens:5000,...extra});
 const text=String(r.choices?.[0]?.message?.content||'').trim();
 return {parsed:parseAiJson(text),model:String(r.model||openRouterInvoiceModel),usage:r.usage||null};
}
app.post("/api/parts/receiving/scan-invoice",auth,managerPermission("inventory"),upload.single("invoice"),async(req,res)=>{try{
 if(!req.file)return res.status(400).json({error:"Take a photo or upload a vendor invoice."});
 if(!openRouterClient)return res.status(503).json({error:"Invoice scanning requires OPENROUTER_API_KEY on Railway."});
 const mime=String(req.file.mimetype||''); if(!mime.startsWith('image/')&&mime!=="application/pdf")return res.status(415).json({error:"Use an invoice photo (JPG/PNG/WEBP) or PDF."});
 const result=await openRouterInvoiceExtract(req.file);
 const parsed=result.parsed; parsed.lines=Array.isArray(parsed.lines)?parsed.lines:[];
 const db=requireDb(); if(parsed.vendor)parsed.vendor=await resolveVendor(db,parsed.vendor,true); for(const line of parsed.lines){const pn=String(line.partNumber||'').trim();let m={rows:[]};if(pn)m=await db.query(`SELECT id,part_number,description,manufacturer,quantity,cost,price,vendor FROM fullbay_import_parts WHERE lower(regexp_replace(coalesce(part_number,''),'[^a-zA-Z0-9]','','g'))=lower(regexp_replace($1,'[^a-zA-Z0-9]','','g')) ORDER BY CASE WHEN lower(part_number)=lower($1) THEN 0 ELSE 1 END LIMIT 3`,[pn]);line.matches=m.rows;line.matchedPartId=m.rowCount===1?m.rows[0].id:null;line.matchStatus=m.rowCount===1?'matched':m.rowCount>1?'possible':'new'}
 res.json({extract:parsed,filename:req.file.originalname||'invoice',warnings:[],ai:{provider:'openrouter',model:result.model,usage:result.usage}});
 }catch(e){return aiErrorResponse(res,e,'Invoice scan failed')}});
app.post("/api/parts/receiving/receive",auth,managerPermission("inventory"),async(req,res,next)=>{const db=await requireDb().connect();let stage="validate";try{
 const inv=req.body?.invoice||{},lines=Array.isArray(req.body?.lines)?req.body.lines:[];
 if(!lines.length)return res.status(400).json({error:'No invoice lines to receive.'});
 const usable=lines.map((l,i)=>({l:l||{},i})).filter(x=>Number(x.l.quantity||0)>0);
 if(!usable.length)return res.status(400).json({error:'Every invoice line has zero quantity. Enter the quantity received.'});
 for(const {l,i} of usable){if(!Number(l.matchedPartId||0)&&!l.createNew)return res.status(400).json({error:`Line ${i+1} must be matched to an inventory part or marked Create New.`});if(!Number(l.matchedPartId||0)&&l.createNew&&!String(l.partNumber||'').trim())return res.status(400).json({error:`Line ${i+1} needs a part number before a new inventory item can be created.`})}
 const invoiceDate=/^\d{4}-\d{2}-\d{2}$/.test(String(inv.invoiceDate||'').trim())?String(inv.invoiceDate).trim():null;
 const invoiceNumber=String(inv.invoiceNumber||'').trim()||null;
 stage="begin";await db.query('BEGIN');
 stage="vendor";const canonicalVendor=await resolveVendor(db,inv.vendor,true);inv.vendor=canonicalVendor||String(inv.vendor||'').trim();
 stage="invoice";const ir=await db.query(`INSERT INTO parts_vendor_invoices(vendor,invoice_number,invoice_date,po_number,subtotal,tax,freight,total,tax_rate,tax_included_in_cost,source_filename,source_method,status,raw_extract,created_by,received_at) VALUES($1::text,$2::text,$3::date,$4::text,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$11::text,'scan','received',$12::jsonb,$13::text,now()) RETURNING id`,[inv.vendor||null,invoiceNumber,invoiceDate,String(inv.poNumber||'').trim()||null,Number(inv.subtotal||0),Number(inv.tax||0),Number(inv.freight||0),Number(inv.total||0),Number(inv.taxRate||0),Boolean(inv.taxIncludedInCost),String(req.body?.filename||'').slice(0,255)||null,JSON.stringify(inv),req.user.username]);
 const invoiceId=ir.rows[0].id;let received=0,created=0;
 const taxableBase=usable.reduce((a,{l})=>a+(l.taxable===false?0:Math.max(0,Number(l.quantity||0))*Math.max(0,Number(l.unitCost||0))),0);
 for(const {l,i} of usable){stage=`line_${i+1}`;let partId=Number(l.matchedPartId||0)||null;const qty=Math.max(0,Number(l.quantity||0)),unitCost=Math.max(0,Number(l.unitCost||0)),core=Math.max(0,Number(l.coreCost||0));
  if(partId){const exists=await db.query('SELECT id FROM fullbay_import_parts WHERE id=$1::bigint',[partId]);if(!exists.rowCount)throw Object.assign(new Error(`Line ${i+1}: selected inventory match no longer exists.`),{status:409})}
  if(!partId&&l.createNew){const pn=String(l.partNumber||'').trim();const normalized=pn.toLowerCase().replace(/[^a-z0-9]/g,'');stage=`line_${i+1}_match_new`;const existing=await db.query(`SELECT id FROM fullbay_import_parts WHERE lower(regexp_replace(coalesce(part_number,''),'[^a-zA-Z0-9]','','g'))=$1 ORDER BY id LIMIT 1`,[normalized]);if(existing.rowCount){partId=existing.rows[0].id}else{stage=`line_${i+1}_create`;const sk=`ittr-receive:${crypto.createHash('sha256').update(`${pn}|${invoiceId}|${i}`).digest('hex').slice(0,28)}`;const nr=await db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,manufacturer,quantity,cost,price,vendor,status,inventory_managed,purchase_taxable,raw,source_file) VALUES($1::text,$2::text,$3::text,$4::text,0::numeric,$5::numeric,0::numeric,$6::text,'Active',true,$7::boolean,'{}'::jsonb,'ITTR Smart Receiving') ON CONFLICT(source_key) DO UPDATE SET updated_at=now() RETURNING id`,[sk,pn,String(l.description||'').trim()||null,String(l.manufacturer||'').trim()||null,unitCost,inv.vendor||null,l.taxable!==false]);partId=nr.rows[0].id;created++}}
  const lineTax=(l.taxable===false||taxableBase<=0)?0:Number(inv.tax||0)*((qty*unitCost)/taxableBase);
  stage=`line_${i+1}_invoice_line`;await db.query(`INSERT INTO parts_vendor_invoice_lines(invoice_id,line_no,vendor_part_number,manufacturer,description,quantity,unit_cost,core_cost,line_total,taxable,tax_amount,matched_part_id,match_status,received_quantity) VALUES($1::bigint,$2::integer,$3::text,$4::text,$5::text,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$11::numeric,$12::bigint,$13::text,$6::numeric)`,[invoiceId,i+1,String(l.partNumber||'').trim()||null,String(l.manufacturer||'').trim()||null,String(l.description||'').trim()||null,qty,unitCost,core,Number(l.lineTotal||qty*unitCost),l.taxable!==false,lineTax,partId,partId?'matched':'unmatched']);
  if(!partId)continue;
  stage=`line_${i+1}_stock`;const pr=await db.query('SELECT * FROM fullbay_import_parts WHERE id=$1::bigint FOR UPDATE',[partId]);const oldQty=Number(pr.rows[0].quantity||0),oldAvg=Number(pr.rows[0].cost||0),newQty=oldQty+qty,lineTaxForCost=(l.taxable===false||taxableBase<=0)?0:Number(inv.tax||0)*((qty*unitCost)/taxableBase),landedUnitCost=unitCost+(inv.taxIncludedInCost&&qty>0?lineTaxForCost/qty:0),newAvg=newQty>0?((oldQty*oldAvg)+(qty*landedUnitCost))/newQty:landedUnitCost;
  await db.query(`UPDATE fullbay_import_parts SET quantity=$2::numeric,previous_purchase_cost=last_purchase_cost,last_purchase_cost=$3::numeric,last_purchase_at=now(),cost=$4::numeric,vendor=COALESCE(NULLIF($5::text,''),vendor),inventory_value=($2::numeric*$4::numeric),updated_at=now() WHERE id=$1::bigint`,[partId,newQty,unitCost,newAvg,inv.vendor||'']);
  stage=`line_${i+1}_ledger`;await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username,metadata) VALUES($1,'vendor_receive',$2,$3,$4,$5,$6,$7,$8::jsonb)`,[partId,qty,oldQty,newQty,invoiceNumber||`Invoice ${invoiceId}`,'Smart Receiving',req.user.username,JSON.stringify({invoiceId,vendor:inv.vendor,unitCost,landedUnitCost,coreCost:core,purchaseTaxable:l.taxable!==false,taxAmount:lineTaxForCost,poNumber:inv.poNumber})]);
  stage=`line_${i+1}_cost_history`;await db.query(`INSERT INTO part_purchase_cost_history(part_id,vendor,invoice_number,invoice_id,quantity,unit_cost,core_cost,username) VALUES($1::bigint,$2::text,$3::text,$4::bigint,$5::numeric,$6::numeric,$7::numeric,$8::text)`,[partId,inv.vendor||null,invoiceNumber,invoiceId,qty,unitCost,core,req.user.username]);received++;
 }
 stage="commit";await db.query('COMMIT');await audit(req.user.username,'vendor_invoice_received',{invoiceId,received,created,vendor:inv.vendor});res.json({ok:true,invoiceId,received,created,vendor:inv.vendor});
 }catch(e){try{await db.query('ROLLBACK')}catch{}console.error('SMART RECEIVING FAILED',stage,e?.code,e?.message);if(e?.code==='23505')return res.status(409).json({error:'This vendor invoice number has already been received. Duplicate receiving was blocked.',code:'DUPLICATE_INVOICE'});if(e?.status)return res.status(e.status).json({error:e.message,stage});const msg=String(e?.message||'Receiving failed.').slice(0,240);return res.status(500).json({error:`Receiving failed at ${stage}: ${msg}`,stage,code:e?.code||'RECEIVE_FAILED'});
 }finally{db.release()}});
app.get("/api/parts/receiving/invoices",auth,managerPermission("inventory"),async(req,res,next)=>{try{const r=await requireDb().query(`SELECT i.*,count(l.id)::int line_count,coalesce(sum(l.received_quantity),0) received_qty FROM parts_vendor_invoices i LEFT JOIN parts_vendor_invoice_lines l ON l.invoice_id=i.id GROUP BY i.id ORDER BY i.created_at DESC LIMIT 100`);res.json({items:r.rows})}catch(e){next(e)}});
app.get("/api/parts/:id/cost-history",auth,managerPermission("inventory"),async(req,res,next)=>{try{const r=await requireDb().query(`SELECT * FROM part_purchase_cost_history WHERE part_id=$1 ORDER BY purchased_at DESC LIMIT 100`,[req.params.id]);res.json({items:r.rows})}catch(e){next(e)}});



// ---- v24.6.1 Service Order Review + audited labor adjustment ----
async function nextServiceOrderNumber(db){const y=new Date().getFullYear();await db.query("SELECT pg_advisory_xact_lock($1::bigint)",[2461]);const q=await db.query("SELECT coalesce(max((regexp_match(service_order_number,$1))[1]::int),0)+1 n FROM service_orders WHERE service_order_number ~ $2",[`^SO-${y}-([0-9]+)$`,`^SO-${y}-[0-9]+$`]);return `SO-${y}-${String(Number(q.rows[0]?.n||1)).padStart(5,'0')}`}
async function completedWo(db,woId){const q=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");const sf=q.rows[0]?.payload||{};return (Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===String(woId))||null}
app.post('/api/service-orders/from-work-order/:woId',auth,adminOnly,async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const woId=String(req.params.woId),w=await completedWo(db,woId);if(!w){await db.query('ROLLBACK');return res.status(404).json({error:'Work order not found.'})}if(String(w.status)!=='Completed'){await db.query('ROLLBACK');return res.status(409).json({error:'Complete the work order before creating the service order.'})}let ex=(await db.query('SELECT id FROM service_orders WHERE work_order_id=$1::text',[woId])).rows[0];if(ex){await db.query('ROLLBACK');return res.json({ok:true,id:ex.id,existing:true})}let unit=null;if(w.unitRecordId)unit=(await db.query('SELECT * FROM customer_units WHERE id=$1::bigint',[w.unitRecordId])).rows[0]||null;if(!unit&&w.unit)unit=(await db.query('SELECT * FROM customer_units WHERE unit_number=$1::text ORDER BY updated_at DESC LIMIT 1',[String(w.unit)])).rows[0]||null;const n=await nextServiceOrderNumber(db);const ins=await db.query(`INSERT INTO service_orders(service_order_number,work_order_id,customer_id,customer_name,unit_id,unit_number,vin,mileage,po_number,created_by) VALUES($1,$2,$3::bigint,$4,$5::bigint,$6,$7,$8::numeric,$9,$10) RETURNING id`,[n,woId,w.customerId||unit?.customer_id||null,w.customer||unit?.customer_name||'',unit?.id||w.unitRecordId||null,w.unit||unit?.unit_number||'',w.vin||unit?.vin||'',Number(w.mileage||unit?.mileage||0)||null,w.poNumber||'',req.user.username]);await db.query('COMMIT');res.json({ok:true,id:ins.rows[0].id})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.get('/api/service-orders/:id',auth,adminOnly,async(req,res,next)=>{try{const db=requireDb(),so=(await db.query('SELECT * FROM service_orders WHERE id=$1::bigint',[req.params.id])).rows[0];if(!so)return res.status(404).json({error:'Service order not found.'});const w=await completedWo(db,so.work_order_id);if(!w)return res.status(404).json({error:'Source work order not found.'});const raw=(await db.query(`SELECT task_uid,task_name,mechanic_username,sum(extract(epoch from (ended_at-started_at))/3600.0) original_hours FROM task_time_sessions WHERE work_order_id=$1::text AND ended_at IS NOT NULL GROUP BY task_uid,task_name,mechanic_username ORDER BY task_name,mechanic_username`,[so.work_order_id])).rows;const adj=(await db.query(`SELECT DISTINCT ON (task_uid,mechanic_username) task_uid,mechanic_username,adjusted_hours,original_hours,reason,adjusted_by,created_at FROM task_time_adjustments WHERE work_order_id=$1::text ORDER BY task_uid,mechanic_username,created_at DESC,id DESC`,[so.work_order_id])).rows;const am=new Map(adj.map(a=>[`${a.task_uid}::${a.mechanic_username}`,a]));const sessions=raw.map(r=>({...r,original_hours:Number(r.original_hours||0),adjusted_hours:Number(am.get(`${r.task_uid}::${r.mechanic_username}`)?.adjusted_hours??r.original_hours),adjustment:am.get(`${r.task_uid}::${r.mechanic_username}`)||null}));res.json({serviceOrder:so,workOrder:w,sessions})}catch(e){next(e)}});
app.post('/api/service-orders/:id/time-adjustment',auth,adminOnly,async(req,res,next)=>{try{const db=requireDb(),so=(await db.query('SELECT * FROM service_orders WHERE id=$1::bigint',[req.params.id])).rows[0];if(!so||so.status!=='review')return res.status(409).json({error:'Service order is locked or missing.'});const b=req.body||{},hours=Number(b.adjustedHours),reason=String(b.reason||'').trim();if(!Number.isFinite(hours)||hours<0)return res.status(400).json({error:'Adjusted hours must be zero or greater.'});if(reason.length<3)return res.status(400).json({error:'Reason for labor-time adjustment is required.'});const orig=(await db.query(`SELECT coalesce(sum(extract(epoch from (ended_at-started_at))/3600.0),0) h FROM task_time_sessions WHERE work_order_id=$1::text AND task_uid=$2::text AND mechanic_username=$3::text AND ended_at IS NOT NULL`,[so.work_order_id,String(b.taskUid||''),String(b.mechanic||'')])).rows[0]?.h||0;await db.query(`INSERT INTO task_time_adjustments(work_order_id,task_uid,mechanic_username,adjusted_hours,original_hours,reason,adjusted_by) VALUES($1,$2,$3,$4::numeric,$5::numeric,$6,$7)`,[so.work_order_id,String(b.taskUid||''),String(b.mechanic||''),hours,Number(orig),reason,req.user.username]);await audit(req.user.username,'labor_time_adjusted',{workOrderId:so.work_order_id,taskUid:b.taskUid,mechanic:b.mechanic,originalHours:Number(orig),adjustedHours:hours,reason});res.json({ok:true})}catch(e){next(e)}});
app.post('/api/service-orders/:id/to-invoice',auth,adminOnly,async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const so=(await db.query('SELECT * FROM service_orders WHERE id=$1::bigint FOR UPDATE',[req.params.id])).rows[0];if(!so){await db.query('ROLLBACK');return res.status(404).json({error:'Service order not found.'})}const existing=(await db.query("SELECT id FROM customer_invoices WHERE service_order_id=$1::bigint AND status<>'void'",[so.id])).rows[0];if(existing){await db.query('ROLLBACK');return res.json({ok:true,id:existing.id,existing:true})}const w=await completedWo(db,so.work_order_id);if(!w){await db.query('ROLLBACK');return res.status(404).json({error:'Source work order missing.'})}let cust=so.customer_id?(await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint',[so.customer_id])).rows[0]:null;const num=await nextInvoiceNumber(db),rate=invoiceMoney(cust?.default_labor_rate||req.body?.laborRate||0),terms=String(cust?.credit_terms||'Due on Receipt'),days=/30/.test(terms)?30:/15/.test(terms)?15:/45/.test(terms)?45:0;const ins=await db.query(`INSERT INTO customer_invoices(invoice_number,work_order_id,service_order_id,customer_id,customer_name,unit_id,unit_number,vin,mileage,po_number,invoice_date,due_date,terms,tax_rate,created_by) VALUES($1,$2,$3::bigint,$4::bigint,$5,$6::bigint,$7,$8,$9::numeric,$10,CURRENT_DATE,CURRENT_DATE+$11::int,$12,$13::numeric,$14) RETURNING id`,[num,so.work_order_id,so.id,so.customer_id,so.customer_name,so.unit_id,so.unit_number,so.vin,so.mileage,so.po_number,days,terms,Number(req.body?.taxRate||0),req.user.username]);const iid=ins.rows[0].id;const adj=(await db.query(`SELECT DISTINCT ON (task_uid,mechanic_username) task_uid,mechanic_username,adjusted_hours FROM task_time_adjustments WHERE work_order_id=$1::text ORDER BY task_uid,mechanic_username,created_at DESC,id DESC`,[so.work_order_id])).rows,am=new Map(adj.map(a=>[`${a.task_uid}::${a.mechanic_username}`,Number(a.adjusted_hours||0)]));const raw=(await db.query(`SELECT task_uid,mechanic_username,sum(extract(epoch from (ended_at-started_at))/3600.0) h FROM task_time_sessions WHERE work_order_id=$1::text AND ended_at IS NOT NULL GROUP BY task_uid,mechanic_username`,[so.work_order_id])).rows;const hm=new Map();for(const r of raw){const h=am.has(`${r.task_uid}::${r.mechanic_username}`)?am.get(`${r.task_uid}::${r.mechanic_username}`):Number(r.h||0);hm.set(String(r.task_uid),(hm.get(String(r.task_uid))||0)+h)}let order=0;for(const t of (Array.isArray(w.tasks)?w.tasks:[])){const job=String(t.t||'Repair'),hours=Math.round((hm.get(String(t.uid||''))||0)*100)/100;const laborIns=await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,quantity,unit_price,unit_cost,taxable,line_total,parent_line_id) VALUES($1,$2,$3,$4,'labor',$5,$6::numeric,$7::numeric,0,false,$6::numeric*$7::numeric,NULL) RETURNING id`,[iid,++order,String(t.uid||''),job,job,hours,rate]);const laborId=laborIns.rows[0].id;for(const part of (Array.isArray(t.parts)?t.parts:[]))await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,line_total,parent_line_id) VALUES($1,$2,$3,$4,'part',$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$7::numeric*$8::numeric,$11::bigint)`,[iid,++order,String(t.uid||''),job,String(part.description||part.partNumber||'Part'),String(part.partNumber||''),Number(part.qty||1),Number(part.unitPrice||0),Number(part.unitCost||0),part.sellTaxable!==false,laborId])}await recalcInvoice(db,iid);await db.query("UPDATE service_orders SET status='invoiced',updated_at=now() WHERE id=$1::bigint",[so.id]);await db.query('COMMIT');res.json({ok:true,id:iid})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});

// ---- v24.6 Professional Customer Invoicing ----
function invoiceMoney(v){const n=Number(v);return Number.isFinite(n)?Math.round(n*100)/100:0}
async function nextInvoiceNumber(db){const y=new Date().getFullYear();await db.query("SELECT pg_advisory_xact_lock($1::bigint)",[2460]);const q=await db.query("SELECT coalesce(max((regexp_match(invoice_number,$1))[1]::int),0)+1 n FROM customer_invoices WHERE invoice_number ~ $2",[`^IT-${y}-([0-9]+)$`,`^IT-${y}-[0-9]+$`]);return `IT-${y}-${String(Number(q.rows[0]?.n||1)).padStart(5,'0')}`}
function invoiceLineDiscount(qty,unitPrice,type,value){const gross=Math.max(0,Number(qty||0))*Math.max(0,Number(unitPrice||0));const mode=String(type||'fixed')==='percent'?'percent':'fixed';const raw=Math.max(0,Number(value||0));return invoiceMoney(Math.min(gross,mode==='percent'?gross*Math.min(raw,100)/100:raw))}
async function recalcInvoice(db,id){const lr=await db.query(`SELECT coalesce(sum(greatest(0,quantity*unit_price-discount)),0) subtotal,coalesce(sum(CASE WHEN taxable THEN greatest(0,quantity*unit_price-discount) ELSE 0 END),0) taxable FROM customer_invoice_lines WHERE invoice_id=$1::bigint`,[id]);const inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];if(!inv)return null;const linesSubtotal=invoiceMoney(lr.rows[0].subtotal),taxable=invoiceMoney(lr.rows[0].taxable),fees=invoiceMoney(inv.shop_supplies)+invoiceMoney(inv.environmental_fee),preDiscount=Math.max(0,linesSubtotal+fees),discountType=String(inv.discount_type||'fixed'),discountValue=Math.max(0,invoiceMoney(inv.discount_value??inv.discount??0)),discount=Math.min(preDiscount,discountType==='percent'?preDiscount*Math.min(100,discountValue)/100:discountValue),subtotal=Math.max(0,preDiscount-discount),discountRatio=preDiscount>0?discount/preDiscount:0,taxableAfterDiscount=Math.max(0,taxable*(1-discountRatio)),tax=invoiceMoney(taxableAfterDiscount*invoiceMoney(inv.tax_rate)/100),total=invoiceMoney(subtotal+tax),paid=invoiceMoney(inv.amount_paid),balance=invoiceMoney(Math.max(0,total-paid));let status=inv.status;if(status!=='void'&&status!=='draft'){status=balance<=0&&total>0?'paid':paid>0?'partial':status==='paid'?'sent':status}await db.query(`UPDATE customer_invoices SET discount=$8::numeric,subtotal=$2::numeric,taxable_subtotal=$3::numeric,tax=$4::numeric,total=$5::numeric,balance_due=$6::numeric,status=$7::text,paid_at=CASE WHEN $7::text='paid' THEN coalesce(paid_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1::bigint`,[id,subtotal,taxableAfterDiscount,tax,total,balance,status,discount]);return (await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint',[id])).rows[0]}
async function getInvoiceBundle(db,id){const inv=(await db.query(`SELECT i.*,c.dot_number AS customer_dot_number,c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,c.postal_code AS customer_postal_code,c.billing_address AS customer_billing_address,c.billing_city AS customer_billing_city,c.billing_state AS customer_billing_state,c.billing_postal_code AS customer_billing_postal_code,c.email AS profile_customer_email FROM customer_invoices i LEFT JOIN fullbay_import_customers c ON c.id::text=i.customer_id::text WHERE i.id=$1::bigint`,[id])).rows[0];if(!inv)return null;const lines=(await db.query('SELECT * FROM customer_invoice_lines WHERE invoice_id=$1::bigint ORDER BY sort_order,id',[id])).rows;const payments=(await db.query('SELECT * FROM customer_invoice_payments WHERE invoice_id=$1::bigint ORDER BY paid_at,id',[id])).rows;return {invoice:inv,lines,payments}}
app.get('/api/invoices',auth,managerPermission("invoices"),async(req,res,next)=>{try{const status=String(req.query.status||'').trim();const q=await requireDb().query(`SELECT * FROM customer_invoices WHERE ($1::text='' OR status=$1::text) ORDER BY invoice_date DESC,id DESC LIMIT 500`,[status]);res.json({items:q.rows})}catch(e){next(e)}});
app.get('/api/invoices/:id',auth,managerPermission("invoices"),async(req,res,next)=>{try{const x=await getInvoiceBundle(requireDb(),req.params.id);if(!x)return res.status(404).json({error:'Invoice not found.'});res.json(x)}catch(e){next(e)}});
app.post('/api/invoices/from-work-order/:woId',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const woId=String(req.params.woId);const ex=await db.query("SELECT id FROM customer_invoices WHERE work_order_id=$1::text AND status<>'void'",[woId]);if(ex.rowCount){await db.query('ROLLBACK');return res.json({ok:true,id:ex.rows[0].id,existing:true})}const sq=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");const sf=sq.rows[0]?.payload||{};const w=(Array.isArray(sf.workorders)?sf.workorders:[]).find(x=>String(x?.id)===woId);if(!w){await db.query('ROLLBACK');return res.status(404).json({error:'Work order not found.'})}if(String(w.status)!=='Completed'){await db.query('ROLLBACK');return res.status(409).json({error:'Complete the work order before creating its invoice.'})}let cust=null;if(w.customerId){cust=(await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint',[w.customerId])).rows[0]||null}if(!cust&&w.customer){cust=(await db.query('SELECT * FROM fullbay_import_customers WHERE lower(customer_name)=lower($1::text) LIMIT 1',[w.customer])).rows[0]||null}const num=await nextInvoiceNumber(db),rate=invoiceMoney(cust?.default_labor_rate||req.body?.laborRate||0),terms=String(cust?.credit_terms||'Due on Receipt'),days=/30/.test(terms)?30:/15/.test(terms)?15:/45/.test(terms)?45:0;const ins=await db.query(`INSERT INTO customer_invoices(invoice_number,work_order_id,customer_id,customer_name,unit_number,vin,po_number,invoice_date,due_date,terms,tax_rate,created_by) VALUES($1,$2,$3::bigint,$4,$5,$6,$7,CURRENT_DATE,CURRENT_DATE+$8::int,$9,$10::numeric,$11) RETURNING id`,[num,woId,cust?.id||null,w.customer||cust?.customer_name||'Customer',w.unit||'',w.vin||'',w.poNumber||'',days,terms,Number(req.body?.taxRate||0),req.user.username]);const id=ins.rows[0].id;const sessions=(await db.query(`SELECT task_uid,sum(extract(epoch from (coalesce(ended_at,now())-started_at))/3600.0) hours FROM task_time_sessions WHERE work_order_id=$1::text AND ended_at IS NOT NULL GROUP BY task_uid`,[woId])).rows;const hm=new Map(sessions.map(x=>[String(x.task_uid),Number(x.hours||0)]));let order=0;for(const t of (Array.isArray(w.tasks)?w.tasks:[])){const job=String(t.t||'Repair'),hours=Math.round((hm.get(String(t.uid||''))||0)*100)/100;const laborIns=await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,quantity,unit_price,unit_cost,taxable,line_total,metadata,parent_line_id) VALUES($1,$2,$3,$4,'labor',$5,$6::numeric,$7::numeric,0,false,($6::numeric*$7::numeric),$8::jsonb,NULL) RETURNING id`,[id,++order,String(t.uid||''),job,job,hours,rate,JSON.stringify({outcome:t.outcome||'',note:t.outcomeNote||''})]);const laborId=laborIns.rows[0].id;for(const part of (Array.isArray(t.parts)?t.parts:[])){await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,line_total,metadata,parent_line_id) VALUES($1,$2,$3,$4,'part',$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::boolean,($7::numeric*$8::numeric),$11::jsonb,$12::bigint)`,[id,++order,String(t.uid||''),job,String(part.description||part.partNumber||'Part'),String(part.partNumber||''),Number(part.qty||1),Number(part.unitPrice||0),Number(part.unitCost||0),part.sellTaxable!==false,JSON.stringify({inventoryPartId:part.inventoryPartId||null,sourcePartId:part.id||null}),laborId])}}await recalcInvoice(db,id);await db.query('COMMIT');await audit(req.user.username,'invoice_created',{invoiceId:id,workOrderId:woId});res.json({ok:true,id})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/invoices',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const b=req.body||{},num=await nextInvoiceNumber(db);let c=null;if(b.customerId)c=(await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint',[b.customerId])).rows[0]||null;const terms=String(b.terms||c?.credit_terms||'Due on Receipt'),days=terms==='Net 60'?60:terms==='Net 30'?30:terms==='Net 15'?15:0,invoiceDate=b.invoiceDate||null,dueDate=b.dueDate||null;const q=await db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,unit_id,unit_number,vin,dot_number,mileage,po_number,invoice_date,due_date,terms,tax_rate,discount_type,discount_value,billing_address,billing_city,billing_state,billing_postal_code,customer_note,internal_note,created_by) VALUES($1,$2::bigint,$3,$4::bigint,$5,$6,$7,$8::numeric,$9,coalesce($10::date,CURRENT_DATE),coalesce($11::date,coalesce($10::date,CURRENT_DATE)+$12::int),$13,$14::numeric,'fixed',0,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,[num,b.customerId||null,String(b.customerName||c?.customer_name||'Customer'),b.unitId||null,String(b.unitNumber||''),String(b.vin||''),String(b.dotNumber||c?.dot_number||''),Number(b.mileage||0)||null,String(b.poNumber||''),invoiceDate,dueDate,days,terms,Number(b.taxRate||0),c?.billing_address||c?.address||null,c?.billing_city||c?.city||null,c?.billing_state||c?.state||null,c?.billing_postal_code||c?.postal_code||null,String(b.customerNote||''),String(b.internalNote||''),req.user.username]);await recalcInvoice(db,q.rows[0].id);await db.query('COMMIT');res.json({ok:true,id:q.rows[0].id})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.put('/api/invoices/:id',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const id=req.params.id,cur=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];if(!cur){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(!['draft','sent','partial'].includes(cur.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Paid or void invoices are locked.'})}const b=req.body||{};let c=null;if(b.customerId)c=(await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint',[b.customerId])).rows[0]||null;const discountType=['fixed','percent'].includes(String(b.discountType||''))?String(b.discountType):String(cur.discount_type||'fixed'),discountValue=Math.max(0,Number(b.discountValue??cur.discount_value??cur.discount??0));await db.query(`UPDATE customer_invoices SET customer_id=$2::bigint,customer_name=$3,unit_id=$4::bigint,unit_number=$5,vin=$6,dot_number=$7,po_number=$8,mileage=$9::numeric,invoice_date=$10::date,due_date=$11::date,terms=$12,tax_rate=$13::numeric,shop_supplies=$14::numeric,environmental_fee=$15::numeric,discount_type=$16,discount_value=$17::numeric,billing_address=$18,billing_city=$19,billing_state=$20,billing_postal_code=$21,customer_note=$22,internal_note=$23,updated_at=now() WHERE id=$1::bigint`,[id,b.customerId??cur.customer_id,String(b.customerName??c?.customer_name??cur.customer_name),b.unitId??cur.unit_id,String(b.unitNumber??cur.unit_number??''),String(b.vin??cur.vin??''),String(b.dotNumber??c?.dot_number??cur.dot_number??''),String(b.poNumber??cur.po_number??''),Number(b.mileage??cur.mileage??0)||null,b.invoiceDate||cur.invoice_date,b.dueDate||cur.due_date,String(b.terms??cur.terms??''),Number(b.taxRate??cur.tax_rate??0),Number(b.shopSupplies??cur.shop_supplies??0),Number(b.environmentalFee??cur.environmental_fee??0),discountType,discountValue,c?.billing_address||c?.address||cur.billing_address||null,c?.billing_city||c?.city||cur.billing_city||null,c?.billing_state||c?.state||cur.billing_state||null,c?.billing_postal_code||c?.postal_code||cur.billing_postal_code||null,String(b.customerNote??cur.customer_note??''),String(b.internalNote??cur.internal_note??'')]);await recalcInvoice(db,id);await db.query('COMMIT');res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/invoices/:id/lines',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const id=req.params.id,b=req.body||{},inv=(await db.query('SELECT status FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];if(!inv){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked.'})}const typ=['labor','part','fee','sublet','other'].includes(b.lineType)?b.lineType:'other';let parentLineId=b.parentLineId?Number(b.parentLineId):null,jobUid=String(b.jobUid||''),jobName=String(b.jobName||'');if(parentLineId){const p=(await db.query(`SELECT id,job_uid,job_name FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint AND line_type='labor'`,[parentLineId,id])).rows[0];if(!p){await db.query('ROLLBACK');return res.status(409).json({error:'Parent labor operation not found.'})}jobUid=String(p.job_uid||'');jobName=String(p.job_name||'');if(typ==='labor')parentLineId=null}const qty=Math.max(0,Number(b.quantity||0)),price=Math.max(0,Number(b.unitPrice||0)),discountType=String(b.discountType||'fixed')==='percent'?'percent':'fixed',discountValue=Math.max(0,Number(b.discountValue??b.discount??0)),discount=invoiceLineDiscount(qty,price,discountType,discountValue);const q=await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,discount,discount_type,discount_value,line_total,parent_line_id) VALUES($1::bigint,(SELECT coalesce(max(sort_order),0)+1 FROM customer_invoice_lines WHERE invoice_id=$1::bigint),$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::boolean,$11::numeric,$12,$13::numeric,greatest(0,$7::numeric*$8::numeric-$11::numeric),$14::bigint) RETURNING id`,[id,jobUid,jobName,typ,String(b.description??''),String(b.partNumber||''),qty,price,Number(b.unitCost||0),b.taxable===true,discount,discountType,discountValue,parentLineId]);await recalcInvoice(db,id);await db.query('COMMIT');res.json({ok:true,id:q.rows[0].id})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.put('/api/invoices/:id/lines/:lineId',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const b=req.body||{},id=req.params.id;const inv=(await db.query('SELECT status FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];if(!inv||!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked or missing.'})}const typ=['labor','part','fee','sublet','other'].includes(b.lineType)?b.lineType:'other';let parentLineId=typ==='labor'?null:(b.parentLineId?Number(b.parentLineId):null),jobName=String(b.jobName||''),jobUid=String(b.jobUid||'');if(parentLineId){const p=(await db.query(`SELECT job_uid,job_name FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint AND line_type='labor'`,[parentLineId,id])).rows[0];if(!p){await db.query('ROLLBACK');return res.status(409).json({error:'Parent labor operation not found.'})}jobName=String(p.job_name||jobName);jobUid=String(p.job_uid||jobUid)}const qty=Math.max(0,Number(b.quantity||0)),price=Math.max(0,Number(b.unitPrice||0)),discountType=String(b.discountType||'fixed')==='percent'?'percent':'fixed',discountValue=Math.max(0,Number(b.discountValue??b.discount??0)),discount=invoiceLineDiscount(qty,price,discountType,discountValue);await db.query(`UPDATE customer_invoice_lines SET job_uid=$3,job_name=$4,line_type=$5,description=$6,part_number=$7,quantity=$8::numeric,unit_price=$9::numeric,unit_cost=$10::numeric,taxable=$11::boolean,discount=$12::numeric,discount_type=$13,discount_value=$14::numeric,line_total=greatest(0,$8::numeric*$9::numeric-$12::numeric),parent_line_id=$15::bigint WHERE id=$2::bigint AND invoice_id=$1::bigint`,[id,req.params.lineId,jobUid,jobName,typ,String(b.description||''),String(b.partNumber||''),qty,price,Number(b.unitCost||0),b.taxable===true,discount,discountType,discountValue,parentLineId]);await recalcInvoice(db,id);await db.query('COMMIT');res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.delete('/api/invoices/:id/lines/:lineId',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const inv=(await db.query('SELECT status FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[req.params.id])).rows[0];if(!inv||!['draft','sent','partial'].includes(inv.status)){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is locked or missing.'})}const target=(await db.query('SELECT line_type FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint',[req.params.lineId,req.params.id])).rows[0];if(target?.line_type==='labor')await db.query('DELETE FROM customer_invoice_lines WHERE parent_line_id=$1::bigint AND invoice_id=$2::bigint',[req.params.lineId,req.params.id]);await db.query('DELETE FROM customer_invoice_lines WHERE id=$1::bigint AND invoice_id=$2::bigint',[req.params.lineId,req.params.id]);await recalcInvoice(db,req.params.id);await db.query('COMMIT');res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/invoices/:id/finalize',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const inv=await recalcInvoice(db,req.params.id);if(!inv){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(invoiceMoney(inv.total)<=0){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice total must be greater than zero.'})}await db.query("UPDATE customer_invoices SET status=CASE WHEN amount_paid>0 THEN 'partial' ELSE 'sent' END,finalized_at=coalesce(finalized_at,now()),sent_at=coalesce(sent_at,now()),updated_at=now() WHERE id=$1::bigint",[req.params.id]);await db.query('COMMIT');res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/invoices/:id/payments',auth,managerPermission("invoices"),async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const id=req.params.id,amount=invoiceMoney(req.body?.amount);if(amount<=0){await db.query('ROLLBACK');return res.status(400).json({error:'Payment amount must be greater than zero.'})}const inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[id])).rows[0];if(!inv||inv.status==='void'){await db.query('ROLLBACK');return res.status(409).json({error:'Invoice is missing or void.'})}if(amount>invoiceMoney(inv.balance_due)+.01){await db.query('ROLLBACK');return res.status(409).json({error:'Payment cannot exceed the balance due.'})}await db.query(`INSERT INTO customer_invoice_payments(invoice_id,amount,method,reference,note,paid_at,received_by) VALUES($1::bigint,$2::numeric,$3,$4,$5,coalesce($6::timestamptz,now()),$7)`,[id,amount,String(req.body?.method||'Other'),String(req.body?.reference||''),String(req.body?.note||''),req.body?.paidAt||null,req.user.username]);await db.query('UPDATE customer_invoices SET amount_paid=amount_paid+$2::numeric,updated_at=now() WHERE id=$1::bigint',[id,amount]);await recalcInvoice(db,id);await db.query('COMMIT');await audit(req.user.username,'invoice_payment',{invoiceId:id,amount,method:req.body?.method});res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/invoices/:id/void',auth,managerPermission("invoices"),async(req,res,next)=>{try{const q=await requireDb().query("UPDATE customer_invoices SET status='void',updated_at=now() WHERE id=$1::bigint AND amount_paid=0 RETURNING id",[req.params.id]);if(!q.rowCount)return res.status(409).json({error:'Paid invoices cannot be voided until payments are reconciled.'});res.json({ok:true})}catch(e){next(e)}});
app.delete('/api/invoices/:id',auth,ownerOnly,async(req,res,next)=>{const db=await requireDb().connect();try{await db.query('BEGIN');const inv=(await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE',[req.params.id])).rows[0];if(!inv){await db.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(String(req.body?.confirmInvoiceNumber||'')!==String(inv.invoice_number)){await db.query('ROLLBACK');return res.status(400).json({error:'Type the exact invoice number to permanently delete it.'})}const snapshot=await getInvoiceBundle(db,req.params.id);await db.query('DELETE FROM customer_invoice_payments WHERE invoice_id=$1::bigint',[req.params.id]);await db.query('DELETE FROM customer_invoice_lines WHERE invoice_id=$1::bigint',[req.params.id]);await db.query('DELETE FROM customer_invoices WHERE id=$1::bigint',[req.params.id]);await db.query('COMMIT');await audit(req.user.username,'invoice_permanently_deleted',{invoiceNumber:inv.invoice_number,customer:inv.customer_name,total:inv.total,status:inv.status,hadPayments:(snapshot?.payments||[]).length});res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.get('/api/invoices/:id/pdf',auth,managerPermission("invoices"),async(req,res,next)=>{
 try{
  const db=requireDb(),x=await getInvoiceBundle(db,req.params.id);
  if(!x)return res.status(404).json({error:'Invoice not found.'});
  const i=x.invoice,rawLines=Array.isArray(x.lines)?x.lines:[],lines=rawLines.filter(l=>l.line_type==='labor'||String(l.part_number||'').trim()||String(l.description||'').trim()||Number(l.unit_price||0)!==0||Number(l.quantity||0)!==1);
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${String(i.invoice_number).replace(/[^A-Za-z0-9_-]/g,'_')}.pdf"`);
  res.setHeader('Cache-Control','private, no-store');

  const doc=new PDFDocument({
   size:'LETTER',
   margins:{top:36,right:42,bottom:44,left:42},
   bufferPages:true,
   info:{Title:`Invoice ${i.invoice_number}`,Author:'Iron Team Truck & Trailer Repair'}
  });
  doc.pipe(res);

  const money=n=>`$${invoiceMoney(n).toFixed(2)}`;
  const L=42,R=570,W=528;
  const NAVY='#22364b',INK='#111827',MUTED='#64748b',LINE='#cbd5e1',PALE='#f1f5f9',SOFT='#f8fafc',BLUE='#eaf4ff';
  const s=v=>String(v??'').trim();
  const text=(v,x,y,opt={})=>doc.text(s(v),x,y,opt);
  const rect=(x,y,w,h,fill=null,stroke=LINE)=>{
   if(fill){doc.save().rect(x,y,w,h).fill(fill).restore()}
   if(stroke){doc.save().rect(x,y,w,h).strokeColor(stroke).lineWidth(.6).stroke().restore()}
  };
  const line=y=>doc.save().moveTo(L,y).lineTo(R,y).strokeColor('#e2e8f0').lineWidth(.5).stroke().restore();
  const pageBottom=()=>doc.page.height-doc.page.margins.bottom-8;
  let y=36;

  function newPage(){
   doc.addPage();
   y=38;
  }
  function ensure(h){
   if(y+h>pageBottom())newPage();
  }
  const tableCuts=[L+48,L+296,L+361,L+442];
  function drawTableGuides(y0,h,color='#e2e8f0'){
   for(const x0 of tableCuts)doc.save().moveTo(x0,y0).lineTo(x0,y0+h).strokeColor(color).lineWidth(.45).stroke().restore();
  }
  function drawTableHeader(){
   ensure(24);
   rect(L,y,W,23,PALE,LINE);drawTableGuides(y,23,'#cbd5e1');
   const cols=[
    [L+6,38,'TYPE','left'],
    [L+55,232,'DESCRIPTION','left'],
    [L+300,57,'QTY / HRS','right'],
    [L+365,72,'RATE / PRICE','right'],
    [L+447,76,'AMOUNT','right']
   ];
   doc.fillColor('#334155').font('Helvetica-Bold').fontSize(7);
   for(const [x0,w,label,align] of cols)text(label,x0,y+8,{width:w,align});
   y+=23;
  }

  // Header
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18);
  text('IRON TEAM TRUCK & TRAILER REPAIR',L,y,{width:350});
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.2);
  text('Professional Heavy-Duty Truck & Trailer Service',L,y+23,{width:350});

  rect(410,y-3,160,63,PALE,null);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(21);
  text('INVOICE',420,y+5,{width:140,align:'right'});
  doc.fontSize(10);
  text(i.invoice_number,420,y+34,{width:140,align:'right'});
  y+=80;

  // Bill-to and invoice metadata
  const panelY=y,leftW=292,gap=12,rightX=L+leftW+gap,rightW=W-leftW-gap,panelH=82;
  rect(L,panelY,leftW,panelH,'#ffffff',LINE);
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.2);
  text('BILL TO',L+10,panelY+10,{width:leftW-20});
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5);
  text(i.customer_name||'—',L+10,panelY+25,{width:leftW-20});
  const billStreet=i.billing_address||i.customer_billing_address||i.customer_address||'';
  const billCity=[
   i.billing_city||i.customer_billing_city||i.customer_city,
   i.billing_state||i.customer_billing_state||i.customer_state,
   i.billing_postal_code||i.customer_billing_postal_code||i.customer_postal_code
  ].filter(Boolean).join(' ');
  doc.fillColor('#334155').font('Helvetica').fontSize(8.2);
  text([billStreet,billCity].filter(Boolean).join('\n'),L+10,panelY+42,{width:leftW-20,lineGap:1});

  rect(rightX,panelY,rightW,panelH,'#ffffff',LINE);
  const meta=[
   ['INVOICE DATE',String(i.invoice_date||'').slice(0,10)||'—'],
   ['DUE DATE',String(i.due_date||'').slice(0,10)||'—'],
   ['TERMS',i.terms||'Due on Receipt'],
   ['STATUS',String(i.status||'draft').toUpperCase()]
  ];
  meta.forEach((r,n)=>{
   const yy=panelY+10+n*16;
   doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.1);
   text(r[0],rightX+10,yy,{width:82});
   doc.fillColor(INK).font('Helvetica').fontSize(8.1);
   text(r[1],rightX+96,yy,{width:rightW-106,align:'right'});
  });
  y+=panelH+12;

  // Vehicle information
  const widths=[70,205,100,153],labels=['UNIT #','VIN','MILEAGE','DOT / PO'];
  const values=[
   i.unit_number||'—',
   i.vin||'—',
   i.mileage?`${Number(i.mileage).toLocaleString()} mi`:'—',
   [i.dot_number||i.customer_dot_number,i.po_number].filter(Boolean).join(' / ')||'—'
  ];
  rect(L,y,W,48,'#ffffff',LINE);
  let xx=L;
  for(let n=0;n<4;n++){
   if(n)doc.save().moveTo(xx,y).lineTo(xx,y+48).strokeColor('#e2e8f0').lineWidth(.5).stroke().restore();
   doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7);
   text(labels[n],xx+8,y+8,{width:widths[n]-16});
   doc.fillColor(INK).font('Helvetica').fontSize(n===1?7.5:8.1);
   text(values[n],xx+8,y+23,{width:widths[n]-16,ellipsis:true});
   xx+=widths[n];
  }
  y+=60;

  drawTableHeader();

  const labors=lines.filter(l=>l.line_type==='labor').sort((a,b)=>Number(a.sort_order||a.id)-Number(b.sort_order||b.id));
  const other=lines.filter(l=>l.line_type!=='labor').sort((a,b)=>Number(a.sort_order||a.id)-Number(b.sort_order||b.id));
  const used=new Set();

  function childrenFor(labor,index){
   let rows=other.filter(c=>String(c.parent_line_id||'')===String(labor.id));
   if(rows.length)return rows;
   rows=other.filter(c=>!c.parent_line_id && (
    (c.job_uid&&labor.job_uid&&String(c.job_uid)===String(labor.job_uid)) ||
    (c.job_name&&labor.job_name&&String(c.job_name).toLowerCase()===String(labor.job_name).toLowerCase())
   ));
   if(rows.length){
    const earlier=labors.slice(0,index).some(prev=>
     (prev.job_uid&&labor.job_uid&&String(prev.job_uid)===String(labor.job_uid)) ||
     (prev.job_name&&labor.job_name&&String(prev.job_name).toLowerCase()===String(labor.job_name).toLowerCase())
    );
    if(earlier)return [];
   }
   return rows;
  }

  function drawLabor(labor,index){
   const children=childrenFor(labor,index);
   const estimate=34+(children.length?18:0)+children.length*28+28;
   ensure(Math.min(estimate,190));
   if(y<48)drawTableHeader();

   const laborTotal=Number(labor.line_total||0);
   const laborDescription=s(labor.description)||'Labor';

   // Strong labor header; internal legacy job/service names are never printed.
   rect(L,y,W,34,NAVY,null);drawTableGuides(y,34,'#526477');
   rect(L+9,y+5,25,24,'#ffffff',null);
   doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9);
   text(String(index+1),L+9,y+12,{width:25,align:'center'});
   doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
   text('LABOR',L+48,y+11,{width:42});
   doc.fontSize(9);
   text(laborDescription,L+91,y+10,{width:205,ellipsis:true});
   doc.font('Helvetica').fontSize(8.2);
   text(Number(labor.quantity||0).toFixed(2),L+300,y+11,{width:58,align:'right'});
   text(money(labor.unit_price),L+363,y+11,{width:76,align:'right'});
   doc.font('Helvetica-Bold');
   text(money(laborTotal),L+444,y+11,{width:82,align:'right'});
   y+=34;

   if(children.length){
    rect(L,y,W,18,'#eef2f6',null);
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7);
    text('PARTS & CHARGES FOR THIS LABOR',L+48,y+6,{width:250});
    y+=18;
   }

   let partTotal=0;
   for(const part of children){
    used.add(part.id);
    ensure(30);
    const amount=Number(part.line_total||0);
    partTotal+=amount;

    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.2);
    text(part.line_type==='part'?'PART':String(part.line_type||'ITEM').toUpperCase(),L+8,y+9,{width:40});
    const desc=[part.part_number?`#${part.part_number}`:'',part.description||''].filter(Boolean).join('  ·  ')||'Item';
    doc.fillColor(INK).font('Helvetica').fontSize(8);
    text(desc,L+56,y+8,{width:235,ellipsis:true});
    text(String(Number(part.quantity||0)),L+300,y+8,{width:58,align:'right'});
    text(money(part.unit_price),L+363,y+8,{width:76,align:'right'});
    doc.font('Helvetica-Bold');
    text(money(amount),L+444,y+8,{width:82,align:'right'});
    drawTableGuides(y,28);
    y+=28;
    line(y);
   }

   const total=laborTotal+partTotal;
   rect(L,y,W,27,SOFT,null);
   doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.3);
   text(`${Number(labor.quantity||0).toFixed(2)} labor hr  ·  ${children.length} part${children.length===1?'':'s'}`,L+250,y+9,{width:188,align:'right'});
   doc.fillColor(INK).fontSize(8.8);
   text(money(total),L+444,y+8,{width:82,align:'right'});
   y+=34;
  }

  labors.forEach((labor,index)=>drawLabor(labor,index));

  const orphan=other.filter(r=>!used.has(r.id));
  if(orphan.length){
   ensure(26+orphan.length*28);
   rect(L,y,W,20,PALE,null);
   doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.2);
   text('OTHER ITEMS',L+8,y+7,{width:150});
   y+=20;
   for(const part of orphan){
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.2);
    text(part.line_type==='part'?'PART':String(part.line_type||'ITEM').toUpperCase(),L+8,y+9,{width:40});
    const desc=[part.part_number?`#${part.part_number}`:'',part.description||''].filter(Boolean).join('  ·  ')||'Item';
    doc.fillColor(INK).font('Helvetica').fontSize(8);
    text(desc,L+56,y+8,{width:235,ellipsis:true});
    text(String(Number(part.quantity||0)),L+300,y+8,{width:58,align:'right'});
    text(money(part.unit_price),L+363,y+8,{width:76,align:'right'});
    doc.font('Helvetica-Bold');
    text(money(part.line_total),L+444,y+8,{width:82,align:'right'});
    drawTableGuides(y,28);y+=28;line(y);
   }
  }

  y+=8;

  // Customer notes are printed exactly as saved. Never replace them with generic text.
  const customerNote=s(i.customer_note);
  const shopSupplies=Number(i.shop_supplies||0);
  const environmentalFee=Number(i.environmental_fee||0);
  const additionalFees=shopSupplies+environmentalFee;
  doc.font('Helvetica').fontSize(8);
  const noteTextHeight=customerNote?doc.heightOfString(customerNote,{width:278,lineGap:2}):0;
  const summaryRows=7+(shopSupplies>0?1:0)+(environmentalFee>0?1:0)+(Number(i.discount||0)>0?1:0);
  const bottomPanelH=Math.max(158,Math.min(240,Math.max(noteTextHeight+48,summaryRows*20+20)));
  ensure(bottomPanelH+4);

  const notesW=300,gap2=14,summaryX=L+notesW+gap2,summaryW=W-notesW-gap2,top=y;
  rect(L,top,notesW,bottomPanelH,'#ffffff',LINE);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
  text('CUSTOMER NOTES',L+10,top+10,{width:notesW-20});
  if(customerNote){
   doc.fillColor('#334155').font('Helvetica').fontSize(8);
   text(customerNote,L+10,top+29,{width:notesW-20,height:bottomPanelH-39,lineGap:2});
  }

  rect(summaryX,top,summaryW,bottomPanelH,'#ffffff',LINE);
  let sy=top+12;
  const row=(label,value,{bold=false,size=8.3,fill=null}={})=>{
   if(fill)rect(summaryX+1,sy-5,summaryW-2,23,fill,null);
   doc.fillColor(INK).font(bold?'Helvetica-Bold':'Helvetica').fontSize(size);
   text(label,summaryX+10,sy,{width:95});
   text(value,summaryX+108,sy,{width:summaryW-118,align:'right'});
   sy+=20;
  };
  const rawSubtotal=Number(i.subtotal||0)+Number(i.discount||0);
  const itemsSubtotal=Math.max(0,rawSubtotal-additionalFees);
  row('Items Subtotal',money(itemsSubtotal));
  if(shopSupplies>0)row('Shop Supplies',money(shopSupplies));
  if(environmentalFee>0)row('Environmental / Other',money(environmentalFee));
  row('Subtotal',money(rawSubtotal));
  if(Number(i.discount||0)>0)row('Discount',`-${money(i.discount)}`);
  row(`Tax (${Number(i.tax_rate||0).toFixed(3)}%)`,money(i.tax));
  row('TOTAL',money(i.total),{bold:true,size:11,fill:BLUE});
  row('Paid',money(i.amount_paid));
  row('BALANCE DUE',money(i.balance_due),{bold:true,size:10.5,fill:PALE});

  // Customer-facing warranty, repair authorization, mechanic's lien, safety and signature section.
  y=top+bottomPanelH+12;
  const legalNotice='Any warranties on the parts and accessories sold hereby are made by the manufacturer. You understand and agree that we make no warranties of any kind unless expressed in writing. You hereby authorize us to perform the repair work herein set forth and to purchase the necessary material and parts to perform such repair work. You agree that we are not responsible for loss or damage to your vehicle or articles left in your vehicle in case of fire, theft, or any other cause beyond our control or for any delays caused by unavailability of parts or delays in part shipments by the supplier or transporter. In addition, you agree that we are not responsible for damages to your vehicle from freezing due to lack of antifreeze. You hereby grant our employees permission to operate your vehicle on streets, highways, or elsewhere for the purpose of testing and/or inspection. You acknowledge and agree that an express mechanic\'s lien on your vehicle is granted to secure payment of this invoice for the repair work detailed in this invoice.';
  const tireNotice='After tires or wheels are replaced or serviced, you must stop and recheck wheel nut torque after 50 miles of driving to ensure proper installation and safety. Failure to comply with this requirement releases Iron Team Truck & Trailer Repair from liability for tire or wheel loss or resulting damage.';
  doc.font('Helvetica').fontSize(7.2);
  const legalH=doc.heightOfString(legalNotice,{width:W-20,lineGap:1.45});
  doc.font('Helvetica-Bold').fontSize(7.2);
  const tireH=doc.heightOfString(tireNotice,{width:W-20,lineGap:1.35});
  const noticeH=Math.max(150,legalH+tireH+82);
  ensure(noticeH+8);
  rect(L,y,W,noticeH,'#ffffff',LINE);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
  text('WARRANTY & REPAIR AUTHORIZATION',L+10,y+10,{width:W-20});
  doc.fillColor('#334155').font('Helvetica').fontSize(7.2);
  text(legalNotice,L+10,y+25,{width:W-20,lineGap:1.45});
  let ly=y+27+legalH+8;
  doc.save().moveTo(L+10,ly).lineTo(R-10,ly).strokeColor(LINE).lineWidth(.55).stroke().restore();
  ly+=10;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.7);
  text('IMPORTANT SAFETY NOTICE',L+10,ly,{width:W-20});
  ly+=14;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.2);
  text(tireNotice,L+10,ly,{width:W-20,lineGap:1.35});
  ly+=tireH+18;
  doc.fillColor('#334155').font('Helvetica').fontSize(7.1);
  text('Customer Signature: ______________________________',L+10,ly,{width:225});
  text('Printed Name: ______________________________',L+245,ly,{width:210});
  text('Date: ______________',L+455,ly,{width:63,align:'right'});
  y+=noticeH+8;

  // Footer remains safely inside every page's printable area.
  const pages=doc.bufferedPageRange();
  for(let p=0;p<pages.count;p++){
   doc.switchToPage(pages.start+p);
   const fy=doc.page.height-doc.page.margins.bottom-9;
   doc.save().moveTo(L,fy-7).lineTo(R,fy-7).strokeColor(LINE).lineWidth(.5).stroke().restore();
   doc.fillColor(MUTED).font('Helvetica').fontSize(6.7);
   text(`IRON TEAM TRUCK & TRAILER REPAIR   ·   ${i.invoice_number}   ·   Page ${p+1} of ${pages.count}`,L,fy,{width:W,align:'center'});
  }

  doc.end();
 }catch(e){next(e)}
});

const stripeSecret=String(process.env.STRIPE_SECRET_KEY||'').trim();
const resendKey=String(process.env.RESEND_API_KEY||'').trim();
const invoiceFromEmail=String(process.env.INVOICE_FROM_EMAIL||'').trim();
app.post('/api/invoices/:id/payment-link',auth,managerPermission("invoices"),async(req,res,next)=>{try{if(!stripeSecret)return res.status(503).json({error:'Stripe is not configured. Add STRIPE_SECRET_KEY in Railway.'});const x=await getInvoiceBundle(requireDb(),req.params.id);if(!x)return res.status(404).json({error:'Invoice not found.'});const i=x.invoice,amount=Math.round(Number(i.balance_due||0)*100);if(amount<50)return res.status(409).json({error:'Invoice has no payable balance.'});const base=String(process.env.APP_PUBLIC_URL||'').replace(/\/$/,'');const p=new URLSearchParams();p.set('mode','payment');p.set('success_url',`${base}/?payment=success&invoice=${encodeURIComponent(i.invoice_number)}`);p.set('cancel_url',`${base}/?payment=cancel&invoice=${encodeURIComponent(i.invoice_number)}`);p.set('line_items[0][price_data][currency]','usd');p.set('line_items[0][price_data][product_data][name]',`Invoice ${i.invoice_number}`);p.set('line_items[0][price_data][unit_amount]',String(amount));p.set('line_items[0][quantity]','1');p.set('metadata[invoice_id]',String(i.id));p.set('metadata[invoice_number]',String(i.invoice_number));const rr=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${stripeSecret}`,'Content-Type':'application/x-www-form-urlencoded'},body:p});const d=await rr.json();if(!rr.ok)throw new Error(d?.error?.message||'Stripe checkout could not be created.');await requireDb().query('UPDATE customer_invoices SET payment_url=$2,stripe_session_id=$3,updated_at=now() WHERE id=$1::bigint',[i.id,d.url,d.id]);await audit(req.user.username,'invoice_payment_link_created',{invoiceId:i.id});res.json({ok:true,url:d.url})}catch(e){next(e)}});
app.post('/api/invoices/:id/email',auth,managerPermission("invoices"),async(req,res,next)=>{try{if(!resendKey||!invoiceFromEmail)return res.status(503).json({error:'Email is not configured. Add RESEND_API_KEY and INVOICE_FROM_EMAIL in Railway.'});const x=await getInvoiceBundle(requireDb(),req.params.id);if(!x)return res.status(404).json({error:'Invoice not found.'});const i=x.invoice,to=String(req.body?.email||i.customer_email||'').trim();if(!to)return res.status(400).json({error:'Customer email is required.'});const pay=i.payment_url?`<p><a href="${String(i.payment_url).replace(/"/g,'')}" style="display:inline-block;background:#155eef;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Pay Invoice Securely</a></p>`:'';const html=`<div style="font-family:Arial,sans-serif;max-width:640px"><h2>Iron Team Truck & Trailer Repair</h2><p>Invoice <b>${i.invoice_number}</b> for Unit <b>${i.unit_number||'—'}</b> is ready.</p><p>Total: <b>$${Number(i.total||0).toFixed(2)}</b><br>Balance due: <b>$${Number(i.balance_due||0).toFixed(2)}</b></p>${pay}<p>Please contact the shop with any questions.</p><hr><p style="font-size:12px"><b>Parts Warranty:</b> We are responsible for handling eligible warranty claims on parts supplied and installed by Iron Team Truck & Trailer Repair, subject to the applicable manufacturer warranty and shop terms.</p><p style="font-size:12px"><b>Tire / Wheel Safety:</b> After tire or wheel service, wheel fasteners / lug nuts must be checked and re-torqued after approximately 50 miles of driving. Please return to our shop for this safety check.</p></div>`;const rr=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:invoiceFromEmail,to:[to],subject:`Invoice ${i.invoice_number} — Iron Team Truck & Trailer Repair`,html})});const d=await rr.json();if(!rr.ok)throw new Error(d?.message||'Email could not be sent.');await requireDb().query('UPDATE customer_invoices SET customer_email=$2,email_sent_at=now(),updated_at=now() WHERE id=$1::bigint',[i.id,to]);await audit(req.user.username,'invoice_emailed',{invoiceId:i.id,to});res.json({ok:true,id:d.id})}catch(e){next(e)}});
const memoryCache=new Map();
function aiErrorResponse(res,err,fallback){
 console.error("AI ERROR:",err?.status,err?.code,err?.message);
 if(err?.code==="AI_NOT_CONFIGURED")return res.status(503).json({error:err.message,code:"AI_NOT_CONFIGURED"});
 if(err?.status===401||err?.code==="invalid_api_key")return res.status(401).json({error:"AI provider rejected the API key. Check the server-side API key in Railway.",code:"INVALID_API_KEY"});
 if(err?.status===429)return res.status(429).json({error:"AI provider is temporarily rate-limited. The configured paid fallback is attempted automatically when available; try again shortly.",code:"RATE_LIMIT"});
 if(err?.status===403)return res.status(403).json({error:"The configured AI key/model does not have permission for this request.",code:"PERMISSION"});
 return res.status(500).json({error:String(err?.message||fallback||"AI request failed").slice(0,500),code:err?.code||"AI_ERROR"});
}
function requireAIClient(){if(!client){const e=new Error("OpenAI API key is not configured on the server.");e.code="AI_NOT_CONFIGURED";throw e}return client}
function requireOpenRouterClient(){if(!openRouterClient){const e=new Error("OPENROUTER_API_KEY is not configured on the server.");e.code="AI_NOT_CONFIGURED";throw e}return openRouterClient}
function cacheKey(text,targetLanguage){return `${targetLanguage}|${text}`}
async function openAITextAI(system,user){const response=await requireAIClient().responses.create({model:process.env.OPENAI_TEXT_MODEL||"gpt-5.6-luna",input:[{role:"system",content:[{type:"input_text",text:system}]},{role:"user",content:[{type:"input_text",text:user}]}]});return String(response.output_text||"").trim()}
async function openRouterTextAI(system,user){const response=await requireOpenRouterClient().chat.completions.create({model:openRouterModel,messages:[{role:"system",content:system},{role:"user",content:user}],temperature:0.2,max_tokens:1800});return String(response.choices?.[0]?.message?.content||"").trim()}
async function textAI(system,user){
 if(aiProvider==="openrouter")return openRouterTextAI(system,user);
 if(aiProvider==="openai")return openAITextAI(system,user);
 if(openRouterClient){try{return await openRouterTextAI(system,user)}catch(e){if(!client)throw e;console.warn("OpenRouter failed; falling back to OpenAI:",e?.status,e?.message)}}
 if(client)return openAITextAI(system,user);
 const e=new Error("No AI provider is configured. Add OPENROUTER_API_KEY or OPENAI_API_KEY in Railway.");e.code="AI_NOT_CONFIGURED";throw e;
}
function selectedAIProvider(){if(aiProvider==="openrouter")return openRouterClient?"openrouter":"none";if(aiProvider==="openai")return client?"openai":"none";return openRouterClient?"openrouter":client?"openai":"none"}
app.get("/api/ai/status",auth,(req,res)=>res.json({server:true,aiConfigured:Boolean(openRouterClient||client),provider:selectedAIProvider(),openRouterConfigured:Boolean(openRouterClient),openAIConfigured:Boolean(client),model:selectedAIProvider()==="openrouter"?openRouterModel:String(process.env.OPENAI_TEXT_MODEL||"gpt-5.6-luna"),message:openRouterClient?`OpenRouter paid-credit AI ready (${openRouterModel}).`:client?"AI ready via OpenAI.":"No AI key is configured."}));
app.post("/api/translate",auth,async(req,res)=>{try{const {text,sourceLanguage="English",targetLanguage="Ukrainian",domain="semi-truck and trailer repair shop software"}=req.body||{};if(typeof text!=="string"||!text.trim())return res.status(400).json({error:"text is required"});if(text.length>5000)return res.status(400).json({error:"text is too long"});const key=cacheKey(text,targetLanguage);if(memoryCache.has(key))return res.json({translation:memoryCache.get(key),cached:true});const translation=await textAI(`You are the professional translator for a US semi-truck and trailer repair shop management application. Translate ${sourceLanguage} into ${targetLanguage}. Preserve truck/unit numbers, part numbers, VINs, usernames, company names, abbreviations, measurements, timestamps, and proper nouns. Use natural terminology used by diesel mechanics. Return only the translated text.`,`Domain: ${domain}\n\nText:\n${text}`);memoryCache.set(key,translation);res.json({translation,cached:false})}catch(e){return aiErrorResponse(res,e,"translation_failed")}});
const NOTE_MODES={
 professional:"Detect the input language automatically. Translate to professional American English and rewrite as a concise heavy-duty truck repair service note.",
 invoice:"Detect the input language automatically. Translate to American English and produce a short invoice-ready repair description, usually 1-3 sentences.",
 detailed:"Detect the input language automatically. Translate to American English and produce a detailed professional repair narrative in logical chronological order.",
 customer:"Detect the input language automatically. Translate to clear American English for a truck owner or fleet manager. Explain technical language without changing facts.",
 grammar:"Keep the original language. Correct grammar, spelling and clarity only; do not translate unless needed to make mixed-language text internally consistent.",
 ukrainian:"Translate into natural professional Ukrainian used by truck/diesel mechanics.",
 technical:"Detect the input language automatically. Translate to concise professional American English describing only the observed problem/finding.",
 recommendation:"Detect the input language automatically. Translate to concise professional American English describing only the recommended repair/action."
};
function manualIntent(q){return /\b(torque|torque spec|specification|wiring|diagram|schematic|procedure|repair manual|service manual|tighten|ft[- ]?lb|nm|момент|схем|мануал|проводк|процедур|затяжк)\b/i.test(String(q||''))}
async function findWorkshopManuals(db,unit,question){
 const make=String(unit?.make||''),model=String(unit?.model||''),engine=String(unit?.engine||''),year=Number(unit?.year||0);
 const q=String(question||'').toLowerCase();
 const r=await db.query(`SELECT id,title,make,model,year_from,year_to,engine,category,source_name,source_url,original_name,size_bytes,r2_key
 FROM workshop_manuals WHERE active=true AND
 (coalesce(make,'')='' OR lower(make)=lower($1) OR lower($1) LIKE '%'||lower(make)||'%') AND
 (coalesce(model,'')='' OR lower(model)=lower($2) OR lower($2) LIKE '%'||lower(model)||'%') AND
 ($3::int=0 OR (coalesce(year_from,$3::int)<=$3::int AND coalesce(year_to,$3::int)>=$3::int))
 ORDER BY CASE WHEN lower(coalesce(engine,''))=lower($4) AND $4<>'' THEN 0 ELSE 1 END, updated_at DESC LIMIT 8`,[make,model,year,engine]);
 return r.rows.map(x=>({...x,score:(q.includes(String(x.category||'').replace(/_/g,' ').toLowerCase())?2:0)+(x.r2_key?1:0)})).sort((a,b)=>b.score-a.score);
}
async function manualPdfAsk(manual,system,user){
 if(!manual?.r2_key||!openRouterClient)return '';
 if(Number(manual.size_bytes||0)>18*1024*1024)return '';
 const obj=await requireR2().send(new GetObjectCommand({Bucket:r2Bucket,Key:manual.r2_key}));
 const bytes=await obj.Body.transformToByteArray();
 const b64=Buffer.from(bytes).toString('base64');
 const content=[{type:'text',text:`${system}\n\n${user}\n\nThis is a shop-owned/licensed workshop manual. Use only facts actually present in the manual. For torque/specification answers include units and page/section when visible. For wiring/diagram questions identify the relevant diagram/page/section and never invent a circuit.`},{type:'file',file:{filename:manual.original_name||'manual.pdf',file_data:`data:application/pdf;base64,${b64}`}}];
 const r=await requireOpenRouterClient().chat.completions.create({model:openRouterModel,messages:[{role:'user',content}],temperature:0.1,max_tokens:2200,plugins:[{id:'file-parser',pdf:{engine:'cloudflare-ai'}}]});
 return String(r.choices?.[0]?.message?.content||'').trim();
}
app.get('/api/manuals',auth,async(req,res,next)=>{try{const q=await requireDb().query(`SELECT id,title,make,model,year_from,year_to,engine,category,source_name,source_url,original_name,size_bytes,active,created_by,created_at FROM workshop_manuals WHERE active=true ORDER BY updated_at DESC,id DESC`);res.json({items:q.rows})}catch(e){next(e)}});
app.post('/api/manuals',auth,adminOnly,upload.single('manual'),async(req,res,next)=>{try{const title=String(req.body?.title||'').trim(),make=String(req.body?.make||'').trim(),model=String(req.body?.model||'').trim(),engine=String(req.body?.engine||'').trim(),category=String(req.body?.category||'service_manual').trim(),sourceName=String(req.body?.sourceName||'').trim(),sourceUrl=String(req.body?.sourceUrl||'').trim(),yearFrom=Number(req.body?.yearFrom||0)||null,yearTo=Number(req.body?.yearTo||0)||null;if(!title)return res.status(400).json({error:'Manual title is required.'});let key=null,name=null,mime=null,size=0;if(req.file){if(req.file.mimetype!=='application/pdf')return res.status(415).json({error:'Workshop manual upload must be a PDF.'});key=`manuals/${Date.now()}-${crypto.randomUUID()}.pdf`;await requireR2().send(new PutObjectCommand({Bucket:r2Bucket,Key:key,Body:req.file.buffer,ContentType:'application/pdf',CacheControl:'private, max-age=3600'}));name=req.file.originalname||'manual.pdf';mime='application/pdf';size=req.file.size||req.file.buffer.length}const q=await requireDb().query(`INSERT INTO workshop_manuals(title,make,model,year_from,year_to,engine,category,source_name,source_url,r2_key,original_name,mime_type,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[title,make||null,model||null,yearFrom,yearTo,engine||null,category,sourceName||null,sourceUrl||null,key,name,mime,size,req.user.username]);await audit(req.user.username,'workshop_manual_added',{id:q.rows[0].id,title});res.json({item:q.rows[0]})}catch(e){next(e)}});
app.get('/api/manuals/:id/open',auth,async(req,res,next)=>{try{const q=await requireDb().query('SELECT * FROM workshop_manuals WHERE id=$1::bigint AND active=true',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Manual not found.'});const m=q.rows[0];if(m.r2_key){const url=await getSignedUrl(requireR2(),new GetObjectCommand({Bucket:r2Bucket,Key:m.r2_key}),{expiresIn:900});return res.json({url,title:m.title})}if(m.source_url)return res.json({url:m.source_url,title:m.title});res.status(404).json({error:'This manual has no document or source link.'})}catch(e){next(e)}});
app.delete('/api/manuals/:id',auth,ownerOnly,async(req,res,next)=>{try{const q=await requireDb().query('DELETE FROM workshop_manuals WHERE id=$1::bigint RETURNING id,title,r2_key',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Manual not found.'});if(q.rows[0].r2_key){try{await requireR2().send(new DeleteObjectCommand({Bucket:r2Bucket,Key:q.rows[0].r2_key}))}catch{}}await audit(req.user.username,'workshop_manual_deleted',{id:q.rows[0].id,title:q.rows[0].title});res.json({ok:true})}catch(e){next(e)}});
function pmServiceIntent(q){
 return /\b(pm(?:\s+service)?|preventive\s+maintenance|oil(?:\s+change|\s+service)?|engine\s+oil|lube|lubrication|grease|filter(?:s)?)\b/i.test(String(q||''));
}
function compactInvoiceHistory(rows){
 const byId=new Map();
 for(const row of Array.isArray(rows)?rows:[]){
  const key=String(row.id||row.invoice_number||'');
  if(!key)continue;
  if(!byId.has(key))byId.set(key,{id:row.id,invoiceNumber:row.invoice_number,date:row.invoice_date,mileage:row.mileage,status:row.status,lines:[]});
  const g=byId.get(key);
  const desc=String(row.description||row.job_name||'').trim();
  if(desc)g.lines.push({type:row.line_type||'',description:desc,partNumber:row.part_number||'',quantity:row.quantity});
 }
 return [...byId.values()];
}
function pmFactText(x){
 const parts=[];
 if(x.date)parts.push(String(x.date).slice(0,10));
 if(x.mileage!==null&&x.mileage!==undefined&&x.mileage!=='')parts.push(`${Number(x.mileage).toLocaleString('en-US')} miles`);
 if(x.invoiceNumber)parts.push(`Invoice ${x.invoiceNumber}`);
 if(x.status)parts.push(`status ${x.status}`);
 const labor=(x.lines||[]).filter(l=>l.type==='labor').map(l=>l.description).filter(Boolean);
 if(labor.length)parts.push(labor.slice(0,3).join('; '));
 return parts.join(' · ');
}
function extractJsonObject(text){const s=String(text||'').trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();try{return JSON.parse(s)}catch{}const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a){try{return JSON.parse(s.slice(a,b+1))}catch{}}throw new Error('AI returned an unreadable structured response. Please try again.');}
async function multimodalInvoiceExtract(file,extraText=''){
 const mime=String(file?.mimetype||'').toLowerCase();if(!file?.buffer?.length)throw new Error('Attach an invoice image or PDF.');
 if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)){const e=new Error('AI invoice import supports PDF, JPG, PNG, and WEBP.');e.status=415;throw e}
 const data=`data:${mime};base64,${file.buffer.toString('base64')}`;
 const schema=`Return ONLY valid JSON with this shape: {"documentType":"invoice|service_order|unknown","sourceNumber":"","customerName":"","customerPhone":"","unitNumber":"","vin":"","usdot":"","mileage":null,"invoiceDate":"YYYY-MM-DD or empty","dueDate":"YYYY-MM-DD or empty","terms":"","poNumber":"","authorizer":"","laborTotal":null,"partsTotal":null,"grandTotal":null,"services":[{"description":"","labor":[{"description":"","hours":0,"rate":0,"amount":0,"taxable":false}],"parts":[{"partNumber":"","description":"","quantity":0,"unitPrice":0,"amount":0,"taxable":true}]}],"warnings":[]}. Never invent unreadable values. Use empty string/null and add a warning. Group each part under the labor/service immediately above it. Preserve source numbers exactly. For Fullbay documents, if a field labeled Service Order or SO is visible, use that value as sourceNumber (for example SO-1009); do not substitute an invoice number. Treat the document as historical completed repair work unless the user explicitly asks to create a new billing invoice.`;
 const prompt=`You are ITTR Legacy Invoice Import AI. Extract this heavy-duty truck/trailer invoice or service order for migration into a repair ERP. ${schema}\nUser note: ${String(extraText||'').slice(0,1500)}`;
 let response;
 if(openRouterClient){const content=[{type:'text',text:prompt}];if(mime==='application/pdf')content.push({type:'file',file:{filename:file.originalname||'invoice.pdf',file_data:data}});else content.push({type:'image_url',image_url:{url:data}});response=await openRouterClient.chat.completions.create({model:openRouterInvoiceFallbackModel,messages:[{role:'user',content}],temperature:0,max_tokens:5000, ...(mime==='application/pdf'?{plugins:[{id:'file-parser',pdf:{engine:'cloudflare-ai'}}]}:{})});return extractJsonObject(response.choices?.[0]?.message?.content||'')}
 if(client&&mime.startsWith('image/')){response=await client.chat.completions.create({model:String(process.env.OPENAI_VISION_MODEL||'gpt-5.6-luna'),messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:data}}]}],temperature:0,max_tokens:5000});return extractJsonObject(response.choices?.[0]?.message?.content||'')}
 throw Object.assign(new Error('Configure OPENROUTER_API_KEY to use AI invoice/image import.'),{code:'AI_NOT_CONFIGURED'});
}
async function enrichLegacyInvoiceDraft(db,draft){
 const d={...draft};let customer=null,unit=null;
 if(d.customerName){const q=await db.query(`SELECT * FROM fullbay_import_customers WHERE lower(customer_name)=lower($1) OR lower(customer_name) LIKE '%'||lower($1)||'%' ORDER BY CASE WHEN lower(customer_name)=lower($1) THEN 0 ELSE 1 END,id LIMIT 5`,[String(d.customerName).trim()]);if(q.rowCount===1||q.rows[0])customer=q.rows[0]}
 if(d.vin||d.unitNumber){const q=await db.query(`SELECT * FROM customer_units WHERE ($1<>'' AND lower(coalesce(vin,''))=lower($1)) OR ($2<>'' AND lower(coalesce(unit_number,''))=lower($2)) ORDER BY CASE WHEN $1<>'' AND lower(coalesce(vin,''))=lower($1) THEN 0 ELSE 1 END,updated_at DESC LIMIT 5`,[String(d.vin||''),String(d.unitNumber||'')]);unit=q.rows[0]||null;if(unit?.customer_id&&!customer){customer=(await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1',[unit.customer_id])).rows[0]||null}}
 const partMatches=[];for(const svc of Array.isArray(d.services)?d.services:[]){for(const part of Array.isArray(svc.parts)?svc.parts:[]){let m=null;const token=String(part.partNumber||part.description||'').trim();if(token){const q=await db.query(`SELECT id,part_number,description,cost AS buy_price,price AS sell_price,quantity,location FROM fullbay_import_parts WHERE lower(coalesce(part_number,''))=lower($1) OR lower(coalesce(description,''))=lower($1) OR lower(coalesce(part_number,'')) LIKE '%'||lower($1)||'%' OR lower(coalesce(description,'')) LIKE '%'||lower($1)||'%' ORDER BY CASE WHEN lower(coalesce(part_number,''))=lower($1) THEN 0 ELSE 1 END,id LIMIT 1`,[token]);m=q.rows[0]||null}partMatches.push({source:part.partNumber||part.description||'',match:m})}}
 return {...d,matches:{customer:customer?{id:customer.id,name:customer.customer_name,dotNumber:customer.dot_number}:null,unit:unit?{id:unit.id,unitNumber:unit.unit_number,vin:unit.vin,customerId:unit.customer_id}:null,parts:partMatches}};
}
app.post('/api/ai/import/analyze',auth,managerPermission('invoices'),upload.single('file'),async(req,res)=>{try{const extracted=await multimodalInvoiceExtract(req.file,String(req.body?.message||''));const draft=await enrichLegacyInvoiceDraft(requireDb(),extracted);await audit(req.user.username,'ai_legacy_invoice_analyzed',{file:req.file?.originalname||'',sourceNumber:draft.sourceNumber||'',customer:draft.customerName||'',unit:draft.unitNumber||''});res.json({ok:true,draft})}catch(e){return aiErrorResponse(res,e,'AI import analysis failed')}});

app.post('/api/ai/import/commit-history',auth,managerPermission('customers'),async(req,res,next)=>{const db=await requireDb().connect();try{
 const d=req.body?.draft||{},services=Array.isArray(d.services)?d.services:[];
 if(!services.length)return res.status(400).json({error:'No completed service lines were detected.'});
 const customerId=Number(d.matches?.customer?.id||0)||null,unitId=Number(d.matches?.unit?.id||0)||null;
 if(!customerId||!unitId)return res.status(409).json({error:'Match the legacy document to an existing ITTR customer and unit before adding it to permanent vehicle history.'});
 const unit=(await db.query('SELECT * FROM customer_units WHERE id=$1::bigint',[unitId])).rows[0];
 if(!unit||String(unit.customer_id)!==String(customerId))return res.status(409).json({error:'The selected unit does not belong to the matched customer.'});
 const source=String(d.sourceNumber||'').trim()||`AI-${Date.now()}`,so=/^SO/i.test(source)?source:`SO-${source}`;
 const completed=d.invoiceDate||d.dueDate||new Date().toISOString().slice(0,10);
 await db.query('BEGIN');
 let imported=0;
 for(let i=0;i<services.length;i++){
   const svc=services[i]||{},labors=Array.isArray(svc.labor)?svc.labor:[],parts=Array.isArray(svc.parts)?svc.parts:[];
   const laborAmount=labors.reduce((n,l)=>n+Number(l.amount ?? (Number(l.hours||0)*Number(l.rate||0)) ?? 0),0);
   const partAmount=parts.reduce((n,p)=>n+Number(p.amount ?? (Number(p.quantity||0)*Number(p.unitPrice||0)) ?? 0),0);
   const hours=labors.reduce((n,l)=>n+Number(l.hours||0),0),total=laborAmount+partAmount;
   const complaint=String(svc.description||labors[0]?.description||`Legacy service ${i+1}`).slice(0,2000);
   const correction=String(svc.correction||svc.description||labors.map(x=>x.description).filter(Boolean).join('; ')||complaint).slice(0,5000);
   const key=`ai-legacy-history:${canonicalFullbaySo(so).toLowerCase()}:${customerId}:${unitId}:${i+1}`;
   const raw={aiImported:true,documentType:d.documentType||'legacy',sourceNumber:source,authorizer:d.authorizer||'',terms:d.terms||'',warnings:d.warnings||[],aiLabor:labors,aiParts:parts};
   await db.query(`INSERT INTO fullbay_service_history(source_key,customer_id,customer_name,unit_record_id,unit_number,vin,unit_status,unit_type,unit_subtype,service_order,invoice_number,po_number,action_number,action_completed_at,lead_tech,tech,complaint,actual_correction,hours,labor_amount,part_amount,total_amount,unit_miles,component,system,raw,source_file,service_writer,invoiced,service_status,parts_status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28,$29,$30,$31)
   ON CONFLICT(source_key) DO UPDATE SET customer_id=EXCLUDED.customer_id,customer_name=EXCLUDED.customer_name,unit_record_id=EXCLUDED.unit_record_id,unit_number=EXCLUDED.unit_number,vin=EXCLUDED.vin,service_order=EXCLUDED.service_order,invoice_number=EXCLUDED.invoice_number,po_number=EXCLUDED.po_number,action_completed_at=EXCLUDED.action_completed_at,complaint=EXCLUDED.complaint,actual_correction=EXCLUDED.actual_correction,hours=EXCLUDED.hours,labor_amount=EXCLUDED.labor_amount,part_amount=EXCLUDED.part_amount,total_amount=EXCLUDED.total_amount,unit_miles=EXCLUDED.unit_miles,raw=EXCLUDED.raw,source_file=EXCLUDED.source_file,service_status='Completed',parts_status='Done',updated_at=now()`,
   [key,customerId,d.matches.customer.name||d.customerName||unit.customer_name,unitId,unit.unit_number,unit.vin,unit.unit_status,unit.unit_type,unit.unit_subtype,so,d.documentType==='invoice'?source:null,String(d.poNumber||'')||null,String(i+1),completed,null,null,complaint,correction,hours,laborAmount,partAmount,total,Number(d.mileage||unit.mileage||0)||null,'Legacy Fullbay','Repair History',JSON.stringify(raw),'AI legacy screenshot',null,d.documentType==='invoice', 'Completed','Done']);
   imported++;
 }
 await reconcileFullbayHistoryLinks(db);
 await db.query('COMMIT');
 await audit(req.user.username,'ai_legacy_history_committed',{serviceOrder:so,customerId,unitId,services:imported,sourceNumber:source});
 res.json({ok:true,serviceOrder:so,customerId,unitId,services:imported});
}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/ai/import/commit-invoice',auth,managerPermission('invoices'),async(req,res,next)=>{const db=await requireDb().connect();try{const d=req.body?.draft||{};if(!Array.isArray(d.services)||!d.services.length)return res.status(400).json({error:'No service lines were detected. Review the import first.'});await db.query('BEGIN');const customerId=Number(d.matches?.customer?.id||0)||null,unitId=Number(d.matches?.unit?.id||0)||null,num=await nextInvoiceNumber(db),terms=String(d.terms||'Due on Receipt'),days=/60/.test(terms)?60:/30/.test(terms)?30:/15/.test(terms)?15:0;const q=await db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,unit_id,unit_number,vin,dot_number,mileage,po_number,invoice_date,due_date,terms,tax_rate,internal_note,created_by) VALUES($1,$2::bigint,$3,$4::bigint,$5,$6,$7,$8::numeric,$9,coalesce($10::date,CURRENT_DATE),coalesce($11::date,coalesce($10::date,CURRENT_DATE)+$12::int),$13,0,$14,$15) RETURNING id`,[num,customerId,String(d.customerName||d.matches?.customer?.name||'Legacy Customer'),unitId,String(d.unitNumber||d.matches?.unit?.unitNumber||''),String(d.vin||d.matches?.unit?.vin||''),String(d.usdot||d.matches?.customer?.dotNumber||''),Number(d.mileage||0)||null,String(d.poNumber||''),d.invoiceDate||null,d.dueDate||null,days,terms,`AI imported from legacy ${d.documentType||'invoice'}${d.sourceNumber?` · Source ${d.sourceNumber}`:''}. Review before finalizing.`,req.user.username]);const iid=q.rows[0].id;let order=0;for(const svc of d.services){const job=String(svc.description||'Legacy Service').slice(0,500);const labors=Array.isArray(svc.labor)&&svc.labor.length?svc.labor:[{description:job,hours:0,rate:0,taxable:false}];let parent=null;for(const l of labors){const qty=Math.max(0,Number(l.hours||0)),price=Math.max(0,Number(l.rate||0));const x=await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,quantity,unit_price,unit_cost,taxable,line_total,parent_line_id) VALUES($1,$2,$3,$4,'labor',$5,$6::numeric,$7::numeric,0,$8::boolean,$6::numeric*$7::numeric,NULL) RETURNING id`,[iid,++order,crypto.randomUUID(),job,String(l.description||job),qty,price,l.taxable===true]);if(!parent)parent=x.rows[0].id}for(const part of Array.isArray(svc.parts)?svc.parts:[]){const qty=Math.max(0,Number(part.quantity||0)),price=Math.max(0,Number(part.unitPrice||0));await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,line_total,parent_line_id) VALUES($1,$2,$3,'part',$4,$5,$6::numeric,$7::numeric,0,$8::boolean,$6::numeric*$7::numeric,$9::bigint)`,[iid,++order,job,String(part.description||part.partNumber||'Part'),String(part.partNumber||''),qty,price,part.taxable!==false,parent])}}
 await recalcInvoice(db,iid);await db.query('COMMIT');await audit(req.user.username,'ai_legacy_invoice_committed',{invoiceId:iid,sourceNumber:d.sourceNumber||'',services:d.services.length});res.json({ok:true,id:iid})}catch(e){try{await db.query('ROLLBACK')}catch{}next(e)}finally{db.release()}});
app.post('/api/ai/copilot/action',auth,async(req,res)=>{try{const message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'message required'});const m=message.toLowerCase();let action=null;if(/\b(open|go to|show)\b.*\binvoice/.test(m))action={type:'navigate',view:'invoices',label:'Open Invoices'};else if(/\b(open|go to|show)\b.*\b(parts|inventory)\b/.test(m))action={type:'navigate',view:'parts',label:'Open Parts'};else if(/\b(open|go to|show)\b.*\bcustomer/.test(m))action={type:'navigate',view:'customers',label:'Open Customers'};else if(/\b(open|go to|show)\b.*\b(work order|work orders)\b/.test(m))action={type:'navigate',view:'workorders',label:'Open Work Orders'};else if(/\b(check|audit|diagnos|bug|lag|slow|error)/.test(m)){const db=requireDb();const build={frontend:'24.23.1',backend:'24.23.1'};const auditRows=(await db.query('SELECT action,created_at FROM server_audit ORDER BY id DESC LIMIT 40')).rows;action={type:'diagnostic',label:'ShopFlow diagnostic',report:{build,online:true,recentAuditEvents:auditRows.length,checks:['API route available','Database query successful','Copilot action layer responding'],note:'Runtime browser performance and failed requests are captured by the client diagnostic snapshot when available.'}}}res.json({ok:true,action})}catch(e){return aiErrorResponse(res,e,'Copilot action failed')}});

app.post("/api/ai/shop-chat",auth,async(req,res)=>{try{
 const question=String(req.body?.message||'').trim();if(!question)return res.status(400).json({error:'message required'});if(question.length>3000)return res.status(400).json({error:'Message is too long.'});
 const db=requireDb(),explicit=String(req.body?.unit||'').trim();
 const unitMatch=explicit?[null,explicit]:(question.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)||question.match(/(?:unit|truck|тра[кк]|машин|тягач|номер)\s*#?\s*([A-Za-z0-9-]{2,20})/i)||question.match(/\b(\d{2,8})\b/));
 let unit=null,history=[],invoices=[],workorders=[],manuals=[];
 if(unitMatch){const token=unitMatch[1];const uq=await db.query(`SELECT * FROM customer_units WHERE lower(coalesce(unit_number,''))=lower($1) OR lower(coalesce(vin,''))=lower($1) ORDER BY updated_at DESC LIMIT 1`,[token]);unit=uq.rows[0]||null;}
 if(unit){
  const hr=await db.query(`SELECT service_order,invoice_number,actual_correction,complaint,action_completed_at,hours,unit_miles,component,system,tech FROM fullbay_service_history WHERE lower(coalesce(unit_number,''))=lower($1) OR lower(coalesce(vin,''))=lower($2) ORDER BY action_completed_at DESC NULLS LAST LIMIT 180`,[unit.unit_number||'',unit.vin||'']);
  history=hr.rows;
  const ir=await db.query(`SELECT i.id,i.invoice_number,i.invoice_date,i.mileage,i.status,i.updated_at,l.line_type,l.job_name,l.description,l.part_number,l.quantity FROM customer_invoices i LEFT JOIN customer_invoice_lines l ON l.invoice_id=i.id WHERE i.unit_id=$1 OR lower(coalesce(i.unit_number,''))=lower($2) OR lower(coalesce(i.vin,''))=lower($3) ORDER BY i.invoice_date DESC,i.updated_at DESC,l.sort_order,l.id LIMIT 220`,[unit.id,unit.unit_number||'',unit.vin||'']);
  invoices=ir.rows;
  manuals=await findWorkshopManuals(db,unit,question);
  const st=await db.query("SELECT payload FROM app_state WHERE state_key='shopflow'");
  const sf=st.rows[0]?.payload||{};
  workorders=(Array.isArray(sf.workorders)?sf.workorders:[]).filter(w=>String(w.unit||'').toLowerCase()===String(unit.unit_number||'').toLowerCase()||String(w.vin||'').toLowerCase()===String(unit.vin||'').toLowerCase()).slice(-60).map(w=>({id:w.id,unit:w.unit,status:w.status,date:w.date,completedAt:w.completedAt,mileage:w.mileage,tasks:(w.tasks||[]).map(t=>({name:t.t,outcome:t.taskOutcome||'',note:t.outcomeNote||'',elapsedMs:t.elapsedMs||0}))}));
 }
 const financialAllowed=req.user.role==='admin'||(req.user.role==='manager'&&req.user.permissions?.financials!==false);
 const recentIttrServices=compactInvoiceHistory(invoices);
 const pmInvoiceMatches=recentIttrServices.filter(x=>pmServiceIntent((x.lines||[]).map(l=>`${l.description} ${l.partNumber||''}`).join(' ')));
 const pmWorkorderMatches=workorders.filter(w=>pmServiceIntent((w.tasks||[]).map(t=>`${t.name||''} ${t.outcome||''} ${t.note||''}`).join(' ')));
 const pmFullbayMatches=history.filter(h=>pmServiceIntent(`${h.complaint||''} ${h.actual_correction||''} ${h.component||''} ${h.system||''}`));
 const context={
  unit:unit?{unitNumber:unit.unit_number,vin:unit.vin,year:unit.year,make:unit.make,model:unit.model,mileage:unit.mileage,engine:unit.engine,transmission:unit.transmission}:null,
  recentIttrServices:recentIttrServices.map(x=>financialAllowed?x:{...x,status:undefined}),
  fullbayHistory:history,
  ittrWorkOrders:workorders,
  pmMatches:{ittrInvoices:pmInvoiceMatches.slice(0,12),ittrWorkOrders:pmWorkorderMatches.slice(-12).reverse(),fullbay:pmFullbayMatches.slice(0,20)},
  manualSources:manuals.map(m=>({id:m.id,title:m.title,category:m.category,sourceName:m.source_name,sourceUrl:m.source_url,vehicle:[m.year_from,m.year_to,m.make,m.model,m.engine].filter(Boolean).join(' ')}))
 };
 const system=`You are ITTR Workshop Copilot for a professional heavy-duty truck and trailer repair shop. Answer in the same language as the user. Use the supplied shop database as the authority for unit history. Never invent a repair, date, mileage, part number, torque specification, wiring detail, diagnostic result or price. Distinguish SHOP HISTORY from MANUAL / REFERENCE information. For history questions, use BOTH current ITTR invoices/jobs and imported Fullbay history. Current ITTR records are valid history even when their invoice status is draft, sent, partial, or paid; clearly state the status instead of ignoring the record. Always prioritize the newest matching ITTR record before older Fullbay records. For PM/oil-service questions, inspect pmMatches and recentIttrServices and search semantically across PM service, preventive maintenance, oil/filter change, lubrication, grease, engine oil and filters. If pmMatches.ittrInvoices contains a newer matching record, you MUST mention it in the answer with its date, mileage when available, invoice number and status. For technical procedures/specs, only give exact torque/spec values when they are present in the supplied licensed manual; otherwise say a verified manual/source is required. Keep answers concise and mechanic-friendly, with bullets when useful.`;
 let result='';let usedManual=null;
 if(manualIntent(question)&&manuals[0]?.r2_key&&openRouterClient&&r2Configured){usedManual=manuals[0];try{result=await manualPdfAsk(usedManual,system,`Question: ${question}\n\nSHOP DATABASE CONTEXT:\n${JSON.stringify(context)}`)}catch(e){console.warn('manual AI fallback',e?.message)}}
 if(!result)result=await textAI(system,`Question: ${question}\n\nSHOP DATABASE CONTEXT:\n${JSON.stringify(context)}`);
 if(pmServiceIntent(question)&&pmInvoiceMatches.length){
  const newest=pmInvoiceMatches[0],inv=String(newest.invoiceNumber||'');
  if(inv && !String(result||'').includes(inv)){
   const lead=`Most recent ITTR PM/service record: ${pmFactText(newest)}.`;
   result=`${lead}\n\n${String(result||'').trim()}`.trim();
  }
 }
 const sources=[];if(unit){if(history.length)sources.push({type:'history',label:`Fullbay history · Unit ${unit.unit_number}`});if(invoices.length)sources.push({type:'invoice',label:'ITTR invoices / jobs'});if(workorders.length)sources.push({type:'workorder',label:'ITTR work orders'});}if(usedManual)sources.unshift({type:'manual',label:usedManual.title,manualId:usedManual.id});else if(manuals.length&&manualIntent(question))sources.push({type:'manual_available',label:`${manuals.length} workshop manual source${manuals.length===1?'':'s'} available`});
 res.json({result,matchedUnit:unit?unit.unit_number:null,unit:context.unit,sources,manuals:manuals.slice(0,5).map(m=>({id:m.id,title:m.title,category:m.category,sourceName:m.source_name}))});
}catch(e){return aiErrorResponse(res,e,'Shop AI failed')}});
app.post("/api/ai/note",auth,async(req,res)=>{try{const text=String(req.body?.text||"").trim(),mode=String(req.body?.mode||"professional").toLowerCase();if(!text)return res.status(400).json({error:"text required"});if(text.length>8000)return res.status(400).json({error:"text is too long"});const instruction=NOTE_MODES[mode]||NOTE_MODES.professional;res.json({result:await textAI(`You are the writing assistant for a US heavy-duty truck and trailer repair shop. ${instruction} Preserve every technical fact exactly. Preserve VINs, unit numbers, part numbers, fault codes, cylinder numbers, measurements, quantities and component names. Never invent work performed, parts replaced, measurements, causes, diagnosis, customer authorization, or test results. If the source says a cause is possible or suspected, keep that uncertainty. Return only the rewritten text.`,text)})}catch(e){return aiErrorResponse(res,e,"AI note failed")}});
app.post("/api/ai/diagnostic",auth,async(req,res)=>{try{const text=String(req.body?.text||"").trim();if(!text)return res.status(400).json({error:"text required"});res.json({result:await textAI("You are a diagnostic assistant for professional heavy-duty diesel technicians. Provide a prioritized diagnostic plan, likely systems/causes, tests and measurements to verify. Clearly distinguish possibilities from confirmed facts. Do not claim a diagnosis without evidence. Include safety cautions when a test requires vehicle lifting, rotating components, fuel pressure, high voltage, air pressure, or hot systems.",text)})}catch(e){return aiErrorResponse(res,e,"AI diagnostic failed")}});
app.post("/api/ai/part",auth,async(req,res)=>{try{const vin=String(req.body?.vin||"").trim(),query=String(req.body?.query||"").trim();if(!query)return res.status(400).json({error:"query required"});res.json({result:await textAI("You assist a professional heavy-duty truck parts counter. Analyze the supplied part number/description and VIN context. List likely OEM numbers, supersessions, cross-reference candidates, manufacturer/application clues, and practical verification steps. Never present an uncertain cross-reference or fitment as confirmed. Clearly label each candidate as VERIFIED FROM PROVIDED FACTS, LIKELY / NEEDS CATALOG VERIFICATION, or INSUFFICIENT INFORMATION. Do not invent a part number just to provide an answer. End with a short 'Verify before ordering' checklist.",`VIN: ${vin||"not supplied"}\nPart/query: ${query}`)})}catch(e){return aiErrorResponse(res,e,"AI part assistant failed")}});
app.post("/api/ai/productivity-summary",auth,managerPermission("reports"),async(req,res)=>{try{const period=String(req.body?.period||"").slice(0,120),sessions=Array.isArray(req.body?.sessions)?req.body.sessions.slice(0,1000):[];res.json({result:await textAI("You are an operations analyst for a heavy-duty truck repair shop. Summarize the supplied factual mechanic task-session history for management. Focus on recorded repair labor, workload distribution, units/tasks worked, completed sessions, unusually long or fragmented jobs, and useful follow-up questions. Do not rank mechanics as good/bad and do not infer productivity percentage, attendance, idle time, or performance from missing data. Clearly state that the report is based only on recorded task sessions.",`Period: ${period}\nRecorded task sessions JSON:\n${JSON.stringify(sessions)}`)})}catch(e){return aiErrorResponse(res,e,"AI productivity summary failed")}});
app.post("/api/vin",auth,async(req,res)=>{try{const item=await lookupNhtsaVin(req.body?.vin);res.json({result:item,item,source:"NHTSA vPIC",official:true,decodedAt:new Date().toISOString()})}catch(e){res.status(e.status||500).json({error:e.message||"VIN decode failed.",code:e.code||"VIN_LOOKUP",details:e.details||undefined})}});
app.post("/api/transcribe",auth,upload.single("audio"),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:"audio required"});const file=new File([req.file.buffer],req.file.originalname||"note.webm",{type:req.file.mimetype||"audio/webm"});const t=await requireAIClient().audio.transcriptions.create({file,model:process.env.OPENAI_TRANSCRIBE_MODEL||"gpt-4o-transcribe"});res.json({text:t.text||""})}catch(e){return aiErrorResponse(res,e,"transcription failed")}});

app.get("/api/admin/server-audit",auth,managerPermission("reports"),async(req,res,next)=>{try{const q=await requireDb().query("SELECT username,action,details,created_at FROM server_audit ORDER BY id DESC LIMIT 500");res.json({rows:q.rows})}catch(e){next(e)}});
app.use("/api",(req,res)=>res.status(404).json({error:"API endpoint not found"}));
app.use((err,req,res,next)=>{
 const incident=`ITTR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
 console.error(`[${incident}]`,err);
 if(err?.code==="DB_NOT_CONFIGURED"||err?.code==="R2_NOT_CONFIGURED")return res.status(503).json({error:err.message,code:err.code,incident});
 if(err?.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Photo is too large. Maximum original file size is 25 MB.",incident});
 if(err?.code==="PHOTO_TYPE"||err?.code==="PHOTO_PROCESSING")return res.status(415).json({error:err.message,code:err.code,incident});
 const safe=String(err?.message||"Server error").replace(/OPENROUTER_API_KEY|OPENAI_API_KEY|R2_SECRET_ACCESS_KEY/gi,'server credential');
 res.status(500).json({error:isProd?"An unexpected server error occurred.":safe,incident});
});
app.get("*splat",(req,res)=>{
 res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
 res.setHeader("Pragma","no-cache");
 res.setHeader("Expires","0");
 res.sendFile(authoritativeIndex);
});

initDb()
  .then(()=>ensurePartsSearchPerformance())
  .then(()=>migrateLegacyFindingPhotosAtStartup())
  .then(()=>repairTaskUidsAtStartup())
  .then(()=>normalizeCollaborationAtStartup())
  .then(()=>repairApprovedFindingsAtStartup())
  .then(async()=>{try{const x=await reconcileDuplicateImportedCustomers();if(x.merged)console.log(`Merged ${x.merged} duplicate imported customer record(s).`)}catch(e){console.error("Customer dedupe warning:",e?.message)}try{const x=await repairFullbayServiceDatesAtStartup();if(x.repaired)console.log(`Repaired ${x.repaired} Fullbay service date(s).`)}catch(e){console.error("Fullbay service date repair warning:",e?.message)}try{const x=await repairFullbayTextArtifactsAtStartup();const n=Object.values(x).reduce((a,b)=>a+Number(b||0),0);if(n)console.log(`Normalized Fullbay display artifacts: ${JSON.stringify(x)}`)}catch(e){console.error("Fullbay text normalization warning:",e?.message)}httpServer.listen(port,()=>console.log(`ITTR v24.23.1 Online running on port ${port}`))})
  .catch(e=>{console.error("ITTR database startup failed:",e);process.exit(1)});
