/**
 * The form that took nothing, and was sent anyway.
 *
 * Airbnb serves its postings on careers.airbnb.com as two tabs - "Role
 * overview" and "Application" - with the Greenhouse form in an iframe
 * behind the second. Landing on the first on the night of the 10th, the
 * engine found the fields, filled none of them, rescued none of them, and
 * pressed Submit on a blank application. The board refused it over all
 * eight of its required fields and the attempt was handed back as
 * "could not be sent".
 *
 * The refusal was not the damage. `claimCompany` is called on the way to
 * Submit, so the posting was recorded as one this had applied to - and a
 * posting nobody applied to that will never be returned to is worse than
 * one that failed loudly. It happened twice in one night on two different
 * Airbnb roles.
 *
 * Two things were wrong and both are asserted here. The engine would
 * press Submit on a form holding none of the candidate's answers, and it
 * had no way to get past a tab to the form in the first place.
 *
 * The line between them matters. "Still empty after a second pass, sending
 * anyway" is a *good* bet on one field a page would not take - boards
 * refuse values for their own reasons and a form that is 15/16 filled is
 * worth sending. It stops being a bet when none of the required fields
 * took a value, because then there is nothing to send.
 */

import assert from "node:assert/strict";
import { applyTo } from "../src/apply/engine.js";
import { createAdapterRegistry, CONFIDENCE, OUTCOMES } from "../src/apply/contract.js";
import { answerContext } from "../src/apply/answer-context.js";
import { withDefaults } from "../src/profile.js";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log("PASS " + name); };

const PROFILE = withDefaults({
  firstName: "Daniel", lastName: "Torres", email: "someone@example.test", phone: "+1 (929) 489-1252",
  city: "Temple", state: "TX", country: "United States",
  workAuthorization: "us-citizen", requiresSponsorship: "no", howHeard: "Company website",
});

/** The eight Airbnb named in its refusal, as fields. */
const AIRBNB_FIELDS = [
  "First Name", "Last Name", "Email", "Country", "Phone", "Location (City)",
  "How did you hear about this job?", "Are you legally authorized to work in the country where the job is located?",
].map((label, index) => ({ key: `f${index + 1}`, tag: "input", type: "text", label, required: true, options: [] }));

/**
 * A board whose fields take a value only once the form has been opened.
 * `tabbed` decides whether it starts closed; `reveal` is what the page
 * reports when the engine clicks its way in.
 */
function board({ tabbed, takes = () => true }) {
  let open = !tabbed;
  let presses = 0;
  const applied = () => (open ? AIRBNB_FIELDS.filter((field) => takes(field)).map((field) => field.key) : []);

  const adapter = {
    name: "fixture",
    capabilities: { multiPage: false, upload: false, verifyAccepted: true, submit: true, receipt: true, account: false },
    detect: async () => CONFIDENCE.EXACT,
    // No `inspect` of its own: that is what makes the engine run its own
    // settle-and-reveal first, which is the half being tested.
    fill: async ({ fills }) => {
      const took = new Set(applied());
      return { applied: fills.filter((fill) => took.has(fill.key)).map((fill) => fill.key), failed: fills.filter((fill) => !took.has(fill.key)).map((fill) => ({ key: fill.key, reason: "the page did not take it" })), values: {} };
    },
    verify: async () => ({ empty: AIRBNB_FIELDS.filter((field) => !applied().includes(field.key)) }),
    uploadsSettled: async () => ({ settled: true }),
    menuOptions: async () => [],
    submit: async () => (presses += 1, { clicked: true }),
    readOutcome: async () => ({ status: OUTCOMES.CONFIRMED, receipt: "Thank you for applying." }),
  };

  const browser = {
    openTab: async () => 1,
    capture: async () => ({ url: "https://careers.fixture.test/positions/1", title: "Fixture", capturedAt: Date.now() }),
    closeTab: async () => {},
    inject: async () => {},
    // Every page call the engine makes outside the adapter goes through
    // here: counting inputs while it settles, then looking for the door.
    // The tab is answered as a page holding no form of its own, which is
    // what the top frame of a careers site embedding a board looks like.
    inFrame: async (_tabId, _frameId, fn) => {
      const source = String(fn);
      if (source.includes("querySelectorAll(\"input, select, textarea\")")) return [{ frameId: 0, result: open ? AIRBNB_FIELDS.length : 2 }];
      if (source.includes("__ghApply")) return [{ frameId: 0, result: { fields: AIRBNB_FIELDS } }];
      if (source.includes("aria-selected")) {
        if (open) return [{ frameId: 0, result: "" }];
        open = true;
        return [{ frameId: 0, result: "Application" }];
      }
      return [];
    },
  };

  return { adapter, browser, presses: () => presses, opened: () => open };
}

async function send(options) {
  const fixture = board(options);
  const request = {
    id: "https://careers.fixture.test/positions/1", company: "Fixture Co", title: "Senior Engineer",
    applyUrl: "https://careers.fixture.test/positions/1", jd: "A fixture posting. Never sent anywhere.",
    profile: PROFILE, documents: {}, policy: { review: false },
  };
  request.answerContext = answerContext(request, PROFILE);
  const claims = [];
  const outcome = await applyTo({
    request,
    registry: createAdapterRegistry([fixture.adapter]),
    browser: fixture.browser,
    services: {
      answers: async () => ({ answers: [], unanswered: [], forced: [] }),
      claimCompany: async () => (claims.push(Date.now()), { claimed: true }),
    },
  });
  return { outcome, ...fixture, claims: claims.length };
}

await test("A form that took none of its required answers is never submitted", async () => {
  // The board stays shut and refuses every value, so nothing lands.
  const sent = await send({ tabbed: true, takes: () => false });
  assert.equal(sent.presses(), 0, "Submit was pressed on a form holding none of the candidate's answers");
  assert.equal(sent.claims, 0, "a posting nobody applied to was claimed as applied-to");
  assert.notEqual(sent.outcome.status, OUTCOMES.CONFIRMED);
  assert.match(sent.outcome.reason, /took none of its 8 required answer\(s\)/);
});

await test("One field a page would not take is still sent", async () => {
  // The distinction the gate turns on: 7 of 8 is a page being difficult
  // about one field, and that application is worth sending.
  const sent = await send({ tabbed: false, takes: (field) => field.label !== "Country" });
  assert.equal(sent.outcome.status, OUTCOMES.CONFIRMED);
  assert.equal(sent.presses(), 1);
});

await test("A form behind a tab is opened and then filled", async () => {
  // The same shut board, but its fields work once the tab is clicked -
  // which is Airbnb. Nothing about the fix to the gate above helps here;
  // this is the application being sent rather than parked.
  const sent = await send({ tabbed: true });
  assert.equal(sent.opened(), true, "the Application tab was never clicked");
  assert.equal(sent.outcome.status, OUTCOMES.CONFIRMED);
  assert.equal(sent.presses(), 1);
});

console.log(`${count} empty-form submit checks passed.`);
