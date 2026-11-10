import assert from 'node:assert/strict';
import {activeFilters,evaluateFilters,normalizeFilters,localFilter,selectCompanyRoles} from '../src/filters.js';
import {screenJob,validateScreening,screeningSignature,documentSignature} from '../src/screening.js';
import {stagedBatch,mapBounded} from '../src/pipeline.js';
import {withDefaults} from '../src/profile.js';
import {originalSource} from '../src/original-posting.js';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
const url='https://job-boards.greenhouse.io/fixtureorg/jobs/123';
const quotes={remote:'This position is fully remote throughout the United States.',travel:'Travel of up to 25% is required for this role.',none:'No travel is required for this position.',clearance:'No security clearance is required for this role.',interview:'All interviews are conducted virtually for this position.'};
const job={id:'a',company:'Fixture Organization',title:'Software Engineer',applyUrl:url,jd:Object.values(quotes).join('\n')};
// Pinned strict: these checks are about what counts as evidence, and the
// strictness that decides what an unknown costs is covered in screening-strictness.mjs.
const profile=withDefaults({screeningEnabled:true,screeningWorkplace:'remote',screeningTravel:'none',screeningUnknown:'strict'});
function payload(findings){return{company:job.company,role:job.title,findings:Object.fromEntries(Object.entries(findings).map(([key,[value,quote]])=>[key,{value,explanation:'Role-specific evidence',appliesToRole:true,evidence:[{url,quote}]}])),sources:[{url,title:'Software Engineer at Fixture Organization',company:job.company,scope:'role'}]};}
const cited={searchEvidence:{nativeCitations:[{url,title:'Software Engineer at Fixture Organization'}]}};
await test('All filters are optional; profile preferences do not enable them',()=>{
 assert.deepEqual(activeFilters(withDefaults({remotePreference:'Remote',willingToTravel:'no'})),[]);
 assert.equal(normalizeFilters({screeningWorkplace:'bogus'}).screeningWorkplace,'any');
 assert.equal(normalizeFilters({screeningBatchSize:1000}).screeningBatchSize,30);
});
await test('Verified remote work does not override a conflicting travel requirement',async()=>{
 const result=await validateScreening(payload({workplace:['remote',quotes.remote],travel:['required',quotes.travel]}),cited,job,profile);
 assert.equal(result.decision,'rejected');assert.deepEqual(result.conflicts,['Required travel']);
});
await test('Missing travel or on-site-interview evidence holds the job for review',async()=>{
 const result=await validateScreening(payload({workplace:['remote',quotes.remote]}),cited,job,{...profile,screeningInterview:'none'});
 assert.equal(result.decision,'review');assert.deepEqual(result.unknown,['Required travel','On-site interviews']);
});
await test('Matching exact-role quotes and native sources make a job eligible',async()=>{
 const result=await validateScreening(payload({workplace:['remote',quotes.remote],travel:['none',quotes.none],clearance:['none',quotes.clearance],interview:['virtual',quotes.interview]}),cited,job,{...profile,screeningClearance:'none',screeningInterview:'none'});
 assert.equal(result.decision,'eligible');assert.equal(Object.keys(result.findings).length,4);
});
await test('Generic hybrid benefits do not prove remote-only work for this role',async()=>{
 const quote='Our benefits include Remote Work/Hybrid Work opportunities.';
 const result=await validateScreening(payload({workplace:['remote',quote],travel:['none',quotes.none]}),cited,{...job,jd:job.jd+'\n'+quote},profile);
 assert.equal(result.decision,'review');assert.equal(result.findings.workplace.value,'unknown');
});
await test('A short first-party Remote location label is usable only with native exact-role evidence',async()=>{
 const j={...job,metadata:{location:'Remote'}};
 const p=payload({workplace:['remote','Remote'],travel:['none',quotes.none]});
 assert.equal((await validateScreening(p,cited,j,profile)).decision,'eligible');
 assert.equal((await validateScreening(p,cited,job,profile)).decision,'review');
 assert.equal((await validateScreening(p,{},j,profile)).decision,'review');
});
await test('Fabricated excerpts, ordinary links, wrong employers and different-role sources cannot establish eligibility',async()=>{
 const valid=payload({workplace:['remote',quotes.remote],travel:['none',quotes.none]});
 const invented=structuredClone(valid);invented.findings.travel.evidence[0].quote='No travel will ever be required under any circumstances.';
 assert.equal((await validateScreening(invented,cited,job,profile)).decision,'review');
 assert.equal((await validateScreening(valid,{},job,profile)).decision,'review');
 await assert.rejects(()=>validateScreening({...valid,company:'Another Employer'},cited,job,profile),/match/);
 const wrong=structuredClone(valid),other=url.replace('123','456');wrong.sources[0].url=other;for(const f of Object.values(wrong.findings))f.evidence[0].url=other;
 assert.equal((await validateScreening(wrong,{searchEvidence:{nativeCitations:[{url:other}]}},job,profile)).decision,'review');
});
await test('A verified original posting remains exact-role evidence when its application URL adds /apply',async()=>{
 const original='https://ats.rippling.com/fixture/jobs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',j={...job,applyUrl:original+'/apply',originalUrl:original,descriptionSource:originalSource(original,'official-api')};
 const p=payload({workplace:['remote',quotes.remote],travel:['required',quotes.travel]});p.sources[0].url=original;for(const f of Object.values(p.findings))f.evidence[0].url=original;
 const reply={searchEvidence:{nativeCitations:[{url:original}]}};
 const checked=await validateScreening(p,reply,j,profile);assert.equal(checked.decision,'rejected');assert.equal(checked.findings.workplace.verified,true);assert.equal(checked.findings.travel.verified,true);
 const other=original.replace('aaaaaaaa','ffffffff');p.sources[0].url=other;for(const f of Object.values(p.findings))f.evidence[0].url=other;
 const wrong=await validateScreening(p,{searchEvidence:{nativeCitations:[{url:other}]}},j,profile);assert.equal(wrong.decision,'review');assert.equal(wrong.findings.workplace.verified,false);
});
await test('Silence and an unrelated negative sentence cannot prove no travel',async()=>{
 for(const quote of [quotes.remote,'No security clearance; travel is required for this role.']){
  const j={...job,jd:job.jd+'\n'+quote};
  assert.equal((await validateScreening(payload({workplace:['remote',quotes.remote],travel:['none',quote]}),cited,j,profile)).decision,'review');
 }
});
await test('Company policies need independently read excerpts and explicit applicability',async()=>{
 const policy='https://fixture.example/careers/travel',quote='All employees may optionally travel to company retreats.';
 const p=payload({workplace:['remote',quotes.remote],travel:['optional',quote]});p.sources.push({url:policy,title:'Fixture Organization policies',company:job.company,scope:'company-policy'});p.findings.travel.evidence[0].url=policy;
 const reply={searchEvidence:{nativeCitations:[...cited.searchEvidence.nativeCitations,{url:policy}]}};
 assert.equal((await validateScreening(p,reply,job,profile,{readSource:async()=>quote})).decision,'eligible');
 p.findings.travel.appliesToRole=false;
 assert.equal((await validateScreening(p,reply,job,profile,{readSource:async()=>quote})).decision,'review');
});
await test('An optional perk cannot establish optional interviews, relocation or on-call work',async()=>{
 const quote='Company retreat travel is optional for this role.';
 const p=payload({interview:['optional',quote],relocation:['optional',quote],onCall:['optional',quote]});
 const result=await validateScreening(p,cited,{...job,jd:quote},{...profile,screeningWorkplace:'any',screeningTravel:'any',screeningInterview:'none',screeningRelocation:'none',screeningOnCall:'none'});
 assert.equal(result.decision,'review');assert.equal(result.unknown.length,3);
});
await test('Allowing unknowns is explicit and retains a warning; verified conflicts still reject',()=>{
 const p={...profile,screeningUnknown:'allow'};
 assert.equal(evaluateFilters({},p).decision,'eligible');assert.ok(evaluateFilters({},p).unknown.length);
 assert.equal(evaluateFilters({travel:{value:'required',verified:true}},p).decision,'rejected');
});
await test('Title/company exclusions avoid AI and disabled filters do not research',async()=>{
 let requests=0;const ask=async()=>{requests++;throw new Error('Unexpected AI call');};
 assert.equal((await screenJob(job,{...profile,screeningExcludedCompanies:job.company},{ask})).decision,'rejected');
 assert.equal(localFilter(job,{...profile,screeningTitles:'Designer'}).decision,'rejected');
 assert.equal((await screenJob(job,withDefaults(),{ask})).decision,'eligible');assert.equal(requests,0);
});
await test('Research uses web search and account failures stop instead of approving unknown requirements',async()=>{
 await assert.rejects(()=>screenJob(job,profile,{ask:async request=>{assert.equal(request.webSearch,true);assert.match(request.messages[0].content,/beyond the supplied description/);throw Object.assign(new Error('Usage cap'),{status:429});}}),/Usage cap/);
});
await test('Saved-stage signatures invalidate changed rules, descriptions and ChatGPT context',async()=>{
 assert.notEqual(await screeningSignature(job,profile),await screeningSignature(job,{...profile,screeningTravel:'any'}));
 assert.notEqual(await documentSignature(job,profile),await documentSignature({...job,jd:'Changed'},profile));
 assert.equal(await documentSignature(job,profile),await documentSignature(job,{...profile,maxPerRun:1}));
 assert.notEqual(await documentSignature(job,{...profile,resumeChatUrl:'one'}),await documentSignature(job,{...profile,resumeChatUrl:'two'}));
});
await test('Company selection compares eligible roles without marking rejected roles as applied',()=>{
 const best={...job,mode:'fillable',screening:{findings:{travel:{verified:true}}}},manual={...job,id:'b',mode:'manual'};
 const result=selectCompanyRoles([manual,best,{...job,id:'c',company:'Other Employer'}]);
 assert.equal(result.selected.length,2);assert.equal(result.selected.find(j=>j.company===job.company).id,'a');assert.equal(result.alternatives.length,1);
});
/**
 * Extraction stays bounded, but it is no longer a barrier.
 *
 * Reading a posting is a page load and screening it is a ChatGPT
 * request: different resources, and making the second wait for every
 * one of the first bought nothing. It cost a measured 43% of ChatGPT's
 * night (tests/pipeline-idle.mjs), because no document was being
 * written and no form filled for as long as a batch took to read.
 *
 * What still has to hold is the bound - three readers, not six - and
 * the ordering further down, where `choose` does see a whole window
 * and a document is written before the application that uses it.
 */
