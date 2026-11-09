/**
 * The supervisor's symptom table, and the run loop's use of it.
 *
 * Two halves, because the thing being protected lives in two places. The
 * first half drives health.js directly: each named condition is raised
 * from the evidence that should raise it, is *not* raised by evidence that
 * looks similar, offers its remedy exactly as often as its budget allows,
 * and ends either in a stop or in a quarantine - never in a counter that
 * nobody reads.
 *
 * The second half reads background.js as text. It cannot be imported: it
 * reaches `chrome` at the top level, which is why every wiring mistake in
 * this extension's history shipped. So the seams are asserted by source -
 * that a result is shown to the supervisor, that the remedies are acted
 * on, that a quarantined board is filtered out of discovery as well as out
 * of the queue - because a condition nothing consults is worse than no
 * condition at all: it reads as a feature in the morning.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createHealth, mailSignal, HEALTH_DEFAULTS } from "../src/health.js";
import { dayProgress, emptyLedger, nextRun, recordOutcome, withScheduleDefaults } from "../src/schedule.js";
import { monitorBody } from "../src/ui/monitor.js";
import { stopEnding } from "../src/stop-control.js";

/**
 * A local wall-clock time on the day these tests are set. The health
 * record rolls its counters on the local day, so a UTC anchor would make
 * every backoff test below pass or fail depending on which timezone it
 * ran in - and the longest of them walks a board through seven hours.
 */
const at = (hour, minute = 0) => new Date(2026, 10, 9, hour, minute).getTime();

let count = 0;
const test = async (name, work) => { await work(); count++; console.log("PASS " + name); };

const GREENHOUSE = "https://job-boards.greenhouse.io/acme/jobs/4010";
const LEVER = "https://jobs.lever.co/beta/8f1b0b1e-0000-4000-8000-000000000001";

const noCode = (company, applyUrl = GREENHOUSE) => ({ status: "manual", company, applyUrl, reason: `no security code arrived: no security code mail for ${company} arrived within 240 seconds` });
const signedOut = (company, applyUrl = GREENHOUSE) => ({ status: "manual", company, applyUrl, reason: "no security code arrived: Gmail is not signed in on this browser, so the code cannot be read" });
const sent = (company, applyUrl = GREENHOUSE, detail = {}) => ({ status: "submitted", company, applyUrl, reason: "", detail });

/* ------------------------------------------------------------ the evidence */

await test("A mail wait is told apart from a board that happens to mention signing in", () => {
  assert.equal(mailSignal(signedOut("Acme")), "signed-out");
  assert.equal(mailSignal(noCode("Acme")), "timeout");
  assert.equal(mailSignal({ reason: "no account mail from vhr-osvhr arrived within 180 seconds" }), "timeout");
  assert.equal(mailSignal(sent("Acme", GREENHOUSE, { securityCode: true })), "ok");
  // A Workday candidate account the bot could not sign in to is a job
  // going wrong, not a mailbox going wrong, and reading it as the mailbox
  // would quarantine Gmail over somebody else's password page.
  assert.equal(mailSignal({ status: "manual", reason: "the candidate account is not signed in and the password was refused" }), "");
  assert.equal(mailSignal({ status: "failed", reason: "the form rejected the submission: Resume/CV is required" }), "");
});

/* ------------------------------------------------- the mailbox conditions */

await test("Gmail saying it is signed out raises its own condition on the first attempt", () => {
  const health = createHealth();
  health.attempt(signedOut("Acme"));
  const [condition] = health.conditions();
  assert.equal(condition.name, "mailbox-signed-out");
  assert.equal(condition.severity, "degraded");
  assert.equal(health.stop(), null);
  assert.deepEqual(health.remedies().map((r) => r.remedy), ["reset-mailbox"]);
});

