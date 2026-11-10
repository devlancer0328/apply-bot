/**
 * The difference between a bad application and a bad night.
 *
 * ## What was missing
 *
 * Everything below the run loop already survives one job going wrong:
 * `applyCandidate` catches, the ledger counts, the queue carries on. That
 * is the right behaviour for a bad form and the wrong behaviour for a
 * signed-out mailbox, because the two are indistinguishable from inside a
 * single attempt. A Gmail tab that has been logged out turns every
 * email-gated board into a four-minute wait that ends in nothing, and the
 * run loop's answer to that is to do it again, two hundred and eighty more
 * times, writing one anonymous warn line per attempt. Come back in the
 * morning and the day reads as slow. It was not slow; it was over at 1am
 * and nothing said so.
 *
 * So the unit here is not an error, it is a *named condition*: a sentence
 * about the system rather than about a job, with evidence behind it, a
 * remedy if one is safe, and a point at which the remedy has been tried
 * enough times that the honest thing is to stop and say so. The names are
 * the product. "Fourteen failures" is not actionable at eight in the
 * morning; "the mailbox has been signed out since 01:12 and two reloads
 * did not fix it" is.
 *
 * ## Where the line between healing and stopping sits
 *
 * A remedy runs by itself only when it is local, idempotent and cheap to
 * be wrong about: closing a Gmail tab so the next wait opens a fresh one,
 * slowing one board down, dropping a screenshot nobody has asked for. The
 * moment a remedy would touch an employer or a form it is not taken, and
 * the run stops instead, because the cost of guessing wrong there is a
 * second application to a real company rather than a wasted minute.
 *
 * Stopping is also the answer when the remedy has had its turn. Two
 * mailbox resets is the budget: a third would mean the browser's Google
 * session is gone, which is a password nobody here has. Grinding on past
 * that is not resilience, it is burning the postings that would have
 * worked tomorrow against a wall that will still be there in an hour.
 *
 * One condition deliberately never stops the run. A board that has started
 * refusing everything - banned, or re-skinned overnight - is quarantined
 * for the rest of the day and the queue goes on with the other six, because
 * "Greenhouse is angry" is not a reason to stop applying through Lever.
 *
 * ## Nothing here touches chrome
 *
 * The clock and every observation are handed in and the remedies are
 * returned as words for the caller to carry out, so a simulated day can
 * drive the whole supervisor through three hundred attempts in a second
 * (tests/soak.mjs). `snapshot`/`restore` exist for the same reason the
 * ledger has them: an MV3 worker that dies at 3am must come back knowing
 * the mailbox has already been reset twice tonight, or the budget resets
 * with it and the escalation never arrives.
 */

import { atsOf } from "./ats.js";
import { dayKey } from "./schedule.js";

