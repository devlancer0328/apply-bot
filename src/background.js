import { isCompensationQuestion, researchCompensation, hasCompensationResearch } from "./salary.js";
import { databaseRequest } from './database.js';
import {configureChatGptWorkers,closeChatGptWorkers,chatTabContext} from './chatgpt.js';
import {DiscoveryRounds,runCapacity} from './run-policy.js';
import {startClock,elapsedClock,tick} from './timing.js';
import {confirmationSnapshot,newConfirmation,confirmedWizardReceipt} from './submission-evidence.js';
import {snapshotWriter} from './run-snapshot.js';
import {resumedEnding,stopEnding} from './stop-control.js';
import { stateStorage } from './store.js';
/** Application pipeline: discover postings, tailor a resume through ChatGPT context, fill and verify forms, then review or submit. Resumes and evidence persist in SQLite. */

import { answerFitsControl, resolveField, resolveForm, wantsProse } from "./answers.js";
import {isDemographicQuestion} from './demographics.js';
import { answerAll, answerQuestion, AiError } from "./ai.js";
import { candidateFrom, checkWriter, educationFrom, WriterError, writeApplication,completeApplicationSupport } from "./writer.js";
import {applicationNeeds,extractionResting,applicationPriority,protectsCompany,bankedJobs} from './application-needs.js';
import { describe as describeSpend, resetRun as resetSpend, runTotal } from "./spend.js";
import { atsOf, FILLABLE } from "./ats.js";
import {isDiscoveryUrl,readOriginalPosting,verifiedOriginal} from './original-posting.js';
import { ashbyApplyUrl, ashbyIds, ashbyPosting } from "./ashby.js";
import { leverApplyUrl, leverIds, leverPosting } from "./lever.js";
import { ripplingApplyUrl, ripplingIds, ripplingPosting } from "./rippling.js";
import { workableApplyUrl, workableIds, workablePosting } from "./workable.js";
import { applyToJobApplyUrl, applyToJobIds, applyToJobPosting } from "./applytojob.js";
import { workdayApplyUrl, workdayIds, workdayPosting, workdayPostingUrl } from "./workdayBoard.js";
import {finishApplicationTab} from './final-page.js';
import {allJobs,getJob,saveJob,getResume,saveResume,allResumes} from './store.js';
import {screenJob,screeningSignature,documentSignature,fingerprint} from './screening.js';
import {normalizeFilters,selectCompanyRoles} from './filters.js';
import {stagedBatch} from './pipeline.js';
import { canonicalUrl } from "./join.js";
import {greenhouseIds, greenhousePosting, greenhouseApplyUrl} from './greenhouse.js';
import {historyIndex,historyUrls,jobIdentityKeys} from './history.js';
import {companyKey as employerNameKey,companyResolved} from './companies.js';
import {BUILD_VERSION,DATABASE_PROTOCOL} from './update.js';
import { isHiringCafeSearch, searchPage } from "./hiringcafe.js";
import { recommendedJobs } from "./jobright.js";
import { createVerificationService } from "./apply/verification.js";
import { ALL_PATTERNS } from "./mail-providers.js";
import { OUTCOMES } from "./apply/contract.js";
import { chromeBrowserOps } from "./apply/chrome-ops.js";
import { applyThroughModule, forgetBoardTrials, moduleEngine } from "./apply/run-bridge.js";
import { atFront, disown, findTab, focus, hold, openTab as openInFront, reapTabs, releaseOwned, resident } from "./tabs.js";
import { boardStarted, boardWaitMs, dayProgress, emptyLedger, nextRun, recordDiscovered, recordOutcome, rollDay, withScheduleDefaults } from "./schedule.js";
import { createHealth } from "./health.js";
import {employerDay} from './employers.js';
import {harvestBoards,relevantPostings,rosterSeeds} from './boards.js';
import {roleAllowed,roleFilterActive,roleRejection,roleTerms} from './roles.js';
import { createSlots } from "./slots.js";
import { allLinks, allPairings, allResults, allHistory, answerPack, askedQuestions, claimSubmission, forgetKeys, readProfile, recordResult, releaseSubmission, toBase64, usedAnswers } from "./store.js";
import { questionKey } from "./question-pack.js";
import { scoreFit } from "./fit.js";
import { documentText } from "./templates.js";
import { suppliedApplication } from "./pairings.js";

// Nothing here uses a key any more; one an earlier version saved is dropped.
forgetKeys().catch(() => {});
import { missingFromProfile } from "./profile.js";
import { applicationFolder, dayFolder, logText, MANUAL_ROOT, onExportProblem, otherLinksCsv, otherLinksPath, resultsCsv, save, saveJson, stamp } from "./vault.js";

/** The profile's authorization setting, in words a model can use. */
const AUTHORIZATION_WORDS = {
  "us-citizen": "US citizen, authorized to work in the United States without sponsorship",
  "permanent-resident": "lawful permanent resident, authorized to work in the United States without sponsorship",
  "visa-holder": "visa holder, currently authorized to work in the United States",
  "needs-sponsorship": "will require visa sponsorship to work in the United States",
};

const state = {
  running: false,
  stopping: false,
  total: 0,
  done: 0,
  attempted:0,submitted:0,targetSubmitted:0,screened:0,rejected:0,review:0,phase:'idle',aiWorkers:null,startedAt:0,finishedAt:0,lastActivityAt:0,heartbeatAt:0,stopReason:null,lastError:null,activeJobs:{},discovered:0,discoverySource:'',feedScan:null,day:null,attempts:null,
  /**
   * Who asked for the stop `stopping` is carrying.
   *
   * Four different things set that flag - the button, the health ladder,
   * the stall watchdog, and a future fifth - and the ending was worked out
   * afterwards by elimination, which named every stop nobody else claimed
   * as the applicant having pressed the button. It is recorded when it is
   * asked for instead, and it rides in the saved progress so the answer
   * survives the worker that knew it.
   */
  stopSource:'',
  log: [],
};

/**
 * The log lives in session storage as well as in memory, because memory here
 * is the service worker's, and Chrome ends the worker thirty seconds after a
 * run finishes. Open the popup a minute later and an in-memory log is gone -
 * a run that sent four applications looks exactly like one that never ran.
 *
 * Session storage is also how a worker that died mid-run gets to say so. The
 * last thing written was "running"; the next worker to start reads that and
 * knows the run it did not finish was not finished by anyone.
 */
const durableRun=snapshotWriter(value=>stateStorage.set({lastRunSnapshot:value}),{onError:error=>{console.warn('Could not save workflow status',error);state.lastError={at:Date.now(),message:'Could not save workflow status: '+error.message};}});

/**
 * The day, kept apart from the run.
 *
 * A run is now one shift of a day's work rather than the whole of it (see
 * schedule.js), so the quota, the pace and the tally of what went wrong
 * cannot live in `state`, which is wiped at the top of every run. They live
 * here and in SQLite, and the first thing a new service worker does is read
 * them back - otherwise a worker Chrome killed at application two hundred
 * would start the afternoon counting from zero and apply six hundred times.
 */
let scheduleSettings=withScheduleDefaults();
let dailyLedger=emptyLedger();
const durableDay=snapshotWriter(value=>stateStorage.set({dailyLedger:value}),{delay:5000,onError:error=>console.warn('Could not save the day ledger',error)});
const keepDay=()=>durableDay.schedule(dailyLedger);
const loadSchedule=async()=>(scheduleSettings=withScheduleDefaults((await stateStorage.get('schedule')).schedule));
const loadDay=async()=>(dailyLedger=rollDay((await stateStorage.get('dailyLedger')).dailyLedger));

/**
 * Midnight during a run is a new quota, not a continuation of yesterday's.
 * Without this an unattended night would stop at 00:01 convinced the day's
 * three hundred were already sent - by the previous day.
 */
const freshDay=()=>{if(rollDay(dailyLedger).day!==dailyLedger.day){dailyLedger=rollDay(dailyLedger);keepDay();}return dailyLedger;};

/**
 * What is systemically wrong, as opposed to what went wrong with this job.
 *
 * Alongside the ledger and for the same reason: the conditions are about
 * the day rather than the run, and the escalation ladder only works if a
 * worker Chrome killed at 3am comes back knowing the mailbox has already
 * been reloaded twice tonight. See health.js.
 */
const health=createHealth();
const durableHealth=snapshotWriter(value=>stateStorage.set({healthState:value}),{delay:5000,onError:error=>console.warn('Could not save the health record',error)});
const keepHealth=()=>durableHealth.schedule(health.snapshot());
const loadHealth=async()=>health.restore((await stateStorage.get('healthState')).healthState);

/** Applications in flight. Resized from the settings at the top of each run. */
const slots=createSlots({limit:scheduleSettings.attemptConcurrency,onChange:value=>{state.attempts=value;remember();}});

const remember = () => {
  state.day=dayProgress(freshDay(),scheduleSettings);
  state.health={conditions:health.conditions(),freeBytes:health.freeBytes,screenshots:health.screenshots};
  state.autopilot=scheduleSettings.autopilot;
  // `stopping` and `stopSource` are saved with the rest because they are the
  // only record that a stop was ever asked for. They used to live in the
  // worker's memory alone, and Chrome ends that worker during the minutes a
  // run takes to wind down - after which the next worker read "running" and
  // called the ending an interruption, which is the one ending built to be
  // restarted immediately. Pressing Stop and watching a fresh run begin a
  // minute later is that line.
  const value={runLog:state.log,runProgress:{running:state.running||(state.phase==='starting'&&!state.finishedAt),stopping:state.stopping,stopSource:state.stopSource,total:state.total,done:state.done,attempted:state.attempted,submitted:state.submitted,targetSubmitted:state.targetSubmitted,screened:state.screened,rejected:state.rejected,review:state.review,phase:state.phase,aiWorkers:state.aiWorkers,startedAt:state.startedAt,finishedAt:state.finishedAt,lastActivityAt:state.lastActivityAt,heartbeatAt:state.heartbeatAt,stopReason:state.stopReason,lastError:state.lastError,activeJobs:state.activeJobs,discovered:state.discovered,discoverySource:state.discoverySource,feedScan:state.feedScan,day:state.day,attempts:state.attempts,health:state.health,autopilot:scheduleSettings.autopilot}};
  chrome.storage.session.set(value).catch(()=>{});durableRun.schedule(value);
};

const restored = chrome.storage.session
  .get(["runLog", "runProgress"])
  .then(async(stored) => {
    // The day comes from SQLite rather than session storage, because session
    // storage dies with the browser and the quota has to survive a restart.
    await Promise.all([loadSchedule().catch(()=>{}),loadDay().catch(()=>{}),loadHealth().catch(()=>{})]);
    slots.resize(scheduleSettings.attemptConcurrency);
    if(!stored.runProgress)stored=(await stateStorage.get('lastRunSnapshot')).lastRunSnapshot||stored;
    if (Array.isArray(stored.runLog)) state.log = stored.runLog;
    if (stored.runProgress) {
      state.total = stored.runProgress.total ?? 0;
      state.done = stored.runProgress.done ?? 0;
      for(const key of ['attempted','submitted','targetSubmitted','screened','rejected','review','phase','aiWorkers','startedAt','finishedAt','lastActivityAt','heartbeatAt','stopReason','lastError','activeJobs','discovered','discoverySource','feedScan','attempts','health'])if(stored.runProgress[key]!==undefined)state[key]=stored.runProgress[key];
      if (stored.runProgress.running) {
        const ending=resumedEnding({...stored.runProgress,done:state.done,total:state.total});
        state.stopReason=ending.reason;
        state.activeJobs={};state.aiWorkers={...state.aiWorkers,busy:0,queued:0,tasks:[]};state.phase=ending.phase;state.finishedAt=Date.now();
        state.stopping=false;state.stopSource='';
        // Nothing to wait for: a run that did not choose to stop was
        // killed, so autopilot picks it up on the next tick rather than
        // honouring a delay the dead run had written down. A run that was
        // asked to stop keeps the delay, and a Stop the dead worker may
        // not have finished writing down is written down again here -
        // otherwise the supervisor restarts the run the applicant stopped
        // and the button is one Chrome can undo by recycling a worker.
        if(ending.restartable)stateStorage.set({autopilotResumeAt:0}).catch(()=>{});
        else if(ending.reason.code==='user')stopAutopilot().catch(()=>{});
        if(ending.level==='error')state.lastError={at:Date.now(),message:state.stopReason.message};
        state.log.push({at:Date.now(),level:ending.level,message:ending.message});
        remember();
      }
    }
  })
  .catch(() => {});

function log(level, message, detail) {
  const entry = { at: Date.now(), level, message, detail };
  state.lastActivityAt=entry.at;
  if(level==='error'){state.lastError={at:entry.at,message};if(!state.running&&!state.stopReason)state.stopReason={code:'error',message};}
  state.log.push(entry);
  if (state.log.length > 500) state.log.shift();
  remember();
  // Nothing may be listening; a closed popup is the normal case, not an error.
  chrome.runtime.sendMessage({ type: "log", entry }).catch(() => {});
}
onExportProblem((message) => log("warn", message));
function jobActivity(job,stage,message){
  const id=job.url||job.id||job.sourceUrl;if(!id)return;const before=state.activeJobs[id];
  state.activeJobs[id]={id,company:job.company||before?.company||'',title:job.title||before?.title||'',stage,message,startedAt:before?.startedAt||Date.now(),updatedAt:Date.now()};
  const recent=Object.values(state.activeJobs).sort((a,b)=>b.updatedAt-a.updatedAt);if(recent.length>100)state.activeJobs=Object.fromEntries(recent.slice(0,100).map(j=>[j.id,j]));
  state.lastActivityAt=Date.now();remember();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a step took, in the log.
 *
 * Added because "it is slow" and "which part is slow" are different questions,
 * and only the second one can be acted on. Waiting for a page, writing the
 * documents and filling the form are minutes apart in cost, and without a
 * number beside each the whole run is just slow.
 */
/** The model spend since a `runTotal()` snapshot, in words. */
function sinceSpend(before) {
  const now = runTotal();
  return describeSpend(null, {
    calls: now.calls - before.calls,
    inputTokens: now.inputTokens - before.inputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    cachedTokens: now.cachedTokens - before.cachedTokens,
    dollars: now.dollars - before.dollars,
    priced: now.priced,
  });
}

const since = (from, to = Date.now()) => `${((to - from) / 1000).toFixed(1)}s`;

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** A LinkedIn job: neither applied to nor listed for applying by hand. */
function isLinkedIn(url) {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Below this, tailoring would be guesswork and a resume written from a
 * navigation menu is worse than no application at all.
 */
const JD_MIN = 400;

/**
 * The same job, by what it says rather than where it is.
 *
 * One posting reaches the bot by several roads - Jobright's link, Hiring
 * Cafe's, the board's own - and each road has its own address, so a check on
 * addresses alone sends the same application twice. The company and the
 * title, folded: lower case, the bracketed tags boards and aggregators add
 * ("[Remote]", "(Hybrid - Austin)") gone, a trailing "Inc" or "LLC" gone,
 * punctuation and spacing gone. Empty when either is unknown, and an empty
 * key matches nothing.
 */
export function jobKey(company, title) {
  const c = fold(company);
  const t = fold(title);
  return c && t ? `${c}|${t}` : "";
}

const fold = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|gmbh|plc)\b\.?/g, " ")
    .replace(/\b(?:remote|hybrid|onsite|on-site|usa?|us-based|united states)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");

/**
 * The company alone, folded the same way. Employers are budgeted rather
 * than barred - see employers.js for how many roles one may have in a day
 * and why that is not the same as applying twice to one posting. Empty
 * when the company is unknown or a placeholder, and matches nothing.
 */
export function companyKey(company) {
  return employerNameKey(company);
}

/**
 * The boards whose postings can be read from an API instead of a page: the
 * posting (title, company, description, form address) from an address, the
 * address's parts, and the form's address from a posting's.
 */
const BOARD_NAMES = { greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever", workday: "Workday", rippling: "Rippling", workable: "Workable", applytojob: "ApplyToJob" };

const BOARD_API = {
  greenhouse: {posting:greenhousePosting,ids:greenhouseIds,applyUrl:greenhouseApplyUrl},
  ashby: { posting: ashbyPosting, ids: ashbyIds, applyUrl: ashbyApplyUrl },
  lever: { posting: leverPosting, ids: leverIds, applyUrl: leverApplyUrl },
  rippling: { posting: ripplingPosting, ids: ripplingIds, applyUrl: ripplingApplyUrl },
  workable: { posting: workablePosting, ids: workableIds, applyUrl: workableApplyUrl },
  applytojob: { posting: applyToJobPosting, ids: applyToJobIds, applyUrl: applyToJobApplyUrl },
  // The posting page is the one to read when the API cannot be reached;
  // the form's address behind it opens on a sign-in.
  workday: { posting: workdayPosting, ids: workdayIds, applyUrl: workdayApplyUrl, pageUrl: workdayPostingUrl },
};

/* ------------------------------------------------------------------ tabs */

/**
 * Waits for a tab to finish loading, then for its form to actually appear.
 *
 * "complete" means the document loaded, which on a React board is a spinner.
 * The form arrives afterwards, so the real signal is the field count holding
 * still for a moment - rising means it is still rendering, and reading it then
 * yields half a form.
 */
async function waitForForm(tabId) {
  const deadline = Date.now() + 30000;
  let previous = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    await wait(250);
    let count;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => document.querySelectorAll("input, select, textarea").length,
      });
      count = Math.max(0, ...results.map((result) => result.result ?? 0));
    } catch {
      continue;
    }

    if (count > 0 && count === previous) {
      stable += 1;
      if (stable >= 2) return await waitForHydration(tabId);
    } else {
      stable = 0;
    }
    previous = count;
  }
  return false;
}

/**
 * Waits for React to take the form over.
 *
 * The board serves the form as HTML and React hydrates it afterwards. In
 * between, the fields are on screen and the count holds still - "loaded",
 * by any look at the page - but nothing on them works: a menu clicked
 * shows nothing, and a value typed is not in React's state, so the form
 * later insists the phone, the names and the resume are missing when they
 * are plainly there. Every slow and refused form traced back to this.
 *
 * Hydration leaves a mark: React hangs its fiber on each DOM node it owns.
 * A form whose inputs carry it is ready. A page with no React at all - the
 * older embedded boards - is ready as served, and is not waited for.
 */
async function waitForHydration(tabId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let states;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => {
          const inputs = [...document.querySelectorAll("input, select, textarea")];
          const count = inputs.length;
          const state = (() => {
            if (inputs.length === 0) return "none";
            const reactPage =
              Boolean(document.querySelector("#__next, [data-reactroot], #root, #app, [class*='select__control'], [class*='react-select'], script[src*='react'], .ashby-application-form-field")) ||
              Boolean(window.__NEXT_DATA__);
            if (!reactPage) return "static";
            const owned = inputs.filter((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber") || key.startsWith("__reactProps")));
            if (owned.length < Math.ceil(inputs.length / 2)) return "pending";
            // The phone box is a widget (intl-tel-input) that sets itself up
            // after hydration and wipes the box when it does. Set up, it has
            // marked the input with its id and wrapped it in its container.
            const phones = inputs.filter((node) => node.type === "tel" && /\biti\b|iti__/.test(node.className));
            if (phones.some((node) => !node.hasAttribute("data-intl-tel-input-id") && !node.closest(".iti"))) return "pending";
            return "hydrated";
          })();
          return { state, count };
        },
      });
      states = results.map((result) => result.result).filter(Boolean);
    } catch {
      await wait(200);
      continue;
    }
    // Only the frame holding the form counts. A captcha's iframes also hold
    // a box or two, and a React one of those that never hydrates would
    // otherwise hold a plain server-rendered form here for the full wait.
    const form = states.sort((a, b) => b.count - a.count)[0];
    if (form && (form.state === "hydrated" || form.state === "static")) return true;
    await wait(150);
  }
  return true;
}

/**
 * Every tab the run opens goes to the front; see tabs.js for why. The
 * second argument is what the old "bring each tab to the front" setting
 * passed, kept so the call sites read the same, and ignored.
 */
const openTab = (url) => openInFront(url);

const closeTab = (tabId) => chrome.tabs.remove(tabId).catch(() => {});

/**
 * Finds the frame holding the application form and loads the filler into it.
 *
 * Greenhouse is served two ways: as its own page, and as an iframe embedded in
 * the company's careers site. In the second case the top frame has no form at
 * all, so every frame is asked and the busiest one wins.
 */
async function attach(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    files: ["src/fill.js"],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => (window.__ghApply ? window.__ghApply.inventory() : null),
  });

  const best = results
    .filter((result) => result.result && result.result.fields.length > 0)
    .sort((a, b) => b.result.fields.length - a.result.fields.length)[0];

  if (!best) return null;
  return { frameId: best.frameId, inventory: best.result };
}

const inFrame = (tabId, frameId, func, args = []) =>
  chrome.scripting
    .executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func, args })
    .then((results) => results[0]?.result);

/* -------------------------------------------------- link to application */

/**
 * Opens a link and reads what it is.
 *
 * Every frame is asked and the most informative answer wins, because a careers
 * page that embeds its board in an iframe has the apply address in the child
 * and the job description in the parent, and neither frame alone is the whole
 * posting.
 */
async function readLink(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    files: ["src/extract.js"],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => (window.__ghExtract ? /(^|\.)(jobright\.ai|hiringcafe\.com|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com)$/i.test(location.hostname) ? window.__ghExtract.discover() : window.__ghExtract.read() : null),
  });

  const reports = results.map((result) => result.result).filter(Boolean);
  if (reports.length === 0) return null;

  const greenhouse = reports.find((report) => FILLABLE.has(report.apply?.ats));
  const longest = reports.reduce((best, report) => (report.jd.length > best.jd.length ? report : best));

  // The two can come from different frames, so they are merged rather than
  // chosen between.
  return {
    ...longest,
    apply: greenhouse?.apply ?? longest.apply,
    company: longest.company || greenhouse?.company || "",
    role: longest.role || greenhouse?.role || "",
  };
}

/**
 * Reads the page over and over until the posting has actually arrived.
 *
 * This used to wait for the whole document's text to stop changing and then
 * read once. On a single-page aggregator that is a bad proxy for the thing
 * being waited on: a relative timestamp that reticks, a chat widget, a lazily
 * loaded row of related jobs all keep the body's length moving long after the
 * description is complete, so the wait ran to its timeout almost every time
 * and a Jobright link cost fifteen seconds before anything was read at all.
 *
 * Waiting on the extracted description instead asks the question that matters.
 * It stops growing when the posting is there, which is usually about a second
 * after the page paints, and the surrounding furniture cannot hold it open.
 */
async function readWhenReady(tabId, deadlineMs = 12000) {
  const deadline = Date.now() + deadlineMs;
  let best = null;
  let previous = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    // Re-injected each time rather than once up front, which is deliberate: a
    // careers page builds its Greenhouse iframe after the page paints, and a
    // frame that did not exist at the first read has no extractor in it.
    const report = await readLink(tabId).catch(() => null);

    if (report) {
      if (!best || report.jd.length > best.jd.length) best = report;
      // An apply address can appear a frame later than the text it belongs to.
      if (best && !best.apply && report.apply) best.apply = report.apply;

      if (report.originalControl) return report;
      if (report.jd.length >= JD_MIN && report.jd.length === previous) {
        stable += 1;
        if (stable >= 2) return best;
      } else {
        stable = 0;
      }
      previous = report.jd.length;
    }

    await wait(250);
  }

  return best;
}

/**
 * Presses the apply control and waits to see where it went.
 *
 * Needed because an aggregator rarely links to the employer directly. Jobright
 * and Hiring Cafe put their apply buttons through a redirect of their own, or
 * make them buttons with no address at all, so a page that mentions no ATS
 * anywhere in its markup can still be a Greenhouse posting one hop away.
 *
 * Both destinations are watched: the tab may navigate in place, or a new one
 * may open. Whichever arrives first is the answer, and any tab opened along
 * the way is handed back to be closed.
 */
async function hopToApply(tabId) {
  const opened = [];
  const onCreated = (tab) => {
    if (tab.openerTabId !== tabId) return;
    opened.push(tab.id);
    // A tab the site opened is a background one, and throttled; same rule as ours.
    void focus(tab.id);
  };
  chrome.tabs.onCreated.addListener(onCreated);

  try {
    const before = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "";

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => (window.__ghExtract ? window.__ghExtract.followApply() : null),
    });
    const action = results.map((result) => result.result).find((result) => result?.acted);
    if (!action) return { tabId: null, opened };

    if (action.navigate) await chrome.tabs.update(tabId, { url: action.navigate });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await wait(250);

      const spawned = opened.length > 0 ? await chrome.tabs.get(opened[0]).catch(() => null) : null;
      const current = await chrome.tabs.get(tabId).catch(() => null);

      // An address that names an ATS has already answered the only question
      // the hop was asked. Waiting for the page behind it to render is a page
      // load spent confirming something the URL said, and it is the same page
      // the form will be opened on in a moment anyway.
      for (const tab of [spawned, current]) {
        if (!tab?.url || tab.url === before || tab.url.startsWith("about:")) continue;
        const ats = atsOf(tab.url);
        if (ats) return { tabId: tab.id, opened, via: action.text, known: { url: tab.url, ats } };
      }

      if (spawned?.status === "complete" && spawned.url && !spawned.url.startsWith("about:")) {
        return { tabId: spawned.id, opened, via: action.text, url: spawned.url };
      }
      if (current?.status === "complete" && current.url && current.url !== before) {
        return { tabId, opened, via: action.text, url: current.url };
      }
    }

    return { tabId: null, opened };
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

/**
 * The resume and letter, with a rate limit or a provider outage waited
 * out rather than charged to the job. A few postings are written at once
 * now, so a 429 is a thing that happens; it used to put the posting to
 * rest for a week.
 */
/** The model spend on a written application, for the log line that announces it. */
function spent(generated) {
  const spend = generated?.spend;
  if (!spend) return "";
  return ` (model: resume ${spend.resume}; letter ${spend.letter})`;
}

