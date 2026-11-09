import { stateStorage } from './store.js';
/**
 * The run window.
 *
 * A popup dies the moment it loses focus, so it owns none of the run - it asks
 * the service worker for the state it missed on open, then follows along. The
 * run continues whether this is on screen or not.
 */

import { canonicalUrl } from "./join.js";
import { allLinks, allResults, allHistory, readProfile } from "./store.js";
import { resultsCsv } from "./vault.js";
import { missingFromProfile,missingProfileFields } from "./profile.js";
import {companyResolved} from './companies.js';
import {historyIndex} from './history.js';
import {reloadExtension} from './update.js';
import {runSummary} from './run-policy.js';

const $ = (id) => document.getElementById(id);
let canRun = false;
$('monitor').href=chrome.runtime.getURL('src/options.html#monitor');
function runtimeStatus(state){const target=$('run-status');target.textContent=state?.running?`${state.phase||'Running'} · ${state.attempted||0} application attempts · ${state.aiWorkers?.busy||0} AI requests active`:runSummary(state);target.className=state?.stopReason?.code==='error'?'status error':'note';}

function line(entry) {
  const node = document.createElement("div");
  node.className = entry.level;
  node.textContent = new Date(entry.at).toLocaleTimeString() + "  " + entry.message;
  if (entry.detail) node.title = JSON.stringify(entry.detail, null, 2);
  $("log").append(node);
  $("log").scrollTop = $("log").scrollHeight;
}

function setRunning(running, done, total, stopping = false) {
  $("run").disabled = running || !canRun;
  // Already pressed, and pressing it again does nothing a second time.
  // Leaving it live through a wind-down invited the second press that used
  // to queue another run behind the one being stopped.
  $("stop").disabled = !running || stopping;
  $("run").textContent = running ? (stopping ? "Stopping - finishing what is open" : total > 0 ? `Running - ${done} outcomes from ${total} jobs` : "Running") : "Run";
  $("progress").hidden = !running && done === 0;
  $("progress").firstElementChild.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}

async function refresh() {
  const [profile, state] = await Promise.all([
    readProfile(),
    chrome.runtime.sendMessage({ type: "state" }),
  ]);

  const sent = new Set((await stateStorage.get("submitted")).submitted ?? []);
  const history = await allHistory(), index=historyIndex(history);
  const unresolved=history.filter(r=>r.kind==='external' && !companyResolved(r));

  // The list loaded on the options page, not the sheet. Opening the popup
  // makes no network request, and the number shown is the number that will
  // actually be worked through.
  const { links } = await allLinks();
  const waiting =
    links.filter((link) => !sent.has(canonicalUrl(link)) && !index.match(link) && !index.matchCompany('',link)).length;

  const sources = [];
  if (profile.autoFetch && profile.jobrightRecommend) sources.push("Jobright");
  if (profile.autoFetch && /^https:\/\/(?:www\.)?(?:hiringcafe\.com|hiring\.cafe)\//i.test(String(profile.hiringCafeUrl ?? "").trim())) sources.push("Hiring Cafe");

  const parts = [];
  if (waiting > 0) parts.push(`${waiting} loaded link${waiting === 1 ? "" : "s"} to work through`);
  if (sources.length > 0) parts.push(`then ${sources.join(" and ")} in turn${profile.keepRunning ? ", until no new jobs" : ""}`);
  if(waiting>0||sources.length>0)parts.push(profile.maxPerRun>0?`limit: ${profile.maxPerRun} application attempts`:'no application-attempt limit');
  if (sent.size > 0) parts.push(`${sent.size} already submitted`);

  $("ready").textContent =
    parts.length === 0
      ? "Add job links in Workspace → Job sources to start."
      : `${parts.join("; ")}.`;

  $("mode").hidden = false;
  if (profile.dryRun) {
    $("mode").className = "status";
    $("mode").textContent = "Review mode: forms are filled and left open before final submission.";
  } else {
    $("mode").className = "status error";
    $("mode").textContent = "Automatic submission is enabled.";
  }

  const missing = missingFromProfile(profile);
  canRun = missing.length === 0 && unresolved.length === 0 && (waiting > 0 || sources.length > 0);
  if (missing.length) $("ready").textContent = `Finish setup in Workspace: ${missing.join(", ")}.`;
  else if(unresolved.length) $('ready').textContent=`Set the company name for ${unresolved.length} past application(s) before running.`;
  const actions=$('setup-actions'); actions.replaceChildren();
  const linksToFix=missing.length ? missingProfileFields(profile).map(([key,label])=>({label:`Set ${label}`,hash:`profile/focus/${key}`})) : unresolved.length ? [{label:'Resolve company names',hash:'history'}] : !canRun ? [{label:'Add job links',hash:'sources'}] : [];
  for(const {label,hash} of linksToFix) {
    const link=document.createElement('a'); link.textContent=label; link.href=chrome.runtime.getURL(`src/options.html#${hash}`); link.target='_blank'; link.style.display='block'; actions.append(link);
  }
  actions.hidden=!linksToFix.length;
  $('run').title=canRun ? 'Start applications; one application per company' : $('ready').textContent;
  $("run").disabled = !canRun;
  $("log").innerHTML = "";
  for (const entry of state?.log ?? []) line(entry);
  setRunning(state?.running ?? false, state?.done ?? 0, state?.total ?? 0, state?.stopping ?? false);
  runtimeStatus(state);
  if (state?.running) poll();
}

let polling = null;
function poll() {
  if (polling) return;
  polling = setInterval(async () => {
    const state = await chrome.runtime.sendMessage({ type: "state" }).catch(() => null);
    if (!state) return;
    setRunning(state.running, state.done, state.total, state.stopping);
    runtimeStatus(state);
    if (!state.running) {
      clearInterval(polling);
      polling = null;
      refresh();
    }
  }, 1000);
}

/* ---------------------------------------------------------------- actions */

$("run").addEventListener("click", async () => {
  const profile = await readProfile();
  if (!profile.dryRun) {
    const ok = confirm(
      "Automatic submission is enabled. Submit applications from your loaded links and enabled feeds?",
    );
    if (!ok) return;
  }
  $("log").innerHTML = "";
  await chrome.runtime.sendMessage({ type: "run" });
  setRunning(true, 0, 0);
  poll();
});

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  $("stop").disabled = true;
  line({ at: Date.now(), level: "warn", message: "Stopping. Nothing new is being started, requests in flight are being cancelled, and autopilot is off." });
});