await test("Mail that never arrives needs a run of attempts before the mailbox is blamed", () => {
  const health = createHealth();
  health.attempt(noCode("Acme"));
  health.attempt(noCode("Beta"));
  assert.deepEqual(health.conditions(), []);
  health.attempt(noCode("Gamma"));
  assert.equal(health.conditions()[0].name, "mail-waits-failing");
  // One code that was actually fetched and typed says the mailbox works,
  // and every count about it starts again from there.
  health.attempt(sent("Delta", GREENHOUSE, { securityCode: true }));
  assert.deepEqual(health.conditions(), []);
});

await test("Two reloads is the mailbox budget; the third flare-up stops the day and says why", () => {
  const health = createHealth();
  const fail = (company) => { health.attempt(signedOut(company)); return health.remedies(); };
  assert.equal(fail("Acme").length, 1);
  assert.equal(fail("Beta").length, 1);
  // The budget is spent, so the condition stops offering a remedy nobody
  // has any reason to believe in and asks for a person instead.
  assert.equal(fail("Gamma").length, 0);
  const stop = health.stop();
  assert.equal(stop.condition, "mailbox-signed-out");
  assert.match(stop.message, /signed in by hand/);
  assert.equal(health.conditions()[0].tried, 2);
});

await test("Reloading the mailbox buys a fresh run of evidence rather than one more failure", () => {
  const health = createHealth();
  const reloads = () => health.remedies().filter((r) => r.remedy === "reset-mailbox").length;
  for (let i = 0; i < HEALTH_DEFAULTS.mailFailures; i++) health.attempt(noCode(`Acme ${i}`));
  assert.equal(reloads(), 1);
  // The one failure that was already in flight while Gmail reloaded must
  // not be read as the reload having failed, or the budget is spent on
  // evidence from before the remedy existed.
  health.attempt(noCode("Delta"));
  assert.equal(reloads(), 0);
  health.attempt(noCode("Epsilon"));
  health.attempt(noCode("Zeta"));
  assert.equal(reloads(), 1);
});

/* ---------------------------------------------------- the board conditions */

await test("A board failing on everything is cooled, then quarantined, and never stops the day", () => {
  const health = createHealth();
  const fail = (n) => { for (let i = 0; i < n; i++) health.attempt({ status: "failed", company: `Acme ${i}`, applyUrl: GREENHOUSE, reason: "the board put up a captcha puzzle after Submit" }); };
  fail(HEALTH_DEFAULTS.boardFailures);
  assert.equal(health.conditions()[0].name, "board-hostile:greenhouse");
  assert.ok(health.boardFactor("greenhouse") === 1);
  assert.deepEqual(health.remedies().map((r) => [r.remedy, r.board]), [["cool-board", "greenhouse"]]);
  assert.equal(health.boardFactor("greenhouse"), HEALTH_DEFAULTS.boardCoolFactor);
  assert.equal(health.quarantined("greenhouse"), false);
  fail(HEALTH_DEFAULTS.boardFailures);
  assert.equal(health.remedies().length, 1);
  fail(HEALTH_DEFAULTS.boardFailures);
  assert.equal(health.quarantined("greenhouse"), true);
  assert.equal(health.conditions()[0].severity, "quarantined");
  // The whole point: Lever is untouched and the night carries on.
  assert.equal(health.quarantined("lever"), false);
  assert.equal(health.boardFactor("lever"), 1);
  assert.equal(health.stop(), null);
});

await test("One success on a board forgets its run of failures", () => {
  const health = createHealth();
  for (let i = 0; i < HEALTH_DEFAULTS.boardFailures - 1; i++) health.attempt({ status: "failed", applyUrl: LEVER, company: `Acme ${i}`, reason: "Lever's Submit is behind a captcha puzzle" });
  health.attempt(sent("Beta", LEVER));
  for (let i = 0; i < HEALTH_DEFAULTS.boardFailures - 1; i++) health.attempt({ status: "failed", applyUrl: LEVER, company: `Gamma ${i}`, reason: "Lever's Submit is behind a captcha puzzle" });
  assert.deepEqual(health.conditions(), []);
});

