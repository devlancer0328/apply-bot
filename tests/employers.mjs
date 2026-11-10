import assert from 'node:assert/strict';
import {employerDay} from '../src/employers.js';
import {selectCompanyRoles} from '../src/filters.js';
import {historyIndex,historyUrls,jobIdentityKeys} from '../src/history.js';
import {boardRoster,boardSlug,harvestBoards,relevantPostings,rosterSeeds} from '../src/boards.js';
import {withScheduleDefaults} from '../src/schedule.js';
let count=0;const test=async(name,work)=>{await work();count++;console.log('PASS '+name);};
const gh=(board,id)=>`https://job-boards.greenhouse.io/${board}/jobs/${id}`;
const role=(id,company,extra={})=>({id,company,title:'Role '+id,applyUrl:id,sourceUrl:id,mode:'fillable',...extra});
/** The day's rule as the run applies it: choose, then claim, then send. */
const runDay=(jobs,day,limit)=>{
 const {selected,alternatives}=selectCompanyRoles(jobs,{limit,room:job=>day.room(job.company,[job.sourceUrl,job.applyUrl])});
 const sent=[];
 for(const job of selected)if(day.claim(job.company,[job.sourceUrl,job.applyUrl]))sent.push(job);
 return {sent,alternatives};
};

await test('Three distinct roles at one employer are allowed, a fourth is held, and the limit is configurable',()=>{
 const jobs=[1,2,3,4].map(n=>role(gh('acme',1000+n),'Acme Inc'));
 const {sent,alternatives}=runDay(jobs,employerDay({limit:3}),3);
 assert.equal(sent.length,3,'three genuinely different postings at one employer are allowed');
 assert.equal(alternatives.length,1,'the fourth is held as an alternative rather than sent');
 assert.equal(new Set(sent.map(job=>job.id)).size,3);
 assert.equal(runDay([1,2,3,4].map(n=>role(gh('acme',2000+n),'Acme Inc')),employerDay({limit:1}),1).sent.length,1,'the old one-per-employer rule is still reachable');
 assert.equal(runDay([1,2,3,4,5].map(n=>role(gh('acme',3000+n),'Acme Inc')),employerDay({limit:5}),5).sent.length,5);
});

await test('The same posting twice is refused however it is spelled, and never consumes two of the employer allowance',()=>{
 const day=employerDay({limit:3});
 const url=gh('acme','4242'),tracked=url+'?utm_source=jobright&gh_src=abc';
 assert.deepEqual(jobIdentityKeys(url),jobIdentityKeys(tracked),'tracking parameters do not make a second posting');
 const history=historyIndex([{company:'Acme Inc',applyUrl:url,status:'submitted'}]);
 assert.ok(history.match(tracked),'the exact posting is refused even after the employer has room again');
 assert.ok(history.match(url+'/'));
 // The posting-level refusal is permanent and does not depend on the budget.
 day.claim('Acme Inc',[url]);day.claim('Acme Inc',[gh('acme','4243')]);day.claim('Acme Inc',[gh('acme','4244')]);
 assert.equal(day.room('Acme Inc',[url]),0);
 const fresh=employerDay({limit:3});
 assert.equal(fresh.room('Acme Inc',[url]),3,'a new day gives the employer its allowance back');
 assert.ok(history.match(tracked),'...but the posting applied to yesterday is still refused today');
});

