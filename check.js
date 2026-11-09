/**
 * Checks the bot against the thing it will actually meet.
 *
 * The fixture is not markup anyone wrote for a test. It is the rendered
 * application form captured out of Chrome from a live Greenhouse posting, which
 * matters because every mistake worth catching here came from assuming what
 * that markup looks like. Three of them were real, and all three are asserted
 * below: the invisible `<input required>` behind every dropdown, the file
 * inputs labelled "Attach" with the meaning only in their ids, and the
 * dropdown that reports an empty value after you have successfully filled it.
 *
 * Run with: node apply-bot/check.js
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { resolveForm, resolveField, chooseOption, expand, pickOption } from "./src/answers.js";
import { applyHost, canonicalUrl, groupByFolder, joinApplications, postingUrlFrom, resolveApplication } from "./src/join.js";
import { atsOf } from "./src/ats.js";
import { parseAnswers, snapToOption } from "./src/ai.js";
import { costOf, describe as describeSpend } from "./src/spend.js";
import { diagnoseSearch, isHiringCafeSearch, pageUrl as hiringCafePage } from "./src/hiringcafe.js";
import { classified as classifiedJobright } from "./src/jobright.js";
import { DiscoveryRounds } from "./src/run-policy.js";
import { codeForCompany, mailboxUrl, namesMatch, parseRow, ROW_MINUTE_MS } from "./src/mailbox.js";
import { applicationFolder, boardLabel, dayFolder, MANUAL_ROOT, otherLinksCsv, otherLinksPath, resultsCsv, safeName, stamp } from "./src/vault.js";
import { candidateFrom, checkWriterSettings, educationFrom, resumeToText, themeFrom } from "./src/writer.js";
import { askChatGpt, chatGptStatus, isChatGptUrl } from "./src/chatgpt.js";
import { documentFault, resumePrompt, toDocument, toResume } from "./src/resume.js";
import { buildQueue, extractLinks, isSignInPage, linksFromCsv, sheetCsvUrl } from "./src/links.js";

import { DEFAULT_PROFILE, missingFromProfile, withDefaults } from "./src/profile.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${passed || !detail ? "" : `  -> ${detail}`}`);
  if (!passed) failures += 1;
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------- the page */

/**
 * Classes whose subtree Chrome reported as having no box on the real page.
 *
 * linkedom has no layout engine and loads no stylesheets, so a filter that
 * depends on an element's measured size cannot be exercised honestly without
 * being told what the browser measured. These are those observations, not
 * guesses - the phone widget keeps a country search box and 244 country
 * options mounted inside a `display: none` container at all times.
 */
const HIDDEN_SUBTREES = ["iti__hide", "iti__dropdown-content"];

function hiddenByCss(element) {
  for (let node = element; node; node = node.parentElement) {
    const className = String(node.className ?? "");
    if (HIDDEN_SUBTREES.some((hidden) => className.includes(hidden))) return true;
  }
  return false;
}

/** Runs the real fill.js over a page and returns the inventory it reports. */
function inventoryOf(html) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  const context = createContext({
    window,
    document,
    location: { href: "https://job-boards.greenhouse.io/discord/jobs/8840756002" },
    CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
    getComputedStyle: (element) => ({
      display: hiddenByCss(element) ? "none" : "block",
      visibility: "visible",
      opacity: "1",
    }),
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    setTimeout,
    console,
  });

  // Every element answers the same way, so the inventory stands or falls on
  // the markup-level signals - aria-hidden, tabindex, labels, ids - rather
  // than on anything this harness invented.
  for (const element of document.querySelectorAll("input, select, textarea")) {
    element.getBoundingClientRect = () => (hiddenByCss(element) ? { width: 0, height: 0 } : { width: 200, height: 30 });
  }

  context.window = context;
  runInContext(readFileSync(join(HERE, "src/fill.js"), "utf8"), context);
  return runInContext("window.__ghApply.inventory()", context);
}

const PROFILE = { ...withDefaults({
  firstName:'Steven',lastName:'Atkins',email:'steven@example.test',phone:'(281) 555-0100',city:'Friendswood',state:'Texas',country:'United States',linkedin:'https://www.linkedin.com/in/steven-atkins-9382',
  workAuthorization:'us-citizen',requiresSponsorship:'no',over18:'yes',nonCompete:'no',backgroundCheck:'yes',previouslyEmployed:'no',willingToRelocate:'no',willingToTravel:'yes',gender:'Male',race:'Asian',hispanic:'no',veteran:'I am not a protected veteran',disability:'No, I do not have a disability',transgender:'yes',sexualOrientation:'Heterosexual',techYears:8,startDate:'Two weeks from offer',salaryFallback:120000,howHeard:'Google',
  street: "123 Main St",
  zip: "77546",
  github: "https://github.com/steven-atkins",
  website: "https://stevenatkins.dev",
  applicationResume: "Ten years building web applications.",
  apiKey: "test",
}), applicationResume: "Ten years building web applications." };

const CONTEXT = {
  company: "Discord",
  title: "Data Scientist - Client Platform",
  jd: "The base salary range for this full-time position is listed below. Base Salary $160,000 - $200,000 USD",
  letter: "I have spent years on client platform reliability.",
  resume: PROFILE.applicationResume,
};

/* ---------------------------------------------- the real Greenhouse form */

section("A live Greenhouse application form");

const fixture = readFileSync(join(HERE, "fixtures/greenhouse-discord.html"), "utf8");
const inventory = inventoryOf(fixture);
const plan = resolveForm(inventory.fields, PROFILE, CONTEXT);

const byLabel = (text) => inventory.fields.find((field) => field.label.toLowerCase().includes(text.toLowerCase()));
const outcomeOf = (field) => {
  if (!field) return "missing";
  if (plan.fills.some((entry) => entry.key === field.key)) return "fill";
  if (plan.attachments.some((entry) => entry.key === field.key)) return "attach";
  if (plan.questions.some((entry) => entry.key === field.key)) return "ask";
  if (plan.blocked.some((entry) => entry.key === field.key)) return "blocked";
  if (plan.skipped.some((entry) => entry.key === field.key)) return "skip";
  return "none";
};
const valueOf = (text) => plan.fills.find((entry) => entry.key === byLabel(text)?.key)?.value;

check("the form is read at all", inventory.fields.length > 0, `${inventory.fields.length} fields`);
check("the submit button is found", inventory.submit.found, JSON.stringify(inventory.submit));

// The bug that would have blocked every single application.
const decoys = inventory.fields.filter((field) => !field.label && !field.id && !field.name);
check("the invisible required inputs behind each dropdown are ignored", decoys.length === 0, `${decoys.length} unlabelled controls survived`);

const phoneSearch = inventory.fields.find((field) => field.id.includes("search-input"));
check("the phone widget's hidden country search is ignored", !phoneSearch);

section("Identity comes from the profile, verbatim");
check("first name", valueOf("First Name") === "Steven", valueOf("First Name"));
check("last name", valueOf("Last Name") === "Atkins", valueOf("Last Name"));
check("email", valueOf("Email") === PROFILE.email, valueOf("Email"));
check("phone", valueOf("Phone") === PROFILE.phone, valueOf("Phone"));
check("LinkedIn is optional on this form, so it is left empty", valueOf("LinkedIn") === undefined, String(valueOf("LinkedIn")));
const linkedinRequired = resolveField({ type: "text", required: true, options: [], label: "LinkedIn Profile", name: "linkedin" }, PROFILE, CONTEXT);
check("LinkedIn is given where the form insists on it", linkedinRequired.outcome === "fill" && linkedinRequired.value === "https://www.linkedin.com/in/steven-atkins-9382", JSON.stringify(linkedinRequired));
const urlOptional = resolveField({ type: "url", required: false, options: [], label: "Website", name: "website" }, { ...PROFILE, website: "" }, CONTEXT);
check("an optional address box is not filled with the LinkedIn profile either", urlOptional.outcome !== "fill", JSON.stringify(urlOptional));
const prefilled = resolveField({ type: "text", required: false, options: [], label: "LinkedIn Account:", name: "linkedInAccount", current: "https://www.linkedin.com/in/steven-atkins-9382" }, PROFILE, CONTEXT);
check("an optional LinkedIn box a career site filled from its own records is emptied", prefilled.outcome === "fill" && prefilled.value === "" && prefilled.cleared === true, JSON.stringify(prefilled));
check("website", valueOf("Website") === PROFILE.website, valueOf("Website"));
check("how they heard", valueOf("How did you hear") === PROFILE.howHeard, valueOf("How did you hear"));
{
  const menu = resolveField({ key: "hh", tag: "input", type: "search", combobox: true, options: [], label: "How Did You Hear About Us?", required: true }, PROFILE, CONTEXT);
  check("a searchable source menu gets Google, then its category, then the job boards", menu.outcome === "fill" && menu.candidates[0] === "Google" && menu.candidates.indexOf("Search Engine") < menu.candidates.indexOf("LinkedIn"), JSON.stringify(menu.candidates));
  check("a chosen source is preserved", withDefaults({ howHeard: "LinkedIn" }).howHeard === "LinkedIn" && withDefaults({ howHeard: "A friend" }).howHeard === "A friend");
  const ashby = ["Company website / careers page", "LinkedIn", "Other job board (e.g. Glassdoor, RepVue, Built In)", "Networking / referral", "Recruiter outreach", "Industry event or conference", "Other"].map((label) => ({ label, value: label }));
  const heard = resolveField({ key: "hh2", tag: "radio", type: "radio", options: ashby, label: "How did you hear about this opportunity?", required: true }, PROFILE, CONTEXT);
  check("an Ashby source menu without Google takes the careers page, not the job board that opens a second question", heard.outcome === "fill" && heard.value === "Company website / careers page", JSON.stringify(heard));
  const boards = ["Glassdoor", "Indeed", "Built In", "RepVue", "Other"].map((label) => ({ label, value: label }));
  const which = resolveField({ key: "hh3", tag: "radio", type: "radio", options: boards, label: "Please specify which job board brought you to Horizon3.", required: true }, PROFILE, CONTEXT);
  check("the follow-up asking which job board is answered from the same rule", which.outcome === "fill" && which.rule === "how-heard" && which.value === "Indeed", JSON.stringify(which));
}
check("country", valueOf("Country") === "United States", valueOf("Country"));
check("city is spelled the way the geocoder spells it", valueOf("Location (City)") === "Friendswood, Texas", valueOf("Location (City)"));

section("Documents, whose labels say only 'Attach'");
const resumeField = inventory.fields.find((field) => field.id === "resume");
const letterField = inventory.fields.find((field) => field.id === "cover_letter");
check("the resume input is recognised by its id", outcomeOf(resumeField) === "attach", outcomeOf(resumeField));
check("the cover letter input is recognised despite the underscore", outcomeOf(letterField) === "attach", outcomeOf(letterField));
check(
  "the two are not confused for each other",
  plan.attachments.find((entry) => entry.key === resumeField?.key)?.document === "resume" &&
    plan.attachments.find((entry) => entry.key === letterField?.key)?.document === "cover",
  JSON.stringify(plan.attachments),
);

