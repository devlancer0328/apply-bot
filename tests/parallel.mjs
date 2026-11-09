import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {ChatWorkerPool,parallelChatUrl} from '../src/chat-workers.js';
import {DiscoveryRounds} from '../src/run-policy.js';
import {stagedBatch} from '../src/pipeline.js';
import {deadline} from '../src/deadline.js';
import {withDefaults} from '../src/profile.js';
import {monitorBody} from '../src/ui/monitor.js';
import {snapshotWriter} from '../src/run-snapshot.js';
import {virtualFeed} from './jobright-fixture.mjs';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await test('Worker width is configurable, bounded at four, and standalone chats cannot be forked implicitly',()=>{
 // Four is the bound because each worker holds a ChatGPT tab per kind of
 // task; anything outside one-to-four is somebody's typo, not a request.
 // Four by default: the writing half of a ten-worker budget, the sending
 // half being the day plan's attemptConcurrency.
 assert.equal(withDefaults().chatGptConcurrency,4);assert.equal(withDefaults({chatGptConcurrency:1}).chatGptConcurrency,1);
 assert.equal(withDefaults({chatGptConcurrency:4}).chatGptConcurrency,4);assert.equal(withDefaults({chatGptConcurrency:90}).chatGptConcurrency,4);
 assert.equal(withDefaults({chatGptConcurrency:0}).chatGptConcurrency,1);assert.equal(new ChatWorkerPool(90).limit,4);
 assert.equal(parallelChatUrl('https://chatgpt.com/g/g-p-daniel/c/old-thread'),'https://chatgpt.com/g/g-p-daniel/project');
 assert.equal(parallelChatUrl('https://chatgpt.com/c/old-thread'),null);assert.equal(parallelChatUrl('https://chatgpt.com.evil.test/g/g-p-daniel/project'),null);
});
await test('Requests overlap at most twice and out-of-order replies retain their job identity',async()=>{
 const pool=new ChatWorkerPool(2);let active=0,peak=0;const ended=[];
 const results=await Promise.all([0,1,2,3].map(id=>pool.run(async slot=>{active++;peak=Math.max(peak,active);await wait(id===0?30:3);active--;ended.push(id);return {id,slot};})));
 assert.equal(peak,2);assert.ok(ended.indexOf(1)<ended.indexOf(0));assert.deepEqual(results.map(r=>r.id),[0,1,2,3]);assert.equal(pool.status().busy,0);
});
await test('Two transport failures drain active work before automatic sequential fallback',async()=>{
 const pool=new ChatWorkerPool(2);const events=[];let active=0;
 const output=await Promise.allSettled([0,1,2,3].map(id=>pool.run(async()=>{active++;events.push(['start',id,active]);await wait(id>=2?30:id===1?15:3);active--;events.push(['end',id,active]);if(id<2)throw Object.assign(new Error('Tab lost'),{workerFailure:true});return id;})));
 assert.equal(pool.status().effective,1);assert.match(pool.status().reason,/one request/);assert.equal(output[2].value,2);assert.equal(output[3].value,3);
 assert.equal(events.find(e=>e[0]==='start'&&e[1]===3)[2],1);assert.ok(events.findIndex(e=>e[0]==='start'&&e[1]===3)>events.findIndex(e=>e[0]==='end'&&e[1]===2));
});
await test('Account/authentication failures stop queued work instead of switching tabs to bypass a limit',async()=>{
 for(const status of [401,403,409,412,429]){
  const pool=new ChatWorkerPool(2);let calls=0;
  const results=await Promise.allSettled([0,1,2,3].map(id=>pool.run(async()=>{calls++;await wait(id===0?1:10);if(id===0)throw Object.assign(new Error('Account notice'),{status});return id;})));
  assert.equal(calls,2);assert.equal(results[2].reason.status,status);assert.equal(pool.status().busy,0);assert.equal(pool.status().queued,0);
 }
});
await test('Stopping a worker queue prevents pending requests and lets active operations settle',async()=>{
 const pool=new ChatWorkerPool(1),first=pool.run(async()=>{await wait(8);return 1;});
 const second=pool.run(()=>{throw new Error('Queued work started');});pool.stop();
 const results=await Promise.allSettled([first,second]);assert.equal(results[0].value,1);assert.equal(results[1].reason.status,499);assert.equal(pool.status().busy,0);
});
await test('Unrelated output errors do not trigger a concurrency fallback',async()=>{
 const pool=new ChatWorkerPool(2);await Promise.allSettled([1,2].map(()=>pool.run(()=>{throw new Error('Malformed output');})));
 assert.equal(pool.status().effective,2);assert.equal(pool.status().failures,0);
});
await test('Parallel preparation respects capacity and leaves a worker available while a form applies',async()=>{
 let active=0,peak=0,attempts=0;const writes=[],applied=[];
 await stagedBatch([1,2,3,4,5],{extract:async id=>({id}),screen:async j=>j,choose:async j=>j,prepareConcurrency:2,
  prepare:async j=>{active++;peak=Math.max(peak,active);await wait(2);active--;writes.push(j.id);return j.id===1?null:j;},
  apply:async j=>{assert.ok(active<=1);attempts++;applied.push(j.id);},remaining:()=>3-attempts});
 assert.equal(peak,2);assert.deepEqual(applied,[2,3,4]);assert.equal(writes.includes(5),false);
});
await test('Two research tasks overlap, retain input order, and finish before document generation',async()=>{
 let active=0,peak=0;const ended=[],prepared=[];
 await stagedBatch([1,2,3],{extract:async id=>({id}),screenConcurrency:2,screen:async job=>{active++;peak=Math.max(peak,active);await wait(job.id===1?20:2);active--;ended.push(job.id);return job.id===3?null:job;},choose:async jobs=>{assert.equal(active,0);assert.equal(ended.length,3);assert.deepEqual(jobs.map(j=>j.id),[1,2]);return jobs;},prepare:async job=>{assert.equal(active,0);prepared.push(job.id);return job;},apply:async()=>{},remaining:()=>10});
 assert.equal(peak,2);assert.equal(ended[0],2);assert.deepEqual(prepared,[1,2]);
});
await test('Stop drains both active researchers and prevents later research or generation',async()=>{
 let stopped=false,active=0,generated=0;const started=[];
 await stagedBatch([1,2,3],{extract:async id=>({id}),screenConcurrency:2,screen:async job=>{started.push(job.id);active++;await wait(job.id===1?2:8);stopped=true;active--;return job;},choose:async jobs=>jobs,prepare:async job=>{generated++;return job;},apply:async()=>{},remaining:()=>10,stopped:()=>stopped});
 assert.deepEqual(started,[1,2]);assert.equal(active,0);assert.equal(generated,0);
});
await test('A research account failure drains its peer and cannot start another task or application',async()=>{
 let active=0,prepared=0;const started=[];
 await assert.rejects(()=>stagedBatch([1,2,3],{extract:async id=>({id}),screenConcurrency:2,screen:async job=>{started.push(job.id);active++;try{await wait(job.id===1?2:8);if(job.id===1)throw Object.assign(new Error('Account limit'),{status:429});return job;}finally{active--;}},choose:async jobs=>jobs,prepare:async job=>{prepared++;return job;},apply:async()=>{},remaining:()=>10}),error=>error.status===429);
 assert.deepEqual(started,[1,2]);assert.equal(active,0);assert.equal(prepared,0);
});
await test('A feed with newly discovered but filtered/duplicate jobs does not finish the run',()=>{
 const rounds=new DiscoveryRounds(2);
 assert.equal(rounds.success('jobright',rounds.observe(['a','b'])),false);
 assert.equal(rounds.success('hiringcafe',rounds.observe(['c'])),false);
 assert.equal(rounds.success('jobright',rounds.observe(['a','b'])),false);
 assert.equal(rounds.success('hiringcafe',rounds.observe(['d'])),false);
 assert.equal(rounds.success('jobright',rounds.observe(['a'])),false);
 assert.equal(rounds.success('hiringcafe',rounds.observe(['c','d'])),true);
});
await test('Already-seen pages cannot exhaust a source until its pagination finishes, and every distinct source must be checked',()=>{
 const rounds=new DiscoveryRounds(2);rounds.observe(['already-loaded']);
 assert.equal(rounds.success('hiringcafe',rounds.observe(['already-loaded']),false),false);
 assert.equal(rounds.success('jobright',0),false);assert.equal(rounds.success('jobright',0),false);
 assert.equal(rounds.success('hiringcafe',rounds.observe(['later-new-job']),false),false);
 assert.equal(rounds.success('hiringcafe',0,true),false);assert.equal(rounds.success('jobright',0,true),false);
 assert.equal(rounds.success('hiringcafe',0,true),true);
});
await test('A bounded Jobright read continues below the first batch instead of restarting and repeatedly reading the same jobs',async()=>{
 const feed=virtualFeed({count:12});
 const first=await feed.collect(2),second=await feed.collect(2,true);
 assert.equal(first.more,true);assert.equal(second.more,true);assert.ok(second.scan.top>first.scan.top);assert.equal(second.scan.restarted,false);
 let last=second;for(let n=0;n<15&&last.more;n++)last=await feed.collect(3,true);
 assert.equal(last.complete,true);assert.equal(last.links.length,12);
});
await test('Discovery errors cannot masquerade as exhaustion and three failures require intervention',()=>{
 const rounds=new DiscoveryRounds(1);assert.equal(rounds.failure('jobright'),false);assert.equal(rounds.failure('jobright'),false);assert.equal(rounds.failure('jobright'),true);
 assert.equal(rounds.success('jobright',rounds.observe(['new'])),false);assert.equal(rounds.failure('jobright'),false);
});
await test('A hung browser message has a bounded deadline and normal completions are preserved',async()=>{
 await assert.rejects(()=>deadline(new Promise(()=>{}),5,'No browser response'),/No browser response/);assert.equal(await deadline(Promise.resolve(42),100,'timeout'),42);
});
await test('Monitor checkpoints coalesce rapid changes, clone their data and flush the final status immediately',async()=>{
 const writes=[],writer=snapshotWriter(async value=>writes.push(value),{delay:8});const value={attempts:1};writer.schedule(value);value.attempts=99;await wait(15);assert.deepEqual(writes,[{attempts:1}]);
 writer.schedule({attempts:2});writer.schedule({attempts:3});await writer.flush();assert.deepEqual(writes,[{attempts:1},{attempts:3}]);await wait(12);assert.equal(writes.length,2);
});
await test('Monitor checkpoint failures do not break later writes, and overlapping flushes remain serialized',async()=>{
 let active=0,peak=0,errors=0;const writes=[],writer=snapshotWriter(async v=>{active++;peak=Math.max(peak,active);await wait(4);active--;if(v===1)throw new Error('Disk unavailable');writes.push(v);},{delay:1000,onError:()=>errors++});
 writer.schedule(1);const first=writer.flush();writer.schedule(2);const second=writer.flush();await Promise.all([first,second]);assert.equal(errors,1);assert.equal(peak,1);assert.deepEqual(writes,[2]);
});
const source=await readFile(new URL('../src/chatgpt.js',import.meta.url),'utf8');
const functionSource=source.slice(source.indexOf('async function converse(prompt, options)'),source.indexOf('/* --------------------------------------------------------------- bridge */'));
function chatFixture({alert='',path='/c/assigned',deferred=false}={}){
 const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
 Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});
 const location={pathname:path,href:'https://chatgpt.com'+path};
 dom.document.querySelector('button').onclick=()=>{
  const user=dom.document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=dom.document.querySelector('textarea').value;dom.document.body.append(user);
  const turn=dom.document.createElement('div');turn.dataset.messageAuthorRole='assistant';turn.textContent='{"summary":"Prepared for the assigned job"}';dom.document.body.append(turn);
  if(alert){const notice=dom.document.createElement('div');notice.setAttribute('role','alert');notice.textContent=alert;dom.document.body.append(notice);}
 };
 const converse=vm.runInNewContext(`(${functionSource})`,{document:dom.document,window:dom.window,location,setTimeout:cb=>queueMicrotask(cb),HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL});
 return {document:dom.document,window:dom.window,location,send:prompt=>converse(prompt,{timeoutMs:1000,settleMs:0,detached:deferred,taskId:'assigned-task'})};
}
await test('Rate limiting in a job description is never mistaken for a ChatGPT account cap',async()=>{
 const fixture=chatFixture();const reply=await fixture.send('Design AI services using caching, queuing, rate limiting, failover, and cost optimization.');assert.equal(reply.ok,true);
});
await test('Actual platform usage-limit notices still stop the request',async()=>{
 const fixture=chatFixture({alert:"You've reached your limit. Please try again later."});assert.equal((await fixture.send('Engineer role')).reason,'rate-limited');
});
await test('A usage cap on the project landing page is detected before a server conversation ID exists',async()=>{
 const fixture=chatFixture({alert:"You've reached your limit. Please try again later.",deferred:true,path:'/g/g-p-daniel/project'});
 assert.equal((await fixture.send('Assigned job')).started,true);assert.equal((await fixture.window.__applyBotChatTask.check(false)).reason,'rate-limited');
});
await test('Detached sending returns before polling and refuses a different conversation',async()=>{
 const fixture=chatFixture({deferred:true});assert.equal((await fixture.send('The assigned job')).started,true);
 assert.equal((await fixture.window.__applyBotChatTask.check(false)).pending,true);assert.equal((await fixture.window.__applyBotChatTask.check(false)).ok,true);
 fixture.location.pathname='/c/another';fixture.location.href='https://chatgpt.com/c/another';assert.equal((await fixture.window.__applyBotChatTask.check(false)).reason,'conversation-changed');
});
await test('Binding a fresh project conversation requires its assigned prompt, not another chat response',async()=>{
 const fixture=chatFixture({deferred:true,path:'/g/g-p-daniel/project'});await fixture.send('Assigned job description');
 fixture.document.querySelector('[data-message-author-role=user]').textContent='A different job description';fixture.location.pathname='/g/g-p-daniel/c/other';fixture.location.href='https://chatgpt.com'+fixture.location.pathname;
 assert.equal((await fixture.window.__applyBotChatTask.check(false)).pending,true);fixture.window.__applyBotChatTask.bindingStarted=Date.now()-11000;
 assert.equal((await fixture.window.__applyBotChatTask.check(false)).reason,'conversation-changed');
});
await test('New user bubbles expand to verify the complete JD and project slug changes retain the same conversation',async()=>{
 const fixture=chatFixture({deferred:true,path:'/g/g-p-daniel/project'}),prompt='The assigned full job description with a long final requirement';await fixture.send(prompt);
 const user=fixture.document.querySelector('[data-message-author-role=user]');user.removeAttribute('data-message-author-role');user.setAttribute('data-user-message-bubble','true');user.textContent=prompt.slice(0,20);
 const more=fixture.document.createElement('button');more.textContent='Show more';more.onclick=()=>{const replacement=fixture.document.createElement('div');replacement.setAttribute('data-user-message-bubble','true');replacement.textContent=prompt;user.replaceWith(replacement);};user.append(more);
 fixture.location.pathname='/g/g-p-daniel/c/assigned';fixture.location.href='https://chatgpt.com'+fixture.location.pathname;
 assert.equal((await fixture.window.__applyBotChatTask.check(false)).needsForeground,true);
 assert.equal((await fixture.window.__applyBotChatTask.check(true)).pending,true);
 fixture.location.pathname='/g/g-p-daniel-friendly-name/c/assigned';fixture.location.href='https://chatgpt.com'+fixture.location.pathname;
 const finished=await fixture.window.__applyBotChatTask.check(false);assert.equal(finished.ok,true);assert.ok(finished.text);
});
await test('Optimistic local ChatGPT IDs can become server IDs only after the assigned JD is verified',async()=>{
 const fixture=chatFixture({deferred:true,path:'/g/g-p-daniel/project'}),button=fixture.document.querySelector('button'),original=button.onclick;
 const move=path=>{fixture.location.pathname=path;fixture.location.href='https://chatgpt.com'+path;};
 button.onclick=()=>{original();move('/g/g-p-daniel/c/local-chatgpt%3Aoptimistic');};
 await fixture.send('Assigned role description');assert.equal((await fixture.window.__applyBotChatTask.check(false)).pending,true);
 move('/g/g-p-daniel-friendly/c/server-assigned');assert.equal((await fixture.window.__applyBotChatTask.check(false)).pending,true);
 const finished=await fixture.window.__applyBotChatTask.check(false);assert.equal(finished.ok,true);assert.ok(finished.text);
 move('/c/another-server-id');assert.equal((await fixture.window.__applyBotChatTask.check(false)).reason,'conversation-changed');
});
await test('Posted prompt verification tolerates decoded entities and relocated JSON link brackets without changing the sent prompt',async()=>{
 const fixture=chatFixture({deferred:true,path:'/g/g-p-daniel/project'}),prompt='Company: Example. Salary $200,000&mdash;$265,000. Evidence: {"sources":[{"url":"https://example.test/pay","company":"Example"}]}';
 await fixture.send(prompt);const user=fixture.document.querySelector('[data-message-author-role=user]');assert.equal(user.textContent,prompt);
 user.textContent=prompt.replace('&mdash;','—').replace('[{"url":"https','{"url":"[https');fixture.location.pathname='/c/assigned';fixture.location.href='https://chatgpt.com/c/assigned';
 assert.equal((await fixture.window.__applyBotChatTask.check(false)).pending,true);const finished=await fixture.window.__applyBotChatTask.check(false);assert.equal(finished.ok,true);assert.ok(finished.text);
});
await test('Run monitor exposes stop reasons, worker progress, errors and safely escaped log details',()=>{
 const html=monitorBody({running:false,stopReason:{code:'error',message:'Run stopped: account limit'},lastError:{message:'<script>bad</script>',at:Date.now()},aiWorkers:{effective:2,busy:1,tasks:[{label:'Example Company',stage:'Waiting for response',startedAt:Date.now(),characters:120}]},log:[{at:Date.now(),level:'error',message:'Failure details'}]});
 assert.match(html,/account limit/);assert.match(html,/Example Company/);assert.match(html,/120 response characters/);assert.match(html,/Failure details/);assert.equal(html.includes('<script>bad'),false);
});
console.log(`${count} parallelism, monitoring and run-continuation checks passed.`);
