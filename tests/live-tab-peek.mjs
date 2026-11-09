/**
 * Photograph a tab a run left open, without disturbing it.
 *
 * The engine deliberately leaves the page up when it parks on a captcha,
 * because that page is the whole handover to a person. Reading it has to
 * be a separate act from the run that produced it: re-running the harness
 * to see what happened would navigate the tab and destroy the only record
 * of the state being asked about.
 *
 * MATCH picks the tab by substring of its URL. Nothing is clicked, nothing
 * is navigated, and no tab is closed unless CLOSE is set.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const MATCH = process.env.MATCH ?? "";
const LABEL = process.env.LABEL ?? "tab";
const CLOSE = process.env.CLOSE === "1";

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
const found = [];

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);

  for (const page of context.pages()) {
    const url = page.url();
    if (!MATCH || !url.includes(MATCH)) continue;
    const entry = { url, title: await page.title().catch(() => "") };
    entry.text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1200)).catch(() => "");
    entry.captchaFrames = await page
      .evaluate(() =>
        [...document.querySelectorAll("iframe")]
          .filter((frame) => /hcaptcha|recaptcha|turnstile/i.test(frame.src || ""))
          .map((frame) => {
            const box = frame.getBoundingClientRect();
            return { src: (frame.src || "").slice(0, 120), w: Math.round(box.width), h: Math.round(box.height), visibility: getComputedStyle(frame).visibility };
          }),
      )
      .catch(() => []);
    await page.screenshot({ path: `test-results/${LABEL}-${found.length}.png` }).catch(() => {});
    found.push(entry);
    if (CLOSE) await page.close().catch(() => {});
  }
} finally {
  await writeFile(`test-results/${LABEL}.json`, JSON.stringify(found, null, 2));
  await browser.close();
}

for (const entry of found) {
  console.log(`\n${entry.url}\n  title: ${entry.title}`);
  console.log(`  captcha frames: ${JSON.stringify(entry.captchaFrames)}`);
  console.log(`  text: ${entry.text.slice(0, 600)}`);
}
if (found.length === 0) console.log(`no open tab matching ${JSON.stringify(MATCH)}`);
