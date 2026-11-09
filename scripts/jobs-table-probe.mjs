/**
 * The jobs table as the live run has it, board by board.
 *
 * `watch-run.mjs` answers "how is the night going"; this answers the narrower
 * question "which board did each posting turn out to be on, and why was it
 * set aside", which is what decides whether the aggregator or the adapter
 * gate is the thing worth fixing. It reads through the extension's own
 * options page because a module service worker cannot be asked to import
 * anything from outside itself, and it closes the page again immediately.
 * Reads only: nothing here writes, so checking cannot become part of what is
 * being measured.
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const ATTACH = process.env.ATTACH ?? 'http://127.0.0.1:9222';
const EXT_ID = process.env.EXT_ID ?? 'cmndpkaonfgknkjeijmhhiiodmjmekpn';

const browser = await chromium.connectOverCDP(ATTACH);
let rows = [];
try {
  const context = browser.contexts()[0];
  const ours = list => list.find(worker => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent('serviceworker', { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    rows = await page.evaluate(async () => {
      const { allJobs } = await import('./store.js');
      return (await allJobs()).map(job => ({ id: job.id, stage: job.stage, mode: job.mode, ats: job.ats, company: job.company, title: job.title, applyUrl: job.applyUrl, originalUrl: job.originalUrl, reason: job.reason, manualReason: job.manualReason, extractedAt: job.extractedAt, updatedAt: job.updatedAt }));
    });
  } finally { await page.close().catch(() => {}); }
} finally { await browser.close(); }

await writeFile('test-results/jobs-table-probe.json', JSON.stringify(rows, null, 2));

const tally = (list, pick) => { const counts = {}; for (const row of list) { const key = pick(row) || '(none)'; counts[key] = (counts[key] ?? 0) + 1; } return Object.entries(counts).sort((a, b) => b[1] - a[1]); };
console.log(`${rows.length} job row(s); by stage:`, tally(rows, row => row.stage));
const jobright = rows.filter(row => String(row.id).includes('jobright.ai'));
console.log(`\nfrom Jobright: ${jobright.length}`);
console.log('  by stage:', tally(jobright, row => row.stage));
console.log('  by board:', tally(jobright, row => row.ats));
for (const row of jobright.filter(row => row.stage === 'unsupported')) console.log(`    unsupported  ${row.ats || '?'}  ${row.company || '?'}  ${row.applyUrl}`);
console.log('  review reasons:', tally(jobright.filter(row => row.stage === 'review'), row => String(row.reason).slice(0, 90)));
console.log('\nnot from Jobright, by board:', tally(rows.filter(row => !String(row.id).includes('jobright.ai')), row => row.ats));
