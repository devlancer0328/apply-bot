/**
 * The two adapters that claim the boards nobody wrote one for.
 *
 * Nine of the thirty-one corpus postings parked with "no adapter recognises
 * <host>" and were never touched - the largest single loss against the
 * three-hundred-a-day target. Two of those nine are Lever; the rest are
 * one board each, which is why the answer to them is an adapter that reads
 * a form's own structure rather than seven more adapters.
 *
 * A generic filler is the one component here that can do real harm. It
 * fills forms on sites nobody has looked at, and an application sent to a
 * real employer cannot be taken back - so what is asserted below is mostly
 * the refusals, and each of them is a separate test rather than a clause
 * in a bigger one. The property the whole file exists to hold is this: the
 * generic adapter either understands a form completely or it declines.
 *
 * ## How this runs without a browser
 *
 * The real engine, the real adapters and the real `src/fill.js`, over
 * linkedom markup in a vm context - the harness `tests/workday-wizard.mjs`
 * established, and `tests/prose-answers.mjs`'s habit of recording every
 * value the engine typed. Nothing here can reach a real employer: the
 * pages are in-process, `fetch` is poisoned for the length of the run, and
 * the duplicate claim is refused except in the two tests that are about
 * pressing Submit.
 *
 * What it cannot prove is the markup. Every fixture below is the real
 * shape as the corpus recon recorded it, but a fixture is still a
 * reconstruction, and detection against a live page is the thing to test
 * first with a browser in hand.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { applyTo } from "../src/apply/engine.js";
import { createAdapterRegistry, CONFIDENCE } from "../src/apply/contract.js";
import { genericAdapter, probeForm } from "../src/apply/adapters/generic.js";
import { submitChoices } from "../src/apply/form-ops.js";
import { greenhouseAdapter } from "../src/apply/adapters/greenhouse.js";
import { leverAdapter } from "../src/apply/adapters/lever.js";
import { ashbyAdapter } from "../src/apply/adapters/ashby.js";
import { workableAdapter } from "../src/apply/adapters/workable.js";
import { answerContext } from "../src/apply/answer-context.js";
import { withDefaults } from "../src/profile.js";

const pageScript = await readFile(new URL("../src/fill.js", import.meta.url), "utf8");

// Nothing in an apply attempt should reach the network, and a fixture that
// quietly did would be reaching a real board.
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
  startDate: "Two weeks from offer",
});

const RESUME = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" });

/* ------------------------------------------------------------- the markup */

/**
 * One Lever question, in the markup Lever serves.
 *
 * `li.application-question`, the heading in its own `.application-label`
 * beside the control rather than around it, the required marker as the
 * asterisk a person reads and the word in the class name. `src/fill.js`
 * has a branch for exactly this, which is why the adapter needs none.
 */
const leverQuestion = (label, control, { required = true } = {}) =>
  `<li class="application-question${required ? " required" : ""}">
     <label><div class="application-label"><span class="text">${label}</span>${required ? '<span class="required">✱</span>' : ""}</div>
     <div class="application-field">${control}</div></label>
   </li>`;

const LEVER_FORM = `
  <div class="section-wrapper page-full-width"><h2>Submit your application</h2>
  <form method="POST" action="https://jobs.lever.co/fixtureco/11111111-2222-3333-4444-555555555555/apply" id="application-form">
    <ul class="application-additional">
      ${leverQuestion("Resume/CV", '<input type="file" name="resume" id="resume-upload-input">')}
      ${leverQuestion("Full name", '<input type="text" name="name" required>')}
      ${leverQuestion("Email", '<input type="email" name="email" required>')}
      ${leverQuestion("Phone", '<input type="tel" name="phone" required>')}
      ${leverQuestion("LinkedIn URL", '<input type="text" name="urls[LinkedIn]">', { required: false })}
      ${leverQuestion("Are you legally authorized to work in the United States?", '<select name="cards[auth][field0]" required><option value=""></option><option value="Yes">Yes</option><option value="No">No</option></select>')}
    </ul>
    <input type="hidden" name="resumeStorageId" value="">
    <button type="submit" id="btn-submit" class="template-btn-submit">Submit application</button>
  </form></div>`;

/** hCaptcha as Lever actually mounts it: scoring the session, asking nothing. */
const LEVER_INVISIBLE_CAPTCHA = `
  <iframe data-box="0,0" src="https://newassets.hcaptcha.com/captcha/v1/58a26338/static/hcaptcha-enclave.html#frame=enclave&_origin=https%3A%2F%2Fjobs.lever.co&host=jobs.lever.co"></iframe>
  <iframe data-box="300,78" src="https://newassets.hcaptcha.com/captcha/v1/58a26338/static/hcaptcha.html#frame=challenge&host=jobs.lever.co&size=invisible&theme=light"></iframe>`;

