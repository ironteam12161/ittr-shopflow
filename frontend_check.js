


(async function ITTRRemoveOldServiceWorkers(){
 try{
  if("serviceWorker" in navigator){
   const regs=await navigator.serviceWorker.getRegistrations();
   for(const reg of regs)await reg.unregister();
  }
  if("caches" in window){
   const names=await caches.keys();
   for(const name of names)await caches.delete(name);
  }
 }catch(e){console.warn("ITTR cache cleanup:",e);}
})();


const DEFAULT_USERS={};
let USERS=JSON.parse(localStorage.getItem("ittr_users_v1")||"null")||DEFAULT_USERS;

function makeTaskUid(prefix="task"){
 try{
   if(globalThis.crypto?.randomUUID)return `${prefix}-${crypto.randomUUID()}`;
 }catch(_){}
 return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,12)}`;
}
function newTaskRecord(text,extra={}){
 return {
   uid:makeTaskUid("task"),
   t:String(text||"").trim(),
   done:false,startedAt:"",stoppedAt:"",runningBy:"",elapsedMs:0,completedAt:"",
   taskOutcome:"",outcomeNote:"",outcomeAt:"",outcomeBy:"",
   paused:false,pausedAt:"",pauseReason:"",pauseNote:"",
   ...extra
 };
}

const FRONTEND_VERSION="24.4.1";
let cloudToken=sessionStorage.getItem("ittr_cloud_token")||"";
let cloudReady=false,cloudSaving={},cloudVersions={},cloudPending=new Set(),cloudRefreshBusy=false;
function authHeaders(extra={}){return {...extra,...(cloudToken?{Authorization:`Bearer ${cloudToken}`}:{})}}
async function apiJSON(url,options={}){
 const opts={...options,headers:authHeaders({"Content-Type":"application/json",...(options.headers||{})})};
 const r=await fetch(url,opts);let d={};try{d=await r.json()}catch(_){ }
 if(r.status===401 && !url.includes("/api/auth/login")){cloudToken="";sessionStorage.removeItem("ittr_cloud_token");session=null;sessionStorage.removeItem("ittr_session");showLogin();throw new Error(d.error||"Session expired.")}
 if(!r.ok)throw new Error(d.error||`Server error ${r.status}`);return d;
}
function queueCloudState(key,payload){
 if(!cloudReady||!cloudToken)return;
 clearTimeout(cloudSaving[key]);
 cloudPending.add(key);
 cloudSaving[key]=setTimeout(async()=>{
   try{
     const d=await apiJSON(`/api/state/${key}`,{method:"PUT",body:JSON.stringify({payload,expectedVersion:Number(cloudVersions[key]||0)})});
     if(d?.version!=null)cloudVersions[key]=Number(d.version);
   }catch(e){showSyncError(e.message)}
   finally{cloudPending.delete(key);cloudSaving[key]=null;}
 },180);
}
async function refreshCloudStateSilently(){
 if(!cloudReady||!cloudToken||cloudRefreshBusy)return;
 cloudRefreshBusy=true;
 try{
   const d=await apiJSON("/api/state");
   let changed=false;
   const apply=(key,fn)=>{
     const remote=d[key]; if(!remote||cloudPending.has(key))return;
     const rv=Number(remote.version||0),lv=Number(cloudVersions[key]||0);
     if(rv>lv){fn(remote.payload);cloudVersions[key]=rv;changed=true;}
   };
   apply("users",payload=>{USERS=payload||{};localStorage.setItem("ittr_users_v1",JSON.stringify(USERS));});
   apply("shopflow",payload=>{state=payload||{workorders:[],issues:[]};localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));});
   apply("pro",payload=>{PRO=payload||{};localStorage.setItem(PRO_KEY,JSON.stringify(PRO));});
   if(changed)render();
 }catch(e){/* keep current screen usable during temporary network issues */}
 finally{cloudRefreshBusy=false;}
}
function showSyncError(msg){const b=document.getElementById("appErrorBanner"),t=document.getElementById("appErrorText");if(b&&t){t.textContent=`Cloud sync: ${msg}`;b.style.display="block"}}
function saveUsers(){localStorage.setItem("ittr_users_v1",JSON.stringify(USERS));queueCloudState("users",USERS)}

function mechanicActivityLabel(code,customText=""){
 const map={cleaning:"Cleaning Work Area",yard:"In the Yard",moving_unit:"Moving Truck / Trailer",parts:"Getting Parts",waiting_parts:"Waiting for Parts",helping:"Helping Another Mechanic",inspection:"General Inspection",break:"Break",custom:customText||"Custom Activity"};
 return map[code]||"Available";
}
function mechanicActivityRecord(username){
 const users=USERS;
 const u=users?.[username];
 if(!u)return {code:"",note:"",startedAt:""};
 return u.currentActivity||{code:"",note:"",startedAt:""};
}
function saveMechanicActivity(username,record){
 const users=USERS;
 if(!users?.[username])return;
 users[username].currentActivity=record;
 users[username].activityHistory=Array.isArray(users[username].activityHistory)?users[username].activityHistory:[];
 users[username].activityHistory.unshift({
   ...record,
   endedAt:"",
   savedAt:new Date().toISOString()
 });
 users[username].activityHistory=users[username].activityHistory.slice(0,100);
 if(typeof saveUsers==="function"){
   saveUsers();
 }
}

function toggleCustomMechanicActivity(){
 const s=document.getElementById("mechanicActivitySelect"),i=document.getElementById("mechanicCustomActivity");
 if(!s||!i)return;i.classList.toggle("hidden",s.value!=="custom");
}
function closeCurrentMechanicActivity(users,username,endedAt=new Date().toISOString()){
 const u=users?.[username],a=u?.currentActivity;if(!u||!a?.code)return;
 u.activityHistory=Array.isArray(u.activityHistory)?u.activityHistory:[];
 const row=u.activityHistory.find(x=>!x.endedAt&&x.startedAt===a.startedAt);
 if(row)row.endedAt=endedAt;
 u.currentActivity={code:"",customText:"",note:"",startedAt:""};
}
function stopMechanicActivity(){
 if(!requireMechanic())return;
 const users=USERS;if(!users?.[session.username])return;
 closeCurrentMechanicActivity(users,session.username);
 try{saveUsers(users)}catch(e){saveUsers()}
 renderMechanicActivity();renderMechanicLiveStatus();
}

function startMechanicActivity(){
 if(!requireMechanic())return;
 const code=document.getElementById("mechanicActivitySelect")?.value||"";
 const customText=(document.getElementById("mechanicCustomActivity")?.value||"").trim();
 const note=(document.getElementById("mechanicActivityNote")?.value||"").trim();
 if(!code)return alert(currentLanguage==="uk"?"Оберіть діяльність.":"Choose an activity.");
 if(code==="custom"&&!customText)return alert(currentLanguage==="uk"?"Введіть свою діяльність.":"Type your custom activity.");
 const users=USERS;if(!users?.[session.username])return;
 closeCurrentMechanicActivity(users,session.username);
 const r={code,customText:code==="custom"?customText:"",note,startedAt:new Date().toISOString(),endedAt:""};
 users[session.username].currentActivity={...r};
 users[session.username].activityHistory=Array.isArray(users[session.username].activityHistory)?users[session.username].activityHistory:[];
 users[session.username].activityHistory.unshift({...r});
 users[session.username].activityHistory=users[session.username].activityHistory.slice(0,500);
 try{saveUsers(users)}catch(e){saveUsers()}
 renderMechanicActivity();renderMechanicLiveStatus();
}
function clearMechanicActivity(){
 if(!requireMechanic())return;
 const users=USERS;if(!users?.[session.username])return;
 closeCurrentMechanicActivity(users,session.username);
 try{saveUsers(users)}catch(e){saveUsers()}
 renderMechanicActivity();renderMechanicLiveStatus();
}
function renderMechanicActivity(){
 if(session?.role!=="mechanic")return;
 const p=document.getElementById("mechanicActivityPanel");if(!p)return;
 const a=mechanicActivityRecord(session.username),label=mechanicActivityLabel(a.code,a.customText);
 const b=document.getElementById("mechanicActivityStatusBadge"),c=document.getElementById("mechanicActivityCurrent");
 if(a.code){
  if(b){b.textContent=translateDynamicText(label);b.className="badge mechanicActivityBadge";}
  if(c)c.innerHTML=`<b>${translateDynamicText("Current activity")}:</b> ${esc(translateDynamicText(label))}${a.note?` · ${esc(a.note)}`:""}${a.startedAt?` · ${translateDynamicText("Started")}: ${fmtDateTime(a.startedAt)}`:""}`;
  p.classList.add("mechanicActivityLive");
 }else{
  if(b){b.textContent=translateDynamicText("Available");b.className="badge";}
  if(c)c.textContent=translateDynamicText("Available");p.classList.remove("mechanicActivityLive");
 }
 toggleCustomMechanicActivity();
}

function mechanicAccounts(){
 return Object.entries(USERS)
  .filter(([username,u])=>u.role==="mechanic")
  .map(([username,u])=>({username,display:u.display||username}))
  .sort((a,b)=>a.display.localeCompare(b.display));
}
function mechanicDisplay(username){
 const u=USERS[username];
 return u?.display||username||"Unassigned";
}

let session=JSON.parse(sessionStorage.getItem("ittr_session")||"null");


const APP_VIEWS=["dashboard","workorders","trucksearch","customers","parts","procenter","activityhistory","mechanic","completed","approvals","accounts","inspection","mycompleted"];
let currentView=null;
let viewHistory=[];

function allowedViewForRole(view){
 if(!session)return false;
 const adminViews=["dashboard","workorders","trucksearch","customers","parts","procenter","activityhistory","completed","approvals","accounts"];
 const mechanicViews=["mechanic","inspection","mycompleted"];
 return session.role==="admin" ? adminViews.includes(view) : mechanicViews.includes(view);
}

function defaultViewForRole(){
 return session?.role==="admin" ? "dashboard" : "mechanic";
}

function syncMobileChrome(){
 const nav=document.getElementById("mobileBottomNav"),header=document.querySelector("header"),root=document.documentElement;
 if(root){root.style.setProperty("--mobile-nav-height",`${nav&&getComputedStyle(nav).display!=="none"?Math.ceil(nav.getBoundingClientRect().height):0}px`);root.style.setProperty("--mobile-header-height",`${header&&getComputedStyle(header).display!=="none"?Math.ceil(header.getBoundingClientRect().height):0}px`)}
}
function syncModalState(){document.body?.classList.toggle("modalOpen",!!document.querySelector(".modal.open"));syncMobileChrome()}
function getTopOpenModal(){
 const open=[...document.querySelectorAll(".modal.open")];
 if(!open.length)return null;
 return open.map((el,index)=>({el,index,z:Number.parseInt(getComputedStyle(el).zIndex,10)||0}))
   .sort((a,b)=>a.z-b.z||a.index-b.index).at(-1).el;
}
function closeTopOpenModal(){
 const modal=getTopOpenModal();
 if(!modal)return false;
 if(modal.id==="smartReceivingModal"){closeSmartReceiving();return true;}
 if(modal.id==="partsScannerModal"){closePartsScanner();return true;}
 if(modal.id==="partDetailModal"){closePartDetail();return true;}
 modal.classList.remove("open");
 updateMobileBackButton();
 return true;
}
function updateMobileBackButton(){
 const btn=document.getElementById("mobileBackBtn");
 const hasModal=!!document.querySelector(".modal.open");
 if(btn){const canBack=hasModal || viewHistory.length>0;btn.classList.toggle("visible",canBack);}
 syncModalState();
}

function showView(view,{push=true,replace=false}={}){
 if(!allowedViewForRole(view))view=defaultViewForRole();
 if(!view)return;

 if(currentView && currentView!==view && push){
   viewHistory.push(currentView);
 }

 APP_VIEWS.forEach(v=>{
   const el=document.getElementById(v);
   if(el)el.classList.toggle("hidden",v!==view);
 });

 document.querySelectorAll(".navbtn[data-view]").forEach(b=>{
   b.classList.toggle("active",b.dataset.view===view);
 });
 document.querySelectorAll(".mobileNavBtn[data-mobile-view]").forEach(b=>{
   b.classList.toggle("active",b.dataset.mobileView===view);
 });

 currentView=view;
 if(view==="customers")renderCustomerDirectory();
 if(view==="parts")loadPartsCenter();

 const state={ittr:true,view};
 try{
   if(replace)history.replaceState(state,"",location.href);
   else if(push)history.pushState(state,"",location.href);
 }catch(e){}

 window.scrollTo(0,0);
 updateMobileBackButton();
}

function mobileGoBack(){
 if(closeTopOpenModal())return;
 if(viewHistory.length){
   const previous=viewHistory.pop();
   showView(previous,{push:false});
   return;
 }
 showView(defaultViewForRole(),{push:false});
}

function bindNavigation(){
 document.addEventListener("click",e=>{
   const mobileBtn=e.target.closest(".mobileNavBtn[data-mobile-view]");
   if(mobileBtn){
     e.preventDefault();
     showView(mobileBtn.dataset.mobileView);
     return;
   }

   const desktopBtn=e.target.closest(".navbtn[data-view]");
   if(desktopBtn){
     e.preventDefault();
     showView(desktopBtn.dataset.view);
     return;
   }

   if(e.target.closest("#mobileBackBtn")){
     e.preventDefault();
     mobileGoBack();
   }
 });

 window.addEventListener("popstate",e=>{
   if(getTopOpenModal()){
     closeTopOpenModal();
     return;
   }
   const requested=e.state?.view;
   if(requested && allowedViewForRole(requested)){
     if(viewHistory.length)viewHistory.pop();
     showView(requested,{push:false});
   }else{
     mobileGoBack();
   }
 });
}
function updateOnlineState(){
 const b=document.getElementById("offlineBanner");
 if(b)b.style.display=navigator.onLine?"none":"block";
}
window.addEventListener("online",updateOnlineState);
let lastAppError="";
window.addEventListener("error",e=>{
 const b=document.getElementById("appErrorBanner");
 const t=document.getElementById("appErrorText");
 if(b&&t){
   const msg=e.message||"Unexpected error";
   if(msg!==lastAppError){
     lastAppError=msg;
     t.textContent=msg;
     b.style.display="block";
   }
 }
});
window.addEventListener("unhandledrejection",e=>{
 const b=document.getElementById("appErrorBanner");
 const t=document.getElementById("appErrorText");
 if(b&&t){
   const msg=String(e.reason?.message||e.reason||"Unexpected error");
   if(msg!==lastAppError){
     lastAppError=msg;
     t.textContent=msg;
     b.style.display="block";
   }
 }
});

window.addEventListener("offline",updateOnlineState);

function applyRole(){
 if(session?.username && USERS?.[session.username]?.language){
   currentLanguage=USERS[session.username].language;
 }
  const isAdmin=session?.role==="admin", isMechanic=session?.role==="mechanic";
  document.querySelectorAll(".adminOnly").forEach(el=>el.classList.toggle("hiddenRole",!isAdmin));
  document.querySelectorAll(".mechanicOnly").forEach(el=>el.classList.toggle("hiddenRole",!isMechanic));
  document.getElementById("currentUser").textContent=session?(session.display||session.username):"";
  document.getElementById("currentRole").textContent=session?session.role.toUpperCase():"";
  if(!session) return;
  const firstView=isAdmin?"dashboard":"mechanic";
  viewHistory=[]; currentView=null; showView(firstView,{push:false,replace:true});
}
function showLogin(){
  document.getElementById("loginScreen").style.display=session?"none":"flex";
  if(session) applyRole();
}
document.getElementById("loginForm").onsubmit=async e=>{
  e.preventDefault();
  const u=document.getElementById("loginUser").value.trim();
  const p=document.getElementById("loginPass").value;
  const err=document.getElementById("loginError");err.textContent="Signing in…";
  try{
    const d=await apiJSON("/api/auth/login",{method:"POST",body:JSON.stringify({username:u,password:p})});
    cloudToken=d.token;sessionStorage.setItem("ittr_cloud_token",cloudToken);
    session={username:d.user.username,role:d.user.role,display:d.user.display};
    sessionStorage.setItem("ittr_session",JSON.stringify(session));
    await loadCloudStateAfterLogin();
    err.textContent="";document.getElementById("loginScreen").style.display="none";applyRole();render();
  }catch(ex){err.textContent=ex.message||"Sign in failed."}
};
async function logout(){
  try{if(cloudToken)await apiJSON("/api/auth/logout",{method:"POST",body:"{}"})}catch(_){ }
  cloudToken="";cloudReady=false;session=null;currentView=null;viewHistory=[];
  sessionStorage.removeItem("ittr_cloud_token");sessionStorage.removeItem("ittr_session");
  document.getElementById("loginUser").value="";document.getElementById("loginPass").value="";document.getElementById("loginScreen").style.display="flex";
}
function requireAdmin(){
  if(session?.role!=="admin"){alert(tr("Admin access required."));return false}
  return true;
}
function requireMechanic(){
  if(session?.role!=="mechanic"){alert(tr("Mechanic access required."));return false}
  return true;
}

const today=new Date().toISOString().slice(0,10);

/*
 I18N MAINTENANCE RULE:
 - Add every new system/UI phrase to UI_TRANSLATIONS when building new features.
 - English remains the source language.
 - User-entered truck/customer/job text is not automatically translated.
 - getTranslationAudit() identifies new untranslated interface phrases.
 - Production AI translation should run on the backend, never expose an AI API key in this browser file.
*/
const UI_TRANSLATIONS={
 "Truck & Trailer Repair Operations":"Керування ремонтом вантажівок і причепів",
 "Logout":"Вийти",
 "Calendar":"Календар",
 "Admin Work Orders":"Наряди на роботи",
 "Completed Jobs":"Завершені роботи",
 "Findings":"Зауваження",
 "Mechanic Accounts":"Акаунти механіків",
 "Shop Calendar":"Календар майстерні",
 "Scheduled work orders by day, week, or month.":"Заплановані наряди на день, тиждень або місяць.",
 "+ New Work Order":"+ Новий наряд",
 "Today":"Сьогодні",
 "Day":"День",
 "Week":"Тиждень",
 "Month":"Місяць",
 "Mechanic Live Status":"Поточний статус механіків",
 "See what each mechanic is working on right now.":"Показує, над чим кожен механік працює зараз.",
 "My Work Orders":"Мої наряди",
 "Upcoming / On the Way":"Очікуються / В дорозі",
 "Ready to Work":"Готові до роботи",
 "Truck Is Here":"Трак прибув",
 "View Assignment":"Переглянути завдання",
 "Assigned to you:":"Призначено вам:",
 "No upcoming assigned trucks.":"Немає очікуваних траків.",
 "No trucks ready to work on.":"Немає траків, готових до роботи.",
 "My Completed Work":"Мої завершені роботи",
 "Findings Center":"Центр зауважень",
 "Action Required":"Потрібна дія",
 "Yesterday":"Вчора",
 "Earlier":"Раніше",
 "All History":"Вся історія",
 "All statuses":"Усі статуси",
 "Waiting for Customer":"Очікуємо клієнта",
 "Proceed":"Виконувати",
 "Waiting":"Очікуємо",
 "Do Not Proceed":"Не виконувати",
 "Resolved History":"Вирішено",
 "No findings in this view.":"У цьому розділі немає зауважень.",
 "Inspection / Needs Attention":"Інспекція / Потребує уваги",
 "+ Add Finding":"+ Додати зауваження",
 "Create Work Order":"Створити наряд",
 "Edit Work Order":"Редагувати наряд",
 "Truck / Unit #":"Трак / № юніта",
 "Customer":"Клієнт",
 "Scheduled date":"Запланована дата",
 "Scheduled time":"Запланований час",
 "Assign mechanic":"Призначити механіка",
 "Assigned mechanic":"Призначений механік",
 "Parking spot":"Паркувальне місце",
 "Priority":"Пріоритет",
 "Unit type":"Тип юніта",
 "Customer unit":"Клієнтський трак",
 "Fleet unit":"Власний автопарк",
 "Truck is here":"Трак на місці",
 "Jobs to perform (one per line)":"Роботи для виконання (кожна з нового рядка)",
 "Initial notes":"Початкові примітки",
 "Create Work Order":"Створити наряд",
 "Save Changes":"Зберегти зміни",
 "Assigned Jobs":"Призначені роботи",
 "Notes":"Примітки",
 "Status":"Статус",
 "Open":"Відкрито",
 "In Progress":"В роботі",
 "Completed":"Виконано",
 "Not Completed":"Не виконано",
 "Next Visit":"Наступний візит",
 "Decision Required":"Потрібне рішення",
 "Start":"Почати",
 "Stop":"Зупинити",
 "Complete Work Order":"Завершити наряд",
 "Reactivate / Add Missed Work":"Відновити / Додати пропущену роботу",
 "Mechanic completion notes":"Підсумкові примітки механіка",
 "Future repair / next visit notes":"Майбутній ремонт / наступний візит",
 "Recommended revisit mileage (optional)":"Рекомендований пробіг до повторної перевірки (необов'язково)",
 "Job Outcome":"Результат роботи",
 "Choose outcome":"Оберіть результат",
 "Reason / mechanic note":"Причина / примітка механіка",
 "Save Job Outcome":"Зберегти результат",
 "Change Password":"Змінити пароль",
 "Change Mechanic Password":"Змінити пароль механіка",
 "New password":"Новий пароль",
 "Confirm new password":"Підтвердити новий пароль",
 "Mechanic name":"Ім'я механіка",
 "Username":"Логін",
 "Password":"Пароль",
 "+ Add Mechanic":"+ Додати механіка",
 "Delete":"Видалити",
 "Delete Work Order":"Видалити наряд",
 "Customer decision:":"Рішення клієнта:",
 "Recommended:":"Рекомендовано:",
 "Recommended repair:":"Рекомендований ремонт:",
 "Problem:":"Проблема:",
 "Admin / Customer note":"Примітка адміністратора / клієнта",
 "Save Note":"Зберегти примітку",
 "Add to Work Order":"Додати до наряду",
 "Added to Work Order":"Додано до наряду",
 "Working":"Працює",
 "Idle":"Вільний",
 "No active work assigned.":"Немає активної роботи.",
 "Unit":"Юніт",
 "Labor":"Робочий час",
 "Started":"Почато",
 "Stopped":"Зупинено",
 "Legacy — outcome not recorded":"Старий запис — результат не зафіксовано",
 "Truck marked here":"Трак позначено як прибулий",
 "High":"Високий",
 "Normal":"Звичайний",
 "Low":"Низький",
 "Needs Attention":"Потребує уваги",
 "Safety Critical":"Критично для безпеки",
 "Problem found":"Виявлена проблема",
 "Recommended repair":"Рекомендований ремонт",
 "Photo":"Фото",
 "Save Finding":"Зберегти зауваження",
 "Work Order / Unit":"Наряд / Юніт",
 "Severity":"Серйозність",
 "Admin Controls":"Керування адміністратора",
 "Default account":"Стандартний акаунт",
 "Name":"Ім'я",
 "Role":"Роль",
 "Action":"Дія",
 "Work Orders":"Наряди",
 "Customer / company":"Клієнт / компанія",
 "Mechanic":"Механік",
 "Parking":"Паркування",
 "Completed Work":"Завершені роботи",
 "View":"Переглянути",
 "Edit":"Редагувати",
 "All":"Усі",
 "Future / Waiting":"Майбутні / Очікуються",
 "Truck Here":"Трак на місці",
 "Fleet":"Автопарк",
 "Customer":"Клієнт",
 "Reason":"Причина",
 "Added work":"Додані роботи",
 "Completion Notes":"Підсумкові примітки",
 "Future / Next Visit":"Майбутнє / Наступний візит",
 "Recommended Recheck":"Рекомендована повторна перевірка",
 "Recent History":"Остання історія",
 "Reported":"Повідомлено",
 "Approved Finding":"Схвалене зауваження",
 "Running":"Виконується",
 "On the Way":"В дорозі",
 "Resolved":"Вирішено"
};


Object.assign(UI_TRANSLATIONS,{
 "Work Order":"Наряд",
 "Work Order History":"Історія наряду",
 "Admin Controls":"Керування адміністратора",
 "Assigned Jobs":"Призначені роботи",
 "Notes":"Примітки",
 "Priority:":"Пріоритет:",
 "Status:":"Статус:",
 "Mechanic:":"Механік:",
 "Parking:":"Паркування:",
 "Started:":"Почато:",
 "Stopped:":"Зупинено:",
 "Labor:":"Робочий час:",
 "Truck marked here":"Трак позначено як прибулий",
 "Parking spot #":"Паркувальне місце №",
 "Save Parking Spot":"Зберегти паркувальне місце",
 "Edit Full Work Order":"Редагувати весь наряд",
 "Delete Work Order":"Видалити наряд",
 "Move Back to Future / Not Here":"Повернути в очікування / Трак не прибув",
 "Start Work Order":"Почати наряд",
 "Complete Work Order":"Завершити наряд",
 "Add Inspection Finding":"Додати зауваження інспекції",
 "Reactivate / Add Missed Work":"Відновити / Додати пропущену роботу",
 "Running":"Виконується",
 "Truck Here":"Трак на місці",
 "Waiting for Truck":"Очікуємо трак",
 "Fleet Auto":"Автопарк — автоматично",
 "Reactivated":"Відновлено",
 "Added work:":"Додані роботи:",
 "High":"Високий",
 "Normal":"Звичайний",
 "Low":"Низький",
 "Emergency":"Терміново",
 "Open":"Відкрито",
 "No work orders found.":"Нарядів не знайдено.",
 "No completed work orders yet.":"Завершених нарядів ще немає.",
 "No completed work orders for your account yet.":"У вашому акаунті ще немає завершених нарядів.",
 "No inspection findings yet.":"Зауважень інспекції ще немає.",
 "No findings reported yet.":"Зауважень ще не додано.",
 "Date":"Дата",
 "Time":"Час",
 "Jobs":"Роботи",
 "Actions":"Дії",
 "Display name":"Ім’я для відображення",
 "Create Mechanic Account":"Створити акаунт механіка",
 "Save Password":"Зберегти пароль",
 "Close":"Закрити"
});


Object.assign(UI_TRANSLATIONS,{
 "Truck Search":"Пошук трака",
 "Search":"Пошук",
 "Truck Search / Unit History":"Пошук трака / Історія юніта",
 "Find a truck by unit number, customer, work performed, mechanic notes, future notes, findings, or recommendations.":"Знайдіть трак за номером юніта, клієнтом, виконаними роботами, примітками механіка, майбутніми роботами, зауваженнями або рекомендаціями.",
 "Search truck history":"Пошук в історії трака",
 "All work orders":"Усі наряди",
 "Active / Open":"Активні / Відкриті",
 "Future / Waiting":"Майбутні / Очікуються",
 "Search everything":"Шукати всюди",
 "Notes only":"Тільки примітки",
 "Jobs / repairs only":"Тільки роботи / ремонти",
 "Findings only":"Тільки зауваження",
 "Work Order History":"Історія нарядів",
 "Findings History":"Історія зауважень",
 "Future / Next Visit Notes":"Майбутні роботи / Наступний візит",
 "No matching trucks or history found.":"Нічого не знайдено.",
 "Open Work Order":"Відкрити наряд",
 "Unit Summary":"Інформація про юніт",
 "Last activity":"Остання активність",
 "work orders":"нарядів",
 "findings":"зауважень"
});


Object.assign(UI_TRANSLATIONS,{
 "Current Activity":"Поточна діяльність",
 "Update what you are doing when you are not actively timed on a repair task.":"Оновіть, що ви зараз робите, коли не працюєте над завданням із таймером.",
 "Not Set":"Не вказано",
 "Activity":"Діяльність",
 "Choose activity":"Оберіть діяльність",
 "Cleaning Work Area":"Прибирання робочого місця",
 "In the Yard":"На території / у дворі",
 "Moving Truck / Trailer":"Переміщення трака / причепа",
 "Getting Parts":"Отримання запчастин",
 "Waiting for Parts":"Очікування запчастин",
 "Helping Another Mechanic":"Допомога іншому механіку",
 "General Inspection":"Загальна інспекція",
 "Break":"Перерва",
 "Other":"Інше",
 "Optional note":"Необов’язкова примітка",
 "Update Activity":"Оновити діяльність",
 "Clear / Available":"Очистити / Вільний",
 "Available":"Вільний",
 "Current activity":"Поточна діяльність",
 "Started":"Почато",
 "Activity history":"Історія діяльності"
});


Object.assign(UI_TRANSLATIONS,{
 "Custom Activity":"Власна діяльність",
 "Stop Activity":"Зупинити діяльність",
 "Mechanic Activity History":"Історія діяльності механіків",
 "All Mechanics":"Усі механіки",
 "Yesterday":"Вчора",
 "All Dates":"Усі дати",
 "Still Active":"Ще активна",
 "Activities":"Діяльності",
 "Total Activity Time":"Загальний час діяльності",
 "No activity history found.":"Історію діяльності не знайдено."
});

Object.assign(UI_TRANSLATIONS,{"Operations Center":"Операційний центр","Vehicle Profiles":"Профілі техніки","Maintenance":"Техобслуговування","Productivity":"Продуктивність","Notifications":"Сповіщення","Daily Report":"Щоденний звіт","Audit Log":"Журнал змін","AI Tools":"AI інструменти","Mileage Maintenance":"Обслуговування за пробігом","Make Professional":"Оформити професійно","Suggest Diagnostic Steps":"Запропонувати кроки діагностики","Decode VIN":"Розшифрувати VIN","Official NHTSA vPIC lookup. A complete 17-character VIN automatically fills available vehicle details.":"Офіційна перевірка NHTSA vPIC. Повний 17-значний VIN автоматично заповнює доступні дані автомобіля.","Permanent Vehicle Notes":"Постійні примітки про техніку"});

Object.assign(UI_TRANSLATIONS,{
 "Primary":"Основний",
 "Helper":"Помічник",
 "Helpers":"Помічники",
 "Primary mechanic":"Основний механік",
 "Helper mechanics":"Механіки-помічники",
 "+ Add Helper Mechanic":"+ Додати механіка-помічника",
 "Add Helper Mechanic":"Додати механіка-помічника",
 "Choose a mechanic":"Оберіть механіка",
 "Add Helper":"Додати помічника",
 "Remove":"Видалити",
 "Mechanic Work Summary":"Підсумок роботи механіків",
 "Who worked on each job and their recorded labor time.":"Хто виконував кожну роботу та зафіксований робочий час.",
 "Loading mechanic labor…":"Завантаження робочого часу механіків…",
 "No recorded mechanic labor sessions yet.":"Зафіксованих сесій роботи механіків ще немає.",
 "Total recorded labor":"Загальний зафіксований робочий час",
 "Sessions":"Сесії",
 "Paused":"Призупинено",
 "Resumed":"Продовжено",
 "Finished":"Завершено",
 "Pause":"Призупинити",
 "Resume":"Продовжити",
 "Complete":"Завершити",
 "Pause Job":"Призупинити роботу",
 "Pause reason":"Причина призупинення",
 "End of day":"Кінець робочого дня",
 "Waiting for parts":"Очікування запчастин",
 "Waiting for approval":"Очікування погодження",
 "Need another mechanic":"Потрібен інший механік",
 "Other reason":"Інша причина",
 "Pause note":"Примітка до призупинення",
 "Resume Job":"Продовжити роботу",
 "Work Timeline":"Хронологія роботи",
 "No work timeline for this job yet.":"Для цієї роботи ще немає хронології.",
 "Not Completed / Next Visit":"Не виконано / Наступний візит",
 "This unit is assigned to you but is still marked as on the way.":"Цей юніт призначено вам, але він ще позначений як такий, що в дорозі.",
 "You participated in this work order. Only the primary/completing mechanic can reactivate it.":"Ви брали участь у цьому наряді. Відновити його може лише основний механік або механік, який його завершив.",
 "This work order is not assigned/released to your mechanic account.":"Цей наряд не призначено або не відкрито для вашого акаунта механіка.",
 "Fleet unit auto-release:":"Автоматичний доступ для автопарку:",
 "ON":"УВІМК.",
 "OFF":"ВИМК.",
 "Mark Truck Is Here":"Позначити: трак прибув",
 "Open Unit":"Відкрити юніт",
 "Open Job":"Відкрити роботу",
 "Open Work Order":"Відкрити наряд",
 "View Assignment":"Переглянути завдання",
 "Photo uploaded successfully.":"Фото успішно завантажено.",
 "Preparing photo…":"Підготовка фото…",
 "Uploading photo…":"Завантаження фото…",
 "Upload failed":"Помилка завантаження",
 "Take Photo / Choose Photo":"Зробити / вибрати фото",
 "Choose Photo":"Вибрати фото",
 "Photo evidence":"Фотопідтвердження",
 "No photo":"Немає фото",
 "Date Unknown":"Дата невідома",
 "Admin approved this repair. Complete it once it appears in the work-order task list.":"Адміністратор погодив цей ремонт. Виконайте його після появи в списку робіт наряду.",
 "Do not perform this additional repair.":"Не виконуйте цей додатковий ремонт.",
 "Waiting for admin/customer decision.":"Очікуємо рішення адміністратора / клієнта.",
 "Customer Decision":"Рішення клієнта",
 "Proceed with Repair":"Виконувати ремонт",
 "Wait for Customer":"Очікувати клієнта",
 "Decline Repair":"Не виконувати ремонт",
 "My Work":"Моя робота",
 "History":"Історія",
 "Finding":"Зауваження",
 "Back":"Назад",
 "Menu":"Меню",
 "Ready":"Готово",
 "Scheduled":"Заплановано",
 "Truck On The Way":"Трак у дорозі",
 "Truck Arrived":"Трак прибув",
 "Waiting for Diagnosis":"Очікує діагностики",
 "Diagnosis In Progress":"Діагностика виконується",
 "Waiting for Parts":"Очікує запчастин",
 "Parts Arrived":"Запчастини прибули",
 "Ready for Mechanic":"Готовий для механіка",
 "QC Inspection":"Контроль якості",
 "Ready for Pickup":"Готовий до видачі",
 "Invoiced":"Рахунок виставлено",
 "Paid":"Оплачено",
 "Vehicle Profile":"Профіль техніки",
 "Year":"Рік",
 "Make":"Марка",
 "Model":"Модель",
 "Plate":"Номерний знак",
 "Engine":"Двигун",
 "Transmission":"Трансмісія",
 "Mileage":"Пробіг",
 "VIN":"VIN",
 "Service":"Обслуговування",
 "Interval":"Інтервал",
 "Last Service Mileage":"Пробіг останнього ТО",
 "Due Soon":"Скоро потрібно",
 "Overdue":"Прострочено",
 "OK":"OK",
 "Daily Shop Report":"Щоденний звіт майстерні",
 "Active Work Orders":"Активні наряди",
 "Completed Today":"Завершено сьогодні",
 "Mechanics Working":"Механіків працює",
 "Download Work Order PDF":"Завантажити PDF наряду",
 "Work Order PDF":"PDF наряду",
 "Completed By":"Завершив",
 "Completed At":"Завершено",
 "Initial Notes":"Початкові примітки",
 "Future Repair / Next Visit":"Майбутній ремонт / Наступний візит",
 "Recheck Mileage":"Пробіг для повторної перевірки",
 "Findings / Recommendations":"Зауваження / Рекомендації",
 "Task":"Робота",
 "Outcome":"Результат",
 "Mechanics":"Механіки",
 "Recorded Labor":"Зафіксований робочий час",
 "No findings recorded.":"Зауважень не зафіксовано.",
 "No notes recorded.":"Приміток не зафіксовано.",
 "Parts Used":"Використані запчастини",
 "Part Number":"Номер запчастини",
 "Part Description":"Опис запчастини",
 "Description":"Опис",
 "Qty":"К-сть",
 "Add Part":"Додати запчастину",
 "No parts recorded for this job.":"Для цієї роботи запчастини не вказані.",
 "Enter a part number or description.":"Введіть номер запчастини або опис.",
 "Part added.":"Запчастину додано.",
 "Remove part?":"Видалити запчастину?",
 "Added by":"Додав",
 "Repair / Service & Parts":"Ремонт / Роботи та запчастини"
});

const UI_PLACEHOLDER_TRANSLATIONS={
 "Type your activity...":"Введіть свою діяльність...",
 "Example: cleaning bay 2, checking trailers in yard...":"Наприклад: прибираю пост 2, перевіряю причепи у дворі...",
 "Example: 123, air leak, brakes, PM service, future repair...":"Наприклад: 123, витік повітря, гальма, PM service, майбутній ремонт...",
 "Search unit, customer, problem...":"Пошук за юнітом, клієнтом або проблемою...",
 "Customer / company":"Клієнт / компанія",
 "Unit 214":"Юніт 214",
 "P-12":"P-12",
 "PM service\nCheck engine light\nReplace front brake shoes":"ТО / PM service\nПеревірити Check Engine\nЗамінити передні гальмівні колодки",
 "Customer complaint, parts status, special instructions...":"Скарга клієнта, статус запчастин, особливі інструкції...",
 "Example: RH steer tire has sidewall damage":"Наприклад: праве кермове колесо має пошкодження боковини",
 "Replace tire before vehicle leaves shop":"Замінити колесо до виїзду трака з майстерні",
 "Customer decision, authorization, follow-up...":"Рішення клієнта, дозвіл, подальші дії...",
 "What was done, anything unusual, anything customer should know":"Що було виконано, незвичні моменти, що потрібно повідомити клієнту",
 "Example: Front brakes approx. 30% remaining — recheck in 10,000 miles":"Наприклад: передні гальма приблизно 30% — перевірити через 10 000 миль",
 "Example: 10000":"Наприклад: 10000",
 "Why was this not completed? What needs to be done next time?":"Чому роботу не виконано? Що потрібно зробити наступного разу?"
};

let currentLanguage=localStorage.getItem("ittr_language")||"en";
const untranslatedUIPhrases=new Set();

function tr(text){return currentLanguage==="uk"?(UI_TRANSLATIONS[text]||text):text;}

function translateExact(text){
 if(currentLanguage!=="uk")return text;
 return UI_TRANSLATIONS[text]||text;
}

function translateDynamicText(text){
 if(currentLanguage!=="uk")return text;
 const exact=UI_TRANSLATIONS[text];
 if(exact)return exact;

 // Common dynamic UI phrases.
 let m;
 if((m=text.match(/^(\d+) finding(s?)$/))) return `${m[1]} ${Number(m[1])===1?"зауваження":"зауважень"}`;
 if((m=text.match(/^(\d+) action required$/))) return `Потрібна дія: ${m[1]}`;
 if((m=text.match(/^(\d+) upcoming assigned truck(s?)$/))) return `Очікуваних призначених траків: ${m[1]}`;
 if((m=text.match(/^Unit (.+)$/))) return `Юніт ${m[1]}`;
 if((m=text.match(/^Work Order #(.+)$/))) return `Наряд #${m[1]}`;
 if((m=text.match(/^Parking (.+)$/))) return `Паркування ${m[1]}`;
 if((m=text.match(/^Remove (.+)$/))) return `Видалити ${m[1]}`;
 if((m=text.match(/^(\d+) helpers?$/))) return `Помічників: ${m[1]}`;
 if((m=text.match(/^(\d+) sessions?$/))) return `Сесій: ${m[1]}`;

 return text;
}

