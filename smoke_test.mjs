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
 const health=await waitJson('/api/health');
 if(!health?.ok)throw new Error(`Health endpoint returned unexpected payload: ${JSON.stringify(health)}`);
 const build=await waitJson('/api/build');
 if(String(build?.backend)!==String(pkg.version)||String(build?.frontendExpected)!==String(pkg.version)){
  throw new Error(`Build identity mismatch. package=${pkg.version} response=${JSON.stringify(build)}`);
 }
 console.log(`PASS startup smoke test: v${pkg.version} /api/health + /api/build`);
}finally{
 if(!exited){child.kill('SIGTERM');await sleep(150);if(!exited)child.kill('SIGKILL')}
}
