/**
 * The one mistake that cannot be taken back.
 *
 * Every other failure in this system costs an application. Sending two to
 * the same posting costs the candidate the employer, because the duplicate
 * is visible from the other side and there is no undo. An MV3 service
 * worker is killed without warning - Chrome ends an idle one after thirty
 * seconds and a busy one whenever it feels like it - so "the worker died
 * halfway through an application" is not an edge case, it is a thing that
 * happens several times in an unattended day. The question this file
 * exists to answer is whether it can produce two.
 *
 * ## Why this runs the real database
 *
 * The protection is a row written into SQLite inside a transaction,
 * exported and flushed to an OPFS file, immediately before Submit is
 * pressed (`claimSubmission` in database.js, called from `applyTo` in
 * apply/engine.js). Every part of that sentence has to be true for the
 * property to hold, and all but one of them are invisible to a test that
 * stubs the store out: that the write is committed rather than buffered,
 * that the file on disk has it before the click rather than after, and
 * that a second claim against the same posting is refused by the real
 * matching rules rather than by a fixture's idea of them.
 *
 * So `src/database.js` is loaded for real, against an in-memory OPFS and
 * the real sql.js wasm. A worker restart is a fresh import of that module
 * over the same bytes, which is exactly what a new service worker does.
 * The only thing invented is the browser.
 *
 * ## What "killed" means here
 *
 * A killed worker does not throw; it stops existing. An exception would be
 * caught by the engine and turned into an outcome, which is the opposite
 * of what is being tested. So a kill is an operation that never resolves -
 * the engine is frozen exactly where the worker died, cannot press
 * anything else, and its result is discarded - and the count that matters
 * is kept on the page, because the number of times the employer's Submit
 * button was pressed is the only definition of a duplicate that matters.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { createAdapterRegistry, OUTCOMES } from "../src/apply/contract.js";
import { genericAdapter } from "../src/apply/adapters/generic.js";
import { applyTo } from "../src/apply/engine.js";
import { answerContext } from "../src/apply/answer-context.js";
import { toRunResult } from "../src/apply/run-bridge.js";
import { withDefaults } from "../src/profile.js";
import { historyIndex } from "../src/history.js";

const HERE = new URL("../", import.meta.url);
const pageScript = await readFile(new URL("src/fill.js", HERE), "utf8");
const wasm = await readFile(new URL("src/vendor/sql-wasm.wasm", HERE));

let count = 0;
const test = async (name, work) => { await work(); count++; console.log("PASS " + name); };

/* ------------------------------------------------------------- the disk */

/**
 * OPFS, in memory.
 *
 * Deliberately byte-for-byte rather than a Map of records: the thing being
 * asserted is that a *file* on disk carries the claim at a given instant,
 * and a snapshot taken mid-run has to be openable by a database module
 * that knows nothing about this test.
 */
const disk = new Map();
const directory = {
  async getFileHandle(name, { create = false } = {}) {
    if (!disk.has(name)) {
      if (!create) throw Object.assign(new Error("no such file"), { name: "NotFoundError" });
      disk.set(name, new Uint8Array());
    }
    return {
      getFile: async () => ({ arrayBuffer: async () => copy(disk.get(name)).buffer }),
      createWritable: async () => ({ write: async (bytes) => disk.set(name, copy(bytes)), close: async () => {}, abort: async () => {} }),
    };
  },
};
const copy = (bytes) => Uint8Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
const FILE = "apply-bot.sqlite3";

Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: async () => directory } }, configurable: true, writable: true });
globalThis.chrome = { runtime: { getURL: (path) => `stub://${path}` }, storage: { local: { get: async () => ({}) } } };
globalThis.indexedDB = { databases: async () => [] };
globalThis.fetch = async () => ({ arrayBuffer: async () => copy(wasm).buffer });

/**
 * A service worker, as far as the database is concerned.
 *
 * A fresh import is a fresh module instance with no connection, no cached
 * rows and no queue, which opens the OPFS file from whatever bytes are on
 * it. That is precisely what Chrome does when it kills one worker and
 * starts another, and it is the only honest way to ask whether the day's
 * protection survived.
 */
let generation = 0;
const bootWorker = async () => (await import(`../src/database.js?worker=${++generation}`)).databaseRequest;

const claimThrough = (request) => (application) => request({ action: "claimSubmission", value: { applyUrl: application.applyUrl, sourceUrl: application.sourceUrl, id: application.id, company: application.company, title: application.title } });

/* ------------------------------------------------------------- the page */

