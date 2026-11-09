/**
 * What an unverified requirement costs, and what it must still cost.
 *
 * On 8 Nov an unattended run found 13,333 job links and sent six. The
 * forms were fine and the supply was fine; 44 of the day's 71 holds read
 * "Not verified: Security clearance, On-site interviews" - two rules that
 * no ordinary software posting ever addresses, so research could only
 * ever return unknown for them and every posting was held. These checks
 * pin the line that replaced that behaviour: a gate the posting actually
 * raises still holds, a preference nobody published no longer does, and a
 * verified requirement the candidate fails is still a rejection.
 *
 * No browser: screening is pure given a posting, a profile and a stubbed
 * research reply.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateFilters, normalizeFilters, FILTER_DEFAULTS } from "../src/filters.js";
import { screenJob, screeningSignature } from "../src/screening.js";
import { roleAllowed } from "../src/roles.js";
import { withDefaults } from "../src/profile.js";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`  PASS  ${name}`); };

// The live profile on the night in question, rule for rule.
const live = withDefaults({ screeningEnabled: true, screeningWorkplace: "remote-hybrid", screeningClearance: "none", screeningInterview: "none" });
const ordinary = { id: "a", company: "Fixture Organization", title: "Senior Software Engineer", applyUrl: "https://job-boards.greenhouse.io/fixtureorg/jobs/123", jd: "Build and operate payment services in Go and TypeScript. You will own reliability for a team of six." };
const defense = { ...ordinary, id: "b", company: "Defense Fixture", title: "Software Engineer, Mission Systems", jd: "Support classified mission systems. An active TS/SCI security clearance is required for this role." };
const unverified = (keys) => Object.fromEntries(keys.map((key) => [key, { value: "unknown", verified: false, explanation: "Nothing quotable.", evidence: [] }]));

await test("the strictness is three named values and balanced is the default", () => {
  assert.equal(FILTER_DEFAULTS.screeningUnknown, "balanced");
  assert.equal(normalizeFilters({}).screeningUnknown, "balanced");
  for (const value of ["strict", "allow"]) assert.equal(normalizeFilters({ screeningUnknown: value }).screeningUnknown, value);
});

await test("the old 'review' value folds to balanced, because it was the default nobody chose", () => {
  // It was both the stored default and the strict setting, so an installed
  // profile carrying it says nothing about what the person wanted. Anyone
  // who does want the holds now says so with 'strict'.
  assert.equal(normalizeFilters({ screeningUnknown: "review" }).screeningUnknown, "balanced");
  assert.equal(withDefaults({ screeningUnknown: "review" }).screeningUnknown, "balanced");
});

await test("the night's own hold no longer costs an attempt", () => {
  const before = evaluateFilters(unverified(["workplace", "clearance", "interview"]), { ...live, screeningUnknown: "strict" }, ordinary);
  assert.equal(before.decision, "review");
  assert.equal(before.reason, "Not verified: Work arrangement, Security clearance, On-site interviews.");
  const now = evaluateFilters(unverified(["workplace", "clearance", "interview"]), live, ordinary);
  assert.equal(now.decision, "eligible");
  assert.deepEqual(now.holds, []);
  assert.deepEqual(now.unknown, ["Work arrangement", "Security clearance", "On-site interviews"]);
  assert.match(now.reason, /Unverified, and not a disqualifier/);
});

await test("a clearance the posting itself raises is still held for a person", () => {
  const held = evaluateFilters(unverified(["clearance"]), live, defense);
  assert.equal(held.decision, "review");
  assert.deepEqual(held.holds, ["Security clearance"]);
});

await test("a verified requirement the candidate cannot meet is still a rejection", () => {
  const found = { clearance: { value: "active", verified: true, explanation: "Quoted from the posting.", evidence: [{ url: defense.applyUrl, quote: "An active TS/SCI security clearance is required for this role." }] } };
  for (const strictness of ["strict", "balanced", "allow"]) {
    const result = evaluateFilters(found, { ...live, screeningUnknown: strictness }, defense);
    assert.equal(result.decision, "rejected", strictness);
    assert.deepEqual(result.conflicts, ["Security clearance"]);
  }
});

await test("a soft requirement is a preference even when the posting raises it", () => {
  // An on-site final round is something to decline in two weeks. It is not
  // a reason to skip the application today.
  const onsite = { ...ordinary, jd: ordinary.jd + " Expect an on-site interview loop at our Austin office, and occasional travel." };
  const result = evaluateFilters(unverified(["interview", "workplace", "travel"]), { ...live, screeningTravel: "none" }, onsite);
  assert.equal(result.decision, "eligible");
  assert.deepEqual(result.holds, []);
});

await test("sponsorship and location are gates; employment type is not", () => {
  const profile = { ...live, screeningSponsorship: "available", screeningLocation: "profile", screeningEmployment: "full-time" };
  const asked = { ...ordinary, jd: ordinary.jd + " We do not sponsor visas, and you must reside in a state where we are registered." };
  const held = evaluateFilters(unverified(["sponsorship", "location", "employment"]), profile, asked);
  assert.equal(held.decision, "review");
  assert.deepEqual(held.holds, ["Location eligibility", "Visa sponsorship"]);
  assert.ok(held.unknown.includes("Employment type"), "the employment unknown is recorded but does not hold");
  assert.equal(evaluateFilters(unverified(["sponsorship", "location", "employment"]), profile, ordinary).decision, "eligible");
});

await test("a rule the person typed themselves is a gate with or without a matching posting", () => {
  const profile = { ...live, screeningOtherRules: "No staffing agencies" };
  assert.equal(evaluateFilters(unverified(["other"]), profile, ordinary).decision, "review");
  assert.equal(evaluateFilters(unverified(["other"]), { ...profile, screeningUnknown: "allow" }, ordinary).decision, "eligible");
});

await test("without a posting to read, a gate is assumed raised", () => {
  // evaluateFilters is reachable before extraction in recovery paths, and
  // "no text" is not evidence that nothing was asked for.
  assert.equal(evaluateFilters(unverified(["clearance"]), live).decision, "review");
});

await test("strict still holds everything and allow still holds nothing", () => {
  assert.equal(evaluateFilters(unverified(["interview"]), { ...live, screeningUnknown: "strict" }, ordinary).decision, "review");
  assert.equal(evaluateFilters(unverified(["clearance"]), { ...live, screeningUnknown: "allow" }, defense).decision, "eligible");
});

await test("research that cannot be reached applies the posting instead of parking it", async () => {
  const unreachable = { ask: async () => { throw new Error("Browser reply unavailable"); } };
  const applied = await screenJob(ordinary, live, unreachable);
  assert.equal(applied.decision, "eligible");
  assert.equal(applied.mode, "research-unavailable");
  const parked = await screenJob(ordinary, { ...live, screeningUnknown: "strict" }, unreachable);
  assert.equal(parked.decision, "review");
  // A cleared posting is the case where losing the research does matter.
  assert.equal((await screenJob(defense, live, unreachable)).decision, "review");
});

await test("an account failure still stops the run rather than approving unknowns", async () => {
  await assert.rejects(() => screenJob(ordinary, live, { ask: async () => { throw Object.assign(new Error("Usage cap"), { status: 429 }); } }), /Usage cap/);
});

await test("changing the strictness re-screens everything already held", async () => {
  assert.notEqual(await screeningSignature(ordinary, live), await screeningSignature(ordinary, { ...live, screeningUnknown: "strict" }));
});

await test("relevance is untouched: the sales titles stay out", () => {
  // The holds were the throughput problem; drifting into "Enterprise
  // Account Executive" was a different one, and loosening the first must
  // not reopen the second.
  const roles = withDefaults({ ...live, roleFilterEnabled: true, roleFilterTitles: "software engineer\nmachine learning" });
  assert.equal(roleAllowed("Enterprise Account Executive", roles), false);
  assert.equal(roleAllowed("Senior Software Engineer", roles), true);
});

await test("the strictness is offered in the settings form the save button reads", async () => {
  const markup = await readFile(new URL("../src/ui/jobs.js", import.meta.url), "utf8");
  const form = markup.slice(markup.indexOf('id="settings-form"'), markup.indexOf("save-settings','Save filters'"));
  assert.ok(form.includes("'screeningUnknown'"), "the select lives inside #settings-form");
  for (const value of ["balanced", "strict", "allow"]) assert.ok(form.includes(`['${value}',`), value);
});

console.log(`${count} screening strictness checks passed.`);
