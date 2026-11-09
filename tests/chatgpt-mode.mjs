import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {selectChatGptMode,taskMode} from '../src/chatgpt-mode.js';
import {answerAll,answerQuestion} from '../src/ai.js';
import {setModelTransport,ProviderError} from '../src/vendor/generation.js';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
function fixture({levels=['none','medium','high'],initial='high',slider=true}={}){
 const dom=parseHTML('<html><body><textarea id="prompt-textarea"></textarea><button id="mode" aria-label="Select ChatGPT model" aria-controls="menu" aria-expanded="false"></button><div id="menu" role="menu" hidden></div></body></html>'),{document,window}=dom;
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:function(){return this.closest('[hidden]')?[]:[{width:100}];},configurable:true});
 const trigger=document.querySelector('#mode'),menu=document.querySelector('#menu');let index=levels.indexOf(initial);
 const update=()=>{trigger.setAttribute('data-selected-reasoning-effort',levels[index]);trigger.textContent=levels[index];menu.querySelector('[role=slider]')?.setAttribute('aria-valuenow',index);};
 trigger.onclick=()=>{menu.hidden=!menu.hidden;trigger.setAttribute('aria-expanded',String(!menu.hidden));};
 menu.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;trigger.setAttribute('aria-expanded','false');}});
 if(slider){menu.innerHTML='<div data-model-picker-power-slider><span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+(levels.length-1)+'"></span></div>';menu.querySelector('[role=slider]').addEventListener('keydown',e=>{if(e.key==='Home')index=0;else if(e.key==='ArrowRight')index=Math.min(levels.length-1,index+1);update();});}
 else for(const level of levels){const button=document.createElement('button');button.setAttribute('role','menuitemradio');button.textContent=level;button.onclick=()=>{index=levels.indexOf(level);update();menu.hidden=true;trigger.setAttribute('aria-expanded','false');};menu.append(button);}
 class KeyboardEvent extends window.Event{constructor(type,options){super(type,options);this.key=options.key;this.code=options.code;}}
 update();const select=vm.runInNewContext('('+selectChatGptMode.toString()+')',{document,KeyboardEvent,setTimeout:cb=>queueMicrotask(cb)});
 return {select,trigger,menu,dom};
}
await test('Resumes require High, form answers prefer Instant, and research and other tasks prefer Medium',()=>{
 assert.equal(taskMode({verbatim:true,webSearch:true}),'high');assert.equal(taskMode({task:'resume'}),'high');assert.equal(taskMode({webSearch:true}),'medium');assert.equal(taskMode({format:'json'}),'medium');
 assert.equal(taskMode({task:'form-answers'}),'instant');assert.equal(taskMode({task:'form-answers',webSearch:true}),'medium');assert.equal(taskMode({task:'cover-letter'}),'medium');assert.equal(taskMode({task:'form-answers',verbatim:true}),'high');
});
await test('Single and batch application answers both carry their Instant task policy to the transport',async()=>{
 const requests=[];setModelTransport(async request=>{requests.push(request);return {text:request.format==='text'?'A supported answer':JSON.stringify({'1':'A supported answer'})};});
 const question={key:'why',question:'Why are you interested in this role?',required:true};
 assert.equal(await answerQuestion(question,{},{}),'A supported answer');assert.equal((await answerAll([question],{},{})).answers.length,1);
 assert.equal(requests.length,2);assert.ok(requests.every(request=>request.task==='form-answers'&&taskMode(request)==='instant'));
});
await test('An unavailable required mode stops single and batch answers instead of falling back to guesses',async()=>{
 setModelTransport(async()=>{throw new ProviderError('Required mode is unavailable',412);});const question={key:'why',question:'Why this role?',required:true};
 await assert.rejects(()=>answerQuestion(question,{},{}),error=>error.fatal===true);await assert.rejects(()=>answerAll([question],{},{}),error=>error.fatal===true);
});
await test('The live discrete slider switches High to Medium to Instant and back to High with proof',async()=>{
 const f=fixture();for(const desired of ['medium','instant','high']){const r=await f.select(desired);assert.equal(r.ok,true);assert.equal(r.selected,desired);assert.equal(f.menu.hidden,true);}
});
await test('An exact current mode avoids opening the menu or changing the user model',async()=>{
 const f=fixture(),r=await f.select('high');assert.equal(r.changed,false);assert.equal(f.menu.hidden,true);
});
await test('A stuck picker can retain verified Medium for Instant work, but cannot downgrade a High resume',async()=>{
 const f=fixture({initial:'medium'});f.trigger.onclick=()=>{};
 const other=await f.select('instant');assert.equal(other.ok,true);assert.equal(other.selected,'medium');assert.equal(other.fallback,true);
 const resume=await f.select('high');assert.equal(resume.ok,false);assert.equal(resume.reason,'mode-control-missing');
});
await test('An already-selected High mode does not need an interactive picker before hydration',async()=>{
 const f=fixture({initial:'high'});f.trigger.onclick=null;
 const selected=await f.select('high');assert.equal(selected.ok,true);assert.equal(selected.selected,'high');assert.equal(selected.changed,false);
});
await test('An unhydrated mode button is retried until its menu actually opens',async()=>{
 const f=fixture(),click=f.trigger.onclick;let clicks=0;f.trigger.onclick=()=>{if(++clicks>=3)click();};
 const selected=await f.select('medium');assert.equal(selected.ok,true);assert.equal(selected.selected,'medium');assert.ok(clicks>=3);
});
await test('A menu of explicit effort options also selects the requested mode',async()=>{
 const f=fixture({slider:false});assert.equal((await f.select('instant')).selected,'instant');assert.equal((await f.select('high')).selected,'high');
});
await test('An unrelated model header cannot hide the actual thinking-effort control',async()=>{
 const f=fixture(),header=f.dom.document.createElement('button');header.dataset.testid='model-switcher-dropdown-button';header.textContent='GPT';f.dom.document.body.prepend(header);
 f.trigger.setAttribute('aria-label','Select thinking effort');assert.equal((await f.select('medium')).selected,'medium');
});
await test('Instant may fall back to Medium but a resume can never silently fall back below High',async()=>{
 const f=fixture({levels:['medium'],initial:'medium'});assert.equal((await f.select('instant')).selected,'medium');const high=await f.select('high');assert.equal(high.ok,false);assert.equal(high.reason,'mode-unavailable');
});
const source=await readFile(new URL('../src/chatgpt.js',import.meta.url),'utf8'),code=source.slice(source.indexOf('async function converse(prompt, options)'),source.indexOf('/* --------------------------------------------------------------- bridge */'));
function composerFixture({changeMode=false,changeWhileWaiting=false,delayedSend=false,neverReady=false}={}){
 const dom=parseHTML('<html><body><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><button aria-label="Select ChatGPT model" data-selected-reasoning-effort="high">High</button></body></html>'),{document,window}=dom;
 Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get:()=>100,configurable:true});let sent=0;
 const editor=document.querySelector('#prompt-textarea');
 document.execCommand=(command,_ui,value)=>{if(command==='delete')editor.innerHTML='';if(command==='insertText'){editor.textContent=value;const icon=document.createElement('span');icon.setAttribute('data-inline-url-icon','');icon.innerHTML='<svg><style>@supports (color:color(display-p3 1 1 1)){CSS decoration}</style></svg>';editor.prepend(icon);if(changeMode)document.querySelector('[data-selected-reasoning-effort]').setAttribute('data-selected-reasoning-effort','medium');}return true;};
 document.querySelector('[data-testid=send-button]').onclick=()=>{sent++;const turn=document.createElement('div');turn.dataset.messageAuthorRole='user';turn.innerHTML=editor.innerHTML;document.body.append(turn);};
 if(changeWhileWaiting){let reads=0;Object.defineProperty(document.querySelector('[data-testid=send-button]'),'disabled',{get(){if(++reads===1){queueMicrotask(()=>document.querySelector('[data-selected-reasoning-effort]').setAttribute('data-selected-reasoning-effort','medium'));return true;}return false;}});}
 if(delayedSend||neverReady){let reads=0;Object.defineProperty(document.querySelector('[data-testid=send-button]'),'disabled',{get:()=>neverReady||++reads<=25});}
 const converse=vm.runInNewContext('('+code+')',{document,window,location:{href:'https://chatgpt.com/c/assigned',pathname:'/c/assigned'},setTimeout:cb=>queueMicrotask(cb),Event:window.Event,URL});
 return {converse,window,document,sent:()=>sent};
}
await test('Drive URL icon CSS does not corrupt composer or posted-prompt verification',async()=>{
 const f=composerFixture(),reply=await f.converse('A role with https://drive.google.com/file/d/candidate-reference/view',{expectedMode:'high',detached:true,taskId:'decorated',timeoutMs:1000,settleMs:0});assert.equal(reply.started,true);assert.equal(f.sent(),1);
});
await test('A mode changed while typing prevents sending the prompt',async()=>{
 const f=composerFixture({changeMode:true}),reply=await f.converse('Assigned role',{expectedMode:'high',detached:true,taskId:'changed',timeoutMs:1000,settleMs:0});assert.equal(reply.reason,'mode-changed');assert.equal(f.sent(),0);
});
await test('A mode changed while waiting for an enabled Send button also prevents sending',async()=>{
 const f=composerFixture({changeWhileWaiting:true}),reply=await f.converse('Assigned resume',{expectedMode:'high',detached:true,taskId:'changed-late',timeoutMs:1000,settleMs:0});assert.equal(reply.reason,'mode-changed');assert.equal(f.sent(),0);
});
await test('Delayed editor readiness waits for an enabled Send button instead of using synthetic Enter',async()=>{
 const f=composerFixture({delayedSend:true}),reply=await f.converse('Assigned resume',{expectedMode:'high',detached:true,taskId:'delayed-send',timeoutMs:1000,settleMs:0});assert.equal(reply.started,true);assert.equal(f.sent(),1);
});
await test('A disabled Send button is a loading failure and cannot be reported as a sent request',async()=>{
 const f=composerFixture({neverReady:true}),reply=await f.converse('Assigned resume',{expectedMode:'high',detached:true,taskId:'disabled-send',timeoutMs:1000,settleMs:0});assert.equal(reply.reason,'send-not-ready');assert.equal(f.sent(),0);
});
await test('An explicit usage cap with a disabled composer remains an account error',async()=>{
 const f=composerFixture({neverReady:true}),notice=f.document.createElement('div');notice.setAttribute('role','alert');notice.textContent='Usage limit reached';f.document.body.append(notice);
 const reply=await f.converse('Must not send',{expectedMode:'high',detached:true,taskId:'capped',timeoutMs:1000,settleMs:0});assert.equal(reply.reason,'rate-limited');assert.equal(f.sent(),0);
});
await test('The send guard recognizes alternate effort controls and normalizes the Instant alias',async()=>{
 for(const [stored,expected]of [[' HIGH ','high'],[' NONE ','instant']]){const f=composerFixture(),trigger=f.document.querySelector('[data-selected-reasoning-effort]');trigger.setAttribute('aria-label','Select thinking effort');trigger.setAttribute('data-selected-reasoning-effort',stored);
  const header=f.document.createElement('button');header.dataset.testid='model-switcher-dropdown-button';header.textContent='GPT';f.document.body.prepend(header);
  const reply=await f.converse('Assigned task',{expectedMode:expected,detached:true,taskId:'alternate',timeoutMs:1000,settleMs:0});assert.equal(reply.started,true);assert.equal(f.sent(),1);}
});
console.log(`${count} task-mode and rich-editor checks passed.`);