const FORM = `
  <h1>Senior Engineer</h1>
  <form method="post" action="/careers/apply">
    <label for="fn">First name *</label><input id="fn" name="first_name" required>
    <label for="ln">Last name *</label><input id="ln" name="last_name" required>
    <label for="em">Email address *</label><input id="em" name="email" type="email" required>
    <label for="ph">Phone *</label><input id="ph" name="phone" required>
    <label for="cv">Resume *</label><input id="cv" name="resume" type="file" required>
    <label for="li">LinkedIn profile</label><input id="li" name="linkedin">
    <button type="submit">Submit application</button>
  </form>`;
const THANKS = "<h1>Thank you for applying</h1><p>We have received your application.</p>";

function page(html, { url, onSubmit }) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  for (const name of ["MouseEvent", "PointerEvent", "InputEvent", "FocusEvent", "DragEvent"]) if (!window[name]) window[name] = class extends window.Event {};
  const element = window.Element?.prototype ?? window.HTMLElement.prototype;
  element.focus ??= function () {};
  element.scrollIntoView ??= function () {};
  element.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, width: 200, height: 30, right: 200, bottom: 30 }; };
  Object.defineProperty(element, "offsetParent", { configurable: true, get() { return this.ownerDocument.body; } });

  const resources = [];
  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) resources.push({ name: `https://fixtureco.example/upload/${file.name}`, startTime: performance.now() });
    });
  }
  for (const button of document.querySelectorAll("button, input[type='submit']")) button.addEventListener("click", () => onSubmit(document));

  const context = vm.createContext({
    window, document,
    location: { href: url, hostname: new URL(url).hostname, origin: new URL(url).origin },
    setTimeout, clearTimeout, console, URL, Blob, Uint8Array, atob, btoa,
    performance: { now: () => performance.now(), getEntriesByType: (kind) => (kind === "resource" ? resources : []) },
    CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement, HTMLElement: window.HTMLElement, Element: window.Element,
    Event: window.Event, MouseEvent: window.MouseEvent, PointerEvent: window.PointerEvent,
    InputEvent: window.InputEvent, FocusEvent: window.FocusEvent, DragEvent: window.DragEvent,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
    File: class { constructor(parts, name, options) { this.name = name; this.type = options?.type ?? ""; this.parts = parts?.[0] ?? []; this.size = this.parts.length ?? 0; } },
  });
  context.globalThis = context;
  context.window = context;
  for (const key of ["__ghApply", "__ghApplyInflight", "__ghApplyRequests", "__ghApplyTracking"]) delete window[key];
  vm.runInContext(pageScript, context);
  return { document, window, context };
}

/**
 * The employer, who counts presses and does not care which worker made them.
 *
 * `presses` survives a restart because the form does: a second worker
 * opening a second tab at the same posting is the scenario, and two
 * presses across two tabs is still two applications.
 */
function employer(url, company) {
  const record = { url, company, presses: 0, snapshots: [] };
  let live = null;
  const press = (document) => {
    record.presses += 1;
    // The disk, exactly as it stood at the instant the employer saw the
    // click. Kept so a later worker can be booted from it and asked
    // whether the claim was already there.
    record.snapshots.push(copy(disk.get(FILE) ?? new Uint8Array()));
    document.body.innerHTML = THANKS;
  };
  return {
    record,
    /** A new tab. The page is rebuilt; the employer's tally is not. */
    reopen() { live = page(FORM, { url, onSubmit: press }); return live; },
    current() { return live ?? this.reopen(); },
  };
}

function browserFor(site) {
  const closed = [];
  return {
    closed,
    openTab: async () => { site.reopen(); return 1; },
    adoptTab: async (tabId) => ({ id: tabId, url: site.record.url, title: "" }),
    closeTab: async (tabId) => closed.push(tabId),
    navigate: async () => {},
    inject: async () => [],
    findTab: async () => null,
    info: async () => ({ url: site.record.url, status: "complete", title: "" }),
    capture: async () => ({ url: site.record.url, title: "Fixture", capturedAt: Date.now() }),
    frames: async () => [{ frameId: 0, url: site.record.url }],
    inFrame: async (tabId, frameId, fn, args = []) => {
      const call = vm.runInContext(`(${fn.toString()})`, site.current().context);
      const value = await call(...args);
      const answer = value === undefined ? null : JSON.parse(JSON.stringify(value));
      return frameId === undefined ? [{ frameId: 0, result: answer }] : answer;
    },
  };
}

/* ------------------------------------------------------------ one attempt */

