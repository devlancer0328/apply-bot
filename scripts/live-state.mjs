/**
 * What the extension's own tables say, read out of the running browser.
 *
 * The questions this answers cannot be answered from the source: whether a
 * company is claimed, what today's ledger counts, and which postings the
 * duplicate index would now refuse are all rows in SQLite inside the
 * profile Chrome has open, and every one of them decides whether an
 * unattended run is safe to start. Reading them from a test harness that
 * builds its own database would be reading a different machine.
 *
 * Read-only on purpose. Nothing here writes, so it can be run against a
 * live run in progress without becoming part of what it is measuring.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const OUT = process.env.OUT ?? "test-results/live-state.json";

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
let found = {};

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    found = await page.evaluate(async () => {
      const store = await import("./store.js");
      const { allHistory, allResults, stateStorage, readProfile, readSchedule } = store;
      const history = await allHistory();
      const results = await allResults();
      const profile = await readProfile();
      const kv = await stateStorage.get(["runLog", "lastRun", "dayPlan", "health", "autopilotResumeAt", "dayLedger", "ledger", "schedule"]);
      const tabs = await chrome.tabs.query({});
      return {
        at: Date.now(),
        profile,
        schedule: typeof readSchedule === "function" ? await readSchedule() : null,
        kv,
        historyCount: history.length,
        history: history.map((row) => ({ id: row.id, kind: row.kind, company: row.company, title: row.title, applyUrl: row.applyUrl, importedAt: row.importedAt })),
        resultCount: results.length,
        results: results.map((row) => ({ id: row.id, company: row.company, title: row.title, status: row.status, reason: row.reason, at: row.at, applyUrl: row.applyUrl })),
        tabs: tabs.map((tab) => ({ id: tab.id, url: (tab.url || "").slice(0, 120), title: (tab.title || "").slice(0, 80) })),
      };
    });
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await writeFile(OUT, JSON.stringify(found, null, 2));
  await browser.close();
}

const submission = (found.history ?? []).filter((row) => row.kind === "submission");
console.log(`history ${found.historyCount} rows (${submission.length} submission claims), results ${found.resultCount}`);
console.log(`tabs ${(found.tabs ?? []).length}; chatgpt ${(found.tabs ?? []).filter((tab) => /chatgpt\.com|chat\.openai/.test(tab.url)).length}`);
console.log(`written to ${OUT}`);
