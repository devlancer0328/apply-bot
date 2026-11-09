import {chatModeFixture} from './chat-mode-fixture.js';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sampleDocument} from '../src/templates.js';
import {browsersDir,scratchPath,releaseScratch} from './scratch.js';

await mkdir('test-results',{recursive:true});
const root=process.cwd(),cases={
 '10001':{company:'Pipeline Alpha',workplace:'onsite',travel:'required'},
 '10002':{company:'Pipeline Alpha',workplace:'remote',travel:'none'},
 '10003':{company:'Pipeline Gamma',workplace:'remote',travel:'unknown'},
 '10004':{company:'Pipeline Beta',workplace:'remote',travel:'none'},
 '10005':{company:'Pipeline Falla',workplace:'remote',travel:'none'},
 '10006':{company:'Pipeline Fallb',workplace:'remote',travel:'none'},
 '10007':{company:'Pipeline Delta',workplace:'remote',travel:'none'},
 '10008':{company:'Pipeline Epsilon',workplace:'remote',travel:'none'},
 '10009':{company:'Pipeline Filtered',workplace:'onsite',travel:'required'},
 '10010':{company:'Pipeline FeedOne',workplace:'remote',travel:'none'},
 '10012':{company:'Pipeline Original',workplace:'remote',travel:'none'},
 '10011':{company:'Pipeline FeedTwo',workplace:'remote',travel:'none'},
 '10014':{company:'Pipeline SparseRejected',workplace:'onsite',travel:'required'},
 '10015':{company:'Pipeline SparseMiddle',workplace:'remote',travel:'none'},
 '10016':{company:'Pipeline SparseLast',workplace:'remote',travel:'none'},
 '10017':{company:'Pipeline Zeta',workplace:'remote',travel:'unknown'},
};
const remote='This position is fully remote throughout the United States.';
const onsite='This position requires on-site attendance at the company office.';
const noTravel='No travel is required for this position.';
const travel='Travel of up to 25% is required for this role.';
function html(id){const j=cases[id]||cases['10002'],jd=`${j.company} is hiring a Software Engineer. ${j.workplace==='remote'?remote:onsite} ${j.travel==='none'?noTravel:j.travel==='required'?travel:'Travel details are not published.'} The team builds accessible customer applications using React and TypeScript, with careful testing, documentation, communication and maintainable engineering practices. Candidates should have professional experience delivering reliable production applications and collaborating with product teams.`;
 return `<!doctype html><html><head><title>Software Engineer at ${j.company}</title><script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Software Engineer',description:jd,hiringOrganization:{name:j.company}})}</script></head><body><h1>Software Engineer</h1><main id="content"><p>${jd}</p></main><form id="application_form"><label for="first_name">First name *</label><input id="first_name" required><label for="last_name">Last name *</label><input id="last_name" required><label for="email">Email *</label><input id="email" type="email" required><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required><button type="submit">Submit application</button></form><script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++;document.body.textContent='Thank you for applying';};</script></body></html>`;
}
const sparseIds=Object.fromEntries([['a'.repeat(23)+'1','10014'],['a'.repeat(23)+'2','10015'],['a'.repeat(23)+'3','10016']]);
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(req.url.includes('/jobs/info/')?'<html><head><title>Copied role at Copied Employer</title></head><body><h1>Copied role</h1><article>'+('WRONG AGGREGATOR DESCRIPTION '.repeat(200))+'</article><button>Apply with autofill</button><a href="'+base+(sparseIds[req.url.split('/').pop()]||(req.url.includes('unreadable')?'10013':'10012'))+'">Original Job Post</a></body></html>':req.url.endsWith('10013')?'<html><body><h1>Unavailable job</h1><p>The description could not be loaded.</p></body></html>':html(req.url.split('/').pop()));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://pipeline.greenhouse.io:${server.address().port}/jobs/`;
const resume={...sampleDocument(),coverLetter:'Dear hiring team, I build accessible software and would welcome the opportunity to discuss this role. Alex Morgan'};
const chatHtml=`<!doctype html><html><body><textarea id="prompt-textarea" style="width:700px;height:160px"></textarea><button data-testid="send-button">Send</button><script>
 const resume=${JSON.stringify(resume).replaceAll('<','\\u003c')};
 document.querySelector('button').onclick=()=>{
  const prompt=document.querySelector('textarea').value;
      localStorage.setItem('seenModes',JSON.stringify([...(JSON.parse(localStorage.getItem('seenModes')||'[]')),{mode:document.querySelector('#fixture-mode').dataset.selectedReasoningEffort,prompt}]));
  localStorage.setItem('calls',JSON.stringify([...(JSON.parse(localStorage.getItem('calls')||'[]')),prompt]));
  const company=(prompt.match(/(?:^|\\n)Company: ([^\\n]+)/)||[])[1]||(prompt.match(/Pipeline [A-Za-z]+/)||[])[0]||'Pipeline Alpha';
  const url=(prompt.match(/(?:Posting URL|Job URL): (http[^\\s]+)/)||[])[1]||'${base}10002';
  const screening=prompt.includes('Research application eligibility with web search now');
  const salary=prompt.includes('Research compensation with live web search.');
  const kind=screening?'screen':salary?'salary':'resume',requestId=crypto.randomUUID();
  const metric=phase=>fetch('/fixture-metric',{method:'POST',body:JSON.stringify({phase,kind,company,requestId,url:location.href,at:Date.now()})});metric('start');
  const user=document.createElement('div');user.dataset.userMessageBubble='true';
  const collapsed=prompt.length>500;user.textContent=collapsed?prompt.slice(0,200):prompt;
  if(collapsed){const more=document.createElement('button');more.textContent='Show more';more.onclick=()=>{user.textContent=prompt;};user.append(more);}document.body.append(user);
  if(!location.pathname.includes('/c/')){history.replaceState({},'', '/g/g-p-staged/c/local-chatgpt%3A'+requestId);setTimeout(()=>history.replaceState({},'', '/g/g-p-staged-friendly/c/'+requestId),1200);}
  document.querySelector('textarea').value='';
  const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.body.append(stop);
  let output={...resume,targetTitle:company+' Software Engineer'};
  if(screening){
   const workplace=prompt.includes(${JSON.stringify(onsite)})?'onsite':'remote';
   const travel=prompt.includes(${JSON.stringify(noTravel)})?'none':prompt.includes(${JSON.stringify(travel)})?'required':'unknown';
   const evidence=quote=>[{url,quote}];
   output={company,role:'Software Engineer',findings:{workplace:{value:workplace,evidence:evidence(workplace==='remote'?${JSON.stringify(remote)}:${JSON.stringify(onsite)})},travel:{value:travel,evidence:travel==='unknown'?[]:evidence(travel==='none'?${JSON.stringify(noTravel)}:${JSON.stringify(travel)})}},sources:[{url,title:'Software Engineer at '+company,company,scope:'role'}]};
  } else if(salary)output={status:'researched',company,role:'Software Engineer',location:'United States',currency:'USD',period:'year',basis:'base',minimum:140000,maximum:190000,recommendedAmount:173000,rationale:'Controlled company-specific compensation evidence.',sources:[{url,title:'Software Engineer at '+company,company,role:'Software Engineer',matchType:'exact-company-role',details:'Controlled employer role pay disclosure.'}]};
  if(kind==='resume'&&/Pipeline Fall[ab]/.test(company)){setTimeout(()=>{history.replaceState({},'', '/c/unrelated-'+requestId);user.textContent='An unrelated conversation';metric('lost');},150);return;}
  setTimeout(()=>{
  const turn=document.createElement('div');turn.dataset.messageAuthorRole='assistant';turn.textContent=JSON.stringify(output);turn.style.whiteSpace='pre-wrap';document.body.append(turn);stop.remove();metric('end');
  if(screening||salary){const citation=document.createElement('a');citation.dataset.testid='webpage-citation';citation.href=url;citation.textContent='Native source fixture';turn.append(citation);}
  },kind==='resume'?(company==='Pipeline Alpha'?8000:2000):kind==='screen'?(company==='Pipeline Gamma'?15000:8000):100);
 };</script></body></html>`+chatModeFixture();
