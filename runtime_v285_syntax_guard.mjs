import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const file='server.js';
const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
if(r.status!==0){
 const text=String(r.stderr||r.stdout||'');
 console.error(text);
 const m=text.match(/server\.js:(\d+)/);const line=Number(m?.[1]||0);
 if(line){const rows=fs.readFileSync(file,'utf8').split(/\n/);const a=Math.max(0,line-10),b=Math.min(rows.length,line+9);console.error('--- generated server context ---');for(let i=a;i<b;i++)console.error(`${i+1}: ${rows[i]}`)}
 throw new Error('generated server.js syntax invalid after inventory runtime patch');
}
console.log('ITTR v285 generated server syntax guard passed');
