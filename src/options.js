import {allJobs,getJob,saveJob,stateStorage,allQuestions,answerAsked,forgetQuestion,answerPack} from './store.js';
import {unblocked} from './question-pack.js';
import {resumable} from './application-needs.js';
import {canonicalUrl} from './join.js';
import {monitor,monitorBody} from './ui/monitor.js';
import {deadline} from './deadline.js';
import {runSummary} from './run-policy.js';
import {withScheduleDefaults} from './schedule.js';
import {jobs,jobsTable,jobDetails} from './ui/jobs.js';
import { readProfile, writeProfile, allResumes, getResume, saveResume, deleteResume, allTemplates, getTemplate, saveTemplate, deleteTemplate, allLinks, saveLinks, clearLinks, allPairings, savePairings, clearPairings, allResults, db } from './store.js';
import { missingFromProfile, missingProfileFields, withDefaults } from './profile.js';
import { DEFAULT_TEMPLATE, blankDocument, sampleDocument, documentText, applyTemplate } from './templates.js';
import { buildQueue, linksFromCsv, sheetCsvUrl, isSignInPage } from './links.js';
import { classifyPairingFolder, pairingFolders, pairingLink, parsePairedLines, reviewPairings } from './pairings.js';
import { findTab, focus } from './tabs.js';
import { chatGptRoundTrip } from './chatgpt.js';
import { ROOT, resultsCsv } from './vault.js';
import { bytesToBase64, base64ToBytes } from './codec.js';
import { buildDocumentPdf } from './vendor/generation.js';
import { toDocument } from './resume.js';
import { h, button, readFields, download } from './ui/helpers.js';
import { mountTemplateEditor } from './ui/template-editor.js';
import { mountResumeEditor } from './ui/resume-editor.js';
import { extractPdf } from './ui/preview.js';
import {compensationHtml} from './ui/research.js';
import * as pages from './ui/pages.js';
import {allHistory, importHistory, deleteHistory,setHistoryCompany} from './store.js';
import {historyCandidates,companyCandidates,previewHistory,readHistoryFiles,historyUrls} from './history.js';
import {companyResolved} from './companies.js';
import {reloadExtension} from './update.js';

const content = document.getElementById('content');
document.querySelector('.sidebar-bottom .version').textContent = `Version ${chrome.runtime.getManifest().version}`;
let data = {}, dispose, dirty = false, generation = 0, noticeTimer, previousHash = '#overview';
const labels = { monitor:'Run monitor', jobs:'Jobs', overview:'Overview', resumes:'My resumes', templates:'Template studio', sources:'Job sources', profile:'My profile', settings:'Settings', activity:'Applications',history:'Already applied',questions:'Questions' };
/**
 * The same document is the side panel, where it runs at about 350px.
 *
 * The layout narrows in CSS; what CSS cannot give back is room, and the
 * resume editor and template studio genuinely need a window - so the panel
 * carries a way out to the current route in a tab. A side panel is not a
 * tab, and that is the only thing distinguishing the two from inside the
 * page. The anchor is opened through chrome.tabs rather than followed,
 * because following it would navigate the panel itself.
 */
