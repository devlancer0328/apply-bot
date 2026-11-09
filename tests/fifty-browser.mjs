import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {sampleDocument} from '../src/templates.js';
import {chatModeFixture} from './chat-mode-fixture.js';
import {browsersDir,scratchPath,releaseScratch} from './scratch.js';
await mkdir('test-results',{recursive:true});
const root=process.cwd(),receipts=[],uploads=new Map(),report={version:JSON.parse((await readFile('manifest.json','utf8')).replace(/^\uFEFF/,'')).version,startedAt:new Date().toISOString(),checks:[],errors:[]};
const pass=name=>{report.checks.push(name);console.log('PASS '+name);};
const profilePath=scratchPath('fifty-profile'),downloadsPath=scratchPath('fifty-downloads');
let context,page;
const company=id=>'Acceptance Employer '+String(id).padStart(3,'0');
const jd=id=>`${company(id)} is hiring a Software Engineer. This position is fully remote. No travel is required. No security clearance is required. All interviews are conducted remotely. Build accessible production applications with React, TypeScript, careful testing, and maintainable engineering. Collaborate with engineering and product teams to deliver reliable customer experiences. Candidates should have experience designing and shipping well tested software, documenting decisions, reviewing code and communicating clearly with colleagues.`;
const server=createServer(async(req,res)=>{
 const parts=new URL(req.url,'http://fixture.test'),id=Number(parts.pathname.split('/').at(-1));
 if(parts.pathname.startsWith('/upload/')){const buffers=[];for await(const b of req)buffers.push(b);uploads.set(id,Buffer.concat(buffers));res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
 if(parts.pathname.startsWith('/submitted/')){receipts.push(id);res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
 res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
 res.end(`<!doctype html><html><head><title>Engineer at ${company(id)}</title><script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Software Engineer',hiringOrganization:{name:company(id)},description:jd(id)})}</script></head><body><h1>Software Engineer</h1><main id="content"><p>${jd(id)}</p>${id===1?'<p>Thank you for applying: this is only an example, not a receipt.</p>':''}</main><form id="application_form"><label for="first_name">First name *</label><input id="first_name" required><label for="last_name">Last name *</label><input id="last_name" required><label for="email">Email *</label><input id="email" type="email" required><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required><button type="submit">Submit application</button></form><script>
 document.querySelector('#resume').onchange=async e=>{if(e.target.files[0])await fetch('/upload/${id}',{method:'POST',body:e.target.files[0]});};document.querySelector('form').onsubmit=async e=>{e.preventDefault();if(${id}===1)return;await fetch('/submitted/${id}',{method:'POST'});document.title='Application received at ${company(id)}';document.body.innerHTML='<h1>Thank you for applying to ${company(id)}</h1><p>Your application has been received.</p>';};</script></body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://acceptance.greenhouse.io:${server.address().port}/jobs/`;
const resume={...sampleDocument(),coverLetter:'Dear hiring team, I build accessible production applications and welcome the opportunity to discuss the role. Alex Morgan'};
const chat=`<!doctype html><html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><script>
 const documentTemplate=${JSON.stringify(resume).replaceAll('<','\\u003c')};document.querySelector('button').onclick=()=>{const prompt=document.querySelector('textarea').value,mode=document.querySelector('#fixture-mode').dataset.selectedReasoningEffort,company=(prompt.match(/Acceptance Employer \\d+/)||[])[0],research=prompt.includes('Research compensation with live web search.'),id=Number(company.split(' ').at(-1)),url='${base}'+id;
 localStorage.setItem('calls',JSON.stringify([...(JSON.parse(localStorage.getItem('calls')||'[]')),{company,mode,research,at:Date.now()}]));const user=document.createElement('div');user.dataset.userMessageBubble='true';user.textContent=prompt;document.body.append(user);document.querySelector('textarea').value='';if(!location.pathname.includes('/c/'))history.replaceState({},'', '/g/g-p-acceptance/c/'+crypto.randomUUID());
 const result=research?{status:'researched',company,role:'Software Engineer',location:'United States',currency:'USD',period:'year',basis:'base',minimum:140000,maximum:190000,recommendedAmount:173000,rationale:'Controlled exact-company role evidence.',sources:[{url,title:'Engineer at '+company,company,role:'Software Engineer',matchType:'exact-company-role',details:'Employer role pay disclosure.'}]}:{...documentTemplate,targetTitle:company+' Software Engineer'};
 const turn=document.createElement('div');turn.dataset.messageAuthorRole='assistant';turn.style.whiteSpace='pre-wrap';turn.textContent=JSON.stringify(result);if(research){const a=document.createElement('a');a.dataset.testid='webpage-citation';a.href=url;a.textContent='Native company source';turn.append(a);}document.body.append(turn);};</script></body></html>`+chatModeFixture();
try{
 const portable=(await readdir(browsersDir).catch(()=>[])).find(p=>/^chromium-\d+$/.test(p));
 context=await chromium.launchPersistentContext(profilePath,{...(portable?{executablePath:resolve(browsersDir,portable,'chrome-win64/chrome.exe')}:{channel:'chromium'}),downloadsPath,headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--host-resolver-rules=MAP acceptance.greenhouse.io 127.0.0.1','--no-proxy-server'],viewport:{width:1440,height:1050},acceptDownloads:true});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin='chrome-extension://'+new URL(worker.url()).host;
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(origin+'/src/options.html#monitor');
 const call=(method,...args)=>page.evaluate(async({method,args})=>(await import('./store.js'))[method](...args),{method,args});
 await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:chat}));
 const mainChat=await context.newPage();await mainChat.goto('https://chatgpt.com/g/g-p-acceptance/project');
 await call('writeProfile',{firstName:'Alex',lastName:'Morgan',email:'alex@example.test',phone:'5555550100',city:'Seattle',state:'WA',country:'United States',startDate:'Two weeks after offer',workAuthorization:'us-citizen',requiresSponsorship:'no',dryRun:false,exportFiles:true,delayMs:0,maxPerRun:0,maxSubmittedPerRun:50,autoFetch:false,chatGptConcurrency:2,chatGptProjectUrl:'https://chatgpt.com/g/g-p-acceptance/project',screeningEnabled:true,screeningWorkplace:'remote',screeningTravel:'none',screeningClearance:'none',screeningInterview:'none',screeningUnknown:'review'});
 await call('saveLinks',Array.from({length:52},(_,i)=>base+(i+1)));await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const deadline=Date.now()+1200000;let state,last=-1;
 do{await new Promise(r=>setTimeout(r,1000));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));if(state.submitted!==last){last=state.submitted;console.log('Confirmed '+last+'/50; phase '+state.phase);await writeFile('test-results/fifty-browser-progress.json',JSON.stringify({at:Date.now(),state,serverReceipts:receipts},null,2));}}while(state.running&&Date.now()<deadline);
 assert.equal(state.running,false,JSON.stringify(state));assert.equal(state.stopReason.code,'target',JSON.stringify(state));assert.equal(state.submitted,50);assert.equal(state.attempted,51);assert.deepEqual(new Set(receipts),new Set(Array.from({length:50},(_,i)=>i+2)));assert.equal(receipts.length,50);
 pass('An unattended browser run records exactly fifty server-confirmed submissions; an uncertain attempt does not count and job 52 is never submitted');
 const results=await call('allResults'),confirmed=results.filter(r=>r.status==='submitted'),resumes=await call('allResumes');assert.equal(confirmed.length,50);assert.equal(results.find(r=>r.applyUrl===base+'1').status,'unconfirmed');
 assert.equal(new Set(confirmed.map(r=>r.company)).size,50);assert.equal(state.review,0);assert.equal(state.rejected,0);assert.equal(confirmed.every(r=>r.detail.lastScreenshot&&!r.detail.screenshotError&&r.detail.boardSaid),true);
 pass('Every confirmed employer is unique, all strict evidence filters pass, and every confirmation retains a final screenshot and board receipt');
 for(const result of confirmed){
  const id=Number(result.applyUrl.split('/').at(-1)),saved=resumes.find(r=>r.job.company===result.company);assert.ok(saved);assert.equal(saved.aiMode.selected,'high');assert.equal(saved.document.name,'Alex Morgan');assert.equal(saved.document.targetTitle,result.company+' Software Engineer');
  const pdf=uploads.get(id);assert.ok(pdf?.subarray(0,5).equals(Buffer.from('%PDF-')));assert.ok((await PDFDocument.load(pdf)).getPageCount()>0);
  const evidence=await page.evaluate(async path=>{const{db}=await import('./store.js'),file=await db({action:'get',table:'files',id:path});const bytes=new Uint8Array(await file.content.arrayBuffer());return {length:bytes.length,signature:[...bytes.slice(0,8)]};},result.detail.lastScreenshot.path);
  assert.ok(evidence.length>5000);assert.deepEqual(evidence.signature,[137,80,78,71,13,10,26,10]);assert.equal(result.detail.lastScreenshot.url,result.applyUrl);
  assert.ok(result.detail.timings.workflow>=result.detail.timings.application);assert.ok(result.detail.timings.application>=result.detail.timings.screenshot);assert.ok(result.completedAt>=result.at);
 }
 pass('All fifty uploaded resumes are valid PDFs for the correct candidate/employer, all fifty final images are real PNGs for the correct application, and timing boundaries are consistent');
 const calls=await mainChat.evaluate(()=>JSON.parse(localStorage.getItem('calls')||'[]'));assert.equal(calls.length,51);assert.equal(calls.every(c=>c.mode==='high'&&!c.research),true);
 pass('Every resume uses High; forms without pay questions make zero compensation calls (51 AI requests for 50 receipts plus one uncertain attempt)');
 const history=await call('allHistory');assert.equal(new Set(history.map(r=>r.company)).size,51);await call('saveLinks',[base+'2']);await call('writeProfile',{maxSubmittedPerRun:0,maxPerRun:1});await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
 const duplicateDeadline=Date.now()+30000;do{await new Promise(r=>setTimeout(r,500));state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));}while(state.running&&Date.now()<duplicateDeadline);assert.equal(state.attempted,0);assert.equal(receipts.length,50);
 pass('A subsequent run cannot reapply to any already submitted company');
 assert.deepEqual(report.errors,[]);report.confirmed=50;report.serverReceipts=receipts;report.results=confirmed.map(r=>({company:r.company,url:r.applyUrl,timings:r.detail.timings,screenshot:r.detail.lastScreenshot.path}));
}catch(error){report.failure=error.stack;console.error(error);process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:'test-results/fifty-browser-failure.png',fullPage:true}).catch(()=>{});}
finally{await context?.close();await new Promise(r=>server.close(r));await releaseScratch(profilePath);await releaseScratch(downloadsPath);report.finishedAt=new Date().toISOString();await writeFile('test-results/fifty-browser-report.json',JSON.stringify(report,null,2));}
