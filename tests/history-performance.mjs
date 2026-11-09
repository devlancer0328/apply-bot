import assert from 'node:assert/strict';
import {jobIdentityKeys,historyIndex,historyCandidates,previewHistory,readHistoryFiles} from '../src/history.js';
import {canonicalUrl} from '../src/join.js';
import {greenhouseIds,greenhousePosting,jobHtmlText} from '../src/greenhouse.js';
import {stage} from '../src/stages.js';
import {companyKey,companyResolved,employerKeys} from '../src/companies.js';
import {withDefaults} from '../src/profile.js';
import {databaseReply,ExtensionUpdateError,BUILD_VERSION,DATABASE_PROTOCOL,reloadExtension} from '../src/update.js';
let count=0;
async function test(name,work) { await work(); count++; console.log(`PASS ${name}`); }
await test('Greenhouse host, tracking, embedded and application aliases identify one posting',()=>{
  const index=historyIndex(historyCandidates('https://boards.greenhouse.io/acme/jobs/123?gh_src=saved'));
  for(const url of ['https://job-boards.greenhouse.io/acme/jobs/123/','https://boards.greenhouse.io/embed/job_app?token=123&for=acme','https://job-boards.greenhouse.io/acme/jobs/123/application']) assert.ok(index.match(url),url);
  assert.equal(index.match('https://boards.greenhouse.io/acme/jobs/124'),null);
  assert.equal(index.match('https://boards.greenhouse.io/other/jobs/123'),null);
});
await test('Ashby and Lever posting/application URLs match without merging employers',()=>{
  const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  for(const host of ['jobs.ashbyhq.com','jobs.lever.co']) {
    const index=historyIndex(historyCandidates(`https://${host}/acme/${id}`));
    assert.ok(index.match(`https://${host}/acme/${id}/application?utm_source=test`));
    assert.equal(index.match(`https://${host}/other/${id}`),null);
  }
});
await test('Workday locales, title slugs and apply suffixes preserve requisition identity',()=>{
  const index=historyIndex(historyCandidates('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Seattle/Engineer_R12345'));
  assert.ok(index.match('https://acme.wd1.myworkdayjobs.com/External/job/Remote/Software-Engineer_R12345/apply'));
  assert.equal(index.match('https://acme.wd1.myworkdayjobs.com/External/job/Remote/Engineer_R12346'),null);
});
await test('Unknown job query parameters and embedded tokens cannot collapse different jobs',()=>{
  assert.notEqual(canonicalUrl('https://careers.example/jobs?jobId=1'),canonicalUrl('https://careers.example/jobs?jobId=2'));
  const index=historyIndex(historyCandidates('https://careers.example/jobs?jobId=1&utm_medium=email'));
  assert.ok(index.match('https://careers.example/jobs?utm_source=feed&jobId=1'));
  assert.equal(index.match('https://careers.example/jobs?jobId=2'),null);
  assert.deepEqual(jobIdentityKeys('javascript:alert(1)'),[]);
  assert.deepEqual(jobIdentityKeys('https://user:password@careers.example/jobs/1'),[]);
});
await test('Importing 350 links is idempotent and previews without modifying existing records',()=>{
  const values=Array.from({length:350},(_,i)=>`https://boards.greenhouse.io/acme-${i}/jobs/${i+1}`).join('\n');
  const candidates=historyCandidates(values).map((r,i)=>({...r,company:`Previous Company ${i}`})), existing=[];
  const preview=previewHistory([...candidates,...candidates],existing);
  assert.equal(preview.fresh.length,350); assert.equal(preview.duplicates,350); assert.equal(existing.length,0);
  assert.equal(previewHistory(candidates,preview.fresh).fresh.length,0);
});
await test('Folder import reads job links and never reads resume or job-description contents',async()=>{
  const file=(name,path,body)=>({name,webkitRelativePath:path,size:100,text:async()=>body});
  const value=await readHistoryFiles([
    file('job-link.txt','Daniel/4MINDS/Forward Deployed Engineer/job-link.txt','https://boards.greenhouse.io/4minds/jobs/123'),
    {name:'Resume.pdf',webkitRelativePath:'Daniel/4MINDS/Forward Deployed Engineer/Resume.pdf',text(){throw new Error('Must not read');}},
    {name:'job-description.txt',webkitRelativePath:'Daniel/4MINDS/Forward Deployed Engineer/job-description.txt',text(){throw new Error('Must not read');}},
    file('job-link.txt','Daniel/Other/Role/job-link.txt','No saved link')
  ]);
  assert.equal(value.candidates.length,2); assert.equal(value.ignored,2); assert.equal(value.empty,0);
  assert.equal(value.candidates[0].company,'4MINDS'); assert.equal(value.candidates[0].title,'Forward Deployed Engineer');
});
await test('One application per company is mandatory across roles, job boards and legal name variations',()=>{
  const row={...historyCandidates('https://jobright.ai/jobs/abc')[0],company:'4MINDS',title:'Forward Deployed Engineer'};
  const index=historyIndex([row]);
  assert.ok(index.matchCompany('4 Minds, Inc.','https://jobs.lever.co/unrelated/another-role'));
  assert.equal(index.matchCompany('Other Minds'),null);
  assert.equal('onePerCompany' in withDefaults({onePerCompany:false}),false);
  assert.equal(companyKey('Acme Labs LLC'),'acmelabs'); assert.equal(companyKey('Acme'),'acme');
  assert.equal(companyResolved({applyUrl:'https://boards.greenhouse.io/acme/jobs/1'}),false);
});
await test('Company-only imports need no job links and aliases protect a different brand name',()=>{
  const index=historyIndex([{company:'Acme',companyAliases:['Acme Technologies']}]);
  assert.ok(index.matchCompany('Acme Inc')); assert.ok(index.matchCompany('Acme Technologies LLC'));
  assert.equal(index.matchCompany('Acme Labs'),null);
  const rows=previewHistory([{company:'ACME',urls:[]},{company:'Acme Inc',urls:[]},{company:'Other',urls:[]}]);
  assert.equal(rows.fresh.length,2); assert.equal(rows.duplicates,1);
});
await test('Greenhouse extraction decodes content and only accepts supported public board URLs',()=>{
  assert.deepEqual(greenhouseIds('https://job-boards.greenhouse.io/acme/jobs/123'),{board:'acme',id:'123'});
  assert.equal(greenhouseIds('https://job-boards.greenhouse.io.evil.test/acme/jobs/123'),null);
  assert.equal(greenhouseIds('http://examplecareers.greenhouse.io:123/jobs/123'),null);
  assert.equal(jobHtmlText('&lt;p&gt;R&amp;amp;D&lt;/p&gt;&lt;p&gt;Engineer&lt;/p&gt;'),'R&D\nEngineer');
});
await test('Public API results are cached, with no fallback salary or application submission request',async()=>{
  const previous=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({id:87654321,title:'Engineer',company_name:'Example',content:'<p>'+ 'A real job description. '.repeat(20)+'</p>'})};};
  try {
    const url='https://boards.greenhouse.io/performance-test/jobs/87654321';
    assert.equal((await greenhousePosting(url)).company,'Example'); assert.equal((await greenhousePosting(url)).title,'Engineer');
    assert.equal(calls.length,1); assert.match(calls[0].url,/boards-api.greenhouse.io/); assert.equal(calls[0].options.method,undefined); assert.ok(calls[0].options.signal);
    await greenhousePosting(url,{refresh:true});assert.equal(calls.length,2,'Final posting revalidation bypasses the extraction cache');
  } finally {globalThis.fetch=previous;}
});
await test('A later stage failure reuses successful generation and retries only failed work',async()=>{
  const checkpoint={}, calls={documents:0,research:0};
  async function attempt() {
    const doc=await stage(checkpoint,'documents',async()=>{calls.documents++;return {resume:'Generated once',letter:'Same response'};});
    await stage(checkpoint,'research',async()=>{calls.research++;if(calls.research===1) throw new Error('Transient research failure');return 'Cited research';});
    return doc;
  }
  await assert.rejects(attempt()); const value=await attempt();
  assert.equal(value.letter,'Same response'); assert.deepEqual(calls,{documents:1,research:2});
  assert.ok(checkpoint.timings.documents>=0); assert.ok(checkpoint.timings.research>=0);
});
await test('ATS vendors remain valid real employers and Workable short job links do not identify a shared company',()=>{
  for(const company of ['Workday','Greenhouse','Lever','Ashby']) assert.ok(companyResolved({company}),company);
  assert.deepEqual(employerKeys('https://apply.workable.com/j/AAA111'),[]);
  assert.deepEqual(employerKeys('https://apply.workable.com/j/BBB222'),[]);
  assert.deepEqual(employerKeys('https://apply.workable.com/acme/j/AAA111'),['employer:workable:acme']);
});
await test('Import grouping retains every company name when multiple names share a hiring-board account',()=>{
  const companies=[{company:'First Company',applyUrl:'https://jobs.lever.co/shared/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},{company:'Second Company',applyUrl:'https://jobs.lever.co/shared/ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'}];
  const rows=previewHistory(companies).fresh,index=historyIndex(rows);
  assert.equal(rows.length,1); assert.deepEqual(rows[0].companyAliases,['Second Company']);
  assert.ok(index.matchCompany('First Company')); assert.ok(index.matchCompany('Second Company'));
});
await test('Database replies from an older background fail with an actionable update error',()=>{
  for(const response of [{ok:true,value:[]},{ok:false,error:'Unknown database table.'},{ok:true,protocol:DATABASE_PROTOCOL,build:'older-build',value:[]}]) {
    assert.throws(()=>databaseReply(response),error=>error instanceof ExtensionUpdateError && error.needsReload===true);
  }
});
await test('A compatible worker preserves database values and real SQL errors',()=>{
  const metadata={build:BUILD_VERSION,protocol:DATABASE_PROTOCOL};
  assert.deepEqual(databaseReply({...metadata,ok:true,value:{saved:true}}),{saved:true});
  assert.throws(()=>databaseReply({...metadata,ok:false,error:'Disk write failed'}),/Disk write failed/);
});
await test('Reload recovery refuses to interrupt an active run or an unknown run state',async()=>{
  let reloads=0;
  for(const state of [{running:true},null,{}]) await assert.rejects(reloadExtension({sendMessage:async()=>state,reload:()=>reloads++}));
  assert.equal(reloads,0);
});
await test('An idle extension can reload without resetting or replacing its database',async()=>{
  let reloads=0;const messages=[];
  await reloadExtension({sendMessage:async message=>{messages.push(message);return {running:false};},reload:()=>reloads++});
  assert.equal(reloads,1);assert.deepEqual(messages,[{type:'state'}]);
});
console.log(`${count} history/performance checks passed.`);