await test('An employer applied to in a previous run is still excluded for that posting and still budgeted for the others',()=>{
 const previous={company:'Acme Inc',title:'Role A',applyUrl:gh('acme','7001'),status:'submitted',at:Date.now()};
 const applications=historyIndex([previous]);
 // The run keeps company-level refusals only for imported rows that carry
 // no posting link, which is the only thing such a row can have meant.
 const barred=historyIndex([previous].filter(row=>!historyUrls(row).some(url=>jobIdentityKeys(url).length)));
 assert.ok(applications.match(gh('acme','7001')),'that posting stays refused');
 assert.equal(applications.match(gh('acme','7002')),null,'a different posting at the employer is not refused by it');
 assert.equal(barred.matchCompany('Acme Inc',gh('acme','7002')),null,'a real application no longer bars the whole employer');
 const imported={company:'Acme Inc',kind:'external',urls:[]};
 const never=historyIndex([imported].filter(row=>!historyUrls(row).some(url=>jobIdentityKeys(url).length)));
 assert.ok(never.matchCompany('Acme Inc',gh('acme','7002')),'an imported company with no link still bars the employer outright');
 const day=employerDay({limit:3});day.bar(imported.company,[]);
 assert.equal(day.room('Acme Inc',[gh('acme','7002')]),0);
 assert.equal(day.claim('Acme Inc',[gh('acme','7002')]),false);
});

await test('Roles at one employer are spaced rather than fired back to back, and other employers are not held up',()=>{
 const gap=20*60000,start=Date.parse('2026-03-04T12:00:00Z');
 const day=employerDay({limit:3,gapMs:gap,now:()=>start});
 assert.equal(day.waitMs('Acme Inc',[gh('acme','1')],start),0,'the first application waits for nothing');
 day.started('Acme Inc',[gh('acme','1')],start);
 assert.equal(day.waitMs('Acme Inc',[gh('acme','2')],start),gap,'the second is held off for the whole gap');
 assert.equal(day.waitMs('Acme Inc',[gh('acme','2')],start+gap-1),1);
 assert.equal(day.waitMs('Acme Inc',[gh('acme','2')],start+gap),0);
 assert.equal(day.waitMs('Beta Labs',[gh('beta','1')],start),0,'a different employer is never held up by it');
 // The queue sends in the order selection returns, so the spacing has to
 // be in that order too: A,B,A,B rather than A,A,B,B.
 const jobs=[role(gh('acme','11'),'Acme Inc'),role(gh('acme','12'),'Acme Inc'),role(gh('beta','11'),'Beta Labs'),role(gh('beta','12'),'Beta Labs')];
 const {selected}=selectCompanyRoles(jobs,{limit:3,room:()=>3});
 assert.equal(selected.length,4);
 for(let i=1;i<selected.length;i++)assert.notEqual(selected[i].company,selected[i-1].company,'no two consecutive sends go to one employer');
});

await test('Reservations are taken once, given back when a preparation dies, and reset with the calendar day',()=>{
 // Ten minutes before local midnight, because the day rolls over where the
 // applicant is rather than at UTC and the fixture must say the same thing
 // in every timezone the machine running it might be set to.
 const evening=new Date(2026,2,4);evening.setHours(23,50,0,0);
 let clock=evening.getTime();
 const day=employerDay({limit:3,now:()=>clock});
 assert.equal(day.claim('Acme Inc',[gh('acme','1')]),true);
 assert.equal(day.claim('Acme Inc',[gh('acme','2')]),true);
 assert.equal(day.count('Acme Inc',[gh('acme','1')]),2,'two concurrent preparations cannot both read the last slot as free');
 day.release('Acme Inc',[gh('acme','2')]);
 assert.equal(day.count('Acme Inc',[gh('acme','1')]),1,'a preparation that failed before opening a form costs the employer nothing');
 clock+=20*60000;
 assert.equal(day.count('Acme Inc',[gh('acme','1')]),0,'the budget resets at midnight in the applicant\u2019s own timezone');
 assert.equal(day.claim('Acme Inc',[gh('acme','9')]),true);
});

