/**
 * How many applications may be in flight, and what a waiting one gives back.
 *
 * ## The arithmetic this exists to fix
 *
 * One Greenhouse application measured a hundred and sixty-four seconds end
 * to end. A hundred and twenty-seven of those were spent after Submit,
 * polling Gmail for an eight-digit code. The form was finished, the tab
 * just sat there, and because `stagedBatch` sends one application at a
 * time, so did the entire run: three quarters of the day would be the bot
 * watching a mailbox.
 *
 * `apply/verification.js` already fixed half of this - its waits are
 * registered rather than held, so the *foreground* is free during them
 * (see tabs.js for why one tab on screen is the hard constraint). But a
 * free foreground is worth nothing if there is no second application to
 * use it. This file is the other half: a bounded number of attempts in
 * flight, and an attempt that is waiting on something outside the browser
 * hands its slot to whoever is next in line.
 *
 * ## Why the slot comes back rather than the attempt restarting
 *
 * A code expires. An attempt that gave up its slot at Submit has to get
 * one again to type the eight digits, and it queues for it like everyone
 * else, in order. That bounds how long it can be kept out - one active
 * attempt's turn, not the rest of the run - which is why the queue is FIFO
 * and why `width` stays small. Fairness here is not politeness; it is the
 * difference between typing a code and watching it expire.
 */

export function createSlots({ limit = 1, now = () => Date.now(), onChange = () => {} } = {}) {
  let width = Math.max(1, Math.floor(limit) || 1);
  let serial = 0;
  const entries = new Map();
  const queue = [];

  // A parked attempt is still an attempt - the monitor must be able to say
  // "waiting for an emailed security code, four minutes" rather than show
  // nothing - but it does not count against the width.
  const busy = () => [...entries.values()].filter((entry) => !entry.parked).length;
  const status = () => ({ width, busy: busy(), parked: [...entries.values()].filter((entry) => entry.parked).length, queued: queue.length, holders: [...entries.values()].map((entry) => ({ id: entry.id, company: entry.company ?? "", board: entry.board ?? "", stage: entry.stage ?? "", waitingFor: entry.waitingFor ?? "", parked: entry.parked, abandoned: entry.abandoned === true, forMs: now() - entry.since })) });
  const emit = () => onChange(status());
  const pump = () => {
    while (busy() < width && queue.length) queue.shift()();
  };
  const acquire = (id) =>
    new Promise((resolve) => {
      // An abandoned attempt is let through without a slot. It is still
      // running somewhere - nothing here can kill a half-filled form - and
      // queueing it would hand the pipe back to work the queue has already
      // written off.
      if (!entries.has(id) || entries.get(id).abandoned) {
        resolve();
        return;
      }
      queue.push(() => {
        const entry = entries.get(id);
        if (entry) {
          entry.parked = false;
          entry.waitingFor = "";
          entry.since = now();
        }
        resolve();
      });
      pump();
      emit();
    });
  const free = (id) => {
    entries.delete(id);
    pump();
    emit();
  };

  return {
    status,
    /** Changing the width mid-run lets a fallback narrow the pipe without stopping it. */
    resize(value) {
      width = Math.max(1, Math.floor(value) || 1);
      pump();
      emit();
    },
    /**
     * Run one attempt in a slot. `work` is handed a handle it can use to
     * say what it is doing and to step out of the way while it waits.
     */
    async hold(label, work, { deadlineMs = 0 } = {}) {
      const id = ++serial;
      entries.set(id, { id, ...label, parked: true, abandoned: false, stage: "", waitingFor: "", since: now() });
      await acquire(id);
      // The pool reclaims the slot at the deadline because it owns the
      // slot; the caller decides separately what an abandoned attempt
      // means for the record. Both have to happen, and neither can wait
      // for the attempt itself, which by then is the thing not answering.
      const timer = deadlineMs > 0 ? setTimeout(() => {
        const entry = entries.get(id);
        if (!entry) return;
        entry.abandoned = true;
        entry.parked = true;
        entry.waitingFor = "nothing; the queue stopped waiting for this attempt";
        pump();
        emit();
      }, deadlineMs) : null;
      const handle = {
        note(stage) {
          const entry = entries.get(id);
          if (entry) {
            entry.stage = stage;
            emit();
          }
        },
        /**
         * The whole point of the file. Whatever happens inside here runs
         * with no slot held, so the next attempt starts immediately; when
         * it returns, this attempt queues for a slot again before carrying
         * on, because what comes next is page work and page work needs the
         * front.
         */
        async waiting(what, wait) {
          const entry = entries.get(id);
          if (entry) {
            entry.parked = true;
            entry.waitingFor = what;
          }
          pump();
          emit();
          try {
            return await wait();
          } finally {
            await acquire(id);
          }
        },
      };
      try {
        return await work(handle);
      } finally {
        clearTimeout(timer);
        free(id);
      }
    },
  };
}
