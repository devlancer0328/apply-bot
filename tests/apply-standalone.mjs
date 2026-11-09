/**
 * The apply module on its own, against a local Greenhouse-shaped form.
 *
 * No run loop, no queue, no discovery: one job URL goes in and one outcome
 * comes out. That is the whole point of the exercise - the old path could
 * only be reached by starting a run, which meant every change to form
 * filling was tested through document generation, screening and scheduling,
 * and took two and a half minutes to say anything.
 *
 * The model is substituted here. Everything else is real: the real
 * extension, the real fill.js, a real Chromium, a real file upload and a
 * real Submit. What is stubbed is the one service whose job is to be
 * unpredictable, because a test that cannot say what the answer should be
 * cannot tell a regression from a mood.
 */

import { chromium } from "playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demographicFixture } from "./demographic-fixture.js";
import { ashbyAdapter } from "../src/apply/adapters/ashby.js";
import { scratchRoot, browsersDir, scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const portable = (await readdir(browsersDir).catch(() => [])).find((name) => /^chromium-\d+$/.test(name));
const executablePath = portable ? resolve(browsersDir, portable, "chrome-win64/chrome.exe") : undefined;
const profilePath = scratchPath("apply-standalone");
const pass = (name) => console.log(`PASS ${name}`);

const jd =
  "Example Careers is hiring a Software Engineer to build accessible customer applications with React and TypeScript. " +
  "The team works together on careful testing, performance measurement, documentation, and maintainable user interfaces. " +
  "This remote role collaborates with designers and engineers to ship reliable features. Candidates should have experience " +
  "building web applications and communicating clearly.";

// Greenhouse's own field names and ids, which is what the adapter detects
// and what fill.js reads. The upload endpoint and the filename chip copy how
// the board acknowledges a file, so uploadsSettled has something to settle on.
const jobHtml = `<!doctype html><html><head><title>Software Engineer at Example Careers</title></head><body>
<h1>Software Engineer</h1><main id="content"><p>${jd} ${jd}</p></main>
<form id="application_form">
<label for="first_name">First name *</label><input id="first_name" name="first_name" required>
<label for="last_name">Last name *</label><input id="last_name" name="last_name" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="phone">Phone *</label><input id="phone" name="phone" type="tel" required>
<label for="resume">Resume *</label><input id="resume" name="resume" type="file" required>
<label for="expected_salary">Expected base salary</label><input type="number" id="expected_salary" name="expected_salary" required>
${demographicFixture}
<button type="submit">Submit Application</button></form>
<script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++;document.body.textContent='Thank you for applying';};
document.querySelectorAll('input[type=file]').forEach(input=>input.addEventListener('change',async()=>{const file=input.files[0];if(!file)return;await fetch('/upload/'+input.name,{method:'POST',body:file});const chip=document.createElement('span');chip.className='file-upload__filename';chip.textContent=file.name;document.body.append(chip);}));</script>
</body></html>`;

// A company careers page with none of Greenhouse's markings, served from the
// same place so the unsupported case is a real page with a real form rather
// than a navigation that failed.
const unknownHtml = `<!doctype html><html><head><title>Engineer at Unknown Careers</title></head><body>
<h1>Engineer</h1><form id="careers-form"><label for="name">Full name *</label><input id="name" name="name" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<button type="submit">Apply</button></form>
<script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++;};</script>
</body></html>`;

// Workable, in the two respects that make it the second adapter: the saved
// link is the posting and the form is one step on, and Submit says nothing
// on the page at all - the application goes out as a request, and the
// board's answer to that request is the only receipt there is.
const workablePosting = `<!doctype html><html><head><title>CAD Engineer at Toloka</title></head><body>
<h1>Freelance Mechanical CAD Engineer</h1><p data-ui="job-description">Build and review CAD models.</p>
<button data-ui="apply-button">Apply for this job</button></body></html>`;

const workableForm = `<!doctype html><html><head><title>Apply - CAD Engineer</title></head><body>
<form data-ui="application_form">
<label for="firstname">First name *</label><input id="firstname" name="firstname" required>
<label for="lastname">Last name *</label><input id="lastname" name="lastname" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="phone">Phone *</label><input id="phone" name="phone" type="tel" required>
<label for="resume">Resume *</label><input id="resume" name="resume" type="file" required>
<button type="submit">Submit application</button></form>
<script>window.submissions=0;document.querySelector('form').onsubmit=async e=>{e.preventDefault();window.submissions++;
  await fetch('/api/v3/accounts/toloka/candidates',{method:'POST',body:'{}'});
  // Deliberately silent. Workable's own confirmation is brief and often
  // gone before anything looks; the request is the honest signal.
  document.querySelector('button[type=submit]').disabled=true;};
document.querySelectorAll('input[type=file]').forEach(input=>input.addEventListener('change',async()=>{const file=input.files[0];if(!file)return;await fetch('/upload/'+input.name,{method:'POST',body:file});}));
</script></body></html>`;

// Ashby, as the board that resembles Greenhouse. The fixture is built out
// of the three habits src/fill.js already knows about and the adapter
// deliberately says nothing about: questions as blocks rather than labelled
// inputs, yes/no as a pair of buttons over a hidden checkbox, and every
// answer posted to the server as it is given - which is why Submit has to
// wait for the requests in the air rather than firing the moment it is
// enabled.
const ashbyPosting = `<!doctype html><html><head><title>Senior Engineer at Sunny Data</title></head><body>
<div class="ashby-job-posting-brief"><h1>Senior Engineer</h1><p>Build the data platform.</p>
<a href="application">Apply for this job</a></div></body></html>`;

const ashbyForm = `<!doctype html><html><head><title>Application - Senior Engineer</title></head><body>
<div class="ashby-application-form-container"><form>
<div class="ashby-application-form-field-entry"><label for="_systemfield_name">Name *</label><input id="_systemfield_name" name="_systemfield_name" required></div>
<div class="ashby-application-form-field-entry"><label for="_systemfield_email">Email *</label><input id="_systemfield_email" name="_systemfield_email" type="email" required></div>
<div class="ashby-application-form-field-entry"><label for="_systemfield_resume">Resume *</label><input id="_systemfield_resume" name="_systemfield_resume" type="file" required></div>
<div class="ashby-application-form-field-entry"><label>Are you legally authorized to work in the United States? *</label>
  <input type="checkbox" id="auth" style="display:none">
  <button type="button" data-option="yes" aria-pressed="false">Yes</button>
  <button type="button" data-option="no" aria-pressed="false">No</button></div>
<button type="submit">Submit Application</button></form></div>
<script>
window.submissions=0;window.pendingSaves=0;window.submitSawPending=null;
// Ashby saves each answer as it is given. The counter is what the filler
// watches before it will allow Submit.
const save=async()=>{window.pendingSaves++;await fetch('/api/save',{method:'POST',body:'{}'});window.pendingSaves--;};
document.querySelectorAll('input,button[data-option]').forEach(node=>node.addEventListener('change',save));
document.querySelectorAll('button[data-option]').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('button[data-option]').forEach(other=>other.setAttribute('aria-pressed','false'));
  button.setAttribute('aria-pressed','true');
  document.getElementById('auth').checked = button.dataset.option==='yes';
  save();}));
// Ashby sends the file to S3 on selection and only then shows its name.
// That name appearing is what the filler waits for before Submit.
document.querySelectorAll('input[type=file]').forEach(input=>input.addEventListener('change',async()=>{
  const file=input.files[0];if(!file)return;window.pendingSaves++;await fetch('/upload/'+input.name,{method:'POST',body:file});window.pendingSaves--;
  const chip=document.createElement('span');chip.className='file-name';chip.textContent=file.name;input.parentElement.appendChild(chip);}));
document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++;window.submitSawPending=window.pendingSaves;
  document.body.innerHTML='<h1>Thanks for applying!</h1><p>Your application has been submitted to Sunny Data.</p>';};
</script></body></html>`;

const server = createServer((request, response) => {
  if ((request.headers.host || "").startsWith("apply.workable.com")) {
    if (request.url.startsWith("/api/")) {
      request.resume();
      request.on("end", () => {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end('{"id":"candidate-1"}');
      });
      return;
    }
    if (request.url.startsWith("/upload/")) {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"uploaded":true}');
      });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(/\/apply\/?$/.test(request.url) ? workableForm : workablePosting);
    return;
  }
  if ((request.headers.host || "").startsWith("unknown-careers")) {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(unknownHtml);
    return;
  }
  if (request.url.startsWith("/upload/")) {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"uploaded":true}');
    });
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(jobHtml);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://examplecareers.greenhouse.io:${server.address().port}`;