async function writeWithPatience(profile, job, resumeSnapshot=null) {
  const names = {documents:'Resume generation and PDF',saveResume:'Save resume',letter:'Cover letter',letterPdf:'Letter PDF',saveLetter:'Save cover letter',research:'Compensation research',save:'Save documents'};
  const checkpoint = {id:job.libraryId,resumeSnapshot,onStage:(name,status,ms) => {
    jobActivity(job,status==='completed'?'prepared':name,`${names[name]||name}: ${status}`);
    if (status === 'completed') log('info',`${job.company || job.title} - ${names[name] || name}: ${(ms / 1000).toFixed(1)}s`);
  }};
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await writeApplication(profile, job, runAbort.signal, checkpoint);
    } catch (error) {
      const status = error instanceof WriterError ? error.status : 0;
      if (status >= 500 && error.retryable!==false && attempt < 2 && !state.stopping) {
        log("warn", `${job.company || job.title} - the writer answered ${status}; trying again in ${20 * (attempt + 1)}s`);
        await wait(20000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

/**
 * A link, turned into something that can be submitted.
 *
 * The order here is the point of the whole design. The page is read first and
 * the apply address checked against Greenhouse before anything is generated,
 * so a posting that applies through Workday - or through an email address, or
 * a form this bot has never seen - costs one page load and nothing else. Only
 * once the form is known to be fillable is a resume and a letter written for
 * it.
 */
/**
 * The hiring systems the generic filler is allowed to drive, and nothing
 * else.
 *
 * An allow-list rather than a block-list, because the question is not "is
 * this site dangerous" - every site is, these are real applications - but
 * "has this one been looked at". Each entry here was driven end to end in
 * recon with one unambiguous Submit found on the page; see `genericFill` in
 * src/profile.js for what that recon covered and declined.
 *
 * Deliberately excluded, and both appear in real feeds: a company's own
 * bespoke careers page, where there is no second posting to learn from and
 * no way to know what its Submit does, and a job board re-listing someone
 * else's posting, where applying means holding an account on that board
 * rather than sending anything to the employer.
 */
const GENERIC_VENDORS = [/(^|\.)odoo\.com$/i];
// Boards that carry other people's postings. Not discovery sources this bot
// reads, so `isDiscoveryUrl` does not name them, but equally not employers.
const RELISTING = /(^|\.)(dice\.com|monster\.com|simplyhired\.com|talent\.com|jobs\.net|careerbuilder\.com|builtin\.com|themuse\.com|wellfound\.com)$/i;
const genericFillAllowed = (profile, url) => {
  if (profile.genericFill === "any") return true;
  if (profile.genericFill !== "vendors") return false;
  try { return GENERIC_VENDORS.some((pattern) => pattern.test(new URL(url).hostname)); } catch { return false; }
};

async function sourceFromLink(link, profile, via = "", hints = {}) {
  const tabs = [];
  const openedAt = Date.now();
  if (isLinkedIn(link) || isLinkedIn(via)) {
    return { skip: "a LinkedIn job, which is neither applied to nor listed", elsewhere: true };
  }
  try {
    let report=null,listing=null,hop=null;
    let originalUrl=hints.originalUrl||link;
    const duplicate=(company,...urls)=>hints.history?.matchCompany(company,link,via,...urls)||hints.history?.match(link,via,...urls);
    if(duplicate(hints.company))return {skip:'Already applied to this posting, or this employer is on your never-approach list',duplicate:true};
    if(isDiscoveryUrl(link)&&!hints.originalUrl) {
      await atFront(async()=>{
        const first=await openTab(link);tabs.push(first);
        listing=await readWhenReady(first);
        if(!listing)return;
        if(duplicate(listing.company,listing.apply?.url))return;
        if(listing.apply?.url)originalUrl=listing.apply.url;
        // An employer's own careers page is as good an answer as a board's,
        // and the card's data names it outright. Taking it here is what
        // keeps a posting on a site no board of ours serves from costing the
        // hop before it can even be named.
        else if(listing.originalUrl&&!isDiscoveryUrl(listing.originalUrl))originalUrl=listing.originalUrl;
        else if(listing.employerLinkOffered===false)return;
        else {hop=await hopToApply(first);tabs.push(...hop.opened);originalUrl=hop.known?.url||hop.url||'';}
      });
      if(duplicate(listing?.company,originalUrl))return {skip:'Already applied to this posting, or this employer is on your never-approach list',duplicate:true};
      // The aggregator saying it holds no employer link is a different
      // answer from the bot failing to find one, and worth keeping apart:
      // over a night's run every card marked this way failed to resolve and
      // every card not marked resolved, so there is nothing here to retry in
      // half an hour. Let it go cheaply instead of paying the hop again each
      // time the feed offers it back.
      if(listing?.employerLinkOffered===false&&(!originalUrl||isDiscoveryUrl(originalUrl)))return {skip:'the aggregator holds no employer link for this posting; it applies only through the aggregator itself'};
      if(!originalUrl||isDiscoveryUrl(originalUrl))throw Object.assign(new Error('The original employer posting link could not be resolved; aggregator descriptions are not used.'),{originalUnavailable:true});
    }
    const readPage=async url=>atFront(async()=>{
      const tab=await openTab(url);tabs.push(tab);return readWhenReady(tab);
    });
    const board=atsOf(originalUrl);
    if(board&&!FILLABLE.has(board)&&profile.manualMode!=='write'&&!genericFillAllowed(profile,originalUrl))return manualApplication({link,via,applyUrl:originalUrl,listing,hints,profile,reason:'applies through '+board+', which this bot cannot fill'});
    try {
      report=await readOriginalPosting(originalUrl,{api:BOARD_API[board],readPage,minimum:JD_MIN,log:message=>log('warn',message)});
      // A company careers page may embed its supported board. Read the
      // exact board posting as authority rather than the wrapper's text.
      if(report.apply?.url&&report.apply.url!==originalUrl&&BOARD_API[report.apply.ats]?.ids(report.apply.url)) {
        report=await readOriginalPosting(report.apply.url,{api:BOARD_API[report.apply.ats],readPage,minimum:JD_MIN,log:message=>log('warn',message)});
      }
    } catch(error) {
      if(error.postingClosed)return {skip:error.message};
      throw Object.assign(error,{originalUnavailable:true});
    }
    report.apply={...report.apply,url:report.apply?.url||originalUrl,ats:report.apply?.ats||atsOf(report.apply?.url||originalUrl)};
    if(duplicate(report.company,report.apply.url))return {skip:'Already applied to this posting, or this employer is on your never-approach list',duplicate:true};
    listing=report;
    // A site that is itself another list of other people's postings is a
    // different answer from a site with no adapter, and saying so is worth
    // one branch: four of nine "cannot be filled automatically" on a night's
    // run were Dice, where applying means holding a Dice account rather than
    // reaching the employer at all, and reading that as a missing adapter
    // sends somebody off to write one.
    if(!FILLABLE.has(report.apply.ats)&&!genericFillAllowed(profile,report.apply.url))
      return manualApplication({link,via,applyUrl:report.apply.url,listing,hints,profile,reason:isDiscoveryUrl(report.apply.url)||RELISTING.test(hostOf(report.apply.url))?`${hostOf(report.apply.url)} re-lists this posting rather than taking the application, so there is no employer form here to fill.`:'This application site cannot be filled automatically.'});
    report.apply.url=BOARD_API[report.apply.ats]?.applyUrl(report.apply.url)||report.apply.url;
    log('info',report.company+' - original description verified from '+report.descriptionSource.method+': '+report.descriptionSource.url);
    const jd = String(report.jd ?? "").trim();
    if (jd.length < JD_MIN) {
      return { skip: `only ${jd.length} characters of job description were found` };
    }

    // What the page says it is, unless the page says something useless - a
    // board that titles its frame "IFrame" - and the list it came from knew
    // better.
    const useless = (text) => !text || /^(iframe|frame|untitled|job application)$/i.test(String(text).trim());
    const company = (useless(report.company) && hints.company) || report.company || listing.company || hints.company || "";
    const title = (useless(report.role) && hints.title) || report.role || listing.role || report.title || hints.title || "";
    if (hints.history?.matchCompany(company,link,via,report.apply.url) || hints.history?.match(link,via,report.apply.url)) return {skip:'Already applied to this posting, or this employer is on your never-approach list',duplicate:true};
    if (hints.applied?.has(jobKey(company, title))) {
      return { skip: `already applied to "${title}" at ${company}, reached earlier by another link`, duplicate: true };
    }
    if (hints.employers && !hints.employers.room(company,[link,via,report.apply.url])) {
      return { skip: `${company} has had its allowance of roles for today`, duplicate: true };
    }
    if (!companyKey(company)) return {skip:'The hiring company could not be verified. Review manually; no application was prepared or sent.'};
    if(hints.extractOnly)return {posting:{id:canonicalUrl(link),sourceUrl:via||link,applyUrl:report.apply.url,company,title,jd,descriptionSource:report.descriptionSource,originalUrl:report.descriptionSource.url,metadata:report.metadata||{},ats:report.apply.ats,mode:'fillable',extractedAt:Date.now(),extractionMs:Date.now()-openedAt}};
    if (hints.claimPreparation && !hints.claimPreparation(company,link,via,report.apply.url)) return {skip:'Another role at this company is already being prepared in this run',duplicate:true};
    log("info", `${title || link} - ${BOARD_NAMES[report.apply.ats] ?? report.apply.ats}, found in ${since(openedAt)}. Writing resume and cover letter.`);

    const writingAt = Date.now();
    const generated = await writeWithPatience(profile, { jd, url: link, title, company });
    log("info", `${generated.company || title} - written in ${since(writingAt)}${spent(generated)}`);
    if (generated.violations.length > 0) {
      log("warn", `${generated.company || title} - ${generated.violations.length} generation warning(s)`, generated.violations);
    }

    return {
      application: {
        id: canonicalUrl(link),
        // Where it was found: the aggregator's page when the link came from
        // one, which is more useful in the record than the apply address twice.
        sourceUrl: via || link,
        applyUrl: report.apply.url,
        company: generated.company || company || new URL(report.apply.url).hostname,
        title: (useless(generated.role) ? title : generated.role) || title,
        jd,
        descriptionSource:report.descriptionSource,originalUrl:report.descriptionSource.url,
        compensation: generated.compensation,
        timings: {extraction:writingAt-openedAt,...generated.timings},
        letterText: generated.letterText,
        // The tailored bullets, as text. The PDF about to be attached cannot be
        // read back, and this is the same document before it was laid out.
        resumeText: generated.resumeText,
        // The first job on it, for the forms that ask the current title and
        // employer as separate boxes.
        currentRole: generated.resume?.experience?.[0]?.role ?? "",
        currentCompany: generated.resume?.experience?.[0]?.company ?? "",
        // The degree, school and year on the resume, for the education block.
        education: generated.resume?.education ?? null,
        // The whole resume as data - every job with its dates and bullets -
        // for Workday, which asks the career back job by job.
        resumeData: generated.resume ?? null,
        resume: generated.resumeBlob,
        resumeName: generated.resumeName,
        letter: generated.letterBlob,
        letterName: generated.letterName,
      },
    };
  } finally {
    for (const tab of new Set(tabs)) await closeTab(tab);
  }
}

/**
 * A job this bot cannot send. By the setting, either the resume and the
 * letter are written all the same, into a folder under "manual
 * application/<day>/", and the link goes on the day's table in "other links/" - for
 * the applicant to apply by hand; or the link is only listed; or the job
 * is passed over. LinkedIn jobs are always passed over.
 */
async function manualApplication({ link, via, applyUrl, listing, hints, profile, reason }) {
  if (isLinkedIn(applyUrl)) {
    return { skip: `${reason}; it is a LinkedIn job, which is neither applied to nor listed`, elsewhere: true };
  }
  if (profile.manualMode === "ignore") {
    return { skip: `${reason}; passed over, by the setting`, elsewhere: true };
  }
  const jd = String(listing?.jd ?? "").trim();
  const company = listing?.company || hints.company || "";
  const title = listing?.role || listing?.title || hints.title || "";
  if (hints.applied?.has(jobKey(company, title))) {
    return { skip: `already applied to "${title}" at ${company}, reached earlier by another link`, duplicate: true };
  }
  if ((hints.employers && !hints.employers.room(company,[link,via,applyUrl])) || hints.history?.matchCompany(company,link,via,applyUrl)) {
    return { skip: `${company} has had its allowance of roles for today`, duplicate: true };
  }
  if(hints.extractOnly&&profile.manualMode!=='write')return {posting:{id:canonicalUrl(link),sourceUrl:via||link,applyUrl:applyUrl||link,company,title,jd:'',mode:'manual',manualReason:reason,ats:atsOf(applyUrl||link),extractedAt:Date.now()}};
  if (jd.length < JD_MIN) {
    return { skip: `${reason}, and only ${jd.length} characters of description were found to write from`, elsewhere: true };
  }

  if(hints.extractOnly)return {posting:{id:canonicalUrl(link),sourceUrl:via||link,applyUrl:applyUrl||link,company,title,jd,descriptionSource:listing?.descriptionSource,originalUrl:listing?.descriptionSource?.url,mode:'manual',manualReason:reason,ats:atsOf(applyUrl||link),extractedAt:Date.now()}};

  // Listed but not written for: the setting that keeps the model key for
  // the applications this bot actually sends, or the run's quota of
  // by-hand folders already used up. The link still goes on the list,
  // with no folder beside it.
  const why = profile.manualMode === "list" ? "by the setting" : hints.manualSlot && !hints.manualSlot() ? `the run's limit of ${profile.manualLimit} by-hand folder(s) is reached` : "";
  if (why) {
    const application = { id: canonicalUrl(link), sourceUrl: via || link, applyUrl: applyUrl || link, company: company || (applyUrl ? hostOf(applyUrl) : ""), title };
    log("info", `${title || link} - ${reason}. Listed for applying by hand; nothing written for it, ${why}.`);
    return { manual: { application, folder: "", reason, written: false } };
  }

  if (!companyKey(company)) return {skip:'The hiring company could not be verified. Review manually before applying.'};
  if (hints.claimPreparation && !hints.claimPreparation(company,link,via,applyUrl)) return {skip:'Another role at this company is already being prepared in this run',duplicate:true};

  log("info", `${title || link} - ${reason}. Writing resume and cover letter for a manual application.`);
  const writingAt = Date.now();
  const generated = await writeWithPatience(profile, { jd, url: link, title, company });
  log("info", `${generated.company || title} - written in ${since(writingAt)}${spent(generated)}`);

  const application = {
    id: canonicalUrl(link),
    sourceUrl: via || link,
    applyUrl: applyUrl || link,
    company: generated.company || company || (applyUrl ? hostOf(applyUrl) : ""),
    title: generated.role || title,
  };
  const folder = applicationFolder(application, MANUAL_ROOT);
  const files = [];
  await save(`${folder}/${generated.resumeName}`, generated.resumeBlob, { type: "application/pdf" });
  files.push(generated.resumeName);
  await save(`${folder}/${generated.letterName}`, generated.letterBlob, { type: generated.letterBlob.type || "application/pdf" });
  files.push(generated.letterName);
  await save(`${folder}/Cover letter.txt`, generated.letterText, { type: "text/plain" });
  files.push("Cover letter.txt");
  const note = [
    `${application.company}${application.title ? ` - ${application.title}` : ""}`,
    `Apply here: ${application.applyUrl}`,
    application.sourceUrl !== application.applyUrl ? `Found via: ${application.sourceUrl}` : "",
    `Why by hand: ${reason}.`,
    `Written: ${new Date().toLocaleString()}`,
  ].filter(Boolean);
  await save(`${folder}/Job link.txt`, note.join("\n"), { type: "text/plain" });
  files.push("Job link.txt");
  await saveJson(`${folder}/application.json`, {
    company: application.company,
    title: application.title,
    status: "manual",
    reason,
    jobUrl: application.applyUrl,
    foundVia: application.sourceUrl,
    applicant: { name: `${profile.firstName} ${profile.lastName}`.trim(), email: profile.email },
    writtenAt: new Date().toISOString(),
    compensation: application.compensation,
    files,
  }, { overwrite: true });

  return { manual: { application, folder, reason } };
}

/** The day's "other links" table, rewritten whole with every row of that day. */
async function keepOtherLinks(manual, at = Date.now()) {
  const day = dayFolder(new Date(at));
  const rows = manual.filter((row) => dayFolder(new Date(row.at)) === day);
  await keep(otherLinksPath(new Date(at)), otherLinksCsv(rows), { overwrite: true, type: "text/csv" });
}

/* ------------------------------------------------------------- one job */

/** The facts a form's open questions are answered from: the posting, the documents written for it, the person. */
/**
 * The answered questions, held for the length of a run.
 *
 * Read once at the top of a run rather than per application: the pack is
 * small, it only changes when a person answers something on the Questions
 * page, and a database read per form is a read per form. An answer typed
 * mid-run reaches the next run, which is the same bargain every other
 * setting here makes.
 */
let runAnswerPack = {};

/**
 * A question nothing could answer, written down against the form it came
 * off so the applicant can answer it once on the Questions page.
 *
 * Never allowed to be the reason an application fails. The attempt is
 * already parking when this runs, and a failed write here would turn a
 * recoverable park into a lost one for the sake of bookkeeping.
 */
async function rememberQuestions(application, entries) {
  const sightings = (entries ?? [])
    .filter((entry) => String(entry?.question ?? "").trim())
    .map((entry) => ({
      question: entry.question,
      company: application?.company ?? "",
      url: application?.applyUrl || application?.sourceUrl || "",
      required: entry.required !== false,
      options: (entry.options ?? []).map((option) => (typeof option === "string" ? option : option?.label ?? option?.value ?? "")).filter(Boolean).slice(0, 40),
      type: entry.type ?? "",
      reason: entry.reason ?? "",
    }));
  if (!sightings.length) return;
  await askedQuestions(sightings).catch((error) => log("warn", `could not save ${sightings.length} unanswered question(s) for review: ${error.message}`));
  // Which questions parked which application, so that answering one can
  // pick the application back up. Without this the pack would fill with
  // answers and nothing would ever be retried: the answer is on the
  // Questions page and the job it unblocks is unidentifiable.
  const id = application?.id;
  if (id) blockedBy.set(id, [...new Set([...(blockedBy.get(id) ?? []), ...sightings.map((entry) => questionKey(entry.question, entry.company)).filter(Boolean)])]);
  log("info", `${application?.company ?? "This application"} - ${sightings.length} question(s) saved to Questions for you to answer once: ${sightings.map((entry) => `"${String(entry.question).slice(0, 60)}"`).join(", ")}`);
}

/**
 * Questions raised during an attempt, held until the attempt's outcome
 * is written, because the job row is only saved once at the end and the
 * questions are discovered in the middle.
 */
const blockedBy = new Map();

function answerContext(application, profile) {
  return {
    // What the applicant has already answered, so a question that parked
    // an application last night fills a form tonight.
    answerPack: runAnswerPack,
    company: application.company,
    title: application.title,
    jd: application.jd,
    letter: application.letterText ?? "",
    // The resume written for this posting when there is one, and the pasted
    // career behind all of them otherwise.
    resume: application.resumeText ?? "",
    compensation: application.compensation,
    currentRole: application.currentRole ?? "",
    currentCompany: application.currentCompany ?? "",
    currentlyEmployed: /present|current|ongoing|now/i.test(application.resumeData?.experience?.[0]?.endDate || ""),
    education: application.education ?? educationFrom(),
    // The person, as distinct from the career. See facts() in ai.js.
    location: [profile.city, profile.state, profile.country].filter(Boolean).join(", "),
    country: profile.country || '',
    remotePreference: profile.remotePreference,
    startDate: profile.startDate,
    workAuthorization: AUTHORIZATION_WORDS[profile.workAuthorization] ?? "",
    sponsorship: profile.requiresSponsorship === "yes" ? "will need sponsorship" : "does not need sponsorship, now or in the future",
    relocation: profile.willingToRelocate === "yes" ? "willing to relocate" : profile.willingToRelocate === "no" ? "not willing to relocate" : "not specified",
    travel: profile.willingToTravel === "no" ? "not able to travel" : profile.willingToTravel === "yes" ? "able to travel when the role requires it" : "not specified",
    phone: profile.phone,
    email: profile.email,
    // Said outright, because the tailored resume names some of the
    // posting's tools and not others, and a model asked about one it does
    // not name answered "0-1 years" and "None" for the title it was used
    // under - two fields above a resume claiming the stack.
    extraFacts: [
      'Only claim technology experience explicitly supported by the supplied resume. Do not treat the job description as candidate experience.',
    ],
  };
}

async function ensureApplicationSupport(application,profile,fields,context) {
  // Resolve saved facts before spending another model request. A missing
  // legal/demographic answer cannot be repaired with compensation research.
  if(resolveForm(fields,profile,context).blocked.some(field=>!['salary-research','cover-letter-text'].includes(field.rule)))return;
  const needs=applicationNeeds(fields,profile);
  if(!needs.letter&&!needs.compensation)return;
  const checkpoint={onStage:(name,status,ms)=>{
    jobActivity({...application,url:application.id},'applying',name==='research'?'Researching compensation requested by this form':'Preparing the requested cover letter');
    if(status==='completed')log('info',`${application.company} - form ${name}: ${(ms/1000).toFixed(1)}s`);
  }};
  try{await completeApplicationSupport(profile,application,needs,checkpoint);}
  finally{
    application.timings={...application.timings,...checkpoint.timings};Object.assign(context,answerContext(application,profile));
    const job=await getJob(application.id),libraryId=application.libraryId||job?.resumeId;
    const saved=libraryId&&await getResume(libraryId);
    if(saved)await saveResume({...saved,letter:application.letterText||saved.letter||'',letterPdf:application.letter||saved.letterPdf||null,compensation:application.compensation,timings:application.timings});
    if(job)await saveJob({...job,applicationData:{...job.applicationData,letterText:application.letterText||'',letterName:application.letterName||'',compensation:application.compensation,timings:application.timings,libraryId}});
  }
}
async function runOne(application, profile, attempt = soloAttempt) {
  const started = Date.now();
  let finalResult = null;
  let submissionAttempted = false;
  const formClock=startClock();
  application.formClock=formClock;
  const finish = (status, reason, detail) => (finalResult = {
    id: application.id,
    company: application.company,
    title: application.title,
    applyUrl: application.applyUrl,
    sourceUrl: application.sourceUrl ?? "",
    status,
    reason: reason ?? "",
    detail: { ...(detail || {}), submissionAttempted,compensation: application.compensation || null, timings:{...application.timings,application:elapsedClock(formClock),workflow:application.workflowClock?elapsedClock(application.workflowClock):elapsedClock(formClock)},aiMode:application.aiMode||null },
    at: started,
    took: Date.now() - started,
  });

  // Re-read before filling, so an import or another route discovered since
  // preparation cannot bypass the exclusion list. An imported row naming a
  // posting refuses that posting; one naming only an employer refuses the
  // employer, which is the single company-level refusal left now that the
  // day's budget has replaced the rest. Split the same way as the run's own
  // index, or an import of past applications would bar every employer in it.
  const latest = await allHistory();
  const latestHistory = historyIndex(latest);
  const latestBarred = historyIndex(latest.filter(row=>!historyUrls(row).some(url=>jobIdentityKeys(url).length)));
  if (latestBarred.matchCompany(application.company,...historyUrls(application))) return finish('skipped','This employer is on your never-approach list');
  if (latestHistory.match(...historyUrls(application))) return finish('skipped','Already applied to this posting, or its submission needs review');

  // Anything sent, or possibly sent, gets its folder on disk: the documents
  // that went, the confirmation, and a note of what happened. Written before
  // the tab closes, since the confirmation is photographed off it. A failure
  // to write is logged and does not change what the run records, because
  // the application was sent either way.
  const archived = async (result, confirmedTabId, options) => {
    try {
      const folder = await archive(application, profile, result, confirmedTabId, options);
      result.detail = { ...(result.detail ?? {}), folder };
      log("info", `${application.company} - saved to ${profile.exportFiles?'Downloads/job applied-folder/':'SQLite workspace: '}${folder}`);
    } catch (error) {
      log("warn", `${application.company} - could not write the application folder: ${error?.message ?? error}`);
    }
    return result;
  };

  let tabId;
  let frameId;
  let submitPressed = false;
  let confirmationBefore=[];

  // Written up for the applicant to send by hand: the folder under "manual
  // application/" holds the resume, the letter and every answer worked out
  // for the form, so the form can be redone from it in a minute. The caller
  // puts the link on the day's "other links" table.
  const handoff = async (reason, detail) => {
    const result = finish("manual", reason, { ...(detail ?? {}), handoff: true, filled: application.answers?.length ?? 0 });
    return await archived(result, null, { root: MANUAL_ROOT });
  };

  // An employer claimed in the instant before Submit, given back because
  // the Submit did not take. The module path decides this for itself and
  // releases through the same service (see run-bridge.js); this is the
  // same judgement for the original filler, which claims in the same place
  // and had the same hole - a board that answers Submit with a puzzle, or
  // refuses the filled form outright, left the employer marked as applied
  // to with no application in existence and nothing able to undo it.
  // Never called where Submit may have landed: a page that says nothing is
  // recorded as sent and keeps its claim.
  const releaseClaim = async (why) => {
    try {
      await releaseSubmission(application);
      log("info", `${application.company} - ${why}, so the employer has been released and can be applied to again`);
    } catch (error) {
      log("warn", `${application.company} - ${why}, but the claim could not be given back: ${error?.message ?? error}. This employer will be treated as already applied to.`);
    }
  };

  const context = answerContext(application, profile);

  // The apply module, which is where the ranked adapters, the generic
  // fallback for a careers page nobody wrote one for, and the mailbox wait
  // that does not hold the foreground all live - and which until now only
  // a test harness could reach, so none of it had ever sent an application
  // from an unattended run. Everything below this branch is the path that
  // did, kept whole and one setting away; see src/apply/run-bridge.js.
  if (moduleEngine(profile, application.applyUrl)) {
    let fatal = null;
    try {
      const said = await applyThroughModule({
        application, profile, context, log,
        browser: chromeBrowserOps(),
        services: moduleServices(application, profile, context, attempt, (error) => (fatal = error)),
      });
      // A signed-out writer or an exhausted quota repeats for every job
      // after this one, so it ends the run rather than this attempt. The
      // engine answers for everything it meets, fatal included, which is
      // right for a single pasted URL and wrong for a queue of three
      // hundred - hence the flag, raised where the model is called and
      // acted on here.
      if (fatal) throw fatal;
      if (said.submitted) submissionAttempted = true;
      const result = finish(said.status, said.reason, said.detail);
      if (said.archive) await archived(result, null, { root: said.archive === "manual" ? MANUAL_ROOT : "applied", confirmationUrl: said.confirmationUrl });
      if (said.keepOpen && said.outcome.evidence?.tabId) await keepForReview(said.outcome.evidence.tabId, application, result);
      return result;
    } catch (error) {
      if (fatal || (error instanceof AiError && error.fatal)) throw error;
      return finish("failed", error?.message ?? String(error));
    } finally {
      // The engine's own tab is gone by now unless it was left for a
      // person; either way it is no longer the tab the front should fall
      // back to between other jobs' turns.
      resident(null);
    }
  }

  // Workday is a wizard with an account in front of it, not a form, and
  // has its own driver.
  if (atsOf(application.applyUrl) === "workday") {
    return runWorkday(application, profile, context, { finish, archived, getResult:()=>finalResult,markSubmit:()=>{submissionAttempted=true;},attempt });
  }

  try {
    tabId = await openTab(application.applyUrl, profile.foregroundTabs);
    resident(tabId);
    const loadedAt = Date.now();
    await waitForForm(tabId);
    const formAt = Date.now();

    const attached = await attach(tabId);
    if (!attached) return finish("failed", "no application form was found on the page");

    const { inventory } = attached;
    frameId = attached.frameId;
    log("info", `${application.company} - read ${inventory.fields.length} fields in ${since(started)} (page ${since(started, loadedAt)}, form ${since(loadedAt, formAt)}, read ${since(formAt)})`);

    await ensureApplicationSupport(application,profile,inventory.fields,context);
    const plan = resolveForm(inventory.fields, profile, context);
    if (plan.blocked.some(b=>b.rule === 'salary-research')) return handoff('Compensation research is unavailable or uncited. Review this application manually; no salary fallback was used.');
    const demographicBlock = plan.blocked.find(b=>isDemographicQuestion(b.label));
    if (demographicBlock) return handoff(`A required demographic answer needs profile review: ${demographicBlock.reason}`);

    if(plan.blocked.length){
      await rememberQuestions(application,plan.blocked.map(entry=>({question:entry.label,reason:entry.reason,required:true,options:entry.options??[],type:entry.type??''})));
      return handoff('Required candidate information needs review: '+plan.blocked.map(entry=>entry.reason).join('; '));
    }

    if (plan.questions.length > 0) {
      // A menu that only renders when opened has no options in the
      // inventory, so the model was answering "Degree" blind - "Bachelor of
      // Science in Computer Science" against a list that says "Bachelor's
      // of Science (B.S)" - missing, and being asked again with the list.
      // Read off the page first, and the one answer is the right one.
      for (const question of plan.questions) {
        const field = inventory.fields.find((candidate) => candidate.key === question.key);
        if (!field?.combobox || (question.options ?? []).length > 0) continue;
        const labels = (await inFrame(tabId, frameId, (key) => window.__ghApply.menuOptions(key), [question.key]).catch(() => null)) ?? [];
        if (labels.length > 0) question.options = labels.map((label) => ({ label }));
      }
      log("info", `${application.company} - asking the model ${plan.questions.length} open question(s), in one call`);
      const askedAt = Date.now();
      const before = runTotal();
      const { answers, unanswered, forced } = await answerAll(plan.questions, context, profile);
      const fitted=fittedAnswers(answers,unanswered,plan.questions,inventory.fields);
      const requiredUnknown=unanswered.filter(question=>question.required);
      if(requiredUnknown.length){
        await rememberQuestions(application,requiredUnknown.map(question=>({question:question.question,required:true,options:plan.questions.find(entry=>entry.key===question.key)?.options??[],reason:'no saved fact supports an answer'})));
        return handoff('Required candidate answers are not supported by saved facts: '+requiredUnknown.map(question=>question.question).join('; '));
      }
      log("info", `${application.company} - answered in ${since(askedAt)} (model: ${sinceSpend(before)})`);
      plan.fills.push(...fitted);
      if (forced.length > 0) {
        log("warn", `${application.company} - ${forced.length} required question(s) answered on the model's best judgement`, forced);
      }
      if (unanswered.length > 0) {
        log("info", `${application.company} - ${unanswered.length} optional question(s) left blank`, unanswered);
      }
    }

    const attachments = [];
    for (const attachment of plan.attachments) {
      const blob = attachment.document === "resume" ? application.resume : application.letter;
      if (!blob) {
        const field = inventory.fields.find((entry) => entry.key === attachment.key);
        if (field?.required) return finish("skipped", `the form requires a ${attachment.document} and the folder has none`);
        continue;
      }
      attachments.push({
        key: attachment.key,
        name: attachment.document === "resume" ? application.resumeName : application.letterName,
        type: blob.type || (attachment.document === "resume" ? "application/pdf" : "text/plain"),
        data: await toBase64(blob),
      });
    }

    // What is being typed, question by question, for the folder on disk: a
    // form handed over at a captcha is finished by hand from it.
    application.answers = plan.fills
      .map((fill) => {
        const field = inventory.fields.find((candidate) => candidate.key === fill.key);
        return { question: field?.label ?? fill.key, answer: spoken(field, fill) };
      })
      .filter((entry) => entry.answer !== undefined && entry.answer !== null && String(entry.answer).trim() !== "");

    const fillingAt = Date.now();
    const applied = await inFrame(tabId, frameId, (payload) => window.__ghApply.apply(payload), [
      { fills: plan.fills, attachments },
    ]);
    {
      // Where the seconds went, slowest first: a field that took four
      // seconds was waiting on a menu, and that is a thing to go and look at.
      const slow = (applied?.timings ?? [])
        .filter((timing) => timing.ms >= 1000)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5)
        .map((timing) => `${inventory.fields.find((field) => field.key === timing.key)?.label?.slice(0, 40) ?? timing.key} ${(timing.ms / 1000).toFixed(1)}s`);
      const placed = (applied?.applied ?? []).filter((key) => plan.fills.some((fill) => fill.key === key)).length;
      log("info", `${application.company} - filled ${placed} of ${plan.fills.length} in ${since(fillingAt)}${slow.length > 0 ? `; slow: ${slow.join(", ")}` : ""}`);
    }

    // A second pass over what the first could not place. A profile value that
    // matched nothing on a menu,
    // "Two weeks from offer" against "2 weeks" - is put back to the model
    // with the menu's actual entries, and the model picks from those.
    const unplaced = (applied?.failed ?? [])
      .map((entry) => inventory.fields.find((field) => field.key === entry.key))
      .filter((field) => field && field.key && field.type !== "file");
    if (unplaced.length > 0) {
      log("info", `${application.company} - ${unplaced.length} field(s) took no value; choosing from what each actually offers`, applied.failed);
      const again = await rescue(tabId, frameId, unplaced, context, profile, "__ghApply", application.answers);
      if (again?.failed?.length > 0) log("warn", `${application.company} - ${again.failed.length} field(s) still would not take a value`, again.failed);
    }

    // Read the form back. A value React silently rejected looks exactly like
    // one it accepted until the page is asked what it holds. Anything required
    // and still empty gets the same second pass, and then Submit is pressed
    // either way: a form the board refuses is reported as failed with the
    // board's own complaint, which beats refusing it on the board's behalf.
    let verified = await inFrame(tabId, frameId, () => window.__ghApply.verify());
    if (verified?.empty?.length > 0) {
      // Fields the plan already had an answer for are filled again from the
      // plan - a form that re-rendered after the upload drops typed values,
      // and the first name is not a question for the model. The rest get
      // the second pass.
      const emptyKeys = new Set(verified.empty.map((field) => field.key).filter(Boolean));
      const known = plan.fills.filter((fill) => emptyKeys.has(fill.key));
      if (known.length > 0) {
        await inFrame(tabId, frameId, (payload) => window.__ghApply.apply(payload), [{ fills: known, attachments: [] }]).catch(() => null);
        verified = await inFrame(tabId, frameId, () => window.__ghApply.verify());
      }
      const fields = (verified?.empty ?? []).filter((field) => field.key && !known.some((fill) => fill.key === field.key));
      if (fields.length > 0) {
        log("info", `${application.company} - ${fields.length} required field(s) still empty; answering them`, fields);
        await rescue(tabId, frameId, fields, context, profile, "__ghApply", application.answers);
      }
      verified = await inFrame(tabId, frameId, () => window.__ghApply.verify());
      if (verified?.empty?.length > 0) {
        log("warn", `${application.company} - still empty after a second pass: ${verified.empty.map((field) => field.label).join(", ")}; sending anyway`);
      }
    }

    // Conditional demographic fields can appear after earlier answers (for
    // example race after Hispanic/Latino). Re-read and use profile facts only.
    const demographics = await refreshDemographics(tabId, frameId, context, profile, '__ghApply', application.answers);
    if (demographics.failed.length) log('warn', `${application.company} - demographic answers need review`, demographics.failed);
    const requiredDemographic = demographics.failed.find(field=>field.required);
    if (requiredDemographic) return handoff(`A required demographic answer needs profile review: ${requiredDemographic.label}`);
    verified = await inFrame(tabId, frameId, () => window.__ghApply.verify());

    // Lever is never sent. Its Submit sits behind an hCaptcha that, from a
    // datacenter address, is the picture puzzle only a person can click
    // through, and a tab waiting on a person is no use on a machine nobody
    // is watching. The form was filled all the same, for the answers: they
    // go into the folder with the resume and letter, and the applicant
    // redoes the form from it in a minute.
    if (atsOf(application.applyUrl) === "lever") {
      log("info", `${application.company} - Lever puts a captcha puzzle on Submit; the answers are saved under "manual application/" for you to send by hand`);
      return await handoff("Lever's Submit is behind a captcha puzzle; filled, and saved for you to send by hand", {
        attachments: attachments.length,
        questions: plan.questions.length,
        captcha: true,
      });
    }

    // ApplyToJob puts a reCAPTCHA checkbox ("Human Check") on the form. The
    // box is ticked; when it takes the tick without a picture puzzle the
    // form is sent, and when it does not the form goes the way of Lever's.
    if (atsOf(application.applyUrl) === "applytojob") {
      const check = await tickCaptcha(tabId);
      if (check.present && !check.passed) {
        log("info", `${application.company} - ApplyToJob's "Human Check" wants a picture puzzle; the answers are saved under "manual application/" for you to send by hand`);
        return await handoff("ApplyToJob's Human Check wants a picture puzzle; filled, and saved for you to send by hand", {
          attachments: attachments.length,
          questions: plan.questions.length,
        });
      }
      if (check.present) log("info", `${application.company} - the Human Check took the tick without a puzzle`);
    }

    // The board uploads each attached file in the background and refuses a
    // Submit that arrives first - "Resume/CV is required", with the file
    // sitting right there in the input. A form with few questions reaches
    // this point seconds after attaching, so the uploads are waited for.
    const uploadsDeadline = Date.now() + 60000;
    let uploads = null;
    while (Date.now() < uploadsDeadline) {
      uploads = await inFrame(tabId, frameId, () => window.__ghApply.uploadsSettled()).catch(() => null);
      if (!uploads || uploads.settled) break;
      await wait(500);
    }
    if (uploads && !uploads.settled) return handoff(`Documents are still uploading: ${uploads.pending.join(', ')}. Review before submitting.`);

    confirmationBefore=(await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func:confirmationSnapshot})).flatMap(result=>result.result||[]);
    const claim = await claimSubmission(application);
    if (!claim.claimed) return finish('skipped','Submission blocked: this job is already in your applied history or needs submission review');
    submitPressed = true;
    submissionAttempted = true;
    const submitted = await inFrame(tabId, frameId, () => window.__ghApply.submit());
    if (!submitted?.clicked) {
      await releaseClaim("the submit button could not be clicked");
      return finish("failed", submitted?.reason ?? "the submit button could not be clicked");
    }

    // Pressing Submit is not the same as having applied, and this used to
    // wait four seconds and say "submitted" without looking. Now the page is
    // asked what happened. Three answers are possible, and the asymmetry
    // between them is the point: a form that shows errors was not sent, and
    // may be tried again; a page that confirms was sent; a page that says
    // nothing either way may well have been sent, and so is remembered as
    // sent - pressing Submit twice is the one mistake this must never make.
    const detail = { filled: applied?.applied?.length ?? 0, attachments: attachments.length };
    let outcome = await confirmSubmission(tabId, frameId,20000,confirmationBefore);

    // A fourth answer: the board wants proof the address is real before it
    // takes the application. The code is in the applicant's mail, the mail is
    // open in this same browser, and the form is still on screen waiting.
    if (outcome.verification) {
      const sentTo = outcome.verification.email || profile.email;
      log("info", `${application.company} - the board mailed a security code to ${sentTo}; reading it from Gmail`);
      let code;
      try {
        // Not `atFront`. The slot goes back too, so the next application
        // starts its form while this one waits for eight digits.
        ({ code } = await attempt.waiting("an emailed security code", () => mailbox.verification({
          kind: "email-code",
          email: profile.email,
          company: application.company,
          board: boardOf(application.applyUrl),
        })));
      } catch (error) {
        return await handoff(`no security code arrived: ${error.message}; saved for you to send by hand`, detail);
      }
      usedCodes.add(code);
      detail.securityCode = true;

      const entered = await inFrame(tabId, frameId, (value) => window.__ghApply.enterCode(value), [code]);
      if (!entered?.entered) {
        return await archived(finish("unconfirmed", `a code arrived but could not be typed in: ${entered?.reason ?? "unknown"}`, detail));
      }
      log("info", `${application.company} - code entered, submitting again`);
      await wait(500);
      const again = await inFrame(tabId, frameId, () => window.__ghApply.submit());
      if (!again?.clicked) return finish("failed", again?.reason ?? "the submit button could not be clicked after the code");
      outcome = await confirmSubmission(tabId, frameId,20000,confirmationBefore);
    }

    // The board refused the form over something that was filled - usually a
    // file it had not finished taking. Attached again, filled again where
    // the complaint names a field, and sent once more. One more time, not
    // a loop: a form refused twice over the same thing is being misread.
    if (!outcome.confirmed && outcome.complaints) {
      log("warn", `${application.company} - the board refused the form: ${outcome.complaints}. Attaching and filling again, then resubmitting.`);
      {
        // The whole plan again, not just the files: whatever emptied the
        // upload may have emptied the boxes beside it.
        await inFrame(tabId, frameId, (payload) => window.__ghApply.apply(payload), [{ fills: plan.fills, attachments }]).catch(() => null);
        const retryDeadline = Date.now() + 60000;
        while (Date.now() < retryDeadline) {
          const state = await inFrame(tabId, frameId, () => window.__ghApply.uploadsSettled()).catch(() => null);
          if (!state || state.settled) break;
          await wait(500);
        }
      }
      const stillEmpty = await inFrame(tabId, frameId, () => window.__ghApply.verify()).catch(() => null);
      if (stillEmpty?.empty?.length > 0) await rescue(tabId, frameId, stillEmpty.empty.filter((field) => field.key), context, profile, "__ghApply", application.answers).catch(() => null);
      const again = await inFrame(tabId, frameId, () => window.__ghApply.submit());
      if (again?.clicked) outcome = await confirmSubmission(tabId, frameId,20000,confirmationBefore);
    }

    if (outcome.confirmed) {
      return await archived(finish("submitted", "", { ...detail, boardSaid: outcome.quote ?? "" }), tabId);
    }

    // A fifth answer: a captcha puzzle after Submit, which only a person can
    // click through. Lever, the one board that puts one up, is never sent
    // (see above), so this is a board that does not usually ask; the form
    // was not sent, and goes to the applicant with its answers.
    if (outcome.captcha) {
      await releaseClaim("the board put up a captcha puzzle after Submit and nothing was sent");
      return await handoff("the board put up a captcha puzzle after Submit; saved for you to send by hand", { ...detail, captcha: true });
    }

    if (outcome.complaints) {
      await releaseClaim("the board refused the filled form");
      return finish("failed", `the form rejected the submission: ${outcome.complaints}`, { ...detail, outcome });
    }
    return await archived(
      finish("unconfirmed", "pressed Submit, but no confirmation appeared; treated as sent", {
        ...detail,
        outcome,
      }),
    );
  } catch (error) {
    if (error instanceof AiError && error.fatal) throw error;

    // "Frame with ID 0 was removed": the page went away under a script.
    // Before Submit was pressed that is a page that re-rendered or reloaded
    // mid-fill, and nothing was sent - the job is worth one more try in a
    // fresh tab. After Submit it is more likely the form navigating to its
    // confirmation, which means the application went, and a job recorded as
    // failed would be sent again next week. So the tab is asked first.
    if (tabId && /frame .*removed|frame .*not found|cannot access|context invalidated/i.test(error?.message ?? "")) {
      if (!submitPressed) return finish("failed", `the page changed while it was being filled (${error.message})`, { retry: true });
      await wait(1500);
      const outcome = await confirmSubmission(tabId, frameId ?? 0, 8000,confirmationBefore).catch(() => null);
      if (outcome?.confirmed) {
        return await archived(finish("submitted", "", { boardSaid: outcome.quote ?? "", afterError: error.message }), tabId);
      }
      return await archived(finish("unconfirmed", `the page changed after Submit (${error.message}); treated as possibly sent`));
    }
    return finish("failed", error?.message ?? String(error));
  } finally {
    resident(null);
    // Closed however it ended. Sent, failed or handed over, the record is on
    // disk and a tab left open on a machine nobody is watching is only a tab
    // left open - except where a person still has something to do on it.
    if (tabId) await finishTab(tabId, application, finalResult, keptForPerson(profile, finalResult));
  }
}

