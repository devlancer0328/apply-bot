/**
 * Deciding what belongs in each field of an application form.
 *
 * Every field resolves to exactly one of four outcomes, and which one it is
 * matters more than the value itself:
 *
 *   fill     - the profile knows this, copy it
 *   attach   - a document goes here
 *   ask      - open-ended, the model may answer it
 *   blocked  - required, and nothing here may answer it
 *
 * The fourth exists for one reason. A form that asks whether you need visa
 * sponsorship, or whether you are a protected veteran, is asking a question
 * with a true answer that the applicant knows and a model does not. Guessing it
 * is not a wrong field value, it is a false statement on an application, so a
 * sensitive field the profile cannot answer stops the whole submission rather
 * than being filled with the model's best idea.
 *
 * Matching runs on the field's visible label first and its name or id second,
 * never on position, because position is the thing that changes between two
 * companies using the same board.
 */

import { isCompensationQuestion, hasCompensationResearch, statedCompensationAnswer } from "./salary.js";
import {demographicWordings,isDemographicQuestion,isPronounAnswer,chooseDemographicOption} from './demographics.js';
/** The rules whose answer is a fact about the applicant rather than about the job. */
const DEMOGRAPHIC_RULES = new Set(['pronouns','gender','race','hispanic','veteran','disability','transgender','sexual-orientation']);
/** The rules whose answer is a tie between the applicant and the employer applied to. */
const EMPLOYER_TIE_RULES = new Set(['previous-employment','relationship-to-employee','family-at-employer','knows-an-employee']);
const asksEmployerTie = (subject) =>
  /(?:previously|ever) (?:worked|been employed|volunteered|interned)|current or former employee|former employee|worked (?:here|for us|at this company)|\b(?:are|were) you (?:currently |previously |ever )?an employee of\b|\b(?:externship|practicum|clinical rotation)\b/.test(subject);
import {packAnswer,fillCompany,templateQuestion} from './question-pack.js';

/**
 * Does the question name the employer it is being asked on behalf of?
 *
 * The employer-tie question is the one sentence where the company's own
 * name decides the meaning: "have you previously worked in a remote
 * environment" and "have you previously worked for us as an employee"
 * share their opening words and are not the same question. Templating
 * the asked text against the company is how the answer pack already
 * tells two employers' versions of one question apart, so it is what
 * tells this one from the question that only sounds like it.
 */
const namesEmployer = (label, company) => {
  const text = String(label ?? "");
  if (/\b(?:here|for us|with us|at this company|this company|our company|our organi[sz]ation)\b/i.test(text)) return true;
  return templateQuestion(text, String(company ?? "")).includes("{company}");
};

const yesNoAnswer = value => value === 'yes' ? 'Yes' : value === 'no' ? 'No' : '';

const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
];

const STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

/** The same table the other way round, for reading a code back as a name. */
const STATE_NAMES = Object.fromEntries(
  Object.entries(STATE_CODES).map(([name, code]) => [code, name.replace(/\b\w/g, (letter) => letter.toUpperCase())]),
);

/** "Texas" for "TX" or "texas"; whatever was given, otherwise. */
const stateName = (state) => {
  const given = String(state ?? "").trim();
  if (STATE_NAMES[given.toUpperCase()]) return STATE_NAMES[given.toUpperCase()];
  const code = STATE_CODES[normalise(given)];
  return code ? STATE_NAMES[code] : given;
};

// Accents dropped, so Rippling's "Résumé" is a resume.
const normalise = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Label first, then the machine names, so a relabelled field still resolves.
 *
 * Underscores and hyphens become spaces because the machine names are where
 * the meaning often lives - Greenhouse labels both upload controls "Attach"
 * and distinguishes them only by the ids `resume` and `cover_letter`.
 */
function haystack(field) {
  return normalise([field.label, field.name, field.id].filter(Boolean).join(" | ").replace(/[_-]+/g, " "));
}

/**
 * The wordings an answer might appear under on a menu.
 *
 * The profile stores an intent - "decline", "no" - but no board offers those
 * words. Each one is expanded into the phrasings that mean it, in preference
 * order, and the page tries them in turn against whatever is actually on the
 * dropdown. Keeping this list here rather than in the page script is what
 * keeps the page script free of any opinion about what an answer means.
 */
/**
 * The option a number falls in, for a list known up front.
 *
 * The same reading of "0-1", "4-6", "7+", "Less than 1", "10+ years" and
 * Beginner..Expert as the page script's pickByNumber in fill.js, which
 * handles the menus that only exist once opened. Two copies because the
 * page script is injected as a self-contained file and cannot import.
 */
