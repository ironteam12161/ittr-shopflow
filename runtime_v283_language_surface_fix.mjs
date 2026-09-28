import fs from 'node:fs';

const VERSION='24.28.3';
const serverPath='server.js';
if(!fs.existsSync(serverPath))throw new Error('server.js missing');
let s=fs.readFileSync(serverPath,'utf8');

// Existing production databases predate the language column. CREATE TABLE IF NOT
// EXISTS does not add new columns to those databases, so migrate it explicitly.
const emailAlter=' ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email TEXT;';
if(!s.includes('ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT')){
  if(!s.includes(emailAlter))throw new Error('auth_users migration anchor missing');
  s=s.replace(emailAlter,`${emailAlter}\n ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';\n UPDATE auth_users SET language=CASE WHEN lower(coalesce(language,'')) IN ('uk','ua') THEN 'uk' ELSE 'en' END WHERE language IS NULL OR lower(coalesce(language,'')) NOT IN ('en','uk');`);
}

// Normalize the value returned to every browser/session.
s=s.replace('language:row.language||"en"','language:["uk","ua"].includes(String(row.language||"").toLowerCase())?"uk":"en"');

s=s.replaceAll('24.28.2',VERSION);
fs.writeFileSync(serverPath,s,'utf8');

const mechanicMap={
 'My Work Orders':'Мої наряди',
 'Touch-first mechanic workspace':'Робоче місце механіка з сенсорним керуванням',
 '＋ Start New Job':'＋ Розпочати нову роботу',
 '+ Start New Job':'+ Розпочати нову роботу',
 'Start New Job':'Розпочати нову роботу',
 'Inspection':'Огляд',
 'Completed':'Виконано',
 'Live':'Активне',
 'Logout':'Вийти',
 'MECHANIC':'МЕХАНІК',
 'Current Activity':'Поточна діяльність',
 'Update what you are doing when you are not actively timed on a repair task.':'Оновіть, що ви зараз робите, коли не працюєте над завданням із таймером.',
 'Not Set':'Не вказано',
 'Activity':'Діяльність',
 'Choose activity':'Оберіть діяльність',
 'Optional note':'Необов’язкова примітка',
 'Update Activity':'Оновити діяльність',
 'Stop Activity':'Зупинити діяльність',
 'Clear / Available':'Очистити / Вільний',
 'Upcoming / On the Way':'Очікуються / В дорозі',
 'No upcoming assigned trucks.':'Немає очікуваних призначених траків.',
 'Ready to Work':'Готові до роботи',
 'No trucks ready to work on.':'Немає траків, готових до роботи.',
 'Truck Is Here':'Трак прибув',
 'You can start a walk-in job yourself using company DOT + VIN, or see work assigned to you before the truck arrives. When the truck arrives, press':'Ви можете самостійно розпочати роботу з клієнтом, використовуючи номер DOT компанії + VIN, або переглянути призначену вам роботу до прибуття вантажівки. Коли вантажівка прибуде, натисніть',
 'to move it into your ready-to-work list.':'щоб перемістити її до списку «Готово до роботи».',
 'Cleaning Work Area':'Прибирання робочого місця',
 'In the Yard':'На території / у дворі',
 'Moving Truck / Trailer':'Переміщення трака / причепа',
 'Break':'Перерва',
 'Shop Maintenance':'Обслуговування майстерні',
 'Parts Run':'Поїздка за запчастинами',
 'Available':'Вільний'
};
const placeholderMap={
 'Example: cleaning bay 2, checking trailers in yard...':'Наприклад: прибираю пост 2, перевіряю причепи у дворі...'
};

const helper=`\n/* ITTR v24.28.3 deterministic mechanic translation surface */\nconst ITTR_MECHANIC_UA=${JSON.stringify(mechanicMap)};\nconst ITTR_MECHANIC_UA_PLACEHOLDERS=${JSON.stringify(placeholderMap)};\nfunction ittrNormalizeLanguage(v){v=String(v||'').toLowerCase();return (v==='uk'||v==='ua')?'uk':'en'}\nfunction applyMechanicLanguageSurface(){\n if(ittrNormalizeLanguage(currentLanguage)!=='uk')return;\n const roots=[document.getElementById('mechanic'),document.querySelector('header'),document.getElementById('mobileBottomNav')].filter(Boolean);\n const seen=new Set();\n for(const root of roots){\n  if(seen.has(root))continue;seen.add(root);\n  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);\n  const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);\n  for(const node of nodes){\n   const parent=node.parentElement;if(!parent||['SCRIPT','STYLE','TEXTAREA'].includes(parent.tagName))continue;\n   const raw=node.nodeValue||'',key=raw.trim(),ua=ITTR_MECHANIC_UA[key]||UI_TRANSLATIONS?.[key];\n   if(ua&&key)node.nodeValue=raw.replace(key,ua);\n  }\n }\n document.querySelectorAll('#mechanic option').forEach(el=>{const key=String(el.textContent||'').trim(),ua=ITTR_MECHANIC_UA[key]||UI_TRANSLATIONS?.[key];if(ua)el.textContent=ua});\n document.querySelectorAll('#mechanic input[placeholder],#mechanic textarea[placeholder]').forEach(el=>{const key=String(el.getAttribute('placeholder')||'').trim(),ua=ITTR_MECHANIC_UA_PLACEHOLDERS[key]||UI_TRANSLATIONS?.[key];if(ua)el.setAttribute('placeholder',ua)});\n}\n`;

for(const fp of ['index.html','public/index.html']){
 if(!fs.existsSync(fp))continue;
 let h=fs.readFileSync(fp,'utf8');
 if(!h.includes('ITTR v24.28.3 deterministic mechanic translation surface')){
   const applyStart=h.indexOf('function applyTranslations(){');
   if(applyStart<0)throw new Error(`${fp}: applyTranslations not found`);
   h=h.slice(0,applyStart)+helper+h.slice(applyStart);
   const setStart=h.indexOf('\nasync function setLanguage(',applyStart+helper.length);
   if(setStart<0)throw new Error(`${fp}: setLanguage boundary not found`);
   let block=h.slice(applyStart+helper.length,setStart);
   const close=block.lastIndexOf('\n}');
   if(close<0)throw new Error(`${fp}: applyTranslations end not found`);
   if(!block.includes('applyMechanicLanguageSurface();'))block=block.slice(0,close)+'\n applyMechanicLanguageSurface();'+block.slice(close);
   h=h.slice(0,applyStart+helper.length)+block+h.slice(setStart);
 }
 // Make account language authoritative every time role state is applied.
 const marker='// ITTR_LANGUAGE_ROLE_SYNC';
 if(h.includes(marker)&&!h.includes('// ITTR_LANGUAGE_ACCOUNT_AUTHORITATIVE')){
   h=h.replace(marker,`${marker}\n // ITTR_LANGUAGE_ACCOUNT_AUTHORITATIVE\n if(session?.language){currentLanguage=ittrNormalizeLanguage(session.language);localStorage.setItem('ittr_language',currentLanguage);}`);
 }
 h=h.replaceAll('24.28.2',VERSION);
 fs.writeFileSync(fp,h,'utf8');
}

for(const fp of ['sw.js','public/sw.js'])if(fs.existsSync(fp)){
 fs.writeFileSync(fp,fs.readFileSync(fp,'utf8').replaceAll('24.28.2',VERSION),'utf8');
}

console.log(`ITTR v${VERSION} language schema + mechanic translation surface applied`);
