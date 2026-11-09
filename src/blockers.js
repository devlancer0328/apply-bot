/**
 * The postings this candidate cannot be hired for, decided from the
 * posting's own words in under a millisecond.
 *
 * This is not the eligibility research in screening.js and does not
 * replace it. That suite answers "does this role match the applicant's
 * preferences", costs a web-search pass per posting, and is off by
 * default. This answers a narrower question - "would this employer be
 * legally or administratively unable to hire this person" - and it is
 * worth answering first because the alternative is paying for it later:
 * a posting demanding an active clearance the applicant does not hold
 * still costs a resume, a cover letter, a filled form and a submission
 * before the rejection arrives weeks later.
 *
 * Every rule here is off unless the applicant has stated the fact it
 * needs. A blank is never read as a "no" - the same bar profile.js sets
 * for every personal statement, and for the same reason: being wrong
 * here does not cost an inaccuracy, it silently costs applications the
 * candidate would have wanted, and they never find out.
 *
 * The patterns are deliberately narrow. A rule that fires on a phrase
 * the posting did not mean is the expensive failure, because a rejected
 * posting leaves a line in a table nobody reads and an application that
 * was never attempted. Where a clause is ambiguous the posting is let
 * through, and the fit pass or the form itself deals with it.
 */

const fold = (value) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");

/** The posting as one searchable string: the title, the description and whatever the board labelled it. */
const postingText = (job) => fold([job?.title, job?.jd, ...Object.values(job?.metadata ?? {})].filter((value) => typeof value === "string").join("\n"));

/** Sentences, so a requirement and its negation cannot be read out of two different clauses. */
const clauses = (text) => text.match(/[^.!?\n]+/g) ?? [];

/** "No clearance required", "unless", "preferred" - anything that stops a clause being a hard requirement. */
const SOFTENED = /\b(?:no|not|without|never|unless|except|however|but|preferred|preferable|nice to have|a plus|bonus|desirable|ideally|willing to obtain|ability to obtain|able to obtain|eligible to obtain|or equivalent)\b/;

/**
 * Whether the applicant answered this question at all.
 *
 * Shared by every rule below, and the whole safety of the file: a
 * profile that has never been filled in blocks nothing.
 */
const stated = (value) => String(value ?? "").trim() !== "";

/* --------------------------------------------------------- clearance */

/**
 * An active clearance is a thing a government granted, and nothing on a
 * resume implies one. So this fires only when the applicant has said
 * outright that they hold none, and only on the active form - "must be
 * able to obtain" is a requirement anybody can meet and is softened out
 * above.
 */
const ACTIVE_CLEARANCE = /\b(?:active|current|existing|in[- ]scope)\b[^,;]{0,40}\b(?:clearance|ts\/sci|top secret|public trust)\b|\b(?:clearance|ts\/sci|top secret)\b[^,;]{0,40}\b(?:is |are )?(?:required|mandatory)\b|\bmust (?:currently )?(?:hold|have|possess|maintain)\b[^,;]{0,40}\bclearance\b/;

