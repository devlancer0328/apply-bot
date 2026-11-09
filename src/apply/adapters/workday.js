/**
 * Workday.
 *
 * The first board here that is not a form. It is a wizard behind a wall:
 * Create Account or Sign In, then My Information, My Experience,
 * Application Questions, Voluntary Disclosures, sometimes Self Identify,
 * and Review - each page saved by its own Continue, each page's fields
 * drawn a few at a time after the page frame is already up.
 *
 * ## What is ported and what is new
 *
 * The page half is `src/workday.js` unchanged - `window.__wdApply`, which
 * knows Workday's widgets: the listbox buttons, the pill-based multiselect,
 * the date spinbuttons that only commit through React's own handler, the
 * `noCaptchaWrapper` over every button. That is years of findings and none
 * of it is rewritten here.
 *
 * What is new is only the outside: the old `runWorkday` was a 420-line
 * switch over page kinds that also planned forms, called the model, kept
 * the duplicate claim and classified receipts. All of that is the engine's
 * now. What is left below is the part that is actually about Workday -
 * which page is this, how does it move, and what is behind the wall.
 *
 * ## The wall, and why this adapter refuses it by default
 *
 * Every Workday posting in the corpus is behind an account. Creating one
 * writes a durable candidate record into that employer's ATS under the
 * applicant's real name and address, visible to their recruiters, and there
 * is no delete. That is not the same kind of act as filling a form, so it
 * is not covered by the same permission: `account` refuses unless
 * `policy.register` says otherwise, and refusing parks the attempt with the
 * page intact for a person who can decide.
 *
 * Signing in to an account that already exists is not that act, and is
 * allowed whenever there is a password to do it with.
 */

import { CONFIDENCE, OUTCOMES } from "../contract.js";
import { workdayApplyUrl, workdayIds } from "../../workdayBoard.js";
import { newConfirmation } from "../../submission-evidence.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How patient to be with a page that draws itself in instalments.
 *
 * Mutable, and the only reason is the local wizard fixture: a page that is
 * already complete the instant it is asked still costs `still` per look,
 * and six looks a page across six pages is ninety seconds of a test
 * waiting for a page that was never going to change. Nothing in `src/`
 * writes to it.
 */
export const TIMINGS = {
  /** A page is settled when what it shows has held still this long. */
  still: 2500,
  /** Longest a Workday page is given to draw itself. */
  settle: 40000,
  /** Longest a Continue is given to land on the next page. */
  move: 45000,
  /** Between looks at a page that is still changing. */
  poll: 300,
};

/** "Something went wrong, please refresh" - done as told, this many times. */
const RELOAD_LIMIT = 3;
/** Turns at the account wall before it is a wall this cannot get past. */
const WALL_LIMIT = 8;

/** The wizard pages that are forms to be filled rather than doors. */
const FORM_PAGES = new Set(["autofill", "myinfo", "experience", "questions", "disclosures", "selfid", "form"]);