export const HEALTH_DEFAULTS = {
  /** Mail waits that may fail in a row before the mailbox is suspected. */
  mailFailures: 3,
  /** Mailbox resets allowed in a day. Past this the Google session is gone. */
  mailResets: 2,
  /** Attempts on one board that may fail in a row before it is suspected. */
  boardFailures: 5,
  /** Cool-downs a board gets before it is left alone for the day. */
  boardCools: 2,
  /** How much the gap on a cooling board is multiplied, per cool-down. */
  boardCoolFactor: 4,
  /** Complete discovery rounds with nothing new before the feeds are named dry. */
  droughtRounds: 3,
  /** And the point at which waiting longer has stopped being a plan. */
  droughtStopRounds: 12,
  /**
   * Attempts that reached a form and produced nothing, across more than one
   * board, before the whole operation is called broken.
   *
   * This was fifteen, on the reasoning that a run of genuinely hard
   * postings exists but fifteen in a row at two different boards does not.
   * The first unattended night measured otherwise: fourteen parks against
   * two sent, across Greenhouse, Workday, Ashby and Lever, and every one
   * of them for a different and correct reason - a Workday address line
   * nobody has supplied, a captcha after Submit, a securities-licence
   * question no stored fact answers, a mailed code that never arrived. At
   * that rate fifteen in a row is ordinary rather than diagnostic, and the
   * cost of being wrong here is the whole night: this condition stops the
   * run and nothing clears it until the day rolls over, because the thing
   * that clears it is an application being sent.
   *
   * Forty, then, which is roughly two hours of queue. The breaks this is
   * the last net for are already caught sooner and by name - a signed-out
   * writer, a dead mailbox, one hostile board at five - so what reaches
   * this counter is the case nobody anticipated, and spending two hours
   * before calling it is the right trade against ending a good night at
   * 2am over a run of hard postings.
   */
  barrenAttempts: 40,
  /** Below this much room, the screenshot of the last page stops being written. */
  diskLowBytes: 600_000_000,
  /** And below this, nothing further is sent. */
  diskStopBytes: 250_000_000,
  /**
   * What one confirmed application costs, both copies.
   *
   * Measured over the ninety-eight application folders the bot has
   * actually written: the résumé PDF is 22 KB, the letter 10 KB when the
   * form wanted one, the answers and the JSON under 6 KB together, and the
   * final viewport PNG averages 210 KB across the fifty-seven that have
   * one - five sixths of the total, and the reason the first remedy for a
   * filling disk is to stop taking it. Each of those is stored twice when
   * file export is on: once in SQLite, where a blob is base64 and so a
   * third larger again, and once in Downloads. 560 KB is therefore the
   * worst case rather than the average, which is what a floor wants to be.
   */
  bytesPerApplication: 560_000,
};

/* --------------------------------------------------------- the evidence */

/**
 * What one finished attempt says about the mailbox.
 *
 * Read off the recorded reason rather than off an exception, because by
 * the time the run loop has a result the exception is four translations
 * away: verification.js throws, engine.js turns it into a challenge, the
 * bridge turns that into `manual`, and the only thing that survives all
 * three intact is the sentence. `signed-out` is Gmail saying so in as many
 * words and is worth acting on immediately; `timeout` is a code that never
 * came, which is one bad employer once and a broken mailbox fifteen times.
 */
export function mailSignal(result = {}) {
  if (result.detail?.securityCode) return "ok";
  const reason = String(result.reason ?? "");
  // Gmail by name, because "not signed in" on its own is also what a board
  // says about its own candidate account, and treating that as a mailbox
  // failure would quarantine the mailbox over a Workday password.
  if (/(?:gmail|outlook) is not signed in|not signed in to (?:gmail|google|outlook|microsoft)|(?:google|microsoft) account[^.]{0,40}signed out/i.test(reason)) return "signed-out";
  if (/no (?:security code|account mail|code)[^.]{0,80}arrived within|the mailbox answered with no code/i.test(reason)) return "timeout";
  return "";
}

/** An attempt that reached a form. Duplicates and dry runs prove nothing either way. */
/**
 * How long a dead discovery source is left alone before it is tried again,
 * doubling from the first figure and capped at the second. Ten minutes is
 * long enough that a feed under load is not hammered, short enough that a
 * transient outage costs a handful of applications rather than a night.
 */
const SOURCE_RETRY_BASE_MS = 10 * 60000;
const SOURCE_RETRY_MAX_MS = 60 * 60000;

/**
 * The same arrangement for a quarantined board, on a longer scale. A board
 * that is refusing the bot is usually rate-limiting it or has put a wall
 * up, and both ease off over an hour rather than a minute; the wait is
 * longer than a feed's so the probe is not itself the thing keeping the
 * wall up. Capped at two hours, which over a night is five or six goes.
 */
const BOARD_RETRY_BASE_MS = 30 * 60000;
const BOARD_RETRY_MAX_MS = 2 * 3600000;

const counted = (status) => ["submitted", "unconfirmed", "failed", "manual", "abandoned"].includes(status);
const succeeded = (status) => status === "submitted" || status === "unconfirmed";

/**
 * The gaps that are ours. A board cannot be blamed for a question the
 * profile does not answer, a code that never arrived in our mailbox, or a
 * street address nobody has supplied - and on the first unattended night
 * every one of these was read as Greenhouse being hostile, because they
 * all arrive as "an attempt that reached a form and sent nothing".
 */
