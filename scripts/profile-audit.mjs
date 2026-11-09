/**
 * Which stored facts are missing, and which required question each one parks.
 *
 * Every blank in the profile is a class of application that stops rather
 * than sends, and at three hundred a day the difference between a blank
 * that costs one posting and one that costs forty is worth knowing before
 * the night starts rather than after. `profile-sync.mjs` writes the facts;
 * this reads back what is actually in `chrome.storage` on the running
 * extension and says what each gap costs, so the decision to fill a field
 * or leave it deliberately empty is made against a number.
 *
 * It attaches to the Chrome that is already running and never launches one
 * - the profile that matters is the one the person is signed into.
 *
 *   ATTACH=http://127.0.0.1:9222 EXT_ID=<id> node scripts/profile-audit.mjs
 */

import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";

/** What a blank costs, for the fields a required question actually reaches. */
const COSTS = {
  street: "Workday's address block is required on most tenants; the posting parks at 'Address Line 1 is required'",
  github: "Mapbox and other engineering-led boards ask for it as a required URL",
  website: "asked as an optional portfolio link, and as the fallback for any required URL box",
  workdayPassword: "Workday sign-in; without it every returning tenant parks at the login",
  previousEmployers: "'have you worked here before' menus that want the employer named",
  chatGptProjectUrl: "every application: the writer has nowhere to send the resume prompt",
  nonCompete: "a required yes/no on finance and healthcare boards",
  howHeard: "a required menu on most Greenhouse and Workday forms",
  startDate: "'when can you start' on nearly every form",
  desiredSalary: "pay boxes - though these need cited research, not a stored number",
  licenses: "'do you hold any securities industry licenses' on finance boards; blank parks it, the word 'none' answers it",
  answerBank: "nothing by itself, but it is the only way to settle a judgement question the bot refuses to invent",
  educationSchool: "Workday's My Experience and Greenhouse's School/Degree rows, where the generated resume carries no education section",
  educationDegree: "as educationSchool",
  educationStart: "the education block's start year and month",
  educationEnd: "the education block's end year and month",
};

const browser = await chromium.connectOverCDP(ATTACH);
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const worker = context.serviceWorkers().find((candidate) => candidate.url().includes(EXT_ID));
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  const page = await context.newPage();
  let stored;
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    // The profile lives in the extension's own SQLite key-value table, not
    // in chrome.storage - reading the latter returns an empty object and
    // reports every field blank on a profile that is completely filled in.
    stored = await page.evaluate(async () => (await (await import("./store.js")).stateStorage.get("profile")).profile ?? {});
  } finally {
    await page.close().catch(() => {});
  }

  const empty = (value) => value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  const blanks = Object.keys(stored).filter((key) => empty(stored[key])).sort();

  console.log("RUN SETTINGS");
  for (const key of ["maxPerRun", "maxSubmittedPerRun", "exportFiles", "autoFetch", "jobrightRecommend", "hiringCafeUrl", "allowAccountRegistration", "applyEngine", "chatGptProjectUrl", "chatGptConcurrency"]) {
    console.log(`  ${key.padEnd(24)} ${JSON.stringify(stored[key])}`);
  }

  console.log("\nIDENTITY");
  for (const key of ["firstName", "lastName", "email", "phone", "street", "city", "state", "zip", "country", "linkedin", "github", "website"]) {
    console.log(`  ${key.padEnd(24)} ${JSON.stringify(stored[key] ?? "")}`);
  }

  console.log(`\nBLANK (${blanks.length})`);
  for (const key of blanks) console.log(`  ${key.padEnd(24)} ${COSTS[key] ?? "no required question is known to reach this"}`);
} finally {
  await browser.close();
}
