import fs from 'node:fs';

const files=['public/index.html','index.html'];
const oldFn=`function openInvoiceWorkspace(id){
  const url=invoiceWorkspaceUrl(id);
  // Open as a normal isolated browser tab; authentication is handed off
  // over a same-origin BroadcastChannel, so no credentials are placed in the URL.
  const link=document.createElement('a');
  link.href=url;
  link.target='_blank';
  document.body.appendChild(link);
  link.click();
  link.remove();
}`;
const newFn=`function openInvoiceWorkspace(id){
  const invoiceId=Number(id||0);
  if(!invoiceId)return;
  const url=invoiceWorkspaceUrl(invoiceId);
  // Use window.open instead of a synthetic target=_blank anchor. Modern browsers
  // treat target=_blank links as implicit noopener, which prevents the new tab
  // from inheriting this tab's sessionStorage. That left invoiceWorkspace tabs
  // authenticated too late (or not at all) and produced a blank workspace.
  // A same-origin window.open preserves the opener/session handoff. BroadcastChannel
  // remains available as a secondary authentication handoff.
  let tab=null;
  try{tab=window.open(url,'_blank')}catch(_){tab=null}
  if(!tab){
    // Popup/tab blocked: never strand the user. Open the invoice in the current SPA.
    openInvoice(invoiceId,false);
    return;
  }
  try{tab.focus()}catch(_){ }
}`;

for(const fp of files){
  if(!fs.existsSync(fp))continue;
  let s=fs.readFileSync(fp,'utf8');
  if(s.includes(oldFn)){
    s=s.replace(oldFn,newFn);
  }else if(!s.includes("Modern browsers\n  // treat target=_blank links as implicit noopener")){
    throw new Error(`Invoice workspace opener signature not found in ${fp}; refusing unsafe patch.`);
  }
  fs.writeFileSync(fp,s);
}
console.log('ITTR v24.26.0 invoice workspace navigation fix applied');