const fullTab = document.getElementById('open-workspace');
chrome.tabs.getCurrent().then(tab => { if (!tab) { document.body.dataset.surface = 'panel'; fullTab.hidden = false; } }).catch(() => {});
fullTab.addEventListener('click',event => { event.preventDefault(); chrome.tabs.create({url:fullTab.href,active:true}); });
let historyPreview = [], pairingPreview = [], applicationImageUrl=null;
function clearApplicationImage(){if(applicationImageUrl){URL.revokeObjectURL(applicationImageUrl);applicationImageUrl=null;}}
function notify(value, error = false) {
  const notice = document.getElementById('notice'); notice.textContent = value instanceof Error ? value.message : value; notice.hidden = false; notice.classList.toggle('error',error); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.hidden = true,error ? 12000 : 6000);
}
const fail = error => notify(error,true);
const setDirty = value => { dirty = value; };
async function detectConnections() { data.connections = await Promise.all(pages.services.map(async service => ({ id:service.id, tab:await findTab(service.patterns) }))); }
async function loadData() {
  const [profile,resumes,templates,{links},pairings,results,stats,run,history,jobRows,stored,questionRows] = await Promise.all([readProfile(),allResumes(),allTemplates(),allLinks(),allPairings(),allResults(),db({action:'stats'}),chrome.runtime.sendMessage({type:'state'}),allHistory(),allJobs(),stateStorage.get('schedule'),allQuestions().catch(()=>[])]);
  data = {profile,resumes,templates,links,pairings,results,stats,run,history,jobs:jobRows,questions:questionRows,schedule:withScheduleDefaults(stored.schedule)}; await detectConnections(); updateRunState();
}
function updateRunState() {
  // A run winding down after Stop is not a green pill. It said "generating"
  // in green for two minutes after the button was pressed, which is how a
  // slow stop reads as no stop at all.
  const run = data.run || {}, label = document.getElementById('run-state'); label.textContent = run.running && run.stopping ? 'Stopping · finishing what is open' : run.running ? `${run.phase || 'Running'} · ${run.aiWorkers?.busy ? `${run.aiWorkers.busy}/${run.aiWorkers.effective} AI active · `:''}${run.attempted || 0} attempts` : run.stopReason?`Stopped · ${run.stopReason.code}`:'Ready';label.title=runSummary(run); label.className = `pill ${run.running && !run.stopping ? 'green' : ''}`;
}
async function renderRoute() {
  const currentHash = location.hash || '#overview';
  if (dirty && !confirm('Leave this editor without saving your changes?')) { history.replaceState(null,'',previousHash); return; }
  dirty = false; previousHash = currentHash; const ticket = ++generation;
  fullTab.href = chrome.runtime.getURL(`src/options.html${currentHash}`);
  clearApplicationImage(); dispose?.(); dispose = null; content.setAttribute('aria-busy','true');
  try {
    await loadData(); if (ticket !== generation) return;
    const [rawView,mode,id] = currentHash.slice(1).split('/'), view = labels[rawView] ? rawView : 'overview';
    document.getElementById('breadcrumb').textContent = `Workspace / ${labels[view]}`;
    document.querySelectorAll('[data-view]').forEach(a => a.classList.toggle('active',a.dataset.view === view));
    if (view === 'resumes' && mode === 'edit') {
      const record = await getResume(decodeURIComponent(id)); if (!record) throw new Error('This resume no longer exists.');
      dispose = mountResumeEditor(content,record,data.profile.template,{ dirty:setDirty, save:async value => { await saveResume(value); notify('Resume saved to SQLite.'); }, error:fail, info:notify, canUseChatGpt:async () => { const state = await chrome.runtime.sendMessage({type:'state'}); if (state.running) throw new Error('Wait for the run to finish before reading a resume with ChatGPT.'); } });
    } else if (view === 'templates' && mode === 'edit') {
      const template = await getTemplate(decodeURIComponent(id));
      dispose = mountTemplateEditor(content,template,data.resumes.find(r=>r.document)?.document || sampleDocument(),{ sample:!data.resumes.some(r=>r.document),dirty:setDirty,save:async value => { await saveTemplate(value); notify('Template saved. Future PDFs use this design.'); },error:fail });
    } else content.innerHTML = view==='monitor'?monitor(data):view==='jobs'?jobs(data):pages[view](data);
    if (mode==='focus' && view==='profile') { const field=content.querySelector(`[data-key="${CSS.escape(decodeURIComponent(id || ''))}"]`); field?.focus(); field?.scrollIntoView({block:'center'}); }
  } catch (error) { content.innerHTML = `<section class="card"><h2>${error.needsReload ? 'Finish the extension update' : 'Couldn’t open this view'}</h2><p class="muted">${h(error.message)}</p>${error.needsReload ? button('reload-extension','Reload extension','primary') : button('retry','Try again')}</section>`; fail(error); }
  finally { if (ticket === generation) content.setAttribute('aria-busy','false'); }
}
async function saveSettings() {
  // Every settings region on the page, not just the first. A second block
  // with its own Save button - the role filter is one - would otherwise
  // look saved and keep none of what was typed into it.
  const forms = [...content.querySelectorAll('#settings-form,[data-settings]')]; if (!forms.length) return;
  const values = forms.reduce((all,form)=>readFields(form,all),{});
  for (const form of forms) for (const input of form.querySelectorAll('input[type="email"],input[type="url"]')) if (input.value && !input.checkValidity()) { input.reportValidity(); throw new Error('Check the highlighted address.'); }
  await writeProfile(values); data.profile = await readProfile(); dirty = false; notify('Changes saved.');
}
/**
 * The day plan. Minutes and seconds on screen, milliseconds in storage,
 * converted here rather than making the applicant type 720000.
 */
