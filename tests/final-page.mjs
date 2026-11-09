import assert from 'node:assert/strict';
import {finishApplicationTab} from '../src/final-page.js';
import {pack,unpack} from '../src/codec.js';
import {BUILD_VERSION,DATABASE_PROTOCOL} from '../src/update.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=';
let scenario,events,stored,tab,active;
const application={id:'image-test',company:'Example Company',title:'Engineer'};
function setup(options={}) {
 scenario=options;events=[];stored=[];tab={id:12,windowId:3,url:'https://example.test/confirmation',title:'Application received'};active=12;
 globalThis.chrome={
  tabs:{get:async()=>({...tab}),update:async()=>{active=12;return {...tab};},query:async()=>[{id:active}],
   captureVisibleTab:async()=>{events.push('capture');if(scenario.captureError)throw new Error('Capture refused');if(scenario.wrongTab)active=99;if(scenario.navigation)tab.url='https://example.test/changed';return png;},
   remove:async()=>{events.push('close');}},
  windows:{update:async()=>{}},
  runtime:{sendMessage:async message=>{
   const request=unpack(message.request);
   if(request.action==='put'){
    events.push('save');if(scenario.storageError)throw new Error('SQLite write failed');
    stored.push(request.value);if(scenario.afterSave)tab.url='https://example.test/changed';
   }
   const value=request.action==='kvGet'?{profile:{exportFiles:false}}:true;
   return {ok:true,build:BUILD_VERSION,protocol:DATABASE_PROTOCOL,value:await pack(value)};
  }}
 };
}
let count=0;
const test=async(name,work)=>{await work();count++;console.log(`PASS ${name}`);};
await test('A real PNG is durably saved before the application tab closes',async()=>{
 setup();const result={status:'submitted',detail:{folder:'applied/example'}};
 const value=await finishApplicationTab({tabId:12,application,result});
 assert.equal(value.closed,true);assert.deepEqual(events,['capture','save','close']);
 assert.equal(result.detail.lastScreenshot.path,'applied/example/Last page.png');
 assert.equal(result.detail.lastScreenshot.url,'https://example.test/confirmation');
 assert.deepEqual(new Uint8Array(await stored[0].content.arrayBuffer()),new Uint8Array(await(await fetch(png)).arrayBuffer()));
});
await test('Capture or SQLite failures leave the tab open and preserve the submission outcome',async()=>{
 for(const error of ['captureError','storageError']){
  setup({[error]:true});const result={status:'submitted',detail:{}};
  const value=await finishApplicationTab({tabId:12,application,result});
  assert.equal(value.closed,false);assert.ok(result.detail.screenshotError);assert.equal(result.status,'submitted');assert.ok(!events.includes('close'));
 }
});
await test('A different active tab or navigating page cannot be saved as application evidence',async()=>{
 for(const error of ['wrongTab','navigation']){
  setup({[error]:true});const result={status:'unconfirmed',detail:{}};
  const value=await finishApplicationTab({tabId:12,application,result});
  assert.equal(value.closed,false);assert.equal(stored.length,0);assert.ok(!events.includes('close'));
 }
});
await test('Navigation during persistence preserves the captured image and keeps the tab open',async()=>{
 setup({afterSave:true});const result={status:'submitted',detail:{}};
 const value=await finishApplicationTab({tabId:12,application,result});
 assert.equal(value.closed,false);assert.equal(stored.length,1);assert.ok(result.detail.lastScreenshot);assert.ok(result.detail.screenshotError);assert.ok(!events.includes('close'));
});
await test('Review mode saves its final page while retaining the filled form',async()=>{
 setup();const result={status:'dry-run',detail:{}};
 const value=await finishApplicationTab({tabId:12,application,result,keepOpen:true});
 assert.equal(value.closed,false);assert.match(value.path,/^review\//);assert.deepEqual(events,['capture','save']);
});
await test('Failed and uncertain application screenshots retain their real outcome',async()=>{
 for(const status of ['failed','manual','unconfirmed']){
  setup();const result={status,detail:{}};
  const value=await finishApplicationTab({tabId:12,application,result});
  assert.equal(value.closed,true);assert.equal(result.status,status);assert.ok(result.detail.lastScreenshot);
 }
});
console.log(`${count} final-page screenshot checks passed.`);
