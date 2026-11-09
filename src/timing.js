/** Wall time labels the event; a monotonic clock measures elapsed work. */
export const tick=()=>globalThis.performance?.now?.()??Date.now();
export const startClock=()=>({at:Date.now(),tick:tick()});
export const elapsedClock=clock=>Math.max(0,Math.round(tick()-clock.tick));