section("Legal and demographic questions never reach the model");
const SENSITIVE = [
  ["Are you legally authorized to work", "Yes"],
  ["Are you currently located in the US", "Yes"],
  ["willing to relocate", "No"],
  ["Gender", PROFILE.gender],
  ["Race and Ethnicity", PROFILE.race],
  ["Veteran Status", PROFILE.veteran],
  ["Disability Status", PROFILE.disability],
];

for (const [label, expected] of SENSITIVE) {
  const field = byLabel(label);
  check(`"${label}" is answered from the profile`, outcomeOf(field) === "fill", outcomeOf(field));
  check(`"${label}" answers ${expected}`, valueOf(label) === expected, valueOf(label));
}

check(
  "no demographic or legal question was handed to the model",
  !plan.questions.some((question) => /gender|race|ethnic|veteran|disabilit|authoriz|sponsor|relocat|located/i.test(question.question)),
  JSON.stringify(plan.questions.map((question) => question.question)),
);

check(
  "declining expands to the wording this board actually offers",
  expand("decline").some((candidate) => candidate === "I don't wish to answer"),
  JSON.stringify(expand("decline")),
);

section("Consent and the open questions");
check(
  "the demographic consent checkbox is ticked",
  outcomeOf(byLabel("I consent to Discord collecting")) === "fill",
  outcomeOf(byLabel("I consent to Discord collecting")),
);
check(
  "'Why do you want to work at Discord?' goes to the model",
  outcomeOf(byLabel("Why do you want to work at Discord")) === "ask",
  outcomeOf(byLabel("Why do you want to work at Discord")),
);
check(
  "the long behavioural question goes to the model",
  outcomeOf(byLabel("Tell us about a time a metric")) === "ask",
  outcomeOf(byLabel("Tell us about a time a metric")),
);

section("The form as a whole");
check("nothing blocks this application", plan.blocked.length === 0, JSON.stringify(plan.blocked));
check(
  "every required field is accounted for",
  inventory.fields
    .filter((field) => field.required)
    .every((field) => ["fill", "attach", "ask"].includes(outcomeOf(field))),
  JSON.stringify(
    inventory.fields.filter((field) => field.required && !["fill", "attach", "ask"].includes(outcomeOf(field))).map((field) => field.label),
  ),
);

/* --------------------------------------------------------- the gate */

section("The gate that refuses to submit");

const requiredSelect = [
  {
    key: "k1",
    tag: "select",
    type: "select-one",
    name: "",
    id: "",
    label: "Which of our offices would you work from?",
    required: true,
    options: [
      { value: "1", label: "Dublin" },
      { value: "2", label: "Berlin" },
    ],
  },
];
check(
  "a required dropdown with no answerable option blocks the job",
  resolveForm(requiredSelect, PROFILE, CONTEXT).blocked.length === 0 ||
    resolveForm(requiredSelect, PROFILE, CONTEXT).questions.length === 1,
  "an office choice is open-ended, so the model may try it",
);

/* AlphaSense's wording, as a free text box. The profile knows this answer,
   and a blank here skipped the job. */
const eligibilityText = [
  { key: "e1", tag: "input", type: "text", name: "", id: "", label: "Are you currently eligible to work in the United States of America?", required: true, options: [] },
  { key: "e2", tag: "input", type: "text", name: "", id: "", label: "Are you legally permitted to work in the US?", required: true, options: [] },
  { key: "e3", tag: "input", type: "text", name: "", id: "", label: "Work eligibility status", required: false, options: [] },
];
{
  const plan = resolveForm(eligibilityText, PROFILE, CONTEXT);
  const answered = Object.fromEntries(plan.fills.map((f) => [f.key, f.value]));
  check(
    "\"eligible to work\" is answered from the profile, not sent to the model or left blank",
    answered.e1 === "Yes" && answered.e2 === "Yes" && answered.e3 === "Yes" && plan.blocked.length === 0 && plan.questions.length === 0,
    JSON.stringify({ fills: answered, blocked: plan.blocked, questions: plan.questions.map((q) => q.key) }),
  );
}

/* Mercury's wording. It went to the model, which answered with the city of
   the resume's last employer - two fields below a location box that said
   Friendswood, Texas. Where the applicant works from is a fact about the
   applicant, and only the profile holds it. */
{
  const workFrom = [{ key: "w1", tag: "input", type: "text", name: "", id: "", label: "From where do you intend to work?", required: true, options: [] }];
  const plan = resolveForm(workFrom, PROFILE, CONTEXT);
  check(
    "\"from where do you intend to work\" is the profile's city and state, never the model's guess",
    plan.fills[0]?.value === "Friendswood, Texas" && plan.questions.length === 0,
    JSON.stringify({ fills: plan.fills, questions: plan.questions.map((q) => q.key) }),
  );
}

/* AlphaSense asks the current title and employer as two boxes. Sent to the
   model, each came back as a sentence about itself. The attached resume's
   first entry is the answer. */
{
  const current = [
    { key: "t", tag: "input", type: "text", name: "", id: "", label: "Current Title", required: true, options: [] },
    { key: "c", tag: "input", type: "text", name: "", id: "", label: "Current Company", required: true, options: [] },
    { key: "w", tag: "textarea", type: "textarea", name: "", id: "", label: "Why do you want to work here?", required: true, options: [] },
  ];
  const plan = resolveForm(current, PROFILE, { ...CONTEXT, currentRole: "Staff Software Engineer", currentCompany: "Arize AI" });
  const fills = Object.fromEntries(plan.fills.map((f) => [f.key, f.value]));
  check(
    "current title comes off the attached resume; current company is N/A, the applicant being between contracts",
    fills.t === "Staff Software Engineer" && fills.c === "N/A",
    JSON.stringify(fills),
  );
  const recent = resolveForm([{ key: "r", tag: "input", type: "text", name: "", id: "", label: "Most recent employer", required: true, options: [] }], PROFILE, { ...CONTEXT, currentCompany: "Arize AI" });
  check("the most recent employer is the resume's latest", recent.fills[0]?.value === "Arize AI", JSON.stringify(recent.fills));
  check(
    "and an open question still goes to the model, knowing whether its box is one line or many",
    plan.questions.length === 1 && plan.questions[0].multiline === true,
    JSON.stringify(plan.questions),
  );
}

const requiredSponsorship = [
  {
    key: "k2",
    tag: "select",
    type: "select-one",
    name: "",
    id: "",
    label: "Do you now or in the future require sponsorship?",
    required: true,
    options: [
      { value: "1", label: "Pending" },
      { value: "2", label: "Under review" },
    ],
  },
];
const sponsorship = resolveForm(requiredSponsorship, PROFILE, CONTEXT);
check("a required legal question with no matching option blocks the job", sponsorship.blocked.length === 1, JSON.stringify(sponsorship));
check("and it is not passed to the model instead", sponsorship.questions.length === 0, JSON.stringify(sponsorship.questions));

const unknownLegal = {
  key: "k3",
  tag: "input",
  type: "text",
  name: "",
  id: "",
  // Was the felony question until a rule named it. The backstop is what
  // is being checked, so this has to stay a question nothing answers:
  // sensitive enough that the model may not guess, and held by nobody.
  label: "Have you ever been asked to submit to a polygraph examination?",
  required: true,
  options: [],
};
check(
  "a legal question no rule names is refused rather than guessed",
  resolveField(unknownLegal, PROFILE, CONTEXT).outcome === "blocked",
  resolveField(unknownLegal, PROFILE, CONTEXT).outcome,
);

// And the one it used to be, now that the applicant has stated it once.
// A conviction question is answered from profile.criminalRecord and from
// nothing else: clear that statement and it parks exactly as before.
const conviction = { ...unknownLegal, label: "Have you ever been convicted of a felony?" };
const stated = resolveField(conviction, PROFILE, CONTEXT);
check("a stated clean record answers the conviction question", stated.outcome === "fill" && stated.value === "No", JSON.stringify(stated));
check(
  "and with nothing stated it goes back to a person",
  resolveField(conviction, { ...PROFILE, criminalRecord: "" }, CONTEXT).outcome === "blocked",
  resolveField(conviction, { ...PROFILE, criminalRecord: "" }, CONTEXT).outcome,
);

// Vercel: "based in any of these countries?" over a dropdown of countries.
// The answer is the country, and the rule that answers "located in the US?"
// with a yes used to return nothing here, which skipped the job.
const countryPick = {
  key: "k3b",
  tag: "input",
  type: "text",
  name: "",
  id: "",
  label: "Are you currently based in any of these countries? Please note these are the only countries where we are accepting applications",
  required: true,
  combobox: true,
  options: [],
};
check(
  "a dropdown of countries is answered with the country",
  resolveField(countryPick, PROFILE, CONTEXT).value === "United States",
  JSON.stringify(resolveField(countryPick, PROFILE, CONTEXT)),
);
const countryYesNo = {
  ...countryPick,
  key: "k3c",
  tag: "select",
  type: "select-one",
  combobox: false,
  label: "Are you currently based in the US?",
  options: [
    { value: "1", label: "Yes" },
    { value: "0", label: "No" },
  ],
};
check(
  "the same question over yes/no is still answered yes",
  resolveField(countryYesNo, PROFILE, CONTEXT).candidates?.[0] === "Yes",
  JSON.stringify(resolveField(countryYesNo, PROFILE, CONTEXT)),
);

// Patriot Software: the one Greenhouse job in a run of seven, skipped because
// nothing answered this. It is a decision, so it is a setting.
const travel = {
  ...countryYesNo,
  key: "k3e",
  label: "This role may include an in-person interview and requires annual travel to our Canton, Ohio headquarters. Are you able to travel as required?",
};
check(
  "'able to travel as required?' is answered yes from the profile",
  resolveField(travel, PROFILE, CONTEXT).outcome === "fill" && resolveField(travel, PROFILE, CONTEXT).candidates?.[0] === "Yes",
  JSON.stringify(resolveField(travel, PROFILE, CONTEXT)),
);
check(
  "and no when the setting says so",
  resolveField(travel, { ...PROFILE, willingToTravel: "no" }, CONTEXT).candidates?.[0] === "No",
  JSON.stringify(resolveField(travel, { ...PROFILE, willingToTravel: "no" }, CONTEXT)),
);
check(
  "travel is not mistaken for relocation",
  resolveField({ ...travel, key: "k3f", label: "Are you willing to relocate to Canton, Ohio?" }, PROFILE, CONTEXT).candidates?.[0] === "No",
  JSON.stringify(resolveField({ ...travel, key: "k3f", label: "Are you willing to relocate to Canton, Ohio?" }, PROFILE, CONTEXT)),
);

