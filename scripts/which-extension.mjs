/**
 * Which extension is actually running, and whether it is this source tree.
 *
 * An older build of this extension is installed beside the current one,
 * and an unpacked service worker keeps running the bytes it started with
 * however many times the files on disk change. Both of those produce the
 * same symptom - a fix that is plainly in the file and plainly not in the
 * behaviour - so the only way to be sure is to ask each worker for a
 * sentence that only the current source contains.
 */

import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(ATTACH);
try {
  const context = browser.contexts()[0];
  const workers = context.serviceWorkers();
  console.log(`${workers.length} service worker(s)`);

  for (const worker of workers) {
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${id}/src/options.html`);
      const seen = await page.evaluate(async () => {
        const source = await fetch(chrome.runtime.getURL("src/apply/run-bridge.js")).then((r) => r.text()).catch(() => "");
        const bg = await fetch(chrome.runtime.getURL("src/background.js")).then((r) => r.text()).catch(() => "");
        const store = await fetch(chrome.runtime.getURL("src/store.js")).then((r) => r.text()).catch(() => "");
        return {
          id: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
          name: chrome.runtime.getManifest().name,
          // On disk right now, as the extension itself can read it.
          diskHasLeverLegacy: /LEGACY_ONLY = new Set\(\["applytojob", "lever"\]\)/.test(source),
          diskHasRelease: /releaseSubmission/.test(store),
          diskHasReadyWriter: /async function readyWriter\(/.test(bg),
          // Live in the worker that is running, which is the thing that matters.
          liveHasRelease: typeof (await chrome.runtime.sendMessage({ type: "state" })) === "object",
        };
      });
      console.log(JSON.stringify(seen, null, 2));
    } catch (error) {
      console.log(`${id}: ${error.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}
