/**
 * The run loop, driving the apply module.
 *
 * Until now the two had never met. `src/apply` was exercised by its own
 * fixtures and by three harnesses that apply to one job with no run in
 * progress; the unattended run used a different filler entirely. So every
 * confirmed application the module has ever produced was produced by a test
 * harness, and the question this file exists to answer - what does the
 * queue record when the module says `confirmed`, and does the day's quota,
 * the employer budget, the slot pool and the folder on disk all still work
 * on the other side of that word - had no answer at all.
 *
 * What is asserted here is therefore the seam rather than the engine. The
 * engine is tested against forms by `tests/generic-forms.mjs` and
 * `tests/prose-answers.mjs`; this one tests that an outcome becomes the
 * right result, that the right result moves the right counters, and that
 * the things built against the old path - a supplied résumé going up
 * unchanged, a slot handed back during a mailbox wait, an employer's
 * allowance, a failure the queue survives - still hold when the module is
 * the thing filling the form.
 *
 * ## How this runs without a browser
 *
 * The harness is `tests/generic-forms.mjs`'s, and deliberately the same
 * one: the real engine, the real adapters and the real `src/fill.js` over
 * linkedom markup in a vm context, with `fetch` poisoned so a fixture that
 * strayed onto the network would say so. What is added is a page that can
 * change under the attempt - a board that refuses a form and then asks for
 * an emailed code - and a record of every file the page was handed, since
 * "is the paired résumé the file that went up" is a question about bytes.
 *
 * What it cannot prove is Chrome. Detection against live markup, the
 * foreground queue, and `chrome.scripting` returning what linkedom returns
 * are all beyond it, and are the things to put a browser on first.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { applyThroughModule, moduleEngine, toRunResult } from "../src/apply/run-bridge.js";
import { createAdapterRegistry, OUTCOMES } from "../src/apply/contract.js";
import { answerContext } from "../src/apply/answer-context.js";
import { ashbyAdapter } from "../src/apply/adapters/ashby.js";
import { genericAdapter } from "../src/apply/adapters/generic.js";
import { greenhouseAdapter } from "../src/apply/adapters/greenhouse.js";
import { leverAdapter } from "../src/apply/adapters/lever.js";
import { workableAdapter } from "../src/apply/adapters/workable.js";
import { withDefaults } from "../src/profile.js";
import { createSlots } from "../src/slots.js";
import { employerDay } from "../src/employers.js";
import { emptyLedger, recordOutcome, withScheduleDefaults } from "../src/schedule.js";
import { protectsCompany } from "../src/application-needs.js";
import { applicationFolder, MANUAL_ROOT } from "../src/vault.js";
import { suppliedApplication } from "../src/pairings.js";
import { candidateFrom } from "../src/writer.js";

const pageScript = await readFile(new URL("../src/fill.js", import.meta.url), "utf8");

globalThis.fetch = async () => {
  throw new Error("a fixture run tried to reach the network");
};

let count = 0;
const test = async (name, work) => {
  await work();
  count++;
  console.log("PASS " + name);
};

/* ------------------------------------------------------------- the person */

const PROFILE = withDefaults({
  firstName: "Daniel", lastName: "Torres", email: "someone@example.test", phone: "+1 (929) 489-1252",
  city: "Temple", state: "TX", country: "United States", linkedin: "https://linkedin.com/danieltorres8483",
  workAuthorization: "us-citizen", requiresSponsorship: "no", nonCompete: "no", over18: "yes",
  startDate: "Two weeks from offer", dryRun: false,
});

const bytes = (text) => new Uint8Array([...text].map((character) => character.charCodeAt(0)));
const RESUME = new Blob([bytes("%PDF-1.4 generated")], { type: "application/pdf" });

/* ------------------------------------------------------------- the markup */

const FORM = ({ extra = "" } = {}) => `
  <h1>Senior Engineer</h1>
  <form method="post" action="/careers/apply">
    <label for="fn">First name *</label><input id="fn" name="first_name" required>
    <label for="ln">Last name *</label><input id="ln" name="last_name" required>
    <label for="em">Email address *</label><input id="em" name="email" type="email" required>
    <label for="ph">Phone *</label><input id="ph" name="phone" required>
    <label for="cv">Resume *</label><input id="cv" name="resume" type="file" required>
    <label for="li">LinkedIn profile</label><input id="li" name="linkedin">
    ${extra}
    <button type="submit">Submit application</button>
  </form>`;

const THANKS = "<h1>Thank you for applying</h1><p>We have received your application.</p>";
const REFUSED = `<div class="error" data-box="300,20">Resume/CV is required</div>`;

