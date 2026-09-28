import fs from 'node:fs';

const VERSION='24.28.0';
const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');

function replaceOnce(label,oldText,newText,already=''){
  if(already && s.includes(already))return;
  const i=s.indexOf(oldText);
  if(i<0)throw new Error(`${label} target not found`);
  s=s.slice(0,i)+newText+s.slice(i+oldText.length);
}

// 1) Browser hardening. Keep the legacy inline UI working while enforcing the
// strongest CSP that is currently compatible with the application.
const oldHelmet=`app.use(helmet({\n contentSecurityPolicy:false, // Inline legacy UI handlers still require a CSP migration before strict enforcement.\n crossOriginEmbedderPolicy:false\n}));`;
const newHelmet=`app.use(helmet({\n contentSecurityPolicy:{directives:{\n  defaultSrc:["'self'"],\n  baseUri:["'self'"],\n  objectSrc:["'none'"],\n  frameAncestors:["'none'"],\n  formAction:["'self'"],\n  scriptSrc:["'self'","'unsafe-inline'","blob:"],\n  styleSrc:["'self'","'unsafe-inline'"],\n  imgSrc:["'self'","data:","blob:","https:"],\n  fontSrc:["'self'","data:"],\n  connectSrc:["'self'","https:","wss:"],\n  workerSrc:["'self'","blob:"],\n  mediaSrc:["'self'","blob:","https:"]\n }},\n crossOriginEmbedderPolicy:false\n}));\napp.use((req,res,next)=>{\n res.setHeader("Permissions-Policy","camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()");\n res.setHeader("X-Permitted-Cross-Domain-Policies","none");\n next();\n});`;
if(s.includes(oldHelmet))s=s.replace(oldHelmet,newHelmet);
else if(!s.includes('Permissions-Policy'))throw new Error('helmet security header target not found');

// 2) Cost/abuse and memory-pressure limits for AI and upload-heavy routes.
const authLimiterAnchor='app.use("/api/auth",authLimiter);';
if(!s.includes('const aiLimiter=rateLimit')){
 const extra=`${authLimiterAnchor}\nconst aiLimiter=rateLimit({windowMs:60*1000,max:24,standardHeaders:true,legacyHeaders:false,message:{error:"Too many AI requests. Please wait a moment and try again."}});\nconst uploadLimiter=rateLimit({windowMs:60*1000,max:20,standardHeaders:true,legacyHeaders:false,message:{error:"Too many uploads. Please wait a moment and try again."}});\napp.use("/api/ai",aiLimiter);\napp.use("/api/translate",aiLimiter);\napp.use("/api/transcribe",aiLimiter);\napp.use("/api/ai/import",uploadLimiter);\napp.use("/api/manuals",uploadLimiter);\napp.use("/api/findings",uploadLimiter);`;
 if(!s.includes(authLimiterAnchor))throw new Error('auth limiter anchor not found');
 s=s.replace(authLimiterAnchor,extra);
}

// 3) Least-privilege shared-state reads. Mechanics receive only their assigned
// ShopFlow work orders/findings, not the legacy users/pro administrative blobs.
if(!s.includes('ITTR v24.28.0 role-scoped state reader')){
 const startNeedle='app.get("/api/state",auth,async(req,res,next)=>{try{';
 const start=s.indexOf(startNeedle);
 if(start<0)throw new Error('state reader route not found');
 const endToken='}catch(e){next(e)}});';
 const endAt=s.indexOf(endToken,start);
 if(endAt<0)throw new Error('state reader route end not found');
 const end=endAt+endToken.length;
 const route=`// ITTR v24.28.0 role-scoped state reader\napp.get("/api/state",auth,async(req,res,next)=>{try{\n const db=requireDb();\n if(req.user?.role==='mechanic'){\n  const q=await db.query("SELECT state_key,payload,version,updated_at FROM app_state WHERE state_key='shopflow'");\n  const r=q.rows[0];if(!r)return res.json({});\n  const sf=(r.payload&&typeof r.payload==='object')?r.payload:{workorders:[],issues:[]};\n  const workorders=(Array.isArray(sf.workorders)?sf.workorders:[]).filter(w=>mechanicOwnsWorkOrder(req.user,w));\n  const ids=new Set(workorders.map(w=>String(w?.id||'')));\n  const issues=(Array.isArray(sf.issues)?sf.issues:[]).filter(i=>ids.has(String(i?.wo||'')));\n  return res.json({shopflow:{payload:{...sf,workorders,issues},version:Number(r.version),updatedAt:r.updated_at}});\n }\n const q=await db.query("SELECT state_key,payload,version,updated_at FROM app_state ORDER BY state_key");const d={};for(const r of q.rows)d[r.state_key]={payload:r.payload,version:Number(r.version),updatedAt:r.updated_at};res.json(d);\n}catch(e){next(e)}});`;
 s=s.slice(0,start)+route+s.slice(end);
}

// 4) Customer financial/customer-directory access is management-only.
s=s.replace('app.get("/api/fullbay/customers",auth,async(req,res,next)=>{try{','app.get("/api/fullbay/customers",auth,managerPermission("customers"),async(req,res,next)=>{try{');
s=s.replace('app.get("/api/fullbay/customers/:id",auth,async(req,res,next)=>{try{','app.get("/api/fullbay/customers/:id",auth,managerPermission("customers"),async(req,res,next)=>{try{');