const LEVELS = ["none", "beginner", "novice", "basic", "familiar", "intermediate", "proficient", "advanced", "expert"];
export function pickOption(options, target) {
  const labelled = (options ?? []).map((option) => ({ option, label: normalise(option.label || option.value) })).filter((entry) => entry.label);
  const ranges = labelled
    .map(({ option, label }) => {
      const numbers = (label.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (numbers.length === 0) return null;
      if (/less than|under|fewer than|below|<\s*\d/.test(label)) return { option, low: 0, high: numbers[0] - 0.01 };
      if (/more than|over|greater than|above|\+|>\s*\d|or more/.test(label)) return { option, low: numbers[0], high: Infinity };
      if (numbers.length >= 2) return { option, low: Math.min(numbers[0], numbers[1]), high: Math.max(numbers[0], numbers[1]) };
      return { option, low: numbers[0], high: numbers[0] };
    })
    .filter(Boolean);

  if (ranges.length > 0) {
    const holding = ranges.find((range) => target >= range.low && target <= range.high);
    if (holding) return holding.option;
    const below = ranges.filter((range) => range.low <= target).sort((a, b) => b.low - a.low)[0];
    return below ? below.option : ranges.sort((a, b) => a.low - b.low)[0].option;
  }

  const rungs = labelled
    .map(({ option, label }) => ({ option, rank: LEVELS.findIndex((level) => label.includes(level)) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (rungs.length === 0) return null;
  return rungs[Math.min(rungs.length - 1, Math.max(0, Math.round((target / 10) * (rungs.length - 1))))].option;
}

/** The ways a "how did you hear about us" menu words the usual answers, in order of preference. */
// The company's own site before "job board": landing from a search is a
// visit to the careers page, and "Other job board" on an Ashby form opens
// a second question asking which.
const HOW_HEARD_WORDINGS = ["Google", "Search Engine", "Search engine (Google, Bing, etc.)", "Online search", "Internet search", "Company website", "Careers page", "Career site", "Job Board", "LinkedIn", "Indeed", "Glassdoor", "Other"];

export function expand(value) {
  const want = normalise(value);

  if (want === "decline") {
    return [
      "Decline to self-identify",
      "I don't wish to answer",
      "I do not wish to answer",
      "Prefer not to say",
      "I prefer not to answer",
      "Decline to answer",
      "I don't wish to disclose",
      "Decline",
    ];
  }
  if (want === "yes") return ["Yes", "I am", "I do", "I have", "True", "I agree", "I acknowledge", "I accept", "I confirm", "Acknowledge", "Confirm"];
  if (want === "no") return ["No", "I am not", "I do not", "I have not", "False"];
  if (want === "heterosexual") return ["Heterosexual or straight", "Heterosexual / straight", "Heterosexual", "Straight"];
  // The veteran and disability statements, as the boards each word them.
  // Workday's menus say "I am not a protected veteran" on most sites and
  // "I am not a veteran" on some; the disability form's "No" runs to a
  // sentence.
  if (/not a protected veteran|not a veteran/.test(want)) {
    // "I am not a veteran" ahead of the bare "not a protected veteran":
    // the latter is also inside "I identify as a veteran, just not a
    // protected veteran", which says the opposite.
    return ["I am not a protected veteran", "I am not a veteran", "Not a protected veteran", "I am not a protected veteran, and I am not a veteran", "No, I am not a protected veteran", "No"];
  }
  if (/^no\b.*disabilit/.test(want)) {
    return ["No, I do not have a disability", "No, I don't have a disability", "No, I do not have a disability and have not had one in the past", "No, I do not have a disability or a history/record of having a disability", String(value), "No"];
  }

  // A place, as "City, ST". Greenhouse's location box is a search over a
  // geocoder, and the geocoder spells places its own way: "Friendswood,
  // Texas, United States", never "Friendswood, TX". The state's full name is
  // offered second so the right state still wins where a city name is shared,
  // and the bare city last, because a geocoder returning one place for a
  // typed city is almost always returning the right one.
  const place = /^(.+?),\s*([A-Za-z .]+)$/.exec(String(value).trim());
  if (place) {
    const [, city, region] = place;
    const code = STATE_NAMES[region.toUpperCase()] ? region.toUpperCase() : STATE_CODES[normalise(region)];
    const name = code ? STATE_NAMES[code] : "";
    // The full name first: it is what a geocoder shows and what a text box
    // asking for "city and state" wants. The code second, the bare city last.
    return name ? [`${city}, ${name}`, `${city}, ${code}`, city] : [String(value), city];
  }

  return [String(value)];
}

/**
 * Picks the option that says what we mean.
 *
 * Exact text wins, then a contained match, then a small set of synonyms, since
 * boards phrase the same answer as "Yes", "Yes, I am", "I am authorized" and
 * "I do not wish to answer" versus "Decline to self-identify".
 */
export function chooseOption(options, desired) {
  if (!options || options.length === 0) return null;
  const want = normalise(desired);
  if (!want) return null;

  const usable = options.filter((option) => normalise(option.label) || normalise(option.value));
  const text = (option) => normalise(option.label) || normalise(option.value);

  // A placeholder is not an answer, however well it matches.
  const real = usable.filter((option) => !/^(select\.{0,3}|choose\.{0,3}|--.*--|please select)$/.test(text(option)));
  const pool = real.length > 0 ? real : usable;

  const exact = pool.find((option) => text(option) === want || normalise(option.value) === want);
  if (exact) return exact;

  const starts = pool.find((option) => text(option).startsWith(want) || want.startsWith(text(option)));
  if (starts) return starts;

  /**
   * Containment on word boundaries, never bare substrings.
   *
   * This matters more than it looks. Matching "no" loosely picks "Pending" out
   * of a sponsorship dropdown, because "pending" contains an n and an o in
   * order - and the result is an application that states the opposite of the
   * truth about the applicant's right to work.
   */
  const contains = (haystackText, needle) =>
    new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystackText);

  for (const phrase of expand(want).map(normalise)) {
    const hit = pool.find((option) => contains(text(option), phrase));
    if (hit) return hit;
  }

  const loose = pool.find((option) => contains(text(option), want));
  return loose ?? null;
}

/**
 * Answers "do you live in one of the following states: ..." by reading the list
 * out of the question itself.
 *
 * Boards use this to screen for states they cannot employ in, and the list
 * differs per company, so the only reliable source for it is the label.
 */
function statesListedIn(label) {
  const text = normalise(label);
  const listed = US_STATES.filter((state) => new RegExp(`\\b${state}\\b`).test(text));
  // Two or more named states is a list being asked about. One is a sentence
  // that happens to mention a state.
  return listed.length >= 2 ? listed : null;
}

/**
 * The metros that forms ask about by nickname.
 *
 * "Are you located in the NYC area?" is a question about a place with no
 * edges, and there is no honest way to compute one. What can be said without
 * a map is narrower and is all this table carries: which states a metro
 * reaches into, and the cities it is built out of.
 *
 * That asymmetry is the whole design. A state the metro does not reach is a
 * sound no whatever the commute - Temple, Texas is not in the New York area
 * and no radius changes that. A city inside one of those states that is not
 * on the list is not a no, it is unknown, and goes to a person. So the
 * table being incomplete costs an application a review; it never costs a
 * false answer, which is the only failure that matters here.
 */
const METROS = {
  nyc: { states: ["NY", "NJ", "CT"], cities: ["new york", "brooklyn", "queens", "bronx", "staten island", "jersey city", "newark", "hoboken", "yonkers", "stamford", "white plains"] },
  "new york city": { states: ["NY", "NJ", "CT"], cities: ["new york", "brooklyn", "queens", "bronx", "staten island", "jersey city", "newark", "hoboken", "yonkers", "stamford", "white plains"] },
  "tri state": { states: ["NY", "NJ", "CT"], cities: ["new york", "brooklyn", "queens", "bronx", "jersey city", "newark", "stamford"] },
  "bay area": { states: ["CA"], cities: ["san francisco", "oakland", "berkeley", "san jose", "palo alto", "mountain view", "sunnyvale", "santa clara", "redwood city", "san mateo", "fremont", "daly city", "emeryville"] },
  "sf bay area": { states: ["CA"], cities: ["san francisco", "oakland", "berkeley", "san jose", "palo alto", "mountain view", "sunnyvale", "santa clara", "redwood city", "san mateo", "fremont"] },
  "silicon valley": { states: ["CA"], cities: ["san jose", "palo alto", "mountain view", "sunnyvale", "santa clara", "cupertino", "menlo park", "redwood city"] },
  dmv: { states: ["DC", "MD", "VA"], cities: ["washington", "arlington", "alexandria", "bethesda", "silver spring", "rockville", "mclean", "reston"] },
  "dc area": { states: ["DC", "MD", "VA"], cities: ["washington", "arlington", "alexandria", "bethesda", "silver spring", "rockville", "mclean", "reston"] },
  "greater boston": { states: ["MA"], cities: ["boston", "cambridge", "somerville", "brookline", "newton", "quincy", "waltham"] },
  "greater seattle": { states: ["WA"], cities: ["seattle", "bellevue", "redmond", "kirkland", "tacoma", "everett"] },
  "greater chicago": { states: ["IL"], cities: ["chicago", "evanston", "oak park", "naperville", "schaumburg"] },
  "chicagoland": { states: ["IL"], cities: ["chicago", "evanston", "oak park", "naperville", "schaumburg"] },
  "greater los angeles": { states: ["CA"], cities: ["los angeles", "santa monica", "pasadena", "burbank", "glendale", "long beach", "culver city", "el segundo"] },
  socal: { states: ["CA"], cities: ["los angeles", "san diego", "irvine", "santa monica", "pasadena", "long beach", "anaheim"] },
};

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The profile's state as a two-letter code, whichever way it was written. */
function stateCode(state) {
  const given = String(state ?? "").trim();
  if (STATE_NAMES[given.toUpperCase()]) return given.toUpperCase();
  return STATE_CODES[normalise(given)] ?? "";
}

/**
 * Whether the applicant is where the question is asking about.
 *
 * Returns "Yes", "No", or nothing at all - and the third is the important
 * one. A question naming a place the profile cannot be placed against gets
 * no answer, which leaves the field blocked and the application in front of
 * a person, exactly as it was before this existed. The rule only ever turns
 * parks into answers where the answer is a fact.
 */
function proximityAnswer(label, profile) {
  const question = normalise(label);
  const city = normalise(profile.city);
  const state = stateCode(profile.state);

  // The applicant's own city, named in the question, settles it outright.
  if (city && new RegExp(`\\b${escapeRegex(city)}\\b`).test(question)) return "Yes";

  const metro = Object.entries(METROS).find(([name]) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(question))?.[1];
  const named = US_STATES.find((entry) => new RegExp(`\\b${entry}\\b`).test(question));
  const reaches = metro ? metro.states : named ? [STATE_CODES[named]] : null;
  if (!reaches || !state) return "";

  if (!reaches.includes(state)) return "No";
  if (metro) return metro.cities.includes(city) ? "Yes" : "";
  return "Yes";
}

/**
 * Whether the applicant is in the place a question names, at whatever
 * scale the question chose: a list of states, a country, or a metro.
 *
 * The same three readings the residence rule has always had, lifted out so
 * the compound "located in and able to work in the US" question settles its
 * location half the same way rather than against a second opinion. "" still
 * means unknown and still parks.
 */
function placedIn(question, profile) {
  const listed = statesListedIn(question);
  if (listed) return listed.includes(normalise(profile.state)) ? "Yes" : "No";
  if (/\b(?:the )?(?:us|usa|u\.s\.?|united states|america)\b/.test(question)) {
    if (!String(profile.country ?? "").trim()) return "";
    return /united states|usa|us\b/.test(normalise(profile.country)) ? "Yes" : "No";
  }
  // Neither a list of states nor the country: a single named place, as in
  // "are you located in the NYC area?". The profile holds where the
  // applicant lives, so this is a fact to read rather than a judgement.
  return proximityAnswer(question, profile);
}

/** Words that are part of a company's legal name rather than its identity. */
const COMPANY_NOISE = /\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|technologies|technology|labs|software|systems|solutions|the)\b/g;

const companyKey = (name) => normalise(name).replace(/[.,]/g, " ").replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();

/**
 * Whether this applicant has worked for the company being applied to.
 *
 * No, unless they have said otherwise in so many words.
 *
 * This used to search the generated resume for the employer's name, on
 * the reasoning that a fact about the pair cannot come from a setting
 * about the applicant. The reasoning was right and the source was
 * wrong. A resume is written for the posting it is sent to, so the
 * employer's own words appear in it - the role, the stack, the industry,
 * sometimes the company itself as a customer or a competitor - and a
 * name found there is evidence of what the document is about rather than
 * where the applicant worked. Every match it produced was a "yes" on a
 * question the applicant would have answered "no", which is a false
 * statement on a signed application: the single worst outcome in this
 * file, and the one its judgement rules exist to avoid.
 *
 * So the guess is gone and the declaration stays. `previousEmployers` is
 * a list the applicant typed, naming employers they choose to name, and
 * an employer absent from it is an employer they never worked for. The
 * cover letter was never consulted and still is not, for the reason that
 * now disqualifies the resume too, only more so.
 */
function workedAt(company, profile) {
  const target = companyKey(company);
  if (!target) return false;

  const declared = String(profile.previousEmployers ?? "")
    .split(/[,\n;]/)
    .map(companyKey)
    .filter(Boolean);
  if (declared.length > 0 && declared.some((employer) => employer === target)) return true;

  // A bare "yes" in the profile means "assume I have worked everywhere", which
  // nobody means; it is kept only as a manual override for a single run.
  return profile.previouslyEmployed === "yes";
}

const AUTHORIZATION_ANSWER = {
  "us-citizen": "I am a US citizen",
  "permanent-resident": "I am a lawful permanent resident",
  "visa-holder": "I hold a visa that permits me to work",
  "needs-sponsorship": "I will require sponsorship",
};

/**
 * The same four statuses as wordings a menu might use, most specific first.
 *
 * For a dropdown whose entries are only visible once it opens, so the page
 * has to be handed every phrasing in advance. Order is the safety: "Yes" is
 * last because its own expansions ("I am") sit inside every entry of a
 * status menu - "I am authorized ... due to my nationality" was picked for a
 * sponsorship case that way - and a status phrase wins before it is tried.
 */
const AUTHORIZATION_WORDINGS = {
  "us-citizen": ["US citizen", "citizen", "due to my nationality", "nationality", "do not need a company to sponsor", "without sponsorship", "Yes"],
  "permanent-resident": ["lawful permanent resident", "permanent resident", "green card", "do not need a company to sponsor", "without sponsorship", "Yes"],
  "visa-holder": ["do not need a company to sponsor", "valid work permit", "work permit", "visa", "Yes"],
  "needs-sponsorship": ["need visa support", "needs to be sponsored", "require sponsorship", "sponsorship", "not authorized", "No"],
};

/**
 * "Authorized to work without sponsorship" asks about authorization.
 *
 * The sponsorship rule sits above the authorization rule and the first match
 * wins, so a question naming both went to sponsorship and was answered from
 * `requiresSponsorship`. For Ondo's "are you currently authorized to work in
 * the United States without the need for employer sponsorship?" that is "No",
 * which on the form reads as "I am not authorized to work here" - the inverse
 * of the truth for a citizen, and a false statement that ends an application
 * rather than failing anywhere visible. The sponsorship clause there
 * qualifies the authorization; it is not what is being asked.
 *
 * Narrow on purpose, because the opposite wording is just as common and the
 * sponsorship reading is right for it: Scale's "will you now or in the future
 * require work authorization or employment sponsorship?" names both too, and
 * must keep falling through to the sponsorship rule. The difference is the
 * negated qualifier - "without", "not requiring" - between the two, so that
 * is what this looks for rather than the mere presence of both words.
 *
 * Bounded by `?` and `|` so it cannot reach across a sentence into the next
 * question, or out of the label and into the field's machine names.
 *
 * "Able to work" belongs in the first half for the same reason "eligible"
 * does, and was missing. BetterHelp asks "are you located in and able to
 * work in the US without visa sponsorship for the next 5 years?" - the
 * Ondo wording with a plainer verb - and without that alternative the
 * guard does not fire, the sponsorship rule takes the question, and a
 * citizen answers "No" to being able to work here. `\b` keeps it off
 * "unable", where the reading flips.
 */
const AUTHORIZED_WITHOUT_SPONSORSHIP =
  /(?:\b(?:authoriz|authoris|eligib|permitted|entitled)\w*\b|\bable to (?:work|be employed)\b)[^?|]*?\b(?:without|no need (?:for|of)|(?:do(?:es)?|will) not (?:requir|need)\w*|not (?:requiring|needing))\b[^?|]*?\bsponsor/;

/**
 * Being somewhere, as the half of a question that is about an address.
 *
 * The preposition is required. Vercel labels its status menu "your
 * authorization to work in the country where you live", and the bare word
 * "live" there is part of a sentence about authorization, not a second
 * question about where the applicant is.
 */
const BEING_LOCATED = /\b(?:located|based|residing|living|reside|live|resident) in\b/;

/** Being allowed to hold the job, as the half that is about status. */
const BEING_ALLOWED_TO_WORK =
  /\b(?:able|authoriz\w*|authoris\w*|eligible|permitted|entitled|legally able|cleared) to (?:work|be employed)\b|\bright to work\b|\bwork (?:legally|lawfully)\b/;

/**
 * A question asking about a span of years ahead rather than today.
 *
 * It changes who may answer. A citizenship and a green card do not expire,
 * so their holder can speak for the next five years; a visa has a date on
 * it, and "yes, for the next 5 years" from a visa holder is a promise about
 * a renewal nobody has granted yet.
 */
const FUTURE_HORIZON =
  /\bnext \d+\+? (?:or more )?years?\b|\bfor (?:at least )?\d+\+? years?\b|\bnow (?:and|or) in the future\b|\bat any (?:time|point) in the future\b|\bforeseeable future\b|\bon an ongoing basis\b/;

/**
 * The field map.
 *
 * Order matters: the first rule whose pattern matches wins, so narrower
 * questions sit above the broad ones they would otherwise be swallowed by.
 * "sensitive" marks a rule the model is never allowed to stand in for.
 */
/** The phrasings that ask for an account of something rather than a fact about it. */
const PROSE_PHRASING = /\bpaste\b|\bdescribe\b|\bexplain\b|\breasons?\b|\btell us\b|\bwhy\b|\bin your own words\b|\bwalk (?:us|me) through\b|\belaborate\b|\bwhat (?:interests|excites|draws|motivates)\b|cover letter/;

/** A field asking for a fact rather than an account: not a paragraph box, not a "why". */
const shortAnswer = (field) => field.tag !== "textarea" && field.type !== "textarea" && !PROSE_PHRASING.test(haystack(field));

/**
 * The sentence a long label is actually asking.
 *
 * Boards increasingly put a paragraph of policy above a control and leave
 * the question as its last line, and a rule reading the whole paragraph
 * answers the preamble instead. DigiCert's form had three of these at once
 * and all three came out wrong in review: a sponsorship question whose
 * preamble says the role carries none was answered "US citizen", a
 * background-check consent whose preamble contains the word "authorization"
 * was answered "US citizen" as well, and a text-message consent ending "May
 * we contact you via text message?" was answered with the phone number.
 *
 * Only the question is the question. A label that is one sentence is
 * unchanged by this, which is nearly all of them.
 */
function operativeQuestion(field) {
  const label = normalise(field?.label ?? "");
  // The dots in "i.e." and "e.g." do not end a sentence. Splitting on them
  // left Coinbase's conflict question as the list inside its own
  // parenthesis - "child/step-child, spouse/partner, ...?" - with the
  // question that list qualifies thrown away, and it parked two finished
  // applications. Masked rather than special-cased in the split, so the
  // dots come back in whichever piece they belong to.
  const masked = label.replace(/\b(?:i\.e|e\.g|etc|vs|approx|dr|mr|mrs|ms|inc|ltd|u\.s|u\.k)\.(?=[\s,;:)]|$)/gi, (found) => found.replaceAll(".", "\u0000"));
  const sentences = masked.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim().replaceAll("\u0000", ".")).filter(Boolean) ?? [];
  if (sentences.length <= 1) return label;
  return [...sentences].reverse().find((sentence) => sentence.endsWith("?")) ?? sentences[sentences.length - 1];
}

