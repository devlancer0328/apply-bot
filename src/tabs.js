/** Discover service tabs by URL across windows. Prefer the focused window and recent activity; tab positions are irrelevant. Serialize foreground work to avoid browser throttling. */

import { atsOf } from "./ats.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loading longer than this is given up on - unless the document is already usable. */
const LOAD_TIMEOUT_MS = 90000;

/**
 * How long a parsed page is given to go from interactive to complete before
 * it is used as it is. Past this what is still loading is an analytics
 * beacon or an image, not the form.
 */
const INTERACTIVE_GRACE_MS = 3000;

/**
 * Choose by service URL, focused window, and last activity.
 */
export async function findTab(patterns, accept = () => true) {
  const [tabs, window] = await Promise.all([chrome.tabs.query({ url: patterns }), chrome.windows.getLastFocused().catch(() => null)]);
  const usable = tabs.filter(tab => tab.id && accept(tab));
  usable.sort((a, b) => Number(b.windowId === window?.id) - Number(a.windowId === window?.id) || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
  return usable[0] ?? null;
}

/** Brings a tab, and its window, to the front. */
export async function focus(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tab;
}

/* ----------------------------------------------------------- the front */

/**
 * Only one tab can be in front, so page work takes turns at it.
 *
 * Three postings being opened at once meant three tabs loading at once, of
 * which only the active one loaded at speed; the others sat throttled until
 * their turn came, if it came before the deadline. So every stretch of work
 * that needs a tab on screen - loading a posting, following its apply
 * button, reading a mailbox, putting a prompt to ChatGPT - goes through
 * `atFront`, which runs them one after another.
 *
 * The form being filled is the resident: it stays in front between turns,
 * and gets the front back the moment a turn ends.
 */
let line = Promise.resolve();
let residentId = null;

/** The tab that should be in front whenever nothing else needs it. */
export function resident(tabId) {
  residentId = tabId ?? null;
}

export async function atFront(work) {
  const turn = line.then(work, work);
  line = turn.then(
    () => {},
    () => {},
  );
  try {
    return await turn;
  } finally {
    if (residentId !== null) await focus(residentId);
  }
}

/** Runs inside the page. Where the document is in its loading. */
function readiness() {
  return { state: document.readyState, href: location.href };
}

/**
 * Resolves once the page in the tab is usable.
 *
 * Chrome's own "complete" for a tab waits on every last resource, and a
 * page that is otherwise ready can sit on a slow tracker or font for most
 * of a minute, which is how jobs were being lost to the load timeout. So
 * the document is asked directly: parsed and fully loaded is done, parsed
 * and still fetching is done after a short grace, and only a page that has
 * not even parsed by the deadline is given up on.
 */
export async function settled(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  const started = Date.now();
  let interactiveSince = 0;
  // A reload or navigation takes a moment to register as "loading".
  await wait(300);

  for (;;) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error("the tab closed before the page loaded");
    if (current.status === "complete" && !current.pendingUrl) return tabId;

    // The document is only worth asking once the tab is on its page: before
    // that the answer is about:blank's, which is always "complete".
    let page = null;
    if (!current.pendingUrl && /^https?:/.test(current.url ?? "")) {
      page = await chrome.scripting
        .executeScript({ target: { tabId }, func: readiness })
        .then((results) => results[0]?.result)
        .catch(() => null);
      if (page && !/^https?:/.test(page.href ?? "")) page = null;
    }

    if (page?.state === "complete") return tabId;
    if (page?.state === "interactive") {
      interactiveSince ||= Date.now();
      if (Date.now() - interactiveSince >= INTERACTIVE_GRACE_MS) return tabId;
    } else {
      interactiveSince = 0;
    }

    if (Date.now() - started > timeoutMs) {
      if (page?.state) return tabId;
      throw new Error(`the page did not finish loading within ${Math.round(timeoutMs / 1000)} seconds`);
    }
    await wait(250);
  }
}

/** Opens an address in a new tab at the front and waits for the page. */
export async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await own(tab.id, url);
  return settled(tab.id);
}

/** Moves an open tab to an address and waits for the page. */
export async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await touch(tabId);
  await focus(tabId);
  return settled(tabId);
}

/** Reloads an open tab and waits for the page. A discarded tab comes back the same way. */
export async function reload(tabId) {
  await focus(tabId);
  await touch(tabId);
  await chrome.tabs.reload(tabId);
  return settled(tabId);
}

/* ------------------------------------------------- the tabs we opened */