await test("A board is only hostile when the board is what refused us", () => {
  // The night of 7 November, verbatim: eighteen parks, a third of them
  // Greenhouse, and not one of them Greenhouse's doing. Reading these as
  // a hostile board quarantines a third of the day's supply over a street
  // address and a licence question nobody has answered yet.
  const ours = createHealth();
  for (const reason of [
    'required candidate information needs review: "Preferred Name" is required and the profile is empty for it',
    "required candidate answers are not supported by saved facts: Are you an athlete or esports competitor?",
    "compensation research is unavailable or uncited; no salary fallback is allowed",
    "Error-Address Line 1 - The field Address Line 1 is required and must have a value.",
    "no security code arrived: no security code mail for MongoDB arrived within 240 seconds",
    "could not sign in to cvshealth.wd1.myworkdayjobs.com",
  ]) {
    for (let i = 0; i < HEALTH_DEFAULTS.boardFailures; i++) ours.attempt({ status: "manual", applyUrl: GREENHOUSE, company: `Acme ${reason}${i}`, reason });
  }
  assert.deepEqual(ours.conditions().filter((c) => c.name.startsWith("board-hostile")), [], JSON.stringify(ours.conditions()));
  assert.equal(ours.quarantined("greenhouse"), false);

  // And the signal still fires on what it was built for.
  for (const reason of ["the board put up a captcha puzzle after Submit", "net::ERR_CONNECTION_RESET", "no application form was found on the page", "the site answered 429 Too Many Requests"]) {
    const board = createHealth();
    for (let i = 0; i < HEALTH_DEFAULTS.boardFailures; i++) board.attempt({ status: "manual", applyUrl: GREENHOUSE, company: `Acme ${i}`, reason });
    assert.equal(board.conditions()[0]?.name, "board-hostile:greenhouse", reason);
  }
});

await test("Our own gaps neither raise a board nor wipe out the evidence of a real one", () => {
  const health = createHealth();
  const refuse = () => health.attempt({ status: "manual", applyUrl: GREENHOUSE, company: `Acme ${Math.random()}`, reason: "the board put up a captcha puzzle after Submit" });
  for (let i = 0; i < HEALTH_DEFAULTS.boardFailures - 1; i++) refuse();
  health.attempt({ status: "manual", applyUrl: GREENHOUSE, company: "Mindrift", reason: 'required candidate information needs review: "Address" is required and the profile is empty for it' });
  assert.deepEqual(health.conditions(), []);
  refuse();
  assert.equal(health.conditions()[0]?.name, "board-hostile:greenhouse");
});

await test("Skipped duplicates are not evidence of anything and cannot quarantine a board", () => {
  const health = createHealth();
  for (let i = 0; i < 40; i++) health.attempt({ status: "skipped", applyUrl: GREENHOUSE, company: `Acme ${i}`, reason: "already applied to this company" });
  assert.deepEqual(health.conditions(), []);
  assert.equal(health.quarantined("greenhouse"), false);
});

/* --------------------------------------------------- the whole-day conditions */

await test("Nothing going out anywhere stops the day, but one bad board on its own does not", () => {
  const health = createHealth();
  for (let i = 0; i < HEALTH_DEFAULTS.barrenAttempts + 5; i++) health.attempt({ status: "failed", applyUrl: GREENHOUSE, company: `Acme ${i}`, reason: "the documents could not be attached" });
  assert.equal(health.conditions().some((c) => c.name === "nothing-succeeding"), false);
  const spread = createHealth();
  for (let i = 0; i < HEALTH_DEFAULTS.barrenAttempts; i++) spread.attempt({ status: "failed", applyUrl: i % 2 ? GREENHOUSE : LEVER, company: `Acme ${i}`, reason: "the documents could not be attached" });
  const stop = spread.stop();
  assert.equal(stop.condition, "nothing-succeeding");
  assert.match(stop.message, /across 2 boards/);
});

