/**
 * Walking one application from an address to a recorded outcome.
 *
 * The engine owns the order of the steps and the judgement at each one; the
 * adapter owns how a particular site is operated. The split is what makes
 * "add a board" a small job: an adapter that can read a form, type into it
 * and press one button inherits the whole of the planning, the re-reading,
 * the duplicate guard and the outcome classification below.
 *
 * Three rules shape everything here.
 *
 * ## Every path produces an outcome
 *
 * Including the ones that throw. A run that loses an attempt to an exception
 * leaves a company neither applied to nor protected nor parked for a person,
 * which is the one state with no way back into it. So the whole walk is
 * wrapped, and the thrown case lands on `uncertain` if Submit was pressed
 * and `challenge` if it was not.
 *
 * ## Nothing waits while holding the foreground
 *
 * Only one tab can be in front, so page work takes turns (see tabs.js). A
 * turn that sits waiting for something to arrive - an upload, a receipt, a
 * security code - starves every other job for as long as it waits, which is
 * how one application spent twelve hours blocking the queue on a screenshot
 * it never got to take.
 *
 * The structure prevents it rather than asking anyone to remember: the
 * engine never takes a turn itself. Each `browser.*` call is one short turn
 * taken by BrowserOps, and the pauses in the polling loops below sit
 * *between* those calls, where they cost nothing. Anything longer than a
 * poll - a mailbox, a person - goes out to a service and comes back later.
 *
 * ## An unrecognised site is filled only as far as it is understood
 *
 * `CONFIDENCE.GENERIC` is occupied now, so a site nobody wrote an adapter
 * for is read, filled and verified by the generic adapter rather than
 * refused on sight. What has not changed is the judgement under it: that
 * adapter declines in its `advance`, before the claim is taken, on a
 * required field it could not answer or a Submit it cannot identify, so a
 * form the bot does not understand is still parked with its page intact.
 */

import { OUTCOMES, missingCapabilities } from "./contract.js";
import { formOps } from "./form-ops.js";
import { confirmationBaseline } from "./signals.js";
import { answerFitsControl, resolveField, resolveForm, wantsProse } from "../answers.js";
import { isDemographicQuestion } from "../demographics.js";

/** Between turns, never inside one. See the note above. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A form that keeps growing is still rendering; reading it now yields half of it. */
const FORM_SETTLE_MS = 30000;
/** Uploads the board is still taking. Submit arrives before them on a short form. */
const UPLOAD_SETTLE_MS = 60000;
/** How long the page is given to say what happened after Submit. */
const OUTCOME_MS = 20000;
/** A form being misread, rather than a form a hundred model calls would fix. */
const RESCUE_LIMIT = 15;
/** Wizard pages. Twice the longest real one, which is Workday's seven. */
const PAGE_LIMIT = 12;

/**
 * Apply to one job.
 *
 * `request.tabId` adopts a tab the person already has open instead of
 * opening one, which is the whole of what "apply to what I am looking at"
 * needs. Everything else arrives in the request; nothing is read from run
 * state, because this has to work with no run in progress.
 */