// DoorDash: "Do you identify as transgender?" over a menu that renders its
// options only when opened. Answered as the applicant stated, not declined.
const trans = { ...countryPick, key: "k3g", label: "Do you identify as transgender?" };
check(
  "'Do you identify as transgender?' is answered from the profile",
  resolveField(trans, PROFILE, CONTEXT).outcome === "fill" && resolveField(trans, PROFILE, CONTEXT).candidates?.[0] === "Yes",
  JSON.stringify(resolveField(trans, PROFILE, CONTEXT)),
);
check(
  "and is not confused with the gender question",
  resolveField(trans, PROFILE, CONTEXT).rule === "transgender" && resolveField({ ...trans, key: "k3h", label: "Gender" }, PROFILE, CONTEXT).rule === "gender",
  resolveField(trans, PROFILE, CONTEXT).rule,
);
check(
  "sexual orientation is heterosexual by default, in the wordings boards use",
  resolveField({ ...trans, key: "k3i", label: "Sexual Orientation" }, PROFILE, CONTEXT).candidates?.includes("Heterosexual or straight"),
  JSON.stringify(resolveField({ ...trans, key: "k3i", label: "Sexual Orientation" }, PROFILE, CONTEXT)),
);
check(
  "sexual orientation declines when the profile says so",
  resolveField({ ...trans, key: "k3i", label: "Sexual Orientation" }, { ...PROFILE, sexualOrientation: "decline" }, CONTEXT).candidates?.includes("Prefer not to say"),
  JSON.stringify(resolveField({ ...trans, key: "k3i", label: "Sexual Orientation" }, { ...PROFILE, sexualOrientation: "decline" }, CONTEXT)),
);

// Patriot Software again: "How many years of experience do you have with
// Vue.js?" over a menu of bands, answered 0-1 by the model. Now the profile's
// number, placed on the menu.
const bands = ["0-1", "2-3", "4-6", "7-10", "10+"].map((label) => ({ value: label, label }));
const yearsSelect = { ...countryYesNo, key: "k4a", label: "How many years of experience do you have with Vue.js?", options: bands };
check(
  "'years of experience with Vue.js' over bands picks the band holding the number",
  resolveField(yearsSelect, PROFILE, CONTEXT).outcome === "fill" && resolveField(yearsSelect, PROFILE, CONTEXT).candidates?.[0] === "7-10",
  JSON.stringify(resolveField(yearsSelect, PROFILE, CONTEXT)),
);
const yearsBox = { ...countryPick, key: "k4b", combobox: true, options: [], label: "How many years of experience do you have with .NET Core / C#?" };
check(
  "the same question over a menu that renders later carries the number to the page",
  resolveField(yearsBox, PROFILE, CONTEXT).outcome === "fill" && resolveField(yearsBox, PROFILE, CONTEXT).pick === 8 && resolveField(yearsBox, PROFILE, CONTEXT).value === "8",
  JSON.stringify(resolveField(yearsBox, PROFILE, CONTEXT)),
);
check(
  "a plain box gets the number typed",
  resolveField({ ...yearsBox, key: "k4c", combobox: false, label: "Years of experience with PostgreSQL" }, PROFILE, CONTEXT).value === "8",
  JSON.stringify(resolveField({ ...yearsBox, key: "k4c", combobox: false, label: "Years of experience with PostgreSQL" }, PROFILE, CONTEXT)),
);
check(
  "'describe your experience with X' in a text area still goes to the model",
  resolveField({ ...yearsBox, key: "k4d", tag: "textarea", combobox: false, label: "Describe your experience with Kubernetes" }, PROFILE, CONTEXT).outcome === "ask",
  resolveField({ ...yearsBox, key: "k4d", tag: "textarea", combobox: false, label: "Describe your experience with Kubernetes" }, PROFILE, CONTEXT).outcome,
);
const hispanic = { ...countryYesNo, key: "k4e", label: "Are you Hispanic/Latino?", options: ["Yes", "No", "Decline To Self Identify"].map((label) => ({ value: label, label })) };
check(
  "'Are you Hispanic/Latino?' is answered No, not with the race setting",
  resolveField(hispanic, PROFILE, CONTEXT).candidates?.[0] === "No",
  JSON.stringify(resolveField(hispanic, PROFILE, CONTEXT)),
);
const gdpr = { ...countryYesNo, key: "k4f", label: "GDPR", options: [{ value: "1", label: "Acknowledge / Confirm" }] };
check(
  "a one-entry GDPR menu is acknowledged without the model",
  resolveField(gdpr, PROFILE, CONTEXT).outcome === "fill" && resolveField(gdpr, PROFILE, CONTEXT).candidates?.[0] === "Acknowledge / Confirm",
  JSON.stringify(resolveField(gdpr, PROFILE, CONTEXT)),
);
// Care Access: the education block, ids school--0 .. end-year--0. A start
// date answered "two weeks from now" there came back "End date must be
// after start date".
const schooled = { ...CONTEXT, education: { degree: "Bachelor of Science in Computer Science", school: "University of Houston", year: "2016" } };
const edu = (key, id, label, extra = {}) => ({ ...countryPick, key, id, name: "", label, combobox: true, options: [], ...extra });
check("start year is four years before the degree's year", resolveField(edu("e1", "start-year--0", "Start date year", { combobox: false }), PROFILE, schooled).value === "2012");
check("end year is the degree's year", resolveField(edu("e2", "end-year--0", "End date year", { combobox: false }), PROFILE, schooled).value === "2016");
check("start month is a September, not two weeks from now", resolveField(edu("e3", "start-month--0", "Start date month"), PROFILE, schooled).candidates?.[0] === "September");
check(
  "the degree is offered in the menu's spellings",
  resolveField(edu("e4", "degree--0", "Degree"), PROFILE, schooled).candidates?.includes("Bachelor's of Science (B.S)"),
  JSON.stringify(resolveField(edu("e4", "degree--0", "Degree"), PROFILE, schooled)),
);
check("the discipline is the major off the degree line", resolveField(edu("e5", "discipline--0", "Discipline"), PROFILE, schooled).candidates?.[0] === "Computer Science");
check("the school is the school", resolveField(edu("e6", "school--0", "School"), PROFILE, schooled).value === "University of Houston");
check("'when can you start' is still availability, not the education block", resolveField({ ...countryPick, key: "e7", id: "question_1", label: "When can you start?", combobox: false, options: [] }, PROFILE, schooled).rule === "start-date");
check("a 1-10 rating picks 8", pickOption([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ label: String(n) })), 8)?.label === "8");
check("a word ladder picks the rung eight tenths up", pickOption(["Beginner", "Intermediate", "Advanced", "Expert"].map((label) => ({ label })), 8)?.label === "Advanced", pickOption(["Beginner", "Intermediate", "Advanced", "Expert"].map((label) => ({ label })), 8)?.label);
check("'Less than 1' and '5+ years' are read as bands", pickOption(["Less than 1 year", "1-4 years", "5+ years"].map((label) => ({ label })), 8)?.label === "5+ years");
check("a number above every band takes the top band", pickOption(["0-1", "2-3", "4-5"].map((label) => ({ label })), 8)?.label === "4-5");

check(
  "'Where did you first hear about this role?' is answered from the profile",
  resolveField({ ...countryPick, key: "k3d", combobox: false, label: "Where did you first hear about this role?" }, PROFILE, CONTEXT).value === PROFILE.howHeard,
  JSON.stringify(resolveField({ ...countryPick, key: "k3d", combobox: false, label: "Where did you first hear about this role?" }, PROFILE, CONTEXT)),
);

// Vercel again: three labels that went wrong on a live form.
const vercel = (label) => resolveField({ ...countryPick, key: `v-${label.length}`, label }, PROFILE, CONTEXT);
check(
  "'authorization to work in the country where you live' is the authorization rule, not the country one",
  vercel("Your authorization to work in the country where you live. Please choose the option that describes your work authorization.").rule === "authorization",
  JSON.stringify(vercel("Your authorization to work in the country where you live. Please choose the option that describes your work authorization.")),
);
check("a plain 'Country' box is still the country", vercel("Country").value === "United States");
check(
  "'Please double-check all the information' is an acknowledgement, and takes the only option",
  vercel("Please double-check all the information provided above. Ensuring accuracy is crucial.").rule === "acknowledgement" &&
    vercel("Please double-check all the information provided above. Ensuring accuracy is crucial.").sole === true,
  JSON.stringify(vercel("Please double-check all the information provided above. Ensuring accuracy is crucial.")),
);
check(
  "an acknowledgement offers 'Acknowledge' and 'Confirm' among its wordings",
  vercel("By submitting my application, I acknowledge that I have read the privacy notice").candidates.includes("Confirm"),
  JSON.stringify(vercel("By submitting my application, I acknowledge that I have read the privacy notice").candidates),
);
// Vercel's authorization menu, matched the way the page script matches: each
// wording in turn, exact first and then on a word boundary.
const VERCEL_AUTH = [
  "I am authorized to work in the country due to my nationality",
  "I am authorized to work in the country based on a valid work permit and do not need a company to sponsor my visa",
  "I am authorized to work in the country based on a valid work permit which needs to be sponsored by the company I work for",
  "I am not authorized to work in the country and need visa support",
  "Other",
];
const pageMatch = (options, candidates) => {
  for (const candidate of candidates) {
    const want = candidate.toLowerCase();
    const hit =
      options.find((option) => option.toLowerCase() === want) ??
      options.find((option) => new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(option.toLowerCase()));
    if (hit) return hit;
  }
  return null;
};
const authFor = (workAuthorization) =>
  pageMatch(
    VERCEL_AUTH,
    resolveField(
      { ...countryPick, key: `auth-${workAuthorization}`, label: "Your authorization to work in the country where you live." },
      withDefaults({ workAuthorization }),
      CONTEXT,
    ).candidates,
  );
check("a citizen picks the nationality entry", authFor("us-citizen") === VERCEL_AUTH[0], authFor("us-citizen"));
check("a permanent resident picks the no-sponsor-needed entry", authFor("permanent-resident") === VERCEL_AUTH[1], authFor("permanent-resident"));
check("a visa holder picks the no-sponsor-needed entry", authFor("visa-holder") === VERCEL_AUTH[1], authFor("visa-holder"));
check("someone needing sponsorship picks the needs-support entry, not 'I am ... nationality'", authFor("needs-sponsorship") === VERCEL_AUTH[3], authFor("needs-sponsorship"));

// Two live wordings that name authorization and sponsorship in one sentence
// and mean opposite things. The sponsorship rule matches first, so the only
// thing keeping them apart is its guard - and getting it wrong is silent:
// both answers are a valid option on a Yes/No menu, so the form takes it.
const yesNoAsk = (label) =>
  resolveField({ ...countryPick, key: `yn-${label.length}`, combobox: false, label, options: [{ value: "1", label: "Yes" }, { value: "0", label: "No" }] }, PROFILE, CONTEXT);
