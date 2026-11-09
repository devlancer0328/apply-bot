/**
 * The workspace photographed at side-panel widths.
 *
 * Chrome's side panel cannot be driven over CDP - it is not a tab and does
 * not appear in the target list - so the panel is proved the only way that
 * is left: the same document it loads, at the widths it loads it at. A
 * narrow layout asserted in CSS and never looked at is how the funnel
 * chart shipped with a 110px label column squeezing its bar into a sliver.
 *
 *   EXT_ID=... node scripts/panel-shots.mjs
 *
 * Writes test-results/panel-<route>-<width>.png and reports any route whose
 * document scrolls sideways, which at these widths is always a bug.
 */

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const WIDTHS = (process.env.WIDTHS ?? "350,500").split(",").map(Number);
const ROUTES = (process.env.ROUTES ?? "monitor,overview,settings,resumes,activity").split(",");

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
const problems = [];
try {
  const context = browser.contexts()[0];
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);
  const origin = `chrome-extension://${new URL(worker.url()).host}`;

  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const route of ROUTES) {
      await page.goto(`${origin}/src/options.html#${route}`);
      await page.waitForFunction(() => document.getElementById("content")?.getAttribute("aria-busy") === "false", null, { timeout: 30000 });
      // A tab is a tab, so options.js will not have flagged this document as
      // the panel. The panel-only rules are the point of the exercise, so the
      // flag is set by hand here rather than photographing a layout nobody
      // will ever see.
      await page.evaluate(() => { document.body.dataset.surface = "panel"; document.getElementById("open-workspace").hidden = false; });
      await page.waitForTimeout(400);
      const path = `test-results/panel-${route}-${width}.png`;
      await page.screenshot({ path, fullPage: true });
      // A horizontal scrollbar on a 350px document means something was laid
      // out against a width the panel does not have. Three pixels of slack
      // for sub-pixel rounding, which is not the same as an overflow.
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 3) problems.push(`${route} at ${width}px overflows by ${over}px`);
      console.log(`${path}${over > 3 ? `  OVERFLOWS by ${over}px` : ""}`);
    }
  }
  await page.close();
} finally {
  await browser.close();
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(" -", problem);
  process.exit(1);
}
console.log("\nNo sideways scroll and no page errors at any panel width.");
