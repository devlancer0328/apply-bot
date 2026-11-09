import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {stagedBatch} from '../src/pipeline.js';
import {ChatWorkerPool} from '../src/chat-workers.js';
import {applicationNeeds,extractionResting,applicationPriority,protectsCompany} from '../src/application-needs.js';
import {screenJob} from '../src/screening.js';
import {stage} from '../src/stages.js';
import {answerAll} from '../src/ai.js';
import {setModelTransport} from '../src/vendor/generation.js';
import {resolveField} from '../src/answers.js';
import {boardStarted,boardWaitMs,dayProgress,emptyLedger,nextRun,recordDiscovered,recordOutcome,rollDay,withScheduleDefaults} from '../src/schedule.js';
import {createSlots} from '../src/slots.js';
let count=0;const test=async(name,work)=>{await work();console.log('PASS '+name);count++;};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await test('Answer logs disambiguate repeated on values using the selected label instead of the first radio option',async()=>{
 const bg=await readFile(new URL('../src/background.js',import.meta.url),'utf8'),start=bg.indexOf('function spoken('),code=bg.slice(start,bg.indexOf('\n}',start)+2),spoken=vm.runInNewContext('('+code+')');
 const field={options:[{label:'American Indian or Alaska Native',value:'on'},{label:'Asian',value:'on'}]};
 assert.equal(spoken(field,{value:'on',candidates:['Asian']}),'Asian');
 assert.equal(spoken({options:[{label:'Wrong'},{label:'Asian'}]},{candidates:['Asian']}),'Asian');
});
await test('Workday country annotations and combined race/ethnicity use both saved facts without changing identity',()=>{
 const field={label:'Please select the race/ethnicity which most accurately describes how you identify yourself.',type:'select',required:true,options:[{label:'White (Not Hispanic or Latino) (United States of America)',value:'white'},{label:'Asian (Not Hispanic or Latino) (United States of America)',value:'asian'}]};
 const result=resolveField(field,{race:'East Asian',hispanic:'no'},{});assert.equal(result.outcome,'fill');assert.equal(result.value,'asian');
 const labelled={...field,options:field.options.map(({label})=>({label}))},answer=resolveField(labelled,{race:'East Asian',hispanic:'no'},{});assert.equal(answer.value,'Asian (Not Hispanic or Latino) (United States of America)');
 assert.equal(resolveField(field,{race:'East Asian',hispanic:'yes'},{}).outcome,'blocked');
 assert.equal(resolveField(field,{race:'East Asian',hispanic:'decline'},{}).outcome,'blocked');
 const narrow={...field,options:[{label:'East Asian (United States of America)',value:'east'}]};assert.equal(resolveField(narrow,{race:'Asian',hispanic:'no'},{}).outcome,'blocked');
});
await test('Explicit INSUFFICIENT answers stop after one call; malformed batches never fan out into per-field requests',async()=>{
 const question={key:'license',question:'Do you hold the required professional license?',required:true,options:[{label:'Yes'},{label:'No'}]};let calls=0;
 setModelTransport(async()=>{calls++;return {text:'{"1":"INSUFFICIENT"}'};});
 const insufficient=await answerAll([question],{},{});assert.equal(calls,1);assert.equal(insufficient.answers.length,0);assert.equal(insufficient.unanswered[0].required,true);
 calls=0;setModelTransport(async()=>{calls++;return {text:'Unreadable response'};});
 const malformed=await answerAll(Array.from({length:8},(_,i)=>({...question,key:'q'+i})),{},{});assert.equal(calls,2);assert.equal(malformed.answers.length,0);assert.equal(malformed.unanswered.length,8);
});
await test('Only proven pre-submit manual failures are retryable; legacy, uncertain and submitted outcomes stay protected',()=>{
 assert.equal(protectsCompany({status:'manual'}),true);
 assert.equal(protectsCompany({status:'manual',detail:{submissionAttempted:true}}),true);
 assert.equal(protectsCompany({status:'manual',detail:{submissionAttempted:false}}),false);
 assert.equal(protectsCompany({status:'submitted',detail:{submissionAttempted:false}}),true);
 assert.equal(protectsCompany({status:'unconfirmed',detail:{submissionAttempted:false}}),true);
});
await test('Ready documents and short supported forms are prioritized ahead of account-based wizards',()=>{
 const fast={link:'https://jobs.ashbyhq.com/example/111'},wizard={link:'https://example.wd1.myworkdayjobs.com/External/job/Remote/Engineer_R123'};
 assert.ok(applicationPriority(fast)>applicationPriority(wizard));
 assert.ok(applicationPriority(wizard,{stage:'documents-ready'})>applicationPriority(fast));
});
await test('A ready second job submits while the first High request is still pending; preparation is bounded',async()=>{
 const slow=deferred(),prepared=[],applied=[];let active=0,peak=0;
 await stagedBatch([1,2,3,4],{extract:async id=>({id}),screen:async x=>x,choose:async x=>x,prepareConcurrency:2,
  prepare:async x=>{prepared.push(x.id);active++;peak=Math.max(peak,active);if(x.id===1)await slow.promise;active--;return x;},
  apply:async x=>{if(!applied.length){assert.equal(x.id,2);assert.equal(active,1);assert.deepEqual(prepared,[1,2]);slow.resolve();}applied.push(x.id);},remaining:()=>4-applied.length});
 assert.equal(peak,2);assert.equal(applied.length,4);assert.equal(new Set(applied).size,4);
});
await test('A one-submission capacity does not speculatively generate or submit a second job',async()=>{
 const prepared=[],applied=[];
 await stagedBatch([1,2,3],{extract:async x=>x,screen:async x=>x,choose:async x=>x,prepareConcurrency:2,prepare:async x=>{prepared.push(x);return x;},apply:async x=>applied.push(x),remaining:()=>1-applied.length});
 assert.deepEqual(prepared,[1]);assert.deepEqual(applied,[1]);
});
await test('Stop drains the other preparation and prevents any late submission or new preparation',async()=>{
 const slow=deferred(),prepared=[],applied=[];let stopped=false,finished=false;
 await stagedBatch([1,2,3],{extract:async x=>x,screen:async x=>x,choose:async x=>x,prepareConcurrency:2,prepare:async x=>{prepared.push(x);if(x===1){await slow.promise;finished=true;}return x;},apply:async x=>{applied.push(x);stopped=true;slow.resolve();},remaining:()=>10,stopped:()=>stopped});
 assert.equal(finished,true);assert.deepEqual(prepared,[1,2]);assert.deepEqual(applied,[2]);
});
await test('A fatal preparation error drains its peer, propagates, and never sends the peer form',async()=>{
 const slow=deferred();let drained=false,applied=0;
 await assert.rejects(()=>stagedBatch([1,2,3],{extract:async x=>x,screen:async x=>x,choose:async x=>x,prepareConcurrency:2,prepare:async x=>{if(x===1){queueMicrotask(slow.resolve);throw Object.assign(new Error('Account limit'),{status:429});}await slow.promise;drained=true;return x;},apply:async()=>applied++,remaining:()=>10}),/Account limit/);
 assert.equal(drained,true);assert.equal(applied,0);
});
await test('Real form needs distinguish optional letters, required prose/uploads, salary history and pay questions',()=>{
 assert.deepEqual(applicationNeeds([{type:'file',label:'Resume',required:true}]),{letter:false,compensation:false});
 const letter={type:'file',label:'Cover letter',required:false};
 assert.equal(applicationNeeds([letter]).letter,false);assert.equal(applicationNeeds([letter],{generateOptionalLetters:true}).letter,true);
 assert.equal(applicationNeeds([{...letter,required:true}]).letter,true);assert.equal(applicationNeeds([{type:'textarea',label:'Cover letter',required:true}]).letter,true);
 assert.equal(applicationNeeds([{type:'text',label:'Current salary history',required:true}]).compensation,false);
 assert.equal(applicationNeeds([{type:'number',label:'Expected base salary',required:true}]).compensation,true);
});
await test('Unreadable originals rest for thirty minutes, but explicit Recheck bypasses the cooldown',()=>{
 const now=Date.now(),job={stage:'review',reason:'Original posting needs review: No complete description.',updatedAt:now};
 assert.equal(extractionResting(job,now+1000),true);assert.equal(extractionResting(job,now+1800001),false);
 assert.equal(extractionResting({...job,stage:'discovered',extractionRetryAt:now+1800000},now),false);
 assert.equal(extractionResting({stage:'held',reason:'Held by you.',updatedAt:now},now),false);
});
await test('Four healthy requests recover two-worker capacity; user-selected single mode never grows',async()=>{
 const pool=new ChatWorkerPool(2);
 for(let i=0;i<2;i++)await assert.rejects(pool.run(()=>{throw Object.assign(new Error('Renderer failure'),{workerFailure:true});}));
 assert.equal(pool.limit,1);
 for(let i=0;i<3;i++)await pool.run(async()=>true);assert.equal(pool.limit,1);
 await pool.run(async()=>true);assert.equal(pool.limit,2);assert.equal(pool.reason,'');assert.equal(pool.failures,2);
 const single=new ChatWorkerPool(1);for(let i=0;i<6;i++)await single.run(async()=>true);assert.equal(single.limit,1);
});
await test('Research failures honor Allow unknown without inventing evidence, while account caps still stop',async()=>{
 const job={company:'Example',title:'Engineer',jd:'Develop tested production applications. '.repeat(15),applyUrl:'https://example.test/jobs/1'};
 const profile={screeningEnabled:true,screeningTravel:'none',screeningUnknown:'allow'};
 const result=await screenJob(job,profile,{ask:async()=>{throw new Error('Browser reply unavailable');}});
 assert.equal(result.decision,'eligible');assert.deepEqual(result.findings,{});assert.equal(result.mode,'research-unavailable');
 assert.equal((await screenJob(job,{...profile,screeningUnknown:'strict'},{ask:async()=>{throw new Error('Browser reply unavailable');}})).decision,'review');
 await assert.rejects(()=>screenJob(job,profile,{ask:async()=>{throw Object.assign(new Error('Account cap'),{status:429});}}),error=>error.status===429);
});
const writer=await readFile(new URL('../src/writer.js',import.meta.url),'utf8');
// The role-family reuse writeApplication consults comes along with it,
// unmodified, so this measures the real decision about when ChatGPT is
// asked for a resume rather than a restatement of it.
const writeCode=(writer.slice(writer.indexOf('/* ------------------------------------------------- reuse by role family */'),writer.indexOf('export function resumeToText'))+writer.slice(writer.indexOf('export async function writeApplication'))).replace(/^export /gm,'');
const supportCode=writer.slice(writer.indexOf('export async function completeApplicationSupport'),writer.indexOf('export async function writeApplication')).replace(/^export /,'');
const pdf=new Uint8Array([37,80,68,70]),saved=new Map(),candidate={name:'Actual Candidate'},doc={sections:[{heading:'Summary',paragraphs:['Actual experience.']}]};
let resumeCalls=0,letterCalls=0,researchCalls=0;
const globals={Blob,Uint8Array,crypto,Date,stage,MODEL:'ChatGPT',ProviderError:class extends Error{},WriterError:class extends Error{},candidateFrom:()=>candidate,normalizeTemplate:()=>({theme:{}}),documentText:()=>'',resumeToText:()=>'',record:()=>0,saveResume:async r=>saved.set(r.id,r),writeResume:async()=>{resumeCalls++;return {resume:{name:candidate.name},document:doc,pdf,settings:{theme:{}},aiMode:{selected:'high'}};},generateCoverLetter:async()=>{letterCalls++;return {text:'Dear hiring team, supported candidate experience.',usage:{}};},buildCoverLetterPdf:async()=>pdf,researchCompensation:async()=>{researchCalls++;return {status:'researched',researchedAt:Date.now()};}};
vm.createContext(globals);
const write=vm.runInContext(writeCode+';writeApplication',globals),support=vm.runInContext('('+supportCode+')',globals);
await test('Resume-first preparation saves the High PDF and makes no letter or salary AI call',async()=>{
 const result=await write({},{jd:'Actual employer description',title:'Engineer',company:'Example',deferSupporting:true},undefined,{});
 assert.equal(resumeCalls,1);assert.equal(letterCalls,0);assert.equal(researchCalls,0);assert.equal(result.letterBlob,null);assert.equal(result.letterName,'');assert.equal(result.compensation.status,'not-requested');assert.ok(saved.get(result.libraryId).pdf instanceof Blob);
});
await test('A required cover letter and pay question generate support once, without regenerating High',async()=>{
 const app={jd:'Actual employer description',title:'Engineer',company:'Example',resumeData:{name:candidate.name},compensation:{status:'not-requested'}};
 await support({},app,{letter:true,compensation:true},{});await support({},app,{letter:true,compensation:true},{});
 assert.equal(resumeCalls,1);assert.equal(letterCalls,1);assert.equal(researchCalls,1);assert.ok(app.letter instanceof Blob);assert.ok(app.letterName.endsWith('.pdf'));assert.equal(app.compensation.status,'researched');
});
/* --------------------------------------------- a day rather than a run */

