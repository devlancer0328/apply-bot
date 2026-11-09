import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir,readdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sampleDocument} from '../src/templates.js';
import {chatModeFixture} from './chat-mode-fixture.js';
import {browsersDir,scratchPath,releaseScratch} from './scratch.js';
await mkdir('test-results',{recursive:true});
const report={startedAt:new Date().toISOString(),checks:[],errors:[]},metrics=[],receipts=[],uploads=new Map();
const pass=name=>{report.checks.push(name);console.log('PASS '+name);};
const company=id=>'Speed Employer '+id;
let fixCountry=false;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture.test'),id=Number(url.pathname.split('/').at(-1));
 if(url.pathname==='/metric'){const body=[];for await(const b of req)body.push(b);metrics.push(JSON.parse(Buffer.concat(body)));res.writeHead(200);res.end('{}');return;}
 if(url.pathname.startsWith('/receipt/')){receipts.push({id,at:Date.now()});res.writeHead(200);res.end('{}');return;}
 if(url.pathname.startsWith('/upload/')){const body=[];for await(const b of req)body.push(b);uploads.set(id,Buffer.concat(body));res.writeHead(200);res.end('{}');return;}
 const jd=`${company(id)} is hiring a Software Engineer. This position is fully remote throughout the United States. No travel is required for this position. Build accessible production software with careful testing, performance measurements and documentation. Collaborate with engineers and product teams to deliver maintainable customer applications using React and TypeScript. Candidates should have experience shipping reliable applications, reviewing code, documenting decisions and communicating clearly with colleagues.`;
 const cover=id===3?'<label for="cover_letter">Cover letter *</label><textarea id="cover_letter" name="cover_letter" required></textarea>':'<label for="cover_letter">Cover letter</label><input id="cover_letter" name="cover_letter" type="file">';
 const blocked=id===4&&!fixCountry?'<label for="country">Country *</label><select id="country" required><option value="">Select</option><option>France</option><option>United Kingdom</option></select><label for="salary">Expected salary *</label><input id="salary" required>':'';
 res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
 res.end(`<!doctype html><html><head><title>Engineer at ${company(id)}</title><script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Software Engineer',description:jd,hiringOrganization:{name:company(id)}})}</script></head><body><h1>Software Engineer</h1><main id="content"><p>${jd}</p></main><form id="application_form"><label for="first_name">First name *</label><input id="first_name" required><label for="last_name">Last name *</label><input id="last_name" required><label for="email">Email *</label><input id="email" type="email" required><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required>${cover}${blocked}<button type="submit">Submit application</button></form><script>document.querySelector('#resume').onchange=async e=>{if(e.target.files[0])await fetch('/upload/${id}',{method:'POST',body:e.target.files[0]});};document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/receipt/${id}',{method:'POST'});document.body.innerHTML='<h1>Thank you for applying</h1><p>Your application has been received at ${company(id)}.</p>';};</script></body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://speed.greenhouse.io:${server.address().port}`;
const document=sampleDocument();
const chat=`<!doctype html><html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><script>
 const resume=${JSON.stringify(document).replaceAll('<','\\u003c')};document.querySelector('button').onclick=()=>{
 const prompt=document.querySelector('textarea').value,id=Number(prompt.match(/Speed Employer (\\d+)/)?.[1]),kind=prompt.includes('Write a concise professional cover letter')?'letter':prompt.includes('compensation with live web search')?'salary':'resume',mode=document.querySelector('#fixture-mode').dataset.selectedReasoningEffort;
 const metric=phase=>fetch('/fixture-metric',{method:'POST',body:JSON.stringify({id,kind,phase,mode,at:Date.now()})});metric('start');
 const user=document.createElement('div');user.dataset.userMessageBubble='true';user.textContent=prompt;document.body.append(user);document.querySelector('textarea').value='';history.replaceState({},'', '/c/'+crypto.randomUUID());
 const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);
 setTimeout(()=>{const turn=document.createElement('div');turn.dataset.messageAuthorRole='assistant';turn.style.whiteSpace='pre-wrap';turn.textContent=kind==='letter'?'Dear hiring team, I build accessible production applications with React and TypeScript and would welcome the opportunity to contribute. Alex Morgan':JSON.stringify({...resume,targetTitle:'Software Engineer at Speed Employer '+id});document.body.append(turn);stop.remove();metric('end');},kind==='resume'&&id===2?16000:1000);
 };</script></body></html>`+chatModeFixture();
const profilePath=scratchPath('throughput-profile');
let context;
try{
 const portable=(await readdir(browsersDir).catch(()=>[])).find(x=>/^chromium-\d+$/.test(x));
 context=await chromium.launchPersistentContext(profilePath,{...(portable?{executablePath:resolve(browsersDir,portable,'chrome-win64/chrome.exe')}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${process.cwd()}`,`--load-extension=${process.cwd()}`,'--host-resolver-rules=MAP speed.greenhouse.io 127.0.0.1','--no-proxy-server'],viewport:{width:1440,height:1050}});
 await context.route('https://chatgpt.com/**',route=>{
  if(new URL(route.request().url()).pathname==='/fixture-metric'){metrics.push(JSON.parse(route.request().postData()));return route.fulfill({contentType:'application/json',body:'{}'});}
  return route.fulfill({contentType:'text/html',body:chat});
 });
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin='chrome-extension://'+new URL(worker.url()).host;
 const main=await context.newPage();await main.goto('https://chatgpt.com/g/g-p-speed/project');
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(origin+'/src/options.html#settings');
 const call=(method,...args)=>page.evaluate(async({method,args})=>(await import('./store.js'))[method](...args),{method,args});
 await call('writeProfile',{firstName:'Alex',lastName:'Morgan',email:'alex@example.test',phone:'5555550100',city:'Seattle',state:'WA',country:'United States',startDate:'Two weeks after offer',workAuthorization:'us-citizen',requiresSponsorship:'no',dryRun:false,exportFiles:false,delayMs:0,autoFetch:false,maxPerRun:0,maxSubmittedPerRun:2,chatGptProjectUrl:'https://chatgpt.com/g/g-p-speed/project',chatGptConcurrency:2});
 const run=async(ids)=>{
  await call('saveLinks',ids.map(id=>base+'/jobs/'+id));await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
  const deadline=Date.now()+150000;let state;
  do{await new Promise(r=>setTimeout(r,400));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while((state.running||!state.finishedAt)&&Date.now()<deadline);
  assert.equal(state.running,false,JSON.stringify(state.log.slice(-10)));return state;
 };
 const first=await run([1,2]);report.firstRun=first;assert.equal(first.submitted,2,JSON.stringify(first.log.slice(-12)));assert.equal(receipts.length,2);
 const slowEnd=metrics.find(m=>m.id===2&&m.kind==='resume'&&m.phase==='end');assert.ok(slowEnd);assert.ok(receipts.find(x=>x.id===1).at<slowEnd.at,JSON.stringify({receipts,metrics}));
 pass('The actual browser pipeline confirms a ready application before its slower High-mode peer finishes');
 assert.equal(metrics.filter(m=>m.phase==='start').length,2);assert.equal(metrics.every(m=>m.kind==='resume'&&m.mode==='high'),true);
 pass('Two forms without pay requirements or required letters use exactly two High requests and zero support requests');
 const results=await call('allResults');for(const result of results){assert.equal(result.status,'submitted');assert.ok(result.detail.lastScreenshot?.path);assert.equal(result.detail.compensation.status,'not-requested');assert.ok(uploads.get(Number(result.applyUrl.split('/').at(-1)))?.subarray(0,4).equals(Buffer.from('%PDF')));}
 pass('Both receipts have saved final screenshots, uploaded PDFs and no invented compensation');
 await call('writeProfile',{maxSubmittedPerRun:1});const letterAt=metrics.length;const letterRun=await run([3]);assert.equal(letterRun.submitted,1);
 const letterCalls=metrics.slice(letterAt).filter(m=>m.phase==='start');assert.deepEqual(letterCalls.map(x=>x.kind),['resume','letter']);assert.deepEqual(letterCalls.map(x=>x.mode),['high','medium']);
 const letterJob=await call('getJob',base+'/jobs/3'),saved=await call('getResume',letterJob.resumeId);assert.ok(saved.letterPdf);assert.match(saved.letter,/Dear hiring team/);assert.match(letterJob.applicationData.letterText,/Dear hiring team/);
 pass('A required text cover letter is generated once in Medium, filled and persisted without repeating High');
 assert.equal(main.url(),'https://chatgpt.com/g/g-p-speed/project');
 pass('Resume, form and cover-letter workers leave the user project tab untouched');
 await call('writeProfile',{maxPerRun:1,maxSubmittedPerRun:0});const blockedAt=metrics.length;const blockedRun=await run([4]);assert.equal(blockedRun.submitted,0);assert.equal(receipts.some(x=>x.id===4),false);
 assert.equal(metrics.slice(blockedAt).filter(m=>m.phase==='start').length,1);
 const manual=(await call('allResults')).find(r=>r.company===company(4));assert.equal(manual.status,'manual');assert.equal(manual.detail.submissionAttempted,false);
 pass('A known unsupported profile choice is held before spending requests on compensation or other support');
 fixCountry=true;await page.goto(origin+'/src/options.html#jobs');await page.getByRole('heading',{name:'Jobs',exact:true}).waitFor();await page.locator(`[data-action="job-detail"][data-id="${base}/jobs/4"]`).click();await page.locator('[data-action="recheck-job"]').click();
 const recoveryAt=metrics.length,recovered=await run([4]);assert.equal(recovered.submitted,1);assert.equal(receipts.filter(x=>x.id===4).length,1);assert.equal(metrics.length,recoveryAt);
 pass('Recheck safely recovers a proven pre-submit failure using the saved High PDF and submits exactly once');
 const wd=await context.newPage(),wdSource=await readFile('src/workday.js','utf8');
 for(const broken of [false,true]){
  await wd.goto('about:blank');await wd.setContent(`<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowVoluntaryDisclosuresPage"><div data-automation-id="formField-race"><label for="race">Race *</label><button id="race" aria-required="true" aria-haspopup="listbox" aria-controls="choices" aria-expanded="false">${broken?'American Indian or Alaska Native (United States of America)':'Select One'}</button></div></section><button data-automation-id="pageFooterNextButton">Continue</button></main><ul id="choices" role="listbox" hidden><li role="option">American Indian or Alaska Native (United States of America)</li><li role="option">Asian (United States of America)</li></ul><script>const b=document.querySelector('#race'),list=document.querySelector('#choices');b.onclick=()=>{list.hidden=!list.hidden;b.setAttribute('aria-expanded',String(!list.hidden));};for(const row of list.children)row.onclick=()=>{if(!${broken})b.textContent=row.textContent;list.hidden=true;b.setAttribute('aria-expanded','false');};document.addEventListener('keydown',e=>{if(e.key==='Escape'){list.hidden=true;b.setAttribute('aria-expanded','false');}});</script>`);
  await wd.addScriptTag({content:wdSource});
  const proof=await wd.evaluate(async()=>{const field=window.__wdApply.inventory().fields.find(x=>/race/i.test(x.label));return window.__wdApply.apply({fills:[{key:field.key,value:'Asian',candidates:['Asian'],replace:true}],attachments:[]});});
  if(broken){assert.equal(proof.applied.length,0);assert.equal(proof.failed.length,1);}
  else{assert.equal(proof.applied.length,1);assert.equal(Object.values(proof.values)[0],'Asian (United States of America)');}
 }
 pass('Workday demographic fills verify the selected label, report actual values, and reject a click that retained another identity');
 await wd.goto('about:blank');await wd.setContent('<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowVoluntaryDisclosuresPage"><div data-automation-id="formField-race"><legend>Race *</legend><label><input type="radio" name="race" required>American Indian or Alaska Native (United States of America)</label><label><input type="radio" name="race" required>Asian (United States of America)</label></div></section><button data-automation-id="pageFooterNextButton">Continue</button></main>');await wd.addScriptTag({content:wdSource});
 const radioFields=await wd.evaluate(()=>window.__wdApply.inventory().fields),radioPlan=await page.evaluate(async fields=>(await import('./answers.js')).resolveForm(fields,{race:'East Asian',hispanic:'no'},{}),radioFields);
 const radioProof=await wd.evaluate(plan=>window.__wdApply.apply(plan),radioPlan);assert.equal(radioProof.applied.length,1);assert.equal(Object.values(radioProof.values)[0],'Asian (United States of America)');
 pass('Workday radio groups sharing the default on value select and record the profile-matching identity');
 await wd.goto('about:blank');await wd.setContent('<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowSelfIdentifyPage"><div data-automation-id="formField-disabilityStatus"><legend>Please check one of the boxes below:</legend><label><input type="checkbox" checked>Yes, I have a disability, or have had one in the past</label><label><input type="checkbox">No, I do not have a disability and have not had one in the past</label><label><input type="checkbox">I do not want to answer</label></div></section><button data-automation-id="pageFooterNextButton">Save and Continue</button></main>');await wd.addScriptTag({content:wdSource});
 const selfFields=await wd.evaluate(()=>{if(window.__wdApply.state().kind!=='selfid')throw new Error('Self-identification page alias missing');return window.__wdApply.inventory().fields;});assert.equal(selfFields.length,1);assert.equal(selfFields[0].required,true);assert.match(selfFields[0].label,/Disability/);
 const selfPlan=await page.evaluate(async fields=>(await import('./answers.js')).resolveForm(fields,{disability:'No'},{}),selfFields);assert.equal(selfPlan.questions.length,0);assert.equal(selfPlan.blocked.length,0);
 const selfProof=await wd.evaluate(plan=>window.__wdApply.apply(plan),selfPlan);assert.equal(selfProof.applied.length,1);assert.equal(Object.values(selfProof.values)[0],'No, I do not have a disability and have not had one in the past');assert.equal(await wd.locator('input:checked').count(),1);
 const emptyPlan=await page.evaluate(async fields=>(await import('./answers.js')).resolveForm(fields,{},{}),selfFields);assert.equal(emptyPlan.blocked.length,1);assert.equal(emptyPlan.questions.length,0);await wd.close();
 pass('Workday CC-305 checkbox choices replace stale selections using the saved disability answer with zero AI; missing facts are held before Continue');
 assert.deepEqual(report.errors,[]);report.metrics=metrics;report.receipts=receipts;report.firstRun=first;report.supportCalls=metrics.filter(m=>m.phase==='start');
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{await context?.close();await new Promise(r=>server.close(r));await releaseScratch(profilePath);report.metrics=metrics;report.receipts=receipts;report.finishedAt=new Date().toISOString();await writeFile('test-results/throughput-browser-report.json',JSON.stringify(report,null,2));}