await test("A feed drought waits a long time before it gives up, and one new link ends it", () => {
  const health = createHealth();
  for (let i = 0; i < HEALTH_DEFAULTS.droughtRounds - 1; i++) health.discovery({ found: 0, complete: true });
  assert.deepEqual(health.conditions(), []);
  health.discovery({ found: 0, complete: true });
  assert.equal(health.conditions()[0].name, "feed-drought");
  assert.equal(health.stop(), null);
  health.discovery({ found: 12, complete: true });
  assert.deepEqual(health.conditions(), []);
  for (let i = 0; i < HEALTH_DEFAULTS.droughtStopRounds; i++) health.discovery({ found: 0, complete: true });
  assert.match(health.stop().message, /widening/);
  // A half-read page is not a round. Counting it would call a feed dry
  // after three chunks of a list that has two thousand jobs left in it.
  const partial = createHealth();
  for (let i = 0; i < 30; i++) partial.discovery({ found: 0, complete: false });
  assert.deepEqual(partial.conditions(), []);
});

await test("A refused writer identity stops at once; a sent application clears it", () => {
  const health = createHealth();
  health.service("writer", { ok: false, status: 401, message: "ChatGPT is signed out" });
  assert.equal(health.stop().condition, "writer-signed-out");
  health.attempt(sent("Acme"));
  assert.equal(health.stop(), null);
});

/* ------------------------------------------------------------------ disk */

await test("Disk pressure drops the screenshot first and refuses to apply only when the record is at risk", () => {
  const health = createHealth();
  health.storage({ quota: 50e9, usage: 10e9, dbBytes: 200e6 });
  assert.equal(health.screenshots, true);
  assert.deepEqual(health.conditions(), []);
  health.storage({ quota: 10.5e9, usage: 10e9, dbBytes: 200e6 });
  assert.equal(health.screenshots, false);
  assert.equal(health.conditions()[0].name, "disk-low");
  assert.equal(health.stop(), null);
  // The floor is the database's own size, not a constant: SQLite here is
  // one file rewritten whole on every save, so a disk that cannot hold a
  // second copy of it fails at the next write of anything.
  health.storage({ quota: 10.3e9, usage: 10e9, dbBytes: 400e6 });
  assert.equal(health.stop().condition, "disk-critical");
  health.storage({ quota: 50e9, usage: 10e9, dbBytes: 400e6 });
  assert.equal(health.stop(), null);
  assert.equal(health.screenshots, true);
});

await test("The published cost of an application matches what the folders on disk actually weigh", () => {
  // Ninety-eight real folders: a 20 KB resume, often a 20 KB letter, under
  // 3 KB of text and JSON, and a 199 KB screenshot - stored once in SQLite
  // as base64 and once in Downloads. Asserted so that a change to what is
  // written has to come back here and change the arithmetic the disk
  // thresholds are built on.
  const onDisk = 20_000 + 20_000 + 199_000 + 3_000;
  assert.ok(Math.abs(HEALTH_DEFAULTS.bytesPerApplication - (onDisk * 4 / 3 + onDisk)) < 60_000);
  assert.ok(HEALTH_DEFAULTS.bytesPerApplication * 300 < 200e6, "a full day has to fit in a couple of hundred megabytes");
});

/* -------------------------------------------------- surviving the worker */

await test("A killed worker comes back knowing how many recoveries tonight has already had", () => {
  const health = createHealth();
  health.attempt(signedOut("Acme"));
  health.remedies();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < HEALTH_DEFAULTS.boardFailures; i++) health.attempt({ status: "failed", applyUrl: LEVER, company: `Beta ${round}-${i}`, reason: "the board put up a captcha puzzle after Submit" });
    health.remedies();
  }
  assert.equal(health.quarantined("lever"), true);

  const resumed = createHealth().restore(JSON.parse(JSON.stringify(health.snapshot())));
  assert.equal(resumed.quarantined("lever"), true);
  // One more flare-up, and the budget is already spent: without the
  // restore this would start the ladder again and never reach the stop.
  resumed.attempt(signedOut("Gamma"));
  assert.equal(resumed.remedies().length, 1);
  resumed.attempt(signedOut("Delta"));
  assert.equal(resumed.stop().condition, "mailbox-signed-out");
});