/**
 * Greenhouse's eight one-character boxes, found by their ids rather than by
 * the sentence above them, which is the part that gets reworded.
 *
 * Put above the form rather than in place of it, because the board leaves
 * its Submit where it was - and because the code is typed and then sent
 * with that same button, a fixture that replaced the page would be testing
 * a board nobody has met.
 */
const showCode = (document) => {
  for (const complaint of document.querySelectorAll(".error")) complaint.remove();
  document.querySelector("form").insertAdjacentHTML("beforebegin", `<div class="email-verification">
    <p>A verification code was sent to someone@example.test</p>
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((at) => `<input id="security-input-${at}" maxlength="1">`).join("")}
  </div>`);
};

/* ------------------------------------------------------------ the browser */

/**
 * A page, as `executeScript` would find it.
 *
 * Two things are invented here and both are invented deliberately, because
 * linkedom has neither. Boxes come from the fixture's own `data-box`, since
 * whether a captcha frame is a puzzle is a question about measured size.
 * And the resource timeline is a fixture of its own: `uploadsSettled` reads
 * a finished upload off it, so a page that takes a file has to say it took
 * one or every attempt here would sit out the twelve-second fallback.
 */
function page(html, { url, uploads = [], onSubmit } = {}) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  for (const name of ["MouseEvent", "PointerEvent", "InputEvent", "FocusEvent", "DragEvent"]) {
    if (!window[name]) window[name] = class extends window.Event {};
  }
  const element = window.Element?.prototype ?? window.HTMLElement.prototype;
  element.focus ??= function () {};
  element.scrollIntoView ??= function () {};
  element.getBoundingClientRect = function () {
    const [width, height] = (this.getAttribute?.("data-box") ?? "200,30").split(",").map(Number);
    return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height };
  };
  Object.defineProperty(element, "offsetParent", { configurable: true, get() { return this.ownerDocument.body; } });

  const hidden = (node) => Boolean(node?.hasAttribute?.("hidden")) || /display:\s*none/i.test(node?.getAttribute?.("style") ?? "");
  const resources = [];

  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      uploads.push({ name: file.name, type: file.type, text: String.fromCharCode(...(file.parts ?? [])) });
      resources.push({ name: `https://fixtureco.example/upload/${file.name}`, startTime: performance.now() });
    });
  }
  for (const button of document.querySelectorAll("button, input[type='submit']")) {
    if (onSubmit) button.addEventListener("click", () => onSubmit(button, document));
  }

  const context = vm.createContext({
    window, document,
    location: { href: url, hostname: new URL(url).hostname, origin: new URL(url).origin },
    setTimeout, clearTimeout, console, URL, Blob, Uint8Array, atob, btoa,
    performance: { now: () => performance.now(), getEntriesByType: (kind) => (kind === "resource" ? resources : []) },
    CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
    getComputedStyle: (node) => ({ display: hidden(node) ? "none" : "block", visibility: "visible", opacity: "1" }),
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    InputEvent: window.InputEvent,
    FocusEvent: window.FocusEvent,
    DragEvent: window.DragEvent,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
    File: class { constructor(parts, name, options) { this.name = name; this.type = options?.type ?? ""; this.parts = parts?.[0] ?? []; this.size = this.parts.length ?? 0; } },
  });
  context.globalThis = context;
  context.window = context;
  for (const key of ["__ghApply", "__ghApplyInflight", "__ghApplyRequests", "__ghApplyTracking"]) delete window[key];
  vm.runInContext(pageScript, context);
  return { document, window, context, url };
}

/**
 * A tab whose page can change under the attempt.
 *
 * `onSubmit` is given the press number, because the case this file exists
 * for is a board that answers differently the second time: refused, then a
 * demand for an emailed code, then a receipt.
 */
function tabOver(html, url, { onSubmit } = {}) {
  const state = { url, submits: 0, uploads: [] };
  let built = null;
  const press = (button, document) => {
    state.submits += 1;
    onSubmit?.(state.submits, document, state);
  };
  return {
    state,
    current() {
      if (!built) built = page(html, { url, uploads: state.uploads, onSubmit: press });
      return built;
    },
    goTo(next) {
      state.url = next;
      built = null;
    },
  };
}

