/**
 * Where a night's idle time actually goes, measured rather than guessed.
 *
 * ## The question
 *
 * "There must be no time that extension is ideling. How about: job
 * scraping & validating & resume generating has 5 chatgpts, and applying
 * and other actions use another 5 workers, so module 1 and module 2 work
 * independently."
 *
 * The instinct is right and the mechanism needs checking, so this
 * measures the thing both halves of the argument are about: what
 * fraction of a night each resource spends doing nothing.
 *
 * ## How
 *
 * The real `stagedBatch` and the real `ChatWorkerPool`, driven with the
 * same barriers `run()` puts around them - discover, then batch, then
 * the next batch only once the last has fully drained. One simulated
 * second is one real millisecond. The durations are the ones the code's
 * own comments quote: a six-minute ChatGPT deadline, a twelve-minute
 * attempt deadline, page loads in the tens of seconds.
 *
 * Utilisation is sampled against wall time, so "ChatGPT idle" means tabs
 * that could have been writing and were not.
 *
 * ## Four shapes
 *
 * `batched` is what runs today. `split` is the proposal as stated: two
 * independent pools, one for discovery and writing, one for applying.
 * `streaming` keeps one shared pool but removes the stage barriers, so
 * extraction, screening, writing and applying all run continuously off
 * queues. `streaming+priority` adds the one thing the split was really
 * after: a form waiting on an answer jumps the queue ahead of resume
 * writing, because the form is holding a browser tab and the resume is
 * not holding anything.
 */
import { stagedBatch } from '../src/pipeline.js';
import { ChatWorkerPool } from '../src/chat-workers.js';

const SECOND = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Durations in simulated seconds, from the run loop's own comments and defaults. */
const COST = {
  discover: 40,
  extract: 8,
  screen: 20,
  prepare: 95,
  applyBrowser: 120,
  applyAnswers: 25,
};

function meter(capacity) {
  let busy = 0, area = 0, last = Date.now();
  const mark = () => { const now = Date.now(); area += busy * (now - last); last = now; };
  return {
    take() { mark(); busy++; },
    give() { mark(); busy--; },
    utilisation(totalMs) { mark(); return area / (capacity * totalMs); },
  };
}

/** What runs today: discovery, then batches, each drained before the next. */
async function batched({ workers, attempts, batchSize, backlog, rounds, perRound, overlapDiscovery = false }) {
  const chat = meter(workers), sender = meter(attempts);
  const pool = new ChatWorkerPool(workers);
  const ask = (seconds) => pool.run(async () => { chat.take(); try { await sleep(seconds * SECOND); } finally { chat.give(); } });
  const started = Date.now();
  let sent = 0;
  // Discovery is a browser tab reading a board; it needs no ChatGPT and
  // no application slot, so whether it blocks the rest is a choice.
  const scrape = (round) => sleep(COST.discover * SECOND).then(() => Array.from({ length: perRound }, (_, i) => ({ id: `${round}:${i}` })));
  let ahead = overlapDiscovery ? scrape(0) : null;
  for (let round = 0; round < rounds; round++) {
    const fresh = overlapDiscovery ? await ahead : await scrape(round);
    if (overlapDiscovery) ahead = round + 1 < rounds ? scrape(round + 1) : Promise.resolve([]);
    for (let offset = 0; offset < fresh.length; offset += batchSize) {
      await stagedBatch(fresh.slice(offset, offset + batchSize), {
        extract: async (job) => { await sleep(COST.extract * SECOND); return job; },
        screen: async (job) => { await ask(COST.screen); return job; },
        choose: (jobs) => jobs,
        prepare: async (job) => { await ask(COST.prepare); return job; },
        apply: async () => {
          sender.take();
          try {
            await sleep((COST.applyBrowser / 2) * SECOND);
            await ask(COST.applyAnswers);
            await sleep((COST.applyBrowser / 2) * SECOND);
            sent++;
          } finally { sender.give(); }
        },
        remaining: () => Infinity,
        prepareConcurrency: workers, screenConcurrency: workers, applyConcurrency: attempts,
        readyBacklog: backlog, pickReady: () => 0, stopped: () => false, phase: () => {},
      });
    }
  }
  const elapsed = Date.now() - started;
  pool.stop();
  return { sent, elapsed, chat: chat.utilisation(elapsed), sender: sender.utilisation(elapsed) };
}

/**
 * A stage that runs continuously off a queue instead of in a batch.
 *
 * `width` of these pull from `inbox` for as long as the night lasts and
 * push what they produce into `outbox`, so a slow job holds up nothing
 * but its own worker.
 */
