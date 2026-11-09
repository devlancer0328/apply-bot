/**
 * Is `WORKDAY_SEARCH` pointed at the address Workday actually mails from?
 *
 * The search in mailbox.js is `from:otp.workday.com newer_than:3h`, written
 * from a tenant seen once. A sender key that has drifted does not fail
 * loudly: the search returns nothing, which reads exactly like mail that
 * has not arrived yet, and every Workday account sits waiting out its full
 * three minutes for a letter that is already in the box. The equivalent
 * Greenhouse search had drifted that way - the sender had gained a region
 * prefix - so this asks rather than assumes.
 *
 * Reading the answer correctly is most of the job. Gmail hides its rows for
 * about a second while it swaps views and shows an empty list for two and a
 * half on a cold tab, so one look after a navigation reports zero results
 * for a search that has plenty, which is how a careless check produced a
 * confident false negative. Every search here is therefore polled once a
 * second for twenty-five, and the rendered rows are only believed once
 * Gmail's own search box agrees it is showing the query that was issued.
 *
 * The question the last two searches settle is the one that matters most:
 * a verification mail carrying that subject from an address the search
 * does not cover is a tenant the reader will never find.
 *
 * Read-only: it opens one tab, changes its hash, reads text, and closes
 * the tab it opened. Nothing is clicked in a message and nothing is sent.
 *
 *   ATTACH=http://127.0.0.1:9222 EMAIL=... node tests/workday-mail-probe.mjs
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const attachTo = process.env.ATTACH ?? "http://127.0.0.1:9222";
const email = process.env.EMAIL ?? "";

const VERIFY = 'subject:"verify your candidate account"';

/** The one in mailbox.js, the wider nets, and the two that find a drift. */
const SEARCHES = [
  ["current", "from:otp.workday.com newer_than:3h"],
  ["current-no-window", "from:otp.workday.com"],
  ["verify-subject", VERIFY],
  ["verify-elsewhere", `${VERIFY} -from:otp.workday.com`],
  ["activation-wording", 'subject:("activate your account" OR "candidate account activation" OR "confirm your account")'],
  ["password-reset", 'subject:("password reset" OR "reset your password") newer_than:90d'],
  // One tenant at a time, for the question that comes up every time an
  // account refuses a password: has this address been signed up here
  // before, by this bot or by anything else?
  ...(process.env.QUERY ? [["asked-for", process.env.QUERY]] : []),
];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What Gmail is showing, read whole. `searching` is the guard against
 * believing the previous view's rows: Gmail keeps the lists it has already
 * drawn in the page and only the visible one belongs to this query.
 */
function readList(query) {
  const rows = [...document.querySelectorAll("tr.zA")]
    .filter((row) => row.getClientRects().length > 0)
    .map((row) => row.textContent.replace(/\s+/g, " ").trim());
  const box = document.querySelector('form[role="search"] input, input[name="q"], input[aria-label="Search mail"]');
  const main = document.querySelector('[role="main"]')?.textContent ?? "";
  return {
    signedOut: /accounts\.google\.com/.test(location.href),
    inBox: box?.value ?? "",
    searching: (box?.value ?? "").trim() === query.trim(),
    empty: /no messages matched|nothing matched/i.test(main),
    rows,
  };
}

/**
 * Clicks the nth row that is actually on screen.
 *
 * Gmail keeps the rows of every list it has drawn in the page, hidden, so
 * `querySelector("tr.zA")` is as likely to return the top of the inbox the
 * tab was on a minute ago as the top of this search - which is how the
 * first version of this probe confidently read a Jobright mail as Workday's
 * activation sender.
 */