export async function applyTo({ request, registry, browser, services = {}, log = () => {} }) {
  const policy = { review: true, ...(request.policy ?? {}) };
  const context = request.answerContext;
  const profile = request.profile;
  const started = Date.now();
  const trace = [];
  const answers = [];

  let tabId = request.tabId ?? null;
  let adapter = null;
  let confidence = null;
  let frameId;
  let submitted = false;
  let baseline = [];
  let outcome = null;
  /** What is already behind this attempt. Handed to `restore` on a retry. */
  const checkpoint = { ...(request.checkpoint ?? {}) };

  const record = (status, reason, evidence = {}) => (outcome = {
    status,
    reason,
    submitted,
    ...(evidence.receipt ? { receipt: evidence.receipt } : {}),
    ...(status === OUTCOMES.CHALLENGE ? { reviewId: `${request.id}:${started}` } : {}),
    evidence: { adapter: adapter?.name ?? null, confidence, tabId, trace, answers, took: Date.now() - started, ...evidence },
  });

  /**
   * Parked for a person, with the page left as it is.
   *
   * This is `challenge` rather than a failure because the two mean different
   * things to the run: a failure may be retried by a machine, and this may
   * not. A captcha, an unsupported site, a demographic question the profile
   * cannot answer and a deliberate review all end here, because all four are
   * "someone has to look at this".
   */
  const park = (reason, evidence) => {
    log("info", `${request.company} - ${reason}`);
    return record(OUTCOMES.CHALLENGE, reason, evidence);
  };

  const step = async (name, work) => {
    const at = Date.now();
    try {
      return await work();
    } finally {
      trace.push({ step: name, ms: Date.now() - at });
    }
  };

  /** What an adapter method is handed. One argument, so payloads ride along. */
  const on = (extra = {}) => ({ request, profile, policy, browser, services, tabId, frameId, checkpoint, log, ...extra });

  /**
   * The adapter's method, or the engine's default for sites that do not
   * override it.
   *
   * `async` so a step that answers without waiting for anything - an
   * adapter whose uploads are already settled by the time the page saves -
   * is still a promise to the caller. The alternative is every call site
   * remembering, and the one that forgot lost an application to
   * "call(...).catch is not a function".
   */
  const call = async (name, extra) => (typeof adapter?.[name] === "function" ? adapter[name](on(extra)) : DEFAULTS[name](on(extra)));

  try {
    if (!context) throw new Error("applyTo needs an answerContext; the candidate's facts are an input, not something apply builds.");

    tabId = await step("detect", async () => (tabId ? (await browser.adoptTab(tabId), tabId) : browser.openTab(request.applyUrl)));
    if (!tabId) return park("the application page could not be opened");

    const match = await step("detect", () => registry.resolve({ url: request.applyUrl, browser, tabId, log }));
    if (!match) {
      return park(`no adapter recognises ${hostOf(request.applyUrl)}; the page is left open to apply by hand`, { unsupported: true });
    }
    adapter = match.adapter;
    confidence = match.confidence;
    log("info", `${request.company} - ${adapter.name} (confidence ${confidence})`);

    // Asked before anything is typed. An adapter that cannot read its own
    // values back, or cannot tell a receipt from a redirect, leaves an
    // application in a state nobody can resolve - better an untouched form.
    const missing = missingCapabilities(adapter, policy);
    if (missing.length > 0) return park(`${adapter.name} cannot ${missing.join(" or ")} on this form; left open to apply by hand`);

    // A link that was saved months ago usually points at the posting, not
    // the application, and the two are different pages on most boards. The
    // form wait below is worthless until the adapter has arrived at one -
    // the first version of this waited thirty seconds on a job description
    // and then inventoried a page it had only just navigated away from.
    const reached = await step("reach", () => call("reach"));
    if (reached?.park) return park(reached.park);

    // A sign-in or registration wall, on the boards that have one. Asked
    // before the form is looked for, because on those boards there is no
    // form to look for until it is past - and asked only of adapters that
    // claim the capability, so nothing changes for a board without a wall.
    if (adapter.capabilities?.account) {
      const account = await step("account", () => call("account", { checkpoint }));
      if (account?.park) return park(account.park);
    }

    // A wizard that died halfway is the case a checkpoint exists for. The
    // adapter reconciles it against the page as it is now and says which
    // pages are already behind it; it is allowed to say none, and a page
    // filled twice is cheaper than a page skipped wrongly.
    if (checkpoint?.pages?.length > 0) {
      const restored = await step("restore", () => call("restore", { checkpoint }));
      if (restored?.park) return park(restored.park);
      if (restored?.restored) log("info", `${request.company} - picked up a part-finished application at "${restored.at ?? checkpoint.pages.at(-1)}"`);
    }

    /**
     * One page of the form, and then the next.
     *
     * A single-page board runs this once: the default `advance` answers
     * `{done: true}` and nothing below changes for it. A wizard runs it per
     * page, and the loop is the only thing the engine had to learn - every
     * judgement inside it is the same judgement, applied again.
     *
     * The bound is on pages rather than time because a wizard that answers
     * "there is another page" forever is a misread page, not a long form,
     * and twelve is twice the longest real one (Workday's seven).
     */
    let page = 0;
    let placed = null;
    let plan = null;
    let attachments = [];

    for (; page < PAGE_LIMIT; page++) {
      // The field-count wait below is for boards read by the default
      // inspector, which has no way of knowing whether a React page has
      // finished drawing. An adapter with its own `inspect` has a better
      // signal than counting inputs - Workday watches its own page state -
      // and making it wait for ours first only costs it the wait.
      if (typeof adapter.inspect !== "function") await step("inspect", () => waitForForm(browser, tabId));
      const inspected = await step("inspect", () => call("inspect", { page }));
      // The adapter looked and found something a person has to deal with -
      // a required upload that is neither the resume nor the letter. Said
      // here rather than discovered as an empty form.
      if (inspected?.blocked) return park(inspected.blocked);
      // A page with no fields is normally a page that failed to load. On a
      // wizard it can be a page of prose - Workday's review page is one -
      // and an adapter that knows the difference says `ready`. Without
      // that, an empty first page is still a page nobody can fill.
      if (!inspected?.fields?.length) {
        if (page === 0 && !inspected?.ready) return park("no application form was found on the page");
        log("info", `${request.company} - page ${page + 1} holds no fields; asking the adapter what comes next`);
      }
      frameId = inspected?.frameId ?? frameId;
      if (inspected?.fields?.length) {
        log("info", `${request.company} - page ${page + 1}: read ${inspected.fields.length} fields in ${((Date.now() - started) / 1000).toFixed(1)}s`);

        // The artifact the form turned out to want, which `Services.documents`
        // has described since the contract was written and nothing had yet
        // asked for. It is asked for here because both of the things it
        // produces are inputs to the plan below rather than to the fill: a
        // cover letter nobody wrote is a required upload with nothing to
        // attach, and a pay question with no cited research blocks the whole
        // attempt. Asked after the fields are known, because what the form
        // wants is the only way to know whether either is needed at all.
        if (typeof services.documents === "function") await services.documents({ request, fields: inspected.fields, page });

        plan = await step("resolve", () => planForm(inspected.fields, { profile, context, services, call, log, company: request.company }));
        if (plan.park) return park(plan.park);
        answers.push(...plan.answers);

        attachments = [];
        for (const attachment of plan.attachments) {
          const blob = attachment.document === "resume" ? request.documents?.resume : request.documents?.letter;
          if (!blob) {
            const field = inspected.fields.find((entry) => entry.key === attachment.key);
            if (field?.required) return park(`the form requires a ${attachment.document} and none was supplied`);
            continue;
          }
          attachments.push({
            key: attachment.key,
            name: attachment.document === "resume" ? request.documents.resumeName : request.documents.letterName,
            type: blob.type || (attachment.document === "resume" ? "application/pdf" : "text/plain"),
            data: await toBase64(blob),
          });
        }

        placed = await step("fill", () => call("fill", { fills: plan.fills, attachments }));
        log("info", `${request.company} - filled ${(placed?.applied ?? []).length} of ${plan.fills.length}${slowest(placed, inspected.fields)}`);

        // A value the page silently refused looks exactly like one it took
        // until the page is asked what it holds. Everything below is that
        // question, asked until the answers stop changing.
        const unplaced = (placed?.failed ?? [])
          .map((entry) => inspected.fields.find((field) => field.key === entry.key))
          .filter((field) => field && field.key && field.type !== "file");
        if (unplaced.length > 0) {
          // With the board's own reason beside each one. "3 fields took no
          // value" is the same sentence whether a menu offered nothing
          // that fit or never opened at all, and those are a profile
          // problem and a page problem respectively.
          log("info", `${request.company} - ${unplaced.length} field(s) took no value; choosing from what each actually offers`, (placed?.failed ?? []).map((entry) => `${inspected.fields.find((field) => field.key === entry.key)?.label ?? entry.key}: ${entry.reason}`));
          await rescue(unplaced, { profile, context, services, call, answers, log, company: request.company });
        }

        const stillEmpty = await step("verify", () => verifyFilled(plan, { call, profile, context, services, answers, log, company: request.company }));
        if (stillEmpty.park) return park(stillEmpty.park);

        // Conditional demographics appear only after an earlier answer (race
        // after Hispanic/Latino). Re-read, and answer from the profile only -
        // a model has no business guessing these.
        const conditional = await step("verify", () => refreshDemographics({ call, profile, context, answers }));
        const requiredDemographic = conditional.failed.find((field) => field.required);
        if (requiredDemographic) {
          // The reason is said as well as the label. "Gender needs review"
          // tells the person nothing they could not see; what the page
          // offered and why nothing matched is the part they need.
          return park(`a required demographic answer needs profile review: ${requiredDemographic.label}${requiredDemographic.reason ? ` (${requiredDemographic.reason})` : ""}`);
        }
      }

      const advanced = await step("advance", () => call("advance", { page, checkpoint }));
      if (advanced?.park) return park(advanced.park);

      // What is behind this attempt, written down before the next page is
      // asked for. A worker that dies on page four comes back knowing it.
      // Only a page that actually moved counts: the review page is reached
      // and left unsaved on purpose, and recording it would tell a resumed
      // attempt the application had been sent.
      if (advanced?.moved) {
        checkpoint.pages = [...(checkpoint.pages ?? []), advanced.at ?? `page ${page + 1}`];
        checkpoint.answers = answers.length;
        await services.checkpoint?.({ request, checkpoint }).catch?.(() => {});
      }

      if (!advanced?.more) break;
      if (!advanced?.moved) return park(advanced.reason ?? `the form would not move past "${advanced.at ?? `page ${page + 1}`}"`);
    }

    if (page >= PAGE_LIMIT) return park(`the form kept asking for another page after ${PAGE_LIMIT}; left open to finish by hand`);

    if (policy.review) {
      return park("filled and verified; left open for you to look at", {
        filled: (placed?.applied ?? []).length,
        attachments: attachments.length,
        questions: plan?.questions?.length ?? 0,
        pages: page + 1,
      });
    }

    const ready = await step("preflight", () => settleUploads(call, UPLOAD_SETTLE_MS));
    if (!ready.settled) return park(`documents are still uploading: ${ready.pending.join(", ")}; review before submitting`);

    // The last thing before Submit, and deliberately so: a claim taken
    // earlier and then abandoned protects a company nobody applied to.
    if (typeof services.claimCompany !== "function") return park("no duplicate-protection service was supplied; refusing to submit");
    const claim = await services.claimCompany(request);
    if (!claim?.claimed) return record(OUTCOMES.REJECTED, "already applied to this company, or its submission needs review");

    baseline = await confirmationBaseline(browser, tabId);
    submitted = true;
    const pressed = await step("submit", () => call("submit"));
    if (!pressed?.clicked) return record(OUTCOMES.REJECTED, pressed?.reason ?? "the submit button could not be clicked");

    // The board wants the address proved before it takes the application.
    // The code is in a mailbox, which means waiting - so it is asked for
    // through a service and this attempt gives up its turn until it lands.
    // Asked after every outcome is read rather than only after the first,
    // which is the bug this shape replaces: a form refused over an empty
    // field was refilled and resubmitted, the code boxes that came back
    // from *that* submit were nobody's job, and three applications were
    // parked as "the board wants an emailed security code" with the code
    // sitting unread in a mailbox the bot can open.
    const read = async () => clearEmailCode(await call("readOutcome", { before: baseline, timeoutMs: OUTCOME_MS }), { request, services, call, baseline, log });

    let said = await step("outcome", read);

    // Refused over something that was filled, usually a file the board had
    // not finished taking. Everything is put back - whatever emptied the
    // upload may have emptied the boxes beside it - and sent once more.
    // Once, not in a loop: a form refused twice over the same thing is
    // being misread, and a third press is not going to read it better.
    if (said.status === OUTCOMES.REJECTED && said.complaints) {
      log("warn", `${request.company} - the board refused the form: ${said.complaints}. Filling again, then resubmitting.`);
      await call("fill", { fills: plan.fills, attachments });
      await settleUploads(call, UPLOAD_SETTLE_MS);
      const empty = await call("verify");
      if (empty?.empty?.length > 0) {
        await rescue(empty.empty.filter((field) => field.key), { profile, context, services, call, answers, log, company: request.company });
      }
      const again = await step("submit", () => call("submit"));
      if (again?.clicked) said = await step("outcome", read);
    }

    if (said.status === OUTCOMES.CONFIRMED) return record(OUTCOMES.CONFIRMED, "", { receipt: said.receipt });
    if (said.status === OUTCOMES.CHALLENGE) return park(said.reason ?? "the board asked for a person after Submit", { challenge: said.challenge });
    if (said.status === OUTCOMES.REJECTED) return record(OUTCOMES.REJECTED, said.reason ?? `the form rejected the submission: ${said.complaints}`, { complaints: said.complaints });

    // Submit was pressed and the page said nothing either way. Recorded as
    // possibly sent, because pressing Submit twice is the one mistake this
    // must never make.
    return record(OUTCOMES.UNCERTAIN, said.reason ?? "pressed Submit, but no confirmation appeared; treated as sent");
  } catch (error) {
    const message = error?.message ?? String(error);

    // "Frame with ID 0 was removed": the page went away under a script.
    // Before Submit that is a re-render mid-fill and nothing was sent, so
    // the job is worth another try. After Submit it is more likely the form
    // navigating to its own confirmation, which means it went - and a job
    // recorded as failed is a job applied to twice. So the tab is asked.
    if (tabId && /frame .*removed|frame .*not found|cannot access|context invalidated/i.test(message)) {
      if (!submitted) return record(OUTCOMES.REJECTED, `the page changed while it was being filled (${message})`, { retry: true });
      await pause(1500);
      const after = await call("readOutcome", { before: baseline, timeoutMs: 8000 }).catch(() => null);
      if (after?.status === OUTCOMES.CONFIRMED) return record(OUTCOMES.CONFIRMED, "", { receipt: after.receipt, afterError: message });
      return record(OUTCOMES.UNCERTAIN, `the page changed after Submit (${message}); treated as possibly sent`);
    }

    if (submitted) return record(OUTCOMES.UNCERTAIN, `${message}; Submit had already been pressed, so this may have been sent`);
    return park(`this application could not be completed: ${message}`, { error: message });
  } finally {
    // The outcome object is the one already on its way back to the caller,
    // so the picture and the tab are settled by writing into it. A `finally`
    // cannot change what was returned, which is the right constraint here:
    // nothing about photographing a page should be able to alter what the
    // page was judged to have said.
    if (outcome) await step("evidence", () => keepEvidence(outcome, { browser, tabId, policy, services, request, log }));
  }
}