function shouldTranslateTextNode(node){
 const parent=node.parentElement;
 if(!parent)return false;
 if(["SCRIPT","STYLE","TEXTAREA","INPUT","OPTION"].includes(parent.tagName))return false;
 return true;
}

function applyTranslations(){
 document.documentElement.lang=currentLanguage==="uk"?"uk":"en";
 const selector=document.getElementById("languageSelect");
 if(selector)selector.value=currentLanguage;

 const reverse=Object.fromEntries(Object.entries(UI_TRANSLATIONS).map(([en,uk])=>[uk,en]));
 const placeholderReverse=Object.fromEntries(Object.entries(UI_PLACEHOLDER_TRANSLATIONS).map(([en,uk])=>[uk,en]));

 const dynamicTranslate=(text)=>{
   const source=reverse[text]||text;
   if(currentLanguage!=="uk")return source;
   if(UI_TRANSLATIONS[source])return UI_TRANSLATIONS[source];
   let x;
   if((x=source.match(/^Work Order #(\d+) — (.+)$/)))return `Наряд #${x[1]} — ${x[2]}`;
   if((x=source.match(/^Unit (.+)$/)))return `Юніт ${x[1]}`;
   if((x=source.match(/^(\d+) finding(s?)$/)))return `${x[1]} ${Number(x[1])===1?"зауваження":"зауважень"}`;
   if((x=source.match(/^(\d+) action required$/)))return `Потрібна дія: ${x[1]}`;
   if((x=source.match(/^(\d+) job(s?)$/)))return `${x[1]} ${Number(x[1])===1?"робота":"роботи"}`;
   return source;
 };

 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 const nodes=[];
 while(walker.nextNode())nodes.push(walker.currentNode);
 nodes.forEach(node=>{
   const p=node.parentElement;
   if(!p||["SCRIPT","STYLE","TEXTAREA","INPUT"].includes(p.tagName))return;
   const raw=node.nodeValue, trimmed=raw.trim();
   if(!trimmed)return;
   const translated=dynamicTranslate(trimmed);
   node.nodeValue=raw.replace(trimmed,translated);
 });

 document.querySelectorAll("input[placeholder],textarea[placeholder]").forEach(el=>{
   const source=placeholderReverse[el.placeholder]||el.dataset.i18nPlaceholderSource||el.placeholder;
   el.dataset.i18nPlaceholderSource=source;
   el.placeholder=currentLanguage==="uk"?(UI_PLACEHOLDER_TRANSLATIONS[source]||UI_TRANSLATIONS[source]||source):source;
 });

 const aiToggle=document.getElementById("aiTranslateEnabled");
 if(aiToggle)aiToggle.checked=aiTranslationEnabled;
 if(currentLanguage==="uk")scheduleAITranslation();
}

function setLanguage(lang){
 currentLanguage=lang==="uk"?"uk":"en";
 localStorage.setItem("ittr_language",currentLanguage);
 if(typeof session!=="undefined" && session?.username && typeof USERS!=="undefined" && USERS[session.username]){
   USERS[session.username].language=currentLanguage;
   saveUsers();
 }
 render();
 applyTranslations();

 if(currentLanguage==="uk")scheduleAITranslation();
}

function getTranslationAudit(){
 return {
   language:currentLanguage,
   untranslated:[...untranslatedUIPhrases].sort()
 };
}


/* ==========================================================
   AI TRANSLATION LAYER
   ----------------------------------------------------------
   - Uses local Ukrainian dictionary first.
   - Sends only missing English text to POST /api/translate.
   - Never stores an API key in the browser.
   - Caches translations in localStorage.
   - Watches newly rendered DOM and translates it automatically.
   - Keeps input/textarea values unchanged so original repair
     notes and work descriptions are never overwritten.
   ========================================================== */
const AI_TRANSLATION_ENDPOINT="/api/translate";
function runningFromFileProtocol(){return location.protocol==="file:"}

let aiTranslationEnabled=localStorage.getItem("ittr_ai_translation")!=="false";
let aiTranslationBusy=0;
let aiObserver=null;
let aiTranslationTimer=null;
let aiApplying=false;
const aiTranslationPending=new Set();

function aiCacheLoad(){
 try{return JSON.parse(localStorage.getItem("ittr_ai_translation_cache")||"{}")}catch(e){return {}}
}
function aiCacheSave(cache){
 try{localStorage.setItem("ittr_ai_translation_cache",JSON.stringify(cache))}catch(e){}
}
let aiTranslationCache=aiCacheLoad();

function setAITranslationEnabled(enabled){
 aiTranslationEnabled=!!enabled;
 localStorage.setItem("ittr_ai_translation",aiTranslationEnabled?"true":"false");
 const el=document.getElementById("aiTranslateEnabled");
 if(el)el.checked=aiTranslationEnabled;
 if(aiTranslationEnabled && currentLanguage==="uk")scheduleAITranslation();
}

function updateAITranslationStatus(){
 const el=document.getElementById("aiTranslationStatus");
 if(!el)return;
 el.textContent=currentLanguage==="uk"
   ?(aiTranslationBusy>0?"AI перекладає…":"AI переклад увімкнено")
   :(aiTranslationBusy>0?"AI translating…":"AI translation enabled");
 el.classList.toggle("show",aiTranslationBusy>0);
}

function looksEnglishText(text){
 const s=String(text||"").trim();
 if(!s || s.length<2)return false;
 if(!/[A-Za-z]/.test(s))return false;
 if(/^https?:\/\//i.test(s))return false;
 if(/^[A-Z0-9#_.\-\/]+$/.test(s) && !/\s/.test(s))return false; // IDs / unit-like tokens
 return true;
}

function shouldAITranslateNode(node){
 if(!node || node.nodeType!==Node.TEXT_NODE)return false;
 const p=node.parentElement;
 if(!p)return false;
 if(["SCRIPT","STYLE","TEXTAREA","INPUT","CODE","PRE"].includes(p.tagName))return false;
 if(p.closest("[data-no-ai-translate]"))return false;
 return looksEnglishText(node.nodeValue);
}

function sourceTextForAI(raw){
 return String(raw||"").trim();
}

function localDictionaryTranslation(source){
 if(typeof UI_TRANSLATIONS!=="undefined" && UI_TRANSLATIONS[source])return UI_TRANSLATIONS[source];
 return "";
}

async function requestAITranslation(text){
 const cacheKey=`uk|${text}`;
 if(aiTranslationCache[cacheKey])return aiTranslationCache[cacheKey];

 const local=localDictionaryTranslation(text);
 if(local){
   aiTranslationCache[cacheKey]=local;
   aiCacheSave(aiTranslationCache);
   return local;
 }

 aiTranslationBusy++;
 updateAITranslationStatus();
 try{
   const response=await fetch(AI_TRANSLATION_ENDPOINT,{
     method:"POST",
     headers:authHeaders({"Content-Type":"application/json"}),
     body:JSON.stringify({
       text,
       sourceLanguage:"English",
       targetLanguage:"Ukrainian",
       domain:"semi-truck and trailer repair shop software"
     })
   });
   if(!response.ok)throw new Error(`Translation server returned ${response.status}`);
   const data=await response.json();
   const translated=String(data.translation||"").trim();
   if(!translated)throw new Error("Empty AI translation");
   aiTranslationCache[cacheKey]=translated;
   aiCacheSave(aiTranslationCache);
   return translated;
 }finally{
   aiTranslationBusy=Math.max(0,aiTranslationBusy-1);
   updateAITranslationStatus();
 }
}

async function translateTextNodeWithAI(node){
 if(currentLanguage!=="uk" || !aiTranslationEnabled || !shouldAITranslateNode(node))return;
 const raw=node.nodeValue;
 const source=sourceTextForAI(raw);
 if(!source || aiTranslationPending.has(source))return;

 const local=localDictionaryTranslation(source);
 if(local){
   node.nodeValue=raw.replace(source,local);
   return;
 }

 aiTranslationPending.add(source);
 try{
   const translated=await requestAITranslation(source);
   // Node may have been replaced by a render while request was running.
   if(node.isConnected && currentLanguage==="uk" && node.nodeValue.includes(source)){
     aiApplying=true;
     node.nodeValue=node.nodeValue.replace(source,translated);
     aiApplying=false;
   }
 }catch(err){
   // Fail quietly: keep the original English text.
   console.warn("AI translation unavailable:",err.message||err);
 }finally{
   aiTranslationPending.delete(source);
 }
}

async function translateVisibleDOMWithAI(){
 if(currentLanguage!=="uk" || !aiTranslationEnabled)return;
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 const nodes=[];
 while(walker.nextNode()){
   const n=walker.currentNode;
   if(shouldAITranslateNode(n))nodes.push(n);
 }
 // Limit concurrency to keep phones responsive.
 const concurrency=3;
 let index=0;
 async function worker(){
   while(index<nodes.length){
     const n=nodes[index++];
     await translateTextNodeWithAI(n);
   }
 }
 await Promise.all(Array.from({length:Math.min(concurrency,nodes.length||1)},worker));
}

function scheduleAITranslation(){
 if(!aiTranslationEnabled || currentLanguage!=="uk")return;
 clearTimeout(aiTranslationTimer);
 aiTranslationTimer=setTimeout(()=>translateVisibleDOMWithAI(),180);
}

function startAITranslationObserver(){
 if(aiObserver)return;
 aiObserver=new MutationObserver(mutations=>{
   if(aiApplying || !aiTranslationEnabled || currentLanguage!=="uk")return;
   let needs=false;
   for(const m of mutations){
     if(m.type==="childList" && m.addedNodes.length){needs=true;break}
     if(m.type==="characterData"){needs=true;break}
   }
   if(needs)scheduleAITranslation();
 });
 aiObserver.observe(document.body,{childList:true,subtree:true,characterData:true});
}

function clearAITranslationCache(){
 aiTranslationCache={};
 localStorage.removeItem("ittr_ai_translation_cache");
}


const seed=[];

let state=JSON.parse(localStorage.getItem("ittr_shopflow_v2")||"null")||{workorders:seed,issues:[]};

/*
 Remove prototype/demo work orders that may already be saved in a browser.
 These records shipped with earlier builds and were never user-created.
 The fingerprint intentionally requires the known demo ID + unit/customer/tasks
 so a genuine user-created work order will not be removed just because it shares an ID.
*/
const DEMO_WORK_ORDER_FINGERPRINTS=[
 {id:1001,unit:"Truck 214",customer:"ABC Logistics",tasks:["PM service","Inspect brakes","Diagnose air leak"]},
 {id:1002,unit:"Truck 327",customer:"Owner Operator",tasks:["Valve adjustment","Relative compression test"]},
 {id:1003,unit:"Fleet 55",customer:"ITTR Fleet",tasks:["Annual inspection","Oil service"]}
];
function isPrototypeDemoWorkOrder(w){
 return DEMO_WORK_ORDER_FINGERPRINTS.some(d=>{
   if(Number(w?.id)!==d.id)return false;
   if(String(w?.unit||"")!==d.unit)return false;
   if(String(w?.customer||"")!==d.customer)return false;
   const names=(w?.tasks||[]).map(t=>String(t?.t||""));
   return d.tasks.every(name=>names.includes(name));
 });
}
const beforeDemoCleanup=(state.workorders||[]).length;
state.workorders=(state.workorders||[]).filter(w=>!isPrototypeDemoWorkOrder(w));
if(state.workorders.length!==beforeDemoCleanup){
 localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));
}



(state.issues||[]).forEach(i=>{
 if(!i.createdAt){
   const d=new Date(i.created||"");
   i.createdAt=!isNaN(d)?d.toISOString():"";
 }
 const w=state.workorders.find(x=>x.id==i.wo);
 if(typeof i.unitSnapshot==="undefined")i.unitSnapshot=w?.unit||"";
 if(typeof i.customerSnapshot==="undefined")i.customerSnapshot=w?.customer||"";
 if(typeof i.mechanic==="undefined")i.mechanic="";
 if(typeof i.decisionAt==="undefined")i.decisionAt="";
 if(typeof i.decisionBy==="undefined")i.decisionBy="";
});
(state.workorders||[]).forEach(w=>{
 if(typeof w.outcomeWorkflowVersion==="undefined"){
   // Already-completed records predate the mandatory outcome workflow.
   // Active records will use the new workflow the next time they are completed.
   w.outcomeWorkflowVersion=w.status==="Completed"?0:1;
 }
 if(!Array.isArray(w.history))w.history=[];
 if(typeof w.completionNotes==="undefined")w.completionNotes="";
 if(typeof w.futureNotes==="undefined")w.futureNotes="";
 if(typeof w.revisitMiles==="undefined")w.revisitMiles="";
 if(typeof w.completedBy==="undefined")w.completedBy=w.status==="Completed"?(w.mechanic||""):"";
 if(typeof w.reactivationCount==="undefined")w.reactivationCount=0;
 if(typeof w.reactivatedBy==="undefined")w.reactivatedBy="";
 if(typeof w.reactivatedAt==="undefined")w.reactivatedAt="";
 if(typeof w.isReactivated==="undefined")w.isReactivated=false;
 if(typeof w.arrivedAt==="undefined")w.arrivedAt="";
 if(typeof w.arrivedBy==="undefined")w.arrivedBy="";
 if(!Array.isArray(w.helpers))w.helpers=[];
 w.helpers=[...new Set(w.helpers.map(x=>String(x||"").trim().toLowerCase()).filter(x=>x&&x!==String(w.mechanic||"").toLowerCase()))];
 (w.tasks||[]).forEach(t=>{
   if(typeof t.startedAt==="undefined")t.startedAt="";
   if(typeof t.stoppedAt==="undefined")t.stoppedAt="";
   if(typeof t.elapsedMs==="undefined")t.elapsedMs=0;
   if(typeof t.completedAt==="undefined")t.completedAt=t.done?(t.stoppedAt||""):"";
   if(typeof t.taskOutcome==="undefined")t.taskOutcome=t.done?"completed":"";
   if(typeof t.outcomeNote==="undefined")t.outcomeNote="";
   if(!Array.isArray(t.parts))t.parts=[];
   if(typeof t.outcomeAt==="undefined")t.outcomeAt="";
   if(typeof t.outcomeBy==="undefined")t.outcomeBy="";
   if(typeof t.runningBy==="undefined")t.runningBy=(t.startedAt&&!t.stoppedAt&&!t.done)?(w.mechanic||""):"";
 });
});
save();

let adminFilter="all";
function save(){localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));queueCloudState("shopflow",state)}
function esc(s){return String(s??"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]))}
function readyForMechanic(w){return w.status!=="Completed" && (w.unitType==="fleet" ? w.fleetAuto!==false : !!w.truckHere)}
function assignedMechanicUsernames(w){
 const primary=String(w?.mechanic||"").trim().toLowerCase();
 const helpers=Array.isArray(w?.helpers)?w.helpers.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean):[];
 return [...new Set([primary,...helpers].filter(Boolean))];
}
function mechanicAssignedToWorkOrder(w,username){return assignedMechanicUsernames(w).includes(String(username||"").trim().toLowerCase())}
function mechanicAssignmentsLabel(w){
 const names=assignedMechanicUsernames(w).map(u=>mechanicDisplay(u)).filter(Boolean);
 return names.length?names.join(", "):"Unassigned";
}
function assignmentChips(w){
 const primary=String(w?.mechanic||"").toLowerCase();
 return assignedMechanicUsernames(w).map(u=>`<span class="assignmentChip ${u===primary?"primary":""}">${u===primary?"Primary · ":"Helper · "}${esc(mechanicDisplay(u))}</span>`).join("");
}
function assignedToCurrentMechanic(w){
 if(session?.role!=="mechanic")return false;
 if(w.status==="Completed")return false;
 return mechanicAssignedToWorkOrder(w,session.username);
}
function visibleToCurrentMechanic(w){
 if(!assignedToCurrentMechanic(w))return false;
 if(w.isReactivated && String(w.reactivatedBy||"").toLowerCase()===String(session.username||"").toLowerCase())return true;
 return readyForMechanic(w);
}
function upcomingForCurrentMechanic(w){
 if(!assignedToCurrentMechanic(w))return false;
 if(w.isReactivated)return false;
 if(w.unitType==="fleet")return w.fleetAuto===false;
 return !w.truckHere;
}
function availabilityBadge(w){
 if(w.unitType==="fleet" && w.fleetAuto!==false) return '<span class="badge b-here">Fleet Auto</span>';
 if(w.truckHere) return '<span class="badge b-here">Truck Here</span>';
 return '<span class="badge b-future">Waiting for Truck</span>';
}
function statusBadge(s){let c=s==="Completed"?"b-done":s==="In Progress"?"b-progress":"b-open";return `<span class="badge ${c}">${esc(s)}</span>`}
function priorityBadge(s){let c=(s==="High"||s==="Emergency")?"b-high":"b-low";return `<span class="badge ${c}">${esc(s)}</span>`}

function mechanicOptions(selected=""){
 const accounts=mechanicAccounts();
 if(!accounts.length)return '<option value="">No mechanic accounts</option>';
 return accounts.map(m=>`<option value="${esc(m.username)}" ${m.username===selected?"selected":""}>${esc(m.display)} (${esc(m.username)})</option>`).join("");
}
function refreshMechanicSelects(selectedEdit=""){
 const n=document.getElementById("newMechanicSelect");
 if(n)n.innerHTML=mechanicOptions(n.value||"");
 const e=document.getElementById("editMechanic");
 if(e)e.innerHTML=mechanicOptions(selectedEdit||e.value||"");
}

function openAddHelper(workOrderId){
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
 if(!w)return alert(tr("Work order not found."));
 if(session?.role!=="admin" && !mechanicAssignedToWorkOrder(w,session?.username))return alert(tr("You are not assigned to this work order."));
 const assigned=new Set(assignedMechanicUsernames(w));
 const available=mechanicAccounts().filter(m=>!assigned.has(String(m.username||"").toLowerCase()));
 if(!available.length)return alert(tr("Every mechanic is already assigned to this work order."));
 const sel=document.getElementById("helperMechanicSelect");
 sel.innerHTML=available.map(m=>`<option value="${esc(m.username)}">${esc(m.display)} (${esc(m.username)})</option>`).join("");
 document.getElementById("helperWorkOrderId").value=workOrderId;
 document.getElementById("helperModal").classList.add("open");
 updateMobileBackButton();
}
async function addHelperMechanic(workOrderId,username){
 try{
  const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/helpers`,{method:"POST",body:JSON.stringify({username})});
  if(d?.shopflow){state=d.shopflow;localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));}
  if(d?.version!=null)cloudVersions.shopflow=Number(d.version);
  closeModal("helperModal");render();openDetail(Number(workOrderId));
 }catch(e){alert(e.message||"Could not add helper mechanic.")}
}
async function removeHelperMechanic(workOrderId,username){
 if(!confirm(`Remove ${mechanicDisplay(username)} from this work order?`))return;
 try{
  const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/helpers/${encodeURIComponent(username)}`,{method:"DELETE"});
  if(d?.shopflow){state=d.shopflow;localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));}
  if(d?.version!=null)cloudVersions.shopflow=Number(d.version);
  render();openDetail(Number(workOrderId));
 }catch(e){alert(e.message||"Could not remove helper mechanic.")}
}
function openMechanicAccount(){
 if(!requireAdmin())return;
 document.getElementById("mechanicAccountForm").reset();
 document.getElementById("mechanicAccountModal").classList.add("open");
}
document.getElementById("mechanicAccountForm").onsubmit=async e=>{
 e.preventDefault();if(!requireAdmin())return;
 const f=new FormData(e.target),username=String(f.get("username")||"").trim().toLowerCase(),display=String(f.get("display")||"").trim(),password=String(f.get("password")||"");
 if(!username||!display||!password)return;
 try{await apiJSON("/api/admin/users",{method:"POST",body:JSON.stringify({username,display,password})});USERS[username]={role:"mechanic",display,activityHistory:[],currentActivity:{code:"",note:"",startedAt:""}};saveUsers();closeModal("mechanicAccountModal");render()}catch(ex){alert(ex.message)}
};
async function deleteMechanicAccount(username){
 if(!requireAdmin())return;
 const assigned=(state.workorders||[]).some(w=>w.status!=="Completed"&&mechanicAssignedToWorkOrder(w,username));if(assigned)return alert(tr("This mechanic still has active assigned work orders. Reassign or remove them first."));
 if(confirm(`Delete mechanic account ${username}?`))try{await apiJSON(`/api/admin/users/${encodeURIComponent(username)}`,{method:"DELETE"});delete USERS[username];saveUsers();render()}catch(ex){alert(ex.message)}
}

function openChangeMechanicPassword(username){
 if(!requireAdmin())return;
 const user=USERS[username];
 if(!user || user.role!=="mechanic")return alert(tr("Mechanic account not found."));
 const form=document.getElementById("passwordForm");
 form.elements["username"].value=username;
 form.elements["password"].value="";
 form.elements["confirmPassword"].value="";
 document.getElementById("passwordModalTitle").textContent=`Change Password — ${user.display||username}`;
 document.getElementById("passwordModal").classList.add("open");
 updateMobileBackButton();
}


function activityHistoryDateKey(iso){const d=new Date(iso);if(isNaN(d))return "";return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function activityHistoryDurationMs(r){const s=new Date(r.startedAt||""),e=r.endedAt?new Date(r.endedAt):new Date();return isNaN(s)||isNaN(e)?0:Math.max(0,e-s)}
function activityHistoryDurationLabel(ms){const t=Math.floor(ms/1000),h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;return h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`}
function refreshActivityHistoryMechanicFilter(){
 const el=document.getElementById("activityHistoryMechanicFilter");if(!el)return;
 const old=el.value||"all",mechs=mechanicAccounts();
 el.innerHTML=`<option value="all">All Mechanics</option>`+mechs.map(u=>`<option value="${esc(u.username)}">${esc(u.display||u.username)}</option>`).join("");
 el.value=mechs.some(u=>u.username===old)?old:"all";
}
function setActivityHistoryToday(){const e=document.getElementById("activityHistoryDateFilter");if(e)e.value=activityHistoryDateKey(new Date().toISOString());renderMechanicActivityHistory()}
function setActivityHistoryYesterday(){const d=new Date();d.setDate(d.getDate()-1);const e=document.getElementById("activityHistoryDateFilter");if(e)e.value=activityHistoryDateKey(d.toISOString());renderMechanicActivityHistory()}
function clearActivityHistoryDate(){const e=document.getElementById("activityHistoryDateFilter");if(e)e.value="";renderMechanicActivityHistory()}
function renderMechanicActivityHistory(){
 if(session?.role!=="admin")return;
 const box=document.getElementById("activityHistoryResults"),sum=document.getElementById("activityHistorySummary");if(!box||!sum)return;
 refreshActivityHistoryMechanicFilter();
 const users=USERS,mf=document.getElementById("activityHistoryMechanicFilter")?.value||"all",df=document.getElementById("activityHistoryDateFilter")?.value||"";
 let rows=[];
 Object.entries(users||{}).forEach(([username,u])=>{
  if(u.role!=="mechanic"||(mf!=="all"&&username!==mf))return;
  (Array.isArray(u.activityHistory)?u.activityHistory:[]).forEach(r=>{const dateKey=activityHistoryDateKey(r.startedAt);if(!df||dateKey===df)rows.push({username,display:u.display||username,...r,dateKey})});
 });
 rows.sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt));
 const total=rows.reduce((s,r)=>s+activityHistoryDurationMs(r),0);
 sum.innerHTML=`<div class="activityHistorySummaryGrid"><div class="activityHistorySummaryCard"><div class="muted">Activities</div><div class="metricValue">${rows.length}</div></div><div class="activityHistorySummaryCard"><div class="muted">Total Activity Time</div><div class="metricValue">${activityHistoryDurationLabel(total)}</div></div><div class="activityHistorySummaryCard"><div class="muted">Mechanics</div><div class="metricValue">${new Set(rows.map(r=>r.username)).size}</div></div></div>`;
 if(!rows.length){box.innerHTML='<div class="truckSearchEmpty">No activity history found.</div>';applyTranslations();return}
 const days={};rows.forEach(r=>(days[r.dateKey]??=[]).push(r));
 box.innerHTML=Object.keys(days).sort().reverse().map(day=>{
  const recs=days[day],by={};recs.forEach(r=>(by[r.username]??=[]).push(r));
  return `<div class="activityDayGroup"><div class="activityDayHeader"><b>${new Date(day+"T12:00:00").toLocaleDateString(currentLanguage==="uk"?"uk-UA":"en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</b><span class="activityHistoryDuration">${activityHistoryDurationLabel(recs.reduce((s,r)=>s+activityHistoryDurationMs(r),0))}</span></div>${Object.entries(by).map(([username,list])=>`<div class="activityMechanicGroup"><div style="display:flex;justify-content:space-between;gap:10px"><div><b>${esc(list[0].display)}</b><div class="muted">@${esc(username)}</div></div><b>${activityHistoryDurationLabel(list.reduce((s,r)=>s+activityHistoryDurationMs(r),0))}</b></div>${list.sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt)).map(r=>`<div class="activityTimelineRow"><div><b>${new Date(r.startedAt).toLocaleTimeString(currentLanguage==="uk"?"uk-UA":"en-US",{hour:"numeric",minute:"2-digit"})}</b><div class="muted">${r.endedAt?new Date(r.endedAt).toLocaleTimeString(currentLanguage==="uk"?"uk-UA":"en-US",{hour:"numeric",minute:"2-digit"}):translateDynamicText("Still Active")}</div></div><div><div class="activityTimelineName">${esc(translateDynamicText(mechanicActivityLabel(r.code,r.customText)))}</div>${r.note?`<div class="muted">${esc(r.note)}</div>`:""}</div><div class="activityHistoryDuration">${activityHistoryDurationLabel(activityHistoryDurationMs(r))}</div></div>`).join("")}</div>`).join("")}</div>`;
 }).join("");
 applyTranslations();if(currentLanguage==="uk"&&typeof scheduleAITranslation==="function")scheduleAITranslation();
}

function renderMechanicAccounts(){
 const box=document.getElementById("mechanicAccountsTable");
 if(!box)return;
 const rows=mechanicAccounts().map(m=>`<tr>
   <td>${esc(m.display)}</td>
   <td>${esc(m.username)}</td>
   <td>Mechanic</td>
   <td>
     <button class="secondary" data-username="${encodeURIComponent(m.username)}" onclick="openChangeMechanicPassword(decodeURIComponent(this.dataset.username))">Change Password</button>
     ${m.username==="mechanic"?'<span class="muted"> Default account</span>':`<button class="danger" data-username="${encodeURIComponent(m.username)}" onclick="deleteMechanicAccount(decodeURIComponent(this.dataset.username))">Delete</button>`}
   </td>
 </tr>`).join("");
 box.innerHTML=rows||'<tr><td colspan="4" class="muted">No mechanic accounts created.</td></tr>';
}


function workOrderHistoryEntry(type,data={}){
 return {
   type,
   at:new Date().toISOString(),
   by:session?.username||"",
   byDisplay:session?.display||session?.username||"",
   ...data
 };
}
function mechanicCompletedCard(w){
 const history=(w.history||[]).slice().reverse();
 const latestHistory=history.slice(0,5).map(h=>{
   if(h.type==="reactivated"){
     return `<div class="historyitem"><b>Reactivated</b> · ${fmtDateTime(h.at)}<div class="muted">By ${esc(h.byDisplay||h.by||"Mechanic")}</div><div>${esc(h.reason||"")}</div>${(h.addedTasks||[]).length?`<div class="muted">Added: ${(h.addedTasks||[]).map(esc).join(", ")}</div>`:""}</div>`;
   }
   if(h.type==="completed"){
     return `<div class="historyitem"><b>Completed</b> · ${fmtDateTime(h.at)}<div class="muted">By ${esc(h.byDisplay||h.by||"Mechanic")}</div></div>`;
   }
   return "";
 }).join("");

 return `<div class="card">
   <div class="jobtop">
     <div><b>Unit ${esc(w.unit)}</b><div class="muted">${esc(w.customer||"")} · Parking ${esc(w.parking||"—")}</div></div>
     <span class="badge b-done">Completed</span>
   </div>
   <div style="margin-top:10px">
     ${(w.tasks||[]).map(t=>`<div class="muted">${normalizedTaskOutcome(t)==="completed"?"✓":normalizedTaskOutcome(t)==="next_visit"?"↻":normalizedTaskOutcome(t)==="not_completed"?"✕":"•"} ${esc(t.t)} — ${esc(normalizedTaskOutcome(t)?taskOutcomeLabel(t):(Number(w.outcomeWorkflowVersion||0)===0?"Legacy — outcome not recorded":"Decision Required"))}${t.elapsedMs?` · ${fmtDuration(taskElapsed(t))}`:""}${t.outcomeNote?` · ${esc(t.outcomeNote)}`:""}${t.outcomeBy?` · By ${esc(mechanicDisplay(t.outcomeBy))}`:""}</div>`).join("")}
   </div>
   ${w.completionNotes?`<div class="futureNote"><b>Completion notes</b><div>${esc(w.completionNotes)}</div></div>`:""}
   ${w.futureNotes?`<div class="futureNote"><b>Future / next visit</b><div>${esc(w.futureNotes)}</div>${w.revisitMiles?`<div class="muted">Recommended recheck in ${esc(String(w.revisitMiles))} miles</div>`:""}</div>`:""}
   ${w.reactivationCount?`<div class="reactivated"><b>Reactivated ${w.reactivationCount} time${w.reactivationCount===1?"":"s"}</b></div>`:""}
   ${latestHistory?`<div style="margin-top:10px"><b>Recent history</b>${latestHistory}</div>`:""}
   <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
     <button onclick="openDetail(${w.id})">View</button>
     ${(w.completedBy===session.username || w.mechanic===session.username)?`<button class="secondary" onclick="openReactivate(${w.id})">Reactivate / Add Missed Work</button>`:""}
   </div>
 </div>`;
}
function renderMyCompleted(){
 const box=document.getElementById("myCompletedJobs");
 if(!box || session?.role!=="mechanic")return;
 const mine=(state.workorders||[])
   .filter(w=>w.status==="Completed" && (w.completedBy===session.username || mechanicAssignedToWorkOrder(w,session.username) || (w.tasks||[]).some(t=>t.outcomeBy===session.username)))
   .sort((a,b)=>new Date(b.completedAt||0)-new Date(a.completedAt||0));
 box.innerHTML=mine.map(mechanicCompletedCard).join("")||'<div class="card empty">You have no completed work orders yet.</div>';
}
function openReactivate(id){
 if(!requireMechanic())return;
 const w=state.workorders.find(x=>x.id===id);
 if(!w || w.status!=="Completed")return;
 if(!(w.completedBy===session.username || w.mechanic===session.username))return alert(tr("You can only reactivate your own completed work."));
 document.getElementById("reactivateWorkOrderId").value=id;
 document.getElementById("reactivateForm").reset();
 document.getElementById("reactivateWorkOrderId").value=id;
 document.getElementById("reactivateModal").classList.add("open");
}
document.getElementById("reactivateForm").onsubmit=e=>{
 e.preventDefault();
 if(!requireMechanic())return;
 const f=new FormData(e.target);
 const id=Number(f.get("workOrderId"));
 const w=state.workorders.find(x=>x.id===id);
 if(!w || w.status!=="Completed")return;
 if(!(w.completedBy===session.username || w.mechanic===session.username))return alert(tr("You can only reactivate your own completed work."));
 const reason=(f.get("reason")||"").trim();
 const added=(f.get("tasks")||"").split("\n").map(x=>x.trim()).filter(Boolean);
 if(!reason || !added.length)return;
 added.forEach(t=>{
   w.tasks.push(newTaskRecord(t,{source:"reactivation"}));
 });
 // Reactivation becomes a new active visit owned by the mechanic who reopened it.
 w.mechanic=session.username;
 w.status="In Progress";
 w.outcomeWorkflowVersion=1;
 w.completedAt="";
 w.completedBy="";
 w.isReactivated=true;
 w.reactivatedBy=session.username;
 w.reactivatedAt=new Date().toISOString();
 // A mechanic can only reactivate a truck they are currently working on,
 // so customer units are treated as physically present for this reactivated visit.
 if(w.unitType==="customer")w.truckHere=true;
 if(w.unitType==="fleet")w.fleetAuto=true;
 w.reactivationCount=Number(w.reactivationCount||0)+1;
 w.history=w.history||[];
 w.history.push(workOrderHistoryEntry("reactivated",{reason,addedTasks:added}));
 save();
 closeModal("reactivateModal");
 render();
 openDetail(id);
};

function canCurrentMechanicComplete(w){
 if(!w || session?.role!=="mechanic")return false;
 if(w.status==="Completed")return false;
 const assigned=mechanicAssignedToWorkOrder(w,session.username);
 if(!assigned)return false;
 // Reactivated jobs remain completable by the mechanic that reactivated them.
 if(w.isReactivated && String(w.reactivatedBy||"").toLowerCase()===String(session.username||"").toLowerCase())return true;
 return visibleToCurrentMechanic(w);
}

function openCompleteWithNotes(id){
 if(!requireMechanic())return;
 const w=state.workorders.find(x=>x.id===id);
 if(!w)return alert(tr("Work order could not be found."));
 if(!canCurrentMechanicComplete(w))return alert(tr("This work order is not active for your mechanic account."));
 const activeIdx=activeTaskIndex(w);
 if(activeIdx!==-1){
   const activeName=w.tasks?.[activeIdx]?.t||"current job";
   return alert(`Stop "${activeName}" before completing the work order.`);
 }
 const undecided=(w.tasks||[]).filter(t=>!taskHasFinalDecision(t));
 if(undecided.length){
   const names=undecided.slice(0,5).map(t=>t.t).join(", ");
   return alert(`Every assigned job needs a mechanic decision before completing the work order.\nStill needs decision: ${names}${undecided.length>5?"...":""}`);
 }
 const form=document.getElementById("closeNotesForm");
 if(!form)return alert(tr("Completion form is unavailable. Please reopen the work order."));
 document.getElementById("closeNotesWorkOrderId").value=id;
 form.elements["completionNotes"].value=w.completionNotes||"";
 form.elements["futureNotes"].value=w.futureNotes||"";
 form.elements["revisitMiles"].value=w.revisitMiles||"";
 // Close detail first so the completion dialog is the only active modal.
 closeModal("detailModal");
 document.getElementById("closeNotesModal").classList.add("open");
}
document.getElementById("closeNotesForm").onsubmit=e=>{
 e.preventDefault();
 if(!requireMechanic())return;
 const f=new FormData(e.target);
 const id=Number(f.get("workOrderId"));
 const w=state.workorders.find(x=>x.id===id);
 if(!w)return alert(tr("Work order could not be found."));
 if(!canCurrentMechanicComplete(w))return alert(tr("This work order is no longer active for your account."));
 if(activeTaskIndex(w)!==-1)return alert(tr("A job is still running. Stop it before completing the work order."));
 const undecided=(w.tasks||[]).filter(t=>!taskHasFinalDecision(t));
 if(undecided.length)return alert(tr("Every assigned job must be marked Completed, Not Completed, or Next Visit before the work order can be closed."));

 const completionNotes=(f.get("completionNotes")||"").trim();
 const futureNotes=(f.get("futureNotes")||"").trim();
 const revisitMiles=(f.get("revisitMiles")||"").trim();
 const wasReactivated=!!w.isReactivated;
 const deferredTasks=(w.tasks||[]).filter(t=>["not_completed","next_visit"].includes(normalizedTaskOutcome(t)));
 const deferredSummary=deferredTasks.map(t=>`${t.t} — ${taskOutcomeLabel(t)}${t.outcomeNote?`: ${t.outcomeNote}`:""}`).join("\n");

 w.completionNotes=completionNotes;
 w.futureNotes=[futureNotes,deferredSummary].filter(Boolean).join("\n");
 w.revisitMiles=revisitMiles;
 w.completedBy=session.username;
 w.completedAt=new Date().toISOString();
 w.status="Completed";
 w.outcomeWorkflowVersion=1;
 w.history=w.history||[];
 w.history.push(workOrderHistoryEntry("completed",{
   completionNotes,
   futureNotes,
   revisitMiles,
   reactivatedCompletion:wasReactivated,
   taskOutcomes:(w.tasks||[]).map(t=>({task:t.t,outcome:normalizedTaskOutcome(t),note:t.outcomeNote||""}))
 }));

 // Close the active reactivation cycle only after successful completion.
 w.isReactivated=false;
 w.reactivatedBy="";
 w.reactivatedAt="";

 save();
 closeModal("closeNotesModal");
 render();

 // Go directly back to mechanic completed history after finishing.
 showView("mycompleted");
 renderMechanicActivity();
   renderMyCompleted();
 renderCalendar();
 renderMechanicLiveStatus();
};


let calendarMode=localStorage.getItem("ittr_calendar_mode")||"week";
let calendarDate=new Date();

function isoDateLocal(d){
 const y=d.getFullYear();
 const m=String(d.getMonth()+1).padStart(2,"0");
 const day=String(d.getDate()).padStart(2,"0");
 return `${y}-${m}-${day}`;
}
function startOfWeek(d){
 const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());
 const day=x.getDay();
 const diff=(day===0?-6:1-day); // Monday start
 x.setDate(x.getDate()+diff);
 return x;
}
function sameDate(a,b){
 return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
}
function fmtCalendarDate(d){
 return d.toLocaleDateString([], {weekday:"short",month:"short",day:"numeric"});
}
function setCalendarMode(mode){
 if(!["day","week","month"].includes(mode))return;
 calendarMode=mode;
 localStorage.setItem("ittr_calendar_mode",mode);
 renderCalendar();
}
function calendarMove(dir){
 if(calendarMode==="day")calendarDate.setDate(calendarDate.getDate()+dir);
 if(calendarMode==="week")calendarDate.setDate(calendarDate.getDate()+7*dir);
 if(calendarMode==="month")calendarDate.setMonth(calendarDate.getMonth()+dir);
 renderCalendar();
}
function calendarToday(){
 calendarDate=new Date();
 renderCalendar();
}
function calendarJobsFor(date){
 const key=isoDateLocal(date);
 return (state.workorders||[])
   .filter(w=>w.date===key)
   .sort((a,b)=>String(a.time||"").localeCompare(String(b.time||"")));
}
function calendarJobCard(w){
 const firstOpen=(w.tasks||[]).find(t=>!t.done) || (w.tasks||[])[0];
 return `<div class="calJob" onclick="openDetail(${w.id})">
   <div class="unit">Unit ${esc(w.unit)}</div>
   <div class="meta">${esc(w.time||"No time")} · ${esc(mechanicDisplay(w.mechanic)||"Unassigned")} · ${esc(w.status||"")}</div>
   ${firstOpen?`<div class="task">${esc(firstOpen.t)}</div>`:""}
 </div>`;
}
function renderCalendar(){
 if(session?.role!=="admin")return;
 const box=document.getElementById("shopCalendar");
 const title=document.getElementById("calendarTitle");
 if(!box||!title)return;

 ["day","week","month"].forEach(m=>{
   const btn=document.getElementById("cal"+m[0].toUpperCase()+m.slice(1)+"Btn");
   if(btn)btn.classList.toggle("active",calendarMode===m);
 });

 const today=new Date();

 if(calendarMode==="day"){
   title.textContent=calendarDate.toLocaleDateString([], {weekday:"long",month:"long",day:"numeric",year:"numeric"});
   const jobs=calendarJobsFor(calendarDate);
   box.innerHTML=`<div class="calendarDayView">
     <div class="calendarCell ${sameDate(calendarDate,today)?"today":""}">
       <div class="calendarCellHeader"><span>${fmtCalendarDate(calendarDate)}</span><span>${jobs.length} job${jobs.length===1?"":"s"}</span></div>
       ${jobs.map(calendarJobCard).join("")||'<div class="calendarEmpty">No work orders scheduled.</div>'}
     </div>
   </div>`;
   return;
 }

 if(calendarMode==="week"){
   const start=startOfWeek(calendarDate);
   const end=new Date(start); end.setDate(end.getDate()+6);
   title.textContent=`${start.toLocaleDateString([], {month:"short",day:"numeric"})} – ${end.toLocaleDateString([], {month:"short",day:"numeric",year:"numeric"})}`;
   const cells=[];
   for(let i=0;i<7;i++){
     const d=new Date(start); d.setDate(start.getDate()+i);
     const jobs=calendarJobsFor(d);
     cells.push(`<div class="calendarCell ${sameDate(d,today)?"today":""}">
       <div class="calendarCellHeader"><span>${fmtCalendarDate(d)}</span><span>${jobs.length}</span></div>
       ${jobs.map(calendarJobCard).join("")||'<div class="calendarEmpty">No jobs</div>'}
     </div>`);
   }
   box.innerHTML=`<div class="calendarWeek">${cells.join("")}</div>`;
   return;
 }

 // Month
 const year=calendarDate.getFullYear(), month=calendarDate.getMonth();
 title.textContent=calendarDate.toLocaleDateString([], {month:"long",year:"numeric"});
 const first=new Date(year,month,1);
 const mondayOffset=(first.getDay()+6)%7;
 const gridStart=new Date(year,month,1-mondayOffset);
 const weekdayNames=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
 let cells=weekdayNames.map(x=>`<div class="calendarWeekday">${x}</div>`).join("");
 for(let i=0;i<42;i++){
   const d=new Date(gridStart); d.setDate(gridStart.getDate()+i);
   const jobs=calendarJobsFor(d);
   const outside=d.getMonth()!==month;
   cells+=`<div class="calendarCell ${outside?"outside":""} ${sameDate(d,today)?"today":""}">
     <div class="calendarCellHeader"><span>${d.getDate()}</span><span>${jobs.length||""}</span></div>
     ${jobs.slice(0,4).map(calendarJobCard).join("")}
     ${jobs.length>4?`<div class="calendarEmpty">+${jobs.length-4} more</div>`:""}
   </div>`;
 }
 box.innerHTML=`<div class="calendarMonth">${cells}</div>`;
}

