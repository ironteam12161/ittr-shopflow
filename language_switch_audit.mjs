import fs from 'node:fs';

const fail=(m)=>{console.error(`FAIL language switch: ${m}`);process.exit(1)};
const pass=(m)=>console.log(`PASS language switch: ${m}`);
const read=(p)=>fs.readFileSync(p,'utf8');
const html=read('public/index.html');
const server=read('server.js');

const fnMatch=html.match(/async function setLanguage\(lang\)\{[\s\S]*?\n\}/);
if(!fnMatch)fail('async setLanguage implementation missing');
const fn=fnMatch[0];

if(!server.includes('app.patch("/api/auth/preferences",auth'))fail('self-service preferences endpoint missing');
pass('authenticated self-service preferences endpoint exists');

if(!server.includes('["en","uk"].includes(language)'))fail('language whitelist missing');
pass('server restricts language values to EN/UA');

if(!server.includes('WHERE id=$1 RETURNING *')||!server.includes('[req.user.id,language]'))fail('preference update is not scoped to authenticated user id');
pass('preference write is scoped to the signed-in account');

if(!fn.includes('apiJSON("/api/auth/preferences",{method:"PATCH",body:{language:next}})'))fail('selector does not persist selected language');
pass('selector persists language through self-service API');

if(!fn.includes('location.reload();'))fail('clean reload after save missing');
pass('successful language change reloads clean source DOM');

if(!fn.includes('selector.disabled=true')||!fn.includes('selector.disabled=false'))fail('selector pending/error state guard missing');
pass('selector is guarded while preference save is pending');

if(!fn.includes('currentLanguage=previous')||!fn.includes('session.language=priorSessionLanguage'))fail('failed save rollback missing');
pass('failed preference save rolls back language/session state');

if(fn.includes('saveUsers()')||fn.includes('queueCloudState("users"'))fail('mechanic language path touches shared users state');
pass('language switch does not write shared users state');

if(!html.includes('language:d.user.language||localStorage.getItem("ittr_language")||"en"'))fail('login language hydration missing');
if(!html.includes('if(session?.language){\n   currentLanguage=session.language;'))fail('role language hydration missing');
pass('login/role initialization hydrates account language');

if(!html.includes('ITTR_LANGUAGE_ROLE_SYNC'))fail('language role-sync marker missing');
pass('role transition language synchronization is present');

console.log('PASS language switch regression audit complete');
