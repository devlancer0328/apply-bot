import {h,head,button} from './helpers.js';
import {elapsedText,runSummary} from '../run-policy.js';
import {bars,donut,funnel,target,TONE} from './charts.js';

/**
 * What each job is actually doing, in the four words a person uses.
 *
 * The run tracks a dozen stages and they are all meaningful to the code,
 * but someone glancing at the page after a night away is asking a much
 * smaller question: is it working on this, is it waiting for me, did it
 * go, or is it over. Everything maps onto one of those.
 */
const WORKING=['discovered','screening','extracting','documents','documents-ready','generating','applying','review','queued'];
const HOLDING=['manual','held','challenge','alternative','unconfirmed'];
const DONE=['submitted','dry-run'];
const PASSED=['skipped','unsupported','rejected','failed','abandoned'];
const groupOf=stage=>WORKING.includes(stage)?'working':HOLDING.includes(stage)?'holding':DONE.includes(stage)?'done':PASSED.includes(stage)?'passed':'working';

/** Every job the run knows about, bucketed into those four. */
function buckets(run){
 const jobs=Object.values(run.activeJobs||{});
 const out={working:[],holding:[],done:[],passed:[]};
 for(const job of jobs)out[groupOf(job.stage)].push(job);
 for(const list of Object.values(out))list.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 return out;
}

const jobRows=(list,emptyWord)=>list.length
 ?`<ul class="job-list">${list.slice(0,10).map(job=>`<li><span class="job-main"><strong>${h(job.company||job.title||job.id)}</strong><small>${h(job.title||'')}</small></span><span class="job-side"><em>${h(job.stage||'')}</em><small>${h(job.message||'')}</small></span></li>`).join('')}${list.length>10?`<li class="job-more">and ${list.length-10} more</li>`:''}</ul>`
 :`<p class="muted chart-empty">${h(emptyWord)}</p>`;

/**
 * The dashboard, above everything that was already here.
 *
 * The page it replaces answered "what is the run doing" in prose and left
 * "how is the day going" to be worked out from a counter strip. The
 * questions actually asked after a night away are how many went out, what
 * is stuck on me, where the supply went, and which boards and employers
 * took them - so each one gets a shape rather than a sentence.
 */
