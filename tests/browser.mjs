import {chatModeFixture} from './chat-mode-fixture.js';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { createServer } from 'node:http';
import {demographicFixture} from './demographic-fixture.js';
import {browsersDir,scratchPath,releaseScratch} from './scratch.js';

const root = resolve(fileURLToPath(new URL('..',import.meta.url)));
process.chdir(root);
await mkdir('test-results',{recursive:true});
const portable = (await readdir(browsersDir).catch(() => [])).find(p => /^chromium-\d+$/.test(p));
const executablePath = portable ? resolve(browsersDir,portable,'chrome-win64/chrome.exe') : undefined;
const profilePath = scratchPath('test-profile');
const report = { startedAt:new Date().toISOString(), checks:[], errors:[], liveSite:null };
const pass = (name,details) => { console.log(`PASS ${name}`); report.checks.push({name,details}); };
let context, page, origin;
// Declared out here so the finally block can clean up whichever of the three
// scratch profiles this run got as far as creating.
let historyRoot, migrationPath;
let fixtureHtml = '';
const fixtureServer = createServer((request,response) => {
  if(request.url.startsWith('/upload/')) {request.resume();request.on('end',()=>{response.writeHead(200,{'Content-Type':'application/json'});response.end('{"uploaded":true}');});return;}
  response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}); response.end(fixtureHtml);
});
await new Promise(resolve => fixtureServer.listen(0,'127.0.0.1',resolve));
async function launch(path = profilePath) {
  context = await chromium.launchPersistentContext(path,{ ...(executablePath ? {executablePath} : {channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--host-resolver-rules=MAP examplecareers.greenhouse.io 127.0.0.1','--no-proxy-server'],viewport:{width:1440,height:1050},acceptDownloads:true });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:20000});
  origin = new URL(worker.url()).origin;
  // URL.origin is "null" for extension URLs in Node.
  origin = `chrome-extension://${new URL(worker.url()).host}`;
  page = await context.newPage();
  page.on('pageerror',error => report.errors.push(error.message));
  page.on('dialog',dialog => dialog.accept());
  await page.goto(`${origin}/src/options.html`);
  await page.getByRole('heading',{name:'A little more organized. A lot more you.'}).waitFor();
}
async function route(hash) { await page.evaluate(hash => { location.hash = hash; },hash); await page.waitForFunction(() => document.getElementById('content').getAttribute('aria-busy') === 'false'); await page.waitForTimeout(180); }
const call = (method,...args) => page.evaluate(async ({method,args}) => (await import('./store.js'))[method](...args),{method,args});
const action = name => page.locator(`[data-action="${name}"]`);
async function startTestRun() {
  let state;
  do {state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));if(state.running)await new Promise(resolve=>setTimeout(resolve,100));} while(state.running);
  const old=state.log[0]?.at;
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'run'}));
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {state=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));if(state.log.length && state.log[0].at!==old)return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Run did not start: '+JSON.stringify(state));
}
async function field(key,value) { await page.locator(`[data-key="${key}"]`).fill(value); }
// Action handlers are async; click() resolves once the event is dispatched, not
// once the handler has written to the store. Every handler ends in notify(), so
// the notice is the signal that the work actually landed.
async function clickAndSettle(name,message) {
  await action(name).click();
  await page.waitForFunction(expected => {
    const notice = document.getElementById('notice');
    return notice && !notice.hidden && notice.textContent.includes(expected);
  },message,{timeout:15000});
}
try {
  await launch();
  assert.equal((await call('db',{action:'stats'})).engine,'SQLite');
  assert.equal((await call('readProfile')).dryRun,true);
  pass('Unpacked Manifest V3 extension opens in Chromium with persistent SQLite');
  await page.screenshot({path:'test-results/overview.png',fullPage:true});

  await route('templates'); await action('new-template').click();
  await page.locator('[data-action="template-save"]').waitFor();
  await field('name','Midnight professional');
  await page.locator('[data-key="theme.fontFamily"]').selectOption('Courier New');
  await field('theme.accentColor','#155e75');
  await field('theme.baseSize','11');
  await page.locator('[data-move="0"][data-direction="1"]').click();
  await action('template-save').click();
  await page.locator('.pdf-pages canvas').first().waitFor({timeout:15000});
  let templates = await call('allTemplates'), template = templates.find(t => t.name === 'Midnight professional');
  assert.equal(template.sections[0].id,'skills'); assert.equal(template.theme.accentColor,'155e75');
  await page.screenshot({path:'test-results/template-studio.png',fullPage:true});
  await action('back-templates').click(); await page.locator(`[data-action="activate-template"][data-id="${template.id}"]`).click();
  assert.equal((await call('readProfile')).activeTemplateId,template.id);
  pass('Visual template editor: typography, color, section order, live PDF, save and activation');

  await route('resumes'); await action('new-resume').click(); await action('resume-save').waitFor();
  await field('name','Frontend engineering'); await field('document.name','Alex Morgan'); await field('document.targetTitle','Software Engineer');
  await field('document.contact.email','alex@example.test'); await field('document.contact.phone','555-0100'); await field('document.contact.location','Seattle, WA');
  await page.locator('#resume-summary').fill('Software engineer building accessible applications with TypeScript and React.');
  await action('add-role').click();
  await field('document.sections.2.roles.0.company','Example Software'); await field('document.sections.2.roles.0.role','Software Engineer');
  await field('document.sections.2.roles.0.location','Seattle'); await field('document.sections.2.roles.0.startDate','Jan 2022');
  await page.locator('#role-bullets-0').fill('Built accessible interfaces with React and TypeScript.\nImproved performance using measured browser traces.');
  await page.locator('[data-action="add-entry"][data-section-id="education"]').click();
  await field('document.sections.3.entries.0.title','B.S. Computer Science'); await field('document.sections.3.entries.0.subtitle','Example University'); await field('document.sections.3.entries.0.right','2021');
  await action('resume-save').click();
  await page.locator('.pdf-pages canvas').first().waitFor();
  let records = await call('allResumes'), resume = records.find(r => r.name === 'Frontend engineering');
  assert.equal(resume.document.sections[2].roles[0].company,'Example Software');
  await page.screenshot({path:'test-results/resume-editor.png',fullPage:true});
  await action('back-resumes').click(); assert.equal(await action('activate-resume').count(),0);
  assert.equal((await call('getResume',resume.id)).document.sections[3].entries[0].title,'B.S. Computer Science');
  await page.locator('#resume-search').fill('does not exist'); assert.equal(await page.locator('.resume-card').count(),0); await page.locator('#resume-search').fill('Frontend'); assert.equal(await page.locator('.resume-card').count(),1);
  await page.locator(`[data-action="resume-menu"][data-id="${resume.id}"]`).click();
  await page.locator(`[data-action="duplicate-resume"][data-id="${resume.id}"]`).click();
  await action('resume-save').waitFor(); await action('back-resumes').click();
  assert.equal((await call('allResumes')).length,2);
  pass('Resume library: create, edit, preview, education, search and duplicate without a generation-input selector');

  await page.locator('#resume-import').setInputFiles({name:'imported.txt',mimeType:'text/plain',buffer:Buffer.from('Alex Morgan\nSoftware Engineer\nExample Software\nJan 2022 - Present\nBuilt React applications.')});
  await action('structure-resume').waitFor();
  assert.match(await page.locator('#source-content').inputValue(),/Example Software/);
  await action('back-resumes').click();
  pass('Text import is retained and explicitly requires review before activation');

  const pdfBytes = await page.evaluate(async id => {
    const record = await (await import('./store.js')).getResume(id);
    const {buildDocumentPdf} = await import('./vendor/generation.js');
    return [...await buildDocumentPdf(record.document)];
  },resume.id);
  await page.locator('#resume-import').setInputFiles({name:'pdf-import.pdf',mimeType:'application/pdf',buffer:Buffer.from(pdfBytes)});
  await action('structure-resume').waitFor();
  assert.match(await page.locator('#source-content').inputValue(),/Example Software/);
  assert.ok((await call('allResumes')).find(r => r.name === 'pdf-import').originalPdf);
  await action('back-resumes').click();
  pass('PDF import extracts readable text locally and retains the original PDF');

  await route('profile');
  for (const [key,value] of Object.entries({firstName:'Alex',lastName:'Morgan',email:'alex@example.test',phone:'555-0100',city:'Seattle',state:'Washington',country:'United States',startDate:'Two weeks after offer'})) await field(key,value);
  await page.locator('[data-key="workAuthorization"]').selectOption('us-citizen'); await page.locator('[data-key="requiresSponsorship"]').selectOption('no');
  await clickAndSettle('save-settings','Changes saved.');
  assert.equal((await call('readProfile')).firstName,'Alex');
  await route('settings');
  assert.equal(await page.locator('[data-key="companySize"],[data-key="formatPrompt"],[data-key="degree"],[data-key="experience"],[data-key="salaryFallback"],[data-key="activeResumeId"]').count(),0);
  assert.equal(await page.locator('[data-key="dryRun"]').isChecked(),true);
  await action('save-settings').click();
  pass('Profile/settings persist, review mode defaults on, removed career controls are absent');

  await route('sources');
  await field('pastedLinks','https://boards.greenhouse.io/example/jobs/123\nhttps://boards.greenhouse.io/example/jobs/123?utm_source=test\nhttps://jobs.lever.co/example/456');
  await clickAndSettle('load-links','2 unique job links loaded.');
  assert.equal((await call('allLinks')).links.length,2);
  pass('Job links load and deduplicate through the new workspace');

  await route('history');
  const oldCompanies=Array.from({length:350},(_,i)=>`Previously Applied ${i+1}`);
  await page.locator('#history-companies').fill([...oldCompanies,oldCompanies[0]+' Inc.'].join('\n'));
  await action('preview-companies').click();
  await page.getByText('350 new company entries', {exact:false}).waitFor();
  assert.equal((await call('allHistory')).length,0);
  await action('commit-history').click();
  await page.getByRole('heading',{name:'Protected companies'}).waitFor();
  assert.equal((await call('allHistory')).length,350);
  await call('importHistory',oldCompanies.map(company=>({company})));
  assert.equal((await call('allHistory')).length,350);
  pass('350 applied companies preview without writing, then import atomically and remain idempotent');

  historyRoot=scratchPath('history-folder');const folderPath=resolve(historyRoot,'Daniel');
  const rolePath=resolve(folderPath,'4MINDS','Forward Deployed Engineer'); await mkdir(rolePath,{recursive:true});
  await writeFile(resolve(rolePath,'job-link.txt'),'https://jobright.ai/jobs/info/previous-4minds-role');
  await writeFile(resolve(rolePath,'Resume.pdf'),'Unread resume fixture');
  await writeFile(resolve(rolePath,'job-description.txt'),'Description fixture');
  await page.locator('#history-folder').setInputFiles(folderPath);
  await page.getByText('1 new company entries',{exact:false}).waitFor();
  assert.equal((await call('allHistory')).length,350);
  assert.equal(await page.locator('#history-name-match').count(),0);
  await action('commit-history').click();
  await page.getByRole('heading',{name:'Protected companies'}).waitFor();
  const importedFolder=(await call('allHistory')).find(r=>r.company==='4MINDS');
  assert.equal(importedFolder.title,'Forward Deployed Engineer'); assert.equal(importedFolder.company,'4MINDS');
  await page.locator('#history-search').fill('4MINDS'); assert.equal(await page.locator('#history-table tbody tr').count(),1);
  await page.screenshot({path:'test-results/already-applied.png',fullPage:true});
  pass('Real directory picker imports job-link.txt, infers company/role and ignores resume files');

  await call('importHistory',[{applyUrl:'https://jobright.ai/jobs/info/company-not-yet-known'}]);
  const unresolvedEntry=(await call('allHistory')).find(r=>r.applyUrl?.includes('company-not-yet-known'));
  await startTestRun();
  await page.waitForFunction(async()=>{const s=await chrome.runtime.sendMessage({type:'state'});return !s.running && s.log.some(e=>e.message.includes('unknown company'));});
  await call('setHistoryCompany',unresolvedEntry.id,'Resolved Company',['Old Brand']);
  assert.equal((await call('allHistory')).find(r=>r.id===unresolvedEntry.id).companyAliases[0],'Old Brand');
  pass('Unknown imported company names block the entire run until resolved; aliases are retained');

  const claimJob={applyUrl:'https://boards.greenhouse.io/claim-test/jobs/7654321',company:'Claim Test',title:'Engineer'};
  const claims=await Promise.all([call('claimSubmission',claimJob),call('claimSubmission',{...claimJob,company:'Claim Test, Inc.',title:'Different role',applyUrl:'https://jobs.lever.co/different-board/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'})]);
  assert.equal(claims.filter(r=>r.claimed).length,1);
  assert.equal((await call('allHistory')).filter(r=>r.kind==='submission').length,1);
  const blocked=await call('claimSubmission',{applyUrl:'https://example.test/another-role',company:oldCompanies[0]}); assert.equal(blocked.claimed,false);
  const countBefore=(await call('allHistory')).length;
  await assert.rejects(call('db',{action:'replace',table:'history',value:[{id:'should-roll-back',applyUrl:'https://example.test/rollback'},{}]}));
  assert.equal((await call('allHistory')).length,countBefore);
  pass('Concurrent submission claims allow one sender; imported jobs block submission; SQL failures roll back atomically');

  const owner=context.serviceWorkers()[0];
  await owner.evaluate(()=>{globalThis.originalWritable=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(){throw new Error('Controlled disk failure');};});
  try { await assert.rejects(call('importHistory',[{applyUrl:'https://example.test/must-not-survive',company:'Disk failure'}])); }
  finally { await owner.evaluate(()=>{FileSystemFileHandle.prototype.createWritable=globalThis.originalWritable;delete globalThis.originalWritable;}); }
  assert.equal((await call('allHistory')).length,countBefore);
  assert.equal((await call('allHistory')).some(r=>(r.applyUrl || '').includes('must-not-survive')),false);
  pass('Failed filesystem writes recover from the last durable SQLite file without losing applied history');

  await page.evaluate(async () => {
    const {db,recordResult} = await import('./store.js');
    await Promise.all(Array.from({length:8},(_,i) => db({action:'put',table:'files',value:{id:`test/file-${i}.txt`,path:`test/file-${i}.txt`,content:new Blob([`file ${i}`]),at:Date.now()}})));
    await recordResult({id:'result-1',company:'Example Software',title:'Software Engineer',status:'submitted',applyUrl:'https://example.test/jobs/1',at:Date.now(),detail:{folder:'test'}});
    await recordResult({id:'result-1',company:'Example Software',status:'failed',at:Date.now()});
  });
  assert.equal((await call('allResults'))[0].status,'submitted');
  const file = await page.evaluate(async () => { const f = await (await import('./store.js')).db({action:'get',table:'files',id:'test/file-2.txt'}); return {blob:f.content instanceof Blob,text:await f.content.text()}; });
  assert.deepEqual(file,{blob:true,text:'file 2'});
  await route('activity'); await action('application-detail').click(); assert.equal(await action('download-file').count(),8);
  pass('SQLite serializes concurrent writes, round-trips Blobs and preserves submitted outcomes');

  await route('settings');
  const [download] = await Promise.all([page.waitForEvent('download'),action('backup').click()]);
  const backupPath = resolve('test-results/workspace-backup.sqlite3'); await download.saveAs(backupPath);
  const sqlite = await initSqlJs(), database = new sqlite.Database(new Uint8Array(await readFile(backupPath)));
  assert.equal(database.exec('PRAGMA integrity_check')[0].values[0][0],'ok');
  assert.equal(database.exec('SELECT COUNT(*) FROM files')[0].values[0][0],8); database.close();
  await call('deleteResume',resume.id);
  await page.locator('#backup-import').setInputFiles(backupPath);
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('backup restored'));
  assert.equal((await call('getResume',resume.id)).name,'Frontend engineering');
  await assert.rejects(call('db',{action:'import',value:Buffer.from('not a SQLite database').toString('base64')}));
  assert.equal((await call('getResume',resume.id)).name,'Frontend engineering');
  pass('Export is a valid SQLite file; restoring it recovers deleted records and binary files');
  pass('Invalid database imports are rejected without changing existing records');
  const oldDatabase=new sqlite.Database(new Uint8Array(await readFile(backupPath)));
  oldDatabase.run('DROP TABLE history');
  oldDatabase.run("DELETE FROM settings WHERE key='chatContextFlow'");
  const oldProfile=JSON.parse(oldDatabase.exec("SELECT json FROM settings WHERE key='profile'")[0].values[0][0]);
  oldProfile.activeResumeId=resume.id; oldProfile.salaryFallback=999999;
  oldDatabase.run("UPDATE settings SET json=? WHERE key='profile'",[JSON.stringify(oldProfile)]);
  const oldResume=JSON.parse(oldDatabase.exec('SELECT json FROM resumes WHERE id=?',[resume.id])[0].values[0][0]);
  oldResume.kind='master'; oldResume.sourceResumeId='retired-source';
  oldDatabase.run('UPDATE resumes SET json=? WHERE id=?',[JSON.stringify(oldResume),resume.id]);
  await call('db',{action:'import',value:Buffer.from(oldDatabase.export()).toString('base64')});
  assert.equal((await call('getResume',resume.id)).kind,'saved'); assert.equal('sourceResumeId' in await call('getResume',resume.id),false);
  const cleanedProfile=(await call('db',{action:'kvGet',keys:'profile'})).profile;
  assert.equal('salaryFallback' in cleanedProfile,false); assert.equal('activeResumeId' in cleanedProfile,false);
  pass('Restoring a previous-version SQLite backup removes input-resume links and salary defaults while retaining documents');
  oldDatabase.run('UPDATE resumes SET json=? WHERE id=?',['{',resume.id]);
  await assert.rejects(call('db',{action:'import',value:Buffer.from(oldDatabase.export()).toString('base64')}));
  assert.equal((await call('getResume',resume.id)).name,'Frontend engineering'); oldDatabase.close();
  pass('A failed data upgrade rolls back the entire restore and leaves the current database usable');
  // A genuine old backup has no applied-history table. Re-import the current
  // backup before continuing so restart also checks the new records survive.
  await call('db',{action:'import',value:Buffer.from(await readFile(backupPath)).toString('base64')});
  assert.equal((await call('allHistory')).length,countBefore);

  // Detect service tabs from real Chrome tab metadata without using positions.
  await context.route(/https:\/\/(?:chatgpt\.com|mail\.google\.com|jobright\.ai|hiring\.cafe)\//,route => route.fulfill({contentType:'text/html',body:'<title>Connection test fixture</title><p>Connection fixture</p>'}));
  const order = ['https://hiring.cafe/','https://chatgpt.com/','https://jobright.ai/jobs/recommend','https://mail.google.com/mail/u/0/'];
  const servicePages = [];
  for (const url of order) { const p = await context.newPage(); await p.goto(url); servicePages.push(p); }
  await servicePages[1].bringToFront();
  const detected = await page.evaluate(async () => {
    const {findTab} = await import('./tabs.js');
    return Promise.all(['https://mail.google.com/*','https://chatgpt.com/*','https://jobright.ai/*','https://hiring.cafe/*'].map(async pattern => { const t = await findTab([pattern]); return {url:t.url,index:t.index}; }));
  });
  assert.match(detected[0].url,/mail.google.com/); assert.match(detected[1].url,/chatgpt.com/); assert.notEqual(detected[0].index,0);
  await page.evaluate(async () => { const {findTab,focus} = await import('./tabs.js'); await focus((await findTab(['https://chatgpt.com/*'])).id); });
  assert.match((await page.evaluate(async () => (await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0].url)),/chatgpt.com/);
  for (const p of servicePages) await p.close();
  pass('Tab detection and activation work with services deliberately opened in a different order');
  await context.unrouteAll();

  await page.setViewportSize({width:720,height:1000}); await route('templates'); await page.screenshot({path:'test-results/compact-layout.png',fullPage:true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),true);
  pass('Workspace remains usable at a narrow viewport without horizontal overflow');
  await context.close();

  await launch();
  assert.equal((await call('allHistory')).length,countBefore);
  assert.equal((await call('claimSubmission',claimJob)).claimed,false);
  pass('Imported applications and interrupted submission markers survive backup restore and a browser restart');
  assert.equal((await call('getResume',resume.id)).name,'Frontend engineering'); assert.equal('activeResumeId' in await call('readProfile'),false); assert.equal((await call('allLinks')).links.length,2); assert.equal((await call('db',{action:'stats'})).tables.files,8);
  pass('SQLite resumes, settings, links and evidence survive a complete browser restart');
  const popup = await context.newPage(); await popup.goto(`${origin}/src/popup.html`);
  await popup.waitForFunction(() => document.getElementById('ready').textContent.length > 0);
  assert.equal(await popup.locator('#run').isEnabled(),true);
  await popup.screenshot({path:'test-results/popup.png'}); await popup.close();
  pass('Popup reflects the actual queue and profile readiness');
  const availability=(await call('readProfile')).startDate;
  await call('writeProfile',{startDate:''});
  const blockedPopup=await context.newPage(); await blockedPopup.goto(`${origin}/src/popup.html`);
  const setupLink=blockedPopup.getByRole('link',{name:'Set earliest start date'}); await setupLink.waitFor();
  assert.equal(await blockedPopup.locator('#run').isDisabled(),true);
  const [setupPage]=await Promise.all([context.waitForEvent('page'),setupLink.click()]);
  await setupPage.locator('[data-key="startDate"]').waitFor();
  await setupPage.waitForFunction(()=>document.activeElement?.dataset.key==='startDate');
  await setupPage.locator('[data-key="startDate"]').fill(availability);
  await setupPage.locator('[data-action="save-settings"]').click();
  await setupPage.waitForFunction(()=>document.getElementById('notice').textContent==='Changes saved.');
  await blockedPopup.reload(); await blockedPopup.waitForFunction(()=>!document.getElementById('run').disabled);
  await blockedPopup.screenshot({path:'test-results/popup-ready.png'});
  await setupPage.close(); await blockedPopup.close();
  pass('Disabled Run links directly to the missing availability field; saving it enables Run');

  // Run the actual extension pipeline against deterministic browser fixtures.
  // This tests orchestration and form filling without using an account or sending an application.
  const saved = await call('getResume',resume.id);
  const replyDocument = {...saved.document,coverLetter:'Dear hiring team, I build accessible applications with React and TypeScript. Thank you for considering my application. Alex Morgan',tailoring:{jdTitle:'Software Engineer',jdCompany:'Example Careers',primaryKeywords:['React','TypeScript']}};
  const paySource={url:'https://example.test/company/example-careers/engineering-pay',title:'Example Careers engineering compensation',company:'Example Careers',role:'Software Engineer',matchType:'exact-company-role',date:'2026-11-06',details:'Published base pay for the company role in Seattle.'};
  const payReply={status:'researched',company:'Example Careers',role:'Software Engineer',location:'Seattle',currency:'USD',period:'year',basis:'base',minimum:140000,maximum:190000,recommendedAmount:173000,rationale:'AI-selected amount supported by exact company role evidence.',sources:[paySource]};
  const chatHtml=`<!doctype html><html><body><div>Candidate context is stored on the ChatGPT side.</div><textarea id="prompt-textarea" style="width:600px;height:120px"></textarea><button data-testid="send-button">Send</button><script>
    const resume=${JSON.stringify(replyDocument).replaceAll('<','\\u003c')};
    const pay=${JSON.stringify(payReply)};
    document.querySelector('button').onclick=()=>{
      const prompt=document.querySelector('textarea').value;
      localStorage.setItem('seenModes',JSON.stringify([...(JSON.parse(localStorage.getItem('seenModes')||'[]')),{mode:document.querySelector('#fixture-mode').dataset.selectedReasoningEffort,prompt}]));
      localStorage.setItem('seenPrompts',JSON.stringify([...(JSON.parse(localStorage.getItem('seenPrompts') || '[]')),{prompt,url:location.href}]));
      const user=document.createElement('div');user.dataset.userMessageBubble='true';user.textContent=prompt;document.body.append(user);
      if(!location.pathname.includes('/c/'))history.replaceState({},'', '/c/fixture-'+crypto.randomUUID()+'?temporary-chat=true');
      const research=prompt.includes('Research compensation with live web search. Use cited evidence');
      const answer=prompt.includes('You fill in the fields of a job application form') || prompt.includes('You fill in one field of a job application form');
      const output=research ? JSON.stringify(pay) : answer ? JSON.stringify({'1':'173000'}) : prompt.includes('Write a concise professional cover letter') ? 'Dear hiring team, I build accessible React applications. Thank you for considering me. Alex Morgan' : JSON.stringify(resume);
      const turn=document.createElement('div'); turn.dataset.messageAuthorRole='assistant'; turn.style.whiteSpace='pre-wrap'; turn.textContent=output;
      if(research){const citation=document.createElement('a');citation.dataset.testid='webpage-citation';citation.href=pay.sources[0].url;citation.textContent='Company compensation source';turn.append(citation);}
      document.body.append(turn);
    };</script></body></html>`+chatModeFixture();
  const fixtureUrl = `http://examplecareers.greenhouse.io:${fixtureServer.address().port}/jobs/991122`;
  const jd = 'Example Careers is hiring a Software Engineer to build accessible customer applications with React and TypeScript. The team works together on careful testing, performance measurement, documentation, and maintainable user interfaces. This remote role collaborates with designers and engineers to ship reliable features. Candidates should have experience building web applications and communicating clearly.';
  const jobHtml = `<!doctype html><html><head><title>Software Engineer at Example Careers</title><script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Software Engineer',description:jd,hiringOrganization:{name:'Example Careers'}})}</script></head><body><h1>Software Engineer</h1><p>${jd}</p><form id="application_form"><label for="first_name">First name *</label><input id="first_name" name="first_name" required><label for="last_name">Last name *</label><input id="last_name" name="last_name" required><label for="email">Email *</label><input id="email" name="email" type="email" required><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" required><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required><label for="expected_salary">Expected base salary</label><input type="number" id="expected_salary" name="expected_salary" required><label for="cover_letter">Cover letter</label><input id="cover_letter" name="cover_letter" type="file">${demographicFixture}<button type="submit">Submit Application</button></form><script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++;document.body.textContent='Thank you for applying';};</script></body></html>`;
  await context.route('https://chatgpt.com/**',route => route.fulfill({contentType:'text/html',body:chatHtml}));
  fixtureHtml = jobHtml.replace(`<p>${jd}</p>`,`<main id="content"><p>${jd} ${jd}</p></main>`).replace('</body>',`<script>document.querySelectorAll('input[type=file]').forEach(input=>input.addEventListener('change',async()=>{const file=input.files[0];if(!file)return;await fetch('/upload/'+input.name,{method:'POST',body:file});const chip=document.createElement('span');chip.className='file-upload__filename';chip.textContent=file.name;document.body.append(chip);}));</script></body>`);
  const chat = await context.newPage(); await chat.goto('https://chatgpt.com/c/candidate-context');
  for (const record of await call('allResumes')) await call('deleteResume',record.id);
  assert.equal((await call('allResumes')).length,0);
  await call('writeProfile',{dryRun:true,maxPerRun:1,autoFetch:false,delayMs:0,exportFiles:false,gender:'Male',pronouns:'He/him/his',race:'East Asian',hispanic:'no',veteran:'No Veteran',sexualOrientation:'Straight'});
  await call('saveLinks',[fixtureUrl]);
  await startTestRun();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const records = await call('allResults');
    if (records.some(r => r.applyUrl === fixtureUrl)) break;
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  const state = await page.evaluate(() => chrome.runtime.sendMessage({type:'state'}));
  await writeFile('test-results/fixture-run-log.json',JSON.stringify(state,null,2));
  const fixtureResults = await call('allResults');
  const fixtureResult = fixtureResults.find(r => r.applyUrl === fixtureUrl);
  assert.equal(fixtureResult?.status,'dry-run',JSON.stringify(state.log.slice(-10),null,2));
  const applicationPage = context.pages().find(p => p.url() === fixtureUrl);
  assert.ok(applicationPage,'Review form remains open');
  assert.equal(await applicationPage.locator('#first_name').inputValue(),'Alex');
  assert.equal(await applicationPage.locator('#email').inputValue(),'alex@example.test');
  assert.equal(await applicationPage.locator('#resume').evaluate(e => e.files.length),1);
  assert.equal(await applicationPage.evaluate(() => window.submissions),0);
  assert.ok((await call('allResumes')).some(r => r.kind === 'generated' && r.job.company === 'Example Careers'));
  assert.equal(await applicationPage.locator('#expected_salary').inputValue(),'173000');
  const generated=(await call('allResumes')).find(r=>r.kind==='generated');
  assert.equal(generated.compensation.recommendedAmount,173000); assert.equal('sourceResumeId' in generated,false);
  const queries=await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenPrompts') || '[]'));
  const resumeQuery=queries[0];
  assert.equal(resumeQuery.prompt.replace(/\s+/g,' ').trim(),jd);
  assert.equal((await call('getJob',fixtureUrl)).descriptionSource.method,'employer-page');
  assert.ok(resumeQuery.url.endsWith('/c/candidate-context')); assert.ok(!resumeQuery.prompt.includes('Example Software'));
  assert.ok(queries.some(q=>q.prompt.includes('Based on JD and company, tell me what compensation this position would be.')));
  assert.equal(queries.filter(q=>q.prompt.includes('Write a concise professional cover letter using only the supplied resume')).length,0);
  assert.equal(queries.length,3); // combined documents, cited research, salary field
  assert.deepEqual(await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenModes')||'[]').map(entry=>entry.mode)),['high','medium','none']);
  assert.ok(fixtureResult.detail.timings.documents>=0); assert.ok(fixtureResult.detail.timings.research>=0);
  pass('Combined document generation removes the separate letter call and exposes stage timings');
  await applicationPage.screenshot({path:'test-results/filled-review-form.png',fullPage:true});
  for(const [id,expected] of [['demo-gender','Man'],['demo-ethnicity','East Asian'],['demo-orientation','Heterosexual'],['demo-military','No, I am not a veteran or active member'],['demo-sex','Male'],['demo-veteran','I am not a protected veteran'],['demo-race','Asian']]) {
    assert.equal(await applicationPage.locator('#'+id).evaluate(input=>input.closest('.select__control').querySelector('[data-values]').textContent),expected,id);
  }
  pass('The real pipeline replaces decline chips using the profile, includes transparent selected controls, and fills conditional race without an AI demographic call');
  assert.ok(fixtureResult.detail.lastScreenshot?.path);
  assert.equal(fixtureResult.detail.screenshotError,undefined);
  const reviewScreenshot=await page.evaluate(async path=>{
    const file=await (await import('./store.js')).db({action:'get',table:'files',id:path});
    return {type:file.content.type,size:file.content.size};
  },fixtureResult.detail.lastScreenshot.path);
  assert.equal(reviewScreenshot.type,'image/png');assert.ok(reviewScreenshot.size>0);
  pass('Review-mode completion stores the actual final viewport in SQLite and keeps the form open');
  await applicationPage.close();
  pass('Full pipeline with no saved input resume: use ChatGPT conversation context, request Search, validate native citations, fill the AI-selected salary, and stop before submission');
  while ((await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}))).running) await new Promise(resolve=>setTimeout(resolve,200));
  await route('activity'); await page.locator(`[data-action="application-detail"][data-id="${fixtureResult.id}"]`).click();
  assert.ok(await page.getByText('AI-selected application amount:',{exact:false}).isVisible());
  assert.equal(await page.locator(`a[href="${paySource.url}"]`).count(),1);
  await page.screenshot({path:'test-results/compensation-research.png',fullPage:true});
  pass('Application details display the researched range, AI-selected amount and original source links');
  await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:chatHtml.replace('"coverLetter":'+JSON.stringify(replyDocument.coverLetter),'"coverLetter":""').replace("citation.dataset.testid='webpage-citation';",'')}));
  await chat.goto('https://chatgpt.com/c/candidate-context');
  const uncitedUrl=fixtureUrl.replace('991122','991123');
  await call('saveLinks',[uncitedUrl]);
  await startTestRun();
  const uncitedDeadline=Date.now()+150000;
  let uncitedResult;
  while (Date.now()<uncitedDeadline) {
    uncitedResult=(await call('allResults')).find(r=>r.applyUrl===uncitedUrl);
    if(uncitedResult) break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(uncitedResult?.status,'manual');
  assert.equal(uncitedResult.detail.compensation.status,'unavailable');
  const uncitedForm=context.pages().find(p=>p.url()===uncitedUrl);
  assert.ok(uncitedForm); assert.equal(await uncitedForm.locator('#expected_salary').inputValue(),''); assert.equal(await uncitedForm.evaluate(()=>window.submissions),0);
  await writeFile('test-results/uncited-research-result.json',JSON.stringify(uncitedResult,null,2));
  await uncitedForm.close();
  assert.equal(await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenPrompts') || '[]').filter(q=>q.prompt.includes('Write a concise professional cover letter using only the supplied resume')).length),0);
  pass('A resume-only reply skips an optional cover-letter request when optional letters are disabled');
  pass('A plain source hyperlink without native search citations causes manual handoff and leaves the required salary field empty');
  while ((await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}))).running) await new Promise(resolve=>setTimeout(resolve,200));

  // Use a different company so existing same-role suppression does not hide
  // the actual imported-link check. Neither the page nor ChatGPT may be used.
  const avoidedUrl=fixtureUrl.replace('991122','991199');
  await call('importHistory',[{applyUrl:avoidedUrl,company:'Avoided Company'}]);
  await call('saveLinks',[avoidedUrl]);
  const beforePrompts=await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenPrompts') || '[]').length);
  await startTestRun();
  await page.waitForFunction(async()=>{const s=await chrome.runtime.sendMessage({type:'state'});return !s.running && s.log.some(e=>e.message.includes('0 new to work through'));},{timeout:20000});
  assert.equal(context.pages().some(p=>p.url()===avoidedUrl),false);
  assert.equal(await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenPrompts') || '[]').length),beforePrompts);
  pass('Imported application links are skipped by the actual pipeline before opening a job or asking ChatGPT');

  const otherRoleUrl=fixtureUrl.replace('991122','991177');
  const originalFixture=fixtureHtml;
  fixtureHtml=fixtureHtml.replaceAll('Example Careers','4 Minds, Inc.').replaceAll('Software Engineer','Another engineering role');
  await call('saveLinks',[otherRoleUrl]); await startTestRun();
  const companyDeadline=Date.now()+30000; let companyResult;
  while(Date.now()<companyDeadline) { companyResult=(await call('allResults')).find(r=>r.applyUrl===otherRoleUrl); if(companyResult) break; await new Promise(resolve=>setTimeout(resolve,200)); }
  assert.equal(companyResult?.status,'skipped',JSON.stringify(await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'})))); assert.match(companyResult.reason,/company/i);
  assert.equal(await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenPrompts') || '[]').length),beforePrompts);
  fixtureHtml=originalFixture;
  pass('A different role and job URL at an imported company are rejected after extraction, before any AI generation');

  // A verified legal-employer alias must protect an imported brand even
  // when its old application used a completely different job board.
  await call('importHistory',[{company:'CVS',urls:[]}]);
  const cvsHistory=(await call('allHistory')).find(row=>row.company==='CVS');
  await call('setHistoryCompany',cvsHistory.id,'CVS',['CVS Health','CVS Shared Services Resources LLC','9025 CVS Shared Services Resources LLC']);
  const aliasUrl=fixtureUrl.replace('991122','991176'),historyBeforeAlias=(await call('allHistory')).length;
  assert.equal((await call('claimSubmission',{applyUrl:aliasUrl,company:'9025 CVS Shared Services Resources LLC'})).claimed,false);
  assert.equal((await call('allHistory')).length,historyBeforeAlias);
  fixtureHtml=originalFixture.replaceAll('Example Careers','9025 CVS Shared Services Resources LLC');
  await call('saveLinks',[aliasUrl]);await startTestRun();
  const aliasDeadline=Date.now()+30000;let aliasResult;
  while(Date.now()<aliasDeadline){aliasResult=(await call('allResults')).find(row=>row.applyUrl===aliasUrl);if(aliasResult)break;await new Promise(resolve=>setTimeout(resolve,200));}
  assert.equal(aliasResult?.status,'skipped',JSON.stringify(await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}))));
  assert.equal(await chat.evaluate(()=>JSON.parse(localStorage.getItem('seenPrompts')||'[]').length),beforePrompts);
  assert.equal((await call('allHistory')).length,historyBeforeAlias);fixtureHtml=originalFixture;
  pass('A verified brand/legal-employer alias blocks both the actual pipeline and the atomic submission guard without generating documents or creating a new claim');

  // Exercise final submission only on a local controlled form. This is not
  // a real application; the fixture increments an in-page counter.
  const submitUrl=fixtureUrl.replace('991122','991188');
  fixtureHtml=fixtureHtml.replaceAll('Example Careers','Submission Fixture').replace("document.body.textContent='Thank you for applying';", "document.body.textContent='Thank you for applying';document.body.style.background='#123456';document.documentElement.style.background='#123456';");
  await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:chatHtml.replaceAll('Example Careers','Submission Fixture')}));
  await chat.goto('https://chatgpt.com/c/candidate-context');
  await call('writeProfile',{dryRun:false}); await call('saveLinks',[submitUrl]);
  await startTestRun();
  const submitDeadline=Date.now()+120000;
  let submittedFixture;
  while(Date.now()<submitDeadline) {
    submittedFixture=(await call('allResults')).find(r=>r.applyUrl===submitUrl);
    if(submittedFixture) break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(submittedFixture?.status,'submitted',JSON.stringify(await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}))));
  const marker=(await call('allHistory')).find(r=>r.applyUrl===submitUrl);
  assert.equal(marker.kind,'submission'); assert.equal(marker.status,'submitted');
  assert.equal((await call('claimSubmission',{applyUrl:submitUrl,company:'Submission Fixture'})).claimed,false);
  assert.ok(submittedFixture.detail.lastScreenshot?.path);
  assert.equal(submittedFixture.detail.screenshotError,undefined);
  assert.equal(context.pages().some(p=>p.url()===submitUrl),false,'Submission tab must close after its image is saved');
  const image=await page.evaluate(async path=>{
    const {content}=await (await import('./store.js')).db({action:'get',table:'files',id:path});
    const bitmap=await createImageBitmap(content), canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    return {type:content.type,width:bitmap.width,height:bitmap.height,pixel:[...context.getImageData(50,60,1,1).data]};
  },submittedFixture.detail.lastScreenshot.path);
  assert.deepEqual(image,{type:'image/png',width:1440,height:1050,pixel:[18,52,86,255]});
  await route('overview');await route('activity');await page.locator(`[data-action="application-detail"][data-id="${submittedFixture.id}"]`).click();
  assert.equal(await page.getByRole('button',{name:'Last page screenshot (PNG)',exact:true}).count(),1);
  const [lastPageDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Last page screenshot (PNG)',exact:true}).click()]);
  await lastPageDownload.saveAs('test-results/submission-last-page.png');
  pass('Actual captureVisibleTab saves the confirmation pixels before closing the tab; Applications offers the PNG download');
  await call('writeProfile',{dryRun:true});
  pass('A local fixture submission saves its guard before sending and blocks every subsequent claim');
  await chat.close(); await context.unrouteAll();

  // Live public-page check: read and inventory only, never submit.
  try {
    const response = await context.request.get('https://boards-api.greenhouse.io/v1/boards/discord/jobs',{timeout:20000});
    if (!response.ok()) throw new Error(`Greenhouse API returned ${response.status()}`);
    const jobs = (await response.json()).jobs || [], job = jobs.find(j => /engineer/i.test(j.title)) || jobs[0];
    if (!job) throw new Error('No public jobs returned');
    const live = await context.newPage(); await live.goto(job.absolute_url,{waitUntil:'domcontentloaded',timeout:45000});
    await live.waitForTimeout(5000);
    await live.addScriptTag({path:resolve('src/fill.js')});
    const inventory = await live.evaluate(() => window.__ghApply.inventory());
    report.liveSite = {url:live.url(),title:await live.title(),fields:inventory.fields?.length || 0,submitted:false};
    await live.screenshot({path:'test-results/live-greenhouse.png',fullPage:true});
    if (!inventory.fields?.length) throw new Error('Live form did not expose fields; CAPTCHA or markup may block inspection');
    pass('Live public Greenhouse form opens and is inventoried without submitting',report.liveSite);
    await live.close();
  } catch (error) { report.liveSite = {ok:false,error:error.message,submitted:false}; console.log(`LIVE LIMITATION ${error.message}`); }

  assert.deepEqual(report.errors,[],'No uncaught browser errors');
  pass('No uncaught JavaScript errors in the tested extension views');
  await page.waitForFunction(async()=>{const {stateStorage}=await import('./store.js');const saved=(await stateStorage.get('lastRunSnapshot')).lastRunSnapshot;return saved?.runProgress?.finishedAt>0&&!saved.runProgress.running;});
  const lastRun=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));
  await context.close();await launch();await route('monitor');
  const restoredRun=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));
  assert.deepEqual(restoredRun.stopReason,lastRun.stopReason);assert.equal(restoredRun.attempted,lastRun.attempted);assert.ok(restoredRun.log.length>0);
  await page.evaluate(async()=>{const {stateStorage}=await import('./store.js');const {lastRunSnapshot}=await stateStorage.get('lastRunSnapshot');await stateStorage.set({lastRunSnapshot:{...lastRunSnapshot,runProgress:{...lastRunSnapshot.runProgress,running:true,finishedAt:0,phase:'generating',aiWorkers:{effective:2,busy:2,queued:1,tasks:[{label:'Interrupted fixture'}]}}}});await chrome.storage.session.clear();});
  await context.close();await launch();await route('monitor');
  const interrupted=await page.evaluate(()=>chrome.runtime.sendMessage({type:'state'}));assert.equal(interrupted.running,false);assert.equal(interrupted.stopReason.code,'interrupted');assert.equal(interrupted.aiWorkers.busy,0);assert.deepEqual(interrupted.aiWorkers.tasks,[]);assert.ok(interrupted.lastError.message.includes('interrupted'));
  await page.getByText('Chrome interrupted the previous run. Saved stages and company protection remain; start Run to continue.',{exact:true}).first().waitFor();
  assert.equal((await call('claimSubmission',{applyUrl:submitUrl,company:'Submission Fixture'})).claimed,false);
  pass('The Run monitor restores completed status and diagnoses interrupted work across complete browser restarts without losing company protection');
  await context.close();
  migrationPath = scratchPath('migration-profile');
  await launch(migrationPath);
  await page.evaluate(async () => {
    await chrome.storage.local.set({profile:{firstName:'Legacy',lastName:'Applicant',email:'legacy@example.test',masterResume:'Legacy Applicant\nEngineer at Legacy Company\n2020 - Present',experience:[{from:'2020-01',to:''}],companySize:'large',formatPrompt:'Old prompt'},submitted:['https://example.test/old-job']});
    await new Promise((resolve,reject) => {
      const request = indexedDB.open('greenhouse-apply',1);
      request.onupgradeneeded = () => { request.result.createObjectStore('applications',{keyPath:'id'}); request.result.createObjectStore('results',{keyPath:'id'}); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction(['applications','results'],'readwrite');
        transaction.objectStore('applications').put({id:'legacy-application',resume:new Blob(['legacy PDF bytes'],{type:'application/pdf'})});
        transaction.objectStore('results').put({id:'legacy-result',status:'submitted',company:'Legacy Company',at:Date.now()});
        transaction.oncomplete = () => {db.close();resolve();}; transaction.onerror = () => reject(transaction.error);
      };
    });
    await (await navigator.storage.getDirectory()).removeEntry('apply-bot.sqlite3');
  });
  await context.close(); await launch(migrationPath);
  const migrated = await call('readProfile');
  assert.equal('activeResumeId' in migrated,false); assert.equal('masterResume' in migrated,false); assert.equal((await call('allResumes')).length,0);
  assert.equal('companySize' in migrated,false); assert.equal('formatPrompt' in migrated,false); assert.equal('experience' in migrated,false);
  assert.equal((await call('allResults'))[0].status,'submitted');
  const migratedBlob = await page.evaluate(async () => (await (await import('./store.js')).getApplication('legacy-application')).resume.text());
  assert.equal(migratedBlob,'legacy PDF bytes');
  assert.deepEqual((await call('db',{action:'kvGet',keys:'submitted'})).submitted,['https://example.test/old-job']);
  pass('Legacy migration preserves profile, submissions and binary documents while discarding removed input-resume settings');
} catch (error) {
  report.failure = error.stack; console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({path:'test-results/failure.png',fullPage:true}).catch(() => {});
} finally {
  await context?.close(); await new Promise(resolve => fixtureServer.close(resolve));
  for (const path of [profilePath,historyRoot,migrationPath]) if (path) await releaseScratch(path);
  report.finishedAt = new Date().toISOString(); await writeFile('test-results/browser-report.json',JSON.stringify(report,null,2));
}
