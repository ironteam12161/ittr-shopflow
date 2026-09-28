import fs from 'node:fs';

const marker='function ittrFmtSamsaraTime(x){';
const files=['public/modules/procenter.js','modules/procenter.js'];
let canonical=null;
for(const fp of files){
 if(!fs.existsSync(fp))continue;
 let text=fs.readFileSync(fp,'utf8');
 const positions=[];let at=0;
 while((at=text.indexOf(marker,at))>=0){positions.push(at);at+=marker.length}
 if(positions.length>1){
   const first=positions[0],last=positions[positions.length-1];
   text=text.slice(0,first)+text.slice(last);
   console.log(`ITTR v287 removed ${positions.length-1} duplicate Samsara ProCenter override block(s) from ${fp}`);
 }
 fs.writeFileSync(fp,text,'utf8');
 if(fp==='public/modules/procenter.js')canonical=text;
}
if(canonical!=null&&fs.existsSync('modules/procenter.js')&&fs.readFileSync('modules/procenter.js','utf8')!==canonical){
 fs.writeFileSync('modules/procenter.js',canonical,'utf8');
 console.log('ITTR v287 re-synchronized ProCenter module mirror');
}
console.log('ITTR v287 double-runtime-preparation cleanup complete');