export const workdayAdapter = {
  name: "workday",
  capabilities: { multiPage: true, upload: true, verifyAccepted: true, submit: true, receipt: true, account: true },

  async detect({ url, browser, tabId }) {
    if (workdayIds(url)) return CONFIDENCE.EXACT;
    const frames = await browser.inFrame(tabId, undefined, workdayMarkup).catch(() => []);
    return frames.some((frame) => frame.result) ? CONFIDENCE.STRONG : CONFIDENCE.NONE;
  },

  /**
   * In by the "Apply Manually" door, never "Autofill with Resume".
   *
   * Workday's resume parser guesses at the career and writes its guesses
   * into the form, and correcting them costs more than filling the fields,
   * every one of which this writes from the profile and the resume anyway.
   */
  async reach({ browser, tabId, request, log }) {
    const here = await browser.info(tabId);
    const current = here?.url || request.applyUrl;
    const form = workdayApplyUrl(request.applyUrl);

    if (!/\/apply\b/.test(pathOf(current)) && form !== current) {
      log("info", `${request.company} - the posting is not the form; going on to ${form}`);
      await browser.navigate(tabId, form);
    }

    // The posting page sometimes answers the manual-apply address with the
    // posting again and its own Apply button, so it is pressed if it is
    // there. `startApplication` is a no-op on a page already in the wizard.
    const state = await settled({ browser, tabId });
    if (state?.kind === "posting" || state?.kind === "choose") {
      await api({ browser, tabId }, "startApplication");
      await pause(2000);
    }
    return { reached: true };
  },

  /**
   * The account wall.
   *
   * Reads as a loop over page kinds because that is what it is: Workday
   * moves between the chooser, Create Account and Sign In on its own and in
   * an order that differs by tenant, so the only reliable shape is "look at
   * what is on screen, do the one thing that page allows, look again".
   *
   * The counts are the loop guard. Two sign-ins that both failed is a wrong
   * password, not a slow page.
   */
  async account({ browser, tabId, request, profile, policy, services, log }) {
    const host = hostOf(request.applyUrl);
    const email = profile?.email;
    const password = profile?.workdayPassword;
    const seen = { create: 0, signin: 0, activation: 0, reloads: 0, reset: 0 };
    const page = { browser, tabId };

    for (let turn = 0; turn < WALL_LIMIT; turn++) {
      const state = await settled(page);
      if (!state) return { park: "the Workday page could not be read" };

      if (state.broken) {
        if (++seen.reloads > RELOAD_LIMIT) return { park: `Workday kept answering "Something went wrong" at the sign-in page` };
        await browser.navigate(tabId, state.url);
        continue;
      }

      // Past the wall: either already signed in, or this tenant lets a
      // guest apply. Both leave the wizard on screen with no door on it.
      if (FORM_PAGES.has(state.kind) || state.kind === "review" || state.kind === "done") return { ready: true, at: state.step || state.kind };

      const complaint = [state.errors?.heading, ...(state.errors?.alerts ?? []), state.alert].filter(Boolean).join("; ");

      switch (state.kind) {
        case "posting":
        case "choose":
          await api(page, "startApplication");
          await pause(2000);
          break;

        case "chooseSignIn":
          // Google, LinkedIn or email. Email is the one with a form behind
          // it; which of its two doors depends on whether an account exists.
          await api(page, "withEmail", Boolean(policy?.register) && seen.create === 0);
          await pause(1200);
          break;

        case "create": {
          // The refusal, and the reason this adapter exists in the shape it
          // does. Registering is not something an application attempt gets
          // to decide on its own.
          if (!policy?.register) {
            return { park: `${host} requires a candidate account before the form; registering is not permitted, so the page is left open to create one by hand` };
          }
          if (/already|exist|in use|registered|taken/i.test(complaint) || seen.create >= 1) {
            // Said out loud, because the two reasons this is reached need
            // opposite work and the park at the end of the sign-in path
            // reads identically for both: an address that already has an
            // account is a sign-in, and a tenant refusing the password
            // rules or wanting a field nobody filled is a code change.
            // Without this the only evidence either way was a screenshot.
            log("info", `${request.company} - ${host} did not create the account${complaint ? `: ${complaint}` : " and said nothing about why"}; trying to sign in instead`);
            await api(page, "toSignIn");
            await pause(1200);
            break;
          }
          if (!email || !password) return { park: "a Workday account needs an email and a password in the profile" };
          seen.create += 1;
          log("info", `${request.company} - creating a candidate account on ${host} as ${email}`);
          await api(page, "createAccount", email, password);
          await pause(3000);
          break;
        }

        case "signin": {
          // "Verify your account" - the tenant mailed an activation link
          // and will not sign anyone in until it is followed. Reading mail
          // is a registered wait, so this suspends rather than holding the
          // front for the three minutes it may take.
          if (/verify your account|has been sent|not (?:yet )?(?:been )?verified|verification (?:e-?mail|required)|check your (?:e-?mail|inbox)/i.test(complaint) && seen.activation < 2) {
            seen.activation += 1;
            if (typeof services?.verification !== "function") return { park: "the career site wants the address verified and no mailbox service was supplied" };
            log("info", `${request.company} - ${host} mailed an account verification; waiting for it`);
            try {
              const mail = await services.verification({ kind: "workday-account", email, host, company: request.company, applyUrl: request.applyUrl });
              if (mail?.link) {
                await browser.navigate(tabId, mail.link);
                await pause(2000);
                break;
              }
            } catch (error) {
              return { park: `the career site wants the address verified: ${error?.message ?? error}` };
            }
          }
          if (!password) return { park: `${host} wants a sign-in and there is no Workday password in the profile` };
          if (seen.signin >= 2) {
            const recovered = await recoverAccount(page, { host, email, password, request, services, log, seen });
            if (recovered.recovered) break;
            return { park: recovered.park ?? `could not sign in to ${host}${complaint ? ` (${complaint})` : ""}` };
          }
          if (seen.create === 0 && seen.signin === 0 && policy?.register && (await api(page, "toCreateAccount"))) {
            await pause(1200);
            break;
          }
          seen.signin += 1;
          await api(page, "signIn", email, password);
          await pause(3000);
          break;
        }

        default:
          await pause(1500);
      }
    }
    return { park: "the Workday sign-in pages kept coming back; left open to get past by hand" };
  },

  /**
   * A checkpoint, against the page as it is now.
   *
   * Reconciliation is one question - is the wizard where the checkpoint
   * says it was - and the honest answer is usually no. Workday re-renders
   * from server state on every load, so a wizard reopened after a crash
   * comes back wherever the last Continue saved it, which may be ahead of
   * the checkpoint (a save that landed after the write) or behind it (one
   * that did not). Neither is knowable from the checkpoint.
   *
   * So the page wins, always, and the checkpoint is used for the one thing
   * it is reliable for: saying how far this attempt got, so a person
   * reading the record knows. Nothing is skipped on its word.
   */
  async restore({ browser, tabId, checkpoint, log, request }) {
    const state = await settled({ browser, tabId });
    if (!state) return { restored: false };
    const at = state.step || state.kind;
    const saved = checkpoint?.pages ?? [];

    if (saved.includes(at)) {
      log("info", `${request.company} - Workday reopened on "${at}", which the checkpoint had already saved; filling it again rather than trusting the note`);
    }
    return { restored: true, at, pagesBehind: saved.length, reconciled: "the page, not the checkpoint" };
  },

  /** The wizard's own reading of this page, injected and asked. */
  async inspect({ browser, tabId, request, log }) {
    const page = { browser, tabId };
    const state = await settled(page);
    if (!state) return null;
    // No fields, and that is right rather than a page that failed to load:
    // Review quotes the answers back as prose and the receipt is prose.
    if (state.kind === "review" || state.kind === "done") return { frameId: 0, fields: [], ready: true, state };

    // My Experience is the one page whose shape is not a list of fields: it
    // is a repeating section per job and per school, with the resume
    // attached under it. The page script writes those from the parsed
    // resume, and what is left over is ordinary fields.
    if (state.kind === "experience") {
      const schools = request.resumeData?.education ?? request.education ?? [];
      const report = await api(page, "fillExperience", {
        experience: (request.resumeData?.experience ?? []).map(asJob),
        education: asSchool(Array.isArray(schools) ? schools[0] : schools),
        resume: null,
      }).catch(() => null);
      if (report) log("info", `${request.company} - My Experience: ${report.jobs ?? 0} job(s) written from the resume${report.education ? ", education set" : ""}`, report.notes?.length > 0 ? report.notes : undefined);
    }

    const wanted = await api(page, "idRequested").catch(() => null);
    if (wanted?.uploads?.length > 0) {
      return { frameId: 0, fields: [], blocked: `this application requires an upload of "${wanted.uploads[0]}", which is not the resume or the cover letter` };
    }

    const inventory = await api(page, "inventory", { skipStructured: state.kind === "experience" });
    const fields = (inventory?.fields ?? []).filter((field) => !(field.type === "file" && field.current));
    // What the page turned out to be made of, under the names Workday gives
    // it. A field the resolver could not answer is reported by its visible
    // label, and a Workday label is often the drop zone's own wording
    // rather than the question - "Upload a file (5MB max)" - so the
    // automation id is the only thing in the record that says which
    // control it actually was.
    log("info", `${request.company} - "${state.step || state.kind}" holds ${fields.length} field(s)`, fields.map((field) => `${field.name}:${field.kind}${field.required ? "*" : ""}`));
    return { frameId: 0, fields, state };
  },

  fill: ({ browser, tabId, fills, attachments }) => api({ browser, tabId }, "apply", { fills, attachments }),

  verify: ({ browser, tabId }) => api({ browser, tabId }, "verify"),

  menuOptions: async ({ browser, tabId, key }) => (await api({ browser, tabId }, "menuOptions", key)) ?? [],

  /**
   * Which attachments the tenant has finished taking.
   *
   * Asked properly rather than answered "yes", because `src/workday.js`
   * waits for the same marker itself - inside the page call, which is one
   * foreground turn, for up to forty-five seconds. That is the starvation
   * this architecture exists to prevent, surviving inside a page script
   * where the scheduler cannot see it. The cutover should hand that wait
   * to this poll, which is turn-by-turn and costs nothing between looks.
   */
  uploadsSettled: async ({ browser, tabId }) => {
    const files = await api({ browser, tabId }, "fileNames").catch(() => null);
    const pending = await browser
      .inFrame(tabId, 0, () =>
        [...document.querySelectorAll('[data-automation-id="file-upload-item"]')]
          // An upload in flight has to say so. Asking instead whether the
          // item carries the success marker reads every finished one as
          // pending wherever Workday does not redraw that marker - which
          // is the Review page, where the attachments are a saved list and
          // not a widget. A completed application parked there saying the
          // résumé it had already uploaded twice was "still uploading".
          .filter((item) => item.querySelector('[role="progressbar"], [data-automation-id="file-upload-progress"], [data-automation-id="file-upload-uploading"]'))
          .map((item) => item.querySelector('[data-automation-id="file-upload-item-name"]')?.textContent?.trim() ?? "a file"),
      )
      .catch(() => []);
    return { settled: (pending ?? []).length === 0, pending: pending ?? [], files: files ?? [] };
  },

  /**
   * Continue, and what came of it.
   *
   * Stops at Review rather than pressing through it. The last Continue on a
   * Workday wizard is the submission, and the claim that keeps one company
   * from being applied to twice is taken by the engine immediately before
   * Submit - so an `advance` that pressed it would send an application
   * around the duplicate guard.
   */
  async advance({ browser, tabId, request, log, page: index = 0 }) {
    const page = { browser, tabId };
    const state = await settled(page);
    if (!state) return { park: "the Workday page could not be read before moving on" };
    const at = state.step || state.kind;

    if (state.kind === "done") return { done: true, at, finished: true };
    if (state.kind === "review") return { done: true, at, atSubmit: true };

    const from = `${state.kind}|${state.step}`;
    const moved = await press(page, from);
    if (!moved.moved) {
      return { more: true, moved: false, at, reason: moved.complaint ?? moved.reason ?? `the "${at}" page would not move on` };
    }

    log("info", `${request.company} - Workday: "${at}" saved${moved.state?.step ? `; now "${moved.state.step}"` : ""} (page ${index + 1})`);
    if (moved.state?.kind === "done") return { done: true, moved: true, at, finished: true };
    return { more: true, moved: true, at };
  },

  /** The last Continue. By this point the engine holds the company's claim. */
  async submit({ browser, tabId }) {
    const page = { browser, tabId };
    const state = await settled(page);
    if (state?.kind !== "review") return { clicked: false, reason: `Submit was asked for on the "${state?.step || state?.kind}" page rather than Review` };
    const pressed = await api(page, "next");
    return pressed?.clicked ? { clicked: true } : { clicked: false, reason: pressed?.reason ?? "no Submit button on the review page" };
  },

  /**
   * Whether Workday took it.
   *
   * A wizard has no network receipt to read and no code boxes - its own
   * confirmation page is the only evidence there is, and it has to be a
   * *new* one: some tenants show "thank you for applying" wording on the
   * account page before anything is sent, which is how four real receipts
   * and one welcome page ended up filed the wrong way round in the audit.
   */
  async readOutcome({ browser, tabId, before = [], timeoutMs = 20000 }) {
    const page = { browser, tabId };
    const deadline = Date.now() + timeoutMs;
    let complaint = "";

    while (Date.now() < deadline) {
      await pause(700);
      const state = await api(page, "state").catch(() => null);
      if (!state || state.loading) continue;

      if (state.kind === "done" && state.quote) {
        const receipt = newConfirmation(state.quote, before);
        if (receipt) return { status: OUTCOMES.CONFIRMED, receipt };
      }
      const said = [state.errors?.heading, ...(state.errors?.alerts ?? [])].filter(Boolean).join("; ");
      if (said) complaint = said;
    }

    if (complaint) return { status: OUTCOMES.REJECTED, complaints: complaint, reason: `Workday refused the submission: ${complaint}` };
    return { status: OUTCOMES.UNCERTAIN, reason: "pressed Submit, but Workday showed no new confirmation; treated as sent" };
  },
};

