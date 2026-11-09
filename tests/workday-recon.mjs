/**
 * Looking at the seven live Workday tenants, and touching nothing.
 *
 * Every Workday posting in the corpus belongs to a real employer - Zayo,
 * Highmark, Insperity, DriveTime, OneSource Virtual, Intuitive Machines,
 * Tandem Diabetes - and Workday is the first board here with side effects
 * before Submit. Creating a candidate account writes a durable record into
 * that employer's ATS under a real person's name and address, visible to
 * their recruiters, with no delete. Requesting a code mails a stranger's
 * inbox.
 *
 * So this is reconnaissance only: it loads each posting's apply address,
 * reads what is on the page, and reports. It does not click, type, submit,
 * register or request anything. The adapter is validated against the local
 * wizard fixture in tests/workday-wizard.mjs instead.
 *
 * ## The guards, which are asserted rather than assumed
 *
 * Three, deliberately overlapping, installed before any page script runs,
 * in every frame, on every navigation:
 *
 *   1. Submit. Every `submit` event is cancelled at the capture phase and
 *      counted, so an accidental Enter in a text box cannot send a form.
 *   2. Registration. Every click on a create-account, sign-in or
 *      continue-with-provider control is cancelled at the capture phase
 *      and counted - and so is any press of a Workday `click_filter`, the
 *      overlay its own buttons are clicked through. This is the guard the
 *      submit guard never covered, because registration happens long
 *      before Submit.
 *   3. The engine is not run at all. Nothing here constructs an attempt, so
 *      there is no code path from this file to a filled field.
 *
 * All three counts are reported, and a non-zero count on either of the
 * first two fails the run.
 */

