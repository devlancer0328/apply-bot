/**
 * The bug: a paragraph box answered "Yes", on an application that was sent.
 *
 * DataCamp's Greenhouse form asks "Paste your full resume text below for
 * faster review by our AI assistant. (Formatting is not important, the
 * content is)". It is a free-text box, it is required, and the filed
 * application carries the word "Yes" in it. Nothing refused that: the box
 * had no options, so it was offered to the answering service as an open
 * question; the service answered a yes/no; and the engine typed what it
 * was given. A recruiter reading it learns only that nobody was home, and
 * an application cannot be taken back.
 *
 * Three separate things had to be true for it to happen, so there are
 * three guards here and each is tested on its own:
 *
 *   1. The control is classified before the question is asked, from the
 *      tag *and* the phrasing - a board that renders a paragraph question
 *      as a long one-line input is the case the tag alone misses.
 *   2. A question that asks for the résumé is answered from the résumé,
 *      which is already in hand, and never reaches a model at all.
 *   3. Whatever the answering service returns is checked against the
 *      control it is headed for before anything is typed, because the
 *      model is not the only thing that can produce "Yes" - a stub, a
 *      cached reply and the rescue pass can all do it.
 *
 * The engine test at the bottom is the one that proves the property the
 * bug violated: a textarea cannot receive "Yes" from any source.
 */

import assert from "node:assert/strict";
import { answerFitsControl, profileLink, resolveForm, wantsProse } from "../src/answers.js";
import { answerAll } from "../src/ai.js";
import { setModelTransport } from "../src/vendor/generation.js";
import { applyTo } from "../src/apply/engine.js";
import { createAdapterRegistry, CONFIDENCE } from "../src/apply/contract.js";
import { answerContext } from "../src/apply/answer-context.js";
import { withDefaults } from "../src/profile.js";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log("PASS " + name); };

const PROFILE = withDefaults({
  firstName: "Daniel", lastName: "Torres", email: "someone@example.test", phone: "+1 (929) 489-1252",
  city: "Temple", state: "TX", country: "United States", linkedin: "https://linkedin.com/danieltorres8483",
  workAuthorization: "us-citizen", requiresSponsorship: "no", nonCompete: "no",
});
const RESUME = "Daniel Torres\nTemple, TX\n\nSenior AI Engineer at Querium (2019-Present)\nBuilt production LLM systems in Python.";
const CONTEXT = { company: "Fixture Co", title: "Senior Engineer", resume: RESUME, compensation: null };

const PASTE = "Paste your full resume text below for faster review by our AI assistant. (Formatting is not important, the content is)";

/* --------------------------------------------- 1. classifying the control */

await test("A paragraph box is recognised by its tag, and by its phrasing when the board renders one as an input", () => {
  assert.equal(wantsProse({ tag: "textarea", type: "textarea", label: "Anything else?" }), true);
  assert.equal(wantsProse({ tag: "input", type: "text", label: PASTE }), true);
  assert.equal(wantsProse({ tag: "input", type: "text", label: "Why do you want to work here?" }), true);
  assert.equal(wantsProse({ tag: "input", type: "text", label: "Tell us about a project you are proud of" }), true);
  // A fact is a fact however long the box is, and a menu is never prose
  // however it is worded - "describe your level of experience" over a list
  // of bands is a list.
  assert.equal(wantsProse({ tag: "input", type: "text", label: "LinkedIn Profile" }), false);
  assert.equal(wantsProse({ tag: "select", type: "select-one", label: "Describe your level of experience", options: [{ label: "0-2" }, { label: "3-5" }] }), false);
});