await test('Submissions stay sequential by default, and widen only when the caller asks',async()=>{
 const order=[];let active=0,peak=0;
 const run=width=>stagedBatch([1,2,3],{extract:async id=>({id}),screen:async j=>j,choose:async j=>j,prepare:async j=>j,applyConcurrency:width,
  apply:async j=>{active++;peak=Math.max(peak,active);await wait(4);order.push(j.id);active--;},remaining:()=>10});
 await run(1);assert.equal(peak,1);assert.deepEqual(order,[1,2,3]);
 peak=0;order.length=0;await run(2);assert.equal(peak,2);assert.equal(order.length,3);
});
await test('A stuck application is abandoned on its deadline and the queue sends the rest without it',async()=>{
 const stuck=deferred(),applied=[],abandoned=[];let active=0,peak=0;
 await stagedBatch([1,2,3],{extract:async id=>({id}),screen:async j=>j,choose:async j=>j,prepare:async j=>j,applyConcurrency:2,applyDeadlineMs:25,onAbandoned:value=>abandoned.push(value.id),
  apply:async j=>{active++;peak=Math.max(peak,active);try{if(j.id===1)await stuck.promise;applied.push(j.id);}finally{active--;}},remaining:()=>10});
 assert.deepEqual(abandoned,[1]);assert.deepEqual(applied,[2,3]);assert.equal(peak,2);
 stuck.resolve();
});
await test('A per-job deadline can differ by board, so one wedged short form does not cost a wizard\u2019s worth of the day',async()=>{
 const slow=deferred(),abandoned=[];
 await stagedBatch([{id:1,board:'greenhouse'},{id:2,board:'workday'}],{extract:async job=>job,screen:async j=>j,choose:async j=>j,prepare:async j=>j,applyConcurrency:2,
  applyDeadlineMs:job=>job.board==='workday'?400:20,onAbandoned:value=>abandoned.push(value.id),
  apply:async job=>{if(job.board==='greenhouse')await slow.promise;await wait(40);},remaining:()=>10});
 assert.deepEqual(abandoned,[1]);
 slow.resolve();
});
await test('Two attempts cannot overshoot the last remaining submission of the day',async()=>{
 const settings=withScheduleDefaults({dailyTarget:5});let ledger=emptyLedger(0),applied=[];
 for(let i=0;i<4;i++)ledger=recordOutcome(ledger,{status:'submitted'},1000+i);
 await stagedBatch([1,2,3],{extract:async id=>({id}),screen:async j=>j,choose:async j=>j,prepare:async j=>j,applyConcurrency:2,
  apply:async j=>{applied.push(j.id);ledger=recordOutcome(ledger,{status:'submitted'},2000);},
  remaining:()=>Math.max(0,settings.dailyTarget-ledger.submitted)});
 assert.deepEqual(applied,[1]);
 const progress=dayProgress(ledger,settings,3000);assert.equal(progress.met,true);assert.equal(progress.remaining,0);
});
await test('A day survives the service worker being killed: the quota is read back rather than restarted',()=>{
 const noon=new Date(2026,10,7,12,0,0).getTime(),settings=withScheduleDefaults({dailyTarget:300,autopilot:true});
 let ledger=emptyLedger(noon);
 for(let i=0;i<120;i++)ledger=recordOutcome(ledger,{status:'submitted'},noon+i*1000);
 ledger=recordOutcome(ledger,{status:'failed',reason:'no security code mail for Acme arrived within 240 seconds',company:'Acme'},noon+200000);
 ledger=boardStarted(ledger,'greenhouse',settings,noon+200000,()=>0.5);
 // What SQLite holds, and what a brand new worker reads back out of it.
 const resumed=rollDay(JSON.parse(JSON.stringify(ledger)),noon+3600000);
 assert.equal(resumed.submitted,120);assert.equal(resumed.failed,1);
 assert.equal(dayProgress(resumed,settings,noon+3600000).remaining,180);
 assert.equal(boardWaitMs(resumed,'greenhouse',settings,noon+200000),settings.boardGapMs);
 // Chrome killed that run; it did not choose to stop, so the next one starts.
 assert.equal(nextRun({ledger:resumed,settings,stopReason:{code:'interrupted'},now:noon+3600000}).start,true);
 // And tomorrow is a fresh quota, not a hundred and eighty-application debt.
 assert.equal(rollDay(JSON.parse(JSON.stringify(ledger)),noon+86400000).submitted,0);
});
await test('Autopilot restarts after ordinary endings, backs off after errors, and never overrides Stop',()=>{
 const settings=withScheduleDefaults({autopilot:true,dailyTarget:300,failureRetryMs:60000}),ledger=emptyLedger(Date.now());
 assert.equal(nextRun({ledger,settings,stopReason:{code:'user'}}).start,false);
 assert.equal(nextRun({ledger,settings,stopReason:{code:'setup',message:'the profile is incomplete'}}).start,false);
 assert.equal(nextRun({ledger,settings,stopReason:{code:'complete'}}).delayMs,settings.idleRetryMs);
 assert.equal(nextRun({ledger,settings,stopReason:{code:'exhausted'}}).delayMs,settings.exhaustedRetryMs);
 assert.equal(nextRun({ledger,settings,stopReason:{code:'error'},failures:1}).delayMs,60000);
 assert.equal(nextRun({ledger,settings,stopReason:{code:'error'},failures:3}).delayMs,240000);
 assert.equal(nextRun({ledger,settings,stopReason:{code:'error'},failures:9}).delayMs,360000);
 assert.equal(nextRun({ledger,settings:{...settings,autopilot:false},stopReason:{code:'complete'}}).start,false);
 // A run the watchdog wound down is not a run the applicant stopped.
 assert.equal(nextRun({ledger,settings,stopReason:{code:'stalled'}}).start,true);
 let met=emptyLedger(Date.now());for(let i=0;i<300;i++)met=recordOutcome(met,{status:'submitted'});
 assert.equal(nextRun({ledger:met,settings,stopReason:{code:'target'}}).start,false);
});
await test('One board is paced without holding up the others, and the gap is jittered',()=>{
 const settings=withScheduleDefaults({boardGapMs:60000}),now=1000;
 let ledger=emptyLedger(now);
 assert.equal(boardWaitMs(ledger,'greenhouse',settings,now),0);
 ledger=boardStarted(ledger,'greenhouse',settings,now,()=>0.5);
 assert.equal(boardWaitMs(ledger,'greenhouse',settings,now),60000);
 assert.equal(boardWaitMs(ledger,'lever',settings,now),0);
 assert.equal(boardWaitMs(ledger,'greenhouse',settings,now+60001),0);
 const soonest=boardStarted(emptyLedger(now),'greenhouse',settings,now,()=>0).boards.greenhouse.nextAt;
 const latest=boardStarted(emptyLedger(now),'greenhouse',settings,now,()=>1).boards.greenhouse.nextAt;
 assert.equal(latest-soonest,24000);
});
await test('A night of the same timeout reads as one counted row, not three hundred',()=>{
 let ledger=emptyLedger(0);
 for(const company of ['Acme','Beta Industries','Gamma'])ledger=recordOutcome(ledger,{status:'failed',company,reason:`no security code mail for ${company} arrived within 240 seconds; saved for you to send by hand`},1000);
 ledger=recordOutcome(ledger,{status:'abandoned',reason:'attempt abandoned after its deadline'},2000);
 const {reasons,failed,abandoned}=dayProgress(ledger,withScheduleDefaults(),3000);
 assert.equal(failed,3);assert.equal(abandoned,1);
 assert.equal(reasons[0].count,3);assert.match(reasons[0].reason,/no security code mail for arrived within n seconds/);
});
await test('A day that applied to everything it found names job supply as the ceiling, not speed',()=>{
 const settings=withScheduleDefaults({dailyTarget:300});let ledger=recordDiscovered(emptyLedger(0),40,1000);
 for(let i=0;i<40;i++)ledger=recordOutcome(ledger,{status:'submitted'},1000+i);
 assert.equal(dayProgress(ledger,settings,2000).supplyLimited,true);
 assert.equal(dayProgress(recordDiscovered(ledger,2000,2000),settings,3000).supplyLimited,false);
});
await test('An attempt waiting on mail hands its slot over and queues to get it back',async()=>{
 const slots=createSlots({limit:1}),order=[],mail=deferred(),peerWork=deferred();
 const first=slots.hold({company:'Acme',board:'greenhouse'},async attempt=>{
  attempt.note('Filling the form');order.push('first-form');
  await attempt.waiting('an emailed security code',()=>mail.promise);
  order.push('first-code');
 });
 await wait(2);
 const peer=slots.hold({company:'Beta'},async()=>{order.push('second-form');await peerWork.promise;order.push('second-done');});
 await wait(2);
 assert.deepEqual(order,['first-form','second-form']);
 const parked=slots.status();assert.equal(parked.busy,1);assert.equal(parked.parked,1);
 assert.match(parked.holders.find(holder=>holder.company==='Acme').waitingFor,/security code/);
 // The code arrived, but the front belongs to the peer until it finishes.
 mail.resolve();await wait(2);assert.deepEqual(order,['first-form','second-form']);
 peerWork.resolve();await Promise.all([first,peer]);
 assert.deepEqual(order,['first-form','second-form','second-done','first-code']);
 assert.equal(slots.status().busy,0);
});
await test('A slot reclaimed at its deadline stops counting, so one abandoned attempt cannot wedge the pool',async()=>{
 const slots=createSlots({limit:1}),stuck=deferred(),started=[];
 const first=slots.hold({company:'Acme'},async()=>{started.push('acme');await stuck.promise;},{deadlineMs:10});
 await wait(2);
 const next=slots.hold({company:'Beta'},async()=>{started.push('beta');});
 await wait(40);
 assert.deepEqual(started,['acme','beta']);
 assert.equal(slots.status().holders.find(holder=>holder.company==='Acme').abandoned,true);
 stuck.resolve();await Promise.all([first,next]);
 assert.equal(slots.status().busy,0);
});
await test('The day plan refuses nonsense without falling back to no limits at all',()=>{
 const value=withScheduleDefaults({dailyTarget:'many',attemptConcurrency:40,boardGapMs:-5,attemptDeadlineMs:1,autopilot:'yes'});
 assert.equal(value.dailyTarget,300);assert.equal(value.attemptConcurrency,6);assert.equal(value.boardGapMs,0);
 assert.equal(value.attemptDeadlineMs,60000);assert.equal(value.autopilot,false);
 assert.equal(withScheduleDefaults({autopilot:true}).autopilot,true);
});
console.log(`${count} throughput and demand-driven document checks passed.`);