import { chromium } from "playwright";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workdayApplyUrl, workdayIds } from "../src/workdayBoard.js";
import { scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const corpus = process.env.CORPUS ?? "/home/administrator/Downloads/Daniel";
const outFile = process.env.OUT ?? "test-results/workday-recon.json";
const PAGE_MS = Number(process.env.PAGE_MS ?? 60000);

/* ----------------------------------------------------------- the postings */

const postings = [];
for (const company of (await readdir(corpus, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  for (const role of (await readdir(resolve(corpus, company.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    const applyUrl = (await readFile(resolve(corpus, company.name, role.name, "job-link.txt"), "utf8").catch(() => "")).trim();
    if (!applyUrl || !/\.myworkdayjobs\.com$/i.test(new URL(applyUrl).hostname)) continue;
    postings.push({ company: company.name, title: role.name, applyUrl });
  }
}
console.log(`${postings.length} Workday postings from ${corpus}\n`);

/* --------------------------------------------------------------- guards */

/**
 * Runs before any page script, in every frame, on every navigation.
 *
 * The registration half matches on Workday's own automation ids rather
 * than on wording, because wording is per-tenant and the ids are not. The
 * `click_filter` entry is the important one: Workday wraps its buttons in
 * a `noCaptchaWrapper` and the real click target is a transparent div over
 * the button, so a guard that only watched buttons would watch the wrong
 * element.
 */
const GUARDS = () => {
  window.__blockedSubmits = 0;
  window.__blockedRegistrations = 0;

  window.addEventListener(
    "submit",
    (event) => {
      window.__blockedSubmits += 1;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  const REGISTRATION = [
    "createAccountSubmitButton",
    "signInSubmitButton",
    "createAccountLink",
    "signInLink",
    "CreateAccountWithEmailButton",
    "SignInWithEmailButton",
    "click_filter",
    "pageFooterNextButton",
    "bottom-navigation-next-button",
    "adventureButton",
    "applyManually",
    "autofillWithResume",
    "useMyLastApplication",
  ];

  const blocked = (node) => {
    for (let at = node; at && at !== document.documentElement; at = at.parentElement) {
      const id = at.getAttribute?.("data-automation-id");
      if (id && REGISTRATION.includes(id)) return id;
      if (at.tagName === "BUTTON" && /create account|sign in|continue with|apply/i.test(at.textContent ?? "")) return at.textContent.trim().slice(0, 40);
    }
    return null;
  };

  for (const kind of ["pointerdown", "mousedown", "click"]) {
    window.addEventListener(
      kind,
      (event) => {
        const why = blocked(event.target);
        if (!why) return;
        if (kind === "click") window.__blockedRegistrations += 1;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }
};

/* ------------------------------------------------------------ the reading */

/**
 * What the wall looks like, read off the page and nothing else.
 *
 * Reported as what the adapter would need rather than as a dump: which
 * page kind Workday is showing, whether a guest can apply at all, which
 * doors the chooser offers, and which fields the account form wants.
 */
const READ = () => {
  const id = (name) => document.querySelector(`[data-automation-id="${name}"]`);
  const seen = (...names) => names.filter((name) => id(name));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  const kind = id("createAccountSubmitButton")
    ? "create"
    : id("signInSubmitButton")
      ? "signin"
      : id("SignInWithEmailButton") || id("CreateAccountWithEmailButton")
        ? "chooseSignIn"
        : id("applyFlowPage")
          ? "wizard"
          : id("adventureButton")
            ? "posting"
            : "unknown";

  return {
    url: location.href,
    title: document.title,
    kind,
    heading: text(document.querySelector("h1, h2")),
    // The doors this tenant offers, which decides whether an account is
    // avoidable at all.
    doors: seen("SignInWithEmailButton", "CreateAccountWithEmailButton", "signInLink", "createAccountLink", "applyManually", "autofillWithResume", "useMyLastApplication", "adventureButton"),
    social: [...document.querySelectorAll("button, a")].map(text).filter((label) => /continue with|sign in with/i.test(label)).slice(0, 6),
    accountFields: seen("email", "password", "verifyPassword", "createAccountCheckbox"),
    // Whether anything on the page suggests an application can be made
    // without registering first.
    guestWording: /apply (?:as a guest|without)/i.test(document.body?.innerText ?? ""),
    // Told apart on purpose. `noCaptchaWrapper` is what Workday calls the
    // overlay it puts over every button and is on every tenant; a real
    // puzzle is a recaptcha or hcaptcha frame, and reporting the first as
    // the second would say all seven need a person when none of them do.
    buttonOverlay: Boolean(document.querySelector('[data-automation-id="noCaptchaWrapper"]')),
    captcha: Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey]')),
    legalNotice: Boolean(document.querySelector('[data-automation-id="legalNoticeAcceptButton"]')),
    wizardSteps: (document.body?.innerText ?? "").match(/step \d+ of (\d+)/i)?.[1] ?? null,
    verificationWording: /verify your (?:account|email)|a verification|security code|one-time/i.test(document.body?.innerText ?? ""),
    frames: [...document.querySelectorAll("iframe")].length,
    // The markup itself, which is the part worth having: Workday names
    // every control it draws, so the ids present on the wall say exactly
    // what the adapter will meet there.
    automationIds: [...new Set([...document.querySelectorAll("[data-automation-id]")].map((node) => node.getAttribute("data-automation-id")))].slice(0, 40),
    bodyStart: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    guards: { submits: window.__blockedSubmits ?? null, registrations: window.__blockedRegistrations ?? null },
  };
};

/* ------------------------------------------------------------------- run */

const report = { startedAt: new Date().toISOString(), corpus, readOnly: true, results: [] };
const profilePath = scratchPath("workday-recon");
let context;

try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    args: ["--no-proxy-server"],
    viewport: { width: 1440, height: 1050 },
  });
  await context.addInitScript(GUARDS);

  for (const posting of postings) {
    const ids = workdayIds(posting.applyUrl);
    const apply = workdayApplyUrl(posting.applyUrl);
    process.stdout.write(`${posting.company.padEnd(22)} ${(ids?.tenant ?? "?").padEnd(16)} `);

    const page = await context.newPage();
    let read = null;
    let failure = null;
    try {
      await page.goto(apply, { waitUntil: "domcontentloaded", timeout: PAGE_MS });
      // Workday draws its wall a few seconds after the document; waited for
      // by asking the page, not by clicking anything on it.
      // The wall is a React page that draws itself in instalments; waited
      // for by watching the markup settle, never by clicking anything.
      await page
        .waitForFunction(() => document.querySelector('[data-automation-id="createAccountSubmitButton"], [data-automation-id="signInSubmitButton"], [data-automation-id="SignInWithEmailButton"], [data-automation-id="CreateAccountWithEmailButton"], [data-automation-id="applyFlowPage"], [data-automation-id="errorPage"]'), { timeout: 25000 })
        .catch(() => {});
      await page.waitForTimeout(2500);
      read = await page.evaluate(READ);
    } catch (error) {
      failure = error?.message?.split("\n")[0] ?? String(error);
    }

    const guards = await page
      .evaluate(() => ({ submits: window.__blockedSubmits ?? null, registrations: window.__blockedRegistrations ?? null }))
      .catch(() => ({ submits: null, registrations: null }));

    report.results.push({ ...posting, tenant: ids?.tenant ?? null, applyAddress: apply, read, guards, failure });
    console.log(failure ? `FAILED  ${failure.slice(0, 60)}` : `${(read?.kind ?? "?").padEnd(14)} ${read?.doors?.join(",") || "(no doors)"}`);
    await page.close();
  }

  /* -------------------------------------------------- the safety assertion */

  report.guardInstalled = report.results.every((result) => result.guards.submits !== null);
  report.blockedSubmits = report.results.reduce((total, result) => total + (result.guards.submits ?? 0), 0);
  report.blockedRegistrations = report.results.reduce((total, result) => total + (result.guards.registrations ?? 0), 0);

  console.log(`\nGuards present on every page reached: ${report.guardInstalled}`);
  console.log(`Submit events cancelled by the guard: ${report.blockedSubmits}`);
  console.log(`Registration clicks cancelled by the guard: ${report.blockedRegistrations}`);
  console.log(`Accounts created: 0 (nothing in this file clicks, types or submits)`);

  if (report.blockedSubmits > 0 || report.blockedRegistrations > 0) {
    console.error("\n*** SAFETY FAILURE: something tried to act on a live tenant. ***");
    process.exitCode = 1;
  }

  /* ----------------------------------------------------------- the finding */

  const walls = report.results.filter((result) => result.read);
  const byKind = walls.reduce((counts, result) => ({ ...counts, [result.read.kind]: (counts[result.read.kind] ?? 0) + 1 }), {});
  console.log(`\nWhat the apply address shows: ${Object.entries(byKind).map(([kind, n]) => `${kind} ${n}`).join(", ") || "(nothing read)"}`);
  console.log(`Tenants offering a guest route: ${walls.filter((result) => result.read.guestWording).length} of ${walls.length}`);
  console.log(`Tenants showing the account form outright: ${walls.filter((result) => result.read.accountFields.length > 0).length} of ${walls.length}`);
  console.log(`Tenants with a legal-notice modal over the wall: ${walls.filter((result) => result.read.legalNotice).length} of ${walls.length}`);
  console.log(`Tenants with a real captcha puzzle: ${walls.filter((result) => result.read.captcha).length} of ${walls.length}`);
  console.log(`Wizard length, where the progress bar said: ${[...new Set(walls.map((result) => result.read.wizardSteps).filter(Boolean))].sort().join(", ") || "(not shown)"} steps`);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await releaseScratch(profilePath);
  report.finishedAt = new Date().toISOString();
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`\nFull results: ${outFile}`);
}