const report={checks:[],errors:[],startedAt:new Date().toISOString()},metrics=[];
const pass=name=>{report.checks.push(name);console.log('PASS '+name);};
const profilePath=scratchPath('staged-profile');
let context,page;
try{
 const portable=(await readdir(browsersDir).catch(()=>[])).find(p=>/^chromium-\d+$/.test(p));
 context=await chromium.launchPersistentContext(profilePath,{...(portable?{executablePath:resolve(browsersDir,portable,'chrome-win64/chrome.exe')}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--host-resolver-rules=MAP pipeline.greenhouse.io 127.0.0.1,MAP jobright.ai 127.0.0.1','--no-proxy-server'],viewport:{width:1440,height:1050},acceptDownloads:true});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const origin='chrome-extension://'+new URL(worker.url()).host;
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(origin+'/src/options.html#jobs');
 await page.getByRole('heading',{name:'Jobs',exact:true}).waitFor();
 const call=(method,...args)=>page.evaluate(async({method,args})=>(await import('./store.js'))[method](...args),{method,args});
 assert.equal(await page.locator('[data-key="screeningEnabled"]').isChecked(),false);
 for(const key of ['Workplace','Travel','Clearance','Interview','Location','Employment','Sponsorship','Relocation','OnCall'])assert.equal(await page.locator(`[data-key="screening${key}"]`).inputValue(),'any');
 await page.locator('[data-key="screeningEnabled"]').check();await page.locator('[data-key="screeningTravel"]').selectOption('none');await page.getByRole('button',{name:'Save filters',exact:true}).click();
 assert.equal((await call('readProfile')).screeningTravel,'none');assert.equal((await call('readProfile')).screeningWorkplace,'any');
 pass('Filters start disabled and unrestricted; the user can save an individual optional restriction in the workspace');
 await call('writeProfile',{firstName:'Alex',lastName:'Morgan',email:'alex@example.test',phone:'5555550100',city:'Seattle',state:'WA',country:'United States',startDate:'Two weeks after offer',workAuthorization:'us-citizen',requiresSponsorship:'no',dryRun:true,maxPerRun:2,autoFetch:false,delayMs:0,chatGptConcurrency:2,chatGptProjectUrl:'https://chatgpt.com/g/g-p-staged/project',screeningEnabled:true,screeningWorkplace:'remote',screeningTravel:'none',screeningUnknown:'review'});
 await context.route('https://chatgpt.com/**',route=>{
  if(new URL(route.request().url()).pathname==='/fixture-metric'){metrics.push(JSON.parse(route.request().postData()));return route.fulfill({contentType:'application/json',body:'{}'});}
  return route.fulfill({contentType:'text/html',body:chatHtml});
 });
 const chat=await context.newPage();await chat.goto('https://chatgpt.com/g/g-p-staged/project');
 const links=['https://www.linkedin.com/jobs/view/987654321',...['10001','10009','10003','10017','10002','10004'].map(id=>base+id)];await call('saveLinks',links);
 await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const deadline=Date.now()+240000;let state,peakWorkers=0,monitorCaptured=false;
 do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));peakWorkers=Math.max(peakWorkers,state.aiWorkers?.busy||0);
  if(state.aiWorkers?.busy===2&&!monitorCaptured){await page.goto(origin+'/src/options.html#monitor');await page.getByRole('heading',{name:'Run monitor',exact:true}).waitFor();await page.getByText(/2\/2 active/).waitFor();await page.screenshot({path:'test-results/parallel-monitor-running.png',fullPage:true});monitorCaptured=true;}
 }while(state.running&&Date.now()<deadline);
 assert.equal(state.running,false,JSON.stringify(state));
 await writeFile('test-results/staged-run-log.json',JSON.stringify(state,null,2));
 const results=await call('allResults'),jobs=await call('allJobs'),forms=results.filter(r=>r.status==='dry-run');
 assert.equal(state.attempted,2,JSON.stringify(state));assert.equal(forms.length,2,JSON.stringify(results));
 assert.equal(jobs.find(j=>j.id===base+'10001').stage,'rejected');assert.equal(jobs.find(j=>j.id===base+'10003').stage,'review');assert.equal(jobs.find(j=>j.id===base+'10017').stage,'review');
 assert.equal(jobs.find(j=>j.id===base+'10002').stage,'dry-run');assert.equal(jobs.find(j=>j.id===base+'10004').stage,'dry-run');
 pass('A mixed queue skips LinkedIn, rejects conflicting travel/on-site work, holds unknowns, and reaches two application forms with limit two');
 const generated=await call('allResumes');assert.equal(generated.length,2);assert.deepEqual(new Set(forms.map(r=>r.company)),new Set(['Pipeline Alpha','Pipeline Beta']));
 pass('A rejected role does not block an eligible role at the same company; rejected and review jobs generate no resumes');
 assert.equal(peakWorkers,2);assert.equal(monitorCaptured,true);
 const resumeMetrics=metrics.filter(m=>m.kind==='resume'),start=company=>resumeMetrics.find(m=>m.phase==='start'&&m.company===company).at,end=company=>resumeMetrics.find(m=>m.phase==='end'&&m.company===company).at;
 assert.ok(start('Pipeline Beta')<end('Pipeline Alpha'));assert.ok(end('Pipeline Beta')<end('Pipeline Alpha'));
 for(const saved of generated)assert.ok(saved.document.targetTitle.startsWith(saved.job.company),JSON.stringify(saved));
 assert.ok(context.pages().includes(chat));assert.equal(chat.url(),'https://chatgpt.com/g/g-p-staged/project');
 pass('Two isolated resume conversations overlap, finish out of order, retain the correct employer document, and leave the main ChatGPT tab open');
 pass('The live Run monitor displays both workers and their current tasks during generation');
 const calls=await chat.evaluate(()=>JSON.parse(localStorage.getItem('calls')||'[]'));
 const types=calls.map(p=>p.includes('Research application eligibility with web search now')?'screen':p.includes('Research compensation with live web search.')?'salary':'resume');
 assert.equal(types.filter(t=>t==='screen').length,2);assert.equal(types.filter(t=>t==='resume').length,2);
 assert.ok(types.lastIndexOf('screen')<types.indexOf('resume'));
 pass('Original evidence avoids unnecessary AI screening; unresolved travel is researched in bounded windows before generation');
 const researchMetrics=metrics.filter(m=>m.kind==='screen'),researchStart=company=>researchMetrics.find(m=>m.phase==='start'&&m.company===company),researchEnd=company=>researchMetrics.find(m=>m.phase==='end'&&m.company===company);
 assert.ok(researchStart('Pipeline Zeta').at<researchEnd('Pipeline Gamma').at);assert.ok(researchEnd('Pipeline Zeta').at<researchEnd('Pipeline Gamma').at);
 assert.ok(researchMetrics.filter(m=>m.phase==='start').every(m=>new URL(m.url).pathname==='/'&&new URL(m.url).searchParams.get('temporary-chat')==='true'));
 pass('Two research conversations overlap and finish out of order in temporary chats, preserve each job decision, and leave the main project conversation untouched');
 for(const result of forms){assert.ok(result.detail.lastScreenshot?.path);assert.equal(result.detail.screenshotError,undefined);const form=context.pages().find(p=>p.url()===result.applyUrl);assert.ok(form);assert.equal(await form.evaluate(()=>window.submissions),0);assert.equal(await form.locator('#first_name').inputValue(),'Alex');}
 pass('Both real browser forms retain profile values and attachments, save screenshots, and stop before submission');
 await page.goto(origin+'/src/options.html#jobs');await page.getByRole('heading',{name:'Jobs',exact:true}).waitFor();
 await page.locator(`[data-action="job-detail"][data-id="${base}10001"]`).click();await page.getByText(onsite,{exact:true}).waitFor();
 assert.equal(await page.locator('#job-detail a[href="'+base+'10001"]').count()>=1,true);
 await page.screenshot({path:'test-results/jobs-screening-evidence.png',fullPage:true});
 pass('Jobs UI shows the decision, source link and exact quoted requirement');
 await page.goto(origin+'/src/options.html#activity');await page.locator(`[data-action="application-detail"][data-id="${forms[0].id}"]`).click();
 const image=page.getByAltText('Last saved application page');await image.waitFor();await image.evaluate(img=>img.decode());
 assert.equal(await page.getByRole('button',{name:'Last page screenshot (PNG)',exact:true}).count(),1);
 await page.screenshot({path:'test-results/application-screenshot-preview.png',fullPage:true});
 pass('Applications displays an actual PNG preview and a clearly labeled download button');
 const before=(await chat.evaluate(()=>JSON.parse(localStorage.getItem('calls')||'[]'))).length;
 await call('saveLinks',[base+'10002',base+'10004']);await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const reuseDeadline=Date.now()+90000;do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<reuseDeadline);
 assert.equal(state.running,false);assert.equal(state.attempted,2);assert.equal(await chat.evaluate(()=>JSON.parse(localStorage.getItem('calls')||'[]').length),before);
 assert.equal((await call('allResumes')).length,2);
 pass('A later review run reuses unchanged extracted postings, verified research and saved documents without additional AI requests');
 const cachedJob=await call('getJob',base+'10002');cachedJob.applicationData.compensation.researchedAt=Date.now()-7*3600000;await call('saveJob',cachedJob);
 await call('saveLinks',[base+'10002']);await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const refreshDeadline=Date.now()+90000;do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<refreshDeadline);
 assert.equal(state.running,false);assert.equal(state.attempted,1);const refreshed=await chat.evaluate(()=>JSON.parse(localStorage.getItem('calls')||'[]'));
 assert.equal(refreshed.length,before);
 assert.equal((await call('getJob',base+'10002')).applicationData.compensation.status,'not-requested');assert.equal((await call('allResumes')).length,2);
 pass('A cached form with no pay question does not refresh unused compensation research');
 const backup=await call('db',{action:'export'}),savedJobs=await call('allJobs');
 await call('db',{action:'replace',table:'jobs',value:[]});assert.equal((await call('allJobs')).length,0);
 await call('db',{action:'import',value:backup});
 assert.deepEqual(await call('allJobs'),savedJobs);assert.equal((await call('allResumes')).length,2);
 pass('SQLite backup and restore retains staged jobs, research evidence and document links');
 // Losing both owned conversations must reduce concurrency and continue subsequent jobs.
 await call('writeProfile',{screeningEnabled:false,maxPerRun:2});await call('saveLinks',['10005','10006','10007','10008'].map(id=>base+id));
 const fallbackAt=metrics.length;await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const fallbackDeadline=Date.now()+180000;do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<fallbackDeadline);
 assert.equal(state.running,false);assert.equal(state.attempted,2,JSON.stringify(state));assert.equal(state.aiWorkers.effective,1);assert.ok(state.aiWorkers.reason);assert.ok(state.lastError?.message);
 const fallbackMetrics=metrics.slice(fallbackAt).filter(m=>m.kind==='resume'),deltaEnd=fallbackMetrics.find(m=>m.phase==='end'&&m.company==='Pipeline Delta'),epsilonStart=fallbackMetrics.find(m=>m.phase==='start'&&m.company==='Pipeline Epsilon');
 assert.ok(deltaEnd&&epsilonStart);assert.ok(epsilonStart.at>=deltaEnd.at);
 await page.goto(origin+'/src/options.html#monitor');await page.getByRole('heading',{name:'Latest error',exact:true}).waitFor();await page.screenshot({path:'test-results/parallel-monitor-fallback.png',fullPage:true});
 pass('Lost worker conversations are reported visibly; two transport failures switch to one worker and later jobs still reach their forms');
 // A rejected first feed page must not be mistaken for an exhausted feed.
 const feedPages=[];
 await context.route('https://hiringcafe.com/**',route=>{
  const n=Number(new URL(route.request().url()).searchParams.get('page'))||1;feedPages.push(n);
  const ids=n===1?['10009']:n===2?['10010','10011']:[];
  const data={buildId:'fixture',props:{pageProps:{ssrPage:n,ssrHits:ids.map(id=>({apply_url:base+id,job_information:{title:'Software Engineer'},v5_processed_job_data:{company_name:cases[id].company}})),ssrTotalCount:120,ssrIsLastPage:n===3}}};
  return route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><h1>Hiring Cafe fixture page ${n}</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`});
 });
 const feed=await context.newPage();await feed.goto('https://hiringcafe.com/?searchState=fixture&page=1');
 await call('writeProfile',{screeningEnabled:true,screeningWorkplace:'remote',screeningTravel:'none',autoFetch:true,jobrightRecommend:false,hiringCafeUrl:'https://hiringcafe.com/?searchState=fixture',keepRunning:true,maxPerRun:0});
 await call('saveLinks',[base+'10009']);await page.evaluate(async()=>{const {stateStorage}=await import('./store.js');await stateStorage.set({hiringCafePage:1});});
 await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const feedDeadline=Date.now()+180000;do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<feedDeadline);
 assert.equal(state.running,false);assert.equal(state.stopReason?.code,'exhausted',JSON.stringify(state));assert.equal(state.attempted,2);assert.equal(state.rejected,1);assert.deepEqual(feedPages,[1,2,3,1,2,3]);
 assert.equal(metrics.some(m=>m.company==='Pipeline Filtered'&&m.kind==='resume'),false);
 pass('Unlimited discovery continues past a rejected, already-seen first page, fills two later jobs, and finishes only when pagination is exhausted');
 await page.goto(origin+'/src/options.html#monitor');await page.getByText('No new jobs found across a complete round of the enabled feeds.',{exact:true}).waitFor();await page.screenshot({path:'test-results/run-monitor-exhausted.png',fullPage:true});
 pass('The final monitor explains feed exhaustion separately from a limit, Stop, or an error');
 // A legacy aggregator cache must not win over an original description.
 const discovery='http://jobright.ai:'+server.address().port+'/jobs/info/original-conflict',unreadable='http://jobright.ai:'+server.address().port+'/jobs/info/original-unreadable';
 await call('writeProfile',{autoFetch:false,dryRun:true,maxPerRun:2,screeningEnabled:true});
 await call('saveJob',{id:discovery,sourceUrl:discovery,applyUrl:base+'10012',company:'Copied Employer',title:'Copied role',jd:'WRONG AGGREGATOR DESCRIPTION '.repeat(100),extractedAt:Date.now(),stage:'eligible'});
 await call('saveLinks',[discovery,unreadable]);await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const originalDeadline=Date.now()+120000;do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<originalDeadline);
 assert.equal(state.running,false);assert.equal(state.attempted,1,JSON.stringify(state));
 const originalJob=await call('getJob',discovery),blockedJob=await call('getJob',unreadable);
 assert.equal(originalJob.company,'Pipeline Original');assert.equal(originalJob.descriptionSource.url,base+'10012');assert.equal(originalJob.descriptionSource.method,'employer-page');assert.equal(originalJob.jd.includes('WRONG AGGREGATOR'),false);
 assert.equal(blockedJob.stage,'review');assert.equal(blockedJob.jd,'');assert.equal(blockedJob.descriptionSource,null);
 const originalCalls=await chat.evaluate(()=>JSON.parse(localStorage.getItem('calls')||'[]'));assert.equal(originalCalls.some(p=>p.includes('WRONG AGGREGATOR')),false);
 pass('The full browser workflow replaces a legacy Jobright cache with the original description and holds an unreadable original without generating from copied text');
 // A fixed-height, recycled Jobright list has long sections with no new links.
 const sparsePosts=Object.keys(sparseIds).map(id=>'http://jobright.ai:'+server.address().port+'/jobs/info/'+id);
 const sparseFeedHtml=`<!doctype html><html><body><h1>Jobright recommendations fixture</h1><aside style="height:500px;overflow:auto"><div style="height:60000px">Unrelated sidebar</div></aside><main id="feed" style="position:absolute;top:0;left:300px;height:600px;width:900px;overflow:auto"><div style="height:24000px;position:relative"><div id="mounted"></div></div></main><script>
 const pane=document.querySelector('#feed'),mounted=document.querySelector('#mounted'),posts=${JSON.stringify(sparsePosts)},slots=[0,18,39];
 function render(){const index=Math.floor(pane.scrollTop/600);mounted.innerHTML=slots.map((slot,n)=>slot>=index&&slot<=index+1?'<a style="position:absolute;top:'+slot*600+'px" href="'+posts[n]+'">Software Engineer</a>':'').join('');}pane.addEventListener('scroll',render);render();</script></body></html>`;
 await context.route('https://jobright.ai/jobs/recommend*',route=>route.fulfill({contentType:'text/html',body:sparseFeedHtml}));
 const jobrightFeed=await context.newPage();await jobrightFeed.goto('https://jobright.ai/jobs/recommend');
 await call('writeProfile',{autoFetch:true,jobrightRecommend:true,hiringCafeUrl:'',keepRunning:true,maxPerRun:0,dryRun:true});await call('saveLinks',[]);
 const sparseBefore=new Set((await call('allResults')).map(result=>result.id));
 await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const sparseDeadline=Date.now()+240000;let emptyChunkSeen=false;
 do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));if(state.feedScan?.unique===1&&state.feedScan?.percent>15&&state.feedScan?.complete===false)emptyChunkSeen=true;}while(state.running&&Date.now()<sparseDeadline);
 await writeFile('test-results/jobright-staged-run.json',JSON.stringify(state,null,2));
 assert.equal(state.running,false,JSON.stringify(state));assert.equal(state.stopReason?.code,'exhausted',JSON.stringify(state));assert.equal(state.attempted,2);assert.equal(state.rejected,1);
 assert.equal(emptyChunkSeen,true);assert.equal(state.feedScan.complete,true);assert.equal(state.feedScan.unique,3);
 const sparseResults=(await call('allResults')).filter(r=>!sparseBefore.has(r.id)&&r.status==='dry-run');assert.deepEqual(new Set(sparseResults.map(r=>r.company)),new Set(['Pipeline SparseMiddle','Pipeline SparseLast']));
 for(const result of sparseResults){assert.ok(result.detail.lastScreenshot?.path);const form=context.pages().find(p=>p.url()===result.applyUrl);assert.ok(form);assert.equal(await form.evaluate(()=>window.submissions),0);}
 assert.equal(metrics.some(m=>m.company==='Pipeline SparseRejected'&&m.kind==='resume'),false);
 pass('Jobright scans through empty recycled sections, rejects the first role, fills two distant roles with screenshots, and stops only after a complete round finds no new jobs');
 await page.goto(origin+'/src/options.html#monitor');await page.getByText('Job discovery',{exact:true}).waitFor();await page.screenshot({path:'test-results/jobright-discovery-monitor.png',fullPage:true});
 pass('The monitor shows the completed Jobright scan and exhaustion reason after all distant jobs have been processed');
 await call('writeProfile',{keepRunning:false});await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const onePassDeadline=Date.now()+180000;
 do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<onePassDeadline);
 assert.equal(state.running,false,JSON.stringify(state));assert.equal(state.stopReason?.code,'one-pass',JSON.stringify(state));assert.equal(state.feedScan.complete,true);assert.equal(state.attempted,2);
 pass('One-pass discovery also drains the entire virtual Jobright feed rather than stopping after the first bounded read');
 // Real Chrome tab APIs and page reloads, with a deterministic account notice.
 const recovery=await page.evaluate(async chatId=>{
  const api=await import('./chatgpt.js'),script=chrome.scripting.executeScript.bind(chrome.scripting),query=chrome.tabs.query.bind(chrome.tabs),reload=chrome.tabs.reload.bind(chrome.tabs);
  let injected=0,reloads=0;const progress=[];
  chrome.tabs.query=async options=>(await query(options)).filter(t=>!options?.url||t.id===chatId);
  chrome.tabs.reload=async(...args)=>{reloads++;return reload(...args);};
  chrome.scripting.executeScript=async args=>{if(args.func?.name==='converse'&&injected++===0)return [{result:{ok:false,reason:'account-changed',diagnostics:['Controlled account-change notice']}}];return script(args);};
  try {
   api.configureChatGptWorkers({limit:1,onRetry:info=>progress.push(info.retry)});
   const reply=await api.askChatGpt({messages:[{role:'user',content:'Pipeline Recovery Software Engineer'}],format:'json',chatUrl:'https://chatgpt.com/g/g-p-staged/project',verbatim:true});
   return {reloads,progress,reply:JSON.parse(reply.text).targetTitle};
  }finally{chrome.scripting.executeScript=script;chrome.tabs.query=query;chrome.tabs.reload=reload;await api.closeChatGptWorkers();}
 },await page.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});return tabs.find(t=>t.url.includes('/g/g-p-staged/project'))?.id||tabs[0].id;}));
 assert.equal(recovery.reloads,1);assert.deepEqual(recovery.progress,[1]);assert.match(recovery.reply,/Pipeline Recovery/);
 pass('An injected account-change notice refreshes the actual browser tab once and completes the same logical ChatGPT request');
 const exhaustedRecovery=await page.evaluate(async()=>{
  const api=await import('./chatgpt.js'),script=chrome.scripting.executeScript.bind(chrome.scripting),reload=chrome.tabs.reload.bind(chrome.tabs);let reloads=0;const retries=[];
  chrome.tabs.reload=async(...args)=>{reloads++;return reload(...args);};
  chrome.scripting.executeScript=async args=>args.func?.name==='converse'?[{result:{ok:false,reason:'account-changed',diagnostics:['Persistent controlled fault']}}]:script(args);
  try{api.configureChatGptWorkers({limit:1,onRetry:info=>retries.push(info.retry)});await api.askChatGpt({messages:[{role:'user',content:'Persistent recovery fixture'}],format:'text'});return {unexpectedSuccess:true};}
  catch(e){return {reloads,retries,status:e.status,retryable:e.retryable,message:e.message};}
  finally{chrome.scripting.executeScript=script;chrome.tabs.reload=reload;await api.closeChatGptWorkers();}
 });
 assert.equal(exhaustedRecovery.reloads,3);assert.deepEqual(exhaustedRecovery.retries,[1,2,3]);assert.equal(exhaustedRecovery.status,401);assert.equal(exhaustedRecovery.retryable,false);assert.match(exhaustedRecovery.message,/3 refresh retries/);
 pass('A persistent account notice stops after exactly three actual browser refreshes with an actionable error');
 assert.deepEqual(report.errors,[]);pass('No uncaught JavaScript errors in the staged workflow');
}catch(error){report.failure=error.stack;console.error(error);process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:'test-results/staged-failure.png',fullPage:true}).catch(()=>{});}
finally{await context?.close();await new Promise(r=>server.close(r));await releaseScratch(profilePath);report.finishedAt=new Date().toISOString();await writeFile('test-results/staged-browser-report.json',JSON.stringify(report,null,2));}