async function saveSchedule() {
  const form = content.querySelector('#schedule-form'); if (!form) return;
  const values = readFields(form,{});
  const schedule = withScheduleDefaults({ ...data.schedule, autopilot:values.autopilot === true, dailyTarget:values.dailyTarget, attemptConcurrency:values.attemptConcurrency, documentBacklog:values.documentBacklog, boardGapMs:Math.round(values.boardGapMs * 1000), perCompanyPerDay:values.perCompanyPerDay, employerGapMs:Math.round(values.employerGapMs * 60000), attemptDeadlineMs:Math.round(values.attemptDeadlineMs * 60000), wizardDeadlineMs:Math.round(values.wizardDeadlineMs * 60000), exhaustedRetryMs:Math.round(values.exhaustedRetryMs * 60000) });
  await stateStorage.set({ schedule });
  data.schedule = schedule;
  // The worker holds the alarm, so it has to be told: a setting saved into
  // storage that nobody reads until the next run would leave autopilot on
  // in the options page and off in the extension.
  await chrome.runtime.sendMessage({ type:'schedule' }).catch(() => {});
  notify(schedule.autopilot ? `Day plan saved. Runs continue by themselves until ${schedule.dailyTarget || 'you stop them'}.` : 'Day plan saved. Autopilot is off, so runs start only when you press Run.');
  await renderRoute();
}
async function newResume() {
  const doc = blankDocument(), profile = data.profile;
  doc.name = [profile.firstName,profile.lastName].filter(Boolean).join(' '); doc.contact.email = profile.email; doc.contact.phone = profile.phone; doc.contact.location = [profile.city,profile.state].filter(Boolean).join(', ');
  const id = crypto.randomUUID(); await saveResume({id,name:'Untitled resume',kind:'saved',document:doc,createdAt:Date.now()}); location.hash = `resumes/edit/${id}`;
}
async function startRun() {
  const profile = await readProfile(), missing = missingFromProfile(profile);
  if (missing.length) { location.hash=`profile/focus/${missingProfileFields(profile)[0][0]}`; notify(`Before starting, add: ${missing.join(', ')}. Then save your changes.`,true); return; }
  const unknown=(await allHistory()).filter(r=>r.kind==='external' && !companyResolved(r));
  if(unknown.length) {location.hash='history';notify(`Set ${unknown.length} missing company name(s) before starting.`,true);return;}
  if (!confirm('Automatic submission is enabled. Submit applications from your loaded links and enabled feeds?')) return;
  await chrome.runtime.sendMessage({type:'run'});location.hash='monitor'; notify('Application run started.');
}
async function requireIdle() { if ((await chrome.runtime.sendMessage({type:'state'})).running) throw new Error('Stop the current run before changing applied history.'); }
// Shared by the parked-application buttons. `documents-ready` is the
// stage the banked-document drain reads, and clearing `resultId` drops
// the stop that put the row here - left on, the next park would be
// reasoned about against a stale outcome.
async function queueParked(jobs) {
  for (const job of jobs) await saveJob({...job,stage:'documents-ready',hold:false,resultId:'',reason:'Resumed by you after the hold was cleared.'});
  await saveLinks([...new Set([...(await allLinks()).links,...jobs.map(job=>job.sourceUrl||job.applyUrl)])]);
}
async function showHistoryPreview(candidates,details = '') {
  const target = content.querySelector('#history-preview'); if(!target) return;
  const known = [...await allHistory(),...data.results.filter(r=>['submitted','unconfirmed'].includes(r.status))];
  const preview = previewHistory(candidates,known); historyPreview = preview.fresh;
  const unresolved=preview.fresh.filter(r=>!companyResolved(r)).length;
  target.innerHTML = `<div class="divider"></div><h3>Review before importing</h3><p>${preview.fresh.length} new company entries · ${preview.duplicates} repeat entries ignored. ${h(details)}</p><p>Every role at an imported company will be blocked. ${unresolved ? `${unresolved} entries need company names; runs stay blocked until you set them.` : ''}</p><div class="code-list">${preview.fresh.slice(0,100).map(r=>`<div>${h(r.company || 'Company identified by job board, or needs a name')} ${h(r.applyUrl || '')}</div>`).join('')}${preview.fresh.length > 100 ? `<p>Showing the first 100 of ${preview.fresh.length} entries.</p>` : ''}</div><p class="hint">Confirm you already applied to these companies. Importing does not visit links or submit applications.</p>${button('commit-history',`Mark ${preview.fresh.length} companies as already applied`,'primary',preview.fresh.length ? '' : 'disabled')}`;
}
const pairingCandidate = () => ({name:[data.profile.firstName,data.profile.lastName].filter(Boolean).join(' '),email:data.profile.email,phone:data.profile.phone,location:[data.profile.city,data.profile.state,data.profile.country].filter(Boolean).join(', '),links:[]});
/**
 * Every directory of the chosen folder read into a pairing, including the
 * ones that cannot become one. A fault is recorded rather than thrown so the
 * review lists all thirty-one employers at once; a folder import that stops
 * at the first bad directory makes fixing a corpus a thirty-one pass job.
 */