await test('Extraction is bounded and overlaps screening, which still precedes generation and multiple applications',async()=>{
 const events=[];let inFlight=0,peak=0,attempts=0,overlapped=false;
 await stagedBatch([0,1,2,3,4,5],{
  extract:async id=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,2));events.push('extract'+id);inFlight--;return id===0?null:{id};},
  screen:async job=>{if(inFlight>0)overlapped=true;events.push('screen'+job.id);return job.id<=2?null:job;},
  choose:async jobs=>jobs,prepare:async job=>{events.push('generate'+job.id);return job;},
  apply:async job=>{events.push('apply'+job.id);attempts++;},remaining:()=>2-attempts,
 });
 assert.equal(peak,3,'three readers at once, not one per posting');
 assert.ok(overlapped,'screening should start while postings are still being read');
 assert.equal(attempts,2);assert.equal(events.filter(x=>x.startsWith('generate')).length,2);
 // `choose` still sees the whole batch, so nothing is written until the
 // last posting has been screened and the best role per employer picked.
 assert.ok(events.findIndex(x=>x.startsWith('generate'))>events.map((x,i)=>x.startsWith('screen')?i:-1).reduce((a,b)=>Math.max(a,b)),'generation waits for the chosen window');
 assert.ok(events.indexOf('apply3')>events.indexOf('generate3'));
 assert.ok(events.indexOf('apply3')<events.indexOf('generate4'));
});
await test('Stop at a stage boundary prevents resume generation and application',async()=>{
 let stop=false,writes=0;
 await stagedBatch([1,2],{extract:async id=>({id}),screen:async job=>{stop=true;return job;},choose:async a=>a,prepare:async()=>{writes++;},apply:async()=>{writes++;},remaining:()=>5,stopped:()=>stop});
 assert.equal(writes,0);
});
await test('An extraction error drains other readers without leaving background work running',async()=>{
 let active=0;await assert.rejects(()=>mapBounded([1,2,3],3,async i=>{active++;try{await new Promise(r=>setTimeout(r,2));if(i===1)throw new Error('Reader failed');}finally{active--;}}),/Reader failed/);assert.equal(active,0);
});
console.log(`${count} screening and staged-pipeline checks passed.`);