function activeTaskForWorkOrder(w){
 const idx=activeTaskIndex(w);
 return idx>=0 ? w.tasks[idx] : null;
}
function activeTaskForMechanic(w,username){
 const idx=activeTaskIndexForMechanic(w,username);
 return idx>=0 ? w.tasks[idx] : null;
}
function mechanicUpcomingCount(username){
 return (state.workorders||[]).filter(w=>
   mechanicAssignedToWorkOrder(w,username) &&
   w.status!=="Completed" &&
   ((w.unitType==="customer"&&!w.truckHere) || (w.unitType==="fleet"&&w.fleetAuto===false))
 ).length;
}
function mechanicCurrentWork(username){
 const assigned=(state.workorders||[]).filter(w=>
   mechanicAssignedToWorkOrder(w,username) &&
   w.status!=="Completed"
 );
 for(const w of assigned){
   const task=activeTaskForMechanic(w,username);
   if(task)return {w,task};
 }
 const inProgress=assigned.find(w=>w.status==="In Progress" && readyForMechanic(w));
 return inProgress?{w:inProgress,task:null}:null;
}
function renderMechanicLiveStatus(){
 if(session?.role!=="admin")return;
 const box=document.getElementById("mechanicLiveStatus");
 if(!box)return;
 const mechanics=mechanicAccounts();

 box.innerHTML=mechanics.map(user=>{
   const current=mechanicCurrentWork(user.username);
   const upcoming=mechanicUpcomingCount(user.username);

   if(current?.task){
     const elapsed=taskElapsed(current.task);
     return `<div class="mechanicStatusCard running">
       <div class="mechanicStatusTop">
         <div><b>${esc(user.display||user.username)}</b><div class="muted">@${esc(user.username)}</div></div>
         <span class="badge b-done"><span class="liveDot"></span>Working</span>
       </div>
       <div class="statusTask">Unit ${esc(current.w.unit)} — ${esc(current.task.t)}</div>
       <div class="muted">Started ${fmtDateTime(current.task.startedAt)} · ${fmtDuration(elapsed)}</div>
       ${upcoming?`<div class="muted" style="margin-top:8px">${upcoming} upcoming assigned truck${upcoming===1?"":"s"}</div>`:""}
       <button class="secondary" style="margin-top:10px" onclick="openDetail(${current.w.id})">Open Unit</button>
     </div>`;
   }

   if(current?.w){
     return `<div class="mechanicStatusCard waiting">
       <div class="mechanicStatusTop">
         <div><b>${esc(user.display||user.username)}</b><div class="muted">@${esc(user.username)}</div></div>
         <span class="badge b-wait"><span class="waitDot"></span>In Progress</span>
       </div>
       <div class="statusTask">Unit ${esc(current.w.unit)}</div>
       <div class="muted">No task timer is currently running.</div>
       ${upcoming?`<div class="muted" style="margin-top:8px">${upcoming} upcoming assigned truck${upcoming===1?"":"s"}</div>`:""}
       <button class="secondary" style="margin-top:10px" onclick="openDetail(${current.w.id})">Open Unit</button>
     </div>`;
   }

   const activity=mechanicActivityRecord(user.username);
   if(activity.code){
     return `<div class="mechanicStatusCard waiting">
       <div class="mechanicStatusTop">
         <div><b>${esc(user.display||user.username)}</b><div class="muted">@${esc(user.username)}</div></div>
         <span class="badge b-wait"><span class="waitDot"></span>${esc(translateDynamicText(mechanicActivityLabel(activity.code,activity.customText)))}</span>
       </div>
       <div class="statusTask">${esc(translateDynamicText(mechanicActivityLabel(activity.code,activity.customText)))}</div>
       ${activity.note?`<div class="muted">${esc(activity.note)}</div>`:""}
       ${activity.startedAt?`<div class="muted">${translateDynamicText("Started")}: ${fmtDateTime(activity.startedAt)}</div>`:""}
       ${upcoming?`<div class="muted" style="margin-top:8px">${upcoming} upcoming assigned truck${upcoming===1?"":"s"}</div>`:""}
     </div>`;
   }
   return `<div class="mechanicStatusCard">
     <div class="mechanicStatusTop">
       <div><b>${esc(user.display||user.username)}</b><div class="muted">@${esc(user.username)}</div></div>
       <span class="badge"><span class="idleDot"></span>${translateDynamicText("Available")}</span>
     </div>
     <div class="muted" style="margin-top:10px">${upcoming?`${upcoming} upcoming assigned truck${upcoming===1?"":"s"}.`:translateDynamicText("No active work assigned.")}</div>
   </div>`;
 }).join("") || '<div class="card empty">No mechanic accounts found.</div>';
}


function truckSearchNormalize(v){return String(v||"").toLowerCase().trim()}
function truckSearchWorkOrderDate(w){
 const raw=w.completedAt||w.date||"";
 const d=new Date(raw);
 return isNaN(d)?new Date(0):d;
}
function truckSearchFindingDate(i){
 if(typeof findingDateValue==="function")return findingDateValue(i);
 const d=new Date(i.createdAt||i.created||"");
 return isNaN(d)?new Date(0):d;
}
function truckSearchWOAllowed(w,status){
 if(status==="completed")return w.status==="Completed";
 if(status==="active")return w.status!=="Completed" && readyForMechanic(w);
 if(status==="future")return w.status!=="Completed" && !readyForMechanic(w);
 return true;
}
function truckSearchTextForWO(w,scope){
 const taskText=(w.tasks||[]).map(t=>[t.t,t.outcomeNote,(typeof taskOutcomeLabel==="function"?taskOutcomeLabel(t):"")].filter(Boolean).join(" ")).join(" ");
 const noteText=[w.notes,w.completionNotes,w.futureNotes,w.revisitMiles].filter(Boolean).join(" ");
 if(scope==="notes")return noteText;
 if(scope==="jobs")return taskText;
 if(scope==="findings")return "";
 return [w.unit,w.customer,w.mechanic,mechanicDisplay(w.mechanic),w.parking,w.status,w.priority,taskText,noteText].filter(Boolean).join(" ");
}
function truckSearchTextForFinding(i,w,scope){
 const text=[i.description,i.recommendation,i.adminNote,i.severity,i.approval].filter(Boolean).join(" ");
 if(scope==="notes")return [i.adminNote].filter(Boolean).join(" ");
 if(scope==="jobs")return [i.recommendation].filter(Boolean).join(" ");
 if(scope==="findings")return text;
 return [w?.unit,i.unitSnapshot,w?.customer,i.customerSnapshot,text].filter(Boolean).join(" ");
}
function truckSearchHighlight(text,query){
 const raw=String(text||"");
 if(!query)return esc(raw);
 const q=String(query).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
 try{return esc(raw).replace(new RegExp(`(${q})`,"ig"),'<span class="truckSearchMatch">$1</span>')}catch(e){return esc(raw)}
}
function unitSearchKey(w,i=null){
 return String(w?.unit||i?.unitSnapshot||"Unknown Unit").trim()||"Unknown Unit";
}
function renderTruckSearch(){
 if(session?.role!=="admin")return;
 const box=document.getElementById("truckSearchResults");
 if(!box)return;

 const query=truckSearchNormalize(document.getElementById("truckGlobalSearch")?.value);
 const status=document.getElementById("truckSearchStatus")?.value||"all";
 const scope=document.getElementById("truckSearchScope")?.value||"all";
 const workorders=(state.workorders||[]).filter(w=>truckSearchWOAllowed(w,status));
 const findings=state.issues||[];

 const groups={};

 workorders.forEach(w=>{
   const key=unitSearchKey(w);
   const hay=truckSearchNormalize(truckSearchTextForWO(w,scope));
   const matches=!query||hay.includes(query)||truckSearchNormalize(key).includes(query);
   if(!matches)return;
   if(!groups[key])groups[key]={unit:key,customer:w.customer||"",workorders:[],findings:[]};
   groups[key].workorders.push(w);
   if(!groups[key].customer&&w.customer)groups[key].customer=w.customer;
 });

 findings.forEach(i=>{
   const w=(state.workorders||[]).find(x=>x.id==i.wo);
   if(w && !truckSearchWOAllowed(w,status) && status!=="all")return;
   const key=unitSearchKey(w,i);
   const hay=truckSearchNormalize(truckSearchTextForFinding(i,w,scope));
   const matches=!query||hay.includes(query)||truckSearchNormalize(key).includes(query);
   if(!matches)return;
   if(!groups[key])groups[key]={unit:key,customer:w?.customer||i.customerSnapshot||"",workorders:[],findings:[]};
   groups[key].findings.push(i);
 });

 const results=Object.values(groups).map(g=>{
   g.workorders.sort((a,b)=>truckSearchWorkOrderDate(b)-truckSearchWorkOrderDate(a));
   g.findings.sort((a,b)=>truckSearchFindingDate(b)-truckSearchFindingDate(a));
   const allDates=[
     ...g.workorders.map(truckSearchWorkOrderDate),
     ...g.findings.map(truckSearchFindingDate)
   ].filter(d=>d.getTime()>0);
   g.lastActivity=allDates.length?new Date(Math.max(...allDates.map(d=>d.getTime()))):new Date(0);
   return g;
 }).sort((a,b)=>b.lastActivity-a.lastActivity);

 if(!results.length){
   box.innerHTML='<div class="truckSearchEmpty">No matching trucks or history found.</div>';
   applyTranslations();
   return;
 }

 box.innerHTML=results.map(g=>{
   const futureNotes=g.workorders
     .filter(w=>w.futureNotes)
     .map(w=>({id:w.id,date:w.completedAt||w.date,text:w.futureNotes,revisit:w.revisitMiles}))
     .slice(0,8);

   return `<div class="truckSearchUnit">
     <div class="truckSearchUnitHeader">
       <div>
         <div class="truckSearchUnitTitle">Unit ${truckSearchHighlight(g.unit,query)}</div>
         <div class="muted">${truckSearchHighlight(g.customer||"No customer",query)}</div>
         <div class="truckSearchChips">
           <span class="badge">${g.workorders.length} work orders</span>
           <span class="badge">${g.findings.length} findings</span>
           ${g.lastActivity.getTime()?`<span class="badge">Last activity: ${g.lastActivity.toLocaleDateString(currentLanguage==="uk"?"uk-UA":"en-US")}</span>`:""}
         </div>
       </div>
     </div>
     <div class="truckSearchUnitBody">

       ${futureNotes.length?`<div class="truckSearchSectionTitle">Future / Next Visit Notes</div>
       ${futureNotes.map(n=>`<div class="truckSearchRecord">
         <div class="muted">${esc(n.date||"")}${n.revisit?` · Recheck: ${esc(n.revisit)} miles`:""}</div>
         <div class="truckSearchNote">${truckSearchHighlight(n.text,query)}</div>
         <div class="truckSearchActions"><button class="secondary" onclick="openDetail(${n.id})">Open Work Order</button></div>
       </div>`).join("")}`:""}

       ${g.workorders.length?`<div class="truckSearchSectionTitle">Work Order History</div>
       ${g.workorders.map(w=>`<div class="truckSearchRecord">
         <div class="truckSearchRecordTop">
           <div>
             <b>${esc(w.date||"")} ${esc(w.time||"")} · ${esc(translateDynamicText(w.status||""))}</b>
             <div class="muted">${esc(mechanicDisplay(w.mechanic)||"")} ${w.parking?`· Parking ${esc(w.parking)}`:""}</div>
           </div>
           ${statusBadge(w.status)}
         </div>
         ${(w.tasks||[]).length?`<div style="margin-top:7px">${(w.tasks||[]).map(t=>`<div>• ${truckSearchHighlight(t.t,query)}${(typeof normalizedTaskOutcome==="function"&&normalizedTaskOutcome(t))?` — ${esc(taskOutcomeLabel(t))}`:""}</div>`).join("")}</div>`:""}
         ${w.notes?`<div class="truckSearchNote" style="margin-top:7px"><b>Notes:</b> ${truckSearchHighlight(w.notes,query)}</div>`:""}
         ${w.completionNotes?`<div class="truckSearchNote" style="margin-top:7px"><b>Completion Notes:</b> ${truckSearchHighlight(w.completionNotes,query)}</div>`:""}
         ${w.futureNotes?`<div class="truckSearchNote" style="margin-top:7px"><b>Future / Next Visit:</b> ${truckSearchHighlight(w.futureNotes,query)}</div>`:""}
         <div class="truckSearchActions"><button class="secondary" onclick="openDetail(${w.id})">Open Work Order</button></div>
       </div>`).join("")}`:""}

       ${g.findings.length?`<div class="truckSearchSectionTitle">Findings History</div>
       ${g.findings.map(i=>`<div class="truckSearchRecord">
         <div class="truckSearchRecordTop">
           <div>
             <b>${truckSearchHighlight(i.description||"Finding",query)}</b>
             <div class="muted">${esc(i.created||i.createdAt||"")} · ${esc(i.severity||"")}</div>
           </div>
           ${approvalBadge(i)}
         </div>
         ${i.recommendation?`<div class="truckSearchNote"><b>Recommended:</b> ${truckSearchHighlight(i.recommendation,query)}</div>`:""}
         ${i.adminNote?`<div class="truckSearchNote"><b>Admin / Customer note:</b> ${truckSearchHighlight(i.adminNote,query)}</div>`:""}
       </div>`).join("")}`:""}

     </div>
   </div>`;
 }).join("");

 applyTranslations();
 if(currentLanguage==="uk"&&typeof scheduleAITranslation==="function")scheduleAITranslation();
}





