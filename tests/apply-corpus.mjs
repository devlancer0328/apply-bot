/**
 * The apply module against a real corpus of saved job applications.
 *
 * Every posting here is live, and belongs to a real person's real job
 * search, so the two acts with consequences are two separate switches that
 * have to be asked for by name. SUBMIT files applications. REGISTER opens
 * candidate accounts, and exists apart from SUBMIT because Workday keeps
 * its form behind one: a review run refused an account reviews nothing.
 *
 * With neither set - the default, and how this is normally run - nothing
 * may be sent and nothing may be signed up for. Three things enforce that,
 * deliberately overlapping, because one guard is a guard and three are a
 * guarantee:
 *
 *   1. Every attempt runs with `policy.review = true`, and the engine
 *      returns before the preflight, claim and submit steps are reached.
 *   2. No claim service is supplied, so even a review flag that somehow
 *      got lost would stop at "no duplicate-protection service".
 *   3. A page init script cancels every `submit` event in every frame at
 *      the capture phase and counts what it cancelled. The count is
 *      asserted to be zero at the end, so an accidental Enter key in a
 *      text box would be caught rather than sent.
 *
 * What this is for: the Greenhouse postings are the real test of the one
 * adapter that exists. The rest park, as intended, and are probed for what
 * the next five adapters will need - a form nobody has written code for is
 * still perfectly willing to describe itself.
 */

import { chromium } from "playwright";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browsersDir, scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const corpus = process.env.CORPUS ?? "/home/administrator/Downloads/Daniel";
const only = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
const outFile = process.env.OUT ?? "test-results/apply-corpus.json";
const portable = (await readdir(browsersDir).catch(() => [])).find((name) => /^chromium-\d+$/.test(name));
const executablePath = portable ? resolve(browsersDir, portable, "chrome-win64/chrome.exe") : undefined;

/**
 * The candidate's LinkedIn address, and whether a non-compete binds them.
 *
 * Both of these used to live only here, and both were the whole reason an
 * application stopped: five of the ten Greenhouse postings require a
 * LinkedIn URL and no resume.json carries one, and the single posting that
 * did not stop on LinkedIn stopped on the non-compete instead. Neither is a
 * judgement the resolver may make - inventing either would be a false
 * statement on a real application - so refusing was right and the fix was
 * never going to be in the resolver.
 *
 * It was in the profile, and that is where they are now (see
 * scripts/profile-sync.mjs). These two are left as overrides for trying a
 * different answer against the corpus without disturbing what is stored,
 * and an unset one no longer blanks the stored fact.
 */
const LINKEDIN = process.env.LINKEDIN ?? "";
const NON_COMPETE = process.env.NON_COMPETE ?? "";

/**
 * Driving the person's own Chrome instead of a throwaway profile.
 *
 * Set CHROME_USER_DATA_DIR and CHROME_PROFILE to run the corpus with real
 * cookies and real sessions, which is the only way to see what a board
 * shows a signed-in candidate. Playwright drives it over the pipe
 * transport, because Chrome has refused `--remote-debugging-port` against
 * the default user-data-dir since 136.
 */
const userDataDir = process.env.CHROME_USER_DATA_DIR;
const profileDirectory = process.env.CHROME_PROFILE;

/**
 * The person's real session, carried in as cookies.
 *
 * Driving their own Chrome directly turned out to be closed to us: since 136
 * it refuses a debugger against the default user-data-dir over the pipe as
 * well as over a port, and the stable channel no longer side-loads an
 * unpacked extension at all. Carrying the session into the same browser the
 * baseline used is better anyway - the browser build is then held constant,
 * so any difference in results is the difference in being signed in.
 */
const cookieJar = process.env.COOKIES;

/** Applies under this address instead of the resume's, when set. */
const EMAIL = process.env.EMAIL ?? "";

/**
 * Whether this run may create candidate accounts, and what with.
 *
 * Separate from SUBMIT because the two permissions are separate acts and
 * Workday needs them in that order: the wizard is behind the account, so a
 * review run that may not register never sees a single field of the form
 * it is supposed to be reviewing. REGISTER on its own is how the seven
 * Workday postings get read at all - accounts created, nothing sent, the
 * submit guard still standing. SUBMIT implies it, because an application
 * that may be sent is not improved by refusing it a way in.
 *
 * The password is written into the stored profile rather than kept here,
 * because the account it opens outlives the run: the next attempt at the
 * same tenant has to sign in to it, and a password that existed only for
 * the length of one process would lock the applicant out of accounts
 * created in their own name.
 */
const REGISTER = Boolean(process.env.SUBMIT || process.env.REGISTER);
const WORKDAY_PASSWORD = process.env.WORKDAY_PASSWORD ?? "";

/** A browser the person already has open, e.g. http://127.0.0.1:9222. */
const attachTo = process.env.ATTACH;
let attached = null;

/**
 * The throwaway profile, for runs that are not borrowing one. Only a
 * profile this run minted is ever cleaned up afterwards: the person's own
 * user-data-dir, and whatever an attached browser is sitting on, are not
 * ours to delete.
 */
