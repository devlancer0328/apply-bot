/** Coalesce monitor checkpoints and serialize writes without blocking live updates. */
export function snapshotWriter(write,{delay=5000,onError=()=>{}}={}){
 let timer=null,latest=null,line=Promise.resolve();
 const flush=()=>{
  clearTimeout(timer);timer=null;if(!latest)return line;
  const value=latest;latest=null;
  line=line.then(()=>write(value)).catch(onError);return line;
 };
 return {schedule(value){latest=structuredClone(value);if(!timer)timer=setTimeout(flush,delay);},flush};
}
