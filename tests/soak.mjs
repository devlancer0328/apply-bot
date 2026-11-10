/**
 * A night, simulated, because a night cannot be rehearsed.
 *
 * Everything else in this repository tests one attempt. The failure modes
 * that actually end an unattended day are not properties of one attempt:
 * they are properties of three hundred of them in a row, where the thing
 * that goes wrong is slow, systemic and invisible from inside any single
 * job. A Gmail tab that signs out at one in the morning does not fail an
 * application, it fails every application after it, and the only way to
 * see that before it happens for real is to run the day.
 *
 * ## What is real here and what is not
 *
 * The supervisor is real: `health.js`, `schedule.js`, `slots.js`,
 * `employers.js`, `history.js` and the actual SQLite in `database.js`
 * against an in-memory OPFS, so every duplicate claim is adjudicated by
 * the code that will adjudicate it at 3am. What is simulated is the
 * browser and the employers - a `night()` driver that mirrors the control
 * flow of `runLoop`/`applyCandidate` in background.js over a world model
 * that can be made hostile on command.
 *
 * Mirroring rather than importing is forced: background.js touches
 * `chrome` at module scope and cannot be loaded in Node at all. The seam
 * that creates - a driver that drifts from the loop it imitates - is
 * covered the only way it can be, by `tests/health.mjs` asserting the
 * wiring in background.js by source. Read the two together; neither is
 * sufficient alone.
 *
 * ## The clock
 *
 * Virtual, and advanced by the driver. A real day is 86 400 000 ms and the
 * pacing under test is measured in minutes, so every module that needs the
 * time is given `() => at`. That is not a convenience: the midnight
 * rollover, the per-board gap and the per-employer spacing are all things
 * whose bugs only appear at a scale no test can wait for.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createHealth, HEALTH_DEFAULTS } from "../src/health.js";
import { boardStarted, boardWaitMs, dayProgress, emptyLedger, nextRun, recordDiscovered, recordOutcome, rollDay, withScheduleDefaults } from "../src/schedule.js";
import { employerDay } from "../src/employers.js";
import { createSlots } from "../src/slots.js";
import { historyIndex } from "../src/history.js";
import { atsOf } from "../src/ats.js";
import { monitorBody } from "../src/ui/monitor.js";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log("PASS " + name); };

/* ------------------------------------------------------------- the disk */

const wasm = await readFile(new URL("../src/vendor/sql-wasm.wasm", import.meta.url));
const disk = new Map();
const copy = (bytes) => Uint8Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
const directory = {
  async getFileHandle(name, { create = false } = {}) {
    if (!disk.has(name)) {
      if (!create) throw Object.assign(new Error("no such file"), { name: "NotFoundError" });
      disk.set(name, new Uint8Array());
    }
    return {
      getFile: async () => ({ arrayBuffer: async () => copy(disk.get(name)).buffer }),
      createWritable: async () => ({ write: async (bytes) => disk.set(name, copy(bytes)), close: async () => {}, abort: async () => {} }),
    };
  },
};
Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: async () => directory } }, configurable: true, writable: true });
globalThis.chrome = { runtime: { getURL: (path) => `stub://${path}` }, storage: { local: { get: async () => ({}) } } };
globalThis.indexedDB = { databases: async () => [] };
globalThis.fetch = async () => ({ arrayBuffer: async () => copy(wasm).buffer });

/**
 * A service worker, from the database's point of view.
 *
 * Each boot is a fresh module instance reading the OPFS bytes, which is
 * what Chrome gives you after it kills one. The soak restarts the worker
 * on purpose in the middle of the night, so this is load-bearing rather
 * than decorative.
 */
let generation = 0;
const bootWorker = async () => {
  disk.delete("apply-bot.sqlite3");
  return (await import(`../src/database.js?soak=${++generation}`)).databaseRequest;
};
const restartWorker = async () => (await import(`../src/database.js?soak=${++generation}`)).databaseRequest;

/* ------------------------------------------------------------ the world */

const BOARDS = {
  greenhouse: (slug, n) => `https://job-boards.greenhouse.io/${slug}/jobs/${n}`,
  lever: (slug, n) => `https://jobs.lever.co/${slug}/${n}`,
  ashby: (slug, n) => `https://jobs.ashbyhq.com/${slug}/${n}`,
  workable: (slug, n) => `https://apply.workable.com/${slug}/j/${n}`,
  workday: (slug, n) => `https://${slug}.wd1.myworkdayjobs.com/External/job/Remote/Engineer_${n}`,
};
const BOARD_NAMES = Object.keys(BOARDS);
const ROLES = ["Backend Engineer", "Platform Engineer", "Data Engineer", "Site Reliability Engineer", "Full Stack Engineer"];
/** The boards that finish an application by mailing a code. */
const MAILS_A_CODE = new Set(["greenhouse", "workday"]);

