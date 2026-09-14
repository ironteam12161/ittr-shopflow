let localAbort=null;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.renderCustomerDirectory?.(),{passive:true});
 await window.renderCustomerDirectory?.();
}
export async function afterShow(){await window.renderCustomerDirectory?.()}
export function unmount(){localAbort?.abort();localAbort=null}
