/**
 * The reaper against the browser the person is actually using.
 *
 * The fixtures prove the decision; only a real Chrome proves the sweep -
 * that the ledger survives in session storage, that `chrome.tabs.query`
 * answers with the fields the decision reads, and that what gets closed
 * is what was meant. So this stages the morning-after state on purpose:
 * tabs left behind by a service worker that is gone, standing beside tabs
 * nothing may touch, and then asks the extension to tidy up.
 *
 * It is destructive by design - it opens tabs and expects most of them to
 * be closed - so it is not in `npm run check`. Run it by hand against a
 * browser you are willing to have tabs opened in:
 *
 *   EXT_ID=... node tests/live-tab-reaper.mjs
 */

import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";

const browser = await chromium.connectOverCDP(ATTACH);
const opened = [];
let failures = 0;
const check = (ok, what) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
};

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  // Two extension pages, because a service worker is not allowed to
  // `import()` and this needs two module instances anyway: the first
  // stands in for the service worker that opened the tabs and then died,
  // the second for the one that comes after and has to clean up. They
  // share nothing but `chrome.storage.session`, which is the entire
  // mechanism under test.
  const origin = `chrome-extension://${EXT_ID}`;
  const past = await context.newPage();
  const present = await context.newPage();
  await past.goto(`${origin}/src/options.html`);
  await present.goto(`${origin}/src/options.html`);
  opened.push(past, present);

  const urls = () => context.pages().map((page) => page.url());
  const before = urls();
  console.log(`${before.length} tab(s) open before:\n${before.map((url) => `  - ${url.slice(0, 110)}`).join("\n")}\n`);

  // The staging. Every one of these is a real tab in the person's window.
  const staged = [
    { label: "their own ChatGPT tab", url: "https://chatgpt.com/", lease: null, survives: true },
    { label: "an orphaned Jobright feed", url: "https://jobright.ai/jobs/recommend", lease: { purpose: "feed" }, survives: false },
    { label: "an orphaned Gmail search", url: "https://mail.google.com/mail/u/0/#inbox", lease: { purpose: "mailbox" }, survives: false },
    { label: "an orphaned worker tab", url: "about:blank", lease: { purpose: "chatgpt", slot: 0, key: "0:resume" }, survives: false },
    { label: "a captcha waiting for a person", url: "https://job-boards.greenhouse.io/", lease: { purpose: "captcha" }, survives: true },
    { label: "an orphan the person pinned", url: "https://example.com/pinned", lease: { purpose: "page" }, survives: true, pinned: true },
  ];
  // Identified by creation order rather than by address: Chrome hands out
  // tab ids in ascending order, and two of these are deliberately the same
  // address as a tab the live run already has open - which is the point,
  // since picking the run's tab by its URL is precisely the mistake the
  // ledger exists to make impossible.
  const highWater = await past.evaluate(async () => Math.max(0, ...(await chrome.tabs.query({})).map((tab) => tab.id)));
  for (const entry of staged) {
    const page = await context.newPage();
    await page.goto(entry.url, { waitUntil: "commit", timeout: 30000 }).catch(() => {});
    opened.push(page);
    entry.page = page;
  }

  // The run that opened them, taking each tab onto the ledger exactly as
  // `openTab` and the worker pool do, and then ageing the leases so they
  // are outside the idle window. Nothing is faked but the clock.
  const seeded = await past.evaluate(async ({ staged, highWater }) => {
    const ledger = await import("/src/tabs.js");
    const fresh = (await chrome.tabs.query({})).filter((tab) => tab.id > highWater).sort((a, b) => a.id - b.id);
    const ids = {};
    for (const [index, entry] of staged.entries()) {
      const tab = fresh[index];
      if (!tab) continue;
      ids[entry.label] = tab.id;
      if (entry.pinned) await chrome.tabs.update(tab.id, { pinned: true });
      if (entry.lease) await ledger.own(tab.id, entry.url, entry.lease);
    }
    // The live run's own leases are lifted out of the way for the length
    // of the sweep. They belong to a service worker that is alive and
    // working, and the whole subject here is what happens to the ones
    // left by a service worker that is not.
    const held = (await chrome.storage.session.get("applyBotOwnedTabs")).applyBotOwnedTabs ?? [];
    const mine = held.filter((lease) => Object.values(ids).includes(lease.tabId));
    await chrome.storage.session.set({ applyBotOwnedTabs: mine });
    return { ids, staged: mine.length, setAside: held.length - mine.length, live: held.filter((lease) => !Object.values(ids).includes(lease.tabId)) };
  }, { staged: staged.map(({ page, ...rest }) => rest), highWater });
  console.log(`staged ${seeded.staged} lease(s), ${seeded.setAside} of the live run's set aside; the service worker that held the staged ones is gone`);

  // The clock is the one thing simulated, because `lastAccessed` belongs
  // to Chrome and the idle window is ten minutes of real waiting. The
  // ownership, the generations, the tabs and the closing are all real.
  const closed = await present.evaluate(async () => {
    const ledger = await import("/src/tabs.js");
    const chat = await import("/src/chatgpt.js");
    const before = (await chrome.tabs.query({})).length;
    const closed = await ledger.reapTabs({ chat: chat.chatTabContext(), reviewBudget: 5, now: Date.now() + 10 * 60000 });
    return { before, after: (await chrome.tabs.query({})).length, closed, left: await ledger.ourTabs() };
  });
  await past.evaluate(async (live) => {
    const held = (await chrome.storage.session.get("applyBotOwnedTabs")).applyBotOwnedTabs ?? [];
    await chrome.storage.session.set({ applyBotOwnedTabs: [...live, ...held.filter((lease) => !live.some((entry) => entry.tabId === lease.tabId))] });
  }, seeded.live);

  console.log(`reaped: ${closed.before} tab(s) before the sweep, ${closed.after} after`);
  for (const entry of closed.closed) console.log(`  closed ${entry.purpose} ${entry.tabId}: ${entry.reason}`);
  console.log("");

  for (const entry of staged) {
    check(!entry.page.isClosed() === entry.survives, `${entry.label} was ${entry.survives ? "kept" : "closed"}`);
  }
  console.log(`\n  ${before.length} tab(s) before staging, ${closed.before} after staging, ${closed.after} after the sweep`);
  check(closed.left.every((lease) => ["captcha", "page"].includes(lease.purpose)), "only the leases that were spared are still on the ledger");
} finally {
  for (const page of opened) if (!page.isClosed()) await page.close().catch(() => {});
  await browser.close();
}

console.log(failures === 0 ? "\nlive tab reaper checks passed." : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