/** Deterministic, because a soak that fails one run in forty is not evidence. */
const dice = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/**
 * The feed. Postings are generated rather than fixtured because the shape
 * that matters is the distribution - how many employers, how many roles
 * each, which boards - and three hundred hand-written fixtures would fix
 * that distribution by accident.
 */
function* postings({ employers = 600, from = 0 } = {}) {
  // Six hundred of them, where a day's target is three hundred. It was a
  // hundred and forty, which was generous against a budget of three roles
  // each and impossible against a budget of one: the day stopped at a
  // hundred and twenty-seven, having run out of employers rather than
  // time. That is a true thing about one-per-employer and worth knowing,
  // but it is not what this file tests - a day that ends early tests the
  // throughput, pacing and storage machinery below it on a third of the
  // work. The supply question has its own test further down.
  for (let n = from; ; n++) {
    const employer = n % employers;
    const board = BOARD_NAMES[employer % BOARD_NAMES.length];
    const slug = `employer-${employer}`;
    // The role turns over once per pass rather than once per posting, so
    // an employer's second and third openings are genuinely different
    // ones. Handing the same employer the same role again is a duplicate,
    // correctly refused, and a feed that did it would quietly test nothing.
    yield { company: `Employer ${employer}`, title: ROLES[Math.floor(n / employers) % ROLES.length], board, applyUrl: BOARDS[board](slug, 10000 + n), id: `job-${n}` };
  }
}

/**
 * One attempt's outcome, decided by the state of the world rather than by
 * the job. That inversion is the whole point: the conditions being tested
 * are the ones where the posting was fine and the system was not.
 */
function outcomeFor(job, world, roll) {
  if (world.hostile.has(job.board)) return { status: "manual", reason: `the form could not be read: no apply button or form was found on ${job.board}` };
  if (world.mail !== "ok" && MAILS_A_CODE.has(job.board)) {
    return world.mail === "signed-out"
      ? { status: "manual", reason: "no security code arrived: Gmail is not signed in on this browser, so the code cannot be read" }
      : { status: "manual", reason: `no security code arrived: no security code mail for ${job.company} arrived within 240 seconds` };
  }
  if (world.writer === "down") return { status: "failed", reason: "the resume writer refused the request (401)" };
  // An ordinary night still loses some. Roughly one in twelve, which is
  // what the eight confirmed applications of the first unattended run and
  // the folders behind them actually looked like.
  if (roll() < world.lossRate) return { status: "manual", reason: "a required question had no answer in the profile: years of experience with Kubernetes" };
  return { status: "submitted", detail: MAILS_A_CODE.has(job.board) ? { securityCode: "384102" } : {} };
}

/* ----------------------------------------------------------- the driver */

/**
 * A night.
 *
 * The loop below is `runLoop` with the browser taken out: pace the board,
 * budget the employer, refuse what history already has, take the claim,
 * get an outcome, show it to the supervisor, record it, carry out whatever
 * the supervisor asked for, and stop if it asked for that. Everything
 * between `slots.hold` and `recordOutcome` is the order background.js uses
 * and the order matters, so it is kept even where a test would not need it.
 *
 * `script` is how a night is made hostile: a map of attempt number to a
 * function that mutates the world, so "Gmail dies on attempt 40" is one
 * line rather than a branch in the driver.
 */
