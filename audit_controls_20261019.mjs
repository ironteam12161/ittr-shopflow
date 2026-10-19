// Audit-only control explorer. Runs only on test_harness's disposable local server/database.
import {startTestServer,dbSuiteGuard,sleep} from './test_harness.mjs';
import {chromium} from 'playwright';
import {writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
dbSuiteGuard('control explorer');
const OWNER={username:'auditowner',password:'Audit-Owner-Only-2026!'};
const srv=await startTestServer({prefix:'ittr_control_audit',admin:OWNER,env:{STRIPE_SECRET_KEY:'',RESEND_API_KEY:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',TWILIO_ACCOUNT_SID:'',TWILIO_AUTH_TOKEN:''}});
const R=srv.request, records=[],screens=[],observations=[],requests=[],consoleErrors=[],popups=[],roles={};
let browser;const base=srv.base(),today=new Date().toISOString().slice(0,10),now=new Date().toISOString();
const t=(uid,text,extra={})=>({uid,t:text,done:false,startedAt:'',stoppedAt:'',elapsedMs:0,parts:[],...extra});
const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
const fp=e=>JSON.stringify({tag:e.tagName,id:e.id||'',attrs:[...e.attributes].filter(a=>a.name==='onclick'||a.name.startsWith('data-')&&!a.name.startsWith('data-audit')).map(a=>[a.name,a.value]).sort(),text:e.id||e.getAttribute('onclick')||[...e.attributes].some(a=>a.name.startsWith('data-'))?'':e.textContent.trim().replace(/\s+/g,' ')});
try{
const token=await srv.login(OWNER.username,OWNER.password);
for(const u of ['mechanic1','mechanic2']){await R('/api/admin/users',{method:'POST',token,body:{username:u,display:u==='mechanic1'?'Roman (test)':'Ivan (test)',password:'Audit-Mechanic-2026!'}});roles[u]='Audit-Mechanic-2026!';}
for(const [u,permissions] of [['managerall',{customers:true,invoices:true,inventory:true,reports:true,employees:true,financials:true}],['managerlimited',{customers:false,invoices:false,inventory:false,reports:false,employees:false,financials:false}]]){await R('/api/admin/managers',{method:'POST',token,body:{username:u,display:u,permissions,password:'Audit-Manager-2026!'}});roles[u]='Audit-Manager-2026!';}roles.auditowner=OWNER.password;
const c=(await R('/api/customers',{method:'POST',token,body:{customer_name:'Audit Fleet & Logistics LLC',email:'audit@example.test',phone:'555-0100'}})).item;
const cid=c.id;await R(`/api/customers/${cid}/units`,{method:'POST',token,body:{unit_number:'6600',vin:'1HGBH41JXMN109186'}});
const st=await R('/api/state',{token});const sf=st.shopflow.payload;
sf.workorders=[
{id:901,unit:'6600',customer:c.customer_name,customerId:cid,status:'Open',mechanic:'mechanic1',helpers:['mechanic2'],truckHere:true,date:today,time:'08:00',tasks:[t('a1','Inspect brakes and replace oil filter'),t('a2','Check coolant leak')],inspection:{required:true,type:'truck',status:'Not Started',results:{}}},
{id:902,unit:'TR-902',customer:c.customer_name,customerId:cid,status:'In Progress',mechanic:'mechanic2',helpers:[],truckHere:true,date:today,time:'09:00',tasks:[t('b1','Repair air leak',{paused:true,pauseReason:'Waiting for parts'})],blockers:{parts:{on:true,note:'Air valve expected tomorrow'}},inspection:{required:false,status:'Not Required',results:{}}},
{id:903,unit:'FUTURE-903',customer:c.customer_name,status:'Open',mechanic:'',helpers:[],truckHere:false,date:today,time:'10:00',tasks:[t('c1','PM service')],inspection:{required:false,status:'Not Required',results:{}}},
{id:904,unit:'DONE-904',customer:c.customer_name,customerId:cid,status:'Completed',mechanic:'mechanic1',helpers:[],truckHere:true,date:today,time:'11:00',tasks:[t('d1','Oil change',{done:true,outcome:'Completed',taskOutcome:'completed',finishedBy:'mechanic1'})],inspection:{required:false,status:'Not Required',results:{}}},
{id:905,unit:'RUN-905',customer:c.customer_name,status:'In Progress',mechanic:'mechanic1',helpers:[],truckHere:true,date:today,time:'12:00',tasks:[t('e1','Wheel seal replacement',{startedAt:now,runningBy:'mechanic1'})],inspection:{required:false,status:'Not Required',results:{}}},
{id:906,unit:'QC-906',customer:c.customer_name,status:'In Progress',mechanic:'mechanic2',helpers:[],truckHere:true,date:today,time:'13:00',tasks:[t('f1','Replace front brake shoes',{done:true,outcome:'Completed',taskOutcome:'completed'})],inspection:{required:false,status:'Not Required',results:{}}}];
sf.issues=[{id:'audit-f1',wo:901,mechanic:'mechanic1',description:'Front brake lining worn',recommendation:'Replace brake shoes',approval:'Waiting for Customer',createdAt:now,officeReviewedAt:now,sentAt:now,photoIds:[]},{id:'audit-f2',wo:902,mechanic:'mechanic2',description:'Oil seep',recommendation:'Monitor seep',approval:'Do Not Proceed',createdAt:now,photoIds:[]}];
await R('/api/state/shopflow',{method:'PUT',token,body:{payload:sf,expectedVersion:st.shopflow.version}});
const part=(await srv.db.query(`INSERT INTO fullbay_import_parts(source_key,part_number,description,quantity,cost,price,location,vendor,status,uom,allocated,min_qty) VALUES('audit-p1','AUDIT-FILTER','Engine oil filter',10,20,35,'A-01','Audit Vendor','Active','each',0,2) RETURNING id`)).rows[0].id;
const inv=await R('/api/invoices',{method:'POST',token,body:{customerId:cid,customerName:c.customer_name,unitNumber:'6600'}});
await R(`/api/invoices/${inv.id}/lines`,{method:'POST',token,body:{lineType:'labor',description:'Oil change',quantity:1,unitPrice:150,taxable:false,jobName:'PM service'}});
await R(`/api/invoices/${inv.id}/lines`,{method:'POST',token,body:{lineType:'part',description:'Engine oil filter',partNumber:'AUDIT-FILTER',inventoryPartId:part,quantity:1,unitPrice:35,taxable:false,jobName:'PM service'}});
const est=await R('/api/estimates',{method:'POST',token,body:{customerName:c.customer_name}});await R(`/api/estimates/${est.id}/lines`,{method:'POST',token,body:{lineType:'labor',description:'Brake job',quantity:2,unitPrice:150}});
await srv.db.query('UPDATE customer_estimates SET customer_id=$1 WHERE id=$2',[cid,est.id]);
await R('/api/purchase-orders',{method:'POST',token,body:{vendor:'Audit Vendor',workOrderId:'902',lines:[{partNumber:'VALVE',description:'Air valve',qty:1,unitCost:50}]}});
const link=await R('/api/customer-links',{method:'POST',token,body:{kind:'portal',refId:String(cid)}});
const portalPath=new URL(link.url).pathname;
browser=await chromium.launch({headless:true,args:['--no-sandbox']});
// Focused cross-module/live/reconnect checks before exercising generic controls.
{
 const ctx=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'}),p=await ctx.newPage(),stockResponses=[],messages=[];
 p.on('dialog',d=>d.dismiss());p.on('response',async r=>{try{if(new URL(r.url()).pathname==='/api/parts'){const d=await r.json();stockResponses.push({at:Date.now(),qty:d.items?.find(x=>Number(x.id)===Number(part))?.quantity})}}catch{}});
 p.on('websocket',ws=>ws.on('framereceived',e=>{try{messages.push(JSON.parse(String(e.payload)))}catch{}}));
 try{
  await p.goto(base);await p.fill('#loginUser',OWNER.username);await p.fill('#loginPass',OWNER.password);await p.click('#loginForm button[type=submit]');await p.waitForFunction(()=>cloudReady);await p.evaluate(()=>showView('parts'));await sleep(600);
  const n0=stockResponses.length,m0=messages.length,before=stockResponses.at(-1)?.qty;
  await R(`/api/invoices/${inv.id}/finalize`,{method:'POST',token});await sleep(1400);
  const actual=(await R(`/api/parts/${part}`,{token})).item.quantity;
  observations.push({kind:'invoice-stock-live-refresh',before,serverAfter:actual,displayedAfter:stockResponses.at(-1)?.qty,partsFetches:stockResponses.length-n0,domains:messages.slice(m0).filter(m=>m.type==='data_changed').map(m=>m.domain)});
  await p.evaluate(()=>loadPartsCenter());await sleep(200);
  await p.evaluate(()=>stopLiveStatusSocket());await sleep(150);
  const n1=stockResponses.length,offlineBefore=stockResponses.at(-1)?.qty;
  await R(`/api/parts/${part}/transaction`,{method:'POST',token,body:{type:'adjust_add',qty:3,reason:'Audit reconnect check'}});await sleep(700);
  await p.evaluate(()=>connectLiveStatusSocket());await p.waitForFunction(()=>document.getElementById('liveStatusBadge')?.dataset.state==='connected');await sleep(1400);
  observations.push({kind:'reconnect-stock-live-refresh',before:offlineBefore,serverAfter:(await R(`/api/parts/${part}`,{token})).item.quantity,displayedAfter:stockResponses.at(-1)?.qty,partsFetches:stockResponses.length-n1});
  await p.evaluate(async id=>{await showView('invoices');await openInvoice(id,true)},inv.id);await sleep(200);
  const current=await R(`/api/invoices/${inv.id}`,{token}),line=current.lines.find(l=>l.line_type==='labor'),newDescription='REMOTE CHANGED LABOR DESCRIPTION';
  await R(`/api/invoices/${inv.id}/lines/${line.id}`,{method:'PUT',token,body:{lineType:'labor',description:newDescription,quantity:Number(line.quantity),unitPrice:Number(line.unit_price),taxable:false,jobName:line.job_name}});
  await p.waitForSelector('#ittrStaleNote',{timeout:5000});await p.locator('#ittrStaleNote button').first().click();await sleep(600);
  observations.push({kind:'invoice-editor-refresh',remoteDescription:newDescription,editorDescription:await p.evaluate(id=>activeInvoice?.lines?.find(l=>String(l.id)===String(id))?.description,line.id),noteStillVisible:await p.locator('#ittrStaleNote').count()});
 }catch(e){observations.push({kind:'focused-check-error',error:e.stack||String(e)})}
 await ctx.close();console.log('AUDIT_FOCUSED '+JSON.stringify(observations));
}
const officeViews=['dashboard','board','workorders','approvals','customers','compliance','parts','purchaseorders','estimates','invoices','bills','reports','procenter','completed','accounts','activityhistory','trucksearch'];
const selectors='button,a,[role=button],[onclick]';const exercised=new Map(),modalSpecs=new Map();
for(const role of ['auditowner','managerall','managerlimited','mechanic1','mechanic2'])for(const width of role==='auditowner'?[1440,900,390]:[1440,390]){
 const ctx=await browser.newContext({viewport:{width,height:900},timezoneId:'America/Chicago',serviceWorkers:'block',acceptDownloads:true});
 await ctx.addInitScript(()=>{window.__auditPrints=0;window.print=()=>window.__auditPrints++;});
 await ctx.route('**/*',route=>{const u=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol))return route.continue();return route.abort();});
 let page=await ctx.newPage(),errors=[],dialogs=[],http=[],downloads=[];
 const attach=p=>{p.setDefaultTimeout(2500);p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>{dialogs.push({type:d.type(),message:d.message()});d.dismiss().catch(()=>{})});p.on('response',r=>{if(r.url().includes('/api/'))http.push({status:r.status(),path:new URL(r.url()).pathname})});p.on('download',d=>downloads.push(d.suggestedFilename()));p.on('popup',p=>{popups.push({role,width,url:p.url()});p.close().catch(()=>{})});p.on('console',m=>{if(m.type()==='error')consoleErrors.push({role,width,text:m.text()})})};attach(page);
 async function login(){await page.goto(base);await page.fill('#loginUser',role);await page.fill('#loginPass',roles[role]);await page.click('#loginForm button[type=submit]');await page.waitForFunction(()=>cloudReady,null,{timeout:15000});await sleep(120)}
 await login();
 const allowed=await page.evaluate(views=>views.filter(v=>allowedViewForRole(v)),officeViews);
 const cases=(role.startsWith('mechanic')?['mechanic','inspection','mycompleted']:allowed).map(view=>({name:view,view}));
 if(role==='auditowner'){
  for(const panel of ['maintenance','productivity','notifications','dailyreport','audit','fullbay','aitools'])cases.push({name:'operations-'+panel,view:'procenter',panel});
  for(const tab of ['jobs','findings','photos','inspection','time','billing'])cases.push({name:'work-order-'+tab,view:'wo',wo:901,tab});
  cases.push({name:'invoice-editor',view:'invoices',invoice:inv.id});
  for(const report of ['overview','ar','spend','mech','tires','inbox','ai'])cases.push({name:'reports-'+report,view:'reports',report});
  cases.push({name:'customer-profile',view:'customers',customer:cid});
  for(const v of ['instock','fluids','need','order','all'])cases.push({name:'parts-'+v,view:'parts',parts:v});
 }
 if(role.startsWith('mechanic')){cases.push({name:'assigned-work-detail',view:'mechanic',detail:901},{name:'other-mechanic-detail',view:'mechanic',detail:902},{name:'unassigned-detail',view:'mechanic',detail:903});}
 cases.push({name:'header',view:role.startsWith('mechanic')?'mechanic':'dashboard',root:'header'});
 if(width===390)cases.push({name:'mobile-navigation',view:role.startsWith('mechanic')?'mechanic':'dashboard',root:'#mobileBottomNav'});
 const seen=exercised.get(role)||new Set();exercised.set(role,seen);const oldForms=modalSpecs.get(role)||[];cases.push(...oldForms);const modalSeen=new Set(oldForms.map(s=>s.root));
 async function setup(spec){
  if(page.isClosed()){page=await ctx.newPage();attach(page);await login()}
  if(!await page.evaluate(()=>!!session&&cloudReady).catch(()=>false))await login();
  await page.evaluate(()=>{window.ITTR_NO_LOGOUT_RELOAD=true;document.querySelectorAll('.modal.open').forEach(m=>m.classList.remove('open'));document.getElementById('mobileMoreSheet')?.classList.remove('open');window.ITTRPhotoViewer?.close();document.body.classList.remove('invoiceWorkspaceMode');syncModalState()});
  await page.evaluate(async s=>{if(s.wo){woWs.id=s.wo;woWs.tab=s.tab;await showView('wo')}else await showView(s.view);if(s.panel)showProPanel(s.panel);if(s.parts)setPartsView(s.parts);if(s.invoice)await openInvoice(s.invoice,true);if(s.customer)await openCustomerProfile(s.customer);if(s.report)document.querySelector(`[data-rep=tab][data-t="${s.report}"]`)?.click();if(s.detail)openDetail(s.detail);},spec);
  await sleep(120);
  for(const key of spec.path||[]){const found=await mark(key);if(!found)return false;await page.locator('[data-audit-selected="1"]').click({timeout:1400}).catch(()=>{});await sleep(120)}
  return true;
 }
 async function mark(key){return page.evaluate(({key,source,selectors})=>{document.querySelectorAll('[data-audit-selected]').forEach(e=>e.removeAttribute('data-audit-selected'));const f=(e=>JSON.stringify({tag:e.tagName,id:e.id||'',attrs:[...e.attributes].filter(a=>a.name==='onclick'||a.name.startsWith('data-')&&!a.name.startsWith('data-audit')).map(a=>[a.name,a.value]).sort(),text:e.id||e.getAttribute('onclick')||[...e.attributes].some(a=>a.name.startsWith('data-'))?'':e.textContent.trim().replace(/\s+/g,' ')}));const candidates=[...document.querySelectorAll(selectors)].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&f(e)===key);if(!candidates.length)return false;candidates[0].setAttribute('data-audit-selected','1');return true},{key,source:fp.toString(),selectors})}
 for(let ci=0;ci<cases.length;ci++){
  const spec=cases[ci];try{if(!await setup(spec)){screens.push({role,width,case:spec.name,setup:'parent control unavailable'});continue}
  const root=spec.root||await page.evaluate(s=>{const m=getTopOpenModal?.();return m?'#'+m.id:'#'+(s.wo?'wo':s.view)},spec);
  const inventory=await page.evaluate(({root,selectors,source})=>{const h=document.querySelector(root),f=(e=>JSON.stringify({tag:e.tagName,id:e.id||'',attrs:[...e.attributes].filter(a=>a.name==='onclick'||a.name.startsWith('data-')&&!a.name.startsWith('data-audit')).map(a=>[a.name,a.value]).sort(),text:e.id||e.getAttribute('onclick')||[...e.attributes].some(a=>a.name.startsWith('data-'))?'':e.textContent.trim().replace(/\s+/g,' ')})),vis=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';if(!h)return {missing:root,controls:[]};const controls=[...h.querySelectorAll(selectors)].filter(vis).filter(e=>!e.parentElement?.closest('button,a,[role=button]')).map(e=>({key:f(e),text:e.innerText?.trim().replace(/\s+/g,' ').slice(0,120)||e.title||e.getAttribute('aria-label')||e.id,disabled:!!e.disabled,tag:e.tagName,role:e.getAttribute('role'),tabIndex:e.tabIndex,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}));const inputs=[...h.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(vis).filter(e=>!(e.labels?.length||e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||e.title)).map(e=>({id:e.id,type:e.type,placeholder:e.placeholder}));return {controls,unlabeled:inputs,overflow:document.documentElement.scrollWidth>innerWidth,view:typeof currentView==='undefined'?'':currentView,hash:location.hash}}, {root,selectors,source:fp.toString()});
  screens.push({role,width,case:spec.name,root,...inventory});
  for(const control of inventory.controls){
   const rec={role,width,case:spec.name,text:control.text,key:control.key};
   if(control.disabled){rec.outcome='disabled';records.push(rec);continue}
   if(/delete all|erase all|reset all|permanently erase|clear everything|wipe/i.test(control.text||'')){rec.outcome='destructive-final-step-not-executed';records.push(rec);continue}
   if(seen.has(control.key)){rec.outcome='same-handler-previously-exercised';records.push(rec);continue}
   const e0=errors.length,d0=dialogs.length,h0=http.length,dl0=downloads.length;
   try{
    if(!await setup(spec)||!await mark(control.key)){rec.outcome='unavailable-on-reset';records.push(rec);continue}
    await page.locator('[data-audit-selected="1"]').click({timeout:1400});await sleep(140);rec.outcome='clicked';seen.add(control.key);
    rec.after=await page.evaluate(()=>({view:currentView,hash:location.hash,modals:[...document.querySelectorAll('.modal.open')].map(e=>e.id),invalid:[...document.querySelectorAll('.modal.open input,.modal.open select,.modal.open textarea')].filter(e=>!e.checkValidity()).map(e=>e.id)})).catch(()=>({navigated:true}));
    const mid=rec.after.modals?.at(-1);if(mid&&!spec.path?.length&&!modalSeen.has('#'+mid)&&cases.length<130){modalSeen.add('#'+mid);const next={...spec,name:spec.name+' → '+control.text,root:'#'+mid,path:[control.key]};cases.push(next);const forms=modalSpecs.get(role)||[];forms.push(next);modalSpecs.set(role,forms);}
   }catch(e){rec.outcome='interaction-error';rec.error=e.message.split('\n')[0];}
   rec.errors=errors.slice(e0);rec.dialogs=dialogs.slice(d0);rec.http=http.slice(h0);rec.downloads=downloads.slice(dl0);records.push(rec);
  }
  }catch(e){screens.push({role,width,case:spec.name,setupError:e.message.split('\n')[0]})}
 }
 // Role navigation matrix is checked even when a forbidden tab has no visible button.
 const gates=await page.evaluate(vs=>vs.map(v=>({view:v,allowed:allowedViewForRole(v)})),officeViews).catch(()=>[]);observations.push({kind:'role-gates',role,width,gates});
 await ctx.close();console.log('AUDIT_PROGRESS '+JSON.stringify({role,width,screens:screens.length,controls:records.length}));
}
// Customer portal has a separate unauthenticated shell.
for(const width of [1440,390]){const ctx=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),p=await ctx.newPage(),errs=[];p.on('pageerror',e=>errs.push(e.message));await p.goto(base+portalPath);await sleep(500);screens.push({role:'customer',width,case:'portal',...await p.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('button,a')].map(e=>({text:e.innerText,href:e.getAttribute('href')})),text:document.body.innerText.slice(0,2000)})),errors:errs});await ctx.close();}
}catch(e){observations.push({kind:'fatal',error:e.stack||String(e)});console.error('AUDIT_FATAL '+(e.stack||e));}
finally{await browser?.close().catch(()=>{});await srv.cleanup();}
const payload={baseCommit:process.env.GITHUB_SHA||'local',version:'24.75.3',records,screens,observations,consoleErrors,popups};
writeFileSync('/tmp/ittr-control-audit.json',JSON.stringify(payload,null,2));
console.log('AUDIT_SUMMARY '+JSON.stringify({screens:screens.length,controls:records.length,outcomes:records.reduce((a,r)=>(a[r.outcome]=(a[r.outcome]||0)+1,a),{}),scriptErrors:records.filter(r=>r.errors?.length).length,setupErrors:screens.filter(s=>s.setupError).length,overflow:screens.filter(s=>s.overflow).length,fatal:observations.filter(o=>o.kind==='fatal')}));
console.log('AUDIT_PAYLOAD_GZIP_BASE64='+gzipSync(JSON.stringify(payload)).toString('base64'));

if(observations.some(o=>o.kind==='fatal'))process.exitCode=1;
