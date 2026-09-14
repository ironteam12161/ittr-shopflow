let localAbort=null;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.loadPartsCenter?.(),{passive:true});
 await window.loadPartsCenter?.();
}
export async function afterShow(){await window.loadPartsCenter?.()}
export function unmount(){localAbort?.abort();localAbort=null}
