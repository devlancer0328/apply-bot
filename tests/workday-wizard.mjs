/**
 * The engine against a wizard, which is the thing it had never met.
 *
 * Three boards in, every adapter was a single page with one Submit on it,
 * and `multiPage`, `account`, `advance` and `restore` had been declared in
 * the contract since the first commit without ever running. Workday is all
 * four at once: a registration wall, then six or seven pages each saved by
 * its own Continue, with the last Continue being the submission.
 *
 * So this runs the real engine, the real Workday adapter and the real
 * `src/workday.js` page script against a local wizard - no live tenant, no
 * account, no mail. linkedom holds Workday's markup, a vm context holds the
 * page script exactly as `executeScript` would inject it, and the fake
 * BrowserOps takes its turns on the real foreground queue from tabs.js.
 *
 * ## Safety
 *
 * Nothing here can reach a real employer. The fixture is in-process, the
 * registration guard is asserted rather than assumed (a page script that
 * counts and cancels any real registration attempt), and the submit path
 * is only exercised with the duplicate claim stubbed.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { applyTo } from "../src/apply/engine.js";
import { createAdapterRegistry } from "../src/apply/contract.js";
import { TIMINGS, workdayAdapter } from "../src/apply/adapters/workday.js";
import { answerContext } from "../src/apply/answer-context.js";
import { atFront, resident } from "../src/tabs.js";
import { withDefaults } from "../src/profile.js";
import { resolveField } from "../src/answers.js";

const pageScript = await readFile(new URL("../src/workday.js", import.meta.url), "utf8");

// The fixture draws every page at once, so the patience a real tenant needs
// is ninety seconds of a test waiting for markup that cannot change. The
// shape of the waiting is unchanged - only how long each look allows.
Object.assign(TIMINGS, { still: 60, poll: 10, settle: 4000, move: 4000 });

let count = 0;
const test = async (name, work) => {
  await work();
  count++;
  console.log("PASS " + name);
};

const HOST = "fixture.wd1.myworkdayjobs.com";
const APPLY_URL = `https://${HOST}/en-US/Careers/job/Remote/Senior-Engineer_R-1234`;

/* ------------------------------------------------------------ the markup */

const field = (name, label, control, { required = true } = {}) =>
  `<div data-automation-id="formField-${name}"><label>${label}${required ? " *" : ""}</label>${control}</div>`;

const text = (name, label, options) => field(name, label, `<input type="text" id="${name}">`, options);

const radios = (name, label, choices) =>
  field(
    name,
    label,
    choices.map((choice, at) => `<label for="${name}-${at}">${choice}</label><input type="radio" id="${name}-${at}" name="${name}" value="${choice}">`).join(""),
  );

const footer = (label = "Save and Continue") =>
  `<div data-automation-id="noCaptchaWrapper"><button data-automation-id="pageFooterNextButton">${label}</button><div data-automation-id="click_filter"></div></div>`;

const progress = (step) => `<div data-automation-id="progressBarActiveStep">${step}</div>`;

/**
 * The wizard, page by page, in the markup a real tenant serves.
 *
 * `createAccount` and `signIn` are the wall. The six after it are the
 * wizard. The last is the receipt, and reaching it requires the review
 * page's Continue - which this adapter deliberately does not press.
 */
