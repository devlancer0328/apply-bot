/**
 * Is the carried session actually Daniel's, and can the mailbox reader read it?
 *
 * The corpus harness asserts a *Google* session exists before it spends
 * thirty-one postings on a browser that might be signed out. That check is
 * about cookies; this one is about the inbox. They are not the same
 * question, and the difference matters: a profile can carry a live
 * `__Secure-1PSID` and still land on the account chooser, which reads to
 * `readRows` as signed out and to the harness as fine.
 *
 * So this asks the two things the corpus cannot:
 *
 *   1. Which address is signed in, read off Gmail's own page rather than
 *      inferred from a cookie name.
 *   2. Whether `verification.js` - the real one, through the real
 *      BrowserOps, inside the extension - can drive that mailbox.
 *
 * ## Nothing is sent
 *
 * The reader only ever searches and reads. It is pointed at a company that
 * has mailed nothing, so the expected result is the timeout, and the
 * timeout is the evidence: reaching "no security code mail arrived" means
 * every step before it worked - the tab was borrowed, the search ran, the
 * rows were read - against the real inbox. "Gmail is not signed in" is the
 * failure, and it is a different error on purpose.
 */

import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const cookieJar = process.env.COOKIES ?? "test-results/profile41-cookies.json";
const outFile = process.env.OUT ?? "test-results/gmail-session.json";
/** Short on purpose: the point is to reach the read, not to wait out a real code. */
const LOOK_MS = Number(process.env.VERIFY_MS ?? 25000);

const report = { startedAt: new Date().toISOString(), cookieJar };
const profilePath = scratchPath("gmail-session");
let context;

try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-proxy-server"],
    viewport: { width: 1440, height: 1050 },
  });

  // The same submit guard the corpus installs. Gmail has forms on it, and
  // a run that reads a mailbox should be no more able to post one than a
  // run that fills an application.
  await context.addInitScript(() => {
    window.__blockedSubmits = 0;
    window.addEventListener("submit", (event) => {
      window.__blockedSubmits += 1;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  });

  await context.addCookies(JSON.parse(await readFile(cookieJar, "utf8")));

  /* ------------------------------------------------ 1. who is signed in */

  const probe = await context.newPage();
  await probe.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" }).catch(() => {});
  await probe.waitForTimeout(9000);

  report.gmail = await probe.evaluate(() => {
    const text = document.body?.innerText ?? "";
    // Gmail puts the signed-in address in the account button's label, and
    // in a meta tag on the page it serves to a signed-in session.
    const label = document.querySelector('a[aria-label*="@"], [aria-label*="Google Account"]')?.getAttribute("aria-label") ?? "";
    const addresses = [...new Set((document.documentElement.innerHTML.match(/[\w.+-]+@gmail\.com/g) ?? []))].slice(0, 5);
    return {
      url: location.href,
      title: document.title,
      // The account chooser and the sign-in page are both "not the inbox".
      signedOut: /accounts\.google\.com/.test(location.href),
      rows: document.querySelectorAll("tr.zA").length,
      label: label.slice(0, 160),
      addresses,
      sample: text.replace(/\s+/g, " ").slice(0, 200),
    };
  });
  await probe.screenshot({ path: "test-results/gmail-session.png", fullPage: false }).catch(() => {});
  await probe.close();

  console.log(`Gmail URL      : ${report.gmail.url}`);
  console.log(`Gmail title    : ${report.gmail.title}`);
  console.log(`Signed out     : ${report.gmail.signedOut}`);
  console.log(`Inbox rows     : ${report.gmail.rows}`);
  console.log(`Addresses seen : ${report.gmail.addresses.join(", ") || "(none)"}`);

  /* ------------------------------- 2. the real reader, through the engine */

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const driver = await context.newPage();
  await driver.goto(`${origin}/src/options.html`);
  await driver.getByRole("heading", { name: "A little more organized. A lot more you." }).waitFor();

  report.reader = await driver.evaluate(async (timeoutMs) => {
    const { createVerificationService } = await import("./apply/verification.js");
    const { chromeBrowserOps } = await import("./apply/chrome-ops.js");
    const log = [];
    const { verification, waiting } = createVerificationService({
      browser: chromeBrowserOps(),
      log: (level, message) => log.push(`${level}: ${message}`),
    });

    // Registered, so an attempt suspended on a mailbox is visible while it
    // waits - the thing the monitor shows instead of a job that looks hung.
    const asked = verification({
      kind: "email-code",
      email: "danieltorres3274@gmail.com",
      // A company that has mailed nothing. The reader must search, read and
      // find no match; it must not find somebody else's code.
      company: "Nonexistent Harness Company",
      timeoutMs,
    });
    await new Promise((done) => setTimeout(done, 1500));
    const suspended = waiting();

    try {
      return { resolved: await asked, suspended, log };
    } catch (error) {
      return { error: String(error?.message ?? error), suspended, log };
    }
  }, LOOK_MS);

  const { error = "", suspended = [], log = [] } = report.reader;
  // Reaching the timeout means the search ran and the rows were read.
  report.reader.reachedMailbox = /arrived within/.test(error);
  report.reader.signedOutError = /not signed in/.test(error);

  console.log(`\nRegistered wait: ${suspended.length === 1 ? `yes - "${suspended[0].waitingFor}"` : "NONE"}`);
  for (const line of log) console.log(`  ${line}`);
  console.log(`Reader result  : ${error || JSON.stringify(report.reader.resolved)}`);
  console.log(`Mailbox read   : ${report.reader.reachedMailbox}`);

  report.blockedSubmits = await driver.evaluate(() => window.__blockedSubmits ?? 0);
  report.gmailReadable = report.gmail.rows > 0 && !report.gmail.signedOut && report.reader.reachedMailbox;
  console.log(`\nGmail readable with the carried session: ${report.gmailReadable}`);
} catch (failure) {
  report.failure = failure.stack;
  console.error(failure);
  process.exitCode = 1;
} finally {
  await context?.close();
  await releaseScratch(profilePath);
  report.finishedAt = new Date().toISOString();
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`\nFull results: ${outFile}`);
}
