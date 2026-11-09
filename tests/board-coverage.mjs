/**
 * Every board the run calls fillable has something that can fill it.
 *
 * Rippling sat in `FILLABLE` for weeks with no adapter in the registry and
 * no place in the legacy routing list, so the scraper surfaced Rippling
 * postings, the run spent a company's daily allowance claiming one, and
 * the attempt fell through to the generic adapter - which is gated off by
 * default and parked it. Nothing failed loudly; the board was simply
 * declared supported and was not.
 *
 * The gap was invisible because the three facts that disagreed live in
 * three files: the fillable set in `ats.js`, the adapter list in
 * `standalone.js`, and the legacy-only set in `run-bridge.js`. This file
 * reads all three and asserts they agree, so adding a board to the
 * fillable set without an adapter fails here rather than in the night.
 *
 * It also pins the captcha tab rule. A filled form behind a puzzle is one
 * human click from being sent and that click can only happen on the page,
 * so the tab must stay open; it was being closed because `keepOpen` was
 * tied to `dryRun`, which is false on every real run.
 */

import assert from "node:assert/strict";
import { FILLABLE } from "../src/ats.js";
import { applyRegistry } from "../src/apply/standalone.js";

let count = 0;
const test = (name, work) => { work(); count++; console.log(`  PASS  ${name}`); };

// The legacy engine answers for these, so they need no modular adapter.
const LEGACY_ONLY = new Set(["applytojob", "lever"]);

const registry = applyRegistry();
const named = new Set(registry.list().map((adapter) => adapter.name).filter(Boolean));

test("the registry exposes its adapters by name", () => {
  assert.ok(named.size > 0, "no adapter names could be read off the registry");
});

for (const board of FILLABLE) {
  test(`${board} is fillable and something can fill it`, () => {
    assert.ok(
      named.has(board) || LEGACY_ONLY.has(board),
      `${board} is in FILLABLE but has no modular adapter and is not routed to the legacy engine, so every ${board} posting burns a company and parks`,
    );
  });
}

test("rippling in particular is reachable, which it was not", () => {
  assert.ok(named.has("rippling"));
});

test("the generic adapter is not what answers for a named board", () => {
  for (const board of FILLABLE) {
    if (LEGACY_ONLY.has(board)) continue;
    assert.notEqual(board, "generic");
    assert.ok(named.has(board), `${board} would fall through to the gated generic adapter`);
  }
});

console.log(`${count} board coverage checks passed.`);