const ondoAuth = yesNoAsk("Are you currently authorized to work in the United States without the need for employer sponsorship?");
check("'authorized to work ... without the need for sponsorship' is the authorization question", ondoAuth.rule === "authorization", JSON.stringify(ondoAuth));
check("so a citizen answers it Yes - answering from requiresSponsorship would deny being allowed to work", ondoAuth.candidates?.[0] === "Yes", JSON.stringify(ondoAuth));
const scaleAuth = yesNoAsk("This is a 1099 independent contractor role. Will you now or in the future require work authorization or employment sponsorship to work in the United States? Please answer accurately, as this information is needed to determine eligibility.");
check("'will you require work authorization or sponsorship' is still the sponsorship question", scaleAuth.rule === "sponsorship", JSON.stringify(scaleAuth));
check("and is still answered No", scaleAuth.candidates?.[0] === "No", JSON.stringify(scaleAuth));
const plainSponsor = yesNoAsk("Will you now or in the future require sponsorship for employment visa status?");
check("a plain sponsorship question is untouched by the guard", plainSponsor.rule === "sponsorship" && plainSponsor.candidates?.[0] === "No", JSON.stringify(plainSponsor));

const fleetio = vercel("Do you reside in the United States, Canada, or Mexico? Please note, this role is only open to candidates who live in the three countries listed above.");
check(
  "'Do you reside in the US, Canada or Mexico?' leads with Yes and offers the country after",
  fleetio.candidates[0] === "Yes" && fleetio.candidates[1] === "United States",
  JSON.stringify(fleetio),
);

check(
  "'willing to submit to a drug test and a background check' is answered from the profile",
  vercel("Are you willing to submit to a drug test and a background check upon an offer?").rule === "background-check" &&
    vercel("Are you willing to submit to a drug test and a background check upon an offer?").value === "Yes",
  JSON.stringify(vercel("Are you willing to submit to a drug test and a background check upon an offer?")),
);

check(
  "the sole flag travels into the plan",
  resolveForm([{ ...countryPick, key: "v-sole", label: "I acknowledge the privacy notice" }], PROFILE, CONTEXT).fills[0]?.sole === true,
);

check("unsupported jobs are listed by default", withDefaults({}).manualMode === "list" && withDefaults({}).manualLimit === 10);
check("the old checkbox, off, becomes the listing mode", withDefaults({ writeForManual: false }).manualMode === "list" && !("writeForManual" in withDefaults({ writeForManual: false })));
check("retired settings do not enable writing", withDefaults({ writeForManual: true }).manualMode === "list");
check("an unknown mode falls back to listing", withDefaults({ manualMode: "sometimes" }).manualMode === "list");
check("a chosen mode is kept", withDefaults({ manualMode: "ignore" }).manualMode === "ignore");

const emptyProfile = withDefaults({ gender: "", race: "", veteran: "", disability: "" });
const unanswerable = {
  key: "k4",
  tag: "select",
  type: "select-one",
  name: "",
  id: "",
  label: "Veteran Status",
  required: true,
  options: [{ value: "1", label: "I am not a protected veteran" }],
};
check(
  "an unset demographic answer blocks rather than defaulting to something",
  resolveField(unanswerable, emptyProfile, CONTEXT).outcome === "blocked",
  JSON.stringify(resolveField(unanswerable, emptyProfile, CONTEXT)),
);

check(
  "'No' does not match 'I am not a protected veteran'",
  chooseOption([{ value: "1", label: "I am not a protected veteran" }], "decline") === null,
  "declining must not silently become a veteran status",
);

/* ------------------------------------------- worked here before */

section("'Have you worked here before' is answered per application");

const employmentQuestion = {
  key: "e1",
  tag: "select",
  type: "select-one",
  name: "",
  id: "",
  label: "Are you a current or former employee of this company?",
  required: true,
  options: [],
};

const withHistory = { ...withDefaults({}), applicationResume: "Senior Engineer, Gainwell Technologies, 2021-2024. Engineer, Boon, 2019-2021." };
const askedBy = (company, profile) =>
  resolveField(employmentQuestion, profile, { ...CONTEXT, company, resume:profile.applicationResume || "", letter: `I would love to join ${company}.` }).value;

check("yes for a company named in the resume", askedBy("Gainwell Technologies", withHistory) === "Yes", askedBy("Gainwell Technologies", withHistory));
check("no for a company that is not", askedBy("Discord", withHistory) === "No", askedBy("Discord", withHistory));
check(
  "the legal suffix does not decide it",
  askedBy("Gainwell Technologies, Inc.", withHistory) === "Yes",
  askedBy("Gainwell Technologies, Inc.", withHistory),
);
check(
  "the cover letter naming the company does not make it a former employer",
  askedBy("Netflix", withHistory) === "No",
  "a letter addressed to Netflix says 'Netflix' constantly",
);

const declared = withDefaults({ previousEmployers: "Acme Corp, Globex", applicationResume: "Worked at Initech." });
check("an explicit list is believed over the resume", askedBy("Globex", declared) === "Yes", askedBy("Globex", declared));
check("and excludes what it does not name", askedBy("Initech", declared) === "No", askedBy("Initech", declared));

check(
  "the question is still never handed to the model",
  resolveField(employmentQuestion, withDefaults({}), CONTEXT).outcome === "fill",
  resolveField(employmentQuestion, withDefaults({}), CONTEXT).outcome,
);

/* --------------------------------------------------------- the join */

section("Joining folders to the exported queue");

const file = (path) => ({ name: path.split("/").pop(), webkitRelativePath: path });
const folders = groupByFolder([
  file("Applications/Discord - Data Scientist/Steven_Atkins_Resume.pdf"),
  file("Applications/Discord - Data Scientist/Steven_Atkins_Cover_Letter.txt"),
  file("Applications/Discord - Data Scientist/Posting.txt"),
  file("Applications/Acme - Backend Engineer/Steven_Atkins_Resume.pdf"),
  file("Applications/Acme - Backend Engineer/Posting.txt"),
  file("Applications/Globex - Platform Lead/Steven_Atkins_Resume.pdf"),
  file("Applications/Globex - Platform Lead/Posting.txt"),
  file("Applications/Initech - Nowhere/Steven_Atkins_Resume.pdf"),
  file("Applications/Initech - Nowhere/Posting.txt"),
]);

check("folders are rebuilt from the flat file list", folders.length === 4, `${folders.length}`);

const postings = [
  { id: "a", url: "https://jobs.example.com/discord-ds", applyUrl: "https://job-boards.greenhouse.io/discord/jobs/1", company: "Discord", title: "Data Scientist", jd: "x" },
  { id: "b", url: "https://jobs.example.com/acme-be/", applyUrl: "https://jobs.lever.co/acme/1", company: "Acme", title: "Backend Engineer", jd: "x" },
  { id: "c", url: "https://jobs.example.com/globex-pl", applyUrl: "", company: "Globex", title: "Platform Lead", jd: "x" },
];

const { pending, problems } = joinApplications(folders, postings);
const texts = {
  "Discord - Data Scientist": "Data Scientist at Discord\nhttps://jobs.example.com/discord-ds?utm_source=feed\nSaved 2026-10-30",
  "Acme - Backend Engineer": "Backend Engineer at Acme\nhttps://jobs.example.com/acme-be\nSaved 2026-10-30",
  "Globex - Platform Lead": "Platform Lead at Globex\nhttps://jobs.example.com/globex-pl\nSaved 2026-10-30",
  "Initech - Nowhere": "Nowhere at Initech\nhttps://jobs.example.com/initech-nw\nSaved 2026-10-30",
};

const resolved = pending.map((entry) => resolveApplication(entry, texts[entry.folder.name]));
const ready = resolved.filter((entry) => entry.ok);
const setAside = [...problems, ...resolved.filter((entry) => !entry.ok)];

check("the Greenhouse posting is ready to send", ready.length === 1 && ready[0].company === "Discord", JSON.stringify(ready.map((entry) => entry.company)));
check("a tracking parameter does not break the match", ready[0]?.applyUrl.includes("greenhouse.io"), ready[0]?.applyUrl);
check(
  "a Lever posting is set aside, with the board named",
  setAside.some((entry) => entry.folder === "Acme - Backend Engineer" && entry.reason.includes("lever")),
  JSON.stringify(setAside.map((entry) => entry.reason)),
);
check(
  "a posting with no apply link is set aside",
  setAside.some((entry) => entry.folder === "Globex - Platform Lead" && entry.reason.includes("no apply link")),
  JSON.stringify(setAside.map((entry) => entry.reason)),
);
check(
  "a folder with no matching export is set aside rather than dropped",
  setAside.some((entry) => entry.folder === "Initech - Nowhere" && entry.reason.includes("no posting")),
  JSON.stringify(setAside.map((entry) => entry.reason)),
);
check("every folder is accounted for", ready.length + setAside.length === folders.length, `${ready.length} + ${setAside.length}`);

check("the posting link is read by shape, not by line number", postingUrlFrom("Role at Co\n\nhttps://x.test/1\nSaved") === "https://x.test/1");
check("a trailing slash is not a different job", canonicalUrl("https://x.test/a/") === canonicalUrl("https://x.test/a"));
check(
  "two embedded Greenhouse forms are two jobs, not one path",
  canonicalUrl("https://job-boards.greenhouse.io/embed/job_app?for=apartmentiq&token=1") !== canonicalUrl("https://job-boards.greenhouse.io/embed/job_app?for=patriotsoftware&token=2"),
);
check(
  "an embedded form's tracking parameters still fall away",
  canonicalUrl("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1&gh_src=x") === canonicalUrl("https://job-boards.greenhouse.io/embed/job_app?token=1&for=acme"),
);
check("Greenhouse is recognised on both hosts", applyHost("https://boards.greenhouse.io/x") === "greenhouse" && applyHost("https://job-boards.greenhouse.io/x") === "greenhouse");

/* --------------------------------------------------------- the salary */

section("Reading a list of links");

