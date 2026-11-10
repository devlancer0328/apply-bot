/**
 * The day's quota, the pace it is spent at, and when the next run starts.
 *
 * A run used to be a thing with a beginning and an end: press Run, work the
 * feeds, stop. Three hundred applications a day is thirteen hours at the
 * measured hundred and sixty-four seconds an application, so "a run" and "a
 * day" cannot stay the same object. The day is this file: a ledger that
 * outlives the service worker, a target counted against it, a pace that
 * keeps one board from seeing three hundred posts from one address in an
 * afternoon, and the rule for whether the next run starts now, in twenty
 * minutes, or not at all.
 *
 * Two decisions are recorded here because they are the ones a reader will
 * want to argue with. The first is that the day is *not* paced globally:
 * spreading three hundred over twenty-four hours would be twelve an hour,
 * and the measured ceiling is close enough to that number that a global
 * pace would guarantee the target is missed. So the run goes flat out and
 * only the per-board gap holds it back. The second is that Stop means stop
 * - pressing it turns autopilot off - because a supervisor that restarts a
 * run the person just stopped is a bot nobody can switch off.
 *
 * Nothing here touches `chrome`. The storage and the clock are handed in,
 * so the whole policy runs in the throughput fixtures without a browser.
 */

export const SCHEDULE_DEFAULTS = {
  /** Confirmed submissions wanted in a calendar day. Zero means no ceiling. */
  dailyTarget: 300,
  /**
   * Applications in flight at once.
   *
   * Two, because the bottleneck is dead time rather than work: of the
   * hundred and sixty-four seconds a Greenhouse application took, a
   * hundred and twenty-seven were spent waiting for an emailed code, and a
   * waiting attempt gives its slot back (see slots.js). Two covers the
   * common shape - one form being filled while one waits on its mail -
   * without putting a third Gmail reader and a third loading tab in front
   * of a browser that can only render one of them at speed.
   *
   * Six now, not two. The reasoning above still holds for one board on
   * one machine, but it was sizing the slowest half of the run against
   * itself: a night of it submitted nine applications in seven hours.
   * This is the sending half of a ten-worker budget, the writing half
   * being `chatGptConcurrency`.
   */
  attemptConcurrency: 6,

  /**
   * Finished resumes allowed to pile up ahead of the form filler.
   *
   * The writer needs only ChatGPT and the filler needs a browser, a
   * board that is answering and sometimes a person; tying the first to
   * the second meant a captcha stopped both. Ten is about a quarter of
   * an hour of writing banked against the filler being stuck, and is
   * bounded because documents stale: compensation research inside one
   * expires after six hours.
   */
  documentBacklog: 6,
  /** Smallest gap between two application starts on the same board. */
  boardGapMs: 45000,
  /**
   * Applications one employer may receive. Not in a day - at all.
   *
   * This was three, and the reasoning was supply: one per employer turns
   * "three hundred applications" into "three hundred employers never
   * applied to before", which is nine thousand a month and more than the
   * feeds hold. That arithmetic has not changed and the rule is one
   * anyway, because what it costs is applications and what it buys is
   * not looking like a bot to the one reader who matters. Three resumes
   * from the same candidate in a week is a pattern a recruiter sees.
   *
   * It is a day budget by construction - the tally rolls at midnight -
   * so the permanence comes from the other half, the history index in
   * background.js, which refuses an employer this bot has ever sent to.
   * This stays at one so the two agree rather than the budget quietly
   * allowing a second the index then refuses at the last gate.
   */
  perCompanyPerDay: 1,
  /**
   * Smallest gap between two application starts at the same employer.
   *
   * The budget above says three are allowed; this says they do not arrive
   * together. Twenty minutes costs nothing in practice because the queue
   * works other employers while one waits, and it is the difference between
   * three applications an afternoon and three inside a minute.
   */
  employerGapMs: 20 * 60000,
  /** An attempt the queue stops waiting for. Its slot is freed and the reason recorded. */
  attemptDeadlineMs: 12 * 60000,
  /** Workday is an account, a mailed activation and a wizard, so it gets longer. */
  wizardDeadlineMs: 25 * 60000,
  /**
   * Keep starting runs until the day's target is met, unattended.
   *
   * On by default, because a single run is not what this is for. A run
   * ends whenever the loaded links are done, the feeds report nothing
   * new, or Chrome tears the service worker down mid-attempt - and with
   * nothing to start the next one, the day ends there. A machine that
   * ran a night with this off finished its queue before one in the
   * morning and did nothing for the six hours after it.
   *
   * Pressing Stop still turns it off, which is the only thing that
   * should: a supervisor that restarts a run a minute after somebody
   * stopped it is a bot that cannot be switched off.
   */
  autopilot: true,
  /** After an ordinary finish. */
  idleRetryMs: 60000,
  /** After the feeds reported nothing new: they refill, but not in a minute. */
  exhaustedRetryMs: 10 * 60000,
  /** First back-off after a run stopped on an error; doubles, to six times this. */
  failureRetryMs: 5 * 60000,
};