/* ------------------------------------------------- the stranded accounts */

/**
 * Tenants this worker has already asked for a password reset.
 *
 * A Workday tenant carries dozens of postings and every one of them
 * reaches `account()` separately, so without this the first stranded
 * employer would be mailed a reset link once a minute all night. It is
 * deliberately not durable: a worker that dies and comes back may ask one
 * more time, and asking again is harmless because the recovery converges
 * rather than accumulating - see `recoverAccount`.
 */
const resetAsked = new Set();

/**
 * What the mailbox reader has to find before a reset can be finished, and
 * the whole specification of the one thing it cannot do yet.
 *
 * Workday's reset mail is not its activation mail. The subject is
 * different, it is sent by the tenant rather than by otp.workday.com, and
 * the link is a reset path rather than `/activate/` - so neither half of
 * `activation()` in src/apply/verification.js matches it, and every other
 * kind that file knows is routed to `securityCode()`, which looks for
 * eight digits and would both miss the link and report the failure as a
 * submitted application that must not be applied to again.
 *
 * So a kind it does not advertise is never asked for. `services` says
 * which kinds it reads in `verificationKinds`; until that list contains
 * this one the reset is requested and then handed to a person, which is
 * still the difference between a permanently lost tenant and a thirty-
 * second fix. Supporting it is a branch alongside `activation()` that
 * takes exactly the fields below.
 */