// v24 Unified Smart Search
let globalSmartTimer=null,smartDirectoryTimer=null;
function smartResultMeta(parts){return parts.map(cleanImportedDisplayText).filter(Boolean).join(" · ")}
function hideGlobalSmartSearch(){const b=document.getElementById("globalSmartSearchResults");if(b){b.classList.add("hidden");b.innerHTML=""}}
function scheduleGlobalSmartSearch(value){clearTimeout(globalSmartTimer);const q=String(value||"").trim();if(q.length<2){hideGlobalSmartSearch();return}globalSmartTimer=setTimeout(()=>runGlobalSmartSearch(q),180)}
async function runGlobalSmartSearch(q){
 const box=document.getElementById("globalSmartSearchResults");if(!box)return;
 try{
  const d=await apiJSON(`/api/smart-search?q=${encodeURIComponent(q)}&limit=6`),rows=[];
  (d.customers||[]).forEach(x=>rows.push(`<button class="smartResult" onclick="smartOpenCustomer(${Number(x.id)})"><div class="smartResultType">Customer</div><div class="smartResultTitle">${esc(cleanImportedDisplayText(x.customer_name)||"")}</div><div class="smartResultMeta">${esc(smartResultMeta([x.dot_number?`DOT ${cleanVehicleMeta(x.dot_number)}`:"",x.phone||"",[x.city,x.state].map(cleanImportedDisplayText).filter(Boolean).join(", ")]))}</div></button>`));
  (d.units||[]).forEach(x=>rows.push(`<button class="smartResult" onclick="smartOpenUnit(${Number(x.id)})"><div class="smartResultType">Vehicle</div><div class="smartResultTitle">Unit ${esc(cleanVehicleMeta(x.unit_number)||"—")} · ${esc(vehicleDisplayName(x))}</div><div class="smartResultMeta">${esc(smartResultMeta([x.customer_name||"",cleanVehicleMeta(x.vin)||"",x.plate?`Plate ${cleanVehicleMeta(x.plate)}`:""]))}</div></button>`));
  (d.workorders||[]).forEach(x=>rows.push(`<button class="smartResult" onclick="smartOpenService('${x.source||"ittr"}',${x.customer_id?Number(x.customer_id):'null'},'${encodeURIComponent(String(x.id||""))}','${encodeURIComponent(String(x.unit||""))}')"><div class="smartResultType">${x.source==="fullbay"?"Service Order":"Work Order"}</div><div class="smartResultTitle">${x.source==="fullbay"?`SO #${esc(cleanVehicleMeta(x.id))}`:`WO #${esc(cleanVehicleMeta(x.id))}`} · Unit ${esc(cleanVehicleMeta(x.unit)||"—")}</div><div class="smartResultMeta">${esc(smartResultMeta([x.completedAt?fmtShortDate(x.completedAt):"",x.customer||"",x.summary||""]))}</div></button>`));
  box.innerHTML=rows.length?rows.slice(0,12).join(""):`<div class="smartResultMeta" style="padding:12px">No matches.</div>`;box.classList.remove("hidden");
 }catch(e){box.innerHTML=`<div class="smartResultMeta" style="padding:12px">Search unavailable: ${esc(e.message||"")}</div>`;box.classList.remove("hidden")}
}
function smartOpenCustomer(id){hideGlobalSmartSearch();showView("customers");setTimeout(()=>openCustomerProfile(id),0)}
function smartOpenUnit(unitId){hideGlobalSmartSearch();showView("customers");setTimeout(()=>openVehicleProfile(unitId),0)}
function smartOpenService(source,customerId,id,encodedUnit=""){hideGlobalSmartSearch();if(source==="fullbay"){showView("customers");return setTimeout(()=>openFullbayServiceOrder(id,customerId,encodedUnit),0)}const n=Number(decodeURIComponent(id||""));if(Number.isFinite(n))openDetail(n)}
document.addEventListener("click",e=>{if(!e.target.closest(".smartHeaderSearch"))hideGlobalSmartSearch()});document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();document.getElementById("globalSmartSearch")?.focus()}});
function debouncedSmartDirectory(){clearTimeout(smartDirectoryTimer);smartDirectoryTimer=setTimeout(renderSmartDirectory,180)}
async function renderSmartDirectory(){
 const q=String(document.getElementById("customerDirectorySearch")?.value||"").trim(),results=document.getElementById("smartDirectoryResults"),table=document.getElementById("customerDirectoryTableCard");if(!results||!table)return;
 if(q.length<2){results.classList.add("hidden");results.innerHTML="";table.classList.remove("hidden");await renderCustomerDirectory();return}
 table.classList.add("hidden");results.classList.remove("hidden");results.innerHTML='<div class="card">Searching customers, vehicles and service history…</div>';
 try{
  const d=await apiJSON(`/api/smart-search?q=${encodeURIComponent(q)}&limit=30`),customers=d.customers||[],units=d.units||[],workorders=d.workorders||[];
  const group=(title,body)=>`<div class="smartGroup"><div class="smartGroupTitle">${esc(title)}</div>${body||'<div class="smartGroupItem"><span class="muted">No matches</span></div>'}</div>`;
  const c=customers.map(x=>`<div class="smartGroupItem"><div><div class="smartPrimary">${esc(cleanImportedDisplayText(x.customer_name)||"")}</div><div class="smartMeta">${esc(smartResultMeta([x.dot_number?`DOT ${cleanVehicleMeta(x.dot_number)}`:"",x.phone||"",[x.city,x.state,x.postal_code].map(cleanImportedDisplayText).filter(Boolean).join(", ")]))}</div></div><div class="smartActions"><button class="secondary" onclick="openCustomerProfile(${Number(x.id)})">Open Customer</button></div></div>`).join("");
  const u=units.map(x=>`<div class="smartGroupItem"><div><div class="smartPrimary">Unit ${esc(cleanVehicleMeta(x.unit_number)||"—")} · ${esc(vehicleDisplayName(x))}</div><div class="smartMeta">${esc(smartResultMeta([x.customer_name||"",cleanVehicleMeta(x.vin)||"",x.plate?`Plate ${cleanVehicleMeta(x.plate)}`:"",x.mileage!=null?`${Number(x.mileage).toLocaleString()} mi`:""]))}</div></div><div class="smartActions">${x.customer_id?`<button class="secondary" onclick="openVehicleProfile(${Number(x.id)})">Open Vehicle</button>`:""}</div></div>`).join("");
  const w=workorders.map(x=>`<div class="smartGroupItem"><div><div class="smartPrimary">${x.source==="fullbay"?`Fullbay SO #${esc(cleanVehicleMeta(x.id))}`:`WO #${esc(cleanVehicleMeta(x.id))}`} · Unit ${esc(cleanVehicleMeta(x.unit)||"—")}</div><div class="smartMeta">${esc(smartResultMeta([x.customer||"",x.status||"",x.summary||""]))}</div></div><div class="smartActions"><button class="secondary" onclick="smartOpenService('${x.source||"ittr"}',${x.customer_id?Number(x.customer_id):'null'},'${encodeURIComponent(String(x.id||""))}','${encodeURIComponent(String(x.unit||""))}')">${x.source==="fullbay"?"Open Service Order":"Open Work Order"}</button></div></div>`).join("");
  results.innerHTML=group(`Customers (${customers.length})`,c)+group(`Vehicles (${units.length})`,u)+group(`Service / Work Orders (${workorders.length})`,w);
 }catch(e){results.innerHTML=`<div class="notice"><b>Search unavailable</b><div class="muted">${esc(e.message||"")}</div></div>`}
}

function fmtShortDate(v){if(!v)return "—";const d=new Date(v);if(!Number.isFinite(d.getTime()))return String(v||"—");return d.toLocaleDateString("en-US",{month:"2-digit",day:"2-digit",year:"numeric"})}
let vehicleProfileCache=null,vehicleProfilePane="overview";
async function openVehicleProfile(unitId,pane="overview"){
 if(!requireAdmin())return;vehicleProfilePane=pane||"overview";if(document.getElementById("customerModal")?.classList.contains("open"))closeModal("customerModal");const modal=document.getElementById("vehicleProfileModal"),box=document.getElementById("vehicleProfileBody");modal.classList.add("open");updateMobileBackButton();box.innerHTML='<div class="productivityLoading">Loading vehicle…</div>';
 try{vehicleProfileCache=await apiJSON(`/api/customer-units/${encodeURIComponent(unitId)}/profile`);renderVehicleProfile()}catch(e){box.innerHTML=`<div class="error">${esc(e.message||"Unable to load vehicle profile.")}</div>`}
}
function showVehiclePane(pane){vehicleProfilePane=pane;["overview","history","current"].forEach(x=>{document.getElementById(`vehiclePane_${x}`)?.classList.toggle("hidden",x!==pane);document.getElementById(`vehicleTab_${x}`)?.classList.toggle("active",x===pane)})}
function cleanImportedDisplayText(v){
 let s=String(v??"").replace(/^\uFEFF/,"").trim();
 if(!s)return "";
 for(let i=0;i<3;i++){
   const excel=s.match(/^=+\s*"([\s\S]*)"$/);
   if(excel){s=excel[1].replace(/""/g,'"').trim();continue}
   if(/^"[\s\S]*"$/.test(s)){s=s.slice(1,-1).replace(/""/g,'"').trim();continue}
   break;
 }
 s=s.replace(/^=+\s*/,"");
 s=s.replace(/(^|[\s·|;,])=+(?=[A-Za-z0-9#])/g,"$1");
 s=s.replace(/\s*\|\s*/g," · ");
 s=s.replace(/\s*·\s*/g," · ");
 s=s.replace(/\s{2,}/g," ").trim();
 return s;
}
function cleanVehicleMeta(v){return cleanImportedDisplayText(v).replace(/^[-·]+\s*/,"").trim()}
function uniqueImportedParts(parts){const seen=new Set(),out=[];for(const p of parts.map(cleanImportedDisplayText).filter(Boolean)){const k=p.toLowerCase().replace(/[.,]+$/," ").trim();if(!seen.has(k)){seen.add(k);out.push(p)}}return out}
function vehicleDisplayName(u={}){const parts=uniqueImportedParts([u.year,u.make,u.model]);return parts.join(" ")||cleanVehicleMeta(u.unit_type||u.unit_subtype||"Vehicle")||"Vehicle"}
function cleanImportedPerson(v){return cleanImportedDisplayText(v)}
function vehicleHistorySummary(w){const t=(w.tasks||[]).map(x=>cleanImportedDisplayText(x?.t||x?.outcomeNote)).filter(Boolean);return t.slice(0,2).join(" · ")+(t.length>2?` + ${t.length-2} more`:"")||cleanImportedDisplayText(w.notes||w.completionNotes)||"Service record"}
function renderVehicleProfile(){
 const d=vehicleProfileCache;if(!d)return;const u=d.unit||{},c=d.customer||{},history=d.history||[],active=d.active||[];
 const unitLabel=cleanVehicleMeta(u.unit_number)||"—",customerLabel=cleanImportedDisplayText(c.customer_name||u.customer_name||"Unassigned customer"),vinLabel=cleanVehicleMeta(u.vin)||"—",plateLabel=cleanVehicleMeta(u.plate),statusLabel=cleanVehicleMeta(u.unit_status);
 document.getElementById("vehicleProfileTitle").textContent=`Unit ${unitLabel}`;
 const box=document.getElementById("vehicleProfileBody");box.innerHTML=`<div class="vehicleProfileHero"><div class="vehicleProfileCard"><div class="vehicleProfileTitle">Unit ${esc(unitLabel)}</div><div><b>${esc(vehicleDisplayName(u))}</b></div><div class="muted">${esc(customerLabel)}</div></div><div class="vehicleProfileCard"><div class="muted">VIN</div><b>${esc(vinLabel)}</b><div class="muted">${plateLabel?`Plate ${esc(plateLabel)}`:"No plate saved"}</div></div><div class="vehicleProfileCard"><div class="muted">Mileage</div><b>${u.mileage!=null?`${Number(u.mileage).toLocaleString()} mi`:"—"}</b><div class="muted">${esc(statusLabel)}</div></div><div class="vehicleProfileCard"><div class="muted">History</div><b>${history.length} service order${history.length===1?"":"s"}</b><div class="muted">${active.length} active ITTR</div></div></div><div class="vehicleTabs"><button id="vehicleTab_overview" onclick="showVehiclePane('overview')">Overview</button><button id="vehicleTab_history" onclick="showVehiclePane('history')">Service History (${history.length})</button><button id="vehicleTab_current" onclick="showVehiclePane('current')">Current Work (${active.length})</button><button class="secondary" onclick="openCustomerUnitEditor(${c.id||u.customer_id||'null'},${u.id})">Edit Vehicle</button>${c.id?`<button class="secondary" onclick="closeModal('vehicleProfileModal');openCustomerProfile(${c.id})">Open Customer</button>`:""}<button onclick="createWorkOrderFromVehicleProfile(${u.id})">+ New Work Order</button></div><div id="vehiclePane_overview"><div class="row"><div class="card"><b>Vehicle Details</b><div class="muted" style="margin-top:8px">Engine: ${esc(cleanImportedDisplayText(u.engine)||"—")}</div><div class="muted">Transmission: ${esc(cleanImportedDisplayText(u.transmission)||"—")}</div><div class="muted">Type: ${esc(uniqueImportedParts([u.unit_type,u.unit_subtype]).join(" · ")||"—")}</div></div><div class="card"><b>Customer</b><div style="margin-top:8px">${esc(customerLabel)}</div><div class="muted">${c.dot_number?`DOT ${esc(cleanVehicleMeta(c.dot_number))}`:""}</div><div class="muted">${esc(cleanImportedDisplayText(c.phone)||"")}</div></div></div>${u.notes?`<div class="card"><b>Vehicle Notes</b><div style="margin-top:8px">${esc(cleanImportedDisplayText(u.notes))}</div></div>`:""}</div><div id="vehiclePane_history" class="hidden"><div class="historyToolbar"><input id="vehicleHistorySearch" type="search" placeholder="Search service order, invoice, repair…" oninput="renderVehicleHistoryRows()"><select id="vehicleHistorySource" onchange="renderVehicleHistoryRows()"><option value="">All history</option><option value="fullbay">Fullbay</option><option value="ittr">ITTR</option></select></div><div style="overflow:auto"><table class="vehicleHistoryTable"><thead><tr><th>Date</th><th>Service Order</th><th>Work Performed</th><th>Mileage</th><th>Total</th><th></th></tr></thead><tbody id="vehicleHistoryRows"></tbody></table></div></div><div id="vehiclePane_current" class="hidden"><div id="vehicleCurrentWork" class="vehicleCurrentWork"></div></div>`;
 renderVehicleHistoryRows();renderVehicleCurrentWork();showVehiclePane(vehicleProfilePane);applyTranslations();
}
function renderVehicleHistoryRows(){
 const body=document.getElementById("vehicleHistoryRows");if(!body||!vehicleProfileCache)return;
 const q=String(document.getElementById("vehicleHistorySearch")?.value||"").trim().toLowerCase(),src=String(document.getElementById("vehicleHistorySource")?.value||""),c=vehicleProfileCache.customer||{};
 const rows=(vehicleProfileCache.history||[]).filter(w=>(!src||w.source===src)&&(!q||[w.id,w.invoice,w.unit,w.vin,w.mechanic,vehicleHistorySummary(w)].map(cleanImportedDisplayText).join(" ").toLowerCase().includes(q)));
 body.innerHTML=rows.length?rows.map(w=>`<tr><td><b>${esc(w.completedAt?fmtShortDate(w.completedAt):(cleanImportedDisplayText(w.date)||"—"))}</b></td><td><b>${w.source==="fullbay"?`SO #${esc(cleanVehicleMeta(w.id))}`:`WO #${esc(cleanVehicleMeta(w.id))}`}</b><div class="muted">${w.invoice?`Invoice #${esc(cleanVehicleMeta(w.invoice))}`:""}</div></td><td>${esc(vehicleHistorySummary(w))}</td><td>${w.mileage!=null?`${Number(w.mileage).toLocaleString()} mi`:"—"}</td><td>${w.source==="fullbay"?money(w.totalAmount||0):"—"}</td><td><button class="secondary" onclick="${w.source==="fullbay"?`openFullbayServiceOrder('${encodeURIComponent(String(w.id||""))}',${c.id||'null'},'${encodeURIComponent(String(w.unit||vehicleProfileCache.unit?.unit_number||""))}')`:`closeModal('vehicleProfileModal');openDetail(${Number(w.id)})`}">Open</button></td></tr>`).join(""):'<tr><td colspan="6" class="muted">No matching service orders.</td></tr>';
}
function renderVehicleCurrentWork(){const box=document.getElementById("vehicleCurrentWork");if(!box||!vehicleProfileCache)return;const rows=vehicleProfileCache.active||[];box.innerHTML=rows.length?rows.map(w=>`<div class="vehicleCurrentItem"><div><b>WO #${esc(w.id)} · ${esc(w.status||"Active")}</b></div><div class="muted">${esc(vehicleHistorySummary(w))}</div><div style="margin-top:8px"><button class="secondary" onclick="closeModal('vehicleProfileModal');openDetail(${Number(w.id)})">Open Work Order</button></div></div>`).join(""):'<div class="muted">No active ITTR work orders for this vehicle.</div>'}
function createWorkOrderFromVehicleProfile(unitId){const u=vehicleProfileCache?.unit,c=vehicleProfileCache?.customer;if(!u||String(u.id)!==String(unitId))return;closeModal("vehicleProfileModal");openWorkOrder();unitSuggestionCache=[{...u,customer_name:c?.customer_name||u.customer_name,dot_number:c?.dot_number||""}];setTimeout(()=>applyUnitSuggestion("new",unitId),0)}

Object.assign(UI_TRANSLATIONS,{"Customers":"Клієнти","Customers & Fleet Directory":"Клієнти та автопарк","Customer records, truck/unit profiles, contact information and complete service history.":"Клієнти, траки/юніти, контакти та повна історія сервісу.","Add Customer":"Додати клієнта","Search customers":"Пошук клієнтів","Known Units":"Відомі юніти","Service Records":"Історія сервісу","Truck / Unit List":"Список траків / юнітів","Service History":"Історія сервісу","Edit Customer":"Редагувати клієнта","Add Truck / Unit":"Додати трак / юніт","Primary Contact":"Основний контакт","DOT Number":"DOT номер","Internal Notes":"Внутрішні примітки"});
Object.assign(UI_TRANSLATIONS,{"Dashboard":"Панель","Work Orders":"Наряд-замовлення","Customers & Vehicles":"Клієнти та техніка","Operations":"Операції","Shop Operations":"Операції майстерні","Smart search":"Розумний пошук","Completed History":"Історія завершених","Team Activity":"Активність механіків","Mechanic Accounts":"Акаунти механіків","Completed Work":"Завершені роботи"});
/* ===== ITTR CUSTOMER CRM + UNIT DIRECTORY v23.8 ===== */
let customerDirectoryTimer=null,customerDirectoryCache=[],customerProfileCache=null,unitLookupTimer=null,unitSuggestionCache=[];
function debouncedCustomerDirectory(){clearTimeout(customerDirectoryTimer);customerDirectoryTimer=setTimeout(renderCustomerDirectory,220)}
async function renderCustomerDirectory(){
 if(session?.role!=="admin")return;const tbody=document.getElementById("customerDirectoryTable");if(!tbody)return;const rawQ=document.getElementById("customerDirectorySearch")?.value?.trim()||"";if(rawQ.length>=2&&document.getElementById("smartDirectoryResults")&&!document.getElementById("smartDirectoryResults").classList.contains("hidden"))return;const q="";tbody.innerHTML='<tr><td colspan="6">Loading customers…</td></tr>';
 try{const d=await apiJSON(`/api/customers?q=${encodeURIComponent(q)}`);customerDirectoryCache=d.items||[];if(Array.isArray(d.warnings)&&d.warnings.length)console.warn("Customer CRM warnings:",d.warnings);const total=customerDirectoryCache.length,units=customerDirectoryCache.reduce((a,x)=>a+Number(x.unit_count||0),0),services=customerDirectoryCache.reduce((a,x)=>a+Number(x.service_count||0),0),active=customerDirectoryCache.filter(x=>x.active!==false).length;const stats=document.getElementById("customerDirectoryStats");if(stats)stats.innerHTML=`<div class="customerStat"><span class="muted">Customers</span><b>${total}</b></div><div class="customerStat"><span class="muted">Active</span><b>${active}</b></div><div class="customerStat"><span class="muted">Known Units</span><b>${units}</b></div><div class="customerStat"><span class="muted">Service Records</span><b>${services}</b></div>`;
 tbody.innerHTML=customerDirectoryCache.length?customerDirectoryCache.map(c=>`<tr><td><button class="customerNameLink" onclick="openCustomerProfile(${c.id})">${esc(cleanImportedDisplayText(c.customer_name)||"")}</button><div class="muted">${c.fullbay_id?`Fullbay ${esc(cleanVehicleMeta(c.fullbay_id))} · `:""}${c.active===false?"Inactive":"Active"}</div></td><td>${esc(cleanImportedDisplayText(c.contact_name)||"—")}<div class="muted">${esc(cleanImportedDisplayText(c.phone)||"—")}${c.email?` · ${esc(cleanImportedDisplayText(c.email))}`:""}</div></td><td>DOT ${esc(cleanVehicleMeta(c.dot_number)||"—")}<div class="muted">${esc(uniqueImportedParts([c.city,c.state,c.postal_code]).join(", ")||"—")}</div></td><td><b>${Number(c.unit_count||0)}</b></td><td><b>${Number(c.service_count||0)}</b></td><td><button class="secondary" onclick="openCustomerProfile(${c.id})">Open</button></td></tr>`).join(""):'<tr><td colspan="6" class="empty">No customers found.</td></tr>';applyTranslations();}
 catch(e){tbody.innerHTML=`<tr><td colspan="6" class="error">${esc(e.message||"Unable to load customers.")}</td></tr>`}
}
let fmcsaLookupTimer=null,fmcsaCustomerLookupCache=null,fmcsaLookupDot="";
function setFmcsaLookupCard(html,kind="") {const box=document.getElementById("fmcsaLookupCard");if(!box)return;box.classList.remove("hidden");box.className=`vehicleMatchCard ${kind||""}`;box.innerHTML=html;}
function clearFmcsaLookupCard(){const box=document.getElementById("fmcsaLookupCard");if(box){box.classList.add("hidden");box.innerHTML=""}fmcsaCustomerLookupCache=null;fmcsaLookupDot=""}
function scheduleFmcsaLookup(value){clearTimeout(fmcsaLookupTimer);const dot=String(value||"").replace(/\D/g,"");if(dot.length<5){if(!dot)clearFmcsaLookupCard();return}fmcsaLookupTimer=setTimeout(()=>lookupCustomerFmcsa(false),750)}
function fmcsaVal(id,val,overwrite=true){const e=document.getElementById(id);if(!e||val===undefined||val===null||String(val).trim()==="")return;if(overwrite||!String(e.value||"").trim())e.value=String(val).trim()}
function applyFmcsaToCustomer(item,overwrite=false){if(!item)return;fmcsaVal("ceName",item.legalName,overwrite);fmcsaVal("cePhone",item.phone,overwrite);fmcsaVal("ceAddress",item.address,overwrite);fmcsaVal("ceCity",item.city,overwrite);fmcsaVal("ceState",item.state,overwrite);fmcsaVal("ceZip",item.zip,overwrite);fmcsaVal("ceCountry",item.country,overwrite);fmcsaVal("ceDot",item.dotNumber,true)}
async function lookupCustomerFmcsa(force=false){
 if(!requireAdmin())return;const dot=String(document.getElementById("ceDot")?.value||"").replace(/\D/g,"");if(dot.length<5){if(force)alert("Enter a valid USDOT number first.");return}
 if(!force&&fmcsaLookupDot===dot&&fmcsaCustomerLookupCache)return;
 setFmcsaLookupCard(`<b>Checking FMCSA / SAFER…</b><div class="muted">USDOT ${esc(dot)}</div>`);
 try{const d=await apiJSON(`/api/fmcsa/carriers/${encodeURIComponent(dot)}`),x=d.item||{};fmcsaLookupDot=dot;fmcsaCustomerLookupCache={...x,checkedAt:d.checkedAt||new Date().toISOString()};applyFmcsaToCustomer(x,false);
  const status=x.outOfService==="Y"?"OUT OF SERVICE":x.allowedToOperate==="Y"?"Allowed to Operate":x.allowedToOperate==="N"?"Not Allowed to Operate":"FMCSA record found";
  setFmcsaLookupCard(`<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><b>✓ Official FMCSA Match</b><div style="font-size:16px;font-weight:700;margin-top:3px">${esc(x.legalName||"Carrier")}</div>${x.dbaName?`<div class="muted">DBA ${esc(x.dbaName)}</div>`:""}<div class="muted">USDOT ${esc(x.dotNumber||dot)}${x.mcNumber?` · MC ${esc(x.mcNumber)}`:""} · ${esc(status)}</div><div class="muted">${esc([x.address,[x.city,x.state,x.zip].filter(Boolean).join(" "),x.phone].filter(Boolean).join(" · "))}</div></div><div><button type="button" onclick="applyFmcsaToCustomer(fmcsaCustomerLookupCache,true)">Use / Replace Fields</button></div></div>`);
 }catch(e){fmcsaCustomerLookupCache=null;fmcsaLookupDot="";setFmcsaLookupCard(`<b>FMCSA lookup unavailable</b><div class="muted">${esc(e.message||"Unable to look up this USDOT number.")}</div>`,`error`)}
}
function customerEditorFields(c={}){const map={ceName:"customer_name",ceContact:"contact_name",ceEmail:"email",ceDot:"dot_number",cePhone:"phone",cePhone2:"secondary_phone",ceAddress:"address",ceCity:"city",ceState:"state",ceZip:"postal_code",ceCountry:"country",ceBillingContact:"billing_contact",cePayment:"payment_method",ceTerms:"credit_terms",ceLimit:"credit_limit",ceBillingAddress:"billing_address",ceBillingCity:"billing_city",ceBillingState:"billing_state",ceBillingZip:"billing_postal_code",ceNotes:"notes"};Object.entries(map).forEach(([id,k])=>{const e=document.getElementById(id);if(e){const v=c?.[k]??"";e.value=typeof v==="string"?cleanImportedDisplayText(v):v}});const a=document.getElementById("ceActive");if(a)a.checked=c?.active!==false;clearFmcsaLookupCard();if(c?.fmcsa_last_checked){fmcsaLookupDot=String(c.dot_number||"").replace(/\D/g,"");fmcsaCustomerLookupCache={dotNumber:c.dot_number||"",legalName:c.customer_name||"",dbaName:c.fmcsa_dba_name||"",mcNumber:c.fmcsa_mc_number||"",allowedToOperate:c.fmcsa_allowed_to_operate||"",outOfService:c.fmcsa_out_of_service||"",powerUnits:c.fmcsa_power_units,drivers:c.fmcsa_drivers,checkedAt:c.fmcsa_last_checked,raw:c.fmcsa_snapshot||{}};setFmcsaLookupCard(`<b>✓ FMCSA verified</b><div class="muted">Last checked ${esc(fmtDateTime(c.fmcsa_last_checked))}${c.fmcsa_mc_number?` · MC ${esc(c.fmcsa_mc_number)}`:""}</div>`);}}
function openCustomerEditor(id=null){if(!requireAdmin())return;const c=id?(customerDirectoryCache.find(x=>String(x.id)===String(id))||customerProfileCache?.customer||{}):{};document.getElementById("customerEditId").value=id||"";document.getElementById("customerEditTitle").textContent=id?"Edit Customer":"Add Customer";customerEditorFields(c);document.getElementById("customerEditModal").classList.add("open");updateMobileBackButton()}
async function runCustomerCrmDiagnostics(){if(!requireAdmin())return;const box=document.getElementById("customerCrmDiagnosticBox");if(box){box.classList.remove("hidden");box.textContent="Running CRM diagnostics…"}try{const d=await apiJSON("/api/admin/customer-crm-diagnostics");const tables=Object.entries(d.tables||{}).map(([k,v])=>`${k}: ${v?"OK":"MISSING"}`).join(" · ");const sync=d.sync||{};const errors=Array.isArray(sync.errors)?sync.errors:[];const detail=errors.slice(0,5).map(x=>`<div class="muted">• ${esc(x.source||"record")} ${esc(x.unit||"")} — ${esc(x.error||"")}</div>`).join("");const samples=Array.isArray(d.unitSamples)?d.unitSamples:[];const sampleHtml=samples.length?`<div style="margin-top:6px"><b>Newest unit records:</b> ${samples.slice(0,5).map(x=>`Unit ${esc(cleanVehicleMeta(x.unit_number)||"?")} (${esc(cleanImportedDisplayText(x.customer_name)||"unlinked")})`).join(" · ")}</div>`:"";const state=d.stateCounts||{};const unlinked=Array.isArray(d.unlinkedUnits)?d.unlinkedUnits:[];const sources=Array.isArray(d.unitSourceCounts)?d.unitSourceCounts:[];const extra=`<div style="margin-top:6px"><b>Cloud state:</b> Vehicle Profiles ${Number(state.vehicleProfiles||0)} · Work Orders ${Number(state.workOrders||0)}</div>${sources.length?`<div><b>DB unit sources:</b> ${sources.map(x=>`${esc(x.source)} ${Number(x.count||0)}`).join(" · ")}</div>`:""}${unlinked.length?`<div><b>Unlinked units:</b> ${unlinked.slice(0,8).map(x=>`Unit ${esc(cleanVehicleMeta(x.unit_number)||"?")} (${esc(cleanImportedDisplayText(x.customer_name)||"no customer")})`).join(" · ")}</div>`:""}`;if(box)box.innerHTML=`<b>CRM Diagnostics v${esc(d.version||"")}</b><br>${esc(tables)}<br>Customers: ${Number(d.counts?.customers||0)} · Units: ${Number(d.counts?.units||0)}<br>Sync: ${sync.ok===false?"warnings":"OK"}${errors.length?` · ${errors.length} skipped record(s)`:""}${detail}${sampleHtml}${extra}${d.error?`<br>${esc(d.error)}`:""}`;await renderCustomerDirectory();}catch(e){if(box)box.innerHTML=`<b>Diagnostics failed:</b> ${esc(e.message||"Unknown error")}`}}
async function openCustomerProfile(id){if(!requireAdmin())return;const box=document.getElementById("customerProfileBody");document.getElementById("customerModal").classList.add("open");updateMobileBackButton();box.innerHTML='<div class="productivityLoading">Loading customer profile…</div>';try{const d=await apiJSON(`/api/customers/${id}/profile`);customerProfileCache=d;renderCustomerProfile()}catch(e){box.innerHTML=`<div class="error">${esc(e.message||"Unable to load customer profile.")}</div>`}}
function renderCustomerProfile(){
 const d=customerProfileCache;if(!d)return;const c=d.customer||{},units=d.units||[],history=d.history||[];
 const customerName=cleanImportedDisplayText(c.customer_name)||"Customer Profile";document.getElementById("customerModalTitle").textContent=customerName;
 const box=document.getElementById("customerProfileBody"),fullbayCount=history.filter(x=>x.source==="fullbay").length,ittrCount=history.length-fullbayCount;
 box.innerHTML=`<div class="customerProfileHeader"><div><h2 style="margin:0">${esc(customerName)}</h2><div class="customerProfileMeta"><span class="badge">DOT ${esc(cleanVehicleMeta(c.dot_number)||"—")}</span><span class="badge">${units.length} vehicles</span><span class="badge">${history.length} service orders</span>${c.fullbay_id?`<span class="badge">Fullbay ${esc(cleanVehicleMeta(c.fullbay_id))}</span>`:""}</div></div><div><button class="secondary" onclick="openCustomerEditor(${c.id})">Edit Customer</button> <button onclick="openCustomerUnitEditor(${c.id})">+ Add Unit</button></div></div>
 <div class="customerWorkspaceTabs"><button id="custTabOverview" class="active" onclick="showCustomerPane('overview')">Overview</button><button id="custTabVehicles" onclick="showCustomerPane('vehicles')">Vehicles (${units.length})</button><button id="custTabHistory" onclick="showCustomerPane('history')">Service History (${history.length})</button></div>
 <div id="customerPaneOverview" class="customerPane"><div class="customerDirectoryGrid"><div class="card"><div class="muted">Contact</div><b>${esc(cleanImportedDisplayText(c.contact_name)||"—")}</b><div>${esc(cleanImportedDisplayText(c.phone)||"")}${c.email?` · ${esc(cleanImportedDisplayText(c.email))}`:""}</div></div><div class="card"><div class="muted">Location</div><b>${esc(uniqueImportedParts([c.city,c.state,c.postal_code]).join(", ")||"—")}</b><div>${esc(cleanImportedDisplayText(c.address)||"")}</div></div><div class="card"><div class="muted">Vehicles</div><b>${units.length}</b><div>${units.filter(u=>cleanVehicleMeta(u.vin)).length} with VIN</div></div><div class="card"><div class="muted">History</div><b>${history.length}</b><div>${fullbayCount} Fullbay · ${ittrCount} ITTR</div></div></div>${c.notes?`<div class="card"><b>Internal Notes</b><div style="margin-top:6px">${esc(cleanImportedDisplayText(c.notes))}</div></div>`:""}</div>
 <div id="customerPaneVehicles" class="customerPane hidden"><div class="toolbar"><div><h2>Vehicles</h2><div class="muted">One vehicle record per unit. VIN, mileage and history stay attached to this record.</div></div><button onclick="openCustomerUnitEditor(${c.id})">+ Add Truck / Unit</button></div><div class="unitCompactList">${units.length?units.map(u=>{const unit=cleanVehicleMeta(u.unit_number)||"—",vin=cleanVehicleMeta(u.vin)||"—",plate=cleanVehicleMeta(u.plate),status=cleanVehicleMeta(u.unit_status);return `<div class="unitCompactCard"><div class="unitCompactTitle"><div class="unitCompactMain"><b>Unit ${esc(unit)}</b><div class="unitVehicleName">${esc(vehicleDisplayName(u))}</div></div><button class="secondary" onclick="openCustomerUnitEditor(${c.id},${u.id})">Edit</button></div><div class="unitMetaLine"><span class="unitMetaLabel">VIN</span><span>${esc(vin)}</span>${plate?`<span>· Plate ${esc(plate)}</span>`:""}</div><div class="unitMetaLine">${u.mileage!=null?`<span>${Number(u.mileage).toLocaleString()} mi</span>`:""}${status?`<span>· ${esc(status)}</span>`:""}</div><div class="actions"><button class="secondary" onclick="openVehicleProfile(${u.id},'history')">Open Vehicle</button><button onclick="createWorkOrderForUnit(${u.id})">New Work Order</button></div></div>`}).join(""):'<div class="muted">No vehicles saved yet.</div>'}</div></div>
 <div id="customerPaneHistory" class="customerPane hidden"><div class="toolbar"><div><h2>Service History</h2><div class="muted">Each row is one service order. Open it for the complete repair detail.</div></div></div><div class="historyToolbar"><input id="customerHistorySearch" type="search" placeholder="Search SO, invoice, unit, repair…" oninput="renderCustomerHistoryRows()"><select id="customerHistoryUnit" onchange="renderCustomerHistoryRows()"><option value="">All vehicles</option>${units.map(u=>{const raw=String(u.unit_number||"").toLowerCase(),label=cleanVehicleMeta(u.unit_number)||"—";return `<option value="${esc(raw)}">Unit ${esc(label)}</option>`}).join("")}</select><select id="customerHistorySource" onchange="renderCustomerHistoryRows()"><option value="">All history</option><option value="fullbay">Fullbay imported</option><option value="ittr">ITTR</option></select></div><div style="overflow:auto"><table class="historyTable"><thead><tr><th>Date</th><th>Unit</th><th>Service Order</th><th>Work performed</th><th>Total</th><th></th></tr></thead><tbody id="customerHistoryRows"></tbody></table></div></div>`;
 renderCustomerHistoryRows();applyTranslations();
}
function showCustomerPane(name){for(const n of ["overview","vehicles","history"]){document.getElementById(`customerPane${n[0].toUpperCase()+n.slice(1)}`)?.classList.toggle("hidden",n!==name);document.getElementById(`custTab${n[0].toUpperCase()+n.slice(1)}`)?.classList.toggle("active",n===name)}}
function serviceHistorySummary(w){const tasks=(w.tasks||[]).map(t=>cleanImportedDisplayText(t.t||t.outcomeNote||"")).filter(Boolean);return tasks.slice(0,3).join(" · ")+(tasks.length>3?` + ${tasks.length-3} more`:"")}
function renderCustomerHistoryRows(){
 const body=document.getElementById("customerHistoryRows");if(!body||!customerProfileCache)return;
 const q=String(document.getElementById("customerHistorySearch")?.value||"").trim().toLowerCase(),unit=String(document.getElementById("customerHistoryUnit")?.value||""),source=String(document.getElementById("customerHistorySource")?.value||"");
 const rows=(customerProfileCache.history||[]).filter(w=>(!unit||String(w.unit||"").toLowerCase()===unit)&&(!source||w.source===source)&&(!q||[w.id,w.invoice,w.unit,w.vin,w.mechanic,serviceHistorySummary(w)].map(cleanImportedDisplayText).join(" ").toLowerCase().includes(q)));
 body.innerHTML=rows.length?rows.map(w=>`<tr><td>${esc(w.completedAt?fmtShortDate(w.completedAt):(cleanImportedDisplayText(w.date)||"—"))}</td><td><b>${esc(cleanVehicleMeta(w.unit)||"—")}</b><div class="muted">${w.mileage!=null?`${Number(w.mileage).toLocaleString()} mi`:""}</div></td><td><b>${w.source==="fullbay"?`SO #${esc(cleanVehicleMeta(w.id))}`:`WO #${esc(cleanVehicleMeta(w.id))}`}</b><div class="muted">${w.invoice?`Invoice #${esc(cleanVehicleMeta(w.invoice))}`:""}</div><span class="badge historySource">${w.source==="fullbay"?"Fullbay":"ITTR"}</span></td><td><div class="historySummary">${esc(serviceHistorySummary(w)||"No repair summary")}</div></td><td>${w.source==="fullbay"?money(w.totalAmount||0):"—"}</td><td><button class="secondary" onclick="${w.source==="fullbay"?`openFullbayServiceOrder('${encodeURIComponent(String(w.id||""))}',${customerProfileCache.customer?.id||'null'},'${encodeURIComponent(String(w.unit||""))}')`:`closeModal('customerModal');openDetail(${Number(w.id)})`}">Open</button></td></tr>`).join(""):'<tr><td colspan="6" class="muted">No matching service orders.</td></tr>';
}
function openVehicleHistory(encoded){showCustomerPane("history");const u=decodeURIComponent(encoded||"").toLowerCase(),sel=document.getElementById("customerHistoryUnit");if(sel){sel.value=u;renderCustomerHistoryRows()}document.getElementById("customerPaneHistory")?.scrollIntoView({behavior:"smooth",block:"start"})}
async function openFullbayServiceOrder(encodedSo,customerId,encodedUnit){
 const so=decodeURIComponent(encodedSo||""),unit=decodeURIComponent(encodedUnit||"");document.getElementById("serviceOrderModal").classList.add("open");updateMobileBackButton();document.getElementById("serviceOrderTitle").textContent=`Service Order #${cleanVehicleMeta(so)}`;const box=document.getElementById("serviceOrderBody");box.innerHTML='<div class="productivityLoading">Loading service order…</div>';
 try{
  const d=await apiJSON(`/api/fullbay/service-orders/${encodeURIComponent(so)}?customerId=${encodeURIComponent(customerId||"")}&unit=${encodeURIComponent(unit)}`),o=d.order||{};
  const techs=[o.leadTech,...(o.technicians||[])].map(cleanImportedPerson).filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  box.innerHTML=`<div class="soHero"><div class="soMetric"><div class="muted">Customer</div><b>${esc(cleanImportedDisplayText(o.customer)||"—")}</b></div><div class="soMetric"><div class="muted">Vehicle</div><b>Unit ${esc(cleanVehicleMeta(o.unit)||"—")}</b><div>${esc(cleanVehicleMeta(o.vin)||"")}</div></div><div class="soMetric"><div class="muted">Completed</div><b>${esc(o.completedAt?fmtDateTime(o.completedAt):"—")}</b><div>${o.mileage?`${Number(o.mileage).toLocaleString()} mi`:""}</div></div><div class="soMetric"><div class="muted">Invoice</div><b>${esc(o.invoice?`#${cleanVehicleMeta(o.invoice)}`:"—")}</b><div>${o.po?`PO ${esc(cleanVehicleMeta(o.po))}`:""}</div></div></div><div class="soHero"><div class="soMetric"><div class="muted">Labor</div><b>${money(o.laborAmount||0)}</b></div><div class="soMetric"><div class="muted">Parts</div><b>${money(o.partAmount||0)}</b></div><div class="soMetric"><div class="muted">Total</div><b>${money(o.totalAmount||0)}</b></div><div class="soMetric"><div class="muted">Labor Hours</div><b>${Number(o.hours||0).toFixed(2)}</b></div></div><div class="card"><b>Technicians</b><div>${esc(techs.join(", ")||"—")}</div></div><h3>Jobs / Work Performed</h3>${(o.actions||[]).map((a,i)=>{const complaint=cleanImportedDisplayText(a.complaint),correction=cleanImportedDisplayText(a.correction),component=cleanImportedDisplayText(a.component),system=cleanImportedDisplayText(a.system),tech=cleanImportedDisplayText(a.tech),action=cleanVehicleMeta(a.action);const title=complaint||component||`Job ${i+1}`;return `<div class="soJob"><h4>${action?`Action ${esc(action)} · `:""}${esc(title)}</h4>${complaint?`<div><b>Complaint / Requested work:</b> ${esc(complaint)}</div>`:""}${correction?`<div class="soCorrection"><b>What was done:</b> ${esc(correction)}</div>`:""}<div class="muted" style="margin-top:8px">${[system,component,tech].filter(Boolean).map(esc).join(" · ")}${a.hours?` · ${Number(a.hours).toFixed(2)} hr`:""} · Labor ${money(a.laborAmount||0)} · Parts ${money(a.partAmount||0)}</div></div>`}).join("")||'<div class="muted">No action details found.</div>'}<div class="muted" style="margin-top:14px">Historical record imported from Fullbay. Original SO #${esc(cleanVehicleMeta(o.serviceOrder||so))}.</div>`;
 }catch(e){box.innerHTML=`<div class="error">${esc(e.message||"Unable to load service order.")}</div>`}
}
function filterCustomerHistoryByUnit(encoded){openVehicleHistory(encoded)}
let customerUnitVinTimer=null,customerUnitVinLast="",vehicleProfileVinTimer=null,vehicleProfileVinLast="";
function normalizedVinInput(v){return String(v||"").trim().toUpperCase().replace(/\s+/g,"")}
function validVin17(v){return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalizedVinInput(v))}
function vinSummaryHtml(d){const details=[d.vehicleType,d.bodyClass,d.gvwr?`GVWR ${d.gvwr}`:"",d.driveType,d.fuelType].filter(Boolean).join(" · ");const engine=[d.engine||"",d.transmission?`Transmission: ${d.transmission}`:""].filter(Boolean).join(" · ");const plant=[d.plantCity,d.plantState,d.plantCountry].filter(Boolean).join(", ");return `<div class="vehicleMatchCard"><b>✓ NHTSA VIN decoded — ${esc([d.year,d.make,d.model].filter(Boolean).join(" ")||d.vin||"")}</b>${details?`<div class="muted">${esc(details)}</div>`:""}${engine?`<div class="muted">${esc(engine)}</div>`:""}${plant?`<div class="muted">Built: ${esc(plant)}</div>`:""}${d.errorCode&&d.errorCode!=="0"?`<div class="muted" style="margin-top:4px">NHTSA note: ${esc(d.errorText||`Code ${d.errorCode}`)}</div>`:""}</div>`}
function fillVinFields(prefix,d,replace=false){const map=prefix==="cu"?{Year:"year",Make:"make",Model:"model",Engine:"engine",Transmission:"transmission"}:{Year:"year",Make:"make",Model:"model",Engine:"engine",Transmission:"transmission"};Object.entries(map).forEach(([suffix,key])=>{const el=document.getElementById(prefix+suffix);if(el&&d?.[key]&&(replace||!String(el.value||"").trim()))el.value=d[key]})}
async function fetchOfficialVinDecode(vin){const v=normalizedVinInput(vin);if(!validVin17(v))throw new Error("Enter a valid 17-character VIN. VINs cannot contain I, O, or Q.");return await apiJSON(`/api/vin/${encodeURIComponent(v)}`)}
function scheduleCustomerUnitVinDecode(value){clearTimeout(customerUnitVinTimer);const v=normalizedVinInput(value),el=document.getElementById("cuVin");if(el&&el.value!==v)el.value=v;if(v.length!==17){customerUnitVinLast="";const card=document.getElementById("cuVinDecodeCard");if(card){card.classList.add("hidden");card.innerHTML=""}return}customerUnitVinTimer=setTimeout(()=>decodeCustomerUnitVIN(false),450)}
async function decodeCustomerUnitVIN(manual=false){const el=document.getElementById("cuVin"),v=normalizedVinInput(el?.value);if(!validVin17(v)){if(manual)alert("Enter a valid 17-character VIN. VINs cannot contain I, O, or Q.");return}if(!manual&&customerUnitVinLast===v)return;const card=document.getElementById("cuVinDecodeCard");if(card){card.classList.remove("hidden");card.innerHTML='<div class="vehicleMatchCard">Looking up VIN with NHTSA…</div>'}try{const r=await fetchOfficialVinDecode(v),d=r.item||r;customerUnitVinLast=v;fillVinFields("cu",d,false);if(card)card.innerHTML=vinSummaryHtml(d)+`<div class="actions"><button type="button" class="secondary" onclick="applyCustomerUnitVinReplace()">Replace vehicle fields with NHTSA data</button></div>`}catch(e){customerUnitVinLast="";if(card)card.innerHTML=`<div class="error"><b>VIN decode unavailable</b><div>${esc(e.message||"NHTSA lookup failed.")}</div></div>`}}
async function applyCustomerUnitVinReplace(){const v=normalizedVinInput(document.getElementById("cuVin")?.value);try{const r=await fetchOfficialVinDecode(v),d=r.item||r;fillVinFields("cu",d,true);const card=document.getElementById("cuVinDecodeCard");if(card)card.innerHTML=vinSummaryHtml(d)}catch(e){alert(e.message||"VIN decode failed.")}}
function scheduleVehicleProfileVinDecode(value){clearTimeout(vehicleProfileVinTimer);const v=normalizedVinInput(value),el=document.getElementById("vpVin");if(el&&el.value!==v)el.value=v;if(v.length!==17){vehicleProfileVinLast="";return}vehicleProfileVinTimer=setTimeout(()=>decodeVehicleVIN(false),450)}
function openCustomerUnitEditor(customerId,unitId=null){let u={};if(unitId){u=(customerProfileCache?.units||[]).find(x=>String(x.id)===String(unitId))||((vehicleProfileCache?.unit&&String(vehicleProfileCache.unit.id)===String(unitId))?vehicleProfileCache.unit:null)||{};}if(!customerId)customerId=customerProfileCache?.customer?.id||vehicleProfileCache?.customer?.id||u.customer_id||"";if(!customerId)return alert("This vehicle is not linked to a customer yet.");document.getElementById("cuCustomerId").value=customerId;document.getElementById("cuUnitId").value=unitId||"";document.getElementById("customerUnitTitle").textContent=unitId?"Edit Truck / Unit":"Add Truck / Unit";const map={cuUnit:"unit_number",cuVin:"vin",cuYear:"year",cuMake:"make",cuModel:"model",cuPlate:"plate",cuMileage:"mileage",cuEngine:"engine",cuTransmission:"transmission",cuNotes:"notes"};Object.entries(map).forEach(([id,k])=>{const e=document.getElementById(id),v=u?.[k]??"";if(e)e.value=typeof v==="string"?cleanImportedDisplayText(v):v});customerUnitVinLast="";const vc=document.getElementById("cuVinDecodeCard");if(vc){vc.classList.add("hidden");vc.innerHTML=""}document.getElementById("customerUnitModal").classList.add("open");updateMobileBackButton()}
document.getElementById("customerEditForm").onsubmit=async e=>{e.preventDefault();if(!requireAdmin())return;const f=new FormData(e.target),id=f.get("id"),body=Object.fromEntries(f.entries());body.active=document.getElementById("ceActive").checked;if(fmcsaCustomerLookupCache&&String(body.dot_number||"").replace(/\D/g,"")===String(fmcsaCustomerLookupCache.dotNumber||fmcsaLookupDot||"").replace(/\D/g,"")){const x=fmcsaCustomerLookupCache;Object.assign(body,{fmcsa_checked_at:x.checkedAt||new Date().toISOString(),fmcsa_dba_name:x.dbaName||"",fmcsa_mc_number:x.mcNumber||"",fmcsa_allowed_to_operate:x.allowedToOperate||"",fmcsa_out_of_service:x.outOfService||"",fmcsa_power_units:x.powerUnits??null,fmcsa_drivers:x.drivers??null,fmcsa_snapshot:x.raw||x});}try{if(id)await apiJSON(`/api/customers/${id}`,{method:"PUT",body:JSON.stringify(body)});else await apiJSON("/api/customers",{method:"POST",body:JSON.stringify(body)});closeModal("customerEditModal");await renderCustomerDirectory();if(id&&customerProfileCache&&String(customerProfileCache.customer?.id)===String(id))await openCustomerProfile(id)}catch(err){alert(err.message||"Customer could not be saved.")}};
document.getElementById("customerUnitForm").onsubmit=async e=>{e.preventDefault();if(!requireAdmin())return;const f=new FormData(e.target),customerId=f.get("customerId"),unitId=f.get("unitId"),body=Object.fromEntries(f.entries());try{if(unitId)await apiJSON(`/api/customer-units/${unitId}`,{method:"PUT",body:JSON.stringify(body)});else await apiJSON(`/api/customers/${customerId}/units`,{method:"POST",body:JSON.stringify(body)});closeModal("customerUnitModal");if(unitId&&document.getElementById("vehicleProfileModal")?.classList.contains("open"))await openVehicleProfile(unitId,vehicleProfilePane);else await openCustomerProfile(customerId);await renderCustomerDirectory()}catch(err){alert(err.message||"Unit could not be saved.")}};
function hideUnitSuggestions(mode){const el=document.getElementById(mode==="edit"?"editUnitSuggestions":"woUnitSuggestions");if(el)el.innerHTML=""}
function workOrderFormEl(mode,name){const form=document.getElementById(mode==="edit"?"editForm":"woForm");return form?.elements?.namedItem(name)||null}
function renderUnitSuggestions(mode,items){const box=document.getElementById(mode==="edit"?"editUnitSuggestions":"woUnitSuggestions");if(!box)return;box.innerHTML=(items||[]).map(x=>`<button type="button" class="unitSuggestItem" onclick="applyUnitSuggestion('${mode}',${Number(x.id)})"><b>Unit ${esc(cleanVehicleMeta(x.unit_number)||"")}</b> — ${esc(cleanImportedDisplayText(x.customer_name)||"No customer")}<div class="muted">${esc(smartResultMeta([cleanVehicleMeta(x.vin)||"",vehicleDisplayName(x),x.plate?`Plate ${cleanVehicleMeta(x.plate)}`:""])||"No vehicle details")}</div></button>`).join("")}
function renderWorkOrderVehicleMatch(mode,x){const box=document.getElementById(mode==="edit"?"editVehicleMatch":"woVehicleMatch");if(!box)return;if(!x){box.classList.add("hidden");box.innerHTML="";return}box.classList.remove("hidden");box.innerHTML=`<div class="vehicleMatchCard"><b>Matched Unit ${esc(cleanVehicleMeta(x.unit_number)||"")}</b><div>${esc(cleanImportedDisplayText(x.customer_name)||"")}${x.dot_number?` · DOT ${esc(cleanVehicleMeta(x.dot_number))}`:""}</div><div class="muted">${esc(smartResultMeta([cleanVehicleMeta(x.vin)||"",vehicleDisplayName(x),x.plate?`Plate ${cleanVehicleMeta(x.plate)}`:"",x.mileage!=null?`${Number(x.mileage).toLocaleString()} mi`:""])||"Vehicle details can be added in Customers")}</div></div>`}
async function customerUnitSuggest(input,mode){clearTimeout(unitLookupTimer);const q=String(input?.value||"").trim();if(q.length<1){hideUnitSuggestions(mode);return}unitLookupTimer=setTimeout(async()=>{try{const d=await apiJSON(`/api/customer-units/suggest?q=${encodeURIComponent(q)}`);unitSuggestionCache=d.items||[];renderUnitSuggestions(mode,unitSuggestionCache);const exact=unitSuggestionCache.filter(x=>String(x.unit_number||"").toLowerCase()===q.toLowerCase());if(exact.length===1)applyUnitSuggestion(mode,exact[0].id,false)}catch{}},160)}
function applyUnitSuggestion(mode,id,close=true){const x=unitSuggestionCache.find(v=>String(v.id)===String(id))||customerProfileCache?.units?.find(v=>String(v.id)===String(id));if(!x)return;const f=mode==="edit"?document.getElementById("editForm"):document.getElementById("woForm");const set=(name,val)=>{const e=f?.elements?.namedItem(name);if(e)e.value=val??""};set("unit",cleanVehicleMeta(x.unit_number));set("customer",cleanImportedDisplayText(x.customer_name||x.canonical_customer||""));set("customerId",x.customer_id||"");set("unitRecordId",x.id||"");set("vin",cleanVehicleMeta(x.vin));set("year",cleanImportedDisplayText(x.year));set("make",cleanImportedDisplayText(x.make));set("model",cleanImportedDisplayText(x.model));set("plate",cleanVehicleMeta(x.plate));set("mileage",x.mileage??"");set("dotNumber",cleanVehicleMeta(x.dot_number));renderWorkOrderVehicleMatch(mode,x);if(close)hideUnitSuggestions(mode)}
function createWorkOrderForUnit(unitId){const x=customerProfileCache?.units?.find(v=>String(v.id)===String(unitId));if(!x)return;closeModal("customerModal");openWorkOrder();unitSuggestionCache=[{...x,customer_name:customerProfileCache.customer?.customer_name||x.customer_name,dot_number:customerProfileCache.customer?.dot_number||""}];setTimeout(()=>applyUnitSuggestion("new",unitId),0)}

/* ===== ITTR PROFESSIONAL OPERATIONS MODULE v20 ===== */
const PRO_KEY="ittr_pro_v20";
function loadPro(){
 try{return JSON.parse(localStorage.getItem(PRO_KEY)||"{}")}catch(e){return {}}
}
let PRO=Object.assign({vehicles:[],maintenance:[],audit:[],notifications:[],delays:[]},loadPro());
function savePro(){localStorage.setItem(PRO_KEY,JSON.stringify(PRO));queueCloudState("pro",PRO)}

async function loadCloudStateAfterLogin(){
 const localUsers=USERS,localShop=state,localPro=PRO;
 const d=await apiJSON("/api/state");
 const remoteUsers=d.users?.payload||{},remoteShop=d.shopflow?.payload||{workorders:[],issues:[]},remotePro=d.pro?.payload||{};
 const remoteEmpty=Object.keys(remoteUsers).length===0 && (!remoteShop.workorders||remoteShop.workorders.length===0) && Object.keys(remotePro).length===0;
 const localHasData=Object.keys(localUsers||{}).length>0 || (localShop?.workorders||[]).length>0 || Object.keys(localPro||{}).length>0;
 if(remoteEmpty && localHasData && session?.role==="admin"){
   const useLocal=confirm("The online database is empty, but this browser has existing ITTR data. Upload this browser's current users/work orders/operations data to the cloud now?\n\nChoose OK to migrate it, or Cancel to start with an empty online database.");
   if(useLocal){await apiJSON("/api/state/import-local",{method:"POST",body:JSON.stringify({users:localUsers,shopflow:localShop,pro:localPro})});}
 }
 const fresh=await apiJSON("/api/state");
 USERS=fresh.users?.payload||{};
 state=fresh.shopflow?.payload||{workorders:[],issues:[]};
 PRO=fresh.pro?.payload||{};
 cloudVersions={users:Number(fresh.users?.version||0),shopflow:Number(fresh.shopflow?.version||0),pro:Number(fresh.pro?.version||0)};
 localStorage.setItem("ittr_users_v1",JSON.stringify(USERS));
 localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));
 localStorage.setItem(PRO_KEY,JSON.stringify(PRO));
 cloudReady=true;
}
async function restoreCloudSession(){
 if(!cloudToken||!session)return false;
 try{const d=await apiJSON("/api/auth/me");session={username:d.user.username,role:d.user.role,display:d.user.display};sessionStorage.setItem("ittr_session",JSON.stringify(session));await loadCloudStateAfterLogin();return true}catch(_){return false}
}

function audit(action,details="",unit=""){
 PRO.audit.unshift({at:new Date().toISOString(),user:session?.username||"system",action,details,unit});
 PRO.audit=PRO.audit.slice(0,3000);savePro();
}
function notifyPro(type,message,unit=""){
 PRO.notifications.unshift({id:Date.now()+Math.random(),at:new Date().toISOString(),type,message,unit,read:false});
 PRO.notifications=PRO.notifications.slice(0,1000);savePro();
}

let fullbayCustomerTimer=null,fullbayPartTimer=null,fullbayPartCache=[];
let fullbayBrowseTimer=null;
function money(v){const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n):"—"}
function debouncedFullbayBrowse(type){clearTimeout(fullbayBrowseTimer);fullbayBrowseTimer=setTimeout(()=>type==="customers"?loadFullbayCustomers(0):loadFullbayParts(0),220)}
function fullbayPager(id,type,total,offset,limit){const el=document.getElementById(id);if(!el)return;const page=Math.floor(offset/limit)+1,pages=Math.max(1,Math.ceil(total/limit));el.innerHTML=`<span class="muted">${Number(total).toLocaleString()} records · Page ${page} of ${pages}</span><button class="secondary" ${offset<=0?"disabled":""} onclick="${type==='customers'?'loadFullbayCustomers':'loadFullbayParts'}(${Math.max(0,offset-limit)})">← Previous</button><button class="secondary" ${offset+limit>=total?"disabled":""} onclick="${type==='customers'?'loadFullbayCustomers':'loadFullbayParts'}(${offset+limit})">Next →</button>`}
async function loadFullbayCustomers(offset=0){const out=document.getElementById("fullbayCustomerBrowser");if(!out)return;const q=document.getElementById("fullbayCustomerBrowserSearch")?.value?.trim()||"";out.innerHTML='<div class="productivityLoading">Loading customers…</div>';try{const d=await apiJSON(`/api/fullbay/customers?q=${encodeURIComponent(q)}&limit=50&offset=${offset}`);const items=d.items||[];out.innerHTML=items.length?`<table><thead><tr><th>Customer</th><th>Phone / DOT</th><th>Location</th><th>Terms</th><th>Account</th></tr></thead><tbody>${items.map(x=>`<tr><td><b>${esc(cleanImportedDisplayText(x.customer_name)||"")}</b><div class="muted">Fullbay ID ${esc(cleanVehicleMeta(x.fullbay_id)||"—")} · ${x.active===false?"Inactive":"Active"}</div></td><td>${esc(cleanImportedDisplayText(x.phone)||"—")}<div class="muted">${x.secondary_phone?esc(cleanImportedDisplayText(x.secondary_phone))+" · ":""}DOT ${esc(cleanVehicleMeta(x.dot_number)||"—")}</div></td><td>${esc(uniqueImportedParts([x.city,x.state,x.postal_code]).join(", ")||"—")}</td><td>${esc(cleanImportedDisplayText(x.credit_terms)||"—")}<div class="muted">Credit ${money(x.credit_limit)}</div></td><td>${esc(cleanImportedDisplayText(x.payment_method)||"—")}<div class="muted">${x.taxable===false?"Tax Exempt":"Taxable"}${x.price_level?" · "+esc(cleanImportedDisplayText(x.price_level)):""}</div></td></tr>`).join("")}</tbody></table>`:'<div class="muted">No customers found.</div>';fullbayPager("fullbayCustomerPager","customers",Number(d.total||0),Number(d.offset||0),Number(d.limit||50));}catch(e){out.innerHTML=`<div class="error">${esc(e.message||"Unable to load customers.")}</div>`}}
async function loadFullbayParts(offset=0){const out=document.getElementById("fullbayPartBrowser");if(!out)return;const q=document.getElementById("fullbayPartBrowserSearch")?.value?.trim()||"";out.innerHTML='<div class="productivityLoading">Loading inventory…</div>';try{const d=await apiJSON(`/api/fullbay/parts?q=${encodeURIComponent(q)}&limit=50&offset=${offset}`);const items=d.items||[];out.innerHTML=items.length?`<table><thead><tr><th>Part #</th><th>Description</th><th>Stock</th><th>Price / Cost</th><th>Location / Vendor</th><th>Manufacturer</th></tr></thead><tbody>${items.map(x=>`<tr><td><b>${esc(x.part_number||"—")}</b><div class="muted">${esc(x.status||"")}${x.category?" · "+esc(x.category):""}</div></td><td>${esc(x.description||"—")}${x.notes?`<div class="muted fullbayDetails">${esc(x.notes)}</div>`:""}</td><td class="${Number(x.quantity||0)<=Number(x.min_qty||0)&&x.min_qty!=null?'stockLow':''}">${Number(x.quantity||0).toLocaleString()} ${esc(x.uom||"")}<div class="muted">Allocated ${Number(x.allocated||0).toLocaleString()}</div></td><td>${money(x.price)}<div class="muted">Avg cost ${money(x.cost)}</div></td><td>${esc(x.location||"—")}<div class="muted">${esc(x.vendor||"—")}</div></td><td>${esc(x.manufacturer||"—")}</td></tr>`).join("")}</tbody></table>`:'<div class="muted">No inventory found.</div>';fullbayPager("fullbayPartPager","parts",Number(d.total||0),Number(d.offset||0),Number(d.limit||50));}catch(e){out.innerHTML=`<div class="error">${esc(e.message||"Unable to load inventory.")}</div>`}}

async function renderFullbayImportStatus(){
 const box=document.getElementById("fullbayImportStatus");if(!box)return;box.textContent="Loading…";
 try{const d=await apiJSON("/api/fullbay/import/status");const c=d.customers||{},p=d.parts||{},sv=d.service||{},u=d.units||{};box.innerHTML=`<b>Customers:</b> ${Number(c.n||0).toLocaleString()}${c.last?` · last updated ${esc(fmtDateTime(c.last))}`:""}<br><b>Known units:</b> ${Number(u.n||0).toLocaleString()}<br><b>Historical service actions:</b> ${Number(sv.n||0).toLocaleString()} · ${Number(sv.orders||0).toLocaleString()} service orders${sv.last?` · last updated ${esc(fmtDateTime(sv.last))}`:""}<br><b>Inventory records:</b> ${Number(p.n||0).toLocaleString()}${p.last?` · last updated ${esc(fmtDateTime(p.last))}`:""}${(d.recent||[]).length?`<hr><b>Recent imports</b><br>${d.recent.slice(0,6).map(x=>`${esc(fmtDateTime(x.created_at))} — ${esc(x.import_type)} — ${Number(x.rows_imported||0).toLocaleString()} imported, ${Number(x.rows_skipped||0)} skipped`).join("<br>")}`:""}`;const stats=document.getElementById("fullbayStats");if(stats)stats.innerHTML=`<div class="fullbayStat"><span class="muted">Customers</span><b>${Number(c.n||0).toLocaleString()}</b></div><div class="fullbayStat"><span class="muted">Units</span><b>${Number(u.n||0).toLocaleString()}</b></div><div class="fullbayStat"><span class="muted">Service Orders</span><b>${Number(sv.orders||0).toLocaleString()}</b></div><div class="fullbayStat"><span class="muted">Service Actions</span><b>${Number(sv.n||0).toLocaleString()}</b></div><div class="fullbayStat"><span class="muted">Inventory Parts</span><b>${Number(p.n||0).toLocaleString()}</b></div>`;loadFullbayCustomers(0);loadFullbayParts(0);}
 catch(e){box.textContent=e.message||"Unable to load Fullbay import status."}
}
async function uploadFullbayCsv(type){
 if(!requireAdmin())return;const input=document.getElementById(type==="customers"?"fullbayCustomersFile":"fullbayPartsFile");const file=input?.files?.[0];if(!file)return alert(`Choose the Fullbay ${type} CSV first.`);
 const fd=new FormData();fd.append("file",file);const box=document.getElementById("fullbayImportStatus");if(box)box.textContent=`Importing ${file.name}…`;
 try{const r=await fetch(`/api/fullbay/import/${type}`,{method:"POST",headers:{Authorization:`Bearer ${cloudToken}`},body:fd});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Import failed (${r.status})`);alert(`${type==="customers"?"Customers":"Parts"} imported: ${d.imported}. Skipped: ${d.skipped}.`);input.value="";renderFullbayImportStatus();}
 catch(e){if(box)box.textContent=e.message||"Import failed.";alert(e.message||"Import failed.")}
}
async function uploadFullbayServiceHistory(){
 if(!requireAdmin())return;const input=document.getElementById("fullbayServiceFile"),file=input?.files?.[0];if(!file)return alert("Choose the Fullbay Details / Service History CSV first.");
 const ok=confirm("Import units and historical service records from this Fullbay Details export? Existing matching records will be updated, not duplicated.");if(!ok)return;
 const fd=new FormData();fd.append("file",file);const box=document.getElementById("fullbayImportStatus");if(box)box.textContent=`Importing ${file.name}…`;
 try{const r=await fetch("/api/fullbay/import/service-history",{method:"POST",headers:{Authorization:`Bearer ${cloudToken}`},body:fd});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Import failed (${r.status})`);alert(`Fullbay Details imported successfully.\n\nRows: ${Number(d.imported||0).toLocaleString()}\nUnits linked/created: ${Number(d.units||0).toLocaleString()}\nCustomers matched: ${Number(d.customers||0).toLocaleString()}\nSkipped: ${Number(d.skipped||0).toLocaleString()}`);input.value="";await renderFullbayImportStatus();await renderCustomerDirectory();}
 catch(e){if(box)box.textContent=e.message||"Import failed.";alert(e.message||"Service history import failed.")}
}
async function decodeImportedUnitVins(){
 if(!requireAdmin())return;if(!confirm("Use the official NHTSA VIN decoder to fill missing year, make, model and available engine/transmission data for imported units?"))return;const box=document.getElementById("fullbayImportStatus");if(box)box.textContent="Decoding missing VIN details with NHTSA…";
 try{const d=await apiJSON("/api/customer-units/decode-missing-vins",{method:"POST",body:JSON.stringify({limit:100})});alert(`VIN decode finished.\nChecked: ${d.checked||0}\nUpdated: ${d.updated||0}\nFailed: ${d.failed||0}`);await renderFullbayImportStatus();await renderCustomerDirectory()}
 catch(e){alert(e.message||"VIN decode failed.");if(box)box.textContent=e.message||"VIN decode failed."}
}
async function fullbayTestSearch(type){
 const input=document.getElementById(type==="customers"?"fullbayCustomerTest":"fullbayPartTest"),out=document.getElementById(type==="customers"?"fullbayCustomerTestResults":"fullbayPartTestResults");if(!input||!out)return;const q=input.value.trim();if(q.length<2){out.innerHTML="";return}
 try{const d=await apiJSON(`/api/fullbay/${type}?q=${encodeURIComponent(q)}`);const items=d.items||[];out.innerHTML=items.length?items.slice(0,20).map(x=>type==="customers"?`<div class="partRow"><div><b>${esc(cleanImportedDisplayText(x.customer_name)||"")}</b><div class="muted">${esc([x.phone,x.email,[x.city,x.state].filter(Boolean).join(", ")].filter(Boolean).join(" · "))}</div></div></div>`:`<div class="partRow"><div><b>${esc(x.part_number||"—")}</b></div><div class="partDesc">${esc(x.description||"")}<div class="muted">${esc([x.vendor,x.location,x.quantity!=null?`Qty ${x.quantity}`:""].filter(Boolean).join(" · "))}</div></div></div>`).join(""):'<div class="muted">No matches.</div>'}
 catch(e){out.innerHTML=`<div class="muted">${esc(e.message||"Search failed")}</div>`}
}
function fullbayCustomerSuggest(input){
 clearTimeout(fullbayCustomerTimer);const q=String(input?.value||"").trim();if(q.length<2)return;fullbayCustomerTimer=setTimeout(async()=>{try{const d=await apiJSON(`/api/fullbay/customers?q=${encodeURIComponent(q)}`);const list=document.getElementById("fullbayCustomerList");if(list)list.innerHTML=(d.items||[]).map(x=>`<option value="${esc(cleanImportedDisplayText(x.customer_name)||"")}">${esc([x.phone,x.email].filter(Boolean).join(" · "))}</option>`).join("")}catch{}},180);
}
function fullbayPartSuggest(input,workOrderId,taskIndex,kind){
 clearTimeout(fullbayPartTimer);const q=String(input?.value||"").trim();if(q.length<2)return;fullbayPartTimer=setTimeout(async()=>{try{const d=await apiJSON(`/api/fullbay/parts?q=${encodeURIComponent(q)}`);fullbayPartCache=d.items||[];const numList=document.getElementById("fullbayPartNumberList"),descList=document.getElementById("fullbayPartDescriptionList");if(numList)numList.innerHTML=fullbayPartCache.filter(x=>x.part_number).map(x=>`<option value="${esc(x.part_number)}">${esc(x.description||"")}</option>`).join("");if(descList)descList.innerHTML=fullbayPartCache.filter(x=>x.description).map(x=>`<option value="${esc(x.description)}">${esc(x.part_number||"")}</option>`).join("");const v=q.toLowerCase();const match=fullbayPartCache.find(x=>String(kind==="number"?x.part_number:x.description||"").toLowerCase()===v);if(match){const pn=document.getElementById(`partNo_${workOrderId}_${taskIndex}`),pd=document.getElementById(`partDesc_${workOrderId}_${taskIndex}`);if(pn&&!pn.value.trim()&&match.part_number)pn.value=match.part_number;if(pd&&!pd.value.trim()&&match.description)pd.value=match.description;if(kind==="number"&&pd&&match.description)pd.value=match.description;if(kind==="description"&&pn&&match.part_number)pn.value=match.part_number;}}catch{}},180);
}

function showProPanel(name){
 if(name==="vehicles"){showView("customers");return}
 document.querySelectorAll(".proPanel").forEach(x=>x.classList.add("hidden"));
 document.getElementById("proPanel"+name.charAt(0).toUpperCase()+name.slice(1))?.classList.remove("hidden");
 if(name==="vehicles")renderVehicleProfiles();
 if(name==="maintenance")renderMaintenance();
 if(name==="productivity")renderProductivity();
 if(name==="notifications")renderProNotifications();
 if(name==="dailyreport")renderDailyReport();
 if(name==="audit")renderAuditLog();
 if(name==="fullbay")renderFullbayImportStatus();
 if(name==="aitools")checkAIConnection();
}
async function saveVehicleProfile(){
 const unit=(document.getElementById("vpUnit")?.value||"").trim();if(!unit)return alert(tr("Unit number required."));
 const data={unit,vin:(vpVin.value||"").trim().toUpperCase(),customer:vpCustomer.value.trim(),mileage:+vpMileage.value||0,year:vpYear.value.trim(),make:vpMake.value.trim(),model:vpModel.value.trim(),plate:vpPlate.value.trim(),engine:vpEngine.value.trim(),transmission:vpTransmission.value.trim(),parking:vpParking.value.trim(),notes:vpNotes.value.trim(),updatedAt:new Date().toISOString()};
 const i=PRO.vehicles.findIndex(v=>String(v.unit).toLowerCase()===unit.toLowerCase());
 if(i>=0)PRO.vehicles[i]={...PRO.vehicles[i],...data};else PRO.vehicles.push(data);
 savePro();
 try{await apiJSON("/api/customer-units/from-vehicle-profile",{method:"POST",body:JSON.stringify(data)});}catch(e){showSyncError(`Vehicle saved locally, but Customer Unit Directory sync failed: ${e.message}`);}
 audit("Vehicle profile saved",`${data.year} ${data.make} ${data.model}`,unit);renderVehicleProfiles();
 if(document.getElementById("viewCustomers")&&!document.getElementById("viewCustomers").classList.contains("hidden"))await renderCustomerDirectory();
}
function renderVehicleProfiles(){
 const box=document.getElementById("vehicleProfileResults");if(!box)return;
 const q=(document.getElementById("vpSearch")?.value||"").toLowerCase();
 let arr=PRO.vehicles.filter(v=>!q||JSON.stringify(v).toLowerCase().includes(q));
 box.innerHTML=arr.length?arr.map(v=>{
  const history=(state.workorders||[]).filter(w=>String(w.unit).toLowerCase()===String(v.unit).toLowerCase());
  const findings=(state.issues||[]).filter(i=>String(i.unitSnapshot||"").toLowerCase()===String(v.unit).toLowerCase()||history.some(w=>w.id==i.wo));
  return `<div class="vehicleCard"><div style="display:flex;justify-content:space-between;gap:10px"><div><h3 style="margin:0">Unit ${esc(v.unit)}</h3><div class="muted">${esc([v.year,v.make,v.model].filter(Boolean).join(" "))} · ${esc(v.customer||"")}</div></div><span class="badge">${Number(v.mileage||0).toLocaleString()} mi</span></div>
  <div class="muted">VIN: ${esc(v.vin||"—")} · Plate: ${esc(v.plate||"—")} · Parking: ${esc(v.parking||"—")}</div>
  <div>${esc(v.engine||"")} ${v.transmission?`· ${esc(v.transmission)}`:""}</div>${v.notes?`<div style="margin-top:6px"><b>Notes:</b> ${esc(v.notes)}</div>`:""}
  <div class="truckSearchChips"><span class="badge">${history.length} work orders</span><span class="badge">${findings.length} findings</span></div>
  <div class="actions"><button class="secondary" onclick="loadVehicleProfile('${encodeURIComponent(v.unit)}')">Edit</button><button class="secondary" onclick="openUnitInTruckSearch('${encodeURIComponent(v.unit)}')">Full History</button></div></div>`;
 }).join(""):'<div class="truckSearchEmpty">No vehicle profiles yet.</div>';
}
function loadVehicleProfile(encoded){
 const unit=decodeURIComponent(encoded),v=PRO.vehicles.find(x=>String(x.unit)===unit);if(!v)return;
 const map={vpUnit:"unit",vpVin:"vin",vpCustomer:"customer",vpMileage:"mileage",vpYear:"year",vpMake:"make",vpModel:"model",vpPlate:"plate",vpEngine:"engine",vpTransmission:"transmission",vpParking:"parking",vpNotes:"notes"};
 Object.entries(map).forEach(([id,k])=>{const e=document.getElementById(id);if(e)e.value=v[k]??""});
 window.scrollTo({top:0,behavior:"smooth"});
}
function openUnitInTruckSearch(encoded){
 const unit=decodeURIComponent(encoded);showView("trucksearch");setTimeout(()=>{const e=document.getElementById("truckGlobalSearch");if(e){e.value=unit;renderTruckSearch()}},0);
}
async function decodeVehicleVIN(manual=true){
 const vin=normalizedVinInput(document.getElementById("vpVin")?.value);if(!validVin17(vin)){if(manual)alert(tr("Enter a valid 17-character VIN."));return}
 if(!manual&&vehicleProfileVinLast===vin)return;
 try{const r=await fetchOfficialVinDecode(vin),d=r.item||r;vehicleProfileVinLast=vin;fillVinFields("vp",d,false);if(manual&&d.errorCode&&d.errorCode!=="0")alert(`NHTSA decoded the VIN with a note: ${d.errorText||d.errorCode}`)}catch(e){vehicleProfileVinLast="";if(manual)alert(e.message||"VIN decode failed.")}
}
function addMaintenancePlan(){
 const unit=maintUnit.value.trim(),service=maintService.value.trim(),interval=+maintInterval.value,last=+maintLastMileage.value;
 if(!unit||!service||!interval)return alert(tr("Unit, service and interval are required."));
 PRO.maintenance.push({id:Date.now(),unit,service,interval,lastMileage:last,createdAt:new Date().toISOString()});savePro();audit("Maintenance plan added",`${service} every ${interval} miles`,unit);renderMaintenance();
}
function maintenanceState(m){
 const v=PRO.vehicles.find(v=>String(v.unit).toLowerCase()===String(m.unit).toLowerCase()),current=+v?.mileage||0,due=(+m.lastMileage||0)+(+m.interval||0),left=due-current;
 return {current,due,left,status:left<0?"Overdue":left<=Math.max(1000,m.interval*.1)?"Due Soon":"OK"};
}
function renderMaintenance(){
 const box=document.getElementById("maintenanceResults");if(!box)return;
 box.innerHTML=PRO.maintenance.length?PRO.maintenance.map(m=>{const s=maintenanceState(m);return `<div class="maintCard"><div style="display:flex;justify-content:space-between"><div><b>Unit ${esc(m.unit)} — ${esc(m.service)}</b><div class="muted">Every ${Number(m.interval).toLocaleString()} mi · Last: ${Number(m.lastMileage).toLocaleString()} · Due: ${Number(s.due).toLocaleString()}</div></div><span class="badge ${s.status==="Overdue"?"b-high":s.status==="Due Soon"?"b-wait":""}">${s.status}</span></div></div>`}).join(""):'<div class="truckSearchEmpty">No maintenance plans yet.</div>';
}
const WORKFLOW_STATUSES=["Scheduled","Truck On The Way","Truck Arrived","Waiting for Diagnosis","Diagnosis In Progress","Waiting for Customer Approval","Waiting for Parts","Parts Arrived","Ready for Mechanic","In Progress","QC Inspection","Ready for Pickup","Completed","Invoiced","Paid"];
function setProfessionalStatus(id,status){
 const w=state.workorders.find(x=>x.id==id);if(!w)return;const old=w.status;w.status=status;save();audit("Work order status changed",`${old} → ${status}`,w.unit);notifyPro("status",`Unit ${w.unit}: ${status}`,w.unit);render();
}
function startDelay(id,type,note=""){
 const w=state.workorders.find(x=>x.id==id);if(!w)return;
 const active=PRO.delays.find(d=>d.wo==id&&!d.endedAt);if(active)return alert(tr("A delay is already running."));
 PRO.delays.unshift({id:Date.now(),wo:id,unit:w.unit,type,note,startedAt:new Date().toISOString(),endedAt:""});savePro();audit("Delay started",type,w.unit);
}
function stopDelay(id){
 const d=PRO.delays.find(x=>x.wo==id&&!x.endedAt);if(!d)return;d.endedAt=new Date().toISOString();savePro();audit("Delay stopped",d.type,d.unit);
}
let productivityLastData=null;
function productivityLocalDateKey(value){const d=value instanceof Date?value:new Date(value);if(isNaN(d))return "";return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function productivityDateAtMidnight(dateStr){const [y,m,d]=String(dateStr||"").split("-").map(Number);return new Date(y||new Date().getFullYear(),(m||1)-1,d||1,0,0,0,0)}
function productivityRange(){const el=document.getElementById("productivityDate"),period=document.getElementById("productivityPeriod")?.value||"day";if(el&&!el.value)el.value=productivityLocalDateKey(new Date());let base=productivityDateAtMidnight(el?.value||productivityLocalDateKey(new Date())),start=new Date(base),end=new Date(base);if(period==="week"){const dow=(base.getDay()+6)%7;start.setDate(base.getDate()-dow);end=new Date(start);end.setDate(start.getDate()+7)}else if(period==="month"){start=new Date(base.getFullYear(),base.getMonth(),1);end=new Date(base.getFullYear(),base.getMonth()+1,1)}else end.setDate(start.getDate()+1);return {period,start,end,label:period==="day"?start.toLocaleDateString():period==="week"?`${start.toLocaleDateString()} – ${new Date(end-1).toLocaleDateString()}`:start.toLocaleDateString(undefined,{month:"long",year:"numeric"})}}
function setProductivityToday(){const e=document.getElementById("productivityDate");if(e)e.value=productivityLocalDateKey(new Date());renderProductivity()}
function shiftProductivityDate(direction){const e=document.getElementById("productivityDate");if(!e)return;const r=productivityRange(),d=productivityDateAtMidnight(e.value);if(r.period==="month")d.setMonth(d.getMonth()+direction);else if(r.period==="week")d.setDate(d.getDate()+7*direction);else d.setDate(d.getDate()+direction);e.value=productivityLocalDateKey(d);renderProductivity()}
function populateProductivityMechanics(){const e=document.getElementById("productivityMechanic");if(!e)return;const cur=e.value||"all";const opts=Object.entries(USERS||{}).filter(([,u])=>u.role==="mechanic").sort((a,b)=>String(a[1].display||a[0]).localeCompare(String(b[1].display||b[0])));e.innerHTML='<option value="all">All Mechanics</option>'+opts.map(([u,v])=>`<option value="${esc(u)}">${esc(v.display||u)}</option>`).join("");e.value=opts.some(([u])=>u===cur)?cur:"all"}
function overlapMs(start,end,rangeStart,rangeEnd){const a=Math.max(new Date(start).getTime(),rangeStart.getTime()),b=Math.min(end?new Date(end).getTime():Date.now(),rangeEnd.getTime());return Math.max(0,b-a)}
function splitSessionByDay(session,rangeStart,rangeEnd){const out=[];let cursor=new Date(Math.max(new Date(session.startedAt).getTime(),rangeStart.getTime()));const stop=new Date(Math.min(session.endedAt?new Date(session.endedAt).getTime():Date.now(),rangeEnd.getTime()));while(cursor<stop){const next=new Date(cursor);next.setHours(24,0,0,0);const segEnd=new Date(Math.min(next.getTime(),stop.getTime()));out.push({day:productivityLocalDateKey(cursor),ms:Math.max(0,segEnd-cursor),startedAt:new Date(cursor),endedAt:segEnd});cursor=segEnd}return out}
async function renderProductivity(){
 const box=document.getElementById("productivityResults");if(!box)return;populateProductivityMechanics();const range=productivityRange(),mf=document.getElementById("productivityMechanic")?.value||"all";box.innerHTML='<div class="productivityLoading">Loading recorded labor sessions…</div>';
 try{
  const qs=new URLSearchParams({start:range.start.toISOString(),end:range.end.toISOString()});if(mf!=="all")qs.set("mechanic",mf);
  const data=await apiJSON(`/api/admin/productivity?${qs.toString()}`);productivityLastData={...data,range,mf};
  const byDay={};for(let d=new Date(range.start);d<range.end;d.setDate(d.getDate()+1))byDay[productivityLocalDateKey(d)]={};
  (data.sessions||[]).forEach(sess=>splitSessionByDay(sess,range.start,range.end).forEach(seg=>{const day=byDay[seg.day]||(byDay[seg.day]={}),row=day[sess.mechanicUsername]||(day[sess.mechanicUsername]={laborMs:0,sessions:[],tasks:new Set(),units:new Set(),completed:0});row.laborMs+=seg.ms;row.sessions.push({...sess,segmentMs:seg.ms,segmentStart:seg.startedAt,segmentEnd:seg.endedAt});row.tasks.add(`${sess.workOrderId}|${sess.taskUid}`);if(sess.unit)row.units.add(sess.unit);if(String(sess.endReason||"").toLowerCase()==="completed"&&sess.endedAt&&productivityLocalDateKey(sess.endedAt)===seg.day)row.completed++}));
  const activityByDay={};Object.entries(USERS||{}).forEach(([username,u])=>{if(u.role!=="mechanic"||(mf!=="all"&&username!==mf))return;(u.activityHistory||[]).forEach(a=>{const aStart=new Date(a.startedAt||"");if(isNaN(aStart))return;const aEnd=a.endedAt?new Date(a.endedAt):new Date();for(let d=new Date(range.start);d<range.end;d.setDate(d.getDate()+1)){const dayStart=new Date(d),dayEnd=new Date(d);dayEnd.setDate(dayEnd.getDate()+1);const ms=overlapMs(aStart,aEnd,dayStart,dayEnd);if(ms){const key=productivityLocalDateKey(dayStart);activityByDay[key]??={};activityByDay[key][username]=(activityByDay[key][username]||0)+ms}}})});
  const mechanicNames=Object.fromEntries(Object.entries(USERS||{}).map(([u,v])=>[u,v.display||u]));let shopLabor=0,shopOther=0,shopTasks=new Set(),shopUnits=new Set();
  const allMechanicUsernames=Object.entries(USERS||{}).filter(([,u])=>u.role==="mechanic").map(([u])=>u);const dayHtml=Object.keys(byDay).sort().reverse().map(day=>{const rows=[];const names=new Set([...Object.keys(byDay[day]||{}),...Object.keys(activityByDay[day]||{}),...(mf==="all"?allMechanicUsernames:[])]);if(mf!=="all")names.add(mf);for(const username of [...names].sort((a,b)=>String(mechanicNames[a]||a).localeCompare(String(mechanicNames[b]||b)))){const r=byDay[day]?.[username]||{laborMs:0,sessions:[],tasks:new Set(),units:new Set(),completed:0},other=activityByDay[day]?.[username]||0;shopLabor+=r.laborMs;shopOther+=other;r.tasks.forEach(x=>shopTasks.add(x));r.units.forEach(x=>shopUnits.add(x));const detail=r.sessions.length?`<details class="productivityDetail"><summary>Audit ${r.sessions.length} time session${r.sessions.length===1?"":"s"}</summary>${r.sessions.sort((a,b)=>new Date(a.segmentStart)-new Date(b.segmentStart)).map(x=>`<div class="productivityDetailRow"><div>${new Date(x.segmentStart).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}–${new Date(x.segmentEnd).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</div><div><b>Unit ${esc(x.unit||"—")}</b> · ${esc(x.taskName||"Task")}<div class="muted">WO ${esc(x.workOrderId)}${x.pauseReason?` · ${esc(x.pauseReason)}`:""}${x.pauseNote?` — ${esc(x.pauseNote)}`:""}</div></div><b>${activityHistoryDurationLabel(x.segmentMs)}</b></div>`).join("")}</details>`:'<div class="muted">No recorded repair-task sessions.</div>';rows.push(`<tr><td><b>${esc(mechanicNames[username]||username)}</b><div class="muted">@${esc(username)}</div></td><td><b>${activityHistoryDurationLabel(r.laborMs)}</b></td><td>${r.tasks.size}</td><td>${r.completed}</td><td>${r.units.size}</td><td>${activityHistoryDurationLabel(other)}</td></tr><tr><td colspan="6">${detail}</td></tr>`)}return `<div class="card productivityDay"><h3>${new Date(day+"T12:00:00").toLocaleDateString(currentLanguage==="uk"?"uk-UA":"en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</h3><table class="productivityTable"><thead><tr><th>Mechanic</th><th>Repair Labor</th><th>Tasks Worked</th><th>Completed Sessions</th><th>Units</th><th>Other Activity</th></tr></thead><tbody>${rows.join("")||'<tr><td colspan="6" class="muted">No recorded activity.</td></tr>'}</tbody></table></div>`}).join("");
  box.innerHTML=`<div class="card"><h2>${esc(range.label)}</h2><div class="proMetricGrid"><div class="proMetric"><strong>${activityHistoryDurationLabel(shopLabor)}</strong><span class="muted">Recorded repair labor</span></div><div class="proMetric"><strong>${shopTasks.size}</strong><span class="muted">Unique tasks worked</span></div><div class="proMetric"><strong>${shopUnits.size}</strong><span class="muted">Units worked on</span></div><div class="proMetric"><strong>${activityHistoryDurationLabel(shopOther)}</strong><span class="muted">Other recorded activity</span></div></div></div>${dayHtml}`;
 }catch(e){box.innerHTML=`<div class="notice">Productivity history unavailable: ${esc(e.message||"Unable to load")}</div>`}
}
async function aiProductivitySummary(){const out=document.getElementById("productivityAiSummary");if(!out)return;if(!productivityLastData){await renderProductivity();if(!productivityLastData)return}out.textContent="Working…";try{const d=productivityLastData,r=d.range;const payload={period:r.label,sessions:(d.sessions||[]).map(x=>({mechanic:x.mechanicUsername,unit:x.unit,task:x.taskName,startedAt:x.startedAt,endedAt:x.endedAt,endReason:x.endReason}))};const result=await proAI("/api/ai/productivity-summary",payload);out.textContent=result||""}catch(e){out.textContent=e.message||"AI summary failed."}}

function buildProNotifications(){
 const pending=(state.issues||[]).filter(i=>(i.approval||"Waiting for Customer")==="Waiting for Customer");
 const overdue=PRO.maintenance.filter(m=>maintenanceState(m).status==="Overdue");
 return [
  ...pending.map(i=>({type:"approval",message:`Customer approval pending: ${i.description||"finding"}`,unit:i.unitSnapshot||""})),
  ...overdue.map(m=>({type:"maintenance",message:`Maintenance overdue: ${m.service}`,unit:m.unit}))
 ];
}
function renderProNotifications(){
 const box=document.getElementById("notificationResults");if(!box)return;
 const live=buildProNotifications(),saved=PRO.notifications;
 const all=[...live,...saved].slice(0,100);
 box.innerHTML=`<h2>Shop Notifications</h2>`+(all.length?all.map(n=>`<div class="noticeRow"><b>${esc(n.unit?`Unit ${n.unit}`:"Shop")}</b> — ${esc(n.message)}${n.at?`<div class="muted">${fmtDateTime(n.at)}</div>`:""}</div>`).join(""):'<div class="truckSearchEmpty">No notifications.</div>');
}
function renderDailyReport(){
 const box=document.getElementById("dailyReportResults");if(!box)return;
 const el=document.getElementById("dailyReportDate");if(el&&!el.value)el.value=new Date().toISOString().slice(0,10);
 const day=el?.value||new Date().toISOString().slice(0,10);
 const worked=(state.workorders||[]).filter(w=>String(w.date||w.completedAt||"").slice(0,10)===day);
 const completed=(state.workorders||[]).filter(w=>String(w.completedAt||"").slice(0,10)===day);
 const activities=[];Object.entries(USERS||{}).forEach(([username,u])=>(u.activityHistory||[]).filter(a=>String(a.startedAt||"").slice(0,10)===day).forEach(a=>activities.push({...a,username,display:u.display||username})));
 const approvals=(state.issues||[]).filter(i=>(i.approval||"Waiting for Customer")==="Waiting for Customer");
 box.innerHTML=`<div class="card"><h2>Daily Shop Report — ${esc(day)}</h2><div class="proMetricGrid"><div class="proMetric"><strong>${worked.length}</strong>Scheduled / worked</div><div class="proMetric"><strong>${completed.length}</strong>Completed</div><div class="proMetric"><strong>${approvals.length}</strong>Approvals pending</div><div class="proMetric"><strong>${activities.length}</strong>Recorded activities</div></div>
 <h3>Completed Units</h3>${completed.map(w=>`<div>• Unit ${esc(w.unit)} — ${esc(w.customer||"")} — ${esc(w.completionNotes||"Completed")}</div>`).join("")||'<div class="muted">None</div>'}
 <h3>Mechanic Activity</h3>${activities.map(a=>`<div>• ${esc(a.display)} — ${esc(mechanicActivityLabel(a.code,a.customText))} — ${activityHistoryDurationLabel(activityHistoryDurationMs(a))}</div>`).join("")||'<div class="muted">None</div>'}</div>`;
}
function renderAuditLog(){
 const box=document.getElementById("auditResults");if(!box)return;
 box.innerHTML=`<h2>Audit Log</h2>`+(PRO.audit.length?PRO.audit.slice(0,500).map(a=>`<div class="auditRow"><b>${esc(a.action)}</b>${a.unit?` · Unit ${esc(a.unit)}`:""}<div>${esc(a.details||"")}</div><div class="muted">${fmtDateTime(a.at)} · ${esc(a.user||"")}</div></div>`).join(""):'<div class="truckSearchEmpty">No audit records yet.</div>');
}

async function checkAIConnection(){
 const el=document.getElementById("aiConnectionStatus");if(el)el.textContent="Checking server…";
 if(location.protocol==="file:"){if(el)el.textContent="Open ITTR through http://localhost:3000, not as a file.";return}
 try{
   const r=await fetch("/api/ai/status",{headers:authHeaders()});
   const d=await r.json();
   if(el){
     el.textContent=d.aiConfigured
       ?`Connected — ${d.message||"AI is configured and ready."}`
       :"Server connected — add OPENROUTER_API_KEY (recommended) or OPENAI_API_KEY in Railway.";
     el.style.fontWeight="700";
   }
 }catch(e){
   if(el)el.textContent="Cannot reach ITTR server.";
 }
}

async function proAI(endpoint,payload){
 if(location.protocol==="file:"){
   alert(tr("AI tools require the ITTR server. Run the server and use http://localhost:3000."));
   return null;
 }
 try{
   const r=await fetch(endpoint,{method:"POST",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify(payload)});
   let d={};try{d=await r.json()}catch(_){}
   if(!r.ok)throw new Error(d.error||`Server error ${r.status}`);
   return d.result??d.translation??d;
 }catch(e){
   const msg=(e?.message==="Failed to fetch")
     ?"Cannot reach the ITTR server."
     :String(e?.message||"AI request failed");
   alert(msg);
   return null;
 }
}
async function aiProfessionalNote(mode="professional"){
 const text=aiShopText.value.trim();if(!text)return;aiShopResult.textContent="Working…";try{const r=await proAI("/api/ai/note",{text,mode});aiShopResult.textContent=r||""}catch(e){aiShopResult.textContent=e.message||"AI request failed."}
}
async function professionalizeFormField(formId,fieldName,mode="professional"){const form=document.getElementById(formId),el=form?.querySelector(`[name="${fieldName}"]`);if(!el||!el.value.trim())return alert(tr("Enter text first."));const original=el.value;el.disabled=true;try{const r=await proAI("/api/ai/note",{text:original,mode});if(r)el.value=r}finally{el.disabled=false;el.focus()}}
async function professionalizeIssueField(fieldName){return professionalizeFormField("issueForm",fieldName,fieldName==="recommendation"?"recommendation":"technical")}
function copyAIResult(id){const text=document.getElementById(id)?.textContent||"";if(!text.trim())return;navigator.clipboard?.writeText(text).then(()=>{}).catch(()=>{})}
async function aiDiagnosticAssistant(){
 const text=aiDiagnosticInput.value.trim();if(!text)return;aiDiagnosticResult.textContent="Working…";const r=await proAI("/api/ai/diagnostic",{text});aiDiagnosticResult.textContent=r||"";
}
async function aiPartAssistant(){
 const query=aiPartQuery.value.trim();if(!query)return;aiPartResult.textContent="Working…";const r=await proAI("/api/ai/part",{vin:aiPartVin.value.trim(),query});aiPartResult.textContent=r||"";
}
async function startVoiceNote(){
 if(!navigator.mediaDevices?.getUserMedia)return alert(tr("Microphone is not available in this browser."));
 try{
  const stream=await navigator.mediaDevices.getUserMedia({audio:true}),rec=new MediaRecorder(stream),chunks=[];
  rec.ondataavailable=e=>chunks.push(e.data);
  rec.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:rec.mimeType});const fd=new FormData();fd.append("audio",blob,"note.webm");aiShopResult.textContent="Transcribing…";try{const rr=await fetch("/api/transcribe",{method:"POST",headers:authHeaders(),body:fd}),d=await rr.json();if(!rr.ok)throw new Error(d.error||"Transcription failed");aiShopText.value=d.text||"";aiShopResult.textContent="Transcription complete."}catch(e){aiShopResult.textContent=e.message}};
  rec.start();aiShopResult.textContent="Recording… press OK to stop.";setTimeout(()=>{alert(tr("Recording started. Press OK here, then recording will stop."));if(rec.state==="recording")rec.stop()},200);
 }catch(e){alert(tr("Microphone permission is required."))}
}
function renderProCenter(){
 renderVehicleProfiles();renderMaintenance();if(!document.getElementById("proPanelProductivity")?.classList.contains("hidden"))renderProductivity();renderProNotifications();renderDailyReport();renderAuditLog();
}