/** The haystack, narrowed to that question where the label holds more than one sentence. */
function askedSubject(field) {
  const question = operativeQuestion(field);
  if (!question || question === normalise(field?.label ?? "")) return haystack(field);
  return normalise([question, field?.name, field?.id].filter(Boolean).join(" | ").replace(/[_-]+/g, " "));
}

/** A control whose every entry is a yes or a no, which wants the fact and not the value. */
const yesNoControl = (field) => {
  const choices = (field?.options ?? []).map((option) => normalise(option.label ?? option.value ?? ""));
  return choices.length > 0 && choices.every((choice) => /^(?:yes|no)\b/.test(choice));
};

/**
 * Whether a field wants prose rather than a phrase or a yes.
 *
 * The control is the stronger half of this, and the phrasing is the half
 * that catches a board rendering a paragraph question as a long one-line
 * input. Greenhouse does exactly that, and "Paste your full resume text
 * below for faster review by our AI assistant" was therefore offered to the
 * model as a one-line box, came back "Yes", and went out on a filed
 * DataCamp application. Either signal alone is enough, because the damage
 * is the same shape whichever of the two is missing.
 *
 * A control with options is never prose however it is worded: "describe
 * your level of experience" over a menu of bands is a menu.
 */
export function wantsProse(field = {}) {
  if (field.tag === "textarea" || field.type === "textarea" || field.multiline === true) return true;
  if (field.combobox || (field.options ?? []).length > 0) return false;
  return PROSE_PHRASING.test(haystack(field));
}

/** The whole of what a yes/no control can say, and the whole of what a prose box cannot. */
const BARE_YES_NO = /^(?:y|n|yes|no|true|false|n\/a|na|none|n\/a\.)\.?$/i;

/**
 * Whether a value can honestly be typed into this control.
 *
 * Checked separately from who produced the value, because the model is not
 * the only thing that can answer "Yes" to a paragraph box - a stubbed
 * service, a cached reply and a rescue pass can all do it - and the
 * guarantee wanted here is about the control, not about the author. A
 * recruiter reading "Yes" where they asked for a résumé learns nothing
 * except that nobody was home, and the application cannot be taken back.
 */
export const answerFitsControl = (field = {}, value) =>
  !(wantsProse(field) && (field.options ?? []).length === 0 && BARE_YES_NO.test(String(value ?? "").trim()));

/** The phone is a US number, so a country picker beside it is always the United States. */
const US_PHONE_COUNTRY = ["United States of America (+1)", "United States (+1)", "United States of America", "United States", "USA", "US", "+1"];

/** The two-letter code and the written name, each the other's alternative. */
const STATES =
  "AL Alabama,AK Alaska,AZ Arizona,AR Arkansas,CA California,CO Colorado,CT Connecticut,DE Delaware,DC District of Columbia,FL Florida,GA Georgia,HI Hawaii,ID Idaho,IL Illinois,IN Indiana,IA Iowa,KS Kansas,KY Kentucky,LA Louisiana,ME Maine,MD Maryland,MA Massachusetts,MI Michigan,MN Minnesota,MS Mississippi,MO Missouri,MT Montana,NE Nebraska,NV Nevada,NH New Hampshire,NJ New Jersey,NM New Mexico,NY New York,NC North Carolina,ND North Dakota,OH Ohio,OK Oklahoma,OR Oregon,PA Pennsylvania,PR Puerto Rico,RI Rhode Island,SC South Carolina,SD South Dakota,TN Tennessee,TX Texas,UT Utah,VT Vermont,VA Virginia,WA Washington,WV West Virginia,WI Wisconsin,WY Wyoming"
    .split(",")
    .map((entry) => entry.split(/ (.*)/).slice(0, 2));

/** "TX" answers with "Texas" and "Texas" answers with "TX"; anything else with nothing. */
function stateAlso(state) {
  const wanted = String(state ?? "").trim().toLowerCase();
  if (!wanted) return "";
  const pair = STATES.find(([code, name]) => code.toLowerCase() === wanted || name.toLowerCase() === wanted);
  if (!pair) return "";
  return pair[0].toLowerCase() === wanted ? pair[1] : pair[0];
}

/**
 * The applicant's own answers to questions nothing else here can reach.
 *
 * One `pattern = answer` per line of `profile.answerBank`, the pattern a
 * plain phrase matched case-insensitively inside the question. Checked
 * before every other rule on purpose: a stated answer is the applicant
 * speaking, and the point of the field is to be able to correct this file
 * without editing it.
 *
 * The parse is exported so the settings page can count the lines that will
 * actually be used rather than the lines that were typed. A line without an
 * `=`, or with a phrase of one or two characters, is silently ignored here,
 * and a field that says "2 answers" when three were written is how someone
 * finds out before a run does.
 */
export function standingAnswers(text) {
  const entries = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [, phrase, answer] = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(line) ?? [];
    if (!phrase || phrase.length < 3) continue;
    entries.push({ phrase: normalise(phrase), answer });
  }
  return entries;
}

function bankedAnswer(profile, field) {
  const question = askedSubject(field);
  return standingAnswers(profile?.answerBank).find((entry) => question.includes(entry.phrase))?.answer ?? "";
}

/**
 * The pack's answer to the question this field is asking, with the
 * employer's name written back into it.
 *
 * The label and not `askedSubject`, because the pack is keyed on the
 * question a person read and answered on the Questions page. The
 * machine names folded into the subject differ per posting and would
 * make every employer's copy of one question a separate entry.
 */
function packedAnswer(context, field) {
  const asked = String(field?.label ?? "").trim() || operativeQuestion(field);
  if (!asked) return "";
  return fillCompany(packAnswer(context?.answerPack, asked, context?.company), context?.company);
}

/**
 * The judgement questions, and the one test that decides which of them may
 * be answered without the applicant.
 *
 * None of these is a fact a resume states. "Are you an athlete or esports
 * competitor who participates in games fantasy sports platforms offer
 * selections on" is a real required question on a real form, the model
 * rightly declines it, and declining costs the whole application - so the
 * question is not whether the answer is knowable, it is what being wrong
 * about it would cost.
 *
 * Three costs, and only the third is cheap enough:
 *
 *   A claim. An answer asserting the applicant holds, has done or is
 *     entitled to something - a licence, a clearance, a degree, a
 *     referral, employment at this company. Wrong here is a false
 *     statement that cannot be withdrawn, and an earlier fallback here
 *     claimed certifications the applicant does not hold. Never answered;
 *     the `sensitive` rules and `looksSensitive` already refuse these.
 *
 *   A regulated denial. Criminal history, immigration status, security
 *     clearance, professional licensing, protected-class identity. Saying
 *     no to these is a declaration a regulator or a background check reads
 *     rather than a field a recruiter corrects, and the harm from being
 *     wrong lands on the applicant. Also never answered - `profile.licenses`
 *     and the answer bank exist so the applicant can state them once.
 *
 *   An ordinary denial. The applicant is not an unusual thing, is not
 *     related to anyone here, and did not hear about this from an
 *     employee. Nothing is claimed, no regulator reads it, the employer
 *     re-checks anything that matters, and being wrong costs a correction.
 *     These are the ones below.
 *
 * Each entry only fires on a control that can hold a yes or a no, because
 * the answer to all of them is one word and a paragraph box asking for an
 * account of something is a different question wearing the same words.
 */
const JUDGEMENT_DEFAULTS = [
  {
    // PrizePicks and the other fantasy-sports boards have to screen out
    // people who can bet on their own results. Ten years of continuous
    // full-time software employment is the evidence against, a competitor
    // whose contests a sportsbook prices is a full-time occupation, and
    // the answer asserts no qualification of any kind.
    id: "athlete",
    pattern: /\b(?:professional |collegiate |amateur )?athlete\b|\besports?\b|\bfantasy sports\b|\bsportsbook\b|compete (?:professionally|in (?:contests|games))/,
    answer: "No",
  },
  {
    // "Are you related to, or in a personal relationship with, a current
    // employee?" An employer asks this to route a conflict check, not to
    // qualify anyone, and nothing about this applicant's record touches
    // any of these companies. A wrong no is corrected by the disclosure
    // the employer runs anyway.
    id: "relationship-to-employee",
    pattern: /\b(?:related to|relative of|family member|immediate family)\b[^|?]*\b(?:employee|staff|anyone (?:who )?works?)\b|personal relationship with[^|?]*\bemployee\b|\bnepotism\b/,
    answer: "No",
  },
  {
    /**
     * The same conflict screen asked about a household rather than an
     * employee: relatives, a spouse, a domestic partner, friends and
     * family, anyone under this roof who works there.
     *
     * The rule above wants the sentence to name an employee and reaches
     * "are you related to a current employee"; it does not reach "do you
     * have any relatives at this company", which names only the company,
     * nor "is your spouse employed by us", which names only a spouse. An
     * employer asks all three for one reason - to route a conflict check
     * - and the answer is the same each time, because the applicant has
     * no connection of any kind to any of these companies. Nothing is
     * claimed, and a wrong no is corrected by the disclosure the
     * employer runs regardless.
     *
     * Not "have you ever worked here", which is about the applicant
     * rather than their household and has its own rule and its own
     * evidence; the pattern needs one of the household words to fire.
     */
    id: "family-at-employer",
    pattern:
      /\b(?:relatives?|relations|spouses?|domestic partners?|households?|next of kin|friends? or family|family (?:or|and) friends?|family members?)\b[^|?]*\b(?:employ\w*|works?|worked|working|at (?:this|our|the) (?:company|organi\w*|firm)|with (?:this|our) (?:company|organi\w*)|here\b|for us\b)/,
    answer: "No",
  },
  {
    /**
     * "Do you know anyone who works at Smartsheet?" - the referral
     * question, asked without the word referral.
     *
     * The relationship rule above wants a relative and this wants an
     * acquaintance, so Smartsheet's wording reached neither, went to the
     * model as an open question, and parked a finished Greenhouse
     * application on a fact no profile could ever hold: the roster of
     * another company's staff. The answer is the same every time. These
     * postings come off a job feed, nobody here was introduced by anyone
     * inside, and a no claims nothing and costs a correction at worst.
     *
     * Not the channel question. "How did you hear about this role?" has
     * its own rule and an answer in the profile, and nothing here may
     * reach it - which is why a works-at or an employed-at has to be in
     * the sentence rather than the word "anyone" being enough.
     */
    id: "knows-an-employee",
    pattern:
      /\bknow (?:anyone|anybody|someone|somebody)\b[^|?]*\b(?:works?|working|employed|employee)\b|\b(?:any|personal) (?:connections?|contacts?|acquaintances?)\b[^|?]*\b(?:at|with|within|inside|to)\b|\b(?:friends?|family|relatives?)\b[^|?]*\bwho (?:currently )?works?\b/,
    answer: "No",
  },
  {
    // A financial interest in the employer or a competitor, asked as a
    // conflict screen. The applicant holds none that this system could
    // ever see, and the answer claims nothing.
    id: "financial-interest",
    pattern: /\bfinancial interest\b|\bownership interest\b|\bconflict of interest\b.*\b(?:with|in)\b/,
    answer: "No",
  },
  {
    // Where this application came from, which this system is the
    // authority on: a job feed, with no agency behind it. "Are you
    // represented by a recruiter or staffing agency for this role?"
    id: "agency-represented",
    pattern: /\b(?:represented by|working with|submitted by)\b[^|?]*\b(?:recruit(?:er|ing)|staffing|search firm|agency)\b|\bthird[- ]party (?:recruiter|agency)\b/,
    answer: "No",
  },
  {
    // The anti-bribery screen banks and exchanges put on every
    // application: whether the applicant holds public office, or is
    // closely related to somebody who does. Coinbase asks it four ways
    // and parked two finished applications on all four, because it is
    // not a fact any profile holds and the model would not invent one.
    //
    // It is the same shape as the conflict and financial-interest
    // screens above. An applicant who held office would be the one
    // person who had to correct it, and a correction costs a sentence
    // where silence costs the application.
    id: "government-official",
    pattern: /\b(?:government|public|state) official\b|\bpolitically exposed person\b|\bforeign official\b|\bholder of public office\b|\bcivil service position\b/,
    answer: "No",
  },
  {
    // Healthcare and federal contractors screen for exclusion from
    // Medicare, Medicaid and other funded programmes before anything
    // else. Being debarred is a published, individual sanction; its
    // absence is the ordinary state and is what this answers.
    id: "debarment",
    pattern: /\bdebarr?ed\b|\bexclusion list\b|\bOIG exclusion\b|\bsanctions? list\b|\b(?:excluded|ineligible)\b[^|?]*\b(?:federal|state|medicare|medicaid|government)[- ]?(?:funded |health ?care )?program/i,
    answer: "No",
  },
];