await test("A prose box cannot hold a yes, and a yes/no control is untouched by the rule", () => {
  for (const value of ["Yes", "no", "YES.", "N/A", "true", "None"]) {
    assert.equal(answerFitsControl({ tag: "textarea", label: "Why Substack?" }, value), false, `"${value}" was allowed into a textarea`);
    assert.equal(answerFitsControl({ tag: "input", type: "text", label: PASTE }, value), false, `"${value}" was allowed into a résumé box`);
  }
  assert.equal(answerFitsControl({ tag: "textarea", label: "Why Substack?" }, "I have been reading it since 2019, and the publishing problem it is solving is the one I want to work on."), true);
  assert.equal(answerFitsControl({ tag: "select", label: "Are you over 18?", options: [{ label: "Yes" }, { label: "No" }] }, "Yes"), true);
  assert.equal(answerFitsControl({ tag: "input", type: "text", label: "Current title" }, "Senior AI Engineer"), true);
});

await test("An open question carries the shape of its control to the model, read from tag and phrasing alike", () => {
  const asked = resolveForm([{ key: "f1", tag: "input", type: "text", label: "Why do you want to join Fixture Co?", required: true, options: [] }], PROFILE, CONTEXT).questions;
  assert.equal(asked.length, 1);
  assert.equal(asked[0].multiline, true);
});

/* ------------------------------------------- 2. the résumé answers itself */

await test("A box asking for the résumé is filled from the résumé and never becomes an open question", () => {
  for (const label of [PASTE, "Please copy and paste your CV below", "Resume text"]) {
    const plan = resolveForm([{ key: "f1", tag: "textarea", type: "textarea", label, required: true, options: [] }], PROFILE, CONTEXT);
    assert.deepEqual(plan.questions, [], `"${label}" was sent to the model instead of being answered from the résumé`);
    assert.equal(plan.blocked.length, 0);
    assert.equal(plan.fills[0].value, RESUME);
    assert.equal(plan.fills[0].rule, "resume-text");
  }
  // The upload beside it is still an upload, not a place to type the résumé.
  const upload = resolveForm([{ key: "f1", type: "file", label: "Resume/CV", required: true, options: [] }], PROFILE, CONTEXT);
  assert.deepEqual(upload.attachments, [{ key: "f1", document: "resume" }]);
});

/* ------------------------------------- 3. the model's reply, before typing */

await test("A model that answers a paragraph box with a yes is treated as having not answered", async () => {
  const question = { key: "q1", question: PASTE, required: true, must: true, options: [], multiline: true };
  for (const reply of ["Yes", "No", "N/A"]) {
    setModelTransport(async () => ({ text: JSON.stringify({ 1: reply }) }));
    const result = await answerAll([question], CONTEXT, {});
    assert.equal(result.answers.length, 0, `the model's "${reply}" was accepted for a paragraph box`);
    assert.equal(result.unanswered[0].required, true);
  }
  setModelTransport(async () => ({ text: JSON.stringify({ 1: "I have spent nine years building production machine-learning systems in Python." }) }));
  assert.equal((await answerAll([question], CONTEXT, {})).answers.length, 1);
});

/* ------------------------------------------------- the property, end to end */

/**
 * The smallest thing the engine will drive: one page, one field, and a
 * record of everything that was typed into it. No network, no browser, no
 * employer - the point is only that the engine refuses to put the value on
 * the page, whoever supplied it.
 */
function fixture(field) {
  const typed = [];
  const adapter = {
    name: "fixture",
    capabilities: { multiPage: false, upload: false, verifyAccepted: true, submit: true, receipt: true, account: false },
    detect: async () => CONFIDENCE.EXACT,
    inspect: async () => ({ frameId: 0, fields: [field] }),
    fill: async ({ fills }) => (typed.push(...fills), { applied: fills.map((fill) => fill.key), failed: [], values: {} }),
    verify: async () => ({ empty: [] }),
    menuOptions: async () => [],
  };
  const browser = {
    openTab: async () => 1,
    capture: async () => ({ url: "https://fixture.test/apply", title: "Fixture", capturedAt: Date.now() }),
    closeTab: async () => {},
  };
  return { typed, adapter, browser };
}