function render(){
 const wo=state.workorders||[];
 const issues=state.issues||[];
 const completed=wo.filter(w=>w.status==="Completed");

 if(session?.role==="admin"){
   renderAdminTable();

   const completedTable=document.getElementById("completedTable");
   if(completedTable){
     completedTable.innerHTML=completed.map(w=>`<tr><td>#${w.id}</td><td><b>${esc(w.unit)}</b></td><td>${esc(w.customer)}</td><td>${esc(mechanicDisplay(w.mechanic))}</td><td>${esc(w.completedAt||"")}</td><td>${esc(w.parking||"—")}</td><td><button class="secondary" onclick="openDetail(${w.id})">View</button> <button class="secondary" onclick="downloadWorkOrderPDF(${w.id})">Download Work Order PDF</button></td></tr>`).join("")||'<tr><td colspan="7" class="empty">No completed work orders yet.</td></tr>';
   }

   renderFindingsCenter();

   renderMechanicAccounts();
   refreshMechanicSelects();
   renderCalendar();
   renderMechanicLiveStatus();
   renderTruckSearch();
   renderMechanicActivityHistory();
   renderProCenter();
 }

 if(session?.role==="mechanic"){
   const upcomingBox=document.getElementById("mechanicUpcoming");
   if(upcomingBox){
     upcomingBox.innerHTML=wo.filter(upcomingForCurrentMechanic).map(mechanicUpcomingCard).join("")||'<div class="card empty">No upcoming assigned trucks.</div>';
   }

   const jobsBox=document.getElementById("mechanicJobs");
   if(jobsBox){
     jobsBox.innerHTML=wo.filter(visibleToCurrentMechanic).map(mechanicCard).join("")||'<div class="card empty">No trucks ready to work on.</div>';
   }

   const issuesBox=document.getElementById("issues");
   if(issuesBox){
     const mine=issues.filter(i=>!i.mechanic||i.mechanic===session.username).sort((a,b)=>findingDateValue(b)-findingDateValue(a)),groups={};
     mine.forEach(i=>{const dk=findingDayKey(i),w=wo.find(x=>x.id==i.wo),unit=w?.unit||i.unitSnapshot||"Unknown Unit",k=`${dk}|||${unit}`;(groups[k]||(groups[k]={date:dk,unit,items:[]})).items.push(i)});
     issuesBox.innerHTML=Object.values(groups).map(g=>`<div class="findingUnitGroup"><div class="findingUnitHeader" style="cursor:default"><div><div class="findingUnitName">${esc(g.unit)}</div><div class="findingUnitMeta">${esc(findingDateLabel(g.date))} · ${g.items.length} finding${g.items.length===1?"":"s"}</div></div></div><div class="findingUnitBody">${g.items.map(issueCard).join("")}</div></div>`).join("")||'<div class="card empty">No inspection findings yet.</div>';
   }

   const issueWO=document.getElementById("issueWO");
   if(issueWO){
     issueWO.innerHTML=wo.filter(visibleToCurrentMechanic).map(w=>`<option value="${w.id}">${esc(w.unit)}</option>`).join("");
   }

   renderMyCompleted();
 }

 const pendingApprovals=issues.filter(i=>(i.approval||"Waiting for Customer")==="Waiting for Customer");

 const notify=document.getElementById("approvalNotify");
 if(notify){
   notify.textContent=pendingApprovals.length;
   notify.style.display=(session?.role==="admin" && pendingApprovals.length)?"inline-block":"none";
 }

 const mobileNotify=document.getElementById("mobileApprovalNotify");
 if(mobileNotify){
   mobileNotify.textContent=pendingApprovals.length;
   mobileNotify.style.display=(session?.role==="admin" && pendingApprovals.length)?"inline-block":"none";
 }

 updateMobileBackButton();
 applyTranslations();
 hydrateFindingPhotos();
}
function renderAdminTable(){
 const table=document.getElementById("workTable");
 if(!table || session?.role!=="admin")return;

 let wo=(state.workorders||[]).filter(w=>w.status!=="Completed");
 if(adminFilter==="future")wo=wo.filter(w=>!readyForMechanic(w));
 if(adminFilter==="here")wo=wo.filter(w=>w.truckHere);
 if(adminFilter==="fleet")wo=wo.filter(w=>w.unitType==="fleet");

 table.innerHTML=wo.map(w=>`<tr><td>#${w.id}</td><td><b>${esc(w.unit)}</b><div class="muted">${esc(w.customer)} · ${w.unitType==="fleet"?"Fleet":"Customer"}</div></td><td>${esc(w.date)} ${esc(w.time)}</td><td>${esc(mechanicAssignmentsLabel(w))}</td><td>${esc(w.parking||"—")}</td><td>${availabilityBadge(w)}</td><td>${statusBadge(w.status)}</td><td><button class="secondary" onclick="openDetail(${w.id})">Open</button> <button class="secondary" onclick="openEdit(${w.id})">Edit</button></td></tr>`).join("")||'<tr><td colspan="8" class="empty">No work orders in this view.</td></tr>';
}
function setAdminFilter(f,btn){adminFilter=f;document.querySelectorAll(".filterbtn").forEach(x=>x.classList.remove("active"));btn.classList.add("active");renderAdminTable()}
function jobCard(w){return `<div class="card jobcard"><div class="jobtop"><div><b>#${w.id} — ${esc(w.unit)}</b><div class="muted">${esc(w.customer)} · ${esc(mechanicAssignmentsLabel(w))} · ${esc(w.date)} ${esc(w.time)} · Parking ${esc(w.parking||"—")}</div></div>${statusBadge(w.status)}</div><div style="margin-top:8px">${availabilityBadge(w)}</div><div style="margin-top:10px"><b>Assigned to you:</b>${w.tasks.map(t=>`<div class="muted">${t.done?"✓":(t.startedAt&&!t.stoppedAt?"▶":"○")} ${esc(t.t)}${t.done?` · ${fmtDuration(taskElapsed(t))}`:""}</div>`).join("")}</div><div style="margin-top:10px"><button class="secondary" onclick="openDetail(${w.id})">Open Work Order</button></div></div>`}
function futureCard(w){return `<div class="card jobcard"><div class="jobtop"><div><b>#${w.id} — ${esc(w.unit)}</b><div class="muted">${esc(w.date)} ${esc(w.time)} · ${esc(mechanicDisplay(w.mechanic))} · Parking ${esc(w.parking||"—")}</div></div>${availabilityBadge(w)}</div><p class="muted">${esc(w.notes||"")}</p><div style="display:flex;gap:8px;flex-wrap:wrap">${w.unitType==="customer"?`<button class="success" onclick="markTruckHere(${w.id})">✓ Truck Is Here</button>`:""}<button class="secondary" onclick="openDetail(${w.id})">Open</button><button class="secondary" onclick="openEdit(${w.id})">Edit</button></div></div>`}
function mechanicUpcomingCard(w){
 const assignedJobs=(w.tasks||[]).map(t=>`<div class="muted">○ ${esc(t.t)}</div>`).join("");
 return `<div class="card jobcard">
   <div class="jobtop">
     <div>
       <b>Unit ${esc(w.unit)}</b>
       <div class="muted">${esc(w.customer||"")} · Scheduled ${esc(w.date)} ${esc(w.time)} · Parking ${esc(w.parking||"—")}</div>
     </div>
     <span class="badge b-wait">On the Way</span>
   </div>
   <div style="margin-top:10px">
     <b>Assigned to you:</b>
     ${assignedJobs||'<div class="muted">No repair tasks listed.</div>'}
   </div>
   ${w.notes?`<div class="futureNote"><b>Admin notes</b><div>${esc(w.notes)}</div></div>`:""}
   <div style="margin-top:12px">
     <button class="success" onclick="mechanicMarkTruckHere(${w.id})">✓ Truck Is Here</button>
     <button class="secondary" onclick="openDetail(${w.id})">View Assignment</button>
   </div>
 </div>`;
}