function clickVisibleRow(index) {
  const rows = [...document.querySelectorAll("tr.zA")].filter((row) => row.getClientRects().length > 0);
  if (!rows[index]) return "";
  rows[index].click();
  return rows[index].textContent.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** The opened message: who sent it, what it said, where its links point. */
function readMessage() {
  const main = document.querySelector('[role="main"]');
  return {
    subject: main?.querySelector("h2")?.textContent?.trim() ?? "",
    senders: [...(main?.querySelectorAll("span[email]") ?? [])].map((node) => node.getAttribute("email")).filter(Boolean),
    body: (main?.querySelector(".a3s")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 500),
    links: [...(main?.querySelectorAll(".a3s a[href]") ?? [])].map((anchor) => anchor.href).slice(0, 10),
  };
}

const browser = await chromium.connectOverCDP(attachTo);
const report = { attachTo, searches: {}, messages: [] };
let page = null;

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${attachTo}`);

  // On the inbox first and onto each search by hash afterwards. A cold tab
  // booted straight onto `#search/` runs the search but leaves Gmail's own
  // box empty, and the box is the only thing that says which view the rows
  // on screen belong to.
  page = await context.newPage();
  const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
  await page.goto(`https://mail.google.com/mail/${account}#inbox`, { waitUntil: "domcontentloaded" });
  for (let look = 0; look < 40; look++) {
    const seen = await page.evaluate(readList, "").catch(() => null);
    if (seen?.signedOut) throw new Error("this browser is not signed in to Gmail");
    if (seen?.rows.length > 0) break;
    await pause(1000);
  }

  const show = async (query) => {
    await page.evaluate((hash) => {
      location.hash = "#inbox";
      setTimeout(() => {
        location.hash = hash;
      }, 150);
    }, `#search/${encodeURIComponent(query)}`);
    let seen = null;
    for (let look = 0; look < 25; look++) {
      await pause(1000);
      seen = await page.evaluate(readList, query).catch(() => null);
      if (seen?.searching && (seen.rows.length > 0 || seen.empty)) break;
    }
    return seen;
  };

  for (const [name, query] of SEARCHES) {
    const seen = await show(query);
    report.searches[name] = { query, settled: Boolean(seen?.searching), rows: seen?.rows.length ?? 0, sample: (seen?.rows ?? []).slice(0, 5) };
    console.log(`${name.padEnd(20)} ${String(seen?.rows.length ?? 0).padStart(3)} rows  settled=${seen?.searching ? "yes" : "NO "}  ${(seen?.rows[0] ?? "").slice(0, 86)}`);
    if (name === "asked-for") for (const row of (seen?.rows ?? []).slice(0, 12)) console.log(`                     | ${row.slice(0, 110)}`);
  }

  // The sender, read off real messages rather than inferred from a row. The
  // search is re-shown and the opened thread checked against the subject
  // that was searched for, because a row clicked before the view swapped is
  // a row in whatever list the tab was on a moment ago.
  for (const [name, query, depth] of [["verify-subject", VERIFY, 1], ["verify-elsewhere", `${VERIFY} -from:otp.workday.com`, 3]]) {
    for (let index = 0; index < Math.min(depth, report.searches[name].rows); index++) {
      const seen = await show(query);
      if (!seen?.searching) continue;
      const row = await page.evaluate(clickVisibleRow, index);
      let message = null;
      for (let look = 0; look < 15; look++) {
        await pause(700);
        message = await page.evaluate(readMessage);
        if (message.senders.length > 0 && /candidate account/i.test(message.subject)) break;
      }
      report.messages.push({ from: name, row, ...message });
      console.log(`\n${name}[${index}]: ${message?.subject}\n  senders: ${message?.senders.join(", ") || "(none read)"}\n  links:   ${(message?.links ?? []).slice(0, 3).join("\n           ")}`);
    }
  }
} catch (error) {
  report.failure = error?.message ?? String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  // The tab this opened, and only that one. Everything the person had open
  // when the probe attached is still open when it detaches.
  await page?.close().catch(() => {});
  await browser.close();
  await writeFile("test-results/workday-mail-probe.json", JSON.stringify(report, null, 2));
  console.log("\nFull results: test-results/workday-mail-probe.json");
}