async function drive(field, answer) {
  const { typed, adapter, browser } = fixture(field);
  const request = {
    id: "https://fixture.test/apply", company: "Fixture Co", title: "Senior Engineer",
    applyUrl: "https://fixture.test/apply", jd: "A fixture posting. Never sent anywhere.",
    profile: PROFILE, documents: {}, resumeText: RESUME, policy: { review: true },
  };
  request.answerContext = answerContext(request, PROFILE);
  const outcome = await applyTo({
    request,
    registry: createAdapterRegistry([adapter]),
    browser,
    services: { answers: async (questions) => ({ answers: questions.map((question) => ({ key: question.key, value: answer })), unanswered: [], forced: [] }) },
  });
  return { outcome, typed };
}

await test("A textarea cannot receive a yes from the answering service, however the service was built", async () => {
  const required = await drive({ key: "f1", tag: "textarea", type: "textarea", label: "Why Fixture Co?", required: true, options: [] }, "Yes");
  assert.deepEqual(required.typed, [], "the engine typed a yes into a paragraph box");
  assert.equal(required.outcome.status, "challenge");
  // The refusal names the answer it threw away rather than blaming the
  // profile. A required prose box answered "Yes" is the answerer being
  // wrong, not a fact nobody supplied, and the two send whoever reads the
  // overnight log to opposite places.
  assert.match(required.outcome.reason, /required answer\(s\) the control could not honestly hold: "Why Fixture Co\?" was answered "Yes"/);
  assert.equal(required.outcome.submitted, false);

  // Optional, and so not worth stopping an application over: the value is
  // dropped, the box stays empty and the form is finished.
  const optional = await drive({ key: "f1", tag: "textarea", type: "textarea", label: "Anything else you would like to tell us?", required: false, options: [] }, "Yes");
  assert.deepEqual(optional.typed, []);
  assert.match(optional.outcome.reason, /filled and verified/);

  // The same box with a real answer in it is filled, which is the control
  // on all of the above: this refuses a shape of answer, not the field.
  const prose = await drive({ key: "f1", tag: "textarea", type: "textarea", label: "Why Fixture Co?", required: true, options: [] }, "Because the evaluation work is the part of this job I want to keep doing.");
  assert.equal(prose.typed.length, 1);
  assert.match(prose.outcome.reason, /filled and verified/);
});

/* ------------------------------------- the facts that stopped the corpus */

await test("A LinkedIn address written the way people remember it is normalised to where the profile actually lives", () => {
  assert.equal(profileLink("https://linkedin.com/danieltorres8483", "www.linkedin.com"), "https://www.linkedin.com/in/danieltorres8483");
  assert.equal(profileLink("linkedin.com/in/danieltorres8483", "www.linkedin.com"), "https://www.linkedin.com/in/danieltorres8483");
  assert.equal(profileLink("danieltorres8483", "www.linkedin.com"), "https://www.linkedin.com/in/danieltorres8483");
  assert.equal(profileLink("https://www.linkedin.com/company/fixture", "www.linkedin.com"), "https://www.linkedin.com/company/fixture");
  assert.equal(profileLink("", "www.linkedin.com"), "");
});

await test("The LinkedIn questions a form actually asks are both answered from the one stored fact", () => {
  const fields = [
    { key: "f1", tag: "select", type: "select-one", label: "Do you have a LinkedIn profile?", required: true, options: [{ label: "Yes", value: "1" }, { label: "No", value: "0" }] },
    { key: "f2", tag: "input", type: "text", label: "Please provide a link to your LinkedIn profile.", required: true, options: [] },
  ];
  const plan = resolveForm(fields, PROFILE, CONTEXT);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.fills.find((fill) => fill.key === "f1").candidates[0], "Yes");
  assert.equal(plan.fills.find((fill) => fill.key === "f2").value, "https://www.linkedin.com/in/danieltorres8483");
  // Still refused, and rightly, when there is nothing stored to answer with.
  const empty = resolveForm(fields, { ...PROFILE, linkedin: "" }, CONTEXT);
  assert.equal(empty.blocked.length, 1);
});

