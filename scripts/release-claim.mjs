/**
 * Give an employer back by hand.
 *
 * The release is automatic from now on, but it cannot reach backwards:
 * claims taken before it existed are still standing against applications
 * that were never sent, and each one is an employer this bot can no
 * longer approach. This frees a named posting through the same database
 * action the run uses, so there is one definition of what releasing means
 * rather than a repair script with its own idea of it.
 *
 *   node scripts/release-claim.mjs <applyUrl> [<applyUrl> ...]
 */

import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const urls = process.argv.slice(2);
if (urls.length === 0) throw new Error("name at least one apply URL to release");

const browser = await chromium.connectOverCDP(ATTACH);
try {
  const context = browser.contexts()[0];
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    const done = await page.evaluate(async (list) => {
      const { releaseSubmission, allHistory } = await import("./store.js");
      const out = [];
      for (const applyUrl of list) out.push({ applyUrl, ...(await releaseSubmission({ applyUrl }).catch((error) => ({ error: String(error) }))) });
      return { out, claims: (await allHistory()).filter((row) => row.kind === "submission").map((row) => row.applyUrl) };
    }, urls);
    for (const row of done.out) console.log(`${row.released ? "released" : row.error ? `error ${row.error}` : "not held"}  ${row.applyUrl}`);
    console.log(`claims still standing: ${done.claims.length}`);
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
}
