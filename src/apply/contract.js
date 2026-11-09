/**
 * What the apply module is, and what it is allowed to touch.
 *
 * The apply module answers one question: given a job, its documents and a
 * person's facts, what happened when we tried to send the application? It is
 * deliberately the only part of the system that presses Submit, and it is
 * deliberately not allowed to produce the things it needs. It does not
 * generate resumes, research compensation or read mailboxes; it asks for those
 * through `Services` and waits. A module that can quietly produce its own
 * inputs ends up with two salary researchers and two duplicate-protection
 * rules, which is how the old flow grew to 380 lines inside the run loop.
 *
 * Three boundaries matter here, and each exists for a reason that has already
 * cost something:
 *
 *   Adapters   - how a given site is operated. Ranked, never exclusive.
 *   BrowserOps - everything that touches Chrome, behind one interface.
 *   Services   - the work apply needs but must not do itself.
 *
 * ## Why adapters are ranked rather than matched
 *
 * The old design kept a closed set of fillable boards and sent everything else
 * to a manual handoff: a career page that was not Greenhouse, Ashby, Lever,
 * Workday, Rippling, Workable or ApplyToJob was simply not applied to. That
 * makes "support every careers site" impossible by construction, because there
 * is no code path for a site nobody wrote an adapter for.
 *
 * So detection returns a confidence rather than a yes, the registry picks the
 * most confident adapter, and a generic adapter matches everything at the
 * lowest confidence. An unknown company careers page is then the ordinary
 * case handled poorly rather than a case refused outright, and writing a new
 * adapter becomes an optimisation instead of a prerequisite.
 *
 * Detection is async and is given the page, not just the address, because a
 * company's own domain frequently embeds a board in an iframe. Judging from
 * the hostname alone is how an embedded Greenhouse form gets treated as an
 * unknown site.
 */

/**
 * The four outcomes an attempt can have. Everything else - "submitted?",
 * "probably", a screenshot that looks like a thank-you page - collapses into
 * one of these, because the audit found four applications with real receipts
 * filed as unconfirmed and one welcome page filed as a success.
 *
 * `uncertain` is not a failure state. It means the company stays protected and
 * a person has to look, which is the only safe reading of "we pressed Submit
 * and then lost the page".
 */
export const OUTCOMES = Object.freeze({
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  CHALLENGE: "challenge",
  UNCERTAIN: "uncertain",
});

/**
 * How sure an adapter is that it should drive this page.
 *
 * The numbers only have to order correctly. They are spaced so a future
 * adapter can sit between two of them without renumbering the rest.
 */
export const CONFIDENCE = Object.freeze({
  /** The posting's identifiers parse against a known board's API. */
  EXACT: 100,
  /** Known board markup found on the page or in one of its frames. */
  STRONG: 70,
  /** A recognised form library or embed, but not a board we have tested. */
  LIKELY: 40,
  /**
   * Something form-shaped, recognised by nothing more than its shape.
   *
   * Occupied by `adapters/generic.js`, and adding it was the registration
   * this rank was reserved for and nothing else. Sitting below every other
   * rank is what makes it safe: it can only ever drive a page every board
   * adapter has already declined, so a board that grows an adapter later
   * takes its own postings back by being registered.
   */
  GENERIC: 10,
  /** Not this adapter. */
  NONE: 0,
});

/**
 * The stages an attempt moves through, in order.
 *
 * Named here rather than left implicit in control flow so each one can be
 * tested on its own and so the monitor has a vocabulary for "where is this
 * job". A step may be skipped; it may not be reordered.
 *
 * `inspect` through `advance` is a loop, not a line. That was a correction
 * forced by Workday: the list read as a sequence for three single-page
 * boards and then met a seven-page wizard, where every judgement in the
 * middle has to be made once per page. The order within an iteration is
 * unchanged, which is why the three existing adapters did not notice - a
 * board whose `advance` says it is done runs the loop exactly once.
 */
export const APPLY_STEPS = Object.freeze([
  "detect",
  "reach",
  "account",
  "restore",
  "inspect",
  "resolve",
  "fill",
  "verify",
  "advance",
  "preflight",
  "submit",
  "outcome",
  "evidence",
]);

