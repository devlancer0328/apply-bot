/**
 * Checks the Outlook selectors against a real, signed-in Outlook.
 *
 * Everything else about reading a mailbox can be tested from a fixture,
 * because everything else is a decision: which provider, which dialect,
 * whose code this is. The selectors are not a decision - they are a claim
 * about somebody else's undocumented markup, and the only thing that can
 * settle a claim like that is the markup. Gmail's were settled by years
 * of running against it. Outlook's have not been, so this exists to
 * settle them in one pass instead of discovering them one failed
 * application at a time.
 *
 * It reads. It does not type into the search box, open a message, click
 * anything or send anything. The worst it can do is leave a tab scrolled.
 *
 * Run it against the browser the extension runs in:
 *
 *   google-chrome --remote-debugging-port=9222      # the browser you use
 *   node scripts/outlook-mail-probe.mjs             # this, in another shell
 *
 * Have Outlook open on a folder holding at least one message - any
 * message. What comes back says, for each selector the extension relies
 * on, whether it found anything and what it found.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerById, searchFor } from "../src/mail-providers.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const attachTo = process.env.ATTACH ?? "http://127.0.0.1:9222";
const outlook = providerById("outlook");

/**
 * Every claim the spec makes, asked of the live page one at a time.
 *
 * Runs inside the tab. Deliberately not `readRows`: that one answers
 * "is there a code", and the question here is the one underneath it -
 * which of these selectors matches anything at all, and does what it
 * matched look like a row. A spec that is half right fails as silence,
 * so silence is what this is built to localise.
 */
function inspect(spec) {
  const found = (selector) => {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  const rows = found(spec.rows).filter((row) => row.getClientRects().length > 0);
  const sample = rows.slice(0, 3).map((row) => ({
    innerText: (row.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240),
    // The two differ wherever a row's spans abut, and the difference is
    // what decides whether a company name can be told from the body.
    textContent: (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
    ariaLabel: (row.getAttribute("aria-label") || "").slice(0, 240),
    // Where a send time could come from. A row with none of these is the
    // bad case: codes then get told apart only by what was in the box
    // when the wait began, which reads as a code that never arrived.
    dated: [...row.querySelectorAll("[title], [aria-label]")]
      .flatMap((node) => [node.getAttribute("title"), node.getAttribute("aria-label")])
      .filter((value) => value && /\b(?:19|20)\d{2}\b/.test(value))
      .slice(0, 3),
  }));
  const box = document.querySelector(spec.box);
  return {
    url: location.href,
    signedOut: new RegExp(spec.signedOut, "i").test(location.href),
    rowSelector: spec.rows,
    rowsVisible: rows.length,
    rowsInDom: found(spec.rows).length,
    // Which of the three alternatives in the row selector is carrying it.
    byAlternative: spec.rows.split(",").map((one) => ({ selector: one.trim(), matched: found(one.trim()).length })),
    searchBox: box ? { selector: spec.box, tag: box.tagName.toLowerCase(), value: String(box.value ?? "").slice(0, 120) } : null,
    refreshControl: [...document.querySelectorAll('[role="button"], button')]
      .map((node) => node.getAttribute("aria-label") ?? node.getAttribute("title") ?? "")
      .filter((label) => new RegExp(spec.refresh, "i").test(label))
      .slice(0, 3),
    readingPane: Boolean(document.querySelector(spec.message)),
    sample,
  };
}

const browser = await chromium.connectOverCDP(attachTo);
const pages = browser.contexts().flatMap((context) => context.pages());
const tab = pages.find((page) => /^https:\/\/outlook\.(live|office|office365)\.com\/mail\//.test(page.url()));

if (!tab) {
  console.error("No Outlook tab is open in that browser. Open Outlook on any folder and run this again.");
  console.error(`Tabs seen: ${pages.map((page) => page.url()).join(", ") || "none"}`);
  await browser.close();
  process.exit(1);
}

const report = await tab.evaluate(inspect, outlook.spec);
report.searchWouldBe = searchFor(outlook, "code");

await writeFile("test-results/outlook-mail-probe.json", JSON.stringify(report, null, 2));

const verdict = (label, ok, detail) => console.log(`${ok ? "  ok  " : " MISS "} ${label.padEnd(22)} ${detail}`);
console.log(`\nOutlook at ${report.url}\n`);
verdict("signed in", !report.signedOut, report.signedOut ? "the tab is on a sign-in page" : "reading the mailbox");
verdict("message rows", report.rowsVisible > 0, `${report.rowsVisible} visible of ${report.rowsInDom} in the page`);
for (const alternative of report.byAlternative) verdict("  alternative", alternative.matched > 0, `${alternative.matched} - ${alternative.selector}`);
verdict("search box", Boolean(report.searchBox), report.searchBox ? `${report.searchBox.tag} holding "${report.searchBox.value}"` : "none of the selectors matched");
verdict("refresh control", report.refreshControl.length > 0, report.refreshControl.join(", ") || "none - the search is re-run instead, which also works");
verdict("reading pane", report.readingPane, report.readingPane ? "present" : "not open - only matters for Workday activation mail");

const dated = report.sample.filter((row) => row.dated.length > 0).length;
verdict("row send times", dated > 0, `${dated} of ${report.sample.length} sampled rows carry a dated tooltip`);
const separated = report.sample.filter((row) => row.innerText && row.innerText !== row.textContent).length;
verdict("row text", report.sample.some((row) => row.innerText), `${separated} of ${report.sample.length} sampled rows read differently whole than concatenated`);

console.log(`\nThe search this would run: ${report.searchWouldBe}`);
console.log("First rows as the reader sees them:\n");
for (const row of report.sample) console.log(`  ${row.innerText || row.textContent || "(empty)"}\n`);
console.log("Full detail in test-results/outlook-mail-probe.json");

await browser.close();