const WIZARD = {
  create: `<div data-automation-id="signInContent">
      <h2>Create Account</h2>
      <input type="text" data-automation-id="email" id="email">
      <input type="password" data-automation-id="password" id="password">
      <input type="password" data-automation-id="verifyPassword" id="verifyPassword">
      <input type="checkbox" data-automation-id="createAccountCheckbox" id="consent">
      <button data-automation-id="createAccountSubmitButton">Create Account</button>
      <a data-automation-id="signInLink">Sign In</a>
    </div>`,

  signin: `<div data-automation-id="signInContent">
      <h2>Sign In</h2>
      <input type="text" data-automation-id="email" id="email">
      <input type="password" data-automation-id="password" id="password">
      <button data-automation-id="signInSubmitButton">Sign In</button>
      <a data-automation-id="createAccountLink">Create Account</a>
    </div>`,

  myinfo: `<div data-automation-id="applyFlowPage">${progress("My Information")}
      <section data-automation-id="applyFlowMyInfoPage">
        ${text("firstName", "First Name")}
        ${text("lastName", "Last Name")}
        ${text("email", "Email Address")}
        ${text("phone-number", "Phone Number")}
        ${text("addressSection_city", "City")}
      </section>${footer()}</div>`,

  experience: `<div data-automation-id="applyFlowPage">${progress("My Experience")}
      <section data-automation-id="applyFlowMyExpPage">
        ${text("linkedinQuestion", "LinkedIn Profile", { required: false })}
        ${field("resume", "Resume/CV", '<input type="file" id="resume">')}
      </section>${footer()}</div>`,

  questions: `<div data-automation-id="applyFlowPage">${progress("Application Questions")}
      <section data-automation-id="applyFlowPrimaryQuestionsPage">
        ${radios("nonCompete", "Are you subject to a non-compete or non-solicitation agreement?", ["Yes", "No"])}
        ${radios("sponsorship", "Will you now or in the future require sponsorship for employment visa status?", ["Yes", "No"])}
        ${text("startDate", "Earliest start date")}
      </section>${footer()}</div>`,

  disclosures: `<div data-automation-id="applyFlowPage">${progress("Voluntary Disclosures")}
      <section data-automation-id="applyFlowVoluntaryDisclosuresPage">
        ${radios("gender", "Gender", ["Male", "Female", "I do not wish to answer"])}
        ${radios("veteranStatus", "Veteran Status", ["I am not a protected veteran", "I identify as one or more of the classifications of a protected veteran", "I do not wish to answer"])}
      </section>${footer()}</div>`,

  review: `<div data-automation-id="applyFlowPage">${progress("Review")}
      <section data-automation-id="applyFlowReviewPage"><h2>Review your application</h2><p>Please review before submitting.</p></section>
      ${footer("Submit")}</div>`,

  done: `<div data-automation-id="pageMainContent"><h1>Thank you for applying</h1><p>We have received your application.</p></div>`,
};

/** The order the wizard moves in once the wall is behind it. */
const ORDER = ["myinfo", "experience", "questions", "disclosures", "review", "done"];

/* ------------------------------------------------------------ the browser */

/**
 * A page, as `executeScript` would find it.
 *
 * linkedom has no layout and none of the pointer event classes, so the few
 * the page script uses are shimmed. They are shimmed as the real ones
 * behave for this purpose - an event that bubbles and carries a type -
 * rather than faked away, so a handler the script relies on still runs.
 */
function page(html, { url = `https://${HOST}/en-US/Careers/apply`, onNext, onCreate, onSignIn } = {}) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);

  for (const name of ["MouseEvent", "PointerEvent", "InputEvent", "FocusEvent"]) {
    if (!window[name]) window[name] = class extends window.Event {};
  }
  window.getComputedStyle ??= () => ({ display: "block", visibility: "visible" });
  window.scrollTo = () => {};
  window.performance ??= performance;
  const element = window.Element?.prototype ?? window.HTMLElement.prototype;
  element.getBoundingClientRect ??= function () {
    return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 };
  };
  element.focus ??= function () {};
  element.scrollIntoView ??= function () {};
  Object.defineProperty(element, "offsetParent", { configurable: true, get() { return this.ownerDocument.body; } });
  for (const node of document.querySelectorAll("*")) node.getClientRects = () => [{ width: 10, height: 10 }];

  // linkedom parses markup; it does not implement what a click to a radio
  // or a checkbox means. The page script writes a choice by clicking one,
  // so the fixture supplies the browser's half of that.
  for (const box of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
    // Both the property and the attribute: linkedom answers `.checked`
    // from one and `:checked` from the other, and the page script reads
    // back through both.
    const tick = (node, on) => {
      node.checked = on;
      if (on) node.setAttribute("checked", "");
      else node.removeAttribute("checked");
    };
    box.addEventListener("click", () => {
      if (box.type === "checkbox") return tick(box, !box.checked);
      for (const sibling of document.querySelectorAll(`input[type="radio"][name="${box.getAttribute("name")}"]`)) tick(sibling, false);
      tick(box, true);
    });
  }

  // A real tenant answers a dropped file by drawing an upload row and
  // marking it successful a moment later; the page script waits for that
  // marker. Without it the fixture would sit in the page script's own
  // forty-five-second upload wait, which is a finding about that wait
  // rather than about the wizard.
  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.addEventListener("change", () => {
      const name = input.files?.[0]?.name ?? "fixture-resume.pdf";
      const row = document.createElement("div");
      row.setAttribute("data-automation-id", "file-upload-item");
      row.innerHTML = `<span data-automation-id="file-upload-item-name">${name}</span><span data-automation-id="file-upload-successful">Successfully Uploaded</span>`;
      input.parentElement.append(row);
    });
  }

  const press = (selector, handler) => {
    const node = document.querySelector(selector);
    if (node && handler) node.addEventListener("click", handler);
  };
  // The footer is wrapped the way Workday wraps it, so the click lands on
  // the filter div over the button rather than the button.
  press('[data-automation-id="click_filter"]', onNext);
  press('[data-automation-id="pageFooterNextButton"]', onNext);
  press('[data-automation-id="createAccountSubmitButton"]', onCreate);
  press('[data-automation-id="signInSubmitButton"]', onSignIn);

  const context = vm.createContext({
    window,
    document,
    location: { href: url, hostname: HOST, assign: () => {} },
    setTimeout,
    clearTimeout,
    performance,
    CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    InputEvent: window.InputEvent,
    FocusEvent: window.FocusEvent,
    DataTransfer: class { constructor() { this.items = { add: (file) => this.files.push(file) }; this.files = []; } },
    File: class { constructor(parts, name, options) { this.name = name; this.type = options?.type ?? ""; } },
    Blob,
    Uint8Array,
    atob,
    btoa,
    console,
  });
  context.globalThis = context;
  // linkedom hands out one window across parses, and the page script
  // installs itself only once ("if (window.__wdApply) return"). Left alone,
  // page two of the wizard would be read by page one's closure.
  delete window.__wdApply;
  vm.runInContext(pageScript, context);
  return { document, window, context, url, api: window.__wdApply };
}

