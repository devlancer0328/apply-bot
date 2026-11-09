/**
 * The writer running ahead of the form filler.
 *
 * One number used to govern both how many resumes ChatGPT wrote at once
 * and how many finished ones could wait to be sent, and that number was
 * two. So the half that needs only ChatGPT was pinned to the half that
 * needs a browser, a board that is answering and sometimes a person -
 * and a single captcha idled both. These check the two limits now move
 * independently, and that the batch handed to the pipeline is no longer
 * clamped down to the worker count.
 */
import assert from 'node:assert/strict';
import { stagedBatch } from '../src/pipeline.js';
import { SCHEDULE_DEFAULTS, withScheduleDefaults } from '../src/schedule.js';

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };

const never = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const jobs = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
const passthrough = { extract: (e) => e, screen: (e) => e, choose: (items) => items };

await test('the writer fills the backlog while the filler is stuck on one job', async () => {
  let written = 0, sending = 0;
  const run = stagedBatch(jobs(20), {
    ...passthrough,
    prepare: async (job) => { written += 1; return job; },
    // The first application never finishes - a captcha, or a board that
    // stopped answering. Before, this stopped the writer two jobs later.
    apply: async () => { sending += 1; await never(); },
    remaining: () => 20,
    prepareConcurrency: 4,
    readyBacklog: 10,
    applyConcurrency: 1,
  });
  for (let i = 0; i < 60; i += 1) await tick();

  assert.equal(sending, 1, 'the filler is holding exactly one stuck application');
  // Ten banked plus the one in the filler's hands.
  assert.equal(written, 11, `the writer banked a full backlog, not two (wrote ${written})`);
  run.catch(() => {});
});

await test('the backlog is a ceiling, not a target', async () => {
  let written = 0;
  const run = stagedBatch(jobs(30), {
    ...passthrough,
    prepare: async (job) => { written += 1; return job; },
    apply: async () => { await never(); },
    remaining: () => 30,
    prepareConcurrency: 2,
    readyBacklog: 4,
    applyConcurrency: 1,
  });
  for (let i = 0; i < 60; i += 1) await tick();
  assert.equal(written, 5, 'four banked plus the one being sent, and no further');
  run.catch(() => {});
});

await test('ChatGPT is never asked for more preparations at once than it was given', async () => {
  let live = 0, peak = 0;
  const run = stagedBatch(jobs(20), {
    ...passthrough,
    prepare: async (job) => { live += 1; peak = Math.max(peak, live); await tick(); live -= 1; return job; },
    apply: async () => { await never(); },
    remaining: () => 20,
    prepareConcurrency: 3,
    readyBacklog: 12,
    applyConcurrency: 1,
  });
  for (let i = 0; i < 80; i += 1) await tick();
  assert.ok(peak <= 3, `a deep backlog must not widen the writer itself (peaked at ${peak})`);
  run.catch(() => {});
});

await test('left unset, the backlog is the old behaviour and nothing changes', async () => {
  let written = 0;
  const run = stagedBatch(jobs(20), {
    ...passthrough,
    prepare: async (job) => { written += 1; return job; },
    apply: async () => { await never(); },
    remaining: () => 20,
    prepareConcurrency: 2,
    applyConcurrency: 1,
  });
  for (let i = 0; i < 60; i += 1) await tick();
  assert.equal(written, 3, 'two in hand plus the one being sent');
  run.catch(() => {});
});

await test('the shipped budget is ten workers, split four writing and six sending', () => {
  assert.equal(SCHEDULE_DEFAULTS.attemptConcurrency, 6);
  assert.equal(SCHEDULE_DEFAULTS.documentBacklog, 10);
  // Six is now reachable; it used to be clamped to four.
  assert.equal(withScheduleDefaults({ attemptConcurrency: 6 }).attemptConcurrency, 6);
  assert.equal(withScheduleDefaults({ attemptConcurrency: 99 }).attemptConcurrency, 6);
  // Clamped rather than defaulted, the same as every other count in the
  // day plan: a stored nought means "as few as possible", not "unset".
  assert.equal(withScheduleDefaults({ documentBacklog: 0 }).documentBacklog, 1);
  assert.equal(withScheduleDefaults({ documentBacklog: 999 }).documentBacklog, 40);
  assert.equal(withScheduleDefaults({}).documentBacklog, SCHEDULE_DEFAULTS.documentBacklog);
});

console.log(`${count} backlog and worker-budget checks passed.`);