/** And the same board when it has decided to ask: the picture puzzle. */
const SHOWN_CAPTCHA = `<iframe data-box="400,580" src="https://newassets.hcaptcha.com/captcha/v1/58a26338/static/hcaptcha.html#frame=challenge&host=jobs.lever.co&size=normal"></iframe>`;

/** A company's own form: no board markup anywhere, labelled with `for`. */
const PLAIN_FORM = ({ extra = "", action = "/careers/apply" } = {}) => `
  <h1>Senior Engineer</h1>
  <form method="post" action="${action}">
    <label for="fn">First name *</label><input id="fn" name="first_name" required>
    <label for="ln">Last name *</label><input id="ln" name="last_name" required>
    <label for="em">Email address *</label><input id="em" name="email" type="email" required>
    <label for="ph">Phone *</label><input id="ph" name="phone" required>
    <label for="li">LinkedIn profile</label><input id="li" name="linkedin">
    ${extra}
    <button type="submit">Submit application</button>
  </form>`;

/* ------------------------------------------------------------ the browser */

/**
 * A page, as `executeScript` would find it.
 *
 * linkedom has no layout engine, so every element is given the box the
 * fixture declares in `data-box` and 200x30 otherwise. That is the one
 * thing the harness invents, and it is invented deliberately: whether a
 * captcha frame is a puzzle or a tracker is a question about its measured
 * size, and it cannot be asserted honestly without saying what Chrome
 * measured.
 */
function page(html, { url, onSubmit } = {}) {
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

  // Lever takes the résumé the moment it is chosen and writes the storage
  // id it got back into a hidden box; `uploadsSettled` watches for that.
  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.addEventListener("change", () => {
      const storage = document.querySelector('input[name="resumeStorageId"]');
      if (storage) storage.value = "fixture-storage-id";
    });
  }
  for (const button of document.querySelectorAll("button, input[type='submit']")) {
    if (onSubmit) button.addEventListener("click", () => onSubmit(button, document));
  }

  const context = vm.createContext({
    window, document,
    location: { href: url, hostname: new URL(url).hostname, origin: new URL(url).origin },
    setTimeout, clearTimeout, performance, console, URL, Blob, Uint8Array, atob, btoa,
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
    File: class { constructor(parts, name, options) { this.name = name; this.type = options?.type ?? ""; } },
  });
  context.globalThis = context;
  context.window = context;
  // linkedom hands out one window across parses, and the page script
  // installs itself only once; without this, page two is read by page
  // one's closure and nothing on it is ever found.
  for (const key of ["__ghApply", "__ghApplyInflight", "__ghApplyRequests", "__ghApplyTracking"]) delete window[key];
  vm.runInContext(pageScript, context);
  return { document, window, context, url };
}

/**
 * A tab over a map of address to markup, so a `reach` that navigates can
 * be watched doing it.
 */
function tabOver(pages, start, { onSubmit } = {}) {
  const state = { url: start, visited: [start], submits: 0 };
  let built = null;
  const press = (button, document) => {
    state.submits += 1;
    onSubmit?.(button, document, state);
  };
  return {
    state,
    current() {
      if (!built) built = page(pages[state.url] ?? "<p>nothing here</p>", { url: state.url, onSubmit: press });
      return built;
    },
    goTo(url) {
      state.url = url;
      state.visited.push(url);
      built = null;
    },
  };
}

/** chrome-ops.js, with the fixture where Chrome would be. */
function browserFor(tab) {
  return {
    openTab: async () => 1,
    adoptTab: async (tabId) => ({ id: tabId, url: tab.state.url, title: "" }),
    closeTab: async () => {},
    navigate: async (tabId, url) => tab.goTo(url),
    inject: async () => [],
    findTab: async () => null,
    info: async () => ({ url: tab.state.url, status: "complete", title: "" }),
    capture: async () => ({ url: tab.state.url, title: "", capturedAt: Date.now() }),
    frames: async () => [{ frameId: 0, url: tab.state.url }],
    inFrame: async (tabId, frameId, fn, args = []) => {
      const call = vm.runInContext(`(${fn.toString()})`, tab.current().context);
      const value = await call(...args);
      // Structured clone is what crosses the process boundary for real, so
      // a page answer that cannot cross it is a bug here too.
      const answer = value === undefined ? null : JSON.parse(JSON.stringify(value));
      return frameId === undefined ? [{ frameId: 0, result: answer }] : answer;
    },
  };
}

