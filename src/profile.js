/** User-owned settings. Resume context stays in ChatGPT. */
import {FILTER_DEFAULTS,normalizeFilters} from './filters.js';
import {ROLE_DEFAULTS} from './roles.js';
export const DEFAULT_PROFILE = {
  ...FILTER_DEFAULTS,
  // The roles the applicant will take, stated rather than inferred. Off by
  // default: an empty list must not read as "allow nothing" on first run.
  ...ROLE_DEFAULTS,
  activeTemplateId: 'default',
  sheetUrl: '', pastedLinks: '', pairedLinks: '', autoFetch: false, jobrightRecommend: true,
  hiringCafeUrl: '', keepRunning: true,
  chatGptProjectUrl: '', chatGptConcurrency:2, letterInstructions: '', answerInstructions: '',
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
  dryRun: true, delayMs: 2000, maxPerRun: 5, maxSubmittedPerRun:0, foregroundTabs: true,
  exportFiles: false, generateOptionalLetters:false,
};
export const MANUAL_MODES = ['write', 'list', 'ignore'];
export const GENERIC_FILL_MODES = ['off', 'vendors', 'any'];
export const APPLY_ENGINES = ['module', 'legacy'];
export const RESUME_REUSE = ['family', 'posting'];
export function withDefaults(stored = {}) {
  const value = Object.fromEntries(Object.keys(DEFAULT_PROFILE).map(key => [key, stored?.[key] ?? DEFAULT_PROFILE[key]]));
  for (const key of Object.keys(DEFAULT_PROFILE)) if (typeof DEFAULT_PROFILE[key] === 'string' && typeof value[key] !== 'string') value[key] = DEFAULT_PROFILE[key];
  if (!MANUAL_MODES.includes(value.manualMode)) value.manualMode = 'list';
  if (!GENERIC_FILL_MODES.includes(value.genericFill)) value.genericFill = 'off';
  if (!APPLY_ENGINES.includes(value.applyEngine)) value.applyEngine = 'module';
  if (!RESUME_REUSE.includes(value.resumeReuse)) value.resumeReuse = 'family';
  for (const key of ['manualLimit', 'techYears', 'delayMs', 'maxPerRun']) value[key] = Math.max(0, Number(value[key]) || 0);
  // Four, because each worker keeps a ChatGPT tab per kind of task and
  // four workers is already sixteen tabs; past that the browser is the
  // bottleneck rather than the account.
  value.chatGptConcurrency=Math.max(1,Math.min(4,Math.floor(Number(value.chatGptConcurrency))||1));
  value.maxSubmittedPerRun=Number.isFinite(Number(value.maxSubmittedPerRun))?Math.max(0,Math.floor(Number(value.maxSubmittedPerRun))):0;
  for (const key of ['autoFetch', 'jobrightRecommend', 'keepRunning', 'dryRun', 'foregroundTabs', 'exportFiles','generateOptionalLetters','fillableOnly','allowAccountRegistration','roleFilterEnabled']) value[key] = typeof value[key] === 'boolean' ? value[key] : DEFAULT_PROFILE[key];
  value.roleFilterTitles = String(value.roleFilterTitles || '').trim().slice(0, 3000);
  // Remove the password distributed by old builds, including imported settings.
  if (/^Vhkautmd/.test(value.workdayPassword)) value.workdayPassword = '';
  return {...value,...normalizeFilters(value)};
}
export const requiredProfileFields = [['firstName', 'first name'], ['lastName', 'last name'], ['email', 'email'], ['phone', 'phone'], ['city', 'city'], ['country', 'country'], ['startDate', 'earliest start date'], ['workAuthorization', 'work authorization'], ['requiresSponsorship', 'sponsorship answer']];
export const missingProfileFields = profile => requiredProfileFields.filter(([key])=>!String(profile[key] || '').trim());
export const missingFromProfile = profile => missingProfileFields(profile).map(([,label])=>label);
