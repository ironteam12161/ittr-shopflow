import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

if(process.env.ITTR_LANGUAGE_TEST_DB!=='1'){
 console.log('SKIP language DB integration test: ITTR_LANGUAGE_TEST_DB is not enabled');
 process.exit(0);
}
const url=String(process.env.DATABASE_URL||'');
if(!url)throw new Error('DATABASE_URL is required for language DB integration test');
const {Pool}=pg;
const db=new Pool({connectionString:url,ssl:false});
const adminUser='ciadmin',adminPass='CI-Language-Admin-2026!',mechanicUser='langtest',mechanicPass='CI-Mechanic-2026!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let child=null,output='',port=0;

async function getFreePort(){
 return await new Promise((resolve,reject)=>{
  const server=net.createServer();
  server.unref();
  server.once('error',reject);
  server.listen({host:'127.0.0.1',port:0,exclusive:true},()=>{
   const address=server.address();
   const selected=typeof address==='object'&&address?Number(address.port):0;
   server.close(err=>err?reject(err):resolve(selected));
  });
 });
}
async function request(path,{method='GET',token,body}={}){
 const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
 if(!r.ok)throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(data)}`);
 return data;
}
async function waitHealth(){
 for(let i=0;i<100;i++){
  if(child?.exitCode!=null)throw new Error(`server exited early (${child.exitCode})\n${output}`);
  try{const d=await request('/api/health');if(d?.ok&&d?.db)return d}catch{}
  await sleep(100);
 }
 throw new Error(`server did not become DB-ready\n${output}`);
}

try{
 // Reproduce a pre-language production schema: auth_users exists but has no language column.
 await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
 await db.query(`CREATE TABLE auth_users(
   id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
   password_hash TEXT NOT NULL, role TEXT NOT NULL, permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
   email TEXT, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 )`);
 port=await getFreePort();
 if(!port)throw new Error('Could not allocate a free port for language DB integration test');
 const env={...process.env,PORT:String(port),NODE_ENV:'test',BOOTSTRAP_ADMIN_USERNAME:adminUser,BOOTSTRAP_ADMIN_PASSWORD:adminPass,OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',SAMSARA_API_TOKEN:''};
 child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>{output+=d.toString();if(output.length>30000)output=output.slice(-30000)});
 child.stderr.on('data',d=>{output+=d.toString();if(output.length>30000)output=output.slice(-30000)});
 await waitHealth();

 const col=await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='auth_users' AND column_name='language'");
 if(!col.rowCount)throw new Error('language migration did not add auth_users.language');
 console.log('PASS language DB: legacy auth_users schema migrated');

 const admin=await request('/api/auth/login',{method:'POST',body:{username:adminUser,password:adminPass}});
 if(admin.user?.language!=='en')throw new Error(`bootstrap admin language expected en, got ${admin.user?.language}`);
 await request('/api/admin/users',{method:'POST',token:admin.token,body:{username:mechanicUser,display:'Language Test Mechanic',password:mechanicPass}});
 const first=await request('/api/auth/login',{method:'POST',body:{username:mechanicUser,password:mechanicPass}});
 if(first.user?.language!=='en')throw new Error(`new mechanic language expected en, got ${first.user?.language}`);
 console.log('PASS language DB: mechanic login returns default EN');

 const saved=await request('/api/auth/preferences',{method:'PATCH',token:first.token,body:{language:'uk'}});
 if(saved.user?.language!=='uk')throw new Error(`saved language expected uk, got ${saved.user?.language}`);
 const me=await request('/api/auth/me',{token:first.token});
 if(me.user?.language!=='uk')throw new Error(`same-session /me expected uk, got ${me.user?.language}`);
 const second=await request('/api/auth/login',{method:'POST',body:{username:mechanicUser,password:mechanicPass}});
 if(second.user?.language!=='uk')throw new Error(`new-session persistence expected uk, got ${second.user?.language}`);
 console.log('PASS language DB: UA preference persists across sessions');

 const reset=await request('/api/auth/preferences',{method:'PATCH',token:second.token,body:{language:'en'}});
 if(reset.user?.language!=='en')throw new Error('switch back to EN failed');
 console.log('PASS language DB: EN/UA round-trip works');
}finally{
 if(child&&child.exitCode==null){child.kill('SIGTERM');await sleep(150);if(child.exitCode==null)child.kill('SIGKILL')}
 await db.end().catch(()=>{});
}
