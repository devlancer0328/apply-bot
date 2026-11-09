/**
 * The places after Submit where an application stopped and waited for a
 * person, and what each one does instead.
 *
 * Greenhouse holds an application until the applicant proves the address:
 * a row of one-character boxes and an eight-digit code in the mailbox. The
 * engine has read that mailbox for a while, and the reading works. What
 * did not work was *when* it was asked.
 *
 * Three real submissions ran into it on the same afternoon. DigiCert and
 * Flowcode were refused once over a field the board's own location service
 * had failed to fill, were refilled and resubmitted - and the code boxes
 * that came back from that second Submit were nobody's job, because the
 * code handler only ever ran on the first outcome that was read. Both were
 * recorded as "the board wants an emailed security code" and parked, with
 * the code sitting unread in a mailbox the bot can open. MCG got one round
 * further and hit the other half of it: a board that refuses a resubmit
 * issues a *fresh* code, and the second request had nowhere to go either.
 *
 * At three hundred applications a day each of those is a finished
 * application thrown away for want of eight digits, so both are asserted
 * here against the real engine with a fake board in front of it.
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
});

/**
 * A board that answers a scripted list of outcomes, one per Submit, and
 * records every code it was given. `script` is read in order; the last
 * entry stands for every press after it.
 */
function board(script) {
  const codes = [];
  let presses = 0;
  const adapter = {
    name: "fixture",
    capabilities: { multiPage: false, upload: false, verifyAccepted: true, submit: true, receipt: true, account: false },
    detect: async () => CONFIDENCE.EXACT,
    inspect: async () => ({ frameId: 0, fields: [{ key: "f1", tag: "input", type: "text", label: "First Name", required: true, options: [] }] }),
    fill: async ({ fills }) => ({ applied: fills.map((fill) => fill.key), failed: [], values: {} }),
    verify: async () => ({ empty: [] }),
    uploadsSettled: async () => ({ settled: true }),
    menuOptions: async () => [],
    submit: async () => (presses += 1, { clicked: true }),
    enterCode: async ({ code }) => (codes.push(code), { entered: true }),
    readOutcome: async () => script[Math.min(presses, script.length) - 1],
  };
  const browser = {
    openTab: async () => 1,
    capture: async () => ({ url: "https://fixture.test/apply", title: "Fixture", capturedAt: Date.now() }),
    closeTab: async () => {},
    inFrame: async () => [],
  };
  return { adapter, browser, codes, presses: () => presses };
}

const CODE_WANTED = { status: OUTCOMES.CHALLENGE, challenge: { kind: "email-code", email: "someone@example.test" }, reason: "the board wants an emailed security code" };
const REFUSED = { status: OUTCOMES.REJECTED, complaints: "Location (City)*; Our location service is temporarily unavailable." };
const ACCEPTED = { status: OUTCOMES.CONFIRMED, receipt: "Thank you for applying." };

async function send(script, { verification } = {}) {
  const fixture = board(script);
  const request = {
    id: "https://fixture.test/apply", company: "Fixture Co", title: "Senior Engineer",
    applyUrl: "https://fixture.test/apply", jd: "A fixture posting. Never sent anywhere.",
    profile: PROFILE, documents: {}, policy: { review: false },
  };
  request.answerContext = answerContext(request, PROFILE);
  const mailbox = [];
  const outcome = await applyTo({
    request,
    registry: createAdapterRegistry([fixture.adapter]),
    browser: fixture.browser,
    services: {
      answers: async () => ({ answers: [], unanswered: [], forced: [] }),
      claimCompany: async () => ({ claimed: true }),
      verification: verification ?? (async () => (mailbox.push(Date.now()), { code: `code-${mailbox.length}` })),
    },
  });
  return { outcome, ...fixture, asked: mailbox.length };
}

await test("A code asked for after a refusal and a resubmit is fetched, not parked for a person", async () => {
  // Submit refused, refilled, resubmitted, and *then* the code boxes - the
  // exact shape DigiCert and Flowcode stopped on.
  const sent = await send([REFUSED, CODE_WANTED, ACCEPTED]);
  assert.equal(sent.outcome.status, OUTCOMES.CONFIRMED);
  assert.equal(sent.outcome.receipt, "Thank you for applying.");
  assert.deepEqual(sent.codes, ["code-1"]);
});

await test("A board that issues a fresh code after a resubmit gets the fresh code too", async () => {
  // MCG: code accepted, resubmit refused, a second code mailed.
  const sent = await send([CODE_WANTED, CODE_WANTED, ACCEPTED]);
  assert.equal(sent.outcome.status, OUTCOMES.CONFIRMED);
  assert.deepEqual(sent.codes, ["code-1", "code-2"], "the second code request went unanswered");
});

await test("A board still asking on the third round fails fast rather than holding the queue", async () => {
  const sent = await send([CODE_WANTED]);
  assert.equal(sent.outcome.status, OUTCOMES.CHALLENGE);
  assert.equal(sent.asked, 2, "a code loop was followed further than twice");
  assert.equal(sent.outcome.submitted, true);
});

await test("A mailbox that never answers parks this one posting and leaves the next one free to start", async () => {
  const sent = await send([CODE_WANTED, ACCEPTED], { verification: async () => { throw new Error("no security code mail for Fixture Co arrived within 240 seconds"); } });
  assert.equal(sent.outcome.status, OUTCOMES.CHALLENGE);
  assert.match(sent.outcome.reason, /no security code arrived: no security code mail/);
  // One press, and nothing retried behind it: the attempt is over and the
  // queue moves on rather than sitting on a mailbox that is not going to
  // answer. The company stays protected, because Submit was pressed.
  assert.equal(sent.presses(), 1);
  assert.equal(sent.outcome.submitted, true);
});

console.log(`${count} post-submit stall checks passed.`);