const profilePath = userDataDir || attachTo ? null : scratchPath("corpus-profile");

/**
 * One posting beyond this is a posting that is not going to answer.
 *
 * A run allowed to register or to submit is given much longer, because its
 * long case is long for a legitimate reason: a board that holds the
 * application for an emailed code or an emailed account activation is
 * allowed two and a half to three minutes to wait for it, and
 * that is this entire budget on its own, with filling the form and reading
 * the outcome still to be paid for before it starts. The Scale AI
 * application came in at 143.7s against a flat 150s alarm - six seconds
 * from having a sent application cut off and filed as a harness error, with
 * the tab torn down underneath it.
 */
const POSTING_MS = Number(process.env.POSTING_MS ?? (REGISTER ? 420000 : 150000));

/* ------------------------------------------------------------ the corpus */

/** One directory per company, one role directory inside it, four files in that. */
async function readCorpus(directory) {
  const postings = [];
  for (const company of (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const role of (await readdir(resolve(directory, company.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const folder = resolve(directory, company.name, role.name);
      const applyUrl = (await readFile(resolve(folder, "job-link.txt"), "utf8").catch(() => "")).trim();
      if (!applyUrl) continue;
      postings.push({
        company: company.name,
        title: role.name,
        applyUrl,
        host: new URL(applyUrl).hostname,
        jd: await readFile(resolve(folder, "job-description.txt"), "utf8").catch(() => ""),
        resumeData: JSON.parse(await readFile(resolve(folder, "resume.json"), "utf8").catch(() => "null")),
        resumePdf: await readFile(resolve(folder, "Resume.pdf")).catch(() => null),
        resumeName: `${basename(company.name)} - Resume.pdf`,
      });
    }
  }
  return postings;
}

/**
 * Which of the seven boards an address belongs to, for grouping the report.
 * This is the harness's own reckoning, not the module's - the module decides
 * by looking at the page, which is the whole point, and the two disagreeing
 * is a finding rather than a bug in either.
 */
const BOARDS = [
  ["greenhouse", /(^|\.)greenhouse\.io$/i],
  ["workday", /\.myworkdayjobs\.com$/i],
  ["ashby", /(^|\.)ashbyhq\.com$/i],
  ["lever", /(^|\.)lever\.co$/i],
  ["workable", /(^|\.)workable\.com$/i],
  ["applytojob", /(^|\.)applytojob\.com$/i],
];
const boardOf = (host) => BOARDS.find(([, pattern]) => pattern.test(host))?.[0] ?? "unsupported";

/* ----------------------------------------------------------- the browser */

const postings = (await readCorpus(corpus)).filter((posting) => !only || only.test(posting.company));
console.log(`${postings.length} postings from ${corpus}\n`);

const report = { startedAt: new Date().toISOString(), corpus, results: [] };
let context;
/** Hoisted so the cleanup below can close it; see the note there. */
let driver;

try {
  // The person's own extensions stay off for the run. This is a launch
  // flag and nothing else: it is not written into the profile, and their
  // Chrome comes back with all of them when it is restarted normally.
  const args = [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-proxy-server"];
  if (profileDirectory) args.push(`--profile-directory=${profileDirectory}`);
  if (userDataDir) {
    // Chrome 142 needs telling twice. It ignores --load-extension unless the
    // kill switch is disabled, and it decides how to decrypt the profile's
    // cookies by sniffing the desktop environment - which is not there when
    // it is started from a script, so it guesses `basic`, derives the wrong
    // key and silently comes up signed out of everything.
    args.push("--disable-features=DisableLoadExtensionCommandLineSwitch", "--password-store=gnome-libsecret");
  }

  // Attaching to a browser the person already has open, already signed in
  // to, and is already watching. Launching our own would mean a second
  // window and a second set of logins, and the profile they signed into is
  // locked by the window they are looking at.
  if (attachTo) {
    attached = await chromium.connectOverCDP(attachTo);
    context = attached.contexts()[0];
    if (!context) throw new Error(`nothing to attach to at ${attachTo}`);
  } else
  context = await chromium.launchPersistentContext(userDataDir ?? profilePath, {
    // Chrome stable will not side-load an unpacked extension, so a run that
    // needs the extension points CHROME_BINARY at a build that still can.
    ...(process.env.CHROME_BINARY ? { executablePath: process.env.CHROME_BINARY } : userDataDir ? { channel: "chrome" } : executablePath ? { executablePath } : { channel: "chromium" }),
    headless: !process.env.HEADFUL,
    args,
    viewport: { width: 1440, height: 1050 },
  });

  // What the person already had open. An attached run is a guest in their
  // browser, and the cleanup after each posting used to close every page it
  // could see - which on an attached browser is their mailbox, their notes
  // and whatever else they were in the middle of. It now closes the pages
  // this run opened and nothing else.
  const theirs = new Set(context.pages());

  // Guard three. Runs before any page script, in every frame, on every
  // navigation. Nothing in the engine presses Submit in review mode; this
  // is here for the thing nobody predicted.
  await context.addInitScript(({ reallySubmit, mayRegister }) => {
    window.__blockedSubmits = 0;
    // A real run has to be able to press Submit, so the guard stands aside.
    // It is the only thing between a filled form and a filed application,
    // which is why it is switched off explicitly rather than by default.
    if (!reallySubmit) {
      // Workday's Create Account and Sign In pages are ordinary forms, so
      // pressing their button raises a `submit` the guard cancelled along
      // with everything else - and a review run that may register then
      // spent its whole budget pressing buttons that did nothing before
      // parking on "could not sign in". The test is those two buttons
      // being on screen and nothing else: Workday counts Create Account /
      // Sign In as step one of six, so it sits inside `applyFlowPage` like
      // every other page and excluding that frame excludes the wall along
      // with it. The buttons themselves are gone by the time there is an
      // application to protect, and the wizard's own Continue is not a
      // form submit.
      const accountWall = () => Boolean(document.querySelector('[data-automation-id="createAccountSubmitButton"], [data-automation-id="signInSubmitButton"]'));
      window.addEventListener(
        "submit",
        (event) => {
          if (mayRegister && accountWall()) return;
          window.__blockedSubmits += 1;
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
    }

    // The two guards stand down separately because the two acts are
    // separate, and a run reviewing Workday needs exactly this pair: an
    // account it is allowed to create, and a Submit it is not. Tying them
    // together is what made the wizard unreviewable - the form is behind
    // the account, so refusing the account refuses the review.
    if (mayRegister) return;

    // Guard four, which the submit guard never covered. Workday asks for a
    // candidate account before the form, so the act with consequences
    // happens long before anything is submitted - and unlike a filled form,
    // a registration is a durable record in that employer's ATS that nobody
    // can take back. Matched on Workday's own automation ids, including
    // `click_filter`, the transparent overlay its buttons are clicked
    // through; a guard watching only buttons would watch the wrong element.
    window.__blockedRegistrations = 0;
    const REGISTRATION = ["createAccountSubmitButton", "signInSubmitButton", "CreateAccountWithEmailButton", "SignInWithEmailButton", "createAccountLink", "signInLink"];
    window.addEventListener(
      "click",
      (event) => {
        for (let node = event.target; node && node !== document.documentElement; node = node.parentElement) {
          const id = node.getAttribute?.("data-automation-id");
          const wrapped = id === "click_filter" && node.closest('[data-automation-id="noCaptchaWrapper"]')?.querySelector(REGISTRATION.map((name) => `[data-automation-id="${name}"]`).join(","));
          if (!(id && REGISTRATION.includes(id)) && !wrapped) continue;
          window.__blockedRegistrations += 1;
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      },
      true,
    );
  }, { reallySubmit: Boolean(process.env.SUBMIT), mayRegister: REGISTER });

  // A real profile that comes up signed out is worse than no real profile:
  // the run would look like the baseline and prove nothing, and the reason
  // is usually a locked keyring rather than anything about the sites. So it
  // is checked before thirty-one postings are spent on it.
  if (cookieJar) {
    const saved = JSON.parse(await readFile(cookieJar, "utf8"));
    await context.addCookies(saved);
  }

  if (userDataDir || cookieJar || attachTo) {
    const cookies = await context.cookies();
    const google = cookies.filter((cookie) => /(^|\.)google\.com$/.test(cookie.domain));
    report.session = {
      cookies: cookies.length,
      googleCookies: google.length,
      signedIn: google.some((cookie) => /^(?:__Secure-\d*PSID|SID|SSID|HSID)$/.test(cookie.name)),
      domains: [...new Set(cookies.map((cookie) => cookie.domain))].length,
    };
    console.log(`Profile: ${report.session.cookies} cookies across ${report.session.domains} domains; Google session ${report.session.signedIn ? "live" : "ABSENT"}`);
    if (!report.session.signedIn) throw new Error("the launched profile has no live Google session; refusing to run the corpus against a silently signed-out browser");
  }

  // A real profile can have several extensions, and one of them may be an
  // older build of this one. Taking whichever worker answered first picks
  // its workspace page instead of ours, which then never shows what we are
  // waiting for - so when the id is known it is matched exactly.
  const wanted = process.env.EXT_ID;
  const ours = (list) => (wanted ? list.find((worker) => worker.url().includes(wanted)) : list[0]);
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${wanted}; is it installed and awake?`);
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  driver = await context.newPage();
  await driver.goto(`${origin}/src/options.html`);
  await driver.getByRole("heading", { name: "A little more organized. A lot more you." }).waitFor();

  // The candidate is the corpus's own person, taken from the first
  // resume.json. Filling a stranger's name into someone's real application
  // forms would make every parked page useless to them.
  const person = postings.find((posting) => posting.resumeData)?.resumeData;
  // Written as a merge of what is not blank, never as a blank. `writeProfile`
  // merges, so a key left out keeps what is stored - and the facts that stop
  // applications now live in the stored profile (see scripts/profile-sync.mjs)
  // rather than in an environment variable. Writing `linkedin: ""` because
  // nobody exported LINKEDIN would delete the one field that accounted for
  // most of what this corpus could not fill.
  const stored = await driver.evaluate(async ({ who, linkedin, nonCompete, email, register, password }) => {
    const [first, ...rest] = String(who.name || "").split(/\s+/);
    const [city, state] = String(who.location || "").split(",").map((part) => part.trim());
    const facts = {
      firstName: first ?? "", lastName: rest.join(" "), email: email || who.email || "", phone: who.phone ?? "",
      city: city ?? "", state: state ?? "", country: "United States", linkedin, nonCompete,
      startDate: "Two weeks after offer", workAuthorization: "us-citizen", requiresSponsorship: "no",
      willingToRelocate: "no", willingToTravel: "yes", remotePreference: "remote",
      ...(password ? { workdayPassword: password } : {}),
    };
    const { writeProfile } = await import("./store.js");
    // Written as a boolean rather than filtered out with the blanks: the
    // permission a run was not given has to be withdrawn from the profile
    // too, or a run that once registered leaves every later one allowed to.
    return writeProfile({ ...Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== "")), allowAccountRegistration: register });
  }, { who: person, linkedin: LINKEDIN, nonCompete: NON_COMPETE, email: EMAIL, register: REGISTER, password: WORKDAY_PASSWORD });
  // The address is worth saying out loud when it is not the resume's own:
  // a verification code is only readable in the mailbox it was sent to.
  console.log(`Candidate: ${person?.name} <${EMAIL || person?.email}>${EMAIL ? ` (overriding ${person?.email})` : ""}  LinkedIn: ${stored.linkedin || "(none stored)"}  non-compete: ${stored.nonCompete || "(none stored)"}`);
  // Said out loud because both are permissions to do something durable to
  // a stranger's recruiting system, and a run that has them should never
  // be one anybody is surprised by afterwards.
  console.log(`Accounts: may register ${stored.allowAccountRegistration ? "YES" : "no"}; Workday password ${stored.workdayPassword ? `stored (${stored.workdayPassword.length} characters)` : "NOT SET"}; may submit ${process.env.SUBMIT ? "YES" : "no"}\n`);

  for (const posting of postings) {
    const board = boardOf(posting.host);
    const at = Date.now();
    process.stdout.write(`${posting.company.padEnd(30)} ${board.padEnd(12)} `);

    let run;
    let alarm;
    try {
      run = await Promise.race([
        attempt(driver, posting),
        new Promise((_, reject) => {
          alarm = setTimeout(() => reject(new Error(`the posting did not answer within ${POSTING_MS / 1000}s`)), POSTING_MS);
        }),
      ]);
    } catch (error) {
      run = { outcome: { status: "harness-error", reason: error?.message ?? String(error), evidence: {} }, asked: [], log: [] };
      // A timed-out attempt is still running inside the driver page. Left
      // there it would share the foreground queue with the next posting and
      // make both unreadable; reloading the page ends it.
      await driver.goto(`${origin}/src/options.html`).catch(() => {});
      await driver.getByRole("heading", { name: "A little more organized. A lot more you." }).waitFor().catch(() => {});
    } finally {
      clearTimeout(alarm);
    }

    const recon = await probe(context, posting.applyUrl);
    const result = { ...posting, resumeData: undefined, resumePdf: undefined, jd: undefined, board, took: Date.now() - at, ...run, recon };
    report.results.push(result);
    console.log(`${result.outcome.status.padEnd(15)} ${((Date.now() - at) / 1000).toFixed(1)}s  ${recon.gone ? "POSTING GONE  " : ""}${(result.outcome.reason || "").slice(0, 70)}`);

    // Parked pages pile up; the module leaves them open on purpose, and
    // thirty of them starves the browser. A real application's confirmation
    // page is the only evidence the person has that it was sent - so it is
    // photographed to a file first, and the durable copy is what survives.
    const slug = posting.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    for (const page of context.pages()) {
      if (page === driver || theirs.has(page)) continue;
      if (page.url().includes(new URL(posting.applyUrl).hostname)) {
        const shot = `test-results/submit-${slug}.png`;
        await page.screenshot({ path: shot, fullPage: false }).then(() => { result.screenshot = shot; }).catch((error) => { result.screenshotError = error.message.slice(0, 120); });
      }
      await page.close().catch(() => {});
    }
    // Written after every posting rather than at the end, so a run that
    // dies on posting nineteen still has the first eighteen on disk.
    await writeFile(outFile, JSON.stringify(report, null, 2)).catch(() => {});
  }

  /* -------------------------------------------------- the safety assertion */

  report.blockedSubmits = report.results.reduce((total, result) => total + (result.recon.blockedSubmits ?? 0), 0);
  report.blockedRegistrations = report.results.reduce((total, result) => total + (result.recon.blockedRegistrations ?? 0), 0);
  report.submittedAnything = report.results.some((result) => result.outcome.submitted === true);
  const reached = report.results.filter((result) => result.recon.reached);
  report.guardInstalled = reached.length > 0 && reached.every((result) => result.recon.guard);
  console.log(`\nSubmit guard present on every reached page: ${report.guardInstalled}`);
  console.log(`Submit events cancelled by the guard: ${report.blockedSubmits}`);
  console.log(`Account registrations cancelled by the guard: ${report.blockedRegistrations}`);
  console.log(`Attempts that reached Submit: ${report.results.filter((result) => result.outcome.submitted).length}`);
  // Having sent something is the failure in a review run and the point of a
  // real one, so it is only read as a failure in the first. The two counters
  // either side of it are failures in both: the guard is only installed when
  // nothing may be sent, so anything it cancelled was a near miss.
  const sentUnasked = report.submittedAnything && !process.env.SUBMIT;
  if (report.blockedSubmits > 0 || report.blockedRegistrations > 0 || sentUnasked) {
    console.error("\n*** SAFETY FAILURE: an attempt tried to submit or register on a live posting. ***");
    process.exitCode = 1;
  }

  summarise(report);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  // An attached browser belongs to the person, not to this run - including
  // the page this run drove the extension from. Detaching without closing
  // it leaves one more workspace tab behind on every run, and four runs in
  // an afternoon is four tabs the person did not open.
  if (attached) {
    await driver?.close().catch(() => {});
    await attached.close();
  }
  else await context?.close();
  if (profilePath) await releaseScratch(profilePath);
  report.finishedAt = new Date().toISOString();
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`\nFull results: ${outFile}`);
}

/* ------------------------------------------------------------ one posting */

/**
 * The model is stubbed, and answers in a way that keeps the form moving
 * rather than realistically: a question that reaches it is a finding in
 * itself, and the point is to see which ones do. The answers are recorded
 * verbatim so a question that should have been resolved from the profile is
 * obvious in the report.
 */
async function attempt(driver, posting) {
  return driver.evaluate(
    async ({ job, resumeBytes }) => {
      const { applyToJob } = await import("./apply/standalone.js");
      const asked = [];
      const log = [];

      const compensation = {
        status: "researched", company: job.company, role: job.title, currency: "USD", period: "year", basis: "base",
        minimum: 150000, maximum: 210000, recommendedAmount: 185000,
        rationale: "Corpus harness evidence; never sent, review only.",
        evidence: { mode: "chatgpt-native-citations", nativeCitations: ["https://example.test/pay"] },
        sources: [{ url: "https://example.test/pay", title: "corpus fixture", company: job.company, role: job.title, matchType: "exact-company-role" }],
      };

      const outcome = await applyToJob({
        job: {
          id: job.applyUrl, applyUrl: job.applyUrl, company: job.company, title: job.title, jd: job.jd,
          compensation,
          resumeText: job.resumeText,
          resumeData: job.resumeData,
          currentRole: job.currentRole,
          currentCompany: job.currentCompany,
          education: job.education,
        },
        documents: {
          resume: new Blob([new Uint8Array(resumeBytes)], { type: "application/pdf" }),
          resumeName: job.resumeName,
        },
        profile: await (await import("./store.js")).readProfile(),
        // Review, and nothing else - unless the run was asked for real
        // applications, in which case the engine goes through preflight and
        // presses Submit, and what it sends cannot be taken back.
        //
        // A confirmed application keeps its tab. The engine closes the tab
        // on every outcome except `challenge`, which is right for a run that
        // files its own evidence and wrong here: the confirmation page is
        // the only thing the person has to show the application was sent.
        policy: { review: !job.reallySubmit, ...(job.reallySubmit ? { keepOpen: true } : {}) },
        services: {
          // Guard two. Supplied rather than left to default precisely so the
          // real `claimSubmission` is never reached: a claim written against
          // a live company would protect an application nobody made. A real
          // run has to claim, or the one-per-company rule means nothing.
          claimCompany: async () =>
            job.reallySubmit ? { claimed: true, record: { company: job.company, claimedAt: new Date().toISOString() } } : { claimed: false, reason: "the corpus harness never claims a company" },
          // What this stub says goes to a real employer under the
          // candidate's name, so "whatever keeps the form moving" is not
          // good enough. Three kinds of wrong answer came out of the
          // previous version, and all three were sent at least once:
          //
          //   - a free-text field got "Yes", because the fallback was the
          //     literal string "Yes" whenever there were no options to
          //     choose from. "Paste your full resume text below" was
          //     answered "Yes" on a filed DataCamp application.
          //   - "Did you hear about this opportunity from a current
          //     DailyPay employee?" got "185000", because the pay regex
          //     matched the "pay" inside "DailyPay".
          //   - every yes/no question got "Yes", because "Yes" is the
          //     first option that is not a decline. That answered "Were
          //     you referred for this position", "Are you related to any
          //     current employee", "Are you currently employed with Tubi"
          //     and "Do you need any reasonable accommodations" with a
          //     false statement.
          //
          // So each question is now classified before it is answered, and
          // a question whose honest answer is not known is left blank
          // rather than guessed - which parks the posting when it is
          // required, and parking is the correct outcome for a fact
          // nobody has supplied.
          answers: async (questions) => {
            const answers = [];
            const unanswered = [];
            const forced = [];

            // A conditional follow-up - "If yes, give their name" - only
            // has an answer when the answer above it was yes, and none of
            // them are. Blank is the truthful entry.
            const CONDITIONAL = /^\s*(?:if (?:yes|so|no|not|any|the|you|your|applicable|selected)|if you (?:selected|answered|were|have|are)|please (?:explain|specify|describe|list)? ?(?:if|when)|should you)/i;
            // Questions whose truthful answer for this candidate is no.
            const NO = /\b(?:referr(?:ed|al)|related to|relative|family member|immediate family|spouse|friend)\b|\b(?:currently|previously|ever) (?:been )?(?:employed|worked)\b|\bformer (?:employee|intern)\b|\bnon-?compete\b|\baccommodat(?:ion|ions)\b|\bconflict of interest\b|\bconvicted\b|\bdebarred\b|\bterminated\b/i;
            // Questions whose truthful answer is yes: eligibility the
            // profile already asserts, and the agree/acknowledge boxes.
            // "Do you meet the required years of experience for this role?"
            // is in here and "are you Workday certified?" deliberately is
            // not: the first is a judgement the résumé's nine years already
            // supports, the second is a credential it never mentions.
            const YES = /\b(?:legally )?authoriz(?:ed|ation)\b|\beligible to work\b|\bat least 18\b|\bover 18\b|\bage of 18\b|\b(?:i )?(?:agree|acknowledge|consent|certify|confirm|understand)\b|\bread and\b|\bwilling to\b|\bable to\b|\bcomfortable\b|\bin alignment with\b|\bconsider (?:you|me) for other\b|\binterested in\b|\bmeets?\b[^?]*\b(?:requirement|qualification|minimum|years of experience)\b/i;
            // A pay field, as opposed to a field with "pay" inside a
            // company name. Both halves have to be there.
            const PAY_WORD = /\b(?:salary|compensation|pay|rate|comp)\b/i;
            const PAY_INTENT = /\b(?:expect\w*|desired|target|requirement\w*|range|minimum|ask)\b/i;
            const RESUME_TEXT = /\b(?:paste|copy)\b[\s\S]*\b(?:resume|cv)\b|\b(?:resume|cv) (?:text|body|contents?)\b|\bfull resume\b/i;
            // The past tense is not a variant worth leaving out: Lever's
            // VGS posting asks "In a few words, what interested you about
            // VGS?" as a required paragraph box, and a present-tense-only
            // list read it as a fact nobody had supplied and parked the
            // whole application over the one question this stub is best
            // placed to answer honestly.
            const PROSE = /\bwhy\b|\btell us\b|\bdescribe\b|\bexplain\b|\bwhat (?:interests?|interested|excites?|excited|draws?|drew|motivates?|motivated|appeals?|appealed)\b|\bcover letter\b|\bin your own words\b/i;
            const DECLINE = /decline|prefer not|do not wish|please select|choose|^-+$/i;
            // A question about where the candidate is, as opposed to one
            // about what they can do. Answering these from a default is
            // stating a fact rather than declining a claim.
            const RESIDENCY = /\b(?:do you (?:currently )?(?:live|reside)|are you (?:currently )?(?:located|based|residing|a resident)|is your (?:primary )?residence|do you have .{0,20}residence)\b/i;

            const pick = (options, pattern) => options.find((label) => pattern.test(label));

            for (const question of questions) {
              const text = String(question.question ?? "");
              const options = (question.options ?? []).map((option) => option.label).filter(Boolean);
              const freeText = options.length === 0;
              const yesNo = options.length <= 3 && Boolean(pick(options, /^\s*yes\b/i)) && Boolean(pick(options, /^\s*no\b/i));
              let value;
              let why;

              if (RESUME_TEXT.test(text) && freeText) {
                value = job.resumeText;
                why = "resume-text";
              } else if (CONDITIONAL.test(text)) {
                // Required and conditional on a "no" above it: say so
                // plainly rather than leaving a required field empty.
                // Spelled out rather than "N/A" because these follow-ups
                // are usually paragraph boxes, and `answerFitsControl`
                // drops a bare "N/A" in a prose box as junk - which left
                // NPR parked on a question this had in fact answered.
                value = question.required ? "Not applicable." : undefined;
                why = "conditional-follow-up";
              } else if (freeText && PAY_WORD.test(text) && PAY_INTENT.test(text)) {
                value = "185000";
                why = "pay";
              } else if (!freeText && /highest level|level of (?:completed )?education|education level/i.test(text)) {
                value = pick(options, /bachelor|b\.?s\.?\b|undergraduate/i) ?? pick(options, /college|university/i) ?? options.find((label) => !DECLINE.test(label));
                why = "education-level";
              } else if (yesNo && NO.test(text)) {
                value = pick(options, /^\s*no\b/i);
                why = "known-no";
              } else if (yesNo && YES.test(text)) {
                value = pick(options, /^\s*yes\b/i);
                why = "known-yes";
              } else if (freeText && PROSE.test(text)) {
                // Grounded in what the resume actually says. Nothing here
                // is a claim the resume does not already make.
                value = `${job.currentRole || "Senior AI Engineer"} with ${job.yearsExperience || "9+"} years building production machine-learning and LLM systems in Python, most recently at ${job.currentCompany || "Querium"}. The ${job.title} role at ${job.company} lines up directly with that work - model evaluation, agentic workflows, and the API and observability work that keeps them dependable in front of real users - which is the part of the job I want to keep doing.`;
                why = "prose";
              } else if (yesNo && RESIDENCY.test(text)) {
                // Where the candidate lives is a fact the profile holds and
                // this stub cannot read, and the blanket No below is not a
                // safe default for it. VGS asks "Do you live in one of the
                // following states... Texas..." and was told No on an
                // application that had already given a Temple, TX ZIP code
                // two fields earlier - a plain falsehood, contradicted by
                // the same form. A wrong No is only the cheap mistake when
                // the question is about a credential; on a question of
                // fact it is the expensive one, so this parks instead.
                value = undefined;
                why = "residency-needs-profile";
              } else if (yesNo) {
                // A yes/no nothing above recognised is answered No, because
                // the two answers are not equally cheap to be wrong about.
                // Taking the first non-decline option meant Yes, and OneSource
                // Virtual was told Daniel Torres holds Workday certifications
                // that appear nowhere in his résumé - which is a false claim
                // on a real application, and which unfolded a required "list
                // them" box that nothing could honestly fill. A wrong No
                // understates him; a wrong Yes invents a credential.
                value = pick(options, /^\s*no\b/i);
                why = "unknown-no";
                forced.push({ key: question.key, question: text });
              } else if (!freeText) {
                value = options.find((label) => !DECLINE.test(label));
                why = "first-option";
              } else if (question.required) {
                value = "N/A";
                why = "required-unknown";
                forced.push({ key: question.key, question: text });
              } else {
                value = undefined;
                why = "left-blank";
              }

              asked.push({ question: text, required: Boolean(question.required), options: options.length, multiline: Boolean(question.multiline), rule: why, answered: value === undefined ? null : String(value).slice(0, 120) });
              if (value === undefined || value === "") unanswered.push(question);
              else answers.push({ key: question.key, value });
            }
            return { answers, unanswered, forced };
          },
        },
        // The detail argument carries the field names behind "3 fields would
        // not take a value", which is the only place they are said.
        log: (level, message, detail) => log.push(`${level}: ${message}${detail ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`),
      });

      return { outcome, asked, log };
    },
    { job: jobPayload(posting), resumeBytes: posting.resumePdf ? [...posting.resumePdf] : [] },
  );
}

/** The posting, flattened into things that survive a structured clone. */
function jobPayload(posting) {
  const data = posting.resumeData ?? {};
  const current = data.experience?.[0] ?? {};
  return {
    applyUrl: posting.applyUrl,
    company: posting.company,
    title: posting.title,
    jd: posting.jd,
    reallySubmit: Boolean(process.env.SUBMIT),
    resumeName: posting.resumeName,
    resumeData: data,
    resumeText: resumeToPlainText(data),
    currentRole: current.title ?? "",
    currentCompany: current.company ?? "",
    // Counted off the resume rather than stated, so a prose answer that
    // cites it cannot drift from what the attached PDF says.
    yearsExperience: yearsOfExperience(data),
    education: data.education?.[0]
      ? { degree: data.education[0].degree ?? "", school: data.education[0].school ?? "", location: data.education[0].location ?? "", year: String(data.education[0].dates ?? "").slice(-4) }
      : undefined,
  };
}

/** Earliest role start year to now, as a whole number of years. */
function yearsOfExperience(data) {
  const years = (data.experience ?? []).map((role) => Number(String(role.dates ?? "").match(/\b(19|20)\d{2}\b/)?.[0])).filter(Number.isFinite);
  if (years.length === 0) return "";
  return String(new Date().getFullYear() - Math.min(...years));
}

function resumeToPlainText(data) {
  return [
    data.name, data.location, data.summary,
    ...Object.entries(data.technicalskills ?? {}).map(([group, items]) => `${group}: ${items}`),
    ...(data.experience ?? []).map((role) => `${role.title} at ${role.company} (${role.dates})\n${(role.bullets ?? []).join("\n")}`),
    ...(data.education ?? []).map((entry) => `${entry.degree}, ${entry.school} (${entry.dates})`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ----------------------------------------------------------- the probe */

/**
 * What the page actually is, asked of the page rather than of its address.
 *
 * This runs after the attempt, on whatever the module left open. For the
 * boards with no adapter yet this is the entire point of the exercise: the
 * frame the form lives in, what the controls are made of, whether there is
 * a sign-in in the way, and which board's fingerprints are on it. Those four
 * answers are most of what writing an adapter needs.
 */
async function probe(context, applyUrl) {
  // By host rather than by address: several of these boards rewrite the URL
  // on arrival - a locale prefix, a tracking parameter, a redirect to the
  // posting's canonical id - and an exact match quietly finds nothing.
  const host = new URL(applyUrl).hostname;
  const page = context.pages().find((open) => open.url().startsWith("http") && open.url().includes(host));
  if (!page) return { reached: false };

  // The module parks on an unrecognised site within a second or two, which
  // is correct for it and useless for this: Workday and Ashby both fetch
  // their form after the document is done, so a probe taken at park time
  // reports an empty page. Reconnaissance is the one thing here that is
  // allowed to wait.
  const settling = Date.now() + 20000;
  while (Date.now() < settling) {
    const counts = await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.querySelectorAll("input, select, textarea").length).catch(() => 0)));
    if (Math.max(0, ...counts) > 0) break;
    await new Promise((done) => setTimeout(done, 500));
  }

  const frames = await Promise.all(
    page.frames().map(async (frame) => {
      const read = await frame
        .evaluate(() => ({
          title: document.title,
          inputs: document.querySelectorAll("input, select, textarea").length,
          files: document.querySelectorAll("input[type=file]").length,
          forms: document.querySelectorAll("form").length,
          iframes: [...document.querySelectorAll("iframe")].map((node) => node.src).filter(Boolean).slice(0, 4),
          buttons: [...document.querySelectorAll("button, input[type=submit], [role=button]")].map((node) => (node.innerText || node.value || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8),
          fingerprints: {
            workday: document.querySelectorAll("[data-automation-id]").length,
            ashby: document.querySelectorAll("[class*='ashby'], .ashby-application-form-field").length,
            lever: document.querySelectorAll("[class*='application-form'], [name^='cards['], .posting-apply").length,
            workable: document.querySelectorAll("[data-ui], [class*='styles__application']").length,
            applytojob: document.querySelectorAll("#job_application, [id^='job_application']").length,
            greenhouse: document.querySelectorAll("#application_form, #grnhse_app, [id^='question_']").length,
            reactSelect: document.querySelectorAll("[class*='select__control'], [class*='react-select']").length,
            customControls: document.querySelectorAll("[role=combobox], [role=listbox], [role=radiogroup]").length,
            reactOwned: [...document.querySelectorAll("input, select, textarea")].filter((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))).length,
          },
          signIn: /sign in|log in|create (?:an )?account|returning candidate/i.test(document.body?.innerText ?? ""),
          gone: /no longer accepting|no longer available|position (?:has been )?(?:closed|filled)|this job is closed|not found|page you (?:are|were) looking for/i.test(document.body?.innerText ?? ""),
          // Distinguished from zero on purpose: a frame the guard never
          // reached would otherwise report a reassuring nothing.
          guard: typeof window.__blockedSubmits === "number",
          blockedSubmits: window.__blockedSubmits ?? 0,
          blockedRegistrations: window.__blockedRegistrations ?? 0,
          text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 220),
        }))
        .catch((error) => ({ unreadable: error.message.slice(0, 80) }));
      return { url: frame.url(), ...read };
    }),
  );

  const form = frames.filter((frame) => frame.inputs > 0).sort((a, b) => b.inputs - a.inputs)[0] ?? frames[0];
  return {
    reached: true,
    url: page.url(),
    title: frames[0]?.title ?? "",
    frameCount: frames.length,
    formFrame: form?.url,
    gone: frames.some((frame) => frame.gone),
    signIn: frames.some((frame) => frame.signIn),
    guard: frames.some((frame) => frame.guard),
    blockedSubmits: frames.reduce((total, frame) => total + (frame.blockedSubmits ?? 0), 0),
    blockedRegistrations: frames.reduce((total, frame) => total + (frame.blockedRegistrations ?? 0), 0),
    frames,
  };
}

/* ---------------------------------------------------------------- report */

function summarise({ results }) {
  const groups = [
    ["Boards with an adapter", (result) => ["greenhouse", "workable", "ashby", "workday"].includes(result.board)],
    ["No adapter yet - reconnaissance", (result) => ["lever", "applytojob"].includes(result.board)],
    ["Unsupported by any of the seven", (result) => result.board === "unsupported"],
  ];

  for (const [heading, belongs] of groups) {
    const rows = results.filter(belongs);
    if (rows.length === 0) continue;
    console.log(`\n${heading} (${rows.length})`);
    console.log("  " + "company".padEnd(30) + "conf".padEnd(6) + "status".padEnd(12) + "filled".padEnd(8) + "asked".padEnd(7) + "secs");
    for (const row of rows) {
      const evidence = row.outcome.evidence ?? {};
      console.log(
        "  " +
          row.company.slice(0, 29).padEnd(30) +
          String(evidence.confidence ?? "-").padEnd(6) +
          String(row.outcome.status).padEnd(12) +
          String(evidence.filled ?? "-").padEnd(8) +
          String(row.asked?.length ?? 0).padEnd(7) +
          // The attempt's own time. `took` on the row includes the probe,
          // which deliberately waits for pages the module was right not to.
          ((evidence.took ?? row.took) / 1000).toFixed(1),
      );
    }
  }
}
