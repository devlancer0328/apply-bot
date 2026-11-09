/**
 * Stop, and whether it means stop.
 *
 * ## The report
 *
 * "Currently, stop action is not working correctly. Even I click stop in
 * the extension, it still running."
 *
 * ## What was actually happening, measured live
 *
 * Stop was pressed while two resumes were being written. For a hundred
 * and twenty-three seconds the monitor went on reading "Running ·
 * generating" and the bot went on working, because `state.stopping` is
 * read at loop boundaries and the boundaries are minutes apart: one
 * ChatGPT request owns six minutes of deadline, one attempt owns twelve,
 * and a Workday wizard owns twenty-five. Then Chrome ended the service
 * worker - which it does, three times in the fifteen minutes this was
 * being measured - and the next worker read `running: true` out of the
 * saved progress and wrote down the ending as `interrupted`: *Chrome
 * interrupted the previous run... press Run to continue.* That is the one
 * ending designed to be restarted at once; it clears the autopilot delay
 * on the way past. The flag the button had set lived in the dead worker's
 * memory and was never written down, so the stop was not slow, it was
 * gone, and the supervisor was free to start a fresh run a minute later.
 *
 * ## What is held here
 *
 * The four properties that failure needs, each against the real module
 * rather than a restatement of it:
 *
 *   - a stop reaching a batch with an attempt already in the air ends it
 *     in seconds rather than at the attempt deadline, and does not end a
 *     batch nobody stopped;
 *   - a stop survives the worker that received it, and the run comes back
 *     recorded as stopped rather than as interrupted;
 *   - nothing restarts a stopped run - not the autopilot policy, not the
 *     resume path, not a Run press queued behind the wind-down;
 *   - the ending says who asked for it, including when the answer is
 *     "nothing admitted to it", which used to be reported as the
 *     applicant having pressed a button they never pressed.
 *
 * The pure policy is driven directly. The wiring inside the service
 * worker cannot run without Chrome, so where that is the thing under test
 * it is read out of the source, the way tests/health-clear.mjs does.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resumedEnding, stopEnding } from "../src/stop-control.js";
import { stagedBatch } from "../src/pipeline.js";
import { nextRun, SCHEDULE_DEFAULTS, emptyLedger } from "../src/schedule.js";
import { withChatRecovery } from "../src/chat-recovery.js";
import { runSummary } from "../src/run-policy.js";
import { monitorBody } from "../src/ui/monitor.js";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`  PASS  ${name}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");

/* ------------------------------------------- a stop while work is in flight */

/**
 * One batch, with every stage a stand-in, so the only real thing in the
 * test is `stagedBatch`'s own idea of when it may stop waiting.
 */
function batch({ apply, prepare = (item) => item, stopGraceMs = 60, applyDeadlineMs = 12 * 60000, stopped }) {
  const abandoned = [];
  const run = stagedBatch([{ id: 1 }, { id: 2 }], {
    extract: (item) => item,
    screen: (item) => item,
    choose: (list) => list,
    prepare,
    apply,
    remaining: () => 5,
    applyConcurrency: 1,
    applyDeadlineMs,
    stopGraceMs,
    onAbandoned: (item, ms) => abandoned.push({ item, ms }),
    stopped,
  });
  return { run, abandoned };
}

await test("a stop during an attempt that never answers ends the batch in seconds, not at the attempt deadline", async () => {
  let stopping = false;
  const started = Date.now();
  // Twelve minutes is the real default. The old code awaited exactly this
  // in its finally block, which is the measured two minutes of a bot
  // working on after the button, and up to twenty-five on Workday.
  const { run, abandoned } = batch({ apply: () => new Promise(() => {}), stopped: () => stopping });
  setTimeout(() => { stopping = true; }, 80);
  await run;
  const took = Date.now() - started;
  assert.ok(took < 2000, `the batch should give up on the stopped attempt quickly, took ${took}ms`);
  assert.equal(abandoned.length, 1, "the attempt is recorded as let go, not silently dropped");
});

await test("the grace does not abandon an attempt nobody stopped", async () => {
  // The bound only exists once Stop has been asked for. A grace that
  // fired on a healthy run would turn every slow Workday wizard into an
  // abandoned application, which is the opposite trade.
  const { run, abandoned } = batch({
    apply: () => wait(300).then(() => "sent"),
    applyDeadlineMs: 5000,
    stopGraceMs: 60,
    stopped: () => false,
  });
  await run;
  assert.equal(abandoned.length, 0, "a healthy attempt runs to its own end");
});

await test("a preparation that never notices the stop cannot hold the batch open", async () => {
  // The abort signal is what ends a ChatGPT request early; this is the
  // backstop for the day somebody adds a preparation step and forgets to
  // pass the signal into it. Without it the loop awaits a race of
  // promises that never settle and never gets back to reading the flag.
  let stopping = false;
  const started = Date.now();
  const { run } = batch({ apply: (item) => item, prepare: () => new Promise(() => {}), stopped: () => stopping });
  setTimeout(() => { stopping = true; }, 80);
  await run;
  assert.ok(Date.now() - started < 2000, "a stopped batch returns even with a preparation still hanging");
});

