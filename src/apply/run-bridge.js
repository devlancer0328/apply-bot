/**
 * One attempt, spoken in both languages at once.
 *
 * The run loop and the apply module were built against different
 * vocabularies and have never met. The loop deals in results - `submitted`,
 * `unconfirmed`, `manual`, `failed`, `skipped`, `dry-run` - and the whole
 * of the machinery around it reads those words: the day ledger counts them
 * (schedule.js), the duplicate index protects a company on them
 * (application-needs.js), the folder on disk is chosen by them
 * (final-page.js), and the queue decides whether to retry on them. The
 * module deals in the four outcomes a page can actually have. Neither
 * vocabulary is wrong and neither can be deleted, so this file is the one
 * place the translation happens.
 *
 * It exists as its own module rather than as a branch inside `runOne` for
 * a reason that is about testing rather than tidiness. `background.js`
 * cannot be imported outside Chrome - it reaches `chrome.*` at the top
 * level - so anything written inside it can only be checked by reading its
 * source as text, which is how the cutover would have shipped with nobody
 * able to say what the run loop does with a confirmed outcome. Everything
 * below is importable in Node, so a fixture can drive a real attempt
 * through a real engine and assert the result the queue will actually see.
 *
 * ## What is deliberately not here
 *
 * No duplicate rules, no archiving, no ledger arithmetic, no knowledge of
 * where a folder lives. Those belong to the run loop and already work; the
 * bridge hands back what the loop needs to do its own job and touches none
 * of it. The one thing it does own is the mapping, because a mapping split
 * across two files is a mapping that disagrees with itself.
 */

import { OUTCOMES } from "./contract.js";
import { applyTo } from "./engine.js";
import { applyRegistry } from "./standalone.js";
import { atsOf } from "../ats.js";

/**
 * Boards the module has no answer for, which therefore stay on the legacy
 * path whatever the setting says.
 *
 * ApplyToJob puts reCAPTCHA's anchor frame - a tick box, not a puzzle -
 * beside Submit. The legacy path ticks it and sends the form when the tick
 * is taken at face value; nothing in the module can tick anything, and the
 * generic adapter reads an unanswered human check as a form it has not
 * understood and parks. Routing those postings through the module would
 * turn applications the bot sends today into folders for a person, so they
 * keep the path that can send them until something here can tick a box.
 *
 * Lever used to be here too, and is not any more. See `leverSubmits`.
 */
const LEGACY_ONLY = new Set(["applytojob"]);

/**
 * Whether Lever's Submit is worth pressing on this machine, asked once per
 * posting and answered by what the last few postings did.
 *
 * Lever hides hCaptcha until Submit is pressed. From a datacenter address
 * that is the picture puzzle, and the module fills the form perfectly,
 * presses Submit and meets a wall - measured on a real VGS submission. So
 * Lever was refused outright: fill it, write the folder, never press
 * Submit. Seven finished applications a night went into folders under that
 * rule, on a machine running a real browser on a home connection, where
 * hCaptcha's usual answer to a warm profile is a token and no puzzle at
 * all. Nobody had checked, because the rule meant nobody ever pressed it.
 *
 * So it is checked, and the board's own behaviour is the answer. Three
 * puzzles in a row and the pressing stops for the rest of the run, which
 * is the old rule reached by evidence instead of assumption; one
 * application through and the count goes back to nothing. A claimed
 * employer is not at risk either way - a puzzle releases the claim, which
 * is the same reason pressing Submit here is affordable at all.
 */
const LEVER_PUZZLE_LIMIT = 3;
let leverPuzzles = 0;

export const leverSubmits = () => leverPuzzles < LEVER_PUZZLE_LIMIT;

/** Called at the start of a run: a new browser, a new address, a new answer. */
export function forgetBoardTrials() {
  leverPuzzles = 0;
}

/** What one Lever attempt says about the next one. */
export function noteLeverOutcome(status) {
  if (status === OUTCOMES.CHALLENGE) leverPuzzles += 1;
  else if ([OUTCOMES.CONFIRMED, OUTCOMES.UNCERTAIN].includes(status)) leverPuzzles = 0;
}

/** Whether this posting goes through the apply module. */
export function moduleEngine(profile = {}, applyUrl = "") {
  if (profile.applyEngine === "legacy") return false;
  const board = atsOf(applyUrl);
  if (board === "lever") return leverSubmits();
  return !LEGACY_ONLY.has(board);
}

/**
 * Apply to one prepared job through the module, and say what the run loop
 * should record.
 *
 * `application` is the run's own object, carried through rather than
 * copied, because two things downstream read it after this returns: the
 * archive writes `application.answers` into Answers.txt, and a letter the
 * form turned out to require is written onto it mid-attempt (see the
 * `documents` service). Copying it would quietly lose both.
 *
 * Every service is supplied by the caller. Nothing is defaulted here, and
 * that is the point: the run already has a mailbox reader that parks a
 * slot while it waits and a claim that is atomic across the whole history,
 * and a default that quietly built a second one of either would be a
 * second answer to "have we applied to this company".
 */
