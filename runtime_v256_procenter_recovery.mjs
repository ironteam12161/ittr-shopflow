import fs from 'node:fs';
const files=['public/modules/procenter.js','modules/procenter.js'];
for(const fp of files){
 if(!fs.existsSync(fp)) continue;
 let s=fs.readFileSync(fp,'utf8');
 // v24.25.4 appended an IIFE immediately after preceding code. Without an ASI guard,
 // JavaScript can interpret it as calling the previous expression, producing:
 // "(intermediate value)(...) is not a function" and preventing ProCenter from mounting.
 s=s.replace(/\n\(function\(\)\{\n const css='\.ittr-fault-btn/,"\n;(function(){\n const css='.ittr-fault-btn");
 fs.writeFileSync(fp,s);
}
console.log('ITTR v24.25.6 ProCenter ASI recovery applied');