function dashboard(run){
 const day=run.day||{},jobs=buckets(run);
 const discovered=day.discovered||run.discovered||0;
 const attempted=day.attempted||run.attempted||0;
 const submitted=day.submitted||run.submitted||0;
 const companies=(day.employers||[]).length;

 // Counted once and used by both the headline and the ring. Two honest
 // ways of counting "passed over" sat next to each other on the first
 // draft and disagreed by two, which is all it takes to distrust a page.
 const passed=(day.skipped||0)+(day.abandoned||0)+jobs.passed.length;

 const headline=[
  ['Scraped',discovered,'links found today'],
  ['In progress',jobs.working.length,'being worked on now'],
  ['Holding for you',jobs.holding.length,'needs a person'],
  ['Applied',submitted,'sent today'],
  ['Passed over',passed,'duplicate, unsupported or refused'],
  ['Employers',companies,'applied to today'],
 ];

 const mix=[
  {label:'Sent',value:submitted,color:TONE.sent},
  {label:'Working',value:jobs.working.length,color:TONE.working},
  {label:'Holding',value:jobs.holding.length,color:TONE.holding},
  {label:'Failed',value:day.failed||0,color:TONE.failed},
  {label:'Passed over',value:passed,color:TONE.skipped},
 ];

 return `<section class="card dash">
  <div class="card-head"><h2>Today at a glance</h2><span class="pill ${run.running&&!run.stopping?'green':''}">${run.running&&run.stopping?'Stopping':run.running?'Running · '+h(run.phase||''):'Idle'}</span>${run.autopilot?'<span class="pill green">Autopilot on</span>':''}</div>
  <div class="dash-stats">${headline.map(([label,value,note])=>`<div class="stat"><small>${h(label)}</small><strong>${h(String(value))}</strong><span>${h(note)}</span></div>`).join('')}</div>
  ${target({done:submitted,goal:day.target||0,projected:day.projected??null,onTrack:day.onTrack!==false})}
 </section>

 <div class="cols">
  <section class="card"><h2>Where the day went</h2>
   ${funnel([
     {label:'Links found',value:discovered,color:TONE.skipped},
     {label:'Applications attempted',value:attempted,color:TONE.working},
     {label:'Actually sent',value:submitted,color:TONE.sent},
   ])}
   <p class="hint">Each step shows what survived the one above it. A big drop between found and attempted is supply quality; a big drop between attempted and sent is forms and verification.</p>
  </section>
  <section class="card"><h2>Outcome mix</h2>${donut(mix,{caption:'jobs worked'})}
   <p class="hint">Counts jobs the run actually picked up, not every link it found. The gap between this and Scraped above is supply the day never got to.</p></section>
 </div>

 <div class="cols">
  <section class="card"><h2>What stopped an application</h2>${bars((day.reasons||[]).map(row=>({label:row.reason,value:row.count})),{tone:TONE.holding})}</section>
  <section class="card"><h2>Attempts by platform</h2>${bars((day.boards||[]).map(row=>({label:row.board,value:row.count})),{tone:TONE.sent})}
   <p class="hint">Applications started on each board today. A board missing here was absent from the day's supply; a board here with little sent is being blocked at the form, and the reasons on the left say how.</p></section>
 </div>

 <div class="cols">
  <section class="card"><div class="card-head"><h2>In progress</h2><span class="pill">${jobs.working.length}</span></div>${jobRows(jobs.working,'Nothing is being worked on right now.')}</section>
  <section class="card"><div class="card-head"><h2>Holding for you</h2><span class="pill ${jobs.holding.length?'amber':''}">${jobs.holding.length}</span></div>${jobRows(jobs.holding,'Nothing is waiting on you.')}
   <p class="hint">These are filled and saved. Captcha pages are left open in the browser so the puzzle can be answered where it appeared.</p></section>
 </div>

 <div class="cols">
  <section class="card"><div class="card-head"><h2>Applied in this run</h2><span class="pill green">${jobs.done.length}</span></div>${jobRows(jobs.done,
    // The headline counts the whole day and this list only the run in
    // front of it, so an afternoon restart showed "Applied 6" above
    // "nothing sent yet today" and one of the two had to be wrong.
    submitted?`Nothing sent since this run started. The ${submitted} sent earlier today are listed on the right and in Applications.`:'Nothing sent yet today.')}</section>
  <section class="card"><h2>Employers applied to today</h2>${bars((day.employers||[]).map(row=>({label:row.company,value:row.count})),{tone:TONE.spare,unit:' role(s)',limit:12})}</section>
 </div>`;
}
const rateText=value=>value>=10?Math.round(value)+'/h':value>0?value.toFixed(1)+'/h':'—';
/**
 * The first thing read after a day away: is anything wrong, and is it mine.
 *
 * Above the counters on purpose. An applicant coming back to a night that
 * stopped at 1am needs the sentence explaining why before the number that
 * is lower than it should be, because the number on its own reads as the
 * bot being slow and sends them looking in the wrong place. Each row is a
 * named condition out of health.js with its own evidence and its own
 * remedy, so "fourteen failures" is never what is shown.
 */
/**
 * The day that has quietly ended.
 *
 * A machine ran with autopilot stored off, finished its first pass before
 * one in the morning and did nothing for the six hours after it. Nothing
 * was broken and nothing said so: the page read "Idle", which is also
 * what it reads between two runs a minute apart. This says which of the
 * two it is, and only when it matters - not running, not finished, and
 * nothing coming.
 */
function dormantBody(run){
 const day=run.day;
 if(run.running||run.autopilot||!day?.target||day.met)return '';
 if(run.stopReason?.code==='setup'||run.stopReason?.code==='health')return '';
 return `<section class="card"><div class="card-head"><h2>Nothing further is scheduled</h2><span class="pill">Autopilot off</span></div>
 <p class="info">${day.submitted||0} of ${day.target} sent today, and no run will start by itself. The rest of the day waits for Start run.</p>
 <p class="hint">Turn on "Keep starting runs until the target is met" in the day plan to have the next run start on its own. Pressing Stop always turns it back off.</p></section>`;
}
function healthBody(run){
 const health=run.health;const conditions=health?.conditions||[];
 const halted=run.stopReason?.code==='health';
 if(!conditions.length)return halted?`<section class="card"><h2>Needs you</h2><p class="info">${h(run.stopReason.message)}</p><p class="hint">Press Start run once this is dealt with; that is also what clears the warning.</p></section>`:'';
 const word={stop:'Stops the day',quarantined:'Board left alone',degraded:'Being worked around'};
 return `<section class="card"><div class="card-head"><h2>${conditions.some(c=>c.severity==='stop')?'Needs you':'Health'}</h2><span class="pill ${conditions.some(c=>c.severity==='stop')?'':'green'}">${conditions.length} condition(s)</span></div>
 ${conditions.map(c=>`<div class="progress-line ${c.severity==='stop'?'error':'warn'}"><strong>${h(c.title)}</strong> · ${h(word[c.severity]||c.severity)}<p class="hint">${h(c.detail)}</p><p class="hint">First seen ${h(new Date(c.since).toLocaleTimeString())}${c.tried?`, ${c.tried} automatic recovery attempt(s) since`:''}.</p></div>`).join('')}
 ${health?.screenshots===false?`<p class="hint">Last-page screenshots are not being saved while disk is short${health.freeBytes>0&&health.freeBytes<Infinity?`; ${Math.round(health.freeBytes/1e6)} MB of room is left`:''}.</p>`:''}
 ${conditions.some(c=>c.severity==='stop')?'<p class="hint">Press Start run once this is dealt with; that is also what clears the warning.</p>':''}</section>`;
}
/**
 * The day, above the run.
 *
 * A run is one shift of a day's work now, so "how is it going" cannot be
 * answered from the run's own counters: three hundred applications across
 * thirty runs reads as thirty runs of ten. This card answers the three
 * questions actually asked after an unattended night - how many went out,
 * who to, what went wrong and how often, and whether the rate is good
 * enough for the rest of the day. The needed-rate figure is the honest
 * one, because it is what says by lunchtime that today will fall short.
 */
