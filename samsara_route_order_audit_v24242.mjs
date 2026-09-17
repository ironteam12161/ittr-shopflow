import fs from 'fs';
const s=fs.readFileSync('server.js','utf8'); let ok=0,fail=0;
const c=(n,v)=>{console.log((v?'PASS ':'FAIL ')+n);v?ok++:fail++};
const p=s.indexOf("app.get('/api/samsara/unit-sync/preview'");
const q=s.indexOf("app.post('/api/samsara/unit-sync'");
const a=s.indexOf("app.get('/api/samsara/all-units'");
const f=s.indexOf("app.get('/api/samsara/fleet'");
c('existing Samsara fleet route exists',f>=0);
c('preview route exists',p>=0);
c('sync route exists',q>=0);
c('all units route exists',a>=0);
c('sync routes registered after fleet',p>f&&q>f&&a>f);
const afterFleet=s.slice(f);
const api404rel=Math.min(...[
 afterFleet.indexOf("API endpoint not found"),
 afterFleet.indexOf("API route not found"),
 afterFleet.indexOf("app.use('/api'")
].filter(x=>x>=0));
c('preview before API fallback',api404rel<0||p-f<api404rel);
c('sync before API fallback',api404rel<0||q-f<api404rel);
c('all-units before API fallback',api404rel<0||a-f<api404rel);
c('integration status endpoint',s.includes('/api/samsara/integration-status'));
c('version 24.24.4',s.includes('24.24.4'));
c('Fullbay SQL guard preserved',s.includes('$22'));
console.log(`${ok}/${ok+fail} route checks passed`); if(fail)process.exit(1);