/**
 * The ledger of tabs this bot opened, and the one rule that decides when
 * one of them may be closed.
 *
 * A night's run leaves tabs behind. The worker tabs were the visible half
 * and had their own reaper; the rest were not. A run that reached its end
 * cleanly closed almost everything, and a run that did not - the service
 * worker torn down between two awaits, which Chrome does whenever thirty
 * seconds pass with no extension API call - left whatever was open on
 * screen with nothing in memory that knew it was ours: the posting being
 * read, the Jobright feed, the Gmail search opened for a security code,
 * the about:blank a worker tab had not yet navigated. By morning that is a
 * window of forty renderers on a machine whose disk pressure has already
 * killed the browser once.
 *
 * Closing them is easy and getting it wrong is not recoverable, so the
 * ledger exists to make ownership a fact rather than a guess. A tab is
 * only ever a candidate if this bot opened it and said so at the time;
 * the person's own ChatGPT tab, their own Gmail, the posting they are
 * reading themselves are not in here and can never be chosen, however
 * much they look like ours.
 *
 * Session storage rather than a module variable for the reason above: the
 * ledger has to outlive the service worker that wrote it, because the tabs
 * do. Not local storage, which would outlive it too far - Chrome hands
 * out tab ids afresh every time it starts, so a ledger carried across a
 * browser restart would be a list of other people's tabs with our names
 * against them. Session storage is cleared exactly when tab ids stop
 * meaning anything, which also means an extension reload drops it: the
 * tabs that reload orphans are left alone for good rather than closed on
 * a guess, and that is the right way round.
 */
const LEDGER_KEY = "applyBotOwnedTabs";

/**
 * Which service worker opened a tab.
 *
 * This is what makes an abandoned tab safe to close. Nothing of a run
 * survives its service worker - no attempt, no engine, no await - so a
 * lease written by a previous generation describes work that is already
 * dead, and the tab under it is an orphan by definition rather than by
 * guess. A lease from this generation is the exact opposite: some await
 * somewhere is still holding that tab, and it is never touched.
 */
const GENERATION = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;

/** How long a tab we opened is left alone after its last use. */
const IDLE_MS = 5 * 60000;

/**
 * How recently the person has to have been on a tab for it to count as
 * theirs. Chrome stamps `lastAccessed` when a tab is brought to the front,
 * so this catches the case the ledger cannot: a tab that was ours, that
 * they have since gone and looked at.
 */
const TOUCHED_MS = 2 * 60000;

/** Forms left open for a person, as many as background.js keeps. */
const REVIEW_BUDGET = 5;

const leases = new Map();
let restored = null;
const sessionStore = () => globalThis.chrome?.storage?.session ?? null;

async function ledger() {
  restored ||= (async () => {
    const stored = await sessionStore()?.get(LEDGER_KEY).catch(() => null);
    for (const lease of stored?.[LEDGER_KEY] ?? []) if (!leases.has(lease.tabId)) leases.set(lease.tabId, lease);
  })();
  await restored;
  return leases;
}

// Chained so two leases written in the same tick cannot each store the
// list as it was before the other, and awaited so that what the next
// service worker reads is never a tick behind what this one did - a lease
// lost that way is an orphan nobody can prove is ours.
let writing = Promise.resolve();
async function persist() {
  const store = sessionStore();
  if (!store) return;
  writing = writing.then(() => store.set({ [LEDGER_KEY]: [...leases.values()] })).catch(() => {});
  await writing;
}

/**
 * What a tab was opened for. Only the kept-for-a-person purposes change
 * what happens to it; the rest are for the log line, where "closed 3
 * feed tabs left by an interrupted run" is the sentence that tells
 * somebody the reaper is doing the right thing.
 */
export function purposeOf(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "page";
  }
  if (/(^|\.)(chatgpt\.com|chat\.openai\.com)$/i.test(host)) return "chatgpt";
  if (/(^|\.)mail\.google\.com$/i.test(host)) return "mailbox";
  if (/(^|\.)(jobright\.ai|hiringcafe\.com|hiring\.cafe)$/i.test(host)) return "feed";
  return atsOf(url) ? "application" : "page";
}

/** Takes a tab onto the ledger. `extra` names a purpose the address cannot. */
export async function own(tabId, url = "", extra = {}) {
  const map = await ledger();
  const now = Date.now();
  map.set(tabId, { tabId, purpose: purposeOf(url), url, ...extra, generation: GENERATION, at: map.get(tabId)?.at ?? now, usedAt: now });
  await persist();
  return map.get(tabId);
}

/** Says a tab we own is still being used. Unknown tabs are not adopted by being used. */
export async function touch(tabId, extra = {}) {
  const map = await ledger();
  const lease = map.get(tabId);
  if (!lease) return null;
  map.set(tabId, { ...lease, ...extra, usedAt: Date.now() });
  await persist();
  return map.get(tabId);
}

