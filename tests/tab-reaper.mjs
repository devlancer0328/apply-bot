/**
 * Which tabs may be closed, and the much longer list of which may not.
 *
 * The reaper exists because a run that is interrupted - and over a night
 * the service worker is interrupted repeatedly, Chrome tears it down after
 * thirty quiet seconds - leaves its tabs on screen with nothing in memory
 * that knows they were ever ours. By morning that is a window of postings,
 * feeds, Gmail searches and about:blank renderers on a machine whose disk
 * pressure has already killed the browser once.
 *
 * Every test below the first few is a negative one, and that is deliberate.
 * Closing a tab that was still being used is not a tidy-up that went a
 * little far: it is a filled application thrown away, a puzzle the
 * applicant was three seconds from solving, or one of the person's own
 * tabs vanishing while they were reading it. The decision is pure and
 * lives in one function so that all of it can be asserted here; the sweep
 * around it runs against a `chrome.tabs` stand-in that records what it was
 * asked to close.
 */

import assert from "node:assert/strict";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`  PASS  ${name}`); };

const NOW = 1_700_000_000_000;
const MINUTE = 60000;

/* A browser, as much of one as the ledger and the reaper actually touch. */
function browser({ tabs = [], focusedWindowId = 1, store = {} } = {}) {
  const open = new Map(tabs.map((tab) => [tab.id, { windowId: 1, pinned: false, audible: false, active: false, lastAccessed: NOW - 60 * MINUTE, url: "https://example.com/", ...tab }]));
  const removed = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [...open.values()],
      get: async (id) => { if (!open.has(id)) throw new Error("no tab"); return open.get(id); },
      remove: async (id) => { removed.push(id); open.delete(id); },
      create: async (info) => { const tab = { id: Math.max(0, ...open.keys()) + 1, windowId: 1, ...info }; open.set(tab.id, tab); return tab; },
      update: async (id, info) => Object.assign(open.get(id), info),
    },
    windows: { getLastFocused: async () => ({ id: focusedWindowId }), update: async () => ({}) },
    storage: { session: { get: async () => store, set: async (value) => Object.assign(store, value) } },
    scripting: { executeScript: async () => [] },
  };
  return { open, removed, store };
}

/**
 * A fresh copy of the module per test.
 *
 * The ledger is module state on purpose - it is the run's own memory of
 * what it opened - so the tests cannot share one, and a cache-busting
 * import is cheaper than an exported reset that only tests would call.
 */
let serial = 0;
const freshTabs = () => import(`../src/tabs.js?case=${++serial}`);

/* ------------------------------------------------------- the decision */

const lease = (extra = {}) => ({ tabId: 5, purpose: "page", generation: "this-run", usedAt: NOW - 30 * MINUTE, at: NOW - 30 * MINUTE, ...extra });
const tab = (extra = {}) => ({ id: 5, windowId: 1, pinned: false, audible: false, active: false, lastAccessed: NOW - 30 * MINUTE, url: "https://example.com/", ...extra });

const { tabVerdict, purposeOf } = await freshTabs();
const verdict = (tabPatch, leasePatch, context = {}) =>
  tabVerdict({ tab: tab(tabPatch), lease: leasePatch === null ? null : lease(leasePatch), context: { generation: "this-run", ...context }, now: NOW });

await test("a tab this bot never opened is never closed, whatever it looks like", () => {
  // The single most important line in the file. Ownership is a written
  // record, not a guess from the address: the person's own ChatGPT tab,
  // their own Gmail and the posting they are reading themselves all look
  // exactly like ours and none of them are.
  for (const url of ["https://chatgpt.com/c/theirs", "https://mail.google.com/mail/u/0/#inbox", "https://boards.greenhouse.io/acme/jobs/1", "about:blank"]) {
    assert.equal(verdict({ url }, null).close, false, url);
  }
  assert.match(verdict({}, null).reason, /not a tab this bot opened/);
});

await test("a captcha tab is never closed - not idle, not orphaned, not over budget", () => {
  const ways = [
    [{}, { purpose: "captcha" }],
    [{ lastAccessed: NOW - 10 * 60 * MINUTE }, { purpose: "captcha", usedAt: NOW - 10 * 60 * MINUTE }],
    [{}, { purpose: "captcha", generation: "a-dead-run" }],
  ];
  for (const [patch, held] of ways) {
    const said = tabVerdict({ tab: tab(patch), lease: lease(held), context: { generation: "this-run", overBudget: new Set([5]) }, now: NOW });
    assert.equal(said.close, false, JSON.stringify(held));
    assert.match(said.reason, /puzzle is waiting for a person/);
  }
});