function stage({ width, inbox, outbox, work, done }) {
  return Promise.all(Array.from({ length: width }, async () => {
    for (;;) {
      const item = await inbox.take();
      if (item === null) return;
      const value = await work(item);
      if (value && outbox) outbox.put(value);
      done?.();
    }
  }));
}

/** A queue a stage can wait on, with an end-of-night signal. */
function channel(cap = Infinity) {
  const items = [], waiting = [];
  let closed = false;
  return {
    size: () => items.length,
    full: () => items.length >= cap,
    put(value) { const next = waiting.shift(); if (next) next(value); else items.push(value); },
    close() { closed = true; while (waiting.length) waiting.shift()(null); },
    take() {
      if (items.length) return Promise.resolve(items.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/**
 * No stage barriers: every stage runs for the whole night off a queue.
 *
 * `pools.write` and `pools.answer` are the same object unless the caller
 * splits them, which is how the proposal as stated gets measured against
 * the same clock as everything else.
 */
async function streaming({ workers, attempts, rounds, perRound, backlog, pools, priority = false }) {
  const write = pools.write, answer = pools.answer;
  const chat = meter(write === answer ? workers : write.configured + answer.configured);
  const sender = meter(attempts);
  const askWrite = (seconds) => write.run(async () => { chat.take(); try { await sleep(seconds * SECOND); } finally { chat.give(); } });
  const askAnswer = (seconds) => answer.run(async () => { chat.take(); try { await sleep(seconds * SECOND); } finally { chat.give(); } }, { urgent: priority });

  const found = channel(), read = channel(), eligible = channel(), ready = channel(backlog);
  const started = Date.now();
  let sent = 0;

  const discovery = (async () => {
    for (let round = 0; round < rounds; round++) {
      await sleep(COST.discover * SECOND);
      for (let i = 0; i < perRound; i++) found.put({ id: `${round}:${i}` });
    }
    found.close();
  })();

  const extracting = stage({ width: 3, inbox: found, outbox: read, work: async (job) => { await sleep(COST.extract * SECOND); return job; } });
  const screening = stage({ width: 2, inbox: read, outbox: eligible, work: async (job) => { await askWrite(COST.screen); return job; } });
  const preparing = stage({
    width: workers, inbox: eligible, outbox: ready,
    // The backlog bound lives here: a writer that has filled the pile
    // waits for the senders rather than writing documents that go stale.
    work: async (job) => { while (ready.full()) await sleep(5); await askWrite(COST.prepare); return job; },
  });
  const sending = stage({
    width: attempts, inbox: ready, work: async () => {
      sender.take();
      try {
        await sleep((COST.applyBrowser / 2) * SECOND);
        await askAnswer(COST.applyAnswers);
        await sleep((COST.applyBrowser / 2) * SECOND);
        sent++;
      } finally { sender.give(); }
    },
  });

  await discovery; await extracting; read.close();
  await screening; eligible.close();
  await preparing; ready.close();
  await sending;
  const elapsed = Date.now() - started;
  write.stop(); if (answer !== write) answer.stop();
  return { sent, elapsed, chat: chat.utilisation(elapsed), sender: sender.utilisation(elapsed) };
}

/**
 * A pool past the shipped ceiling, for the comparison that decides this.
 *
 * `ChatWorkerPool` clamps at WIDEST, so two pools of four is not a
 * reorganisation of the same budget - it is eight concurrent requests
 * where the shipped code allows four, and comparing it against four
 * would credit the split with a win that came from the extra tabs. This
 * lifts the clamp so eight shared can be measured against four plus
 * four on equal terms.
 */
const widePool = (limit, reserve = 0) => { const pool = new ChatWorkerPool(1, () => {}, { reserve }); pool.configured = limit; pool.limit = limit; pool.reserve = reserve; return pool; };

/**
 * The shippable shape: `choose` still sees a set, but a small one, and
 * the prepare/apply engine never stops between sets.
 *
 * `choose` cannot be made streaming - it scores a whole group in one
 * ChatGPT call and picks the best role per employer across it, and fed
 * one job at a time it would apply to the first role it saw rather than
 * the best. So it keeps a window. What goes is the barrier *around* it:
 * extraction and screening run continuously, and the writers and senders
 * carry on with the previous window while the next one is being screened.
 */
async function windowed({ workers, attempts, rounds, perRound, backlog, window: windowSize, reserve = 1 }) {
  const pool = new ChatWorkerPool(1, () => {}, { reserve });
  pool.configured = workers; pool.limit = workers; pool.reserve = Math.min(reserve, workers - 1);
  const chat = meter(workers), sender = meter(attempts);
  const ask = (seconds, urgent = false) => pool.run(async () => { chat.take(); try { await sleep(seconds * SECOND); } finally { chat.give(); } }, { urgent });

  const found = channel(), read = channel(), screened = channel(), ready = channel(backlog);
  const started = Date.now();
  let sent = 0;

  const discovery = (async () => {
    for (let round = 0; round < rounds; round++) {
      await sleep(COST.discover * SECOND);
      for (let i = 0; i < perRound; i++) found.put({ id: `${round}:${i}` });
    }
    found.close();
  })();
  const extracting = stage({ width: 3, inbox: found, outbox: read, work: async (job) => { await sleep(COST.extract * SECOND); return job; } });
  const screening = stage({ width: 2, inbox: read, outbox: screened, work: async (job) => { await ask(COST.screen); return job; } });
  // Groups of `windowSize`, or whatever has arrived when the stream ends.
  const chosen = channel();
  const choosing = (async () => {
    let group = [];
    for (;;) {
      const item = await screened.take();
      if (item !== null) group.push(item);
      if (group.length >= windowSize || (item === null && group.length)) { for (const value of group) chosen.put(value); group = []; }
      if (item === null) break;
    }
    chosen.close();
  })();
  const preparing = stage({ width: workers, inbox: chosen, outbox: ready, work: async (job) => { while (ready.full()) await sleep(5); await ask(COST.prepare); return job; } });
  const sending = stage({ width: attempts, inbox: ready, work: async () => {
    sender.take();
    try { await sleep((COST.applyBrowser / 2) * SECOND); await ask(COST.applyAnswers, true); await sleep((COST.applyBrowser / 2) * SECOND); sent++; }
    finally { sender.give(); }
  } });

  await discovery; await extracting; read.close();
  await screening; screened.close();
  await choosing;
  await preparing; ready.close();
  await sending;
  const elapsed = Date.now() - started;
  pool.stop();
  return { sent, elapsed, chat: chat.utilisation(elapsed), sender: sender.utilisation(elapsed) };
}

const shape = { workers: 4, attempts: 4, batchSize: 12, backlog: 12, rounds: 3, perRound: 24 };
const one = new ChatWorkerPool(shape.workers);
const eight = widePool(8);
const results = {
  'batched (today), 4 tabs': await batched(shape),
  'streaming, 4 shared tabs': await streaming({ ...shape, pools: { write: one, answer: one } }),
  'split, 4 write + 4 answer (8 tabs)': await streaming({ ...shape, pools: { write: widePool(4), answer: widePool(4) } }),
  'streaming, 8 shared tabs': await streaming({ ...shape, workers: 8, pools: { write: eight, answer: eight } }),
};
results['batched, whole round as one batch'] = await batched({ ...shape, batchSize: shape.perRound, backlog: shape.perRound });
results['batched + overlapped discovery'] = await batched({ ...shape, overlapDiscovery: true });
results['batched, one batch + overlapped discovery'] = await batched({ ...shape, batchSize: shape.perRound, backlog: shape.perRound, overlapDiscovery: true });
results['windowed choose + continuous engine, 4 tabs'] = await windowed({ ...shape, window: 8 });
for (const [label, workers, reserve] of [['4 shared tabs', 4, 1], ['8 shared tabs', 8, 1]]) {
  const pool = widePool(workers, reserve);
  results[`streaming + priority, ${label}`] = await streaming({ ...shape, workers, pools: { write: pool, answer: pool }, priority: true });
}

const pct = (value) => `${Math.round(value * 100)}%`;
const hours = (ms) => (ms * 1000 / 3600000);
console.log(`\n${shape.rounds} discovery rounds x ${shape.perRound} postings · ${shape.workers} ChatGPT workers · ${shape.attempts} application slots\n`);
console.log('shape                                 sent   hours   ChatGPT busy   slots busy   apps/hour');
for (const [name, value] of Object.entries(results)) {
  console.log(`${name.padEnd(37)} ${String(value.sent).padStart(4)}   ${hours(value.elapsed).toFixed(2)}h   ${pct(value.chat).padStart(11)}   ${pct(value.sender).padStart(10)}   ${(value.sent / hours(value.elapsed)).toFixed(1).padStart(9)}`);
}
console.log();
