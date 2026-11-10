/** User-owned settings. Resume context stays in ChatGPT. */
import {FILTER_DEFAULTS,normalizeFilters} from './filters.js';
import {ROLE_DEFAULTS} from './roles.js';
import {SALARY_PERIODS} from './salary.js';
export const DEFAULT_PROFILE = {
  ...FILTER_DEFAULTS,
  // The roles the applicant will take, stated rather than inferred. Off by
  // default: an empty list must not read as "allow nothing" on first run.
  ...ROLE_DEFAULTS,
  activeTemplateId: 'default',
  // Feeds on by default, because the alternative is a bot with nothing
  // to apply to. Off, a fresh install has no job source whatsoever: a
  // machine that ran a night this way burned through its pasted links in
  // forty minutes and then sat idle for six and a half hours, and the
  // run log it left behind said nothing was wrong, because from the
  // run's point of view nothing was.
  sheetUrl: '', pastedLinks: '', pairedLinks: '', autoFetch: true, jobrightRecommend: true,
  hiringCafeUrl: '', keepRunning: true,
  // Four is the writing half of a ten-worker budget, the sending half
  // being the day plan's `attemptConcurrency`. Needs a project address:
  // every worker past the first opens its own conversation inside one,
  // and a standalone chat cannot be written to by two at once.
  chatGptProjectUrl: '', chatGptConcurrency:4, letterInstructions: '', answerInstructions: '',
  // One High-reasoning resume is two minutes in a ChatGPT tab and is the
  // whole throughput of a run (see src/writer.js). 'family' writes one per
  // role family - back-end, iOS, full-stack - and gives it to every later
  // posting of the same seniority in that family, re-headed with its own
  // title; 'posting' pays the two minutes again for each posting so that
  // every resume is tailored to the description in front of it.
  resumeReuse: 'family',
  fillableOnly: true, manualMode: 'list', manualLimit: 10,
  // Whether the generic filler (src/apply/adapters/generic.js) is allowed to
  // drive a site no adapter was written for, and really send what it fills.
  //
  // Off, and the reasoning is worth keeping rather than rediscovering. The
  // generic adapter refuses a great deal - password boxes, ambiguous
  // Submits, empty required fields, visible captchas - but what it cannot
  // refuse is being wrong about a form it understood badly, and a wrong
  // application cannot be taken back. Recon against six unserved boards
  // found one it drove end to end with an unambiguous Submit (Odoo), one
  // where the Submit is a zero-by-zero element the geometry filter now
  // treats as a posting rather than a form (Paylocity), and two it declined
  // outright (Pinpoint, SuccessFactors). One verified vendor is not grounds
  // for letting it loose on arbitrary employer sites unattended overnight.
  //
  // 'vendors' lets it drive only the hiring systems positively verified in
  // that recon - not a company's bespoke careers page, and not another job
  // board re-listing somebody else's posting. 'any' is the unsupervised
  // version and should be turned on with somebody watching.
  genericFill: 'off',
  // Which code actually fills the form. 'module' is src/apply - the ranked
  // adapters, the generic fallback for a careers page nobody wrote one for,
  // and the non-blocking mailbox wait. 'legacy' is the original path inside
  // background.js, kept reachable because this bot sends real applications
  // to real employers and a bad cutover does not throw, it applies wrongly;
  // one setting has to be able to put every posting back on the code that
  // sent the last few hundred.
  applyEngine: 'module',
  firstName: '', lastName: '', email: '', phone: '', street: '', city: '', state: '', zip: '', country: 'United States',
  workdayPassword: '', linkedin: '', github: '', website: '',
  // Workday and the boards like it want a candidate account before they
  // will show the form, and creating one writes a durable record into that
  // employer's ATS under the applicant's real name, visible to their
  // recruiters, with no way to delete it. That is a different kind of act
  // from filling in a form, so it is a different decision, and it is the
  // applicant's: off here means a Workday posting parks at the wall with
  // its page intact instead of signing anyone up for anything.
  allowAccountRegistration: false,
  // Every one of these stays blank on purpose, and the temptation to
  // default them is worth naming because it costs real applications: a
  // form requiring one the profile does not hold stops the attempt. They
  // are legal and personal statements made under the applicant's name, a
  // default is a statement nobody made, and the applicants it is wrong
  // about are exactly the ones who would be harmed. Filling them in is a
  // setup step (see scripts/profile-sync.mjs), not a fallback.
  workAuthorization: '', requiresSponsorship: '', over18: '', nonCompete: '', backgroundCheck: '', previouslyEmployed: '', previousEmployers: '',
  willingToRelocate: '', willingToTravel: '', gender: 'Decline to self-identify', race: 'Decline to self-identify', hispanic: 'decline', veteran: 'I do not wish to answer', disability: 'I do not wish to answer', transgender: 'decline', sexualOrientation: 'Prefer not to say',
  techYears: 0, startDate: '', howHeard: 'Company website', remotePreference: 'Remote',
  pronouns: '',
  // The degree, as a fact about the person rather than a line on whichever
  // resume this application happens to be carrying. The education block -
  // Workday's My Experience, Greenhouse's School/Degree/Discipline rows -
  // is required far more often than it is optional, and answering it from
  // the generated resume alone means a posting whose resume came back
  // without an education section parks on a fact that has never changed
  // and never will. The resume still wins where it has one; this is what
  // is left when it does not.
  // Named apart from the retired `school` and `degree` career settings on
  // purpose: those are stripped by `withDefaults` precisely so an old
  // settings export cannot put somebody else's degree back, and reusing
  // the names would hand an imported "Old default" straight to a real
  // employer's education block.
  educationSchool: '', educationDegree: '', educationStart: '', educationEnd: '',
  // Whether a job tab the bot could not finish is left on screen.
  //
  // Off, and a posting that cannot be submitted automatically - a
  // captcha on Submit, a puzzle mid-form - has its answers written to
  // the folder and its tab closed with everything else. On, the tab
  // stays so the applicant can make the one click that sends it.
  //
  // Off by default because the kept tab only pays when somebody is
  // there. A supervised run of five is worth five finished forms
  // waiting to be sent; an unattended night at the daily target is a
  // window of renderers nobody will ever click, on the same machine
  // whose disk pressure has killed the browser before. The run log and
  // the manual-application folder say which postings they were, so the
  // work is recoverable either way - the live form is not.
  keepCaptchaTabs: false,
  // The compensation the applicant will say out loud when asked.
  //
  // Blank ships, and blank behaves exactly as before: the question
  // parks unless ChatGPT's research produced cited evidence for this
  // employer. Filled, it is what gets typed when that research comes
  // back unavailable - which on a measured night was fifteen finished
  // applications, more than any other single reason for stopping.
  //
  // Two figures rather than one because forms ask for both ends, and
  // because a single "expected salary" invites the bot to derive a
  // number nobody stated. Which end is used is decided by the question
  // being asked; see statedCompensationAnswer in src/salary.js.
  salaryMin: 0, salaryMax: 0, salaryPeriod: 'year', salaryCurrency: 'USD',
  // Criminal history, as a standing statement rather than a guess.
  //
  // Unlike the blanks above, this one has a default, and the difference
  // is who is making the statement. A clearance or a licence is granted
  // by somebody else and a resume says nothing about whether it was; a
  // criminal record is a fact the applicant holds about themselves and
  // can state once. The applicant has stated it, so "none" is their
  // answer and not an invention - which is the whole bar this file sets.
  //
  // Set to '' and every conviction question parks for a person again;
  // set to 'disclose' and it parks with the disclosure left to them,
  // because a record is never a sentence this system writes. Nothing
  // here answers a clearance, a licence or a credit check: those are
  // other people's registers and keep their own rules.
  criminalRecord: 'none',
  // Professional licences and certifications, or the word "none".
  //
  // Blank on purpose and it costs applications: finance and healthcare
  // boards ask "do you hold or have you held any securities industry
  // licenses", and with nothing here that question parks. The temptation
  // is to answer "no" from the resume having none on it, and that is the
  // trade this field refuses - a resume is a summary the candidate chose
  // what to put on, not a register, and a licence denied to a broker-
  // dealer is a declaration a regulator reads rather than a field a
  // recruiter corrects. One word here turns the whole class of question
  // into an answer; nothing here leaves it with a person.
  licenses: '',
  // The security clearance held, or the word "none".
  //
  // "none" rather than blank, which is the one place this file assumes a
  // fact instead of waiting to be told one. A clearance is granted by a
  // government, so almost nobody has one and everybody who does knows
  // it; starting at blank meant the overwhelmingly common case had to be
  // typed before it was true, and until it was, every form asking about
  // a clearance stopped a finished application on a fact that was never
  // in doubt. Anyone holding one replaces the word, and the question is
  // answered from what they wrote instead.
  //
  // It also buys the blocker: with "none" here, a posting demanding an
  // active clearance is passed over in under a millisecond rather than
  // costing a resume, a letter, a filled form and a submission before
  // the employer rejects it on the one fact that was knowable from the
  // start. A blank blocks nothing, because a blank is not a denial.
  securityClearance: 'none',
  // Which webmail the verification codes are read out of: 'auto', 'gmail'
  // or 'outlook'.
  //
  // Auto is right for almost everyone and wrong for exactly one case. It
  // takes an already-open mailbox tab as the answer, and falls back to the
  // address: outlook.com, hotmail.com, live.com and msn.com are Outlook,
  // and everything else is Gmail. What that cannot settle is a custom
  // domain - `daniel@acme.com` is as likely to be Microsoft 365 as Google
  // Workspace, and nothing in the address says which - so a person on one
  // says so here once.
  mailProvider: 'auto',
  // The instant rules in blockers.js: postings this candidate could not
  // be hired for whatever else is true. On by default and still inert
  // until the facts above are filled in, since every rule is gated on
  // one of them.
  hardBlockers: true,
  // Whether a batch is scored for plausibility before any resume is
  // written, and the score below which it is not worth writing one.
  // One ChatGPT call per batch, no web search - see fit.js for why the
  // threshold is this low.
  fitCheckEnabled: true,
  fitThreshold: 35,
  // Answers to questions no stored fact reaches, as the applicant's own
  // words: one `pattern = answer` per line, the pattern matched against
  // the question the form is asking.
  //
  // This is the escape hatch for the judgement questions - "are you an
  // athlete or esports competitor", "do you hold a clearance" - that are
  // true facts about a person and appear in no resume. The bot refuses to
  // invent them, correctly, and every refusal is a lost application; this
  // is how the applicant states one once and has it answered everywhere
  // after. See JUDGEMENT_DEFAULTS in src/answers.js for the few whose
  // answer is safe enough to ship.
  answerBank: '',
  // Submitting, unthrottled, is what a fresh install does.
  //
  // These three shipped the other way - review before sending, five
  // attempts a run - and a night of three machines produced sixteen
  // applications between them. One had never been taken out of review
  // mode and had applied to nothing at all in seven hours; another ran
  // its five attempts and stopped. Neither reported anything wrong,
  // because neither was wrong: they were doing exactly what they had
  // been configured to do, and the configuration was the shipped one.
  //
  // A default that does nothing is not the safe choice it looks like.
  // The real guard against an unwanted application is that a run cannot
  // start until the profile carries a name, an email, a phone, a
  // location, a start date and a work-authorization answer (see
  // `requiredProfileFields`, enforced in src/options.js) - so the person
  // who has not set this up cannot submit, whatever these say, and the
  // person who has set it up meant to.
  delayMs: 2000, maxPerRun: 0, maxSubmittedPerRun:0, foregroundTabs: true,
  exportFiles: true, generateOptionalLetters:false, profileRevision: 0,
};
/**
 * Bumped when a shipped default changes in a way that has to reach profiles
 * already on disk. Only the keys named under the new revision are reset;
 * everything else the applicant set is left alone.
 *
 * 1 - writing the application folder to Downloads. It shipped off, and the
 *     only switch for it sat at the foot of the data page, so every profile
 *     in the field had the "job applied-folder" the rest of the extension
 *     talks about and nothing ever arrived in it.
 *
 * 2 - no security clearance held. The field shipped blank, a blank is not
 *     a denial, and so every clearance question stopped an application on
 *     a fact nobody was ever unsure about. Only an empty field is filled
 *     in; a profile naming a clearance keeps it.
 */