await test("an attempt parked on an emailed security code keeps both its tabs", () => {
  // The slot is handed back while the mailbox is polled, so from outside
  // nothing is happening on either tab for minutes at a time. What says
  // they are in use is that the run holding them is still alive.
  assert.equal(verdict({ url: "https://boards.greenhouse.io/acme/jobs/1" }, { purpose: "application", usedAt: NOW - 20 * MINUTE }).close, false);
  assert.equal(verdict({ url: "https://mail.google.com/mail/u/0/#search/code" }, { purpose: "mailbox", usedAt: NOW - 20 * MINUTE }).close, false);
  assert.match(verdict({}, { purpose: "application" }).reason, /attempt of this run still holds it/);
});

await test("the ChatGPT tab a request is actually in is never closed, however long the reply takes", () => {
  const busy = { generation: "this-run", chat: { busy: new Set([5]), active: new Set() } };
  const working = verdict({ url: "https://chatgpt.com/c/x" }, { purpose: "chatgpt", slot: 2, usedAt: NOW - 60 * MINUTE }, busy);
  assert.equal(working.close, false);
  assert.match(working.reason, /a request is in this tab/);
});

await test("a busy slot does not shelter the other tabs it happens to own", () => {
  // Measured on a live run: a worker slot holds one tab per kind of task,
  // and reading "this slot is busy" as "all four of its tabs are in use"
  // kept two tabs idle for seven minutes while the slot worked in a
  // third. Only a slot that has not yet said which tab it took counts.
  const elsewhere = { generation: "this-run", chat: { busy: new Set([99]), active: new Set() } };
  assert.equal(verdict({ url: "https://chatgpt.com/c/y" }, { purpose: "chatgpt", slot: 2, usedAt: NOW - 60 * MINUTE }, elsewhere).close, true);
  const starting = { generation: "this-run", chat: { busy: new Set(), active: new Set([2]) } };
  assert.equal(verdict({ url: "https://chatgpt.com/c/y" }, { purpose: "chatgpt", slot: 2, usedAt: NOW - 60 * MINUTE }, starting).close, false);
  // And a slot number from a service worker that is gone proves nothing.
  assert.equal(verdict({ url: "https://chatgpt.com/c/y" }, { purpose: "chatgpt", slot: 2, generation: "a-dead-run", usedAt: NOW - 60 * MINUTE }, starting).close, true);
});

await test("a ChatGPT tab still streaming a reply is kept even though its slot is free", () => {
  const streaming = { generation: "this-run", chat: { busy: new Set(), active: new Set() }, replying: new Set([5]) };
  const said = verdict({ url: "https://chatgpt.com/c/x" }, { purpose: "chatgpt", slot: 1, usedAt: NOW - 60 * MINUTE }, streaming);
  assert.equal(said.close, false);
  assert.match(said.reason, /still streaming/);
});

await test("an idle worker tab is closed once its kind has gone quiet, and not before", () => {
  const idle = { generation: "this-run", chat: { busy: new Set(), active: new Set() } };
  assert.equal(verdict({ url: "https://chatgpt.com/c/x" }, { purpose: "chatgpt", slot: 1, usedAt: NOW - 4 * MINUTE }, idle).close, false);
  assert.equal(verdict({ url: "https://chatgpt.com/c/x" }, { purpose: "chatgpt", slot: 1, usedAt: NOW - 6 * MINUTE }, idle).close, true);
  assert.equal(verdict({ url: "about:blank" }, { purpose: "chatgpt", slot: 1, usedAt: NOW - 6 * MINUTE }, idle).close, true);
});

await test("a worker tab the person navigated somewhere else belongs to them now", () => {
  const idle = { generation: "this-run", chat: { busy: new Set(), active: new Set() } };
  const said = verdict({ url: "https://news.example.com/" }, { purpose: "chatgpt", slot: 1, usedAt: NOW - 60 * MINUTE }, idle);
  assert.equal(said.close, false);
  assert.match(said.reason, /navigated it somewhere else/);
});

await test("pinned, audible, in front, or just looked at means in use", () => {
  const dead = { generation: "this-run" };
  const orphan = { purpose: "page", generation: "a-dead-run", usedAt: NOW - 60 * MINUTE };
  assert.equal(verdict({ pinned: true }, orphan, dead).close, false);
  assert.equal(verdict({ audible: true }, orphan, dead).close, false);
  assert.equal(verdict({ active: true, windowId: 1 }, orphan, { ...dead, focusedWindowId: 1 }).close, false);
  assert.equal(verdict({ lastAccessed: NOW - MINUTE }, orphan, dead).close, false);
  // Active in a window nobody is looking at is not the same claim, and on
  // its own it would spare an abandoned tab forever.
  assert.equal(verdict({ active: true, windowId: 2 }, orphan, { ...dead, focusedWindowId: 1 }).close, true);
});

