import fs from 'node:fs';

const VERSION='24.28.1';
const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');

// Self-service language preference. This is intentionally separate from the
// legacy shared users state so a mechanic can change only their own language.
if(!s.includes('ITTR v24.28.1 self-service language preference')){
  const anchor='app.get("/api/auth/me",auth,(req,res)=>res.json({user:publicUser(req.user)}));';
  if(!s.includes(anchor))throw new Error('auth/me anchor not found');
  const route=`${anchor}\n// ITTR v24.28.1 self-service language preference\napp.patch("/api/auth/preferences",auth,async(req,res,next)=>{try{\n const language=String(req.body?.language||"").trim().toLowerCase();\n if(!["en","uk"].includes(language))return res.status(400).json({error:"Supported languages are en and uk."});\n const q=await requireDb().query("UPDATE auth_users SET language=$2,updated_at=now() WHERE id=$1 RETURNING *",[req.user.id,language]);\n if(!q.rowCount)return res.status(404).json({error:"User account not found."});\n await audit(req.user.username,"language_preference_changed",{language});\n res.json({ok:true,user:publicUser(q.rows[0])});\n}catch(e){next(e)}});`;
  s=s.replace(anchor,route);
}

s=s.replaceAll('24.28.0',VERSION);
fs.writeFileSync(serverPath,s,'utf8');

for(const fp of ['index.html','public/index.html']){
  if(!fs.existsSync(fp))continue;
  let h=fs.readFileSync(fp,'utf8').replaceAll('24.28.0',VERSION);

  h=h.replace(
    'session={username:d.user.username,role:d.user.role,display:d.user.display};\n    sessionStorage.setItem("ittr_session",JSON.stringify(session));',
    'session={username:d.user.username,role:d.user.role,display:d.user.display,language:d.user.language||localStorage.getItem("ittr_language")||"en"};\n    currentLanguage=session.language;localStorage.setItem("ittr_language",currentLanguage);\n    sessionStorage.setItem("ittr_session",JSON.stringify(session));'
  );

  h=h.replace(
    'try{const d=await apiJSON("/api/auth/me");session={username:d.user.username,role:d.user.role,display:d.user.display};sessionStorage.setItem("ittr_session",JSON.stringify(session));await loadCloudStateAfterLogin();return true}catch(_){return false}',
    'try{const d=await apiJSON("/api/auth/me");session={username:d.user.username,role:d.user.role,display:d.user.display,language:d.user.language||localStorage.getItem("ittr_language")||"en"};currentLanguage=session.language;localStorage.setItem("ittr_language",currentLanguage);sessionStorage.setItem("ittr_session",JSON.stringify(session));await loadCloudStateAfterLogin();return true}catch(_){return false}'
  );

  h=h.replace(
    'function applyRole(){\n if(session?.username && USERS?.[session.username]?.language){\n   currentLanguage=USERS[session.username].language;\n }',
    'function applyRole(){\n if(session?.language){\n   currentLanguage=session.language;\n }else if(session?.username && USERS?.[session.username]?.language){\n   currentLanguage=USERS[session.username].language;\n }'
  );

  const oldSet=`function setLanguage(lang){\n currentLanguage=lang==="uk"?"uk":"en";\n localStorage.setItem("ittr_language",currentLanguage);\n if(typeof session!=="undefined" && session?.username && typeof USERS!=="undefined" && USERS[session.username]){\n   USERS[session.username].language=currentLanguage;\n   saveUsers();\n }\n render();\n applyTranslations();\n\n if(currentLanguage==="uk")scheduleAITranslation();\n}`;
  const newSet=`function setLanguage(lang){\n currentLanguage=lang==="uk"?"uk":"en";\n localStorage.setItem("ittr_language",currentLanguage);\n if(typeof session!=="undefined" && session?.username){\n   session.language=currentLanguage;\n   sessionStorage.setItem("ittr_session",JSON.stringify(session));\n   apiJSON("/api/auth/preferences",{method:"PATCH",body:{language:currentLanguage}}).then(d=>{\n     if(d?.user?.language){session.language=d.user.language;sessionStorage.setItem("ittr_session",JSON.stringify(session))}\n   }).catch(e=>showToast?.(\`Language preference: \${e.message}\`,"warning",5000));\n }\n if(typeof session!=="undefined" && session?.username && typeof USERS!=="undefined" && USERS[session.username]){\n   USERS[session.username].language=currentLanguage;\n   if(session?.role!=="mechanic")saveUsers();\n }\n render();\n applyTranslations();\n\n if(currentLanguage==="uk")scheduleAITranslation();\n}`;
  if(h.includes(oldSet))h=h.replace(oldSet,newSet);
  else if(!h.includes('/api/auth/preferences'))throw new Error(`${fp}: language setter target not found`);

  fs.writeFileSync(fp,h,'utf8');
}

for(const fp of ['sw.js','public/sw.js']){
  if(!fs.existsSync(fp))continue;
  fs.writeFileSync(fp,fs.readFileSync(fp,'utf8').replaceAll('24.28.0',VERSION),'utf8');
}

console.log(`ITTR v${VERSION} mechanic language preference fix applied`);