/**
 * The run's own sub-agents, handed to the apply module.
 *
 * Every one of these already exists and already works; the module is given
 * them rather than allowed to load its own, which is the rule that keeps
 * one answer to "have we applied to this company" and one mailbox reader
 * instead of two. `src/apply/standalone.js` loads defaults for a pasted
 * URL with no run in progress, and that is exactly the case this is not.
 *
 * The verification wrapper is the one that earns its place. Reading a code
 * out of Gmail takes minutes, and a minute spent holding a slot is a minute
 * the next application does not start - so the wait goes through
 * `attempt.waiting`, which hands the slot back and queues for it again
 * afterwards. The `board` is added because the mail is addressed about the
 * board's own name for the employer ("mercury"), which is routinely not the
 * name on the resume, and without it a code sitting in the mailbox matches
 * nothing.
 */
function moduleServices(application, profile, context, attempt, onFatal) {
  return {
    answers: async (questions, where, who) => {
      const before = runTotal();
      const askedAt = Date.now();
      try {
        const given = await answerAll(questions, where, who);
        log("info", `${application.company} - answered in ${since(askedAt)} (model: ${sinceSpend(before)})`);
        return given;
      } catch (error) {
        if (error instanceof AiError && error.fatal) onFatal(error);
        throw error;
      }
    },
    // The letter or the cited pay research this particular form turned out
    // to want. A failure here is logged and nothing else: the plan is about
    // to refuse the uncited salary or the missing letter on its own, with a
    // reason that names the field rather than the request that failed.
    documents: async ({ fields }) => {
      try {
        await ensureApplicationSupport(application, profile, fields, context);
      } catch (error) {
        log("warn", `${application.company} - the form asked for something that could not be prepared: ${error?.message ?? error}`);
      }
    },
    // See rememberQuestions. The engine parks on the same two causes the
    // direct path parks on - a blocked field, and a required question no
    // stored fact reaches - and without this hook its parked applications
    // were the only ones whose questions were never written down, so they
    // were the only ones that could never be resumed.
    remember: (entries) => rememberQuestions(application, entries),
    claimCompany: (request) => claimSubmission(request),
    // The claim's other half. Supplied here for the same reason as the
    // claim itself: there is one answer to "have we applied to this
    // company", and the module must give an employer back through the same
    // table it was taken from rather than keeping its own idea of who is
    // spent. When this is missing the bridge keeps the claim, which is the
    // safe way to be wrong - an employer nobody can apply to again costs
    // one employer, and a duplicate application costs the candidate.
    releaseCompany: (request) => releaseSubmission(request),
    verification: (need) => attempt.waiting(
      need?.kind === "workday-account" ? "an account activation mail" : "an emailed security code",
      () => mailbox.verification({ ...need, email: need?.email || profile.email, board: boardOf(application.applyUrl) }),
    ),
    evidence: ({ outcome, picture }) => keepLastPage(application, profile, outcome, picture),
  };
}

/**
 * The last picture of the page, in the folder this outcome will be filed
 * under.
 *
 * The engine photographs the page inside the attempt, before the run has
 * written anything, so the folder has to be worked out from the outcome
 * rather than read off a result that does not exist yet. Worked out exactly
 * the way finishApplicationTab works it out, because the resume, the letter
 * and the answers land in the same folder a moment later and two different
 * answers to "which folder is this" would separate a receipt from the
 * documents that earned it.
 */
async function keepLastPage(application, profile, outcome, picture) {
  const root = [OUTCOMES.CONFIRMED, OUTCOMES.UNCERTAIN].includes(outcome.status) ? "applied" : MANUAL_ROOT;
  const folder = applicationFolder(application, root);
  // Five sixths of what an application costs on disk is this one PNG, so
  // it is the first thing dropped when there is no room left. The folder
  // is still named: the resume, the answers and the receipt go into it a
  // moment later, and they are what the applicant needs to prove the
  // application happened.
  if (!health.screenshots) return { folder };
  const path = `${folder}/Last page.png`;
  await save(path, picture.content, { type: "image/png", overwrite: true });
  return { path, folder };
}

/**
 * Forms left open to be looked at, oldest closed first once there are more
 * than a handful. A run that goes on for days would otherwise leave a
 * window full of them on a machine nobody is watching.
 */
const KEPT_TABS = 5;
const keptTabs = [];
async function keepForReview(tabId, application, result) {
  keptTabs.push({ tabId, application, result });
  // A captcha tab never gives up its place. It holds a filled application
  // that is one human click from being sent, so evicting it to make room
  // discards the work rather than tidying up - and unlike a review tab,
  // which only exists to be glanced at, it cannot be recreated from the
  // folder. Only review tabs are closed to stay under the cap.
  const puzzle = (entry) => Boolean(entry.result?.detail?.captcha);
  // Said out loud to the tab ledger as well as held in this list, because
  // this list does not survive the service worker and the tab does. An
  // unmarked captcha tab would read to the next generation's reaper as a
  // form tab somebody walked away from.
  await hold(tabId, puzzle({ result }) ? 'captcha' : 'review');
  while (keptTabs.filter((entry) => !puzzle(entry)).length > KEPT_TABS) {
    const [old] = keptTabs.splice(keptTabs.findIndex((entry) => !puzzle(entry)), 1);
    const latest = (await allResults()).find(row => row.id === old.result?.id) || old.result;
    const end = await finishApplicationTab({ ...old, result: latest });
    if (end.error) log('warn', `${old.application.company} - final screenshot needs attention; tab kept open: ${end.error}`);
    else await disown(old.tabId);
    if (latest) await recordResult(latest);
  }
  const waiting = keptTabs.filter(puzzle).length;
  if (waiting >= KEPT_TABS) log('warn', `${waiting} captcha tab(s) are open waiting for a person; each one holds a filled application that cannot be sent without you`);
}
/**
 * Whether the person needs the page itself, not just the folder.
 *
 * A captcha earns it only when `keepCaptchaTabs` says somebody is there to
 * use it: the answers are typed and the form is one human click from being
 * sent, but that click can only be made on the page the puzzle appeared
 * on, and nobody makes it overnight. Either way the typed answers reach
 * the manual-application folder, so what closing costs is the live form
 * rather than the work.
 */
const keptForPerson = (profile, result) => Boolean(result?.detail?.captcha && profile.keepCaptchaTabs);

async function finishTab(tabId, application, result, keepOpen) {
  const captureClock=startClock();
  const captured = await finishApplicationTab({tabId,application,result,keepOpen,keepPicture:health.screenshots});
  if(result){result.completedAt=Date.now();result.took=application.formClock?elapsedClock(application.formClock):Math.max(0,result.completedAt-result.at);result.detail.timings={...result.detail.timings,screenshot:elapsedClock(captureClock),workflow:application.workflowClock?elapsedClock(application.workflowClock):result.took,application:result.took};}
  if (captured.error) log('warn', `${application.company} - final screenshot needs attention; tab kept open: ${captured.error}`);
  else log('info', `${application.company} - final screenshot saved before ${keepOpen ? 'review' : 'closing the tab'}`);
  if (keepOpen) await keepForReview(tabId, application, result);
}

/* ------------------------------------------------------------- Workday */


/**
 * A Workday application, start to finish.
 *
 * Workday is a wizard behind an account. The pages come in a fixed order -
 * Create Account or Sign In, Autofill with Resume, My Information, My
 * Experience, Application Questions, Voluntary Disclosures, sometimes Self
 * Identify, Review - and each is saved on its own "Save and Continue", so
 * this is a loop: read which page is showing, deal with it, press on, and
 * read again. The account is created with the one password in the profile
 * the first time a career site is seen and signed into after; a site that
 * wants the address confirmed first gets its activation link read out of
 * Gmail and opened. The form is entered by "Apply Manually", not "Autofill
 * with Resume": the parser invents jobs and misreads companies, so the
 * career is written from the resume's own jobs instead, into panels added
 * one by one.
 *
 * Two things stop it short of Submit on purpose: a dry run, which leaves
 * the review page open; and a required upload of something that is not
 * the resume - a government ID, a certificate - which is handed over to be
 * finished by hand, documents saved under "manual application/".
 */