/**
 * The wizard as a tab: one page at a time, moving when Continue is pressed.
 *
 * `registrations` is the guard. Creating a candidate account is the one act
 * here with a consequence that outlives the test, so the fixture counts
 * every attempt at it rather than trusting the adapter not to make one.
 */
function wizard({ start = "create", registerable = true, failSignIn = false, wall = true } = {}) {
  const state = { at: start, registrations: 0, signIns: 0, continues: [], submitted: false };
  let built = null;

  const build = () => {
    const name = state.at;
    const html = WIZARD[name];
    built = page(html, {
      url: name === "done" ? `https://${HOST}/en-US/Careers?Job_Application_ID=new` : `https://${HOST}/en-US/Careers/apply`,
      onNext: () => {
        state.continues.push(name);
        if (name === "review") state.submitted = true;
        const next = ORDER[ORDER.indexOf(name) + 1];
        if (next) {
          state.at = next;
          built = null;
        }
      },
      onCreate: () => {
        state.registrations += 1;
        if (!registerable) return;
        state.at = "myinfo";
        built = null;
      },
      onSignIn: () => {
        state.signIns += 1;
        if (failSignIn) return;
        state.at = wall ? "myinfo" : "myinfo";
        built = null;
      },
    });
    return built;
  };

  return {
    state,
    current: () => built ?? build(),
    goTo(name) {
      state.at = name;
      built = null;
    },
  };
}

/** chrome-ops.js, with the wizard where Chrome would be. */
function browserFor(tab, { turns = [] } = {}) {
  const turn = (name, work) =>
    atFront(async () => {
      const at = Date.now();
      const value = await work();
      turns.push({ name, held: Date.now() - at });
      return value;
    });

  return {
    turns,
    openTab: (url) => turn("openTab", async () => 1),
    adoptTab: (tabId) => turn("adoptTab", async () => ({ id: tabId, url: APPLY_URL, title: "" })),
    closeTab: () => turn("closeTab", async () => {}),
    navigate: (tabId, url) => turn("navigate", async () => tab.current()),
    inject: () => turn("inject", async () => []),
    findTab: async () => null,
    info: async () => ({ url: tab.current().url, status: "complete", title: "" }),
    capture: (tabId) => turn("capture", async () => ({ url: tab.current().url, title: "", capturedAt: Date.now() })),
    frames: (tabId) => turn("frames", async () => [{ frameId: 0, url: tab.current().url }]),
    inFrame: (tabId, frameId, fn, args = []) =>
      turn("inFrame", async () => {
        const { context } = tab.current();
        const call = vm.runInContext(`(${fn.toString()})`, context);
        const value = await call(...args);
        // Structured clone is what crosses the process boundary for real,
        // so a page answer that cannot cross it is a bug here too.
        const answer = value === undefined ? null : JSON.parse(JSON.stringify(value));
        return frameId === undefined ? [{ frameId: 0, result: answer }] : answer;
      }),
  };
}

/* ------------------------------------------------------------- the person */

const PROFILE = withDefaults({
  firstName: "Fixture",
  lastName: "Candidate",
  email: "fixture@example.test",
  phone: "555-0100",
  city: "Temple",
  state: "Texas",
  country: "United States",
  workdayPassword: "fixture-only-never-real",
  street: "1 Fixture Way",
  nonCompete: "no",
  workAuthorization: "us-citizen",
  requiresSponsorship: "no",
  startDate: "Two weeks after offer",
  willingToRelocate: "no",
  gender: "decline",
  veteranStatus: "not-protected",
  disability: "decline",
});