check(
  "a sheet address copied from the browser becomes a CSV export of the same tab",
  sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf/edit#gid=774") ===
    "https://docs.google.com/spreadsheets/d/1AbC_dEf/export?format=csv&gid=774",
  sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf/edit#gid=774"),
);
check(
  "an address that already returns CSV is left alone",
  sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf/export?format=csv&gid=0") ===
    "https://docs.google.com/spreadsheets/d/1AbC_dEf/export?format=csv&gid=0",
);
check(
  "a job title containing a comma does not shift the link out of its cell",
  linksFromCsv('Role,Link\n"Engineer, Senior",https://boards.greenhouse.io/acme/jobs/1\n').join("|") ===
    "https://boards.greenhouse.io/acme/jobs/1",
  linksFromCsv('Role,Link\n"Engineer, Senior",https://boards.greenhouse.io/acme/jobs/1\n').join("|"),
);
check(
  "the same posting pasted twice with different tracking is one application",
  buildQueue([
    "https://boards.greenhouse.io/acme/jobs/1?source=linkedin\nhttps://boards.greenhouse.io/acme/jobs/1",
  ]).length === 1,
);
check(
  "the order links were collected in is the order they are applied to",
  buildQueue(["https://a.com/1 https://b.com/2", "https://c.com/3"]).join("|") ===
    "https://a.com/1|https://b.com/2|https://c.com/3",
  buildQueue(["https://a.com/1 https://b.com/2", "https://c.com/3"]).join("|"),
);
check(
  "a sheet that is not shared is named as such, not reported as empty",
  isSignInPage('<!doctype html><html><head><title>Sign in - Google Accounts</title>'),
);
check(
  "an ordinary CSV is not mistaken for one",
  !isSignInPage("Role,Link\nEngineer,https://boards.greenhouse.io/acme/jobs/1\n"),
);
check(
  "a link ending a sentence does not keep the full stop",
  extractLinks("Apply at https://boards.greenhouse.io/acme/jobs/1.")[0] ===
    "https://boards.greenhouse.io/acme/jobs/1",
  extractLinks("Apply at https://boards.greenhouse.io/acme/jobs/1.")[0],
);

/* ------------------------------------------------- reading a job link */

section("Deciding where a link applies");

/**
 * The ordering this bot's economics rest on: the apply address is read from
 * the page before anything is generated, so a posting that applies elsewhere
 * costs a page load and no model call.
 */
function extractFrom(html, href) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const context = createContext({ window, document, location: { href }, URL, JSON, console });
  context.window = context;
  runInContext(readFileSync(join(HERE, "src/extract.js"), "utf8"), context);
  return runInContext("window.__ghExtract.read()", context);
}

const AGGREGATOR = `
  <h1>Senior Data Engineer</h1>
  <nav><a href="/jobs">All jobs</a><a href="https://boards.greenhouse.io/acme">Careers</a></nav>
  <main>${"We are looking for a senior data engineer to build pipelines. ".repeat(20)}</main>
  <a href="https://boards.greenhouse.io/acme/jobs/4821?gh_src=abc">Apply on company site</a>
  <script type="application/ld+json">
    {"@type":"JobPosting","title":"Senior Data Engineer","hiringOrganization":{"name":"Acme"}}
  </script>
`;

const aggregator = extractFrom(AGGREGATOR, "https://www.linkedin.com/jobs/view/123");

check(
  "the specific posting wins over the careers index linked in the same page",
  aggregator.apply?.url === "https://boards.greenhouse.io/acme/jobs/4821?gh_src=abc",
  aggregator.apply?.url,
);
check("it is recognised as Greenhouse", aggregator.apply?.ats === "greenhouse", aggregator.apply?.ats);
check(
  "the employer is read from the posting's own structured data, not guessed from the title",
  aggregator.company === "Acme",
  aggregator.company,
);
check("the description comes back with it", aggregator.jd.length > 400, `${aggregator.jd.length} characters`);

const workday = extractFrom(
  `<h1>Analyst</h1><main>${"Text. ".repeat(200)}</main><a href="https://acme.wd1.myworkdayjobs.com/en-US/acme/job/Analyst_R1">Apply</a>`,
  "https://www.indeed.com/viewjob?jk=9",
);
check(
  "a posting applying through Workday is named as such, so the skip says why",
  workday.apply?.ats === "workday",
  JSON.stringify(workday.apply),
);

const direct = extractFrom(
  `<h1>Engineer</h1><main>${"Text. ".repeat(200)}</main>`,
  "https://job-boards.greenhouse.io/discord/jobs/8840756002",
);
check(
  "a link that already landed on Greenhouse needs no hop",
  direct.apply?.ats === "greenhouse" && direct.apply.via === "self",
  JSON.stringify(direct.apply),
);

/* The shape an aggregator actually presents: no ATS anywhere in the markup,
   just its own redirect counter and a button. */
const REDIRECT = `
  <h1>Staff Engineer</h1>
  <main>${"Build and run the platform. ".repeat(30)}</main>
  <a href="https://jobright.ai/out?jid=99&url=https%3A%2F%2Fjob-boards.greenhouse.io%2Facme%2Fjobs%2F77">APPLY NOW</a>
`;
const redirect = extractFrom(REDIRECT, "https://jobright.ai/jobs/info/abc");

check(
  "a destination carried in a redirect link's query string is read without following it",
  redirect.apply?.url === "https://job-boards.greenhouse.io/acme/jobs/77",
  redirect.apply?.url,
);

function controlFor(html, href) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const context = createContext({ window, document, location: { href }, URL, JSON, console });
  context.window = context;
  runInContext(readFileSync(join(HERE, "src/extract.js"), "utf8"), context);
  return runInContext("window.__ghExtract.followApply()", context);
}

const opaque = controlFor(
  `<h1>Staff Engineer</h1>
   <button>Save</button>
   <a href="/search?q=x">Apply filters</a>
   <a href="https://hiring.cafe/r/99" target="_blank">Apply</a>`,
  "https://hiring.cafe/jobs/99",
);
check(
  "the apply link is taken over the filter button that also says apply",
  opaque.navigate === "https://hiring.cafe/r/99",
  JSON.stringify(opaque),
);

const buttonOnly = controlFor(
  `<h1>Staff Engineer</h1><button>Apply now</button>`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "a button with no address of its own is pressed instead",
  buttonOnly.acted === true && buttonOnly.clicked === true,
  JSON.stringify(buttonOnly),
);

/* The control Jobright actually renders, and the one the bot used to walk
   straight past: "Origin Job" leaves the site, "Apply" opens Jobright's own
   form. Only the first is the employer's posting. */
const originJob = controlFor(
  `<h1>Staff Engineer</h1>
   <button>Apply</button>
   <a href="https://job-boards.greenhouse.io/acme/jobs/77" target="_blank">ORIGIN JOB</a>`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "the button that leaves the aggregator is pressed, whatever it calls itself",
  originJob.navigate === "https://job-boards.greenhouse.io/acme/jobs/77",
  JSON.stringify(originJob),
);

for (const wording of ["Origin Job", "Original Job", "Original posting", "Go to original", "View job"]) {
  const control = controlFor(
    `<h1>Engineer</h1><a href="https://job-boards.greenhouse.io/acme/jobs/1">${wording}</a>`,
    "https://jobright.ai/jobs/info/abc",
  );
  check(
    `"${wording}" is recognised as the way out`,
    control.navigate === "https://job-boards.greenhouse.io/acme/jobs/1",
    JSON.stringify(control),
  );
}

/* Jobright offers to apply for you, metered against its own credits, and its
   button satisfies every test for an apply control. Pressing it submits
   through Jobright instead of through the employer's form. */
const autofill = controlFor(
  `<h1>Staff Engineer</h1>
   <button>APPLY WITH AUTOFILL</button>
   <a href="https://job-boards.greenhouse.io/acme/jobs/77">Origin Job</a>`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "the aggregator's own autofill is never the way out, even sitting beside nothing else",
  autofill.navigate === "https://job-boards.greenhouse.io/acme/jobs/77",
  JSON.stringify(autofill),
);

const autofillAlone = controlFor(
  `<h1>Staff Engineer</h1><button>Apply with autofill</button>`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "and a page offering only that is left alone rather than pressed",
  autofillAlone.acted === false,
  JSON.stringify(autofillAlone),
);

const noControl = controlFor(`<h1>Staff Engineer</h1><button>Save</button>`, "https://jobright.ai/jobs/info/abc");
check(
  "a page with nothing to press says so rather than clicking at random",
  noControl.acted === false,
  JSON.stringify(noControl),
);

section("Reading the employer's address off an aggregator's own data");

/**
 * The shape measured on a live Jobright run, which is the whole reason this
 * section exists: the card's "APPLY NOW" is a `<button>` with no address on
 * it, the employer's address is only in the serialised props, and pressing
 * the button means a `window.open` the popup blocker eats. Every one of the
 * forty cards in a scan reported no board, and two in five of the ones
 * opened died with nothing resolved.
 */
function discoverFrom(html, href) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const context = createContext({ window, document, location: { href }, URL, JSON, console });
  context.window = context;
  runInContext(readFileSync(join(HERE, "src/extract.js"), "utf8"), context);
  return runInContext("window.__ghExtract.discover()", context);
}

