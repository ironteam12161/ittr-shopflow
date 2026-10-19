let localAbort=null;
// v24.76.0: mount() already loads this page, so showView() skips the first afterShow() (no double request).
export const loadsOnMount=true;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.renderCustomerDirectory?.(),{passive:true});
 await window.renderCustomerDirectory?.();
}
export async function afterShow(){await window.renderCustomerDirectory?.()}
export function unmount(){localAbort?.abort();localAbort=null}