function requestFor(policy = {}) {
  const request = {
    id: APPLY_URL,
    company: "Fixture Tenant",
    title: "Senior Engineer",
    applyUrl: APPLY_URL,
    jd: "A fixture posting. Never sent anywhere.",
    profile: PROFILE,
    documents: { resume: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }), resumeName: "fixture-resume.pdf" },
    resumeData: { experience: [], education: [] },
    policy: { review: true, ...policy },
  };
  request.answerContext = answerContext(request, PROFILE);
  return request;
}

async function run({ tab, policy = {}, services = {}, checkpoint, log = () => {} } = {}) {
  const request = { ...requestFor(policy), ...(checkpoint ? { checkpoint } : {}) };
  const browser = browserFor(tab);
  const outcome = await applyTo({
    request,
    registry: createAdapterRegistry([workdayAdapter]),
    browser,
    services: {
      answers: async (questions) => ({
        answers: questions.map((question) => ({ key: question.key, value: (question.options ?? [])[0]?.label ?? "Yes" })),
        unanswered: [],
        forced: [],
      }),
      claimCompany: async () => ({ claimed: false, reason: "the wizard fixture never claims a company" }),
      ...services,
    },
    log,
  });
  return { outcome, browser };
}

/* ------------------------------------------------------------------ tests */

await test("Registering is refused by default, and the fixture confirms no account was ever created", async () => {
  const tab = wizard({ start: "create" });
  const { outcome } = await run({ tab });
  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /requires a candidate account before the form; registering is not permitted/);
  assert.equal(tab.state.registrations, 0, "the registration guard counted an attempt to create an account");
  assert.equal(tab.state.submitted, false);
  assert.equal(outcome.submitted, false);
});

await test("A tenant that opens on Sign In is signed into, and the wizard is walked page by page", async () => {
  const tab = wizard({ start: "signin" });
  const lines = [];
  const { outcome } = await run({ tab, log: (level, message) => lines.push(message) });

  assert.equal(tab.state.signIns, 1);
  assert.equal(tab.state.registrations, 0);
  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /filled and verified/);
  // Four form pages filled, then Review reached and deliberately not pressed.
  assert.deepEqual(tab.state.continues, ["myinfo", "experience", "questions", "disclosures"]);
  assert.equal(tab.state.at, "review");
  assert.equal(tab.state.submitted, false, "review mode must never press the review page's Continue");
  assert.equal(outcome.evidence.pages, 5, "five pages were walked: four forms and the review page");
  assert.ok(outcome.evidence.answers.length >= 5, `the wizard's answers were recorded across pages (${outcome.evidence.answers.length})`);
  assert.ok(lines.some((line) => /page 2: read/.test(line)), "the engine reported reading a second page, which is the loop running");
});

await test("Every page's answers are kept, and the non-compete question is answered No from the profile", async () => {
  const tab = wizard({ start: "signin" });
  const { outcome } = await run({ tab });
  const said = new Map(outcome.evidence.answers.map((entry) => [entry.question, String(entry.answer)]));
  assert.equal(said.get("First Name"), "Fixture");
  assert.equal(said.get("Email Address"), "fixture@example.test");
  assert.equal(said.get("Are you subject to a non-compete or non-solicitation agreement?"), "No");
  assert.equal(said.get("Will you now or in the future require sponsorship for employment visa status?"), "No");
});

await test("The adapter stops at Review so the engine, not the wizard, decides to submit", async () => {
  const tab = wizard({ start: "review" });
  const advanced = await workdayAdapter.advance({ browser: browserFor(tab), tabId: 1, request: { company: "Fixture Tenant" }, log: () => {}, page: 4 });
  assert.deepEqual(advanced, { done: true, at: "Review", atSubmit: true });
  assert.equal(tab.state.submitted, false, "advance must not press the review page");
});

await test("Submit is only pressed once the company is claimed, and a new receipt is what confirms it", async () => {
  const tab = wizard({ start: "review" });
  const { outcome } = await run({
    tab,
    policy: { review: false },
    services: { claimCompany: async () => ({ claimed: true }) },
  });
  assert.equal(tab.state.submitted, true);
  assert.equal(outcome.submitted, true);
  assert.equal(outcome.status, "confirmed");
  assert.match(outcome.receipt, /Thank you for applying/);
});

await test("A refused claim stops the wizard at Review with nothing pressed", async () => {
  const tab = wizard({ start: "review" });
  const { outcome } = await run({ tab, policy: { review: false } });
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reason, /already applied to this company/);
  assert.equal(tab.state.submitted, false);
  assert.equal(outcome.submitted, false);
});