// The attempt default is spelled out rather than shared with runOne's
// `soloAttempt`: this function is lifted out of the file and run in a
// sandbox by the Workday receipt fixtures, where a free variable from the
// module around it is simply not there.
async function runWorkday(application, profile, context, { finish, archived, getResult,markSubmit=()=>{},attempt={note(){},waiting:(what,work)=>work()} }) {
  const password = profile.workdayPassword;
  if (!password) return finish('skipped', 'Add a Workday account password in Settings > Connections.');
  if (!profile.street) return finish('skipped', 'Add a street address in your profile for Workday.');
  const email = profile.email;
  const host = hostOf(application.applyUrl);
  const stored = await stateStorage.get("workdayAccounts");
  const accounts = stored.workdayAccounts ?? {};
  const label = application.company;

  let tabId;
  let submitPressed = false;
  let confirmationBefore = [];
  const answers = [];
  application.answers = answers;

  const resumeAttachment = application.resume
    ? { name: application.resumeName || "resume.pdf", type: "application/pdf", data: await toBase64(application.resume) }
    : null;
  let letterAttachment = application.letter
    ? { name: application.letterName || "cover-letter.pdf", type: application.letter.type || "application/pdf", data: await toBase64(application.letter) }
    : null;

  const page = (func, args = []) =>
    chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args }).then((results) => results[0]?.result);
  const api = async (method, ...args) => {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["src/workday.js"] }).catch(() => {});
    return page((name, params) => (window.__wdApply ? window.__wdApply[name](...params) : null), [method, args]);
  };

  /** The page once it has stopped loading and settled on being one thing. */
  const settled = async (timeoutMs = 40000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let signature = "";
    let since = 0;
    while (Date.now() < deadline) {
      const now = await api("state").catch(() => null);
      last = now ?? last;
      // Workday's own error page is as settled as it will get.
      if (now?.broken) return now;
      // A page is settled once what it shows - which page, how many fields,
      // what its menus say - has held still for a couple of seconds. Workday draws a
      // page's fields a few at a time, and fills its menus a fetch later.
      const current = now && !now.loading && now.kind !== "unknown" ? `${now.kind}|${now.step}|${now.drawn}|${now.menus}` : "";
      if (current && current === signature) {
        if (Date.now() - since >= 2500) return now;
      } else {
        signature = current;
        since = Date.now();
      }
      await wait(300);
    }
    return last;
  };

  /** Presses Continue and waits for the wizard to move on - or to complain. */
  const advance = async (from) => {
    const pressed = await api("next");
    if (!pressed?.clicked) return { moved: false, reason: pressed?.reason ?? "no Continue button" };
    const deadline = Date.now() + 45000;
    let state = null;
    while (Date.now() < deadline) {
      await wait(500);
      state = await api("state").catch(() => null);
      if (!state || state.loading) continue;
      if (state.kind === "done") return { moved: true, state };
      if (state.errors?.heading || state.errors?.alerts?.length > 0) {
        // A complaint has to hold for a moment; the old one lingers while
        // the save is in flight.
        await wait(1200);
        const again = await api("state").catch(() => null);
        if (again && (again.errors?.heading || again.errors?.alerts?.length > 0) && `${again.kind}|${again.step}` === from) return { moved: false, state: again, complaint: [again.errors.heading, ...again.errors.alerts].filter(Boolean).join("; ") };
        if (again && `${again.kind}|${again.step}` !== from) return { moved: true, state: again };
        continue;
      }
      // The progress bar redraws a moment before the new page's fields; the
      // same kind with no step named yet is the old page, still leaving.
      const leaving = (state.step === "" && from.startsWith(`${state.kind}|`)) || (state.kind === "form" && from.endsWith(`|${state.step}`));
      if (`${state.kind}|${state.step}` !== from && !leaving) {
        await wait(350);
        return { moved: true, state: await settled(15000) };
      }
    }
    return { moved: false, state, reason: "the page did not move on in 45 seconds" };
  };

  /**
   * One page of plain questions: read, answer from the profile and the
   * model, write, read back, and press on. The same machinery the other
   * boards use, pointed at Workday's widgets.
   */
  const fillPage = async (state, { structured = true } = {}) => {
    const inventory = await api("inventory", { skipStructured: structured });
    const fields = (inventory?.fields ?? []).filter((field) => !(field.type === "file" && field.current));

    const wanted = await api("idRequested").catch(() => null);
    if (wanted?.uploads?.length > 0) return { handoff: `this application requires an upload of "${wanted.uploads[0]}", which is not the resume or the cover letter` };

    await ensureApplicationSupport(application,profile,fields,context);
    if(application.letter&&!letterAttachment)letterAttachment={name:application.letterName||'cover-letter.pdf',type:'application/pdf',data:await toBase64(application.letter)};
    const plan = resolveForm(fields, profile, context);
    if (plan.blocked.some(b=>b.rule === 'salary-research')) return {handoff:'Compensation research is unavailable or uncited; no salary fallback was used.'};
    const demographicBlock = plan.blocked.find(b=>isDemographicQuestion(b.label));
    if (demographicBlock) return {handoff:`A required demographic answer needs profile review: ${demographicBlock.reason}`};
    if(plan.blocked.length){
      await rememberQuestions(application,plan.blocked.map(entry=>({question:entry.label,reason:entry.reason,required:true,options:entry.options??[],type:entry.type??''})));
      return {handoff:'Required candidate information needs review: '+plan.blocked.map(entry=>entry.reason).join('; ')};
    }

    if (plan.questions.length > 0) {
      for (const question of plan.questions) {
        const field = fields.find((candidate) => candidate.key === question.key);
        if (!field?.combobox || (question.options ?? []).length > 0) continue;
        const labels = (await api("menuOptions", question.key).catch(() => null)) ?? [];
        if (labels.length > 0) question.options = labels.map((text) => ({ label: text }));
      }
      const askedAt = Date.now();
      const before = runTotal();
      const { answers: modelAnswers, forced,unanswered } = await answerAll(plan.questions, context, profile);
      const fitted=fittedAnswers(modelAnswers,unanswered,plan.questions,fields);
      const requiredUnknown=unanswered.filter(question=>question.required);
      if(requiredUnknown.length){
        await rememberQuestions(application,requiredUnknown.map(question=>({question:question.question,required:true,options:plan.questions.find(entry=>entry.key===question.key)?.options??[],reason:'no saved fact supports an answer'})));
        return {handoff:'Required candidate answers are not supported by saved facts: '+requiredUnknown.map(question=>question.question).join('; ')};
      }
      log("info", `${label} - ${state.step || state.kind}: answered ${plan.questions.length} open question(s) in ${since(askedAt)} (model: ${sinceSpend(before)})`);
      plan.fills.push(...fitted);
      if (forced.length > 0) log("warn", `${label} - ${forced.length} required question(s) answered on the model's best judgement`, forced);
    }

    const attachments = [];
    for (const attachment of plan.attachments) {
      const file = attachment.document === "resume" ? resumeAttachment : letterAttachment;
      if (file) attachments.push({ key: attachment.key, ...file });
    }

    const applied = await api("apply", { fills: plan.fills, attachments });
    const landed = new Set(applied?.applied ?? []);
    for (const fill of plan.fills) {
      if (!landed.has(fill.key)) continue;
      const question = fields.find((field) => field.key === fill.key)?.label ?? fill.key;
      const answer = applied?.values?.[fill.key]??spoken(fields.find((field) => field.key === fill.key), fill);
      if (answer !== undefined && answer !== null && String(answer).trim() !== "") answers.push({ question, answer });
    }
    log("info", `${label} - ${state.step || state.kind}: ${applied?.applied?.length ?? 0} of ${plan.fills.length + attachments.length} placed`);

    const unplaced = (applied?.failed ?? []).map((entry) => fields.find((field) => field.key === entry.key)).filter((field) => field && field.type !== "file");
    if (unplaced.length > 0) {
      log("info", `${label} - ${unplaced.length} field(s) took no value; choosing from what each offers`, applied.failed);
      await rescue(tabId, 0, unplaced, context, profile, "__wdApply").catch(() => null);
    }

    // Fields that appeared because of an answer - the city and postal code
    // once a country is chosen - get the same treatment, once.
    await wait(600);
    const before = new Set(fields.map((field) => field.name));
    const later = ((await api("inventory", { skipStructured: structured }).catch(() => null))?.fields ?? []).filter((field) => !before.has(field.name) && field.type !== "file");
    if (later.length > 0) {
      await ensureApplicationSupport(application,profile,later,context);
      const more = resolveForm(later, profile, context);
      if (more.questions.length > 0) {
        const { answers: modelAnswers } = await answerAll(more.questions, context, profile);
        more.fills.push(...fittedAnswers(modelAnswers,[],more.questions,later));
      }
      if (more.fills.length > 0) {
        const placed = await api("apply", { fills: more.fills, attachments: [] });
        const landedLater = new Set(placed?.applied ?? []);
        for (const fill of more.fills) {
          if (!landedLater.has(fill.key)) continue;
          const field = later.find((candidate) => candidate.key === fill.key);
          const answer = spoken(field, fill);
          if (answer !== undefined && answer !== null && String(answer).trim() !== "") answers.push({ question: field?.label ?? fill.key, answer });
        }
        log("info", `${label} - ${state.step || state.kind}: ${placed?.applied?.length ?? 0} of ${more.fills.length} late field(s) placed`);
      }
    }

    if([...fields,...later].some(field=>isDemographicQuestion(field.label))){
      const demographics=await refreshDemographics(tabId,0,context,profile,'__wdApply',answers);
      const failed=demographics.failed.find(field=>field.required);
      if(failed)return {handoff:`A required demographic answer needs profile review: ${failed.label}`};
    }
    let verified = await api("verify").catch(() => null);
    if (verified?.empty?.length > 0) {
      const empty = verified.empty.filter((field) => field.key && field.kind !== "file");
      if (empty.length > 0) {
        log("info", `${label} - ${empty.length} required field(s) still empty; answering them`, empty);
        await rescue(tabId, 0, empty, context, profile, "__wdApply").catch(() => null);
      }
      verified = await api("verify").catch(() => null);
      const demographicEmpty = verified?.empty?.find(field=>isDemographicQuestion(field.label));
      if (demographicEmpty) return {handoff:`A required demographic answer needs profile review: ${demographicEmpty.label}`};
      if (verified?.empty?.length > 0) {
        const taken = await api("fillAnyRequired").catch(() => []);
        if (taken?.length > 0) log("warn", `${label} - required with nothing to say, given the first thing offered: ${taken.join(", ")}`);
      }
    }
    return { filled: applied?.applied?.length ?? 0 };
  };

  /** Reads the activation mail and opens its link in this tab. */
  const activate = async () => {
    log("info", `${label} - the career site mailed an account verification; reading it from Gmail`);
    // Registered, not held: Workday's activation mail is the slowest wait
    // in the bot, and the tenant it belongs to is the only job it blocks.
    const mail = await attempt.waiting("an account activation mail", () => mailbox.verification({ kind: "workday-account", email, host }));
    if (mail.link) {
      await chrome.tabs.update(tabId, { url: mail.link });
      await wait(4000);
      return true;
    }
    return false;
  };

  const rememberAccount = async () => {
    if (accounts[host]?.verified) return;
    accounts[host] = { email, verified: true, at: new Date().toISOString() };
    await stateStorage.set({ workdayAccounts: accounts });
  };

  const started = Date.now();
  try {
    // In by the "Apply Manually" door, never "Autofill with Resume": the
    // parser's guesses at the career are not worth correcting when every
    // field is written from the profile and the resume regardless.
    tabId = await openTab(workdayApplyUrl(application.applyUrl), profile.foregroundTabs);
    resident(tabId);

    const seen = { create: 0, signin: 0, activation: 0, unknown: 0, pages: new Map() };
    const deadline = Date.now() + 20 * 60 * 1000;
    let lastKind = "";

    while (Date.now() < deadline) {
      const state = await settled();
      if (!state) return finish("failed", "the Workday page could not be read");
      const pageKey = `${state.kind}|${state.step}`;
      if (state.kind !== lastKind) log("info", `${label} - Workday: ${state.step || state.kind}${state.alert ? ` ("${state.alert}")` : ""}`);
      lastKind = state.kind;

      // Workday's "Something went wrong - please refresh the page": done as
      // told, a few times, before it counts as a failure.
      if (state.broken) {
        seen.reloads = (seen.reloads ?? 0) + 1;
        if (seen.reloads > 3) {
          return finish("failed", `Workday kept answering "Something went wrong" on the "${state.step || state.kind}" page`);
        }
        log("warn", `${label} - Workday says "Something went wrong, please refresh"; reloading (${seen.reloads} of 3)`);
        await chrome.tabs.reload(tabId);
        await wait(4000);
        continue;
      }

      // Loop guard: the same page five times over is a page this cannot get past.
      seen.pages.set(pageKey, (seen.pages.get(pageKey) ?? 0) + 1);
      if (seen.pages.get(pageKey) > 5) {
        return finish("failed", `stuck on the "${state.step || state.kind}" page${state.errors?.heading ? `: ${state.errors.heading}` : ""}`);
      }

      switch (state.kind) {
        case "posting":
        case "choose": {
          await api("startApplication");
          await wait(2500);
          break;
        }

        case "chooseSignIn": {
          // Google, LinkedIn or email: email, which has a form behind it -
          // and on a site never seen before, the create-account one.
          await api("withEmail", !accounts[host]?.verified && seen.create === 0);
          await wait(1500);
          break;
        }

        case "create": {
          const complaint = [state.errors?.heading, ...(state.errors?.alerts ?? []), state.alert].filter(Boolean).join("; ");
          if (/already|exist|in use|registered|taken/i.test(complaint) || accounts[host]?.verified || seen.create >= 1) {
            await api("toSignIn");
            await wait(1500);
            break;
          }
          seen.create += 1;
          log("info", `${label} - creating a candidate account on ${host} as ${email}`);
          await api("createAccount", email, password);
          await wait(4000);
          break;
        }

        case "signin": {
          const complaint = [state.errors?.heading, ...(state.errors?.alerts ?? []), state.alert].filter(Boolean).join("; ");
          if (/verify your account|has been sent|not (?:yet )?(?:been )?verified|verification (?:e-?mail|required)|check your (?:e-?mail|inbox)/i.test(complaint) && seen.activation < 2) {
            seen.activation += 1;
            try {
              if (await activate()) break;
            } catch (error) {
              return finish("failed", `the career site wants the address verified: ${error.message}`);
            }
          }
          if (seen.create === 0 && !accounts[host] && (seen.signin === 0 || /invalid|incorrect|wrong|does not match|unable to sign|not recognized|no account|locked/i.test(complaint))) {
            // Never seen this site: there is no account to sign into yet,
            // so make one first. (Some tenants open on Sign In rather than
            // Create Account.) If one turns out to exist, Create Account
            // says so and the flow comes back here.
            if (await api("toCreateAccount")) {
              await wait(1500);
              break;
            }
          }
          if (seen.signin >= 3) {
            return finish("failed", `could not sign in to ${host}${complaint ? ` (${complaint})` : ""}`);
          }
          seen.signin += 1;
          await api("signIn", email, password);
          await wait(4000);
          break;
        }

        case "autofill": {
          // Only reached when a saved redirect brings an existing account
          // in by the other door. The page is passed without a file: the
          // resume is attached under My Experience, and nothing is parsed.
          await rememberAccount();
          const moved = await advance(pageKey);
          if (!moved.moved && moved.complaint) log("warn", `${label} - autofill page complained: ${moved.complaint}`);
          break;
        }

        case "experience": {
          await rememberAccount();
          const resumeData = application.resumeData ?? {};
          const report = await api("fillExperience", {
            experience: resumeData.experience ?? [],
            education: resumeData.education ?? application.education ?? educationFrom(profile),
            resume: resumeAttachment,
          });
          log("info", `${label} - My Experience: ${report?.jobs ?? 0} job(s) written from the resume${report?.education ? ", education set" : ""}${report?.resume?.ok ? ", resume attached" : ""}`, report?.notes?.length > 0 ? report.notes : undefined);
          const filled = await fillPage(state, { structured: true });
          if (filled.handoff) return await handoff(filled.handoff);
          const moved = await advance(pageKey);
          if (!moved.moved) {
            if (moved.complaint) {
              const fixed = await retryAfterComplaint(moved.complaint, pageKey);
              if (!fixed) return await stopOn(state, moved.complaint);
            } else return await stopOn(state, moved.reason);
          }
          break;
        }

        case "myinfo":
        case "questions":
        case "disclosures":
        case "selfid":
        case "form": {
          await rememberAccount();
          const filled = await fillPage(state);
          if (filled.handoff) return await handoff(filled.handoff);
          const moved = await advance(pageKey);
          if (!moved.moved) {
            if (moved.complaint) {
              const fixed = await retryAfterComplaint(moved.complaint, pageKey);
              if (!fixed) return await stopOn(state, moved.complaint);
            } else return await stopOn(state, moved.reason);
          }
          break;
        }

        case "review": {
          await rememberAccount();
          const [baseline]=await chrome.scripting.executeScript({target:{tabId},func:confirmationSnapshot});
          confirmationBefore=baseline?.result||[];
          const claim = await claimSubmission(application);
          if (!claim.claimed) return finish('skipped','Submission blocked: this job is already in your applied history or needs submission review');
          submitPressed = true;
          markSubmit();
          log("info", `${label} - every page saved; pressing Submit`);
          const moved = await advance(pageKey);
          const after = moved.state ?? (await settled(10000));
          if (confirmedWizardReceipt(after,confirmationBefore)) {
            return await archived(finish("submitted", "", { filled: answers.length, attachments: resumeAttachment ? 1 : 0, boardSaid: after?.quote ?? "" }), tabId);
          }
          if (moved.complaint) {
            return finish("failed", `Workday refused the submission: ${moved.complaint}`);
          }
          return await archived(finish("unconfirmed", "pressed Submit, but no confirmation appeared; treated as sent", { filled: answers.length }), tabId);
        }

        case "done": {
          if(!submitPressed){
            const claim=await claimSubmission(application);
            if(!claim.claimed)return finish('skipped','Workday already shows a completed application at a protected company.');
            return await archived(finish('unconfirmed','Workday showed completion before this run pressed Submit; treated as an existing application needing review.',{boardSaid:state.quote||'',alreadyCompleted:true}),tabId);
          }
          if(confirmedWizardReceipt(state,confirmationBefore))return await archived(finish("submitted", "", { filled: answers.length, attachments: resumeAttachment ? 1 : 0, boardSaid: state.quote ?? "" }), tabId);
          return await archived(finish('unconfirmed','Workday did not show a new submission receipt; the company remains protected.'),tabId);
        }

        default: {
          seen.unknown += 1;
          if (seen.unknown > 12) {
            return finish("failed", `an unrecognised Workday page at ${state.url}`);
          }
          await wait(2000);
        }
      }
    }
    return finish("failed", "the Workday application did not finish within 20 minutes");
  } catch (error) {
    if (error instanceof AiError && error.fatal) throw error;
    if (submitPressed) {
      const after = await api("state").catch(() => null);
      if (confirmedWizardReceipt(after,confirmationBefore)) return await archived(finish("submitted", "", { boardSaid: after.quote ?? "", afterError: error.message }), tabId);
      return await archived(finish("unconfirmed", `the page changed after Submit (${error.message}); treated as possibly sent`), tabId);
    }
    if (/frame .*removed|frame .*not found|cannot access|context invalidated/i.test(error?.message ?? "")) {
      return finish("failed", `the page changed while it was being filled (${error.message})`, { retry: true });
    }
    return finish("failed", error?.message ?? String(error));
  } finally {
    resident(null);
    // Closed however it ended. Sent, failed or handed over, the record is on
    // disk and a tab left open on a machine nobody is watching is only a tab
    // left open - except where a person still has something to do on it.
    if (tabId) await finishTab(tabId, application, getResult(), keptForPerson(profile, getResult()));
  }

  /** The page refused the save: fill what it names and try the save once more. */
  async function retryAfterComplaint(complaint, pageKey) {
    log("warn", `${label} - Workday would not save the page: ${complaint}. Filling what it names and saving again.`);
    const inventory = await api("inventory", { skipStructured: true });
    const invalid = new Set((await api("errors").catch(() => null))?.invalid ?? []);
    const named = (inventory?.fields ?? []).filter((field) => invalid.has(field.id) || complaint.toLowerCase().includes(String(field.label).toLowerCase().slice(0, 30)));
    const empty = (await api("verify").catch(() => null))?.empty ?? [];
    const targets = [...named, ...empty.filter((field) => !named.some((other) => other.key === field.key))].filter((field) => field.kind !== "file" && field.type !== "file");
    if (targets.length > 0) await rescue(tabId, 0, targets, context, profile, "__wdApply").catch(() => null);
    await api("fillAnyRequired").catch(() => null);
    const again = await advance(pageKey);
    return again.moved;
  }

  async function stopOn(state, reason) {
    return finish("failed", `Workday would not save the "${state.step || state.kind}" page: ${reason}`);
  }

  /** A page wants a document this bot does not have: left for the applicant, documents saved. */
  async function handoff(reason) {
    log("warn", `${label} - ${reason}; saved under "manual application/" for you to finish by hand`);
    const result = finish("manual", reason, { handoff: true, filled: answers.length });
    try {
      const folder = await archive(application, profile, result, null, { root: MANUAL_ROOT });
      result.detail.folder = folder;
    } catch (error) {
      log("warn", `${label} - could not write the manual application folder: ${error?.message ?? error}`);
    }
    return result;
  }
}

/**
 * Fills fields the first pass could not, by asking the model to choose from
 * what each control actually offers.
 *
 * The menu is read off the page for each one - react-select renders its
 * options only when opened, so the inventory saw none - and the model is
 * told it must answer. Capped, because a form with forty unplaceable fields
 * is a form being misread, not a form forty model calls will fix.
 */
/**
 * Model answers split into the ones their controls can honestly hold and
 * the ones they cannot, with the misfits appended to `unanswered` so a
 * required one still stops the application instead of being typed.
 *
 * A paragraph box answered "Yes" is the case this exists for. It reads to
 * a recruiter as nobody being home, it cannot be taken back, and it went
 * out on a real application before this was here.
 */
function fittedAnswers(answers, unanswered, questions, fields) {
  const kept = [];
  for (const answer of answers) {
    const field = fields.find(entry => entry.key === answer.key) ?? {};
    if (answerFitsControl(field, answer.value)) { kept.push(answer); continue; }
    const question = questions.find(entry => entry.key === answer.key);
    unanswered.push({ key: answer.key, question: question?.question ?? field.label ?? answer.key, required: Boolean(question?.required) });
  }
  return kept;
}

async function rescue(tabId, frameId, fields, context, profile, api = "__ghApply", record = null) {
  const fills = [];
  const asks = [];
  const failed = [];
  for (const field of fields.slice(0, 15)) {
    const labels = (await inFrame(tabId, frameId, (key, name) => window[name].menuOptions(key), [field.key, api]).catch(() => null)) ?? [];
    const label = field.label || field.name || field.id || "This field";
    // A field the profile answers (a LinkedIn address, a phone number) is
    // answered from the profile; the model has no business inventing one.
    const ruled = resolveField({ ...field, label, options: labels.length > 0 ? labels.map((entry) => ({ label: entry, value: entry })) : field.options ?? [] }, profile, context);
    if (ruled.outcome === "fill" && ruled.rule) {
      fills.push({ key: field.key, value: ruled.value, candidates: ruled.candidates ?? [ruled.value], rule: ruled.rule, ...(ruled.replace ? {replace:true} : {}) });
      continue;
    }
    if(ruled.outcome==='blocked'){failed.push({key:field.key,reason:ruled.reason});continue;}
    if (isDemographicQuestion(label)) {
      failed.push({key:field.key,reason:ruled.reason || 'No offered option matches the saved demographic answer; update the profile or review this field manually.'});
      continue;
    }
    if (isCompensationQuestion(label) && !hasCompensationResearch(context.compensation)) throw new Error('This pay field needs cited compensation research; no fallback is allowed.');
    const local = isCompensationQuestion(label) ? null : menuShapeAnswer(label, labels, profile);
    if (local) {
      fills.push({ key: field.key, value: local, candidates: [local], rule: "menu-shape" });
      continue;
    }
    asks.push({ key: field.key, question: label, options: labels.map((entry) => ({ label: entry })), required: true, must: true, multiline: wantsProse({ ...field, label }) });
  }
  if (asks.length > 0) {
    const { answers } = await answerAll(asks, context, profile);
    for (const answer of answers) {
      const field = fields.find((entry) => entry.key === answer.key);
      if (!answerFitsControl({ ...field, label: field?.label || field?.name || "" }, answer.value)) continue;
      fills.push({ key: answer.key, value: answer.value, candidates: [answer.value], rule: "ai-rescue" });
    }
  }
  if (fills.length === 0) return { applied: [], failed };
  // Into the folder's Answers.txt with the rest, so a form redone by hand
  // has these answers too.
  if (record) {
    for (const fill of fills) {
      const question = fields.find((field) => field.key === fill.key)?.label || fill.key;
      record.push({ question, answer: fill.value });
    }
  }
  const applied = await inFrame(tabId, frameId, (payload, name) => window[name].apply(payload), [{ fills, attachments: [] }, api]);
  return {...applied,failed:[...failed,...(applied?.failed ?? [])]};
}

/** Reconcile conditional and existing demographic controls without asking AI. */
async function refreshDemographics(tabId, frameId, context, profile, api = '__ghApply', record = null) {
  const inventory = await inFrame(tabId,frameId,name=>window[name].inventory(),[api]);
  const fields = inventory.fields.filter(field=>isDemographicQuestion(field.label));
  const plan = resolveForm(fields,profile,context);
  const result = await inFrame(tabId,frameId,(payload,name)=>window[name].apply(payload),[{fills:plan.fills,attachments:[]},api]);
  if (record) for (const fill of plan.fills) {
    if (!(result?.applied ?? []).includes(fill.key)) continue;
    const question = fields.find(field=>field.key === fill.key)?.label || fill.key;
    const answer = {question,answer:result?.values?.[fill.key]??spoken(fields.find(field=>field.key===fill.key),fill)};
    const index = record.findIndex(entry=>entry.question === question);
    if (index >= 0) record[index] = answer;
    else record.push(answer);
  }
  const failed = [...plan.blocked,...plan.skipped,...(result?.failed ?? [])].map(entry=>{
    const field = fields.find(field=>field.key === entry.key);
    return {...entry,label:field?.label || entry.label,required:Boolean(field?.required)};
  });
  return {...result,failed};
}

