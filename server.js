import express from "express";
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
const openRouterModel=String(process.env.OPENROUTER_MODEL||"openrouter/free").trim()||"openrouter/free";
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
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:"3mb"}));

// ITTR v22.6 authoritative frontend path:
// Always serve the repository root index.html in production.
// This prevents an older public/index.html from shadowing the current frontend.
const publicDir=path.join(__dirname,"public");
const webRoot=__dirname;
const authoritativeIndex=path.join(__dirname,"index.html");
console.log("ITTR authoritative web root:",webRoot);
app.use(express.static(webRoot,{
 setHeaders:(res,filePath)=>{
  if(filePath.endsWith("index.html")){
   res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
   res.setHeader("Pragma","no-cache");
   res.setHeader("Expires","0");
  }
 }
}));

app.use("/api/auth",rateLimit({windowMs:15*60*1000,max:100,standardHeaders:true,legacyHeaders:false}));

function requireDb(){if(!pool){const e=new Error("DATABASE_URL is not configured. Add PostgreSQL to the deployment and set DATABASE_URL.");e.code="DB_NOT_CONFIGURED";throw e;}return pool;}
function hashToken(t){return crypto.createHash("sha256").update(t).digest("hex")}
function cleanUsername(v){return String(v||"").trim().toLowerCase().replace(/[^a-z0-9._-]/g,"").slice(0,64)}
function publicUser(row){return {username:row.username,role:row.role,display:row.display_name||row.username,language:row.language||"en"}}

