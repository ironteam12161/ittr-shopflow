let localAbort=null;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.loadInvoices?.(),{passive:true});
 await window.loadInvoices?.();
}
export async function afterShow(){await window.loadInvoices?.()}
export function unmount(){localAbort?.abort();localAbort=null}
