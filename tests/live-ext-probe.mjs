/**
 * What the extension thinks is going on, read from its own options page.
 *
 * A run that ends in four seconds has either refused to start or decided
 * it had nothing to do, and those two look identical from outside. The
 * only place the difference is written down is the worker's own state and
 * the queue it was reading, so this asks for both rather than inferring
 * from the jobs table - which still holds rows from runs weeks old and
 * will happily explain a run that never happened.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "";

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
let found = {};

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => (EXT_ID ? list.find((worker) => worker.url().includes(EXT_ID)) : list[0]);
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    found = await page.evaluate(async () => {
      const { allLinks, allJobs, stateStorage, readProfile } = await import("./store.js");
      const state = await chrome.runtime.sendMessage({ type: "state" });
      const links = await allLinks();
      const jobs = await allJobs();
      const profile = await readProfile();
      const kv = await stateStorage.get(["runLog", "log", "lastRun", "dayPlan", "health", "autopilotResumeAt"]);
      return {
        state,
        linkCount: links.links.length,
        links: links.links.slice(0, 10),
        jobStages: jobs.reduce((into, job) => ({ ...into, [job.stage]: (into[job.stage] || 0) + 1 }), {}),
        pendingJobs: jobs.filter((job) => !/applied|submitted|unsupported|skipped|failed/.test(job.stage || "")).map((job) => ({ company: job.company, stage: job.stage, url: job.url })).slice(0, 15),
        profile: { applyEngine: profile.applyEngine, dryRun: profile.dryRun, maxPerRun: profile.maxPerRun, manualMode: profile.manualMode, fillableOnly: profile.fillableOnly, chatGptProjectUrl: profile.chatGptProjectUrl ? "set" : "", keepRunning: profile.keepRunning, exportFiles: profile.exportFiles, generateOptionalLetters: profile.generateOptionalLetters, allowAccountRegistration: profile.allowAccountRegistration, zip: profile.zip, github: profile.github },
        kvKeys: Object.keys(kv),
        health: kv.health ?? null,
        dayPlan: kv.dayPlan ?? null,
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await writeFile("test-results/ext-probe.json", JSON.stringify(found, null, 2));
  await browser.close();
}

console.log(JSON.stringify(found, null, 2).slice(0, 4000));