await test("A checkpoint is reconciled against the page rather than trusted, and never skips a page", async () => {
  // The worker died after My Information; Workday reopens on My Experience.
  const tab = wizard({ start: "experience" });
  const saved = [];
  const { outcome } = await run({
    tab,
    checkpoint: { pages: ["My Information"], answers: 5 },
    services: { checkpoint: async ({ checkpoint }) => saved.push([...checkpoint.pages]) },
  });
  assert.equal(outcome.status, "challenge");
  assert.deepEqual(tab.state.continues, ["experience", "questions", "disclosures"], "it resumed where the page was, not where the note said");
  assert.deepEqual(saved.at(-1), ["My Information", "My Experience", "Application Questions", "Voluntary Disclosures"]);
});

await test("A checkpoint ahead of the page refills rather than skipping, because the page is the only truth", async () => {
  // The note says Application Questions was saved; the wizard came back on
  // it anyway, which means the save did not land.
  const tab = wizard({ start: "questions" });
  const lines = [];
  await run({ tab, checkpoint: { pages: ["My Information", "My Experience", "Application Questions"] }, log: (level, message) => lines.push(message) });
  assert.deepEqual(tab.state.continues, ["questions", "disclosures"]);
  assert.ok(lines.some((line) => /filling it again rather than trusting the note/.test(line)));
});

await test("A page that will not move on parks the attempt instead of pressing Continue forever", async () => {
  const tab = wizard({ start: "myinfo" });
  // The footer answers nothing: Workday's own "the save did not land" case.
  const stuck = tab.current();
  for (const node of stuck.document.querySelectorAll('[data-automation-id="click_filter"], [data-automation-id="pageFooterNextButton"]')) {
    node.replaceWith(node.cloneNode(true));
  }
  const { outcome } = await run({ tab });
  assert.equal(outcome.status, "challenge");
  assert.match(outcome.reason, /would not move/);
  assert.equal(tab.state.continues.length, 0);
});

/* ------------------------------------------- My Information, which redraws */

/**
 * The page the live tenants actually stopped on, in its own markup.
 *
 * It is kept apart from `WIZARD.myinfo` because the three things below are
 * about the page script rather than the engine, and because adding a
 * country box to the wizard's own My Information would change what every
 * test above walks through.
 */
const ADDRESS_FIELDS = [
  text("firstName", "First Name"),
  text("lastName", "Last Name"),
  text("country", "Country"),
  text("phone-number", "Phone Number"),
].join("");

const addressPage = () =>
  page(`<div data-automation-id="applyFlowPage">${progress("My Information")}
    <section data-automation-id="applyFlowMyInfoPage" id="info">${ADDRESS_FIELDS}</section>${footer()}</div>`);

await test("Country goes in before the fields it would otherwise wipe, whatever order the plan asked for", async () => {
  const { api, document } = addressPage();
  const inventory = api.inventory();
  const keyFor = (name) => inventory.fields.find((field) => field.name === name).key;

  const report = await api.apply({
    fills: [
      { key: keyFor("firstName"), value: "Daniel" },
      { key: keyFor("country"), value: "United States" },
      { key: keyFor("lastName"), value: "Torres" },
    ],
  });
  assert.equal(report.timings[0].key, keyFor("country"), "country was not filled first");
  assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
  assert.equal(document.querySelector("#firstName").value, "Daniel");
});

await test("A field whose node was replaced by the page's own redraw is found again and refilled", async () => {
  // Choosing a country swaps Workday's whole name and address block for a
  // country-specific one, and every value typed before that goes with the
  // nodes that held it. The keys have to survive it; before they did,
  // every field reported "the control is no longer on the page" and
  // Continue was refused for a first name that had been typed twice.
  const { api, document } = addressPage();
  const inventory = api.inventory();
  const first = inventory.fields.find((field) => field.name === "firstName").key;

  await api.apply({ fills: [{ key: first, value: "Daniel" }] });
  assert.equal(document.querySelector("#firstName").value, "Daniel");

  document.querySelector("#info").innerHTML = ADDRESS_FIELDS;
  assert.equal(document.querySelector("#firstName").value, "", "the fixture did not actually replace the block");
  assert.ok(
    api.verify().empty.some((field) => field.key === first),
    "a required field emptied by the redraw has to read as empty, or nothing puts it back",
  );

  const again = await api.apply({ fills: [{ key: first, value: "Daniel" }] });
  assert.equal(again.failed.length, 0, JSON.stringify(again.failed));
  assert.equal(document.querySelector("#firstName").value, "Daniel");
  assert.equal(api.verify().empty.some((field) => field.key === first), false);
});

await test("A phone number loses the dialling code that belongs to the menu beside it", async () => {
  const { api, document } = addressPage();
  const inventory = api.inventory();
  const phone = inventory.fields.find((field) => field.name === "phone-number").key;

  await api.apply({ fills: [{ key: phone, value: "+1 (929) 489-1252" }] });
  assert.equal(document.querySelector("#phone-number").value, "9294891252", "Workday answers anything else with \"Enter a valid format for Phone Number\"");
});

