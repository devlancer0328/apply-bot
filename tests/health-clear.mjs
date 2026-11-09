/**
 * Pressing Run must be able to lift a stop condition.
 *
 * A stop condition ends the day on purpose: ChatGPT signed out, the
 * mailbox gone, the disk full. Nothing in the extension can fix those, so
 * the single escape hatch is the applicant dealing with it and pressing
 * Run, which calls health.forget().
 *
 * That hatch was welded shut. forget() clears the record in memory, the
 * cleared snapshot goes into a five-second write buffer, and the first
 * thing a run does is read the record back from storage - so the run
 * reloaded the very condition it had just been told to drop, stopped
 * again before opening a tab, and the autopilot then refused to start
 * anything for the rest of the day. Observed live: ChatGPT was signed in
 * and answering, and the bot sat halted for twenty minutes repeating that
 * it was signed out, through four attempts to restart it by hand.
 *
 * What is held here is the ordering, not the wording: whatever a clear
 * writes has to reach storage before the next run reads it.
 */

import assert from "node:assert/strict";
import { createHealth } from "../src/health.js";
import { snapshotWriter } from "../src/run-snapshot.js";

let count = 0;
const test = (name, work) => work().then(() => { count++; console.log(`  PASS  ${name}`); });

/** The persisted health record, and the buffered writer in front of it. */
function store() {
  let saved = null;
  const writer = snapshotWriter((value) => { saved = structuredClone(value); }, { delay: 5000 });
  return { writer, read: () => saved };
}

/** Signs the writer out hard enough that health calls a stop. */
function signedOut(health) {
  for (let attempt = 0; attempt < 6; attempt++) {
    health.service("writer", { ok: false, status: 401, message: "ChatGPT is not signed in." });
  }
  return health;
}

await test("a signed-out writer is a stop, which is the condition under test", async () => {
  const health = signedOut(createHealth());
  assert.ok(health.stop(), "six 401s from the resume writer should stop the day");
  assert.equal(health.stop().code, "health");
});

await test("forgetting clears the live record", async () => {
  const health = signedOut(createHealth());
  health.forget();
  assert.equal(health.stop(), null);
});

await test("a clear that is only buffered is undone by the next run's reload", async () => {
  // The exact shape of the live failure, kept so the fix cannot be undone
  // by someone removing the flush and seeing every other test still pass.
  const { writer, read } = store();
  const health = signedOut(createHealth());
  writer.schedule(health.snapshot());
  await writer.flush();

  health.forget();
  writer.schedule(health.snapshot()); // buffered, not yet written

  const reloaded = createHealth().restore(read());
  assert.ok(reloaded.stop(), "without a flush, storage still holds the stop condition");
});

await test("flushing the clear before the run reads it lets the day restart", async () => {
  const { writer, read } = store();
  const health = signedOut(createHealth());
  writer.schedule(health.snapshot());
  await writer.flush();

  health.forget();
  writer.schedule(health.snapshot());
  await writer.flush(); // what pressing Run now does

  const reloaded = createHealth().restore(read());
  assert.equal(reloaded.stop(), null, "a run starting now sees a clean record");
});

await test("the run handler flushes health before starting the run", async () => {
  // Read from the source because the ordering is the whole fix: a run
  // started before the clear lands reloads the condition and halts.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('message?.type === "run"'), source.indexOf('message?.type === "stop"'));
  assert.match(handler, /health\.forget\(\)/, "pressing Run still clears the record");
  assert.match(handler, /durableHealth\.flush\(\)[\s\S]*?run/, "the clear is flushed before the run starts");
  assert.ok(!/\n\s*run\(\);/.test(handler), "the run is no longer started before the flush lands");
});

console.log(`${count} health clearing checks passed.`);
