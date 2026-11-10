/**
 * How much of a night each half of the run spends doing nothing.
 *
 * ## The report
 *
 * "There must be no time that extension is ideling. How about: job
 * scraping & validating & resume generating has 5 chatgpts, and applying
 * and other actions use another 5 workers, so module 1 and module 2 work
 * independently."
 *
 * The idle was real and the diagnosis was close. Writing and applying
 * already overlapped inside a batch - `stagedBatch` has run them
 * together since the backlog was added - so the two modules were not
 * taking turns. What they were both waiting for was the *opening* of
 * every batch: each slice of postings was read in full, then screened in
 * full, and only then did the first resume get written. For as long as
 * that took, no document was being written and no form was being filled.
 *
 * ## What this measures
 *
 * The real `stagedBatch` and the real `ChatWorkerPool`, driven the way
 * `run()` drives them. One simulated second is one real millisecond.
 * Durations are the ones the code's own comments quote: page loads in
 * the tens of seconds, a ChatGPT reply in a minute or two, an attempt in
 * a couple of minutes.
 *
 * Shapes are interleaved and repeated, and the median is reported,
 * because a single pass of each picks up whatever else the machine was
 * doing at the time - early runs of this swung by ten per cent between
 * passes and made a 36% gain look available that was not.
 *
 * ## What it concluded
 *
 * Two independent pools do work, but not for the reason proposed: at the
 * same tab count a single shared pool with priority matches them. The
 * gain comes from removing the barriers and from form answers not
 * queueing behind resume writing, never from the partition - and a fixed
 * partition guarantees idle tabs whenever one module is quiet, which is
 * the disease rather than the cure. Doubling to eight tabs buys roughly
 * another 15%, at the cost of doubling concurrent load on one ChatGPT
 * account, where a 429 closes the pool for the rest of the night.
 *
 * Run it directly; it is a benchmark, not a pass/fail test.
 */
import { stagedBatch } from '../src/pipeline.js';
import { ChatWorkerPool } from '../src/chat-workers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated seconds. */
const COST = { discover: 40, extract: 8, screen: 20, prepare: 95, applyBrowser: 120, applyAnswers: 25 };
const SHAPE = { workers: 4, attempts: 4, batchSize: 12, backlog: 12, rounds: 3, perRound: 24 };

function meter(capacity) {
  let busy = 0, area = 0, last = Date.now();
  const mark = () => { const now = Date.now(); area += busy * (now - last); last = now; };
  return { take() { mark(); busy++; }, give() { mark(); busy--; }, of(total) { mark(); return area / (capacity * total); } };
}

/**
 * One night.
 *
 * `barriers` is the old shape: a slice at a time, each drained before the
 * next is read. `wholeRound` is what ships now - the round handed over in
 * one call, with the screening size as the window `choose` sees rather
 * than as a wall across the pipeline. `reserve` keeps a worker back for
 * form answers and marks them urgent; `overlap` scrapes the next board
 * while the current round is being worked.
 */
async function night({ wholeRound = false, reserve = 0, overlap = false, workers = SHAPE.workers, tabs = 0 }) {
  const { attempts, batchSize, backlog, rounds, perRound } = SHAPE;
  const pool = new ChatWorkerPool(1, () => {}, { reserve });
  pool.configured = workers; pool.limit = workers; pool.reserve = Math.min(reserve, workers - 1);
  const chat = meter(tabs || workers), slot = meter(attempts);
  const ask = (seconds, urgent = false) => pool.run(async () => { chat.take(); try { await sleep(seconds); } finally { chat.give(); } }, { urgent });

  const started = Date.now();
  let sent = 0;
  const scrape = () => sleep(COST.discover).then(() => Array.from({ length: perRound }, (_, i) => ({ id: i })));
  let ahead = overlap ? scrape() : null;

  for (let round = 0; round < rounds; round++) {
    const fresh = overlap ? await ahead : await scrape();
    if (overlap) ahead = round + 1 < rounds ? scrape() : Promise.resolve([]);
    const step = wholeRound ? fresh.length : batchSize;
    for (let offset = 0; offset < fresh.length; offset += step) {
      await stagedBatch(wholeRound ? fresh : fresh.slice(offset, offset + batchSize), {
        chooseWindow: wholeRound ? batchSize : 0,
        extract: async (job) => { await sleep(COST.extract); return job; },
        screen: async (job) => { await ask(COST.screen); return job; },
        choose: (jobs) => jobs,
        prepare: async (job) => { await ask(COST.prepare); return job; },
        apply: async () => {
          slot.take();
          try {
            await sleep(COST.applyBrowser / 2);
            await ask(COST.applyAnswers, reserve > 0);
            await sleep(COST.applyBrowser / 2);
            sent++;
          } finally { slot.give(); }
        },
        remaining: () => Infinity,
        prepareConcurrency: workers, screenConcurrency: workers, applyConcurrency: attempts,
        readyBacklog: backlog, pickReady: () => 0, stopped: () => false, phase: () => {},
      });
    }
  }
  const elapsed = Date.now() - started;
  pool.stop();
  return { rate: sent / (elapsed * 1000 / 3600000), chat: chat.of(elapsed), slot: slot.of(elapsed) };
}

const SHAPES = {
  'before: a slice at a time': { },
  'after: round + window + priority': { wholeRound: true, reserve: 1, overlap: true },
  'after, at 8 tabs': { wholeRound: true, reserve: 1, overlap: true, workers: 8, tabs: 8 },
};

const passes = 5;
const runs = Object.fromEntries(Object.keys(SHAPES).map((name) => [name, []]));
for (let pass = 0; pass < passes; pass++) {
  for (const [name, options] of Object.entries(SHAPES)) runs[name].push(await night(options));
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pct = (value) => `${Math.round(value * 100)}%`;

console.log(`\n${SHAPE.rounds} discovery rounds x ${SHAPE.perRound} postings · ${SHAPE.attempts} application slots · median of ${passes} interleaved passes\n`);
console.log('shape                              apps/hour   ChatGPT busy   slots busy');
const base = median(runs['before: a slice at a time'].map((value) => value.rate));
for (const [name, values] of Object.entries(runs)) {
  const rate = median(values.map((value) => value.rate));
  const change = name.startsWith('before') ? '' : `   ${rate > base ? '+' : ''}${Math.round((rate / base - 1) * 100)}%`;
  console.log(`${name.padEnd(34)} ${rate.toFixed(1).padStart(9)}   ${pct(median(values.map((v) => v.chat))).padStart(12)}   ${pct(median(values.map((v) => v.slot))).padStart(10)}${change}`);
}
console.log();
