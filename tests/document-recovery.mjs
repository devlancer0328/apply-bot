import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {stage} from '../src/stages.js';
import {toResume} from '../src/resume.js';
import {normalizeResume} from '../src/vendor/generation.js';
// The real reuse code and the real writeApplication, lifted out of
// writer.js rather than described again here: the point of this file is
// how many times ChatGPT is asked for a resume, and a reimplementation of
// the decision would answer about itself.
const source=await readFile(new URL('../src/writer.js',import.meta.url),'utf8');
const code=(source.slice(source.indexOf('/* ------------------------------------------------- reuse by role family */'),source.indexOf('export function resumeToText'))+source.slice(source.indexOf('export async function writeApplication'))).replace(/^export /gm,'');
let resumeCalls=0,letterCalls=0,failLetter=true;const saved=new Map(),doc={name:'Candidate',contact:{email:'candidate@example.test'},sections:[{heading:'Summary',paragraphs:['Relevant engineering experience.']}]},pdf=new Uint8Array([37,80,68,70,45,49]),candidate={name:'Candidate',email:'candidate@example.test'};
class ProviderError extends Error{}class WriterError extends Error{}
const context={stage,Blob,Uint8Array,crypto,Date,ProviderError,WriterError,normalizeResume,toResume,candidateFrom:()=>candidate,normalizeTemplate:()=>({theme:{}}),applyTemplate:document=>document,buildDocumentPdf:async()=>pdf,MODEL:'ChatGPT',documentText:()=>doc.name,resumeToText:()=>doc.name,record:()=>0,saveResume:async row=>saved.set(row.id,row),writeResume:async()=>{resumeCalls++;return {resume:{name:'Candidate'},document:doc,pdf,usage:{calls:1},settings:{theme:{}},aiMode:{selected:'high'}};},generateCoverLetter:async()=>{letterCalls++;if(failLetter)throw new ProviderError('Interrupted letter');return {text:'Dear hiring team',usage:{calls:1}};},buildCoverLetterPdf:async()=>pdf,researchCompensation:async()=>({sources:[{url:'https://example.test/role'}]})};
vm.createContext(context);
const write=vm.runInContext(code+';writeApplication',context);
const forget=vm.runInContext('forgetFamilyDocuments',context);

/* -------------------------------- the posting's own saved documents */

// Role-family reuse is off for these: they are about the exact-posting
// snapshot, and a family hit would answer before the snapshot was asked.
const exact={resumeReuse:'posting'};
const job={title:'Engineer',company:'Example',jd:'Original description',url:'https://example.test/role',libraryId:'stable-library-id',documentKey:'same-inputs'};
await assert.rejects(()=>write(exact,job,undefined,{}),/Interrupted letter/);
const partial=saved.get(job.libraryId);assert.ok(partial.pdf instanceof Blob);assert.equal(partial.documentKey,job.documentKey);assert.equal(partial.aiMode.selected,'high');
failLetter=false;
const result=await write(exact,job,undefined,{resumeSnapshot:partial});
assert.equal(resumeCalls,1);assert.equal(letterCalls,2);assert.equal(result.libraryId,job.libraryId);assert.deepEqual(new Uint8Array(await result.resumeBlob.arrayBuffer()),pdf);assert.ok(saved.get(job.libraryId).letterPdf instanceof Blob);
console.log('PASS A later run reuses the persisted High-mode PDF after a cover-letter failure, preserves its ID and completes remaining stages');
await write(exact,{...job,documentKey:'different-inputs',libraryId:'other-library-id'},undefined,{resumeSnapshot:partial});assert.equal(resumeCalls,2);
console.log('PASS Changed document inputs cannot reuse a partial resume from another signature');
await write(exact,job,undefined,{resumeSnapshot:{...partial,aiMode:{selected:'instant'}}});assert.equal(resumeCalls,3);
console.log('PASS Partial recovery cannot bypass the High-mode requirement');

/* ------------------------------------------------ reuse by role family */