const PROFILE = withDefaults({
  firstName: "Daniel", lastName: "Torres", email: "someone@example.test", phone: "+1 (929) 489-1252",
  city: "Temple", state: "TX", country: "United States", linkedin: "https://linkedin.com/danieltorres8483",
  workAuthorization: "us-citizen", requiresSponsorship: "no", nonCompete: "no", over18: "yes",
});
const RESUME = new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/pdf" });
const requestFor = (site) => ({
  id: site.record.url, applyUrl: site.record.url, sourceUrl: site.record.url, company: site.record.company, title: "Senior Engineer",
  jd: "A fixture posting. Never sent anywhere.",
  documents: { resume: RESUME, resumeName: "generated-resume.pdf" },
  resumeText: "Daniel Torres", profile: PROFILE, policy: { review: false, register: false },
});

/**
 * One attempt, through the real engine.
 *
 * `freeze` names the adapter operation the worker is killed at. Reaching
 * it is what ends the attempt, rather than a timer, so the kill lands on
 * the step it is aimed at however long the steps before it took. The
 * engine is left suspended rather than rejected, because a rejection is
 * something the engine handles and a dead worker is not.
 */
async function attempt(site, claim, { freeze = "", onClaim = () => {} } = {}) {
  const request = requestFor(site);
  let died;
  const killed = new Promise((resolve) => { died = () => resolve({ status: "worker-killed", evidence: {} }); });
  const registry = createAdapterRegistry([freeze ? { ...genericAdapter, [freeze]: () => { died(); return new Promise(() => {}); } } : genericAdapter]);
  const services = {
    answers: async (questions) => ({ answers: questions.map((question) => ({ key: question.key, value: "Remote" })), unanswered: [], forced: [] }),
    claimCompany: async (value) => { const answer = await claim(value); onClaim(answer); return answer; },
  };
  const work = applyTo({ request: { ...request, answerContext: answerContext(request, PROFILE) }, registry, browser: browserFor(site), services, log: () => {} });
  if (!freeze) return work;
  return Promise.race([work, killed]);
}

/* ------------------------------------------------------------ the claims */

await test("A posting that has been claimed once cannot be claimed again by a new worker", async () => {
  const url = "https://acme-one.example/careers/apply";
  const first = await bootWorker();
  assert.equal((await claimThrough(first)({ applyUrl: url, company: "Acme One", title: "Senior Engineer", id: url })).claimed, true);
  // The whole of the protection, as a new service worker sees it: nothing
  // in memory, everything read back off the file.
  const second = await bootWorker();
  const refused = await claimThrough(second)({ applyUrl: url, company: "Acme One", title: "Senior Engineer", id: url });
  assert.equal(refused.claimed, false);
  assert.equal(refused.record.kind, "submission");
});

/**
 * The release, against the real database and a real restart.
 *
 * A claim taken for an application that then did not happen used to be
 * permanent: there was no release path anywhere in the codebase, so a
 * board that answered Submit with a puzzle removed that posting from the
 * bot's reach for good. At the rate it was measured - two in five Lever
 * attempts - an unattended night would have spent a large share of the
 * employers it touched on applications nobody made.
 *
 * Driven through a fresh worker on both sides for the same reason the
 * claim is: what matters is that the row is gone from the *file*, because
 * the worker that reads it next is never the one that wrote it.
 */
await test("An employer released after an application that never happened can be claimed again by a new worker", async () => {
  const url = "https://acme-released.example/careers/apply";
  const posting = { applyUrl: url, company: "Acme Released", title: "Senior Engineer", id: url };
  const claimed = await bootWorker();
  assert.equal((await claimThrough(claimed)(posting)).claimed, true);

  const releasing = await bootWorker();
  assert.equal((await releasing({ action: "releaseSubmission", value: { applyUrl: url } })).released, true);

  const after = await bootWorker();
  assert.equal((await claimThrough(after)(posting)).claimed, true, "the released employer is still barred");
});

await test("Releasing touches only this bot's own claim: an imported never-approach row survives it", async () => {
  const url = "https://acme-barred.example/careers/apply";
  const request = await bootWorker();
  await request({ action: "historyImport", value: [{ company: "Acme Barred" }] });
  // An applicant's own "already applied here" statement is not a claim and
  // nothing may delete one; a release that could would quietly reopen an
  // employer they asked never to approach.
  assert.equal((await request({ action: "releaseSubmission", value: { applyUrl: url } })).released, false);
  assert.equal((await claimThrough(request)({ applyUrl: url, company: "Acme Barred", title: "Engineer", id: url })).claimed, false);
});

