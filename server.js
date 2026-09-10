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
import { fileURLToPath } from "url";

dotenv.config();
const {Pool}=pg;
const app=express();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});
const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const port=Number(process.env.PORT||3000);
const isProd=process.env.NODE_ENV==="production";

const configuredApiKey=String(process.env.OPENAI_API_KEY||"").trim();
const apiKeyLooksConfigured=Boolean(configuredApiKey && configuredApiKey!=="your_server_side_key" && !configuredApiKey.toLowerCase().includes("replace") && !configuredApiKey.toLowerCase().includes("your_"));
const client=apiKeyLooksConfigured?new OpenAI({apiKey:configuredApiKey}):null;
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:isProd?{rejectUnauthorized:false}:undefined}):null;

app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:"3mb"}));

// Railway/GitHub-safe static path:
// Prefer /public when the repository preserves folders.
// Fall back to the repository root if GitHub web upload flattened public files.
const publicDir = path.join(__dirname,"public");
const fs = await import("fs");
const hasPublicIndex = fs.existsSync(path.join(publicDir,"index.html"));
const hasRootIndex = fs.existsSync(path.join(__dirname,"index.html"));
const webRoot = hasPublicIndex ? publicDir : (hasRootIndex ? __dirname : publicDir);
console.log("ITTR web root:", webRoot);
app.use(express.static(webRoot));

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
 );`);
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

app.get("/api/health",async(req,res)=>{let db=false;try{if(pool){await pool.query("SELECT 1");db=true}}catch{}res.json({ok:true,db,aiConfigured:Boolean(client),version:"21.1.0-railway-path-fix"})});

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
 const key=String(req.params.key);if(!["users","shopflow","pro"].includes(key))return res.status(400).json({error:"Invalid state key"});
 const payload=req.body?.payload;if(payload===undefined)return res.status(400).json({error:"payload required"});
 // Snapshot sync is serialized in PostgreSQL. v21 beta keeps the legacy UI while making data shared.
 const q=await requireDb().query("UPDATE app_state SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE state_key=$1 RETURNING version,updated_at",[key,JSON.stringify(payload),req.user.username]);
 await audit(req.user.username,"state_save",{key});res.json({ok:true,version:Number(q.rows[0].version),updatedAt:q.rows[0].updated_at});
}catch(e){next(e)}});

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
app.use((err,req,res,next)=>{console.error(err);if(err?.code==="DB_NOT_CONFIGURED")return res.status(503).json({error:err.message,code:err.code});res.status(500).json({error:isProd?"Server error":String(err?.message||err)})});
app.get("*splat",(req,res)=>res.sendFile(path.join(webRoot,"index.html")));

initDb().then(()=>app.listen(port,()=>console.log(`ITTR v21.1 Online running on port ${port}`))).catch(e=>{console.error("ITTR database startup failed:",e);process.exit(1)});
