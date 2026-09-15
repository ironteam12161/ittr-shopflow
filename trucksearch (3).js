let localAbort=null;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.renderTruckSearch?.(),{passive:true});
 await window.renderTruckSearch?.();
}
export async function afterShow(){await window.renderTruckSearch?.()}
export function unmount(){localAbort?.abort();localAbort=null}
