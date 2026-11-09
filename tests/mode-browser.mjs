import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chatModeFixture} from './chat-mode-fixture.js';
import {browsersDir,scratchPath,releaseScratch} from './scratch.js';

const root=resolve('.'),portable=(await readdir(browsersDir).catch(()=>[])).find(name=>/^chromium-\d+$/.test(name));
await mkdir('test-results',{recursive:true});
const report={startedAt:new Date().toISOString(),checks:[],errors:[]},profilePath=scratchPath('mode-profile');let context;
try{
 context=await chromium.launchPersistentContext(profilePath,{...(portable?{executablePath:resolve(browsersDir,portable,'chrome-win64/chrome.exe')}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),origin='chrome-extension://'+new URL(worker.url()).host;
 const html=`<!doctype html><html><body><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><script>
 document.querySelector('button').onclick=()=>{const prompt=document.querySelector('textarea').value,mode=document.querySelector('#fixture-mode').dataset.selectedReasoningEffort;localStorage.setItem('modeHistory',JSON.stringify([...(JSON.parse(localStorage.getItem('modeHistory')||'[]')),{mode,prompt}]));const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=prompt;document.body.append(user);history.replaceState({},'', '/c/'+crypto.randomUUID());const reply=document.createElement('div');reply.dataset.messageAuthorRole='assistant';reply.textContent='Supported fixture answer';document.body.append(reply);document.querySelector('textarea').value='';};</script></body></html>`+chatModeFixture();
 await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:html}));
 const chat=await context.newPage();await chat.goto('https://chatgpt.com/');const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(origin+'/src/options.html');
 const results=await page.evaluate(async()=>{const api=await import('./chatgpt.js');api.configureChatGptWorkers({limit:1});const results=[];try{for(const [task,expected]of [['resume','high'],['form-answers','instant'],['screening','medium'],['cover-letter','medium'],['resume','high']]){const prompt='Assigned '+task+' task';const reply=await api.askChatGpt({task,verbatim:task==='resume',format:'text',messages:[{role:'user',content:prompt}]});results.push({task,expected,mode:reply.mode?.selected,prompt,text:reply.text});}}finally{await api.closeChatGptWorkers();}return results;});
 const sent=await chat.evaluate(()=>JSON.parse(localStorage.getItem('modeHistory')||'[]'));
 assert.equal(results.length,5);assert.equal(sent.length,5);
 for(const [index,result]of results.entries()){assert.equal(result.mode,result.expected);assert.equal(sent[index].mode==='none'?'instant':sent[index].mode,result.expected);assert.equal(result.text,'Supported fixture answer');if(result.task==='resume')assert.equal(sent[index].prompt,result.prompt);}
 assert.deepEqual(report.errors,[]);report.results=results;report.checks.push('The real browser transport sends High → Instant → Medium → Medium → High, verifies each selected mode, and preserves verbatim resume prompts');console.log('PASS '+report.checks[0]);
}catch(error){report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{await context?.close();await releaseScratch(profilePath);report.finishedAt=new Date().toISOString();await writeFile('test-results/mode-browser-report.json',JSON.stringify(report,null,2));}