const RESET_MAIL = {
  kind: "workday-password-reset",
  search: '{subject:("reset your password" OR "password reset" OR "forgot your password")} newer_than:1h',
  linkPattern: "/reset-password|/forgot-password|/password-reset|/resetPassword",
  // Short on purpose. This is a registered wait and costs no foreground,
  // but a mailbox that cannot see this mail at all should say so in two
  // minutes rather than four, because the attempt behind it is already
  // one that was going to be lost.
  timeoutMs: 120000,
};

/** Whether the mailbox reader reads reset mail, as opposed to code mail. */
const readsResetMail = (services) =>
  typeof services?.verification === "function" && (services.verificationKinds ?? []).includes?.(RESET_MAIL.kind) === true;

/**
 * Getting back into a Workday account nothing on this machine can open.
 *
 * An employer whose candidate account already exists under this address,
 * with a password the profile does not hold, is permanently unreachable:
 * Workday will not create a second account for one address and will not
 * let a guest apply. Two tenants were lost that way on the first
 * unattended night and the set only grows as the bot meets more
 * employers, which is what makes this worth doing at all.
 *
 * ## Why it cannot loop and cannot reset twice
 *
 * Three separate things hold it:
 *
 *   - The new password is the one the profile already holds. There is no
 *     fresh secret to store and nothing to lose, and the end state after
 *     one reset and after five is identical, so a repeat is a no-op
 *     rather than a second change.
 *   - One attempt per `account()` call (`seen.reset`), and one per tenant
 *     per worker (`resetAsked`). A tenant that has been tried and failed
 *     parks with the reason instead of being tried again by the next
 *     posting on the same site.
 *   - A successful reset buys exactly one more sign-in, not a fresh pair.
 *     If that one fails the next turn finds `seen.reset` already spent
 *     and parks.
 *
 * And nothing is changed until the whole sequence completes: asking for
 * the mail leaves the account exactly as it was, so an attempt abandoned
 * halfway - which is what happens while the mailbox cannot read this mail
 * - costs a link sitting in the applicant's inbox and nothing else. That
 * link is useful on its own, which is why the park says so.
 */