const OUR_GAP =
  /required candidate (?:information|answers)|not supported by saved facts|could not honestly hold|compensation research is unavailable|demographic answer needs profile review|is required and the profile|the profile does not hold|offers no option matching|no answering service|address ?line ?\d|is required and must have a value|wants a document that is not|no (?:security code|account mail|code)[^.]{0,80}arrived within|the mailbox answered with no code|(?:gmail|outlook) is not signed in|registering is not permitted|no (?:workday )?password in the profile|needs an email and a password|could not sign in to|the original employer posting|already applied|duplicate/i;

/**
 * And the refusals that are the board's: it blocked us, it put a puzzle in
 * the way, it did not answer, or what it served has stopped looking like
 * the site this code was written against.
 */
const BOARD_REFUSAL =
  /captcha|puzzle|cloudflare|are you (?:a )?human|rate.?limit|too many requests|\b(?:403|429|503)\b|access denied|forbidden|blocked|banned|unusual traffic|net::|failed to fetch|could not (?:be )?(?:load|reach|read)|did not load|unreachable|\bdns\b|navigation (?:failed|timed out)|no application form was found|could not find (?:the|an) (?:application )?form|the page (?:could not be read|never finished)|returned (?:an )?empty/i;

/**
 * What one finished attempt says about the board it was on.
 *
 * Deliberately three answers rather than two. "ok" and "refused" move the
 * counter; everything else - our own gaps, and any reason nobody has
 * taught this function yet - leaves it exactly where it was. Quarantining
 * a board costs every posting it carries for the rest of the day, and
 * Greenhouse alone is a third of supply, so the evidence for it has to be
 * the board's behaviour and not merely the absence of a submission. The
 * failure mode nobody has named is caught by `nothing-succeeding`, which
 * is the counter built for exactly that and does not single out a board.
 */
export function boardSignal(result = {}) {
  if (succeeded(result.status)) return "ok";
  if (!counted(result.status)) return "";
  const reason = `${result.reason ?? ""} ${result.detail?.outcome?.complaints ?? ""}`;
  if (OUR_GAP.test(reason)) return "ours";
  return BOARD_REFUSAL.test(reason) ? "refused" : "";
}

/* ------------------------------------------------------- the supervisor */

