/** Bound browser IPC waits; network requests use AbortSignal to cancel too. */
export function deadline(promise,ms,message){
 let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}
