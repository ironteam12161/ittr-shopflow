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
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,HeadBucketCommand} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import { fileURLToPath } from "url";

dotenv.config();
const {Pool}=pg;
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

app.get("/api/build",(req,res)=>res.json({frontendExpected:"23.2.0",backend:"23.2.0",build:"ITTR-23.2-MOBILE-COLLAB-20260910"}));
app.get("/api/health",async(req,res)=>{let db=false;try{if(pool){await pool.query("SELECT 1");db=true}}catch{}res.json({ok:true,db,aiConfigured:Boolean(client),version:"23.2.0",photoStorageConfigured:r2Configured})});

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
function aiErrorResponse(res,err,fallback){console.error("AI ERROR:",err?.status,err?.code,err?.message);if(err?.code==="AI_NOT_CONFIGURED")return res.status(503).json({error:err.message,code:"AI_NOT_CONFIGURED"});if(err?.status===401||err?.code==="invalid_api_key")return res.status(401).json({error:"OpenAI rejected the API key. Check OPENAI_API_KEY in the hosting environment.",code:"INVALID_API_KEY"});if(err?.status===429)return res.status(429).json({error:"OpenAI API rate limit or billing limit reached. Check API billing/usage and try again.",code:"RATE_LIMIT"});if(err?.status===403)return res.status(403).json({error:"This OpenAI API key does not have permission for this request/model.",code:"PERMISSION"});return res.status(500).json({error:String(err?.message||fallback||"AI request failed").slice(0,500),code:err?.code||"AI_ERROR"})}
function requireAIClient(){if(!client){const e=new Error("OpenAI API key is not configured on the server.");e.code="AI_NOT_CONFIGURED";throw e}return client}
function cacheKey(text,targetLanguage){return `${targetLanguage}|${text}`}
async function textAI(system,user){const response=await requireAIClient().responses.create({model:process.env.OPENAI_TEXT_MODEL||"gpt-5.6-luna",input:[{role:"system",content:[{type:"input_text",text:system}]},{role:"user",content:[{type:"input_text",text:user}]}]});return String(response.output_text||"").trim()}
app.get("/api/ai/status",auth,(req,res)=>res.json({server:true,aiConfigured:Boolean(client),message:client?"AI server is configured.":"OPENAI_API_KEY is not configured."}));
app.post("/api/translate",auth,async(req,res)=>{try{const {text,sourceLanguage="English",targetLanguage="Ukrainian",domain="semi-truck and trailer repair shop software"}=req.body||{};if(typeof text!=="string"||!text.trim())return res.status(400).json({error:"text is required"});if(text.length>5000)return res.status(400).json({error:"text is too long"});const key=cacheKey(text,targetLanguage);if(memoryCache.has(key))return res.json({translation:memoryCache.get(key),cached:true});const translation=await textAI(`You are the professional translator for a US semi-truck and trailer repair shop management application. Translate ${sourceLanguage} into ${targetLanguage}. Preserve truck/unit numbers, part numbers, VINs, usernames, company names, abbreviations, measurements, timestamps, and proper nouns. Use natural terminology used by diesel mechanics. Return only the translated text.`,`Domain: ${domain}\n\nText:\n${text}`);memoryCache.set(key,translation);res.json({translation,cached:false})}catch(e){return aiErrorResponse(res,e,"translation_failed")}});
app.post("/api/ai/note",auth,async(req,res)=>{try{const text=String(req.body?.text||"").trim();if(!text)return res.status(400).json({error:"text required"});res.json({result:await textAI("Rewrite semi-truck repair mechanic notes into concise professional service-invoice language. Preserve every technical fact. Do not invent diagnosis, parts, measurements, or work performed. Return only the polished note.",text)})}catch(e){return aiErrorResponse(res,e,"AI note failed")}});
app.post("/api/ai/diagnostic",auth,async(req,res)=>{try{const text=String(req.body?.text||"").trim();if(!text)return res.status(400).json({error:"text required"});res.json({result:await textAI("You are a diagnostic assistant for professional heavy-duty diesel technicians. Provide a prioritized diagnostic plan, likely systems/causes, tests and measurements to verify. Clearly distinguish possibilities from confirmed facts. Do not claim a diagnosis without evidence.",text)})}catch(e){return aiErrorResponse(res,e,"AI diagnostic failed")}});
app.post("/api/ai/part",auth,async(req,res)=>{try{const vin=String(req.body?.vin||"").trim(),query=String(req.body?.query||"").trim();if(!query)return res.status(400).json({error:"query required"});res.json({result:await textAI("You assist a heavy-duty truck parts professional. Give likely OEM/cross-reference candidates only when supported; flag everything that must be verified in an OEM/vendor catalog. Never invent fitment certainty.",`VIN: ${vin||"not supplied"}\nPart/query: ${query}`)})}catch(e){return aiErrorResponse(res,e,"AI part assistant failed")}});
app.post("/api/vin",auth,async(req,res)=>{try{const vin=String(req.body?.vin||"").trim();if(vin.length!==17)return res.status(400).json({error:"17-character VIN required"});res.json({result:await textAI("Given a 17-character heavy-duty vehicle VIN, return ONLY a JSON object with keys year, make, model, engine, transmission. Use empty strings for anything not reliably determined. Do not guess.",vin)})}catch(e){return aiErrorResponse(res,e,"VIN decode failed")}});
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
  .then(()=>app.listen(port,()=>console.log(`ITTR v23.2 Online running on port ${port}`)))
  .catch(e=>{console.error("ITTR database startup failed:",e);process.exit(1)});