await test("an orphan from a previous service worker is reclaimed - the leak this exists for", () => {
  for (const purpose of ["page", "application", "feed", "mailbox", "chatgpt"]) {
    const url = purpose === "mailbox" ? "https://mail.google.com/mail/u/0/#inbox" : purpose === "chatgpt" ? "about:blank" : "https://example.com/";
    const said = tabVerdict({ tab: tab({ url }), lease: lease({ purpose, generation: "a-dead-run", usedAt: NOW - 60 * MINUTE }), context: { generation: "this-run", chat: { active: new Set() } }, now: NOW });
    assert.equal(said.close, true, purpose);
  }
  assert.match(verdict({}, { purpose: "feed", generation: "a-dead-run", usedAt: NOW - 60 * MINUTE }).reason, /left by an interrupted run/);
});

await test("a freshly opened orphan is left alone until the idle window has passed", () => {
  // A service worker can be torn down seconds after opening a tab, and the
  // next one must not race the first one's last await to the close.
  assert.equal(verdict({}, { purpose: "page", generation: "a-dead-run", usedAt: NOW - 2 * MINUTE }).close, false);
});

await test("review and dry-run tabs are kept, and orphaned ones only past the budget", () => {
  assert.equal(verdict({}, { purpose: "review" }).close, false, "this run's own review tab");
  assert.equal(verdict({}, { purpose: "review", generation: "a-dead-run" }).close, false, "an orphan inside the budget");
  const over = tabVerdict({ tab: tab(), lease: lease({ purpose: "review", generation: "a-dead-run" }), context: { generation: "this-run", overBudget: new Set([5]) }, now: NOW });
  assert.equal(over.close, true);
  assert.match(over.reason, /past the review budget/);
});

await test("a tab is read for what it was opened for", () => {
  assert.equal(purposeOf("https://chatgpt.com/?temporary-chat=true"), "chatgpt");
  assert.equal(purposeOf("https://mail.google.com/mail/u/0/#inbox"), "mailbox");
  assert.equal(purposeOf("https://jobright.ai/jobs/recommend"), "feed");
  assert.equal(purposeOf("https://hiring.cafe/"), "feed");
  assert.equal(purposeOf("https://job-boards.greenhouse.io/acme/jobs/1"), "application");
  assert.equal(purposeOf("https://acme.com/careers/1"), "page");
  assert.equal(purposeOf("about:blank"), "page");
});

/* ---------------------------------------------------------- the sweep */

await test("the sweep closes what nobody is using and leaves everything else where it is", async () => {
  const { own, hold, reapTabs } = await freshTabs();
  const world = browser({
    tabs: [
      { id: 1, url: "https://chatgpt.com/c/theirs" },                       // the person's own
      { id: 2, url: "https://job-boards.greenhouse.io/acme/jobs/1" },       // a captcha, held
      { id: 3, url: "https://jobright.ai/jobs/recommend" },                 // this run's feed
      { id: 4, url: "https://mail.google.com/mail/u/0/#search/code" },      // an orphan
      { id: 5, url: "about:blank" },                                        // an orphan worker tab
    ],
  });
  await own(2, "https://job-boards.greenhouse.io/acme/jobs/1");
  await hold(2, "captcha");
  await own(3, "https://jobright.ai/jobs/recommend");
  await own(4, "https://mail.google.com/mail/u/0/#search/code");
  await own(5, "", { purpose: "chatgpt", slot: 0, key: "0:resume" });
  // Both orphans: written by this generation, then aged and re-stamped as
  // another's, which is what a torn-down service worker leaves behind.
  world.store.applyBotOwnedTabs = world.store.applyBotOwnedTabs.map((entry) => ([4, 5].includes(entry.tabId) ? { ...entry, generation: "a-dead-run", usedAt: Date.now() - 60 * MINUTE } : entry));
  const { reapTabs: sweep } = await freshTabs();

  const closed = await sweep({ chat: { active: new Set(), replying: async () => false, forget: () => {} } });
  assert.deepEqual(world.removed.sort(), [4, 5], "only the two orphans");
  assert.deepEqual(closed.map((entry) => entry.purpose).sort(), ["chatgpt", "mailbox"]);
  assert.ok([...world.open.keys()].includes(2), "the captcha tab is still open");
  assert.ok([...world.open.keys()].includes(1), "the person's tab is untouched");
  assert.equal(typeof reapTabs, "function");
});