export async function applyThroughModule({ application, profile, context, policy = {}, services = {}, browser, registry = applyRegistry(), log = () => {}, apply = applyTo }) {
  let claimRefused = false;
  let claimTaken = false;
  let securityCode = false;

  // Read through to the application rather than snapshotted, because the
  // `documents` service writes a cover letter onto it while the engine is
  // between reading the form and attaching to it. A plain copy taken here
  // would be the state before that letter existed, and the attachment step
  // would find nothing to attach.
  const documents = {
    get resume() { return application.resume; },
    get resumeName() { return application.resumeName; },
    get letter() { return application.letter; },
    get letterName() { return application.letterName; },
    get resumeData() { return application.resumeData; },
  };

  const request = {
    id: application.id ?? application.applyUrl,
    company: application.company,
    title: application.title ?? "",
    applyUrl: application.applyUrl,
    sourceUrl: application.sourceUrl ?? "",
    jd: application.jd ?? "",
    profile,
    documents,
    compensation: application.compensation ?? null,
    resumeText: application.resumeText ?? "",
    letterText: application.letterText ?? "",
    resumeData: application.resumeData ?? null,
    education: application.education,
    currentRole: application.currentRole ?? "",
    currentCompany: application.currentCompany ?? "",
    // The run's own context object, by reference. `ensureApplicationSupport`
    // writes the fresh compensation research into it in place, and the
    // engine reads the same object when it plans the form.
    answerContext: context,
    // `review` fills every form and submits none. No setting turns it on
    // any more - it is reachable only from the fixtures that check the
    // engine stops short of Submit. `keepOpen` is left unset rather than
    // set to false, because the engine's own default keeps a `challenge`
    // page open and an explicit false overrides it - which silently closed
    // every captcha the run filled, since `??` treats false as an answer
    // and undefined as none.
    policy: { review: false, register: Boolean(profile.allowAccountRegistration), ...policy },
  };

  // Two facts the outcome does not carry and the run needs. "Rejected"
  // means a refused claim and a refused form in the same word, and those
  // are `skipped` and `failed` to the queue - one is this job already
  // being somebody else's, the other is worth a folder for a person. And a
  // code that was fetched and typed goes in application.json, because
  // "did this application need the mailbox" is the first question asked of
  // a board that starts failing.
  const watched = { ...services };
  if (typeof services.claimCompany === "function") {
    watched.claimCompany = async (claim) => {
      const answer = await services.claimCompany(claim);
      claimRefused = !answer?.claimed;
      claimTaken = Boolean(answer?.claimed);
      return answer;
    };
  }
  if (typeof services.verification === "function") {
    watched.verification = async (need) => {
      const answer = await services.verification(need);
      if (answer && need?.kind !== "workday-account") securityCode = true;
      return answer;
    };
  }

  const outcome = await apply({ request, registry, browser, services: watched, log });
  // Written back for the archive: the answers are what lets a person redo
  // by hand a form that was handed to them at a captcha.
  if (outcome.evidence?.answers?.length > 0) application.answers = outcome.evidence.answers;
  const said = toRunResult(outcome, { review: request.policy.review, claimRefused, claimTaken, securityCode });
  if (atsOf(request.applyUrl) === "lever") {
    noteLeverOutcome(outcome.status);
    if (!leverSubmits()) log("info", `${request.company} - Lever has put up a picture puzzle on every attempt from this machine; the rest of the run fills its forms and writes the folder without pressing Submit`);
  }

  // The claim given back, here rather than by the caller, because the two
  // halves of it have to be one decision. The engine takes the claim in
  // the last moment before Submit and the run loop never sees that happen,
  // so a release owned by the loop would be a second opinion about whether
  // an application exists - and the two opinions disagreeing is either a
  // burned employer or a duplicate application, which are the two worst
  // things this system can do. A release that fails is logged and nothing
  // more: the employer stays protected, which is the safe way to be wrong.
  if (said.release && typeof services.releaseCompany === "function") {
    try {
      await services.releaseCompany(request);
      log("info", `${request.company} - nothing was sent, so the employer has been released and can be applied to again`);
    } catch (error) {
      log("warn", `${request.company} - nothing was sent, but the claim could not be given back: ${error?.message ?? error}. This employer will be treated as already applied to.`);
    }
  }
  return { ...said, outcome };
}

