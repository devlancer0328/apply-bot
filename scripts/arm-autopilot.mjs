/**
 * The switches that turn a rehearsal into a night of real applications.
 *
 * Everything here is a stored setting rather than code, and that is
 * exactly why it needs a file of its own: the settings that made the bot
 * safe to test are the settings that make it useless unattended, and they
 * were changed one at a time, by hand, in an options page nobody will be
 * sitting at tonight. `maxPerRun: 2` stops the night after two. `exportFiles`
 * off writes database rows and no evidence a person can hold. Each was
 * correct when it was set and each is a silent zero by morning.
 *
 * ## Why the thirteen are imported first
 *
 * Today's thirteen confirmed applications were driven through a harness
 * that deliberately stubs `claimCompany` out, so not one of them left a
 * row in the extension's own history. The duplicate protection has
 * therefore never heard of them, and the first thing autopilot would do
 * with a feed full of AI engineering roles is apply to several of them
 * again. They go in as company-level bars rather than posting-level ones:
 * the exact apply addresses are not recorded for all thirteen, a bar costs
 * at most two further roles at an employer already written to today, and a
 * duplicate application cannot be taken back.
 *
 * Attaches to the Chrome that is already running. Never launches one, and
 * never touches a tab the person opened.
 */

import { chromium } from "playwright";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const START = process.env.START === "true";

/** Applied to by hand today, before any of this ran. Not to be repeated. */
const ALREADY_APPLIED = [
  "DataCamp", "Ondo", "Scale", "Domino", "DigiCert", "Federato", "Flowcode",
  "MCG", "Tandem Diabetes Care", "OneSource Virtual", "NPR", "Tubi", "LangChain",
];

/**
 * `maxPerRun` and `maxSubmittedPerRun` go
 * to zero because the ceiling belongs to the day's target and the pacing
 * in schedule.js, not to a per-run counter that was only ever there to
 * keep a test short - a run that stops at two and hands back to autopilot
 * spends its whole night in start-up.
 *
 * The three feeds are turned on together because two of them were off: a
 * night with `autoFetch` false works through the two pasted links and
 * finishes, which is the other way this run could have applied to nothing.
 */
const PROFILE = {
  maxPerRun: 0,
  maxSubmittedPerRun: 0,
  exportFiles: true,
  autoFetch: true,
  jobrightRecommend: true,
  hiringCafeUrl: "https://hiring.cafe/",
  // Foreground tabs are how this bot works: one tab at a time is brought
  // to the front and typed into. Left on.
  foregroundTabs: true,
  keepRunning: true,
  // Off, on the evidence of the first live Workday attempt of the night.
  // Postman's tenant created a candidate account under the applicant's
  // real name, walked the wizard, and then refused the application over
  // "Address Line 1 is required" - a field no résumé in the corpus
  // supplies and nothing here may invent. That is the worst outcome the
  // system can produce: a permanent record in an employer's recruiting
  // system, visible to their recruiters, with no application behind it
  // and no release path of any kind. A claim can be given back; an
  // account cannot be deleted. Until a street address exists, Workday
  // postings park at the account wall having signed nobody up for
  // anything, which costs the postings and nothing else.
  allowAccountRegistration: false,
};

const SCHEDULE = { autopilot: true, dailyTarget: 300, perCompanyPerDay: 3 };

const browser = await chromium.connectOverCDP(ATTACH);
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const ours = (list) => list.find((worker) => worker.url().includes(EXT_ID));
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${EXT_ID}`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    const done = await page.evaluate(async ({ profile, schedule, barred, start }) => {
      const { writeProfile, importHistory, allHistory, stateStorage } = await import("./store.js");
      const { missingFromProfile } = await import("./profile.js");

      const before = await allHistory();
      const known = new Set(before.map((row) => String(row.company || "").toLowerCase()));
      const fresh = barred.filter((company) => !known.has(company.toLowerCase())).map((company) => ({ company }));
      if (fresh.length > 0) await importHistory(fresh);

      const saved = await writeProfile(profile);
      await stateStorage.set({ schedule });
      await chrome.runtime.sendMessage({ type: "schedule" });
      if (start) await chrome.runtime.sendMessage({ type: "run" });

      return {
        imported: fresh.length,
        history: (await allHistory()).length,
        missing: missingFromProfile(saved),
        profile: Object.fromEntries(Object.keys(profile).map((key) => [key, saved[key]])),
        schedule: (await stateStorage.get("schedule")).schedule,
        started: start,
      };
    }, { profile: PROFILE, schedule: SCHEDULE, barred: ALREADY_APPLIED, start: START });

    console.log(JSON.stringify(done, null, 2));
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
}