await test("A declined self-identification is recorded in whichever words the tenant uses for it", async () => {
  const profile = withDefaults({ gender: "Decline to self-identify", race: "Decline to self-identify", veteranStatus: "I do not wish to answer" });
  const menu = (label, options) => ({ key: "d", tag: "button", type: "select", label, required: true, combobox: true, options: options.map((entry) => ({ label: entry })), kind: "select" });
  const chosen = (label, options) => resolveField(menu(label, options), profile, {}).value;

  // Every one of these came off a live tenant. Matching is on the whole
  // label, so each wording missing from the decline list was a required
  // question the profile could not answer and a finished application
  // parked on Voluntary Disclosures.
  assert.equal(chosen("Please select your gender", ["Select One", "Decline to State", "Female", "Male"]), "Decline to State");
  assert.equal(chosen("Please select your gender.", ["Select One", "Female", "Male", "Not Declared"]), "Not Declared");
  assert.equal(chosen("Please select the ethnicity which most accurately describes how you identify yourself.", ["Select One", "Asian (Not Hispanic or Latino) (United States of America)", "Decline to State (United States of America)"]), "Decline to State (United States of America)");
  assert.equal(chosen("What is your Veteran Status?", ["Select One", "I am not a protected veteran", "I decline to self-identify"]), "I decline to self-identify");
  assert.equal(chosen("Please select the veteran status which most accurately describes your status.", ["Select One", "I AM NOT A VETERAN", "I DO NOT WISH TO SELF-IDENTIFY"]), "I DO NOT WISH TO SELF-IDENTIFY");

  // A decline still never answers the question itself.
  const stated = resolveField(menu("Please select your gender", ["Select One", "Female", "Male"]), profile, {});
  assert.equal(stated.outcome, "blocked", JSON.stringify(stated));
});

await test("The Review page's saved attachments are not mistaken for uploads still in flight", async () => {
  const attachments = (html) => {
    const { document } = parseHTML(`<body>${html}</body>`);
    return {
      inject: async () => {},
      inFrame: async (_tabId, _frameId, fn, args = []) => vm.runInNewContext(`(${fn.toString()})(...args)`, { document, args, window: {} }),
    };
  };
  const item = (inner) => `<div data-automation-id="file-upload-item"><span data-automation-id="file-upload-item-name">Resume.pdf</span>${inner}</div>`;

  // How Review renders a résumé that uploaded cleanly two pages earlier:
  // the name, and no sign either way. Reading that as pending parked a
  // finished application one press short of Submit.
  const review = await workdayAdapter.uploadsSettled({ browser: attachments(item("") + item("")), tabId: 1 });
  assert.equal(review.settled, true, JSON.stringify(review.pending));

  const done = await workdayAdapter.uploadsSettled({ browser: attachments(item('<span data-automation-id="file-upload-successful">Successfully Uploaded</span>')), tabId: 1 });
  assert.equal(done.settled, true);

  const uploading = await workdayAdapter.uploadsSettled({ browser: attachments(item('<div role="progressbar" aria-valuenow="40"></div>')), tabId: 1 });
  assert.equal(uploading.settled, false, "an upload genuinely in flight still has to hold Submit back");
  assert.equal(uploading.pending.join(), "Resume.pdf");
});

await test("A yes/no question about years of experience is not answered with a number of years", async () => {
  const question = (options) => ({ key: "q", tag: "button", type: "select", label: "Do you meet the required years of experience for this role?", required: true, combobox: true, options, kind: "select" });
  const profile = withDefaults({ techYears: 9 });

  const counted = resolveField(question([{ label: "0-2" }, { label: "3-5" }, { label: "6-10" }]), profile, {});
  assert.equal(counted.outcome, "fill");
  assert.equal(counted.value, "6-10", "a menu that offers counts still gets the count");

  // Workday's Application Questions page asks this as a yes/no, and the
  // years rule used to claim it and aim a 9 at a menu reading Yes and No.
  const judged = resolveField(question([{ label: "Yes" }, { label: "No" }]), profile, {});
  assert.equal(judged.outcome, "ask", JSON.stringify(judged));
  assert.deepEqual(judged.options.map((option) => option.label), ["Yes", "No"]);
});