await test("Yesterday's conditions do not greet the applicant in the morning", () => {
  let clock = new Date(2026, 10, 7, 23, 50, 0).getTime();
  const health = createHealth({ now: () => clock });
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < HEALTH_DEFAULTS.boardFailures; i++) health.attempt({ status: "failed", applyUrl: GREENHOUSE, company: `Acme ${round}-${i}`, reason: "the board put up a captcha puzzle after Submit" });
    health.remedies();
  }
  assert.equal(health.quarantined("greenhouse"), true);
  clock = new Date(2026, 10, 8, 0, 20, 0).getTime();
  health.attempt(sent("Beta", LEVER));
  assert.equal(health.quarantined("greenhouse"), false);
  assert.deepEqual(health.conditions(), []);
  // A snapshot written yesterday is not restored into today at all.
  const stale = createHealth({ now: () => clock }).restore({ day: "2026-11-07", boards: [["greenhouse", { fails: 9, quarantined: 1 }]], conditions: [] });
  assert.equal(stale.quarantined("greenhouse"), false);
});

await test("Only a person clears a standing condition; the supervisor cannot clear its own diagnosis", () => {
  const health = createHealth();
  health.service("writer", { ok: false, status: 403, message: "refused" });
  assert.ok(health.stop());
  health.remedies();
  assert.ok(health.stop(), "running the remedies must not be a way out of a stop");
  health.forget();
  assert.equal(health.stop(), null);
});

/* ------------------------------------------------- what autopilot does with it */

await test("Autopilot keeps watching a health halt instead of switching itself off for the night", () => {
  const settings = withScheduleDefaults({ autopilot: true, dailyTarget: 300 });
  const ledger = emptyLedger(Date.now());
  const stopReason = { code: "health", message: "Gmail is signed out." };
  const blocked = nextRun({ ledger, settings, stopReason, blocked: true });
  assert.equal(blocked.start, false);
  assert.equal(blocked.watch, true, "the alarm has to stay armed or a condition that lifts is never noticed");
  const cleared = nextRun({ ledger, settings, stopReason, blocked: false });
  assert.equal(cleared.start, true);
  assert.equal(cleared.delayMs, settings.idleRetryMs);
});

/* ------------------------------------------- the morning-after account */

await test("The day's panel answers how many, to whom, why not, and what needs a person", () => {
  const settings = withScheduleDefaults({ dailyTarget: 300 });
  const noon = new Date(2026, 10, 7, 12, 0, 0).getTime();
  let ledger = emptyLedger(noon);
  for (let i = 0; i < 40; i++) ledger = recordOutcome(ledger, { status: "submitted", company: i % 3 ? `Employer ${i % 7}` : "Acme" }, noon + i * 1000);
  for (let i = 0; i < 12; i++) ledger = recordOutcome(ledger, { status: "failed", company: `Other ${i}`, reason: `no security code mail for Other ${i} arrived within 240 seconds` }, noon + 90000);
  const day = dayProgress(ledger, settings, noon + 3600000);
  assert.equal(day.submitted, 40);
  assert.equal(day.employers[0].company, "Acme");
  assert.equal(day.employers.reduce((total, row) => total + row.count, 0), 40);
  assert.equal(day.reasons[0].count, 12);

  const html = monitorBody({
    running: false, day, attempts: { width: 2, busy: 0, parked: 0, queued: 0, holders: [] },
    stopReason: { code: "health", message: "Gmail is signed out and reopening the tab twice did not fix it." },
    health: { screenshots: false, conditions: [{ name: "mailbox-signed-out", title: "Gmail is signed out", detail: "Two reloads did not fix it.", since: noon, tried: 2, severity: "stop" }] },
  });
  assert.match(html, /Needs you/);
  assert.match(html, /Gmail is signed out/);
  assert.match(html, /2 automatic recovery attempt/);
  assert.match(html, /Applied to today \(8 employer\(s\)\)/);
  assert.match(html, /screenshots are not being saved/);
  assert.match(html, /no security code mail for arrived within n seconds/);
  // A healthy day shows no panel at all, because a permanent green tick is
  // a thing people stop reading.
  assert.doesNotMatch(monitorBody({ running: true, day, attempts: {}, health: { conditions: [], screenshots: true } }), /Needs you|Health<\/h2>/);
});