/**
 * Marks a tab as left open on purpose, for a person to finish.
 *
 * `captcha` is the strongest claim in the file: the form behind it is
 * filled and one human click from being sent, the click can only happen
 * on that page, and no folder can recreate it. Ashby and Lever puzzles
 * were being closed out from under the applicant before this existed, so
 * a captcha lease is never reaped - not when it is idle, not when it is
 * orphaned, not when the budget is full.
 */
export async function hold(tabId, purpose) {
  const map = await ledger();
  const now = Date.now();
  map.set(tabId, { tabId, url: "", ...map.get(tabId), purpose, at: map.get(tabId)?.at ?? now, usedAt: now, generation: GENERATION });
  await persist();
  return map.get(tabId);
}

/**
 * Says the run that opened these tabs is over.
 *
 * Without this, a tab a finished run failed to close would be spared for
 * as long as the service worker happened to live - the generation rule
 * reads "this generation" as "still being used", which is true while a
 * run is going and false the moment it ends. What a run deliberately left
 * behind keeps its claim: that is the whole of the review and captcha
 * purposes, and they are what the person is meant to find in the morning.
 */
export async function releaseOwned({ keepCaptcha = true } = {}) {
  const map = await ledger();
  const kept = keepCaptcha ? ["captcha", "review"] : ["review"];
  for (const [tabId, lease] of map) {
    if (kept.includes(lease.purpose)) continue;
    map.set(tabId, { ...lease, generation: "" });
  }
  await persist();
}

/** Drops a tab from the ledger. Does not close it; the caller has, or the person has. */
export async function disown(tabId) {
  const map = await ledger();
  if (!map.delete(tabId)) return false;
  await persist();
  return true;
}

/** The leases we hold, all of them or one purpose's. */
export async function ourTabs(purpose = "") {
  const map = await ledger();
  return [...map.values()].filter((lease) => !purpose || lease.purpose === purpose);
}

/**
 * Is this tab still in use?
 *
 * Pure, and the only answer to the question - the reaper does no judging
 * of its own - because every way of getting this wrong destroys something
 * the run cannot make again. The order is the argument: the cheapest and
 * most absolute reasons to leave a tab alone are asked first, and closing
 * is what is left when none of them hold.
 */
export function tabVerdict({ tab, lease, context = {}, now = Date.now() }) {
  const idleMs = context.idleMs ?? IDLE_MS;
  if (!tab) return { close: false, reason: "the tab is already gone" };
  // The person's own tabs. Not a heuristic and not overridable: if this
  // bot did not open it and write it down, it is not ours to close.
  if (!lease) return { close: false, reason: "not a tab this bot opened" };
  // A puzzle tab holds a filled form one human click from being sent, so
  // it outranks every other reason to keep a tab - but only while
  // somebody is going to make that click. Unattended, the click never
  // comes and the window fills with finished forms nobody will finish,
  // which is why `keepCaptcha` is a setting and not a constant. Off, the
  // tab falls through to the ordinary idle rules below rather than being
  // closed on the spot: the answers are already saved to the folder, and
  // a person who is at the machine still gets the idle window to notice
  // the puzzle and solve it.
  if (lease.purpose === "captcha" && context.keepCaptcha !== false) return { close: false, reason: "a puzzle is waiting for a person" };
  // Three things only a person does with a tab, and one thing only a
  // person causes. A tab they pinned, a tab making noise, the tab they
  // are looking at, and a tab they were on a moment ago are all in use
  // whatever the ledger thinks the run is doing with it.
  if (tab.pinned) return { close: false, reason: "pinned" };
  if (tab.audible) return { close: false, reason: "playing sound" };
  if (tab.active && tab.windowId === context.focusedWindowId) return { close: false, reason: "in front of the person" };
  if (now - (tab.lastAccessed ?? 0) < TOUCHED_MS) return { close: false, reason: "the person was on it a moment ago" };
  // A tab opened for one service and now showing another was taken over
  // by somebody, and it was not us. Only asked of the two purposes that
  // name a service for their whole life; a form tab moves between
  // addresses as a matter of course, and a feed hops to a posting.
  if (["chatgpt", "mailbox"].includes(lease.purpose) && tab.url && tab.url !== "about:blank" && purposeOf(tab.url) !== lease.purpose) {
    return { close: false, reason: "the person navigated it somewhere else" };
  }

  const mine = lease.generation === (context.generation ?? GENERATION);
  // A dry run's filled form and a form kept back to be glanced at. Both
  // are the point of the run that made them, so they are only ever closed
  // the way background.js closes them - oldest first, past the budget -
  // and here only once their run is gone and cannot do it itself.
  if (lease.purpose === "review") {
    if (mine || !context.overBudget?.has(tab.id)) return { close: false, reason: "kept open for review" };
    return { close: true, reason: "a review tab from an interrupted run, past the review budget" };
  }
  if (lease.purpose === "chatgpt") {
    // A request is in this tab; a request has a slot but has not named
    // its tab yet; the page is still writing a reply out. All three are
    // asked, and the first two only of this generation's tabs - an
    // in-memory slot number means nothing about a tab an earlier service
    // worker opened.
    if (mine && context.chat?.busy?.has(tab.id)) return { close: false, reason: "a request is in this tab" };
    if (mine && context.chat?.active?.has(lease.slot)) return { close: false, reason: "its worker slot has just taken a request" };
    if (context.replying?.has(tab.id)) return { close: false, reason: "a reply is still streaming" };
    if (now - (lease.usedAt ?? 0) < idleMs) return { close: false, reason: "used within the idle window" };
    return { close: true, reason: mine ? "an idle worker tab" : "a worker tab left by an interrupted run" };
  }
  // Everything else - the posting being read, the feed, the Gmail search,
  // the form being filled, the attempt parked on an emailed code. While
  // the run that opened it is alive, something is holding it and nothing
  // out here can tell what; once that run is gone, nothing is.
  if (mine) return { close: false, reason: "an attempt of this run still holds it" };
  if (now - (lease.usedAt ?? 0) < idleMs) return { close: false, reason: "used too recently to call abandoned" };
  return { close: true, reason: `a ${lease.purpose} tab left by an interrupted run` };
}