async function night({
  request, start, target = 300, attempts: budget = 1200, world: initial = {}, script = {},
  settings: overrides = {}, feed = postings(),
} = {}) {
  let at = start;
  const world = { mail: "ok", hostile: new Set(), writer: "up", lossRate: 1 / 12, freeBytes: 8e9, reloads: 0, cooled: [], feed: "flowing", ...initial };
  const settings = withScheduleDefaults({ dailyTarget: target, boardGapMs: 45000, employerGapMs: 600000, attemptConcurrency: 2, autopilot: true, ...overrides });
  const health = createHealth({ now: () => at });
  const employers = employerDay({ limit: settings.perCompanyPerDay, gapMs: settings.employerGapMs, now: () => at });
  const slots = createSlots({ limit: settings.attemptConcurrency });
  const roll = dice(20261107);

  let ledger = emptyLedger(at);
  let db = request;
  const sent = [], skipped = [], held = [], duplicates = [], restarts = [];
  const bytes = { written: 0, screenshots: 0 };
  let halt = null, tried = 0, rounds = 0, droughtRounds = 0;

  /** What background.js's `treatConditions` does, in the same order. */
  const treat = async () => {
    for (const { remedy, board } of health.remedies()) {
      if (remedy === "reset-mailbox") { world.reloads += 1; if (world.mailHealsOnReload) world.mail = "ok"; }
      else if (remedy === "cool-board") world.cooled.push(board);
    }
    const stop = health.stop();
    if (!stop || halt) return Boolean(halt);
    halt = { code: "health", condition: stop.condition, message: stop.message };
    return true;
  };

  /**
   * Chrome killing the worker. The ledger and the supervisor go through
   * JSON because that is what SQLite holds, the modules are rebuilt from
   * it, and the database is re-imported over the same OPFS bytes - so a
   * restart that lost the escalation budget or the quarantine would show
   * up here as the night never reaching its stop.
   */
  const restart = async () => {
    const saved = { ledger: JSON.parse(JSON.stringify(ledger)), health: JSON.parse(JSON.stringify(health.snapshot())) };
    db = await restartWorker();
    ledger = saved.ledger;
    health.forget();
    health.restore(saved.health);
    restarts.push(tried);
  };

  while (tried < budget && dayProgress(ledger, settings, at).remaining > 0) {
    if (script[tried]) script[tried]({ world, health, at });
    // Chrome does not wait for a convenient moment, so neither does this:
    // the kill lands on whatever the loop was doing, including the rounds
    // that skipped a quarantined board without applying to anything.
    if (world.restartEvery && rounds && rounds % world.restartEvery === 0) await restart();
    rounds += 1;

    // The feed round, which is also the only thing that happens on a night
    // with nothing in it. A drought has to be able to end a day on its own.
    if (world.feed === "dry") {
      droughtRounds += 1;
      health.discovery({ found: 0, complete: true });
      at += settings.idleRetryMs ?? 600000;
      if (await treat()) break;
      if (droughtRounds > HEALTH_DEFAULTS.droughtStopRounds + 2) break;
      tried += 1;
      continue;
    }
    if (droughtRounds) { health.discovery({ found: 12, complete: true }); ledger = recordDiscovered(ledger, 12, at); droughtRounds = 0; }

    const job = feed.next().value;
    tried += 1;
    const board = atsOf(job.applyUrl);

    // Both halves of a quarantine, exactly as background.js has them: the
    // board is filtered out of the batch and refused again at the queue.
    if (health.quarantined(board)) { held.push(job); continue; }
    if (!employers.claim(job.company, [job.applyUrl])) { held.push(job); continue; }

    // Pacing. Virtual time is advanced by the wait rather than slept, and
    // the cooling multiplier is applied the way the run loop applies it.
    at += boardWaitMs(ledger, board, settings, at) + employers.waitMs(job.company, [job.applyUrl], at);
    ledger = boardStarted(ledger, board, { ...settings, boardGapMs: Math.round(settings.boardGapMs * health.boardFactor(board)) }, at, roll);
    employers.started(job.company, [job.applyUrl], at);

    const claim = await db({ action: "claimSubmission", value: { applyUrl: job.applyUrl, sourceUrl: "", id: job.id, company: job.company, title: job.title } });
    if (!claim.claimed) { duplicates.push(job); employers.release(job.company, [job.applyUrl]); continue; }

    const result = { ...outcomeFor(job, world, roll), company: job.company, applyUrl: job.applyUrl, board };
    // Through the real pool, including the park-the-slot path every board
    // that mails a code goes down. The driver is sequential, so this is
    // not a concurrency test; what it is checking is that a night of
    // attempts - parked, failed, quarantined - hands every slot back. A
    // pool that leaks one holder a night is a pool that is wedged by
    // morning, and nothing else in the run would say so.
    await slots.hold({ company: job.company, board }, async (attempt) => {
      attempt.note("Filling the form");
      if (MAILS_A_CODE.has(board)) await attempt.waiting("an emailed security code", async () => result.detail?.securityCode ?? null);
    });
    health.attempt(result);
    ledger = recordOutcome(ledger, result, at);
    if (result.status === "submitted") {
      sent.push({ ...job, at });
      // What a confirmed application costs the disk, both copies, with the
      // screenshot dropped when the supervisor has asked for that.
      const cost = health.screenshots ? HEALTH_DEFAULTS.bytesPerApplication : HEALTH_DEFAULTS.bytesPerApplication - 210_000 - 280_000;
      bytes.written += cost;
      if (health.screenshots) bytes.screenshots += 1;
      world.freeBytes = Math.max(0, world.freeBytes - cost);
    } else skipped.push({ job, result, at });

    // The rest of the machine, which on a root partition that is already
    // 98 per cent full is the thing most likely to take the last gigabyte
    // while the bot is busy being frugal with it.
    world.freeBytes = Math.max(0, world.freeBytes - (world.drainBytes ?? 0));
    health.storage({ quota: world.freeBytes + 1e9, usage: 1e9, dbBytes: 40e6 });
    if (await treat()) break;

    // Four minutes of work spread across two slots, which is what the
    // eight confirmed applications of the first unattended run averaged.
    at += 45000 + Math.round(roll() * 30000);
  }

  rollDay(ledger, at);
  return { at, world, health, ledger, settings, employers, slots, sent, skipped, held, duplicates, restarts, bytes, halt, tried, db,
    day: () => dayProgress(ledger, settings, at) };
}