async function initDb(){
 if(!pool){console.warn("ITTR: DATABASE_URL missing. Cloud state/auth unavailable.");return;}
 await pool.query(`
 CREATE TABLE IF NOT EXISTS auth_users(
   id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
   password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','mechanic')),
   language TEXT DEFAULT 'en', active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
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
function adminOnly(req,res,next){if(req.user?.role!=="admin")return res.status(403).json({error:"Admin access required."});next()}
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
 let s=String(v??"").trim();
 const m=s.match(/^=\"([\s\S]*)\"$/);
 if(m)s=m[1].replace(/\"\"/g,'"');
 return s.trim();
}
function pickField(row,names){const m=new Map(Object.entries(row||{}).map(([k,v])=>[normHeader(k),cleanFullbayCell(v)]));for(const n of names){const v=m.get(normHeader(n));if(v!=null&&String(v).trim()!=="")return String(v).trim()}return ""}
function numOrNull(v){const n=Number(cleanFullbayCell(v).replace(/[$,%\s,]/g,""));return Number.isFinite(n)?n:null}
function boolOrNull(v){const s=cleanFullbayCell(v).toLowerCase();if(["yes","true","1","active","on"].includes(s))return true;if(["no","false","0","inactive","off"].includes(s))return false;return null}
function dateOrNull(v){const s=cleanFullbayCell(v);if(!s)return null;const d=new Date(s.replace(" ","T"));return Number.isFinite(d.getTime())?d.toISOString():null}
function fullbayDateOrNull(v){const s=cleanFullbayCell(v);if(!s)return null;let d=new Date(s);if(Number.isFinite(d.getTime()))return d.toISOString();const m=s.match(/^([0-9]{1,2}:[0-9]{2}(?:[AP]M)?)\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})$/i);if(m){d=new Date(`${m[2]} ${m[1]}`);if(Number.isFinite(d.getTime()))return d.toISOString()}return null}
function cleanRawRow(row){const out={};for(const [k,v] of Object.entries(row||{})){if(normHeader(k)==="portalcode")continue;out[k]=cleanFullbayCell(v)}return out}
function sourceKey(prefix,...vals){const raw=vals.map(v=>String(v||"").trim().toLowerCase()).filter(Boolean).join("|");return prefix+":"+crypto.createHash("sha256").update(raw||crypto.randomUUID()).digest("hex")}

app.get("/api/fullbay/import/status",auth,adminOnly,async(req,res,next)=>{try{
 const db=requireDb();const [c,p,srv,u,l]=await Promise.all([db.query("SELECT count(*)::int n,max(updated_at) last FROM fullbay_import_customers"),db.query("SELECT count(*)::int n,max(updated_at) last FROM fullbay_import_parts"),db.query("SELECT count(*)::int n,count(DISTINCT service_order)::int orders,max(updated_at) last FROM fullbay_service_history"),db.query("SELECT count(*)::int n FROM customer_units"),db.query("SELECT * FROM fullbay_import_log ORDER BY created_at DESC LIMIT 10")]);
 res.json({customers:c.rows[0],parts:p.rows[0],service:srv.rows[0],units:u.rows[0],recent:l.rows});
}catch(e){next(e)}});

app.post("/api/fullbay/import/customers",auth,adminOnly,upload.single("file"),async(req,res,next)=>{try{
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

app.post("/api/fullbay/import/parts",auth,adminOnly,upload.single("file"),async(req,res,next)=>{try{
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

app.post("/api/fullbay/import/service-history",auth,adminOnly,upload.single("file"),async(req,res,next)=>{
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

app.get("/api/fullbay/customers",auth,async(req,res,next)=>{try{
 const q=String(req.query.q||"").trim(),limit=Math.min(200,Math.max(1,Number(req.query.limit)||50)),offset=Math.max(0,Number(req.query.offset)||0),like=`%${q}%`;
 const r=await requireDb().query(`SELECT id,fullbay_id,customer_name,active,created_fullbay,customer_group,phone,secondary_phone,dot_number,external_id,address,city,state,postal_code,country,assigned_shop,taxable,tax_exempt_number,credit_terms,credit_limit,billing_contact,payment_method,default_labor_rate,price_level,access_method,billing_address,billing_city,billing_state,billing_postal_code,ext_accounting,updated_at FROM fullbay_import_customers WHERE $1='' OR customer_name ILIKE $2 OR coalesce(phone,'') ILIKE $2 OR coalesce(secondary_phone,'') ILIKE $2 OR coalesce(dot_number,'') ILIKE $2 OR coalesce(city,'') ILIKE $2 ORDER BY active DESC NULLS LAST,customer_name LIMIT $3 OFFSET $4`,[q,like,limit,offset]);
 const c=await requireDb().query(`SELECT count(*)::int n FROM fullbay_import_customers WHERE $1='' OR customer_name ILIKE $2 OR coalesce(phone,'') ILIKE $2 OR coalesce(secondary_phone,'') ILIKE $2 OR coalesce(dot_number,'') ILIKE $2 OR coalesce(city,'') ILIKE $2`,[q,like]);res.json({items:r.rows,total:c.rows[0].n,limit,offset});
}catch(e){next(e)}});

app.get("/api/fullbay/customers/:id",auth,async(req,res,next)=>{try{const r=await requireDb().query(`SELECT * FROM fullbay_import_customers WHERE id=$1`,[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Customer not found."});const item=r.rows[0];delete item.raw?.['Portal Code'];res.json({item});}catch(e){next(e)}});

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
app.get("/api/fmcsa/status",auth,adminOnly,(req,res)=>res.json({configured:Boolean(FMCSA_WEBKEY),provider:"FMCSA QCMobile / SAFER",official:true}));
app.get("/api/fmcsa/carriers/:dotNumber",auth,adminOnly,async(req,res)=>{try{const item=await lookupFmcsaCarrier(req.params.dotNumber);res.json({item,source:"FMCSA QCMobile API",official:true,checkedAt:new Date().toISOString()})}catch(e){res.status(e.status||500).json({error:e.message||"FMCSA lookup failed.",code:e.code||"FMCSA_LOOKUP"})}});
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
app.get("/api/customers",auth,adminOnly,async(req,res)=>{
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
app.post("/api/customers",auth,adminOnly,async(req,res,next)=>{try{
 const b=req.body||{},name=String(b.customer_name||"").trim();if(!name)return res.status(400).json({error:"Customer / company name is required."});
 const key=`manual:${crypto.randomUUID()}`;const r=await requireDb().query(`INSERT INTO fullbay_import_customers(source_key,customer_name,phone,secondary_phone,email,dot_number,address,city,state,postal_code,country,contact_name,notes,active,source_file) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,'ITTR manual') RETURNING *`,[key,name,b.phone||null,b.secondary_phone||null,b.email||null,b.dot_number||null,b.address||null,b.city||null,b.state||null,b.postal_code||null,b.country||null,b.contact_name||null,b.notes||null]);if(b.fmcsa_checked_at){await requireDb().query(`UPDATE fullbay_import_customers SET fmcsa_dba_name=$2,fmcsa_mc_number=$3,fmcsa_allowed_to_operate=$4,fmcsa_out_of_service=$5,fmcsa_power_units=$6,fmcsa_drivers=$7,fmcsa_snapshot=$8::jsonb,fmcsa_last_checked=$9 WHERE id=$1`,[r.rows[0].id,b.fmcsa_dba_name||null,b.fmcsa_mc_number||null,b.fmcsa_allowed_to_operate||null,b.fmcsa_out_of_service||null,nOrNull(b.fmcsa_power_units),nOrNull(b.fmcsa_drivers),JSON.stringify(b.fmcsa_snapshot||{}),b.fmcsa_checked_at]);const rr=await requireDb().query("SELECT * FROM fullbay_import_customers WHERE id=$1",[r.rows[0].id]);r.rows[0]=rr.rows[0]}await audit(req.user.username,"customer_created",{customerId:r.rows[0].id,name});res.json({item:customerPublic(r.rows[0])});
}catch(e){next(e)}});
app.put("/api/customers/:id",auth,adminOnly,async(req,res,next)=>{try{
 const b=req.body||{},name=String(b.customer_name||"").trim();if(!name)return res.status(400).json({error:"Customer / company name is required."});
 const r=await requireDb().query(`UPDATE fullbay_import_customers SET customer_name=$2,contact_name=$3,phone=$4,secondary_phone=$5,email=$6,dot_number=$7,address=$8,city=$9,state=$10,postal_code=$11,country=$12,billing_contact=$13,billing_address=$14,billing_city=$15,billing_state=$16,billing_postal_code=$17,credit_terms=$18,credit_limit=$19,payment_method=$20,notes=$21,active=$22,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,name,b.contact_name||null,b.phone||null,b.secondary_phone||null,b.email||null,b.dot_number||null,b.address||null,b.city||null,b.state||null,b.postal_code||null,b.country||null,b.billing_contact||null,b.billing_address||null,b.billing_city||null,b.billing_state||null,b.billing_postal_code||null,b.credit_terms||null,numOrNull(b.credit_limit),b.payment_method||null,b.notes||null,b.active!==false]);if(!r.rowCount)return res.status(404).json({error:"Customer not found."});if(b.fmcsa_checked_at){await requireDb().query(`UPDATE fullbay_import_customers SET fmcsa_dba_name=$2,fmcsa_mc_number=$3,fmcsa_allowed_to_operate=$4,fmcsa_out_of_service=$5,fmcsa_power_units=$6,fmcsa_drivers=$7,fmcsa_snapshot=$8::jsonb,fmcsa_last_checked=$9 WHERE id=$1`,[req.params.id,b.fmcsa_dba_name||null,b.fmcsa_mc_number||null,b.fmcsa_allowed_to_operate||null,b.fmcsa_out_of_service||null,nOrNull(b.fmcsa_power_units),nOrNull(b.fmcsa_drivers),JSON.stringify(b.fmcsa_snapshot||{}),b.fmcsa_checked_at]);const rr=await requireDb().query("SELECT * FROM fullbay_import_customers WHERE id=$1",[req.params.id]);r.rows[0]=rr.rows[0]}try{await requireDb().query("UPDATE customer_units SET customer_name=$2,updated_at=now() WHERE customer_id::text=$1::text",[req.params.id,name])}catch(e){console.error("Customer unit-name sync warning:",e?.message)};await audit(req.user.username,"customer_updated",{customerId:req.params.id,name});res.json({item:customerPublic(r.rows[0])});
}catch(e){next(e)}});
app.get("/api/customers/:id/profile",auth,adminOnly,async(req,res)=>{
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
  let fullbayHistory=[];try{const sr=await db.query(`SELECT service_order,invoice_number,unit_number,vin,max(action_completed_at) completed_at,max(unit_miles) unit_miles,max(lead_tech) lead_tech,max(tech) tech,sum(coalesce(hours,0)) hours,sum(coalesce(labor_amount,0)) labor_amount,sum(coalesce(part_amount,0)) part_amount,sum(coalesce(total_amount,0)) total_amount,json_agg(json_build_object('action',action_number,'complaint',complaint,'correction',actual_correction,'hours',hours,'component',component,'system',system) ORDER BY action_completed_at,action_number) actions FROM fullbay_service_history WHERE customer_id::text=$1::text OR (customer_id IS NULL AND lower(customer_name)=lower($2)) GROUP BY service_order,invoice_number,unit_number,vin ORDER BY max(action_completed_at) DESC NULLS LAST LIMIT 1000`,[customer.id,customer.customer_name]);fullbayHistory=sr.rows.map(x=>({source:"fullbay",id:x.service_order,invoice:x.invoice_number,unit:x.unit_number,vin:x.vin,completedAt:x.completed_at,status:"Completed (Fullbay)",mechanic:x.tech||x.lead_tech||"",mileage:x.unit_miles,hours:Number(x.hours||0),laborAmount:Number(x.labor_amount||0),partAmount:Number(x.part_amount||0),totalAmount:Number(x.total_amount||0),tasks:(Array.isArray(x.actions)?x.actions:[]).map(a=>({t:a.complaint||a.correction||`Action ${a.action||""}`,done:true,outcome:"Completed",outcomeNote:a.correction||"",hours:a.hours,component:a.component,system:a.system}))}))}catch(e){warnings.push(`Imported Fullbay history unavailable (${e.code||"DB"}).`);console.error("Customer profile Fullbay history warning:",e)}
  const history=[...ittrHistory,...fullbayHistory].sort((a,b)=>new Date(b.completedAt||b.date||0)-new Date(a.completedAt||a.date||0)).slice(0,1200);
  res.json({customer:customerPublic(customer),units,history,warnings});
 }catch(e){console.error("Customer profile fatal error:",e);res.status(500).json({error:`Customer profile database error${e?.code?` [${e.code}]`:""}.`,code:e?.code||"CUSTOMER_PROFILE"})}
});
app.post("/api/customers/:id/units",auth,adminOnly,async(req,res,next)=>{try{
 const db=requireDb(),c=await db.query("SELECT id,customer_name FROM fullbay_import_customers WHERE id::text=$1::text",[req.params.id]);if(!c.rowCount)return res.status(404).json({error:"Customer not found."});const b=req.body||{};if(!String(b.unit_number||"").trim())return res.status(400).json({error:"Unit number is required."});const item=await upsertDirectoryUnit(db,{customerId:c.rows[0].id,customerName:c.rows[0].customer_name,unit:b.unit_number,vin:b.vin,year:b.year,make:b.make,model:b.model,plate:b.plate,mileage:b.mileage,engine:b.engine,transmission:b.transmission,notes:b.notes,source:"manual"});await audit(req.user.username,"customer_unit_saved",{customerId:req.params.id,unit:item.unit_number});res.json({item});
}catch(e){next(e)}});
app.put("/api/customer-units/:id",auth,adminOnly,async(req,res,next)=>{try{
 const b=req.body||{},unit=String(b.unit_number||"").trim();if(!unit)return res.status(400).json({error:"Unit number is required."});const r=await requireDb().query(`UPDATE customer_units SET unit_number=$2,vin=$3,year=$4,make=$5,model=$6,plate=$7,mileage=$8,engine=$9,transmission=$10,notes=$11,source='manual',updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,unit,String(b.vin||"").trim().toUpperCase()||null,b.year||null,b.make||null,b.model||null,b.plate||null,Number.isFinite(Number(b.mileage))?Number(b.mileage):null,b.engine||null,b.transmission||null,b.notes||null]);if(!r.rowCount)return res.status(404).json({error:"Unit not found."});res.json({item:r.rows[0]});
}catch(e){next(e)}});
app.delete("/api/customer-units/:id",auth,adminOnly,async(req,res,next)=>{try{await requireDb().query("DELETE FROM customer_units WHERE id=$1",[req.params.id]);res.json({ok:true})}catch(e){next(e)}});
app.post("/api/customer-units/from-vehicle-profile",auth,adminOnly,async(req,res,next)=>{try{
 const b=req.body||{},unit=String(b.unit||b.unit_number||"").trim();if(!unit)return res.status(400).json({error:"Unit number is required."});
 const db=requireDb();let customerId=null,customerName=String(b.customer||b.customer_name||"").trim();
 if(customerName){const c=await db.query("SELECT id,customer_name FROM fullbay_import_customers WHERE lower(trim(customer_name))=lower(trim($1)) ORDER BY id LIMIT 1",[customerName]);if(c.rowCount){customerId=c.rows[0].id;customerName=c.rows[0].customer_name}}
 const item=await upsertDirectoryUnit(db,{customerId,customerName,unit,vin:b.vin,year:b.year,make:b.make,model:b.model,plate:b.plate,mileage:b.mileage,engine:b.engine,transmission:b.transmission,notes:b.notes,source:"vehicle_profile"});
 if(!item)return res.status(500).json({error:"Unit directory did not save the vehicle."});
 const verify=await db.query("SELECT * FROM customer_units WHERE id=$1",[item.id]);if(!verify.rowCount)return res.status(500).json({error:"Unit save could not be verified."});
 await audit(req.user.username,"vehicle_profile_unit_synced",{unit:item.unit_number,customerId:item.customer_id,customerName:item.customer_name});res.json({ok:true,item:verify.rows[0],matchedCustomer:Boolean(item.customer_id)});
}catch(e){next(e)}});

app.post("/api/customer-units/decode-missing-vins",auth,adminOnly,async(req,res,next)=>{try{
 const db=requireDb(),limit=Math.max(1,Math.min(100,Number(req.body?.limit||75)));
 const rows=(await db.query(`SELECT id,vin,year,make,model,engine,transmission FROM customer_units WHERE vin ~ '^[A-HJ-NPR-Z0-9]{17}$' AND (coalesce(year,'')='' OR coalesce(make,'')='' OR coalesce(model,'')='') ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT $1`,[limit])).rows;
 let updated=0,failed=0;const errors=[];
 for(const u of rows){try{const d=await lookupNhtsaVin(u.vin);await db.query(`UPDATE customer_units SET year=coalesce(nullif(year,''),$2),make=coalesce(nullif(make,''),$3),model=coalesce(nullif(model,''),$4),engine=coalesce(nullif(engine,''),$5),transmission=coalesce(nullif(transmission,''),$6),updated_at=now() WHERE id=$1`,[u.id,d.year||null,d.make||null,d.model||null,d.engine||null,d.transmission||null]);updated++}catch(e){failed++;if(errors.length<10)errors.push({vin:u.vin,error:String(e?.message||e)})}}
 await audit(req.user.username,"unit_vin_bulk_decode",{requested:rows.length,updated,failed});res.json({ok:true,checked:rows.length,updated,failed,errors});
}catch(e){next(e)}});

app.get("/api/customer-units/suggest",auth,async(req,res,next)=>{try{
 try{await syncCustomerUnitDirectory()}catch(e){console.error("Unit suggest sync warning:",e?.message)}const q=String(req.query.q||"").trim();if(q.length<1)return res.json({items:[]});const like=`%${q}%`,db=requireDb();
 const r=await db.query(`SELECT u.*,c.customer_name AS canonical_customer,c.phone AS customer_phone,c.email AS customer_email,c.dot_number FROM customer_units u LEFT JOIN fullbay_import_customers c ON c.id::text=u.customer_id::text WHERE u.unit_number ILIKE $1 OR coalesce(u.vin,'') ILIKE $1 OR coalesce(u.plate,'') ILIKE $1 OR coalesce(c.customer_name,u.customer_name,'') ILIKE $1 ORDER BY CASE WHEN lower(u.unit_number)=lower($2) THEN 0 WHEN lower(u.unit_number) LIKE lower($3) THEN 1 ELSE 2 END,u.unit_number LIMIT 20`,[like,q,`${q}%`]);res.json({items:r.rows.map(x=>({...x,customer_name:x.canonical_customer||x.customer_name}))});
}catch(e){next(e)}});


// v24.1 unified shop search: customer + vehicle + ITTR/Fullbay service history.
app.get("/api/smart-search",auth,adminOnly,async(req,res,next)=>{try{
 const q=String(req.query.q||"").trim();if(q.length<2)return res.json({customers:[],units:[],workorders:[]});
 const limit=Math.max(1,Math.min(50,Number(req.query.limit||20))),like=`%${q}%`,db=requireDb();
 const customers=(await db.query(`SELECT id,customer_name,contact_name,phone,email,dot_number,address,city,state,postal_code,active FROM fullbay_import_customers WHERE customer_name ILIKE $1 OR coalesce(contact_name,'') ILIKE $1 OR coalesce(phone,'') ILIKE $1 OR coalesce(email,'') ILIKE $1 OR coalesce(dot_number,'') ILIKE $1 OR coalesce(address,'') ILIKE $1 OR coalesce(city,'') ILIKE $1 ORDER BY active DESC NULLS LAST,customer_name LIMIT $2`,[like,limit])).rows;
 const units=(await db.query(`SELECT u.id,u.customer_id::text AS customer_id,coalesce(c.customer_name,u.customer_name) AS customer_name,u.unit_number,u.vin,u.year,u.make,u.model,u.plate,u.mileage,u.engine,u.transmission,u.notes FROM customer_units u LEFT JOIN fullbay_import_customers c ON c.id::text=u.customer_id::text WHERE u.unit_number ILIKE $1 OR coalesce(u.vin,'') ILIKE $1 OR coalesce(u.plate,'') ILIKE $1 OR coalesce(u.make,'') ILIKE $1 OR coalesce(u.model,'') ILIKE $1 OR coalesce(u.engine,'') ILIKE $1 OR coalesce(u.notes,'') ILIKE $1 OR coalesce(c.customer_name,u.customer_name,'') ILIKE $1 ORDER BY u.unit_number LIMIT $2`,[like,limit])).rows;
 let workorders=[];try{const core=await getCoreState(),needle=q.toLowerCase();workorders=(Array.isArray(core.shopflow?.workorders)?core.shopflow.workorders:[]).filter(w=>{if(!w||typeof w!=="object")return false;const tasks=(Array.isArray(w.tasks)?w.tasks:[]).map(t=>[t?.t,t?.outcomeNote,t?.completionNote].filter(Boolean).join(" ")).join(" "),hay=[w.id,w.unit,w.customer,w.status,w.notes,w.completionNotes,w.futureNotes,w.parking,tasks].filter(v=>v!=null).join(" ").toLowerCase();return hay.includes(needle)}).sort((a,b)=>Number(b.id||0)-Number(a.id||0)).slice(0,limit).map(w=>({source:"ittr",id:w.id,unit:w.unit,customer:w.customer,status:w.status,date:w.date,time:w.time,completedAt:w.completedAt,summary:(w.tasks||[]).map(t=>t?.t).filter(Boolean).slice(0,3).join(", ")||w.notes||w.completionNotes||w.futureNotes||""}))}catch(e){console.error("Smart search work-order warning:",e?.message)}
 try{const sr=await db.query(`SELECT customer_id::text AS customer_id,customer_name,service_order,invoice_number,unit_number,max(action_completed_at) completed_at,string_agg(DISTINCT coalesce(complaint,''),' | ') FILTER (WHERE coalesce(complaint,'')<>'') complaints,string_agg(DISTINCT coalesce(actual_correction,''),' | ') FILTER (WHERE coalesce(actual_correction,'')<>'') corrections FROM fullbay_service_history WHERE customer_name ILIKE $1 OR coalesce(unit_number,'') ILIKE $1 OR coalesce(vin,'') ILIKE $1 OR coalesce(service_order,'') ILIKE $1 OR coalesce(invoice_number,'') ILIKE $1 OR coalesce(complaint,'') ILIKE $1 OR coalesce(actual_correction,'') ILIKE $1 OR coalesce(component,'') ILIKE $1 OR coalesce(system,'') ILIKE $1 GROUP BY customer_id,customer_name,service_order,invoice_number,unit_number ORDER BY max(action_completed_at) DESC NULLS LAST LIMIT $2`,[like,limit]);for(const x of sr.rows)workorders.push({source:"fullbay",id:x.service_order,invoice:x.invoice_number,unit:x.unit_number,customer:x.customer_name,customer_id:x.customer_id,status:"Fullbay History",completedAt:x.completed_at,summary:[x.complaints,x.corrections].filter(Boolean).join(" — ").slice(0,400)})}catch(e){console.error("Smart search Fullbay history warning:",e?.message)}
 workorders.sort((a,b)=>new Date(b.completedAt||b.date||0)-new Date(a.completedAt||a.date||0));res.json({customers,units,workorders:workorders.slice(0,limit),q});
}catch(e){next(e)}});

app.get("/api/admin/customer-crm-diagnostics",auth,adminOnly,async(req,res)=>{
 const out={ok:false,version:"24.1.0",tables:{},columns:{},counts:{},sync:null,error:""};
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
app.get("/api/build",(req,res)=>res.json({frontendExpected:"24.1.0",backend:"24.1.0",build:"ITTR-24.1.0-SMART-UNIFIED-UX-20260911"}));
app.get("/api/health",async(req,res)=>{let db=false;try{if(pool){await pool.query("SELECT 1");db=true}}catch{}res.json({ok:true,db,aiConfigured:Boolean(openRouterClient||client),aiProvider:openRouterClient?"openrouter":client?"openai":"none",version:"24.1.0",photoStorageConfigured:r2Configured})});

app.post("/api/auth/login",async(req,res,next)=>{try{
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
  if(!partNumber&&!description)return res.status(400).json({error:"Enter a part number or description."});
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
  const part={id:`part_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,partNumber,description,qty,addedBy:req.user.username,addedAt:new Date().toISOString()};
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

app.post("/api/admin/users",auth,adminOnly,async(req,res,next)=>{try{
 const username=cleanUsername(req.body?.username),display=String(req.body?.display||"").trim(),password=String(req.body?.password||"");
 if(!username||!display||password.length<6)return res.status(400).json({error:"Username, display name, and password of at least 6 characters are required."});
 const h=await bcrypt.hash(password,12);
 await pool.query("INSERT INTO auth_users(username,display_name,password_hash,role) VALUES($1,$2,$3,'mechanic')",[username,display,h]);
 await audit(req.user.username,"mechanic_created",{username});res.json({user:{username,display,role:"mechanic"}});
}catch(e){if(e?.code==="23505")return res.status(409).json({error:"That username already exists."});next(e)}});
app.patch("/api/admin/users/:username/password",auth,adminOnly,async(req,res,next)=>{try{const username=cleanUsername(req.params.username),password=String(req.body?.password||"");if(password.length<6)return res.status(400).json({error:"Password must be at least 6 characters."});const h=await bcrypt.hash(password,12);const q=await pool.query("UPDATE auth_users SET password_hash=$2,updated_at=now() WHERE username=$1 AND role='mechanic' RETURNING username",[username,h]);if(!q.rowCount)return res.status(404).json({error:"Mechanic account not found."});await audit(req.user.username,"mechanic_password_changed",{username});res.json({ok:true})}catch(e){next(e)}});
app.delete("/api/admin/users/:username",auth,adminOnly,async(req,res,next)=>{try{const username=cleanUsername(req.params.username);const q=await pool.query("DELETE FROM auth_users WHERE username=$1 AND role='mechanic' RETURNING username",[username]);if(!q.rowCount)return res.status(404).json({error:"Mechanic account not found."});await audit(req.user.username,"mechanic_deleted",{username});res.json({ok:true})}catch(e){next(e)}});

const memoryCache=new Map();
function aiErrorResponse(res,err,fallback){
 console.error("AI ERROR:",err?.status,err?.code,err?.message);
 if(err?.code==="AI_NOT_CONFIGURED")return res.status(503).json({error:err.message,code:"AI_NOT_CONFIGURED"});
 if(err?.status===401||err?.code==="invalid_api_key")return res.status(401).json({error:"AI provider rejected the API key. Check the server-side API key in Railway.",code:"INVALID_API_KEY"});
 if(err?.status===429)return res.status(429).json({error:"AI provider rate limit reached. Free AI capacity may be temporarily busy; try again shortly.",code:"RATE_LIMIT"});
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
 const e=new Error("No AI provider is configured. Add OPENROUTER_API_KEY (recommended free option) or OPENAI_API_KEY in Railway.");e.code="AI_NOT_CONFIGURED";throw e;
}
function selectedAIProvider(){if(aiProvider==="openrouter")return openRouterClient?"openrouter":"none";if(aiProvider==="openai")return client?"openai":"none";return openRouterClient?"openrouter":client?"openai":"none"}
app.get("/api/ai/status",auth,(req,res)=>res.json({server:true,aiConfigured:Boolean(openRouterClient||client),provider:selectedAIProvider(),openRouterConfigured:Boolean(openRouterClient),openAIConfigured:Boolean(client),model:selectedAIProvider()==="openrouter"?openRouterModel:String(process.env.OPENAI_TEXT_MODEL||"gpt-5.6-luna"),message:openRouterClient?`Free AI ready via OpenRouter (${openRouterModel}).`:client?"AI ready via OpenAI.":"No AI key is configured."}));
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
app.post("/api/ai/note",auth,async(req,res)=>{try{const text=String(req.body?.text||"").trim(),mode=String(req.body?.mode||"professional").toLowerCase();if(!text)return res.status(400).json({error:"text required"});if(text.length>8000)return res.status(400).json({error:"text is too long"});const instruction=NOTE_MODES[mode]||NOTE_MODES.professional;res.json({result:await textAI(`You are the writing assistant for a US heavy-duty truck and trailer repair shop. ${instruction} Preserve every technical fact exactly. Preserve VINs, unit numbers, part numbers, fault codes, cylinder numbers, measurements, quantities and component names. Never invent work performed, parts replaced, measurements, causes, diagnosis, customer authorization, or test results. If the source says a cause is possible or suspected, keep that uncertainty. Return only the rewritten text.`,text)})}catch(e){return aiErrorResponse(res,e,"AI note failed")}});
app.post("/api/ai/diagnostic",auth,async(req,res)=>{try{const text=String(req.body?.text||"").trim();if(!text)return res.status(400).json({error:"text required"});res.json({result:await textAI("You are a diagnostic assistant for professional heavy-duty diesel technicians. Provide a prioritized diagnostic plan, likely systems/causes, tests and measurements to verify. Clearly distinguish possibilities from confirmed facts. Do not claim a diagnosis without evidence. Include safety cautions when a test requires vehicle lifting, rotating components, fuel pressure, high voltage, air pressure, or hot systems.",text)})}catch(e){return aiErrorResponse(res,e,"AI diagnostic failed")}});
app.post("/api/ai/part",auth,async(req,res)=>{try{const vin=String(req.body?.vin||"").trim(),query=String(req.body?.query||"").trim();if(!query)return res.status(400).json({error:"query required"});res.json({result:await textAI("You assist a professional heavy-duty truck parts counter. Analyze the supplied part number/description and VIN context. List likely OEM numbers, supersessions, cross-reference candidates, manufacturer/application clues, and practical verification steps. Never present an uncertain cross-reference or fitment as confirmed. Clearly label each candidate as VERIFIED FROM PROVIDED FACTS, LIKELY / NEEDS CATALOG VERIFICATION, or INSUFFICIENT INFORMATION. Do not invent a part number just to provide an answer. End with a short 'Verify before ordering' checklist.",`VIN: ${vin||"not supplied"}\nPart/query: ${query}`)})}catch(e){return aiErrorResponse(res,e,"AI part assistant failed")}});
app.post("/api/ai/productivity-summary",auth,adminOnly,async(req,res)=>{try{const period=String(req.body?.period||"").slice(0,120),sessions=Array.isArray(req.body?.sessions)?req.body.sessions.slice(0,1000):[];res.json({result:await textAI("You are an operations analyst for a heavy-duty truck repair shop. Summarize the supplied factual mechanic task-session history for management. Focus on recorded repair labor, workload distribution, units/tasks worked, completed sessions, unusually long or fragmented jobs, and useful follow-up questions. Do not rank mechanics as good/bad and do not infer productivity percentage, attendance, idle time, or performance from missing data. Clearly state that the report is based only on recorded task sessions.",`Period: ${period}\nRecorded task sessions JSON:\n${JSON.stringify(sessions)}`)})}catch(e){return aiErrorResponse(res,e,"AI productivity summary failed")}});
app.post("/api/vin",auth,async(req,res)=>{try{const item=await lookupNhtsaVin(req.body?.vin);res.json({result:item,item,source:"NHTSA vPIC",official:true,decodedAt:new Date().toISOString()})}catch(e){res.status(e.status||500).json({error:e.message||"VIN decode failed.",code:e.code||"VIN_LOOKUP",details:e.details||undefined})}});
app.post("/api/transcribe",auth,upload.single("audio"),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:"audio required"});const file=new File([req.file.buffer],req.file.originalname||"note.webm",{type:req.file.mimetype||"audio/webm"});const t=await requireAIClient().audio.transcriptions.create({file,model:process.env.OPENAI_TRANSCRIBE_MODEL||"gpt-4o-transcribe"});res.json({text:t.text||""})}catch(e){return aiErrorResponse(res,e,"transcription failed")}});

