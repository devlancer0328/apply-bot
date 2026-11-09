/**
 * One real application, to one real posting, watched by a person.
 *
 * This is the only harness here that is allowed to send something. The
 * corpus runner exists to prove the module fills correctly and is built so
 * that it cannot submit; this is its opposite, and the difference is not a
 * flag but the whole design. A submission is irreversible and arrives in a
 * real recruiter's queue under a real person's name, so everything below is
 * arranged so that the dangerous thing happens once, late, visibly, and only
 * for the posting that was named on the command line.
 *
 * Run it twice. `SUBMIT=0` fills the form, verifies what the page actually
 * accepted, photographs it and stops - with a guard installed that cancels
 * every submit event, so the pass physically cannot send. `SUBMIT=1` then
 * does it for real. Two browser launches rather than two phases in one,
 * because a guard that is installed and then removed is a guard that can be
 * removed by accident; a guard that was never in this process at all cannot.
 *
 * Nothing here invents an answer. The model service is wired to refuse every
 * open question, which parks the attempt instead of filling it - a stubbed
 * "Yes" is fine in a test and is a lie on a real application. For the same
 * reason no compensation research is supplied: a salary question will block
 * the attempt rather than be answered from a plausible number.
 */

import { chromium } from "playwright";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

/** The one company. There is no "all", on purpose. */
const COMPANY = process.env.COMPANY ?? "Ondo";
/** The irreversible switch. Anything other than exactly "1" is a dry run. */
const SUBMIT = process.env.SUBMIT === "1";
/**
 * Run the submitting path as far as it goes without submitting.
 *
 * The engine settles uploads, then asks for the company claim, and presses
 * Submit only if the claim is granted. Refusing the claim therefore stops it
 * exactly one step short, which is the only way to find out whether the
 * upload-settling preflight would have caught a file the board never took -
 * a question that matters precisely because the review path never reaches
 * it. The submit-cancelling guard stays installed underneath regardless.
 */
const PREFLIGHT_ONLY = process.env.PREFLIGHT_ONLY === "1" && !SUBMIT;
const CORPUS = process.env.CORPUS ?? "/home/administrator/Downloads/Daniel";
const COOKIES = process.env.COOKIES ?? "test-results/profile41-cookies.json";
/** Slow enough to be followed by eye; the point of the exercise is watching. */
const SLOWMO = Number(process.env.SLOWMO ?? 120);
const phase = SUBMIT ? "submit" : "review";
const OUT = process.env.OUT ?? `test-results/live-apply-${COMPANY.toLowerCase()}-${phase}.json`;

/**
 * Facts no resume states and nothing may infer. Absent ones stay absent:
 * the resolver blocks on a required field it cannot answer, which is the
 * behaviour we want on a real form.
 */
const EXTRA = {
  linkedin: process.env.LINKEDIN ?? "",
  github: process.env.GITHUB ?? "",
  street: process.env.STREET ?? "",
  zip: process.env.ZIP ?? "",
  nonCompete: process.env.NON_COMPETE ?? "no",
};

const report = { startedAt: new Date().toISOString(), company: COMPANY, phase, submitAuthorised: SUBMIT, steps: [] };
const note = (message, detail) => {
  console.log(message);
  report.steps.push({ at: new Date().toISOString(), message, ...(detail ? { detail } : {}) });
};

/* ------------------------------------------------------------ the posting */