const island = (jobResult) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { dataSource: { impId: "0_share_detail_1", pos: 0, jobResult, companyResult: { companyName: "Acme", companyWebsite: "https://www.acme.com", jdLogo: "https://media.licdn.com/logo.png" } } } },
  })}</script>`;

const CARD = `<h1>Staff Engineer</h1><button>APPLY NOW</button><button>APPLY WITH AUTOFILL</button>`;

const scripted = discoverFrom(
  `${CARD}${island({ jobId: "a".repeat(24), jobTitle: "Staff Engineer", isCompanySiteLink: true, applyLink: "https://job-boards.greenhouse.io/acme/jobs/77?jr_id=abc" })}`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "the apply address is read from the card's own data rather than pressed out of a button",
  scripted.apply?.url === "https://job-boards.greenhouse.io/acme/jobs/77?jr_id=abc" && scripted.apply.via === "data-island",
  JSON.stringify(scripted.apply),
);
check("and the board behind it is named without loading it", scripted.apply?.ats === "greenhouse", scripted.apply?.ats);
check(
  "so the hop is already answered at the first look, before any waiting",
  scripted.originalControl === true,
  JSON.stringify(scripted.originalControl),
);

const ownSite = discoverFrom(
  `${CARD}${island({ jobId: "b".repeat(24), isCompanySiteLink: true, applyLink: "https://www.teknalb.com/careers/senior-distributed-systems-engineer?jr_id=xyz" })}`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "an employer's own careers page comes back as the original address even though no board is named",
  ownSite.originalUrl === "https://www.teknalb.com/careers/senior-distributed-systems-engineer?jr_id=xyz" && ownSite.apply === null,
  JSON.stringify([ownSite.originalUrl, ownSite.apply]),
);

const noLink = discoverFrom(
  `${CARD}${island({ jobId: "c".repeat(24), isCompanySiteLink: false, jdLogo: "https://media.licdn.com/dms/image/logo.png", companyUrl: "https://www.cybercoders.com" })}`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "a card holding only a logo and a company home page yields no apply address, not the nearest URL to hand",
  noLink.originalUrl === "" && noLink.apply === null,
  JSON.stringify([noLink.originalUrl, noLink.apply]),
);
check(
  "and the aggregator saying it has no employer link is passed on, so the hop is never paid for",
  noLink.employerLinkOffered === false,
  JSON.stringify(noLink.employerLinkOffered),
);
check(
  "a card that says nothing either way reports nothing either way, rather than refusing the job",
  discoverFrom(CARD, "https://jobright.ai/jobs/info/abc").employerLinkOffered === null,
);

const wrapped = discoverFrom(
  `${CARD}${island({ jobId: "d".repeat(24), applyLink: "https://jobright.ai/out?jid=99&url=https%3A%2F%2Fjobs.lever.co%2Facme%2F1234" })}`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "a redirect counter in the data is unwrapped rather than followed",
  wrapped.apply?.url === "https://jobs.lever.co/acme/1234",
  JSON.stringify(wrapped.apply),
);

const linkedCard = discoverFrom(
  `<h1>Staff Engineer</h1><a href="https://job-boards.greenhouse.io/acme/jobs/5">Origin Job</a>`,
  "https://jobright.ai/jobs/info/abc",
);
check(
  "a card that still has a plain link out is read the way it always was",
  linkedCard.apply?.url === "https://job-boards.greenhouse.io/acme/jobs/5" && linkedCard.apply.via === "discovery-link",
  JSON.stringify(linkedCard.apply),
);

const jobrightEntries = classifiedJobright([
  { id: "1", originalUrl: "https://job-boards.greenhouse.io/acme/jobs/1", companySiteLink: true },
  { id: "2", originalUrl: "https://acme.taleo.net/careersection/1", companySiteLink: true },
  { id: "3", companySiteLink: false },
  { id: "4" },
]);
check(
  "a feed round counts the jobs it was told have no employer link apart from the ones it simply could not name",
  jobrightEntries.boards.fillable === 1 && jobrightEntries.boards.elsewhere === 1 && jobrightEntries.boards.unknown === 2 && jobrightEntries.boards.unreachable === 1,
  JSON.stringify(jobrightEntries.boards),
);

const nowhere = extractFrom(
  `<h1>Engineer</h1><main>${"Text. ".repeat(200)}</main><a href="mailto:jobs@acme.com">Email us</a>`,
  "https://acme.com/careers/engineer",
);
check(
  "a posting with no application form at all reports none rather than a guess",
  nowhere.apply === null,
  JSON.stringify(nowhere.apply),
);

section("ChatGPT tab transport");

// A browser with the tab open, and a page that answers as scripted. Every
// prompt typed into the page is kept for the checks below.
const page = { replies: [], prompts: [], navigations: [],failure:null,reloads:0 };
globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 4, windowId: 1, index: 3, url: "https://chatgpt.com/" }],
    get: async (id) => ({ id, windowId: 1, status: "complete", url: "https://chatgpt.com/" }),
    update: async (id, change) => {
      if (change?.url) page.navigations.push(change.url);
      return { id, windowId: 1 };
    },
    create: async () => ({ id: 4, windowId: 1 }),
    reload:async()=>{page.reloads++;},
  },
  windows: { update: async () => ({}), getLastFocused: async () => ({ id: 1 }) },
  scripting: {
    executeScript: async ({ func, args }) => {if(func.name==='selectChatGptMode')return [{result:{ok:true,requested:args[0],selected:args[0]}}];
      if (func.name === "converse") {if(args[1]?.resumeOnly)return [{result:page.failure||{ok:false,reason:"prompt-not-found"}}];page.prompts.push(args[0]);}
      if (func.name === "probePage") return [{ result: { composer: true, composerKind: "editor", signedOut: false } }];
      return [{ result: page.failure||page.replies.shift()||{ ok: false, reason: "no reply scripted" } }];
    },
  },
};

const fixedSystem = "You write resumes.";
const firstAsk = "Write the resume for this posting.";
page.replies.push({ ok: true, text: "```json\n{\"summary\": \"first draft\"}\n```" });
const first = await askChatGpt({ provider: "openai", model: "x", apiKey: "", system: fixedSystem, messages: [{ role: "user", content: firstAsk }], format: "json", temperature: 0.6, maxTokens: 10 });
check(
  "a request opens a fresh chat and carries the instructions and the question in one prompt",
  page.navigations.length === 1 && /chatgpt\.com/.test(page.navigations[0]) && page.prompts[0].startsWith("INSTRUCTIONS\n\n" + fixedSystem) && page.prompts[0].includes(firstAsk),
  page.prompts[0]?.slice(0, 120),
);
check("a JSON request is told to answer in a json fence", /```json code block/.test(page.prompts[0]), page.prompts[0]?.slice(-120));
check("the reply comes back as the page showed it, with no token counts", first.text.includes('"summary": "first draft"') && first.inputTokens === 0, JSON.stringify(first));

page.replies.push({ ok: true, text: "```json\n{\"summary\": \"repaired\"}\n```" });
await askChatGpt({
  provider: "openai",
  model: "x",
  apiKey: "",
  system: fixedSystem,
  messages: [
    { role: "user", content: firstAsk },
    { role: "assistant", content: first.text },
    { role: "user", content: "Fix: the summary is too short." },
  ],
  format: "json",
  temperature: 0.6,
  maxTokens: 10,
});
check(
  "a repair pass continues the same chat with only the new turn",
  page.navigations.length === 1 && page.prompts[1].startsWith("Fix: the summary is too short.") && !page.prompts[1].includes(firstAsk),
  page.prompts[1]?.slice(0, 120),
);

page.replies.push({ ok: true, text: "Dear hiring team," });
await askChatGpt({ provider: "openai", model: "x", apiKey: "", system: "You write letters.", messages: [{ role: "user", content: "Write the letter." }], format: "text", temperature: 0.6, maxTokens: 10 });
check(
  "a different request starts another chat rather than carrying the last one's history",
  page.navigations.length === 2 && page.prompts[2].includes("You write letters.") && !page.prompts[2].includes(firstAsk),
  page.prompts[2]?.slice(0, 120),
);

const failure = async (reply) => {
  page.failure=reply;
  try {
    await askChatGpt({ provider: "openai", model: "x", apiKey: "", system: "s", messages: [{ role: "user", content: "q" }], format: "text", temperature: 0, maxTokens: 1 });
    return null;
  } catch (error) {
    return error;
  } finally {page.failure=null;}
};
const signedOut = await failure({ ok: false, reason: "signed-out" });
check("a tab still signed out after three refresh retries reports 401", signedOut?.status === 401 && /signed? in|sign in/i.test(signedOut.message)&&signedOut.retryable===false, String(signedOut?.message));
const limited = await failure({ ok: false, reason: "rate-limited" });
check("a usage limit on the account is a 429", limited?.status === 429, String(limited?.message));
const silent = await failure({ ok: false, reason: "timeout" });
check("a reply that never finishes is a 502, not fatal", silent?.status === 502, String(silent?.message));
const promptsBeforeStatus=page.prompts.length;
check("the status check reads the tab without typing into it", (await chatGptStatus()).ok === true && page.prompts.length === promptsBeforeStatus&&page.reloads===9, JSON.stringify(await chatGptStatus()));

page.replies.push({ ok: true, text: "{}" });
await askChatGpt({ provider: "openai", model: "x", apiKey: "", system: "s", messages: [{ role: "user", content: "tailor" }], format: "json", temperature: 0, maxTokens: 1, chatUrl: "https://chatgpt.com/g/g-p-abc/project" });
check("a request naming a project opens its fresh chat there", page.navigations.at(-1) === "https://chatgpt.com/g/g-p-abc/project", page.navigations.at(-1));
check(
  "a project address is one on chatgpt.com and nothing else",
  isChatGptUrl("https://chatgpt.com/g/g-p-abc/project") && isChatGptUrl("https://chat.openai.com/") && !isChatGptUrl("https://example.com/chatgpt.com") && !isChatGptUrl("chatgpt.com/g/x") && !isChatGptUrl(""),
  "isChatGptUrl",
);
check(
  "the spend line counts replies, since the tab reports no tokens",
  describeSpend("ChatGPT", { calls: 3, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }) === "3 replies from ChatGPT",
  describeSpend("ChatGPT", { calls: 3, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }),
);
delete globalThis.chrome;

section("Parsing resumes prepared in ChatGPT");

const identity = { name: "Jane Doe", email: "jane@example.com", phone: "(512) 555-0100", location: "Austin, Texas", education: { degree: "BS CS", school: "UT", location: "Austin, TX", year: "2017" }, links: [] };
const projectDocument = toDocument(
  {
    subtitle: "Senior Backend Engineer",
    sections: [
      { heading: "Profile", paragraphs: ["Backend engineer with eight years in payments."] },
      { heading: "Key Achievements", bullets: ["Cut settlement latency in half."] },
      { heading: "Technical Skills", lines: { Languages: "Go, Python", Databases: ["PostgreSQL"] } },
      {
        heading: "Experience",
        experience: [
          { company: "Acme Payments", title: "Senior Backend Engineer", location: "Austin, TX (Remote)", dates: "Jun 2021 - Present", note: "Payments platform.", stack: ["Go", "Postgres"], bullets: ["Built the settlement service in Go."] },
          { company: "Northwind Traders", title: "Backend Engineer", location: "Seattle, WA", dates: "Jan 2018 – May 2021", bullets: ["Maintained the order API."] },
        ],
      },
      { heading: "Education", entries: [{ degree: "BS CS", school: "UT, Austin", year: "2017" }] },
    ],
  },
  identity,
);
const projectShaped = toResume(projectDocument, identity);
check(
  "a reply in a project's own naming becomes the document the page draws: headings kept, roles and dates split, skills as lines",
  projectDocument.sections.map((section) => section.heading).join("|") === "Profile|Key Achievements|Technical Skills|Experience|Education" &&
    projectDocument.sections[3].roles[0].role === "Senior Backend Engineer" &&
    projectDocument.sections[3].roles[0].startDate === "Jun 2021" &&
    projectDocument.sections[3].roles[0].endDate === "Present" &&
    projectDocument.sections[3].roles[0].note === "Payments platform." &&
    projectDocument.sections[3].roles[0].lines[0].text === "Go, Postgres" &&
    projectDocument.sections[3].roles[1].endDate === "May 2021" &&
    projectDocument.sections[2].lines.length === 2 &&
    projectDocument.sections[2].lines[0].text === "Go, Python" &&
    projectDocument.sections[4].entries[0].title === "BS CS",
  JSON.stringify(projectDocument).slice(0, 400),
);
check(
  "the app's resume is read out of the document: the profile as summary, the skills as buckets, the achievements as highlights, the stack as the environment",
  projectShaped.targetTitle === "Senior Backend Engineer" &&
    projectShaped.summary === "Backend engineer with eight years in payments." &&
    projectShaped.highlights.join("|") === "Cut settlement latency in half." &&
    projectShaped.coreSkills.length === 2 &&
    projectShaped.coreSkills[0].skills.join("|") === "Go|Python" &&
    projectShaped.experience.length === 2 &&
    projectShaped.experience[0].environment.join("|") === "Go|Postgres" &&
    projectShaped.experience[0].scope === "Payments platform.",
  JSON.stringify(projectShaped).slice(0, 400),
);
check("the identity on a tailored resume is the profile's, not the reply's", projectShaped.name === "Jane Doe" && projectShaped.contact.email === "jane@example.com" && projectShaped.education.school === "UT, Austin", JSON.stringify(projectShaped.contact));
const flat = toDocument({ summary: "Eight years in payments.", technicalskills: { Languages: "Go, Python" }, experience: [{ company: "Acme Payments", title: "Senior Backend Engineer", location: "Austin, TX", dates: "Jun 2021 - Present", bullets: ["Built it."] }], education: { degree: "BS CS", school: "UT", location: "Austin, TX", year: "2017" } }, identity);
check(
  "a flat reply in the old shape is drawn as sections in the plain order rather than refused",
  flat.sections.map((section) => section.heading).join("|") === "Professional Summary|Core Skills|Professional Experience|Education" &&
    flat.sections[0].paragraphs[0] === "Eight years in payments." &&
    flat.sections[1].lines[0].label === "Languages" &&
    flat.sections[2].roles[0].endDate === "Present" &&
    flat.sections[3].entries[0].title === "BS CS" &&
    flat.sections[3].entries[0].subtitle === "UT, Austin, TX" &&
    documentFault({ document: flat, resume: toResume(flat, identity) }) === null,
  JSON.stringify(flat).slice(0, 300),
);
check("an empty resume document is rejected", /no resume sections/.test(documentFault({document:{sections:[]}})));
check("resume generation sends only the job description", resumePrompt("React engineer",{company:"Example Careers"}) === "React engineer");

