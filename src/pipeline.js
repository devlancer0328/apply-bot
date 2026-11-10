/** Stage boundaries are explicit; extraction and document preparation have separate bounds. */
export async function mapBounded(items,limit,work,stopped=()=>false){
 const output=new Array(items.length);let next=0,error;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!error&&!stopped()){const i=next++;if(i>=items.length)return;try{output[i]=await work(items[i],i);}catch(e){error=e;}}}));
 if(error)throw error;return output.filter(value=>value!==undefined);
}
/** An attempt the batch stopped waiting for. Never a value `apply` could return. */
const ABANDONED=Symbol('abandoned');

/**
 * A queue one stage hands to the next, with an end-of-stream signal.
 *
 * `take()` resolves with the next item, or with `null` once the stream
 * is closed and drained - which is what lets a stage worker return
 * instead of polling.
 */
function channel(){
 const items=[],waiting=[];let closed=false;
 return {
  size:()=>items.length,
  put(value){const next=waiting.shift();if(next)next(value);else items.push(value);},
  close(){closed=true;while(waiting.length)waiting.shift()(null);},
  take(){
   if(items.length)return Promise.resolve(items.shift());
   if(closed)return Promise.resolve(null);
   return new Promise(resolve=>waiting.push(resolve));
  },
 };
}

/** `width` workers pulling from `inbox` until it closes, or until `halt` says so. */
function pump(width,inbox,work,halt,fail){
 return Promise.all(Array.from({length:width},async()=>{
  for(;;){
   if(halt())return;
   const item=await inbox.take();
   if(item===null)return;
   if(halt())return;
   try{await work(item);}catch(error){fail(error);return;}
  }
 }));
}

/**
 * One batch of postings, from a link to a sent application.
 *
 * ## Why the stages are not barriers any more
 *
 * They used to be: every posting in the batch was read, then every one
 * was screened, and only then did the first resume get written. Both
 * halves of the night sat out that opening - no document was being
 * written and no form was being filled, for as long as it took to read
 * and screen a dozen postings.
 *
 * Measured on a simulated night at four workers (tests/pipeline-idle.mjs),
 * that cost 43% of ChatGPT's time and 37% of the application slots', and
 * none of the cheap fixes touched it: bigger batches and overlapping
 * discovery were each worth about one per cent, because the dead time
 * was inside the batch rather than between batches.
 *
 * So reading and screening are continuous stages now. A posting that has
 * been screened moves on while the one behind it is still being read,
 * and the writers and senders carry on with the previous window the
 * whole time.
 *
 * ## Why `choose` still sees a set
 *
 * Because it cannot answer one posting at a time. It scores a group in a
 * single ChatGPT call, and it picks the best role per employer across
 * the group - fed one at a time it would apply to the first role it saw
 * rather than the best one, which is a worse application every time an
 * employer has posted twice.
 *
 * It keeps a window instead, `chooseWindow` wide. What went is the
 * barrier around it: screening does not stop while a window is being
 * chosen, and the engine below does not stop while the next window is
 * being screened. Windows are handed over in the order the postings
 * arrived, so a priority-sorted batch is still worked best-first.
 *
 * `chooseWindow` of 0 means one window of everything, which is the old
 * behaviour exactly, and is what a caller that has already cut its own
 * batches wants.
 */