/**
 * The last picture of the page, then the tab.
 *
 * Taken before anything closes, because the confirmation is photographed off
 * the page and there is no second chance at it. A capture that fails is
 * recorded and changes nothing else: the application was sent either way,
 * and losing the screenshot is not a reason to lose the outcome.
 *
 * The page is left open whenever the outcome is `challenge`, because every
 * one of those means a person has to finish on that page - an unsupported
 * site, a captcha, a deliberate review. Everything else is done with it.
 */
async function keepEvidence(outcome, { browser, tabId, policy, services, request, log }) {
  if (!tabId) return;
  const keepOpen = policy.keepOpen ?? outcome.status === OUTCOMES.CHALLENGE;

  try {
    const picture = await browser.capture(tabId);
    outcome.evidence.lastPage = { url: picture.url, title: picture.title, capturedAt: picture.capturedAt };
    if (typeof services.evidence === "function") {
      outcome.evidence.lastPage = { ...outcome.evidence.lastPage, ...(await services.evidence({ request, outcome, picture })) };
    }
  } catch (error) {
    outcome.evidence.screenshotError = error?.message ?? String(error);
    log("warn", `${request.company} - final screenshot needs attention; the tab is kept open: ${outcome.evidence.screenshotError}`);
    return;
  }

  if (!keepOpen) await browser.closeTab(tabId).catch(() => {});
}

