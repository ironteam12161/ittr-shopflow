// ITTR v22.6 self-removing service worker
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.map(k=>caches.delete(k)));
  await self.registration.unregister();
 })());
});