const posting=(title,n)=>({title,company:'Example '+n,jd:'Description '+n,url:'https://example.test/'+n,libraryId:'library-'+n,documentKey:'key-'+n});
forget();resumeCalls=0;
for(const [n,title] of [[1,'Senior Backend Engineer'],[2,'Senior Software Engineer, APIs'],[3,'Sr. Server Engineer (Go)']].entries()) await write({},posting(title,n),undefined,{});
assert.equal(resumeCalls,1,'three senior back-end postings share one resume');
await write({},posting('Senior iOS Engineer',4),undefined,{});
assert.equal(resumeCalls,2,'a different family writes its own');
await write({},posting('Staff Backend Engineer',5),undefined,{});
assert.equal(resumeCalls,3,'and so does a different seniority in the same family');
console.log('PASS One High-mode resume is written per role family and seniority, not per posting');

forget();resumeCalls=0;
const titled=await write({},posting('Senior Backend Engineer',6),undefined,{});
const shared=await write({},posting('Senior Backend Engineer, Payments',7),undefined,{});
assert.equal(resumeCalls,1);
assert.equal(titled.role,'Senior Backend Engineer');assert.equal(shared.role,'Senior Backend Engineer, Payments');
assert.equal(saved.get('library-7').document.targetTitle,'Senior Backend Engineer, Payments','the shared document is headed with the posting it is being sent to');
assert.equal(saved.get('library-7').documentKey,'key-7','and keeps its own signature, so its own posting can still cache it');
console.log('PASS A shared resume carries the title of the posting it is sent to, not the one it was written for');

forget();resumeCalls=0;
for(const n of [8,9]) await write({resumeReuse:'posting'},posting('Senior Backend Engineer',n),undefined,{});
assert.equal(resumeCalls,2,'resumeReuse:posting pays for tailoring every time');
console.log('PASS The trade is a setting: every posting gets its own resume when asked for');

forget();resumeCalls=0;
const fallback={...doc};
context.writeResume=async()=>{resumeCalls++;return {resume:{name:'Candidate'},document:fallback,pdf,usage:{calls:1},settings:{theme:{}},aiMode:{selected:'medium'}};};
for(const n of [10,11]) await write({},posting('Senior Backend Engineer',n),undefined,{});
assert.equal(resumeCalls,2,'a document ChatGPT would not write at High effort is not handed to a second posting');
console.log('PASS Only a verified High-mode document is shared across a family');
const chat=await readFile(new URL('../src/chatgpt.js',import.meta.url),'utf8'),converseCode=chat.slice(chat.indexOf('async function converse(prompt, options)'),chat.indexOf('/* --------------------------------------------------------------- bridge */'));
for(const resumeOnly of [false,true]){
 const prompt='Profile links: [{"label":"LinkedIn","url":"https://example.test/profile"}] End.';
 const shown='Profile links: {"label":"LinkedIn","url":"[https://example.test/profile"}] End.';
 for(const wrong of [false,true]){
  const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
  Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let sends=0;
  const add=()=>{const user=dom.document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=wrong?shown.replace('/profile','/another'):shown;user.insertAdjacentHTML('beforeend','<button>Show less</button>');dom.document.body.append(user);const assistant=dom.document.createElement('div');assistant.dataset.messageAuthorRole='assistant';assistant.textContent='Assigned response';dom.document.body.append(assistant);};
  const location={pathname:resumeOnly?'/c/assigned':'/',href:'https://chatgpt.com'+(resumeOnly?'/c/assigned':'/')};
  dom.document.querySelector('button').onclick=()=>{sends++;location.pathname='/c/assigned';location.href='https://chatgpt.com/c/assigned';add();};if(resumeOnly)add();let now=100000;
  const run=vm.runInNewContext('('+converseCode+')',{document:dom.document,window:dom.window,location,Date:{now:()=>now},setTimeout:cb=>queueMicrotask(cb),HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL});
  const started=await run(prompt,{resumeOnly,detached:true,taskId:'labelled',timeoutMs:360000,settleMs:0});
  if(wrong){if(resumeOnly)assert.equal(started.reason,'prompt-not-found');else{await dom.window.__applyBotChatTask.check(false);now+=11000;const failed=await dom.window.__applyBotChatTask.check(false);assert.equal(failed.reason,'conversation-changed',JSON.stringify(failed));}}
  else{assert.equal(started.started,true);await dom.window.__applyBotChatTask.check(false);assert.equal((await dom.window.__applyBotChatTask.check(false)).text,'Assigned response');}
  assert.equal(sends,resumeOnly?0:1);
 }
 console.log('PASS Labelled JSON URL chips retain full identity during '+(resumeOnly?'refresh recovery':'initial binding')+' and a different URL is rejected');
}
