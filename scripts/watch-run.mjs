/**
 * The night, as it is actually going, read from outside it.
 *
 * The monitor page answers this for a person sitting in front of it; this
 * answers it for whoever is checking in every twenty minutes and needs the
 * four things that decide whether to let the run carry on:
 *
 *   - what has actually been sent, and to whom, with the board's own
 *     receipt wording where there is one;
 *   - whether any posting has been attempted twice, which is the one
 *     failure that is worth stopping the night over;
 *   - whether any employer is claimed with no application behind it,
 *     which is the burn the release path exists to prevent and the only
 *     way to tell whether it is working is to look;
 *   - the rate, against the time left in the day.
 *
 * Read-only. Nothing here writes, so checking in cannot become part of
 * what is being measured.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { statfs } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
let seen = {};
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    seen = await page.evaluate(async () => {
      const { allResults, allHistory, allJobs, stateStorage, db } = await import("./store.js");
      const state = await chrome.runtime.sendMessage({ type: "state" });
      const results = await allResults();
      const history = await allHistory();
      const jobs = await allJobs();
      const kv = await stateStorage.get(["dailyLedger", "healthState", "autopilotResumeAt", "schedule"]);
      const stats = await db({ action: "stats" }).catch(() => null);
      const estimate = (await navigator.storage?.estimate?.()) ?? {};
      return {
        at: Date.now(),
        running: state?.running, phase: state?.phase, stopReason: state?.stopReason, lastError: state?.lastError,
        startedAt: state?.startedAt, finishedAt: state?.finishedAt, heartbeatAt: state?.heartbeatAt,
        counts: { total: state?.total, done: state?.done, attempted: state?.attempted, submitted: state?.submitted },
        activeJobs: state?.activeJobs ?? {},
        day: state?.day ?? null,
        health: state?.health ?? null,
        ledger: kv.dailyLedger ?? null,
        autopilotResumeAt: kv.autopilotResumeAt ?? 0,
        results: results.map((row) => ({ id: row.id, company: row.company, title: row.title, status: row.status, reason: row.reason, at: row.at, applyUrl: row.applyUrl, folder: row.detail?.folder ?? "", boardSaid: row.detail?.boardSaid ?? "" })),
        history: history.map((row) => ({ id: row.id, kind: row.kind, company: row.company, title: row.title, status: row.status ?? "", applyUrl: row.applyUrl ?? "" })),
        jobStages: jobs.reduce((into, job) => ({ ...into, [job.stage]: (into[job.stage] || 0) + 1 }), {}),
        log: (state?.log ?? []).slice(-40),
        dbBytes: stats?.bytes ?? 0,
        originFree: Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0)),
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
}

const fs = await statfs("/home/administrator/Downloads");
seen.filesystemFree = fs.bavail * fs.bsize;
await writeFile("test-results/watch-run.json", JSON.stringify(seen, null, 2));

const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
const sent = seen.results.filter((row) => ["submitted", "unconfirmed"].includes(row.status));
const claims = seen.history.filter((row) => row.kind === "submission");

// A claim with no sent result behind it is the burn A4 exists to prevent -
// but only once the attempt is over. The claim is taken in the instant
// before Submit, so an attempt still waiting on a mailed code is holding a
// perfectly correct claim and reading it as a burn would cry wolf every
// time the system is working exactly as intended.
const sentUrls = new Set(sent.map((row) => row.applyUrl));
const inFlight = new Set(Object.keys(seen.activeJobs ?? {}));
const stranded = claims.filter((row) => row.applyUrl && !sentUrls.has(row.applyUrl) && !inFlight.has(row.id?.replace(/^submission:/, "")) && !inFlight.has(row.applyUrl));

// Two results for one posting means it was attempted twice. The one thing
// worth stopping the night over.
const byUrl = new Map();
for (const row of seen.results) byUrl.set(row.applyUrl, (byUrl.get(row.applyUrl) ?? 0) + 1);
const twice = [...byUrl.entries()].filter(([, count]) => count > 1);

console.log(`phase ${seen.phase}  running ${seen.running}  heartbeat ${seen.heartbeatAt ? `${Math.round((Date.now() - seen.heartbeatAt) / 1000)}s ago` : "none"}`);
if (seen.stopReason) console.log(`stopped: [${seen.stopReason.code}] ${seen.stopReason.message}`);
if (seen.lastError) console.log(`last error: ${seen.lastError.message}`);
console.log(`results ${seen.results.length}  sent ${sent.length}  claims ${claims.length}  stages ${JSON.stringify(seen.jobStages)}`);
if (seen.day) console.log(`day: ${seen.day.submitted}/${seen.day.target} submitted, ${seen.day.attempted} attempted, rate ${seen.day.rate?.toFixed(1)}/h, needed ${seen.day.needed?.toFixed(1)}/h, ${seen.day.hoursLeft?.toFixed(1)}h left`);
console.log(`disk: filesystem ${mb(seen.filesystemFree)} free, origin ${mb(seen.originFree)}, database ${mb(seen.dbBytes)}`);

if (seen.health?.conditions?.length) for (const c of seen.health.conditions) console.log(`CONDITION [${c.severity}] ${c.name}: ${c.title}`);
console.log(`\nSENT (${sent.length}):`);
for (const row of sent) console.log(`  ${row.status.padEnd(11)} ${row.company} - ${row.title}${row.folder ? `  [${row.folder}]` : ""}`);

if (stranded.length) { console.log(`\n*** ${stranded.length} CLAIM(S) WITH NO APPLICATION BEHIND THEM ***`); for (const row of stranded) console.log(`  ${row.company} ${row.applyUrl}`); }
if (twice.length) { console.log(`\n*** ${twice.length} POSTING(S) ATTEMPTED TWICE ***`); for (const [url, count] of twice) console.log(`  ${count}x ${url}`); }
if (!stranded.length && !twice.length) console.log(`\nno burned employers, no posting attempted twice`);

const failed = seen.results.filter((row) => !["submitted", "unconfirmed"].includes(row.status));
if (failed.length) {
  console.log(`\nOTHER OUTCOMES (${failed.length}):`);
  const reasons = new Map();
  for (const row of failed) {
    const key = `${row.status}: ${String(row.reason).split(/[;(]|\s-\s/)[0].slice(0, 90)}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}x ${reason}`);
}