function dayBody(run){
 // Filled out before anything is read off it. This page redraws every two
 // seconds against whatever the worker last wrote, and a half-written day
 // - a run restarted mid-write, an older build's record - used to take the
 // whole monitor down with it, leaving no way to see why.
 const day=run.day?{target:0,submitted:0,attempted:0,failed:0,abandoned:0,skipped:0,discovered:0,remaining:0,rate:0,needed:0,hoursLeft:0,projected:0,reasons:[],employers:[],boards:[],...run.day}:null;
 if(!day)return '';
 const attempts=run.attempts||{},holders=attempts.holders||[];
 const verdict=day.target<=0?'No daily target is set; a run stops when the feeds are empty or the per-run limit is reached.'
  :day.met?`Today's target of ${day.target} is met. Nothing further is sent until midnight.`
  :day.rate>0?`${rateText(day.rate)} so far; ${rateText(day.needed)} is needed for the remaining ${day.remaining} in ${day.hoursLeft.toFixed(1)}h. At the current rate today ends at about ${day.projected}.`
  :`${day.remaining} still to send in ${day.hoursLeft.toFixed(1)}h, which needs ${rateText(day.needed)}.`;
 return `<section class="card"><div class="card-head"><h2>Today</h2><span class="pill ${day.met||day.onTrack?'green':''}">${day.target?`${day.submitted} of ${day.target}`:`${day.submitted} sent`}</span><span class="pill ${run.autopilot?'green':''}">${run.autopilot?'Autopilot on':'Autopilot off'}</span></div>
 <div class="stats">${[['Sent today',day.submitted],['Failed',day.failed],['Abandoned',day.abandoned],['Skipped',day.skipped],['Links found',day.discovered],['Current rate',rateText(day.rate)]].map(([label,value])=>`<div class="stat"><small>${label}</small><strong>${h(String(value))}</strong></div>`).join('')}</div>
 <p class="${day.met||day.onTrack?'muted':'info'}">${h(verdict)}</p>
 ${day.supplyLimited?'<p class="info">Everything the feeds produced today has been worked through, so the ceiling is job supply rather than speed. Widen the Hiring Cafe search or add a source.</p>':''}
 ${holders.length?`<div class="code-list">${holders.map(holder=>`<div class="progress-line"><strong>${h(holder.company||holder.board||'Application')}</strong> · ${h(holder.parked?`waiting for ${holder.waitingFor||'something'}, holding no slot`:holder.stage||'working')}<p class="hint">${h(holder.board||'')} · ${elapsedText(holder.forMs||0)}</p></div>`).join('')}</div>`:''}
 <p class="hint">${attempts.busy||0} of ${attempts.width||1} application slot(s) working, ${attempts.parked||0} waiting on mail, ${attempts.queued||0} queued.</p>
 ${day.reasons.length?`<div class="table-wrap"><table><thead><tr><th>WHAT DID NOT GO OUT</th><th>COUNT</th></tr></thead><tbody>${day.reasons.map(row=>`<tr><td>${h(row.reason)}</td><td>${row.count}</td></tr>`).join('')}</tbody></table></div>`:''}
 ${(day.employers||[]).length?`<details><summary>Applied to today (${day.employers.length} employer(s))</summary><div class="table-wrap"><table><thead><tr><th>EMPLOYER</th><th>ROLES</th></tr></thead><tbody>${day.employers.map(row=>`<tr><td>${h(row.company)}</td><td>${row.count}</td></tr>`).join('')}</tbody></table></div></details>`:''}</section>`;
}
export function monitorBody(run={}){
 const now=Date.now(),end=run.running?now:(run.finishedAt||run.lastActivityAt||now),workers=run.aiWorkers||{},last=now-(run.lastActivityAt||now);
 return `${dormantBody(run)}${healthBody(run)}${dashboard(run)}<details><summary>Day and run detail</summary><div class="detail-body">${dayBody(run)}</div></details><section class="card"><div class="card-head"><h2>${run.running&&run.stopping?'Stopping':run.running?'Running · '+h(run.phase):'Run status'}</h2><span class="pill">${run.startedAt?elapsedText(end-run.startedAt):'Not started'}</span></div><p class="${run.stopReason?.code==='error'?'info':'muted'}">${h(runSummary(run))}</p>${run.running&&last>60000?`<p class="info">No visible progress for ${elapsedText(last)}. ChatGPT may still be thinking; each response has a six-minute deadline. You can stop after the current operations.</p>`:''}<div class="stats">${[['Discovered',run.discovered||0],['Confirmed',run.targetSubmitted?`${run.submitted||0}/${run.targetSubmitted}`:run.submitted||0],['Attempts',run.attempted||0],['Screened',run.screened||0],['Held for review',run.review||0],['Rejected',run.rejected||0]].map(([label,value])=>`<div class="stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div><p class="hint">Last progress: ${run.lastActivityAt?h(new Date(run.lastActivityAt).toLocaleTimeString()):'—'} · ${run.running?`Discovery source: ${h(run.discoverySource||'loaded links')}`:'Saved results remain in Applications and Jobs.'}</p></section>
 ${run.feedScan?`<section class="card"><h2>Job discovery</h2><p>${h(run.feedScan.source)} &middot; ${run.feedScan.unique||0} unique links &middot; ${run.feedScan.percent||0}% of loaded list scanned</p><p class="hint">${h({'chunk-limit':'Reading job recommendations','waiting-for-loader':'Waiting for job cards to load','waiting-for-network':'Waiting for the job list to respond','waiting-for-next-page':'Waiting for the next page','confirming-bottom':'Checking for more jobs','backend-end-confirmed':'End of feed confirmed','stable-bottom-confirmed':'End of feed confirmed','confirmed-empty-feed':'No jobs available','feed-error':'Job list needs attention'}[run.feedScan.reason]||'Reading job recommendations')} &middot; ${run.feedScan.complete?'Feed scan complete':'More of this feed remains to be scanned'}</p></section>`:''}
 <section class="card"><div class="card-head"><h2>ChatGPT workers</h2><span class="pill">${workers.busy||0}/${workers.effective||1} active · ${workers.queued||0} waiting</span></div>${workers.reason?`<p class="info">${h(workers.reason)}</p>`:''}${(workers.tasks||[]).map(t=>`<article class="card"><h3>${h(t.label||'ChatGPT request')}</h3><p>${h(t.stage)}${t.mode?' ('+h(t.mode)+')':''} · ${elapsedText(now-t.startedAt)} · ${t.characters||0} response characters</p><p class="hint">${t.taskId?'Task '+h(t.taskId.slice(0,8)):''}${t.tabId?' · tab '+t.tabId:''}</p></article>`).join('')||'<p class="muted">No ChatGPT request is active.</p>'}</section>
 ${run.lastError?`<section class="card"><h2>Latest error</h2><p class="info">${h(run.lastError.message)}</p><p class="hint">${h(new Date(run.lastError.at).toLocaleString())}. Individual job failures can be followed by more work; the run status above explains whether the whole run stopped.</p></section>`:''}
 <section class="card"><h2>Recent job activity</h2>${Object.values(run.activeJobs||{}).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,12).map(j=>`<div class="progress-line"><strong>${h(j.company||j.title||j.id)}</strong> · ${run.running?'':'Last stage: '}${h(j.stage)}<p class="hint">${h(j.title)} · ${h(j.message)} · ${elapsedText(now-j.updatedAt)} ago</p></div>`).join('')||'<p class="muted">Job activity appears after discovery.</p>'}</section>
 <section class="card"><h2>Run log</h2><div class="code-list" style="max-height:480px;overflow:auto">${(run.log||[]).slice(-200).reverse().map(e=>`<div class="progress-line ${h(e.level)}"><small>${h(new Date(e.at).toLocaleTimeString())} · ${h(e.level)}</small> ${h(e.message)}${e.detail?`<details><summary>Details</summary><pre style="white-space:pre-wrap">${h(JSON.stringify(e.detail,null,2))}</pre></details>`:''}</div>`).join('')||'<p>No log entries yet.</p>'}</div></section>`;
}
export function monitor({run}){return head('WATCH THE WHOLE WORKFLOW','Run monitor','Live progress, errors and exact stop reasons. Updates every two seconds.',button('start-run','Start run','primary')+button('stop-run','Stop','quiet')+button('download-run-log','Download run log','quiet'))+'<div id="monitor-connection" hidden class="info"></div><div id="monitor-body">'+monitorBody(run)+'</div>';}
