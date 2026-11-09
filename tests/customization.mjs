import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { withDefaults, missingFromProfile } from '../src/profile.js';
import { DEFAULT_TEMPLATE, normalizeTemplate, templateInstructions, applyTemplate, sampleDocument, educationFromDocument, documentText } from '../src/templates.js';
import { buildDocumentPdf } from '../src/vendor/generation.js';
import { toResume, documentFault, resumePrompt } from '../src/resume.js';
import { resolveField } from '../src/answers.js';
import { pack, unpack } from '../src/codec.js';
import {SALARY_RESEARCH_PROMPT, compensationPrompt,validateCompensation,hasCompensationResearch} from '../src/salary.js';
import { isHiringCafeSearch } from '../src/hiringcafe.js';
import { answerAll } from '../src/ai.js';
import { setModelTransport } from '../src/vendor/generation.js';

let count = 0;
async function test(name, work) { await work(); count++; console.log(`PASS ${name}`); }
await test('Retired career and prompt settings cannot reappear through old imports',() => {
  const value = withDefaults({experience:[{from:'2020-01',to:''}],degree:'Invented',school:'Old default',companySize:'large',companyDescriptions:true,formatPrompt:'Old layout',tailoringInstructions:'Old resume command',firstName:'Alex'});
  for (const key of ['experience','degree','school','companySize','companyDescriptions','formatPrompt','tailoringInstructions']) assert.equal(key in value,false);
  assert.equal(value.firstName,'Alex'); assert.equal(value.workdayPassword,'');
  // An import that says nothing about these gets the shipped defaults,
  // which submit rather than park.
  assert.equal(value.autoFetch,true); assert.equal(value.maxPerRun,0);
  // Review mode is gone outright, not defaulted off: a machine left in it
  // applied to nothing for seven hours and reported itself healthy
  // throughout. An import still carrying the old key does not revive it.
  assert.equal('dryRun' in value,false);
  assert.equal('dryRun' in withDefaults({firstName:'Alex',lastName:'Morgan',email:'a@b.test',dryRun:true}),false);
});
await test('Generation has no local resume or salary setting prerequisite',()=>{
  const profile = withDefaults({firstName:'Alex',lastName:'Morgan',email:'alex@example.test',phone:'555',city:'Seattle',startDate:'Two weeks',workAuthorization:'us-citizen',requiresSponsorship:'no',activeResumeId:'retired',salaryFallback:999999});
  assert.deepEqual(missingFromProfile(profile),[]); assert.equal('activeResumeId' in profile,false); assert.equal('salaryFallback' in profile,false);
  const prompt = resumePrompt('React role',{company:'Example Careers'});
  assert.equal(prompt,'React role');
});
await test('Template order, headings, hidden sections and identity apply to the actual document',() => {
  const template = structuredClone(DEFAULT_TEMPLATE);
  template.sections.reverse(); template.sections.find(s=>s.id==='skills').heading='Technical toolkit'; template.sections.find(s=>s.id==='summary').enabled=false; template.showTitle=false; template.showLinks=false;
  const source = sampleDocument(), output = applyTemplate(source,template);
  assert.equal(output.name,source.name); assert.equal(output.targetTitle,''); assert.deepEqual(output.contact.links,[]);
  assert.ok(!output.sections.some(s=>s.id==='summary')); assert.equal(output.sections.find(s=>s.id==='skills').heading,'Technical toolkit');
  assert.ok(output.sections.findIndex(s=>s.id==='education') < output.sections.findIndex(s=>s.id==='experience'));
  assert.deepEqual(output.sections.find(s=>s.id==='experience').roles,source.sections.find(s=>s.id==='experience').roles);
  assert.ok(templateInstructions(template).includes('Technical toolkit')); assert.equal(resumePrompt('React role',{}, {template}),'React role');
});
await test('Template validation keeps work history visible and clamps invalid styling',() => {
  const template = normalizeTemplate({theme:{fontFamily:'Unknown',baseSize:999,margin:0,accentColor:'bad color'},sections:[{id:'experience',heading:'Experience',enabled:false},{id:'experience',heading:'Duplicate'},{id:'unsupported'}]});
  assert.equal(template.sections.filter(s=>s.id==='experience').length,1); assert.equal(template.sections.find(s=>s.id==='experience').enabled,true); assert.equal(template.theme.baseSize,14); assert.equal(template.theme.accentColor,'1D4ED8');
});
await test('Education is parsed from the ChatGPT document instead of profile defaults',()=>{
  const document=sampleDocument(), resume=toResume(document,{name:document.name,...document.contact,education:{degree:'Wrong',school:'Wrong',location:'',year:''}});
  assert.equal(resume.education.school,'Example University'); assert.equal(documentFault({document}),null);
});
await test('Zero years remains zero in form resolution',() => {
  const result = resolveField({type:'text',tag:'input',label:'How many years of experience do you have with React?',required:true,options:[]},{...withDefaults({}),techYears:0},{});
  assert.equal(result.outcome,'fill'); assert.equal(result.value,'0');
});
await test('Both Hiring Cafe hostnames are detected without requiring tab positions',() => {
  assert.ok(isHiringCafeSearch('https://hiring.cafe/?searchState=example'));
  assert.ok(isHiringCafeSearch('https://hiringcafe.com/classic?searchState=example'));
  assert.equal(isHiringCafeSearch('https://hiring.cafe.evil.test/'),false);
});
await test('Blank preferences do not silently become legal answers or a salary expectation',() => {
  for (const label of ['Are you willing to relocate?','Are you able to travel as required?','Are you at least 18 years old?','Are you subject to a non-compete?','Will you consent to a background check?','What is your desired salary?']) {
    const answer = resolveField({type:'text',tag:'input',required:true,options:[],label},withDefaults({}),{});
    assert.equal(answer.outcome,'blocked',label);
  }
  const answer = resolveField({type:'text',tag:'input',required:true,options:[],label:'Current employer'},withDefaults({}),{currentlyEmployed:true,currentCompany:'Example Software'});
  assert.equal(answer.value,'Example Software');
});
const payJob={company:'Example Careers',title:'Software Engineer',jd:'A job posting with a salary line must still be researched.'};
const source={url:'https://example.test/careers/engineer',title:'Company posting',company:'Example Careers',role:'Software Engineer',matchType:'exact-company-role',date:'2026-11-06',details:'Published base salary for this role and location.'};
const researchPayload={status:'researched',company:payJob.company,role:payJob.title,location:'Seattle',currency:'USD',period:'year',basis:'base',minimum:140000,maximum:190000,recommendedAmount:173000,rationale:'AI-selected amount from the role evidence, not the midpoint.',sources:[source]};
const nativeReply={searchEvidence:{nativeCitations:[{url:source.url,title:source.title}]}};
await test('Compensation uses the exact user prompt and requests company-specific Search evidence',()=>{
 assert.ok(compensationPrompt(payJob).includes(SALARY_RESEARCH_PROMPT)); assert.match(compensationPrompt(payJob),/web search tool now/);
 // The prompt used to call generic market figures insufficient and tell
 // the model to return unavailable without company evidence, and the
 // model obeyed: compensation became the largest single reason a
 // finished application stopped. It now names the fallback tiers and
 // says that returning nothing is the worst outcome - while still
 // refusing a fabricated citation, which is the part that was right.
 assert.match(compensationPrompt(payJob),/comparable roles at similar companies/);
 assert.match(compensationPrompt(payJob),/returning nothing is the worst outcome/);
 assert.match(compensationPrompt(payJob),/Never invent a source URL/);
});
await test('Cited AI salary amounts survive validation without a midpoint calculation',()=>{
 const result=validateCompensation(researchPayload,nativeReply,payJob); assert.ok(hasCompensationResearch(result)); assert.equal(result.recommendedAmount,173000); assert.notEqual(result.recommendedAmount,(result.minimum+result.maximum)/2);
 const question={type:'number',tag:'input',label:'Desired base salary',required:true,options:[]};
 assert.equal(resolveField(question,withDefaults({}),{compensation:result}).outcome,'ask');
 assert.equal(resolveField(question,withDefaults({}),{jd:'Salary $140,000 - $190,000'}).outcome,'blocked');
});
await test('Wrong employers and incoherent figures are still refused, while an uncited estimate is not',()=>{
 // Still refused, because each would put a wrong or meaningless number
 // in front of an employer.
 assert.throws(()=>validateCompensation({...researchPayload,company:'Another company'},nativeReply,payJob));
 assert.throws(()=>validateCompensation({...researchPayload,recommendedAmount:null},nativeReply,payJob));
 assert.throws(()=>validateCompensation({...researchPayload,maximum:1000},nativeReply,payJob));
 assert.throws(()=>validateCompensation({...researchPayload,period:'fortnight'},nativeReply,payJob));
 // No longer refused. Demanding native citations threw away every
 // answer ChatGPT gave without them, which stopped more applications
 // than anything else; the figure is taken and graded instead.
 const uncited=validateCompensation(researchPayload,{},payJob);
 assert.ok(hasCompensationResearch(uncited)); assert.equal(uncited.cited,false); assert.equal(uncited.evidence.mode,'chatgpt-estimate');
 // A source the transcript never cited is dropped from the evidence
 // rather than taking the answer down with it.
 const unsupported=validateCompensation({...researchPayload,sources:[{...source,url:'https://uncited.test/'}]},nativeReply,payJob);
 assert.equal(unsupported.sources.length,0); assert.equal(unsupported.cited,false); assert.ok(hasCompensationResearch(unsupported));
});
await test('Required compensation questions cannot fall back to N/A or the first menu option',async()=>{
 let calls=0; setModelTransport(async()=>{calls++;return {text:'{"1":"INSUFFICIENT"}'};});
 const question={key:'pay',question:'Desired hourly rate',required:true,must:true,options:[{label:'Below $40'},{label:'$40–$60'}]};
 const missing=await answerAll([question],{},{}); assert.equal(calls,0); assert.equal(missing.answers.length,0); assert.equal(missing.unanswered.length,1);
 const cited=validateCompensation(researchPayload,nativeReply,payJob);
 const declined=await answerAll([question],{compensation:cited},{}); assert.equal(declined.answers.length,0); assert.equal(declined.unanswered.length,1);
 setModelTransport(async()=>({text:'{"1":"N/A"}'}));
 const placeholder=await answerAll([{...question,options:[{label:'N/A'},{label:'$40–$60'}]}],{compensation:cited},{}); assert.equal(placeholder.answers.length,0);
});
await test('Binary documents round-trip through Chrome-compatible JSON serialization',async () => {
  const encoded = await pack({files:[new Blob(['document bytes'],{type:'application/pdf'})],bytes:new Uint8Array([0,128,255])});
  const decoded = unpack(JSON.parse(JSON.stringify(encoded)));
  assert.equal(await decoded.files[0].text(),'document bytes'); assert.equal(decoded.files[0].type,'application/pdf'); assert.deepEqual([...decoded.bytes],[0,128,255]);
});
await test('PDF output remains valid and paginates long content',async () => {
  const document = sampleDocument(); document.contact.phone='\u202a+1 555 0100\u202c'; document.sections.find(s=>s.roles).roles[0].bullets = Array.from({length:90},(_,i)=>`Achievement ${i+1}: built accessible interfaces using careful measurement and documented the resulting implementation for the engineering team.`);
  const bytes = await buildDocumentPdf(applyTemplate(document,DEFAULT_TEMPLATE),DEFAULT_TEMPLATE.theme);
  const pdf = await PDFDocument.load(bytes); assert.ok(pdf.getPageCount() >= 3); assert.equal(pdf.getAuthor(),'Alex Morgan');
});
console.log(`${count} customization checks passed.`);
