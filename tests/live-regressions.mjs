import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {virtualFeed} from './jobright-fixture.mjs';

const instant = callback => queueMicrotask(callback);
const feed=virtualFeed({count:3});
const collected=await feed.collect(8);
assert.equal(collected.complete,true);assert.equal(collected.links.length,3);
console.log('PASS Jobright retains jobs removed from the DOM during scrolling');

const source=await readFile(new URL('../src/chatgpt.js',import.meta.url),'utf8');
const converseSource=source.slice(source.indexOf('async function converse(prompt, options)'),source.indexOf('/* --------------------------------------------------------------- bridge */'));
{
 const fixture=parseHTML('<html><body><nav><button>Retry</button></nav><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
 Object.defineProperty(fixture.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});
 fixture.document.querySelector('[data-testid="send-button"]').onclick=()=>{const user=fixture.document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent='Diagnose a network error when something went wrong; display Retry.';fixture.document.body.append(user);const answer=fixture.document.createElement('div');answer.dataset.messageAuthorRole='assistant';answer.textContent='Supported answer';fixture.document.body.append(answer);};
 const run=vm.runInNewContext('('+converseSource+')',{document:fixture.document,window:fixture.window,location:{href:'https://chatgpt.com/c/assigned',pathname:'/c/assigned'},HTMLTextAreaElement:fixture.window.HTMLTextAreaElement,Event:fixture.window.Event,setTimeout:cb=>queueMicrotask(cb)});
 assert.equal((await run('Diagnose a network error',{timeoutMs:1000,settleMs:0})).text,'Supported answer');
 console.log('PASS Error wording in a job prompt and an unrelated sidebar Retry cannot cause a platform-error refresh');
}
const chat=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
Object.defineProperty(chat.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});
let sent=0;
chat.document.querySelector('button').onclick=()=>{
  sent++;const error=chat.document.createElement('div');
  const longPrompt=chat.document.createElement('p');longPrompt.textContent='Job description content. '.repeat(500);
  chat.document.body.append(longPrompt);
  error.setAttribute('role','alert');
  error.innerHTML='Your account changed. Send your message again <button>Retry</button>';
  chat.document.body.append(error);
};
const converse=vm.runInNewContext(`(${converseSource})`,{
  document:chat.document,location:{href:'https://chatgpt.com/'},setTimeout:instant,
  HTMLTextAreaElement:chat.window.HTMLTextAreaElement,Event:chat.window.Event
});
const reply=await converse('Connection check',{timeoutMs:1000,settleMs:1});
assert.equal(reply.reason,'account-changed');assert.equal(reply.ok,false);assert.equal(sent,1);
console.log('PASS ChatGPT account-change notices are detected immediately for the central recovery handler');

const stale=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
let staleSends=0;stale.document.querySelector('button').onclick=()=>{staleSends++;};
const guardedConverse=vm.runInNewContext(`(${converseSource})`,{
  document:stale.document,location:{href:'https://chatgpt.com/'},HTMLTextAreaElement:stale.window.HTMLTextAreaElement,Event:stale.window.Event,
  setTimeout:(callback,ms)=>queueMicrotask(()=>{if(ms===400)stale.document.querySelector('textarea').value='A previous job description';callback();})
});
assert.equal((await guardedConverse('The intended prompt',{timeoutMs:1000,settleMs:1})).reason,'composer-changed');
assert.equal(staleSends,0);
console.log('PASS A stale ChatGPT draft cannot be sent instead of the intended prompt');

const linked=parseHTML('<html><body><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></body></html>');
const editor=linked.document.querySelector('#prompt-textarea');let linkedSends=0;
Object.defineProperty(editor,'innerText',{get:()=>editor.textContent.replace('"url":"https','"url":" https')});
linked.document.execCommand=(command,_ui,value)=>{if(command==='delete')editor.textContent='';if(command==='insertText')editor.textContent=value;return true;};
linked.document.querySelector('button').onclick=()=>{linkedSends++;const notice=linked.document.createElement('div');notice.setAttribute('role','alert');notice.innerHTML='Your account changed. Send your message again <button>Retry</button>';linked.document.body.append(notice);};
const linkedConverse=vm.runInNewContext(`(${converseSource})`,{document:linked.document,location:{href:'https://chatgpt.com/'},setTimeout:instant});
assert.equal((await linkedConverse('Expected request\n{"url":"https://example.test/profile"}',{timeoutMs:1000,settleMs:1})).reason,'account-changed');
assert.equal(linkedSends,1);
console.log('PASS URL presentation spacing cannot reject an otherwise exact ChatGPT prompt');