/* ------------------------------------------------------- planning a form */

/**
 * What goes in each field, before anything is typed.
 *
 * The blocked cases are checked first and separately, because they are not
 * degrees of the same problem: a pay field with no cited research, a
 * demographic question the profile does not answer, and a required fact
 * nobody supplied each mean "stop", and each reads differently to the person
 * who has to pick it up.
 */
async function planForm(fields, { profile, context, services, call, log, company }) {
  const plan = resolveForm(fields, profile, context);

  // A pay field with no research behind it is reported last of the three,
  // not first. `ensureApplicationSupport` skips the research entirely once
  // anything else on the form is blocked - correctly, since the attempt is
  // already lost - so naming it first put the one blocker that was never
  // attempted in front of the blocker that caused it. Thirteen of
  // forty-two parked applications in one night read "compensation
  // research is unavailable", and for most of them compensation was not
  // the problem and had never been looked up.
  const demographic = plan.blocked.find((entry) => isDemographicQuestion(entry.label));
  if (demographic) return { park: `a required demographic answer needs profile review: ${demographic.reason}` };
  const elsewhere = plan.blocked.filter((entry) => entry.rule !== "salary-research");
  if (elsewhere.length === 0 && plan.blocked.length > 0) {
    return { park: "compensation research is unavailable or uncited; no salary fallback is allowed" };
  }
  if (plan.blocked.length > 0) {
    // Written down before parking, so the question that cost this
    // application is on the Questions page rather than only in the
    // sentence below. Demographic and salary blocks are deliberately not
    // recorded: both are answered by a setting that already exists, and
    // putting them on the page would ask the applicant to type an answer
    // the profile is meant to hold.
    await services.remember?.(elsewhere.map((entry) => ({ question: entry.label, reason: entry.reason, required: true, options: entry.options ?? [], type: entry.type ?? "" })));
    return { park: `required candidate information needs review: ${elsewhere.map((entry) => entry.reason).join("; ")}` };
  }

  // A menu that only renders when opened has no options in the inventory, so
  // the model was answering "Degree" blind against a list it could not see.
  // Read the list off the page first and the one answer is the right one.
  for (const question of plan.questions) {
    const field = fields.find((candidate) => candidate.key === question.key);
    if (!field?.combobox || (question.options ?? []).length > 0) continue;
    const labels = (await call("menuOptions", { key: question.key }).catch(() => null)) ?? [];
    if (labels.length > 0) question.options = labels.map((label) => ({ label }));
  }

  if (plan.questions.length > 0) {
    if (typeof services.answers !== "function") return { park: `${plan.questions.length} open question(s) need the model, and no answering service was supplied` };
    log("info", `${company} - asking the model ${plan.questions.length} open question(s), in one call`);
    const { answers, unanswered, forced } = await services.answers(plan.questions, context, profile);

    // What came back is checked against the control it is headed for, and
    // a value the control cannot honestly hold is treated as no answer at
    // all. This is deliberately not a check on the model: a stub, a cached
    // reply and a rescue pass can all produce "Yes" for a paragraph box,
    // and one of them did - the DataCamp application that asked for a
    // pasted résumé and was sent the word "Yes" is this, unguarded.
    const misfit = answers.filter((answer) => !answerFitsControl(fields.find((field) => field.key === answer.key) ?? {}, answer.value));
    for (const answer of misfit) {
      const question = plan.questions.find((entry) => entry.key === answer.key);
      log("warn", `${company} - "${(question?.question ?? answer.key).slice(0, 80)}" is a prose box and was answered "${String(answer.value).slice(0, 20)}"; left empty instead`);
      unanswered.push({ key: answer.key, question: question?.question ?? answer.key, required: Boolean(question?.required), refused: String(answer.value) });
    }

    // The two ways a required question ends up unanswered need telling
    // apart, because they send whoever reads the overnight log to opposite
    // places. Nothing was supplied means a fact is missing from the
    // profile and a person has to add it. Something was supplied and
    // refused means the answerer produced a value the control cannot
    // honestly hold - NPR's "If so, what type(s) of accommodations would
    // you need?" is a paragraph box and was answered "N/A", which
    // `answerFitsControl` drops on purpose - and no amount of profile
    // editing fixes that. Both used to park as "not supported by saved
    // facts", which named the wrong cause for the second and is the kind
    // of wrong answer that costs a morning rather than a minute.
    const requiredUnknown = unanswered.filter((question) => question.required);
    if (requiredUnknown.length > 0) {
      const refused = requiredUnknown.filter((question) => question.refused !== undefined);
      const missing = requiredUnknown.filter((question) => question.refused === undefined);
      const said = [
        missing.length > 0 ? `required candidate answers are not supported by saved facts: ${missing.map((question) => question.question).join("; ")}` : "",
        refused.length > 0 ? `required answer(s) the control could not honestly hold: ${refused.map((question) => `"${question.question}" was answered "${question.refused.slice(0, 30)}"`).join("; ")}` : "",
      ].filter(Boolean);
      // Both kinds go to the page. A refused answer is as much a question
      // for the applicant as a missing one - more, since no profile field
      // will ever fix it.
      await services.remember?.(
        requiredUnknown.map((question) => ({
          question: question.question,
          required: true,
          options: plan.questions.find((entry) => entry.key === question.key)?.options ?? [],
          reason: question.refused === undefined ? "no saved fact supports an answer" : `the control could not hold "${String(question.refused).slice(0, 30)}"`,
        })),
      );
      return { park: said.join("; and ") };
    }
    plan.fills.push(...answers.filter((answer) => !misfit.includes(answer)));
    if (forced.length > 0) log("warn", `${company} - ${forced.length} required question(s) answered on the model's best judgement`, forced);
    if (unanswered.length > 0) log("info", `${company} - ${unanswered.length} optional question(s) left blank`, unanswered);
  }

  // What was typed, question by question, so a form handed to a person at a
  // captcha can be redone from the record in a minute.
  const answers = plan.fills
    .map((fill) => ({ question: fields.find((candidate) => candidate.key === fill.key)?.label ?? fill.key, answer: spoken(fields.find((candidate) => candidate.key === fill.key), fill) }))
    .filter((entry) => entry.answer !== undefined && entry.answer !== null && String(entry.answer).trim() !== "");

  return { ...plan, answers };
}

