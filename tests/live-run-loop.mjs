/**
 * The autopilot run loop itself, against live postings.
 *
 * Everything else that drives the apply module here supplies its own
 * services, and three of the module's services therefore have never run at
 * all: `tests/apply-corpus.mjs` passes no `documents`, no `verification`
 * and no `evidence`, so the cover-letter call, the mailbox wait and the
 * evidence folder are all stubbed out of existence in the only harness
 * that touches real pages. They exist solely in `moduleServices` inside
 * src/background.js, which is reachable only by starting a real run.
 *
 * So this starts one. The queue is replaced with named postings rather
 * than whatever the feeds would have produced, because a run that chooses
 * its own jobs would apply to companies nobody picked; LINKS is the whole
 * of what it may touch and `maxPerRun` is the second bound on it.
 *
 * DRY=1 (the default) runs with `profile.dryRun`, which parks every
 * attempt after filling. That is not a lesser version of the test: the
 * documents service is called while the form is being read and the
 * evidence service in the `finally`, so both are exercised in full, and
 * concurrency is whatever the run loop really does either way. Only the
 * Submit is missing. DRY=0 sends.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "";
const DRY = process.env.DRY !== "0";
const MAX = Number(process.env.MAX ?? 2);
const WAIT_MS = Number(process.env.WAIT_MS ?? 600000);
const LABEL = process.env.LABEL ?? (DRY ? "runloop-dry" : "runloop-submit");
const LINKS = (process.env.LINKS ?? "").split(/\s+/).filter(Boolean);

if (LINKS.length === 0) throw new Error("LINKS is required: the run may only touch postings named on the command line");

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
const report = { startedAt: new Date().toISOString(), dryRun: DRY, maxPerRun: MAX, links: LINKS };

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => (EXT_ID ? list.find((worker) => worker.url().includes(EXT_ID)) : list[0]);
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}; is it installed and awake?`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);

    // The feeds are switched off by name rather than trusted to be empty.
    // A run that quietly topped the queue up from Jobright would apply to
    // companies this test never named and cannot take back.
    report.profile = await page.evaluate(async ({ links, dry, max, project }) => {
      const { writeProfile, saveLinks, clearLinks } = await import("./store.js");
      const { buildQueue } = await import("./links.js");
      await clearLinks();
      await saveLinks(buildQueue([links.join("\n")]));
      const profile = await writeProfile({
        applyEngine: "module",
        dryRun: dry,
        autoFetch: false,
        jobrightRecommend: false,
        sheetUrl: "",
        hiringCafeUrl: "",
        pastedLinks: links.join("\n"),
        manualMode: "list",
        maxPerRun: max,
        maxSubmittedPerRun: 0,
        foregroundTabs: true,
        ...(project ? { chatGptProjectUrl: project } : {}),
      });
      return { applyEngine: profile.applyEngine, dryRun: profile.dryRun, maxPerRun: profile.maxPerRun, autoFetch: profile.autoFetch, jobrightRecommend: profile.jobrightRecommend, chatGptProjectUrl: profile.chatGptProjectUrl };
    }, { links: LINKS, dry: DRY, max: MAX, project: process.env.PROJECT ?? "" });
    console.log(`profile: ${JSON.stringify(report.profile)}`);

    report.started = await page.evaluate(() => chrome.runtime.sendMessage({ type: "run" }));
    console.log(`run started: ${JSON.stringify(report.started)}`);

    // Polled rather than awaited on an event, because the worker can be
    // torn down and respawned mid-run and an event listener would not
    // survive it. How many tabs the run is holding open at once is sampled
    // here too: it is the only direct evidence of whether two attempts are
    // really in flight together, and it cannot be recovered afterwards.
    const deadline = Date.now() + WAIT_MS;
    const samples = [];
    let last = "";
    while (Date.now() < deadline) {
      await page.waitForTimeout(4000);
      const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "state" })).catch(() => null);
      const tabs = context.pages().filter((other) => /lever\.co|ashbyhq|greenhouse|myworkdayjobs|workable/.test(other.url())).map((other) => other.url().slice(0, 90));
      samples.push({ at: Date.now(), running: state?.running ?? null, stage: state?.stage ?? "", jobTabs: tabs.length, tabs });
      const line = `running=${state?.running} tabs=${tabs.length} ${String(state?.stage ?? "").slice(0, 80)}`;
      if (line !== last) { console.log(`  ${line}`); last = line; }
      if (state && !state.running) break;
    }
    report.samples = samples;
    report.peakConcurrentTabs = Math.max(0, ...samples.map((sample) => sample.jobTabs));

    report.jobs = await page.evaluate(async () => {
      const { allJobs, allResults } = await import("./store.js");
      const jobs = await allJobs();
      const results = await allResults();
      return {
        jobs: jobs.map((job) => ({ company: job.company, title: job.title, stage: job.stage, reason: job.reason, url: job.url })),
        results: results.map((result) => ({ company: result.company, status: result.status, reason: result.reason, detail: result.detail, confirmationUrl: result.confirmationUrl, files: result.files })),
      };
    }).catch((error) => ({ error: String(error).slice(0, 300) }));
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await writeFile(`test-results/${LABEL}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}

console.log(`\npeak concurrent job tabs: ${report.peakConcurrentTabs}`);
for (const job of report.jobs?.jobs ?? []) console.log(`  ${String(job.company).padEnd(22)} ${String(job.stage).padEnd(14)} ${String(job.reason ?? "").slice(0, 90)}`);
for (const result of report.jobs?.results ?? []) console.log(`  RESULT ${String(result.company).padEnd(18)} ${String(result.status).padEnd(12)} ${String(result.reason ?? "").slice(0, 70)} ${result.confirmationUrl ?? ""}`);
