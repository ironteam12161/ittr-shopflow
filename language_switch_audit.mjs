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
if(!server.includes("ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'"))fail('existing-database language migration missing');
pass('existing auth_users tables receive language column migration');

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
if(!html.includes('ITTR_LANGUAGE_ACCOUNT_AUTHORITATIVE'))fail('account-authoritative language application missing');
pass('login/role initialization uses authenticated account language');

if(!html.includes('function applyMechanicLanguageSurface(){'))fail('deterministic mechanic translation surface missing');
if(!html.includes('applyMechanicLanguageSurface();'))fail('translation surface is not executed by applyTranslations');
for(const phrase of ['My Work Orders','Current Activity','Upcoming / On the Way','Ready to Work','Touch-first mechanic workspace','Start New Job','Inspection','Completed']){
 if(!html.includes(`'${phrase}'`) && !html.includes(`"${phrase}"`))fail(`required mechanic source phrase missing from translation surface: ${phrase}`);
}
for(const translated of ['Мої наряди','Поточна діяльність','Очікуються / В дорозі','Готові до роботи','Робоче місце механіка з сенсорним керуванням','Розпочати нову роботу']){
 if(!html.includes(translated))fail(`required Ukrainian mechanic translation missing: ${translated}`);
}
pass('screenshot-visible mechanic workspace phrases have deterministic Ukrainian translations');

console.log('PASS language switch regression audit complete');