await test("A state menu is answered in whichever spelling it offers", async () => {
  const menu = (options) => ({ key: "s", tag: "button", type: "select", label: "State", required: true, combobox: true, options, kind: "select" });
  const profile = withDefaults({ state: "TX" });

  // Workday writes them out in full. Before the code and the name were
  // both offered, nothing matched and a live application went out saying
  // Alabama, which is what the model picked off the top of the list.
  assert.equal(resolveField(menu([{ label: "Alabama" }, { label: "Texas" }, { label: "Utah" }]), profile, {}).value, "Texas");
  assert.equal(resolveField(menu([{ label: "AL" }, { label: "TX" }, { label: "UT" }]), profile, {}).value, "TX");
  assert.equal(resolveField(menu([]), withDefaults({ state: "Texas" }), {}).candidates.join("|"), "Texas|TX");
});

await test("No turn on the wizard holds the foreground, so a queued job is never starved by a long page", async () => {
  const tab = wizard({ start: "signin" });
  const { browser } = await run({ tab });
  const longest = Math.max(...browser.turns.map((entry) => entry.held));
  assert.ok(browser.turns.length > 50, `the wizard took ${browser.turns.length} turns across its pages`);
  assert.ok(longest < 600, `the longest single turn held the front for ${longest}ms`);
});

/* ------------------------------------------- the stranded candidate account */

/**
 * A tenant whose account exists under this address with a password
 * nothing here holds - which is what "could not sign in" meant on both
 * Workday tenants the first unattended night, and what made each of them
 * a permanently lost employer.
 *
 * The three pages are drawn into the one document rather than rebuilt,
 * because that is what a real tenant does: the sign-in page re-renders
 * itself into the reset page, and `forgotPassword` reads that transition
 * inside a single call.
 */
const RECOVERY = {
  signin: `<div data-automation-id="signInContent"><h2>Sign In</h2>
      <input type="text" data-automation-id="email" id="email">
      <input type="password" data-automation-id="password" id="password">
      <button data-automation-id="signInSubmitButton">Sign In</button>
      <button data-automation-id="forgotPasswordLink">Forgot your password?</button></div>`,
  forgot: `<div data-automation-id="signInContent"><h2>Forgot Password</h2>
      <input type="text" data-automation-id="email" id="email">
      <button data-automation-id="submitButton">Submit</button></div>`,
  reset: `<div data-automation-id="signInContent"><h2>Set a new password</h2>
      <input type="password" data-automation-id="password" id="password">
      <input type="password" data-automation-id="verifyPassword" id="verifyPassword">
      <button data-automation-id="submitButton">Submit</button></div>`,
};

function strandedTenant({ acceptPassword = true } = {}) {
  const state = { signIns: 0, resetsAsked: 0, mailedTo: "", saved: [], password: "whatever-it-was-set-to-in-2024" };
  const cell = { built: null, markup: RECOVERY.signin };
  // Once the account opens, the tenant is an ordinary wizard again, so the
  // test can tell a recovered sign-in from one that merely stopped failing.
  const inside = wizard({ start: "myinfo" });
  let opened = false;

  const wire = (built) => {
    const doc = built.document;
    const value = (id) => doc.querySelector(`[data-automation-id="${id}"]`)?.value ?? "";
    const redraw = (markup) => { doc.body.innerHTML = markup; wire(built); };
    const on = (id, handler) => doc.querySelector(`[data-automation-id="${id}"]`)?.addEventListener("click", handler);

    on("signInSubmitButton", () => {
      state.signIns += 1;
      if (value("password") !== state.password) return;
      opened = true;
    });
    on("forgotPasswordLink", () => redraw(RECOVERY.forgot));
    on("submitButton", () => {
      // Which page's Submit this is, read off the page rather than kept
      // in a flag, exactly as the adapter has to read it.
      if (doc.querySelector('[data-automation-id="verifyPassword"]')) {
        state.saved.push(value("password"));
        if (!acceptPassword) {
          doc.body.insertAdjacentHTML("beforeend", '<div data-automation-id="inputAlert">New password cannot match a previous password.</div>');
          return;
        }
        state.password = value("password");
        cell.markup = RECOVERY.signin;
        cell.built = null;
        return;
      }
      state.resetsAsked += 1;
      state.mailedTo = value("email");
      redraw('<div data-automation-id="signInContent"><p>Check your email for a link to reset your password.</p></div>');
    });
    return built;
  };

  return {
    state,
    wizard: inside,
    current: () => (opened ? inside.current() : cell.built ?? (cell.built = wire(page(cell.markup, { url: `https://${HOST}/en-US/Careers/login` })))),
    // The mailed link lands on the reset page, in the same tab.
    goTo(markup) { cell.markup = markup; cell.built = null; },
  };
}