await test("Two attempts at one posting in the same worker cannot both be granted", async () => {
  const url = "https://acme-two.example/careers/apply";
  const request = await bootWorker();
  const both = await Promise.all([claimThrough(request)({ applyUrl: url, company: "Acme Two", title: "A", id: url }), claimThrough(request)({ applyUrl: url, company: "Acme Two", title: "B", id: url })]);
  assert.deepEqual(both.map((answer) => answer.claimed).sort(), [false, true]);
});

/* ------------------------------------------- the worker dying mid-application */

await test("A worker killed after Submit leaves the claim on disk, so the restart never presses again", async () => {
  const site = employer("https://acme-three.example/careers/apply", "Acme Three");
  const dying = await bootWorker();
  // Frozen at the step that reads the page after Submit: the button has
  // been pressed, the employer has the application, and nothing was
  // written down about it. This is the worst moment there is.
  const lost = await attempt(site, claimThrough(dying), { freeze: "readOutcome" });
  assert.equal(lost.status, "worker-killed");
  assert.equal(site.record.presses, 1);

  const resumed = await bootWorker();
  const again = await attempt(site, claimThrough(resumed));
  assert.equal(again.status, OUTCOMES.REJECTED);
  assert.match(again.reason, /already applied/);
  assert.equal(site.record.presses, 1, "the employer must never see a second application");
  // And the queue files it as somebody else's job rather than as a failure
  // worth a by-hand folder, which is what keeps a refused claim from
  // producing a second application next week.
  assert.equal(toRunResult(again, { claimRefused: true }).status, "skipped");
});

await test("The claim is on the disk before the employer sees the click, not after", async () => {
  const site = employer("https://acme-four.example/careers/apply", "Acme Four");
  const request = await bootWorker();
  const outcome = await attempt(site, claimThrough(request));
  assert.equal(outcome.status, OUTCOMES.CONFIRMED);
  assert.equal(site.record.presses, 1);

  // The bytes as they stood at the instant of the press, handed to a
  // worker that has never heard of this run. If it refuses the claim, the
  // commit and the flush both happened before the button, which is the
  // only ordering that makes a kill mid-click survivable.
  disk.set(FILE, site.record.snapshots[0]);
  const atTheClick = await bootWorker();
  const refused = await claimThrough(atTheClick)({ applyUrl: site.record.url, company: site.record.company, title: "Senior Engineer", id: site.record.url });
  assert.equal(refused.claimed, false);
});

await test("A worker killed between the claim and the click loses the job and sends nothing", async () => {
  const site = employer("https://acme-five.example/careers/apply", "Acme Five");
  const dying = await bootWorker();
  let granted = null;
  const lost = await attempt(site, claimThrough(dying), { freeze: "submit", onClaim: (answer) => { granted = answer; } });
  assert.equal(lost.status, "worker-killed");
  assert.equal(granted.claimed, true);
  assert.equal(site.record.presses, 0);

  const resumed = await bootWorker();
  const again = await attempt(site, claimThrough(resumed));
  assert.equal(again.status, OUTCOMES.REJECTED);
  assert.equal(site.record.presses, 0);
  // Named rather than regretted: one posting is permanently given up in
  // exchange for never sending two. That is the trade, and it is the right
  // way round - a missed application costs nothing anyone can see.
});

await test("A worker killed before the claim costs nothing: the restart applies normally, once", async () => {
  const site = employer("https://acme-six.example/careers/apply", "Acme Six");
  const dying = await bootWorker();
  let granted = null;
  const lost = await attempt(site, claimThrough(dying), { freeze: "fill", onClaim: (answer) => { granted = answer; } });
  assert.equal(lost.status, "worker-killed");
  assert.equal(granted, null, "nothing may be claimed before the form has been filled");
  assert.equal(site.record.presses, 0);

  const resumed = await bootWorker();
  const again = await attempt(site, claimThrough(resumed));
  assert.equal(again.status, OUTCOMES.CONFIRMED);
  assert.equal(site.record.presses, 1);
});

/* ------------------------------------------------- the rules, not the run */

await test("The engine refuses to submit at all when no duplicate protection was supplied", async () => {
  const site = employer("https://acme-seven.example/careers/apply", "Acme Seven");
  const request = requestFor(site);
  const outcome = await applyTo({ request: { ...request, answerContext: answerContext(request, PROFILE) }, registry: createAdapterRegistry([genericAdapter]), browser: browserFor(site), services: { answers: async (questions) => ({ answers: questions.map((q) => ({ key: q.key, value: "Remote" })), unanswered: [], forced: [] }) }, log: () => {} });
  assert.equal(outcome.status, OUTCOMES.CHALLENGE);
  assert.match(outcome.reason, /no duplicate-protection service/);
  assert.equal(site.record.presses, 0);
});