const holdsNoClearance = (profile) => /^(?:none|no|n\/a|i do not|do not|don't)\b/.test(fold(profile?.securityClearance).trim());

function clearanceBlock(job, profile) {
  if (!stated(profile?.securityClearance) || !holdsNoClearance(profile)) return null;
  const clause = clauses(postingText(job)).find((line) => ACTIVE_CLEARANCE.test(line) && !SOFTENED.test(line));
  return clause ? { rule: "clearance", reason: "The posting requires an active security clearance and your profile states you hold none." } : null;
}

/* -------------------------------------------------------- sponsorship */

const SPONSORSHIP_REFUSED = [
  /\b(?:unable|not able|cannot|can not|do not|does not|will not|won't|are not|is not)\b[^,;]{0,45}\bsponsor/,
  /\bsponsorship\b[^,;]{0,30}\b(?:is |are )?(?:not available|not offered|not provided|unavailable)\b/,
  /\bno (?:visa |work )?sponsorship\b/,
  /\bwithout (?:the need for |requiring )?(?:visa |work )?sponsorship\b/,
];

/** A yes to "do you require sponsorship", in any of the spellings the profile accepts. */
const needsSponsorship = (profile) => /^(?:yes|y|true|i will|i do|require)/.test(fold(profile?.requiresSponsorship).trim());

function sponsorshipBlock(job, profile) {
  if (!stated(profile?.requiresSponsorship) || !needsSponsorship(profile)) return null;
  const refused = clauses(postingText(job)).some((line) => SPONSORSHIP_REFUSED.some((pattern) => pattern.test(line)));
  return refused ? { rule: "sponsorship", reason: "The posting states sponsorship is not available and your profile requires it." } : null;
}

/* ------------------------------------------------------------ country */

/**
 * Where the employer can hire, when the posting says so outright.
 *
 * The narrowest rule in the file, because "based in New York" is a
 * sentence in almost every posting and almost none of them mean the
 * applicant is ineligible. It fires only on a clause that restricts who
 * may apply, and only when the named country is not the applicant's.
 */
const RESTRICTED_TO = /\b(?:must (?:be (?:a )?(?:resident|located|based|living)|reside|live)|only (?:open|available) to (?:candidates|applicants)|candidates must be|applicants must be|restricted to (?:candidates|applicants|residents)|eligible to work (?:only )?in|authorized to work in|work authorization in)\b[^.!?]{0,80}/;

/**
 * Countries the postings in this pipeline actually name, with the
 * spellings and demonyms they use. Deliberately short: an unrecognised
 * country is a posting that is let through, which is the right way to
 * be wrong.
 */
const COUNTRIES = [
  ["united states", ["united states", "the us", " usa", " u.s.", "u.s.a", "america", "american", "stateside"]],
  ["canada", ["canada", "canadian"]],
  ["united kingdom", ["united kingdom", " uk ", "britain", "british", "england", "scotland", "wales"]],
  ["ireland", ["ireland", "irish"]],
  ["germany", ["germany", "german"]],
  ["france", ["france", "french"]],
  ["netherlands", ["netherlands", "dutch"]],
  ["spain", ["spain", "spanish"]],
  ["poland", ["poland", "polish"]],
  ["india", ["india", "indian"]],
  ["australia", ["australia", "australian"]],
  ["new zealand", ["new zealand"]],
  ["singapore", ["singapore"]],
  ["japan", ["japan", "japanese"]],
  ["brazil", ["brazil", "brazilian"]],
  ["mexico", ["mexico", "mexican"]],
];

/** Which countries a clause names, by any of their spellings. */
function countriesIn(text) {
  const padded = ` ${text} `;
  return COUNTRIES.filter(([, spellings]) => spellings.some((spelling) => padded.includes(spelling))).map(([name]) => name);
}

function countryBlock(job, profile) {
  const home = countriesIn(fold(profile?.country));
  if (!stated(profile?.country) || home.length !== 1) return null;
  for (const clause of clauses(postingText(job))) {
    const restriction = clause.match(RESTRICTED_TO)?.[0];
    if (!restriction || SOFTENED.test(restriction)) continue;
    const named = countriesIn(restriction);
    // Only a clause naming exactly one country, and a different one. Two
    // countries is a list the applicant might yet be added to, and zero
    // is a clause about a city or a state, which says nothing about this.
    if (named.length === 1 && named[0] !== home[0]) {
      return { rule: "country", reason: `The posting is open only to candidates in ${named[0].replace(/\b\w/g, (c) => c.toUpperCase())}, and your profile is in ${profile.country}.` };
    }
  }
  return null;
}

/* --------------------------------------------------------- experience */

/**
 * The years bar, when every stated bar is above the applicant.
 *
 * Read off the lowest requirement in the posting rather than the
 * highest: a posting wanting "3+ years of Python and 10+ years leading
 * teams" is a posting a five-year candidate should apply to. Only when
 * even the smallest number stated is out of reach is the posting
 * genuinely addressed to somebody else.
 *
 * The two-year margin is there because the number is aspirational
 * roughly as often as it is real, and because `techYears` is one figure
 * standing in for a career that may have started before the parts the
 * applicant counts.
 */
const YEARS = /\b(\d{1,2})\s*(?:\+|or more|plus)?\s*(?:-|to)?\s*(?:\d{1,2})?\s*(?:\+)?\s*years?\b[^.!?]{0,40}\bexperience\b|\bexperience\b[^.!?]{0,30}\b(\d{1,2})\s*(?:\+|or more|plus)\s*years?\b/g;
const EXPERIENCE_MARGIN = 2;

function experienceBlock(job, profile) {
  const years = Number(profile?.techYears);
  if (!Number.isFinite(years) || years <= 0) return null;
  const bars = [];
  for (const match of postingText(job).matchAll(YEARS)) {
    const value = Number(match[1] ?? match[2]);
    if (Number.isFinite(value) && value > 0 && value <= 40) bars.push(value);
  }
  if (!bars.length) return null;
  const floor = Math.min(...bars);
  return floor > years + EXPERIENCE_MARGIN
    ? { rule: "experience", reason: `The posting asks for ${floor}+ years of experience and your profile states ${years}.` }
    : null;
}

/* --------------------------------------------------------------- all */

const RULES = [clearanceBlock, sponsorshipBlock, countryBlock, experienceBlock];

/**
 * The first rule this posting breaks, or nothing.
 *
 * First rather than all: the table shows one reason and the applicant
 * only needs one to understand why the posting was passed over.
 */
export function hardBlock(job, profile) {
  if (profile?.hardBlockers === false) return null;
  for (const rule of RULES) {
    const blocked = rule(job, profile);
    if (blocked) return blocked;
  }
  return null;
}