// MECHANIC UI RULE: never display internal work-order numbers; identify work by Unit Number only.
function mechanicCard(w){return `<div class="card jobcard"><div class="jobtop"><div><b>Unit ${esc(w.unit)}</b><div class="muted">${esc(w.customer)} · Parking ${esc(w.parking||"—")} · ${esc(w.date)} ${esc(w.time)}</div></div>${statusBadge(w.status)}</div><div style="margin-top:10px">${w.tasks.map(t=>`<div class="muted">${t.done?"✓":(t.startedAt&&!t.stoppedAt?"▶":"○")} ${esc(t.t)}${t.done?` · ${fmtDuration(taskElapsed(t))}`:""}</div>`).join("")}</div><div style="margin-top:10px"><button onclick="openDetail(${w.id})">Open Job</button></div></div>`}
const findingPhotoUrlCache=new Map();
function findingPhotoMarkup(i){
 const photoId=String(i?.photoId||"").trim();
 if(photoId)return `<img class="photo photoLoading" data-finding-photo-id="${esc(photoId)}" alt="Finding photo" loading="lazy"><div class="photoError" data-photo-error-for="${esc(photoId)}" style="display:none"></div>`;
 if(typeof i?.photo==="string"&&i.photo.startsWith("data:image/"))return `<img class="photo" src="${i.photo}" alt="Legacy finding photo" loading="lazy">`;
 return "";
}
async function getFindingPhotoUrl(photoId){
 const cached=findingPhotoUrlCache.get(photoId),now=Date.now();
 if(cached&&cached.expiresAt>now)return cached.url;
 const d=await apiJSON(`/api/photos/${encodeURIComponent(photoId)}/url`);
 const url=String(d?.url||"");
 if(!url)throw new Error("Photo URL was not returned by the server.");
 findingPhotoUrlCache.set(photoId,{url,expiresAt:now+Math.max(60,Number(d.expiresIn||600)-120)*1000});
 return url;
}
function hydrateFindingPhotos(){
 document.querySelectorAll("img[data-finding-photo-id]").forEach(img=>{
   if(img.dataset.loading==="1"||img.dataset.loaded==="1")return;
   const photoId=img.dataset.findingPhotoId;if(!photoId)return;
   img.dataset.loading="1";
   getFindingPhotoUrl(photoId).then(url=>{
     if(!img.isConnected)return;
     img.src=url;img.dataset.loaded="1";img.dataset.loading="0";img.classList.remove("photoLoading");
   }).catch(e=>{
     img.dataset.loading="0";img.classList.remove("photoLoading");img.style.display="none";
     const er=document.querySelector(`[data-photo-error-for="${CSS.escape(photoId)}"]`);if(er){er.textContent=e.message||"Photo unavailable";er.style.display="block";}
   });
 });
}
function setFindingPhotoStatus(text,isError=false){
 const el=document.getElementById("findingPhotoStatus");if(!el)return;el.textContent=text||"";el.style.color=isError?"#b42318":"";
}
async function browserCompressFindingPhoto(file){
 if(!file||!file.size)return null;
 if(file.size>25*1024*1024)throw new Error("Photo is larger than 25 MB. Please retake it at normal camera resolution.");
 setFindingPhotoStatus("Preparing photo…");
 try{
   const bitmap=await createImageBitmap(file,{imageOrientation:"from-image"});
   const max=1920,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height)),w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
   const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
   const ctx=canvas.getContext("2d",{alpha:false});ctx.drawImage(bitmap,0,0,w,h);bitmap.close?.();
   const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Photo compression failed.")),"image/jpeg",0.82));
   return new File([blob],String(file.name||"finding-photo").replace(/\.[^.]+$/,"")+".jpg",{type:"image/jpeg",lastModified:Date.now()});
 }catch(e){
   // Some iPhone/HEIC browser versions cannot decode locally. The server has a second conversion path.
   console.warn("Browser photo compression fallback:",e);
   return file;
 }
}
async function uploadFindingPhoto(file,workOrderId,findingId){
 const prepared=await browserCompressFindingPhoto(file);
 setFindingPhotoStatus(`Uploading photo${prepared?.size?` (${Math.max(1,Math.round(prepared.size/1024))} KB)`:""}…`);
 const fd=new FormData();fd.append("photo",prepared,prepared.name||"finding-photo.jpg");fd.append("workOrderId",String(workOrderId));
 const r=await fetch(`/api/findings/${encodeURIComponent(findingId)}/photo`,{method:"POST",headers:authHeaders(),body:fd});
 let d={};try{d=await r.json()}catch(_){}
 if(r.status===401){cloudToken="";sessionStorage.removeItem("ittr_cloud_token");throw new Error("Session expired. Log in again.");}
 if(!r.ok)throw new Error(d.error||`Photo upload failed (${r.status}).`);
 if(!d.photoId)throw new Error("Server did not return a photo ID.");
 setFindingPhotoStatus("Photo uploaded successfully.");
 return d.photoId;
}

function issueCard(i){
 let w=state.workorders.find(x=>x.id==i.wo);
 return `<div class="card issue">
   <div class="jobtop">
     <div><b>${esc(w?.unit||"Unknown unit")}</b><div class="muted">${esc(i.created)}</div></div>
     <span class="badge b-high">${esc(i.severity)}</span>
   </div>
   <p>${esc(i.description)}</p>
   ${i.recommendation?`<div class="muted"><b>Recommended:</b> ${esc(i.recommendation)}</div>`:""}
   ${findingPhotoMarkup(i)}
   <div style="margin-top:10px"><b>Customer decision:</b> ${approvalBadge(i)}</div>
   ${i.approval==="Proceed"
      ?'<div class="muted" style="margin-top:8px">Admin approved this repair. Complete it once it appears in the work-order task list.</div>'
      :i.approval==="Do Not Proceed"
        ?'<div class="muted" style="margin-top:8px">Do not perform this additional repair.</div>'
        :'<div class="muted" style="margin-top:8px">Waiting for admin/customer decision.</div>'}
 </div>`;
}


let findingView="action";
const collapsedFindingUnits=new Set();
function findingDateValue(i){
 if(i?.createdAt){const d=new Date(i.createdAt);if(!isNaN(d))return d;}
 if(i?.created){const d=new Date(i.created);if(!isNaN(d))return d;}
 return new Date(0);
}
function localDateKey(d){
 if(!(d instanceof Date)||isNaN(d))return "unknown";
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function findingDayKey(i){return localDateKey(findingDateValue(i))}
function dateAtMidnight(offset=0){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return d}
function isFindingToday(i){return findingDayKey(i)===localDateKey(dateAtMidnight())}
function isFindingYesterday(i){return findingDayKey(i)===localDateKey(dateAtMidnight(-1))}
function findingNeedsAction(i){return (i.approval||"Waiting for Customer")==="Waiting for Customer"}
function findingDateLabel(key){
 if(key===localDateKey(dateAtMidnight()))return "Today";
 if(key===localDateKey(dateAtMidnight(-1)))return "Yesterday";
 if(key==="unknown")return "Date Unknown";
 const d=new Date(`${key}T12:00:00`);
 return isNaN(d)?key:d.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric",year:"numeric"});
}
function findingTimeLabel(i){
 const d=findingDateValue(i); if(isNaN(d)||d.getTime()===0)return i.created||"";
 return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
}
function setFindingView(v){findingView=v;renderFindingsCenter()}
function toggleFindingUnit(k){
 if(typeof k!=="string")return;
 collapsedFindingUnits.has(k)?collapsedFindingUnits.delete(k):collapsedFindingUnits.add(k);
 renderFindingsCenter();
}
function findingMatchesView(i){
 if(findingView==="action")return findingNeedsAction(i);
 if(findingView==="today")return isFindingToday(i);
 if(findingView==="yesterday")return isFindingYesterday(i);
 if(findingView==="earlier")return !isFindingToday(i)&&!isFindingYesterday(i);
 return true;
}
function findingRecordCard(i,w){
 const approval=i.approval||"Waiting for Customer",resolved=!findingNeedsAction(i);
 return `<div class="findingRecord ${resolved?"findingResolved":""}">
  <div class="findingRecordTop"><div><div class="muted">${esc(i.severity||"Needs Attention")} · ${esc(findingTimeLabel(i))}${i.mechanic?` · ${esc(mechanicDisplay(i.mechanic))}`:""}</div><div class="findingProblem">${esc(i.description||"No description")}</div></div>${approvalBadge(i)}</div>
  ${i.recommendation?`<div class="muted"><b>Recommended:</b> ${esc(i.recommendation)}</div>`:""}
  ${findingPhotoMarkup(i)}
  ${i.adminNote?`<div class="outcomeNoteBox"><b>Admin / customer note:</b> ${esc(i.adminNote)}</div>`:""}
  <div class="findingDecisionActions">
   <button class="success" onclick="setApproval(${i.id},'Proceed')">Proceed</button>
   <button class="secondary" onclick="setApproval(${i.id},'Waiting for Customer')">Waiting</button>
   <button class="danger" onclick="setApproval(${i.id},'Do Not Proceed')">Do Not Proceed</button>
   ${approval==="Proceed"?`<span class="badge b-approved">${i.convertedToTask?"Added to Work Order":"Approved"}</span>`:""}
   ${i.convertedToTask?`<span class="badge b-done">Added to Work Order</span>`:""}
  </div>
  <div class="field" style="margin-top:10px"><label>Admin / Customer note</label><textarea id="findingAdminNote_${i.id}" placeholder="Customer decision, authorization, follow-up...">${esc(i.adminNote||"")}</textarea></div>
  <button class="secondary" onclick="saveAdminNote(${i.id})">Save Note</button>
 </div>`;
}
function renderFindingsCenter(){
 if(session?.role!=="admin")return;
 const box=document.getElementById("approvalIssues"); if(!box)return;
 const all=Array.isArray(state.issues)?state.issues.slice():[],waiting=all.filter(findingNeedsAction).length,today=all.filter(isFindingToday).length,yesterday=all.filter(isFindingYesterday).length,resolved=all.length-waiting;
 const summary=document.getElementById("findingSummary");
 if(summary)summary.innerHTML=`<div class="findingStat"><span class="muted">Action Required</span><b>${waiting}</b></div><div class="findingStat"><span class="muted">Today</span><b>${today}</b></div><div class="findingStat"><span class="muted">Yesterday</span><b>${yesterday}</b></div><div class="findingStat"><span class="muted">Resolved History</span><b>${resolved}</b></div>`;
 document.querySelectorAll(".findingTab").forEach(b=>b.classList.toggle("active",b.dataset.findingView===findingView));
 const q=(document.getElementById("findingSearch")?.value||"").trim().toLowerCase(),status=document.getElementById("findingStatusFilter")?.value||"all";
 const filtered=all.filter(findingMatchesView).filter(i=>{
  if(status!=="all"&&(i.approval||"Waiting for Customer")!==status)return false;
  if(!q)return true;
  const w=state.workorders.find(x=>x.id==i.wo);
  return [w?.unit,i.unitSnapshot,w?.customer,i.customerSnapshot,i.description,i.recommendation,i.adminNote,i.severity].some(v=>String(v||"").toLowerCase().includes(q));
 }).sort((a,b)=>findingDateValue(b)-findingDateValue(a));
 if(!filtered.length){box.innerHTML='<div class="findingEmpty">No findings in this view.</div>';return}
 const dates={};filtered.forEach(i=>(dates[findingDayKey(i)]||(dates[findingDayKey(i)]=[])).push(i));
 const dateKeys=Object.keys(dates).sort((a,b)=>a==="unknown"?1:b==="unknown"?-1:b.localeCompare(a));
 box.innerHTML=dateKeys.map(dk=>{
  const items=dates[dk],units={};
  items.forEach(i=>{const w=state.workorders.find(x=>x.id==i.wo),unit=String(w?.unit||i.unitSnapshot||"Unknown Unit"),customer=String(w?.customer||i.customerSnapshot||""),k=`${unit}|||${customer}`;(units[k]||(units[k]={unit,customer,items:[]})).items.push(i)});
  return `<div class="findingDateSection"><div class="findingDateHeader"><div class="findingDateTitle">${esc(findingDateLabel(dk))}</div><span class="badge">${items.length} finding${items.length===1?"":"s"}</span></div>
   ${Object.values(units).sort((a,b)=>a.unit.localeCompare(b.unit,undefined,{numeric:true})).map(g=>{const k=`${dk}::${g.unit}::${g.customer}`,collapsed=collapsedFindingUnits.has(k),pending=g.items.filter(findingNeedsAction).length;return `<div class="findingUnitGroup"><div class="findingUnitHeader" data-finding-group="${encodeURIComponent(k)}" onclick="toggleFindingUnit(decodeURIComponent(this.dataset.findingGroup))"><div><div class="findingUnitName">${esc(g.unit)}</div><div class="findingUnitMeta">${esc(g.customer||"No customer")} · ${g.items.length} finding${g.items.length===1?"":"s"}</div></div><div>${pending?`<span class="badge b-wait">${pending} action required</span>`:'<span class="badge b-done">Resolved</span>'} ${collapsed?"▸":"▾"}</div></div><div class="findingUnitBody ${collapsed?"collapsed":""}">${g.items.map(i=>findingRecordCard(i,state.workorders.find(x=>x.id==i.wo))).join("")}</div></div>`}).join("")}</div>`;
 }).join("");
}
function approvalBadge(i){
 const a=i.approval||"Waiting for Customer";
 if(a==="Proceed") return '<span class="badge b-approved">Proceed</span>';
 if(a==="Do Not Proceed") return '<span class="badge b-declined">Do Not Proceed</span>';
 return '<span class="badge b-wait">Waiting for Customer</span>';
}
function adminIssueCard(i){
 let w=state.workorders.find(x=>x.id==i.wo);
 return `<div class="card issue">
   <div class="jobtop">
     <div><b>${esc(w?.unit||"Unknown unit")}</b><div class="muted">${esc(w?.unit||"Unknown unit")} · ${esc(i.created)} · Mechanic finding</div></div>
     ${approvalBadge(i)}
   </div>
   <p><b>Problem:</b> ${esc(i.description)}</p>
   ${i.recommendation?`<div class="muted"><b>Recommended repair:</b> ${esc(i.recommendation)}</div>`:""}
   ${findingPhotoMarkup(i)}
   ${i.adminNote?`<div class="card" style="background:#fafafa;margin-top:10px"><b>Admin note:</b><div>${esc(i.adminNote)}</div></div>`:""}
   <div class="decision">
     <button class="success" onclick="setApproval(${i.id},'Proceed')">Proceed</button>
     <button class="secondary" onclick="setApproval(${i.id},'Waiting for Customer')">Waiting for Customer</button>
     <button class="danger" onclick="setApproval(${i.id},'Do Not Proceed')">Do Not Proceed</button>
     ${i.approval==="Proceed"?`<span class="badge b-approved">${i.convertedToTask?"Added to Work Order":"Approved"}</span>`:""}
   </div>
   <div class="field" style="margin-top:10px">
     <label>Admin / Customer note</label>
     <textarea id="legacyAdminNote_${i.id}" placeholder="Example: Customer approved by phone at 2:15 PM">${esc(i.adminNote||"")}</textarea>
   </div>
   <button class="secondary" onclick="saveAdminNote(${i.id})">Save Note</button>
 </div>`;
}
async function setApproval(id,value){
 if(!requireAdmin())return;
 const i=state.issues.find(x=>String(x.id)===String(id)); if(!i)return;
 try{
   const d=await apiJSON(`/api/findings/${encodeURIComponent(id)}/decision`,{
     method:"POST",
     body:JSON.stringify({value})
   });
   if(d?.shopflow){
     state=d.shopflow;
     localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));
   }
   if(d?.version!=null)cloudVersions.shopflow=Number(d.version);
   render();
   if(value==="Proceed"){
     const updated=state.issues.find(x=>String(x.id)===String(id));
     const wo=updated?state.workorders.find(w=>String(w.id)===String(updated.wo)):null;
     const linked=wo?.tasks?.some(t=>String(t.findingId??"")===String(id));
     if(!linked)showSyncError("Finding was approved, but its work-order task could not be verified.");
   }
 }catch(e){
   alert(e.message||"Finding approval failed.");
 }
}
function saveAdminNote(id){
 if(!requireAdmin())return;
 let i=state.issues.find(x=>x.id===id); if(!i)return;
 const el=document.getElementById("findingAdminNote_"+id)||document.getElementById("legacyAdminNote_"+id);
 i.adminNote=el?el.value:"";
 save();
 render();
}
function convertApprovedFindingToTask(i){
 if(!i || i.approval!=="Proceed")return false;
 let w=state.workorders.find(x=>String(x.id)===String(i.wo));
 if(!w)return false;
 w.tasks=Array.isArray(w.tasks)?w.tasks:[];
 const text=(i.recommendation||"").trim() || (i.description||"").trim();
 if(!text)return false;
 if(!w.tasks.some(t=>t.findingId===i.id || (t.t||"").trim().toLowerCase()===text.toLowerCase())){
   w.tasks.push(newTaskRecord(text,{source:"inspection",findingId:i.id,findingDecision:"Proceed"}));
 }
 i.convertedToTask=true;
 return true;
}
function addApprovedFindingToWorkOrder(id){
 if(!requireAdmin())return;
 let i=state.issues.find(x=>x.id===id);
 if(!i || i.approval!=="Proceed")return;
 convertApprovedFindingToTask(i);
 save();render();
}

function openWorkOrder(){if(!requireAdmin())return;refreshMechanicSelects();renderWorkOrderVehicleMatch("new",null);hideUnitSuggestions("new");document.getElementById("woModal").classList.add("open");updateMobileBackButton()}
function openIssue(workOrderId=null){if(!requireMechanic())return;if(!state.workorders.length)return alert(tr("Create a work order first."));const sel=document.getElementById("issueWO");if(workOrderId!=null&&sel)[...sel.options].some(o=>String(o.value)===String(workOrderId))&&(sel.value=String(workOrderId));document.getElementById("issueModal").classList.add("open");updateMobileBackButton()}
function closeModal(id){
 const modal=document.getElementById(id);
 if(modal) modal.classList.remove("open");
 updateMobileBackButton();
}
document.addEventListener("keydown",e=>{
 if(e.key==="Escape") closeTopOpenModal();
});
document.querySelectorAll(".modal").forEach(m=>{
 m.addEventListener("click",e=>{
   if(e.target===m){
     m.classList.remove("open");
     updateMobileBackButton();
   }
 });
});
const modalObserver=new MutationObserver(()=>updateMobileBackButton());
document.querySelectorAll(".modal").forEach(m=>modalObserver.observe(m,{attributes:true,attributeFilter:["class"]}));
document.getElementById("woForm").onsubmit=e=>{
 e.preventDefault(); if(!requireAdmin())return; let f=new FormData(e.target), unitType=f.get("unitType");
 state.workorders.unshift({
   id:Math.max(1000,...state.workorders.map(x=>x.id))+1,unit:f.get("unit"),customer:f.get("customer"),customerId:f.get("customerId")||"",unitRecordId:f.get("unitRecordId")||"",vin:f.get("vin")||"",year:f.get("year")||"",make:f.get("make")||"",model:f.get("model")||"",plate:f.get("plate")||"",mileage:Number(f.get("mileage")||0)||0,dotNumber:f.get("dotNumber")||"",date:f.get("date"),time:f.get("time"),
   mechanic:f.get("mechanic"),helpers:[],priority:f.get("priority"),parking:f.get("parking"),unitType,
   truckHere:f.get("truckHere")==="on",fleetAuto:unitType==="fleet" ? f.get("fleetAuto")==="on" : false,
   status:"Open",completedAt:"",
   tasks:f.get("tasks").split("\n").map(t=>t.trim()).filter(Boolean).map(t=>newTaskRecord(t)),notes:f.get("notes")
 });
 save();e.target.reset();renderWorkOrderVehicleMatch("new",null);document.querySelector('[name="fleetAuto"]').checked=true;closeModal("woModal");render();
};
document.getElementById("issueForm").onsubmit=async e=>{
 e.preventDefault(); if(!requireMechanic())return;
 const form=e.target,button=form.querySelector('button[type="submit"]');
 if(button?.disabled)return;
 const f=new FormData(form),file=f.get("photo"),woId=Number(f.get("wo")),linked=state.workorders.find(w=>w.id===woId);
 if(!linked)return alert(tr("This work order is no longer available. Refresh and try again."));
 const findingId=Date.now();
 let photoId="";
 try{
   if(button){button.disabled=true;button.dataset.oldText=button.textContent;button.textContent="Saving…";}
   setFindingPhotoStatus("");
   if(file&&file.size)photoId=await uploadFindingPhoto(file,woId,findingId);
   const now=new Date();
   state.issues.unshift({id:findingId,wo:woId,unitSnapshot:linked?.unit||"",customerSnapshot:linked?.customer||"",mechanic:session.username,severity:f.get("severity"),description:f.get("description"),recommendation:f.get("recommendation"),photoId,photo:"",status:"Reported",approval:"Waiting for Customer",adminNote:"",convertedToTask:false,created:now.toLocaleString(),createdAt:now.toISOString(),decisionAt:"",decisionBy:""});
   save();form.reset();setFindingPhotoStatus("");closeModal("issueModal");render();
 }catch(err){
   console.error("Finding save/photo upload failed:",err);setFindingPhotoStatus(err.message||"Photo upload failed.",true);alert(err.message||"Finding could not be saved.");
 }finally{
   if(button){button.disabled=false;button.textContent=button.dataset.oldText||"Save Finding";delete button.dataset.oldText;}
 }
};