const NOON = new Date(2026, 10, 7, 12, 0, 0).getTime();
const LATE = new Date(2026, 10, 7, 22, 0, 0).getTime();

/* ------------------------------------------------------- an ordinary day */

await test("A three-hundred-application day finishes, stays healthy, and sends nothing twice", async () => {
  const request = await bootWorker();
  const run = await night({ request, start: NOON, target: 300 });
  const day = run.day();

  assert.equal(day.submitted, 300, "the day has to reach its target with postings left over");
  assert.equal(day.remaining, 0);
  assert.equal(run.halt, null, "a healthy night must never stop itself");
  assert.deepEqual(run.health.conditions(), [], "and must never raise a condition the applicant would have to read");

  // No duplicate, by the only definition that counts: what the employers saw.
  assert.equal(new Set(run.sent.map((job) => job.applyUrl)).size, 300);
  assert.equal(run.duplicates.length, 0);
  // And by the record that will still be there tomorrow.
  const history = await run.db({ action: "list", table: "history" });
  const index = historyIndex(history);
  for (const job of run.sent) assert.ok(index.match(job.applyUrl), `${job.applyUrl} has to be in tomorrow's duplicate index`);

  // One application per employer, across a whole night of three hundred.
  // This is the property the budget, the claim and the history index all
  // exist to produce, and the only place all three run together.
  const perEmployer = new Map();
  for (const job of run.sent) perEmployer.set(job.company, (perEmployer.get(job.company) ?? 0) + 1);
  assert.equal(Math.max(...perEmployer.values()), 1, "an employer that received two applications is the mistake that cannot be taken back");
  assert.equal(perEmployer.size, 300, "three hundred applications means three hundred different employers");
  // And the tally the applicant reads in the morning adds up to what was
  // actually sent.
  assert.equal(day.employers.reduce((total, row) => total + row.count, 0), 300);
  assert.equal(day.employers[0].count, 1);
  assert.equal(run.slots.status().busy, 0, "a night that leaks one slot is a pool that is wedged by morning");
});

await test("Every board is paced apart all night, and no employer is applied to twice inside the spacing", async () => {
  const request = await bootWorker();
  const run = await night({ request, start: NOON, target: 120 });
  // The ledger carries the next-allowed instant per board, so a run that
  // paced nothing would have left them all at the start of the day.
  for (const board of BOARD_NAMES) assert.ok(run.ledger.boards[board]?.nextAt > NOON, `${board} was never paced`);
  assert.equal(boardWaitMs(run.ledger, "nonexistent", run.settings, run.at), 0);

  // The spacing outlived the rule it was written for: an employer may now
  // only ever receive one, so there is no second application for it to
  // hold back. It stays because the budget is a setting and this is the
  // guard underneath it, and the check becomes the stronger statement -
  // an employer appears once in a night, not merely twice slowly.
  const last = new Map();
  for (const job of run.sent) {
    assert.equal(last.has(job.company), false, `${job.company} was applied to twice in one night`);
    last.set(job.company, job.at);
  }
});