/**
 * The answer a menu's shape gives away, with no model call.
 *
 * A yes/no menu under "are you able / willing / comfortable", "do you have
 * experience with", "can you" is yes: the applicant is applying. A menu of
 * months, years or days under a start date is the date two weeks out. The
 * rest - anything sensitive, anything a yes would misrepresent - is left
 * to the model with the list.
 */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function menuShapeAnswer(label, labels, profile) {
  const lower = labels.map((entry) => String(entry).trim().toLowerCase());
  if (lower.length === 0) return null;
  const subject = String(label).toLowerCase();

  const yesNo = lower.every((entry) => /^(yes|no|n\/a|decline|prefer not|i (?:do not|don't) wish)/.test(entry)) && lower.some((entry) => entry.startsWith("yes"));
  if (yesNo) {
    const capability = /\b(?:are you (?:able|willing|comfortable|open|available|okay|ok)|can you|could you|will you be able|would you be (?:able|willing|comfortable)|do you have (?:experience|at least|\d|hands|strong|solid|proven|a (?:background|strong))|have you (?:worked|used|built|led|managed|designed)|experience (?:with|in|providing|using|working)|familiar with|proficien|comfortable (?:with|working))\b/;
    if (capability.test(subject)) return labels[lower.findIndex((entry) => entry.startsWith("yes"))];
    return null;
  }

  const when = new Date(Date.now() + 14 * 86400000);
  if (/start|available|availability|date/.test(subject)) {
    const months = lower.filter((entry) => MONTHS.some((month) => entry.startsWith(month) || entry === month.slice(0, 3)));
    if (months.length >= 10) {
      const want = MONTHS[when.getMonth()];
      const index = lower.findIndex((entry) => entry.startsWith(want) || entry === want.slice(0, 3));
      if (index >= 0) return labels[index];
    }
    if (lower.every((entry) => /^(19|20)\d\d$/.test(entry))) {
      const index = lower.indexOf(String(when.getFullYear()));
      if (index >= 0) return labels[index];
      return labels[labels.length - 1];
    }
    if (lower.length >= 28 && lower.every((entry) => /^\d{1,2}$/.test(entry))) {
      const index = lower.indexOf(String(when.getDate()));
      if (index >= 0) return labels[index];
    }
  }

  return null;
}

/**
 * Did the application go through?
 *
 * Greenhouse replaces the form with a thank-you, in the same frame or by
 * navigating it, so every frame's text is read rather than the one the form
 * was in - the frame holding the form a moment ago may hold a new document
 * with no page script in it now. Errors are only readable while the form is
 * still there, so they are checked through the page script when it survives.
 */
async function confirmSubmission(tabId, frameId, timeoutMs = 20000,before=[]) {
  const CONFIRMED = /thank you for applying|thanks for applying|application (?:has been|was) (?:submitted|received)|we(?:'ve| have) received your application|application submitted|successfully submitted/i;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let complainedAt = 0;

  while (Date.now() < deadline) {
    await wait(600);

    // The address is the surest sign: the board moves a sent application to
    // its own confirmation page.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url && /\/(?:confirmation|thanks)(?:[/?#]|$)/i.test(tab.url)) {
      const texts = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: () => (document.body?.innerText || "").slice(0, 6000) })
        .then((results) => results.map((result) => result.result || ""))
        .catch(() => []);
      const confirming = texts.find((text) => CONFIRMED.test(text)) ?? "";
      const at = confirming.search(CONFIRMED);
      const quote = at >= 0 ? confirming.slice(Math.max(0, confirming.lastIndexOf("\n", at) + 1), at + 160).replace(/\s+/g, " ").trim() : "";
      if(quote&&newConfirmation(confirming,before))return { confirmed: true, quote };
    }

    const texts = await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: () => (document.body?.innerText || "").slice(0, 6000) })
      .then((results) => results.map((result) => result.result || ""))
      .catch(() => []);
    const confirming = texts.find((text) => newConfirmation(text,before));
    if (confirming !== undefined) {
      const at = confirming.search(CONFIRMED);
      const quote = confirming
        .slice(Math.max(0, confirming.lastIndexOf("\n", at) + 1), at + 160)
        .replace(/\s+/g, " ")
        .trim();
      return { confirmed: true, quote };
    }

    // Rippling and Workable send the application from a script and say
    // little on the page about it - Rippling shows the form again, with a
    // toast that is gone in a moment. Their request to /apply is the
    // answer: 2xx is sent, and 4xx is refused, with the number for the log.
    if (/rippling|workable/.test(atsOf(tab?.url ?? ""))) {
      const answer = await inFrame(tabId, frameId, () => (window.__ghApply ? window.__ghApply.sent() : null)).catch(() => null);
      if (answer?.ok) return { confirmed: true, quote: `the board accepted the application (${answer.status} from ${pathOf(answer.url)})` };
      if (answer && answer.status >= 400) return { confirmed: false, complaints: `the board answered ${answer.status} to the application` };
    }

    // Empty boxes are a prompt. Full ones are the code this run just typed,
    // with the page still deciding what to do about it, which is waiting.
    const verification = await inFrame(tabId, frameId, () => (window.__ghApply ? window.__ghApply.verification() : null)).catch(() => null);
    if (verification && !verification.filled) return { confirmed: false, verification };

    // A puzzle on screen is the board asking for a person; no amount of
    // waiting here answers it.
    if (await captchaShowing(tabId)) return { confirmed: false, captcha: true };

    // A complaint has to stay on the page for a few seconds to count. The
    // messages from a refused first attempt are still showing while the
    // resubmit is on its way to the server; read at once, they would call a
    // sent application failed.
    last = await inFrame(tabId, frameId, () => (window.__ghApply ? window.__ghApply.complaints() : null)).catch(() => null);
    if (last?.messages?.length > 0 || last?.invalid?.length > 0) {
      complainedAt ||= Date.now();
      if (Date.now() - complainedAt >= 4000) {
        const complaints = [...(last.invalid ?? []), ...(last.messages ?? [])].join("; ");
        return { confirmed: false, complaints };
      }
    } else {
      complainedAt = 0;
    }
  }

  return { confirmed: false, complaints: "", last };
}

/**
 * Whether a captcha challenge is on screen: a puzzle iframe from hCaptcha,
 * reCAPTCHA, Arkose or Turnstile, shown rather than the hidden one that
 * decides in silence.
 */
async function captchaShowing(tabId) {
  const results = await chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: () =>
        [...document.querySelectorAll("iframe")].some((frame) => {
          if (!/hcaptcha\.com|recaptcha\/(?:api2|enterprise)\/bframe|arkoselabs|funcaptcha|challenges\.cloudflare/i.test(frame.src)) return false;
          const box = frame.getBoundingClientRect();
          return getComputedStyle(frame).visibility !== "hidden" && getComputedStyle(frame).display !== "none" && box.width > 200 && box.height > 200;
        }),
    })
    .catch(() => []);
  return results.some((result) => result.result === true);
}

/** The path of an address, or the address itself when it will not parse. */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

/**
 * A fill's answer as a person would write it in Answers.txt: the option's
 * wording rather than its value ("Male", not "2"), and for a ticked box the
 * wording asked for rather than "on".
 */
function spoken(field, fill) {
  const value = fill.value;
  if(value===undefined||value===null)return fill.candidates?.[0]??value;
  const matches=field?.options?.filter(candidate=>candidate.value!==undefined&&candidate.value!==null&&String(candidate.value)===String(value))||[];
  const option=matches.find(candidate=>(fill.candidates||[]).some(label=>String(label).trim()===String(candidate.label||'').trim()))||(matches.length===1?matches[0]:null);
  if (option?.label) return option.label;
  if (/^(?:on|true)$/i.test(String(value ?? ""))) return fill.candidates?.[0] ?? value;
  return value;
}

/**
 * Ticks a reCAPTCHA checkbox and reports whether it was taken at face
 * value. The box lives in Google's own frame, which the extension can
 * reach; a tick that passes turns the anchor's aria-checked on, and one
 * that does not opens the picture puzzle, which captchaShowing sees.
 */
async function tickCaptcha(tabId) {
  const anchors = () =>
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => {
          if (!/recaptcha\/(?:api2|enterprise)\/anchor/.test(location.href)) return null;
          const anchor = document.querySelector("#recaptcha-anchor");
          return anchor ? anchor.getAttribute("aria-checked") === "true" : null;
        },
      })
      .then((results) => results.map((result) => result.result).filter((state) => state !== null && state !== undefined))
      .catch(() => []);

  const states = await anchors();
  if (states.length === 0) return { present: false };
  if (states.some(Boolean)) return { present: true, passed: true };

  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        if (!/recaptcha\/(?:api2|enterprise)\/anchor/.test(location.href)) return;
        document.querySelector("#recaptcha-anchor")?.click();
      },
    })
    .catch(() => {});

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await wait(300);
    if ((await anchors()).some(Boolean)) return { present: true, passed: true };
    if (await captchaShowing(tabId)) return { present: true, passed: false };
  }
  return { present: true, passed: false };
}

