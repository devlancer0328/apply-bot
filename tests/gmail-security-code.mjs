/**
 * Can the mailbox reader still find a Greenhouse security code?
 *
 * The search in mailbox.js is a string, and a string that no longer matches
 * anything fails quietly: the list comes back empty, which is the same
 * shape as a code that has not arrived yet, so the run waits out its two
 * and a half minutes and parks the application. Nothing in the unit tests
 * can catch that, because the thing that changed is in Gmail and not here.
 *
 * So this one asks the real inbox. It imports `SEARCH`, `readRows`,
 * `parseRow` and `codeForCompany` from mailbox.js unchanged - the point is to
 * exercise the shipped constants and the shipped screen-reading, not a copy
 * of them - runs the search the way the extension runs it, and insists on
 * pulling a code out for named companies that have mailed one.
 *
 * ## It attaches, it does not launch
 *
 * The sibling live tests start their own Chromium from a cookie jar. This
 * one cannot: the mailbox it needs is the one the person is signed into, so
 * it joins the browser already running with remote debugging on 9222. It
 * opens a page of its own and closes that page only. Read-only throughout -
 * the mailbox is searched and read, and nothing is opened, sent or marked.
 *
 * ## It is a live test and it expires
 *
 * `SEARCH` carries a `newer_than` window, so the companies asked for have to
 * be ones that mailed a code inside that window. Point it somewhere else
 * with COMPANIES="Acme,Other" when the ones below have aged out.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SEARCH, codeForCompany, goToHash, parseRow, readRows } from "../src/mailbox.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const endpoint = process.env.CDP ?? "http://127.0.0.1:9222";
const companies = (process.env.COMPANIES ?? "Scale AI,Ondo Finance").split(",").map((name) => name.trim()).filter(Boolean);
const outFile = process.env.OUT ?? "test-results/gmail-security-code.json";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { startedAt: new Date().toISOString(), endpoint, search: SEARCH, companies };

let browser;
let page;

try {
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${endpoint}`);
  page = await context.newPage();

  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" });

  // The extension borrows the Gmail tab the person already has open, so the
  // mailbox it searches is one that has finished drawing. A tab booted
  // straight into a search hash is a different page: Gmail runs the search
  // but never fills its own search box, and `readRows` waits on that box.
  // Letting the inbox arrive first is what makes this test the real path.
  for (let attempt = 0; attempt < 40; attempt++) {
    await pause(1000);
    if ((await page.evaluate(readRows, "")).settled) break;
  }

  /* ------------------------------------------------ the search, as shipped */

  await page.evaluate(goToHash, `#search/${encodeURIComponent(SEARCH)}`);

  // The same patience the extension has. A fixed sleep is what makes this
  // kind of check lie: for a second after a hash change Gmail has the new
  // rows in the page but none of them on screen, and `readRows` filters on
  // what is on screen, so an early look reads as an empty mailbox.
  let look = null;
  for (let attempt = 0; attempt < 40 && !look?.settled && !look?.failure; attempt++) {
    await pause(attempt === 0 ? 400 : 1000);
    look = await page.evaluate(readRows, SEARCH);
    if (look?.signedOut) throw new Error("Gmail is not signed in on this browser, so the code cannot be read");
  }

  report.rows = look?.rows ?? [];
  report.settled = Boolean(look?.settled);
  console.log(`Search   : ${SEARCH}`);
  console.log(`Settled  : ${report.settled}, ${report.rows.length} visible row(s)`);

  /* -------------------------------------------------- the rows, as shipped */

  report.parsed = report.rows.map(parseRow).filter(Boolean);
  console.log(`Parsed   : ${report.parsed.length} of ${report.rows.length} row(s) gave a company and a code`);

  // Through `codeForCompany`, which is what the readers call, so this says
  // whether the live box would hand each company a code rather than
  // whether a row for it exists: a near-miss company name and a code older
  // than the submission are both refusals, and both look like a row.
  report.found = companies.map((company) => {
    const chosen = codeForCompany(report.rows, { names: [company] });
    const match = report.parsed.find((entry) => entry.code === chosen.code);
    return { asked: company, subject: match?.company ?? "", code: chosen.code ?? "", refused: chosen.refused ?? "", at: match?.at ?? 0 };
  });

  console.log("");
  for (const entry of report.found) {
    console.log(`${entry.asked.padEnd(16)} ${entry.code ? `${entry.code}  (subject said "${entry.subject}")` : entry.refused || "NO CODE"}`);
  }

  report.ok = report.found.every((entry) => /^[A-Z0-9]{8}$/i.test(entry.code));
  console.log(`\nCode read from the live mailbox for every company asked for: ${report.ok}`);
  if (!report.ok) process.exitCode = 1;
} catch (failure) {
  report.failure = failure.stack;
  console.error(failure);
  process.exitCode = 1;
} finally {
  // Only the page this test opened; the person's own tabs are theirs, and
  // dropping the connection does not close their browser.
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`Full results: ${outFile}`);
}