const ADAPTERS = [greenhouseAdapter, workableAdapter, ashbyAdapter, leverAdapter, genericAdapter];

/**
 * One attempt, and everything the engine typed on the way.
 *
 * `claimCompany` refuses by default: a test that is not about pressing
 * Submit must not be able to press it by forgetting to say so.
 */
async function drive(tab, { policy = {}, answer = "Remote", claimed = false } = {}) {
  const typed = [];
  const applyUrl = tab.state.url;
  const request = {
    id: applyUrl, company: "Fixture Co", title: "Senior Engineer", applyUrl,
    jd: "A fixture posting. Never sent anywhere.", profile: PROFILE,
    documents: { resume: RESUME, resumeName: "fixture-resume.pdf" },
    policy: { review: true, ...policy },
  };
  request.answerContext = answerContext(request, PROFILE);

  const outcome = await applyTo({
    request,
    registry: createAdapterRegistry(ADAPTERS),
    browser: browserFor(tab),
    services: {
      answers: async (questions) => {
        typed.push(...questions.map((question) => question.question));
        return { answers: questions.map((question) => ({ key: question.key, value: answer })), unanswered: [], forced: [] };
      },
      claimCompany: async () => ({ claimed }),
    },
  });
  return { outcome, asked: typed, said: new Map(outcome.evidence.answers.map((entry) => [entry.question, String(entry.answer)])) };
}

/* ----------------------------------------------------------------- Lever */

const LEVER_URL = "https://jobs.lever.co/fixtureco/11111111-2222-3333-4444-555555555555/apply";

await test("A Lever posting is claimed outright by the Lever adapter, and the generic one does not get a look in", async () => {
  const tab = tabOver({ [LEVER_URL]: LEVER_FORM }, LEVER_URL);
  const match = await createAdapterRegistry(ADAPTERS).resolve({ url: LEVER_URL, browser: browserFor(tab), tabId: 1, log: () => {} });
  assert.equal(match.adapter.name, "lever");
  assert.equal(match.confidence, CONFIDENCE.EXACT);
});

await test("A Lever form is filled from the profile and reaches Submit, and the board's thank-you is the receipt", async () => {
  const tab = tabOver({ [LEVER_URL]: LEVER_FORM + LEVER_INVISIBLE_CAPTCHA }, LEVER_URL, {
    onSubmit: (button, document) => {
      document.body.innerHTML = "<h1>Thank you for applying</h1><p>We have received your application.</p>";
    },
  });
  const { outcome, said } = await drive(tab, { policy: { review: false }, claimed: true });

  assert.equal(said.get("Full name"), "Daniel Torres");
  assert.equal(said.get("Email"), "someone@example.test");
  assert.equal(said.get("Are you legally authorized to work in the United States?"), "Yes");
  assert.equal(tab.state.submits, 1, "Submit was pressed once, or not at all");
  assert.equal(outcome.submitted, true);
  assert.equal(outcome.status, "confirmed");
  assert.match(outcome.receipt, /Thank you for applying/);
});

await test("An invisible hCaptcha is the board scoring the session and does not stop the application", async () => {
  const tab = tabOver({ [LEVER_URL]: LEVER_FORM + LEVER_INVISIBLE_CAPTCHA }, LEVER_URL);
  const { outcome } = await drive(tab);
  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /filled and verified/, "an enclave frame and a size=invisible frame were read as a wall");
});

await test("A captcha puzzle on the form parks the posting before the claim is taken, with the answers kept", async () => {
  const tab = tabOver({ [LEVER_URL]: LEVER_FORM + SHOWN_CAPTCHA }, LEVER_URL);
  const { outcome, said } = await drive(tab, { policy: { review: false }, claimed: true });
  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /human check \(captcha\) that only a person can clear/);
  assert.equal(outcome.submitted, false, "a form behind a captcha must not be sent");
  assert.equal(tab.state.submits, 0);
  assert.equal(said.get("Full name"), "Daniel Torres", "the answers are kept so a person can redo the form from them");
});

/* --------------------------------------------------------------- generic */

const PLAIN_URL = "https://fixtureco.example/careers/senior-engineer";

await test("A company's own form, recognised by nothing but its shape, is filled at the lowest confidence there is", async () => {
  const tab = tabOver({ [PLAIN_URL]: PLAIN_FORM() }, PLAIN_URL);
  const { outcome, said } = await drive(tab);

  assert.equal(outcome.evidence.adapter, "generic");
  assert.equal(outcome.evidence.confidence, CONFIDENCE.GENERIC);
  assert.equal(said.get("First name"), "Daniel");
  assert.equal(said.get("Last name"), "Torres");
  assert.equal(said.get("Email address"), "someone@example.test");
  assert.equal(said.get("Phone"), "+1 (929) 489-1252");
  assert.match(outcome.reason, /filled and verified/);
});