/**
 * A second pass over what the first could not place.
 *
 * A profile value that matched nothing on a menu - "Two weeks from offer"
 * against "2 weeks" - is put back with the menu's actual entries, and the
 * model picks from those. Capped, because a form with forty unplaceable
 * fields is a form being misread.
 */
async function rescue(fields, { profile, context, services, call, answers, log, company }) {
  const fills = [];
  const asks = [];
  const failed = [];

  for (const field of fields.slice(0, RESCUE_LIMIT)) {
    const labels = (await call("menuOptions", { key: field.key }).catch(() => null)) ?? [];
    const label = field.label || field.name || field.id || "This field";
    const ruled = resolveField({ ...field, label, options: labels.length > 0 ? labels.map((entry) => ({ label: entry, value: entry })) : field.options ?? [] }, profile, context);

    // A field the profile answers - a phone number, a LinkedIn address - is
    // answered from the profile; the model has no business inventing one.
    if (ruled.outcome === "fill" && ruled.rule) {
      fills.push({ key: field.key, value: ruled.value, candidates: ruled.candidates ?? [ruled.value], rule: ruled.rule, ...(ruled.replace ? { replace: true } : {}) });
      continue;
    }
    if (ruled.outcome === "blocked") {
      failed.push({ key: field.key, reason: ruled.reason });
      continue;
    }
    // Reached when the pay question has no cited research behind it. There
    // is no fallback salary, so this is never answered on a guess.
    if (ruled.rule === "salary-research") {
      failed.push({ key: field.key, reason: ruled.reason });
      continue;
    }
    if (isDemographicQuestion(label)) {
      failed.push({ key: field.key, reason: ruled.reason || "no offered option matches the saved demographic answer" });
      continue;
    }
    const local = menuShapeAnswer(label, labels);
    if (local) {
      fills.push({ key: field.key, value: local, candidates: [local], rule: "menu-shape" });
      continue;
    }
    asks.push({ key: field.key, question: label, options: labels.map((entry) => ({ label: entry })), required: true, must: true, multiline: wantsProse({ ...field, label }) });
  }

  if (asks.length > 0 && typeof services.answers === "function") {
    const { answers: given } = await services.answers(asks, context, profile);
    for (const answer of given) {
      const field = fields.find((entry) => entry.key === answer.key);
      if (!answerFitsControl({ ...field, label: field?.label || field?.name || "" }, answer.value)) continue;
      fills.push({ key: answer.key, value: answer.value, candidates: [answer.value], rule: "ai-rescue" });
    }
  }
  // Say so even when there is nothing left to send. A rescue that salvaged
  // nothing used to return here in silence, above the warning, so three
  // live runs stalled on a page whose log named no field and gave no
  // reason; the rescue had blocked every one of them and said nothing.
  if (fills.length === 0) {
    if (failed.length > 0) log("warn", `${company} - ${failed.length} field(s) still would not take a value`, failed);
    return { applied: [], failed };
  }

  for (const fill of fills) answers.push({ question: fields.find((field) => field.key === fill.key)?.label || fill.key, answer: fill.value });
  const applied = await call("fill", { fills, attachments: [] });
  const stuck = [...failed, ...(applied?.failed ?? [])];
  if (stuck.length > 0) log("warn", `${company} - ${stuck.length} field(s) still would not take a value`, stuck);
  return { ...applied, failed: stuck };
}