const judgementDefault = (field) => JUDGEMENT_DEFAULTS.find((entry) => entry.pattern.test(askedSubject(field)))?.answer ?? "";

/**
 * A question whose whole answer is a yes or a no, whether or not the
 * control admits it. Greenhouse renders some of these as a plain text box
 * with the question in the label, and the answer is the same word.
 */
const yesNoQuestion = (field) =>
  yesNoControl(field) ||
  (shortAnswer(field) && (field.options ?? []).length === 0 && !field.combobox && /^(?:are|do|does|did|have|has|is|was|were|will)\b/.test(operativeQuestion(field)));

const RULES = [
  /**
   * The applicant's own words, ahead of everything.
   *
   * Deliberately first and deliberately able to override any rule below:
   * a bank entry exists because the applicant looked at an answer this
   * file produced, or failed to produce, and said otherwise. A phrase
   * loose enough to collide with a rule that was working is the hazard,
   * and the three-character floor and the match being against the
   * question rather than the field's machine names are what keep it
   * narrow.
   */
  {
    id: "answer-bank",
    pattern: /./,
    when: (field, profile) => field.type !== "file" && Boolean(bankedAnswer(profile, field)),
    value: (p, _ctx, field) => bankedAnswer(p, field),
  },

  /**
   * The applicant's answers to questions they were actually asked.
   *
   * Second only to the bank, and for the same reason: both are the
   * applicant speaking. The difference is how the words got there. A
   * bank line is a rule written on purpose, phrase and all; a pack
   * entry is a question that parked an application, shown to them on
   * the Questions page, and answered there. One is configuration and
   * the other is a reply, so a bank line that collides with a pack
   * entry wins - it was written later and more deliberately.
   *
   * Matched on the question with the employer's name taken out, so an
   * answer given once covers every company that asks it. Nothing fuzzy:
   * see question-pack.js for why a near match is not allowed to answer
   * a real form.
   *
   * `answerFitsControl` is the one thing that can still reject a stored
   * answer. "No" typed against a yes/no menu is the same answer on the
   * next form; "No" against a paragraph box that wanted an explanation
   * is not, and that question goes back to being asked.
   */
  {
    id: "answer-pack",
    pattern: /./,
    when: (field, profile, context) =>
      field.type !== "file" && answerFitsControl(field, packedAnswer(context, field)) && Boolean(packedAnswer(context, field)),
    value: (_p, context, field) => packedAnswer(context, field),
  },

  // Documents.
  { id: "resume", pattern: /\bresume\b|\bcv\b/, attach: "resume", when: (field) => field.type === "file" },
  { id: "cover-letter", pattern: /cover letter/, attach: "cover", when: (field) => field.type === "file" },
  // The same letter, typed, where the box is a paragraph rather than an upload (Workable).
  { id: "cover-letter-text", pattern: /cover letter/, when: (field) => field.type === "textarea", value: (_p, ctx) => ctx.letter ?? "" },
  // The same career, pasted. A board that wants the résumé as text already
  // has the text - it is the document this application is attaching - so
  // there is nothing here for a model to decide. Asked as an open question
  // instead, this one was answered "Yes" and sent to DataCamp.
  {
    id: "resume-text",
    pattern: /(?:paste|copy)[^|?]*\b(?:resume|cv)\b|\b(?:resume|cv) (?:text|body|contents?)\b|\bfull resume\b/,
    when: (field) => field.type !== "file" && (field.options ?? []).length === 0,
    value: (_p, ctx) => ctx.resume ?? "",
  },
  // An account a board asks to create on the way - Rippling, Workable - gets
  // the one password every career-site account is made with.
  { id: "password", pattern: /\bpassword\b/, value: (p) => p.workdayPassword || "Vhkautmd1215!@#QWE123qwe" },

  // Identity.
  { id: "first-name", pattern: /\bfirst name\b|\bgiven name\b|^first$/, value: (p) => p.firstName },
  { id: "last-name", pattern: /\blast name\b|\bfamily name\b|\bsurname\b|^last$/, value: (p) => p.lastName },
  // Ashby asks the whole name in one box labelled "Name", id _systemfield_name.
  // A full name asked about somebody else is not this: "If you were referred
  // for this position, please provide the full name of the referrer" was
  // answered "Daniel Torres", which names the applicant as their own
  // referrer on a form that was about to be sent.
  {
    id: "full-name",
    pattern: /\bfull name\b|^name(?:\s*\||$)|systemfield name/,
    when: (field) => !/\breferr|\bemployee\b|\btheir\b|\breference\b|\bemergency\b|\bmanager\b|\bsupervisor\b/.test(haystack(field)),
    value: (p) => `${p.firstName} ${p.lastName}`.trim(),
  },
  { id: "employee-id", pattern: /^employee id\b/, onlyRequired:true, sensitive:true, value:()=>'' },
  { id: "email", pattern: /\be-?mail\b/, value: (p) => p.email },
  // Workday splits the phone across three boxes; only the number is the
  // number. The device type is a menu, and the extension is left blank.
  { id: "phone-type", pattern: /phone (?:device )?type|device type/, value: () => ["Mobile", "Cell", "Cellular", "Home", "Landline"] },
  // "Country Phone Code", "Country / Territory Phone Code", "Phone Code".
  { id: "country-code", pattern: /(?:country|territory)[^|]*?phone code|country code|phone (?:country )?code|dial(?:ing)? code|phone country/, value: () => US_PHONE_COUNTRY },
  // A bare "extension" is only the phone box when a phone is what is
  // being asked for. On its own it is also the word in "current work
  // authorization will expire with no option for extension/further
  // authorization", which is the sponsorship question, and blanking a
  // required field answered it with nothing and parked the application.
  {
    id: "phone-extension",
    pattern: /phone extension|\bextension\b|\bext\.?\b/,
    when: (field) => {
      const subject = askedSubject(field);
      return /\bphone\b|\btelephone\b|\bmobile\b|\btel\b/.test(subject) || /^ext(?:ension)?\b/.test(subject.trim());
    },
    value: () => "",
  },
  // Consent to be texted, which Ashby files under the "Phone" label as a
  // pair of yes/no choices. Reachable is the point of giving the number.
  {
    id: "phone-consent",
    pattern: /\bphone\b|\bmobile\b|\bsms\b|\btext message/,
    // Either the control offers consent as a choice, or the question asks
    // for it in words over a plain yes/no - DigiCert's ends "May we contact
    // you via text message?", and the phone rule below answered it with the
    // number.
    when: (field) =>
      (field.options ?? []).some((option) => /consent|agree|opt.?in/i.test(String(option.label ?? option.value ?? option))) ||
      /\bconsent\b|\bopt.?in\b|may we (?:contact|text|send|message)|do you (?:agree|consent)/.test(askedSubject(field)),
    value: () => ["Yes"],
  },
  // A phone box that offers choices is the country picker beside the
  // number; the number itself is always a US one, so the country is always
  // the United States.
  { id: "phone", pattern: /\bphone\b|\bmobile\b|\btelephone\b/, value: (p, _context, field) => (field?.options?.length > 0 ? US_PHONE_COUNTRY : p.phone) },
  // Name parts Workday asks for and the profile does not keep.
  { id: "middle-name", pattern: /middle (?:name|initial)/, value: () => "" },
  // A preferred name is left blank where the form will take a blank, since
  // the candidate has not said he goes by anything else. Where the form
  // insists - Workday marks it required on some tenants, and one parked an
  // application on it - the name he gave is the name he prefers, and
  // writing it is true in a way that leaving the application unsent is not.
  { id: "preferred-name", pattern: /preferred (?:first )?name|i have a preferred name/, value: (p, _ctx, field) => (field?.required ? p.firstName : "") },
  // The street, before the city rule sees the word "address". A box
  // labelled only "Address" is Workable's location autocomplete rather than
  // a mailing line, and the city and state is a true answer to it - which
  // is worth saying, because a required one of those was the whole of why
  // the Mindrift application stopped. "Address Line 1" is not that box and
  // stays empty rather than take a city, since a postal address with a town
  // on its street line is worse than a blank one.
  {
    id: "street",
    pattern: /address ?line ?1\b|addressline1|\bstreet(?: address)?\b|^address(?:\s*\||$)/,
    /**
     * "Will you now or in the future require Clear Street to sponsor an
     * employment visa on your behalf?" is not an address question, and it
     * parked a live application: the employer is named Clear Street, the
     * word is in the pattern, this rule claimed the field ahead of the
     * sponsorship rule that should have had it, and the profile keeps no
     * street, so a question with a stored answer was refused as
     * unanswerable. An address line is a label and never a sentence - the
     * same guard the country rule below needs, for the same reason.
     */
    when: (field) => normalise(field.label).length <= 40 || /address ?line ?\d|addressline\d/.test(normalise(field.label)),
    value: (p, _ctx, field) => p.street || (/^\s*(?:home |current |mailing )?address\s*$/i.test(String(field?.label ?? "").replace(/[*:]/g, "").trim()) ? [p.city, stateName(p.state)].filter(Boolean).join(", ") : ""),
  },
  { id: "address-2", pattern: /address ?line ?[2-9]\b|addressline[2-9]|\bapt\b|\bsuite\b|\bunit\b/, value: () => "" },
  { id: "zip", pattern: /\bzip\b|\bpostal(?: code)?\b|\bpostcode\b/, value: (p) => p.zip },
  {
    id: "country",
    pattern: /\bcountry\b/,
    // The word turns up inside other questions - "your authorization to work
    // in the country where you live" was answered "United States" - so this
    // only takes a field whose label is the word, more or less.
    when: (field) => normalise(field.label).length <= 40 || (shortAnswer(field) && /^(?:what|which) country (?:are you (?:currently )?(?:based|located|living|residing) in|do you (?:currently )?(?:live|reside|work) in)\s*[?*]*$/.test(normalise(field.label))),
    value: (p) => p.country,
  },
  // A state is asked for by a short label with no yes/no behind it. "Have you
  // been employed by a federal, state or local agency?" is not asking for one.
  {
    id: "state",
    pattern: /\bstate\b|\bprovince\b|\bregion\b/,
    when: (field) => String(field.label ?? "").length <= 60 && !(field.options ?? []).some((option) => /^(?:yes|no)\b/i.test(String(option.label ?? option.value ?? option))),
    // Both spellings, because the profile holds one and the board may want
    // the other. Workday's My Information menu lists states in full, the
    // profile held "TX" from a resume that writes addresses the way people
    // do, nothing matched, and the field fell through to a model that
    // picked the first entry on the list - so a real application went out
    // saying Alabama. Neither spelling is a guess: they name one state.
    value: (p) => [p.state, stateAlso(p.state)].filter(Boolean),
  },
  /**
   * Living here and allowed to work here, asked as one sentence.
   *
   * BetterHelp's "Are you located in and able to work in the US without
   * visa sponsorship for the next 5 years?" is three questions wearing one
   * label, and every rule that can reach it answers a different one of
   * them: proximity reads it as a commute, residence reads only the
   * address and would say yes to somebody who needs a visa, sponsorship
   * reads only the status and inverts it. So it is answered here, as the
   * conjunction it is, and only where the profile settles every part.
   *
   * Above the location rules because first match wins and all three of
   * them would otherwise take it.
   *
   * The five years is not decoration. A citizen and a permanent resident
   * hold a status with no end date and can answer for the span; a visa
   * holder cannot, and that case keeps parking rather than promising a
   * renewal. A recorded authorization the profile does not hold still
   * parks, because the question is sensitive and a guess here is a false
   * statement about the right to be employed.
   *
   * It only claims a question whose place the profile can actually be
   * settled against, which is what keeps it from reaching across the two
   * halves of a sentence that only has one question in it. "Are you
   * legally authorized to work in the country in which this role is
   * located?" names no place at all, and belongs to the authorization
   * rule exactly as it did before.
   */
  {
    id: "located-and-authorized",
    pattern: BEING_LOCATED,
    when: (field, profile) => {
      const question = askedSubject(field);
      return BEING_LOCATED.test(question) && BEING_ALLOWED_TO_WORK.test(question) && Boolean(placedIn(question, profile));
    },
    sensitive: true,
    value: (p, _ctx, field) => {
      const question = askedSubject(field);
      const here = placedIn(question, p);
      if (!here || !p.workAuthorization) return "";
      const sponsored = p.workAuthorization === "needs-sponsorship" || p.requiresSponsorship === "yes";
      if (here === "No" || sponsored) return "No";
      if (FUTURE_HORIZON.test(question) && !["us-citizen", "permanent-resident"].includes(p.workAuthorization)) return "";
      return "Yes";
    },
  },
  /**
   * Working from a named place, which is a different question from living
   * there: "are you able to work from our Austin office", "within
   * commuting distance of Boston".
   *
   * Two facts answer it and nothing else does. Already being there is a
   * yes. Not being there makes it a question about moving, which the
   * profile answers with the relocation setting - the same explicit
   * decision the relocation rule uses, not an inference.
   *
   * The remote preference is deliberately not consulted. Preferring remote
   * work says what someone wants, not where they can be, and a board
   * asking whether you can get to an office is asking the second.
   */
  {
    id: "onsite-proximity",
    pattern:
      /\b(?:able|willing|open|available|prepared) to (?:work (?:from|at|in|out of)|commute|be (?:based|located)|report)\b|\bcommuting distance\b|\bcommute to\b|\bwork (?:from|out of|at) (?:our|the)\b/,
    /**
     * Getting to an office, not the right to hold the job.
     *
     * "Are you located in and able to work in the US without visa
     * sponsorship for the next 5 years?" is this pattern's "able to work
     * in" and none of its subject. BetterHelp's question went here, the
     * proximity table holds cities and metros and has no reading of a
     * country, so the rule produced nothing - and being sensitive and
     * required, nothing held the application, on a question the profile
     * answers outright. Three of those in a quarter of an hour.
     */
    when: (field) => !/sponsor|authoriz|authoris|\bvisa\b|work permit|right to work|work (?:legally|lawfully)/.test(askedSubject(field)),
    sensitive: true,
    value: (p, _ctx, field) => {
      const here = proximityAnswer(field.label, p);
      if (here === "Yes") return "Yes";
      // Willing to move is a yes wherever the office turns out to be, which
      // is why it is checked before the place is: "our Boston office" names
      // somewhere this cannot place, and does not need to.
      if (p.willingToRelocate === "yes") return "Yes";
      if (here === "No") return "No";
      return "";
    },
  },
  {
    id: "city",
    // "From where do you intend to work" went to the model, which answered
    // with the city of the resume's last employer. Where the applicant works
    // from is a fact about the applicant, and the profile holds it.
    pattern:
      /\bcity\b|\blocation\b|\baddress\b|\bwhere are you (?:located|based)\b|where (?:do|will|would) you (?:intend|plan|expect) to work|where (?:will|would|do) you (?:be )?work(?:ing)? from|^from where/,
    // A box labelled just "City" (Workday's address form, with the state in
    // its own box) gets the city alone; anything broader gets "City, State".
    value: (p, _ctx, field) => (/^\s*(?:city|town|city\s*\/\s*town)\s*\*?\s*$/i.test(field?.label ?? "") ? p.city : `${p.city}, ${stateName(p.state)}`),
  },

  // The current job, as the attached resume states it. These went to the
  // model, which answered "Current Title" with a sentence about the title.
  // The resume's first entry is the answer and is already in hand.
  // "Why are you leaving your current role?" names the current role and is
  // not asking for it; a box that wants a title is a short box.
  { id: "current-title", pattern: /current (?:job )?title|current (?:role|position)|^(?:job )?title$|most recent (?:job )?title|\bheadline\b/, when: shortAnswer, value: (_p, ctx) => ctx.currentRole ?? "" },
  // Between contracts: the last one has ended, so there is no current
  // employer. "Most recent" is a different question and gets the resume's.
  { id: "current-company", pattern: /current (?:company|employer|organi[sz]ation)|^(?:company|employer)(?: name)?$/, when: shortAnswer, value: (_p, ctx) => ctx.currentlyEmployed ? ctx.currentCompany || "N/A" : "N/A" },
  { id: "recent-company", pattern: /most recent (?:company|employer)|last (?:company|employer)|previous (?:company|employer)/, when: shortAnswer, value: (_p, ctx) => ctx.currentCompany ?? "" },

  // Links. Twitter is deliberately absent: it is optional everywhere and
  // nothing in the profile answers it.
  // Given only where the form insists. An optional LinkedIn box is left
  // empty on every board: a profile is one more thing for a recruiter to
  // compare the resume against, and nothing is gained by volunteering it.
  // "Do you have a LinkedIn profile?" sits beside the box that wants the
  // address on more than one board, and offering an address to a two-entry
  // menu matches nothing - which blocked DigiCert on a question the profile
  // could answer. Whether there is one is the fact that control is asking.
  { id: "linkedin", pattern: /\blinkedin\b/, onlyRequired: true, value: (p, _ctx, field) => (yesNoControl(field) ? (p.linkedin ? "Yes" : "No") : profileLink(p.linkedin, "www.linkedin.com")) },
  { id: "github", pattern: /\bgithub\b|\bgit hub\b/, value: (p, _ctx, field) => (yesNoControl(field) ? (p.github ? "Yes" : "No") : profileLink(p.github, "github.com")) },
  { id: "website", pattern: /\bwebsite\b|\bportfolio\b|\bpersonal site\b|\bblog\b/, value: (p) => p.website },

  // Legal and screening. None of these may be guessed.
  // Willingness to move is a decision, not a fact to look up, so it comes from
  // its own setting rather than being inferred from the remote preference.
  { id: "relocation", pattern: /relocat|willing to move/, sensitive: true, value: (p) => yesNoAnswer(p.willingToRelocate) },
  // "Able to travel as required?" - annually to a headquarters, to an on-site
  // interview, to clients. Its own setting, since agreeing to a trip and
  // agreeing to move are different promises. The percentage variant ("what
  // percent of travel are you comfortable with") is a different question and
  // is left to the model with the rest of the open ones.
  {
    id: "travel",
    pattern: /\b(?:able|willing|available|open|comfortable) to travel\b|\btravel (?:as required|as needed|when required|when needed|occasionally|for (?:this|the) role)\b|\btravel requirement\b/,
    sensitive: true,
    value: (p) => yesNoAnswer(p.willingToTravel),
  },
  {
    id: "residence",
    pattern: /do you (?:currently )?(?:live|reside)|are you (?:a )?resident|are you (?:currently )?(?:located|based|living)/,
    sensitive: true,
    value: (p, _ctx, field) => {
      // Some ask about a named list of states, some about the country, some
      // about one metro. Which it is can only be read off the question,
      // because the list differs per company and exists nowhere else.
      const question = normalise(field.label);
      const yesNo = placedIn(question, p);

      // A menu may want the place rather than a yes: "are you based in any of
      // these countries?" over a list of countries. Which it is cannot be
      // known while the menu is closed, so both are offered, the yes or no
      // first, and the page takes whichever its entries match. "Do you reside
      // in the United States, Canada, or Mexico?" was being offered only the
      // country, against a menu of Yes and No.
      const choices = field.options.map((option) => normalise(option.label ?? option.value ?? ""));
      const yesNoMenu = choices.length > 0 && choices.every((choice) => /^(?:yes|no)\b/.test(choice));
      if ((field.combobox || choices.length > 0) && !yesNoMenu) {
        const places = [];
        if (/\bcountr(?:y|ies)\b/.test(question)) places.push(p.country);
        if (/\bstates?\b|\bprovinces?\b/.test(question)) places.push(stateName(p.state));
        const wordings = [yesNo, ...places].filter(Boolean);
        if (wordings.length > 0) return wordings;
      }
      // Without a place to name, a question about somewhere the profile
      // cannot settle stays unanswered.
      return yesNo;
    },
  },
  {
    id: "sponsorship",
    pattern: /sponsorship|sponsor(?:ed|ing)?\b|\bh-?1b\b/,
    // Read off the question rather than the whole label, because the
    // "authorized without sponsorship" wording turns up in the policy
    // paragraph above a question that is a plain sponsorship question and
    // flips the answer when it is read there.
    when: (field) => !AUTHORIZED_WITHOUT_SPONSORSHIP.test(askedSubject(field)),
    sensitive: true,
    value: (p) => yesNoAnswer(p.requiresSponsorship),
  },
  {
    id: "authorization",
    // "Eligible to work" is AlphaSense's wording and far from rare; it was
    // missing, and a required text box the profile could have answered was
    // left blank instead, which skipped the job.
    pattern:
      /authoriz|authoris|legally (?:able|entitled|permitted)|right to work|work permit|eligib\w* (?:to|for) (?:work|employ)|(?:work|employment) eligib|permitted to work|able to work in/,
    // "Authorization" is also the word a background-check consent uses for
    // the permission it is asking for - "asked to provide authorization
    // before any such checks are conducted" - and this rule answered one of
    // those with the candidate's citizenship. A box the applicant is
    // agreeing to is not a box stating their status.
    when: (field) => !/\bbackground (?:check|screen)\b|\bi (?:understand|acknowledge|agree|certify|consent)\b/.test(askedSubject(field)),
    sensitive: true,
    value: (p, _ctx, field) => {
      // Phrased as a yes/no far more often than as a status, and a status
      // answer offered to a yes/no field matches nothing.
      if (!p.workAuthorization) return "";
      const authorised = p.workAuthorization !== "needs-sponsorship";
      if (!field.options || field.options.length === 0) {
        // A menu that lists nothing until opened gets every wording; a plain
        // box gets the first of them, which is the yes or no.
        const wordings = AUTHORIZATION_WORDINGS[p.workAuthorization];
        if (!field.combobox || !wordings) return authorised ? "Yes" : "No";
        // "Are you authorized...?" leads with the yes or no; "choose the
        // option that describes your authorization" leads with the status.
        const yesNo = /^(?:are|do|can|will|is|have|would)\b/.test(normalise(field.label));
        return yesNo ? [authorised ? "Yes" : "No", ...wordings] : wordings;
      }
      const status = chooseOption(field.options, AUTHORIZATION_ANSWER[p.workAuthorization] ?? "");
      return status ? status.label || status.value : authorised ? "Yes" : "No";
    },
  },
  { id: "over-18", pattern: /\b18 years\b|\bat least 18\b|\bover 18\b|\bage of 18\b/, sensitive: true, value: (p) => yesNoAnswer(p.over18) },
  { id: "non-compete", pattern: /non[-\s]?compete|non[-\s]?solicit|restrictive covenant/, sensitive: true, value: (p) => yesNoAnswer(p.nonCompete) },
  /**
   * A government security clearance, answered from the applicant's own
   * standing statement.
   *
   * Before the background-check rule, because "clearance background
   * check" is this question wearing that one's words, and the consent
   * that rule reads is a different fact.
   *
   * The file's rule for a regulated denial is that the model never
   * writes one, and this keeps it - `sensitive`, so nothing falls back
   * to a guess. What makes it answerable is the same trade
   * `criminal-record` already makes: who holds the fact. A clearance is
   * granted by a government and cannot be created by claiming it, but
   * *not* holding one is a fact about the applicant, stated once in
   * `profile.securityClearance`, and answering from that is reading
   * their statement rather than inventing it.
   *
   * Only holding is answered. "Willing to obtain" and "eligible to
   * obtain" are deliberately out of reach: the first is a preference
   * nobody stated and the second turns on citizenship, and neither is
   * settled by the applicant saying they hold nothing today.
   */
  {
    id: "security-clearance",
    pattern: /\bsecurity clearance\b|\bclearance level\b|\b(?:active|current|existing|government|dod|federal)\s+clearance\b|\bclearance\b[^|?]*\b(?:held|hold|holding|possess)\w*\b|\bts\/sci\b|\btop secret\b|\bsecret clearance\b|\bpublic trust\b|\bpolygraph\b/,
    when: (field) => !/\b(?:willing|able|eligib\w*|open)\b[^|?]*\bto (?:obtain|get|acquire|apply|undergo|pursue|sponsor)\b|\bsponsor\w* (?:a |an )?(?:security )?clearance\b/.test(askedSubject(field)),
    sensitive: true,
    value: (p, _ctx, field) => {
      const held = String(p.securityClearance ?? "").trim();
      if (!held) return "";
      const none = /^(?:none|no|n\/a|not applicable|do(?:es)? ?n[o']t|i do not)\b/i.test(held);
      // "Do you hold one" wants the yes or no; "what level do you hold"
      // wants the level, and the word the form itself offers when there
      // is none to give.
      if (yesNoControl(field) || /^(?:do|does|did|have|has|are|is|will|would)\b/.test(operativeQuestion(field))) return none ? "No" : "Yes";
      return none ? "None" : held;
    },
  },
  {
    id: "background-check",
    pattern: /background (?:check|screen)|drug (?:test|screen)|pre-?employment screening/,
    sensitive: true,
    value: (p) => yesNoAnswer(p.backgroundCheck),
  },
  /**
   * Criminal history, answered from the applicant's own standing
   * statement and from nothing else.
   *
   * This is a regulated denial, and the file's rule for those is that
   * the model never writes one: the harm from a wrong answer lands on
   * the applicant, and a resume showing no convictions is not a record
   * showing none. What makes this answerable where a clearance is not is
   * who holds the fact. A clearance is granted by a government and the
   * applicant cannot create one by saying so; a criminal record is a
   * fact about the applicant, stated once in `profile.criminalRecord`,
   * and answering from it is reading their statement rather than
   * guessing at it - the same trade `profile.licenses` already makes.
   *
   * So the profile still decides. Empty parks the question exactly as
   * before, and `disclose` parks it too: a record that exists is a
   * sentence only the applicant may write, and "yes" alone on a form
   * that then asks for the circumstances is worse than a person
   * answering both. Only a stated "none" produces an answer here.
   *
   * `sensitive` regardless, so no model fallback can reach around a
   * profile that says nothing.
   */
  {
    id: "criminal-record",
    pattern:
      /\b(?:convict\w*|felony|felonies|misdemean\w*|criminal (?:record|histor\w*|offen\w*|conviction\w*|background|charge\w*|case\w*|proceeding\w*)|plead(?:ed|s)? (?:guilty|no contest)|nolo contendere|under indictment|indicted|incarcerat\w*)\b/,
    // A consent to run a criminal background check is a different
    // question with its own profile answer, and it must keep it.
    when: (field) => !/background (?:check|screen)|drug (?:test|screen)|pre-?employment screening/.test(askedSubject(field)),
    sensitive: true,
    value: (p) => (String(p.criminalRecord ?? "").trim().toLowerCase() === "none" ? "No" : ""),
  },
  {
    id: "previous-employment",
    // "Previously worked in a remote environment?" is not this question; the
    // guard keeps it to working for this employer.
    // Hospitals ask about every prior tie, not only paid employment:
    // HonorHealth's "externship/practicum/clinical rotation or ever
    // volunteered" is the previous-employment question wearing the words
    // a teaching hospital uses, and it parked a finished application.
    // A bare "internship" is not among them on purpose: Discord asks for
    // "a time a metric moved unexpectedly - in a job, internship,
    // research project" and that is an essay question, not a tie to this
    // employer.
    pattern: /(?:previously|ever) (?:worked|been employed|volunteered|interned)|former employee|worked (?:here|for us|at this company)|current or former employee|\b(?:are|were) you (?:currently |previously |ever )?an employee of\b|\b(?:externship|practicum|clinical rotation)\b|\bvolunteered\b[^|?]*\b(?:at|with|for)\b/,
    // The guard words are how "worked in a remote environment" is kept
    // out, and they also sit inside the commonest wording of the
    // question itself - "worked for hims & hers as an employee or
    // contractor", "worked for Clear Street as a full-time employee" -
    // which parked both of those applications on a question whose answer
    // is in the profile. A sentence that names the employer is this
    // question whatever else it says; the guard is for the ones that
    // name nobody.
    when: (field, _profile, context) =>
      namesEmployer(field.label, context?.company) ||
      !/\b(?:remote|hybrid|environment|industry|startup|team|role of|as an?|with)\b/i.test(field.label ?? ""),
    sensitive: true,
    value: (p, ctx) => (workedAt(ctx.company, p) ? "Yes" : "No"),
  },
  /**
   * Professional licences and certifications, which only the applicant
   * can state.
   *
   * Clear Street asks whether any securities industry licence is or has
   * ever been held, and then asks for the list "or say None", and both
   * parked a finished application. The answer is one word and the
   * temptation is to read it off the resume having no certifications on
   * it - but a resume is what the candidate chose to show, not a
   * register, and a licence denied to a broker-dealer is a declaration
   * that goes to a regulator. So this is `sensitive`: with
   * `profile.licenses` empty the question still stops the application,
   * and one word in that field answers this class of question
   * everywhere.
   */
  {
    id: "licenses",
    pattern: /\blicen[sc]es?\b|\bcertificat(?:ion|e)s?\b|\bfinra\b|\bnasaa\b|\bcftc\b|\bnfa\b|\bseries \d{1,2}\b/,
    // A driving licence is about getting to work and a software licence
    // is about the employer; neither is a credential this answers.
    when: (field) => !/\bdriver'?s?\b|\bdriving\b|\bcdl\b|\bvehicle\b|software licen|\blicense (?:agreement|key)\b/.test(askedSubject(field)),
    sensitive: true,
    value: (p, _ctx, field) => {
      const held = String(p.licenses ?? "").trim();
      if (!held) return "";
      const none = /^(?:none|no|n\/a|not applicable)\.?$/i.test(held);
      // "Do you hold..." wants the yes or no; "provide a list of..."
      // wants the list, and the word the question itself asked for when
      // there is nothing to list.
      if (yesNoControl(field) || /^(?:do|does|did|have|has|are|is)\b/.test(operativeQuestion(field))) return none ? "No" : "Yes";
      return none ? "None" : held;
    },
  },

  // Demographic questions.
  { id: "pronouns", pattern: /\bpronouns?\b/, sensitive: true, value: (p) => p.pronouns || (isPronounAnswer(p.gender) ? p.gender : '') },
  // Before gender, because "gender identity: do you identify as transgender?"
  // contains the word gender and is a different question.
  { id: "transgender", pattern: /\btransgender\b|\btrans\b/, sensitive: true, value: (p) => (p.transgender === "yes" ? "Yes" : p.transgender === "no" ? "No" : "decline") },
  { id: "sexual-orientation", pattern: /sexual orientation|\borientation\b|\blgbtq?/, sensitive: true, value: (p) => p.sexualOrientation || "decline" },
  { id: "gender", pattern: /\bgender\b|\bsex\b/, sensitive: true, value: (p) => p.gender },
  // "Are you Hispanic/Latino?" is its own yes/no on most boards, asked
  // beside the race menu rather than as part of it. Answered on its own
  // before the race rule sees it, which answered "Asian" to a menu of yes,
  // no and decline.
  { id: "hispanic", pattern: /\bhispanic\b|\blatino\b|\blatinx\b/, sensitive: true, value: (p) => (p.hispanic === "yes" ? "Yes" : p.hispanic === "decline" ? "Decline" : "No") },
  { id: "race", pattern: /\brace\b|\bethnic/, sensitive: true, value: (p) => p.race },
  { id: "veteran", pattern: /\bveteran\b|\bmilitary\b|\bprotected vet/, sensitive: true, value: (p) => p.veteran },
  // A signature's date, beside the name on an EEOC disability form. Before
  // the disability rule: the box's own name is "eeoc_disability_date".
  { id: "date", pattern: /^(?:today'?s )?date\s*(?:\||$)|\bdate signed\b|signature date|date of signature|disability date\b/, value: () => new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }) },
  { id: "disability", pattern: /\bdisabilit|\bdisabled\b/, sensitive: true, value: (p) => p.disability },
  // Ashby's own survey: "which communities do you belong to?" over a list
  // of disability, veteran, parent, refugee; and an age bracket.
  { id: "communities", pattern: /communities do you belong|underrepresented group|member of any of the following/, sensitive: true, value: () => ["None of the above", "I prefer not to answer", "Prefer not to say", "decline"] },
  { id: "age", pattern: /\byour (?:current )?age\b|\bage (?:range|bracket|group)\b/, sensitive: true, value: () => ["I prefer not to answer", "Prefer not to say", "decline"] },

  // "How many years with Vue.js?" "Rate your proficiency in SQL." Answered
  // with one number from the profile for every tool asked about, placed on
  // whatever scale the control offers: typed into a box, or the band it
  // falls in - "7-10", "8", "Advanced" - picked off a menu. Not a question
  // for the model, which answered 0-1 off a resume that happened not to name
  // the tool. Text areas are left out: "describe your experience with X"
  // wants prose.
  {
    id: "tech-experience",
    pattern: /how many years|years of (?:experience|hands-on|professional)|\byears\b.*\b(?:experience|using|with)\b|rate your|self-?rate|proficien|skill level|level of (?:experience|expertise|proficiency)|how (?:proficient|experienced|comfortable|familiar)|experience level/,
    // Not a yes/no menu. "Do you meet the required years of experience for
    // this role?" matches every reading of this pattern and is not asking
    // for a number: a nine aimed at a menu offering Yes and No matches
    // nothing, and the rule having fired is what stopped the question
    // reaching anything that could answer it. A board that wants the count
    // offers counts; one that wants the judgement offers two words.
    when: (field) => field.tag !== "textarea" && !yesNoControl(field),
    value: (p) => [String(p.techYears ?? 0), `${p.techYears ?? 0} years`, `${p.techYears ?? 0}+ years`],
    pick: (p) => Number(p.techYears) || 0,
  },

  // The education block: School, Degree, Discipline, and start/end month
  // and year, under ids like school--0 and start-year--0 (which arrive here
  // as "school 0", "start year 0"). Answered from the education on the
  // resume that was just written, so the dates agree with the degree on it.
  // A start date here answered "two weeks from now" sent one form back with
  // "End date must be after start date".
  { id: "education-school", pattern: /\bschool \d+$|\buniversity\b|\binstitution\b|school name/, value: (p, ctx) => schooling(ctx, p).school },
  {
    id: "education-degree",
    pattern: /\bdegree \d+$|\bdegree\b|highest (?:completed )?(?:level of )?education|education level|level of education/,
    value: (p, ctx) => schooling(ctx, p).degreeWordings,
  },
  { id: "education-discipline", pattern: /\bdiscipline \d+$|\bdiscipline\b|\bmajor\b|field of study|area of study/, value: (p, ctx) => schooling(ctx, p).majorWordings },
  { id: "education-start-month", pattern: /\bstart month \d+$/, value: (p, ctx) => schooling(ctx, p).startMonths },
  { id: "education-start-year", pattern: /\bstart year \d+$/, value: (p, ctx) => schooling(ctx, p).startYear },
  { id: "education-end-month", pattern: /\bend month \d+$/, value: (p, ctx) => schooling(ctx, p).endMonths },
  { id: "education-end-year", pattern: /\bend year \d+$/, value: (p, ctx) => schooling(ctx, p).endYear },

  // Logistics.
  // "availability" alone is also a word in questions about systems; a
  // paragraph box asking to describe something is never asking for a date.
  { id: "start-date", pattern: /start date|when (?:can|could) you start|\byour availability|availability (?:to start|date)|available to start|notice period|earliest/, when: shortAnswer, value: (p) => p.startDate },
  // The date beside a signature - Workday's self-identification form has
  // "Name", "Employee ID", "Date" - is today. The model guessed one.
  {
    id: "signed-today",
    pattern: /^(?:today'?s )?date\s*(?:\||$)|\bdate ?signed\b|\bsignature date\b|\bdate of (?:signature|application|submission)\b/,
    when: (field) => !/birth|\bdob\b|start|graduat|hire|employ/i.test(field.label ?? ""),
    value: () => {
      const now = new Date();
      return `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
    },
  },
  // A signature box wants the name, typed.
  { id: "signature", pattern: /\bsignature\b|\b(?:type|enter) your (?:full )?name\b|\bname \(?(?:as|for) (?:a |your )?signature/, when: (field) => field.type !== "file" && !/date/i.test(field.label ?? ""), value: (p) => `${p.firstName} ${p.lastName}`.trim() },
  /**
   * "Did you hear about this opportunity from a current DailyPay employee?"
   *
   * The how-heard rule below deliberately refuses these, because they are a
   * yes or no about a person rather than a menu of channels - and what they
   * were refused to was the model, which has no saved fact about DailyPay's
   * staff and correctly declined, parking the application. But there is a
   * fact here, and it is one this system is the authority on: the posting
   * was found on a job feed and nobody referred it. Whether the candidate
   * happens to know somebody there is a different question and is not
   * answered; this is only about where this application came from, which is
   * why the pattern insists on the referral itself and the control has to
   * be offering two words before it fires.
   */
  {
    id: "employee-referral",
    pattern: /(?:hear|learn|find out) about (?:this|the|our)[^|]*\bfrom\b[^|]*\b(?:employee|team member|someone who works)\b|\b(?:were|are) you referred\b|\breferred (?:to (?:us|this)|by)\b.*\bemployee\b|\bemployee referr?al\b|\b(?:did|has|have)\b[^|?]*\b(?:employee|team member|anyone (?:here|at)|someone (?:here|at))\b[^|?]*\brefer\b/,
    when: (field) => yesNoControl(field),
    value: () => "No",
  },
  {
    id: "how-heard",
    // "Where did you first hear about this role?" went to the model, which
    // rightly had nothing to say; the "first" is what the old pattern missed.
    pattern:
      /(?:how|where) did you (?:first |originally )?(?:hear|find|learn)|hear about (?:this|the|our) (?:role|job|position|opening|opportunity)|referr?al source|how were you referred|\bsource of (?:application|referral)\b|which (?:job )?board|(?:job )?board brought you|brought you to/,
    /**
     * Not every question containing "hear about this role" is asking which
     * channel. "Did you hear about this opportunity from a current DailyPay
     * employee?" is a yes or no about a person, and this rule answered it
     * with "Company website", which matched nothing on a two-button control
     * and stopped the application.
     *
     * Two things separate them, and both are read off the field rather than
     * guessed. A channel question is never a yes/no - there is no menu of
     * sources that offers only those two - and it is phrased as "how" or
     * "where", not "did".
     */
    when: (field) => {
      const choices = (field.options ?? []).map((option) => normalise(option.label ?? option.value ?? ""));
      if (choices.length > 0 && choices.every((choice) => /^(?:yes|no)\b/.test(choice))) return false;
      return !/^did you\b/.test(normalise(field.label));
    },
    // The profile's answer, then the ways a menu might word it. Workday
    // tenants file sources under categories - "Search Engine" holding
    // "Google", "Job Board" holding "LinkedIn" - so the category comes
    // right after the thing itself.
    value: (p, _ctx, field) => (field.combobox || field.options?.length > 0 ? [p.howHeard, ...HOW_HEARD_WORDINGS.filter((w) => w !== p.howHeard)] : p.howHeard),
  },
  { id: "remote", pattern: /\bremote\b|\bhybrid\b|\bon-?site\b|work (?:location )?preference/, when: (field) => !/\bhave you\b|\bdid you\b|\bexperience\b/i.test(field.label ?? ""), value: (p) => p.remotePreference },
  // A box that only takes an address - "work samples", "anything else you
  // would like to share" - gets the best address there is.
  /**
   * The ordinary denials. See JUDGEMENT_DEFAULTS above for which
   * questions are in here and, more to the point, which are not.
   *
   * Last of the question rules on purpose: every rule that knows what it
   * is looking at has already had its turn, so this can only reach a
   * question nothing else claimed.
   */
  {
    id: "judgement-default",
    pattern: new RegExp(JUDGEMENT_DEFAULTS.map((entry) => entry.pattern.source).join("|")),
    when: (field) => yesNoQuestion(field) && Boolean(judgementDefault(field)),
    value: (_p, _ctx, field) => judgementDefault(field),
  },
  { id: "any-url", pattern: /./, when: (field) => field.type === "url", onlyRequired: true, value: (p) => p.website || p.github || p.linkedin },

  // Consent. Not a question with an answer so much as a box the form will not
  // send without, and refusing it is identical to not applying.
  {
    id: "acknowledgement",
    // The label is normalised before matching, so "double-check" arrives as
    // "double check".
    pattern: /acknowledge|i agree|consent|privacy (?:notice|policy|statement)|have read|double[\s-]?check|certify|confirm that|i understand|\bgdpr\b|data protection|personal data|terms (?:and|&) conditions|i (?:willingly )?accept/,
    // Such a menu often has one entry - "Acknowledge/Confirm", "I have
    // reviewed and confirmed..." - and that entry is the answer whatever it
    // says, since the alternative is not applying.
    sole: true,
    value: (p, _ctx, field) => {
      const affirmative = chooseOption(field.options ?? [], "yes") ?? chooseOption(field.options ?? [], "i acknowledge");
      return affirmative ? affirmative.label || affirmative.value : "Yes";
    },
  },
];

/** The month a date like "Aug 2011" names, written out and abbreviated. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthWordings(value) {
  const index = MONTHS.findIndex((month) => new RegExp(`\\b${month.slice(0, 3)}`, "i").test(String(value ?? "")));
  if (index < 0) return null;
  return [...new Set([MONTHS[index], MONTHS[index].slice(0, 3)])];
}

/**
 * The education on the resume, in the shapes forms ask for it.
 *
 * The resume holds one line - "Bachelor of Science in Computer Science",
 * the school, the graduation year. Forms want the degree as a menu entry
 * ("Bachelor's of Science (B.S)"), the major on its own, and a start year
 * the resume never states: four years before the end for a bachelor's,
 * two for a master's, five for a doctorate.
 *
 * The profile stands behind the resume rather than beside it. A degree is
 * the one part of a career that does not change between applications, and
 * a posting whose generated resume came back without an education section
 * used to park a required School or Degree box on a fact that has been the
 * same on every resume ever written here. Where the profile also states
 * the two dates, they are used in place of the guessed span: a graduation
 * year minus four is a guess that goes out on a form, and "Aug 2011" is
 * not.
 */
function schooling(context, profile = {}) {
  const resume = context?.education ?? {};
  const education = {
    degree: String(resume.degree ?? "").trim() || String(profile.educationDegree ?? "").trim(),
    school: String(resume.school ?? "").trim() || String(profile.educationSchool ?? "").trim(),
    year: String(resume.year ?? "").trim() || String(profile.educationEnd ?? "").trim(),
  };
  const degree = education.degree;
  const lower = degree.toLowerCase();
  const endYear = Number((String(education.year ?? "").match(/(?:19|20)\d\d/g) ?? []).pop()) || 0;
  // Only when the profile is also what supplied the end year, or a resume
  // naming a different school would be dated from somebody else's degree.
  const stated = education.year === String(profile.educationEnd ?? "").trim() ? profile : {};
  const statedStart = Number((String(stated.educationStart ?? "").match(/(?:19|20)\d\d/g) ?? []).pop()) || 0;

  let degreeWordings;
  let span;
  if (/\b(?:ph\.?d|doctor)/.test(lower)) {
    degreeWordings = ["Doctorate (PhD)", "Doctor of Philosophy (Ph.D)", "PhD", "Ph.D", "Doctorate", "Doctoral"];
    span = 5;
  } else if (/\b(?:master|m\.?s\.?\b|m\.?sc|mba|m\.?eng)/.test(lower)) {
    degreeWordings = ["Master's of Science (M.S)", "Master of Science (M.S)", "Master's Degree", "Master's", "Masters", "Master"];
    span = 2;
  } else if (/\b(?:associate|a\.?s\.?\b|a\.?a\.?\b)/.test(lower)) {
    degreeWordings = ["Associates of Science (A.S)", "Associate of Science (A.S)", "Associate's Degree", "Associates", "Associate"];
    span = 2;
  } else {
    degreeWordings = ["Bachelor's of Science (B.S)", "Bachelor of Science (B.S)", "Bachelor's Degree", "Bachelor's", "Bachelors", "Bachelor"];
    span = 4;
  }
  if (/\barts?\b|b\.?a\.?\b|m\.?a\.?\b/.test(lower) && !/science/.test(lower)) {
    degreeWordings = degreeWordings.map((wording) => wording.replace("Science (B.S)", "Arts (B.A)").replace("Science (M.S)", "Arts (M.A)").replace("Science (A.S)", "Arts (A.A)"));
  }

  // "Bachelor of Science in Computer Science": what follows "in", or
  // failing that "of" ("Bachelor of Computer Science").
  const major = (degree.match(/\bin\s+([A-Za-z&/ ,-]+?)(?:\s*[(,]|$)/)?.[1] ?? degree.match(/\bof\s+([A-Za-z&/ ,-]+?)(?:\s*[(,]|$)/)?.[1] ?? "").trim();
  const majorWordings = [...new Set([major, "Computer Science", "Computer Engineering", "Software Engineering", "Engineering", "Information Technology"].filter(Boolean))];

  return {
    school: education.school,
    degreeWordings,
    majorWordings,
    // The usual American academic year, unless the profile said otherwise.
    startMonths: monthWordings(stated.educationStart) ?? ["September", "Sep", "August"],
    endMonths: monthWordings(stated.educationEnd) ?? ["May", "June", "Jun"],
    startYear: statedStart ? String(statedStart) : endYear ? String(endYear - span) : "",
    endYear: endYear ? String(endYear) : "",
  };
}

/**
 * A profile link in the one form every board accepts. Workday refuses
 * "linkedin.com/in/x" and "https://linkedin.com/in/x" alike; it wants the
 * scheme and the www host. A bare handle is taken as a path on that host.
 */
export function profileLink(value, host) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const bare = host.replace(/^www\./, "");
  const match = raw.match(new RegExp(`^(?:https?://)?(?:[a-z]{2,3}\\.)?(?:www\\.)?${bare.replace(/\./g, "\\.")}(/.*)?$`, "i"));
  if (match) {
    const path = (match[1] ?? "").replace(/\/+$/, "");
    // A LinkedIn profile lives under /in/, and a slug written straight
    // after the host - "linkedin.com/danieltorres8483", which is how people
    // write it from memory - is a 404 to the recruiter who clicks it. The
    // other sections the host serves are left alone.
    if (bare.includes("linkedin") && path && !/^\/(?:in|pub|company|school|showcase)\//i.test(path)) {
      return `https://${host}/in/${path.replace(/^\/+/, "")}`;
    }
    return `https://${host}${path}`;
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.includes("/") && !raw.includes(".")) return `https://${host}/${bare.includes("linkedin") ? "in/" : ""}${raw.replace(/^@/, "")}`;
  return `https://${raw.replace(/^\/+/, "")}`;
}

/**
 * Resolves one field against the profile and the job.
 *
 * `field` is what the page reported: label, name, id, type, required, options.
 */
export function resolveField(field, profile, context) {
  if (field.type === "hidden" || field.type === "submit" || field.type === "button") {
    return { outcome: "ignore" };
  }

  if(field.purpose==='display-language'){
    if(field.current&&!/^select\b/i.test(field.current))return {outcome:'skip',reason:'The form display language is already selected.'};
    return {outcome:'fill',rule:'form-display-language',value:'English',candidates:['English']};
  }

  const subject = haystack(field);
  if (isCompensationQuestion(subject)) {
    if (!hasCompensationResearch(context.compensation)) {
      // Research first, the applicant's own range second, a person
      // third. The order is the point: a figure calibrated to this
      // employer is better than a standing one, but a standing one the
      // applicant wrote down is far better than a filled application
      // stopping on the last box.
      const stated = statedCompensationAnswer(field, profile);
      if (stated) return {outcome:'fill',rule:'salary-stated',value:stated,candidates:[stated]};
      return {outcome:field.required ? 'blocked' : 'skip',rule:'salary-research',reason:'This compensation field needs cited company/role web research, and no salary range is set in the profile.'};
    }
    return {outcome:'ask',question:field.label || field.name || field.id,options:field.options || [],compensation:true};
  }
  const matches = (entry) => entry.pattern.test(subject) && (!entry.when || entry.when(field, profile, context));
  let rule = RULES.find(matches);
  // A question about the applicant's own demographics is answered from the
  // profile's demographic facts, whatever else in the list happens to match
  // its wording first. "Do you live with a disability (as outlined by the
  // ADA)?" was read by the residence rule as a question about where the
  // applicant lives, so it asked a profile that holds no such place and
  // parked four finished applications over an answer it already had.
  if (rule && !DEMOGRAPHIC_RULES.has(rule.id) && isDemographicQuestion(subject)) {
    rule = RULES.find((entry) => DEMOGRAPHIC_RULES.has(entry.id) && matches(entry)) ?? rule;
  }

  // The same precedence for a tie to the employer, and for the same kind
  // of collision. These questions say the company's name, company names
  // are made of ordinary words, and a rule keyed on one of those words
  // gets there first: "Have you ever worked at Clear Street?" was read
  // by the street-address rule, which asked the profile for a street and
  // parked the application when the answer was not one. The question is
  // about a tie to this employer however the employer is spelled.
  if (rule && !EMPLOYER_TIE_RULES.has(rule.id) && asksEmployerTie(subject)) {
    rule = RULES.find((entry) => EMPLOYER_TIE_RULES.has(entry.id) && matches(entry)) ?? rule;
  }

  if (rule && rule.attach) {
    return { outcome: "attach", document: rule.attach, rule: rule.id };
  }

  if (rule && rule.onlyRequired && !field.required) {
    // Already holding a value - Workday carries the candidate's profile
    // from one application to the next - it is emptied, since the point is
    // that it goes unanswered.
    const held = String(field.current ?? "").trim();
    if (held && (field.type === "text" || field.type === "url")) {
      return { outcome: "fill", rule: rule.id, value: "", candidates: [""], cleared: true };
    }
    return { outcome: "skip", rule: rule.id, reason: "optional, and left empty on purpose" };
  }

  if (rule) {
    // A rule answers with one wording, or with several in preference order
    // for a menu whose entries it cannot see.
    const rawAnswer = rule.value(profile, context, field);
    const answer = DEMOGRAPHIC_RULES.has(rule.id) ? demographicWordings(rule.id, rawAnswer,profile) : rawAnswer;
    const wordings = Array.isArray(answer) ? answer.map((entry) => String(entry ?? "").trim()).filter(Boolean) : null;
    const wanted = wordings ? (wordings[0] ?? "") : String(answer ?? "").trim();

    if (!wanted) {
      // A sensitive question with no answer behind it is the one case that must
      // stop the run rather than be improvised or quietly left out.
      if (rule.sensitive && field.required) {
        return { outcome: "blocked", rule: rule.id, reason: `"${field.label}" needs an answer the profile does not hold` };
      }
      if (field.required) {
        return { outcome: "blocked", rule: rule.id, reason: `"${field.label}" is required and the profile is empty for it` };
      }
      return { outcome: "skip", rule: rule.id, reason: "nothing in the profile for an optional field" };
    }

    // Several wordings are used as given, not expanded: expanding "Yes" into
    // "I am" would let it match the first entry of any status menu.
    const candidates = wordings ? [...new Set(wordings)] : expand(wanted);
    const replace = DEMOGRAPHIC_RULES.has(rule.id) ? {replace:true} : {};

    // A plain `<select>` lists its options up front, so a mismatch is knowable
    // now and worth refusing over. A react-select does not - its menu exists
    // only while open - so the wordings go to the page and the verify pass
    // afterwards is what catches a miss.
    const pick = typeof rule.pick === "function" ? rule.pick(profile, context, field) : null;
    const picking = Number.isFinite(pick) ? { pick } : {};

    if (field.options && field.options.length > 0) {
      const option = replace.replace ? chooseDemographicOption(field.options,candidates) :
        (wordings ?? [wanted]).map((wording) => chooseOption(field.options, wording)).find(Boolean) ??
        (picking.pick !== undefined ? pickOption(field.options, picking.pick) : null);
      if (!option) {
        if (field.required) {
          return {
            outcome: "blocked",
            rule: rule.id,
            reason: `"${field.label}" offers no option matching "${wanted}"`,
          };
        }
        return { outcome: "skip", rule: rule.id, reason: `no option matching "${wanted}"` };
      }
      return { outcome: "fill", value: option.value ?? option.label, candidates: [option.label || option.value], rule: rule.id, ...replace };
    }

    return { outcome: "fill", value: wanted, candidates, rule: rule.id, ...replace, ...(rule.sole ? { sole: true } : {}), ...picking };
  }

  // Nothing matched. Whether the model may try depends on what is being asked.
  if (looksSensitive(subject)) {
    return field.required
      ? { outcome: "blocked", reason: `"${field.label}" reads as a legal or demographic question with no profile answer` }
      : { outcome: "skip", reason: "unmatched question that the model may not answer" };
  }

  if (field.type === "file") {
    return field.required
      ? { outcome: "blocked", reason: `"${field.label}" wants a document that is not the resume or the cover letter` }
      : { outcome: "skip", reason: "an optional upload with nothing to put in it" };
  }

  return { outcome: "ask", question: field.label || field.name || field.id, options: field.options ?? [] };
}

/**
 * A backstop for questions the rules did not name.
 *
 * The rule list is written against the forms that have been seen; this catches
 * the phrasings that have not been. It errs toward refusing, because the cost
 * of a model answering a demographic question wrongly is far higher than the
 * cost of skipping a job.
 */
// Clearance is here rather than left to the model because the model is
// reading a resume full of defence and federal contractors, and "must be
// able to obtain a Public Trust" sitting in the description is one short
// step from an answer claiming one. A clearance is granted by a government
// and either exists or does not; nothing in a resume establishes it, and
// claiming one that was never granted is the single worst answer this
// system could produce. It parks until `profile.answerBank` says otherwise.
function looksSensitive(subject) {
  return /\bveteran\b|\bdisabilit|\brace\b|\bethnic|\bgender\b|\bhispanic\b|sponsorship|authoriz|authoris|\bvisa\b|\bcitizen|\bfelony\b|\bconvict|background check|drug (?:test|screen)|\bsalary history\b|\bdate of birth\b|\bssn\b|social security|\bclearance\b|\bpolygraph\b|public trust/.test(
    subject,
  );
}

/** The clause a conditional follow-up ends with, naming what to write instead. */
const FOLLOW_UP_FALLBACK =
  /\bif\s+(?:you\s+(?:did\s*n[o']?t|have\s*n[o']?t|do\s*n[o']?t|didn't|haven't|don't)\s+(?:select|choose|pick|answer)|(?:this\s+is\s+)?not\s+applicable|none\s+(?:of\s+the\s+above\s+)?appl\w*|you\s+(?:do\s*n[o']?t|don't)\s+have\s+any|there\s+are\s+none)[^.?!]*?\b(?:please\s+)?(?:write|enter|put|type|answer|respond(?:\s+with)?|say|state|indicate|input)\s+["“'‘]?(n\s*\/\s*a\.?|na|none|not applicable|no)["”'’.]?/i;

/**
 * A follow-up that is only a question when an earlier answer picked the
 * thing it is about - and that says, in its own words, what to write when
 * nothing picked it.
 *
 * Clear Street's form asks how you heard about the role and then: "If you
 * selected "Clear Street Employee" or "Other" please let us know the name
 * of the employee ... If you did not select "Clear Street Employee" or
 * "Other" please write N/A." Read as an ordinary open question that is a
 * fact about this employer's staff, which no stored fact answers, and it
 * parked a finished application. Read as what it is, the form has already
 * supplied the answer.
 *
 * The condition is the whole of the safety. The quoted terms are the
 * trigger, and the fallback is only written when nothing else on this form
 * is going to select one of them - including a question still on its way
 * to the model, whose options are checked rather than its answer, because
 * the answer does not exist yet. A follow-up naming no trigger at all
 * ("if not applicable, enter N/A") is unconditional and always safe.
 */
function statedFallback(field, resolved) {
  if (!field.required) return "";
  const label = String(field.label ?? "");
  const said = FOLLOW_UP_FALLBACK.exec(label)?.[1];
  if (!said) return "";
  const word = normalise(said).replace(/\.$/, "").replace(/\s+/g, "");
  const literal = word === "n/a" || word === "na" ? "N/A" : word === "none" ? "None" : word === "notapplicable" ? "Not applicable" : word === "no" ? "No" : "";
  if (!literal) return "";

  const triggers = [...label.matchAll(/["“'‘]([^"”'’\n]{2,60})["”'’]/g)].map((match) => normalise(match[1])).filter((trigger) => trigger && trigger !== normalise(literal));
  if (triggers.length === 0) return literal;

  for (const other of resolved) {
    if (other.field === field) continue;
    const reachable =
      other.result.outcome === "fill" ? [other.result.value, ...(other.result.candidates ?? [])] :
      other.result.outcome === "ask" ? (other.field.options ?? []).map((option) => option.label ?? option.value) : [];
    if (reachable.some((value) => triggers.includes(normalise(value)))) return "";
  }
  return literal;
}

/**
 * Resolves a whole form, keeping the fields that need a model separate.
 *
 * Returns blocked separately from skipped because they mean opposite things to
 * the caller: skipped fields are fine to leave empty, one blocked field means
 * this application should not be sent at all.
 */
export function resolveForm(fields, profile, context) {
  const fills = [];
  const attachments = [];
  const questions = [];
  const skipped = [];
  const blocked = [];

  const resolved = fields.map((field) => ({ field, result: resolveField(field, profile, context) }));
  // Second pass, because a conditional follow-up is answered by the rest
  // of the form rather than by the profile, and the rest of the form is
  // only known once every field has had its first turn.
  for (const entry of resolved) {
    if (entry.result.outcome !== "blocked" && entry.result.outcome !== "ask") continue;
    const stated = statedFallback(entry.field, resolved);
    if (stated) entry.result = { outcome: "fill", value: stated, candidates: [stated], rule: "conditional-followup" };
  }

  for (const { field, result } of resolved) {
    switch (result.outcome) {
      case "fill":
        fills.push({
          key: field.key,
          value: result.value,
          candidates: result.candidates ?? [result.value],
          rule: result.rule,
          ...(result.replace ? {replace:true} : {}),
          ...(result.sole ? { sole: true } : {}),
          ...(Number.isFinite(result.pick) ? { pick: result.pick } : {}),
        });
        break;
      case "attach":
        attachments.push({ key: field.key, document: result.document });
        break;
      case "ask":
        questions.push({
          key: field.key,
          question: result.question,
          options: result.options,
          required: field.required,
          compensation: Boolean(result.compensation),
          // A one-line input wants a phrase; a paragraph box wants prose.
          // Told apart here because the model cannot see the box it is
          // filling, and reading the control alone is not enough: a board
          // that renders "paste your résumé below" as a long text input
          // had it answered "Yes" on a real application.
          multiline: wantsProse(field),
        });
        break;
      case "blocked":
        blocked.push({ key: field.key, label: field.label, reason: result.reason, rule: result.rule });
        break;
      case "skip":
        skipped.push({ key: field.key, label: field.label, reason: result.reason });
        break;
      default:
        break;
    }
  }

  return { fills, attachments, questions, skipped, blocked };
}
