import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {virtualFeed} from './jobright-fixture.mjs';
import {DiscoveryRounds} from '../src/run-policy.js';
import {classified} from '../src/jobright.js';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
await test('A fixed-height virtual feed retains every middle card across bounded reads',async()=>{
 const feed=virtualFeed({count:38});let result,reads=0;
 do{result=await feed.collect(8,reads++>0);}while(result.more&&reads<20);
 assert.equal(result.complete,true);assert.equal(result.links.length,38);assert.equal(reads>1,true);
 assert.equal(feed.positions.every((top,i)=>i===0||Math.abs(top-feed.positions[i-1])<=500),true);
 assert.equal(feed.sidebar.scrollTop,0);
});
await test('Chunks containing no new links cannot exhaust a sparse virtual feed',async()=>{
 const feed=virtualFeed({count:40,slots:[0,18,39]}),rounds=new DiscoveryRounds(1);let result,reads=0,emptyIncomplete=0,ended=false;
 do{result=await feed.collect(4,reads++>0);const found=rounds.observe(Array.from(result.links));if(!found&&result.more)emptyIncomplete++;ended=rounds.success('jobright',found,result.complete);if(result.more)assert.equal(ended,false);}while(result.more&&reads<30);
 assert.equal(result.links.length,3);assert.equal(emptyIncomplete>0,true);assert.equal(result.complete,true);
 assert.equal(ended,false,'New links earlier in the same scan still count when its final chunk is empty');
});
await test('Exhaustion requires a complete pass with no new links, including when sources interleave or a read fails',()=>{
 const rounds=new DiscoveryRounds(2);
 assert.equal(rounds.success('jobright',4,false),false);assert.equal(rounds.success('hiringcafe',0,true),false);
 rounds.failure('jobright');assert.equal(rounds.success('jobright',0,true),false);
 assert.equal(rounds.success('hiringcafe',0,true),false);assert.equal(rounds.success('jobright',0,false),false);assert.equal(rounds.success('jobright',0,true),true);
});
await test('A loader lasting longer than the old six-second stop window prevents completion',async()=>{
 const feed=virtualFeed({count:2,loaderUntil:10000});const result=await feed.collect(8);
 assert.equal(result.complete,true);assert.ok(feed.now()>=122000);assert.equal(result.scan.reason,'stable-bottom-confirmed');
});
await test('Backend has-more remains incomplete and a persistent stall becomes an error, never exhaustion',async()=>{
 const network={reset:()=>{},snapshot:()=>({hasMore:true,inflight:0,version:1,ids:[]})},feed=virtualFeed({count:2,network});
 const first=await feed.collect(8,false,{budgetMs:10000});assert.equal(first.more,true);assert.equal(first.complete,false);
 let last=first;for(let i=0;i<8&&!last.unavailable;i++)last=await feed.collect(8,true,{budgetMs:10000});
 assert.equal(last.unavailable,true);assert.equal(last.complete,false);assert.match(last.error,/did not advance/);
});
await test('Repeated responses without new cards cannot keep a stalled feed alive indefinitely',async()=>{
 let version=0;const network={reset:()=>{},snapshot:()=>({hasMore:true,inflight:0,version:version++,ids:[]})},feed=virtualFeed({count:2,network});
 let last=await feed.collect(8,false,{budgetMs:10000});
 for(let i=0;i<8&&!last.unavailable;i++)last=await feed.collect(8,true,{budgetMs:10000});
 assert.equal(last.unavailable,true);assert.equal(last.complete,false);assert.match(last.error,/did not advance/);
});
await test('A terminal backend flag still requires scanning the middle and confirming a quiet bottom',async()=>{
 const network={reset:()=>{},snapshot:()=>({terminal:true,hasMore:false,inflight:0,version:1,ids:[]})},feed=virtualFeed({count:20,network});
 let result,reads=0;do{result=await feed.collect(5,reads++>0);}while(result.more&&reads<10);
 assert.equal(result.links.length,20);assert.equal(result.scan.reason,'backend-end-confirmed');
});
await test('A read budget is incomplete even when visible cards do not change; continuation restores the cursor',async()=>{
 const feed=virtualFeed({count:30});const first=await feed.collect(2);const top=first.scan.top;
 feed.setTop(0);const second=await feed.collect(2,true);
 assert.equal(first.complete,false);assert.equal(second.complete,false);assert.ok(second.scan.top>top);assert.equal(second.scan.restarted,false);
});
await test('A replaced scroll container restarts contiguous scanning instead of claiming the feed ended',async()=>{
 const feed=virtualFeed({count:20});await feed.collect(2);
 delete feed.window.__applyBotJobrightScan;
 const second=await feed.collect(2,true);assert.equal(second.scan.restarted,true);assert.equal(second.complete,false);
});
await test('Replacing the actual list element restarts at its top and retains previously collected jobs',async()=>{
 const feed=virtualFeed({count:20}),first=await feed.collect(3);feed.replaceContainer();
 const second=await feed.collect(2,true);assert.equal(second.complete,false);assert.ok(second.scan.top<first.scan.top);assert.ok(second.links.length>=first.links.length);
 let last=second;for(let i=0;i<10&&last.more;i++)last=await feed.collect(8,true);assert.equal(last.links.length,20);assert.equal(last.complete,true);
});
const observer=await readFile(new URL('../src/jobright-network.js',import.meta.url),'utf8');
function networkFixture(){
 let response={data:{jobs:[{jobId:'a'.repeat(24)}],hasMore:true}},calls=0;
 const window={fetch:async()=>{calls++;return {status:200,clone:()=>({json:async()=>response})};}};
 vm.runInNewContext(observer,{window,location:{href:'https://jobright.ai/jobs/recommend'},URL,Date,Set,Math});
 const request=async(url='/swan/recommend/list/jobs',body={page:1,filter:'engineer'})=>{await window.fetch(url,{body:JSON.stringify(body)});await new Promise(r=>setImmediate(r));return window.__applyBotJobrightNetwork.snapshot();};
 return {window,request,setResponse:value=>response=value,calls:()=>calls};
}
await test('Network observation ignores telemetry and job-statistics pagination fields',async()=>{
 const feed=networkFixture();feed.setResponse({data:{jobs:[],hasMore:false}});
 await feed.request('/swan/job/statistic');assert.equal(feed.window.__applyBotJobrightNetwork.snapshot().terminal,false);
 assert.equal((await feed.request('/swan/recommend/list/jobs')).terminal,true);
});
await test('An empty job array is recognized, while unknown/authentication payloads cannot confirm the end',async()=>{
 const feed=networkFixture();feed.setResponse({data:{jobs:[],hasMore:false}});assert.equal((await feed.request()).terminal,true);
 feed.setResponse({error:'Please sign in',hasMore:false});assert.equal((await feed.request()).terminal,false);
});
await test('Pagination changes keep a stable query scope; changed filters invalidate an old end signal',async()=>{
 const feed=networkFixture(),first=await feed.request(undefined,{page:1,filter:'engineer'}),second=await feed.request(undefined,{page:2,filter:'engineer'});assert.equal(first.scope,second.scope);
 feed.setResponse({data:{jobs:[],hasMore:false}});await feed.request();feed.setResponse({data:{jobs:[{jobId:'b'.repeat(24)}],hasMore:true}});
 const changed=await feed.request(undefined,{page:1,filter:'designer'});assert.notEqual(changed.scope,first.scope);assert.equal(changed.terminal,false);assert.deepEqual(Array.from(changed.ids),['b'.repeat(24)]);
});
await test('The live Jobright response shape and position/count pagination retain a cumulative list',async()=>{
 const feed=networkFixture();feed.setResponse({success:true,result:{jobList:[{jobResult:{jobId:'a'.repeat(24)}}],impId:'first-page'}});
 const first=await feed.request('/swan/recommend/list/jobs?refresh=true&sortCondition=0&position=0&count=20&syncRerank=false',null);
 feed.setResponse({success:true,result:{jobList:[{jobResult:{jobId:'b'.repeat(24)}}],impId:'next-page'}});
 const next=await feed.request('/swan/recommend/list/jobs?refresh=false&sortCondition=0&position=20&count=20&syncRerank=false',null);
 assert.equal(first.scope,next.scope);assert.deepEqual(Array.from(next.ids),['a'.repeat(24),'b'.repeat(24)]);assert.equal(next.terminal,false);
 feed.setResponse({success:false,result:{jobList:[]}});const failed=await feed.request();assert.equal(failed.terminal,false);assert.match(failed.error,/unsuccessful/);
});
await test('A late response for an earlier filter cannot overwrite the current filter',async()=>{
 const pending=[];const window={fetch:async()=>({status:200,clone:()=>({json:()=>new Promise(resolve=>pending.push(resolve))})})};
 vm.runInNewContext(observer,{window,location:{href:'https://jobright.ai/jobs/recommend'},URL,Date,Set,Math});
 await window.fetch('/swan/recommend/list/jobs?filter=old');await window.fetch('/swan/recommend/list/jobs?filter=new');
 pending[1]({data:{jobs:[{jobId:'b'.repeat(24)}],hasMore:true}});await new Promise(r=>setImmediate(r));
 pending[0]({data:{jobs:[],hasMore:false}});await new Promise(r=>setImmediate(r));
 const current=window.__applyBotJobrightNetwork.snapshot();assert.equal(current.terminal,false);assert.deepEqual(Array.from(current.ids),['b'.repeat(24)]);assert.equal(current.inflight,0);
});
await test('Stale responses from an earlier scan cannot declare the new scan finished',async()=>{
 let deliver;const window={fetch:async()=>({status:200,clone:()=>({json:()=>new Promise(r=>deliver=r)})})};
 vm.runInNewContext(observer,{window,location:{href:'https://jobright.ai/jobs/recommend'},URL,Date,Set,Math});
 await window.fetch('/swan/recommend/list/jobs');window.__applyBotJobrightNetwork.reset();deliver({data:{jobs:[],hasMore:false}});await new Promise(r=>setImmediate(r));
 assert.equal(window.__applyBotJobrightNetwork.snapshot().terminal,false);assert.equal(window.__applyBotJobrightNetwork.snapshot().inflight,0);
});
await test('Jobright keeps employer, title and original-link hints bound to their exact job ID without retaining copied descriptions',async()=>{
 const feed=networkFixture(),id='c'.repeat(24);
 feed.setResponse({success:true,result:{jobList:[{jobResult:{jobId:id,jobTitle:'Engineer',externalApplyUrl:'https://jobs.ashbyhq.com/example/123',description:'Copied aggregator description'},companyResult:{companyName:'Example'}}]}});
 const snapshot=await feed.request(),entry=snapshot.entries.find(x=>x.id===id);
 assert.equal(entry.company,'Example');assert.equal(entry.title,'Engineer');assert.equal(entry.originalUrl,'https://jobs.ashbyhq.com/example/123');assert.equal('description' in entry,false);
 entry.company='Changed outside observer';assert.equal(feed.window.__applyBotJobrightNetwork.snapshot().entries.find(x=>x.id===id).company,'Example');
});
await test('Network hints reject active-content, credentials and discovery-site links',async()=>{
 for(const url of ['javascript:alert(1)','https://user:pass@careers.example.test/role','https://jobright.ai/jobs/info/'+('d'.repeat(24))]){
  const feed=networkFixture();feed.setResponse({data:{jobs:[{jobId:'d'.repeat(24),applyUrl:url}]}});const entry=(await feed.request()).entries[0];assert.equal(entry.originalUrl,undefined);
 }
});
await test('A job is named by the board it applies through, and an unnamed site is never read as unsupported',()=>{
 const {entries,boards}=classified([
  {id:'1',originalUrl:'https://boards.greenhouse.io/example/jobs/1'},
  {id:'2',originalUrl:'https://example.icims.com/jobs/2/apply'},
  {id:'3',originalUrl:'https://example.taleo.net/careersection/jobdetail.ftl'},
  {id:'4'},
  {id:'5',originalUrl:'not a url at all'},
 ]);
 assert.deepEqual(entries.map(entry=>entry.ats),['greenhouse','icims','taleo','','']);
 assert.deepEqual(boards,{fillable:1,elsewhere:2,unknown:2,unreachable:0});
});
await test('A job the feed says has no employer link is counted apart from one it merely did not name',()=>{
 const {boards}=classified([
  {id:'1',originalUrl:'https://boards.greenhouse.io/example/jobs/1',companySiteLink:true},
  {id:'2',companySiteLink:false},
  {id:'3'},
 ]);
 // Both 2 and 3 are "unknown" - neither names a board - but only 2 is known
 // to be unreachable, and opening it would cost a tab and a twenty-second
 // hop to learn what the feed already said.
 assert.deepEqual(boards,{fillable:1,elsewhere:0,unknown:2,unreachable:1});
});
await test("Jobright's own applyLink is read as the employer address, and its company-site flag carried",async()=>{
 const feed=networkFixture(),id='e'.repeat(24);
 feed.setResponse({data:{jobs:[{jobResult:{jobId:id,applyLink:'https://job-boards.greenhouse.io/example/jobs/9',isCompanySiteLink:true}}]}});
 const entry=(await feed.request()).entries[0];
 assert.equal(entry.originalUrl,'https://job-boards.greenhouse.io/example/jobs/9');
 assert.equal(entry.companySiteLink,true);
});
await test('A feed job marked as having no company-site link says so even with no address on it',async()=>{
 const feed=networkFixture(),id='f'.repeat(24);
 feed.setResponse({data:{jobs:[{jobResult:{jobId:id,isCompanySiteLink:false}}]}});
 const entry=(await feed.request()).entries[0];
 assert.equal(entry.originalUrl,undefined);assert.equal(entry.companySiteLink,false);
});
await test('The list endpoints that grew up beside /swan/recommend/list/jobs are observed too',async()=>{
 for(const path of ['/swan/recommend/tnt/jobs','/swan/search/list/jobs','/swan/recommend/visitor-list/jobs']){
  const feed=networkFixture();feed.setResponse({data:{jobs:[{jobId:'a'.repeat(24)}],hasMore:false}});
  assert.equal((await feed.request(path)).ids.length,1,path);
 }
 // And nothing else under /swan/, several of which submit.
 const feed=networkFixture();feed.setResponse({data:{jobs:[{jobId:'a'.repeat(24)}]}});
 assert.equal((await feed.request('/swan/job/direct-apply-v2')).ids.length,0);
});
await test("The card's own apply link is used only when it names a board, and never replaces the feed's address",()=>{
 const {entries,boards}=classified([
  {id:'1',cardUrl:'https://jobs.lever.co/example/abc'},
  {id:'2',cardUrl:'https://example.com/careers'},
  {id:'3',originalUrl:'https://job-boards.greenhouse.io/example/jobs/3',cardUrl:'https://example.icims.com/jobs/3/apply'},
 ]);
 assert.deepEqual(entries.map(entry=>[entry.originalUrl,entry.ats]),[['https://jobs.lever.co/example/abc','lever'],[undefined,''],['https://job-boards.greenhouse.io/example/jobs/3','greenhouse']]);
 assert.equal(entries.every(entry=>!('cardUrl' in entry)),true);
 assert.deepEqual(boards,{fillable:2,elsewhere:0,unknown:1,unreachable:0});
});
await test('An apply button with an address is read off the card; one without it leaves the job unnamed',async()=>{
 const boards=['https://boards.greenhouse.io/example/jobs/1','https://example.icims.com/jobs/2/apply'];
 const feed=virtualFeed({count:3,applyUrl:id=>boards[id]});let result,reads=0;
 do{result=await feed.collect(8,reads++>0);}while(result.more&&reads<10);
 assert.equal(result.links.length,3);
 assert.deepEqual([...result.entries].map(entry=>entry.cardUrl),[...boards,undefined]);
 assert.deepEqual(classified(result.entries).boards,{fillable:1,elsewhere:1,unknown:1,unreachable:0});
});
console.log(`${count} Jobright discovery checks passed.`);