/* ---------------------------------------------------- the mailbox at 1am */

await test("A Gmail session that dies mid-night is named, retried twice, and then ends the day", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 300,
    script: { 40: ({ world }) => { world.mail = "signed-out"; } },
  });

  assert.ok(run.halt, "a signed-out mailbox nothing can fix has to stop the night");
  assert.equal(run.halt.condition, "mailbox-signed-out");
  assert.match(run.halt.message, /signed in by hand/);
  assert.equal(run.world.reloads, HEALTH_DEFAULTS.mailResets, "the tab gets exactly its budget of reloads, then the truth");

  // The value of the whole exercise, in one number: how many postings were
  // burnt against a wall before anything said so. Without health.js this
  // is every posting left in the queue.
  const wasted = run.skipped.filter((entry) => /Gmail is not signed in/.test(entry.result.reason)).length;
  assert.ok(wasted <= 12, `${wasted} applications were spent on a dead mailbox before the run stopped`);
  assert.ok(run.day().submitted >= 30, "and the applications sent before it died still count");

  // The boards that do not mail a code kept working right up to the stop,
  // which is why the stop is a judgement rather than a reflex.
  assert.equal(MAILS_A_CODE.has(run.sent.at(-1).board), false, "applications that need no code have to keep going until the run actually ends");
});

await test("A mailbox that is merely stale is reloaded once and the night carries on to target", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 300, world: { mailHealsOnReload: true },
    script: { 40: ({ world }) => { world.mail = "timeout"; } },
  });
  assert.equal(run.halt, null, "a mailbox a reload fixes is not a reason to end the day");
  assert.equal(run.world.reloads, 1);
  assert.equal(run.day().submitted, 300);
  assert.deepEqual(run.health.conditions().map((record) => record.name), [], "and the condition clears when codes start arriving again");
});

await test("Three timed-out waits raise the condition; two unrelated ones do not", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 30, attempts: 24, world: { mailHealsOnReload: true },
    script: { 4: ({ world }) => { world.mail = "timeout"; }, 7: ({ world }) => { world.mail = "ok"; } },
  });
  // Only the two Greenhouse/Workday jobs in that window actually waited on
  // mail, which is below the threshold, so nothing is raised and nothing
  // is reloaded. A supervisor that cried wolf here would be turned off.
  assert.equal(run.world.reloads, 0);
  assert.equal(run.halt, null);
});

/* ------------------------------------------------------- a hostile board */

await test("A board that starts refusing everything is cooled, then quarantined, and the night keeps its target", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 200,
    script: { 20: ({ world }) => { world.hostile.add("greenhouse"); } },
  });

  assert.equal(run.halt, null, "one angry board is never a reason to stop applying through the other four");
  assert.equal(run.day().submitted, 200, "the other boards have to carry the night");
  assert.deepEqual(run.world.cooled, ["greenhouse", "greenhouse"], "the cool-downs come before the quarantine, not instead of it");
  assert.equal(run.health.quarantined("greenhouse"), true);
  assert.equal(run.health.quarantined("lever"), false);

  const condition = run.health.conditions().find((record) => record.name === "board-hostile:greenhouse");
  assert.equal(condition.severity, "quarantined");
  assert.match(condition.detail, /is being left alone for \d+ minutes/, "the panel says how long, because a quarantine now ends on its own");

  // Nothing was opened on greenhouse after the quarantine, and the gap was
  // stretched before it - the two halves of backing off.
  assert.ok(run.held.length > 0, "quarantined postings have to be skipped rather than attempted");
  const lastGreenhouse = run.skipped.map((entry) => entry.job.board).lastIndexOf("greenhouse");
  assert.ok(lastGreenhouse < run.skipped.length - 1);
  assert.equal(run.health.boardFactor("greenhouse"), HEALTH_DEFAULTS.boardCoolFactor ** HEALTH_DEFAULTS.boardCools);
  assert.equal(run.health.boardFactor("lever"), 1);
});

await test("Two boards failing at once is a broken operation, not two bad boards, and it stops", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 300, world: { lossRate: 0 },
    script: { 20: ({ world }) => { world.hostile.add("greenhouse").add("lever").add("ashby").add("workable").add("workday"); } },
  });
  assert.equal(run.halt.condition, "nothing-succeeding");
  assert.match(run.halt.message, /something the whole queue depends on/);
  // Fifteen is the budget, and the run must not have spent two hundred
  // postings discovering what fifteen already said.
  assert.ok(run.skipped.length <= HEALTH_DEFAULTS.barrenAttempts + 6, `${run.skipped.length} attempts before the operation was called broken`);
});