async function recoverAccount(page, { host, email, password, request, services, log, seen }) {
  if (seen.reset > 0 || resetAsked.has(host)) {
    return { park: `${host} has an account under ${email} that this password does not open, and a reset has already been tried. Sign in by hand once and set the password to the one in Settings` };
  }
  seen.reset += 1;
  resetAsked.add(host);

  log("warn", `${request.company} - ${host} has an account for ${email} that the stored password does not open; asking it to mail a reset`);
  const asked = await api(page, "forgotPassword", email);
  if (!asked?.ok) return { park: `could not sign in to ${host} and no reset could be started: ${asked?.reason ?? "the page did not answer"}` };

  if (!readsResetMail(services)) {
    return { park: `${host} has an account under ${email} that the stored password does not open, and a password reset has just been mailed there. Follow that link once and set the password to the one in Settings; every posting on this tenant goes through unattended from then on` };
  }

  let mail;
  try {
    mail = await services.verification({ ...RESET_MAIL, email, host, company: request.company, applyUrl: request.applyUrl });
  } catch (error) {
    return { park: `${host} has mailed a password reset to ${email} and the mailbox reader could not find it (${error?.message ?? error}). Follow that link and set the password to the one in Settings, and this tenant works from then on` };
  }
  if (!mail?.link) return { park: `${host} mailed something about the account that carried no reset link; the mail is in ${email}` };

  await page.browser.navigate(page.tabId, mail.link);
  await pause(2500);
  const set = await api(page, "setNewPassword", password);
  if (!set?.ok) return { park: `${host} mailed a reset link and would not take the stored password: ${set?.reason ?? "the reset page did not answer"}` };

  log("info", `${request.company} - ${host} now uses the stored Workday password; signing in`);
  await pause(2500);
  // One more sign-in, not a fresh pair of them.
  seen.signin = 1;
  return { recovered: true };
}

