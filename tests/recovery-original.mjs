import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {withChatRecovery} from '../src/chat-recovery.js';
import {isDiscoveryUrl,originalSource,verifiedOriginal,readOriginalPosting} from '../src/original-posting.js';
import {screenJob,screeningSignature,documentSignature,originalFindings} from '../src/screening.js';
let count=0;
const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
const failure=(message='Account changed')=>Object.assign(new Error(message),{status:401,chatRecovery:true});
await test('Recovery refreshes the assigned operation and succeeds without restarting the workflow',async()=>{
 let calls=0,reloads=0;const progress=[];
 assert.equal(await withChatRecovery(async()=>{if(++calls<3)throw failure();return 'assigned reply';},{refresh:async()=>{reloads++;},progress:v=>progress.push(v.retry),wait:async()=>{}}),'assigned reply');
 assert.equal(calls,3);assert.equal(reloads,2);assert.deepEqual(progress,[1,2]);
});
await test('Persistent failure permits exactly three refreshes and prevents outer retry multiplication',async()=>{
 let calls=0,reloads=0;
 await assert.rejects(()=>withChatRecovery(async()=>{calls++;throw failure();},{refresh:async()=>{reloads++;},wait:async()=>{}}),error=>error.status===401&&error.retryable===false&&/3 refresh retries/.test(error.message));
 assert.equal(calls,4);assert.equal(reloads,3);
});
await test('Reload failures share the same budget, and cancellation prevents another refresh or send',async()=>{
 let calls=0,reloads=0;
 await assert.rejects(()=>withChatRecovery(async()=>{calls++;throw failure();},{refresh:async()=>{reloads++;throw new Error('Browser disconnected');},wait:async()=>{}}),/3 refresh retries/);
 assert.equal(calls,4);assert.equal(reloads,3);
 const controller=new AbortController();calls=0;reloads=0;
 await assert.rejects(()=>withChatRecovery(async()=>{calls++;throw failure();},{signal:controller.signal,refresh:async()=>{reloads++;},wait:async()=>controller.abort()}),error=>error.status===499);
 assert.equal(calls,1);assert.equal(reloads,0);
});
await test('Changed conversations and content/setup errors are not resent as infrastructure failures',async()=>{
 let reloads=0;const error=Object.assign(failure('Different conversation'),{retryable:false});
 await assert.rejects(()=>withChatRecovery(async()=>{throw error;},{refresh:async()=>reloads++,wait:async()=>{}}),/Different conversation/);
 assert.equal(reloads,0);
});
const url='https://job-boards.greenhouse.io/example/jobs/123';
const jd='This position is fully remote. No travel is required for this position. No security clearance is required for this role. All interviews are conducted virtually for this position. '+('Build reliable software with testing and documentation. '.repeat(5));
const api={ids:value=>value===url?{id:'123'}:null,posting:async()=>({jd,title:'Engineer',company:'Example',applyUrl:url})};
await test('Official posting data is authoritative even when aggregator text would be longer',async()=>{
 let pageReads=0;
 const posting=await readOriginalPosting(url,{api,readPage:async()=>{pageReads++;throw new Error('Should not load');}});
 assert.equal(posting.jd,jd);assert.equal(pageReads,0);assert.equal(posting.descriptionSource.method,'official-api');assert.equal(verifiedOriginal(posting),true);
});
await test('API transport failure falls back to the employer page with explicit provenance',async()=>{
 const posting=await readOriginalPosting(url,{api:{...api,posting:async()=>{throw new Error('Network error');}},readPage:async actual=>({url:actual,jd,role:'Engineer',company:'Example',descriptionMethod:'structured-data'})});
 assert.equal(posting.descriptionSource.method,'employer-page');assert.equal(posting.jd,jd);
});
await test('Closed postings, unreadable original pages and aggregator redirects never fall back to copied text',async()=>{
 let pages=0;
 await assert.rejects(()=>readOriginalPosting(url,{api:{...api,posting:async()=>null},readPage:async()=>{pages++;}}),error=>error.postingClosed);
 assert.equal(pages,0);
 for(const page of [null,{url:'https://jobright.ai/jobs/info/abc',jd,role:'Engineer',descriptionMethod:'structured-data'},{url,jd,role:'Engineer',descriptionMethod:'body'},{url,jd:'short',role:'Engineer',descriptionMethod:'container'}]) {
  await assert.rejects(()=>readOriginalPosting(url,{readPage:async()=>page}),/original employer page/);
 }
 await assert.rejects(()=>readOriginalPosting('https://jobright.ai/jobs/info/abc',{readPage:async()=>{pages++;}}),/original employer posting link/);
 assert.equal(pages,0);
 await assert.rejects(()=>readOriginalPosting(url,{readPage:async()=>({url,jd,role:'Engineer',descriptionMethod:'structured-data',closed:true})}),error=>error.postingClosed);
});
await test('Previously cached descriptions without first-party provenance cannot be reused; unchanged refreshes retain document and research caches',async()=>{
 assert.equal(verifiedOriginal({jd}),false);
 assert.equal(verifiedOriginal({jd,descriptionSource:{revision:0,url,method:'official-api',verifiedAt:Date.now()}}),false);
 assert.equal(isDiscoveryUrl('https://www.jobright.ai/jobs/info/abc'),true);
 assert.throws(()=>originalSource('https://hiringcafe.com/job/abc','official-api'),/original employer/);
 const before={jd,company:'Example',title:'Engineer',applyUrl:url,descriptionSource:originalSource(url,'official-api')};
 const refreshed={...before,descriptionSource:{...before.descriptionSource,verifiedAt:Date.now()+1000}};
 assert.equal(await documentSignature(before,{}),await documentSignature(refreshed,{}));
 assert.equal(await screeningSignature(before,{}),await screeningSignature(refreshed,{}));
 assert.notEqual(await documentSignature(before,{}),await documentSignature({...before,descriptionSource:null},{}));
});
const job={company:'Example',title:'Engineer',jd,applyUrl:url,originalUrl:url,descriptionSource:originalSource(url,'official-api')};
const profile={screeningEnabled:true,screeningWorkplace:'remote',screeningTravel:'none',screeningClearance:'none',screeningInterview:'none',screeningUnknown:'strict'};
await test('Explicit original requirements satisfy screening without spending a web-research request',async()=>{
 let calls=0;const result=await screenJob(job,profile,{ask:async()=>{calls++;throw new Error('Unnecessary research');}});
 assert.equal(result.decision,'eligible');assert.equal(calls,0);assert.equal(result.findings.workplace.evidence[0].url,url);
 assert.equal(result.mode,'original-evidence');
});
await test('Silence, ambiguous arrangements and unverified descriptions still cannot prove negative requirements',()=>{
 const ambiguous={...job,jd:'We offer remote/hybrid work benefits. Our insurance covers travel. This position requires travel.',metadata:{location:'Remote/Hybrid'}};
 assert.deepEqual(originalFindings(ambiguous,profile),{});
 assert.deepEqual(originalFindings({...job,descriptionSource:null},profile),{});
});
await test('Explicit primary workplace metadata is retained separately from a geographic location',()=>{
 const job={id:'a',company:'Example',title:'Engineer',jd:'Software engineering role in a distributed team.',metadata:{location:'Texas, United States',workplaceType:'Remote'},descriptionSource:originalSource(url,'official-api')};
 const p={screeningEnabled:true,screeningWorkplace:'remote'};assert.equal(originalFindings(job,p).workplace.value,'remote');
 const conflicting={...job,jd:'This position requires on-site attendance at the company office.'};assert.equal(originalFindings(conflicting,p).workplace.value,'unknown');
});
await test('An explicit fully remote contractor opportunity retains original proof without guessing omitted requirements',()=>{
 const p={...profile},j={...job,jd:'PLEASE NOTE: This is a fully remote, 1099 independent contractor opportunity with an estimated duration of six months.'};
 const found=originalFindings(j,p);assert.equal(found.workplace.value,'remote');assert.equal(found.travel,undefined);assert.equal(found.clearance,undefined);assert.equal(found.interview,undefined);
 assert.deepEqual(originalFindings({...j,jd:'This is not a fully remote, 1099 independent contractor opportunity.'},p),{});
});
await test('Web research asks only unresolved criteria and merges retained original evidence',async()=>{
 const partial={...job,jd:'This position is fully remote. '+('Build reliable software. '.repeat(12))};let requests=0;
 const result=await screenJob(partial,profile,{ask:async request=>{requests++;const prompt=request.messages[0].content;const shape=JSON.parse(prompt.match(/\n(\{"company"[^\n]+)\nEnabled rules:/)[1]);assert.equal(shape.findings.workplace,undefined);assert.ok(shape.findings.travel);return {text:JSON.stringify({company:'Example',role:'Engineer',findings:{},sources:[]})};}});
 assert.equal(requests,1);assert.equal(result.decision,'review');assert.equal(result.findings.workplace.verified,true);assert.ok(!result.unknown.includes('Work arrangement'));
});
const extract=await readFile(new URL('../src/extract.js',import.meta.url),'utf8');
await test('Discovery reads only the original link and never mistakes a sidebar ATS or autofill for the target',()=>{
 const dom=parseHTML('<html><head><title>Copied job</title></head><body><h1>Copied role</h1><article>WRONG AGGREGATOR DESCRIPTION</article><a href="https://jobs.ashbyhq.com/other/other">Other job</a><button>Apply with autofill</button><a href="'+url+'">Original Job Post</a></body></html>');
 delete dom.window.__ghExtract;vm.runInNewContext(extract,{window:dom.window,document:dom.document,location:{href:'https://jobright.ai/jobs/info/abc',hostname:'jobright.ai'},URL});
 const found=dom.window.__ghExtract.discover();assert.equal(found.jd,'');assert.equal(found.apply.url,url);assert.equal(found.originalControl,true);
});
await test('Nested schema JobPosting descriptions beat unrelated page text and are not truncated',()=>{
 const long=jd.repeat(100),payload={'@graph':[{'@type':'JobPosting',title:'Engineer',description:'<p>'+long+'</p>',hiringOrganization:{name:'Example'}}]};
 const dom=parseHTML('<html><body><script type="application/ld+json">'+JSON.stringify(payload)+'</script><article>WRONG PAGE TEXT</article><h1>Engineer</h1></body></html>');
 delete dom.window.__ghExtract;vm.runInNewContext(extract,{window:dom.window,document:dom.document,location:{href:url,hostname:'job-boards.greenhouse.io'},URL});
 const found=dom.window.__ghExtract.read();assert.equal(found.company,'Example');assert.equal(found.jd,long.trim());assert.equal(found.descriptionMethod,'structured-data');
});
const chat=await readFile(new URL('../src/chatgpt.js',import.meta.url),'utf8');
await test('Multiple structured postings select the current URL and hold ambiguous job lists',()=>{
 const payload=[{'@type':'JobPosting',title:'Wrong role',url:url.replace('123','456'),description:jd,hiringOrganization:{name:'Other'}},{'@type':'JobPosting',title:'Engineer',url,description:jd,hiringOrganization:{name:'Example'}}];
 const dom=parseHTML('<html><body><script type="application/ld+json">'+JSON.stringify(payload)+'</script><h1>Engineer</h1></body></html>');
 delete dom.window.__ghExtract;const location={href:url,hostname:'job-boards.greenhouse.io'};
 vm.runInNewContext(extract,{window:dom.window,document:dom.document,location,URL});
 assert.equal(dom.window.__ghExtract.read().company,'Example');assert.equal(dom.window.__ghExtract.read().ambiguousPosting,false);
 location.href=url.replace('123','789');assert.equal(dom.window.__ghExtract.read().ambiguousPosting,true);
});
await test('A lost in-page task refreshes and recovers its reply instead of failing the job immediately',async()=>{
 const {askChatGpt}=await import('../src/chatgpt.js');let sends=0,reloads=0;
 globalThis.chrome={tabs:{query:async()=>[{id:7,windowId:1,url:'https://chatgpt.com/c/assigned'}],get:async()=>({id:7,windowId:1,status:'complete',url:'https://chatgpt.com/c/assigned'}),update:async()=>({id:7,windowId:1}),reload:async(_id,options)=>{assert.equal(options.bypassCache,true);reloads++;}},windows:{getLastFocused:async()=>({id:1}),update:async()=>({})},scripting:{executeScript:async args=>{if(args.func.name==='selectChatGptMode')return [{result:{ok:true,requested:args.args[0],selected:args.args[0]}}];if(args.func.name==='converse'){if(args.args[1].resumeOnly)return [{result:{ok:true,text:'Recovered assigned response'}}];sends++;return [{result:{ok:false,reason:'task-lost',diagnostics:[]}}];}return [{result:{}}];}}};
 try {const reply=await askChatGpt({messages:[{role:'user',content:'Assigned job description'}],format:'text'});assert.equal(reply.text,'Recovered assigned response');assert.equal(sends,1);assert.equal(reloads,1);}finally{delete globalThis.chrome;}
});
const converseCode=chat.slice(chat.indexOf('async function converse(prompt, options)'),chat.indexOf('/* --------------------------------------------------------------- bridge */'));
await test('Refresh recovery reads the assigned completed reply without sending another prompt',async()=>{
 const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><div data-message-author-role="user">Assigned complete job description</div><div data-message-author-role="assistant">Recovered assigned reply</div></body></html>');
 Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let sends=0;dom.document.querySelector('button').onclick=()=>sends++;
 const converse=vm.runInNewContext('('+converseCode+')',{document:dom.document,window:dom.window,location:{pathname:'/c/assigned',href:'https://chatgpt.com/c/assigned'},setTimeout:cb=>queueMicrotask(cb),HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL});
 const started=await converse('Assigned complete job description',{resumeOnly:true,detached:true,taskId:'recovered',timeoutMs:1000,settleMs:0});assert.equal(started.started,true);
 await dom.window.__applyBotChatTask.check(false);const reply=await dom.window.__applyBotChatTask.check(false);
 assert.equal(reply.text,'Recovered assigned reply');assert.equal(sends,0);
 const mismatch=await converse('Another job',{resumeOnly:true,detached:true,taskId:'other',timeoutMs:1000,settleMs:0});assert.equal(mismatch.reason,'prompt-not-found');assert.equal(sends,0);
});
await test('A refreshed account-error turn retries its verified prompt in place without typing another one',async()=>{
 const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><div data-message-author-role="user">Assigned complete job description</div><div role="alert">Your account changed. Send your message again.</div><button id="retry">Retry</button></body></html>');
 Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let sends=0,retries=0;dom.document.querySelector('[data-testid="send-button"]').onclick=()=>sends++;
 dom.document.querySelector('#retry').onclick=()=>{retries++;dom.document.querySelector('[role="alert"]').remove();const turn=dom.document.createElement('div');turn.dataset.messageAuthorRole='assistant';turn.textContent='Recovered in the original conversation';dom.document.body.append(turn);};
 const converse=vm.runInNewContext('('+converseCode+')',{document:dom.document,window:dom.window,location:{pathname:'/c/assigned',href:'https://chatgpt.com/c/assigned'},setTimeout:cb=>queueMicrotask(cb),HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL});
 const started=await converse('Assigned complete job description',{resumeOnly:true,detached:true,taskId:'retried',timeoutMs:1000,settleMs:0});assert.equal(started.started,true);
 await dom.window.__applyBotChatTask.check(false);const reply=await dom.window.__applyBotChatTask.check(false);
 assert.equal(reply.text,'Recovered in the original conversation');assert.equal(retries,1);assert.equal(sends,0);
});
await test('An optimistic local conversation without server acknowledgement fails in 45 seconds instead of waiting six minutes',async()=>{
 const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
 Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let now=100000;
 const location={pathname:'/c/local-chatgpt%3Aunacknowledged',href:'https://chatgpt.com/c/local-chatgpt%3Aunacknowledged'};
 const converse=vm.runInNewContext('('+converseCode+')',{document:dom.document,window:dom.window,location,Date:{now:()=>now},setTimeout:cb=>queueMicrotask(cb),HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL});
 await converse('Assigned job description',{detached:true,taskId:'unacknowledged',timeoutMs:360000,settleMs:0});now+=45001;
 assert.equal((await dom.window.__applyBotChatTask.check(false)).reason,'no-reply');
});
await test('ChatGPT loading placeholders are never selected as a live composer',async()=>{
 const dom=parseHTML('<html><body><textarea id="pending-home-input" placeholder="Ask anything"></textarea><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
 Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let intended='';
 dom.document.querySelector('button').onclick=()=>{intended=dom.document.querySelector('#prompt-textarea').value;const user=dom.document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=intended;dom.document.body.append(user);};
 const converse=vm.runInNewContext('('+converseCode+')',{document:dom.document,window:dom.window,location:{pathname:'/c/assigned',href:'https://chatgpt.com/c/assigned'},setTimeout:cb=>queueMicrotask(cb),HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL});
 assert.equal((await converse('Assigned job',{detached:true,taskId:'ready',timeoutMs:1000,settleMs:0})).started,true);assert.equal(intended,'Assigned job');assert.equal(dom.document.querySelector('#pending-home-input').value,'');
 dom.document.querySelector('#prompt-textarea').remove();const noComposer=await converse('Must not send',{detached:true,taskId:'loading',timeoutMs:1000,settleMs:0});assert.equal(noComposer.reason,'no-composer');assert.equal(dom.document.querySelector('#pending-home-input').value,'');
});
await test('An exhausted loading worker is retired without closing the pool or touching the user conversation',async()=>{
 const {askChatGpt,configureChatGptWorkers,closeChatGptWorkers,chatGptWorkerStatus}=await import('../src/chatgpt.js');
 let nextId=7,reloads=0;const removed=[],owned={applyBotOwnedTabs:[]},tabs=new Map([[7,{id:7,windowId:1,status:'complete',url:'https://chatgpt.com/c/user'}]]);
 globalThis.chrome={storage:{session:{get:async()=>owned,set:async value=>Object.assign(owned,value)}},tabs:{query:async()=>[tabs.get(7)],get:async id=>{if(!tabs.has(id))throw new Error('closed');return tabs.get(id);},create:async info=>{const tab={id:++nextId,windowId:1,status:'complete',...info};tabs.set(tab.id,tab);return tab;},update:async(id,info)=>{Object.assign(tabs.get(id),info);return tabs.get(id);},remove:async id=>{removed.push(id);tabs.delete(id);},reload:async()=>{reloads++;}},windows:{getLastFocused:async()=>({id:1}),update:async()=>({})},scripting:{executeScript:async args=>{
  if(args.func.name==='selectChatGptMode')return [{result:{ok:true,requested:args.args[0],selected:args.args[0]}}];
  assert.equal(args.func.name,'converse');return [{result:args.target.tabId===8?{ok:false,reason:'no-composer',diagnostics:[]}:{ok:true,text:'Next assigned research',searchEvidence:{nativeCitations:[{url:'https://example.com/role'}]}}}];
 }}};
 try{
  configureChatGptWorkers({limit:2,contextUrl:'https://chatgpt.com/g/g-p-daniel/project'});
  const request={messages:[{role:'user',content:'Research the assigned job'}],format:'text',webSearch:true};
  await assert.rejects(()=>askChatGpt(request),error=>error.status===502&&error.workerFailure===true&&error.retryable===false);
  assert.equal(reloads,3);assert.deepEqual(removed,[8]);assert.equal(chatGptWorkerStatus().closed,undefined);assert.equal(tabs.get(7).url,'https://chatgpt.com/c/user');
  assert.equal((await askChatGpt(request)).text,'Next assigned research');assert.equal(nextId,9);assert.deepEqual(owned.applyBotOwnedTabs.map(lease=>lease.tabId),[9]);
 }finally{await closeChatGptWorkers();delete globalThis.chrome;}
});
await test('Run readiness also refreshes a failed ChatGPT session and succeeds without sending a prompt',async()=>{
 const {chatGptStatus}=await import('../src/chatgpt.js');let probes=0,reloads=0;const retries=[];
 globalThis.chrome={tabs:{query:async()=>[{id:7,windowId:1,url:'https://chatgpt.com/'}],get:async()=>({id:7,status:'complete',url:'https://chatgpt.com/'}),update:async()=>({id:7}),reload:async()=>{reloads++;}},windows:{getLastFocused:async()=>({id:1})},scripting:{executeScript:async args=>{assert.equal(args.func.name,'probePage');return [{result:++probes===1?{signedOut:true,composer:false}:{signedOut:false,composer:true,composerKind:'editor'}}];}}};
 try{const result=await chatGptStatus({onRetry:i=>retries.push(i.retry)});assert.equal(result.ok,true);assert.equal(probes,2);assert.equal(reloads,1);assert.deepEqual(retries,[1]);}finally{delete globalThis.chrome;}
});
/**
 * The order a Jobright card is resolved in, read as text.
 *
 * `background.js` reaches `chrome.*` at the top level and cannot be
 * imported outside the browser, and this order is the whole of the fix for
 * the commonest way a Jobright link died: the hop is the last resort rather
 * than the first, because pressing a scripted apply button is a
 * `window.open` the popup blocker eats and twenty seconds waiting for a tab
 * that will never open. What each branch reads is tested properly against
 * real markup in check.js; all that is left to say here is that the run
 * consults them in the order that makes the hop rare.
 */
await test('A Jobright card is resolved from its own data before anything is pressed',async()=>{
 const source=await readFile(new URL('../src/background.js',import.meta.url),'utf8');
 const resolve=source.slice(source.indexOf('async function sourceFromLink('),source.indexOf('async function manualApplication('));
 const island=resolve.indexOf('listing.apply?.url'),own=resolve.indexOf('listing.originalUrl&&!isDiscoveryUrl'),none=resolve.indexOf('listing.employerLinkOffered===false'),hop=resolve.indexOf('hopToApply(first)');
 assert.ok(island>=0&&own>island&&none>own&&hop>none,`resolution order is ${JSON.stringify({island,own,none,hop})}`);
 assert.ok(/employerLinkOffered===false&&\(!originalUrl\|\|isDiscoveryUrl\(originalUrl\)\)/.test(resolve),'a card the feed says has no employer link is still sent for review rather than let go');
 assert.ok(resolve.includes("{skip:'the aggregator holds no employer link"),'letting it go has to be a skip, so the posting rests instead of being retried in half an hour');
});
console.log(`${count} original-source and ChatGPT recovery checks passed.`);