/**
 * Read the form back, fill what emptied, and ask again about what is still
 * blank. Then send it either way: a form the board refuses is reported with
 * the board's own complaint, which beats refusing it on the board's behalf.
 */
async function verifyFilled(plan, { call, profile, context, services, answers, log, company }) {
  let verified = await call("verify");
  if (!(verified?.empty?.length > 0)) return {};

  // Fields the plan already answered are filled from the plan, not asked
  // about again - a form that re-rendered after an upload drops typed
  // values, and the first name is not a question for a model.
  const emptyKeys = new Set(verified.empty.map((field) => field.key).filter(Boolean));
  const known = plan.fills.filter((fill) => emptyKeys.has(fill.key));
  if (known.length > 0) {
    await call("fill", { fills: known, attachments: [] }).catch(() => null);
    verified = await call("verify");
  }

  const fields = (verified?.empty ?? []).filter((field) => field.key && !known.some((fill) => fill.key === field.key));
  if (fields.length > 0) {
    log("info", `${company} - ${fields.length} required field(s) still empty; answering them`, fields);
    await rescue(fields, { profile, context, services, call, answers, log, company });
    verified = await call("verify");
  }
  if (verified?.empty?.length > 0) {
    log("warn", `${company} - still empty after a second pass: ${verified.empty.map((field) => field.label).join(", ")}; sending anyway`);
  }
  return {};
}

/** Conditional demographic controls, answered from saved facts and nothing else. */
async function refreshDemographics({ call, profile, context, answers }) {
  const inspected = await call("inspect");
  const fields = (inspected?.fields ?? []).filter((field) => isDemographicQuestion(field.label));
  if (fields.length === 0) return { failed: [] };

  const plan = resolveForm(fields, profile, context);
  const result = await call("fill", { fills: plan.fills, attachments: [] });

  for (const fill of plan.fills) {
    if (!(result?.applied ?? []).includes(fill.key)) continue;
    const field = fields.find((candidate) => candidate.key === fill.key);
    const answer = { question: field?.label || fill.key, answer: result?.values?.[fill.key] ?? spoken(field, fill) };
    const index = answers.findIndex((entry) => entry.question === answer.question);
    if (index >= 0) answers[index] = answer;
    else answers.push(answer);
  }

  const failed = [...plan.blocked, ...plan.skipped, ...(result?.failed ?? [])].map((entry) => {
    const field = fields.find((candidate) => candidate.key === entry.key);
    return { ...entry, label: field?.label || entry.label, required: Boolean(field?.required) };
  });
  return { failed };
}

/* ------------------------------------------------------------- after Submit */

/**
 * The board mailed a code before it would take the application.
 *
 * Reading a mailbox means waiting, and waiting is not something that may
 * happen with a tab held in front - so the wait belongs to a service, and
 * this attempt is simply suspended on its promise. This is the one place the
 * old flow held the foreground for two and a half minutes.
 *
 * Anything that is not a code challenge comes straight back out, so the
 * caller can run every outcome through this without asking first.
 *
 * Two rounds, because a board that refuses a resubmit issues a fresh code
 * and asks again - MCG did exactly that, and the application it had
 * already accepted a code for was recorded as rejected. Two and not more:
 * a board still asking on the third round is not going to stop, and a
 * queue of three hundred cannot afford to find that out slowly.
 */
const CODE_ROUNDS = 2;