function openEdit(id){if(!requireAdmin())return;
 let w=state.workorders.find(x=>x.id===id); if(!w)return;
 document.getElementById("editId").value=w.id;
 document.getElementById("editUnit").value=w.unit||"";
 document.getElementById("editCustomer").value=w.customer||"";
 [["editCustomerId","customerId"],["editUnitRecordId","unitRecordId"],["editVin","vin"],["editYear","year"],["editMake","make"],["editModel","model"],["editPlate","plate"],["editMileage","mileage"],["editDotNumber","dotNumber"]].forEach(([id,k])=>{const e=document.getElementById(id);if(e)e.value=w[k]??""}); renderWorkOrderVehicleMatch("edit",(w.vin||w.make||w.plate)?{unit_number:w.unit,customer_name:w.customer,vin:w.vin,year:w.year,make:w.make,model:w.model,plate:w.plate,mileage:w.mileage,dot_number:w.dotNumber}:null);
 document.getElementById("editDate").value=w.date||"";
 document.getElementById("editTime").value=w.time||"";
 refreshMechanicSelects(w.mechanic||"");
 document.getElementById("editMechanic").value=w.mechanic||"";
 document.getElementById("editPriority").value=w.priority||"Normal";
 document.getElementById("editParking").value=w.parking||"";
 document.getElementById("editUnitType").value=w.unitType||"customer";
 document.getElementById("editTruckHere").checked=!!w.truckHere;
 document.getElementById("editFleetAuto").checked=w.fleetAuto!==false;
 document.getElementById("editTasks").value=(w.tasks||[]).map(t=>t.t).join("\n");
 document.getElementById("editNotes").value=w.notes||"";
 document.getElementById("editModal").classList.add("open");
}
document.getElementById("editForm").onsubmit=e=>{
 e.preventDefault(); if(!requireAdmin())return;
 let f=new FormData(e.target), id=Number(f.get("id")), w=state.workorders.find(x=>x.id===id);
 if(!w)return;
 const oldBuckets={};
 (w.tasks||[]).forEach(t=>{
   const key=String(t.t||"").trim().toLowerCase();
   (oldBuckets[key]||(oldBuckets[key]=[])).push(t);
 });
 const newTasks=f.get("tasks").split("\n").map(x=>x.trim()).filter(Boolean).map(t=>{
   const key=t.toLowerCase();
   const old=oldBuckets[key]?.shift();
   return old ? {...old,uid:old.uid||makeTaskUid("task"),t} : newTaskRecord(t);
 });
 w.unit=f.get("unit");
 w.customer=f.get("customer");
 w.customerId=f.get("customerId")||"";w.unitRecordId=f.get("unitRecordId")||"";w.vin=f.get("vin")||"";w.year=f.get("year")||"";w.make=f.get("make")||"";w.model=f.get("model")||"";w.plate=f.get("plate")||"";w.mileage=Number(f.get("mileage")||0)||0;w.dotNumber=f.get("dotNumber")||"";
 w.date=f.get("date");
 w.time=f.get("time");
 w.mechanic=f.get("mechanic");
 w.helpers=(Array.isArray(w.helpers)?w.helpers:[]).filter(u=>String(u).toLowerCase()!==String(w.mechanic||"").toLowerCase());
 w.priority=f.get("priority");
 w.parking=f.get("parking");
 w.unitType=f.get("unitType");
 w.truckHere=f.get("truckHere")==="on";
 w.fleetAuto=w.unitType==="fleet" ? f.get("fleetAuto")==="on" : false;
 w.tasks=newTasks;
 w.notes=f.get("notes");
 save();
 closeModal("editModal");
 render();
};

function mechanicMarkTruckHere(id){
 if(!requireMechanic())return;
 const w=state.workorders.find(x=>x.id===id);
 if(!w)return alert(tr("Work order could not be found."));
 if(!assignedToCurrentMechanic(w))return alert(tr("This unit is not assigned to you."));
 if(w.status==="Completed")return alert(tr("This work order is already completed."));

 if(w.unitType==="fleet"){
   w.fleetAuto=true;
 }else{
   w.truckHere=true;
 }
 w.arrivedAt=new Date().toISOString();
 w.arrivedBy=session.username;
 w.history=w.history||[];
 w.history.push(workOrderHistoryEntry("truck_arrived",{unit:w.unit,mechanic:session.username}));
 save();
 render();
}
function markTruckHere(id){if(!requireAdmin())return;let w=state.workorders.find(x=>x.id===id);if(!w)return;w.truckHere=true;save();render()}
function markTruckNotHere(id){if(!requireAdmin())return;let w=state.workorders.find(x=>x.id===id);if(w.unitType==="customer")w.truckHere=false;save();render();openDetail(id)}

function fmtDateTime(v){
 if(!v)return "—";
 try{return new Date(v).toLocaleString(currentLanguage==="uk"?"uk-UA":"en-US")}catch(e){return v}
}
function fmtDuration(ms){
 if(!ms || ms<0)return "0m";
 const total=Math.floor(ms/1000);
 const h=Math.floor(total/3600);
 const m=Math.floor((total%3600)/60);
 const s=total%60;
 if(h>0)return `${h}h ${m}m`;
 if(m>0)return `${m}m ${s}s`;
 return `${s}s`;
}
function taskElapsed(t){
 let ms=Number(t.elapsedMs||0);
 if(t.startedAt && !t.stoppedAt){
   ms += Math.max(0,Date.now()-new Date(t.startedAt).getTime());
 }
 return ms;
}
function taskRunningBy(t,w){return String(t?.runningBy||((t?.startedAt&&!t?.stoppedAt&&!t?.done)?w?.mechanic||"":"")).toLowerCase()}
function activeTaskIndex(w){
 return (w.tasks||[]).findIndex(t=>t.startedAt && !t.stoppedAt && !t.done);
}
function activeTaskIndexForMechanic(w,username){
 const u=String(username||"").toLowerCase();
 return (w.tasks||[]).findIndex(t=>t.startedAt&&!t.stoppedAt&&!t.done&&taskRunningBy(t,w)===u);
}

function normalizedTaskOutcome(t){
 if(!t)return "";
 if(t.taskOutcome)return t.taskOutcome;
 if(t.done)return "completed";
 return "";
}
function taskHasFinalDecision(t){
 return ["completed","not_completed","next_visit"].includes(normalizedTaskOutcome(t));
}
function taskOutcomeLabel(t){
 const o=normalizedTaskOutcome(t);
 if(o==="completed")return "Completed";
 if(o==="not_completed")return "Not Completed";
 if(o==="next_visit")return "Next Visit";
 return "Decision Required";
}
function taskOutcomeBadge(t,w=null){
 const o=normalizedTaskOutcome(t);
 if(o==="completed")return '<span class="badge b-done">✓ Completed</span>';
 if(o==="not_completed")return '<span class="badge" style="background:#fee4e2;color:#b42318">Not Completed</span>';
 if(o==="next_visit")return '<span class="badge b-wait">Next Visit</span>';
 if(w?.status==="Completed" && Number(w.outcomeWorkflowVersion||0)===0){
   return '<span class="badge" style="background:#f2f4f7;color:#475467">Legacy — outcome not recorded</span>';
 }
 return '<span class="badge b-open">Decision Required</span>';
}
function openTaskOutcome(workOrderId,taskIndex){
 if(!requireMechanic())return;
 const w=state.workorders.find(x=>x.id===workOrderId);
 if(!w || !visibleToCurrentMechanic(w))return alert(tr("This work order is not active for your account."));
 const t=w.tasks?.[taskIndex];
 if(!t)return alert(tr("Job could not be found."));
 if(t.startedAt && !t.stoppedAt)return alert(tr("Stop the running timer first."));
 const form=document.getElementById("taskOutcomeForm");
 form.elements["workOrderId"].value=workOrderId;
 form.elements["taskIndex"].value=taskIndex;
 form.elements["outcome"].value=["not_completed","next_visit"].includes(t.taskOutcome)?t.taskOutcome:"";
 form.elements["note"].value=t.outcomeNote||"";
 document.getElementById("taskOutcomeTitle").textContent=`Job Outcome — ${t.t}`;
 document.getElementById("taskOutcomeModal").classList.add("open");
 updateMobileBackButton();
}
function clearTaskOutcome(workOrderId,taskIndex){
 if(!requireMechanic())return;
 const w=state.workorders.find(x=>x.id===workOrderId);
 if(!w || !visibleToCurrentMechanic(w))return;
 const t=w.tasks?.[taskIndex];
 if(!t)return;
 if(t.startedAt && !t.stoppedAt)return alert(tr("Stop the running timer first."));
 t.done=false;
 t.completedAt="";
 t.taskOutcome="";
 t.outcomeNote="";
 t.outcomeAt="";
 t.outcomeBy="";
 save();
 render();
 openDetail(workOrderId);
}


function sessionDurationMs(s){
 if(!s?.started_at)return 0;
 const start=new Date(s.started_at).getTime();
 const end=s.ended_at?new Date(s.ended_at).getTime():Date.now();
 return Math.max(0,end-start);
}
function mechanicWorkSummaryHTML(w,sessions){
 const grouped={};
 const taskByUid=Object.fromEntries((w?.tasks||[]).map(t=>[String(t.uid||""),t]));
 for(const s of (sessions||[])){
  const u=String(s.mechanic_username||"").trim();if(!u)continue;
  const g=grouped[u]||(grouped[u]={total:0,tasks:{}});g.total+=sessionDurationMs(s);
  const uid=String(s.task_uid||"");const name=s.task_name||taskByUid[uid]?.t||"Job";
  const t=g.tasks[uid||name]||(g.tasks[uid||name]={name,total:0,sessions:0});t.total+=sessionDurationMs(s);t.sessions++;
 }
 for(const t of (w?.tasks||[])){
  const u=String(t.outcomeBy||"").trim();if(!u)continue;
  const g=grouped[u]||(grouped[u]={total:0,tasks:{}});const key=String(t.uid||t.t||"");
  const row=g.tasks[key]||(g.tasks[key]={name:t.t||"Job",total:0,sessions:0});row.outcome=taskOutcomeLabel(t);
 }
 const people=Object.entries(grouped);
 if(!people.length)return '<div class="muted">No mechanic labor has been recorded yet.</div>';
 return `<div class="mechanicWorkSummaryGrid">${people.map(([u,g])=>`<div class="mechanicWorkPerson"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(mechanicDisplay(u)||u)}</b><b>${fmtDuration(g.total)}</b></div>${Object.values(g.tasks).map(t=>`<div class="mechanicWorkTask"><b>${esc(t.name)}</b><div class="muted">${t.total?fmtDuration(t.total)+" worked":"Outcome recorded"}${t.outcome?` · ${esc(t.outcome)}`:""}</div></div>`).join("")}</div>`).join("")}</div>`;
}