await test("the run loop hands the pipeline a stop grace and its own stopping flag", async () => {
  const call = background.slice(background.indexOf("await stagedBatch("), background.indexOf("await stagedBatch(") + 900);
  assert.match(call, /stopGraceMs:STOP_GRACE_MS/, "the batch is told how long a stopped run waits");
  assert.match(call, /stopped:\(\)=>state\.stopping/, "the batch reads the run's own stop flag");
  assert.match(background, /const STOP_GRACE_MS = \d+/, "the grace is a named constant with its reasoning beside it");
});

/* ------------------------------------------- the request itself */

await test("every stop goes through one place, which aborts the run and names who asked", async () => {
  assert.match(background, /function requestStop\(source/, "there is a single entry point for stopping");
  assert.match(background, /runAbort\.abort\(/, "asking for a stop aborts the run's in-flight requests");
  assert.match(background, /if \(source !== "stalled"\) runAgain = false;/, "a stop cancels a run queued behind the wind-down");
  // Four things used to set the flag by hand, which is how an internal
  // stop came to be reported as the applicant's.
  const assignments = background.match(/state\.stopping\s*=\s*true/g) ?? [];
  assert.equal(assignments.length, 1, `only requestStop may raise the flag, found ${assignments.length} assignments`);
  for (const caller of ['requestStop("user"', 'requestStop("health")', 'requestStop("stalled")']) {
    assert.ok(background.includes(caller), `${caller} should be how that stop is asked for`);
  }
});

await test("the writer is handed the run's abort signal, and an aborted request stops retrying at once", async () => {
  // The plumbing was always there - chat-recovery.js has answered an
  // aborted signal with a 499 since it was written - and the one caller
  // that mattered passed `undefined` in the slot where the signal goes.
  assert.match(background, /writeApplication\(profile, job, runAbort\.signal, checkpoint\)/);

  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  const error = await withChatRecovery(() => { attempts += 1; throw Object.assign(new Error("ChatGPT lost the tab"), { workerFailure: true }); }, {
    signal: controller.signal,
    refresh: async () => { throw new Error("a stopped run must not reload a tab to try again"); },
  }).catch((reason) => reason);
  assert.equal(error.status, 499);
  assert.equal(attempts, 0, "an already-stopped run does not start the request at all");
});

await test("a request cut short by the stop is not charged to the posting", async () => {
  assert.match(background, /const stoppedMidRequest = \(error\)/);
  // Recorded as an ordinary failure, each of these would rest the posting
  // for a week and count against the board's health, so a stop would
  // quietly cost the postings it happened to have open.
  const prepare = background.slice(background.indexOf("documents could not be prepared") - 1400, background.indexOf("documents could not be prepared"));
  assert.match(prepare, /if\(stoppedMidRequest\(error\)\)/, "a stopped preparation keeps its place in the queue");
  const apply = background.slice(background.indexOf("the application attempt failed") - 1200, background.indexOf("the application attempt failed"));
  assert.match(apply, /if\(stoppedMidRequest\(error\)\)/, "a stopped attempt is not written down as a failure");
});

/* ------------------------------------------- the stop survives the worker */

await test("the saved progress carries the stop, because the worker holding it does not", async () => {
  const saved = background.slice(background.indexOf("const value={runLog:state.log"), background.indexOf("chrome.storage.session.set(value)"));
  assert.match(saved, /stopping:state\.stopping/, "a stop that is not written down dies with the worker");
  assert.match(saved, /stopSource:state\.stopSource/);
  assert.match(background, /durableRun\.flush\(\)/, "the press is flushed rather than left on the write buffer");
});

await test("a worker booting over a run nobody stopped still calls it interrupted and restarts it", async () => {
  const ending = resumedEnding({ running: true, stopping: false, done: 12, total: 40 });
  assert.equal(ending.reason.code, "interrupted");
  assert.equal(ending.restartable, true, "an interrupted run is the case autopilot exists for");
  assert.match(ending.message, /cut off after 12 of 40/);
});

await test("a worker booting over a run the applicant stopped records the stop, not an interruption", async () => {
  // The live failure, exactly: Stop pressed, worker recycled thirteen
  // seconds later, ending written down as "Chrome interrupted the
  // previous run. ... start Run to continue."
  const ending = resumedEnding({ running: true, stopping: true, stopSource: "user", done: 12, total: 40 });
  assert.equal(ending.reason.code, "user");
  assert.equal(ending.restartable, false);
  assert.match(ending.reason.message, /Stopped by you/);
  assert.match(ending.message, /Nothing further was started/);
});

await test("a stop with no source recorded is still the applicant's, never an interruption", async () => {
  // Saved progress written by an older build has `stopping` but no
  // `stopSource`. Guessing "interrupted" there is the dangerous guess.
  for (const stopSource of [undefined, "", "nonsense"]) {
    const ending = resumedEnding({ running: true, stopping: true, stopSource, done: 1, total: 2 });
    assert.equal(ending.reason.code, "user", `stopSource ${JSON.stringify(stopSource)}`);
    assert.equal(ending.restartable, false);
  }
});

await test("the wound-down run is still the one autopilot is allowed to pick up", async () => {
  // The stall watchdog stops a wedged run precisely so another can start.
  // A fix that made every stop permanent would end unattended nights.
  const ending = resumedEnding({ running: true, stopping: true, stopSource: "stalled", done: 3, total: 9 });
  assert.equal(ending.reason.code, "stalled");
  assert.equal(ending.restartable, true);
});

await test("the resume path consults that decision instead of assuming an interruption", async () => {
  const restore = background.slice(background.indexOf("if (stored.runProgress.running)"), background.indexOf("function log(level, message, detail)"));
  assert.match(restore, /resumedEnding\(/);
  assert.match(restore, /if\(ending\.restartable\)stateStorage\.set\(\{autopilotResumeAt:0\}\)/, "only an interrupted run clears the autopilot delay");
  assert.match(restore, /stopAutopilot\(\)/, "a Stop the dead worker may not have finished writing down is written down again");
});

/* ------------------------------------------- nothing restarts a stopped run */

await test("autopilot refuses to start another run after the applicant's stop", async () => {
  const settings = { ...SCHEDULE_DEFAULTS, autopilot: true };
  const ledger = emptyLedger();
  const stopped = nextRun({ ledger, settings, stopReason: resumedEnding({ running: true, stopping: true, stopSource: "user" }).reason });
  assert.equal(stopped.start, false);
  assert.match(stopped.reason, /Stopped by you/);
});

await test("autopilot would have restarted the interruption the stop used to be mislabelled as", async () => {
  // This is the check that makes the one above mean something: the two
  // endings are a single word apart and that word decides the night.
  const settings = { ...SCHEDULE_DEFAULTS, autopilot: true };
  const restarted = nextRun({ ledger: emptyLedger(), settings, stopReason: resumedEnding({ running: true, stopping: false }).reason });
  assert.equal(restarted.start, true);
});

await test("the stall wind-down still starts a fresh run, so the watchdog is intact", async () => {
  const settings = { ...SCHEDULE_DEFAULTS, autopilot: true };
  const wound = nextRun({ ledger: emptyLedger(), settings, stopReason: stopEnding({ source: "stalled", when: "after the current operations finished" }) });
  assert.equal(wound.start, true);
});

await test("the button switches autopilot off and says so in one handler", async () => {
  const handler = background.slice(background.indexOf('message?.type === "stop"'), background.indexOf('message?.type === "schedule"'));
  assert.match(handler, /requestStop\("user"/);
  assert.match(handler, /stopAutopilot\(\)/);
});

/* ------------------------------------------- the ending says who asked */

await test("each stop is named for whoever asked for it", async () => {
  assert.equal(stopEnding({ source: "user", when: "after the current operations finished" }).code, "user");
  assert.equal(stopEnding({ source: "stalled" }).code, "stalled");
  assert.equal(stopEnding({ source: "user", windingDown: true }).code, "stalled", "the watchdog's wind-down is not the applicant's press");
  const halt = { code: "health", message: "The mailbox is gone." };
  assert.equal(stopEnding({ source: "user", halt }), halt, "a health halt keeps its own sentence");
});

await test("a stop nobody claimed is reported as the fault it is, not as the applicant's press", async () => {
  // `user` is the one code autopilot refuses to restart, so naming an
  // unexplained internal stop that way silently ends the night and leaves
  // the applicant reading that they stopped a run they were watching.
  const orphan = stopEnding({ source: "", when: "after the current operations finished" });
  assert.notEqual(orphan.code, "user");
  assert.match(orphan.message, /without recording what asked for it/);
  assert.equal(nextRun({ ledger: emptyLedger(), settings: { ...SCHEDULE_DEFAULTS, autopilot: true }, stopReason: orphan }).start, true, "a bug in the extension must not be allowed to end the day quietly");
});

await test("the run's own ending resolver is the same one", async () => {
  assert.match(background, /const stoppedReason = \(when\) => stopEnding\(\{ source: state\.stopSource/);
});

/* ------------------------------------------- what the applicant sees */

await test("the pages say stopping in the same second the button is pressed", async () => {
  const winding = { running: true, stopping: true, phase: "stopping", day: null, activeJobs: {}, log: [], aiWorkers: {} };
  assert.match(runSummary(winding), /Stop requested/);
  const body = monitorBody(winding);
  assert.ok(body.includes("Stopping"), "the monitor headline reads Stopping");
  assert.ok(!/pill green">\s*Running/.test(body), "a run winding down is not a green Running pill");
  // The stage used to go on being the headline, which is how two minutes
  // of wind-down read as two minutes of ordinary work.
  assert.match(background, /const phase=value=>\{const next=state\.stopping\?'stopping':value/);
});

console.log(`${count} stop control checks passed.`);