/**
 * Dumps the form on whatever is open, which is how the field map gets written
 * against pages that exist rather than pages as remembered.
 */
$("probe").addEventListener("click", async () => {
  $("log").innerHTML = "";
  line({ at: Date.now(), level: "info", message: "Reading the form on this tab..." });

  const response = await chrome.runtime.sendMessage({ type: "probe" });
  if (!response?.ok) {
    line({ at: Date.now(), level: "error", message: response?.error ?? "could not read the tab" });
    return;
  }

  for (const frame of response.report) {
    line({
      at: Date.now(),
      level: "ok",
      message: `frame ${frame.frameId}: ${frame.counts.total} fields, ${frame.counts.required} required, ${frame.counts.files} uploads, ${frame.counts.comboboxes} comboboxes`,
    });
    for (const field of frame.fields) {
      line({
        at: Date.now(),
        level: "info",
        message: `  [${field.type}${field.required ? " *" : ""}] ${field.label || field.name || field.id}${
          field.options.length > 0 ? ` -> ${field.options.map((option) => option.label).join(" | ")}` : ""
        }`,
        detail: field,
      });
    }
  }

  // Said honestly, because the clipboard is refused often enough to matter: a
  // popup that loses focus mid-write gets nothing, and being told the report
  // was copied when it was not sends you off to paste an empty buffer.
  const copied = await navigator.clipboard
    .writeText(JSON.stringify(response.report, null, 2))
    .then(() => true, () => false);

  line({
    at: Date.now(),
    level: copied ? "ok" : "warn",
    message: copied
      ? "The full report is on the clipboard."
      : "The clipboard was refused. The fields are listed above, or press Export CSV.",
  });
});


$("export").addEventListener("click", async () => {
  const results = await allResults();
  if (results.length === 0) {
    line({ at: Date.now(), level: "warn", message: "No run has been recorded yet." });
    return;
  }

  // The same table the run keeps at job applied-folder/history/applications.csv.
  const csv = resultsCsv(results);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));

  // An anchor rather than chrome.downloads, which would mean asking for a
  // permission solely to write one file the browser can already write.
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `greenhouse-run-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  line({ at: Date.now(), level: "ok", message: `Exported ${results.length} result(s).` });
});

$("settings").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "log") line(message.entry);
});

refresh().catch(error=>{
  $('ready').textContent=error.needsReload ? error.message : `Could not load setup: ${error.message}`;
  $('run').disabled=true;
  if(error.needsReload) {
    const actions=$('setup-actions'),button=document.createElement('button');actions.replaceChildren();actions.hidden=false;
    button.id='reload-extension';button.className='ghost';button.textContent='Reload extension';
    button.addEventListener('click',async()=>{button.disabled=true;try{await reloadExtension();}catch(error){$('ready').textContent=error.message;button.disabled=false;}});
    actions.append(button);
  }
});