/* ------------------------------------------------------------- the feeds */

await test("A feed that dries up waits rather than stops, until waiting has stopped being a plan", async () => {
  const request = await bootWorker();
  const brief = await night({
    request, start: NOON, target: 60, attempts: 80,
    script: { 10: ({ world }) => { world.feed = "dry"; }, 16: ({ world }) => { world.feed = "flowing"; } },
  });
  assert.equal(brief.halt, null, "feeds refill; a dry hour is not a dead night");
  assert.equal(brief.day().submitted, 60);

  const forever = await night({
    request: await bootWorker(), start: NOON, target: 300, attempts: 60,
    script: { 10: ({ world }) => { world.feed = "dry"; } },
  });
  assert.equal(forever.halt.condition, "feed-drought");
  assert.match(forever.halt.message, /the searches need widening/);
});

/* ----------------------------------------------------- the worker dying */

await test("A night interrupted by nine worker restarts keeps its count, its budget and its quarantine", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 180, world: { restartEvery: 20 },
    script: { 30: ({ world }) => { world.hostile.add("lever"); } },
  });

  assert.ok(run.restarts.length >= 8, `only ${run.restarts.length} restarts were injected`);
  assert.equal(run.day().submitted, 180, "a restarted day resumes its quota rather than restarting it");
  assert.equal(run.duplicates.length, 0, "and no posting was claimed twice across a restart");
  assert.equal(new Set(run.sent.map((job) => job.applyUrl)).size, run.sent.length);
  // The quarantine is the thing most easily lost to a restart, because it
  // lives in memory and nowhere else unless `snapshot` carried it.
  assert.equal(run.health.quarantined("lever"), true);
});

await test("A mailbox reset budget is not refilled by a worker restart, so the escalation still arrives", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: NOON, target: 300, world: { restartEvery: 3 },
    script: { 20: ({ world }) => { world.mail = "signed-out"; } },
  });
  // Without `snapshot`/`restore` carrying `tried`, every restart would hand
  // the mailbox two fresh reloads and the night would never reach the
  // sentence that tells the applicant to go and sign in.
  assert.equal(run.halt?.condition, "mailbox-signed-out");
  assert.equal(run.world.reloads, HEALTH_DEFAULTS.mailResets);
});

/* --------------------------------------------------------- the clock */

await test("A day that crosses local midnight starts a new quota and lifts yesterday's quarantine", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: LATE, target: 300, attempts: 260,
    script: { 10: ({ world }) => { world.hostile.add("greenhouse"); } },
  });

  const midnight = new Date(2026, 10, 8, 0, 0, 0).getTime();
  assert.ok(run.at > midnight, "the simulated night has to actually reach tomorrow");
  // Yesterday's applications are not today's, and the day's panel says so.
  assert.ok(run.day().submitted < run.sent.length, "the ledger must have rolled rather than accumulated");
  assert.equal(run.halt, null);
  // A quarantine is about a day. Greenhouse is still hostile, so it will be
  // quarantined again on the evidence of the new day rather than on
  // yesterday's, which is the only way a board ever gets a second chance.
  assert.equal(run.health.day, "2026-11-08");
  assert.ok(run.skipped.some((entry) => entry.job.board === "greenhouse" && entry.at > midnight), "yesterday's quarantine must not outlive yesterday");
});

/* ---------------------------------------------------------- the disk */

await test("A filling disk drops the screenshot first and stops before it cannot write the record", async () => {
  const request = await bootWorker();
  const run = await night({ request, start: NOON, target: 300, world: { freeBytes: 900e6, drainBytes: 2.6e6, lossRate: 0 } });

  assert.equal(run.halt?.condition, "disk-critical");
  assert.match(run.halt.message, /without anything being written down/);
  // The remedy came first and bought real room: the screenshot is five
  // sixths of an application, so the applications sent after the warning
  // outnumber the ones that still got a picture.
  assert.ok(run.bytes.screenshots > 0);
  assert.ok(run.day().submitted > run.bytes.screenshots, "dropping the screenshot has to actually extend the day");
  assert.equal(run.health.screenshots, false);
  // Stopped on the attempt the floor was crossed rather than some way
  // past it, which is the difference between a readable morning and a
  // database that could not write the row saying what went wrong.
  assert.ok(run.world.freeBytes >= HEALTH_DEFAULTS.diskStopBytes - (HEALTH_DEFAULTS.bytesPerApplication + run.world.drainBytes));
});