/** Every job applied to, one line each: date, company, title, link. */
function appliedJobsText(rows) {
  const seen = new Set();
  const lines = [];
  for (const row of rows.filter((entry) => entry.status === "submitted" || entry.status === "unconfirmed").sort((a, b) => a.at - b.at)) {
    const key = jobKey(row.company, row.title) || row.applyUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${new Date(row.at).toISOString().slice(0, 10)}  ${row.company || "?"}  -  ${row.title || "?"}  -  ${row.applyUrl}`);
  }
  return lines.join("\n");
}

/** Security codes already typed this run, so none is typed twice. */
const usedCodes = new Set();

/**
 * Reading the mailbox without owning the screen.
 *
 * This run used to read a security code as `atFront(() =>
 * fetchSecurityCode(...))`: one turn at the foreground queue, held for the
 * whole two and a half minutes the mail took to arrive, during which no
 * other job could load a page or type a character. Two measured Greenhouse
 * applications spent a hundred and twenty-seven of their hundred and
 * sixty-four seconds in exactly that call. apply/verification.js already
 * contains the reader that takes a fresh short turn per look and holds
 * nothing in between - the whole reason that module exists - so the run
 * calls it instead of the old function. Each method below is one turn,
 * deliberately, and there is no long one on offer.
 */
const mailOps = {
  findTab: (patterns) => findTab(patterns, (tab) => !tab.discarded).then((tab) => (tab ? { id: tab.id, url: tab.url, title: tab.title } : null)),
  openTab: (url) => atFront(() => openInFront(url)),
  closeTab,
  inFrame: (tabId, frameId, func, args = []) => atFront(() => chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func, args }).then((results) => results[0]?.result)),
};
const mailbox = createVerificationService({
  browser: mailOps,
  log,
  used: usedCodes,
  // Read per wait rather than captured once: the setting is on the profile
  // page, and a person who changes it mid-run means it for the next
  // application rather than for tomorrow.
  stated: () => readProfile().then((profile) => profile.mailProvider).catch(() => "auto"),
});

/**
 * An attempt running outside the slot pool - the standalone paths, and the
 * fixtures. It has no slot to hand back, so waiting is just waiting.
 */
const soloAttempt = { note() {}, waiting: (what, work) => work() };

/**
 * The board's own name for the company, from the apply address: "mercury"
 * in ?for=mercury or /mercury/jobs/123. It is what the security-code mail is
 * addressed about, when the name on the resume differs.
 */
function boardOf(url) {
  try {
    const parsed = new URL(url);
    const skip = new Set(["embed", "job_app", "boards", "jobs", "job"]);
    return parsed.searchParams.get("for") || parsed.pathname.split("/").find((part) => part && !skip.has(part)) || "";
  } catch {
    return "";
  }
}

/**
 * The record of a sent application, on disk: its own folder under
 * job applied-folder/applied/<day>/ holding the resume and letter that went, the
 * application.json saying what happened. The final viewport is saved in
 * this folder by finishApplicationTab immediately before closing or review.
 * Returns the folder's path within the root.
 */
async function archive(application, profile, result, confirmedTabId, { documentsAgain = true, root = "applied", confirmationUrl: confirmedUrl = "" } = {}) {
  const folder = applicationFolder(application, root);
  const files = [];

  if (!documentsAgain) {
    // The folder exists from a first pass; the documents in it stand.
    if (application.resumeName) files.push(application.resumeName);
    if (application.letterName) files.push(application.letterName);
  }
  if (application.resume && documentsAgain) {
    const name = application.resumeName || "resume.pdf";
    await save(`${folder}/${name}`, application.resume, { type: "application/pdf" });
    files.push(name);
  }
  if (application.letter && documentsAgain) {
    const name = application.letterName || "cover-letter.pdf";
    await save(`${folder}/${name}`, application.letter, { type: application.letter.type || "application/pdf" });
    files.push(name);
  }
  // The letter as text as well, for pasting into a form that asks for it
  // in a box; the PDF above is what the upload boxes take.
  if (application.letterText && documentsAgain) {
    await save(`${folder}/Cover letter.txt`, application.letterText, { type: "text/plain" });
    files.push("Cover letter.txt");
  }

  if (application.answers?.length > 0 && documentsAgain) {
    const lines = [
      `${application.company}${application.title ? ` - ${application.title}` : ""}`,
      `Job: ${application.applyUrl}`,
      application.sourceUrl && application.sourceUrl !== application.applyUrl ? `Found via: ${application.sourceUrl}` : "",
      "",
      ...application.answers.flatMap((entry) => [`Q: ${entry.question}`, `A: ${entry.answer}`, ""]),
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
    await save(`${folder}/Answers.txt`, lines.join("\n"), { type: "text/plain" });
    files.push("Answers.txt");
  } else if (application.answers?.length > 0) {
    files.push("Answers.txt");
  }

  // A folder for applying by hand says where, the way the folders written
  // without a form do, so the two read alike.
  if (root === MANUAL_ROOT) {
    const note = [
      `${application.company}${application.title ? ` - ${application.title}` : ""}`,
      `Apply here: ${application.applyUrl}`,
      application.sourceUrl && application.sourceUrl !== application.applyUrl ? `Found via: ${application.sourceUrl}` : "",
      `Why by hand: ${result.reason || result.status}.`,
      `Written: ${new Date().toLocaleString()}`,
    ].filter(Boolean);
    await save(`${folder}/Job link.txt`, note.join("\n"), { type: "text/plain" });
    files.push("Job link.txt");
  }

  // The address the confirmation was read at. The legacy path still has the
  // tab open at this point and asks it; the apply module photographed and
  // closed the page before handing the outcome back, so it says where
  // instead of leaving a tab open purely to be asked.
  let confirmationUrl = confirmedUrl;
  if (!confirmationUrl && confirmedTabId) {
    const tab = await chrome.tabs.get(confirmedTabId);
    confirmationUrl = tab.url ?? "";
  }

  await saveJson(`${folder}/application.json`, {
    company: application.company,
    title: application.title,
    status: result.status,
    submissionAttempted:result.detail?.submissionAttempted,
    reason: result.reason || undefined,
    jobUrl: application.applyUrl,
    foundVia: application.sourceUrl || undefined,
    confirmationUrl: confirmationUrl || undefined,
    applicant: { name: `${profile.firstName} ${profile.lastName}`.trim(), email: profile.email },
    startedAt: new Date(result.at).toISOString(),
    finishedAt: new Date().toISOString(),
    secondsTaken: Math.round((Date.now() - result.at) / 1000),
    fieldsFilled: result.detail?.filled,
    timings: result.detail?.timings,
    attachments: result.detail?.attachments,
    securityCodeUsed: Boolean(result.detail?.securityCode),
    boardSaid: result.detail?.boardSaid || undefined,
    files,
  }, { overwrite: true });
  files.push("application.json");
  return folder;
}

/* ------------------------------------------------------------- the queue */

/**
 * Fatal rather than per-job: the next job would fail the same way.
 *
 * Only a rejected key, an exhausted quota or no credit qualifies. A cut-off
 * answer or a provider hiccup used to land here too, which meant one unlucky
 * question ended a queue of forty - the log said "Finished 0 of 4" and the
 * other three were never opened.
 */
const stopsTheRun = (error) =>
  (error instanceof AiError && error.fatal) ||
  // 429 is ChatGPT's usage cap, which lifts in hours, not in the next job.
  (error instanceof WriterError && [401, 402, 403, 409, 412, 429].includes(error.status)) || [401,403,409,412,429].includes(error?.status);

/**
 * The Stop button arriving mid-request, which is not the posting's fault.
 *
 * Now that the run's abort signal reaches the writer, every request still
 * in the air when Stop is pressed comes back as a 499. Recorded as an
 * ordinary failure those would put each posting to rest for a week, count
 * against the board's health and fill the day's reason tally with "The run
 * was stopped" - so a stopped run would quietly cost the postings it had
 * open. They stay exactly as they were instead, and the next run takes
 * them from where this one left them.
 */
const stoppedMidRequest = (error) => state.stopping && (error?.status === 499 || /the run was stopped/i.test(error?.message ?? ""));

/**
 * Skipped and failed postings are remembered for this long before being
 * tried again. Without it, a run that goes round and round would write a new
 * resume for the same unanswerable form every hour.
 */
const PASS_DAYS = 7;

/* ------------------------------------------------------------ autopilot */

/**
 * Pressing Run, all day, so nobody has to.
 *
 * A run ends for a dozen ordinary reasons - the feeds had nothing new this
 * round, the per-run attempt limit was reached, ChatGPT wanted a minute -
 * and every one of them used to mean the bot was finished until a person
 * came back. Three hundred applications is perhaps thirty runs, several of
 * them at three in the morning, so the supervisor presses Run itself.
 *
 * The timer is a `chrome.alarms` one and not a `setTimeout`, which is the
 * whole trick. A timeout lives in the service worker's memory and dies
 * with it - and the worker dying is the exact thing being guarded against,
 * since Chrome ends an idle MV3 worker and there is nothing to end an
 * in-memory timer gracefully. An alarm is held by Chrome, survives the
 * worker, and wakes a new one to deliver it. It repeats every minute and
 * the question "is it time yet" is answered from storage rather than from
 * memory, so a missed tick costs a minute instead of the rest of the day.
 */
const AUTOPILOT_ALARM = "apply-bot-autopilot";
let runFailures = 0;
/**
 * The watchdog asks a wedged run to stop the same way a person does, which
 * would otherwise be recorded as the person having stopped it - and Stop
 * is the one ending autopilot refuses to override. So the two are told
 * apart here rather than by the stop flag they share.
 */
let windingDown = false;
/**
 * The same problem once more, for health.js.
 *
 * A run halted because the mailbox is gone sets `state.stopping`, which is
 * the only lever there is for winding an attempt down gracefully - and
 * which the finally block would then record as the applicant having
 * pressed Stop, switching autopilot off and losing the one sentence
 * explaining the night. The reason is written here first and wins.
 */
let haltReason = null;

const armAutopilot = () => chrome.alarms.create(AUTOPILOT_ALARM, { periodInMinutes: 1 });

const stoppedReason = (when) => stopEnding({ source: state.stopSource, halt: haltReason, windingDown, when });

/**
 * Aborted the moment anything asks the run to stop.
 *
 * The flag by itself is read at loop boundaries, and the boundaries are
 * where the time goes: a ChatGPT request has six minutes of its own
 * deadline and will spend all of them, so Stop pressed one second into a
 * resume meant five minutes and fifty-nine seconds of further work. The
 * writer has understood an `AbortSignal` since chat-recovery.js was
 * written - it answers an aborted one with a 499 and stops retrying - and
 * nothing had ever handed it one; `writeApplication(profile, job,
 * undefined, ...)` passed the slot by name.
 *
 * Replaced rather than reset at the top of each run, because an
 * AbortController cannot be un-aborted.
 */
let runAbort = new AbortController();

/**
 * How long a stopped run keeps waiting for an attempt that is already open.
 *
 * Not zero, because an attempt is mid-page and out here there is no way to
 * tell a form being filled from one being submitted; cutting at nought
 * would turn Stop into a source of duplicate applications, which is the
 * one failure this codebase spends the most code avoiding. Not the
 * attempt deadline either, which is twelve minutes and twenty-five for a
 * Workday wizard - the measured cost of that choice was a hundred and
 * twenty-three seconds of the bot visibly working after the button was
 * pressed, and the applicant reasonably concluding the button was broken.
 * Three quarters of a minute is long enough for a page interaction to
 * land and short enough that Stop reads as Stop.
 */
const STOP_GRACE_MS = 45000;

/**
 * Stop, with the asker on the record.
 *
 * Everything that used to raise the stopping flag by hand comes through
 * here, so that one press does all four of the things a press has to do:
 * name who asked, cut the in-flight request short, say so on the monitor
 * in the same second rather than leaving it reading "Running", and cancel
 * any run that was queued behind this one. Pressing Run during a slow
 * wind-down and then pressing Stop again used to leave `runAgain` set, and
 * the wind-down's own finally block then started the fresh run the second
 * press was asking it not to.
 */
function requestStop(source, announcement = "") {
  const fresh = !state.stopping;
  state.stopping = true;
  // A person's stop outranks the supervisor's: the watchdog may wind a run
  // down into a stop the applicant then confirms, and that ending is the
  // applicant's, not a stall.
  if (fresh || source === "user") state.stopSource = source;
  runAbort.abort(new Error("The run was stopped."));
  // The stall watchdog stops a run precisely so another can start.
  if (source !== "stalled") runAgain = false;
  if (state.running || starting) state.phase = "stopping";
  if (fresh && announcement) log("warn", announcement);
  else remember();
}

/* ------------------------------------------------------- staying alive */

/**
 * How much room is left, asked of the browser rather than guessed at.
 *
 * There is no filesystem API in an extension, so `navigator.storage` is
 * the whole of what can be known: Chrome sizes an origin's quota from free
 * disk, so the gap between quota and usage moves with the real thing even
 * though it is not the real thing. The database's own size is passed along
 * because SQLite here is a single file exported and rewritten whole on
 * every save - the disk must be able to hold a second copy of it at any
 * moment, and a day that spends down to less than that fails at the next
 * write of anything rather than at the next screenshot.
 */
async function probeDisk() {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (!estimate) return;
  const stats = await databaseRequest({ action: "stats" }).catch(() => null);
  health.storage({ quota: estimate.quota ?? 0, usage: estimate.usage ?? 0, dbBytes: stats?.bytes ?? 0 });
  keepHealth();
}

/** Times a missing ChatGPT tab is reopened before the night is called off. */
const CHAT_TAB_TRIES = 3;

/**
 * The writer, with the tab it needs reopened if somebody closed it.
 *
 * ChatGPT is the single thing a night cannot do without. Every posting
 * goes through it - the résumé, the letter, and every answer the profile
 * cannot give - so a closed tab is not one bad application, it is eight
 * hours of applying to nothing. And the old behaviour made that silent in
 * the worst way: the run stopped with "No ChatGPT tab is open", autopilot
 * read that as an ordinary error, and the night became a four-second run
 * every few minutes until morning, each one writing the same sentence into
 * a log nobody was reading. Nothing was ever going to open that tab.
 *
 * So it is opened here. That is the action the applicant would take, it is
 * local, it is idempotent, and the only honest way to find out whether it
 * worked is to ask the writer again rather than to assume.
 *
 * What is deliberately *not* recovered is everything else. A signed-out
 * account, an exhausted quota, a page whose composer never appears - none
 * of those are fixed by another tab, and the distinction decides what the
 * rest of the night does. A failure that reopening might fix keeps the
 * `error` code and its widening back-off, because ChatGPT does have bad
 * minutes. A failure that reopening has already failed to fix is named as
 * setup, which is the one class of stop autopilot will not restart into -
 * the difference between a night that ends with a sentence a person can
 * act on and a night that grinds.
 */
async function readyWriter(profile) {
  const onRetry = info => log('warn', 'ChatGPT readiness refresh retry ' + info.retry + '/' + info.limit + ': ' + info.message);
  if (!profile.chatGptProjectUrl) log('warn', 'No ChatGPT project URL is set, so every request goes to whichever conversation happens to be open. Answers will be read out of that conversation\'s context, which is how a night fails on "the reply contains no JSON object" three hundred times. Set one in Settings.');

  for (let tries = 1; ; tries++) {
    const writer = await checkWriter(profile, { onRetry });
    if (writer.ok) return writer;
    if (!/no chatgpt tab is open/i.test(writer.error ?? '')) return writer;
    if (tries >= CHAT_TAB_TRIES) return { ...writer, needsAPerson: true, error: `${writer.error} One was opened ${tries} time(s) and the writer still could not be reached, so nothing here can start the night.` };
    log('warn', `${writer.error} Opening one and trying again (${tries}/${CHAT_TAB_TRIES}).`);
    // Opened and left to load on its own: `checkWriter` brings the tab to
    // the front and waits for a composer itself, so waiting for it here
    // would be the same wait done twice and a second idea of what "ready"
    // means.
    await chrome.tabs.create({ url: profile.chatGptProjectUrl || 'https://chatgpt.com/', active: false }).catch(error => log('warn', `Could not open a ChatGPT tab: ${error?.message ?? error}`));
    await wait(2000);
  }
}

/**
 * Carry out whatever health.js asked for, and halt if it asked for that.
 *
 * Every remedy here is deliberately something that cannot send an
 * application or change one: a tab reloaded, a board slowed down, a
 * screenshot not taken. Anything that would touch an employer is a stop
 * instead, because the cost of guessing wrong there is a second
 * application to a real company rather than a wasted minute.
 */
async function treatConditions() {
  for (const { remedy, board } of health.remedies()) {
    if (remedy === "reset-mailbox") await reloadMailbox();
    else if (remedy === "cool-board") log("warn", `${board} is failing on every attempt, so applications there are being spaced much further apart. If it keeps failing it will be left alone for a while, tried again later, and the other boards will carry the night.`);
    else if (remedy === "skip-screenshots") log("warn", `Disk is running low, so the picture of the last page is no longer being saved. The resume, the answers and the receipt still are.`);
  }
  keepHealth();
  const stop = health.stop();
  if (!stop || haltReason) return Boolean(haltReason);
  haltReason = { code: "health", message: stop.message };
  state.stopReason = haltReason;
  requestStop("health");
  log("error", `Stopping the day: ${stop.message}`);
  remember();
  return true;
}

/**
 * The mailbox, given another chance.
 *
 * Reloaded rather than closed, because a tab the applicant had open is
 * theirs and a reload is the cheapest thing that fixes the case this is
 * for: a Gmail view left running for twenty hours whose session token has
 * gone stale behind it. If Gmail really is signed out the reload lands on
 * the sign-in page, the next wait says so again, and the ladder in
 * health.js reaches the stop that asks for a person - which is the correct
 * ending and the one that used to never arrive.
 *
 * An attempt parked on a mail wait right now loses its tab mid-look. That
 * is accepted: the only way to be here is for mail waits to be failing, so
 * the attempt being interrupted was going to time out anyway.
 */
async function reloadMailbox() {
  const tabs = (await Promise.all(ALL_PATTERNS.map((url) => chrome.tabs.query({ url }).catch(() => [])))).flat();
  for (const tab of tabs) await chrome.tabs.reload(tab.id).catch(() => {});
  log("warn", tabs.length
    ? `The mailbox is not answering with codes, so it has been reloaded. If the next few applications still find nothing, the day stops and waits for you to sign in.`
    : `The mailbox is not answering with codes and no mailbox tab is open; the next application that needs a code will open one.`);
}

/** What happens after this run, decided the moment it ends and written down. */
async function planNextRun() {
  await loadSchedule().catch(() => {});
  const decision = nextRun({ ledger: dailyLedger, settings: scheduleSettings, stopReason: state.stopReason, failures: runFailures, blocked: Boolean(health.stop()) });
  if (!decision.start) {
    await stateStorage.set({ autopilotResumeAt: 0 }).catch(() => {});
    // A health halt keeps its alarm. Some of those conditions do lift
    // without anybody doing anything - a disk another program emptied, a
    // Gmail session that came back - and clearing the alarm would mean the
    // rest of the day went unworked after the thing that stopped it was
    // gone, with the extension insisting it was still on autopilot.
    if (decision.watch) armAutopilot();
    else await chrome.alarms.clear(AUTOPILOT_ALARM).catch(() => {});
    if (scheduleSettings.autopilot) log("info", `Autopilot: ${decision.reason}`);
    return decision;
  }
  await stateStorage.set({ autopilotResumeAt: Date.now() + Math.max(1000, decision.delayMs) }).catch(() => {});
  armAutopilot();
  log("info", `Autopilot: ${decision.reason}`);
  return decision;
}

async function stopAutopilot() {
  const stored = (await stateStorage.get("schedule")).schedule || {};
  if (withScheduleDefaults(stored).autopilot) log("info", "Autopilot is off: you pressed Stop. Turn it back on in Settings when the day should continue by itself.");
  scheduleSettings = withScheduleDefaults({ ...stored, autopilot: false });
  await stateStorage.set({ schedule: { ...stored, autopilot: false }, autopilotResumeAt: 0 });
  await chrome.alarms.clear(AUTOPILOT_ALARM).catch(() => {});
}

async function autopilotTick() {
  await restored;
  await loadSchedule().catch(() => {});
  if (!scheduleSettings.autopilot) {
    await chrome.alarms.clear(AUTOPILOT_ALARM).catch(() => {});
    return;
  }
  await loadDay().catch(() => {});
  // Between runs as well as during them, because the condition that stops
  // the night can arrive while nothing is running - a disk filled by
  // something else on the machine, or a database that has grown past the
  // room left to rewrite it - and the tick is the only thing awake to see.
  await probeDisk().catch(() => {});
  if (state.running || starting) {
    // A run with no sign of life for longer than the longest single
    // attempt is not slow, it is wedged - a tab that never answered, a
    // promise nothing will settle - and the only way back is to wind it
    // down and let the next tick start a fresh one. Stop is asked for
    // rather than forced, so anything mid-submission finishes first.
    const silent = Date.now() - (state.lastActivityAt || Date.now());
    if (silent > scheduleSettings.wizardDeadlineMs + 600000 && !state.stopping) {
      windingDown = true;
      requestStop("stalled");
      log("error", `Autopilot: nothing has happened for ${Math.round(silent / 60000)} minutes, so this run is being wound down and started again.`);
    }
    return;
  }
  const { autopilotResumeAt = 0 } = await stateStorage.get("autopilotResumeAt").catch(() => ({}));
  if (state.stopReason?.code !== "interrupted" && Date.now() < autopilotResumeAt) return;
  const decision = nextRun({ ledger: dailyLedger, settings: scheduleSettings, stopReason: state.stopReason, failures: runFailures, blocked: Boolean(health.stop()) });
  if (!decision.start) {
    await planNextRun();
    return;
  }
  log("info", `Autopilot: starting the next run. ${decision.reason}`);
  run();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOPILOT_ALARM) autopilotTick().catch((error) => console.warn("Autopilot", error));
});
chrome.runtime.onStartup.addListener(() => autopilotTick().catch(() => {}));
// A worker that has just booted re-arms the alarm, because the alarm is the
// only thing that will wake the one after it.
restored.then(() => { if (scheduleSettings.autopilot) armAutopilot(); }).catch(() => {});

let runAgain = false;
let starting = false;
async function run() {
  if (starting || state.running) {
    if (state.stopping) runAgain = true;
    return;
  }
  starting = true;
  state.stopping = false;
  state.stopSource = '';
  runAbort = new AbortController();
  haltReason = null;
  try { await restored;await runInternal(); }
  catch (error) { state.running=false;state.stopReason={code:'error',message:`Could not start the run: ${error.message}`};log("error",state.stopReason.message); }
  finally {
    starting = false;
    if(!state.running&&!state.finishedAt){state.finishedAt=Date.now();if(state.stopping)state.stopReason=stoppedReason('before applications started');state.phase=state.stopping?'stopped':'finished';remember();}
    await durableRun.flush();
    await durableDay.flush();
    await durableHealth.flush();
    windingDown = false;
    haltReason = null;
    runFailures = state.stopReason?.code === 'error' ? runFailures + 1 : 0;
    if (runAgain && !state.running) { runAgain = false; setTimeout(run, 0); }
    else if (!state.running) await planNextRun().catch(() => {});
  }
}
async function runInternal() {
  // Run pressed while a run is still winding down after Stop: it starts as
  // soon as that one has finished. Refused outright, the press did nothing
  // and the log showed only the old run's "Stopped.", which read as the bot
  // halting on its own.
  if (state.running) {
    if (state.stopping) runAgain = true;
    return;
  }

  // A fresh log per run, cleared here and not further down: clearing it after
  // the version line had been written was quietly erasing the version line.
  state.log = [];
  Object.assign(state,{startedAt:Date.now(),finishedAt:0,lastActivityAt:Date.now(),stopReason:null,lastError:null,activeJobs:{},discovered:0,aiWorkers:null,attempted:0,submitted:0,targetSubmitted:0,screened:0,rejected:0,review:0,total:0,done:0,phase:'starting',discoverySource:'',feedScan:null});

  // First line of every run, before anything can fail, because the question
  // "am I actually running the code I just changed?" is otherwise unanswerable
  // from the log - and a Chrome extension is unusually good at answering it
  // wrongly. Edited files do nothing until the extension is reloaded, and a
  // service worker that is already awake keeps serving the old script.
  log("info", `Apply bot ${chrome.runtime.getManifest().version}.`);
  resetSpend();

  const profile = await readProfile();
  // Re-read every run rather than trusted from the last one: a run started
  // by the supervisor hours after the settings changed must use the
  // settings as they are now, and a worker that died since has no memory.
  await loadSchedule();
  await loadDay();
  await loadHealth().catch(()=>{});
  // The answers given on the Questions page since the last run. Read here
  // for the same reason as the schedule: what a run uses is what was
  // saved before it started, and a pack that failed to load must leave
  // the questions unanswered rather than carry a stale one into a form.
  runAnswerPack = await answerPack().catch(() => ({}));
  {
    const waiting = Object.keys(runAnswerPack).length;
    if (waiting) log("info", `${waiting} answered question(s) loaded; forms asking them again are filled rather than held`);
  }
  // Before a tab is opened rather than after the first application has
  // been written: a disk with no room left cannot record what was sent,
  // and an application nobody has a receipt for is worse than one not
  // sent at all.
  await probeDisk().catch(()=>{});
  const blocking=health.stop();
  if(blocking){state.stopReason={code:'health',message:blocking.message};log('error',blocking.message);remember();return;}
  slots.resize(scheduleSettings.attemptConcurrency);
  const today=dayProgress(dailyLedger,scheduleSettings);
  if(today.met){state.stopReason={code:'target',message:`Today's target of ${today.target} confirmed submission(s) is already met at ${today.submitted}. Raise the daily target in Settings, or wait for midnight.`};log('info',state.stopReason.message);remember();return;}
  state.targetSubmitted=profile.maxSubmittedPerRun||0;
  const gaps = missingFromProfile(profile);
  if (gaps.length > 0) {
    state.stopReason={code:'setup',message:`Complete your profile: ${gaps.join('; ')}.`};remember();
    log("error", `The profile is incomplete: ${gaps.join("; ")}. Fill it in on the options page first.`);
    return;
  }

  // Read, not fetched. The list was loaded and shown on the options page, and
  // a run works through exactly what was on screen when Run was pressed.
  const knownJobs=new Map((await allJobs()).map(job=>[job.id,job]));
  const pending=profile.autoFetch?[...knownJobs.values()].filter(job=>!job.hold&&verifiedOriginal(job)&&['extracted','eligible','generating','documents-ready'].includes(job.stage)&&Date.now()-job.updatedAt<86400000):[];
  // The third way in: a link the applicant already chose a resume for. It
  // joins the loaded list rather than forming a queue of its own, so one
  // posting reached by both roads is still one application.
  const pairings = await allPairings();
  const paired = new Map(pairings.map(row=>[canonicalUrl(row.link),row]));
  const loaded = [...new Set([...pending.map(job=>job.id),...pairings.map(row=>row.link),...(await allLinks()).links])];
  if(pending.length)log('info',`Resuming ${pending.length} queued posting(s) from saved progress before collecting more links.`);
  if(pairings.length)log('info',`${pairings.length} link(s) carry a resume you supplied; those resumes are uploaded exactly as given and are never regenerated.`);
  const externalHistory = await allHistory();
  const unresolved = externalHistory.filter(r=>r.kind === 'external' && !companyResolved(r));
  if(unresolved.length) { log('error',`${unresolved.length} past application(s) have an unknown company. Set their company names in Already applied before running.`); return; }
  // Folders ingested from an earlier Resume Builder run still work; links are
  // simply the path that needs no export step, so they win when both exist.
  const prepared = []; // Saved documents are outputs, never implicit run inputs.

  // The sites visited in turn once the loaded list is done: Jobright, then a
  // page of the Hiring Cafe search, then Jobright again. Each visit yields
  // whatever is new there since the last one.
  // With automatic fetching off, the loaded list is the whole run: the
  // sites are not visited, whatever the feed settings say.
  const sources = [];
  const fetching = profile.autoFetch !== false;
  if (fetching && profile.jobrightRecommend) sources.push("jobright");
  if (fetching && isHiringCafeSearch(profile.hiringCafeUrl)) sources.push("hiringcafe");
  else if (fetching && String(profile.hiringCafeUrl ?? "").trim()) log("warn", "The Hiring Cafe address in settings is not a hiringcafe.com search, so it is ignored.");
  // The employers already seen, read straight off their own job boards.
  // Last in the rotation because the feeds are what find new employers and
  // this only widens the ones they found; see boards.js for why it is the
  // one source that grows rather than decays as the history does.
  if (fetching && profile.boardRoster !== false) sources.push("boards");

  /**
   * The order the sources are actually visited in, which is no longer one
   * turn each.
   *
   * Measured over a night's run: forty-seven Jobright cards worked through
   * yielded two postings on a board this bot fills, while one slice of the
   * roster yielded six hundred and fifteen postings from eleven employers,
   * every one of them fillable by construction because that is what a
   * company's own Greenhouse board is. Supply quality, not supply volume,
   * is the ceiling, and a strict round robin spends two visits in three on
   * the sources that supply worst.
   *
   * So the roster is read between every pair of feed visits rather than
   * taking its turn as a third feed. The feeds stay in, and stay first
   * among themselves, because they are the only thing that finds an
   * employer nobody has applied to yet - and an employer found is a board
   * that keeps publishing for as long as the company is hiring.
   */
  const feeds = sources.filter((name) => name !== "boards");
  const visits = sources.includes("boards") && feeds.length > 0 ? feeds.flatMap((name) => ["boards", name]) : [...sources];

  if (loaded.length === 0 && prepared.length === 0 && sources.length === 0) {
    log(
      "error",
      fetching
        ? "No jobs to run: turn on Jobright's recommendations, set a Hiring Cafe search, add a sheet, or paste some links in settings."
        : "No jobs to run: automatic fetching is off and no links are loaded. Paste links or a sheet in settings and press Load links, or turn automatic fetching back on.",
    );
    return;
  }
  if (!fetching) log("info", "Automatic fetching is off: working through the loaded links only, Jobright and Hiring Cafe untouched.");

  if (loaded.length > 0 || sources.length > 0) {
    const writer = await readyWriter(profile);
    if (!writer.ok) {
      state.stopReason={code:writer.needsAPerson?'setup':'error',message:'Run stopped: '+writer.error};
      log("error", writer.error);
      return;
    }
    log("info", `Writing each resume and answering each form with ${writer.model}.`);
  }

  const stored = await stateStorage.get(["submitted", "elsewhere", "passed", "hiringCafePage", "fillableBoards", "manual"]);
  const sent = new Set(stored.submitted ?? []);
  // Jobs written up for applying by hand, for the day's "other links" table.
  const manual = Array.isArray(stored.manual) ? [...stored.manual] : [];
  // The jobs applied to, by company and title, from everything ever recorded
  // as sent. Built from the records rather than kept apart, so it is whole
  // even on a machine where the extension was reinstalled over its history.
  const recorded = await allResults();
  const applications = historyIndex([...externalHistory,...recorded.filter(protectsCompany),...[...sent].map(url=>({applyUrl:url}))]);
  // An imported row carrying no posting link of its own can only ever have
  // meant "not this employer again": there is no posting in it to refuse.
  // Those stay permanent now that an employer by itself no longer is, and
  // they are the only company-level refusal left. Everything with a link is
  // refused by that link, through `match`, for as long as the record exists.
  const barred = historyIndex(externalHistory.filter(row=>!historyUrls(row).some(url=>jobIdentityKeys(url).length)));
  const duplicates = {match:(...urls)=>applications.match(...urls),matchCompany:(company,...urls)=>barred.matchCompany(company,...urls),add:row=>applications.add(row)};
  if (externalHistory.length) log('info',`${externalHistory.length} imported applications and submission markers loaded for duplicate protection.`);
  const counted = recorded.filter(protectsCompany);
  const applied = new Set(counted.map((row) => jobKey(row.company, row.title)).filter(Boolean));
  // The day's budget per employer, seeded from what today's earlier runs
  // already sent so that a worker Chrome restarted at noon does not start
  // the employer's allowance over.
  const employers = employerDay({limit:scheduleSettings.perCompanyPerDay,gapMs:scheduleSettings.employerGapMs});
  for (const row of externalHistory) if(!historyUrls(row).some(url=>jobIdentityKeys(url).length)) employers.bar(row.company,historyUrls(row));
  for (const row of counted) employers.seed(row.company,historyUrls(row),row.at||0);
  log('info',`Up to ${scheduleSettings.perCompanyPerDay} role(s) per employer per day, at least ${Math.round(scheduleSettings.employerGapMs/60000)} minute(s) apart. The same posting is never applied to twice.`);
  if (applied.size > 0) await keep("history/applied-jobs.txt", appliedJobsText(recorded), { overwrite: true });
  // Links that led somewhere other than a board this bot fills. That does
  // not change between runs, and a recommendations list repeats itself from
  // one day to the next, so each is opened once and then left alone - until
  // the set of boards grows, when every link put aside is worth one more
  // look, because some of them were put aside for leading to Ashby.
  const boards = [...FILLABLE].sort().join(",");
  if (stored.fillableBoards !== boards && (stored.elsewhere ?? []).length > 0) {
    log("info", `${stored.elsewhere.length} link(s) that led to other boards will be looked at again, now that ${boards} are filled.`);
    stored.elsewhere = [];
  }
  await stateStorage.set({ fillableBoards: boards, elsewhere: stored.elsewhere ?? [] });
  const elsewhere = new Set(stored.elsewhere ?? []);
  // Greenhouse postings that were skipped or failed, with when. Tried again
  // after PASS_DAYS, not before.
  const passed = stored.passed && typeof stored.passed === "object" ? { ...stored.passed } : {};
  const resting = (id) => passed[id] && Date.now() - passed[id] < PASS_DAYS * 86400000;
  let hiringCafePage = Number(stored.hiringCafePage) || 1;

  // Chrome ends a service worker that has gone thirty seconds without an
  // extension API call, and writing a resume takes longer than that. A fetch
  // in flight does not count as activity, so the worker was dying mid-run -
  // the tab it had opened still on screen, its memory gone, and no line in
  // the log to say so. It survived only while the popup was open, because the
  // popup's polling happened to be the activity Chrome was waiting for. A
  // cheap API call on a timer is the documented way to say "still busy".
  const heartbeat = setInterval(() => {state.heartbeatAt=Date.now();chrome.runtime.getPlatformInfo().catch(() => {});}, 20000);
  // Every tab this bot opened and nothing is using any more. A worker's
  // ChatGPT tab is worth keeping while that kind of request keeps coming
  // and is pure cost once it stops; five minutes idle is long enough that
  // a busy kind never pays for a reload and short enough that a night
  // does not end holding eight renderers it stopped using at nine. The
  // rest - postings, feeds, the Gmail search, the about:blank a worker
  // never navigated - are only ever closed when the run that opened them
  // is gone, which is the only time nothing can still be holding them.
  // What is never closed here is in tabs.js, and the captcha tab waiting
  // for a person is first on that list.
  const tabSweep = setInterval(() => {
    reapTabs({chat:chatTabContext(),reviewBudget:KEPT_TABS,keepCaptcha:Boolean(profile.keepCaptchaTabs)}).then(closed=>{
      if(!closed.length)return;
      const kinds=[...new Set(closed.map(entry=>entry.purpose))].join(', ');
      log('info',`Closed ${closed.length} tab(s) nothing was using (${kinds}): ${closed.map(entry=>entry.reason).join('; ')}`);
    }).catch(()=>{});
  }, 120000);
  // Every five minutes rather than every application, because the question
  // "is the disk filling" changes on the scale of a hundred applications
  // and the answer costs a quota lookup and a page count. The run that
  // matters is the long one, and five minutes is forty applications of
  // warning before anything is lost.
  const diskWatch = setInterval(() => {probeDisk().then(()=>treatConditions()).catch(()=>{});}, 300000);

  if (state.stopping) { clearInterval(heartbeat); clearInterval(tabSweep); clearInterval(diskWatch); log("info", "Stopped before opening applications."); return; }
  state.running = true;
  state.total = 0;
  state.done = 0;
  Object.assign(state,{attempted:0,submitted:0,targetSubmitted:profile.maxSubmittedPerRun||0,screened:0,rejected:0,review:0,phase:'discovering'});
  remember();

  const SOURCE_NAMES = {jobright:"Jobright",hiringcafe:"Hiring Cafe",boards:"the job boards of employers already seen"};
  const rotation = sources.map((name) => SOURCE_NAMES[name] || name).join(" and ");
  log("info", `Live - applications will be sent.`);
  log("info", scheduleSettings.dailyTarget > 0
    ? `Today: ${today.submitted} of ${scheduleSettings.dailyTarget} sent, ${Math.round(today.needed * 10) / 10} an hour needed for the rest of the day. ${scheduleSettings.attemptConcurrency} application(s) at a time, ${Math.round(scheduleSettings.boardGapMs / 1000)}s between applications on one board, ${Math.round(scheduleSettings.attemptDeadlineMs / 60000)} minutes before an attempt is abandoned.`
    : `No daily target set; ${scheduleSettings.attemptConcurrency} application(s) at a time.`);
  if (scheduleSettings.dailyTarget > 0 && profile.maxPerRun > 0 && profile.maxPerRun < scheduleSettings.dailyTarget) {
    log("warn", `The per-run attempt limit is ${profile.maxPerRun}, below today's target of ${scheduleSettings.dailyTarget}. Each run stops at ${profile.maxPerRun}; set Application attempts per run to 0 to let the daily target be the only ceiling.`);
  }
  if (sources.length > 0) {
    log(
      "info",
      profile.keepRunning
        ? `Taking jobs from ${rotation} until a complete round finds no new job links, the attempt limit is reached, or Stop is pressed.${visits.filter((name) => name === "boards").length > 1 ? " The employers' own boards are read between every pair of feed visits, because every posting they return can be filled and most of what the feeds return cannot." : ""}`
        : `Taking jobs from ${rotation} once each, then finishing.`,
    );
  }

  const runStamp = stamp();
  // Whether a board's captcha is answerable from here is a fact about this
  // browser on this connection, and a new run may be neither.
  forgetBoardTrials();
  const identify = (entry) => (entry.application ? entry.application.id : canonicalUrl(entry.link));
  const seenThisRun = new Set();
  const discovery=new DiscoveryRounds(sources.length);
  let discoveredInBatch=0;
  let batchComplete=true;
  const feedTabs=new Set();
  const preparingKeys = new Set();
  // Two claims, with different lifetimes. The posting is exclusive for the
  // whole run, because the same job arriving by Jobright and by Hiring Cafe
  // is one job. The employer is a slot out of the day's budget, taken here
  // rather than at the form so that two preparations running at once cannot
  // both read the last one as free, and given back when the preparation
  // fails before anything was opened.
  const claimPreparation = (company,...urls) => {
    const keys = urls.flatMap(jobIdentityKeys);
    if (keys.some(key=>preparingKeys.has(key))) return false;
    if (!employers.claim(company,urls)) return false;
    keys.forEach(key=>preparingKeys.add(key)); return true;
  };

  // By-hand folders written this run, against the limit in settings. A slot
  // is taken when the decision to write is made, not when the files land,
  // so three postings being written at once cannot overshoot it.
  let manualWritten = 0;
  const manualSlot = () => {
    const limit = Number(profile.manualLimit) || 0;
    if (limit > 0 && manualWritten >= limit) return false;
    manualWritten += 1;
    return true;
  };
  const open = (url) => openTab(url, profile.foregroundTabs);
  // The recommendations tab is read as it stands the first time and reloaded
  // for every look after that, since the feed has moved on by then.
  let jobrightReads = 0;
  let jobrightMore=false;

  // The roster, and where the last visit to it got to. Employers come from
  // everything the applicant has ever been seen to apply through - the
  // record, the imported history and the jobs in the store - plus whatever
  // the feeds turn up during this run, so an employer discovered at ten in
  // the morning has its other openings read the same day. The titles are
  // the relevance vocabulary; see relevantPostings for why history rather
  // than a list kept here.
  const ROSTER_CHUNK = 25;
  let rosterCursor = 0;
  const rosterSeen = new Map();
  const rosterTitles = [...new Set([...recorded,...externalHistory,...knownJobs.values()].map(row=>String(row.title||'').trim()).filter(Boolean))];
  const noteEmployer = (company,...urls) => {for(const url of urls)if(url&&!rosterSeen.has(url))rosterSeen.set(url,{url,company:company||''});};
  for (const row of [...recorded,...externalHistory,...knownJobs.values()]) noteEmployer(row.company,...historyUrls(row));
  const rosterRecords = () => [...rosterSeen.values()];

  // A board this bot cannot fill is recognised in the list itself, before a
  // tab is spent opening the posting to find out. Both feeds carry the real
  // apply address for most of what they return, so the judgement costs
  // nothing here. A job whose site neither feed named is kept: an unnamed
  // site is unknown, not unsupported, and dropping those would quietly lose
  // the Greenhouse postings that arrive behind a company careers page.
  // Turning the setting off restores the older behaviour, where every job
  // went through and the unsupported ones became links saved for later.
  const onlyFillable = profile.fillableOnly !== false;
  const unfillable = (entry) => onlyFillable && Boolean(entry.ats) && !FILLABLE.has(entry.ats);
  // A job the feed itself says has no employer link is not an unnamed site,
  // it is one that applies only through the aggregator. Opening it ends in
  // the same place every time - a tab, a twenty-second hop, and a posting
  // sent for review - so it is declined in the list, where it is free.
  const unreachable = (entry) => entry.companySiteLink === false && !entry.originalUrl;

  /**
   * One batch from one place. Returns the entries worth working through: not
   * sent, not on a board this bot cannot fill, not known to apply elsewhere,
   * not resting, not seen this run.
   */
  const fetchBatch = async (where) => {
    let entries = [];
    let rawIds=null;
    batchComplete=true;
    let heading = "";

    if (where === "loaded") {
      entries = [...loaded.map((link) => { const row = paired.get(canonicalUrl(link)); return row ? { link, company: row.company, title: row.title, resumeId: row.resumeId, resumeName: row.resumeName } : { link }; }), ...prepared.map((application) => ({ application }))];
      heading = `${loaded.length} link(s) loaded in settings${pairings.length ? `, ${pairings.length} with a supplied resume` : ""}, ${prepared.length} prepared application(s)`;
    } else if (where === "jobright") {
      const page = await atFront(() => recommendedJobs({ openTab: open, closeTab, refresh: jobrightReads > 0&&!jobrightMore, detailed:true,continueFeed:jobrightMore,log }));
      const links=page.links;jobrightMore=page.more;batchComplete=page.complete===true;state.feedScan={source:'Jobright',...page.scan,at:Date.now()};remember();
      if(page.openedTabId)feedTabs.add(page.openedTabId);
      jobrightReads += 1;
      entries = page.entries||links.map((link) => ({ link }));
      heading = `${links.length} job(s) on Jobright's recommendations`;
    } else if (where === "boards") {
      // One slice of the roster per visit, so a run alternating the three
      // sources keeps finding new employers rather than spending its whole
      // first round on two hundred board requests.
      const seeds = rosterSeeds(rosterRecords(), {room:seed=>employers.room(seed.company,[seed.url])});
      const slice = seeds.slice(rosterCursor, rosterCursor + ROSTER_CHUNK);
      batchComplete = rosterCursor + ROSTER_CHUNK >= seeds.length;
      rosterCursor = batchComplete ? 0 : rosterCursor + ROSTER_CHUNK;
      const {postings,failures} = await harvestBoards(slice,{log});
      // A stated list of roles outranks the one inferred from history, so
      // when the applicant has named them their phrases are the whole test
      // and the history vocabulary steps aside. Without one, relevance is
      // inferred as before - a company board is mostly roles nobody here
      // applies for, so "no role filter" cannot mean "take all of it".
      const named = roleFilterActive(profile);
      const offered = named ? postings.filter(posting=>roleAllowed(posting.title,profile)) : postings;
      const wanted = relevantPostings(offered,{reference:named?roleTerms(profile.roleFilterTitles):rosterTitles,perEmployer:scheduleSettings.perCompanyPerDay});
      rawIds = postings.map(posting=>canonicalUrl(posting.applyUrl));
      entries = wanted.map(posting=>({link:posting.applyUrl,title:posting.title,company:posting.company,ats:atsOf(posting.applyUrl)}));
      heading = `${postings.length} posting(s) on the job boards of ${slice.length} employer(s) already seen, ${wanted.length} matching ${named?'your role filter':'the roles you apply for'}${failures.length?`, ${failures.length} board(s) unreadable`:''}`;
    } else {
      const page = await atFront(() => searchPage({ searchUrl: profile.hiringCafeUrl, page: hiringCafePage, openTab: open, closeTab, log }));
      const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
      batchComplete=page.last||page.page>=pages;
      const considered = page.jobs.filter((job) => job.applyUrl && !isLinkedIn(job.applyUrl));
      rawIds=page.jobs.map(job=>canonicalUrl(job.applyUrl||job.pageUrl||'')).filter(Boolean);
      const fillable = considered.filter((job) => FILLABLE.has(atsOf(job.applyUrl)));
      // A job on a board this bot fills is opened at its form. The rest are
      // written up for applying by hand, from the card's own page on Hiring
      // Cafe, which carries the posting's text where the employer's site
      // behind the apply address often does not.
      entries = considered.map((job) => ({ link: FILLABLE.has(atsOf(job.applyUrl)) || !job.pageUrl ? job.applyUrl : job.pageUrl, via: job.pageUrl, title: job.title, company: job.company, ats: atsOf(job.applyUrl) }));
      heading = `Hiring Cafe page ${page.page} of ${pages}: ${page.jobs.length} job(s), ${fillable.length} on a board this bot fills, ${considered.length - fillable.length} to write up for applying by hand`;
      hiringCafePage = page.last || page.page >= pages ? 1 : page.page + 1;
      await stateStorage.set({ hiringCafePage });
    }

    const unique = [];
    for (const entry of entries) {
      const id = identify(entry);
      if (unique.some((other) => identify(other) === id)) continue;
      const known=knownJobs.get(id);
      unique.push({...entry,company:entry.company||known?.company,title:entry.title||known?.title,...(verifiedOriginal(known)?{originalUrl:known.originalUrl||known.descriptionSource.url}:{})});
      // An employer the feeds named an hour ago is a board worth reading
      // today, not tomorrow, so the roster grows during the run.
      noteEmployer(entry.company||known?.company,entry.link,entry.originalUrl,known?.applyUrl);
    }
    discoveredInBatch=discovery.observe(rawIds||unique.map(identify));state.discovered=discovery.seen.size;state.lastActivityAt=Date.now();
    // Counted against the day as well as the run, because "did the feeds
    // supply three hundred jobs today" is a different question from "did
    // this run find anything new", and only the first one says whether the
    // target was ever reachable.
    dailyLedger=recordDiscovered(dailyLedger,discoveredInBatch);keepDay();remember();
    const protectionFor = entry => duplicates.matchCompany(entry.company || entry.application?.company,entry.link,entry.via,...historyUrls(entry.application || {})) || duplicates.match(entry.link,entry.via,...historyUrls(entry.application || {}));
    let exclusionsLogged = 0;
    const fresh = unique.filter((entry) => {
      const id = identify(entry);
      if (unfillable(entry) || unreachable(entry)) return false;
      if (health.quarantined(atsOf(entry.link))) return false;
      const protectedCompany = protectionFor(entry);
      if (protectedCompany) { if(exclusionsLogged++ < 3) log('info',`${entry.link || entry.application?.applyUrl} excluded: ${protectedCompany.company || 'company identified by saved application link'} is already protected.`); return false; }
      if (sent.has(id) || elsewhere.has(id) || resting(id) || seenThisRun.has(id)||extractionResting(knownJobs.get(id))) return false;
      // A listing that names the job is checked by name too, before a tab
      // is spent on it.
      const named = entry.application ? jobKey(entry.application.company, entry.application.title) : jobKey(entry.company, entry.title);
      return !(named && applied.has(named));
    });

    const duplicate = entry => Boolean(protectionFor(entry));
    const blocked = unique.filter(duplicate).length;
    const unsupported = unique.filter(unfillable).length;
    const unreached = unique.filter(unreachable).length;
    log("info", `${heading}; ${fresh.length} new to work through.${blocked ? ` ${blocked} excluded by applied history.` : ''}${unsupported ? ` ${unsupported} left out for applying through a board this bot cannot fill.` : ''}${unreached ? ` ${unreached} left out because the feed holds no employer link for them.` : ''}`);
    // The list, on disk before anything opens: what was found, what will be
    // done, and what was left alone and why.
    await keep(`links/${stamp()} ${where}.txt`, linksText({ heading, unique, fresh, sent, elsewhere, resting, identify, duplicate, unfillable, unreachable }));
    return fresh;
  };

  /** Fill the prepared application and record its outcome. */
  const workOne = async (entry, prepared, attempt = soloAttempt) => {
    const id = identify(entry);
    const application = prepared.application;
    let result = prepared.result;

    // The same posting can arrive by two roads - Jobright's link and Hiring
    // Cafe's apply address - and is only ever sent once. Checked here, at
    // sending time, because the other road may have been taken since this
    // one was prepared.
    // The employer's budget is not re-checked here: this attempt reserved
    // its slot when it was chosen, so asking "is there room" of a job that
    // is itself holding the room would refuse every second role.
    if (!result && (sent.has(canonicalUrl(application.applyUrl)) || applied.has(jobKey(application.company, application.title)))) {
      const started = prepared.started ?? Date.now();
      result = { id, company: application.company, title: application.title, applyUrl: application.applyUrl, status: "skipped", reason: "already applied to, found earlier by another route", detail: null, at: started, took: Date.now() - started };
    }

    if (!result) {
      state.attempted+=1;
      prepared.attempted=true;
      remember();
      result = await runOne(application, profile, attempt);
      // A page that changed under the filler, before anything was sent, is
      // tried once more from a fresh tab. The second attempt usually holds.
      if (result.status === "failed" && result.detail?.retry) {
        log("warn", `${application.company}: ${result.reason}; trying once more`);
        result = await runOne(application, profile, attempt);
      }
      // A form this bot fills but could not send - the board refused it, a
      // page would not save, the code never came - is not a loss: the
      // resume and letter are written and the answers worked out. They go
      // under "manual application/" with the reason, and the link on the
      // day's table, for the applicant to send by hand. Nothing of it goes
      // under "applied/", which holds only what was sent.
      if (result.status === "failed" && (application.resume || application.letter)) {
        const why = result.reason;
        const handed = { ...result, status: "manual", reason: `could not be sent (${why}); saved for you to send by hand`, detail: { ...(result.detail ?? {}), handoff: true, failed: why } };
        try {
          handed.detail.folder = await archive(application, profile, handed, null, { root: MANUAL_ROOT });
          log("warn", `${application.company} - could not be sent: ${why}. Saved to ${profile.exportFiles?'Downloads/job applied-folder/':'SQLite workspace: '}${handed.detail.folder} for you to send by hand.`);
        } catch (error) {
          log("warn", `${application.company} - could not write the manual application folder: ${error?.message ?? error}`);
        }
        result = handed;
      }
    }
    await recordResult(result);
    // The day's tally, not the run's: a worker that dies at four in the
    // afternoon must not let the evening's runs start the quota again.
    dailyLedger=recordOutcome(dailyLedger,result);keepDay();
    // And the same outcome read a second time, for what it says about the
    // night rather than about this job. One timed-out code is an employer
    // having a bad day; the fifteenth in a row is a mailbox nobody is
    // signed into, and only this call can tell those apart. See health.js.
    health.attempt(result);
    if(result.status==='submitted')state.submitted++;
    if(result.detail?.folder&&result.detail?.timings)await saveJson(result.detail.folder+'/Timing.json',{startedAt:new Date(application?.workflowClock?.at||result.at).toISOString(),formStartedAt:new Date(result.at).toISOString(),finishedAt:new Date(result.completedAt||Date.now()).toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,milliseconds:result.detail.timings,aiMode:result.detail.aiMode||null},{overwrite:true}).catch(error=>log('warn','Timing export: '+error.message));
    state.done += 1;
    const issue=result.detail?.failed||result.detail?.screenshotError;
    if(issue)state.lastError={at:Date.now(),message:`${result.company||result.applyUrl}: ${typeof issue==='string'?issue:JSON.stringify(issue)}`};

    const level = result.status === "failed" ? "error" : ['skipped','unconfirmed','manual'].includes(result.status) || result.detail?.failed ? "warn" : "ok";
    if (result.status === "manual") {
      state.review+=1;
      if(protectsCompany(result))
        {const named = jobKey(result.company, result.title);if (named) applied.add(named);}
      // Handed over partway - a Workday page wanting an ID - rather than
      // written up before opening: it still goes on the list of links to
      // finish by hand, and is not opened again.
      if (result.detail?.handoff && !manual.some((entry) => entry.id === id)) {
        elsewhere.add(id);
        await stateStorage.set({ elsewhere: [...elsewhere] });
        manual.push({ id, company: result.company, title: result.title, applyUrl: result.applyUrl, sourceUrl: result.sourceUrl, folder: result.detail.folder ?? "", reason: result.reason, at: result.at });
        await stateStorage.set({ manual });
        await keepOtherLinks(manual, result.at);
      }
    }
    const label = result.company || result.applyUrl;
    log(level, `${label}: ${result.status}${result.reason ? ` - ${result.reason}` : ""}`);

    if (result.status === "submitted" || result.status === "unconfirmed") {
      duplicates.add(result);
      sent.add(result.id);
      if (result.applyUrl) sent.add(canonicalUrl(result.applyUrl));
      const named = jobKey(result.company, result.title);
      if (named) applied.add(named);
      await stateStorage.set({ submitted: [...sent] });
      await keep("history/applied-links.txt", [...sent].join("\n"), { overwrite: true });
      // The same, by name: one line per job applied to, readable at a glance.
      await keep("history/applied-jobs.txt", appliedJobsText(await allResults()), { overwrite: true });
    } else if (result.status === "skipped" || result.status === "failed") {
      if (!elsewhere.has(id)) {
        passed[id] = Date.now();
        await stateStorage.set({ passed });
      }
    }

    // The index, rewritten whole after every result rather than at the end,
    // so a run that dies leaves the rows it had. Same for this run's log.
    if(prepared.attempted){
      await keep("history/applications.csv", resultsCsv(await allResults()), { overwrite: true, type: "text/csv" });
      await keep(`history/runs/${runStamp}.txt`, logText(state.log), { overwrite: true });
    }

    // Remedies and the halt decision after the result is on disk, so a
    // worker killed in the middle of treating a condition has still
    // recorded the application that raised it.
    if(await treatConditions())return false;
    if(dayLeft()<=0){state.stopReason={code:'target',message:`Today's target of ${scheduleSettings.dailyTarget} confirmed submissions is met.`};log('info',state.stopReason.message);remember();return false;}
    if(profile.maxSubmittedPerRun>0&&state.submitted>=profile.maxSubmittedPerRun){state.stopReason={code:'target',message:'Reached the target of '+profile.maxSubmittedPerRun+' confirmed submissions.'};remember();return false;}
    if (profile.maxPerRun > 0 && state.attempted >= profile.maxPerRun) {
      state.stopReason={code:'limit',message:`Reached the configured limit of ${profile.maxPerRun} application attempts. Set Application attempts per run to 0 to continue until no new jobs.`};
      log("info", `Stopping after ${state.attempted} application attempt(s), the ceiling set in settings. Skipped and unsupported listings do not use this limit.`);
      return false;
    }
    if (profile.delayMs > 0) await wait(profile.delayMs);
    return true;
  };


  /**
   * Capacity, the narrowest of three: this run's attempt limit, this run's
   * confirmed-submission target, and what is left of the day's quota. The
   * day is counted from the ledger rather than from `state`, so the third
   * run of an afternoon does not get three hundred applications of its own.
   */
  const dayLeft=()=>scheduleSettings.dailyTarget>0?Math.max(0,scheduleSettings.dailyTarget-freshDay().submitted):Number.MAX_SAFE_INTEGER;
  const remaining=()=>Math.min(runCapacity(profile,state),dayLeft());
  const jobClocks=new Map();
  // Once a stop has been asked for, the stage stops being the headline.
  // The monitor and the options pill both read `phase` straight out, so a
  // wind-down that went on reporting "generating" for two minutes is most
  // of why the button looked ignored - the one page that could have said
  // "stopping" was saying "Running" instead.
  const phase=value=>{const next=state.stopping?'stopping':value;if(state.phase!==next){state.phase=next;log('info','Stage: '+next);remember();}};
  const resultFor=(entry,status,reason)=>({id:identify(entry),company:entry.company||'',title:entry.title||'',applyUrl:entry.link,status,reason,at:Date.now(),detail:{}});
  const extractCandidate=async entry=>{
    const id=identify(entry);seenThisRun.add(id);jobClocks.set(id,startClock());
    jobActivity({url:id,title:entry.title,company:entry.company},'extracting','Reading the posting');
    let row=await getJob(id);
    // The pairing is the queue's word on which resume this job uses, so it
    // overrides whatever an earlier run generated - and dropping the pairing
    // from the queue has to drop the lock with it, or a job stays frozen on
    // a document nobody chose any more.
    if(row||entry.resumeId)row={...row,id,resumeId:entry.resumeId||row?.resumeId||'',resumeName:entry.resumeName||row?.resumeName||'',resumeLocked:Boolean(entry.resumeId)};
    if(row?.hold){jobActivity({...row,url:id},'held','Kept on hold by you');log('info',(row.company||entry.link)+' - kept on hold by you.');return null;}
    if(extractionResting(row)){jobActivity({...row,url:id},'review',row.reason||'Original posting is waiting for a scheduled retry.');return null;}
    if(verifiedOriginal(row)&&(duplicates.matchCompany(row.company,row.applyUrl,row.sourceUrl)||duplicates.match(row.applyUrl,row.sourceUrl))){
      const reason='Already applied to this posting, or this employer is on your never-approach list';await saveJob({...row,stage:'duplicate',reason});jobActivity({...row,url:id},'duplicate',reason);await workOne(entry,{application:null,result:{...resultFor(entry,'skipped',reason),company:row.company,title:row.title}});return null;
    }
    try{
      // Extraction and screening caches have independent expiry and signatures.
      const previous=row;
      if(!row?.jd||!verifiedOriginal(row)||row.postingCacheRevision!==2||Date.now()-(row.extractedAt||0)>1800000){
        row={...row,id,sourceUrl:entry.link,company:entry.company||row?.company||'',title:entry.title||row?.title||'',stage:'extracting'};await saveJob(row);
        const found=await sourceFromLink(entry.link,profile,entry.via,{...entry,originalUrl:(verifiedOriginal(previous)?previous.originalUrl:null)||entry.originalUrl||null,extractOnly:true,applied,employers,history:duplicates});
        if(!found.posting){
          const reason=found.skip||'Posting could not be extracted';await saveJob({...row,stage:found.duplicate?'duplicate':'skipped',reason});
          jobActivity({...row,url:id},found.duplicate?'duplicate':'skipped',reason);
          await workOne(entry,{application:null,result:resultFor(entry,'skipped',reason)});return null;
        }
        row={...previous,...found.posting,postingCacheRevision:2,stage:'extracted',extractionRetryAt:0};await saveJob(row);knownJobs.set(id,row);
      }
      if(duplicates.matchCompany(row.company,row.applyUrl,row.sourceUrl)||duplicates.match(row.applyUrl,row.sourceUrl)){
        await saveJob({...row,stage:'duplicate',reason:'Already applied to this posting, or this employer is on your never-approach list'});
        jobActivity({...row,url:id},'duplicate','Already applied to this posting, or this employer is on your never-approach list');
        await workOne(entry,{application:null,result:{...resultFor(entry,'skipped','Already applied to this posting, or this employer is on your never-approach list'),company:row.company,title:row.title}});return null;
      }
      if(row.mode==='manual'&&profile.manualMode!=='write'){
        await saveJob({...row,stage:'unsupported',reason:row.manualReason||'This application site needs manual completion.'});
        jobActivity({...row,url:id},'unsupported',row.manualReason||'This application site needs manual completion.');
        log('info',row.company+' - unsupported site listed in Jobs; it does not use the application limit.');return null;
      }
      jobActivity({...row,url:id},'extracted','Original description saved; waiting for screening');
      return {entry,job:row};
    }catch(error){if(stopsTheRun(error)||[401,403,409,429].includes(error.status))throw error;
      if(error.originalUnavailable){const reason='Original posting needs review: '+error.message;row={...row,id,sourceUrl:entry.link,jd:'',descriptionSource:null,screening:null,screeningKey:'',stage:'review',reason,extractionRetryAt:Date.now()+1800000};await saveJob(row);knownJobs.set(id,row);jobActivity({url:id,company:row?.company,title:row?.title},'review',reason);state.review++;log('warn',reason);remember();return null;}
      state.lastError={at:Date.now(),message:`${entry.link}: ${error.message}`};jobActivity({url:id},'failed',error.message);
      await saveJob({...row,id,sourceUrl:entry.link,stage:'failed',reason:error.message});log('warn',entry.link+' - extraction failed: '+error.message);return null;}
  };
  const screenCandidate=async item=>{
    const screeningClock=startClock();
    const {job}=item,signature=await screeningSignature(job,profile);
    jobActivity({ ...job,url:job.id},'screening','Checking optional rules and evidence');
    if(job.screeningKey!==signature||job.screening?.mode==='research-unavailable'||Date.now()-(job.screening?.checkedAt||0)>21600000){
      await saveJob({...job,stage:'screening'});
      job.screening=await screenJob(job,profile);job.screeningKey=signature;
    }
    state.screened++;if(job.screening.decision==='rejected')state.rejected++;if(job.screening.decision==='review')state.review++;
    if(job.screening.mode==='research-unavailable')state.lastError={at:Date.now(),message:job.company+' - '+job.screening.reason};
    job.screeningMs=elapsedClock(screeningClock);job.stage=job.screening.decision;job.reason=job.screening.reason;
    jobActivity({...job,url:job.id},job.stage,job.reason);
    await saveJob(job);remember();log(job.stage==='eligible'?'info':'warn',job.company+' - '+job.stage+': '+job.reason);
    return job.stage==='eligible'?item:null;
  };
  /**
   * One plausibility score per posting, for the whole batch at once.
   *
   * Here rather than in `screenCandidate` because this is the only stage
   * that holds the batch together - the point of the pass is that twelve
   * postings cost one call instead of twelve - and because it belongs
   * immediately before the expensive half: everything it rejects is a
   * resume and a letter not written, which is a hundred and nine seconds
   * of ChatGPT at the median.
   */
  const scoreCandidates=async items=>{
    if(!profile.fitCheckEnabled||!items.length)return items;
    const clock=startClock();
    for(const {job} of items)jobActivity({...job,url:job.id},'screening','Checking fit against your profile and resume');
    // The most recent resume, whichever kind it is: an uploaded one keeps
    // its extracted text, a generated one only its structure. Either is
    // the career, and the career is what the score turns on.
    const latest=(await allResumes().catch(()=>[])).filter(row=>row.sourceText||row.document).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0];
    const scored=await scoreFit(items.map(item=>item.job),{profile,answerPack:runAnswerPack,resume:latest?.sourceText||documentText(latest?.document)},{threshold:profile.fitThreshold});
    const kept=[];
    for(const {job,kept:keep,score,reason} of scored){
      const detail=score===null?reason:`Fit ${score}/100: ${reason}`;
      if(keep){job.fitScore=score;job.fitReason=detail;kept.push(items.find(item=>item.job.id===job.id));continue;}
      state.rejected++;
      await saveJob({...job,stage:'rejected',reason:detail,fitScore:score,fitReason:detail});
      jobActivity({...job,url:job.id},'rejected',detail);
      log('info',`${job.company} - rejected before writing anything: ${detail}`);
    }
    log('info',`Fit check: ${kept.length} of ${items.length} posting(s) worth writing for, in ${since(clock.at)}.`);
    remember();
    return kept.filter(Boolean);
  };
  const chooseCandidates=async rawItems=>chooseCompanyRoles(await scoreCandidates(rawItems));
  const chooseCompanyRoles=async items=>{
    const byId=new Map(items.map(item=>[item.job.id,item]));
    const {selected,alternatives}=selectCompanyRoles(items.map(i=>i.job),{limit:scheduleSettings.perCompanyPerDay,room:job=>employers.room(job.company,[job.sourceUrl,job.applyUrl])});
    for(const job of alternatives){const reason=`This employer's ${scheduleSettings.perCompanyPerDay} role(s) for today are already taken.`;await saveJob({...job,stage:'alternative',reason});jobActivity({...job,url:job.id},'alternative',reason);}
    return selected.map(job=>byId.get(job.id));
  };
  const prepareCandidate=async item=>{
    const {entry,job}=item;
    jobActivity({...job,url:job.id},'generating',job.resumeLocked?'Using the resume you paired with this posting':'Preparing resume and letter');
    if(job.mode==='manual'&&!manualSlot()){await saveJob({...job,stage:'unsupported',reason:'Manual document limit reached for this run.'});jobActivity({...job,url:job.id},'unsupported','Manual document limit reached.');return null;}
    if(!claimPreparation(job.company,job.sourceUrl,job.applyUrl)){const reason='This posting, or this employer\'s allowance for today, is already taken by another role in this run.';await saveJob({...job,stage:'alternative',reason});jobActivity({...job,url:job.id},'alternative',reason);return null;}
    try{
      // A supplied resume has no signature worth computing: nothing about
      // the posting, the profile or the template can change which bytes go
      // up, so the writer is not consulted and the cached-generation test
      // below is not reached.
      const key=job.resumeLocked?'':await documentSignature(job,profile);let application;
      const saved=job.resumeId&&(job.resumeLocked||job.documentKey===key)?await getResume(job.resumeId):null;
      if(job.resumeLocked){
        application=suppliedApplication(job,saved,candidateFrom(profile));
        log('info',job.company+' - uploading the resume you paired with this posting; nothing is generated for it.');
        const {resume,letter,...metadata}=application;job.applicationData=metadata;
      }
      else if(saved?.pdf&&job.applicationData&&saved.aiMode?.selected==='high'){
        application={...job.applicationData,resume:saved.pdf,letter:saved.letterPdf};log('info',job.company+' - reusing saved documents for this unchanged posting.');
        const researchAge=Date.now()-(application.compensation?.researchedAt||0);
        if(researchAge<0||researchAge>21600000)application.compensation={status:'not-requested'};
      }
      else{
        job.resumeId ||= crypto.randomUUID();job.documentKey=key;
        await saveJob({...job,stage:'generating'});
        if(saved?.pdf&&saved.documentKey===key)log('info',job.company+' - continuing from its saved High-mode resume.');
        const generated=await writeWithPatience(profile,{jd:job.jd,url:job.originalUrl||job.applyUrl,title:job.title,company:job.company,documentKey:key,libraryId:job.resumeId,deferSupporting:job.mode!=='manual'},saved);
        application={id:job.id,sourceUrl:job.sourceUrl,applyUrl:job.applyUrl,company:job.company,title:job.title,jd:job.jd,originalUrl:job.originalUrl,descriptionSource:job.descriptionSource,compensation:generated.compensation,aiMode:generated.aiMode,timings:{extraction:job.extractionMs||0,...generated.timings},letterText:generated.letterText,resumeText:generated.resumeText,currentRole:generated.resume?.experience?.[0]?.role||'',currentCompany:generated.resume?.experience?.[0]?.company||'',education:generated.resume?.education||null,resumeData:generated.resume||null,resume:generated.resumeBlob,resumeName:generated.resumeName,letter:generated.letterBlob,letterName:generated.letterName};
        const {resume,letter,...metadata}=application;job.applicationData=metadata;job.resumeId=generated.libraryId;job.documentKey=key;
      }
      application.libraryId=job.resumeId;application.workflowClock=jobClocks.get(job.id);application.timings={...application.timings,screening:job.screeningMs||0};
    job.stage='documents-ready';await saveJob(job);
      jobActivity({...job,url:job.id},job.stage,'Documents saved');
      if(job.mode==='manual'){
        const result={...resultFor(entry,'manual',job.manualReason),company:job.company,title:job.title,applyUrl:job.applyUrl};
        result.detail.folder=await archive(application,profile,result,null,{root:MANUAL_ROOT});await recordResult(result);
        await saveJob({...job,stage:'manual-ready',reason:job.manualReason});jobActivity({...job,url:job.id},'manual-ready',job.manualReason);return null;
      }
      return {...item,application};
    }catch(error){if(stopsTheRun(error)||[401,403,409,429].includes(error.status))throw error;
      // Nothing was opened and nothing was sent, so the slot this job was
      // holding goes back to the employer rather than costing it a role.
      employers.release(job.company,[job.sourceUrl,job.applyUrl]);
      if(stoppedMidRequest(error)){jobActivity({...job,url:job.id},job.stage,'The run was stopped while this was being prepared; it keeps its place in the queue.');return null;}
      state.lastError={at:Date.now(),message:`${job.company}: ${error.message}`};jobActivity({...job,url:job.id},'failed',error.message);
      await saveJob({...job,stage:'failed',reason:error.message});log('warn',job.company+' - documents could not be prepared: '+error.message);return null;}
  };
  /**
   * How long this job's board and employer still want to be left alone.
   *
   * Three hundred form posts to one board in an afternoon, from one
   * address, at machine speed, is the shape that gets an applicant blocked
   * rather than rate limited - and being blocked costs every remaining
   * application to that board, not just this one. The employer gap is the
   * same idea one level down: three roles at one company are allowed in a
   * day, but a recruiter who sees all three timestamped within a minute of
   * each other is looking at a script.
   *
   * This used to be a wait rather than a question, and the wait happened
   * inside the worker that was about to send - so six senders holding six
   * Greenhouse jobs all sat out the same forty-five seconds together,
   * while finished documents for Ashby and Workday waited behind them for
   * a slot. On a night measured at ninety-five per cent dead time, that is
   * not a rounding error. The gaps are unchanged and the question is now
   * asked of the whole ready pile at once, by `readyToSend` below: the
   * queue sends whichever document is free and nobody waits for anybody.
   */
  const paceWaitMs=job=>Math.max(
    boardWaitMs(dailyLedger,atsOf(job.applyUrl),scheduleSettings),
    employers.waitMs(job.company,[job.sourceUrl,job.applyUrl]),
  );
  /**
   * Which finished document goes next, or none of them yet.
   *
   * Nothing is awaited between this look and the booking in
   * `applyCandidate`, so two jobs on one board cannot both read a clear
   * gap.
   */
  const readyToSend=items=>{
    const free=items.findIndex(item=>paceWaitMs(item.job)<=0);
    if(free>=0)return free;
    // Said on the job that will go first, so the panel shows a queue
    // being paced rather than a queue that has stopped.
    const next=items.reduce((soonest,item)=>paceWaitMs(item.job)<paceWaitMs(soonest.job)?item:soonest,items[0]);
    if(next)jobActivity({...next.job,url:next.job.id},'applying',`Pacing ${atsOf(next.job.applyUrl)||next.job.company||'this employer'}: ${Math.ceil(paceWaitMs(next.job)/1000)}s before the next application there`);
    return -1;
  };
  /** Booked in the instant before the attempt starts, never awaited. */
  const takePace=(job,board)=>{
    // The gap is stretched while a board is cooling off. Multiplying here
    // rather than changing the setting keeps the applicant's own pace as
    // the thing the run goes back to the moment the board behaves again.
    dailyLedger=boardStarted(dailyLedger,board,{...scheduleSettings,boardGapMs:Math.round(scheduleSettings.boardGapMs*health.boardFactor(board))});keepDay();
    employers.started(job.company,[job.sourceUrl,job.applyUrl]);
  };
  /**
   * How long one attempt gets. Workday is an account, a mailed activation
   * and a wizard of six pages, so it is given its own, longer limit;
   * holding every board to the wizard's limit would mean a wedged
   * Greenhouse form costing twenty-five minutes of the day instead of ten.
   */
  const attemptDeadline=item=>atsOf(item.job.applyUrl)==='workday'?scheduleSettings.wizardDeadlineMs:scheduleSettings.attemptDeadlineMs;
  /** An attempt the queue stopped waiting for; see stagedBatch's applyDeadlineMs. */
  const abandonCandidate=async(item,ms)=>{
    const {job}=item,reason=state.stopping
      ? `the run was stopped after ${Math.round(ms/1000)} second(s) of this attempt; the queue let it go rather than hold the stop open`
      : `no answer after ${Math.round(ms/60000)} minute(s); the queue moved on without it`;
    dailyLedger=recordOutcome(dailyLedger,{status:'abandoned',reason:state.stopping?'attempt still open when the run was stopped':'attempt abandoned after its deadline'});keepDay();
    state.lastError={at:Date.now(),message:`${job.company||job.applyUrl}: ${reason}`};
    jobActivity({...job,url:job.id},'abandoned',reason);
    log('warn',`${job.company||job.applyUrl} - ${reason}. Its tab is left as it is; check Jobs for what it had reached.`);
    await saveJob({...(await getJob(job.id))||job,stage:'abandoned',reason}).catch(()=>{});
    remember();
  };
  const applyCandidate=async item=>{
    const {job}=item;
    const board=atsOf(job.applyUrl);
    // A board that has refused everything for a while is left alone for a
    // stretch rather than argued with - half an hour at first, doubling
    // while it keeps refusing. Checked here as well as in the
    // discovery filter because a posting chosen before the quarantine was
    // imposed is already in the batch, and opening it would be one more
    // request to a host that has stopped wanting them.
    if(health.quarantined(board)){jobActivity({...job,url:job.id},'held',`${board} is being left alone for a while after failing on every attempt, and will be tried again later today.`);employers.release(job.company,[job.sourceUrl,job.applyUrl]);return;}
    if(state.stopping)return;
    takePace(job,board);
    // One job's bad hour is not the day's. Extraction and preparation have
    // always absorbed their own failures and carried on; sending did not,
    // so a single unreadable tab threw all the way out of the run loop and
    // ended a shift that had three hundred jobs left in it. Only the
    // account-level refusals - a signed-out writer, an exhausted quota -
    // are worth stopping for, because those repeat for every job after.
    return slots.hold({company:job.company,board},attempt=>sendCandidate(item,attempt),{deadlineMs:attemptDeadline(item)}).catch(async error=>{
      if(stopsTheRun(error)||[401,403,409,412,429].includes(error?.status))throw error;
      if(stoppedMidRequest(error)){jobActivity({...job,url:job.id},job.stage,'The run was stopped while this attempt was open; its tab is left as it is.');return;}
      dailyLedger=recordOutcome(dailyLedger,{status:'failed',company:job.company,reason:error?.message||String(error)});keepDay();
      state.lastError={at:Date.now(),message:`${job.company||job.applyUrl}: ${error?.message??error}`};
      jobActivity({...job,url:job.id},'failed',error?.message??String(error));
      log('warn',`${job.company||job.applyUrl} - the application attempt failed: ${error?.message??error}. The queue continues.`);
      await saveJob({...job,stage:'failed',reason:error?.message??String(error)}).catch(()=>{});
      remember();
    });
  };
  const sendCandidate=async(item,attempt)=>{
    const {job,entry,application}=item;
    attempt.note('Filling and verifying the application');
    jobActivity({...job,url:job.id},'applying','Filling and verifying the application');
    const api=BOARD_API[atsOf(job.applyUrl)];
    if(api?.ids(job.applyUrl)){const latest=await api.posting(job.applyUrl,{refresh:true}).catch(()=>undefined);
      if(latest===null){await saveJob({...job,stage:'closed',reason:'Employer no longer lists this posting.'});jobActivity({...job,url:job.id},'closed','Employer no longer lists this posting.');return;}
      if(latest?.jd&&(latest.jd.trim()!==job.jd.trim()||latest.title!==job.title||companyKey(latest.company)!==companyKey(job.company)||(latest.metadata?.location||'')!==(job.metadata?.location||''))){await saveJob({...job,stage:'review',screeningKey:'',extractedAt:0,reason:'Posting changed after screening; recheck it before applying.'});jobActivity({...job,url:job.id},'review','Posting changed after screening; recheck it.');return;}}
    await saveJob({...job,stage:'applying'});
    await workOne(entry,{application,result:null},attempt);
    const result=(await allResults()).find(row=>row.id===application.id);
    // The questions this attempt could not answer travel onto the row with
    // the outcome, so the Questions page can offer the job back once they
    // are answered. Cleared when the attempt raised none, or an answered
    // question would keep resuming a job that parked on something else.
    const asked=blockedBy.get(job.id)??[];blockedBy.delete(job.id);
    await saveJob({...await getJob(job.id),stage:result?.status||'review',reason:result?.reason||'',resultId:result?.id,blockedBy:asked});
    jobActivity({...job,url:job.id},result?.status||'review',result?.reason||'Application attempt finished');
  };

  try {
    let fallbackLogged=false,lastWorkerSave=0;
    const workers=configureChatGptWorkers({limit:profile.chatGptConcurrency,contextUrl:profile.chatGptProjectUrl||profile.resumeChatUrl,onRetry:info=>log('warn','ChatGPT refresh retry '+info.retry+'/'+info.limit+': '+info.message),onChange:value=>{
      if(state.aiWorkers?.effective===1&&value.effective===2){fallbackLogged=false;log('info','ChatGPT recovered after four healthy requests; two workers are available again.');}
      const structural=!state.aiWorkers||state.aiWorkers.busy!==value.busy||state.aiWorkers.effective!==value.effective;
      state.aiWorkers=value;if(value.reason&&!fallbackLogged){fallbackLogged=true;log('warn',value.reason);}
      const progress=Math.max(0,...(value.tasks||[]).map(t=>t.lastProgressAt||0));state.lastActivityAt=Math.max(state.lastActivityAt,progress);
      if(structural||Date.now()-lastWorkerSave>15000){lastWorkerSave=Date.now();remember();}
    }});
    log('info',workers.effective===2?'ChatGPT: up to 2 concurrent requests; research uses temporary chats and resumes use project chats.':profile.chatGptConcurrency===2&&!workers.contextSupported?'ChatGPT: sequential mode because this context is a standalone conversation. Choose a project for parallel work.':'ChatGPT: sequential mode selected.');
    // The loaded list first, then the sites in turn.
    let turn = -1;
    let exhausted=false;
    const completedFeeds=new Set();
    const retired=new Set();
    let going = true;

    /**
     * Resumes written by an earlier run, sent before anything new is
     * discovered.
     *
     * Writing and sending are two different jobs that fail for two
     * different reasons - writing needs ChatGPT, sending needs a browser
     * and a board that is answering - and the handoff between them has
     * always been a row in SQLite at `documents-ready`. What was missing
     * is anybody picking that row up again. A run that was stopped, or
     * that hit its target, or whose board went quarantined with documents
     * already banked, left finished work on the floor: the next run began
     * at discovery and wrote new resumes for new postings while the old
     * ones aged out.
     *
     * So the bank is drained first. It is the cheapest work available -
     * `prepareCandidate` reuses documents it finds still valid and only
     * regenerates what has gone stale - and it is the work most likely to
     * be lost if it waits, because the compensation research inside a
     * document expires after six hours and postings close.
     *
     * Everything goes through the same batch machinery as a fresh
     * posting, deliberately: the per-employer limits, the board pacing,
     * the duplicate claim and the daily target are not things a second
     * code path should be trusted to reimplement.
     */
    const drainBanked = async () => {
      const banked = bankedJobs(await allJobs().catch(() => []), {
        seen: seenThisRun,
        duplicate: (job) => duplicates.matchCompany(job.company, job.applyUrl, job.sourceUrl) || duplicates.match(job.applyUrl, job.sourceUrl),
      });
      if (!banked.length) return false;
      log('info', `${banked.length} posting(s) already have documents written and not yet sent; sending those before anything else.`);
      const entries = banked.map((job) => ({ entry: { link: job.sourceUrl || job.applyUrl, company: job.company, title: job.title, resumeId: job.resumeLocked ? job.resumeId : '' }, job }));
      for (const { job } of entries) { seenThisRun.add(job.id); jobClocks.set(job.id, startClock()); knownJobs.set(job.id, job); }
      for (let offset = 0; offset < entries.length && !state.stopping && remaining() > 0; offset += scheduleSettings.attemptConcurrency * 2) {
        await stagedBatch(entries.slice(offset, offset + scheduleSettings.attemptConcurrency * 2), {
          // Already extracted, already screened, already scored for fit -
          // all of that is why there is a document. Re-running any of it
          // would be paying twice for an answer that is on the row.
          extract: (item) => item, screen: (item) => item, choose: chooseCompanyRoles,
          prepare: prepareCandidate, apply: applyCandidate, remaining,
          prepareConcurrency: workers.effective, applyConcurrency: scheduleSettings.attemptConcurrency,
          readyBacklog: scheduleSettings.documentBacklog, applyDeadlineMs: attemptDeadline, stopGraceMs: STOP_GRACE_MS, pickReady: readyToSend,
          onAbandoned: (item, ms) => { abandonCandidate(item, ms).catch(() => {}); },
          stopped: () => state.stopping, phase,
        });
      }
      return true;
    };
    await drainBanked();

    while (going && !state.stopping) {
      // A source retired earlier in this run whose backoff has run out. A
      // run that keeps going all night would otherwise never touch it
      // again, however long ago the outage ended.
      for (const name of health.sourcesDue()) {
        if (!retired.delete(name)) continue;
        discovery.revive(name);
        log('info', `Trying ${SOURCE_NAMES[name] || name} again.`);
      }
      const live = visits.filter((name) => !retired.has(name));
      if (turn >= 0 && live.length === 0) break;
      const where = turn < 0 ? "loaded" : live[turn % live.length];
      turn += 1;

      let fresh = [];
      let sourceFailed=false;discoveredInBatch=0;
      phase('discovering');state.discoverySource=where;
      if (where !== "loaded" || loaded.length + prepared.length > 0) {
        try {
          fresh = await fetchBatch(where);
        } catch (error) {
          if (stopsTheRun(error)) throw error;
          sourceFailed=true;
          state.lastError={at:Date.now(),message:`${where}: ${error?.message??error}`};
          log("warn", `Could not read ${where === "jobright" ? "Jobright's recommendations" : where === "hiringcafe" ? "the Hiring Cafe search" : SOURCE_NAMES[where] || "the loaded list"}: ${error?.message ?? error}`);
          // Three failures running is a source that is broken rather than
          // unlucky, and this used to end the night over it. That throws
          // away the sources still working to punish the one that is not,
          // which is the wrong way round when two of three are healthy. It
          // is retired instead, under a condition that stands on the panel
          // until morning - a dead source has to be loud, but it does not
          // have to be fatal unless it was the last one.
          if(discovery.failure(where)){
            retired.add(where);discovery.retire(where);
            const fatal=sources.every(name=>retired.has(name));
            health.source(where,{ok:false,message:error?.message??String(error),fatal});keepHealth();
            log('warn',`${SOURCE_NAMES[where]||where} has failed three times running and is dropped from this run. ${fatal?'It was the last source left, so there is nothing further to discover from.':`The run continues on ${sources.filter(name=>!retired.has(name)).map(name=>SOURCE_NAMES[name]||name).join(' and ')}.`}`);
            if(fatal)throw new Error(`Every discovery source is unreadable; the last was ${where}: ${error.message}`);
          }
        }
      }

      if (fresh.length > 0) {
        state.total += fresh.length;
        remember();

        fresh.sort((a,b)=>applicationPriority(b,knownJobs.get(identify(b)))-applicationPriority(a,knownJobs.get(identify(a))));
        // How many postings are read and screened together, which is a
        // different question from how many can be worked on at once. It
        // used to be the smaller of the two, and the smaller was always
        // the worker count: with two ChatGPT workers and two attempts the
        // setting asking for twelve produced batches of two, so the whole
        // pipeline ran two jobs deep and the backlog below had nothing to
        // hold. The screening size leads now, and concurrency only raises
        // it - a batch smaller than the number of workers would idle them.
        const batchSize=Math.max(normalizeFilters(profile).screeningBatchSize,workers.effective,scheduleSettings.attemptConcurrency);
        for(let offset=0;offset<fresh.length&&!state.stopping&&remaining()>0;offset+=batchSize){
          await stagedBatch(fresh.slice(offset,offset+batchSize),{extract:extractCandidate,screen:screenCandidate,choose:chooseCandidates,prepare:prepareCandidate,apply:applyCandidate,remaining,prepareConcurrency:workers.effective,screenConcurrency:workers.effective,applyConcurrency:scheduleSettings.attemptConcurrency,readyBacklog:scheduleSettings.documentBacklog,applyDeadlineMs:attemptDeadline,stopGraceMs:STOP_GRACE_MS,pickReady:readyToSend,onAbandoned:(item,ms)=>{abandonCandidate(item,ms).catch(()=>{});},stopped:()=>state.stopping,phase});
        }
        if(remaining()<=0)going=false;
      }
      // Filtered and duplicate listings still count as newly discovered;
      // only a complete round without new URLs exhausts the feeds.
      if(where!=='loaded'&&!sourceFailed){exhausted=discovery.success(where,discoveredInBatch,batchComplete);if(batchComplete)completedFeeds.add(where);
        // New links, not postings seen: a feed answering with the same two
        // hundred jobs every round has found nothing, and counting that as
        // supply is how a night with nothing left to apply to reads as busy.
        health.discovery({found:discoveredInBatch,complete:batchComplete});keepHealth();}

      // A drought is the one condition that can become fatal while no
      // application is being made, so it has to be read here as well as
      // after a result, or a night of empty rounds would keep saying
      // "continuing" until morning.
      if(await treatConditions())break;

      if (!going || state.stopping) break;
      if (sources.length === 0) break;

      // Each site visited once: that is a run, unless told to keep going.
      const onePass = !profile.keepRunning && sources.every((name) => retired.has(name) || completedFeeds.has(name));

      // Discovery having nothing left is not the same as the run having
      // nothing left. A document written an hour ago and held back by a
      // captcha, a quarantined board or a worker Chrome shut down is work
      // already paid for, and ending here used to send the day to sleep
      // for twenty minutes on top of it. The feeds are asked again only
      // after the written work is gone.
      if ((exhausted || onePass) && await drainBanked()) continue;

      if (onePass){state.stopReason={code:'one-pass',message:'Finished one pass of the enabled feeds. Enable Continue until no new jobs in Job sources for repeated discovery.'};break;}

      // A whole round with nothing to apply to, and nothing banked: the
      // run is done.
      if (exhausted) {
        state.stopReason={code:'exhausted',message:'No new jobs found across a complete round of the enabled feeds.'};
        log("info", `Nothing left to apply to on ${rotation}. Finishing.`);
        break;
      }
      if(sourceFailed)await wait(2000);
    }
    if (state.stopping) log("info", "Stopped.");
  } catch (error) {
    state.lastError={message:error.message||String(error),at:Date.now(),status:error.status||null};state.stopReason={code:'error',message:'Run stopped: '+state.lastError.message};
    // One unusable key, an exhausted quota or a rejected secret would otherwise
    // be rediscovered once per remaining job, each time costing a page load.
    //
    // Only a refused identity is named as a condition. An exhausted quota
    // and a rejected concurrent request also end the run, and both lift by
    // themselves within hours - naming those would stop autopilot for the
    // night over something that would have fixed itself before the next
    // retry, which is the opposite of the point.
    if([401,403].includes(error?.status)){health.service('writer',{ok:false,status:error.status,message:error.message||String(error)});keepHealth();}
    log("error", `Stopping: ${error?.message ?? error}`);
  } finally {
    await closeChatGptWorkers().catch(error=>log('warn',error.message));
    for(const tabId of feedTabs){const tab=await chrome.tabs.get(tabId).catch(()=>null);if(/^https:\/\/jobright\.ai\/jobs\/recommend/.test(tab?.url||''))await closeTab(tabId).catch(()=>{});}
    clearInterval(heartbeat);
    clearInterval(tabSweep);
    clearInterval(diskWatch);
    // Whatever is still open and was not left open on purpose is nobody's
    // now. The sweep above has stopped, so this is what lets the next run
    // find and close what this one could not - and the next run is the
    // only thing that will, which is why it is said here rather than left
    // to a service worker that may outlive a dozen runs.
    await releaseOwned({keepCaptcha:Boolean(profile.keepCaptchaTabs)}).catch(()=>{});
    state.running = false;
    if(state.stopping)state.stopReason=stoppedReason('after the current operations finished');
    state.stopReason ||= {code:'complete',message:'Finished all loaded jobs. No additional feeds are enabled.'};
    state.finishedAt=Date.now();
    state.phase = state.stopping ? 'stopped' : 'finished';
    const total = runTotal();
    log("info", `Finished: ${state.submitted} confirmed submission(s), ${state.attempted} application attempt(s), ${state.screened} screened, ${state.rejected} rejected, ${state.review} held for review; ${state.total} discovered.${total.calls > 0 ? ` Model spend this run: ${describeSpend(null, total)}.` : ""}`);
    remember();
    await keep("history/applications.csv", resultsCsv(await allResults()), { overwrite: true, type: "text/csv" });
    await keep(`history/runs/${runStamp}.txt`, logText(state.log), { overwrite: true });
    await durableRun.flush();
    if (runAgain) {
      runAgain = false;
      setTimeout(run, 0);
    }
  }
}