function taskSessionTimelineHTML(sessions){
 if(!Array.isArray(sessions)||!sessions.length)return "";
 const total=sessions.reduce((sum,x)=>sum+sessionDurationMs(x),0);
 const rows=sessions.map((x,idx)=>{
   const first=idx===0;
   const startLabel=first?"Started":"Resumed";
   let stopLabel="Working";
   if(x.ended_at){
     if(x.end_reason==="paused")stopLabel="Paused";
     else if(x.end_reason==="completed")stopLabel="Finished";
     else if(x.end_reason==="approval_hold")stopLabel="Put On Hold";
     else if(x.end_reason==="declined")stopLabel="Stopped / Declined";
     else stopLabel="Stopped";
   }
   const status=x.ended_at
     ? (x.end_reason==="completed"?`<span class="badge b-done">Completed</span>`
       :x.end_reason==="paused"?`<span class="badge b-wait">Paused</span>`
       :x.end_reason==="declined"?`<span class="badge b-danger">Declined</span>`
       :x.end_reason==="approval_hold"?`<span class="badge b-wait">Waiting</span>`:"")
     :`<span class="badge b-progress">Running</span>`;
   const reason=x.pause_reason?`<div class="muted" style="margin-top:2px"><b>Reason:</b> ${esc(x.pause_reason)}${x.pause_note?` — ${esc(x.pause_note)}`:""}</div>`:"";
   return `<div style="padding:7px 0;${idx?"border-top:1px dashed #d8dee8;":""}">
      <div><b>${startLabel}:</b> ${fmtDateTime(x.started_at)}</div>
      <div><b>${stopLabel}:</b> ${x.ended_at?fmtDateTime(x.ended_at):"Now"} ${status}</div>
      <div class="muted"><b>${esc(mechanicDisplay(x.mechanic_username)||x.mechanic_username||"Mechanic")}</b> · Work time this session: ${fmtDuration(sessionDurationMs(x))}</div>
      ${reason}
   </div>`;
 }).join("");
 return `<details open style="margin-top:8px">
   <summary style="cursor:pointer;font-weight:800">Work Timeline · ${sessions.length} session${sessions.length===1?"":"s"} · ${fmtDuration(total)} worked</summary>
   <div style="margin-top:4px">${rows}</div>
 </details>`;
}
async function loadWorkOrderTaskSessions(workOrderId){
 try{
   const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/task-sessions`);
   const sessions=Array.isArray(d?.sessions)?d.sessions:[];
   const byUid={};
   for(const x of sessions){
     if(!x.task_uid)continue;
     const uid=String(x.task_uid);
     (byUid[uid]||(byUid[uid]=[])).push(x);
   }
   document.querySelectorAll(`[data-task-timeline-wo="${CSS.escape(String(workOrderId))}"]`).forEach(el=>{
     const uid=String(el.getAttribute("data-task-timeline-uid")||"");
     const ownSessions=uid?(byUid[uid]||[]):[];
     el.innerHTML=ownSessions.length?taskSessionTimelineHTML(ownSessions):"";
   });
   const summary=document.querySelector(`[data-mechanic-work-summary-wo="${CSS.escape(String(workOrderId))}"]`);
   const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
   if(summary&&w)summary.innerHTML=mechanicWorkSummaryHTML(w,sessions);
 }catch(e){
   document.querySelectorAll(`[data-task-timeline-wo="${CSS.escape(String(workOrderId))}"]`).forEach(el=>{
     el.innerHTML=`<div class="muted" style="margin-top:6px">Timeline unavailable: ${esc(e.message||"Unable to load")}${String(e.message||"").includes("API endpoint not found")?" — frontend/backend version mismatch. Deploy server.js from this same release.":""}</div>`;
   });
 }
}



let partsSearchTimer=null,partsScannerStream=null,partsScannerTimer=null,partsHtml5Scanner=null,partsScannerContext={mode:"lookup",workOrderId:null,taskIndex:null},currentPartDetail={id:null,aliases:[]},partBarcodeObjectUrls=new Map();
function partStockClass(x){const q=Number(x.available??x.quantity??0),r=Number(x.reorder_point??x.min_qty??0);return q<=0?"stockOut":(r>0&&q<=r?"stockWarn":"stockGood")}
function partStockState(x){const q=Number(x.available??x.quantity??0),r=Number(x.reorder_point??x.min_qty??0);return q<=0?{label:"Out of stock",cls:"out"}:(r>0&&q<=r?{label:"Low stock",cls:"warn"}:{label:"In stock",cls:"good"})}
function cleanPartField(v,fallback="—"){const x=cleanImportedDisplayText(v);return x||fallback}
async function loadPartsCenter(){const list=document.getElementById("partsList");if(!list)return;const q=document.getElementById("partsSearch")?.value?.trim()||"",filter=document.getElementById("partsFilter")?.value||"all";list.innerHTML='<div class="muted">Loading inventory…</div>';try{const [sum,d]=await Promise.all([apiJSON('/api/parts/summary'),apiJSON(`/api/parts?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&limit=150`)]);const stats=document.getElementById("partsStats");if(stats)stats.innerHTML=`<div class="partsStat"><span class="muted">Parts</span><b>${Number(sum.total||0).toLocaleString()}</b></div><div class="partsStat"><span class="muted">Low Stock</span><b>${Number(sum.low_stock||0).toLocaleString()}</b></div><div class="partsStat"><span class="muted">Out of Stock</span><b>${Number(sum.out_of_stock||0).toLocaleString()}</b></div><div class="partsStat"><span class="muted">On Order</span><b>${Number(sum.on_order||0).toLocaleString()}</b></div><div class="partsStat"><span class="muted">Inventory Value</span><b>${money(sum.inventory_value)}</b></div>`;const items=d.items||[];list.innerHTML=items.length?`<table class="partsTable"><thead><tr><th>Part</th><th>Description</th><th>Available</th><th>Allocated</th><th>Location</th><th>Sell</th><th></th></tr></thead><tbody>${items.map(x=>`<tr><td><b>${esc(cleanPartField(x.part_number))}</b><div class="muted">${esc(cleanImportedDisplayText(x.manufacturer)||'')}${x.internal_barcode?` · ${esc(x.internal_barcode)}`:''}</div></td><td>${esc(cleanPartField(x.description))}<div class="muted">${esc(cleanImportedDisplayText(x.category)||'')}</div></td><td class="${partStockClass(x)}">${Number(x.available||0).toLocaleString()} ${esc(cleanImportedDisplayText(x.uom)||'')}</td><td>${Number(x.allocated||0).toLocaleString()}</td><td>${esc(cleanPartField(x.location))}</td><td>${money(x.price)}</td><td><button class="secondary" onclick="openPartDetail(${Number(x.id)})">Open</button></td></tr>`).join('')}</tbody></table>`:'<div class="ledgerEmpty">No parts match this search or stock filter.</div>'}catch(e){list.innerHTML=`<div class="error">${esc(e.message||'Unable to load parts.')}</div>`}}
function debouncedPartsSearch(){clearTimeout(partsSearchTimer);partsSearchTimer=setTimeout(loadPartsCenter,180)}
function revokePartBarcodeObjectUrl(id){const u=partBarcodeObjectUrls.get(String(id));if(u){try{URL.revokeObjectURL(u)}catch{}partBarcodeObjectUrls.delete(String(id))}}
async function loadPartBarcodeSvg(id,hostId){const host=document.getElementById(hostId);if(!host)return;host.innerHTML='<div class="muted">Loading barcode…</div>';try{const r=await fetch(`/api/parts/${encodeURIComponent(id)}/barcode.svg`,{headers:authHeaders({Accept:'image/svg+xml'})});if(!r.ok)throw new Error(`Barcode request failed (${r.status})`);const blob=await r.blob();revokePartBarcodeObjectUrl(id);const url=URL.createObjectURL(blob);partBarcodeObjectUrls.set(String(id),url);const img=document.createElement('img');img.alt='Part barcode';img.src=url;host.replaceChildren(img)}catch(e){host.innerHTML=`<div class="error">Barcode unavailable. ${esc(e.message||'')}</div>`}}
function renderPartAliasChips(aliases){return aliases.length?`<div class="aliasList">${aliases.map((a,i)=>`<span class="aliasChip">${esc(a)}${session?.role==='admin'?`<button title="Remove barcode" onclick="removePartBarcodeAlias(${i})">×</button>`:''}</span>`).join('')}</div>`:'<div class="muted" style="margin:8px 0 10px">No manufacturer or vendor barcodes saved yet.</div>'}
async function openPartDetail(id){const m=document.getElementById('partDetailModal'),body=document.getElementById('partDetailBody');m?.classList.add('open');syncModalState();body.innerHTML='<div class="muted">Loading part profile…</div>';try{const d=await apiJSON(`/api/parts/${id}`),x=d.item,tx=d.transactions||[],st=partStockState(x),aliases=Array.isArray(x.barcode_aliases)?x.barcode_aliases.map(v=>String(v||'').trim()).filter(Boolean):[];currentPartDetail={id:Number(x.id),aliases};document.getElementById('partDetailTitle').textContent='Part Details';const manufacturer=cleanImportedDisplayText(x.manufacturer)||'',category=cleanImportedDisplayText(x.category)||'',status=cleanImportedDisplayText(x.status)||'';body.innerHTML=`<div class="partDetailShell"><div class="partHero"><div class="partHeroMain"><div class="partHeroPartNumber">${esc(cleanPartField(x.part_number))}</div><div class="partHeroDesc">${esc(cleanPartField(x.description))}</div><div class="partHeroMeta">${manufacturer?`<span class="partMetaChip">${esc(manufacturer)}</span>`:''}${category?`<span class="partMetaChip">${esc(category)}</span>`:''}${status?`<span class="partMetaChip">${esc(status)}</span>`:''}</div></div><span class="partStockBadge ${st.cls}">${st.label}</span></div><div class="partDetailGrid"><div><div class="partPanel"><h3>Stock & Pricing</h3><div class="partMetricGrid"><div class="partMetric"><span>On Hand</span><b class="${partStockClass(x)}">${Number(x.quantity||0).toLocaleString()}</b></div><div class="partMetric"><span>Allocated</span><b>${Number(x.allocated||0).toLocaleString()}</b></div><div class="partMetric"><span>Available</span><b class="${partStockClass(x)}">${Number(x.available||0).toLocaleString()}</b></div><div class="partMetric"><span>On Order</span><b>${Number(x.on_order||0).toLocaleString()}</b></div></div><div class="partInfoGrid"><div class="partInfoItem"><span>Location</span><b>${esc(cleanPartField(x.location))}</b></div><div class="partInfoItem"><span>Preferred Vendor</span><b>${esc(cleanPartField(x.vendor))}</b></div><div class="partInfoItem"><span>Weighted Avg Cost</span><b>${money(x.cost)}</b></div><div class="partInfoItem"><span>Last Buy Cost</span><b>${money(x.last_purchase_cost??x.cost)}</b></div><div class="partInfoItem"><span>Selling Price</span><b>${money(x.price)}</b></div><div class="partInfoItem"><span>Min / Max</span><b>${Number(x.min_qty||0).toLocaleString()} / ${Number(x.max_qty||0).toLocaleString()}</b></div><div class="partInfoItem"><span>Reorder Point</span><b>${Number(x.reorder_point??x.min_qty??0).toLocaleString()}</b></div></div></div>${session?.role==='admin'?`<div class="partPanel" style="margin-top:14px"><h3>Inventory Actions</h3><div class="inventoryActionButtons"><button onclick="showPartInventoryActionForm(${x.id},'receive')">Receive Stock</button><button class="secondary" onclick="showPartInventoryActionForm(${x.id},'adjust_add')">Adjust +</button><button class="secondary" onclick="showPartInventoryActionForm(${x.id},'adjust_remove')">Adjust −</button></div><div class="muted" style="margin-top:8px">Every stock change requires confirmation and is written to the inventory ledger.</div><div id="partInventoryActionPanel" class="partActionPanel hidden"></div></div>`:''}</div><div><div class="barcodeBox"><div class="barcodeTitle">ITTR Internal Barcode</div><div id="partBarcodeSvg-${x.id}" class="barcodeSvgHost"></div><div class="barcodeCode">${esc(x.internal_barcode||'')}</div><div class="barcodeActions"><button onclick="printPartLabel(${x.id},'${encodeURIComponent(cleanPartField(x.part_number,''))}','${encodeURIComponent(cleanPartField(x.description,''))}','${encodeURIComponent(cleanImportedDisplayText(x.location)||'')}' )">Print 3.5 × 2 Label</button><button class="secondary" onclick="copyPartBarcode('${esc(x.internal_barcode||'')}')">Copy Code</button></div></div><div class="partPanel" style="margin-top:14px"><h3>Recognized Barcodes</h3><div id="partAliasList">${renderPartAliasChips(aliases)}</div>${session?.role==='admin'?`<div class="partAliasRow"><input id="partAliasInput" autocomplete="off" placeholder="Scan or enter manufacturer barcode"><button class="secondary" onclick="addPartBarcodeAlias(${x.id})">+ Add</button></div><div class="muted" style="margin-top:7px">Add the manufacturer's barcode so the same part can be scanned without an ITTR sticker.</div>`:''}</div></div></div><div class="partPanel"><h3>Inventory Ledger</h3>${tx.length?`<div class="partsTableWrap"><table class="partsTable"><thead><tr><th>Date</th><th>Movement</th><th>Qty</th><th>Reference</th><th>User</th></tr></thead><tbody>${tx.map(t=>`<tr><td>${esc(fmtDateTime(t.created_at))}</td><td>${esc(String(t.transaction_type||'').replaceAll('_',' '))}</td><td class="${Number(t.quantity_delta)>=0?'txPositive':'txNegative'}">${Number(t.quantity_delta)>0?'+':''}${Number(t.quantity_delta)}</td><td>${esc(cleanImportedDisplayText(t.reference||t.reason)||'—')}${t.unit_number?`<div class="muted">Unit ${esc(cleanImportedDisplayText(t.unit_number))} · ${esc(cleanImportedDisplayText(t.task_name)||'')}</div>`:''}</td><td>${esc(mechanicDisplay(t.username)||t.username||'')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="ledgerEmpty"><b>No inventory movements yet.</b><div style="margin-top:4px">Receiving, work-order usage, returns and manual adjustments will appear here.</div></div>'}</div></div>`;loadPartBarcodeSvg(x.id,`partBarcodeSvg-${x.id}`)}catch(e){body.innerHTML=`<div class="error">${esc(e.message||'Unable to open part.')}</div>`}}
function closePartDetail(){if(currentPartDetail.id!=null)revokePartBarcodeObjectUrl(currentPartDetail.id);currentPartDetail={id:null,aliases:[]};document.getElementById('partDetailModal')?.classList.remove('open');syncModalState()}
function showPartInventoryActionForm(id,type){const panel=document.getElementById('partInventoryActionPanel');if(!panel)return;const receive=type==='receive',remove=type==='adjust_remove';panel.classList.remove('hidden');panel.innerHTML=`<b>${receive?'Receive Stock':remove?'Reduce Inventory':'Increase Inventory'}</b><div class="row" style="margin-top:8px"><div class="field"><label>Quantity</label><input id="partActionQty" type="number" min="0.01" step="1" value="1" inputmode="decimal"></div><div class="field"><label>${receive?'PO / Vendor Reference':'Reason'}</label><input id="partActionRef" placeholder="${receive?'Example: FleetPride PO 18421':'Example: Physical count correction'}"></div></div><div class="actions"><button onclick="submitPartInventoryAction(${Number(id)},'${type}')">${receive?'Receive':'Confirm Adjustment'}</button><button class="secondary" onclick="document.getElementById('partInventoryActionPanel').classList.add('hidden')">Cancel</button></div>`;setTimeout(()=>document.getElementById('partActionQty')?.focus(),30)}
async function submitPartInventoryAction(id,type){const qty=Number(document.getElementById('partActionQty')?.value||0),ref=String(document.getElementById('partActionRef')?.value||'').trim();if(!qty||qty<=0)return alert('Enter a valid quantity.');if(type!=='receive'&&!ref)return alert('Enter a reason for the inventory adjustment.');try{await apiJSON(`/api/parts/${id}/transaction`,{method:'POST',body:JSON.stringify({type,qty,reference:type==='receive'?ref:'',reason:type==='receive'?'':ref,method:'parts_center'})});await openPartDetail(id);loadPartsCenter()}catch(e){alert(e.message||'Inventory update failed.')}}
async function addPartBarcodeAlias(id){const input=document.getElementById('partAliasInput'),code=String(input?.value||'').trim();if(!code)return;if(currentPartDetail.aliases.some(x=>String(x).toLowerCase()===code.toLowerCase()))return alert('That barcode is already assigned to this part.');const aliases=[...currentPartDetail.aliases,code];try{await apiJSON(`/api/parts/${id}`,{method:'PATCH',body:JSON.stringify({barcodeAliases:aliases})});currentPartDetail.aliases=aliases;if(input)input.value='';const list=document.getElementById('partAliasList');if(list)list.innerHTML=renderPartAliasChips(aliases)}catch(e){alert(e.message||'Unable to save barcode.')}}
async function removePartBarcodeAlias(index){if(!session||session.role!=='admin'||currentPartDetail.id==null)return;const aliases=currentPartDetail.aliases.filter((_,i)=>i!==Number(index));try{await apiJSON(`/api/parts/${currentPartDetail.id}`,{method:'PATCH',body:JSON.stringify({barcodeAliases:aliases})});currentPartDetail.aliases=aliases;const list=document.getElementById('partAliasList');if(list)list.innerHTML=renderPartAliasChips(aliases)}catch(e){alert(e.message||'Unable to remove barcode.')}}
async function copyPartBarcode(code){try{await navigator.clipboard.writeText(String(code||''))}catch{const t=document.createElement('textarea');t.value=String(code||'');document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()}}
async function printPartLabel(id,pn,desc,loc){let svg='';try{const r=await fetch(`/api/parts/${encodeURIComponent(id)}/barcode.svg`,{headers:authHeaders({Accept:'image/svg+xml'})});if(!r.ok)throw new Error(`Barcode request failed (${r.status})`);svg=await r.text()}catch(e){return alert('Unable to load barcode for printing: '+(e.message||e))}const partNo=cleanImportedDisplayText(decodeURIComponent(pn))||'',description=cleanImportedDisplayText(decodeURIComponent(desc))||'',location=cleanImportedDisplayText(decodeURIComponent(loc))||'',code=currentPartDetail.id===Number(id)?(document.querySelector('.barcodeCode')?.textContent||''):'';const w=window.open('','_blank','width=640,height=520');if(!w)return alert('Allow pop-ups to print labels.');w.document.write(`<html><head><title>${esc(partNo||'ITTR Part Label')}</title><style>@page{size:3.5in 2in;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;width:3.5in;height:2in;font-family:Arial,Helvetica,sans-serif;color:#111}.label{width:3.5in;height:2in;padding:.11in .14in;display:grid;grid-template-rows:auto 1fr auto;align-items:center;text-align:center;overflow:hidden}.brand{font-size:10pt;font-weight:900;letter-spacing:.08em}.pn{font-size:13pt;font-weight:900;line-height:1.05;margin-top:2px;overflow-wrap:anywhere}.desc{font-size:8.5pt;line-height:1.1;max-height:.33in;overflow:hidden;margin-top:2px}.barcode{height:.82in;display:flex;align-items:center;justify-content:center;overflow:hidden}.barcode svg{max-width:100%;width:100%;height:.78in}.footer{display:flex;justify-content:space-between;align-items:end;gap:8px;font-size:7.5pt;font-weight:700}.code{font-family:monospace;letter-spacing:.04em;white-space:nowrap}.location{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media print{html,body{width:3.5in;height:2in}.label{page-break-after:avoid}}</style></head><body><div class="label"><div><div class="brand">IRON TEAM · PARTS</div><div class="pn">${esc(partNo)}</div><div class="desc">${esc(description)}</div></div><div class="barcode">${svg}</div><div class="footer"><span class="code">${esc(code)}</span><span class="location">${esc(location||'General')}</span></div></div><script>window.onload=()=>setTimeout(()=>window.print(),150)<\/script></body></html>`);w.document.close()}
let smartReceivingData=null;
function openSmartReceiving(){const m=document.getElementById('smartReceivingModal');m?.classList.add('open');resetSmartReceiving();syncModalState();updateMobileBackButton()}
function closeSmartReceiving(){document.getElementById('smartReceivingModal')?.classList.remove('open');smartReceivingData=null;syncModalState();updateMobileBackButton()}
function resetSmartReceiving(){smartReceivingData=null;const b=document.getElementById('smartReceivingBody');if(b)b.innerHTML=`<div class="receivingStart"><div class="receivingDrop"><div class="receivingIcon">📄</div><h3>Scan a vendor invoice</h3><p class="muted">Take a clear photo or upload JPG, PNG, WEBP or PDF. ITTR extracts vendor, invoice number, quantities and current buy prices.</p><input id="vendorInvoiceFile" type="file" accept="image/*,application/pdf" capture="environment" class="hidden" onchange="scanVendorInvoice(this.files?.[0])"><div class="actions" style="justify-content:center"><button onclick="document.getElementById('vendorInvoiceFile').click()">📷 Scan / Upload Invoice</button></div><div class="muted" style="margin-top:10px">Nothing changes inventory until you review and press Receive.</div></div></div>`}
async function scanVendorInvoice(file){if(!file)return;const b=document.getElementById('smartReceivingBody');b.innerHTML='<div class="card"><h3>Reading invoice…</h3><div class="muted">Extracting vendor, invoice, quantities, part numbers and buy prices. Please wait.</div></div>';try{const fd=new FormData();fd.append('invoice',file);const r=await fetch('/api/parts/receiving/scan-invoice',{method:'POST',headers:authHeaders(),body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||'Invoice scan failed.');smartReceivingData={...d,filename:file.name};renderSmartReceivingReview()}catch(e){b.innerHTML=`<div class="error">${esc(e.message||'Invoice scan failed.')}</div><div class="actions"><button class="secondary" onclick="resetSmartReceiving()">Try Again</button></div>`}}
function receiveLineMatchOptions(line,i){const matches=Array.isArray(line.matches)?line.matches:[];let h=matches.map(x=>`<option value="${Number(x.id)}" ${Number(line.matchedPartId)===Number(x.id)?'selected':''}>${esc(cleanPartField(x.part_number))} — ${esc(cleanPartField(x.description)).slice(0,55)}</option>`).join('');return `<select id="recvMatch${i}" onchange="updateReceiveMatch(${i})"><option value="">${line.matchStatus==='new'?'Create new part':'Choose match'}</option>${h}</select>`}
function renderSmartReceivingReview(){const d=smartReceivingData?.extract||{},lines=d.lines||[],b=document.getElementById('smartReceivingBody');const total=Number(d.total||0);b.innerHTML=`<div class="receiveHeaderGrid"><div class="partInfoItem"><span>Vendor</span><input id="recvVendor" value="${esc(d.vendor||'')}"></div><div class="partInfoItem"><span>Invoice #</span><input id="recvInvoice" value="${esc(d.invoiceNumber||'')}"></div><div class="partInfoItem"><span>Invoice Date</span><input id="recvDate" type="date" value="${esc(d.invoiceDate||'')}"></div><div class="partInfoItem"><span>PO #</span><input id="recvPO" value="${esc(d.poNumber||'')}"></div></div><div class="notice"><b>Review before receiving.</b> AI reads the invoice, but you approve the exact part match, quantity and buy price. Unmatched lines can create a new ITTR inventory part.</div><div class="partPanel"><div class="receiveLine receiveLineHead"><div>Part #</div><div>Description</div><div>Qty</div><div>Buy Price</div><div>Core</div><div>ITTR Match</div></div>${lines.map((l,i)=>{const old=Number(l.matches?.[0]?.cost||0),nc=Number(l.unitCost||0),rise=old&&nc>old?((nc-old)/old*100):0;return `<div class="receiveLine"><div><input id="recvPN${i}" value="${esc(l.partNumber||'')}"><div class="${l.matchStatus==='matched'?'matchGood':'matchNew'}">${l.matchStatus==='matched'?'✓ Matched':l.matchStatus==='possible'?'Review match':'+ New / unmatched'}</div></div><div><input id="recvDesc${i}" value="${esc(l.description||'')}"><div class="muted">${esc(l.manufacturer||'')}</div></div><div><input id="recvQty${i}" type="number" min="0" step="1" value="${Number(l.quantity||0)}"></div><div><input id="recvCost${i}" type="number" min="0" step="0.01" value="${Number(l.unitCost||0)}">${rise>=3?`<div class="costRise">▲ ${rise.toFixed(1)}%</div>`:old?`<div class="muted">Old ${money(old)}</div>`:''}</div><div><input id="recvCore${i}" type="number" min="0" step="0.01" value="${Number(l.coreCost||0)}"></div><div>${receiveLineMatchOptions(l,i)}<label class="muted"><input id="recvNew${i}" type="checkbox" ${!l.matchedPartId?'checked':''}> Create if unmatched</label></div></div>`}).join('')}</div><div class="receiveSummary"><div class="receiveTotals"><span>Lines <b>${lines.length}</b></span><span>Invoice Total <b>${money(total)}</b></span><span>Tax ${money(d.tax||0)}</span><span>Freight ${money(d.freight||0)}</span></div><div class="actions"><button class="secondary" onclick="resetSmartReceiving()">Start Over</button><button onclick="receiveSmartInvoice()">✓ Receive Inventory</button></div></div>`}
function updateReceiveMatch(i){const l=smartReceivingData?.extract?.lines?.[i];if(l)l.matchedPartId=Number(document.getElementById(`recvMatch${i}`)?.value||0)||null}
async function receiveSmartInvoice(){const d=smartReceivingData?.extract;if(!d)return;const lines=(d.lines||[]).map((l,i)=>({...l,partNumber:document.getElementById(`recvPN${i}`)?.value||'',description:document.getElementById(`recvDesc${i}`)?.value||'',quantity:Number(document.getElementById(`recvQty${i}`)?.value||0),unitCost:Number(document.getElementById(`recvCost${i}`)?.value||0),coreCost:Number(document.getElementById(`recvCore${i}`)?.value||0),matchedPartId:Number(document.getElementById(`recvMatch${i}`)?.value||0)||null,createNew:Boolean(document.getElementById(`recvNew${i}`)?.checked)})).filter(x=>x.quantity>0);if(!lines.length)return alert('No quantities to receive.');if(lines.some(x=>!x.matchedPartId&&!x.createNew))return alert('Every received line must be matched to inventory or marked Create if unmatched.');const invoice={...d,vendor:document.getElementById('recvVendor')?.value||'',invoiceNumber:document.getElementById('recvInvoice')?.value||'',invoiceDate:document.getElementById('recvDate')?.value||'',poNumber:document.getElementById('recvPO')?.value||''};if(!confirm(`Receive ${lines.length} invoice line(s) from ${invoice.vendor||'vendor'}? Inventory quantities and purchase costs will be updated.`))return;try{const r=await apiJSON('/api/parts/receiving/receive',{method:'POST',body:JSON.stringify({invoice,lines,filename:smartReceivingData.filename})});const b=document.getElementById('smartReceivingBody');b.innerHTML=`<div class="card"><h2>✓ Invoice Received</h2><p><b>${Number(r.received||0)}</b> inventory lines received${r.created?` · <b>${r.created}</b> new part record(s) created`:''}.</p><div class="notice">Purchase cost history and weighted average cost were updated. Every quantity change is in the inventory ledger.</div><div class="actions"><button onclick="closeSmartReceiving();loadPartsCenter()">Done</button><button class="secondary" onclick="resetSmartReceiving()">Receive Another Invoice</button></div></div>`;loadPartsCenter()}catch(e){alert(e.message||'Receiving failed. No partial invoice was committed.') }}
function openPartsScanner(mode='lookup',workOrderId=null,taskIndex=null){partsScannerContext={mode,workOrderId,taskIndex};const m=document.getElementById('partsScannerModal'),inp=document.getElementById('partsScanInput'),out=document.getElementById('partsScanResult');if(m){m.classList.add('open');m.scrollTop=0;m.querySelector('.modalbox')?.scrollTo?.(0,0)}if(inp){inp.value='';setTimeout(()=>{if(!window.matchMedia('(max-width:900px)').matches)inp.focus()},80)}if(out)out.innerHTML='';syncModalState();updateMobileBackButton()}
function closePartsScanner(){stopPartsCamera();document.getElementById('partsScannerModal')?.classList.remove('open');syncModalState()}
async function lookupScannedPart(codeOverride=''){const inp=document.getElementById('partsScanInput'),out=document.getElementById('partsScanResult'),code=String(codeOverride||inp?.value||'').trim();if(!code)return;if(out)out.innerHTML='<div class="muted">Looking up part…</div>';try{const d=await apiJSON(`/api/parts/scan/${encodeURIComponent(code)}`),x=d.item;if(out)out.innerHTML=`<div class="card"><b>${esc(cleanPartField(x.part_number))}</b><div>${esc(cleanPartField(x.description))}</div><div class="${partStockClass(x)}">Available: ${Number(x.available||0).toLocaleString()} ${esc(cleanImportedDisplayText(x.uom)||'')}</div><div class="muted">${esc(cleanPartField(x.location,'No location'))} · ${esc(x.internal_barcode||'')}</div><div class="actions">${partsScannerContext.mode==='workorder'?`<div class="row" style="margin-top:10px"><div class="field"><label>Quantity</label><input id="partsScanQty" type="number" min="1" step="1" value="1" inputmode="numeric"></div><div class="field" style="align-self:end"><button style="width:100%" onclick="confirmScannedPart(${Number(x.id)},'${encodeURIComponent(cleanPartField(x.part_number,''))}','${encodeURIComponent(cleanPartField(x.description,''))}')">Add to This Job</button></div></div>`:`<button onclick="closePartsScanner();showView('parts');setTimeout(()=>openPartDetail(${Number(x.id)}),0)">Open Part</button>`}</div></div>`;stopPartsCamera()}catch(e){if(out)out.innerHTML=`<div class="error">${esc(e.message||'Barcode not found.')}</div>`}}
async function confirmScannedPart(id,pn,desc){const {workOrderId,taskIndex}=partsScannerContext,w=state.workorders.find(x=>String(x.id)===String(workOrderId)),t=w?.tasks?.[taskIndex];if(!t?.uid)return alert('Task not found.');const qty=Number(document.getElementById('partsScanQty')?.value||1);if(!qty||qty<=0)return alert('Enter a valid quantity.');try{const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/tasks/by-uid/${encodeURIComponent(t.uid)}/parts`,{method:'POST',body:JSON.stringify({inventoryPartId:id,partNumber:decodeURIComponent(pn),description:decodeURIComponent(desc),qty,method:'barcode_scan'})});if(d?.shopflow){state=d.shopflow;localStorage.setItem('ittr_shopflow_v2',JSON.stringify(state))}if(d?.version!=null)cloudVersions.shopflow=Number(d.version);closePartsScanner();render();openDetail(workOrderId)}catch(e){alert(e.message||'Unable to add scanned part.')}}
async function startPartsCamera(){stopPartsCamera();const view=document.getElementById('scannerViewport'),video=document.getElementById('partsScannerVideo');if(!navigator.mediaDevices?.getUserMedia)return alert('Camera scanning is not available in this browser. Use a USB/Bluetooth scanner or type the barcode.');try{if('BarcodeDetector' in window){const formats=await BarcodeDetector.getSupportedFormats(),wanted=['code_128','ean_13','ean_8','upc_a','upc_e','code_39','qr_code'].filter(x=>formats.includes(x)),det=new BarcodeDetector(wanted.length?{formats:wanted}:undefined);partsScannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});video.srcObject=partsScannerStream;await video.play();view.classList.remove('hidden');let busy=false;partsScannerTimer=setInterval(async()=>{if(busy||video.readyState<2)return;busy=true;try{const found=await det.detect(video);if(found?.[0]?.rawValue){document.getElementById('partsScanInput').value=found[0].rawValue;await lookupScannedPart(found[0].rawValue)}}catch{}finally{busy=false}},350);return}if(window.Html5Qrcode){view.classList.remove('hidden');video.style.display='none';let mount=document.getElementById('html5PartsReader');if(!mount){mount=document.createElement('div');mount.id='html5PartsReader';view.appendChild(mount)}partsHtml5Scanner=new Html5Qrcode('html5PartsReader');await partsHtml5Scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:280,height:140}},async decoded=>{document.getElementById('partsScanInput').value=decoded;await lookupScannedPart(decoded)});return}alert('Live camera scanning is unavailable. Use a USB/Bluetooth scanner or type the barcode.')}catch(e){stopPartsCamera();alert('Unable to start camera: '+(e.message||e))}}
function stopPartsCamera(){if(partsScannerTimer){clearInterval(partsScannerTimer);partsScannerTimer=null}if(partsScannerStream){partsScannerStream.getTracks().forEach(t=>t.stop());partsScannerStream=null}if(partsHtml5Scanner){const x=partsHtml5Scanner;partsHtml5Scanner=null;Promise.resolve(x.stop()).catch(()=>{}).finally(()=>{try{x.clear()}catch{}})}const v=document.getElementById('partsScannerVideo');if(v){v.srcObject=null;v.style.display=''}const mount=document.getElementById('html5PartsReader');if(mount)mount.remove();document.getElementById('scannerViewport')?.classList.add('hidden')}
function taskPartsHTML(w,t,i){
 const parts=Array.isArray(t.parts)?t.parts:[];
 const rows=parts.length?parts.map((p,pi)=>`<div class="partRow">
   <div><b>${esc(p.partNumber||"—")}</b></div>
   <div class="partDesc">${esc(p.description||"—")}<div class="muted">${p.addedBy?`Added by ${esc(mechanicDisplay(p.addedBy)||p.addedBy)}${p.addedAt?` · ${fmtDateTime(p.addedAt)}`:""}`:""}</div></div>
   <div>Qty ${esc(String(p.qty||1))}</div>
   ${(session?.role==="admin"||String(p.addedBy||"").toLowerCase()===String(session?.username||"").toLowerCase())&&w.status!=="Completed"?`<button type="button" class="danger" onclick="removeTaskPart(${w.id},'${esc(String(t.uid||""))}','${esc(String(p.id||""))}')">×</button>`:""}
 </div>`).join(""):`<div class="muted">No parts recorded for this job.</div>`;
 const add=((session?.role==="mechanic"&&visibleToCurrentMechanic(w))||session?.role==="admin")&&w.status!=="Completed"?`<div class="partAddGrid">
   <input id="partNo_${w.id}_${i}" list="fullbayPartNumberList" placeholder="Part Number" oninput="fullbayPartSuggest(this,${w.id},${i},'number')">
   <input class="partDescInput" id="partDesc_${w.id}_${i}" list="fullbayPartDescriptionList" placeholder="Part Description" oninput="fullbayPartSuggest(this,${w.id},${i},'description')">
   <input id="partQty_${w.id}_${i}" type="number" min="0.01" step="0.01" value="1" placeholder="Qty">
   <button type="button" class="secondary" onclick="addTaskPart(${w.id},${i})">+ Add Part</button><button type="button" class="partScanBtn" onclick="openPartsScanner('workorder',${w.id},${i})">▥ Scan Part</button>
 </div>`:"";
 return `<div class="taskParts"><b>Parts Used</b>${rows}${add}</div>`;
}
async function addTaskPart(workOrderId,taskIndex){
 if(!session)return;
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId)),t=w?.tasks?.[taskIndex];
 if(!t?.uid)return alert(tr("This task no longer exists. Refresh the work order."));
 const partNumber=(document.getElementById(`partNo_${workOrderId}_${taskIndex}`)?.value||"").trim();
 const description=(document.getElementById(`partDesc_${workOrderId}_${taskIndex}`)?.value||"").trim();
 const qty=Math.max(.01,Number(document.getElementById(`partQty_${workOrderId}_${taskIndex}`)?.value||1));
 if(!partNumber&&!description)return alert(tr("Enter a part number or description."));
 try{
  const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/tasks/by-uid/${encodeURIComponent(t.uid)}/parts`,{method:"POST",body:JSON.stringify({partNumber,description,qty,inventoryPartId:(fullbayPartCache.find(x=>String(x.part_number||'').toLowerCase()===partNumber.toLowerCase())?.id||null),method:'manual_work_order'})});
  if(d?.shopflow){state=d.shopflow;localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state))}
  if(d?.version!=null)cloudVersions.shopflow=Number(d.version);
  render();openDetail(workOrderId);
 }catch(e){alert(e.message||"Unable to add part.")}
}
async function removeTaskPart(workOrderId,taskUid,partId){
 if(!confirm(tr("Remove part?")))return;
 try{
  const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/tasks/by-uid/${encodeURIComponent(taskUid)}/parts/${encodeURIComponent(partId)}`,{method:"DELETE"});
  if(d?.shopflow){state=d.shopflow;localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state))}
  if(d?.version!=null)cloudVersions.shopflow=Number(d.version);
  render();openDetail(workOrderId);
 }catch(e){alert(e.message||"Unable to remove part.")}
}

function taskTimerRow(w,t,i){
 const isMechanic=session?.role==="mechanic" && visibleToCurrentMechanic(w) && w.status!=="Completed";
 const running=!!(t.startedAt && !t.stoppedAt && !t.done);
 const outcome=normalizedTaskOutcome(t);
 const completed=outcome==="completed";
 const activeIdx=activeTaskIndexForMechanic(w,session?.username);
 const anotherRunning=activeIdx!==-1 && activeIdx!==i;
 const runner=taskRunningBy(t,w);
 const runningByMe=running && runner===String(session?.username||"").toLowerCase();
 let controls="";

 if(isMechanic){
   if(t.findingDecision==="Do Not Proceed"){
     controls=`<span class="badge b-danger">DO NOT PROCEED</span>`;
   }else if(t.findingDecision==="Waiting for Customer"){
     controls=`<span class="badge b-wait">WAITING FOR CUSTOMER</span>`;
   }else if(running){
     controls=runningByMe?`<button class="secondary" onclick="openPauseTask(${w.id},${i})">Ⅱ Pause</button> <button class="success" onclick="stopTask(${w.id},${i})">✓ Complete</button>`:`<span class="badge b-progress">Working · ${esc(mechanicDisplay(runner)||runner||"Mechanic")}</span>`;
   }else if(completed){
     controls=`<span class="badge b-done">✓ Completed</span>`;
   }else if(["not_completed","next_visit"].includes(outcome)){
     controls=`${taskOutcomeBadge(t,w)}`;
   }else if(t.paused){
     controls=`<button ${anotherRunning?'disabled style="opacity:.45;cursor:not-allowed"':''} onclick="resumeTask(${w.id},${i})">▶ Resume</button>`;
   }else{
     controls=`<button ${anotherRunning?'disabled style="opacity:.45;cursor:not-allowed"':''} onclick="startTask(${w.id},${i})">▶ Start</button>`;
   }
 }else{
   if(t.findingDecision==="Do Not Proceed")controls=`<span class="badge b-danger">DO NOT PROCEED</span>`;
   else if(t.findingDecision==="Waiting for Customer")controls=`<span class="badge b-wait">WAITING FOR CUSTOMER</span>`;
   else controls=running?`<span class="badge b-progress">Running</span>`:taskOutcomeBadge(t,w);
 }

 const rowClass=completed?"outcomeCompleted":t.findingDecision==="Do Not Proceed"?"outcomeNotCompleted":t.findingDecision==="Waiting for Customer"||t.paused?"outcomeNext":outcome==="next_visit"?"outcomeNext":outcome==="not_completed"?"outcomeNotCompleted":"";
 return `<div class="taskrow ${running?"running":""} ${completed?"taskdone":""} ${rowClass}">
   <div class="taskhead">
     <div><b>${esc(t.t)}</b>${t.source==="inspection"?` <span class="badge b-approved">Approved Finding</span>`:""}</div>
     <div class="taskcontrols">${controls}</div>
   </div>
   <div class="timerinfo">
     <b>${t.startedAt?"Latest Start":"Started"}:</b> ${fmtDateTime(t.startedAt)}
     &nbsp; | &nbsp; <b>${t.stoppedAt?"Latest Stop":"Stopped"}:</b> ${fmtDateTime(t.stoppedAt)}
     &nbsp; | &nbsp; <b>Total Labor:</b> ${fmtDuration(taskElapsed(t))}
   </div>
   <div data-task-timeline-wo="${esc(String(w.id))}" data-task-timeline-index="${i}" data-task-timeline-uid="${esc(String(t.uid||""))}"></div>
   ${t.findingDecision==="Do Not Proceed"?`<div class="outcomeNoteBox"><b>DECLINED — DO NOT PROCEED</b><div class="muted">Decision changed by Admin${t.approvalChangedAt?` · ${fmtDateTime(t.approvalChangedAt)}`:""}</div></div>`:""}
   ${t.findingDecision==="Waiting for Customer"?`<div class="outcomeNoteBox"><b>ON HOLD — Waiting for Customer Approval</b><div class="muted">${t.approvalChangedAt?fmtDateTime(t.approvalChangedAt):""}</div></div>`:""}
   ${t.paused && !["Waiting for Customer","Do Not Proceed"].includes(t.findingDecision||"")?`<div class="outcomeNoteBox"><b>Paused:</b> ${esc(t.pauseReason||"Paused")}${t.pauseNote?` — ${esc(t.pauseNote)}`:""}<div class="muted">${t.pausedAt?fmtDateTime(t.pausedAt):""}</div></div>`:""}
   ${isMechanic && !running && !completed && !t.paused && Boolean(t.startedAt||t.stoppedAt||Number(t.elapsedMs||0)>0) && !["Waiting for Customer","Do Not Proceed"].includes(t.findingDecision||"")?`<div class="taskOutcomeActions">
      <button class="secondary" onclick="openTaskOutcome(${w.id},${i})">Not Completed / Next Visit</button>
      ${["not_completed","next_visit"].includes(outcome)?`<button class="secondary" onclick="clearTaskOutcome(${w.id},${i})">Reset Decision</button>`:""}
   </div>`:""}
   ${t.outcomeNote?`<div class="outcomeNoteBox"><b>${esc(taskOutcomeLabel(t))}:</b> ${esc(t.outcomeNote)}<div class="muted">${t.outcomeBy?`By ${esc(mechanicDisplay(t.outcomeBy))}`:""}${t.outcomeAt?` · ${fmtDateTime(t.outcomeAt)}`:""}</div></div>`:""}
   ${taskPartsHTML(w,t,i)}
 </div>`;
}
async function applyTaskServerAction(workOrderId,taskUid,action,extra={}){
 if(!requireMechanic())return false;
 if(!taskUid){alert(tr("This task is missing its permanent ID. Refresh the work order and try again."));return false;}
 try{
   const d=await apiJSON(`/api/work-orders/${encodeURIComponent(workOrderId)}/tasks/by-uid/${encodeURIComponent(taskUid)}/action`,{
     method:"POST",body:JSON.stringify({action,...extra})
   });
   if(d?.shopflow){
     state=d.shopflow;
     localStorage.setItem("ittr_shopflow_v2",JSON.stringify(state));
   }
   if(d?.version!=null)cloudVersions.shopflow=Number(d.version);
   render();
   openDetail(workOrderId);
   return true;
 }catch(e){
   alert(e.message||"Task update failed.");
   return false;
 }
}
async function startTask(workOrderId,taskIndex){
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
 if(!w || !visibleToCurrentMechanic(w))return alert(tr("You do not have access to this work order."));
 const task=w.tasks?.[taskIndex]; if(!task)return alert(tr("This job could not be found."));
 if(task.findingDecision==="Do Not Proceed")return alert(tr("This repair was declined. Do not perform this task."));
 if(task.findingDecision==="Waiting for Customer")return alert(tr("This repair is waiting for customer approval."));
 const au=USERS;
 if(au?.[session.username]?.currentActivity?.code){closeCurrentMechanicActivity(au,session.username);try{saveUsers(au)}catch(e){saveUsers()}}
 await applyTaskServerAction(workOrderId,task.uid,"start");
}
function openPauseTask(workOrderId,taskIndex){
 if(!requireMechanic())return;
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
 const t=w?.tasks?.[taskIndex];
 if(!t)return alert(tr("This job could not be found."));
 if(!(t.startedAt&&!t.stoppedAt&&!t.done))return alert(tr("This job is not currently running."));
 const f=document.getElementById("taskPauseForm");
 f.elements["workOrderId"].value=workOrderId;
 f.elements["taskIndex"].value=taskIndex;
 f.elements["reason"].value="";
 f.elements["note"].value="";
 document.getElementById("taskPauseTitle").textContent=`Pause Job — ${t.t}`;
 document.getElementById("taskPauseModal").classList.add("open");
}
async function pauseTask(workOrderId,taskIndex,reason,note=""){
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
 const task=w?.tasks?.[taskIndex];
 if(!task)return alert(tr("This task no longer exists. Refresh the work order."));
 const ok=await applyTaskServerAction(workOrderId,task.uid,"pause",{reason,note});
 if(ok)closeModal("taskPauseModal");
}
async function resumeTask(workOrderId,taskIndex){
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
 const task=w?.tasks?.[taskIndex];
 if(!task)return alert(tr("This task no longer exists. Refresh the work order."));
 await applyTaskServerAction(workOrderId,task.uid,"resume");
}
async function stopTask(workOrderId,taskIndex){
 const w=state.workorders.find(x=>String(x.id)===String(workOrderId));
 const task=w?.tasks?.[taskIndex];
 if(!task)return alert(tr("This task no longer exists. Refresh the work order."));
 if(!confirm(tr("Mark this job as completed?")))return;
 await applyTaskServerAction(workOrderId,task.uid,"complete");
}

function workOrderNotesBlock(w){
 let out="";
 if(w.completionNotes){
   out+=`<div class="futureNote"><b>Mechanic completion notes</b><div>${esc(w.completionNotes)}</div></div>`;
 }
 if(w.futureNotes){
   out+=`<div class="futureNote"><b>Future / next visit reminder</b><div>${esc(w.futureNotes)}</div>${w.revisitMiles?`<div class="muted">Recommended recheck in ${esc(String(w.revisitMiles))} miles</div>`:""}</div>`;
 }
 if((w.history||[]).length){
   const entries=(w.history||[]).slice().reverse().map(h=>{
     if(h.type==="reactivated"){
       return `<div class="historyitem"><b>Reactivated</b> · ${fmtDateTime(h.at)}<div class="muted">${esc(h.byDisplay||h.by||"")}</div><div>${esc(h.reason||"")}</div>${(h.addedTasks||[]).length?`<div class="muted"><b>Added work:</b> ${(h.addedTasks||[]).map(esc).join(", ")}</div>`:""}</div>`;
     }
     if(h.type==="completed"){
       return `<div class="historyitem"><b>Completed</b> · ${fmtDateTime(h.at)}<div class="muted">${esc(h.byDisplay||h.by||"")}</div></div>`;
     }
     if(h.type==="truck_arrived"){
       return `<div class="historyitem"><b>Truck marked here</b> · ${fmtDateTime(h.at)}<div class="muted">${esc(h.byDisplay||h.by||"")}</div></div>`;
     }
     if(h.type==="helper_added"){return `<div class="historyitem"><b>Helper added: ${esc(h.helperDisplay||mechanicDisplay(h.helper)||h.helper||"")}</b> · ${fmtDateTime(h.at)}<div class="muted">Added by ${esc(h.byDisplay||h.by||"")}</div></div>`;}
     if(h.type==="helper_removed"){return `<div class="historyitem"><b>Helper removed: ${esc(mechanicDisplay(h.helper)||h.helper||"")}</b> · ${fmtDateTime(h.at)}<div class="muted">By ${esc(h.byDisplay||h.by||"")}</div></div>`;}
     if(h.type==="task_outcome"){
       const label=h.outcome==="next_visit"?"Next Visit":"Not Completed";
       return `<div class="historyitem"><b>${esc(h.task||"Job")} — ${label}</b> · ${fmtDateTime(h.at)}<div class="muted">${esc(h.note||"")} · ${esc(h.byDisplay||h.by||"")}</div></div>`;
     }
     return "";
   }).join("");
   out+=`<div class="card" style="margin-top:12px"><b>Work Order History</b>${entries}</div>`;
 }
 return out;
}

function openDetail(id){
 let w=state.workorders.find(x=>x.id===id); if(!w)return; if(session?.role==="mechanic"){
 const ownCompleted=w.status==="Completed" && (w.completedBy===session.username || mechanicAssignedToWorkOrder(w,session.username) || (w.tasks||[]).some(t=>t.outcomeBy===session.username));
 const ownUpcoming=upcomingForCurrentMechanic(w);
 if(!visibleToCurrentMechanic(w) && !ownCompleted && !ownUpcoming) return alert(tr("You do not have access to this work order."));
}
 document.getElementById("detailTitle").textContent=session?.role==="mechanic"?`Unit ${w.unit}`:`Work Order #${w.id} — ${w.unit}`;
 const adminControls=(session?.role==="admin" && w.status!=="Completed")?`
   <h2 style="margin-top:16px">Admin Controls</h2>
   <div class="field"><label>Parking spot #</label><input id="parkingEdit" value="${esc(w.parking||"")}" placeholder="P-12"></div>
   <button class="secondary" onclick="saveParking(${w.id})">Save Parking Spot</button> <button class="secondary" onclick="closeModal('detailModal');openEdit(${w.id})">Edit Full Work Order</button> <button class="danger" onclick="deleteWorkOrder(${w.id})">Delete Work Order</button>
   ${w.unitType==="customer"?(w.truckHere?`<button class="purple" onclick="markTruckNotHere(${w.id})">Move Back to Future / Not Here</button>`:`<button class="success" onclick="markTruckHere(${w.id});openDetail(${w.id})">✓ Mark Truck Is Here</button>`):`<span class="badge b-here">Fleet unit auto-release: ${w.fleetAuto!==false?"ON":"OFF"}</span>`}
 `:(session?.role==="admin"?`
   <h2 style="margin-top:16px">Admin Controls</h2>
   <button class="danger" onclick="deleteWorkOrder(${w.id})">Delete Work Order</button>
 `:"");
 const mechanicControls=(session?.role==="mechanic" && visibleToCurrentMechanic(w))?`
  <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
   ${w.status!=="Completed"?`<button onclick="setStatus(${w.id},'In Progress')">Start Work Order</button><button onclick="openCompleteWithNotes(${w.id})">Complete Work Order</button><button class="secondary" onclick="closeModal('detailModal');openIssue(${w.id})">Add Inspection Finding</button>`:""}
  </div>`:
 (session?.role==="mechanic" && upcomingForCurrentMechanic(w)?`
  <div class="notice" style="margin-top:14px">This unit is assigned to you but is still marked as on the way.</div>
  <div style="margin-top:10px"><button class="success" onclick="mechanicMarkTruckHere(${w.id});closeModal('detailModal')">✓ Truck Is Here</button></div>`:
 (session?.role==="mechanic" && w.status==="Completed" && (w.completedBy===session.username || mechanicAssignedToWorkOrder(w,session.username) || (w.tasks||[]).some(t=>t.outcomeBy===session.username))?`
  <div style="margin-top:14px">${(w.completedBy===session.username || w.mechanic===session.username)?`<button class="secondary" onclick="closeModal('detailModal');openReactivate(${w.id})">Reactivate / Add Missed Work</button>`:`<div class="notice">You participated in this work order. Only the primary/completing mechanic can reactivate it.</div>`}</div>`:
 (session?.role==="mechanic"?`<div class="notice" style="margin-top:14px">This work order is not assigned/released to your mechanic account.</div>`:"")));
 document.getElementById("detailBody").innerHTML=`
  <div class="muted">${esc(w.customer)} · ${esc(w.date)} ${esc(w.time)} · Parking: ${esc(w.parking||"—")}</div>${(w.vin||w.make||w.model||w.plate||w.dotNumber)?`<div class="vehicleMatchCard" style="margin-top:8px"><b>${esc([w.year,w.make,w.model].filter(Boolean).join(" ")||`Unit ${w.unit}`)}</b><div class="muted">${esc([w.vin?`VIN ${w.vin}`:"",w.plate?`Plate ${w.plate}`:"",w.dotNumber?`DOT ${w.dotNumber}`:"",w.mileage?`${Number(w.mileage).toLocaleString()} mi`:""].filter(Boolean).join(" · "))}</div></div>`:""}
  <div class="assignmentStrip">${assignmentChips(w)}</div>
  ${(session?.role==="admin" || (session?.role==="mechanic"&&visibleToCurrentMechanic(w)))&&w.status!=="Completed"?`<div class="helperActions"><button type="button" class="secondary" onclick="openAddHelper(${w.id})">+ Add Helper Mechanic</button>${session?.role==="admin"?(w.helpers||[]).map(u=>`<button type="button" class="danger" data-helper="${encodeURIComponent(u)}" onclick="removeHelperMechanic(${w.id},decodeURIComponent(this.dataset.helper))">Remove ${esc(mechanicDisplay(u))}</button>`).join(""):""}</div>`:""}
  <p><b>Priority:</b> ${esc(w.priority)} &nbsp; <b>Status:</b> ${esc(w.status)} &nbsp; ${availabilityBadge(w)} ${w.isReactivated?'<span class="badge b-wait">Reactivated</span>':""}</p>
  ${w.notes?`<div class="card" style="background:#fafafa"><b>Notes</b><div>${esc(w.notes)}</div></div>`:""}
  <h2 style="margin-top:16px">Assigned Jobs</h2>
  ${w.status==="Completed" && Number(w.outcomeWorkflowVersion||0)===0?`<div class="notice" style="margin-bottom:10px">This work order was completed before per-job outcomes were introduced. Missing outcomes are historical only and do not require action.</div>`:""}
  ${w.tasks.map((t,i)=>taskTimerRow(w,t,i)).join("")}
  ${workOrderNotesBlock(w)}
  ${w.status==="Completed"?`<div style="margin-top:12px"><button class="secondary" onclick="downloadWorkOrderPDF(${w.id})">Download Work Order PDF</button></div>`:""}
  <div class="card mechanicWorkSummary"><h2 style="margin:0">Mechanic Work Summary</h2><div class="muted">Who worked on each job and their recorded labor time.</div><div data-mechanic-work-summary-wo="${esc(String(w.id))}" style="margin-top:8px"><div class="muted">Loading mechanic labor…</div></div></div>
  ${adminControls}
  ${mechanicControls}`;
 document.getElementById("detailModal").classList.add("open");
 loadWorkOrderTaskSessions(w.id);
}


async function downloadWorkOrderPDF(id){
 try{
  const r=await fetch(`/api/work-orders/${encodeURIComponent(id)}/pdf`,{headers:authHeaders(),cache:"no-store"});
  if(!r.ok){
   let msg=`PDF download failed (${r.status}).`;
   try{const d=await r.json();if(d?.error)msg=d.error}catch(_){}
   if(r.status===401){
    cloudToken="";
    sessionStorage.removeItem("ittr_cloud_token");
    session=null;
    sessionStorage.removeItem("ittr_session");
    showLogin();
   }
   throw new Error(msg);
  }
  const blob=await r.blob();
  const cd=r.headers.get("content-disposition")||"";
  const m=cd.match(/filename="?([^";]+)"?/i);
  const name=m?m[1]:`ITTR-Work-Order-${id}.pdf`;
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
 }catch(e){alert(e.message||"Unable to download work order PDF.");}
}

function deleteWorkOrder(id){
 if(!requireAdmin())return;
 const w=state.workorders.find(x=>x.id===id);
 if(!w)return;
 const label=`${w.unit||"this unit"}${w.customer?` — ${w.customer}`:""}`;
 if(!confirm(`Delete work order for ${label}?\n\nThis permanently removes this work order and its findings from the shared shop database.`))return;
 state.workorders=state.workorders.filter(x=>x.id!==id);
 state.issues=(state.issues||[]).filter(i=>Number(i.wo)!==Number(id));
 save();
 closeModal("detailModal");
 render();
}

function saveParking(id){if(!requireAdmin())return;let w=state.workorders.find(x=>x.id===id);w.parking=document.getElementById("parkingEdit").value.trim();save();render();openDetail(id)}
function toggleTask(id,idx,val){if(!requireMechanic())return;let w=state.workorders.find(x=>x.id===id);w.tasks[idx].done=val;if(val&&w.status==="Open")w.status="In Progress";save();render()}

function completeWorkOrder(id){
 openCompleteWithNotes(id);
}

function setStatus(id,s){if(!requireMechanic())return;let w=state.workorders.find(x=>x.id===id);w.status=s;if(s==="Completed")w.completedAt=new Date().toLocaleString();save();render();openDetail(id)}
function completeIssue(id){if(!requireMechanic())return;let i=state.issues.find(x=>x.id===id);i.status="Completed";save();render()}



const helperFormEl=document.getElementById("helperForm");
if(helperFormEl)helperFormEl.onsubmit=e=>{
 e.preventDefault();
 const f=new FormData(e.target);
 addHelperMechanic(Number(f.get("workOrderId")),String(f.get("username")||""));
};

const passwordFormEl=document.getElementById("passwordForm");
if(passwordFormEl)passwordFormEl.onsubmit=async e=>{
 e.preventDefault();if(!requireAdmin())return;
 const f=new FormData(e.target),username=String(f.get("username")||""),password=String(f.get("password")||""),confirmPassword=String(f.get("confirmPassword")||"");
 if(password.length<6)return alert(tr("Password must be at least 6 characters."));if(password!==confirmPassword)return alert(tr("Passwords do not match."));
 try{await apiJSON(`/api/admin/users/${encodeURIComponent(username)}/password`,{method:"PATCH",body:JSON.stringify({password})});closeModal("passwordModal");alert(`Password changed for ${USERS[username]?.display||username}.`)}catch(ex){alert(ex.message)}
};

const taskPauseFormEl=document.getElementById("taskPauseForm");
if(taskPauseFormEl)taskPauseFormEl.onsubmit=e=>{
 e.preventDefault();
 const f=new FormData(e.target);
 pauseTask(Number(f.get("workOrderId")),Number(f.get("taskIndex")),String(f.get("reason")||""),String(f.get("note")||"").trim());
};

const taskOutcomeFormEl=document.getElementById("taskOutcomeForm");
if(taskOutcomeFormEl)taskOutcomeFormEl.onsubmit=e=>{
 e.preventDefault();
 if(!requireMechanic())return;
 const f=new FormData(e.target);
 const workOrderId=Number(f.get("workOrderId"));
 const taskIndex=Number(f.get("taskIndex"));
 const outcome=String(f.get("outcome")||"");
 const note=String(f.get("note")||"").trim();
 if(!["not_completed","next_visit"].includes(outcome))return alert(tr("Choose Not Completed or Next Visit."));
 if(!note)return alert(tr("Please enter a reason or next-visit note."));
 const w=state.workorders.find(x=>x.id===workOrderId);
 if(!w || !visibleToCurrentMechanic(w))return alert(tr("This work order is not active for your account."));
 const t=w.tasks?.[taskIndex];
 if(!t)return alert(tr("Job could not be found."));
 if(t.startedAt && !t.stoppedAt)return alert(tr("Stop the running timer first."));
 t.done=false;
 t.completedAt="";
 t.taskOutcome=outcome;
 t.outcomeNote=note;
 t.outcomeAt=new Date().toISOString();
 t.outcomeBy=session.username;
 w.history=w.history||[];
 w.history.push(workOrderHistoryEntry("task_outcome",{task:t.t,outcome,note}));
 save();
 closeModal("taskOutcomeModal");
 render();
 openDetail(workOrderId);
};

function coreReleaseVersion(v){
 const m=String(v||"").match(/\d+\.\d+\.\d+/);
 return m?m[0]:String(v||"").trim();
}
async function verifyReleaseCompatibility(){
 try{
  const r=await fetch("/api/build",{cache:"no-store"});
  if(!r.ok)throw new Error(`Build check failed (${r.status})`);
  const d=await r.json();
  const backend=coreReleaseVersion(d?.backend||"unknown");
  const expected=coreReleaseVersion(FRONTEND_VERSION);
  const live=document.getElementById("onlineBetaBar");if(live)live.textContent=`ITTR v${expected} ONLINE · backend ${backend} · SMART WORKSPACE · PARTS + BARCODE INVENTORY · FULLBAY · R2`;
  const b=document.getElementById("appErrorBanner");
  if(backend!==expected){
   if(b){
    b.style.display="block";
    b.textContent=`VERSION MISMATCH — Frontend ${expected} but backend ${backend}. Deploy index.html and server.js from the same release.`;
   }
   return false;
  }
  if(b && String(b.textContent||"").startsWith("VERSION MISMATCH")){
   b.style.display="none";
   b.textContent="";
  }
  return true;
 }catch(e){
  const b=document.getElementById("appErrorBanner");
  if(b){
   b.style.display="block";
   b.textContent=`BACKEND BUILD CHECK FAILED — ${e.message||"Unable to verify deployed server version."}`;
  }
  return false;
 }
}

document.addEventListener("DOMContentLoaded",async()=>{
 const mobileChromeResize=()=>{
   if(window.visualViewport){document.body.classList.toggle("keyboardOpen",window.visualViewport.height < window.innerHeight*0.72);}
   syncMobileChrome();
 };
 window.addEventListener("resize",mobileChromeResize,{passive:true});
 window.addEventListener("orientationchange",()=>setTimeout(mobileChromeResize,150),{passive:true});
 window.visualViewport?.addEventListener("resize",mobileChromeResize,{passive:true});
 if(window.ResizeObserver){const ro=new ResizeObserver(syncMobileChrome);const n=document.getElementById("mobileBottomNav"),h=document.querySelector("header");if(n)ro.observe(n);if(h)ro.observe(h);}
 mobileChromeResize();
 await verifyReleaseCompatibility();
 startAITranslationObserver();
 const aiToggle=document.getElementById("aiTranslateEnabled");if(aiToggle)aiToggle.checked=aiTranslationEnabled;
 bindNavigation();updateOnlineState();
 if(session&&cloudToken){const ok=await restoreCloudSession();if(!ok)session=null;}
 showLogin();
 if(session){applyRole();render();}else{applyTranslations();}
 setInterval(()=>{if(session?.role==="admin"&&currentView==="dashboard"&&!document.hidden)renderMechanicLiveStatus()},2000);
// Pull newer cloud snapshots so admin approvals and mechanic updates appear across devices.
setInterval(()=>{if(session&&cloudReady&&!document.hidden)refreshCloudStateSilently()},4000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&session&&cloudReady)refreshCloudStateSilently()});
window.addEventListener("focus",()=>{if(session&&cloudReady)refreshCloudStateSilently()});
});

if("serviceWorker" in navigator){
 window.addEventListener("load",()=>{
   /* service worker registration disabled in v22.6 */
 });
}

