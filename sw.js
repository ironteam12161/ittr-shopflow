// ITTR ShopFlow v24.31.0 production PWA service worker
const CACHE='ittr-shopflow-v24.31.0';
const SHELL=['/','/index.html','/manifest.webmanifest','/invoice-workspace.css','/modules/invoices.html','/modules/invoices.js','/modules/parts.html','/modules/parts.js','/modules/procenter.html','/modules/procenter.js','/modules/customers.html','/modules/customers.js','/modules/trucksearch.html','/modules/trucksearch.js','/inspection-workflow.css','/inspection-workflow.js','/inspection-checklist.js','/assets/iron-team-logo.png'];

self.addEventListener('install',event=>event.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())
));

self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);
  await self.clients.claim();
})()));

async function networkFirst(request,cacheKey=request){
  try{
    const fresh=await fetch(request,{cache:'no-store'});
    if(fresh&&fresh.ok)(await caches.open(CACHE)).put(cacheKey,fresh.clone());
    return fresh;
  }catch(_){
    return (await caches.match(cacheKey))||Response.error();
  }
}

self.addEventListener('fetch',event=>{
  const r=event.request;
  if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin!==location.origin||u.pathname.startsWith('/api/'))return;

  const critical=r.mode==='navigate'||u.pathname==='/'||u.pathname==='/index.html'||u.pathname.startsWith('/modules/')||u.pathname==='/invoice-workspace.css'||u.pathname==='/inspection-workflow.css'||u.pathname==='/inspection-workflow.js'||u.pathname==='/inspection-checklist.js'||u.pathname==='/manifest.webmanifest';
  if(critical){
    const cacheKey=r.mode==='navigate'?'/index.html':r;
    event.respondWith(networkFirst(r,cacheKey));
    return;
  }

  event.respondWith((async()=>{
    const cached=await caches.match(r);
    if(cached)return cached;
    try{
      const fresh=await fetch(r);
      if(fresh.ok)(await caches.open(CACHE)).put(r,fresh.clone());
      return fresh;
    }catch(_){return Response.error()}
  })());
});

self.addEventListener('sync',event=>{
  if(event.tag==='ittr-sync')event.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true})
      .then(cs=>Promise.all(cs.map(c=>c.postMessage({type:'ITTR_SYNC_REQUEST'}))))
  );
});