/**
 * The outcome, as the run loop's result.
 *
 * Separate and exported so the mapping can be asserted on its own against
 * every outcome the engine can produce, including the ones that are hard
 * to stage: the four statuses are the inputs to the day's quota and to the
 * duplicate protection, and getting one of them wrong does not throw, it
 * sends a second application to an employer next week.
 *
 * `archive` names the folder the run should write, or nothing. It is said
 * here rather than inferred by the caller because it has to agree exactly
 * with where the final screenshot was already saved, and two separate
 * derivations of "which folder is this" is how a receipt ends up filed
 * away from the resume that earned it.
 *
 * `release` is whether the employer claimed moments ago has to be given
 * back, and it is the sharpest judgement in this file. The claim is taken
 * in the last instant before Submit, so by the time an outcome exists the
 * only question that matters is whether an application is now sitting in
 * somebody's applicant tracking system. Two outcomes say yes and are never
 * released: `confirmed`, and `uncertain` - which means Submit was pressed
 * and the page said nothing, and is kept precisely because pressing Submit
 * twice is the one mistake this must never make.
 *
 * Released: a captcha puzzle raised *after* Submit, which is Lever's habit
 * and was measured on a real submission to stop the application dead, and
 * a board that refused the filled form outright. In both the board has
 * nothing, and the employer must be approachable again tomorrow.
 *
 * Deliberately not released: a park holding an emailed security code. The
 * board has taken the form and is waiting on proof of the address, so the
 * application half-exists; a person finishes it from the manual folder,
 * and releasing it would be how that person's work becomes a second
 * application next week.
 */
export function toRunResult(outcome, { review = false, claimRefused = false, claimTaken = false, securityCode = false } = {}) {
  const evidence = outcome.evidence ?? {};
  const detail = {
    // Which adapter drove it and how sure it was. The first question about
    // any surprising result is which of the six was at the wheel.
    engine: { adapter: evidence.adapter ?? "", confidence: evidence.confidence ?? null, pages: evidence.pages ?? null, took: evidence.took ?? 0 },
    filled: evidence.filled ?? (evidence.answers?.length ?? 0),
    ...(evidence.attachments === undefined ? {} : { attachments: evidence.attachments }),
    ...(evidence.questions === undefined ? {} : { questions: evidence.questions }),
    ...(securityCode ? { securityCode: true } : {}),
    ...(evidence.retry ? { retry: true } : {}),
    ...(evidence.screenshotError ? { screenshotError: evidence.screenshotError } : {}),
    ...(evidence.lastPage?.path ? { lastScreenshot: evidence.lastPage } : {}),
    ...(evidence.lastPage?.folder ? { folder: evidence.lastPage.folder } : {}),
  };
  const confirmationUrl = evidence.lastPage?.url ?? "";

  if (outcome.status === OUTCOMES.CONFIRMED) {
    return { status: "submitted", reason: "", detail: { ...detail, boardSaid: outcome.receipt ?? "" }, archive: "applied", confirmationUrl, submitted: true, release: false, keepOpen: false };
  }

  if (outcome.status === OUTCOMES.UNCERTAIN) {
    return { status: "unconfirmed", reason: outcome.reason, detail, archive: "applied", confirmationUrl, submitted: Boolean(outcome.submitted), release: false, keepOpen: false };
  }

  if (outcome.status === OUTCOMES.REJECTED) {
    // A refused claim is not a refused form. The company is already
    // protected and nothing was typed anywhere, so this is the queue
    // stepping over a job rather than a job that went wrong - and
    // recording it as a failure would write a by-hand folder for an
    // application that has already been sent once.
    if (claimRefused) return { status: "skipped", reason: outcome.reason, detail, archive: null, confirmationUrl, submitted: false, release: false, keepOpen: false };
    return { status: "failed", reason: outcome.reason, detail: { ...detail, outcome: { complaints: evidence.complaints ?? "" } }, archive: null, confirmationUrl, submitted: Boolean(outcome.submitted), release: claimTaken, keepOpen: false };
  }

  // A review run's park is the deliberate one and the only `challenge`
  // that is not a problem, so it is told apart by the evidence only that
  // park carries - the page count - rather than by matching its wording,
  // which anyone is free to reword.
  if (review && evidence.pages !== undefined) {
    return { status: "dry-run", reason: outcome.reason, detail, archive: null, confirmationUrl, submitted: false, release: false, keepOpen: true };
  }

  return {
    status: "manual",
    reason: outcome.reason,
    detail: { ...detail, handoff: true, ...(evidence.challenge?.kind === "captcha" ? { captcha: true } : {}) },
    archive: "manual",
    confirmationUrl,
    submitted: Boolean(outcome.submitted),
    release: claimTaken && evidence.challenge?.kind === "captcha",
    // A captcha is the one park a person can finish on the spot: the form
    // is filled and the puzzle is the last thing between it and Submit.
    // The page is the only place that click can happen, so the tab stays
    // open and goes on the kept list rather than being closed behind a
    // folder the applicant would have to fill in again from scratch.
    keepOpen: evidence.challenge?.kind === "captcha",
  };
}