/**
 * Closes the tabs nothing is using, and reports what it closed and why.
 *
 * `context.chat` is how the ChatGPT side answers for its own tabs without
 * this file importing it: which worker slots are busy, whether a page is
 * mid-reply, and what to forget when a tab goes. `context.only` narrows
 * the sweep to one purpose.
 */
export async function reapTabs(context = {}) {
  const map = await ledger();
  const now = context.now ?? Date.now();
  const wanted = [...map.values()].filter((lease) => !context.only || lease.purpose === context.only);
  if (wanted.length === 0) return [];

  const focusedWindowId = context.focusedWindowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id ?? -1;
  const live = new Map((await chrome.tabs.query({}).catch(() => [])).map((tab) => [tab.id, tab]));
  // Tabs that are gone take their lease with them, whoever closed them.
  for (const lease of wanted) {
    if (live.has(lease.tabId)) continue;
    map.delete(lease.tabId);
    await context.chat?.forget?.(lease.tabId, lease);
  }

  // The review budget, counted over orphans only: a run still alive keeps
  // its own forms under the cap, and this is the arithmetic it would have
  // done had it lived. Newest kept, captcha leases never in the reckoning.
  const orphanReviews = wanted
    .filter((lease) => lease.purpose === "review" && lease.generation !== GENERATION && live.has(lease.tabId))
    .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
  const overBudget = new Set(orphanReviews.slice(context.reviewBudget ?? REVIEW_BUDGET).map((lease) => lease.tabId));

  const decide = (replying) =>
    wanted
      .filter((lease) => live.has(lease.tabId))
      .map((lease) => ({ lease, tab: live.get(lease.tabId), verdict: tabVerdict({ tab: live.get(lease.tabId), lease, context: { ...context, focusedWindowId, overBudget, replying }, now }) }));

  // A worker tab whose slot is free can still be streaming - the slot is
  // released when the request resolves, and a retry that gave up on a
  // reply leaves the page writing it out. The page is asked only about
  // tabs already condemned, so a quiet run pays nothing for the check.
  const replying = new Set();
  for (const entry of decide(replying)) {
    if (entry.verdict.close && entry.lease.purpose === "chatgpt" && (await context.chat?.replying?.(entry.tab.id))) replying.add(entry.tab.id);
  }

  const closed = [];
  for (const entry of decide(replying)) {
    if (!entry.verdict.close) continue;
    await chrome.tabs.remove(entry.tab.id).catch(() => {});
    map.delete(entry.lease.tabId);
    await context.chat?.forget?.(entry.lease.tabId, entry.lease);
    closed.push({ tabId: entry.lease.tabId, purpose: entry.lease.purpose, key: entry.lease.key ?? "", url: entry.tab.url ?? "", reason: entry.verdict.reason });
  }
  await persist();
  return closed;
}