/* -------------------------------------------------- the run loop's wiring */

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");

await test("Every result is shown to the supervisor, and the remedies are acted on where it matters", () => {
  assert.match(background, /health\.attempt\(result\)/, "the outcome has to reach health.js or none of this runs");
  assert.match(background, /if\(await treatConditions\(\)\)return false;/, "an attempt that raised a stop must not be followed by another one");
  assert.match(background, /if\(await treatConditions\(\)\)break;/, "a drought becomes fatal while nothing is being applied to");
  assert.match(background, /health\.discovery\(\{found:discoveredInBatch,complete:batchComplete\}\)/);
  assert.match(background, /blocked: Boolean\(health\.stop\(\)\)/, "autopilot must ask before starting another run");
  // Both halves of the quarantine. Filtering discovery alone leaves the
  // postings already chosen in the batch, and refusing in the queue alone
  // means every round re-reads a board that has stopped wanting requests.
  assert.match(background, /if \(health\.quarantined\(atsOf\(entry\.link\)\)\) return false;/);
  assert.match(background, /if\(health\.quarantined\(board\)\)/);
  assert.match(background, /boardGapMs:Math\.round\(scheduleSettings\.boardGapMs\*health\.boardFactor\(board\)\)/);
  assert.match(background, /if \(!health\.screenshots\) return \{ folder \};/);
  assert.match(background, /keepPicture:health\.screenshots/);
});