app.get("/api/admin/server-audit",auth,adminOnly,async(req,res,next)=>{try{const q=await requireDb().query("SELECT username,action,details,created_at FROM server_audit ORDER BY id DESC LIMIT 500");res.json({rows:q.rows})}catch(e){next(e)}});
app.use("/api",(req,res)=>res.status(404).json({error:"API endpoint not found"}));
app.use((err,req,res,next)=>{
 console.error(err);
 if(err?.code==="DB_NOT_CONFIGURED"||err?.code==="R2_NOT_CONFIGURED")return res.status(503).json({error:err.message,code:err.code});
 if(err?.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Photo is too large. Maximum original file size is 25 MB."});
 if(err?.code==="PHOTO_TYPE"||err?.code==="PHOTO_PROCESSING")return res.status(415).json({error:err.message,code:err.code});
 res.status(500).json({error:isProd?"Server error":String(err?.message||err)});
});
app.get("*splat",(req,res)=>{
 res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
 res.setHeader("Pragma","no-cache");
 res.setHeader("Expires","0");
 res.sendFile(authoritativeIndex);
});

initDb()
  .then(()=>migrateLegacyFindingPhotosAtStartup())
  .then(()=>repairTaskUidsAtStartup())
  .then(()=>normalizeCollaborationAtStartup())
  .then(()=>repairApprovedFindingsAtStartup())
  .then(()=>app.listen(port,()=>console.log(`ITTR v24.1.0 Online running on port ${port}`)))
  .catch(e=>{console.error("ITTR database startup failed:",e);process.exit(1)});
