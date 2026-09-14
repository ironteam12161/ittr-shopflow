let localAbort=null;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.renderProCenter?.(),{passive:true});
 await window.renderProCenter?.();
}
export async function afterShow(){await window.renderProCenter?.()}
export function unmount(){localAbort?.abort();localAbort=null}