/**
 * @typedef {object} ApplyRequest
 * The whole input. Everything the module needs arrives here; nothing is read
 * from run state, because the module has to work for a single pasted URL with
 * no run in progress.
 *
 * @property {string} id                 Canonical job identity.
 * @property {string} company            Verified employer name, already normalised.
 * @property {string} title              Role title.
 * @property {string} applyUrl           Where the form lives.
 * @property {string} [sourceUrl]        Where the link was found, for audit only.
 * @property {string} jd                 The verified original description.
 * @property {object} profile            Candidate facts and approved answers.
 * @property {ApplyDocuments} documents  Already-generated artifacts.
 * @property {ApplyPolicy} policy        What this attempt is permitted to do.
 * @property {number} [tabId]            Adopt this already-open tab instead of opening one.
 */

/**
 * @typedef {object} ApplyDocuments
 * @property {Blob} [resume]
 * @property {string} [resumeName]
 * @property {Blob} [letter]
 * @property {string} [letterName]
 * @property {object} [resumeData] Parsed resume, for grounding open answers.
 */

/**
 * @typedef {object} ApplyPolicy
 * @property {boolean} review     Stop before Submit and leave the page for a person.
 * @property {boolean} exportCopies Write a copy of the artifacts to Downloads.
 * @property {number}  turnBudgetMs Ceiling on active work, excluding registered waits.
 * @property {boolean} [register] Permit creating a candidate account on the
 *   employer's site. Off unless said, and said separately from `review`,
 *   because the two are different risks: a filled form can be closed, and a
 *   registration is a durable record in that employer's ATS under the
 *   candidate's real name that no one can take back. Every Workday posting
 *   in the corpus sits behind one, so this is the ordinary case and not an
 *   edge.
 */

/**
 * @typedef {object} ApplyOutcome
 * @property {string} status      One of OUTCOMES.
 * @property {string} reason      Human-readable, shown in the monitor verbatim.
 * @property {string} [receipt]   The confirmation line, when one was found.
 * @property {object} evidence    Screenshot reference, answers, timings, errors.
 * @property {boolean} submitted  Whether Submit was actually pressed.
 * @property {string} [reviewId]  Set when the attempt is parked for a person.
 */

/**
 * @typedef {object} ApplyAdapter
 * One site family, or the generic fallback. Every method is optional except
 * `name`, `capabilities` and `detect`; the engine supplies default behaviour
 * for anything an adapter does not override, which is what lets a new adapter
 * start as twenty lines of detection and grow from there.
 *
 * @property {string} name
 * @property {AdapterCapabilities} capabilities
 * @property {(context: DetectionContext) => Promise<number>} detect
 *   Returns a CONFIDENCE. Must inspect frames, not only the hostname.
 * @property {(context: StepContext) => Promise<object>} [reach]
 *   Get to the form. A saved link is very often the posting rather than the
 *   application - the corpus had the form behind an "Apply" button on six
 *   of the nine sites that had one at all - and everything downstream
 *   assumes the form is on screen.
 * @property {(context: StepContext) => Promise<object>} [inspect]
 *   Fields, options, required flags, current values, validation messages.
 *   `{fields: [], ready: true}` says a page with nothing to fill is the
 *   right page anyway - a wizard's review page quotes answers back as
 *   prose - which is how the engine tells it apart from a page that never
 *   loaded. Without `ready`, an empty form is a parked attempt.
 * @property {(context: StepContext) => Promise<object>} [fill]
 *   Reads `context.fills` and `context.attachments`.
 * @property {(context: StepContext) => Promise<object>} [verify]
 *   Read values back. A rendered value is not an accepted value.
 * @property {(context: StepContext) => Promise<object>} [uploadsSettled]
 *   Whether the board has finished taking its files. Submit before this and
 *   the form says the resume is missing with the file sitting in the input.
 * @property {(context: StepContext) => Promise<string[]>} [menuOptions]
 *   What `context.key`'s menu actually offers. A menu that renders only when
 *   opened shows no options to an inventory, and a model asked to pick from
 *   a list it cannot see picks wrong.
 * @property {(context: StepContext) => Promise<object>} [account]
 *   Get past a sign-in or registration wall, before the form is looked for.
 *   Only called when `capabilities.account` is set. Creating an account is a
 *   side effect that outlives the attempt and cannot be undone, so an
 *   adapter that would have to register says `{park}` unless the policy
 *   explicitly allows it (`policy.register`).
 * @property {(context: StepContext) => Promise<object>} [advance]
 *   Move a wizard forward, and say whether there is more.
 *
 *   `{more: true, moved: true, at: "<page>"}` - next page; the engine loops.
 *   `{done: true}` - this is the last page; the engine goes on to Submit.
 *   `{more: true, moved: false, reason}` - would not move; parked.
 *
 *   Navigation is never a submission. On a wizard whose last Continue *is*
 *   the Submit, `advance` must stop at that page and let the engine press
 *   it, because the claim that protects the company is taken there.
 * @property {(context: StepContext) => Promise<object>} [submit]
 * @property {(context: StepContext) => Promise<object>} [enterCode]
 *   Type `context.code` into the board's verification boxes.
 * @property {(context: StepContext) => Promise<ApplyOutcome>} [readOutcome]
 *   Reads `context.before`, the confirmation lines already on the page.
 * @property {(context: StepContext) => Promise<object>} [restore]
 *   Reconcile a saved checkpoint against the page as it is now. Called only
 *   when there is a checkpoint to reconcile. Answering `{restored: false}`
 *   is always allowed and always safe: the attempt then starts from the
 *   page it is actually on, and a page filled twice costs seconds, where a
 *   page skipped on a stale checkpoint costs the application.
 */

