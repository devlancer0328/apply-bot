/**
 * Bounded ChatGPT requests. A fallback drains active requests before new work.
 *
 * The width used to be one or two and nothing else. What actually bounds
 * it is further out than two: each worker holds its own ChatGPT tab per
 * kind of task, so the cost of width is tabs and renderer memory, and the
 * account's own concurrent-use limit is the wall past that - a 429 stops
 * the pool outright rather than narrowing it, because hammering an
 * account that has said no is how a run loses ChatGPT for the night.
 * Four is where the tabs stop being free; the setting picks the number.
 */
const WIDEST = 4;
export class ChatWorkerPool {
  constructor(limit=1,onChange=()=>{}) {
    this.configured=Math.max(1,Math.min(WIDEST,Math.floor(Number(limit))||1));this.limit=this.configured;this.onChange=onChange;
    this.active=new Set();this.tasks=new Map();this.queue=[];this.failures=0;this.completed=0;this.closed=false;this.reason='';this.healthy=0;this.recentFailures=0;
  }
  status(){return {configured:this.configured,effective:this.limit,busy:this.active.size,queued:this.queue.length,completed:this.completed,failures:this.failures,reason:this.reason,tasks:[...this.tasks.values()]};}
  emit(){this.onChange(this.status());}
  run(work,metadata={}){return new Promise((resolve,reject)=>{if(this.closed){reject(this.closed);return;}this.queue.push({work,resolve,reject,metadata});this.drain();});}
  progress(slot,value){if(this.tasks.has(slot)){this.tasks.set(slot,{...this.tasks.get(slot),...value});this.emit();}}
  drain(){
    while(!this.closed&&this.queue.length&&this.active.size<this.limit){
      let slot=0;while(this.active.has(slot))slot++;
      const entry=this.queue.shift();this.active.add(slot);this.tasks.set(slot,{slot,startedAt:Date.now(),...entry.metadata});this.emit();
      Promise.resolve().then(()=>entry.work(slot)).then(value=>{
        this.completed++;this.healthy++;
        if(this.healthy>=4){this.recentFailures=0;if(!this.closed&&this.limit<this.configured){this.limit=this.configured;this.reason='';this.healthy=0;}}
        this.release(slot);entry.resolve(value);
      },error=>{
        if([401,402,403,409,412,429,499].includes(error?.status))this.stop(error);
        else if(error?.workerFailure){this.healthy=0;this.failures++;this.recentFailures++;if(this.recentFailures>=2&&this.limit>1){this.limit=1;this.reason='Repeated ChatGPT tab/response failures; continuing one request at a time until four requests succeed.';}}
        this.release(slot);entry.reject(error);
      });
    }
  }
  release(slot){this.active.delete(slot);this.tasks.delete(slot);this.emit();this.drain();}
  stop(error=Object.assign(new Error('ChatGPT workers stopped.'),{status:499})){
    this.closed=error;for(const entry of this.queue.splice(0))entry.reject(error);this.emit();
  }
}

/** A standalone conversation cannot safely be edited by multiple workers. */
export function parallelChatUrl(value){
  try{const u=new URL(value);if(u.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(u.hostname))return null;
    const project=u.pathname.match(/^\/g\/(g-p-[^/]+)/);if(project)return u.origin+'/g/'+project[1]+'/project';
    const gpt=u.pathname.match(/^\/g\/(g-[^/]+)(?:\/|$)/);if(gpt&&!u.pathname.includes('/c/'))return u.origin+'/g/'+gpt[1];
  }catch{}return null;
}
