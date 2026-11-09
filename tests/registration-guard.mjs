/**
 * Does the corpus harness's registration guard actually fire?
 *
 * The corpus run reports "account registrations cancelled: 0", and that
 * number is worth nothing on its own - a guard that is never wired up
 * reports zero just as confidently as a guard that is working and had
 * nothing to stop. The difference is the whole safety claim for the seven
 * Workday postings, where a registration is a durable recruiter-visible
 * record under a real person's name that cannot be undone.
 *
 * So the guard is pointed at Workday's own markup, offline, and asked to
 * prove it: a Create Account button, a Sign In button, and the transparent
 * `click_filter` overlay Workday actually routes clicks through. Each is
 * clicked. Each must be cancelled and counted.
 *
 * The init script below is a copy of the one in apply-corpus.mjs on
 * purpose - the point is to test that exact text, and importing it would
 * test a refactor of it instead.
 */

import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);

let count = 0;
const test = async (name, work) => {
  await work();
  count++;
  console.log("PASS " + name);
};

/* ------------------------------------------- the guard, as the corpus has it */

const GUARD = () => {
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
};

/** Workday's sign-in page, in the shape its tenants serve it. */
const PAGE = `<!doctype html><html><body>
  <form id="account" onsubmit="window.__submitted = true; return false">
    <div data-automation-id="noCaptchaWrapper">
      <button type="button" data-automation-id="createAccountSubmitButton" onclick="window.__created = true">Create Account</button>
      <div data-automation-id="click_filter" style="position:absolute;inset:0"></div>
    </div>
    <button type="button" data-automation-id="signInSubmitButton" onclick="window.__signedIn = true">Sign In</button>
    <a data-automation-id="createAccountLink" onclick="window.__linked = true">Create Account</a>
    <button type="button" data-automation-id="pageFooterNextButton" onclick="window.__continued = true">Continue</button>
  </form>
</body></html>`;

const profilePath = scratchPath("regguard");
const context = await chromium.launchPersistentContext(profilePath, {
  channel: "chromium",
  headless: true,
  args: ["--no-proxy-server"],
});

// Nothing here catches, so a failed assertion is still on its way out when
// the finally runs and has not set an exit code for releaseScratch to read.
let passed = false;
try {
  await context.addInitScript(GUARD);
  const page = await context.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);

  await test("The guard is installed before the page is interacted with", async () => {
    assert.equal(await page.evaluate(() => typeof window.__blockedRegistrations), "number", "the init script did not run in this frame");
    assert.equal(await page.evaluate(() => window.__blockedRegistrations), 0);
  });

  await test("Create Account is cancelled and counted, and the page's own handler never runs", async () => {
    await page.evaluate(() => document.querySelector('[data-automation-id="createAccountSubmitButton"]').click());
    assert.equal(await page.evaluate(() => window.__blockedRegistrations), 1);
    assert.equal(await page.evaluate(() => window.__created ?? false), false, "the registration handler ran anyway");
  });

  await test("Sign In is cancelled too - an account that does not exist is created by trying to use it", async () => {
    await page.evaluate(() => document.querySelector('[data-automation-id="signInSubmitButton"]').click());
    assert.equal(await page.evaluate(() => window.__blockedRegistrations), 2);
    assert.equal(await page.evaluate(() => window.__signedIn ?? false), false);
  });

  await test("The Create Account link is cancelled, not only the button", async () => {
    await page.evaluate(() => document.querySelector('[data-automation-id="createAccountLink"]').click());
    assert.equal(await page.evaluate(() => window.__blockedRegistrations), 3);
    assert.equal(await page.evaluate(() => window.__linked ?? false), false);
  });

  await test("The transparent click_filter overlay Workday really routes clicks through is caught", async () => {
    // This is the case a guard watching only buttons would miss: the
    // click never reaches the button, it reaches the overlay above it.
    await page.evaluate(() => document.querySelector('[data-automation-id="click_filter"]').click());
    assert.equal(await page.evaluate(() => window.__blockedRegistrations), 4);
    assert.equal(await page.evaluate(() => window.__created ?? false), false);
  });

  await test("Ordinary wizard controls are left alone, so the guard does not silently stop the run", async () => {
    await page.evaluate(() => document.querySelector('[data-automation-id="pageFooterNextButton"]').click());
    assert.equal(await page.evaluate(() => window.__blockedRegistrations), 4, "Continue was counted as a registration");
    assert.equal(await page.evaluate(() => window.__continued), true, "Continue was blocked, which would stall every wizard");
  });

  console.log(`${count} registration-guard checks passed.`);
  passed = true;
} finally {
  await context.close();
  await releaseScratch(profilePath, passed);
}
