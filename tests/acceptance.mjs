import assert from 'node:assert/strict';
import {runCapacity} from '../src/run-policy.js';
import {withDefaults} from '../src/profile.js';
import {stagedBatch} from '../src/pipeline.js';
import {startClock,elapsedClock} from '../src/timing.js';
import {newConfirmation} from '../src/submission-evidence.js';
import {answerAll} from '../src/ai.js';
import {setModelTransport} from '../src/vendor/generation.js';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
await test('A confirmed-submission target defaults off and accepts only a finite nonnegative integer',()=>{
 assert.equal(withDefaults().maxSubmittedPerRun,0);assert.equal(withDefaults({maxSubmittedPerRun:50}).maxSubmittedPerRun,50);assert.equal(withDefaults({maxSubmittedPerRun:Infinity}).maxSubmittedPerRun,0);assert.equal(withDefaults({maxSubmittedPerRun:-1}).maxSubmittedPerRun,0);
});
await test('Fifty confirmed sends are distinct from attempts, manual handoffs and uncertain submissions',()=>{
 const p={maxPerRun:0,maxSubmittedPerRun:50};assert.equal(runCapacity(p,{attempted:75,submitted:49}),1);assert.equal(runCapacity(p,{attempted:76,submitted:50}),0);assert.equal(runCapacity({...p,maxPerRun:5},{attempted:5,submitted:0}),0);
});
await test('The actual staged pipeline continues through failures and stops exactly at fifty confirmed outcomes',async()=>{
 const state={attempted:0,submitted:0},profile={maxPerRun:0,maxSubmittedPerRun:50};
 await stagedBatch(Array.from({length:60},(_,id)=>({id})),{extract:async x=>x,screen:async x=>x,choose:async x=>x,prepare:async x=>x,apply:async x=>{state.attempted++;if(x.id>=7)state.submitted++;},remaining:()=>runCapacity(profile,state),prepareConcurrency:2});
 assert.equal(state.submitted,50);assert.equal(state.attempted,57);
});
await test('A confirmation phrase already in a posting cannot become evidence of submission',()=>{
 const prior=['Thank you for applying: this is an example from the job description.'];assert.equal(newConfirmation(prior[0],prior),'');assert.equal(newConfirmation('Thank you for applying to Example. Your application has been received.',prior).startsWith('Thank you'),true);assert.equal(newConfirmation('Please complete all required fields.',prior),'');
});
await test('Elapsed timing uses a monotonic clock even if the wall clock changes',async()=>{
 const clock=startClock(),original=Date.now;try{Date.now=()=>clock.at+3600000;await new Promise(r=>setTimeout(r,20));const duration=elapsedClock(clock);assert.ok(duration>=10&&duration<5000);}finally{Date.now=original;}
});
await test('Required candidate questions cannot fall back to a decline, N/A, or the first option',async()=>{
 const question={key:'license',question:'Do you hold the requested professional license?',required:true,must:true,options:[{label:'Yes'},{label:'No'}]};
 for(const value of ['INSUFFICIENT','Unclear','N/A','Prefer not to say']){setModelTransport(async()=>({text:JSON.stringify({'1':value})}));const result=await answerAll([question],{},{});assert.equal(result.answers.length,0);assert.equal(result.unanswered[0].required,true);}
});
console.log(`${count} submission-target and timing checks passed.`);
