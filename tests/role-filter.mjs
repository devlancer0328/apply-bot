/**
 * The applicant's own list of roles, and the ChatGPT tabs nobody is using.
 *
 * Both exist because of the same night. A software engineer was applied to
 * as an "Enterprise Account Executive" because relevance was inferred from
 * history and one incidental word was enough, which is the argument for
 * letting the applicant simply say what they want. And the run finished
 * holding eight pinned ChatGPT renderers on a machine whose disk pressure
 * had already killed the browser once, which is the argument for closing
 * the ones that have gone quiet.
 *
 * No browser here: the role filter is pure, and the reaper is exercised
 * against a `chrome.tabs` stand-in that records what it was asked to close.
 */

import assert from "node:assert/strict";
import { roleAllowed, roleFilterActive, roleTerms } from "../src/roles.js";
import { localFilter } from "../src/filters.js";
import { withDefaults } from "../src/profile.js";

let count = 0;
const test = (name, work) => { work(); count++; console.log(`  PASS  ${name}`); };

const WANTED = "software engineer\nfull stack\nmachine learning";
const on = withDefaults({ roleFilterEnabled: true, roleFilterTitles: WANTED });
const off = withDefaults({ roleFilterEnabled: false, roleFilterTitles: WANTED });

test("the phrases are read one per line or comma separated, blanks dropped", () => {
  assert.deepEqual(roleTerms("software engineer\n\nfull stack,  machine learning ;"), ["software engineer", "full stack", "machine learning"]);
});

test("a title holding one of the phrases is allowed whatever its seniority or team", () => {
  for (const title of ["Senior Machine Learning Engineer, Ranking", "Staff Software Engineer (Payments)", "Full Stack Developer", "SOFTWARE ENGINEER III"]) {
    assert.equal(roleAllowed(title, on), true, title);
  }
});

test("a title holding none of them is refused, which is the whole point", () => {
  for (const title of ["Enterprise Account Executive", "Director, Partnerships & Enterprise International Growth", "Accounts Payable Specialist", "Product Designer"]) {
    assert.equal(roleAllowed(title, on), false, title);
  }
});

test("switched off, the filter has no opinion at all", () => {
  assert.equal(roleFilterActive(off), false);
  for (const title of ["Enterprise Account Executive", "Senior Software Engineer"]) assert.equal(roleAllowed(title, off), true);
});

test("switched on with nothing in the list is off, not 'reject everything'", () => {
  // A filter that silently rejects every posting is indistinguishable from
  // a dead feed, and the applicant would be hunting the wrong fault.
  const empty = withDefaults({ roleFilterEnabled: true, roleFilterTitles: "   " });
  assert.equal(roleFilterActive(empty), false);
  assert.equal(roleAllowed("Enterprise Account Executive", empty), true);
});

test("the role filter stands alone and does not need the research suite turned on", () => {
  assert.equal(on.screeningEnabled, false, "the research filters stay off");
  const refused = localFilter({ title: "Enterprise Account Executive", company: "Acme" }, on);
  assert.equal(refused?.decision, "rejected");
  assert.equal(refused?.mode, "role-filter");
  assert.match(refused.reason, /not one of your roles/i);
  assert.equal(localFilter({ title: "Senior Software Engineer", company: "Acme" }, on), null);
});

test("with the filter off and no research rules, nothing is refused locally", () => {
  assert.equal(localFilter({ title: "Enterprise Account Executive", company: "Acme" }, off), null);
});

test("the setting survives a round trip through the profile and is a real boolean", () => {
  const stored = withDefaults({ roleFilterEnabled: "yes", roleFilterTitles: 42 });
  assert.equal(stored.roleFilterEnabled, false, "a non-boolean must not switch the filter on");
  assert.equal(typeof stored.roleFilterTitles, "string");
});

/* ------------------------------------------------- idle ChatGPT tabs */

const { reapIdleChatGptTabs } = await (async () => {
  const removed = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: "https://chatgpt.com/c/abc" }),
      remove: async (id) => { removed.push(id); },
      create: async () => ({ id: 1 }),
      update: async () => {},
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    runtime: { getURL: () => "" },
  };
  const module = await import("../src/chatgpt.js");
  return { ...module, removed };
})();

test("the reaper closes nothing when no worker tab has been opened", async () => {
  // The worker tab table is private to chatgpt.js and only a real request
  // fills it, so what is provable here is the safe half: asked to tidy up
  // a run that has opened nothing, it closes nothing and says so. That the
  // right tab is chosen is decided by the slot-and-age test in the module
  // and is only observable against a live browser.
  const closed = await reapIdleChatGptTabs({ idleMs: 60000 });
  assert.ok(Array.isArray(closed), "the reaper reports which tabs it closed");
  assert.equal(closed.length, 0);
});

console.log(`${count} role filter and tab checks passed.`);