export function createHealth({ settings = {}, now = () => Date.now() } = {}) {
  const limits = { ...HEALTH_DEFAULTS, ...settings };
  let day = dayKey(now());
  /** name -> {name, title, detail, since, at, remedy, tried, pending, severity} */
  const live = new Map();
  const boards = new Map();
  let mailFails = 0, barren = 0, barrenBoards = new Set(), drought = 0, diskFree = Infinity, diskReserve = 0;

  // A condition is about today. Quarantines expire with the day they were
  // imposed in, the reset budget refills, and the morning's panel is not
  // still showing last night's mailbox. Checked on every observation rather
  // than on a timer, because the worker that owns the timer is the thing
  // Chrome keeps killing.
  const roll = (at) => {
    if (dayKey(at) === day) return;
    day = dayKey(at);
    live.clear(); boards.clear();
    mailFails = 0; barren = 0; barrenBoards = new Set(); drought = 0;
  };

  /**
   * Raise a condition, or sharpen one already standing.
   *
   * `pending` is how a remedy is offered exactly once per flare-up. Fresh
   * evidence arriving after a remedy was carried out *is* the remedy having
   * failed - there is no other way to learn that - so it buys one more go
   * while the budget lasts, and nothing after that. Without the budget the
   * run would reload Gmail every four minutes until morning and never reach
   * the sentence that says the Google session is gone.
   */
  const raise = (name, { title, detail, remedy = "", severity = "degraded", budget = 0 }) => {
    const at = now();
    const before = live.get(name);
    if (!before) {
      const record = { name, title, detail, since: at, at, remedy, tried: 0, pending: Boolean(remedy), severity };
      live.set(name, record);
      return record;
    }
    before.at = at;
    before.title = title;
    before.detail = detail;
    if (remedy && !before.pending) before.pending = before.tried < budget;
    if (severity === "stop") before.severity = "stop";
    return before;
  };

  const clear = (name) => live.delete(name);

  return {
    get day() { return day; },

    /**
     * One finished attempt, read for what it says about the night.
     *
     * The same result feeds four counters because one attempt is evidence
     * about four different things at once, and the whole point of this file
     * is that they are told apart: the mailbox, this board, every board,
     * and nothing in particular.
     */
    attempt(result = {}) {
      const at = now();
      roll(at);
      const board = result.board || atsOf(result.applyUrl ?? "") || "";
      const status = result.status ?? "";
      const mail = mailSignal(result);

      if (mail === "ok") { mailFails = 0; clear("mailbox-signed-out"); clear("mail-waits-failing"); }
      else if (mail === "signed-out") {
        mailFails += 1;
        const record = raise("mailbox-signed-out", {
          title: "The mailbox is signed out, so no board that mails a code can be finished",
          detail: `The mailbox reported itself signed out on ${mailFails} attempt(s). Every Greenhouse code and every Workday activation link is unreadable until somebody signs in.`,
          remedy: "reset-mailbox",
          budget: limits.mailResets,
        });
        if (record.tried >= limits.mailResets) {
          record.severity = "stop";
          record.detail = `The mailbox is signed out and reopening the tab ${record.tried} time(s) did not fix it. The browser's mail session has to be signed in by hand; until then every emailed code is unreadable.`;
        }
      } else if (mail === "timeout") {
        mailFails += 1;
        if (mailFails >= limits.mailFailures) {
          const record = raise("mail-waits-failing", {
            title: "Every wait for an emailed code is timing out",
            detail: `${mailFails} attempts in a row ended with no code or activation mail. The mailbox is reachable but nothing is being found in it, which is a stale mailbox tab, a search that has stopped matching, or mail going somewhere else.`,
            remedy: "reset-mailbox",
            budget: limits.mailResets,
          });
          if (record.tried >= limits.mailResets) {
            record.severity = "stop";
            record.detail = `${mailFails} mail waits in a row found nothing, and reopening the mailbox ${record.tried} time(s) changed nothing. Each one of these costs four minutes and strands an application the board has already seen, so the rest of the day is not worth spending this way.`;
          }
        }
      }

      if (!counted(status)) return this;

      // "ours" and the reasons nobody has classified leave the counter
      // untouched: neither evidence for the board nor evidence against it.
      const refusal = boardSignal(result);
      if (board && (refusal === "ok" || refusal === "refused")) {
        const entry = boards.get(board) ?? { fails: 0, quarantined: 0 };
        // A quarantine that has run its course, and this result is the one
        // go it bought. Dropping the flag here is what lets a second
        // refusal quarantine the board again straight away, on a longer
        // wait, instead of making it fail three more times first.
        if (entry.quarantined && entry.quarantineUntil > 0 && at >= entry.quarantineUntil) entry.quarantined = 0;
        if (refusal === "ok") { entry.fails = 0; entry.quarantined = 0; entry.quarantineUntil = 0; entry.quarantines = 0; clear(`board-hostile:${board}`); }
        else entry.fails += 1;
        boards.set(board, entry);
        if (entry.fails >= limits.boardFailures && !entry.quarantined) {
          const record = raise(`board-hostile:${board}`, {
            title: `${board} is refusing this bot rather than answering it`,
            detail: `${entry.fails} attempts on ${board} in a row were turned away by the board itself - a block, a puzzle, a page that would not load, or markup that no longer looks like the site. Applications parked on our own missing facts are not counted here and do not reach this.`,
            remedy: "cool-board",
            budget: limits.boardCools,
          });
          // Deliberately never a stop. One board's bad night is not a reason
          // to stop applying through the other six, and a quarantine costs
          // only the postings on that board.
          if (record.tried >= limits.boardCools) {
            // Until midnight was the old answer, and on the night this was
            // written Lever was quarantined at 01:39 and never tried
            // again - a whole day of one of the two boards that actually
            // answer, thrown away over a bad half hour. It is left alone
            // for a while and then given one posting to prove itself on.
            entry.quarantines = (entry.quarantines ?? 0) + 1;
            const waitMs = Math.min(BOARD_RETRY_MAX_MS, BOARD_RETRY_BASE_MS * 2 ** (entry.quarantines - 1));
            entry.quarantined = at;
            entry.quarantineUntil = at + waitMs;
            record.pending = false;
            record.severity = "quarantined";
            record.retryAt = entry.quarantineUntil;
            record.detail = `${board} is being left alone for ${Math.round(waitMs / 60000)} minutes: ${entry.fails} failures in a row survived ${record.tried} cool-down(s). Its postings are skipped until then; everything else carries on.`;
          }
        }
      }

      // A sent application is proof the writer answered, the model
      // answered and the profile is whole, so it clears those as well as
      // its own counter. Nothing else in the run reports those services
      // succeeding, and a condition that can only be raised is a condition
      // that stops the day the first time it is ever right.
      if (succeeded(status)) { barren = 0; barrenBoards = new Set(); clear("nothing-succeeding"); clear("writer-signed-out"); }
      else {
        barren += 1;
        if (board) barrenBoards.add(board);
        // More than one board, or this is `board-hostile` wearing a
        // different hat and stopping the run over it would be wrong.
        if (barren >= limits.barrenAttempts && barrenBoards.size > 1) {
          raise("nothing-succeeding", {
            title: "Nothing has been sent in a long time, on any board",
            detail: `${barren} attempts in a row across ${barrenBoards.size} boards reached a form and sent nothing. That is not a run of hard postings; something the whole queue depends on - the profile, the documents, the writer - is broken, and the remaining postings would be spent for nothing.`,
            severity: "stop",
          });
        }
      }
      return this;
    },

    /**
     * One complete pass of a feed. `found` is new links, not postings seen:
     * a feed that returns the same two hundred jobs every round has found
     * nothing, and reading it as supply is how a dry night looks busy.
     */
    discovery({ found = 0, complete = true } = {}) {
      const at = now();
      roll(at);
      if (!complete) return this;
      if (found > 0) { drought = 0; clear("feed-drought"); return this; }
      drought += 1;
      if (drought >= limits.droughtRounds) {
        const record = raise("feed-drought", {
          title: "The feeds have stopped producing new postings",
          detail: `${drought} complete rounds of every enabled source found no link that had not been seen before. Feeds do refill, so this waits rather than stops.`,
          remedy: "wait-longer",
          budget: limits.droughtStopRounds,
        });
        if (drought >= limits.droughtStopRounds) {
          record.pending = false;
          record.severity = "stop";
          record.detail = `${drought} complete rounds found nothing new. Waiting longer has stopped being a plan: the searches need widening, or another source adding, before any more applications are possible.`;
        }
      }
      return this;
    },

    /**
     * Room on disk, as the only number a browser extension can actually get.
     *
     * `navigator.storage.estimate()` reports the origin's quota and usage
     * rather than the filesystem's, but Chrome derives that quota from free
     * space, so the gap between them tracks the real disk closely enough to
     * act on. `dbBytes` is held back on top of the floor because SQLite here
     * is one file that is exported and rewritten whole on every write: the
     * disk has to be able to hold a second copy of the database at every
     * single save, and a run that fills the gap between them does not fail
     * at the next screenshot, it fails at the next anything.
     */
    storage({ quota = 0, usage = 0, dbBytes = 0 } = {}) {
      const at = now();
      roll(at);
      diskFree = Math.max(0, quota - usage);
      diskReserve = Math.max(limits.diskStopBytes, dbBytes);
      const fits = Math.floor(diskFree / limits.bytesPerApplication);
      if (diskFree <= diskReserve) {
        raise("disk-critical", {
          title: "The disk is too full to keep a record of what was sent",
          detail: `${mb(diskFree)} of room is left and the database alone needs ${mb(diskReserve)} to save itself. Another application would be sent without anything being written down about it, so nothing further is started.`,
          severity: "stop",
        });
      } else if (diskFree <= limits.diskLowBytes) {
        clear("disk-critical");
        raise("disk-low", {
          title: "Running low on disk; the last-page screenshots are being dropped",
          detail: `${mb(diskFree)} of room is left, which is about ${fits} more application(s) at full size. The screenshot is five sixths of that, so it is no longer taken; the résumé, the answers and the receipt still are.`,
          remedy: "skip-screenshots",
          budget: 0,
        });
      } else { clear("disk-low"); clear("disk-critical"); }
      return this;
    },

    /**
     * An account-level service said yes or no. Only the writer and the model
     * are asked, and only a refusal that will repeat for the next job counts
     * - a cut-off answer is a bad minute, a rejected key is the night.
     */
    service(name, { ok = true, status = 0, message = "" } = {}) {
      const at = now();
      roll(at);
      if (ok) { clear(`${name}-signed-out`); return this; }
      raise(`${name}-signed-out`, {
        title: `${name === "writer" ? "The résumé writer" : name} is signed out or out of quota`,
        detail: `${message || "the service refused the request"}${status ? ` (${status})` : ""}. Nothing here can sign an account back in, and every remaining job would be refused the same way.`,
        severity: "stop",
      });
      return this;
    },

    /**
     * A discovery source that can no longer be read at all.
     *
     * This is the one failure a run cannot see from its own counters: a
     * source returning nothing and a source returning nothing *new* produce
     * the same numbers everywhere downstream, so a feed whose markup changed
     * overnight reads as a quiet night rather than as a third of the supply
     * being gone. Named here so it stands on the panel for as long as it is
     * true, instead of being a warning line that scrolls away.
     *
     * Degraded rather than stop while any other source still answers: one
     * dead feed is a reason to lean on the others, not to end the night.
     *
     * Dead is never permanent. A feed that timed out at one in the morning
     * used to stay dropped until somebody noticed, and on a machine where
     * it was the only source enabled that was the whole night: seven hours
     * of wall clock, five and a half of them idle, nine applications sent.
     * Most outages are not the markup changing - they are a slow minute on
     * somebody else's server - so the condition carries the time it is
     * next worth trying, doubling from ten minutes to an hour so a feed
     * that really is gone is not hammered until morning.
     */
    source(name, { ok = true, message = "", fatal = false } = {}) {
      const at = now();
      roll(at);
      if (ok) { clear(`source-dead:${name}`); return this; }
      const key = `source-dead:${name}`;
      const tries = (live.get(key)?.tries ?? 0) + 1;
      const waitMs = Math.min(SOURCE_RETRY_MAX_MS, SOURCE_RETRY_BASE_MS * 2 ** (tries - 1));
      const record = raise(key, {
        title: `${name} can no longer be read`,
        detail: `${message || "the source could not be read"}. It has been dropped from this run's rotation and the remaining sources carry on${fatal ? ", but it was the last one standing, so there is nothing left to discover from" : ""}. It will be tried again in ${Math.round(waitMs / 60000)} minutes.`,
        severity: fatal ? "stop" : "degraded",
      });
      record.tries = tries;
      record.retryAt = at + waitMs;
      return this;
    },

    /**
     * The dead sources whose backoff has run out, ready to be tried again.
     *
     * A run asks this between rounds so a feed that recovered mid-night is
     * picked back up without waiting for the run to end.
     */
    sourcesDue() {
      const at = now();
      return [...live.entries()]
        .filter(([key, record]) => key.startsWith("source-dead:") && record.retryAt > 0 && at >= record.retryAt)
        .map(([key]) => key.slice("source-dead:".length));
    },

    /* ------------------------------------------------------- the answers */

    /** Every condition standing right now, worst first. */
    conditions() {
      const rank = { stop: 0, quarantined: 1, degraded: 2 };
      return [...live.values()].map((record) => ({ ...record })).sort((a, b) => rank[a.severity] - rank[b.severity] || a.since - b.since);
    },

    /**
     * The remedies waiting to be carried out, handed over once each.
     *
     * Taking a remedy is what advances the ladder, so the caller must only
     * call this when it is actually going to do the work. The alternative -
     * the condition offering its remedy on every poll - is a run that
     * reloads Gmail four times a second and never reaches the escalation
     * that would have told the applicant their session is gone.
     */
    remedies() {
      const taken = [];
      for (const record of live.values()) {
        if (!record.pending || !record.remedy) continue;
        record.pending = false;
        record.tried += 1;
        const board = record.name.startsWith("board-hostile:") ? record.name.slice("board-hostile:".length) : "";
        // The evidence that raised the condition has been answered, so it
        // is spent. A remedy has to be given a fresh run of failures to be
        // judged by, or the one failure that arrives while the cool-down is
        // still taking effect reads as the cool-down having been useless.
        if (board && boards.has(board)) boards.get(board).fails = 0;
        if (record.remedy === "reset-mailbox") mailFails = 0;
        taken.push({ name: record.name, remedy: record.remedy, board });
      }
      return taken;
    },

    /**
     * Everything forgotten, because a person has looked at it.
     *
     * The conditions that stop a run are the ones nothing here can fix, so
     * without this an applicant who signs Gmail back in and presses Run
     * gets a run that halts on the first attempt against a condition raised
     * four hours ago. Pressing Run by hand is the only thing that calls it:
     * the supervisor must never be able to clear its own diagnosis, or the
     * ladder it climbs to reach a stop means nothing.
     */
    forget() {
      live.clear(); boards.clear();
      mailFails = 0; barren = 0; barrenBoards = new Set(); drought = 0;
      return this;
    },

    /**
     * Whether the day should end here, and the sentence the applicant reads.
     *
     * A dead source past its backoff is not a stop: it is the reason to
     * start the next run rather than to refuse it. Holding the supervisor
     * off while the condition stood is what turned one timed-out feed into
     * an idle night, because nothing but a person could ever clear it.
     */
    stop() {
      const at = now();
      const bad = this.conditions().find((record) => record.severity === "stop" && !(record.retryAt > 0 && at >= record.retryAt));
      return bad ? { code: "health", condition: bad.name, message: `${bad.title}. ${bad.detail}` } : null;
    },

    /** A board left alone for the rest of the day. Its postings are not opened. */
    /**
     * A board left alone, and whether it still is. Its postings are not
     * opened while this is true. A quarantine past its wait reads as over
     * here so the next posting on that board is tried; whether the board
     * has actually recovered is decided by what that posting does, in
     * `result` above. A record restored from before quarantines had a wait
     * has none, and keeps the old meaning of lasting until midnight.
     */
    quarantined(board) {
      const entry = board && boards.get(board);
      if (!entry?.quarantined) return false;
      return !(entry.quarantineUntil > 0 && now() >= entry.quarantineUntil);
    },

    /** How much to stretch a board's pacing gap while it is cooling off. */
    boardFactor(board) {
      const entry = boards.get(board);
      const tried = live.get(`board-hostile:${board}`)?.tried ?? 0;
      return entry && tried > 0 ? limits.boardCoolFactor ** Math.min(tried, limits.boardCools) : 1;
    },

    /** Whether the last-page screenshot is still worth the bytes. */
    get screenshots() { return !live.has("disk-low") && !live.has("disk-critical"); },

    get freeBytes() { return diskFree; },

    snapshot() {
      return { day, conditions: [...live.values()], boards: [...boards.entries()], mailFails, barren, barrenBoards: [...barrenBoards], drought, diskFree, diskReserve };
    },

    restore(value) {
      if (!value || typeof value !== "object" || value.day !== dayKey(now())) return this;
      live.clear();
      for (const record of value.conditions ?? []) if (record?.name) live.set(record.name, { ...record });
      boards.clear();
      for (const [board, entry] of value.boards ?? []) boards.set(board, { ...entry });
      mailFails = value.mailFails ?? 0;
      barren = value.barren ?? 0;
      barrenBoards = new Set(value.barrenBoards ?? []);
      drought = value.drought ?? 0;
      diskFree = value.diskFree ?? Infinity;
      diskReserve = value.diskReserve ?? 0;
      return this;
    },
  };
}

const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
