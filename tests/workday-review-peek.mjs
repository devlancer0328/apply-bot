/**
 * Read the Review page back off the live tenant before anything is pressed.
 *
 * Review mode leaves the wizard parked on Review, which is the only place
 * Workday shows every answer it saved in one view. A field can fill, verify
 * and advance and still hold the wrong value - the state menu took
 * "Alabama" from a model rescue for three pages without one warning - so
 * this prints what the employer would actually receive. Read-only: it
 * presses nothing and closes no tab the harness did not open.
 */

import { chromium } from "playwright";

const attached = await chromium.connectOverCDP(process.env.ATTACH ?? "http://127.0.0.1:9222");
try {
  const pages = attached.contexts().flatMap((context) => context.pages());
  const page = pages.find((entry) => /myworkdayjobs\.com/.test(entry.url()));
  if (!page) throw new Error(`no Workday tab is open (${pages.length} tabs)`);
  console.log(page.url(), "\n");
  const text = await page.evaluate(() => {
    const main = document.querySelector('[data-automation-id="applyFlowPage"]') ?? document.body;
    return main.innerText.replace(/\n{2,}/g, "\n").slice(0, 4000);
  });
  console.log(text);
} finally {
  await attached.close();
}