await test("the sweep asks the page before closing a worker tab whose slot has been released", async () => {
  const { own, reapTabs } = await freshTabs();
  const world = browser({ tabs: [{ id: 7, url: "https://chatgpt.com/c/x" }, { id: 8, url: "https://chatgpt.com/c/y" }] });
  await own(7, "", { purpose: "chatgpt", slot: 0, key: "0:resume" });
  await own(8, "", { purpose: "chatgpt", slot: 1, key: "1:answers" });
  for (const entry of world.store.applyBotOwnedTabs) entry.usedAt = Date.now() - 60 * MINUTE;

  const asked = [];
  const closed = await reapTabs({ chat: { active: new Set(), replying: async (id) => { asked.push(id); return id === 7; }, forget: () => {} } });
  assert.deepEqual(asked.sort(), [7, 8], "both condemned tabs were asked");
  assert.deepEqual(world.removed, [8], "the one still writing out a reply was spared");
  assert.deepEqual(closed.map((entry) => entry.key), ["1:answers"]);
});

await test("a tab that has gone loses its lease rather than being closed twice", async () => {
  const { own, reapTabs, ourTabs } = await freshTabs();
  const world = browser({ tabs: [{ id: 9, url: "https://example.com/" }] });
  await own(9, "https://example.com/");
  world.open.delete(9);
  const forgotten = [];
  await reapTabs({ chat: { active: new Set(), replying: async () => false, forget: (id) => forgotten.push(id) } });
  assert.deepEqual(world.removed, [], "nothing was asked to close");
  assert.deepEqual(forgotten, [9]);
  assert.deepEqual(await ourTabs(), []);
});

await test("the ledger outlives the service worker that wrote it", async () => {
  // The whole orphan story depends on this: a new generation has to be
  // able to read what the last one opened, which a module variable cannot
  // give it and session storage can.
  const { own } = await freshTabs();
  const world = browser({ tabs: [{ id: 3, url: "https://jobright.ai/jobs/recommend" }] });
  await own(3, "https://jobright.ai/jobs/recommend");
  const { ourTabs } = await freshTabs();
  const remembered = await ourTabs();
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].purpose, "feed");
  assert.ok(remembered[0].generation, "a lease says which service worker opened it");
  assert.equal(world.store.applyBotOwnedTabs.length, 1);
});

await test("a run that ends gives up its tabs, except the ones it left on purpose", async () => {
  // A service worker outlives many runs. Without this the generation rule
  // would read "opened by the service worker that is still here" as "a
  // run is still using it", and a tab a finished run failed to close
  // would be spared until the browser was restarted.
  const { own, hold, releaseOwned, reapTabs } = await freshTabs();
  const world = browser({
    tabs: [
      { id: 21, url: "https://jobright.ai/jobs/recommend" },
      { id: 22, url: "https://job-boards.greenhouse.io/acme/jobs/2" },
      { id: 23, url: "https://job-boards.greenhouse.io/acme/jobs/3" },
    ],
  });
  await own(21, "https://jobright.ai/jobs/recommend");
  await own(22, "https://job-boards.greenhouse.io/acme/jobs/2");
  await hold(22, "captcha");
  await own(23, "https://job-boards.greenhouse.io/acme/jobs/3");
  await hold(23, "review");

  const chat = { active: new Set(), replying: async () => false, forget: () => {} };
  assert.deepEqual(await reapTabs({ chat }), [], "while the run is going, nothing of its own is touched");
  await releaseOwned();
  const closed = await reapTabs({ chat, now: Date.now() + 10 * 60000 });
  assert.deepEqual(closed.map((entry) => entry.tabId), [21], "the feed it forgot to close");
  assert.deepEqual(world.removed, [21]);
  assert.ok([...world.open.keys()].includes(22) && [...world.open.keys()].includes(23), "the captcha and the review tab were left on purpose");
});

await test("being used does not adopt a tab the bot never opened", async () => {
  const { touch, hold, ourTabs } = await freshTabs();
  browser({ tabs: [{ id: 11, url: "https://example.com/" }] });
  assert.equal(await touch(11), null, "an unknown tab is not written down by being touched");
  assert.deepEqual(await ourTabs(), []);
  // Holding one for a person is the deliberate exception: the engine may
  // have adopted a tab the applicant already had open, and a captcha on it
  // still has to be protected.
  await hold(11, "captcha");
  assert.deepEqual((await ourTabs()).map((entry) => entry.purpose), ["captcha"]);
});

delete globalThis.chrome;
console.log(`${count} tab lifecycle checks passed.`);