/**
 * Ashby's fixture needs its own server, over TLS.
 *
 * `ashbyhq.com` is on Chrome's HSTS preload list, so the browser refuses to
 * speak plain HTTP to it however the address is written - the first attempt
 * at this fixture failed with ERR_SSL_PROTOCOL_ERROR against a plain
 * server. The hostname cannot be given up either: `src/fill.js` decides
 * whether it is on an Ashby page from the hostname, and the whole point of
 * this fixture is to exercise that path.
 *
 * So the fixture is served over HTTPS with a certificate generated here and
 * thrown away afterwards, and the browser is told to ignore it. Nothing is
 * committed and nothing is trusted beyond this process.
 */
const certDir = resolve(scratchRoot, "fixture-cert");
await mkdir(certDir, { recursive: true });
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=jobs.ashbyhq.com", "-addext", "subjectAltName=DNS:jobs.ashbyhq.com",
  "-keyout", resolve(certDir, "key.pem"), "-out", resolve(certDir, "cert.pem"),
], { stdio: "ignore" });

const ashbyServer = createSecureServer({
  key: await readFile(resolve(certDir, "key.pem")),
  cert: await readFile(resolve(certDir, "cert.pem")),
}, (request, response) => {
  if (request.url.startsWith("/api/") || request.url.startsWith("/upload/")) {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(/\/application\/?$/.test(request.url) ? ashbyForm : ashbyPosting);
});
await new Promise((done) => ashbyServer.listen(0, "127.0.0.1", done));

let context;
const report = { startedAt: new Date().toISOString(), runs: [] };

/**
 * Drives the module from the options page rather than the service worker.
 *
 * Either would do - the module takes its browser and its services as
 * arguments and does not care who called it - and an extension page is the
 * honest demonstration of that, because it has no run loop in it at all.
 */
async function applyFromPage(page, settings) {
  return page.evaluate(async ({ url, company, review }) => {
    const { applyToJob } = await import("./apply/standalone.js");

    const asked = [];
    const log = [];
    const compensation = {
      status: "researched",
      company,
      role: "Software Engineer",
      currency: "USD",
      period: "year",
      basis: "base",
      minimum: 140000,
      maximum: 190000,
      recommendedAmount: 173000,
      rationale: "Fixture evidence for the standalone harness.",
      evidence: { mode: "chatgpt-native-citations", nativeCitations: ["https://example.test/pay"] },
      sources: [{ url: "https://example.test/pay", title: "Example Careers engineering compensation", company, role: "Software Engineer", matchType: "exact-company-role" }],
    };

    const outcome = await applyToJob({
      job: {
        id: url,
        applyUrl: url,
        company,
        title: "Software Engineer",
        jd: document.title,
        compensation,
        resumeText: "Alex Morgan\nSoftware Engineer at Example Software\nBuilt accessible interfaces with React and TypeScript.",
      },
      documents: {
        resume: new Blob(["resume fixture bytes"], { type: "application/pdf" }),
        resumeName: "Alex Morgan - Software Engineer.pdf",
      },
      profile: await (await import("./store.js")).readProfile(),
      policy: { review },
      services: {
        answers: async (questions) => {
          asked.push(...questions.map((question) => question.question));
          return { answers: questions.map((question) => ({ key: question.key, value: "173000" })), unanswered: [], forced: [] };
        },
        claimCompany: async () => ({ claimed: true }),
      },
      log: (level, message) => log.push(`${level}: ${message}`),
    });

    return { outcome, asked, log };
  }, settings);
}

try {
  context = await chromium.launchPersistentContext(profilePath, {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--host-resolver-rules=MAP examplecareers.greenhouse.io 127.0.0.1, MAP unknown-careers.example.test 127.0.0.1, MAP apply.workable.com 127.0.0.1, MAP jobs.ashbyhq.com 127.0.0.1",
      "--no-proxy-server",
    ],
    // The Ashby fixture has to be served over TLS with a throwaway
    // certificate; see the note where that server is started.
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1050 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;

  const page = await context.newPage();
  await page.goto(`${origin}/src/options.html`);
  await page.getByRole("heading", { name: "A little more organized. A lot more you." }).waitFor();

  await page.evaluate(async () => {
    const { writeProfile } = await import("./store.js");
    await writeProfile({
      firstName: "Alex", lastName: "Morgan", email: "alex@example.test", phone: "555-0100",
      city: "Seattle", state: "Washington", country: "United States", startDate: "Two weeks after offer",
      workAuthorization: "us-citizen", requiresSponsorship: "no",
      gender: "Male", pronouns: "He/him/his", race: "East Asian", hispanic: "no", veteran: "No Veteran", sexualOrientation: "Straight",
    });
  });

  /* ------------------------------------------------- review, which never sends */

  const reviewUrl = `${base}/jobs/501001`;
  const review = await applyFromPage(page, { url: reviewUrl, company: "Example Careers", review: true });
  report.runs.push({ mode: "review", ...review });

  assert.equal(review.outcome.status, "challenge", JSON.stringify(review, null, 2));
  assert.ok(review.outcome.reviewId, "a parked attempt carries a review id");
  assert.equal(review.outcome.submitted, false);
  assert.equal(review.outcome.evidence.adapter, "greenhouse");
  pass("A single job URL applies with no run in progress, resolves the Greenhouse adapter and parks for review");

  const form = context.pages().find((open) => open.url() === reviewUrl);
  assert.ok(form, "review mode leaves the page open for a person");
  assert.equal(await form.locator("#first_name").inputValue(), "Alex");
  assert.equal(await form.locator("#email").inputValue(), "alex@example.test");
  assert.equal(await form.locator("#phone").inputValue(), "555-0100");
  assert.equal(await form.locator("#resume").evaluate((input) => input.files.length), 1);
  assert.equal(await form.locator("#expected_salary").inputValue(), "173000");
  assert.equal(await form.evaluate(() => window.submissions), 0);
  await form.screenshot({ path: "test-results/apply-standalone-review.png", fullPage: true });
  pass("The ported Greenhouse path fills profile facts, uploads the resume and verifies accepted values");

  // The compensation field is the only thing on this form a profile cannot
  // answer. Anything else turning up here means the resolver stopped
  // recognising a field it used to own.
  assert.deepEqual(review.asked, ["Expected base salary"], JSON.stringify(review.asked));
  pass("Only the pay question reaches the model; demographics and contact details are resolved from saved facts");

  for (const [id, expected] of [["demo-gender", "Man"], ["demo-ethnicity", "East Asian"], ["demo-orientation", "Heterosexual"], ["demo-veteran", "I am not a protected veteran"], ["demo-race", "Asian"]]) {
    assert.equal(await form.locator("#" + id).evaluate((input) => input.closest(".select__control").querySelector("[data-values]").textContent), expected, id);
  }
  pass("Conditional demographic controls are answered from the profile, including race behind the Hispanic question");
  await form.close();

  /* ----------------------------------------------------- submit, on the fixture */

  const submitUrl = `${base}/jobs/501002`;
  const sent = await applyFromPage(page, { url: submitUrl, company: "Submission Fixture", review: false });
  report.runs.push({ mode: "submit", ...sent });

  assert.equal(sent.outcome.status, "confirmed", JSON.stringify(sent, null, 2));
  assert.equal(sent.outcome.submitted, true);
  assert.match(sent.outcome.receipt, /Thank you for applying/i);
  assert.equal(sent.outcome.reviewId, undefined);
  assert.ok(sent.outcome.evidence.lastPage?.url, "the last page is photographed before the tab closes");
  assert.equal(context.pages().some((open) => open.url() === submitUrl), false, "a finished application closes its tab");
  pass("Submit presses once, reads a real receipt off the page, photographs it and closes the tab");

  const steps = [...new Set(sent.outcome.evidence.trace.map((entry) => entry.step))];
  assert.deepEqual(steps, ["detect", "reach", "inspect", "resolve", "fill", "verify", "advance", "preflight", "submit", "outcome", "evidence"], JSON.stringify(steps));
  pass("The walk runs the declared steps in the declared order, ending with evidence");

  // This fixture carries react-select's class names without React behind
  // them, which is exactly the page that used to be held for the full
  // fifteen-second hydration wait - three quarters of the whole attempt.
  // Asserted in time rather than by inspection, because the symptom of
  // losing the escape hatch again is slowness, which nothing else notices.
  const inspecting = sent.outcome.evidence.trace.filter((entry) => entry.step === "inspect").reduce((total, entry) => total + entry.ms, 0);
  assert.ok(inspecting < 8000, `reading the form took ${inspecting}ms; a static page must not wait out the hydration deadline`);
  pass(`A page with React class names and no React is read in ${(inspecting / 1000).toFixed(1)}s instead of waiting out the fiber deadline`);

  /* ------------------------------------- a site no adapter claims is left alone */

  const unknownUrl = `http://unknown-careers.example.test:${server.address().port}/jobs/1`;
  const unknown = await applyFromPage(page, { url: unknownUrl, company: "Unknown Careers", review: false });
  report.runs.push({ mode: "unknown", ...unknown });

  assert.equal(unknown.outcome.status, "challenge", JSON.stringify(unknown, null, 2));
  assert.equal(unknown.outcome.submitted, false);
  assert.match(unknown.outcome.reason, /no adapter recognises/);
  assert.equal(unknown.outcome.evidence.unsupported, true);
  const left = context.pages().find((open) => open.url() === unknownUrl);
  assert.ok(left, "an unsupported site keeps its page for a person");
  assert.equal(await left.locator("#name").inputValue(), "", "nothing is typed into a form nobody understands");
  assert.equal(await left.evaluate(() => window.submissions), 0);
  pass("A site no adapter claims is parked untouched with its page open, which is the intended outcome today");

  /* ------------------- Workable: a second board, through the same engine */

  // The live Workable posting in the corpus cannot be submitted, so the one
  // claim worth testing - that a receipt arriving as an HTTP status needs
  // no change above the adapter - is tested here instead.
  const workableUrl = `http://apply.workable.com:${server.address().port}/toloka/j/8A10343CF6/`;
  const workable = await applyFromPage(page, { url: workableUrl, company: "Toloka", review: false });

  assert.equal(workable.outcome.evidence.adapter, "workable", JSON.stringify(workable, null, 2));
  assert.ok(workable.log.some((line) => line.includes("the posting is not the form")), "the saved link is the posting; the adapter goes on to the form");
  pass("A saved link that points at the posting reaches the form through the declared reach step");

  assert.equal(workable.outcome.status, "confirmed", JSON.stringify(workable, null, 2));
  assert.match(workable.outcome.receipt, /201 from \/api\/v3\/accounts\/toloka\/candidates/);
  pass("A receipt that arrives as an HTTP status is read as a confirmation, with no page text to quote");

  // The point of the previous check, stated as the thing it is guarding: the
  // engine was not taught about network receipts, and the Greenhouse page
  // this fixture mimics never said a word.
  const silent = context.pages().find((open) => open.url().includes("apply.workable.com"));
  assert.equal(silent, undefined, "a confirmed application closes its tab regardless of where the receipt came from");
  pass("The engine accepted a second board's outcome shape without learning anything about that board");

  /* ------------------- Ashby: how little a similar board needs */

  const ashbyUrl = `https://jobs.ashbyhq.com:${ashbyServer.address().port}/sunnydata/cf3934d7-3a1c-444c-a83c-ab202ae65f0b`;
  const ashby = await applyFromPage(page, { url: ashbyUrl, company: "Sunny Data", review: false });
  report.runs.push({ mode: "ashby", ...ashby });

  assert.equal(ashby.outcome.evidence.adapter, "ashby", JSON.stringify(ashby, null, 2));
  assert.equal(ashby.outcome.evidence.confidence, 100);
  assert.ok(ashby.log.some((line) => line.includes("the posting is not the form")), "the saved Ashby link is the posting; the adapter goes on to /application");
  pass("Ashby is recognised from its posting address and reaches the form, which is the whole adapter");

  // The yes/no pair is the shape that has no control of its own to fill -
  // two buttons over a hidden checkbox - and the profile answers it. If the
  // adapter had needed to know about that, this is where it would show.
  const authorized = ashby.outcome.evidence.answers.find((entry) => /legally authorized/i.test(entry.question));
  assert.ok(authorized, `the authorization question was never answered: ${JSON.stringify(ashby.outcome.evidence.answers)}`);
  assert.match(String(authorized.answer), /^yes$/i);
  pass("Ashby's yes/no button pair is answered from the profile with no adapter code for it");

  assert.equal(ashby.outcome.status, "confirmed", JSON.stringify(ashby, null, 2));
  assert.match(ashby.outcome.receipt, /Thanks for applying/i);
  pass("A board that confirms in the page is read by the same default that read a board confirming over the network");

  // Every step the walk took, and not one of them dispatched to the
  // adapter: the file declares `detect` and `reach` and nothing else, so
  // everything below is the engine's own. This is the claim being tested -
  // that a board resembling one already supported costs two methods.
  const overrides = Object.keys(ashbyAdapter).filter((key) => typeof ashbyAdapter[key] === "function");
  assert.deepEqual(overrides.sort(), ["detect", "reach"], `Ashby overrides ${overrides.join(", ")}; a similar board should need no more than detection and a navigation`);
  pass("Ashby carried an application to a receipt while overriding exactly two engine steps");

  console.log("\n15 standalone apply checks passed.");
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((done) => server.close(done));
  await new Promise((done) => ashbyServer.close(done));
  await releaseScratch(profilePath);
  await releaseScratch(certDir);
  report.finishedAt = new Date().toISOString();
  await writeFile("test-results/apply-standalone.json", JSON.stringify(report, null, 2));
}