await test("A health halt is not recorded as the applicant having pressed Stop", () => {
  // `state.stopping` is the only graceful way to wind an attempt down, and
  // the finally block turns that into "Stopped by you" - which switches
  // autopilot off and loses the one sentence explaining the night.
  // Who asked is now recorded when the stop is asked for rather than
  // guessed at afterwards; see src/stop-control.js and tests/stop-control.mjs.
  const halt = { code: "health", message: "The mailbox is gone." };
  assert.equal(stopEnding({ source: "health", halt, when: "after the current operations finished" }), halt);
  assert.equal(stopEnding({ source: "user", halt }), halt, "a halt already under way is not relabelled by a later press");
  assert.match(background, /const stoppedReason = \(when\) => stopEnding\(\{ source: state\.stopSource, halt: haltReason/);
  assert.match(background, /haltReason = \{ code: "health", message: stop\.message \}/);
  assert.match(background, /haltReason = null;/);
  assert.match(background, /requestStop\("health"\)/, "the halt asks for the stop rather than raising the flag itself");
});

await test("The health record is loaded, saved and probed at the moments the worker can die between", () => {
  assert.match(background, /loadHealth\(\)/);
  assert.match(background, /durableHealth\.flush\(\)/);
  assert.match(background, /await probeDisk\(\)\.catch\(\(\) => \{\}\);/, "the disk is read before a run as well as during one");
  assert.match(background, /setInterval\(\(\) => \{probeDisk\(\)/);
  assert.match(background, /health\.forget\(\);/, "pressing Run by hand is what clears a standing condition");
});

/* ------------------------------------------------- a feed that comes back */

/**
 * The night this is taken from: a Jobright read timed out at 01:01, the
 * feed was the only one enabled, and the condition it raised held the
 * supervisor off until the machine was found in the morning. Seven hours
 * of clock, five and a half idle, nine applications sent. Nothing was
 * broken by then - the feed answered fine later - but only a person could
 * clear the condition, and there was no person until eight.
 */
/**
 * A wall-clock time on the night these tests describe, built in local time
 * rather than UTC. The thing being measured is a wait that a day boundary
 * cancels, and the boundary health.js uses is the machine's local
 * midnight - so a UTC literal puts the whole test an unpredictable number
 * of hours from the edge, and it passes or fails by timezone.
 */
const localTime = (hour, minute) => new Date(2026, 10, 9, hour, minute).getTime();

await test("A feed that dies is retried on a backoff rather than being dropped for the day", () => {
  let clock = localTime(1, 1);
  const health = createHealth({ now: () => clock });
  const plan = (blocked) => nextRun({
    ledger: emptyLedger("2026-11-09"),
    settings: withScheduleDefaults({ autopilot: true }),
    stopReason: { code: "health", message: "jobright can no longer be read" },
    blocked,
    now: clock,
  });

  health.source("jobright", { ok: false, message: "Jobright feed inspection did not respond within 50 seconds", fatal: true });
  assert.ok(health.stop(), "the last source dying still stops the run that is going");
  assert.equal(plan(Boolean(health.stop())).start, false);
  assert.equal(plan(Boolean(health.stop())).watch, true, "the alarm is kept so the retry can happen at all");
  assert.deepEqual(health.sourcesDue(), []);

  clock += 9 * 60000;
  assert.ok(health.stop(), "nine minutes in it is still too early to try again");

  clock += 90000;
  assert.equal(health.stop(), null, "ten minutes in the supervisor is free to start a run");
  assert.deepEqual(health.sourcesDue(), ["jobright"], "and the run knows which source to pick back up");
  assert.equal(plan(Boolean(health.stop())).start, true);
  // The condition itself is still standing and still on the panel. Being
  // past its backoff makes it worth retrying, not resolved.
  assert.ok(health.conditions().some((record) => record.name === "source-dead:jobright"));

  // Second failure: the wait doubles rather than repeating, so a feed that
  // really has gone is not read every ten minutes until morning.
  health.source("jobright", { ok: false, message: "still not answering", fatal: true });
  assert.ok(health.stop());
  assert.deepEqual(health.sourcesDue(), []);
  clock += 19 * 60000;
  assert.ok(health.stop(), "the second wait is longer than the first");
  clock += 2 * 60000;
  assert.equal(health.stop(), null);

  // The wait is capped, or a feed that fails all evening ends up with a
  // retry scheduled after the night it was meant to work.
  for (let i = 0; i < 8; i += 1) health.source("jobright", { ok: false, fatal: true });
  const capped = health.conditions().find((record) => record.name === "source-dead:jobright");
  assert.ok(capped.retryAt - clock <= 60 * 60000, "an hour is as long as a dead feed is ever left alone");

  // And when it answers again the condition goes, rather than standing on
  // the panel describing an outage that ended.
  health.source("jobright", { ok: true });
  assert.equal(health.stop(), null);
  assert.deepEqual(health.sourcesDue(), []);
  assert.equal(health.conditions().length, 0);
});

await test("A dead feed beside healthy ones is still only degraded, and still comes back", () => {
  let clock = localTime(1, 1);
  const health = createHealth({ now: () => clock });
  health.source("jobright", { ok: false, message: "timed out", fatal: false });
  assert.equal(health.stop(), null, "one feed of three is a reason to lean on the others, not to stop");
  assert.equal(health.conditions()[0].severity, "degraded");
  clock += 10 * 60000;
  assert.deepEqual(health.sourcesDue(), ["jobright"]);
});

/**
 * Lever was quarantined at 01:39 on the same night, over a bad half hour,
 * and never read again. It was one of the two boards that actually answer
 * this bot, so the day lost most of its supply to a rule meant to stop the
 * bot hammering a site that had put a wall up.
 */
await test("A quarantined board is given another go, not written off until midnight", () => {
  let clock = localTime(1, 39);
  const health = createHealth({ now: () => clock });
  const fail = (n) => { for (let i = 0; i < n; i += 1) health.attempt({ status: "failed", company: `Acme ${i}`, applyUrl: LEVER, reason: "the board put up a captcha puzzle after Submit" }); };
  const quarantine = () => { for (let i = 0; i < HEALTH_DEFAULTS.boardCools + 1; i += 1) { fail(HEALTH_DEFAULTS.boardFailures); health.remedies(); } };

  quarantine();
  assert.equal(health.quarantined("lever"), true);
  assert.equal(health.stop(), null, "one board's bad night still never stops the day");

  clock += 29 * 60000;
  assert.equal(health.quarantined("lever"), true, "half an hour is the shortest a board is left alone");
  clock += 2 * 60000;
  assert.equal(health.quarantined("lever"), false, "past the wait its next posting is tried");
  // Still on the panel. Being worth another go is not the same as being
  // better, and the applicant should see that the board is in trouble.
  assert.equal(health.conditions().find((record) => record.name === "board-hostile:lever")?.severity, "quarantined");

  // The go it bought, spent on a refusal: straight back to quarantine on
  // twice the wait, without having to fail three more times first.
  fail(1);
  assert.equal(health.quarantined("lever"), true);
  clock += 31 * 60000;
  assert.equal(health.quarantined("lever"), true, "the second wait is longer than the first");
  clock += 30 * 60000;
  assert.equal(health.quarantined("lever"), false);

  // The go spent on a submission instead: the board is working, so the
  // quarantine, the failure streak and the condition all go with it.
  health.attempt({ status: "submitted", company: "Acme", applyUrl: LEVER });
  assert.equal(health.quarantined("lever"), false);
  assert.equal(health.conditions().some((record) => record.name === "board-hostile:lever"), false);

  // And a board that recovered is quarantined from scratch next time,
  // rather than inheriting the hour it had worked its way up to.
  quarantine();
  clock += 31 * 60000;
  assert.equal(health.quarantined("lever"), false);
});

await test("A board that is genuinely gone is not probed every half hour until morning", () => {
  let clock = localTime(1, 39);
  const health = createHealth({ now: () => clock });
  const fail = (n) => { for (let i = 0; i < n; i += 1) health.attempt({ status: "failed", company: `Acme ${i}`, applyUrl: LEVER, reason: "the board put up a captcha puzzle after Submit" }); };
  for (let i = 0; i < HEALTH_DEFAULTS.boardCools + 1; i += 1) { fail(HEALTH_DEFAULTS.boardFailures); health.remedies(); }

  // Each go is spent on a refusal, so the wait doubles every time. Five
  // rounds is about seven hours, which keeps the whole thing inside one
  // day - a day boundary clears the board outright and would hide the
  // cap rather than test it.
  const waits = [];
  for (let round = 0; round < 5; round += 1) {
    const since = clock;
    while (health.quarantined("lever")) clock += 60000;
    waits.push(Math.round((clock - since) / 60000));
    fail(1);
  }
  assert.deepEqual(waits, [30, 60, 120, 120, 120], "half an hour, doubling, and never more than two");
});

await test("A retry window survives the worker being restarted", () => {
  let clock = localTime(1, 1);
  const first = createHealth({ now: () => clock });
  first.source("jobright", { ok: false, fatal: true });
  const saved = { day: first.day, boards: [], conditions: first.conditions() };

  clock += 11 * 60000;
  const restored = createHealth({ now: () => clock }).restore(saved);
  assert.equal(restored.stop(), null, "a restart must not reset the clock the backoff is measured on");
  assert.deepEqual(restored.sourcesDue(), ["jobright"]);
});

await test("The run loop picks a revived source back up mid-night", () => {
  // background.js cannot be imported, so the seam is read as text.
  assert.match(background, /for \(const name of health\.sourcesDue\(\)\)/, "the run asks which dead sources are due");
  assert.match(background, /if \(!retired\.delete\(name\)\) continue;/, "and takes them out of the retired set");
  assert.match(background, /discovery\.revive\(name\)/, "and hands their slot back to the round counter");
});

console.log(`${count} health and escalation checks passed.`);
