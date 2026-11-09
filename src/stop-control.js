/**
 * What Stop means, kept apart from the run that obeys it.
 *
 * ## The night this is for
 *
 * The applicant pressed Stop while two resumes were being written. The
 * button set a flag; the flag is read at loop boundaries; the boundaries
 * were minutes away, because one ChatGPT request owns six minutes of
 * deadline and a Workday attempt owns twenty-five. For a hundred and
 * twenty-three seconds the monitor went on saying "Running · generating"
 * and the bot went on opening tabs - and then Chrome ended the service
 * worker, as it does, and the next worker read `running: true` out of the
 * saved progress and recorded the ending as `interrupted`: *Chrome
 * interrupted the previous run... press Run to continue*. That is the one
 * ending built to be restarted at once - it even clears the autopilot
 * delay on the way past - so the Stop was not merely slow, it was erased,
 * and the supervisor was free to start another run a minute later.
 *
 * ## What is decided here
 *
 * Two questions, both pure, so they can be driven through a worker death
 * in a test without a browser (tests/stop-control.mjs):
 *
 *   - who asked for a stop, and therefore what the run's ending is called.
 *     `user` is the one ending autopilot refuses to restart, so calling an
 *     internal stop by that name silently ends the night, and calling the
 *     applicant's stop anything else silently continues it. Both have
 *     happened; neither is recoverable from the log afterwards.
 *   - what a worker that boots over a run still marked `running` should
 *     say happened to it. If that run had been asked to stop, the stop is
 *     the ending. Only a run nobody asked to stop was interrupted.
 *
 * Nothing here touches `chrome`, `state`, or the clock beyond what it is
 * handed.
 */

/** Stops nothing restarts by itself. `user` is in `NEEDS_A_PERSON` over in schedule.js. */
export const STOP_SOURCES = ["user", "health", "stalled"];

/**
 * The ending of a run that was asked to stop.
 *
 * `halt` is health.js's sentence and wins outright, because it is the only
 * one of these that explains the night in words the applicant can act on.
 */
export function stopEnding({ source = "", halt = null, windingDown = false, when = "" } = {}) {
  const tail = when ? ` ${when}` : "";
  if (halt) return halt;
  if (windingDown || source === "stalled") return { code: "stalled", message: `The run showed no activity for a long time and was wound down${tail}. Autopilot starts a fresh one.` };
  if (source === "user") return { code: "user", message: `Stopped by you${tail}.` };
  // Not the applicant, and nothing claimed it. Saying "Stopped by you"
  // here is how a bug inside the extension got filed as the person having
  // pressed a button they never pressed, and it is also how the night
  // ends for good, since that is the one code autopilot will not restart.
  // Named as the fault it is, and left restartable.
  return { code: "error", message: `The run stopped${tail} without recording what asked for it. This is a fault in the extension rather than something you did.` };
}

/**
 * The ending of a run found still marked `running` in the saved progress.
 *
 * `restartable` is the whole point of the distinction: an interrupted run
 * is resumed at once and clears any autopilot delay with it, and a stopped
 * one is not resumed at all.
 */
export function resumedEnding(saved = {}) {
  const { stopping = false, stopSource = "", done = 0, total = 0 } = saved ?? {};
  if (!stopping) {
    return {
      restartable: true,
      phase: "interrupted",
      reason: { code: "interrupted", message: "Chrome interrupted the previous run. Saved stages and company protection remain; start Run to continue." },
      message: `The run was cut off after ${done} of ${total}: Chrome ended the extension's background worker. Already-sent applications are remembered; press Run to continue with the rest.`,
      level: "error",
    };
  }
  const source = STOP_SOURCES.includes(stopSource) ? stopSource : "user";
  const ending = stopEnding({ source });
  return {
    restartable: source === "stalled",
    phase: "stopped",
    reason: { ...ending, message: `${ending.message} Chrome ended the background worker while the run was winding down; nothing it had open was restarted.` },
    message: source === "user"
      ? `Stopped. Chrome ended the extension's background worker before the run had finished winding down, after ${done} of ${total}. Nothing further was started.`
      : `The run was stopped after ${done} of ${total} and Chrome ended the extension's background worker with it.`,
    level: source === "user" ? "info" : "warn",
  };
}