function browserFor(tab) {
  return {
    openTab: async () => 1,
    adoptTab: async (tabId) => ({ id: tabId, url: tab.state.url, title: "" }),
    closeTab: async () => { tab.state.closed = true; },
    navigate: async (tabId, url) => tab.goTo(url),
    inject: async () => [],
    findTab: async () => null,
    info: async () => ({ url: tab.state.url, status: "complete", title: "" }),
    capture: async () => ({ url: tab.state.url, title: "Fixture", capturedAt: Date.now() }),
    frames: async () => [{ frameId: 0, url: tab.state.url }],
    inFrame: async (tabId, frameId, fn, args = []) => {
      const call = vm.runInContext(`(${fn.toString()})`, tab.current().context);
      const value = await call(...args);
      const answer = value === undefined ? null : JSON.parse(JSON.stringify(value));
      return frameId === undefined ? [{ frameId: 0, result: answer }] : answer;
    },
  };
}

const REGISTRY = createAdapterRegistry([greenhouseAdapter, workableAdapter, ashbyAdapter, leverAdapter, genericAdapter]);

/* ---------------------------------------------------------- the run loop */

const URL_OF = (slug) => `https://${slug}.example/careers/senior-engineer`;

const applicationFor = (company, slug, extra = {}) => ({
  id: URL_OF(slug), sourceUrl: URL_OF(slug), applyUrl: URL_OF(slug),
  company, title: "Senior Engineer", jd: "A fixture posting. Never sent anywhere.",
  resume: RESUME, resumeName: "generated-resume.pdf", resumeText: "Daniel Torres\nStaff AI Engineer, Scale AI",
  ...extra,
});

/**
 * The queue's own machinery, with the module in the middle of it.
 *
 * This is `workOne` and `applyCandidate` reduced to what they do with a
 * result: reserve the employer's slot, run the attempt inside the slot
 * pool, record the outcome against the day, and carry on. The modules are
 * the real ones - schedule.js, employers.js, slots.js - because the claim
 * being tested is that they still work when the word `submitted` is
 * produced somewhere new.
 */
function createRun({ perCompanyPerDay = 1, attemptConcurrency = 1, profile = PROFILE } = {}) {
  const schedule = withScheduleDefaults({ dailyTarget: 10, perCompanyPerDay, attemptConcurrency, employerGapMs: 0 });
  const employers = employerDay({ limit: schedule.perCompanyPerDay, gapMs: schedule.employerGapMs });
  const slots = createSlots({ limit: schedule.attemptConcurrency });
  const results = [];
  const folders = [];
  const asked = [];
  let ledger = emptyLedger();

  const record = (result) => {
    results.push(result);
    ledger = recordOutcome(ledger, result);
    return result;
  };

  const attemptOne = async (job, attempt) => {
    const application = job.application;
    const said = await applyThroughModule({
      application, profile,
      context: answerContext(application, profile),
      registry: REGISTRY,
      browser: browserFor(job.tab),
      log: () => {},
      services: {
        answers: async (questions) => ({ answers: questions.map((question) => ({ key: question.key, value: job.answer ?? "Remote" })), unanswered: [], forced: [] }),
        claimCompany: async () => ({ claimed: job.claimed !== false }),
        verification: (need) => attempt.waiting("an emailed security code", async () => {
          asked.push({ ...need, parked: slots.status().parked });
          await job.mailbox?.();
          return { code: job.code ?? "A1B2C3D4" };
        }),
        evidence: async ({ outcome, picture }) => {
          const root = profile.dryRun ? "review" : [OUTCOMES.CONFIRMED, OUTCOMES.UNCERTAIN].includes(outcome.status) ? "applied" : MANUAL_ROOT;
          const folder = applicationFolder(application, root);
          folders.push({ folder, url: picture.url });
          return { path: `${folder}/Last page.png`, folder };
        },
        ...(job.documents ? { documents: job.documents } : {}),
      },
    });
    return record({
      id: application.id, company: application.company, title: application.title, applyUrl: application.applyUrl,
      status: said.status, reason: said.reason,
      detail: { ...said.detail, submissionAttempted: said.submitted },
      at: Date.now(), archive: said.archive, keepOpen: said.keepOpen, confirmationUrl: said.confirmationUrl,
    });
  };

  return {
    employers, slots, results, folders, asked,
    get ledger() { return ledger; },
    /** One job, from the queue's decision to apply to its recorded outcome. */
    async apply(job) {
      const urls = [job.application.sourceUrl, job.application.applyUrl];
      if (!employers.claim(job.application.company, urls)) {
        return record({ id: job.application.id, company: job.application.company, title: job.application.title, applyUrl: job.application.applyUrl, status: "skipped", reason: `${job.application.company} has had its allowance of roles for today`, detail: {}, at: Date.now() });
      }
      // The queue absorbs an attempt that threw rather than ending the day
      // with three hundred jobs left in it; this is applyCandidate's catch.
      return slots.hold({ company: job.application.company }, (attempt) => attemptOne(job, attempt)).catch((error) =>
        record({ id: job.application.id, company: job.application.company, title: job.application.title, applyUrl: job.application.applyUrl, status: "failed", reason: error?.message ?? String(error), detail: {}, at: Date.now() }),
      );
    },
  };
}