await test('One employer under two names is one budget, and an unresolvable employer is left to the other guards',()=>{
 const day=employerDay({limit:2});
 assert.equal(day.claim('Acme Incorporated',[gh('acme','1')]),true);
 assert.equal(day.claim('Acme, Inc.',[gh('acme','2')]),true,'legal endings do not create a second employer');
 assert.equal(day.claim('Acme',['https://boards.greenhouse.io/acme/jobs/3']),false,'...nor does reaching the same board a different way');
 assert.equal(day.room('Confidential',[]),2,'an employer with no resolvable identity is refused elsewhere, not budgeted here');
 const seeded=employerDay({limit:3});
 seeded.seed('Acme Inc',[gh('acme','1')],Date.now());
 assert.equal(seeded.room('Acme Inc',[gh('acme','2')]),2,'an application sent by an earlier run today still counts');
 seeded.seed('Acme Inc',[gh('acme','0')],Date.parse('2001-01-01T00:00:00Z'));
 assert.equal(seeded.room('Acme Inc',[gh('acme','2')]),2,'one sent last year does not');
});

await test('The day plan fixes the employer limit and the pacing, and a saved plan cannot raise them',()=>{
 assert.equal(withScheduleDefaults({}).perCompanyPerDay,1,'one application per employer');
 assert.equal(withScheduleDefaults({}).employerGapMs,20*60000);
 assert.equal(withScheduleDefaults({}).attemptConcurrency,6);
 assert.equal(withScheduleDefaults({}).documentBacklog,6);
 assert.equal(withScheduleDefaults({}).exhaustedRetryMs,10*60000);
 // These had fields in the options page and no longer do. A plan saved
 // before that removal still carries what was typed then, and reading it
 // back would leave an upgraded machine applying three times to one
 // employer through a field nobody can see.
 assert.equal(withScheduleDefaults({perCompanyPerDay:3}).perCompanyPerDay,1,'a stored limit from an older version is ignored');
 assert.equal(withScheduleDefaults({documentBacklog:10}).documentBacklog,6);
 assert.equal(withScheduleDefaults({exhaustedRetryMs:20*60000}).exhaustedRetryMs,10*60000);
 assert.equal(withScheduleDefaults({employerGapMs:0}).employerGapMs,20*60000);
 // The two that are still a choice stay one.
 assert.equal(withScheduleDefaults({dailyTarget:120}).dailyTarget,120);
 assert.equal(withScheduleDefaults({autopilot:false}).autopilot,false);
});

/* ------------------------------------------- the employers' own job boards */

const boardReply=(body,status=200)=>async()=>({ok:status>=200&&status<300,status,json:async()=>body});

await test('A Greenhouse board shown behind a careers page still yields a fillable, identifiable posting',async()=>{
 const rows=await boardRoster({board:'greenhouse',slug:'digicert'},{fetch:boardReply({jobs:[
  {id:8871029002,title:'Senior Software Engineer',absolute_url:'https://www.digicert.com/careers/?gh_jid=8871029002',location:{name:'Remote, US'}},
  {id:8885539002,title:'Staff Engineer',absolute_url:'https://app.careerpuck.com/job-board/digicert/job/8885539002',location:{name:'Lehi, UT'}},
 ]})});
 assert.equal(rows.length,2);
 assert.equal(rows[0].applyUrl,gh('digicert','8871029002'),'the employer\u2019s own careers address carries no board, no job identity and no form');
 assert.deepEqual(jobIdentityKeys(rows[0].applyUrl),['greenhouse:digicert:8871029002','url:https://job-boards.greenhouse.io/digicert/jobs/8871029002']);
 assert.equal(rows[1].applyUrl,gh('digicert','8885539002'));
 assert.equal(rows[0].title,'Senior Software Engineer');
});