const {writeResume,WriterError}=await import('../src/writer.js');
const {generateResumeInChat}=await import('../src/resume.js');
let requests=0;
let response={contextRequired:true,message:'Add candidate information in ChatGPT.'};
const prompts=[];
globalThis.chrome={
  tabs:{query:async()=>[{id:1,windowId:1,index:0,url:'https://chatgpt.com/'}],get:async()=>({id:1,windowId:1,status:'complete',url:'https://chatgpt.com/'}),update:async()=>({id:1,windowId:1})},
  windows:{getLastFocused:async()=>({id:1}),update:async()=>({})},
  scripting:{executeScript:async({func,args})=>{if(func.name==='selectChatGptMode')return [{result:{ok:true,requested:args[0],selected:args[0]}}];if(func.name==='converse'){requests++;prompts.push(args[0]);}return [{result:{ok:true,text:JSON.stringify(response)}}];}}
};
try {
  await assert.rejects(writeResume({chatGptProjectUrl:'https://chatgpt.com/g/g-p-daniel/project'},{company:'Example',title:'Engineer',jd:'A job description'}),error=>error instanceof WriterError&&error.status===401&&/candidate information/.test(error.message));
  assert.equal(requests,1);
  response={summary:'A resume returned by the project.',certifications:['A certification from the reply']};
  const jd='  Job description\n'+('Description content. '.repeat(1000))+'\nEnd.  ';
  const generated=await generateResumeInChat({projectUrl:'https://chatgpt.com/g/g-p-daniel/project',jd,candidate:{name:'Example Candidate',email:'',phone:'',location:''},model:'ChatGPT'});
  assert.equal(prompts.at(-1),jd);assert.equal(requests,2);
  assert.equal(generated.document.sections.find(x=>x.heading==='Certifications').entries[0].title,response.certifications[0]);
  console.log('PASS Resume requests preserve the complete JD exactly, without wrappers or formatting commands');
  globalThis.chrome.scripting.executeScript=async({func,args})=>{if(func.name==='selectChatGptMode')return [{result:{ok:true,requested:args[0],selected:args[0]}}];if(func.name==='converse'&&!args?.[1]?.resumeOnly)requests++;return [{result:{ok:false,reason:'conversation-changed',diagnostics:['The assigned conversation changed']}}];};
  await assert.rejects(writeResume({chatGptProjectUrl:'https://chatgpt.com/g/g-p-daniel/project'},{company:'Example',title:'Engineer',jd:'Assigned posting'}),error=>error instanceof WriterError&&error.retryable===false);
  assert.equal(requests,3);
  const {answerQuestion,AiError}=await import('../src/ai.js');
  globalThis.chrome.scripting.executeScript=async({func,args})=>{if(func.name==='selectChatGptMode')return [{result:{ok:true,requested:args[0],selected:args[0]}}];if(func.name==='converse')requests++;return [{result:{ok:false,reason:'composer-changed',diagnostics:['The composer changed']}}];};
  await assert.rejects(answerQuestion({question:'Describe your work'},{company:'Example',title:'Engineer'},{}),error=>error instanceof AiError&&error.fatal===true);
  assert.equal(requests,7);
  console.log('PASS Changed conversations keep their no-retry marker and changed composers stop form AI after the bounded refresh retries');
} finally {delete globalThis.chrome;}
console.log('PASS Missing ChatGPT candidate context is a setup error that stops the run');

const {verifyNativeSourceCards}=await import('../src/chatgpt.js');
const nativeTitle='Job Application for Software Engineer at Example Company';
const cardReply={text:JSON.stringify({sources:[{url:'https://careers.example.test/jobs/123',title:nativeTitle}]}),searchEvidence:{nativeSourceCards:[{title:nativeTitle,domain:'careers.example.test'}]}};
const originalFetch=globalThis.fetch;let pageRequests=0;
try {
  globalThis.fetch=async(url,options)=>{pageRequests++;assert.equal(options.credentials,'omit');return new Response(`<title>${nativeTitle}</title>`);};
  assert.equal((await verifyNativeSourceCards(cardReply))[0].verification,'native-source-card-and-page-title');
  assert.deepEqual(await verifyNativeSourceCards({...cardReply,searchEvidence:{}}),[]);
  assert.equal(pageRequests,1);
  assert.deepEqual(await verifyNativeSourceCards({...cardReply,text:JSON.stringify({sources:[{url:'https://unrelated.example.test/jobs/123'}]})}),[]);
  assert.equal(pageRequests,1);
  globalThis.fetch=async()=>new Response('<title>Different employer and job</title>');
  assert.deepEqual(await verifyNativeSourceCards(cardReply),[]);
} finally {globalThis.fetch=originalFetch;}
console.log('PASS Native source cards require matching domains and independently fetched page titles');

