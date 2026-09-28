import fs from 'node:fs';

const VERSION='24.28.2';
const files=['index.html','public/index.html'];

for(const fp of files){
  if(!fs.existsSync(fp))continue;
  let h=fs.readFileSync(fp,'utf8');

  // v24.28.1 saved the account preference correctly, but tried to reverse an
  // already-translated DOM in place. AI/dynamic translations are not always
  // perfectly reversible. Save first, then reload the clean English source and
  // apply the chosen account language during normal startup.
  const oldFn=`function setLanguage(lang){
 currentLanguage=lang==="uk"?"uk":"en";
 localStorage.setItem("ittr_language",currentLanguage);
 if(typeof session!=="undefined" && session?.username){
   session.language=currentLanguage;
   sessionStorage.setItem("ittr_session",JSON.stringify(session));
   apiJSON("/api/auth/preferences",{method:"PATCH",body:{language:currentLanguage}}).then(d=>{
     if(d?.user?.language){session.language=d.user.language;sessionStorage.setItem("ittr_session",JSON.stringify(session))}
   }).catch(e=>showToast?.(\`Language preference: \${e.message}\`,"warning",5000));
 }
 if(typeof session!=="undefined" && session?.username && typeof USERS!=="undefined" && USERS[session.username]){
   USERS[session.username].language=currentLanguage;
   if(session?.role!=="mechanic")saveUsers();
 }
 render();
 applyTranslations();

 if(currentLanguage==="uk")scheduleAITranslation();
}`;

  const newFn=`async function setLanguage(lang){
 const next=lang==="uk"?"uk":"en";
 const previous=currentLanguage;
 if(next===previous){applyTranslations();return}
 currentLanguage=next;
 localStorage.setItem("ittr_language",next);
 const selector=document.getElementById("languageSelect");
 if(selector){selector.value=next;selector.disabled=true}
 document.documentElement.lang=next==="uk"?"uk":"en";
 if(typeof session!=="undefined" && session?.username){
   const priorSessionLanguage=session.language||previous;
   session.language=next;
   sessionStorage.setItem("ittr_session",JSON.stringify(session));
   try{
     const d=await apiJSON("/api/auth/preferences",{method:"PATCH",body:{language:next}});
     const saved=d?.user?.language||next;
     session.language=saved;
     currentLanguage=saved;
     localStorage.setItem("ittr_language",saved);
     sessionStorage.setItem("ittr_session",JSON.stringify(session));
     // A clean reload is intentional: it rebuilds the UI from the English source
     // before applying UA, so switching UA -> EN cannot leave stale translated DOM.
     location.reload();
     return;
   }catch(e){
     session.language=priorSessionLanguage;
     currentLanguage=previous;
     localStorage.setItem("ittr_language",previous);
     sessionStorage.setItem("ittr_session",JSON.stringify(session));
     if(selector){selector.value=previous;selector.disabled=false}
     applyTranslations();
     showToast?.(\`Language preference: \${e.message}\`,"warning",5000);
     return;
   }
 }
 // Logged-out/local-only fallback.
 applyTranslations();
 if(selector)selector.disabled=false;
}`;

  if(h.includes(oldFn))h=h.replace(oldFn,newFn);
  else if(!h.includes('A clean reload is intentional: it rebuilds the UI from the English source')){
    throw new Error(`${fp}: v24.28.1 language setter not found`);
  }

  // Keep the language selector aligned after every role/render transition.
  const roleAnchor='function applyRole(){\n if(session?.language){\n   currentLanguage=session.language;';
  if(h.includes(roleAnchor) && !h.includes('ITTR_LANGUAGE_ROLE_SYNC')){
    h=h.replace(roleAnchor,'function applyRole(){\n // ITTR_LANGUAGE_ROLE_SYNC\n if(session?.language){\n   currentLanguage=session.language;');
  }

  h=h.replaceAll('24.28.1',VERSION);
  fs.writeFileSync(fp,h,'utf8');
}

for(const fp of ['sw.js','public/sw.js']){
  if(!fs.existsSync(fp))continue;
  fs.writeFileSync(fp,fs.readFileSync(fp,'utf8').replaceAll('24.28.1',VERSION),'utf8');
}

if(fs.existsSync('server.js')){
  fs.writeFileSync('server.js',fs.readFileSync('server.js','utf8').replaceAll('24.28.1',VERSION),'utf8');
}

console.log(`ITTR v${VERSION} deterministic language switching applied`);