/**
 * Writes a file into the record, or logs that it could not. The record is a
 * convenience beside the run, never a reason to stop one.
 */
async function keep(path, content, options) {
  try {
    await save(path, content, options);
  } catch (error) {
    log("warn", `Could not write ${path}: ${error?.message ?? error}`);
  }
}

/** The links file: what one visit found, what will be done, and what was left alone. */
function linksText({ heading, unique, fresh, sent, elsewhere, resting, identify, duplicate = () => false, unfillable = () => false, unreachable = () => false }) {
  const show = (entry) => entry.application ? `${entry.application.company} - ${entry.application.title}` : entry.link;
  const lines = [`# ${new Date().toLocaleString()}`, `# ${heading}`, ""];
  lines.push(`# To work through (${fresh.length})`);
  for (const entry of fresh) lines.push(show(entry));
  const left = unique.filter((entry) => !fresh.includes(entry));
  if (left.length > 0) {
    lines.push("", `# Left alone (${left.length})`);
    for (const entry of left) {
      const id = identify(entry);
      const why = duplicate(entry) ? 'already applied or submission requires review' : unfillable(entry) ? `applies through ${entry.ats}, which this bot cannot fill` : unreachable(entry) ? "the feed holds no employer link for it; it applies only through the aggregator" : sent.has(id) ? "sent" : elsewhere.has(id) ? "applies elsewhere" : resting(id) ? "skipped or failed recently" : "seen earlier this run";
      lines.push(`${show(entry)}  (${why})`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------- messages */

async function probeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");

  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["src/fill.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func: () => (window.__ghApply ? window.__ghApply.probe() : null),
  });

  return results
    .filter((result) => result.result)
    .map((result) => ({ frameId: result.frameId, ...result.result }))
    .sort((a, b) => b.fields.length - a.fields.length);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'database') {
    const metadata={build:BUILD_VERSION,protocol:DATABASE_PROTOCOL};
    if (_sender.id !== chrome.runtime.id || !_sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({ ...metadata,ok: false, error: 'Only extension pages can access the database.' }); return false; }
    if (message.request?.action === 'import' && (state.running || starting)) { respond({ ...metadata,ok: false, error: 'Stop the run before restoring a backup.' }); return false; }
    databaseRequest(message.request).then(value => respond({ ...metadata,ok: true, value }), error => respond({ ...metadata,ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "run") {
    // Pressing Run by hand is the applicant saying they have looked at
    // whatever stopped the night, so the conditions go with it. Only the
    // button does this: a supervisor allowed to clear its own diagnosis
    // would climb the ladder to a stop and then step straight back off it.
    health.forget();
    keepHealth();
    // Pushed to storage before the run starts, not on the usual five-second
    // delay. The first thing a run does is reload the health record from
    // storage, so a cleared record still sitting in the write buffer is
    // overwritten by the condition it was cleared to lift - and the day
    // could not be restarted by hand at all, which is the one escape hatch
    // a stop condition is supposed to leave open.
    durableHealth.flush().then(run, run);
    respond({ started: true });
    return false;
  }
  if (message?.type === "stop") {
    requestStop("user", state.running || starting
      ? "Stop requested. Nothing new is being started; whatever is already open is being wound down now."
      : "");
    // Stop has to mean stop. A supervisor that starts another run a minute
    // after the applicant pressed the button is a bot nobody can switch
    // off, so the button switches autopilot off with it.
    stopAutopilot().catch(() => {});
    // The press is written through to storage rather than left on the
    // five-second buffer: Chrome ends this worker whenever it likes, and
    // the saved progress is the only thing the next one will know.
    durableRun.flush().catch(() => {});
    respond({ stopping: true, phase: state.phase });
    return false;
  }
  // The options page writes the schedule straight to storage; this is how
  // the worker hears about it, since an alarm nobody armed never fires.
  if (message?.type === "schedule") {
    loadSchedule()
      .then(() => (scheduleSettings.autopilot ? Promise.resolve(armAutopilot()).then(() => stateStorage.set({ autopilotResumeAt: 0 })) : chrome.alarms.clear(AUTOPILOT_ALARM)))
      .then(() => respond({ ok: true, schedule: scheduleSettings }), (error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "state") {
    restored.then(() => respond({ ...state, running: state.running || starting }));
    return true;
  }
  if (message?.type === "probe") {
    probeActiveTab().then(
      (report) => respond({ ok: true, report }),
      (error) => respond({ ok: false, error: error?.message ?? String(error) }),
    );
    return true;
  }
  return false;
});

/**
 * The toolbar button opens the side panel.
 *
 * Chrome ignores openPanelOnActionClick while the action still declares a
 * default_popup, so the popup was removed from the manifest rather than left
 * to win the click silently. The behaviour is re-asserted on every worker
 * boot because the flag belongs to the browser profile, not the extension,
 * and a profile restored from a backup comes back without it - which reads
 * as a toolbar button that does nothing at all.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.warn("Side panel", error));