/**
 * Gem's shape: a real application form that names none of its own fields.
 *
 * Every control is a React component rendering a bare `<input>` with no
 * name, no id, no placeholder, no aria-label and no `<label>` element
 * anywhere - the words the applicant reads sit in a plain `<div>` above
 * each box. Judged on attributes alone the page scored zero of the seven
 * facts an application asks for and the adapter walked away from a form
 * it could have filled completely. The recon that measured that is the
 * reason `probeForm` reads the container as well as the control.
 */
const GEM_FORM = `
  <h1>Senior Engineer</h1>
  <form>
    <div class="row"><div class="lbl">First name</div><input required></div>
    <div class="row"><div class="lbl">Last name</div><input required></div>
    <div class="row"><div class="lbl">Email</div><input type="email" required></div>
    <div class="row"><div class="lbl">Phone</div><input required></div>
    <div class="row"><div class="lbl">Resume</div><input type="file"></div>
    <button type="submit">Submit application</button>
  </form>`;

/** One in-page function over one fixture, through the real frame hop. */
const onPage = async (html, fn) => (await browserFor(tabOver({ [PLAIN_URL]: html }, PLAIN_URL)).inFrame(1, undefined, fn))[0].result;

await test("A form whose controls carry no names, ids or labels is still recognised, from the words beside them", async () => {
  assert.deepEqual(await onPage(GEM_FORM, probeForm), { shape: "form" }, "a React form with no attributes was not recognised as a form");
});

await test("Words belonging to a different control are not collected as this one's label", async () => {
  // The climb stops at the first ancestor holding a second control. Without
  // that, every box on a densely nested page would answer to every label on
  // it, and "this page asks for an email address" would stop meaning
  // anything - which is the failure that matters, because it is the one
  // that would make the adapter fill a newsletter signup.
  const pooled = `<form><div>Email address and phone number<input required><input required><input required><input required></div><button type="submit">Submit application</button></form>`;
  assert.notEqual((await onPage(pooled, probeForm))?.shape, "form", "four controls in one container pooled their labels into a form");
});

/**
 * Paylocity's shape: an "Apply" drawn at zero by zero.
 *
 * `probeForm` counted it and called the page a form; `submitChoices`,
 * which runs just before the claim, measured it and refused. So the
 * adapter filled a twenty-eight field application and then parked on
 * "nothing here sends it" - the posting spent, no application made, and
 * the real form still one link away. The two now apply the same test.
 */
await test("A control too small to be seen does not make a page a form, and the real form is followed to instead", async () => {
  const paylocity = `
    <h1>Senior Engineer</h1>
    <a data-box="0,0" href="https://fixtureco.example/recruiting/jobs/apply/1">Apply</a>
    <form>
      <label for="fn">First name *</label><input id="fn" name="first_name" required>
      <label for="em">Email address *</label><input id="em" name="email" type="email" required>
      <label for="ph">Phone *</label><input id="ph" name="phone" required>
      <label for="li">LinkedIn</label><input id="li" name="linkedin">
    </form>`;
  const seen = await onPage(paylocity, probeForm);
  assert.equal(seen?.shape, "posting", "a 0x0 Apply still counted as the control that sends the application");
  assert.equal(seen?.onward, "https://fixtureco.example/recruiting/jobs/apply/1");
});

await test("probeForm and submitChoices agree about what could send an application", async () => {
  const shown = PLAIN_FORM();
  const flat = shown.replace('<button type="submit">Submit application</button>', '<button data-box="0,0" type="submit">Submit application</button>');

  assert.equal((await onPage(shown, probeForm))?.shape, "form");
  assert.deepEqual(await onPage(shown, submitChoices), ["submit application"]);
  // The disagreement that cost Paylocity: one of these said yes while the
  // other said no, and the gap between them was a filled application
  // nobody could send.
  assert.notEqual((await onPage(flat, probeForm))?.shape, "form");
  assert.deepEqual(await onPage(flat, submitChoices), []);
});