await test('A closed board reads as empty; a broken one is reported rather than read as "no jobs"',async()=>{
 assert.deepEqual(await boardRoster({board:'greenhouse',slug:'gone'},{fetch:boardReply(null,404)}),[]);
 await assert.rejects(()=>boardRoster({board:'greenhouse',slug:'broken'},{fetch:boardReply(null,500)}),/answered 500/);
 await assert.rejects(()=>boardRoster({board:'ashby',slug:'odd'},{fetch:boardReply({jobs:'not a list'})}),/unreadable list/);
 assert.deepEqual(await boardRoster({board:'workday',slug:'anything'},{fetch:boardReply({})}),[],'boards with no public list endpoint are skipped, not guessed at');
 const {postings,failures}=await harvestBoards([{board:'greenhouse',slug:'good',company:'Good Co'},{board:'greenhouse',slug:'bad',company:'Bad Co'}],{
  fetch:async url=>/good/.test(url)?{ok:true,status:200,json:async()=>({jobs:[{id:1,title:'Engineer',location:{name:'Remote'}}]})}:{ok:false,status:503,json:async()=>null}});
 assert.equal(postings.length,1,'one employer\u2019s broken board does not stop the round');
 assert.equal(postings[0].company,'Good Co','the board list APIs never name the company, so the roster keeps it');
 assert.equal(failures.length,1);
});

await test('The roster is built from employers already seen, ordered by room left, and skips the ones with none',()=>{
 const seeds=rosterSeeds([
  {url:gh('acme','1'),company:'Acme Inc'},
  {url:gh('acme','2'),company:'Acme Inc'},
  {url:'https://jobs.ashbyhq.com/beta/4a3d2c1b-0000-4000-8000-000000000000',company:'Beta Labs'},
  {url:'https://example.wd1.myworkdayjobs.com/External/job/Remote/Engineer_R1',company:'Gamma'},
  {url:'https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa1',company:'Delta'},
 ],{room:seed=>seed.slug==='beta'?3:1});
 assert.deepEqual(seeds.map(seed=>`${seed.board}:${seed.slug}`),['ashby:beta','greenhouse:acme'],'one request per employer, most room first');
 assert.equal(seeds[0].company,'Beta Labs');
 assert.equal(rosterSeeds([{url:gh('acme','1'),company:'Acme Inc'}],{room:()=>0}).length,0,'an employer whose day is spent is not worth a request');
 assert.equal(boardSlug('https://example.wd1.myworkdayjobs.com/External/job/Remote/Engineer_R1'),null);
 assert.deepEqual(boardSlug(gh('acme','1')),{board:'greenhouse',slug:'acme'});
});

await test('A whole job board is narrowed to the roles this applicant applies for, one per role, within the day limit',()=>{
 const postings=[
  {title:'Senior Backend Software Engineer',board:'greenhouse',slug:'acme',applyUrl:gh('acme','1')},
  {title:'Machine Learning Engineer',board:'greenhouse',slug:'acme',applyUrl:gh('acme','2')},
  {title:'Staff Data Engineer',board:'greenhouse',slug:'acme',applyUrl:gh('acme','3')},
  {title:'Platform Engineer',board:'greenhouse',slug:'acme',applyUrl:gh('acme','4')},
  {title:'Accounts Payable Specialist',board:'greenhouse',slug:'acme',applyUrl:gh('acme','5')},
  {title:'Enterprise Account Executive',board:'greenhouse',slug:'acme',applyUrl:gh('acme','6')},
 ];
 const reference=['Senior Software Engineer','Machine Learning Engineer, Platform'];
 const kept=relevantPostings(postings,{reference,perEmployer:3});
 assert.equal(kept.length,3,'the day\u2019s allowance is the cap, so no request is wasted writing a fourth resume');
 assert.ok(kept.every(posting=>/engineer/i.test(posting.title)),'a job board is the whole company, and most of it is not this applicant');
 const all=relevantPostings(postings,{reference});
 assert.equal(all.length,4);
 assert.equal(all.some(posting=>/Accounts Payable|Account Executive/.test(posting.title)),false);
 assert.equal(relevantPostings(postings,{reference:[]}).length,postings.length,'with no history to judge by, nothing is dropped');
 assert.equal(relevantPostings(postings,{reference:['Senior Staff Remote Manager Full Time US']}).length,postings.length,'a vocabulary of nothing but furniture is no evidence either');
 const shared=relevantPostings([{title:'Senior Accounts Payable Specialist',board:'greenhouse',slug:'acme',applyUrl:gh('acme','9')}],{reference:['Senior Software Engineer']});
 assert.equal(shared.length,0,'sharing only "senior" with the applicant\u2019s history is not a match');
});

