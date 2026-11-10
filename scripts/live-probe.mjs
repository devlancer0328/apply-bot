/**
 * What the running extension actually holds, in one page.
 *
 * live-state.mjs answers the duplicate-safety questions before an
 * unattended run. This answers the readiness ones: is the profile filled
 * in, is there a resume to tailor from, what is banked at
 * `documents-ready`, and what is waiting on the Questions page. All of
 * it read out of the browser's own SQLite, because a harness that builds
 * its own database is measuring a different machine.
 *
 * Read-only.
 */
import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";

const browser = await chromium.connectOverCDP(ATTACH);
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  // Evaluated in the options page rather than the service worker: a
  // worker is forbidden dynamic import by the HTML spec, and the page
  // talks to the same database over the same message channel.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
  const report = await page.evaluate(async () => {
    const store = await import("./store.js");
    const profile = await store.readProfile();
    const [resumes, jobs, questions, links] = await Promise.all([
      store.allResumes().catch(() => []),
      store.allJobs().catch(() => []),
      store.allQuestions().catch(() => []),
      store.allLinks().catch(() => ({ links: [] })),
    ]);
    const stages = {};
    for (const job of jobs) stages[job.stage || "none"] = (stages[job.stage || "none"] || 0) + 1;
    const missing = (await import("./profile.js")).missingProfileFields(profile);
    return {
      version: chrome.runtime.getManifest().version,
      // The settings the last four stages introduced. If these read as the
      // old values the worker is still running yesterday's bytes.
      newSettings: {
        chatGptConcurrency: profile.chatGptConcurrency,
        fitCheckEnabled: profile.fitCheckEnabled,
        fitThreshold: profile.fitThreshold,
        hardBlockers: profile.hardBlockers,
        securityClearance: profile.securityClearance,
        dryRunGone: profile.dryRun === undefined,
      },
      schedule: (await import("./schedule.js")).withScheduleDefaults((await store.stateStorage.get("schedule")).schedule),
      identity: { name: [profile.firstName, profile.lastName].filter(Boolean).join(" "), email: profile.email, country: profile.country, techYears: profile.techYears },
      missingProfileFields: missing,
      chatGptProjectUrl: profile.chatGptProjectUrl || profile.resumeChatUrl || "",
      feeds: { jobright: profile.jobright ?? profile.autoFetch, hiringCafe: Boolean(profile.hiringCafeUrl), queuedLinks: links.links.length },
      resumes: resumes.map((row) => ({ id: row.id, name: row.name, kind: row.kind, hasPdf: Boolean(row.pdf), hasText: Boolean(row.sourceText || row.document) })),
      jobStages: stages,
      banked: jobs.filter((job) => job.stage === "documents-ready").map((job) => ({ id: job.id, company: job.company, hasData: Boolean(job.applicationData) })),
      questions: questions.map((row) => ({ q: String(row.question || "").slice(0, 70), answered: Boolean(String(row.answer || "").trim()), asked: row.asked })),
      run: { running: false },
    };
  });

  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "state" })).catch(() => null);
  await page.close().catch(() => {});
  console.log(JSON.stringify({ ...report, liveState: state && { running: state.running, phase: state.phase, stopReason: state.stopReason, attempted: state.attempted, submitted: state.submitted } }, null, 2));
} finally {
  await browser.close();
}