async function readPairingFiles(files) {
  const byPath = new Map(files.map(file => [file.webkitRelativePath || file.name,file]));
  const records = [];
  for (const group of pairingFolders([...byPath.keys()]).map(classifyPairingFolder)) {
    const record = {folder:group.folder,company:group.company,title:group.title,link:'',resumeId:'',resumeName:'',fault:group.fault};
    const file = group.resumeFile && byPath.get(group.resumeFile.path);
    if (!record.fault) record.link = pairingLink(await byPath.get(group.linkFile.path).text());
    if (!record.fault && file) {
      if (file.size > 12 * 1024 * 1024) record.fault = 'its resume PDF is larger than 12 MB';
      else try {
        // Read here, in the page that has pdf.js, because text the forms
        // answer from has to exist before the pairing is accepted.
        const sourceText = await extractPdf(file);
        if (!sourceText.trim()) throw new Error('no text could be extracted from it');
        const structured = group.documentFile ? toDocument(JSON.parse(await byPath.get(group.documentFile.path).text()),pairingCandidate()) : null;
        record.resumeName = [group.company,group.title].filter(Boolean).join(' · ') || file.name;
        record.resumeId = crypto.randomUUID();
        record.saved = {id:record.resumeId,name:record.resumeName,kind:'supplied',fileName:file.name,pdf:new Blob([await file.arrayBuffer()],{type:'application/pdf'}),sourceText,document:structured,job:{company:group.company,title:group.title,url:record.link},createdAt:Date.now()};
      } catch (error) { record.fault = `its resume PDF could not be read (${error.message})`; }
    }
    records.push(record);
  }
  if (!records.length) throw new Error('That folder holds no directories to pair. Choose the folder that contains one directory per employer.');
  return records;
}
async function showPairingPreview(records) {
  const target = content.querySelector('#pairing-preview'); if (!target) return;
  const review = reviewPairings(records,{applied:[...await allHistory(),...data.results.filter(r => ['submitted','unconfirmed'].includes(r.status))]});
  pairingPreview = review.queued;
  const refused = [...review.rejected,...review.duplicates];
  target.innerHTML = `<div class="divider"></div><h3>Review before queueing</h3><p>${review.queued.length} pairing(s) ready · ${review.duplicates.length} already applied · ${review.rejected.length} unusable.</p><div class="code-list">${review.queued.map(r => `<div><strong>${h(r.resumeName)}</strong> → ${h(r.link)}</div>`).join('') || '<p class="muted">Nothing here can be queued yet.</p>'}</div>${refused.length ? `<div class="info">${refused.map(r => `<div>${h(r.where)}: ${h(r.fault)}</div>`).join('')}</div>` : ''}<p class="hint">Queued resumes are uploaded exactly as supplied. The extension will not tailor or replace them.</p>${button('commit-pairings',`Queue ${review.queued.length} paired job(s)`,'primary',review.queued.length ? '' : 'disabled')}`;
  if (review.rejected.length) notify(`${review.rejected.length} pairing(s) cannot be used. Fix them in the folder, or they will never be applied to.`,true);
}
const actionHandlers = {
  'download-run-log':()=>download(JSON.stringify(data.run,null,2),`apply-bot-run-${new Date().toISOString().slice(0,10)}.json`,'application/json'),

  'job-detail':async target=>{const job=await getJob(target.dataset.id);if(job)content.querySelector('#job-detail').innerHTML=jobDetails(job);},
  'queue-eligible':async()=>{await requireIdle();const selected=(await allJobs()).filter(j=>['eligible','documents-ready'].includes(j.stage)&&j.screening?.decision==='eligible');if(!selected.length)throw new Error('No eligible pending jobs to resume.');await saveLinks([...new Set([...(await allLinks()).links,...selected.map(j=>j.sourceUrl||j.applyUrl)])]);notify(selected.length+' eligible jobs added to the queue. Start Run to resume saved stages.');},
  'recheck-job':async target=>{await requireIdle();const job=await getJob(target.dataset.id);await saveJob({...job,stage:'discovered',screeningKey:'',extractedAt:0,extractionRetryAt:0,hold:false});const keys=new Set([job.id,job.sourceUrl,job.applyUrl].filter(Boolean).map(canonicalUrl)),stored=await stateStorage.get(['elsewhere','passed']);await stateStorage.set({elsewhere:(stored.elsewhere||[]).filter(id=>!keys.has(canonicalUrl(id))),passed:Object.fromEntries(Object.entries(stored.passed||{}).filter(([id])=>!keys.has(canonicalUrl(id))))});await saveLinks([...new Set([...(await allLinks()).links,job.sourceUrl||job.applyUrl])]);await renderRoute();notify('Queued for fresh extraction and research. Start Run when ready.');},
  /* ------------------------------------------------- questions page */
  // Saved straight to SQLite rather than batched behind one Save button:
  // these are independent answers to independent questions, and a page of
  // forty with one Save is a page where a mistyped fortieth loses the
  // other thirty-nine.
  'save-answer':async target=>{
    const key=target.dataset.key,input=content.querySelector(`[data-question="${CSS.escape(key)}"] .answer-input`);
    await answerAsked(key,input?.value??'');
    await renderRoute();
    notify(String(input?.value??'').trim()?'Answer saved. Any form asking this again is filled from it.':'Answer cleared. This question goes back on the waiting list.');
  },
  'forget-question':async target=>{await forgetQuestion(target.dataset.key);await renderRoute();notify('Question removed. It will come back if a form asks it again.');},
  /**
   * The parked applications handed back to the queue.
   *
   * Queued, not sent. The answer is new and the forms were last seen
   * hours ago, so the next run reads the posting again and fills it with
   * the answer in place - which is also what keeps this honest about an
   * employer who closed the role in the meantime.
   */
  /* ---------------------------------------- putting a parked job back */
  'resume-unblocked':async()=>{
    await requireIdle();
    const ready=unblocked(await allJobs(),await answerPack());
    if(!ready.length)throw new Error('No parked application is waiting on an answered question.');
    for(const job of ready)await saveJob({...job,stage:'documents-ready',hold:false,reason:'Resumed: every question it stopped on now has your answer.',blockedBy:[]});
    await saveLinks([...new Set([...(await allLinks()).links,...ready.map(job=>job.sourceUrl||job.applyUrl)])]);
    await renderRoute();
    notify(`${ready.length} application${ready.length===1?'':'s'} back in the queue. Start Run to send ${ready.length===1?'it':'them'}.`);
  },
  // Back to `documents-ready` rather than to the front of discovery: the
  // resume, the letter and the compensation research are already on the
  // row, and the next run's banked-document drain sends them without
  // paying ChatGPT a second time for answers it already has.
  'resume-parked':async target=>{
    await requireIdle();
    const [entry]=resumable(await allJobs(),data.results).filter(item=>item.job.id===target.dataset.id);
    if(!entry)throw new Error('This application is no longer safe to queue again. Reload the page.');
    await queueParked([entry.job]);
    await renderRoute();
    notify(`${entry.job.company||'The application'} is back in the queue. Start Run to send it.`);
  },
  'resume-parked-all':async()=>{
    await requireIdle();
    // The captcha ones are left out on purpose: each needs an answer to
    // "did you finish it yourself", and a bulk button cannot ask.
    const ready=resumable(await allJobs(),data.results).filter(entry=>!entry.captcha).map(entry=>entry.job);
    if(!ready.length)throw new Error('Nothing is waiting that can be queued without a decision.');
    await queueParked(ready);
    await renderRoute();
    notify(`${ready.length} application${ready.length===1?'':'s'} back in the queue. Start Run to send ${ready.length===1?'it':'them'}.`);
  },
  // The applicant clicked the puzzle and pressed Submit. Recorded as an
  // application so the employer is protected from a second one - which is
  // the whole reason this is asked rather than assumed.
  'parked-was-sent':async target=>{
    await requireIdle();
    const job=await getJob(target.dataset.id);
    const result=data.results.find(row=>String(row.id)===String(job?.resultId));
    const applyUrl=result?.applyUrl||job?.applyUrl||job?.sourceUrl;
    if(!applyUrl)throw new Error('This application has no link to record against.');
    await importHistory([{...(result??{}),company:job.company,title:job.title,applyUrl,sourceUrl:job.sourceUrl,urls:historyUrls(result??{applyUrl,sourceUrl:job.sourceUrl})}]);
    await saveJob({...job,stage:'submitted',hold:false,reason:'You finished this one yourself; it will not be applied to again.'});
    await renderRoute();
    notify(`${job.company||'That application'} recorded as sent by you. It is protected from a second application.`);
  },
  'hold-job':async target=>{await requireIdle();const job=await getJob(target.dataset.id);await saveJob({...job,stage:'held',hold:true,reason:'Held by you. Recheck to return it to the queue.'});await renderRoute();},
  'reload-extension':() => reloadExtension(),
  retry:renderRoute, 'start-run':startRun,
  'stop-run':async () => { await chrome.runtime.sendMessage({type:'stop'}); await renderRoute(); notify('Stopping. Nothing new is being started, requests in flight are being cancelled, and autopilot is off.'); },
  'save-settings':saveSettings, 'save-schedule':saveSchedule, 'new-resume':newResume,
  'import-resume':() => document.getElementById('resume-import').click(),
  'back-resumes':() => location.hash = 'resumes', 'back-templates':() => location.hash = 'templates',
  'edit-resume':target => location.hash = `resumes/edit/${encodeURIComponent(target.dataset.id)}`,
  'edit-template':target => location.hash = `templates/edit/${encodeURIComponent(target.dataset.id)}`,
  'resume-menu':target => { const menu = document.getElementById(`resume-extra-${target.dataset.id}`); menu.hidden = !menu.hidden; },
  'duplicate-resume':async target => { const resume = await getResume(target.dataset.id), id = crypto.randomUUID(); await saveResume({...resume,id,name:`${resume.name} (copy)`,kind:'saved',createdAt:Date.now()}); location.hash = `resumes/edit/${id}`; },
  'delete-resume':async target => { const record = await getResume(target.dataset.id); if (!confirm(`Delete “${record.name}”? Application history will remain.`)) return; await deleteResume(record.id); await renderRoute(); },
  'export-resume':async target => { const resume = await getResume(target.dataset.id); download(JSON.stringify({version:1,name:resume.name,document:resume.document,sourceText:resume.sourceText},null,2),`${resume.name}.json`,'application/json'); },
  'download-resume':async target => { const resume = await getResume(target.dataset.id); if (resume.pdf) download(resume.pdf,`${resume.name}.pdf`); else if (resume.document) download(await buildDocumentPdf(applyTemplate(resume.document,data.profile.template),data.profile.template.theme),`${resume.name}.pdf`,'application/pdf'); else throw new Error('Review the imported content in the editor first.'); },
  'download-letter':async target => { const resume = await getResume(target.dataset.id); download(resume.letter,`${resume.name}-letter.txt`,'text/plain'); },
  'download-original':async target => { const resume = await getResume(target.dataset.id); download(resume.originalPdf,`${resume.name}-original.pdf`); },
  'new-template':async () => { const template = {...structuredClone(DEFAULT_TEMPLATE),id:crypto.randomUUID(),name:'My template'}; await saveTemplate(template); location.hash = `templates/edit/${template.id}`; },
  'activate-template':async target => { await writeProfile({activeTemplateId:target.dataset.id}); notify('Active template updated.'); await renderRoute(); },
  'duplicate-template':async target => { const template = await getTemplate(target.dataset.id); template.id = crypto.randomUUID(); template.name += ' (copy)'; await saveTemplate(template); location.hash = `templates/edit/${template.id}`; },
  'delete-template':async target => { if (!confirm('Delete this template?')) return; await deleteTemplate(target.dataset.id); if (data.profile.activeTemplateId === target.dataset.id) await writeProfile({activeTemplateId:'default'}); await renderRoute(); },
  'open-service':async target => { const service = pages.services.find(s => s.id === target.dataset.id), tab = await findTab(service.patterns); if (tab) await focus(tab.id); else await chrome.tabs.create({url:service.id === 'hiringcafe' && data.profile.hiringCafeUrl ? data.profile.hiringCafeUrl : service.url,active:true}); },
  'test-chatgpt':async () => { if (data.run.running) throw new Error('Wait for the run to finish before testing ChatGPT.'); notify('Checking ChatGPT…'); const result = await chatGptRoundTrip(); if (!result.ok) throw new Error(result.error); notify('ChatGPT connection works.'); },
  'load-links':async () => { await saveSettings(); const sources = [data.profile.pastedLinks]; if (data.profile.sheetUrl) { const response = await fetch(sheetCsvUrl(data.profile.sheetUrl)); if (!response.ok) throw new Error(`Sheet request failed (${response.status}).`); const text = await response.text(); if (isSignInPage(text)) throw new Error('Share the sheet with anyone who has the link first.'); sources.push(...linksFromCsv(text)); } const loaded = buildQueue(sources); if (!loaded.length) throw new Error('No job links found. Paste links or add a public Google Sheet.'); await saveLinks(loaded); notify(`${loaded.length} unique job links loaded.`); await renderRoute(); },
  'clear-links':async () => { await clearLinks(); await renderRoute(); },
  'check-pairings':async () => { await saveSettings(); const rows = parsePairedLines(data.profile.pairedLinks); if (!rows.length) throw new Error('Add one line per job: the posting link, then the label of a resume in My resumes.'); const byName = new Map(data.resumes.map(r => [String(r.name || '').trim().toLowerCase(),r]));
    await showPairingPreview(rows.map(row => { const saved = byName.get(row.label.toLowerCase());
      return {folder:'',company:saved?.job?.company || '',title:saved?.job?.title || '',link:row.link,resumeId:saved?.id || '',resumeName:saved?.name || row.label,
        fault:!row.label ? 'no resume label follows this link' : !saved ? `no resume in your library is named “${row.label}”` : saved.pdf || saved.originalPdf ? '' : `“${saved.name}” has no PDF to upload; export or import one first`};
    })); },
  'pick-pairing-folder':() => document.getElementById('pairing-folder').click(),
  'commit-pairings':async () => { const queued = pairingPreview; if (!queued.length) return;
    for (const record of queued) if (record.saved) await saveResume(record.saved);
    // Re-importing a folder replaces that posting's pairing rather than
    // queueing it twice, so a corrected resume simply wins.
    const keys = new Set(queued.map(r => canonicalUrl(r.link)));
    await savePairings([...(await allPairings()).filter(p => !keys.has(canonicalUrl(p.link))),...queued.map(({link,resumeId,resumeName,company,title,folder}) => ({link,resumeId,resumeName,company,title,folder}))]);
    pairingPreview = []; await renderRoute(); notify(`${queued.length} job link(s) queued with the resume you chose for each.`); },
  'clear-pairings':async () => { await clearPairings(); pairingPreview = []; await renderRoute(); },
  'preview-history':async () => showHistoryPreview(historyCandidates(content.querySelector('#history-links').value)),
  'preview-companies':async () => showHistoryPreview(companyCandidates(content.querySelector('#history-companies').value)),
  'pick-history-folder':() => document.getElementById('history-folder').click(),
  'pick-history-files':() => document.getElementById('history-files').click(),
  'commit-history':async () => { await requireIdle(); const count = historyPreview.length; if(!count) return; await importHistory(historyPreview); historyPreview=[]; await renderRoute(); notify(`${count} company entries imported. All roles at those companies are blocked.`); },
  'set-history-company':async target => { await requireIdle(); const row=data.history.find(r=>r.id===target.dataset.id), value=prompt('Company name. Add alternate names after semicolons if needed.',[row.company,...(row.companyAliases || [])].filter(Boolean).join('; ')); if(value === null) return; const [company,...aliases]=value.split(';').map(s=>s.trim()); await setHistoryCompany(row.id,company,aliases); await renderRoute(); },
  'remove-history':async target => { await requireIdle(); if(!confirm('Remove this protection? Only continue if you are sure this job was not submitted or you intentionally want to apply again. Confirmed extension submissions remain in Applications history.')) return; await deleteHistory(target.dataset.id); await renderRoute(); },
  'export-history':() => download(JSON.stringify({companies:data.history},null,2),'already-applied-companies.json','application/json'),
  'mark-applied':async target => { await requireIdle(); const r=data.results.find(r=>r.id===target.dataset.id); if(!r?.applyUrl) return; await importHistory([{...r,urls:historyUrls(r)}]); notify('Marked as already applied. Future matching jobs will be skipped.'); },
  backup:async () => { const value = await db({action:'export'}); download(base64ToBytes(value),`apply-bot-${new Date().toISOString().slice(0,10)}.sqlite3`); },
  'restore-backup':() => document.getElementById('backup-import').click(),
  'export-settings':async () => { if (content.querySelector('#settings-form')) await saveSettings(); const exported = withDefaults(data.profile); delete exported.workdayPassword; delete exported.activeTemplateId; download(JSON.stringify(exported,null,2),'apply-bot-settings.json','application/json'); },
  'import-settings':() => document.getElementById('settings-import').click(),
  'export-csv':() => download(resultsCsv(data.results),`applications-${new Date().toISOString().slice(0,10)}.csv`,'text/csv'),
  'application-detail':async target => {
    const record = data.results.find(r => String(r.id) === target.dataset.id), folder = record.detail?.folder || '';
    const screenshot = record.detail?.lastScreenshot;
    const files = folder ? await db({action:'fileMetadata',prefix:folder+'/'}) : [];
    const picture=screenshot?.path ? await db({action:'get',table:'files',id:screenshot.path}) : null;
    if(picture&&!files.some(f=>f.id===picture.id)){const {content,...metadata}=picture;files.push(metadata);}
    clearApplicationImage();
    if(picture?.content instanceof Blob)applicationImageUrl=URL.createObjectURL(picture.content);
    content.querySelector('#application-detail').innerHTML = `<section class="card"><h2>${h(record.company)} · ${h(record.title)}</h2><p class="muted">${h(record.reason || record.status)}</p><a href="${pages.safeHref(record.applyUrl)}" target="_blank" rel="noreferrer">Open application page ↗</a>${record.detail?.screenshotError ? `<p class="info">Final screenshot could not be completed; the application tab was kept open. ${h(record.detail.screenshotError)}</p>` : ''}${applicationImageUrl ? `<section class="card"><h3>Last saved application page</h3><p class="hint">Saved before the extension finished this attempt. ${h(new Date(screenshot.capturedAt).toLocaleString())}</p><a href="${applicationImageUrl}" target="_blank" rel="noreferrer"><img src="${applicationImageUrl}" alt="Last saved application page" style="display:block;max-width:100%;max-height:650px;object-fit:contain;border:1px solid #ddd;border-radius:8px"></a></section>` : ''}${compensationHtml(record.detail?.compensation)}<div class="file-list">${files.map(f => button('download-file',f.path === screenshot?.path ? 'Last page screenshot (PNG)' : h(f.path.slice(folder.length+1)),'',`data-id="${h(f.id)}"`)).join('') || '<p class="muted">No archived files for this result.</p>'}</div></section>`;
  },
  'download-file':async target => { const file = await db({action:'get',table:'files',id:target.dataset.id}); if (file) download(file.content,file.path.split('/').at(-1),file.type); },
  // Everything the workspace holds, written to disk under the folder names
  // the runs would have used. For the profiles that applied for weeks with
  // the export switched off: the documents are all in SQLite, and this is
  // how they come out without replaying a single application.
  'export-workspace':async target => {
    const files = await db({action:'fileMetadata',prefix:''});
    if (!files.length) { notify('Nothing archived yet, so there is nothing to write out.'); return; }
    const label = target.textContent;
    let written = 0, failed = 0, firstError = '';
    for (const metadata of files) {
      const file = await db({action:'get',table:'files',id:metadata.id});
      if (!file?.content) continue;
      try { await writeToDownloads(file.content, `${ROOT}/${file.path}`); written += 1; }
      catch (error) { failed += 1; firstError ||= error?.message ?? String(error); }
      target.textContent = `Writing ${written + failed} of ${files.length}…`;
    }
    target.textContent = label;
    notify(`${written} file(s) written to Downloads/${ROOT}/.${failed ? ` ${failed} could not be written: ${firstError}` : ''}`);
  },
};
/**
 * Through the downloads API rather than an anchor, because an anchor's
 * `download` attribute cannot name a folder - the browser flattens the path
 * and the company-and-role folders are most of what makes the export worth
 * having. A page may hand it a blob URL; a service worker may not, which is
 * why src/vault.js takes the longer data: URL route.
 */