export async function stagedBatch(entries,{extract,screen,choose,prepare,apply,remaining,prepareConcurrency=1,screenConcurrency=1,applyConcurrency=1,extractConcurrency=3,chooseWindow=0,readyBacklog=0,applyDeadlineMs=0,stopGraceMs=0,pickReady=()=>0,readyPauseMs=1000,onAbandoned=()=>{},stopped=()=>false,phase=()=>{}}){
 let error;
 const fail=value=>{error ||= value;};
 // A completed document must not wait behind every slower job in the batch.
 // How much of ChatGPT a preparation may take at once is the caller's to
 // decide: it owns the worker pool and knows how much of it the form
 // filler needs left over for answers.
 const width=Math.max(1,Math.floor(prepareConcurrency)||1),pending=new Set(),ready=[];
 /**
  * How many finished documents may wait their turn to be sent.
  *
  * This used to be `width` too, and `width` was capped at two, so the
  * writer could never get more than two jobs ahead of the form filler -
  * and the filler is the half that stops. A captcha, a quarantined board,
  * a Workday wizard that will not load: any of them idles the writer
  * within two jobs, though writing needs nothing but ChatGPT. The night
  * this was measured on spent 5.5 of its 7.3 hours idle with no banked
  * work to fall back on.
  *
  * Separate now: `width` is what ChatGPT carries at once, this is how
  * deep the finished pile may get. Bounded rather than unlimited because
  * documents go stale - the compensation research inside one expires
  * after six hours, and a posting can close while its resume waits.
  */
 const backlog=Math.max(width,Math.floor(readyBacklog)||width);
 // Submissions stay sequential unless the caller widens them. One at a time
 // is correct whenever an attempt holds the browser for its whole length;
 // it is wrong once waiting for an emailed code stops holding anything,
 // because then the only thing a single slot buys is an idle browser.
 const sending=Math.max(1,Math.floor(applyConcurrency)||1),inflight=new Set();
 const selected=[];
 let cursor=0,frontDone=false;
 /**
  * How a chosen window reaches the engine without it polling for one.
  *
  * The engine has nothing of its own to wait on while the first window
  * is still being screened - no preparation, no attempt - so left to
  * itself it would sleep out `readyPauseMs` and only then look. That is
  * a second of four idle workers after every window, which is the thing
  * this whole change is about.
  */
 let waiters=[];
 const awaken=()=>{const list=waiters;waiters=[];for(const resolve of list)resolve();};
 const windowReady=()=>{
  let timer=null;
  // Bounded as well as woken, so a Stop pressed while the stages are
  // quiet is still noticed promptly.
  return Promise.race([new Promise(resolve=>waiters.push(resolve)),new Promise(resolve=>{timer=setTimeout(resolve,Math.min(500,Math.max(50,readyPauseMs)));})]).finally(()=>clearTimeout(timer));
 };

 // Reading and screening stop for the same two reasons the engine does.
 // Screening a posting the run has no room left to send is a ChatGPT
 // request spent on a job that will never be looked at again.
 const halt=()=>Boolean(error)||stopped()||remaining()<=0;

 /**
  * Reading, screening and choosing, running for as long as the batch does.
  *
  * The index each posting came in with is carried through so a window
  * can be handed to `choose` in the caller's order rather than in
  * whatever order screening happened to finish - the caller sorted them
  * by priority, and losing that would quietly work the batch at random.
  */
 const front=(async()=>{
  const read=channel(),screened=channel();
  const windowSize=Math.max(1,Math.floor(chooseWindow)||entries.length||1);
  const intake=channel();
  for(const[index,entry]of entries.entries())intake.put({index,entry});
  intake.close();

  const reading=pump(Math.max(1,extractConcurrency),intake,async({index,entry})=>{
   const value=await extract(entry,index);
   if(value)read.put({index,value});
  },halt,fail).then(()=>read.close());

  const screening=pump(Math.min(2,Math.max(1,screenConcurrency)),read,async({index,value})=>{
   const kept=await screen(value,index);
   if(kept)screened.put({index,value:kept});
  },halt,fail).then(()=>screened.close());

  // Windows in arrival order. The last one is whatever is left when the
  // stream ends, which is why a batch smaller than a window still runs.
  let group=[];
  const flush=async()=>{
   if(!group.length||halt())return;
   const ordered=group.sort((a,b)=>a.index-b.index).map(item=>item.value);
   group=[];
   const picked=await choose(ordered);
   for(const value of picked??[])selected.push(value);
   awaken();
  };
  try{
   for(;;){
    const item=await screened.take();
    if(item!==null)group.push(item);
    if(group.length>=windowSize||(item===null&&group.length))await flush();
    if(item===null)break;
   }
  }catch(failure){fail(failure);}
  await reading;await screening;
 })().catch(fail).finally(()=>{frontDone=true;awaken();});

 const launch=()=>{
  // Three separate ceilings, and they used to be one. What ChatGPT will
  // carry at once; how deep the finished pile may get; and the capacity
  // the applicant actually left, which has to count the sends already in
  // the air - two attempts started against one remaining submission would
  // overshoot the target, and preparing a document for a job there is no
  // room to send is two minutes of ChatGPT thrown away.
  while(!error&&!stopped()&&cursor<selected.length&&pending.size<width&&pending.size+ready.length<backlog&&pending.size+ready.length+inflight.size<remaining()){
   const value=selected[cursor++];let task;
   task=Promise.resolve().then(()=>prepare(value)).then(result=>{if(result)ready.push(result);},e=>{error ||= e;}).finally(()=>pending.delete(task));pending.add(task);
  }
 };
 /**
  * One attempt, with a time limit the queue - not the attempt - enforces.
  *
  * A form that never answers used to be the end of the day: the batch was
  * awaiting it and nothing else could start. Past the deadline the slot is
  * released and the reason recorded, and the attempt itself is left to run
  * out its own internal timeouts unobserved, because killing it from here
  * would abandon a half-filled form without recording that it was sent.
  */
 const send=value=>{
  let timer=null,watch=null,task;
  // Called straight away rather than off a microtask. The queue no longer
  // awaits this before looping, so whatever the attempt does synchronously
  // - above all setting the stop flag - has to be visible by the time the
  // loop decides whether to prepare another job, or stop costs one wasted
  // document every time.
  const work=(async()=>apply(value))();
  const started=Date.now();
  // A number, or a function of the job: an account-plus-wizard board needs
  // longer than a one-page form, and holding both to the wizard's limit
  // would make one stuck form cost twenty-five minutes of the day.
  const limit=typeof applyDeadlineMs==='function'?Number(applyDeadlineMs(value))||0:applyDeadlineMs;
  const racers=[work];
  if(limit>0)racers.push(new Promise(resolve=>{timer=setTimeout(()=>resolve(ABANDONED),limit);}));
  /**
   * Stop shortens the deadline; it does not remove it.
   *
   * The deadline above is the queue's patience with an attempt that is
   * going badly, and twelve to twenty-five minutes is the right amount of
   * it while the run is meant to be running. Once Stop has been pressed it
   * is the wrong amount of anything: the applicant was watching the bot
   * fill forms two minutes after asking it not to, which is how a button
   * that works reads as a button that does nothing. The attempt is still
   * not killed - nothing out here can tell a half-filled form from a sent
   * one, and guessing wrong costs an employer a duplicate - it is simply
   * no longer waited for, which is the same bargain the deadline already
   * makes and is recorded the same way.
   */
  if(stopGraceMs>0)racers.push(new Promise(resolve=>{watch=setInterval(()=>{if(stopped())resolve(ABANDONED);},stopGraceMs);}));
  const guarded=racers.length>1?Promise.race(racers):work;
  task=guarded.then(outcome=>{if(outcome===ABANDONED){work.catch(()=>{});onAbandoned(value,Date.now()-started);}},e=>{error ||= e;}).finally(()=>{clearTimeout(timer);clearInterval(watch);inflight.delete(task);});
  inflight.add(task);return task;
 };
 // Capacity counts what is already in the air: two attempts started against
 // one remaining submission would overshoot a target the applicant set.
 const canSend=()=>ready.length>0&&inflight.size<Math.min(sending,remaining());
 /**
  * The next finished document to send, which is not always the oldest.
  *
  * The caller may hold one back - a board applied to seconds ago, an
  * employer that has already had a role this hour - and the question it
  * answers is "which of these may go now", not "may this one go yet".
  * The difference is the whole point. Waiting on the job at the head of
  * the queue was done inside a worker, so six senders carrying six
  * Greenhouse jobs all sat out the same forty-five seconds together while
  * finished documents for other boards waited behind them.
  */
 const take=()=>{
  if(!ready.length)return null;
  const index=Number(pickReady(ready));
  if(!Number.isInteger(index)||index<0||index>=ready.length)return null;
  return ready.splice(index,1)[0];
 };
 /**
  * Nothing may be sent this instant, but something will be shortly.
  *
  * Short and bounded rather than waiting on the work: the work is a
  * two-minute application and the pacing clears in seconds, so sleeping
  * until an attempt finishes would give back the time this just saved.
  */
 const breathe=async()=>{
  const live=[...pending,...inflight];
  let timer=null;
  try{await Promise.race([...(live.length?[Promise.race(live)]:[]),new Promise(resolve=>{timer=setTimeout(resolve,Math.max(50,readyPauseMs));})]);}
  finally{clearTimeout(timer);}
 };
 /**
  * Wait for the next thing to finish, or for Stop, whichever comes first.
  *
  * Waiting on the work alone is waiting on the thing that is not
  * answering. A preparation still sitting on a request that has not
  * noticed the run's abort holds this race, the race holds the loop, and
  * the loop is what would have read `stopped()` - so the press lands on a
  * run that has stopped being able to look at it.
  */
 const settleOrStop=async tasks=>{
  if(!(stopGraceMs>0))return void await Promise.race(tasks);
  let watcher=null;
  try{await Promise.race([...tasks,new Promise(resolve=>{watcher=setInterval(()=>{if(stopped())resolve();},Math.min(stopGraceMs,500));})]);}
  finally{clearInterval(watcher);}
 };
 // Still work coming: either a window already chosen and not yet written,
 // something in flight, or a stage upstream that has not finished.
 const alive=()=>!frontDone||cursor<selected.length||pending.size||ready.length||inflight.size;
 try{
  while(!error&&!stopped()&&remaining()>0&&alive()){
   phase(pending.size?'processing':cursor<selected.length||frontDone?'generating':'screening');launch();
   if(!canSend()){
    if(pending.size||inflight.size)await settleOrStop([...pending,...inflight]);
    // Nothing of our own to wait on, and the stages upstream are still
    // working: waiting on them rather than spinning on an empty queue.
    else if(!frontDone&&cursor>=selected.length)await windowReady();
    else continue;
   }
   if(error||stopped()||remaining()<=0)break;
   if(!canSend())continue;
   const value=take();
   if(!value){
    // Every finished document is being held back by its board or its
    // employer. The writer carries on regardless, which is why this
    // waits rather than returning.
    phase(pending.size?'processing':'generating');await breathe();continue;
   }
   // Launched, not awaited. Sequencing is `canSend`'s job - it already
   // refuses a second send while one is in the air - and awaiting here
   // as well meant the loop could not reach `launch()` until the
   // application finished, so with sends held to one at a time the
   // writer could never get ahead at all. An application stuck on a
   // captcha stopped the writing too, which is the whole thing the
   // backlog exists to prevent.
   phase('applying');send(value);
  }
 }finally{
  const live=[...pending,...inflight];
  // An attempt settles within the grace above; a preparation settles as
  // soon as the run's abort signal reaches the request it is waiting on.
  // The wait is bounded all the same, because "the batch has stopped" has
  // to be a promise the caller can rely on and a preparation step that
  // one day forgets to pass the signal on must not be able to hold a
  // stopped run open until morning.
  if(stopped()&&stopGraceMs>0&&live.length)await Promise.race([Promise.all(live),new Promise(resolve=>setTimeout(resolve,stopGraceMs))]);
  else await Promise.all(live);
  // The reading and screening stages hold no browser tab and no slot, but
  // they do hold ChatGPT requests, and a caller told the batch is over
  // while one is still in flight would reconfigure the worker pool under
  // it. Bounded by `halt`, which every stage worker checks.
  await front;
 }
 if(error)throw error;
}