const number = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/**
 * The settings that are no longer a choice.
 *
 * These had fields in the options page and were removed from it, which
 * is not the same as being fixed: a day plan saved before that removal
 * still carries whatever was typed then, and spreading the stored
 * record over the defaults would keep it forever. Nothing would read
 * wrong, and an upgraded machine would quietly go on applying three
 * times to one employer because a field it can no longer see says so.
 *
 * Imposed here rather than migrated once, so the answer does not depend
 * on whether a particular upgrade ran.
 */
const FIXED = ["attemptConcurrency", "documentBacklog", "boardGapMs", "perCompanyPerDay", "employerGapMs", "attemptDeadlineMs", "wizardDeadlineMs", "exhaustedRetryMs"];

export function withScheduleDefaults(stored = {}) {
  const value = { ...SCHEDULE_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  for (const key of FIXED) value[key] = SCHEDULE_DEFAULTS[key];
  value.dailyTarget = number(value.dailyTarget, SCHEDULE_DEFAULTS.dailyTarget, { max: 5000 });
  value.idleRetryMs = number(value.idleRetryMs, SCHEDULE_DEFAULTS.idleRetryMs, { min: 1000, max: 3600000 });
  value.failureRetryMs = number(value.failureRetryMs, SCHEDULE_DEFAULTS.failureRetryMs, { min: 1000, max: 3600000 });
  value.autopilot = value.autopilot === true;
  return value;
}

/* ------------------------------------------------------------- the ledger */

/**
 * The calendar day, in the applicant's own timezone rather than UTC.
 *
 * A quota that rolls over at seven in the evening local time would read as
 * the bot having stopped counting, so the boundary is midnight where the
 * person is. `en-CA` is used only because it formats as YYYY-MM-DD.
 */
export const dayKey = (now = Date.now()) => new Date(now).toLocaleDateString("en-CA");

const midnight = (now) => {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return end.getTime();
};

export const emptyLedger = (now = Date.now()) => ({ day: dayKey(now), startedAt: now, submitted: 0, attempted: 0, failed: 0, abandoned: 0, skipped: 0, discovered: 0, firstAt: 0, lastAt: 0, reasons: {}, boards: {}, employers: {} });

/** A ledger read back from storage, with a stale day thrown away rather than carried. */
export const rollDay = (ledger, now = Date.now()) => (ledger && typeof ledger === "object" && ledger.day === dayKey(now) ? { ...emptyLedger(now), ...ledger, day: ledger.day, boards: { ...ledger.boards }, reasons: { ...ledger.reasons }, employers: { ...ledger.employers } } : emptyLedger(now));

/**
 * The most employers one day's roster will name.
 *
 * The ledger is rewritten into SQLite every few seconds, so it cannot be
 * allowed to grow without a ceiling. This was two hundred and fifty,
 * sized when three roles an employer made three hundred applications a
 * hundred names. One application per employer makes it three hundred
 * names exactly, so the old ceiling silently dropped the last fifty
 * employers of a day that met its target - and the roster is read as a
 * tally that adds up to what was sent. Five hundred leaves the same kind
 * of headroom over the target that the old figure had.
 */
const ROSTER_LIMIT = 500;

/**
 * One finished attempt, counted.
 *
 * Reasons are tallied rather than listed because the question the applicant
 * asks after an unattended day is "what went wrong, mostly" - a hundred
 * lines of the same timeout answer it worse than one line with a count.
 */
export function recordOutcome(ledger, outcome = {}, now = Date.now()) {
  const { status, reason = "", company = "" } = outcome;
  const day = rollDay(ledger, now);
  day.lastAt = now;
  day.firstAt ||= now;
  if (status === "submitted" || status === "unconfirmed") {
    day.submitted += 1;
    // Who, not just how many. "Three hundred sent" is not an answer to the
    // first question asked after an unattended day, and the applications
    // table is three hundred rows deep - this is the one line per employer
    // version of it. The count stays a count even though one per employer
    // means it should always read one: a two here is the duplicate that
    // cannot be taken back, and the applicant should be able to see it.
    const name = String(company ?? "").trim();
    if (name && (day.employers[name] || Object.keys(day.employers).length < ROSTER_LIMIT)) day.employers[name] = (day.employers[name] || 0) + 1;
  } else if (status === "abandoned") day.abandoned += 1;
  else if (status === "failed" || status === "manual") day.failed += 1;
  else day.skipped += 1;
  if (status !== "submitted") {
    const key = shortReason(reason, company) || status;
    day.reasons[key] = (day.reasons[key] || 0) + 1;
  }
  if (status !== "skipped") day.attempted += 1;
  return day;
}

/**
 * Reasons arrive as whole sentences carrying a company name, a URL and a
 * number of seconds, so counting them raw gives three hundred buckets of
 * one and tells the applicant nothing. Cut to the first clause, with the
 * employer's own name, any address and every number taken out, "no
 * security code mail for Acme arrived within 240 seconds" and the same
 * sentence about Beta become one row with a count of two.
 */
export function shortReason(reason, company = "") {
  const name = String(company ?? "").trim();
  let text = String(reason ?? "").split(/[;(]|\s-\s/)[0].replace(/https?:\/\/\S+/g, "");
  if (name.length > 2) text = text.split(name).join(" ");
  return text.replace(/\d+/g, "n").replace(/\s{2,}/g, " ").trim().slice(0, 80);
}

/** New links seen, for the supply gauge. Discovery is counted apart from attempts. */
export const recordDiscovered = (ledger, count, now = Date.now()) => {
  const day = rollDay(ledger, now);
  day.discovered += Math.max(0, count || 0);
  return day;
};

/* -------------------------------------------------------------- the pace */

/**
 * Whether a board will take another application yet.
 *
 * Boards do not publish a rate limit; they publish a ban. Three hundred
 * posts to one Greenhouse tenant family in an afternoon from one address
 * is the shape that gets an applicant blocked, and being blocked costs the
 * whole day rather than the one application. The gap is stored as the
 * earliest next start rather than as the last start so the jitter is drawn
 * once, when the slot is taken - a jitter drawn at read time would make
 * every answer to "when may I start" a different one.
 */
export function boardWaitMs(ledger, board, settings = SCHEDULE_DEFAULTS, now = Date.now()) {
  if (!board) return 0;
  return Math.max(0, (ledger?.boards?.[board]?.nextAt || 0) - now);
}

export function boardStarted(ledger, board, settings = SCHEDULE_DEFAULTS, now = Date.now(), random = Math.random) {
  const day = rollDay(ledger, now);
  if (!board) return day;
  const gap = Math.round((settings.boardGapMs ?? SCHEDULE_DEFAULTS.boardGapMs) * (0.8 + 0.4 * random()));
  const before = day.boards[board] || { started: 0, nextAt: 0 };
  day.boards[board] = { started: before.started + 1, lastAt: now, nextAt: now + gap };
  return day;
}

/* ----------------------------------------------------------- the progress */

/**
 * What the monitor says: how many today, how fast, and whether the target
 * is still reachable at that speed. `needed` is the honest number - the
 * rate the rest of the day has to run at - and it is the one that tells the
 * applicant by lunchtime that three hundred is not happening today.
 */
export function dayProgress(ledger, settings = SCHEDULE_DEFAULTS, now = Date.now()) {
  const day = rollDay(ledger, now);
  const target = settings.dailyTarget ?? 0;
  const workedMs = Math.max(0, now - (day.firstAt || day.startedAt || now));
  const hours = workedMs / 3600000;
  const rate = hours >= 1 / 60 ? day.submitted / hours : 0;
  const hoursLeft = Math.max(0, (midnight(now) - now) / 3600000);
  const remaining = target > 0 ? Math.max(0, target - day.submitted) : 0;
  const needed = target > 0 && hoursLeft > 0 ? remaining / hoursLeft : 0;
  const reasons = Object.entries(day.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count }));
  const employers = Object.entries(day.employers ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([company, count]) => ({ company, count }));
  return {
    day: day.day, target, submitted: day.submitted, attempted: day.attempted, failed: day.failed, abandoned: day.abandoned, skipped: day.skipped, discovered: day.discovered,
    remaining, rate, needed, hoursLeft, reasons, employers,
    // Which boards the day's attempts actually went to. The per-board
    // record is kept for pacing, so the count lives on `started`; it was
    // never surfaced, which is why "it only applied to Greenhouse" had to
    // be worked out by reading result URLs by hand.
    boards: Object.entries(day.boards ?? {})
      .map(([board, entry]) => ({ board, count: Number(entry?.started) || 0 }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count),
    projected: Math.round(day.submitted + rate * hoursLeft),
    onTrack: target === 0 || day.submitted + rate * hoursLeft >= target,
    met: target > 0 && day.submitted >= target,
    // Discovery that never became an attempt is the supply story: a day
    // that applied to forty of two thousand links was throttled by this
    // code, and a day that applied to forty of forty-two was not.
    supplyLimited: day.discovered > 0 && day.attempted >= day.discovered * 0.9,
  };
}

/* ------------------------------------------------------------ the next run */

/** Stop reasons a person has to clear. Restarting into one of these just burns the day. */
const NEEDS_A_PERSON = new Set(["user", "setup"]);

/**
 * Whether another run starts, and when.
 *
 * The caller passes the reason the last run ended and how many have ended
 * badly in a row. Everything that is not the applicant's own Stop, a broken
 * profile, or a met target becomes a delay rather than a halt - including
 * "Chrome interrupted the previous run", which is the service worker dying
 * and is the single most common way an unattended day used to end at 2am
 * with nobody watching.
 *
 * `blocked` is whether a systemic condition is still standing (health.js).
 * It is a boolean rather than the condition itself so this file keeps
 * knowing nothing about mailboxes and disks, and it is asked every tick
 * rather than remembered from the stop, because some of those conditions
 * do lift on their own - a disk somebody emptied, a Gmail tab somebody
 * signed back in - and a supervisor that treated "stopped on health" as
 * permanent would leave the rest of the day unworked after the thing that
 * stopped it was fixed.
 */
export function nextRun({ ledger, settings = SCHEDULE_DEFAULTS, stopReason = null, failures = 0, blocked = false, now = Date.now() } = {}) {
  if (!settings.autopilot) return { start: false, delayMs: 0, reason: "Autopilot is off; runs start when you press Run." };
  const progress = dayProgress(ledger, settings, now);
  if (progress.met) return { start: false, delayMs: Math.max(1000, midnight(now) - now), reason: `Today's target of ${progress.target} is met. The next run starts after midnight.` };
  const code = stopReason?.code ?? "";
  if (code === "health") {
    if (blocked) return { start: false, watch: true, delayMs: 0, reason: `Nothing further starts until this is dealt with: ${stopReason?.message ?? "a systemic problem was detected"}` };
    return { start: true, delayMs: settings.idleRetryMs, reason: "The problem that stopped the last run has cleared; continuing." };
  }
  if (NEEDS_A_PERSON.has(code)) return { start: false, delayMs: 0, reason: code === "user" ? "Stopped by you. Autopilot is off until you start another run." : `Needs attention before another run: ${stopReason?.message ?? "setup is incomplete"}` };
  if (code === "error") {
    const delayMs = Math.min(settings.failureRetryMs * 2 ** Math.max(0, failures - 1), settings.failureRetryMs * 6);
    return { start: true, delayMs, reason: `Run ${failures} ended on an error; waiting ${Math.round(delayMs / 60000)} minute(s) before the next one.` };
  }
  if (code === "exhausted" || code === "one-pass") return { start: true, delayMs: settings.exhaustedRetryMs, reason: `The feeds had nothing new; looking again in ${Math.round(settings.exhaustedRetryMs / 60000)} minute(s).` };
  return { start: true, delayMs: settings.idleRetryMs, reason: `${progress.submitted} of ${progress.target} today; continuing.` };
}