await test('One incidental word shared with the history cannot walk a software engineer into a sales job',()=>{
 // Live failure, 8 Nov: "Enterprise Account Executive" was applied to on the
 // strength of "enterprise" alone, which had reached the vocabulary from
 // "Full Stack Software Engineer - Enterprise". The vocabulary is built from
 // the run's own history, so the sale then taught it "account" and
 // "executive" - the drift feeds itself, and two real applications went to
 // roles this applicant has never held before it was caught.
 const history=['Full Stack Software Engineer - Payments','Site Reliability Engineer (Senior or Staff), Storage Layer Services','Staff AI Engineer - Developer Productivity','Senior Software Engineer- Full Stack','Software Engineer III, iOS - Cal AI','Senior Back End Engineer (Ruby on Rails & GO)','Full Stack Software Engineer - Enterprise'];
 const seen=titles=>new Set(relevantPostings(titles.map((title,index)=>({title,board:'greenhouse',slug:'acme',applyUrl:gh('acme',String(index))})),{reference:history}).map(posting=>posting.title));

 const wrong=['Enterprise Account Executive','Director, Partnerships & Enterprise International Growth','Regional Enterprise Sales Director - West (PST + MST)','Enterprise Customer Success Manager','Accounts Payable Specialist','Product Designer'];
 for(const title of seen(wrong)) assert.fail(`${title} shares only scenery with this applicant's history and must not be applied to`);

 // The same bar must not cost the applicant roles that are plainly theirs
 // but say something new: a discipline word carried by most of the history
 // is enough on its own, which is what keeps "Machine Learning Engineer".
 const right=['Machine Learning Engineer','Principal Data Engineer','Platform Engineer, Kubernetes','Site Reliability Engineer','Staff Software Engineer, Applied AI (IC)'];
 const kept=seen(right);
 for(const title of right) assert.ok(kept.has(title),`${title} is this applicant's work and must survive the filter`);
});

await test('One opening listed several times is one posting, so it cannot spend the employer allowance three times',()=>{
 const repeated=[
  {title:'FDE AI/ Solutions Architect (AI, Python/Data)',board:'lever',slug:'provectus',applyUrl:'https://jobs.lever.co/provectus/1'},
  {title:'FDE AI/ Solutions Architect (AI, Python/Data)',board:'lever',slug:'provectus',applyUrl:'https://jobs.lever.co/provectus/2'},
  {title:'Machine Learning Fellow - Frontier (Canada)',board:'lever',slug:'provectus',applyUrl:'https://jobs.lever.co/provectus/3'},
  {title:'Machine Learning Fellow - Frontier (UK)',board:'lever',slug:'provectus',applyUrl:'https://jobs.lever.co/provectus/4'},
  {title:'Senior Data Engineer',board:'lever',slug:'provectus',applyUrl:'https://jobs.lever.co/provectus/5'},
 ];
 const kept=relevantPostings(repeated,{reference:['Machine Learning Engineer','Data Architect','Solutions Architect']});
 assert.deepEqual(kept.map(posting=>posting.applyUrl),['https://jobs.lever.co/provectus/1','https://jobs.lever.co/provectus/3','https://jobs.lever.co/provectus/5']);
 const elsewhere={title:'FDE AI/ Solutions Architect (AI, Python/Data)',board:'ashby',slug:'elsewhere',applyUrl:'https://jobs.ashbyhq.com/elsewhere/6'};
 const other=relevantPostings([...repeated,elsewhere],{reference:['Machine Learning Engineer','Data Architect','Solutions Architect']});
 assert.equal(other.length,4);
 assert.ok(other.includes(elsewhere),'the same title at a different employer is a different job');
});

console.log(`\n${count} employer-budget and job-board checks passed.`);
