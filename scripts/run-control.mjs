/**
 * Stop, reload and start, from outside the browser.
 *
 * An unpacked MV3 extension does not notice that its own source changed.
 * The service worker Chrome started hours ago keeps running the bytes it
 * was started with, so every fix made on disk since then is invisible to
 * the run - which is the difference between a release path that exists in
 * the file and one that exists in the night. `chrome.runtime.reload()`
 * through the extension's own page is the only way to pick them up
 * without touching the browser the person left open.
 *
 *   ACT=stop|reload|start node scripts/run-control.mjs
 */

import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const ACT = process.env.ACT ?? "stop";

const browser = await chromium.connectOverCDP(ATTACH);
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);
  const origin = `chrome-extension://${new URL(worker.url()).host}`;

  const page = await context.newPage();
  try {
    await page.goto(`${origin}/src/options.html`);
    if (ACT === "reload") {
      // `chrome.runtime.reload()` tears down every page the extension owns,
      // including the one making the call, so the evaluate never returns
      // and its rejection is the success signal rather than a failure.
      // Closing the page before the call lands would cancel it, which is
      // the quiet way to believe an extension reloaded when it did not, so
      // the wait here is deliberate.
      await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 8000));
      console.log("reload requested");
    } else {
      const answer = await page.evaluate(async (act) => chrome.runtime.sendMessage({ type: act }), ACT);
      console.log(JSON.stringify(answer));
    }
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
}