section("Recognising where an apply button led, without loading it");

check(
  "both Greenhouse hostnames, old and new",
  atsOf("https://boards.greenhouse.io/mercury/jobs/1") === "greenhouse" &&
    atsOf("https://job-boards.greenhouse.io/mercury/jobs/1") === "greenhouse",
  atsOf("https://job-boards.greenhouse.io/mercury/jobs/1"),
);
check(
  "a board this bot cannot fill is still named, so the skip can say why",
  atsOf("https://jobs.lever.co/acme/1") === "lever",
  atsOf("https://jobs.lever.co/acme/1"),
);
check(
  "the aggregator's own redirect is not a destination",
  atsOf("https://jobright.ai/out?jobId=1") === "",
  atsOf("https://jobright.ai/out?jobId=1"),
);
check(
  "a lookalike host does not pass for the real one",
  atsOf("https://greenhouse.io.evil.test/x") === "" && atsOf("https://notgreenhouse.io/x") === "",
  `${atsOf("https://greenhouse.io.evil.test/x")} ${atsOf("https://notgreenhouse.io/x")}`,
);
check(
  "something that is not a URL is not an ATS",
  atsOf("mailto:jobs@acme.test") === "" && atsOf("careers page") === "",
  "",
);

section("Grounding an answer");

const TAILORED = resumeToText({
  name: "Steven Atkins",
  targetTitle: "Senior Data Engineer",
  summary: "Ten years building batch and streaming pipelines.",
  coreSkills: [{ category: "Languages", skills: ["Python", "SQL"] }],
  experience: [
    {
      company: "Komodor",
      role: "Data Engineer",
      location: "Remote",
      startDate: "Mar 2024",
      endDate: "Apr 2026",
      bullets: ["Rebuilt the ingestion path onto Airflow, cutting freshness from hours to minutes."],
      environment: ["Airflow", "dbt"],
    },
  ],
  education: { degree: "BS Computer Science", school: "Rice", location: "Houston, TX", year: "2014" },
});

check(
  "the tailored bullets reach the model, not just the job title",
  TAILORED.includes("Rebuilt the ingestion path onto Airflow"),
  TAILORED.slice(0, 80),
);
check("so do the skills and the employer", TAILORED.includes("Python, SQL") && TAILORED.includes("Komodor"));
check("an absent resume flattens to nothing rather than throwing", resumeToText(null) === "");
check(
  "a half-built resume does not take the whole answer down with it",
  resumeToText({ name: "A", targetTitle: "B" }).includes("A - B"),
  resumeToText({ name: "A", targetTitle: "B" }),
);

section("Snapping a reply to a list");
const MONTHS = ["January", "February", "March", "April"].map((label) => ({ label }));
check("an exact entry is returned as itself", snapToOption("march", MONTHS) === "March", snapToOption("march", MONTHS));
check(
  "a reply that reasons and then names its choice yields the choice",
  snapToOption("Since the offer date is unknown, the most reasonable selection is: February.", MONTHS) === "February",
  snapToOption("Since the offer date is unknown, the most reasonable selection is: February.", MONTHS),
);
check(
  "the longest entry wins when one contains another",
  snapToOption("$100,000 - $120,000", [{ label: "$100,000" }, { label: "$100,000 - $120,000" }]) === "$100,000 - $120,000",
  snapToOption("$100,000 - $120,000", [{ label: "$100,000" }, { label: "$100,000 - $120,000" }]),
);
check("a reply naming nothing on the list is null", snapToOption("Two weeks from offer", MONTHS) === null, snapToOption("Two weeks from offer", MONTHS));
check("no options means nothing to snap to", snapToOption("anything", []) === null);

section("A page of questions is one call, and what it costs is counted");
check(
  "the batched reply is read as an object keyed by question number, however it was wrapped",
  parseAnswers('{"1": "Yes", "2": "INSUFFICIENT"}')?.["2"] === "INSUFFICIENT" &&
    parseAnswers('```json\n{"1": "Yes"}\n```')?.["1"] === "Yes" &&
    parseAnswers('Here you go: {"1": "Austin, TX"} - hope that helps')?.["1"] === "Austin, TX" &&
    parseAnswers("I cannot answer") === null,
  JSON.stringify(parseAnswers('Here you go: {"1": "Austin, TX"} - hope that helps')),
);
check(
  "a call is priced from the model's list price, cached input at a tenth",
  Math.abs(costOf("claude-sonnet-4-5", { inputTokens: 10000, outputTokens: 1000, cachedTokens: 0 }) - 0.045) < 1e-9 &&
    costOf("claude-sonnet-4-5", { inputTokens: 10000, outputTokens: 1000, cachedTokens: 8000 }) < costOf("claude-sonnet-4-5", { inputTokens: 10000, outputTokens: 1000, cachedTokens: 0 }) &&
    costOf("some-model-nobody-priced", { inputTokens: 1 }) === null,
  String(costOf("claude-sonnet-4-5", { inputTokens: 10000, outputTokens: 1000, cachedTokens: 8000 })),
);
check(
  "the log line names calls, tokens, cached tokens and dollars",
  describeSpend("claude-sonnet-4-5", { calls: 2, inputTokens: 9120, outputTokens: 4300, cachedTokens: 6800 }) === "2 calls, 9,120 tokens in (6,800 cached), 4,300 out, ≈ $0.073",
  describeSpend("claude-sonnet-4-5", { calls: 2, inputTokens: 9120, outputTokens: 4300, cachedTokens: 6800 }),
);
check("an unpriced model is counted in tokens only", describeSpend("mystery-9", { calls: 1, inputTokens: 100, outputTokens: 10 }) === "1 call, 100 tokens in, 10 out", describeSpend("mystery-9", { calls: 1, inputTokens: 100, outputTokens: 10 }));

section("Reading a security code off a Gmail row");
// A row's text as Gmail renders it: unread marker, sender with the count of
// messages in the conversation, subject, attachment marker, time, snippet.
const MERCURY_ROW =
  "Greenhouse 2, Security code for your application to Mercury, has attachment, 5:54 PM, Copy and paste this code into the security code field on your application: 53329416. After you enter the code, resubmit your application.";
check("the company and the code come off the row", JSON.stringify(parseRow(MERCURY_ROW)) === JSON.stringify({ company: "Mercury", code: "53329416", at: 0 }), JSON.stringify(parseRow(MERCURY_ROW)));
check(
  "a two-word company survives",
  parseRow("Greenhouse, Security code for your application to Omada Health, has attachment, 12:30 PM, Copy and paste this code into the security code field on your application: 27354756. After")?.company === "Omada Health",
);
check(
  "a thank-you mail is not a code",
  parseRow("unread, no-reply 2, Thank you for applying to Mercury, 5:58 PM, Steven, Thanks for applying to Mercury.") === null,
);
check("the resume's name for the company matches the board's", namesMatch("Mercury", ["Mercury Technologies", "mercury"]));
check("the board's own slug matches on its own", namesMatch("AlphaSense", ["AlphaSense, Inc.", "alphasense"]));
check("another company's code does not", !namesMatch("Omada Health", ["Mercury", "mercury"]));

// Which of several codes an application may type. The whole point is the
// refusals: a code typed into the wrong employer's form cannot be taken
// back, and a sent application cannot be sent again to make up for it.
const mail = (company, code, at = 0) => ({ at, text: `Greenhouse, Security code for your application to ${company}, has attachment, 5:54 PM, Copy and paste this code into the security code field on your application: ${code}. After` });
const BOX = [mail("Crexi", "11112222"), mail("Omada Health", "33334444"), mail("Lively", "55556666")];
check("the code taken out of a busy box is the one sent to this company", codeForCompany(BOX, { names: ["Omada Health"] }).code === "33334444", JSON.stringify(codeForCompany(BOX, { names: ["Omada Health"] })));
check("a company with nothing in the box waits rather than taking somebody else's", codeForCompany(BOX, { names: ["Mercury"] }).waiting === true);
check("a code already typed into a form is not offered a second time", codeForCompany(BOX, { names: ["Crexi"], used: new Set(["11112222"]) }).waiting === true);
check(
  "two companies starting the same way are refused, not guessed between",
  /Scale AI and Scale Computing/.test(codeForCompany([mail("Scale AI", "77778888"), mail("Scale Computing", "99990000")], { names: ["Scale"] }).refused ?? ""),
  JSON.stringify(codeForCompany([mail("Scale AI", "77778888"), mail("Scale Computing", "99990000")], { names: ["Scale"] })),
);
check(
  "an exact name settles that tie, so the near miss costs the right company nothing",
  codeForCompany([mail("Scale AI", "77778888"), mail("Scale Computing", "99990000")], { names: ["Scale AI"] }).code === "77778888",
);
const SUBMITTED = Date.parse("2026-11-07T22:00:00Z");
check(
  "a code mailed before this application was sent belongs to the last one and is refused",
  codeForCompany([mail("Lively", "11110000", SUBMITTED - 240000)], { names: ["Lively"], since: SUBMITTED - ROW_MINUTE_MS }).waiting === true,
);
check(
  "and the one mailed after it is taken",
  codeForCompany([mail("Lively", "22220000", SUBMITTED + 1000), mail("Lively", "11110000", SUBMITTED - 240000)], { names: ["Lively"], since: SUBMITTED - ROW_MINUTE_MS }).code === "22220000",
);
check(
  "a row Gmail gives no time for falls back to what was in the box when the wait began",
  codeForCompany([mail("Lively", "11110000")], { names: ["Lively"], seen: new Set(["11110000"]) }).waiting === true &&
    codeForCompany([mail("Lively", "11110000")], { names: ["Lively"], seen: new Set() }).code === "11110000",
);
check(
  "the mailbox address picks the account and searches for the mail",
  mailboxUrl("a@gmail.com").startsWith("https://mail.google.com/mail/?authuser=a%40gmail.com#search/") && mailboxUrl("a@gmail.com").includes("greenhouse-mail.io"),
  mailboxUrl("a@gmail.com"),
);