async function readPosting(directory, company) {
  const match = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .find((entry) => entry.name.toLowerCase() === company.toLowerCase());
  if (!match) throw new Error(`no company directory named ${company} under ${directory}`);

  const roles = (await readdir(resolve(directory, match.name), { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (roles.length !== 1) throw new Error(`${match.name} has ${roles.length} roles; this runner takes exactly one`);

  const folder = resolve(directory, match.name, roles[0].name);
  const data = JSON.parse(await readFile(resolve(folder, "resume.json"), "utf8"));
  return {
    company: match.name,
    title: roles[0].name,
    applyUrl: (await readFile(resolve(folder, "job-link.txt"), "utf8")).trim(),
    jd: await readFile(resolve(folder, "job-description.txt"), "utf8"),
    resumePdf: await readFile(resolve(folder, "Resume.pdf")),
    resumeName: `${match.name} - Resume.pdf`,
    resumeData: data,
  };
}

const posting = await readPosting(CORPUS, COMPANY);
note(`${posting.company} - ${posting.title}`);
note(`  ${posting.applyUrl}`);
note(`  phase: ${phase}${PREFLIGHT_ONLY ? " +preflight-only (claim refused, Submit unreachable)" : ""}${SUBMIT ? "  *** THIS PASS CAN SEND ***" : "  (submit events are cancelled in this pass)"}`);

/** The whole resume as prose, for grounding anything that asks for it. */
function resumeToPlainText(data) {
  return [
    data.name,
    data.location,
    data.summary,
    ...Object.entries(data.technicalskills ?? {}).map(([group, items]) => `${group}: ${items}`),
    ...(data.experience ?? []).map((role) => `${role.title} at ${role.company} (${role.dates})\n${(role.bullets ?? []).join("\n")}`),
    ...(data.education ?? []).map((entry) => `${entry.degree}, ${entry.school} (${entry.dates})`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ------------------------------------------------------------ the browser */

const profilePath = scratchPath("live-apply");
let context;
try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    // Visible, and slow enough to follow. The person asked to watch this.
    headless: false,
    slowMo: SLOWMO,
    // The GPU path on this machine fails vaInitialize and then loses its
    // command buffer, and a headful browser that does that intermittently
    // takes its last window down with it - which, mid-application, would
    // lose the attempt at an unknowable point. Software rendering is slower
    // and keeps the window alive, which is the trade worth making here.
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--no-proxy-server",
      "--start-maximized",
      "--disable-gpu",
      "--disable-features=VaapiVideoDecoder,VaapiVideoEncoder",
    ],
    viewport: null,
  });

  /**
   * No pages of our own beyond the one the extension runs in.
   *
   * A blank tab opened alongside the extension gets reaped out from under
   * us within a few seconds - reliably enough to have killed three runs
   * here, at whichever `waitForTimeout` happened to be holding it. So the
   * extension's own options page is both the driver and the thing keeping
   * the window open, and every other check is done without a tab: liveness
   * over plain HTTP below, and the form photographed on the tab the engine
   * opens for itself, which the extension owns and will not reap.
   */

  /**
   * Creating a candidate account is never permitted here, in either pass.
   *
   * Unlike a filled form, a registration is a durable record in the
   * employer's ATS that nobody can take back, and it has not been
   * authorised. Greenhouse never asks, so this should cancel nothing and
   * the count is reported either way - a guard whose count is never read
   * is not a guard.
   */
  await context.addInitScript(() => {
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
  });

  /**
   * The review pass cannot send, and not because it is asked not to.
   * Installed only in this process, so the submitting pass has no way to
   * inherit it and no line of code that takes it off again.
   */
  if (!SUBMIT) {
    await context.addInitScript(() => {
      window.__blockedSubmits = 0;
      window.addEventListener(
        "submit",
        (event) => {
          window.__blockedSubmits += 1;
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
    });
  }

  /* ------------------------------------------------------- the session */

  const saved = JSON.parse(await readFile(COOKIES, "utf8"));
  await context.addCookies(saved);
  const cookies = await context.cookies();
  const google = cookies.filter((cookie) => /(^|\.)google\.com$/.test(cookie.domain));
  const signedIn = google.some((cookie) => /^(?:__Secure-\d*PSID|SID|SSID|HSID)$/.test(cookie.name));
  report.session = { cookies: cookies.length, googleCookies: google.length, signedIn, domains: [...new Set(cookies.map((c) => c.domain))].length };
  note(`Session: ${cookies.length} cookies, ${report.session.domains} domains, Google ${signedIn ? "live" : "ABSENT"}`);
  if (!signedIn) throw new Error("the launched browser has no live Google session; refusing to run");

  /* ------------------------------------------------- is the posting live */

  const answer = await fetch(posting.applyUrl, { redirect: "follow" });
  const html = await answer.text();
  const liveness = {
    status: answer.status,
    url: answer.url,
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim(),
    controls: (html.match(/<(?:input|select|textarea)\b/gi) ?? []).length,
    gone: /no longer accepting|no longer available|position (?:has been )?(?:closed|filled)|this job is closed/i.test(html),
  };
  report.liveness = liveness;
  note(`Posting: HTTP ${liveness.status} "${liveness.title}" - ${liveness.controls} controls in the markup, ${liveness.gone ? "GONE" : "live"}`);
  if (answer.status >= 400 || liveness.gone) throw new Error(`the posting is closed (HTTP ${liveness.status}); refusing to run`);

  /* ----------------------------------------------------- the extension */

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 30000 }));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  // The tab the browser started with, rather than a new one. A fresh tab
  // spends its first moment on about:blank, which is where it gets reaped.
  const driver = context.pages()[0] ?? (await context.newPage());
  await driver.goto(`${origin}/src/options.html`);
  await driver.getByRole("heading", { name: "A little more organized. A lot more you." }).waitFor();
  note(`Extension loaded: ${origin}`);

  /**
   * Gmail, read as the candidate.
   *
   * After the extension page exists, so the window has something holding it
   * open, and the board may hold the application until the address is
   * proved - the code arrives here.
   *
   * Only when asked for, because each attempt replays the candidate's real
   * session cookies at Google from a browser Google has already refused
   * once ("this browser or app may not be secure"), and a session
   * invalidated here is the person's own Chrome signed out.
   */
  const expected = posting.resumeData.email;
  if (process.env.CHECK_GMAIL === "1" || SUBMIT) {
    const mail = await context.newPage();
    try {
      await mail.goto("https://mail.google.com/", { waitUntil: "domcontentloaded" });
      await mail.waitForTimeout(6000);
      const mailbox = await mail.evaluate(() => ({
        title: document.title,
        url: location.href,
        account: [...new Set(document.body.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [])].slice(0, 5),
      }));
      report.gmail = { ...mailbox, expected, readableAsCandidate: mailbox.title.includes(expected) || mailbox.account.includes(expected) };
      note(`Gmail: "${mailbox.title}" -> ${report.gmail.readableAsCandidate ? `readable as ${expected}` : "NOT readable as the candidate"}`);
      await mail.screenshot({ path: `test-results/live-apply-${COMPANY.toLowerCase()}-gmail.png` }).catch(() => {});
    } catch (error) {
      report.gmail = { expected, readableAsCandidate: false, failed: error.message.slice(0, 140) };
      note(`Gmail: could not be read (${report.gmail.failed})`);
    }
    await mail.close().catch(() => {});
  } else {
    report.gmail = { expected, readableAsCandidate: false, skipped: "not re-probed this pass; see the recorded finding" };
    note("Gmail: not re-probed (Google rejects the carried session in an automated browser)");
  }

  /**
   * A mailbox we cannot read stops a submission, and only a submission.
   *
   * Sending with no way to read the code risks an application stuck
   * half-made that nobody can finish. The review pass cannot send, so it
   * has nothing to be stopped for and runs on.
   */
  if (!report.gmail.readableAsCandidate) {
    if (SUBMIT) throw new Error(`Gmail is not readable as ${expected}; refusing to submit without a reachable mailbox`);
    note("  (review pass continues: it cannot send, so it cannot strand an application)");
  }

  /**
   * A photograph of the form as it stood, taken from outside the page.
   *
   * Exposed to the extension page so the engine can trigger one at a moment
   * only it knows about - specifically the instant before Submit, which is
   * reached through the claim service below. Finds the posting's own tab
   * rather than the driver's, since that is the thing worth photographing.
   */
  await context.exposeFunction("__evidenceShot", async (name) => {
    const host = new URL(posting.applyUrl).hostname;
    const page = context.pages().find((open) => open.url().startsWith("http") && open.url().includes(host));
    if (!page) return null;
    const path = `test-results/live-apply-${COMPANY.toLowerCase()}-${name}.png`;
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    note(`  evidence: ${path}`);
    return path;
  });

  // The candidate is the corpus's own person. Anything the profile does not
  // hold is left empty on purpose, so a field needing it blocks.
  const who = posting.resumeData;
  await driver.evaluate(async ({ person, extra }) => {
    const [first, ...rest] = String(person.name || "").split(/\s+/);
    const [city, state] = String(person.location || "").split(",").map((part) => part.trim());
    await (await import("./store.js")).writeProfile({
      firstName: first ?? "",
      lastName: rest.join(" "),
      email: person.email ?? "",
      phone: person.phone ?? "",
      city: city ?? "",
      state: state ?? "",
      country: "United States",
      startDate: "Two weeks after offer",
      workAuthorization: "us-citizen",
      requiresSponsorship: "no",
      willingToRelocate: "no",
      willingToTravel: "yes",
      remotePreference: "remote",
      ...extra,
    });
  }, { person: who, extra: EXTRA });
  note(`Candidate: ${who.name} <${who.email}>  ${who.location}`);
  note(`  supplied extras: ${Object.entries(EXTRA).filter(([, v]) => v).map(([k]) => k).join(", ") || "(none)"}`);

  /* ---------------------------------------------------------- the attempt */

  note(`\nStarting the attempt (${phase})...`);
  const run = await driver.evaluate(
    async ({ job, resumeBytes, submitting, preflightOnly }) => {
      const { applyToJob } = await import("./apply/standalone.js");
      const asked = [];
      const log = [];

      const outcome = await applyToJob({
        job: {
          id: job.applyUrl,
          applyUrl: job.applyUrl,
          company: job.company,
          title: job.title,
          jd: job.jd,
          resumeText: job.resumeText,
          resumeData: job.resumeData,
          currentRole: job.currentRole,
          currentCompany: job.currentCompany,
          education: job.education,
          // Deliberately no compensation research. A pay question then
          // blocks the attempt instead of being answered from a number
          // nobody stands behind.
        },
        documents: {
          resume: new Blob([new Uint8Array(resumeBytes)], { type: "application/pdf" }),
          resumeName: job.resumeName,
        },
        profile: await (await import("./store.js")).readProfile(),
        policy: { review: !submitting && !preflightOnly, keepOpen: true },
        services: {
          /**
           * The model, refusing. Every open question is returned
           * unanswered, which parks a required one rather than filling it.
           * On a real application an invented answer is a false statement,
           * and the attempt stopping is the correct outcome.
           */
          answers: async (questions) => {
            for (const question of questions) {
              asked.push({ question: question.question, required: Boolean(question.required), options: (question.options ?? []).map((option) => option.label).filter(Boolean) });
            }
            return {
              answers: [],
              unanswered: questions.map((question) => ({ key: question.key, question: question.question, required: Boolean(question.required), reason: "this runner never invents an answer for a real application" })),
              forced: [],
            };
          },
          /**
           * The real reservation, with the photograph taken against it.
           *
           * The engine calls this immediately before pressing Submit and
           * will not press if it is refused, which makes it both the
           * duplicate protection and the last honest moment to photograph
           * the form. In the review pass it is never reached.
           */
          claimCompany: async (request) => {
            await window.__evidenceShot("before-submit");
            if (preflightOnly) {
              log.push("info: the claim is refused on purpose; the engine stops here rather than pressing Submit");
              return { claimed: false, reason: "preflight-only run: the claim is refused so Submit is never reached" };
            }
            const { claimSubmission } = await import("./store.js");
            const claim = await claimSubmission(request);
            log.push(`info: claim for ${request.company}: ${JSON.stringify(claim)}`);
            return claim;
          },
        },
        log: (level, message, detail) => log.push(`${level}: ${message}${detail ? ` :: ${JSON.stringify(detail).slice(0, 800)}` : ""}`),
      });

      return { outcome, asked, log };
    },
    {
      job: {
        applyUrl: posting.applyUrl,
        company: posting.company,
        title: posting.title,
        jd: posting.jd,
        resumeName: posting.resumeName,
        resumeData: who,
        resumeText: resumeToPlainText(who),
        currentRole: who.experience?.[0]?.title ?? "",
        currentCompany: who.experience?.[0]?.company ?? "",
        education: who.education?.[0]
          ? { degree: who.education[0].degree ?? "", school: who.education[0].school ?? "", location: who.education[0].location ?? "", year: String(who.education[0].dates ?? "").slice(-4) }
          : undefined,
      },
      resumeBytes: [...posting.resumePdf],
      submitting: SUBMIT,
      preflightOnly: PREFLIGHT_ONLY,
    },
  );

  report.outcome = run.outcome;
  report.asked = run.asked;
  report.log = run.log;

  /* ---------------------------------------------------------- evidence */

  const host = new URL(posting.applyUrl).hostname;
  const page = context.pages().find((open) => open.url().startsWith("http") && open.url().includes(host)) ?? context.pages().find((open) => open.url().startsWith("http"));

  if (page) {
    await page.bringToFront().catch(() => {});
    const shot = `test-results/live-apply-${COMPANY.toLowerCase()}-${SUBMIT ? "after-submit" : "filled-review"}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    report.screenshot = shot;
    note(`\nScreenshot: ${shot}`);

    /**
     * What the page is holding, read from the page rather than from the
     * engine's own account of it. The engine's verify step already checked
     * this; reading it again from outside is the independent second
     * opinion, and it is the thing a person actually wants to see.
     */
    const readBack = await page.evaluate(() => {
      const frames = [document];
      const seen = [];
      for (const doc of frames) {
        for (const node of doc.querySelectorAll("input, select, textarea")) {
          if (node.type === "hidden" || node.type === "submit" || node.type === "button") continue;
          const label =
            node.labels?.[0]?.innerText?.replace(/\s+/g, " ").trim() ||
            doc.querySelector(`label[for="${node.id}"]`)?.innerText?.replace(/\s+/g, " ").trim() ||
            node.getAttribute("aria-label") ||
            node.name ||
            node.id;
          const value = node.type === "file" ? [...(node.files ?? [])].map((file) => file.name).join(", ") : node.type === "checkbox" || node.type === "radio" ? (node.checked ? "checked" : "") : node.value;
          if (!label) continue;
          seen.push({ label: String(label).slice(0, 120), type: node.type || node.tagName.toLowerCase(), required: Boolean(node.required), value: String(value ?? "").slice(0, 160) });
        }
      }
      return {
        url: location.href,
        title: document.title,
        heading: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 400),
        fields: seen,
        blockedSubmits: window.__blockedSubmits ?? null,
        blockedRegistrations: window.__blockedRegistrations ?? 0,
      };
    }).catch((error) => ({ unreadable: error.message.slice(0, 120) }));
    report.pageAfter = readBack;

    if (readBack.fields) {
      note(`\nWhat the page is holding (${readBack.fields.length} controls):`);
      for (const field of readBack.fields) {
        if (!field.value && !field.required) continue;
        note(`  ${field.required ? "*" : " "} ${field.label.padEnd(62).slice(0, 62)} = ${field.value || "(empty)"}`);
      }
    }
    if (readBack.heading) note(`\nPage text: ${readBack.heading.slice(0, 240)}`);
  }

  report.blockedSubmits = report.pageAfter?.blockedSubmits ?? null;
  report.blockedRegistrations = report.pageAfter?.blockedRegistrations ?? 0;

  /* ----------------------------------------------------------- the verdict */

  const outcome = run.outcome;
  note(`\n${"=".repeat(68)}`);
  note(`Outcome:   ${outcome.status}`);
  note(`Reason:    ${outcome.reason || "(none)"}`);
  note(`Submitted: ${outcome.submitted === true}`);
  if (outcome.receipt) note(`Receipt:   ${outcome.receipt}`);
  note(`Filled:    ${outcome.evidence?.filled ?? "-"} field(s), ${outcome.evidence?.attachments ?? 0} attachment(s), ${outcome.evidence?.questions ?? 0} open question(s)`);
  note(`Adapter:   ${outcome.evidence?.adapter} (confidence ${outcome.evidence?.confidence})`);
  note(`Registrations cancelled by the guard: ${report.blockedRegistrations}`);
  if (!SUBMIT) note(`Submit events cancelled by the guard: ${report.blockedSubmits ?? "(guard not seen on this page)"}`);
  note("=".repeat(68));

  if (outcome.evidence?.answers) {
    note("\nAs the engine recorded it:");
    for (const answer of outcome.evidence.answers) note(`  ${String(answer.question).slice(0, 62).padEnd(62)} = ${answer.answer}`);
  }
  if (run.asked.length > 0) {
    note(`\nOpen questions the model was asked for and refused (${run.asked.length}):`);
    for (const question of run.asked) note(`  ${question.required ? "REQUIRED" : "optional"}  ${question.question.slice(0, 100)}`);
  }
  note("\nEngine log:");
  for (const line of run.log) note(`  ${line.slice(0, 300)}`);

  // The review pass must not have sent anything, and says so rather than
  // being assumed to have behaved.
  if (!SUBMIT && (outcome.submitted === true || (report.blockedSubmits ?? 0) > 0)) {
    console.error("\n*** SAFETY FAILURE: the review pass tried to submit. ***");
    process.exitCode = 1;
  }
  if (report.blockedRegistrations > 0) {
    console.error("\n*** An account registration was attempted and cancelled. ***");
    process.exitCode = 1;
  }

  // Left on screen on purpose. The person asked to see how it works, and a
  // window that closes itself the moment it finishes shows nothing.
  const linger = Number(process.env.LINGER_MS ?? 120000);
  note(`\nLeaving the browser open for ${Math.round(linger / 1000)}s so the result can be looked at...`);
  await new Promise((done) => setTimeout(done, linger));
} catch (error) {
  report.failure = error?.stack ?? String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await releaseScratch(profilePath);
  report.finishedAt = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`\nFull results: ${OUT}`);
}