const sourceDOM=parseHTML('<html><body><div role="dialog"><a href="https://unrelated.example.test">Unrelated existing dialog</a></div><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></body></html>');
sourceDOM.document.querySelector('button').onclick=()=>{
  const turn=sourceDOM.document.createElement('div');turn.setAttribute('data-message-author-role','assistant');
  turn.innerHTML='<pre><code>{"status":"researched"}</code></pre><span data-d-component="popover-trigger" aria-haspopup="dialog" aria-expanded="false"><div data-d-component="badge"><span data-d-component="favicon"></span>Sources</div></span>';
  sourceDOM.document.body.append(turn);const trigger=turn.querySelector('[aria-haspopup]');
  trigger.onclick=()=>{
    if(trigger.getAttribute('aria-expanded')==='true'){trigger.setAttribute('aria-expanded','false');sourceDOM.document.querySelector('[data-native-popup]').remove();return;}
    trigger.setAttribute('aria-expanded','true');const popup=sourceDOM.document.createElement('div');popup.setAttribute('role','dialog');popup.setAttribute('data-native-popup','');
    popup.innerHTML=`<button data-d-component="pressable" aria-label="Open employer"><span data-d-component="favicon"><img src="https://www.google.com/s2/favicons?domain=https://careers.example.test"></span><span data-d-weight="medium">${nativeTitle}</span></button>`;
    sourceDOM.document.body.append(popup);
  };
};
const sourceConverse=vm.runInNewContext(`(${converseSource})`,{document:sourceDOM.document,location:{href:'https://chatgpt.com/'},setTimeout:instant,HTMLTextAreaElement:sourceDOM.window.HTMLTextAreaElement,Event:sourceDOM.window.Event,URL});
const sourceReply=await sourceConverse('Research this employer',{timeoutMs:1000,settleMs:0,webSearch:true});
assert.equal(sourceReply.searchEvidence.nativeSourceCards.length,1);
assert.equal(sourceReply.searchEvidence.nativeSourceCards[0].domain,'careers.example.test');
assert.equal(sourceDOM.document.querySelector('[aria-haspopup]').getAttribute('aria-expanded'),'false');
console.log('PASS Native source popovers are read and closed without trusting unrelated dialog links');

for(const variant of ['badge','anchor']){
 const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><section data-content-search-unit-key="fallback:assistant"></section></body></html>');
 Object.defineProperty(dom.window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let polls=0;
 dom.document.querySelector('button').onclick=()=>{const user=dom.document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent='Assigned research';dom.document.body.append(user);const turn=dom.document.createElement('div');turn.dataset.messageAuthorRole='assistant';turn.textContent='Supported answer';dom.document.querySelector('section').append(turn);};
 const context={document:dom.document,window:dom.window,location:{href:'https://chatgpt.com/c/assigned',pathname:'/c/assigned'},HTMLTextAreaElement:dom.window.HTMLTextAreaElement,Event:dom.window.Event,URL,setTimeout:(cb,ms)=>queueMicrotask(()=>{
  if(ms===150&&++polls===3){const scope=dom.document.querySelector('section');
   if(variant==='anchor')scope.insertAdjacentHTML('beforeend','<a data-testid="citation" href="https://careers.example.test/jobs/123">Employer</a>');
   else{scope.insertAdjacentHTML('beforeend','<span data-d-component="popover-trigger" aria-haspopup="dialog" aria-expanded="false"><div data-d-component="badge"><span data-d-component="favicon"></span>Sources</div></span>');const trigger=scope.lastElementChild;trigger.onclick=()=>{if(trigger.getAttribute('aria-expanded')==='true'){trigger.setAttribute('aria-expanded','false');dom.document.querySelector('[role=dialog]').remove();return;}trigger.setAttribute('aria-expanded','true');const popup=dom.document.createElement('div');popup.setAttribute('role','dialog');popup.innerHTML='<button data-d-component="pressable" aria-label="Open employer"><span data-d-component="favicon"><img src="https://www.google.com/s2/favicons?domain=https://careers.example.test"></span><span data-d-weight="medium">'+nativeTitle+'</span></button>';dom.document.body.append(popup);};}
  }cb();})};
 const run=vm.runInNewContext(`(${converseSource})`,context);
 assert.equal((await run('Assigned research',{webSearch:true,detached:true,taskId:'delayed-'+variant,timeoutMs:1000,settleMs:0})).started,true);
 await dom.window.__applyBotChatTask.check(false);assert.equal((await dom.window.__applyBotChatTask.check(false)).needsForeground,true);
 const result=await dom.window.__applyBotChatTask.check(true);assert.equal(result.ok,true);assert.equal(polls,3);
 if(variant==='anchor')assert.equal(result.searchEvidence.nativeCitations[0].url,'https://careers.example.test/jobs/123');
 else{assert.equal(result.searchEvidence.nativeSourceCards[0].title,nativeTitle);assert.equal(dom.document.querySelector('[aria-haspopup]').getAttribute('aria-expanded'),'false');}
 console.log('PASS A delayed native source '+variant+' outside the markdown is collected after the worker comes forward');
}