export const PROFILE_REVISION = 2;
export const MANUAL_MODES = ['write', 'list', 'ignore'];
export const GENERIC_FILL_MODES = ['off', 'vendors', 'any'];
/** No record stated, nothing stated, and a record the applicant will describe themselves. */
export const CRIMINAL_RECORD = ['none', '', 'disclose'];
export const APPLY_ENGINES = ['module', 'legacy'];
export const MAIL_PROVIDERS = ['auto', 'gmail', 'outlook'];
export const RESUME_REUSE = ['family', 'posting'];
export function withDefaults(stored = {}) {
  const value = Object.fromEntries(Object.keys(DEFAULT_PROFILE).map(key => [key, stored?.[key] ?? DEFAULT_PROFILE[key]]));
  for (const key of Object.keys(DEFAULT_PROFILE)) if (typeof DEFAULT_PROFILE[key] === 'string' && typeof value[key] !== 'string') value[key] = DEFAULT_PROFILE[key];
  if (!MANUAL_MODES.includes(value.manualMode)) value.manualMode = 'list';
  if (!GENERIC_FILL_MODES.includes(value.genericFill)) value.genericFill = 'off';
  if (!APPLY_ENGINES.includes(value.applyEngine)) value.applyEngine = 'module';
  if (!MAIL_PROVIDERS.includes(value.mailProvider)) value.mailProvider = 'auto';
  if (!RESUME_REUSE.includes(value.resumeReuse)) value.resumeReuse = 'family';
  for (const key of ['manualLimit', 'techYears', 'delayMs', 'maxPerRun']) value[key] = Math.max(0, Number(value[key]) || 0);
  // Four, because each worker keeps a ChatGPT tab per kind of task and
  // four workers is already sixteen tabs; past that the browser is the
  // bottleneck rather than the account.
  value.chatGptConcurrency=Math.max(1,Math.min(4,Math.floor(Number(value.chatGptConcurrency))||1));
  value.maxSubmittedPerRun=Number.isFinite(Number(value.maxSubmittedPerRun))?Math.max(0,Math.floor(Number(value.maxSubmittedPerRun))):0;
  // Capped below 80 rather than at 100. A threshold high enough to reject
  // most of a batch turns a stored number into a bot that quietly applies
  // to nothing, which is indistinguishable from a broken feed.
  value.fitThreshold=Math.max(0,Math.min(80,Math.floor(Number(value.fitThreshold))||0));
  for (const key of ['autoFetch', 'jobrightRecommend', 'keepRunning', 'foregroundTabs', 'exportFiles','generateOptionalLetters','fillableOnly','allowAccountRegistration','roleFilterEnabled','keepCaptchaTabs','hardBlockers','fitCheckEnabled']) value[key] = typeof value[key] === 'boolean' ? value[key] : DEFAULT_PROFILE[key];
  const revision = Number(stored?.profileRevision) || 0;
  if (revision < 1) value.exportFiles = true;
  // Only onto a field nobody has written in. Overwriting a stated
  // clearance would be this file inventing a denial, which is the one
  // thing it may never do.
  if (revision < 2 && !String(value.securityClearance ?? '').trim()) value.securityClearance = 'none';
  value.profileRevision = PROFILE_REVISION;
  // "Review before sending" used to live here as `dryRun`, filling every
  // form and submitting none. It is gone rather than defaulted off: a
  // machine left in it ran a full night and sent nothing, and a setting
  // whose only failure mode is silence is not worth keeping. Anything
  // still stored under the old key is ignored.
  delete value.dryRun;
  // Anything that is not one of the three answers parks the question
  // rather than answering it. The unrecognised value here is a settings
  // export from another build or a hand-edited database, and the shipped
  // default is the one value that would answer a conviction question on
  // its own - so a value nobody chose must not be read as that one.
  if (!CRIMINAL_RECORD.includes(value.criminalRecord)) value.criminalRecord = '';
  for (const key of ['salaryMin', 'salaryMax']) value[key] = Math.max(0, Math.round(Number(value[key]) || 0));
  if (!SALARY_PERIODS.includes(value.salaryPeriod)) value.salaryPeriod = 'year';
  value.salaryCurrency = /^[A-Za-z]{3}$/.test(value.salaryCurrency) ? value.salaryCurrency.toUpperCase() : 'USD';
  value.roleFilterTitles = String(value.roleFilterTitles || '').trim().slice(0, 3000);
  // Remove the password distributed by old builds, including imported settings.
  if (/^Vhkautmd/.test(value.workdayPassword)) value.workdayPassword = '';
  return {...value,...normalizeFilters(value)};
}
export const requiredProfileFields = [['firstName', 'first name'], ['lastName', 'last name'], ['email', 'email'], ['phone', 'phone'], ['city', 'city'], ['country', 'country'], ['startDate', 'earliest start date'], ['workAuthorization', 'work authorization'], ['requiresSponsorship', 'sponsorship answer']];
export const missingProfileFields = profile => requiredProfileFields.filter(([key])=>!String(profile[key] || '').trim());
export const missingFromProfile = profile => missingProfileFields(profile).map(([,label])=>label);