/**
 * "Did you hear about this opportunity from a current DailyPay employee?"
 *
 * That question stopped a live application. It is deliberately excluded
 * from the how-heard rule - it is a yes or no about a person, not a menu
 * of channels - and what it fell through to was the model, which has no
 * saved fact about DailyPay's staff and declined. The fact exists, though,
 * and this system is the only thing that holds it: the posting came off a
 * job feed and nobody referred it. The two halves asserted together are
 * that the provenance question is answered and the channel question is
 * still the channel rule's, because a "No" sent to a menu of job boards
 * matches nothing and parks the application just as surely.
 */
await test("Whether an employee referred this application is answered from where the posting came from", () => {
  const yesNo = [{ label: "Yes" }, { label: "No" }];
  const ask = (label, options) => resolveForm([{ key: "f1", tag: "select", type: "select-one", label, required: true, options }], PROFILE, CONTEXT);

  for (const label of ["Did you hear about this opportunity from a current DailyPay employee?", "Were you referred by a Fixture Co employee?", "Employee referral?"]) {
    const plan = ask(label, yesNo);
    assert.equal(plan.fills[0]?.rule, "employee-referral", `"${label}" was not read as a question about a referral`);
    assert.equal(plan.fills[0]?.value, "No");
  }

  const channel = ask("How did you hear about this role?", [{ label: "Job Board" }, { label: "Company website" }]);
  assert.equal(channel.fills[0]?.rule, "how-heard", "a menu of channels was answered No");
  // A referral question asked as prose is a different question - "how were
  // you referred" over a text box wants the channel - so the rule holds off
  // until the control itself is offering the two words.
  const written = resolveForm([{ key: "f1", tag: "input", type: "text", label: "How were you referred to this position?", required: true, options: [] }], PROFILE, CONTEXT);
  assert.notEqual(written.fills[0]?.rule, "employee-referral");
});

await test("A box labelled only Address takes the town; a street line does not", () => {
  // The label is as the page inventory reports it, with the required
  // marker already taken off (see `unstarred` in fill.js).
  const address = resolveForm([{ key: "f1", tag: "input", type: "text", label: "Address", required: true, options: [] }], PROFILE, CONTEXT);
  assert.equal(address.fills[0].rule, "street");
  assert.equal(address.fills[0].value, "Temple, Texas");
  const street = resolveForm([{ key: "f1", tag: "input", type: "text", label: "Address Line 1", required: true, options: [] }], PROFILE, CONTEXT);
  assert.equal(street.fills.length, 0);
  assert.equal(street.blocked.length, 1);
  // And the stored street wins wherever there is one.
  assert.equal(resolveForm([{ key: "f1", tag: "input", type: "text", label: "Address", required: true, options: [] }], { ...PROFILE, street: "12 Example Road" }, CONTEXT).fills[0].value, "12 Example Road");
});

await test("An employer with a street in its name does not turn its own questions into address boxes", () => {
  // Clear Street's sponsorship question parked a live application on this:
  // the address rule sits above the sponsorship rule, the company name put
  // the word "street" in the label, and a question the profile answers was
  // refused as one it had nothing for.
  const label = "Will you now or in the future require Clear Street to sponsor an employment visa on your behalf to commence or continue employment?";
  const plan = resolveForm([{ key: "f1", tag: "select", type: "select-one", label, required: true, options: [{ label: "Yes" }, { label: "No" }] }], PROFILE, CONTEXT);
  assert.equal(plan.fills[0]?.rule, "sponsorship", `the question went to the ${plan.fills[0]?.rule ?? "blocked"} rule`);
  assert.equal(plan.fills[0]?.candidates?.includes("No"), true);
  // The boxes that really are address lines are untouched, and still
  // refused while no street is stored.
  for (const line of ["Address Line 1", "Street Address", "Address Line 1 (include apartment or unit number)"]) {
    const address = resolveForm([{ key: "f1", tag: "input", type: "text", label: line, required: true, options: [] }], PROFILE, CONTEXT);
    assert.equal(address.blocked[0]?.rule, "street", `"${line}" stopped being read as an address line`);
  }
});