async function clearEmailCode(outcome, { request, services, call, baseline, log }) {
  let said = outcome;

  for (let round = 0; round < CODE_ROUNDS; round++) {
    if (said.status !== OUTCOMES.CHALLENGE || said.challenge?.kind !== "email-code") return said;
    if (typeof services.verification !== "function") return said;

    const sentTo = said.challenge.email || request.profile?.email;
    log("info", `${request.company} - the board mailed a security code to ${sentTo}; asking for it`);

    let code;
    try {
      // `{code}` from the mailbox service; a bare string from a caller that
      // supplied its own. Both are a code, and refusing one of them would be
      // a shape argument standing in the way of a working application.
      const arrived = await services.verification({ kind: "email-code", email: sentTo, company: request.company, applyUrl: request.applyUrl });
      code = typeof arrived === "string" ? arrived : arrived?.code;
      if (!code) throw new Error("the mailbox answered with no code in it");
    } catch (error) {
      return { status: OUTCOMES.CHALLENGE, reason: `no security code arrived: ${error?.message ?? error}`, challenge: said.challenge };
    }

    const entered = await call("enterCode", { code });
    if (!entered?.entered) return { status: OUTCOMES.UNCERTAIN, reason: `a code arrived but could not be typed in: ${entered?.reason ?? "unknown"}` };

    log("info", `${request.company} - code entered, submitting again`);
    await pause(500);
    const again = await call("submit");
    if (!again?.clicked) return { status: OUTCOMES.REJECTED, reason: again?.reason ?? "the submit button could not be clicked after the code" };
    said = await call("readOutcome", { before: baseline, timeoutMs: OUTCOME_MS });
  }

  return said;
}

/**
 * The board uploads each attached file in the background and refuses a
 * Submit that arrives first - "Resume/CV is required", with the file sitting
 * right there in the input. A short form reaches Submit seconds after
 * attaching, so the uploads are waited for, one poll at a time.
 */
async function settleUploads(call, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await call("uploadsSettled").catch(() => null);
    if (!state || state.settled) return { settled: true, pending: [] };
    await pause(500);
  }
  return { settled: false, pending: state?.pending ?? ["an upload"] };
}

/* ------------------------------------------------------------------ pages */

/**
 * Waits for the form to actually appear.
 *
 * Chrome's "complete" means the document loaded, which on a React board is a
 * spinner. The real signal is the field count holding still - rising means
 * it is still rendering - followed by React taking the fields over. In
 * between the two, fields are on screen and nothing on them works: a menu
 * clicked shows nothing and a typed value never reaches React's state, so
 * the form later insists the phone and the resume are missing when they are
 * plainly there. Every slow and refused form traced back to this.
 */
async function waitForForm(browser, tabId) {
  const deadline = Date.now() + FORM_SETTLE_MS;
  let previous = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    await pause(250);
    const frames = await browser.inFrame(tabId, undefined, () => document.querySelectorAll("input, select, textarea").length).catch(() => null);
    if (!frames) continue;
    const count = Math.max(0, ...frames.map((frame) => frame.result ?? 0));
    if (count > 0 && count === previous) {
      stable += 1;
      if (stable >= 2) return waitForHydration(browser, tabId);
    } else {
      stable = 0;
    }
    previous = count;
  }
  return false;
}

/**
 * React hangs a fiber on every node it owns, so a form whose inputs carry
 * one is live. A page with no React at all - the older embedded boards - is
 * ready as served and is not waited for.
 *
 * Which leaves the case that was quietly costing more than the rest of the
 * attempt put together: a page that looks like React and is not. The test
 * for "is this a React page" is markup - `select__control`, `__next`, a
 * root div - and react-select's class names turn up on server-rendered
 * forms that merely copied its stylesheet. Those pages were held here for
 * the full fifteen seconds waiting for a fiber that was never coming.
 *
 * So a page gets to prove itself static rather than only being assumed
 * dynamic: fields that have stopped changing, and not one fiber among them,
 * is a finished page. The distinction that matters is none versus some - a
 * page part-way through hydration has fibers on some of its inputs, and
 * that one still waits, because it really is mid-flight.
 */
const HYDRATION_MS = 15000;
/** Fields stable and still no fiber for this long: the page is not hydrating. */
const STATIC_GRACE_MS = 2000;

async function waitForHydration(browser, tabId) {
  const deadline = Date.now() + HYDRATION_MS;
  let fields = -1;
  let unchangedSince = 0;

  while (Date.now() < deadline) {
    const frames = await browser.inFrame(tabId, undefined, hydrationState).catch(() => null);
    if (!frames) {
      await pause(200);
      continue;
    }
    // Only the frame holding the form counts. A captcha's iframes hold a box
    // or two, and a React one of those that never hydrates would otherwise
    // hold a plain server-rendered form here for the full wait.
    const form = frames.map((frame) => frame.result).filter(Boolean).sort((a, b) => b.count - a.count)[0];
    if (form && (form.state === "hydrated" || form.state === "static")) return true;

    if (form?.count > 0 && form.owned === 0) {
      if (form.count !== fields) {
        fields = form.count;
        unchangedSince = Date.now();
      } else if (Date.now() - unchangedSince >= STATIC_GRACE_MS) {
        return true;
      }
    } else {
      fields = -1;
    }
    await pause(150);
  }
  return true;
}