/* ----------------------------------------------------- the resume, remade */

/**
 * A parsed resume states a job the way a resume reads it: a title, and one
 * line of dates, "Jul 2023 - Present". My Experience wants a role, a start
 * and an end, each its own control, and the panel's title and start date
 * are both required - so a panel handed the resume's own wording went in
 * with every box empty and Continue answered "The field Job Title is
 * required" once per job. Nothing in the page script was wrong; the two
 * shapes had simply never been introduced, which is why this page has
 * never carried a real application through.
 *
 * The translation lives here because this is the seam between what the
 * request holds and what the board asks for. The page script stays a
 * writer with no opinion about what a resume is.
 */
const RANGE = /\s*(?:[-–—]|\bto\b)\s*/i;

function asJob(job = {}) {
  const [from = "", until = ""] = String(job.dates ?? "").split(RANGE);
  return {
    role: job.role ?? job.title ?? "",
    company: job.company ?? "",
    location: job.location ?? "",
    startDate: job.startDate ?? from,
    endDate: job.endDate ?? until,
    bullets: job.bullets ?? [],
    summary: job.summary ?? "",
  };
}

/** The last year named is the one the degree was finished in. */
function asSchool(entry) {
  if (!entry) return null;
  return { school: entry.school ?? "", degree: entry.degree ?? "", year: entry.year ?? String(entry.dates ?? "").match(/\b(?:19|20)\d{2}\b/g)?.at(-1) ?? "" };
}