async function recover({ tenant, host, verification, kinds = ["workday-password-reset"] }) {
  const applyUrl = `https://${host}/en-US/Careers/job/Remote/Senior-Engineer_R-1234`;
  const request = { ...requestFor(), id: applyUrl, applyUrl, company: `Tenant ${host}` };
  const browser = browserFor(tenant);
  const lines = [];
  const outcome = await applyTo({
    request,
    registry: createAdapterRegistry([workdayAdapter]),
    browser: { ...browser, navigate: async (tabId, url) => { if (/reset/i.test(url)) tenant.goTo(RECOVERY.reset); return tenant.current(); } },
    services: {
      answers: async (questions) => ({ answers: questions.map((question) => ({ key: question.key, value: (question.options ?? [])[0]?.label ?? "Yes" })), unanswered: [], forced: [] }),
      claimCompany: async () => ({ claimed: false, reason: "the wizard fixture never claims a company" }),
      verification,
      verificationKinds: kinds,
    },
    log: (level, message) => lines.push(message),
  });
  return { outcome, lines };
}

await test("An account this password cannot open is recovered by reset, and the new password is the stored one", async () => {
  const tenant = strandedTenant();
  const asked = [];
  const { outcome, lines } = await recover({
    tenant,
    host: "recovered.wd1.myworkdayjobs.com",
    verification: async (need) => { asked.push(need); return { link: `https://recovered.wd1.myworkdayjobs.com/reset-password?token=t` }; },
  });

  assert.equal(tenant.state.resetsAsked, 1, "exactly one reset was requested");
  assert.equal(tenant.state.mailedTo, PROFILE.email);
  assert.deepEqual(tenant.state.saved, [PROFILE.workdayPassword], "the account was set to the password the profile already holds, so there is no new secret to store");
  assert.equal(tenant.state.password, PROFILE.workdayPassword);
  // Two failed sign-ins, then exactly one more after the reset.
  assert.equal(tenant.state.signIns, 3);
  assert.equal(asked[0].kind, "workday-password-reset", "the mailbox is asked for a reset mail, which is not the activation mail");
  assert.match(asked[0].search, /reset your password/);
  assert.equal(outcome.evidence.pages, 5, "the wizard behind the wall was walked, which is the whole point of the reset");
  assert.equal(tenant.wizard.state.at, "review");
  assert.ok(lines.some((line) => /now uses the stored Workday password/.test(line)));
});

await test("A reset is never asked for twice, and a tenant that refuses the password parks instead of looping", async () => {
  const host = "stubborn.wd1.myworkdayjobs.com";
  const first = strandedTenant({ acceptPassword: false });
  const refused = await recover({ tenant: first, host, verification: async () => ({ link: `https://${host}/reset-password?token=t` }) });
  assert.equal(first.state.resetsAsked, 1);
  assert.equal(refused.outcome.status, "challenge");
  assert.match(refused.outcome.reason, /would not take the stored password: New password cannot match/);

  // The next posting on the same tenant must not mail a second link.
  const second = strandedTenant({ acceptPassword: false });
  const again = await recover({ tenant: second, host, verification: async () => { throw new Error("a second reset was requested for a tenant already tried"); } });
  assert.equal(second.state.resetsAsked, 0);
  assert.match(again.outcome.reason, /a reset has already been tried/);
});

await test("A reset mail the mailbox cannot find parks with the link named, and changes no password", async () => {
  const tenant = strandedTenant();
  const { outcome } = await recover({
    tenant,
    host: "unread.wd1.myworkdayjobs.com",
    verification: async () => { throw new Error("no account mail from unread arrived within 120 seconds"); },
  });
  assert.equal(tenant.state.resetsAsked, 1);
  assert.deepEqual(tenant.state.saved, [], "nothing was saved, so the account is exactly as it was");
  assert.match(outcome.reason, /has mailed a password reset to .*and the mailbox reader could not find it/);
  assert.match(outcome.reason, /Follow that link and set the password to the one in Settings/);
});

await test("A mailbox that does not read reset mail is never asked, and the link is handed to a person", async () => {
  // The kinds the reader advertises are the only ones it is asked for.
  // Asked for one it does not know, src/apply/verification.js routes the
  // wait to its security-code reader, which looks for eight digits, holds
  // the Gmail tab for the whole timeout, and then reports the failure in
  // the words of a submitted application that must never be applied to
  // again - none of which is true of a reset.
  const tenant = strandedTenant();
  const { outcome } = await recover({
    tenant,
    host: "unsupported.wd1.myworkdayjobs.com",
    kinds: ["email-code", "workday-account"],
    verification: async () => { throw new Error("the mailbox was asked for a kind it does not read"); },
  });
  assert.equal(tenant.state.resetsAsked, 1, "the reset mail is still sent, because the link is worth having");
  assert.deepEqual(tenant.state.saved, []);
  assert.match(outcome.reason, /a password reset has just been mailed there/);
  assert.match(outcome.reason, /goes through unattended from then on/);
});

resident(null);
console.log(`${count} Workday wizard checks passed.`);