/** Runs in the page. */
function hydrationState() {
  const inputs = [...document.querySelectorAll("input, select, textarea")];
  const owned = inputs.filter((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber") || key.startsWith("__reactProps"))).length;
  const state = (() => {
    if (inputs.length === 0) return "none";
    const reactPage =
      Boolean(document.querySelector("#__next, [data-reactroot], #root, #app, [class*='select__control'], [class*='react-select'], script[src*='react'], .ashby-application-form-field")) ||
      Boolean(window.__NEXT_DATA__);
    if (!reactPage) return "static";
    if (owned < Math.ceil(inputs.length / 2)) return "pending";
    // The phone box is a widget (intl-tel-input) that sets itself up after
    // hydration and wipes the box when it does. Set up, it has marked the
    // input with its id and wrapped it in its container.
    const phones = inputs.filter((node) => node.type === "tel" && /\biti\b|iti__/.test(node.className));
    if (phones.some((node) => !node.hasAttribute("data-intl-tel-input-id") && !node.closest(".iti"))) return "pending";
    return "hydrated";
  })();
  return { state, count: inputs.length, owned };
}

/* ---------------------------------------------------------------- defaults */

/**
 * What a step does for an adapter that does not implement it.
 *
 * The defaults used to refuse - `inspect` returned nothing and `submit`
 * answered that the adapter could not press it - and the result was that
 * every adapter had to re-implement the ordinary way of working a form just
 * to get past them. Two adapters in, six methods were identical between
 * them. So the default is the ordinary case now (see form-ops.js), and an
 * adapter overrides only where its board actually differs.
 *
 * Nothing is lost by that. Whether an attempt may be carried to a receipt
 * at all is decided by `capabilities`, checked before a single field is
 * filled; an adapter that cannot submit is parked there, which is earlier
 * and clearer than a refusal that only surfaces once the form is full.
 *
 * What is left here is the handful of steps most boards genuinely do not
 * have: a single-page form has nothing to advance and no checkpoint to
 * restore, and a link that already points at the form has nothing to reach.
 */
const DEFAULTS = {
  ...formOps,
  reach: () => ({ reached: true }),
  advance: () => ({ done: true }),
  restore: () => ({ restored: false }),
};

/* ----------------------------------------------------------------- small */

/**
 * The answer a menu's shape gives away, with no model call.
 *
 * A yes/no menu under "are you able / willing / comfortable" is yes: the
 * applicant is applying. A menu of months or years under a start date is the
 * date two weeks out. Anything sensitive, and anything a yes would
 * misrepresent, is left to the model with the list in front of it.
 */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function menuShapeAnswer(label, labels) {
  const lower = labels.map((entry) => String(entry).trim().toLowerCase());
  if (lower.length === 0) return null;
  const subject = String(label).toLowerCase();

  const yesNo = lower.every((entry) => /^(yes|no|n\/a|decline|prefer not|i (?:do not|don't) wish)/.test(entry)) && lower.some((entry) => entry.startsWith("yes"));
  if (yesNo) {
    const capability = /\b(?:are you (?:able|willing|comfortable|open|available|okay|ok)|can you|could you|will you be able|would you be (?:able|willing|comfortable)|do you have (?:experience|at least|\d|hands|strong|solid|proven|a (?:background|strong))|have you (?:worked|used|built|led|managed|designed)|experience (?:with|in|providing|using|working)|familiar with|proficien|comfortable (?:with|working))\b/;
    if (capability.test(subject)) return labels[lower.findIndex((entry) => entry.startsWith("yes"))];
    return null;
  }

  const when = new Date(Date.now() + 14 * 86400000);
  if (/start|available|availability|date/.test(subject)) {
    const months = lower.filter((entry) => MONTHS.some((month) => entry.startsWith(month) || entry === month.slice(0, 3)));
    if (months.length >= 10) {
      const want = MONTHS[when.getMonth()];
      const index = lower.findIndex((entry) => entry.startsWith(want) || entry === want.slice(0, 3));
      if (index >= 0) return labels[index];
    }
    if (lower.every((entry) => /^(19|20)\d\d$/.test(entry))) {
      const index = lower.indexOf(String(when.getFullYear()));
      return index >= 0 ? labels[index] : labels[labels.length - 1];
    }
    if (lower.length >= 28 && lower.every((entry) => /^\d{1,2}$/.test(entry))) {
      const index = lower.indexOf(String(when.getDate()));
      if (index >= 0) return labels[index];
    }
  }
  return null;
}

/**
 * A fill's answer as a person would write it: the option's wording rather
 * than its value ("Male", not "2"), and for a ticked box the wording asked
 * for rather than "on".
 */
function spoken(field, fill) {
  const value = fill.value;
  if (value === undefined || value === null) return fill.candidates?.[0] ?? value;
  const matches = field?.options?.filter((candidate) => candidate.value !== undefined && candidate.value !== null && String(candidate.value) === String(value)) || [];
  const option = matches.find((candidate) => (fill.candidates || []).some((label) => String(label).trim() === String(candidate.label || "").trim())) || (matches.length === 1 ? matches[0] : null);
  if (option?.label) return option.label;
  if (/^(?:on|true)$/i.test(String(value ?? ""))) return fill.candidates?.[0] ?? value;
  return value;
}

/** Where the seconds went, slowest first: a four-second field was waiting on a menu. */
function slowest(placed, fields) {
  const slow = (placed?.timings ?? [])
    .filter((timing) => timing.ms >= 1000)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((timing) => `${fields.find((field) => field.key === timing.key)?.label?.slice(0, 40) ?? timing.key} ${(timing.ms / 1000).toFixed(1)}s`);
  return slow.length > 0 ? `; slow: ${slow.join(", ")}` : "";
}

/** The host, for a message a person reads, or the whole address when it will not parse. */
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
};

/** Chunked, because a megabyte of resume passed to fromCharCode at once overflows the stack. */
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