/* --------------------------------------------------------------- the page */

/** Inject the Workday page script and call one of its methods. */
async function api({ browser, tabId }, method, ...args) {
  await browser.inject(tabId, ["src/workday.js"]).catch(() => {});
  return browser.inFrame(tabId, 0, (name, params) => (window.__wdApply ? window.__wdApply[name](...params) : null), [method, args]);
}

/**
 * The page once it has stopped loading and settled on being one thing.
 *
 * Workday draws a page's fields a few at a time and fills its menus a fetch
 * later, so "loaded" is not a usable signal - what is on screen has to hold
 * still. The signature is which page, how many fields, and what the menus
 * say; two and a half seconds unchanged is settled.
 *
 * Every look is one turn and every gap between looks is outside one, which
 * is why this can afford to look often.
 */
async function settled({ browser, tabId }, timeoutMs = TIMINGS.settle) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let signature = "";
  let since = 0;

  while (Date.now() < deadline) {
    const now = await api({ browser, tabId }, "state").catch(() => null);
    last = now ?? last;
    // Workday's own error page is as settled as it will get.
    if (now?.broken) return now;
    const current = now && !now.loading && now.kind !== "unknown" ? `${now.kind}|${now.step}|${now.drawn}|${now.menus}` : "";
    if (current && current === signature) {
      if (Date.now() - since >= TIMINGS.still) return now;
    } else {
      signature = current;
      since = Date.now();
    }
    await pause(TIMINGS.poll);
  }
  return last;
}

/**
 * Presses Continue and waits for the wizard to move on - or to complain.
 *
 * The complaint has to hold for a moment before it counts: the previous
 * page's alert is still on screen while the save is in flight, and read at
 * once it reports a page that saved fine as a page that refused.
 */
async function press(page, from) {
  const pressed = await api(page, "next");
  if (!pressed?.clicked) return { moved: false, reason: pressed?.reason ?? "no Continue button" };

  const deadline = Date.now() + TIMINGS.move;
  let state = null;

  while (Date.now() < deadline) {
    await pause(500);
    state = await api(page, "state").catch(() => null);
    if (!state || state.loading) continue;
    if (state.kind === "done") return { moved: true, state };

    if (state.errors?.heading || state.errors?.alerts?.length > 0) {
      await pause(1200);
      const again = await api(page, "state").catch(() => null);
      if (again && `${again.kind}|${again.step}` !== from) return { moved: true, state: again };
      if (again && (again.errors?.heading || again.errors?.alerts?.length > 0)) {
        return { moved: false, state: again, complaint: [again.errors.heading, ...again.errors.alerts].filter(Boolean).join("; ") };
      }
      continue;
    }

    // The progress bar redraws a moment before the new page's fields; the
    // same kind with no step named yet is the old page, still leaving.
    const leaving = (state.step === "" && from.startsWith(`${state.kind}|`)) || (state.kind === "form" && from.endsWith(`|${state.step}`));
    if (`${state.kind}|${state.step}` !== from && !leaving) {
      await pause(350);
      return { moved: true, state: await settled(page, 15000) };
    }
  }
  return { moved: false, state, reason: `the page would not move on within ${Math.round(TIMINGS.move / 1000)} seconds` };
}

/* ------------------------------------------------------------------ small */

/** Runs in the page. Workday served from a company's own domain. */
function workdayMarkup() {
  if (/\.myworkdayjobs\.com$/i.test(location.hostname)) return true;
  if (document.querySelector('[data-automation-id="applyFlowPage"], [data-automation-id="adventureButton"], [data-automation-id="jobPostingHeader"]')) return true;
  return [...document.querySelectorAll("iframe")].some((frame) => /myworkdayjobs\.com/i.test(frame.src || ""));
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
};
