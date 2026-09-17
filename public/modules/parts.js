export const SMART_RECEIVING_CONFIG=Object.freeze({split:[50,50],varianceWarningPct:5,zoomMin:.4,zoomMax:3,rotateStep:90});
export function receivingPriceVariance(current,historical){const old=Number(historical||0),now=Number(current||0);return old>0?((now-old)/old)*100:0}
let localAbort=null;
export async function mount(scope){
 localAbort=new AbortController();
 scope.on(scope.host,"ittr:module-refresh",()=>window.loadPartsCenter?.(),{passive:true});
 await window.loadPartsCenter?.();
}
export async function afterShow(){await window.loadPartsCenter?.()}
export function unmount(){localAbort?.abort();localAbort=null}