async function writeToDownloads(content, filename) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([String(content)]));
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [item] = await chrome.downloads.search({ id }).catch(() => []);
      if (!item) break;
      if (item.state === 'interrupted') throw new Error(item.error || 'the download was interrupted');
      if (item.state !== 'in_progress') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}
const showApplicationDetail = actionHandlers['application-detail'];
actionHandlers['application-detail'] = async target => {
  await showApplicationDetail(target);
  const record=data.results.find(r=>String(r.id)===target.dataset.id), timings=record.detail?.timings || {};
  content.querySelector('#application-detail').insertAdjacentHTML('beforeend',`<section class="card">${['dry-run','manual'].includes(record.status) ? button('mark-applied','I completed this application','',`data-id="${h(record.id)}"`) : ''}${Object.keys(timings).length ? `<p class="hint">Timing (includes waiting): ${Object.entries(timings).filter(([,ms])=>Number.isFinite(ms)).map(([key,ms])=>`${h(key)} ${(ms/1000).toFixed(1)}s`).join(' · ')}</p>` : ''}</section>`);
};
for (const id of ['history-folder','history-files']) document.getElementById(id).addEventListener('change',async event => {
  const files=[...event.target.files]; event.target.value=''; if(!files.length) return;
  try { notify('Reading link files…'); const value=await readHistoryFiles(files); await showHistoryPreview(value.candidates,`${value.ignored} unrelated files ignored; ${value.empty} link files had no valid URL.`); } catch(error) { fail(error); }
});
document.getElementById('pairing-folder').addEventListener('change',async event => {
  const files=[...event.target.files]; event.target.value=''; if(!files.length) return;
  try { notify('Reading each folder and its resume…'); await showPairingPreview(await readPairingFiles(files)); } catch(error) { fail(error); }
});
content.addEventListener('click',async event => {
  const target = event.target.closest('[data-action]'), handler = target && actionHandlers[target.dataset.action]; if (!handler) return;
  target.disabled = true;
  try { await handler(target); } catch (error) { fail(error); } finally { if (target.isConnected) target.disabled = false; }
});
content.addEventListener('input',event => {
  if (event.target.id === 'history-search') { const query=event.target.value.toLowerCase(); document.getElementById('history-table').innerHTML=pages.historyTable(data.history.filter(r=>`${r.company} ${(r.companyAliases || []).join(' ')} ${r.title} ${r.applyUrl}`.toLowerCase().includes(query))); }
  if (event.target.closest('#settings-form,[data-settings]') && event.target.dataset.key) { dirty = true; const label = content.querySelector('.save-bar small'); if (label) label.textContent = 'Unsaved changes'; }
  if (['resume-search','resume-filter'].includes(event.target.id)) {
    const query = document.getElementById('resume-search').value.toLowerCase(), type = document.getElementById('resume-filter').value;
    document.getElementById('resume-grid').innerHTML = pages.resumeCards(data.resumes.filter(r => (r.name + ' ' + (r.document?.targetTitle || '')).toLowerCase().includes(query) && (type === 'all' || (type === 'generated' ? r.kind === 'generated' : r.kind !== 'generated'))),data.profile);
  }
  if (['application-search','application-filter'].includes(event.target.id)) {
    const query = document.getElementById('application-search').value.toLowerCase(), type = document.getElementById('application-filter').value;
    document.getElementById('application-table').innerHTML = pages.applicationsTable(data.results.filter(r => `${r.company} ${r.title}`.toLowerCase().includes(query) && (type === 'all' || r.status === type)));
  }
});
document.getElementById('resume-import').addEventListener('change',async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error('Import a resume smaller than 12 MB.');
    const record = {id:crypto.randomUUID(),name:file.name.replace(/\.[^.]+$/,''),kind:'saved',createdAt:Date.now()};
    if (/\.json$/i.test(file.name)) {
      const value = JSON.parse(await file.text()), doc = value.document || (value.sections ? value : null);
      if (doc && !Array.isArray(doc.sections)) throw new Error('This is not an exported resume.');
      if (!doc && !value.sourceText) throw new Error('This file contains no resume content.');
      record.name = String(value.name || record.name);
      record.document = doc ? toDocument(doc,{name:String(doc.name || ''),email:String(doc.contact?.email || ''),phone:String(doc.contact?.phone || ''),location:String(doc.contact?.location || ''),links:Array.isArray(doc.contact?.links) ? doc.contact.links : []}) : null;
      record.sourceText = record.document ? documentText(record.document) : String(value.sourceText);
    }
    else if (/\.pdf$/i.test(file.name)) { record.sourceText = await extractPdf(file); record.originalPdf = new Blob([await file.arrayBuffer()],{type:'application/pdf'}); if (!record.sourceText.trim()) throw new Error('This PDF contains no extractable text. Paste its text or create a resume manually.'); }
    else record.sourceText = await file.text();
    await saveResume(record); location.hash = `resumes/edit/${record.id}`; notify('Resume imported. Review its content in the editor.');
  } catch (error) { fail(error); }
});
document.getElementById('backup-import').addEventListener('change',async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try { if (!confirm('Replace this workspace with the selected SQLite backup? Export the current database first if you need to keep it.')) return; const bytes = new Uint8Array(await file.arrayBuffer()); if (new TextDecoder().decode(bytes.subarray(0,15)) !== 'SQLite format 3') throw new Error('Choose a SQLite database backup.'); await db({action:'import',value:bytesToBase64(bytes)}); dirty = false; await renderRoute(); notify('SQLite backup restored.'); } catch (error) { fail(error); }
});
document.getElementById('settings-import').addEventListener('change',async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try { const value = JSON.parse(await file.text()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a settings JSON object.');
    await writeProfile(value); dirty = false; await renderRoute(); notify('Settings imported. Review the profile before running.');
  } catch (error) { fail(error); }
});
document.getElementById('refresh-tabs').addEventListener('click',async () => { try { if (dirty) { await detectConnections(); notify(`${data.connections.filter(c => c.tab).length} service tabs detected. Your unsaved edits are preserved.`); } else await renderRoute(); } catch (error) { fail(error); } });
content.addEventListener('input',event=>{if(!['job-search','job-filter'].includes(event.target.id))return;const search=(document.getElementById('job-search')?.value||'').toLowerCase(),stage=document.getElementById('job-filter')?.value||'all';const rows=(data.jobs||[]).filter(j=>(stage==='all'||j.stage===stage)&&[j.company,j.title,j.reason].join(' ').toLowerCase().includes(search));content.querySelector('#jobs-table').innerHTML=jobsTable(rows);});
window.addEventListener('hashchange',renderRoute);
window.addEventListener('beforeunload',event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
let statePolling=false;
setInterval(async () => {if(statePolling)return;statePolling=true;try {
 const wasRunning=data.run?.running;data.run=await deadline(chrome.runtime.sendMessage({type:'state'}),5000,'The extension is not responding. Reload it if the connection does not recover.');updateRunState();
 if(wasRunning&&!data.run.running&&!dirty&&location.hash!=='#monitor')await renderRoute();
 const body=document.getElementById('monitor-body');if(body){const openDetails=[...body.querySelectorAll('details[open]')].map(e=>e.textContent);body.innerHTML=monitorBody(data.run);for(const el of body.querySelectorAll('details'))if(openDetails.includes(el.textContent))el.open=true;}
 const warning=document.getElementById('monitor-connection');if(warning)warning.hidden=true;
 const log=document.getElementById('live-log');if(log)log.innerHTML=pages.runLogHtml(data.run);
 }catch(error){const warning=document.getElementById('monitor-connection');if(warning){warning.hidden=false;warning.textContent=error.message;}}finally{statePolling=false;}
},2000);
renderRoute();