/**
 * @typedef {object} AdapterCapabilities
 * What this adapter can actually do, so the engine can decide to park an
 * attempt rather than discover the gap halfway through a form.
 *
 * @property {boolean} multiPage      Drives a wizard across pages.
 * @property {boolean} upload         Can attach files and confirm they settled.
 * @property {boolean} verifyAccepted Can read values back from the real control.
 * @property {boolean} submit         Can press the final action.
 * @property {boolean} receipt        Can distinguish a real receipt from navigation.
 * @property {boolean} account        Can create or sign into an account first.
 */

/**
 * @typedef {object} DetectionContext
 * @property {string} url
 * @property {BrowserOps} browser
 * @property {number} tabId
 */

/**
 * @typedef {object} StepContext
 * @property {ApplyRequest} request
 * @property {BrowserOps} browser
 * @property {Services} services
 * @property {number} tabId
 * @property {number} [frameId]
 * @property {object} checkpoint  Survives worker death; see stages.js.
 * @property {(level: string, message: string, detail?: unknown) => void} log
 */

/**
 * @typedef {object} BrowserOps
 * Everything that touches Chrome, and the only thing that does.
 *
 * This interface exists so the engine can be moved out of the extension later
 * without rewriting it: today these are direct `chrome.*` calls in the same
 * process, and the same methods implemented over a socket would put the engine
 * in a local helper with no change above this line. Keeping the seam narrow is
 * the whole point, so resist adding convenience methods that encode apply
 * logic - those belong in the engine, where they can be tested without a
 * browser.
 *
 * Every call takes a turn on the foreground scheduler. A turn may not contain
 * a wait: anything that means "sit here until something arrives" is a
 * registered wait instead, so the one foreground stays free for other jobs.
 *
 * @property {(url: string, options?: object) => Promise<number>} openTab
 * @property {(tabId: number) => Promise<object|null>} adoptTab
 *   Take over a tab the person already had open, after confirming the posting.
 * @property {(patterns: string[]) => Promise<{id: number, url: string}|null>} findTab
 *   A tab already open on one of these addresses. Takes no turn: nothing is
 *   focused and nothing is run, so a mailbox reader can find its tab without
 *   joining the queue to do it.
 * @property {(tabId: number) => Promise<void>} closeTab
 * @property {(tabId: number, url: string) => Promise<void>} navigate
 * @property {(tabId: number, files: string[]) => Promise<void>} inject
 * @property {(tabId: number, frameId: number|undefined, fn: Function, args?: unknown[]) => Promise<unknown>} inFrame
 *   With a frame id, that frame's answer. Without one, every frame's, as
 *   `{frameId, result}` - an embedded board means "is there a form here" has
 *   no single frame to ask.
 * @property {(tabId: number) => Promise<object>} frames
 * @property {(tabId: number) => Promise<{url: string, status: string, title: string}|null>} info
 * @property {(tabId: number) => Promise<{content: Blob, url: string, title: string}>} capture
 */

