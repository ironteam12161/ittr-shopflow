import fs from 'node:fs';

const VERSION='24.27.2';

function replaceInFile(fp,mutate){
  if(!fs.existsSync(fp))return;
  const before=fs.readFileSync(fp,'utf8');
  const after=mutate(before);
  if(after!==before)fs.writeFileSync(fp,after,'utf8');
}

// The v24.27.1 quarantine correctly removed unsafe persisted entries, but a
// pre-login startup save had already inserted the same key into cloudPending.
// That left the UI showing "Syncing (1)…" forever even though the queue was empty.
for(const fp of ['index.html','public/index.html']){
  replaceInFile(fp,h=>{
    let x=h.replaceAll('24.27.1',VERSION);

    // Do not create a cloud write from local browser state before authentication
    // and before current server versions are known.
    x=x.replace('\nsave();\n\nlet adminFilter="all";','\n\nlet adminFilter="all";');

    // Add a self-healing reconciliation for stale in-memory pending keys.
    if(!x.includes('function reconcileCloudPendingGhosts(){')){
      const anchor='function removePersistedState(key){const q=readPersistentSyncQueue();delete q[key];writePersistentSyncQueue(q)}';
      const replacement=`${anchor}\nfunction reconcileCloudPendingGhosts(){\n try{\n  const q=readPersistentSyncQueue();\n  for(const key of [...cloudPending]){\n   if(!q[key]&&!cloudSaving[key])cloudPending.delete(key);\n  }\n }catch(_){}\n}`;
      if(x.includes(anchor))x=x.replace(anchor,replacement);
      else throw new Error(`${fp}: removePersistedState anchor not found`);
    }

    const oldBadge='function updateSyncQueueBadge(){const badge=document.getElementById("sync-queue-badge"),text=document.getElementById("syncQueueText");if(!badge||!text)return;const pending=Math.max(cloudPending.size,persistentSyncCount()),offline=!navigator.onLine;';
    const newBadge='function updateSyncQueueBadge(){reconcileCloudPendingGhosts();const badge=document.getElementById("sync-queue-badge"),text=document.getElementById("syncQueueText");if(!badge||!text)return;const pending=Math.max(cloudPending.size,persistentSyncCount()),offline=!navigator.onLine;';
    if(x.includes(oldBadge))x=x.replace(oldBadge,newBadge);
    else if(!x.includes('function updateSyncQueueBadge(){reconcileCloudPendingGhosts();'))throw new Error(`${fp}: sync badge anchor not found`);

    // When an unsafe legacy item is quarantined, also clear its in-memory marker.
    const oldQuarantine='writePersistentSyncQueue(safe);return count;';
    const newQuarantine='writePersistentSyncQueue(safe);for(const key of Object.keys(unsafe)){cloudPending.delete(key);if(cloudSaving[key]){clearTimeout(cloudSaving[key]);cloudSaving[key]=null}}return count;';
    if(x.includes(oldQuarantine))x=x.replace(oldQuarantine,newQuarantine);
    else if(!x.includes('for(const key of Object.keys(unsafe)){cloudPending.delete(key)'))throw new Error(`${fp}: quarantine cleanup anchor not found`);

    return x;
  });
}

// Bump runtime identity and PWA cache key after all previous patches.
replaceInFile('server.js',s=>s.replaceAll('24.27.1',VERSION));
for(const fp of ['sw.js','public/sw.js'])replaceInFile(fp,s=>s.replaceAll('24.27.1',VERSION));

console.log(`ITTR v${VERSION} sync ghost cleanup applied`);