await test("A required field the form will not take parks the posting rather than sending it half-answered", async () => {
  const offices = `<label for="of">Which of our offices would you work from? *</label>
    <select id="of" name="office" required><option value=""></option><option value="dublin">Dublin</option><option value="berlin">Berlin</option></select>`;
  const tab = tabOver({ [PLAIN_URL]: PLAIN_FORM({ extra: offices }) }, PLAIN_URL, {});
  const { outcome } = await drive(tab, { policy: { review: false }, claimed: true, answer: "Remote" });

  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /required field\(s\) on this form were not answered: Which of our offices/);
  assert.equal(outcome.submitted, false);
  assert.equal(tab.state.submits, 0, "a form with an unanswered required field reached Submit");
});

await test("Two differently worded Submits is an ambiguous form, and an ambiguous form is not sent", async () => {
  const tab = tabOver({ [PLAIN_URL]: PLAIN_FORM({ extra: "<button>Apply with LinkedIn</button>" }) }, PLAIN_URL);
  const { outcome } = await drive(tab, { policy: { review: false }, claimed: true });
  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /more than one control could be the one that sends the application/);
  assert.equal(tab.state.submits, 0);
});

await test("A sign-in or registration wall is never filled, however much the rest of it looks like a form", async () => {
  const wall = `<h1>Create your candidate account to apply</h1><form>
    <label for="e">Email *</label><input id="e" name="email" type="email" required>
    <label for="p">Password *</label><input id="p" name="password" type="password" required>
    <label for="f">First name *</label><input id="f" name="first" required>
    <label for="l">Last name *</label><input id="l" name="last" required>
    <button type="submit">Apply</button></form>`;
  const tab = tabOver({ [PLAIN_URL]: wall }, PLAIN_URL);
  assert.equal(await genericAdapter.detect({ browser: browserFor(tab), tabId: 1 }), CONFIDENCE.NONE);

  const { outcome } = await drive(tab);
  assert.match(outcome.reason, /no adapter recognises fixtureco\.example/);
  assert.equal(outcome.submitted, false);
});

await test("A posting whose form is one link away is followed to it; a posting whose only way on is a one-click apply is not", async () => {
  const posting = (control) => `<h1>Senior Engineer</h1><p>${"We are hiring. ".repeat(40)}</p>${control}`;
  const form = "https://fixtureco.example/careers/senior-engineer/apply";

  const followed = tabOver({ [PLAIN_URL]: posting(`<a href="${form}">Apply Now!</a>`), [form]: PLAIN_FORM() }, PLAIN_URL);
  const reached = await drive(followed);
  assert.deepEqual(followed.state.visited, [PLAIN_URL, form]);
  assert.equal(reached.outcome.evidence.adapter, "generic");
  assert.match(reached.outcome.reason, /filled and verified/);
  assert.equal(reached.said.get("First name"), "Daniel");

  const oneClick = tabOver({ [PLAIN_URL]: posting("<button>Easy Apply</button>") }, PLAIN_URL);
  const refused = await drive(oneClick);
  assert.deepEqual(oneClick.state.visited, [PLAIN_URL], "the page was navigated away from on a guess");
  assert.match(refused.outcome.reason, /"Easy Apply", which sends an application rather than opening a form/);

  const button = tabOver({ [PLAIN_URL]: posting("<button>Apply for this job</button>") }, PLAIN_URL);
  const unpressed = await drive(button);
  assert.match(unpressed.outcome.reason, /the only way on from this page is a button/);
});

/* ------------------------------------------------- the ordering, directly */

await test("The generic adapter never outranks an adapter that knows the board, on a page both of them claim", async () => {
  const embedded = `<div id="grnhse_app">${PLAIN_FORM()}</div>`;
  const url = "https://careers.fixtureco.example/jobs/9";
  const tab = tabOver({ [url]: embedded }, url);
  const browser = browserFor(tab);

  // Both answer for this page, which is the only interesting case: the
  // generic one would fill it, and the registry still gives it to
  // Greenhouse.
  assert.equal(await genericAdapter.detect({ url, browser, tabId: 1 }), CONFIDENCE.GENERIC);
  assert.equal(await greenhouseAdapter.detect({ url, browser, tabId: 1 }), CONFIDENCE.STRONG);

  const match = await createAdapterRegistry(ADAPTERS).resolve({ url, browser, tabId: 1, log: () => {} });
  assert.equal(match.adapter.name, "greenhouse");
});

await test("The generic rank is below every other rank, so registering a board adapter always takes its pages back", () => {
  assert.ok(CONFIDENCE.GENERIC < CONFIDENCE.LIKELY);
  assert.ok(CONFIDENCE.LIKELY < CONFIDENCE.STRONG);
  assert.ok(CONFIDENCE.STRONG < CONFIDENCE.EXACT);
  assert.ok(CONFIDENCE.NONE < CONFIDENCE.GENERIC);
});

console.log(`${count} generic-adapter and Lever checks passed.`);