// 5) Full backups are Owner/Admin-only. They include shared state and labor history.
s=s.replace('app.get("/api/admin/backup",auth,adminOnly,async(req,res,next)=>{try{','app.get("/api/admin/backup",auth,ownerOnly,async(req,res,next)=>{try{');

// 6) Inventory/vendor mutations require the inventory permission. Mechanics use
// work-order part flows rather than a free-form stock-increasing transaction.
s=s.replace("app.post('/api/parts/vendors/resolve',auth,async(req,res,next)=>{try{","app.post('/api/parts/vendors/resolve',auth,managerPermission(\"inventory\"),async(req,res,next)=>{try{");
s=s.replace('app.post("/api/parts/:id/transaction",auth,async(req,res,next)=>{','app.post("/api/parts/:id/transaction",auth,managerPermission("inventory"),async(req,res,next)=>{');
s=s.replace('if(req.user.role!=="admin"&&!(["return"].includes(type)))return res.status(403).json({error:"Admin access required."});','');

// 7) Stronger staff password policy and revoke active sessions on password reset.
s=s.replace("password.length<8)return res.status(400).json({error:'Username, name and password of at least 8 characters are required.'});","password.length<12)return res.status(400).json({error:'Username, name and password of at least 12 characters are required.'});");
s=s.replace('if(!username||!display||password.length<6)return res.status(400).json({error:"Username, display name, and password of at least 6 characters are required."});','if(!username||!display||password.length<10)return res.status(400).json({error:"Username, display name, and password of at least 10 characters are required."});');
const oldReset='if(password.length<6)return res.status(400).json({error:"Password must be at least 6 characters."});const h=await bcrypt.hash(password,12);const q=await pool.query("UPDATE auth_users SET password_hash=$2,updated_at=now() WHERE username=$1 AND role=\'mechanic\' RETURNING username",[username,h]);if(!q.rowCount)return res.status(404).json({error:"Mechanic account not found."});await audit(req.user.username,"mechanic_password_changed",{username});';
const newReset='if(password.length<10)return res.status(400).json({error:"Password must be at least 10 characters."});const h=await bcrypt.hash(password,12);const q=await pool.query("UPDATE auth_users SET password_hash=$2,updated_at=now() WHERE username=$1 AND role=\'mechanic\' RETURNING id,username",[username,h]);if(!q.rowCount)return res.status(404).json({error:"Mechanic account not found."});await pool.query("DELETE FROM auth_sessions WHERE user_id=$1",[q.rows[0].id]);await audit(req.user.username,"mechanic_password_changed",{username,sessionsRevoked:true});';
if(s.includes(oldReset))s=s.replace(oldReset,newReset);
else if(!s.includes('sessionsRevoked:true'))throw new Error('mechanic password reset hardening target not found');
s=s.replace('if(u?.password && String(u.password).length>=6){','if(u?.password && String(u.password).length>=12){');

// 8) Current release identity.
s=s.replaceAll('24.27.2',VERSION);
fs.writeFileSync(serverPath,s,'utf8');

// 9) Mechanics must not overwrite local admin/user/pro state when those keys are
// intentionally omitted from their role-scoped /api/state response.
for(const fp of ['index.html','public/index.html']){
 if(!fs.existsSync(fp))continue;
 let h=fs.readFileSync(fp,'utf8').replaceAll('24.27.2',VERSION);
 h=h.replace('USERS=fresh.users?.payload||{};\n state=fresh.shopflow?.payload||{workorders:[],issues:[]};\n PRO=fresh.pro?.payload||{};\n cloudVersions={users:Number(fresh.users?.version||0),shopflow:Number(fresh.shopflow?.version||0),pro:Number(fresh.pro?.version||0)};',
`USERS=fresh.users?.payload??(session?.role==='mechanic'?{}:USERS);\n state=fresh.shopflow?.payload||{workorders:[],issues:[]};\n PRO=fresh.pro?.payload??(session?.role==='mechanic'?{}:PRO);\n cloudVersions={users:Number(fresh.users?.version||0),shopflow:Number(fresh.shopflow?.version||0),pro:Number(fresh.pro?.version||0)};`);
 h=h.replace('function saveUsers(){localStorage.setItem("ittr_users_v1",JSON.stringify(USERS));queueCloudState("users",USERS)}','function saveUsers(){localStorage.setItem("ittr_users_v1",JSON.stringify(USERS));if(session?.role!=="mechanic")queueCloudState("users",USERS)}');
 h=h.replace('function savePro(){localStorage.setItem(PRO_KEY,JSON.stringify(PRO));queueCloudState("pro",PRO)}','function savePro(){localStorage.setItem(PRO_KEY,JSON.stringify(PRO));if(session?.role!=="mechanic")queueCloudState("pro",PRO)}');
 fs.writeFileSync(fp,h,'utf8');
}
for(const fp of ['sw.js','public/sw.js'])if(fs.existsSync(fp)){let x=fs.readFileSync(fp,'utf8').replaceAll('24.27.2',VERSION);fs.writeFileSync(fp,x,'utf8')}

console.log(`ITTR v${VERSION} security phase 2 hardening applied`);
