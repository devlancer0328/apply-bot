/**
 * Make sure the run loop's model tab exists, and say whether it is signed in.
 *
 * `run()` refuses to start at all without an open chatgpt.com tab - it is
 * where every open question and every cover letter is answered - so a run
 * started without one stops in four seconds having applied to nothing.
 * That is also the single most likely way an unattended night produces
 * zero applications, so whether the tab is merely open or actually signed
 * in is worth distinguishing rather than assuming.
 *
 * Reuses a tab the person already has open and only opens one if there is
 * none. Nothing is typed into it and nothing is sent.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
let found = {};

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);

  let page = context.pages().find((other) => /chatgpt\.com|chat\.openai\.com/.test(other.url()));
  found.reused = Boolean(page);
  if (!page) {
    page = await context.newPage();
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
  }
  await page.waitForTimeout(8000);

  found.url = page.url();
  found.title = await page.title().catch(() => "");
  // The run loop writes into a project rather than a bare chat, because
  // the project is where the resume context lives. An unset
  // `chatGptProjectUrl` is therefore worth reporting next to the projects
  // that actually exist, since the two together are the whole diagnosis.
  found.projects = await page
    .evaluate(() => [...document.querySelectorAll('a[href*="/g/g-p-"], a[href*="/project"]')].map((link) => ({ text: link.innerText.replace(/\s+/g, " ").trim().slice(0, 40), href: link.href })))
    .catch(() => []);

  found.signedIn = await page
    .evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 3000);
      return {
        hasComposer: Boolean(document.querySelector("#prompt-textarea, [data-testid='composer-text-input'], textarea")),
        loginVisible: /log in|sign up|welcome back/i.test(text),
        head: text.replace(/\s+/g, " ").slice(0, 300),
      };
    })
    .catch((error) => ({ error: String(error).slice(0, 200) }));
  await page.screenshot({ path: "test-results/chatgpt-tab.png" }).catch(() => {});
} finally {
  await writeFile("test-results/chatgpt-tab.json", JSON.stringify(found, null, 2));
  await browser.close();
}

console.log(JSON.stringify(found, null, 2));