/**
 * @typedef {object} Services
 * The work apply needs and must not do itself.
 *
 * Each of these is somebody else's module reached through the router. Apply
 * calls them and waits; it never implements a second copy. The waits are
 * registered rather than slept on, so a job sitting on an email or a person
 * costs no foreground and no worker.
 *
 * @property {(questions: object[], context: object, profile: object) => Promise<{answers: object[], unanswered: object[], forced: object[]}>} answers
 *   The open questions a profile cannot answer. The model lives behind this
 *   so an attempt can be replayed against a fixed set of replies.
 * @property {(need: {request: object, fields: object[], page: number}) => Promise<object>} documents
 *   A cover letter or other artifact the form turned out to require, asked
 *   for with the fields that were read and before the form is planned.
 *   Both things it can produce are inputs to the plan rather than to the
 *   fill: a letter nobody wrote is a required upload with nothing to
 *   attach, and a pay question with no cited research blocks the attempt.
 * @property {(need: object) => Promise<object>} compensation
 *   Cited research. There is no static fallback; absent evidence means review.
 * @property {(need: object) => Promise<object>} verification
 *   A security code or activation link, matched to this employer and request.
 * @property {(need: object) => Promise<object>} review
 *   Park the attempt for a person. Resolves when they approve and continue.
 * @property {(claim: object) => Promise<{claimed: boolean, record?: object}>} claimCompany
 *   Atomic, one application per company. Must be held before Submit.
 * @property {(state: {request: object, checkpoint: object}) => Promise<void>} [checkpoint]
 *   Persist what is behind this attempt, written after each wizard page.
 *   Optional: a board with one page has nothing worth saving, and losing a
 *   checkpoint only costs a re-fill.
 */

/**
 * The registry: adapters compete, the most confident one drives.
 *
 * `resolve` is deliberately tolerant of a detector that throws. A broken
 * adapter should cost its own candidacy, not the whole attempt - otherwise one
 * bad selector in a rarely-used board takes down applications to every site.
 */
export function createAdapterRegistry(adapters = []) {
  const registered = [...adapters];

  return {
    register(adapter) {
      if (!adapter?.name || typeof adapter.detect !== "function") throw new Error("An adapter needs a name and a detect().");
      registered.push(adapter);
      return this;
    },

    list: () => [...registered],

    /**
     * The adapter for this page, with the confidence that chose it.
     *
     * Returns null only when nothing matched at all, which should be
     * impossible once the generic adapter is registered - and is worth
     * surfacing loudly rather than defaulting, because it means the fallback
     * is missing.
     */
    async resolve(context) {
      const scored = await Promise.all(registered.map(async (adapter) => {
        try {
          return { adapter, confidence: Number(await adapter.detect(context)) || CONFIDENCE.NONE };
        } catch (error) {
          context.log?.("warn", `${adapter.name} could not inspect this page: ${error?.message ?? error}`);
          return { adapter, confidence: CONFIDENCE.NONE };
        }
      }));

      const best = scored
        .filter((entry) => entry.confidence > CONFIDENCE.NONE)
        .sort((a, b) => b.confidence - a.confidence)[0];

      return best ?? null;
    },
  };
}

/**
 * Whether an adapter can carry an attempt all the way to a recorded outcome.
 *
 * Checked before filling rather than after, so a site that cannot be submitted
 * or whose result cannot be read is parked with its page intact instead of
 * being half-filled and abandoned.
 */
export function missingCapabilities(adapter, policy = {}) {
  const needed = ["verifyAccepted", "receipt", ...(policy.review ? [] : ["submit"])];
  return needed.filter((capability) => !adapter?.capabilities?.[capability]);
}
