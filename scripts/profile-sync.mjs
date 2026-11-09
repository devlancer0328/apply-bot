/**
 * The candidate's stored facts, written into the extension's own profile.
 *
 * Every required field a form asks and the profile cannot answer is a
 * stopped application, and at three hundred a day a stopped application is
 * a stopped queue. Most of what stopped the corpus was not a judgement
 * call at all - a LinkedIn address, a non-compete answer, a start date -
 * so the cheapest throughput work available is making sure those are
 * actually in `chrome.storage` rather than in a harness environment
 * variable that only exists for the length of one test run.
 *
 * It attaches to a Chrome that is already running with remote debugging
 * and never launches one: the profile these facts belong to is the one the
 * person is signed into, and a second browser would write them somewhere
 * nobody reads. ATTACH and EXT_ID say where; EXT_ID matters because an
 * older build of this extension is installed beside the current one and
 * taking whichever service worker answers first writes the wrong profile.
 *
 *   ATTACH=http://127.0.0.1:9222 EXT_ID=<id> node scripts/profile-sync.mjs
 *
 * Values given on the command line as key=value override the table below,
 * and nothing is ever written empty: `writeProfile` merges, so a key left
 * out keeps whatever is stored, and a key written blank would delete a
 * fact the person had supplied.
 */

import { chromium } from "playwright";

const attachTo = process.env.ATTACH ?? "http://127.0.0.1:9222";
const wanted = process.env.EXT_ID ?? "";

/**
 * Daniel Torres, as the corpus resumes state him, with the address
 * overridden to the mailbox this browser can read - Greenhouse mails an
 * eight-digit code before it will take an application, and a code in an
 * inbox nobody can open is the same as no code.
 *
 * The LinkedIn address was supplied as "linkedin.com/danieltorres8483",
 * which is not where a LinkedIn profile lives; profiles are served under
 * /in/. It is normalised here and again in `profileLink`, so a recruiter
 * following it does not get a 404. The slug itself is unverified.
 *
 * ## Facts that are deliberately absent, and what each one costs
 *
 * The temptation at three hundred a day is to fill every blank so nothing
 * parks, and every one of these is a statement a real employer reads under
 * the applicant's name. A parked posting costs one application; a invented
 * one costs the candidate their credibility with that employer, and it
 * cannot be withdrawn. So:
 *
 *   - `github` and `website` are not here because no GitHub account or
 *     personal site appears anywhere in the corpus - the only matches are
 *     the skill "GitHub Actions". Mapbox asks for a GitHub URL and will
 *     park for want of it. That is the correct trade and it stays until
 *     somebody supplies a real one.
 *   - `street` is not here for the same reason: the resumes give "Temple,
 *     TX" and no street. Workday asks, and Workday postings park.
 *   - `previousEmployers` is not here because the corpus resumes are each
 *     tailored to their posting and name a hundred and twenty-four
 *     different employers between them, none repeating. There is no stable
 *     history to declare. `workedAt` already falls back to the résumé
 *     actually generated for the application in hand, which is the honest
 *     source for "have you worked here before".
 *   - `licenses` is not here although every corpus résumé carries an empty
 *     certifications list, because a résumé is a summary the candidate
 *     chose the contents of and not a register, and "no securities
 *     licence" is read by a regulator rather than corrected by a
 *     recruiter. One word - `licenses=none` on the command line below -
 *     answers the whole class, and only the applicant may say it.
 *   - `answerBank` is empty because the applicant has not yet stated an
 *     answer to anything. It takes one `pattern = answer` per line and is
 *     the way to settle a judgement question permanently:
 *     `answerBank=$'security clearance = No\nathlete = No'`.
 */
const FACTS = {
  firstName: "Daniel",
  lastName: "Torres",
  email: "steven.atkin1493@gmail.com",
  phone: "+1 (929) 489-1252",
  city: "Temple",
  state: "TX",
  // Inferred, not supplied. 76501 is the central ZIP for Temple, TX, which
  // is the only location the corpus states; nobody confirmed it, and no
  // résumé or form response in the corpus carries a postal code. It is
  // recorded because a blank postal code parks forms that ask for one and
  // a wrong central ZIP in the right city is a correctable clerical error
  // rather than a false claim - but it is the one fact in this table that
  // was worked out rather than read, and it should be replaced the moment
  // the applicant says otherwise.
  zip: "76501",
  country: "United States",
  linkedin: "https://www.linkedin.com/in/danieltorres8483",
  workAuthorization: "us-citizen",
  requiresSponsorship: "no",
  over18: "yes",
  nonCompete: "no",
  backgroundCheck: "yes",
  willingToRelocate: "no",
  willingToTravel: "yes",
  startDate: "Two weeks after offer",
  remotePreference: "Remote",
  howHeard: "Company website",
  techYears: 9,
  // The one block of career history that is identical on all thirty-one
  // corpus resumes, and therefore the only part of it this system can
  // state as a fact rather than as whatever the writer produced for the
  // posting in hand. Workday's My Experience and Greenhouse's
  // School/Degree/Discipline rows are required far more often than not,
  // and a resume that came back without an education section used to park
  // the application on a fact that has not changed since 2015.
  educationSchool: "University of Texas - Austin",
  educationDegree: "Bachelor of Science in Computer Science (Software Engineering)",
  educationStart: "Aug 2011",
  educationEnd: "May 2015",
};

// `true` and `false` on a command line are strings, and `withDefaults`
// throws a string at a boolean key away and restores the default - so
// `allowAccountRegistration=true` would silently store the opposite of
// what was asked for, which is the wrong direction for that key in
// particular to fail in.
const literal = (value) => (value === "true" ? true : value === "false" ? false : value);
const overrides = Object.fromEntries(process.argv.slice(2).map((pair) => pair.split(/=(.*)/s).slice(0, 2)).map(([key, value]) => [key, literal(value)]));
const facts = Object.fromEntries(Object.entries({ ...FACTS, ...overrides }).filter(([, value]) => value !== "" && value !== undefined));

const browser = await chromium.connectOverCDP(attachTo);
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${attachTo}`);
  const ours = (list) => (wanted ? list.find((worker) => worker.url().includes(wanted)) : list[0]);
  const worker = ours(context.serviceWorkers()) || ours([await context.waitForEvent("serviceworker", { timeout: 20000 })]);
  if (!worker) throw new Error(`no service worker for extension ${wanted}; is it installed and awake?`);

  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options.html`);
    const saved = await page.evaluate(async (value) => {
      const { writeProfile } = await import("./store.js");
      const { missingFromProfile } = await import("./profile.js");
      const profile = await writeProfile(value);
      return { profile, missing: missingFromProfile(profile) };
    }, facts);

    for (const [key, value] of Object.entries(facts)) console.log(`${key.padEnd(20)} ${saved.profile[key] === value ? "=" : "!"} ${JSON.stringify(saved.profile[key])}`);
    console.log(`\nRequired profile fields still empty: ${saved.missing.length > 0 ? saved.missing.join(", ") : "none"}`);
  } finally {
    await page.close();
  }
} finally {
  // Detaches. The person's browser and every tab they had open stay as they were.
  await browser.close();
}
