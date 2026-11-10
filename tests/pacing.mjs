/**
 * Board and employer pacing, which used to be a wait inside a worker.
 *
 * Boards publish a ban rather than a rate limit, so an application is
 * held back for forty-five seconds after the last one on that board and
 * twenty minutes after the last one at that employer. Those gaps are not
 * in question here. What was wrong is where the holding back happened:
 * inside `applyCandidate`, after the sender slot had been taken. Six
 * senders carrying six Greenhouse jobs - which is most of what the feeds
 * produce - all sat out the same forty-five seconds together, with
 * finished documents for other boards waiting behind them for a slot.
 *
 * Measured on the three field databases: 95% and 97% of the run span was
 * dead time, against 38 and 14 minutes of actual attempt work.
 *
 * The gaps are the same. The question asked is different: not "may this
 * one go yet", which can only be answered by waiting, but "which of these
 * may go now", which is answered immediately or not at all.
 */
import assert from 'node:assert/strict';
import { stagedBatch } from '../src/pipeline.js';

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// A batch left looping holds the process open, so each one that is not
// awaited to its end is stopped before the next test starts.
const halt = [];
const stopAll = () => { while (halt.length) halt.pop()(); };
const stopping = () => { let flag = false; halt.push(() => { flag = true; }); return () => flag; };
const settle = async (times = 80) => { for (let i = 0; i < times; i += 1) await tick(); };
const passthrough = { extract: (e) => e, screen: (e) => e, choose: (items) => items };

/** Twelve postings, two thirds of them on the board that is being paced. */
const postings = () => [
  { id: 0, board: 'greenhouse' }, { id: 1, board: 'greenhouse' }, { id: 2, board: 'greenhouse' },
  { id: 3, board: 'ashby' }, { id: 4, board: 'greenhouse' }, { id: 5, board: 'workday' },
  { id: 6, board: 'greenhouse' }, { id: 7, board: 'greenhouse' }, { id: 8, board: 'greenhouse' },
];

await test('a paced board does not hold the senders that could be working another one', async () => {
  // Greenhouse is held back from the first instant; everything else is
  // free. The senders are the six of the shipped budget.
  const held = new Set(['greenhouse']);
  const sent = [];
  const run = stagedBatch(postings(), {
    ...passthrough,
    prepare: async (job) => job,
    apply: async (job) => { sent.push(job.id); await new Promise(() => {}); },
    remaining: () => 9,
    prepareConcurrency: 4,
    readyBacklog: 10,
    applyConcurrency: 6,
    pickReady: (ready) => ready.findIndex((job) => !held.has(job.board)),
    readyPauseMs: 1,
    stopped: stopping(),
  });
  await settle();

  assert.deepEqual(sent, [3, 5], 'the two free boards went; the paced one waited without taking a slot');

  // The gap elapses. Nothing had to be polled, re-prepared or re-queued.
  held.clear();
  await settle(200);
  assert.deepEqual(sent.slice(0, 2), [3, 5]);
  assert.equal(sent.length, 6, 'the senders fill up the moment the board is free');
  run.catch(() => {}); stopAll();
});

await test('the writer keeps writing while every finished document is paced', async () => {
  // The case the old code could not express at all: nothing may be sent,
  // and there is still work worth doing.
  let written = 0;
  const run = stagedBatch(Array.from({ length: 20 }, (_, id) => ({ id })), {
    ...passthrough,
    prepare: async (job) => { written += 1; return job; },
    apply: async () => { await new Promise(() => {}); },
    remaining: () => 20,
    prepareConcurrency: 4,
    readyBacklog: 10,
    applyConcurrency: 6,
    pickReady: () => -1,
    readyPauseMs: 1,
    stopped: stopping(),
  });
  await settle(200);
  assert.equal(written, 10, `the backlog filled while nothing could be sent (wrote ${written})`);
  run.catch(() => {}); stopAll();
});

await test('a batch whose every document is paced forever still answers Stop', async () => {
  let stopping = false;
  const started = Date.now();
  const run = stagedBatch(Array.from({ length: 20 }, (_, id) => ({ id })), {
    ...passthrough,
    prepare: async (job) => job,
    apply: async () => { await new Promise(() => {}); },
    remaining: () => 20,
    prepareConcurrency: 4,
    readyBacklog: 10,
    applyConcurrency: 6,
    pickReady: () => -1,
    readyPauseMs: 5,
    stopGraceMs: 10,
    stopped: () => stopping,
  });
  setTimeout(() => { stopping = true; }, 60);
  await run;
  assert.ok(Date.now() - started < 2000, 'a paced batch is not a batch that cannot be stopped');
});

await test('left unset, the oldest finished document goes first and nothing changes', async () => {
  const sent = [];
  const run = stagedBatch(Array.from({ length: 4 }, (_, id) => ({ id })), {
    ...passthrough,
    prepare: async (job) => job,
    apply: async (job) => { sent.push(job.id); },
    remaining: () => 4,
    prepareConcurrency: 1,
    applyConcurrency: 1,
  });
  await run;
  assert.deepEqual(sent, [0, 1, 2, 3]);
});

console.log(`\n${count} pacing checks passed.`);