/**
 * The judgement questions are answered from storage and from nowhere else.
 *
 * Every one of them stops an application when the profile is blank, and
 * the cheap-looking fix - a default in `DEFAULT_PROFILE` - is the wrong
 * one: "no" to a non-compete is a legal statement nobody made, and the
 * applicants it is wrong about are the ones it harms. So the property
 * asserted here is both halves at once. A stored answer is used. A blank
 * one is still refused, and the posting is skipped rather than guessed at.
 */
await test("The judgement questions are answered from a stored fact, and refused without one", () => {
  const fresh = withDefaults({});
  for (const key of ["workAuthorization", "requiresSponsorship", "nonCompete", "willingToRelocate", "willingToTravel", "over18", "backgroundCheck", "startDate"]) {
    assert.equal(fresh[key], "", `${key} was given a default it cannot honestly have`);
  }
  const nonCompete = [{ key: "f1", tag: "select", type: "select-one", label: "Are you subject to a non-compete agreement?", required: true, options: [{ label: "Yes" }, { label: "No" }] }];
  assert.equal(resolveForm(nonCompete, PROFILE, CONTEXT).fills[0].candidates[0], "No");
  assert.equal(resolveForm(nonCompete, fresh, CONTEXT).blocked.length, 1);
});

/* ---------------------------- the policy paragraph above the question */

/**
 * Four labels off DigiCert's live Greenhouse form, each a paragraph of
 * policy with the actual question on its last line. All four were answered
 * from the paragraph in a review run, and the application was one Submit
 * away from carrying them.
 */
await test("A question under a paragraph of policy is answered from the question, not the paragraph", () => {
  const yesNo = [{ label: "Yes" }, { label: "No" }];
  const fields = [
    { key: "f1", tag: "select", type: "select-one", required: true, options: yesNo, label: "This position is not eligible for employment-based visa sponsorship. Applicants must possess unrestricted authorization to work in the United States permanently and independently without the need for current or future sponsorship. Will you now or in the future require any form of work-based sponsorship?" },
    { key: "f2", tag: "select", type: "select-one", required: true, options: yesNo, label: "As part of the employment process, all candidates are subject to employment and education verification, as well as a comprehensive background check, in accordance with applicable laws and company policies. I understand that I will be provided with additional information and asked to provide authorization before any such checks are conducted." },
    { key: "f3", tag: "select", type: "select-one", required: true, options: yesNo, label: "By providing your phone number and checking this box, you consent to receive text messages from DigiCert and its representatives regarding your job application. Consent is not a condition of employment. May we contact you via text message?" },
    { key: "f4", tag: "input", type: "text", required: false, options: [], label: "If you were referred for this position, please provide the full name of the referrer" },
  ];
  const plan = resolveForm(fields, { ...PROFILE, backgroundCheck: "yes" }, CONTEXT);
  const answer = (key) => plan.fills.find((fill) => fill.key === key);
  assert.equal(answer("f1").candidates[0], "No", "the sponsorship question was answered from its preamble");
  assert.equal(answer("f2").candidates[0], "Yes", "a background-check consent was answered with a work-authorization status");
  assert.equal(answer("f3").candidates[0], "Yes", "a text-message consent was answered with the phone number");
  assert.equal(answer("f4"), undefined, "the applicant was named as their own referrer");
  // The short forms of the same questions are untouched by any of it.
  const short = resolveForm([
    { key: "s1", tag: "select", type: "select-one", required: true, options: yesNo, label: "Will you now or in the future require visa sponsorship?" },
    { key: "s2", tag: "input", type: "text", required: true, options: [], label: "Full Name" },
    { key: "s3", tag: "select", type: "select-one", required: true, options: yesNo, label: "Are you legally authorized to work in the country in which this role is located?" },
  ], PROFILE, CONTEXT);
  assert.equal(short.fills.find((fill) => fill.key === "s1").candidates[0], "No");
  assert.equal(short.fills.find((fill) => fill.key === "s2").value, "Daniel Torres");
  assert.equal(short.fills.find((fill) => fill.key === "s3").candidates[0], "Yes");
});

console.log(`${count} prose-classification and stored-fact checks passed.`);
