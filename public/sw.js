// ITTR ShopFlow v24.24.0 production PWA service worker
const CACHE='ittr-shopflow-v24.24.0';
const SHELL=['/','/index.html','/manifest.webmanifest','/invoice-workspace.css','/modules/invoices.html','/modules/invoices.js','/modules/parts.html','/modules/parts.js','/modules/procenter.html','/modules/procenter.js','/assets/iron-team-logo.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);await self.clients.claim()})()));
self.addEventListener('fetch',event=>{
 const r=event.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin||new URL(r.url).pathname.startsWith('/api/'))return;
 if(r.mode==='navigate'){event.respondWith((async()=>{try{const fresh=await fetch(r);const c=await caches.open(CACHE);c.put('/index.html',fresh.clone());return fresh}catch(_){return (await caches.match('/index.html'))||Response.error()}})());return}
 event.respondWith((async()=>{const cached=await caches.match(r);const fresh=fetch(r).then(async x=>{if(x.ok)(await caches.open(CACHE)).put(r,x.clone());return x}).catch(()=>null);return cached||(await fresh)||Response.error()})());
});
self.addEventListener('sync',event=>{if(event.tag==='ittr-sync'){event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>Promise.all(cs.map(c=>c.postMessage({type:'ITTR_SYNC_REQUEST'}))))) }});
