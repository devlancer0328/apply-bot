/**
 * What an application actually costs, measured rather than estimated.
 *
 * `health.js` stops the night below a floor derived from
 * `navigator.storage.estimate()`, which reports the origin's quota and not
 * the filesystem - Chrome derives one from the other, but the gap is the
 * difference between "the night stopped early for nothing" and "the night
 * filled the disk and the database could not save itself". Three hundred
 * applications had never been multiplied out against either number, so
 * both are printed here beside the real `df`, along with the size of the
 * database as it stands.
 */

import { chromium } from "playwright";
import { statfs } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const PLANNED = Number(process.env.PLANNED ?? 300);

const browser = await chromium.connectOverCDP(ATTACH);
let seen = {};
try {
  const context = browser.contexts()[0];
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    seen = await page.evaluate(async () => {
      const { db } = await import("./store.js");
      const estimate = (await navigator.storage?.estimate?.()) ?? {};
      const stats = await db({ action: "stats" }).catch((error) => ({ error: String(error) }));
      return { quota: estimate.quota ?? 0, usage: estimate.usage ?? 0, stats };
    });
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
}

const fs = await statfs("/home/administrator/Downloads");
const realFree = fs.bavail * fs.bsize;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const PER_APPLICATION = 560_000;
const originFree = Math.max(0, seen.quota - seen.usage);
const dbBytes = seen.stats?.bytes ?? 0;

console.log(`filesystem free        ${mb(realFree)}`);
console.log(`origin quota - usage   ${mb(originFree)}  (quota ${mb(seen.quota)}, usage ${mb(seen.usage)})`);
console.log(`database now           ${mb(dbBytes)}  rows ${JSON.stringify(seen.stats?.tables ?? {})}`);
console.log("");
console.log(`${PLANNED} applications at ${mb(PER_APPLICATION)} each`);
console.log(`  stored twice (SQLite + Downloads)   ${mb(PLANNED * PER_APPLICATION)}`);
console.log(`  plus a whole-database rewrite       ${mb(dbBytes + PLANNED * PER_APPLICATION * 0.6)}`);
console.log(`  filesystem left afterwards          ${mb(realFree - PLANNED * PER_APPLICATION)}`);
console.log(`  health.js would stop below          ${mb(250_000_000)} of origin room`);
console.log(`  health.js drops screenshots below   ${mb(600_000_000)} of origin room`);
