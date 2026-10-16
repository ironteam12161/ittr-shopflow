import {spawn} from 'node:child_process';
import fs from 'node:fs';

const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const port=39000+Math.floor(Math.random()*1000);
const env={...process.env,PORT:String(port),NODE_ENV:'test',DATABASE_URL:'',OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',SAMSARA_API_TOKEN:''};
const child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});
let output='';
child.stdout.on('data',d=>{output+=d.toString();if(output.length>20000)output=output.slice(-20000)});
child.stderr.on('data',d=>{output+=d.toString();if(output.length>20000)output=output.slice(-20000)});
let exited=false,exitCode=null;
child.on('exit',code=>{exited=true;exitCode=code});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitJson(pathname){
 let last='';
 for(let i=0;i<50;i++){
  if(exited)throw new Error(`Server exited before ${pathname} responded (code ${exitCode}).\n${output}`);
  try{
   const r=await fetch(`http://127.0.0.1:${port}${pathname}`,{cache:'no-store'});
   last=`HTTP ${r.status}`;
   if(r.ok)return await r.json();
  }catch(e){last=e?.message||String(e)}
  await sleep(100);
 }
 throw new Error(`Timed out waiting for ${pathname}: ${last}\n${output}`);
}

try{
 // v24.71.0: this smoke test runs with no database on purpose. Liveness answers; readiness must say "not ready" (503).
 const health=await waitJson('/api/health/live');
 if(!health?.ok||!health?.live)throw new Error(`Liveness endpoint returned unexpected payload: ${JSON.stringify(health)}`);
 const rr=await fetch(`http://127.0.0.1:${port}/api/health`,{cache:'no-store'}),ready=await rr.json().catch(()=>({}));
 if(rr.status!==503||ready.ok!==false||ready.db!==false)throw new Error(`Readiness without a database must be 503/db:false, got ${rr.status} ${JSON.stringify(ready)}`);
 const build=await waitJson('/api/build');
 if(String(build?.backend)!==String(pkg.version)||String(build?.frontendExpected)!==String(pkg.version)){
  throw new Error(`Build identity mismatch. package=${pkg.version} response=${JSON.stringify(build)}`);
 }
 console.log(`PASS startup smoke test: v${pkg.version} /api/health/live + /api/health (503 without a database) + /api/build`);
}finally{
 if(!exited){child.kill('SIGTERM');await sleep(150);if(!exited)child.kill('SIGKILL')}
}