await test("The claim is the last thing before Submit in the engine, and nothing moved it", async () => {
  const engine = await readFile(new URL("src/apply/engine.js", HERE), "utf8");
  const claimAt = engine.indexOf("services.claimCompany(request)");
  const submitAt = engine.indexOf('step("submit"');
  assert.ok(claimAt > 0 && submitAt > claimAt, "the claim has to be taken before the first press, or a kill between them sends twice");
  // Nothing may be awaited between the refusal check and the press that
  // would give a second attempt a window to claim and submit in.
  const waits = [...new Set([...engine.slice(claimAt, submitAt).matchAll(/await\s+([A-Za-z]+)/g)].map((found) => found[1]))];
  assert.deepEqual(waits, ["confirmationBaseline"], "an await between claiming and pressing is a window a second attempt can claim and submit in");
  assert.match(engine.slice(0, claimAt).split("\n").slice(-8).join("\n"), /The last thing before Submit, and deliberately so/, "the reason this ordering is load-bearing has to stay beside it, or it gets refactored away");
});

await test("The run-start history index refuses a posting a dead worker already claimed, before a tab is opened", async () => {
  // The second line of defence, and the cheap one: the markers written by
  // `claimSubmission` are ordinary history rows, so the index every run
  // builds from `allHistory()` already excludes them. Without this a
  // restarted run would re-open the posting and only find out at the
  // claim, having spent a tab, a resume and four minutes on it.
  const url = "https://acme-eight.example/careers/apply";
  const request = await bootWorker();
  await claimThrough(request)({ applyUrl: url, company: "Acme Eight", title: "Senior Engineer", id: url });
  const history = await request({ action: "list", table: "history" });
  assert.equal(history.length > 0, true);
  assert.ok(historyIndex(history).match(url), "a claimed posting has to be visible to the duplicate index of the next run");

  const background = await readFile(new URL("src/background.js", HERE), "utf8");
  assert.match(background, /const externalHistory = await allHistory\(\);/);
  assert.match(background, /const applications = historyIndex\(\[\.\.\.externalHistory,/);
});

await test("A second role at an employer already applied to is refused, however it is spelled or addressed", async () => {
  // One application per employer, ever - the rule this gate exists to
  // make true rather than likely.
  //
  // It has been both ways. Matching on company alone was found by this
  // suite to refuse every later role at an employer, which threw away a
  // large share of a queue built on a three-roles-a-day budget and
  // looked exactly like a duplicate being correctly refused. The budget
  // is one now, so refusing the employer is the rule rather than a bug
  // in it, and the collection filter in background.js drops these long
  // before a resume is written for one.
  const request = await bootWorker();
  const roles = (title, url) => claimThrough(request)({ applyUrl: url, company: "Northstar Dynamics", title, id: url });
  assert.equal((await roles("Backend Engineer", "https://northstar.example/jobs/1")).claimed, true);
  assert.equal((await roles("Platform Engineer", "https://northstar.example/jobs/2")).claimed, false, "a different opening at the same employer is still the same employer");
  // Reached through an aggregator rather than the employer's own page,
  // and named differently. Neither the address nor the folded role can
  // see that these are one company; the company index has to.
  assert.equal((await roles("Data Engineer", "https://aggregator.example/listing/9981")).claimed, false);
  assert.equal((await claimThrough(request)({ applyUrl: "https://northstar.example/jobs/4", company: "Northstar Dynamics, Inc.", title: "SRE", id: "https://northstar.example/jobs/4" })).claimed, false, "a legal ending does not make a second employer");
  // And an employer never applied to is untouched by any of it.
  assert.equal((await claimThrough(request)({ applyUrl: "https://southstar.example/jobs/1", company: "Southstar Labs", title: "Backend Engineer", id: "https://southstar.example/jobs/1" })).claimed, true);
});

await test("An explicit company bar still refuses every posting at that employer", async () => {
  const request = await bootWorker();
  await request({ action: "put", table: "history", value: { id: "bar:ironwood", company: "Ironwood Labs", status: "barred", at: Date.now() } });
  const refused = await claimThrough(request)({ applyUrl: "https://ironwood.example/jobs/4", company: "Ironwood Labs", title: "Anything", id: "iw4" });
  assert.equal(refused.claimed, false);
});

console.log(`${count} double-submission checks passed.`);