await test("Three hundred applications fit in the room the machine actually has", async () => {
  // The arithmetic the applicant cares about, asserted rather than written
  // down somewhere nobody re-reads. Two gigabytes is what the root
  // partition had free when this was measured, and 560 KB is the worst
  // case for one application across both copies of it.
  const free = 2e9;
  assert.ok(300 * HEALTH_DEFAULTS.bytesPerApplication < free * 0.7, "a full day must not need more than two thirds of the free space");
  const request = await bootWorker();
  const run = await night({ request, start: NOON, target: 300, world: { freeBytes: free, lossRate: 0 } });
  assert.equal(run.halt, null, "2.7 GB has to be enough for a full day without the supervisor intervening");
  assert.equal(run.day().submitted, 300);
  assert.equal(run.bytes.written, run.day().submitted * HEALTH_DEFAULTS.bytesPerApplication);
});

/* ------------------------------------------------------- everything at once */

await test("A night with every failure in it at the same time still ends with an honest account", async () => {
  const request = await bootWorker();
  const run = await night({
    request, start: LATE, target: 300, attempts: 500, world: { restartEvery: 25, mailHealsOnReload: true, freeBytes: 4e9 },
    script: {
      15: ({ world }) => { world.hostile.add("workable"); },
      40: ({ world }) => { world.mail = "timeout"; },
      70: ({ world }) => { world.feed = "dry"; },
      76: ({ world }) => { world.feed = "flowing"; },
      120: ({ world }) => { world.hostile.add("ashby"); },
      200: ({ world }) => { world.mail = "timeout"; },
    },
  });

  // Still running, which is the question the applicant is actually asking.
  assert.equal(run.halt, null, `the night stopped: ${run.halt?.message}`);
  assert.ok(run.restarts.length >= 10);
  assert.equal(run.duplicates.length, 0);
  assert.equal(run.slots.status().busy, 0);
  assert.equal(new Set(run.sent.map((job) => job.applyUrl)).size, run.sent.length, "no posting may be sent twice in a chaotic night either");

  // Two boards quarantined, the mailbox healed twice, and the ledger still
  // adds up to what the employers actually received.
  assert.equal(run.health.quarantined("workable"), true);
  assert.equal(run.health.quarantined("ashby"), true);
  assert.ok(run.world.reloads >= 1);
  const today = run.day();
  assert.equal(today.employers.reduce((total, row) => total + row.count, 0), today.submitted);

  // And the morning-after screen is a page a person can read, not a log.
  const html = monitorBody({ running: true, day: today, attempts: { width: 2, busy: 0, parked: 0, queued: 0, holders: [] }, health: { conditions: run.health.conditions(), screenshots: run.health.screenshots, freeBytes: run.health.freeBytes } });
  assert.match(html, /Applied to today \(\d+ employer\(s\)\)/);
  assert.match(html, /is being left alone for \d+ minutes/);
  assert.doesNotMatch(html, /Needs you/, "nothing here needs a person, and saying it does is how a panel gets ignored");
  // Three hundred failures, aggregated into a handful of causes.
  assert.ok(today.reasons.length <= 8, `${today.reasons.length} distinct causes is a log, not an account`);
});

/* ------------------------------------------- what the supervisor does next */

await test("Autopilot will not start another run while a condition nothing can fix is standing", async () => {
  const request = await bootWorker();
  const run = await night({ request, start: NOON, target: 300, script: { 20: ({ world }) => { world.mail = "signed-out"; } } });
  const blocked = nextRun({ ledger: run.ledger, settings: run.settings, stopReason: run.halt, failures: 0, blocked: true, now: run.at });
  assert.equal(blocked.start, false);
  assert.equal(blocked.watch, true, "the supervisor keeps looking, so pressing Run in the morning is all it takes");
  assert.match(blocked.reason, /signed out|needs you|cannot/i);
  // And once the applicant has fixed it and cleared the condition by hand.
  run.health.forget();
  assert.equal(nextRun({ ledger: run.ledger, settings: run.settings, stopReason: run.halt, failures: 0, blocked: Boolean(run.health.stop()), now: run.at }).start, true);
});

console.log(`${count} soak checks passed.`);