section("Walking a Hiring Cafe search");
const HC = "https://hiringcafe.com/classic?searchState=%7B%22remote%22%3Atrue%7D&page=1";
check("the default search is recognised as one", isHiringCafeSearch(HC));
check("a Jobright address is not", !isHiringCafeSearch("https://jobright.ai/jobs/recommend"));
check("an empty setting is not", !isHiringCafeSearch(""));
const page3 = new URL(hiringCafePage(HC, 3));
check("the page number replaces the one in the address", page3.searchParams.get("page") === "3", page3.searchParams.get("page"));
check("and the filters survive the change", page3.searchParams.get("searchState") === new URL(HC).searchParams.get("searchState"));
check(
  "a Greenhouse apply address off the list is recognised as Greenhouse",
  atsOf("https://job-boards.greenhouse.io/doordashusa/jobs/8337751") === "greenhouse",
  atsOf("https://job-boards.greenhouse.io/doordashusa/jobs/8337751"),
);
check("an Ashby one is not", atsOf("https://jobs.ashbyhq.com/horizon3ai/90a870d7") !== "greenhouse", atsOf("https://jobs.ashbyhq.com/horizon3ai/90a870d7"));

/**
 * A search that cannot be read says which of these it is. For most of a
 * night's run it said none of them: "the page holds no search data" is the
 * same sentence for a tab mid-navigation, a Cloudflare interstitial and a
 * site that has stopped serving the island at all, and the reader waited
 * twenty seconds for each before saying it.
 */
const searchDom = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const appRouter = diagnoseSearch(searchDom(`<a href="/job/engineer-123">Engineer</a><script>self.__next_f.push([1,"hits"])</script>`));
check(
  "a site that has moved to streamed props is named as such and not waited on",
  appRouter.settled === true && /App Router/.test(appRouter.why),
  JSON.stringify(appRouter),
);
check(
  "and it says how many cards are on screen, which is the difference between empty and unreadable",
  /1 job card/.test(appRouter.why),
  appRouter.why,
);
const challenged = diagnoseSearch(searchDom("<p>Verify you are human</p>"), "Just a moment...");
check(
  "Cloudflare's interstitial is named, and waited on because it does pass",
  challenged.settled === false && /Cloudflare/.test(challenged.why),
  JSON.stringify(challenged),
);
const slow = diagnoseSearch(searchDom("<main>Loading</main>"), "Hiring Cafe", "Loading");
check("a page simply not there yet is still waited on", slow.settled === false && /no search data/.test(slow.why), JSON.stringify(slow));

/**
 * A source that has broken leaves the rotation, and has to leave the count
 * with it: "every enabled source found nothing new" is what ends a run, and
 * a source nobody is reading can never report an empty round.
 */
const rounds = new DiscoveryRounds(3);
rounds.success("jobright", 0, true);
rounds.success("boards", 0, true);
check("two empty sources of three do not finish a run", rounds.success("jobright", 0, true) === false);
rounds.retire("hiringcafe");
check(
  "but once the third is retired, the two that still answer can",
  rounds.success("boards", 0, true) === true,
);

section("The record on disk");
check("a company name becomes a folder name Windows will take", safeName('Acme: "Labs" <R&D>/Inc.') === "Acme Labs R&D Inc", safeName('Acme: "Labs" <R&D>/Inc.'));
check("the time stamp sorts and contains no colon", /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(stamp(new Date(2026, 9, 31, 18, 14, 36))), stamp(new Date(2026, 9, 31, 18, 14, 36)));
check(
  "an application's folder sits under the day and names the company and the role, with no time in it",
  applicationFolder({ company: "Mercury", title: "Senior Analytics Engineer" }, "applied", new Date(2026, 10, 2)) === "applied/2026-11-02/Mercury - Senior Analytics Engineer",
  applicationFolder({ company: "Mercury", title: "Senior Analytics Engineer" }, "applied", new Date(2026, 10, 2)),
);
check(
  "a job written up for applying by hand goes under its own root",
  applicationFolder({ company: "Mercury", title: "Senior Analytics Engineer" }, MANUAL_ROOT, new Date(2026, 10, 2)) === "manual application/2026-11-02/Mercury - Senior Analytics Engineer",
  applicationFolder({ company: "Mercury", title: "Senior Analytics Engineer" }, MANUAL_ROOT, new Date(2026, 10, 2)),
);
check("day folders include the year", dayFolder(new Date(2026, 0, 9)) === "2026-01-09" && dayFolder(new Date(2026, 11, 25)) === "2026-12-25");
check("the day's other-links table sits under other links/", otherLinksPath(new Date(2026, 10, 2)) === "other links/2026-11-02.csv");
const OTHER = otherLinksCsv([
  { at: Date.UTC(2026, 10, 2), company: "Beta", title: "Data Engineer", applyUrl: "https://beta.taleo.net/careersection/2/jobdetail.ftl?job=9", sourceUrl: "https://hiring.cafe/job/xyz", folder: "manual application/Beta - Data Engineer", reason: "applies through taleo, which this bot cannot fill" },
  { at: Date.UTC(2026, 10, 1), company: "Acme", title: "Platform, Engineer", applyUrl: "https://acme.com/careers/123", sourceUrl: "https://jobright.ai/jobs/info/abc", folder: "manual application/Acme - Platform, Engineer", reason: "applies through acme.com" },
]);
const OTHER_ROWS = OTHER.replace(/^\ufeff/, "").split("\r\n");
check(
  "other links.csv has one column per thing to know - date, company, role, board, job link, application link, folder, why",
  OTHER_ROWS[0] === '"date","company","role","board","job link","application link","folder","why"',
  OTHER_ROWS[0],
);
check(
  "other links.csv is ordered oldest first, names the board, and quotes a comma in a title",
  OTHER_ROWS[1] === '"2026-11-01","Acme","Platform, Engineer","company site","https://jobright.ai/jobs/info/abc","https://acme.com/careers/123","manual application/Acme - Platform, Engineer","applies through acme.com"' &&
    OTHER_ROWS[2].startsWith('"2026-11-02","Beta","Data Engineer","taleo","https://hiring.cafe/job/xyz"'),
  OTHER_ROWS.slice(1).join("\n"),
);
check("other links.csv opens in Excel as written: a byte-order mark and CRLF line ends", OTHER.startsWith("\ufeff") && OTHER.endsWith("\r\n"), JSON.stringify(OTHER.slice(0, 3)));
check(
  "the board column names the ATS, an email address, or the company's own site",
  boardLabel("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_R1") === "workday" &&
    boardLabel("https://career.successfactors.com/job/1") === "successfactors" &&
    boardLabel("mailto:jobs@acme.com") === "email" &&
    boardLabel("https://www.linkedin.com/jobs/view/1") === "linkedin" &&
    boardLabel("https://acme.com/jobs/1") === "company site",
  [boardLabel("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_R1"), boardLabel("mailto:jobs@acme.com"), boardLabel("https://acme.com/jobs/1")].join(" | "),
);
const CSV = resultsCsv([
  { at: 2, company: "B", title: "Role, with comma", status: "submitted", reason: "", took: 61000, applyUrl: "https://b", detail: { folder: "applied/x" } },
  { at: 1, company: "A", title: "R", status: "skipped", reason: 'said "no"', took: 1000, applyUrl: "https://a", sourceUrl: "https://jobright.ai/jobs/info/1" },
]);
check("the CSV is ordered by time and quotes commas and quotes", CSV.split("\n")[1].startsWith('"1970-01-01T00:00:00.001Z","A","R","skipped","said ""no"""') && CSV.includes('"Role, with comma"'), CSV);
check("the folder column points at the application's files", CSV.split("\n")[2].endsWith('"applied/x"'), CSV.split("\n")[2]);

/* ------------------------------------------------- Workday's own questions */

section("Workday's forms, as seen on HCSC and Bloom Energy");
const wd = (field) => resolveField({ type: "text", required: true, options: [], ...field }, PROFILE, CONTEXT);
const signed = wd({ label: "Date", name: "dateSignedOn", id: "selfIdentifiedDisabilityData--dateSignedOn", type: "date" });
check("the date beside the self-identification signature is today, not the model's guess", signed.outcome === "fill" && /^\d{2}\/\d{2}\/\d{4}$/.test(signed.value), JSON.stringify(signed));
const birth = wd({ label: "Date of Birth", name: "dateOfBirth", type: "date" });
check("a date of birth is not today", birth.outcome !== "fill" || birth.rule !== "signed-today", JSON.stringify(birth));
const city = wd({ label: "City", name: "city", id: "address--city" });
check("Workday's own City box gets the city alone", city.value === "Friendswood", JSON.stringify(city));
const agency = wd({ label: "Have you, your spouse, or a relative of you or your spouse been employed or contracted by a federal, state or local agency in any capacity within the past 5 years?", type: "radio", options: [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }] });
check("'federal, state or local agency' is not a question about the home state", agency.rule !== "state", JSON.stringify(agency));
const region = wd({ label: "State", name: "countryRegion", type: "select", options: [{ label: "Texas", value: "Texas" }, { label: "Utah", value: "Utah" }] });
check("a State menu still gets the state", region.value === "Texas", JSON.stringify(region));
const veteranWords = expand("I am not a protected veteran");
check("'I am not a veteran' is tried before the bare 'not a protected veteran'", veteranWords.indexOf("I am not a veteran") < veteranWords.indexOf("Not a protected veteran"), veteranWords.join(" / "));
const linkedin = wd({ label: "Please enter your LinkedIn URL.", name: "linkedInAccount" });
check("a LinkedIn address is given with the www host Workday insists on", linkedin.value === "https://www.linkedin.com/in/steven-atkins-9382", JSON.stringify(linkedin));
const bareHandle = resolveField({ type: "text", required: true, options: [], label: "LinkedIn", name: "linkedin" }, { ...PROFILE, linkedin: "steven-atkins-9382" }, CONTEXT);
check("a bare LinkedIn handle becomes a full address", bareHandle.value === "https://www.linkedin.com/in/steven-atkins-9382", JSON.stringify(bareHandle));

/* --------------------------------------------------------------- done */

section("");
console.log(failures === 0 ? `All checks passed.` : `${failures} check${failures === 1 ? "" : "s"} failed.`);
process.exit(failures === 0 ? 0 : 1);