/* ------------------------------------------------- queue to a confirmation */

await test("A job goes from the queue to a confirmed submission, and the day's ledger counts it", async () => {
  const tab = tabOver(FORM(), URL_OF("acme"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const run = createRun();
  const result = await run.apply({ application: applicationFor("Acme", "acme"), tab });

  assert.equal(result.status, "submitted");
  assert.equal(result.reason, "");
  assert.match(result.detail.boardSaid, /Thank you for applying/);
  assert.equal(result.detail.engine.adapter, "generic");
  assert.equal(result.detail.submissionAttempted, true);
  assert.equal(tab.state.submits, 1, "Submit was pressed more than once");
  assert.equal(run.ledger.submitted, 1);
  assert.equal(run.ledger.attempted, 1);
  assert.equal(run.ledger.failed, 0);
  assert.equal(protectsCompany(result), true, "a confirmed application must protect its employer");
});

await test("A confirmed application is archived into the folder its last page was already saved in", async () => {
  const tab = tabOver(FORM(), URL_OF("sendwave"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const run = createRun();
  const application = applicationFor("Sendwave", "sendwave");
  const result = await run.apply({ application, tab });

  assert.equal(result.archive, "applied");
  assert.equal(run.folders.length, 1, "the final page was photographed once");
  assert.equal(result.detail.folder, applicationFolder(application, "applied"));
  assert.equal(result.detail.folder, run.folders[0].folder, "the screenshot and the documents went to different folders");
  assert.equal(result.detail.lastScreenshot.path, `${run.folders[0].folder}/Last page.png`);
  assert.equal(result.confirmationUrl, tab.state.url, "the archive has no tab left to ask where the receipt was read");
});

await test("Every answer the form was given is written back for the folder a person reads", async () => {
  const tab = tabOver(FORM(), URL_OF("tubi"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const application = applicationFor("Tubi", "tubi");
  await createRun().apply({ application, tab });

  const said = new Map(application.answers.map((entry) => [entry.question, String(entry.answer)]));
  assert.equal(said.get("First name"), "Daniel");
  assert.equal(said.get("Email address"), "someone@example.test");
  assert.equal(said.get("Phone"), "+1 (929) 489-1252");
});

/* ------------------------------------------------------- a supplied résumé */

await test("A paired résumé is the file that goes up, under its own name and byte for byte", async () => {
  const saved = {
    id: "r-datacamp", name: "DataCamp", kind: "supplied", fileName: "Resume.pdf",
    pdf: new Blob([bytes("%PDF-1.4 supplied-by-hand")], { type: "application/pdf" }),
    sourceText: "Daniel Torres\nStaff AI Engineer, Scale AI",
    document: null,
  };
  const job = { id: URL_OF("datacamp"), sourceUrl: URL_OF("datacamp"), applyUrl: URL_OF("datacamp"), company: "DataCamp", title: "Senior Engineer", jd: "A fixture posting.", resumeId: "r-datacamp", resumeLocked: true };
  const application = suppliedApplication(job, saved, candidateFrom(PROFILE));

  const tab = tabOver(FORM(), URL_OF("datacamp"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const result = await createRun().apply({ application, tab });

  assert.equal(result.status, "submitted");
  assert.equal(tab.state.uploads.length, 1);
  assert.equal(tab.state.uploads[0].name, "Resume.pdf", "the supplied résumé went up under a generated name");
  assert.equal(tab.state.uploads[0].text, "%PDF-1.4 supplied-by-hand", "the bytes that went up are not the ones the applicant chose");
  assert.equal(tab.state.uploads[0].type, "application/pdf");
});

/* ------------------------------------------------------- the emailed code */

await test("The emailed code is asked for on the second outcome read, not only the first", async () => {
  // The board refuses the form once, takes it the second time, and only
  // then asks for the code. This is the shape the old path got wrong: the
  // code boxes that came back from the *resubmit* were nobody's job, and
  // applications were parked with the code sitting unread in a mailbox.
  const tab = tabOver(FORM(), URL_OF("mcg"), {
    onSubmit: (press, document) => {
      if (press === 1) document.querySelector("form").insertAdjacentHTML("beforebegin", REFUSED);
      if (press === 2) showCode(document);
      if (press === 3) document.body.innerHTML = THANKS;
    },
  });
  const run = createRun();
  const result = await run.apply({ application: applicationFor("MCG", "mcg"), tab, code: "A1B2C3D4" });

  assert.equal(result.status, "submitted");
  assert.equal(result.detail.securityCode, true, "application.json must say the mailbox was needed");
  assert.equal(run.asked.length, 1, "the code was asked for once");
  assert.equal(run.asked[0].kind, "email-code");
  assert.equal(run.asked[0].email, "someone@example.test");
  assert.equal(tab.state.submits, 3);
  assert.equal(run.ledger.submitted, 1);
});

await test("An attempt waiting on the mailbox hands its slot back, so the next application starts", async () => {
  const run = createRun({ attemptConcurrency: 1, perCompanyPerDay: 1 });
  let release;
  const held = new Promise((resolve) => (release = resolve));

  const waiting = tabOver(FORM(), URL_OF("ondo"), {
    onSubmit: (press, document) => {
      if (press === 1) showCode(document);
      if (press === 2) document.body.innerHTML = THANKS;
    },
  });
  const next = tabOver(FORM(), URL_OF("float"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });

  const first = run.apply({ application: applicationFor("Ondo", "ondo"), tab: waiting, mailbox: () => held });
  // The second job is only started once the first is actually parked on the
  // mailbox, which is the moment the pool is supposed to let it through.
  while (run.asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await run.apply({ application: applicationFor("Float", "float"), tab: next });
  release();

  assert.equal(second.status, "submitted", "the second application could not start while the first waited");
  assert.equal(run.asked[0].parked, 1, "the waiting attempt was still holding its slot");
  assert.equal((await first).status, "submitted");
  assert.equal(run.ledger.submitted, 2);
});

/* --------------------------------------------- budgets, failures, refusals */

await test("An employer's allowance for the day is honoured, and the second role is skipped not sent", async () => {
  const run = createRun({ perCompanyPerDay: 1 });
  const one = tabOver(FORM(), URL_OF("helix"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const two = tabOver(FORM(), URL_OF("helix-two"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });

  const first = await run.apply({ application: applicationFor("Helix", "helix"), tab: one });
  const second = await run.apply({ application: applicationFor("Helix", "helix-two"), tab: two });

  assert.equal(first.status, "submitted");
  assert.equal(second.status, "skipped");
  assert.match(second.reason, /allowance of roles for today/);
  assert.equal(two.state.submits, 0, "the second role reached a form despite the budget");
  assert.equal(run.employers.room("Helix", [URL_OF("helix")]), 0);
  assert.equal(run.ledger.submitted, 1);
  // A skip is not an attempt, or the day's arithmetic counts jobs nobody opened.
  assert.equal(run.ledger.attempted, 1);
  assert.equal(run.ledger.skipped, 1);
});

await test("A posting the board refuses is recorded as failed and the queue carries on to the next", async () => {
  const run = createRun({ perCompanyPerDay: 3 });
  const refusing = tabOver(FORM(), URL_OF("ascend"), { onSubmit: (press, document) => { if (press <= 2) document.querySelector("form").insertAdjacentHTML("beforebegin", REFUSED); } });
  const working = tabOver(FORM(), URL_OF("tally"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });

  const failed = await run.apply({ application: applicationFor("Ascend Learning", "ascend"), tab: refusing });
  const sent = await run.apply({ application: applicationFor("Tally", "tally"), tab: working });

  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /Resume\/CV is required/);
  assert.equal(failed.detail.submissionAttempted, true, "Submit was pressed, so the folder has to say so");
  assert.equal(sent.status, "submitted");
  assert.equal(run.ledger.failed, 1);
  assert.equal(run.ledger.submitted, 1);
  assert.equal(run.ledger.attempted, 2);
});

await test("A refused duplicate claim is a skip, never a failure, and nothing is pressed", async () => {
  const tab = tabOver(FORM(), URL_OF("mercury"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const run = createRun();
  const result = await run.apply({ application: applicationFor("Mercury", "mercury"), tab, claimed: false });

  assert.equal(result.status, "skipped", "a company already applied to must not be filed as a failure");
  assert.equal(result.detail.submissionAttempted, false);
  assert.equal(tab.state.submits, 0);
  assert.equal(run.ledger.submitted, 0);
  assert.equal(run.ledger.failed, 0);
});

await test("A captcha hands the form over with its answers, and does not protect the employer", async () => {
  const puzzle = `<iframe data-box="400,580" src="https://newassets.hcaptcha.com/captcha/v1/58a26338/static/hcaptcha.html#frame=challenge&host=fixtureco.example&size=normal"></iframe>`;
  const tab = tabOver(FORM() + puzzle, URL_OF("odoo"));
  const run = createRun();
  const application = applicationFor("Odoo", "odoo");
  const result = await run.apply({ application, tab });

  assert.equal(result.status, "manual");
  assert.equal(result.detail.handoff, true);
  assert.equal(result.archive, "manual");
  assert.equal(result.detail.submissionAttempted, false);
  assert.equal(tab.state.submits, 0);
  assert.equal(protectsCompany(result), false, "a form nobody sent must leave the employer open");
  assert.equal(run.folders[0].folder, applicationFolder(application, MANUAL_ROOT));
  assert.ok(application.answers.length > 0, "the answers are kept so the form can be redone by hand");
  assert.equal(run.ledger.failed, 1);
});

/* -------------------------------------------------------------- dry runs */

await test("A review run fills the form, leaves the page, and records nothing as sent", async () => {
  const tab = tabOver(FORM(), URL_OF("ramp"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const run = createRun({ profile: withDefaults({ ...PROFILE, dryRun: true }) });
  const application = applicationFor("Ramp", "ramp");
  const result = await run.apply({ application, tab });

  assert.equal(result.status, "dry-run");
  assert.match(result.reason, /filled and verified/);
  assert.equal(result.keepOpen, true, "a filled form that vanishes cannot be looked at");
  assert.equal(result.archive, null);
  assert.equal(tab.state.submits, 0);
  assert.equal(tab.state.closed, undefined, "the tab was closed on a review run");
  assert.equal(run.folders[0].folder, applicationFolder(application, "review"));
  assert.equal(run.ledger.submitted, 0);
});

/* ---------------------------------------- what the form turned out to want */

await test("A cover letter the form asks for is written before the form is planned, and attached", async () => {
  // `Services.documents` has been in the contract since it was written and
  // nothing called it, which is how the run loop's own letter-on-demand
  // would have been dropped by the cutover without anyone noticing.
  const letterBox = `<label for="cl">Cover letter *</label><input id="cl" name="cover_letter" type="file" required>`;
  const tab = tabOver(FORM({ extra: letterBox }), URL_OF("epam"), { onSubmit: (press, document) => { if (press === 1) document.body.innerHTML = THANKS; } });
  const application = applicationFor("EPAM", "epam");
  const seen = [];

  const result = await createRun().apply({
    application, tab,
    documents: async ({ fields }) => {
      seen.push(fields.map((field) => field.label));
      application.letter = new Blob([bytes("%PDF-1.4 letter")], { type: "application/pdf" });
      application.letterName = "Daniel_Torres_Cover_Letter.pdf";
    },
  });

  assert.equal(seen.length, 1, "the form was never offered to the document writer");
  assert.ok(seen[0].includes("Cover letter"), "the writer was not told what the form asked for");
  assert.equal(result.status, "submitted");
  assert.deepEqual(tab.state.uploads.map((upload) => upload.name).sort(), ["Daniel_Torres_Cover_Letter.pdf", "generated-resume.pdf"]);
});

await test("A form wanting a letter nobody could write parks rather than being sent incomplete", async () => {
  const letterBox = `<label for="cl">Cover letter *</label><input id="cl" name="cover_letter" type="file" required>`;
  const tab = tabOver(FORM({ extra: letterBox }), URL_OF("odoo2"));
  const result = await createRun().apply({ application: applicationFor("Odoo", "odoo2"), tab });

  assert.equal(result.status, "manual");
  assert.match(result.reason, /requires a cover and none was supplied/);
  assert.equal(tab.state.submits, 0);
});

/* ------------------------------------------------------------ the switch */

await test("The setting puts every posting back on the original filler, in one word", () => {
  assert.equal(moduleEngine({ applyEngine: "module" }, "https://boards.greenhouse.io/acme/jobs/1"), true);
  assert.equal(moduleEngine({}, "https://fixtureco.example/careers/1"), true, "the module is the default");
  assert.equal(moduleEngine({ applyEngine: "legacy" }, "https://boards.greenhouse.io/acme/jobs/1"), false);
  assert.equal(moduleEngine({ applyEngine: "legacy" }, "https://acme.myworkdayjobs.com/x/job/1"), false);
});

await test("ApplyToJob stays on the original filler, because only that one can tick a Human Check", () => {
  assert.equal(moduleEngine({ applyEngine: "module" }, "https://acme.applytojob.com/apply/abc123"), false);
  assert.equal(moduleEngine({ applyEngine: "module" }, "https://boards.greenhouse.io/acme/jobs/1"), true);
});

// Lever shows its hCaptcha puzzle only after Submit, so the module reaches
// the wall having already claimed the employer. Measured on a real VGS
// submission: filled, claimed, pressed, challenged, nothing sent.
await test("Lever stays on the original filler, because the module claims the employer and then loses it to a puzzle", () => {
  assert.equal(moduleEngine({ applyEngine: "module" }, "https://jobs.lever.co/acme/1-2-3"), false);
  assert.equal(moduleEngine({ applyEngine: "module" }, "https://jobs.lever.co/verygoodsecurity/abc/apply"), false);
});

/* ------------------------------------- the mapping, over every outcome */

/**
 * The run loop's own dispatch, read as text.
 *
 * `background.js` reaches `chrome.*` at the top level and cannot be
 * imported outside the browser, so this is the only way to assert that the
 * seam above is the one the extension actually uses. Thin on purpose: what
 * the module path does is tested properly above, and all that is left to
 * say here is that the run reaches it, that the old path is still standing
 * behind it, and that the three things the module does not do for itself
 * are still wired in.
 */
await test("The run loop dispatches to the apply module, with the original filler still behind it", async () => {
  const source = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
  const runOne = source.slice(source.indexOf("async function runOne("), source.indexOf("async function finishTab("));

  assert.ok(runOne.includes("if (moduleEngine(profile, application.applyUrl)) {"), "the run loop never asks which filler to use");
  assert.ok(runOne.indexOf("moduleEngine(") < runOne.indexOf('atsOf(application.applyUrl) === "workday"'), "Workday is taken by the legacy wizard before the setting is consulted");
  assert.ok(runOne.includes("runWorkday(application, profile, context"), "the legacy Workday driver is no longer reachable");
  assert.ok(runOne.includes("tabId = await openTab(application.applyUrl, profile.foregroundTabs);"), "the legacy filler is no longer reachable");

  const services = source.slice(source.indexOf("function moduleServices("), source.indexOf("async function keepLastPage("));
  assert.ok(services.includes("ensureApplicationSupport(application, profile, fields, context)"), "a letter the form demands would not be written");
  assert.ok(services.includes("claimSubmission(request)"), "the module would submit without the run's duplicate claim");
  assert.ok(services.includes("releaseSubmission(request)"), "an employer claimed for an application that was never sent could never be applied to again");
  assert.ok(services.includes("attempt.waiting("), "a mailbox wait would hold its slot for the whole of the code's arrival");
  assert.ok(services.includes("board: boardOf(application.applyUrl)"), "a code mail addressed by the board's name for the employer would match nothing");
});

await test("Each outcome the engine can produce becomes exactly one result the queue understands", () => {
  const evidence = (extra = {}) => ({ evidence: { answers: [{ question: "First name", answer: "Daniel" }], ...extra } });

  assert.equal(toRunResult({ status: OUTCOMES.CONFIRMED, receipt: "Thank you for applying", submitted: true, ...evidence() }).status, "submitted");
  assert.equal(toRunResult({ status: OUTCOMES.UNCERTAIN, reason: "no confirmation appeared", submitted: true, ...evidence() }).status, "unconfirmed");
  assert.equal(toRunResult({ status: OUTCOMES.CHALLENGE, reason: "a captcha", ...evidence() }).status, "manual");
  assert.equal(toRunResult({ status: OUTCOMES.REJECTED, reason: "the board refused", ...evidence() }).status, "failed");
  assert.equal(toRunResult({ status: OUTCOMES.REJECTED, reason: "already applied" }, { claimRefused: true }).status, "skipped");
  // A review park is the only `challenge` that is not a problem, and it is
  // told apart by the evidence that park alone carries.
  assert.equal(toRunResult({ status: OUTCOMES.CHALLENGE, reason: "filled and verified", ...evidence({ pages: 1, filled: 5 }) }, { review: true }).status, "dry-run");
  assert.equal(toRunResult({ status: OUTCOMES.CHALLENGE, reason: "a captcha", ...evidence() }, { review: true }).status, "manual");

  // The retry flag survives, or a page that re-rendered mid-fill is never
  // tried again; `workOne` reads it and nothing else sets it.
  assert.equal(toRunResult({ status: OUTCOMES.REJECTED, reason: "the page changed", ...evidence({ retry: true }) }).detail.retry, true);
  // And `unconfirmed` is archived as sent, because pressing Submit twice is
  // the one mistake this must never make.
  assert.equal(toRunResult({ status: OUTCOMES.UNCERTAIN, submitted: true, ...evidence() }).archive, "applied");
});

/**
 * The claim given back, over every outcome that can follow one.
 *
 * Asserted outcome by outcome rather than through a staged attempt because
 * this is the decision with the worst failure on both sides: releasing one
 * that was sent applies to an employer twice, and keeping one that was not
 * removes that employer from the bot's reach for good. There is no reading
 * of a log that catches either until it is too late.
 */
await test("An employer claimed for an application that never happened is given back, and one that may have been sent is not", () => {
  const taken = { claimTaken: true };
  const evidence = (extra = {}) => ({ evidence: { answers: [], ...extra } });
  const release = (outcome, options = taken) => toRunResult(outcome, options).release;

  // Lever's shape, measured on a real VGS submission: filled, claimed,
  // Submit pressed, puzzle raised, nothing sent.
  assert.equal(release({ status: OUTCOMES.CHALLENGE, reason: "the board put up a captcha puzzle after Submit", submitted: true, ...evidence({ challenge: { kind: "captcha" } }) }), true);
  assert.equal(release({ status: OUTCOMES.REJECTED, reason: "the form rejected the submission", submitted: true, ...evidence() }), true);

  assert.equal(release({ status: OUTCOMES.CONFIRMED, receipt: "Thank you for applying", submitted: true, ...evidence() }), false);
  // The whole point of `uncertain`: the page said nothing, so the employer
  // keeps its claim and nobody sends a second one.
  assert.equal(release({ status: OUTCOMES.UNCERTAIN, reason: "no confirmation appeared", submitted: true, ...evidence() }), false);
  // The board is holding this one pending proof of the address. A person
  // finishes it from the manual folder; releasing it makes that a second
  // application.
  assert.equal(release({ status: OUTCOMES.CHALLENGE, reason: "no security code arrived", submitted: true, ...evidence({ challenge: { kind: "email-code" } }) }), false);

  // Nothing claimed, nothing to give back - including the refusal, where
  // the standing claim belongs to an application that really was sent.
  assert.equal(release({ status: OUTCOMES.CHALLENGE, reason: "a captcha", ...evidence({ challenge: { kind: "captcha" } }) }, {}), false);
  assert.equal(release({ status: OUTCOMES.REJECTED, reason: "already applied" }, { claimRefused: true }), false);
  assert.equal(release({ status: OUTCOMES.CHALLENGE, reason: "filled and verified", ...evidence({ pages: 1 }) }, { review: true }), false);
});

await test("The bridge gives the claim back through the run's own service, and keeps it when the release fails", async () => {
  // The claim is taken through the service the bridge watches, exactly as
  // the engine takes it in the last moment before Submit; the bridge
  // learns there is something to give back only by seeing that happen.
  const outcomeOf = (status, extra) => async ({ services }) => {
    await services.claimCompany({ company: "VGS" });
    return { status, reason: "the board put up a captcha puzzle after Submit", submitted: true, evidence: { answers: [], ...extra } };
  };
  const run = async ({ apply, releaseCompany }) =>
    applyThroughModule({
      application: { id: "j1", company: "VGS", applyUrl: "https://jobs.lever.co/verygoodsecurity/1/apply" },
      profile: {}, context: {}, browser: {}, registry: createAdapterRegistry([]),
      services: { claimCompany: async () => ({ claimed: true }), releaseCompany },
      apply,
    });

  const given = [];
  const released = await run({ apply: outcomeOf(OUTCOMES.CHALLENGE, { challenge: { kind: "captcha" } }), releaseCompany: async (request) => given.push(request.company) });
  assert.deepEqual(given, ["VGS"]);
  assert.equal(released.status, "manual");

  // A release that throws must not take the attempt down with it. The
  // employer stays claimed, which is the safe way to be wrong.
  const kept = await run({
    apply: outcomeOf(OUTCOMES.CHALLENGE, { challenge: { kind: "captcha" } }),
    releaseCompany: async () => { throw new Error("the database was busy"); },
  });
  assert.equal(kept.status, "manual");

  const sent = [];
  await run({ apply: outcomeOf(OUTCOMES.CONFIRMED, {}), releaseCompany: async (request) => sent.push(request.company) });
  assert.deepEqual(sent, [], "a confirmed application gave its employer back");
});

console.log(`${count} run-loop-through-the-apply-module checks passed.`);
