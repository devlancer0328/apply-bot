/**
 * Generate resumes through ChatGPT context and render the selected visual template.
 *
 * ## Why there is a cache in here at all
 *
 * One resume is one High-reasoning turn in a ChatGPT browser tab, and on
 * the night this was measured that turn took 110 to 127 seconds - out of
 * an attempt that took 170 to 200 end to end. Every ChatGPT request in
 * the run shares two workers, so one resume per posting is a ceiling of
 * roughly fifty attempts an hour before anything else in an attempt is
 * counted, and that night ran at eleven. Nothing else comes close: the
 * page of form answers beside it costs fourteen seconds.
 *
 * There was already a cache and it could not hit. `documentSignature`
 * keys on the description, the company and the title, so it only answers
 * the question "is this the same posting I already wrote for" - which is
 * worth having, because a retried posting must not pay twice, and is
 * worth nothing across a queue of three hundred different postings.
 *
 * So the reuse below is keyed on the role *family* instead: the first
 * back-end posting of the run is written at full effort and every later
 * back-end posting of the same seniority gets that document, re-headed
 * with its own job title. What is lost is real and is worth saying
 * plainly: the bullets, the summary and the ordering are tailored to the
 * first posting in the family rather than to this one, so keywords this
 * posting uses and the first one did not will not appear. What is kept is
 * that the document is a genuine, full-effort, candidate-grounded resume
 * rather than a faster and worse one - the saving comes from writing
 * fewer of them, not from thinking less about each.
 *
 * `profile.resumeReuse` is the switch: 'family' as shipped, 'posting' to
 * pay the two minutes every time and have each resume match the posting
 * in front of it.
 */
import { buildDocumentPdf, buildCoverLetterPdf, generateCoverLetter, ProviderError, normalizeResume } from './vendor/generation.js';
import { chatGptStatus, chatGptTab, useChatGpt } from './chatgpt.js';
import { generateResumeInChat, toResume } from './resume.js';
import { researchCompensation } from './salary.js';
import { profileLink } from './answers.js';
import { applyTemplate, normalizeTemplate, documentText, unmarked, FONT_OPTIONS } from './templates.js';
import { saveResume } from './store.js';
import { record } from './spend.js';
import {stage} from './stages.js';
export class WriterError extends Error { constructor(message, status = 400) { super(message); this.name = 'WriterError'; this.status = status; } }
useChatGpt();
export const MODEL = 'ChatGPT';
export const FONTS = FONT_OPTIONS;
export function educationFrom() { return {degree:'',school:'',location:'',year:''}; }
export function linksFrom(profile) {
  return [{ label: 'LinkedIn', url: profileLink(profile.linkedin, 'www.linkedin.com') }, { label: 'GitHub', url: profileLink(profile.github, 'github.com') }, { label: 'Website', url: String(profile.website || '').trim() }].filter(l => l.url);
}
export function candidateFrom(profile) {
  return { name: [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || '', email: profile.email || '', phone: profile.phone || '', location: [profile.city, profile.state, profile.country].filter(Boolean).join(', '), links: linksFrom(profile) };
}
export const themeFrom = profile => normalizeTemplate(profile.template).theme;

/* ------------------------------------------------- reuse by role family */

/**
 * Which resume a posting may share. Order is the whole of it: a
 * "Principal" title also says "Engineer" and a "Senior iOS Engineer" also
 * says "iOS", so the narrower reading has to be tried first or everything
 * collapses into one bucket. A title matching nothing lands in
 * mid/software, which is one bucket rather than no bucket - the postings
 * that get there are the vague ones, and a vague title is the case where
 * sharing a document costs least.
 */
const BANDS = [[/\b(intern|internship|co-?op)\b/, 'intern'], [/\b(new grad|graduate|entry[- ]level|junior|jr)\b/, 'junior'], [/\b(principal|distinguished|fellow)\b/, 'principal'], [/\b(staff|architect)\b/, 'staff'], [/\b(director|vp|head of|manager|tech lead)\b/, 'lead'], [/\b(senior|sr|iii|iv)\b/, 'senior']];
const FAMILIES = [
  [/\b(ios|swiftui|objective-?c)\b/, 'ios'], [/\b(android|kotlin)\b/, 'android'], [/\b(mobile|react native|flutter)\b/, 'mobile'],
  [/\b(machine learning|ml|ai|llm|nlp|computer vision|deep learning|research engineer)\b/, 'ml'],
  [/\b(data scientist|data science|analytics|analyst)\b/, 'analytics'], [/\b(data|etl|warehouse)\b/, 'data'],
  [/\b(site reliability|sre|devops|infrastructure|platform|cloud|systems)\b/, 'infrastructure'],
  [/\b(security|appsec|infosec|cryptograph)\b/, 'security'], [/\b(qa|quality|sdet|test automation)\b/, 'quality'],
  [/\b(embedded|firmware|hardware)\b/, 'embedded'], [/\bfull[- ]?stack\b/, 'full-stack'],
  [/\b(front[- ]?end|frontend|ui|web|react|javascript|typescript)\b/, 'front-end'],
  [/\b(back[- ]?end|backend|servers?|apis?|distributed|golang|java|ruby|rails|python|node|\.net|php)\b/, 'back-end'],
];
const bucket = (table, title, fallback) => { const name = String(title || '').toLowerCase(); return table.find(([pattern]) => pattern.test(name))?.[1] ?? fallback; };
export const roleFamily = title => bucket(FAMILIES, title, 'software');
export const roleBand = title => bucket(BANDS, title, 'mid');

/**
 * Two postings share a resume when they share a family and everything
 * about the candidate that the document is made of. The profile fields
 * are in the key rather than watched for change because a resume carrying
 * last week's phone number is worse than a slow one.
 */
export const reuseKey = (profile, job) => [roleBand(job.title), roleFamily(job.title), profile.activeTemplateId || 'default',
  profile.chatGptProjectUrl || profile.resumeChatUrl || '', JSON.stringify(normalizeTemplate(profile.template)),
  [profile.firstName, profile.lastName, profile.email, profile.phone, profile.city, profile.state, profile.country, profile.linkedin, profile.github, profile.website].join('|')].join('\u0000');

/** Six hours, so an overnight run writes each family once and a new day starts fresh. */
const REUSE_MS = 21600000, REUSE_LIMIT = 24;
const familyDocuments = new Map();
export function rememberFamilyDocument(key, generated) {
  // Only a verified High-mode document is worth handing to another
  // posting; a fallback mode is already a compromise and compounding it
  // across a whole family is how a run quietly turns out worse documents.
  if (key && generated?.document?.sections?.length && generated.aiMode?.selected === 'high') {
    familyDocuments.set(key, { document: generated.document, aiMode: generated.aiMode, at: Date.now() });
    for (const old of [...familyDocuments.keys()].slice(0, Math.max(0, familyDocuments.size - REUSE_LIMIT))) familyDocuments.delete(old);
  }
  return generated;
}
export function familyDocument(key) {
  const held = key ? familyDocuments.get(key) : null;
  if (held && Date.now() - held.at < REUSE_MS) return held;
  if (held) familyDocuments.delete(key);
  return null;
}
export const forgetFamilyDocuments = () => familyDocuments.clear();

/** The held document as this posting's, re-headed with this posting's title. */
async function fromFamily(held, profile, job) {
  const candidate = candidateFrom(profile), template = normalizeTemplate(profile.template);
  const document = applyTemplate({ ...held.document, targetTitle: job.title || held.document.targetTitle }, template);
  return { resume: normalizeResume(toResume(document, candidate)), document, pdf: await buildDocumentPdf(document, template.theme),
    usage: { calls: 0 }, violations: [], aiMode: held.aiMode, coverLetter: '', settings: { candidate, theme: template.theme, model: MODEL } };
}
export function resumeToText(resume) {
  if (!resume) return '';
  return unmarked([ [resume.name, resume.targetTitle].filter(Boolean).join(' - '), resume.summary, ...(resume.coreSkills || []).map(s => `${s.category}: ${s.skills.join(', ')}`), ...(resume.experience || []).flatMap(r => [r.company, r.role, `${r.startDate} - ${r.endDate}`, ...(r.bullets || []), ...(r.environment || [])]), ...Object.values(resume.education || {}) ].filter(Boolean).join('\n'));
}
export function checkWriterSettings(profile) {
  if (profile.chatGptProjectUrl && !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(profile.chatGptProjectUrl)) throw new WriterError('Enter a ChatGPT project or conversation URL, or leave it empty to use the open ChatGPT conversation.');
}
export async function checkWriter(profile,{onRetry}={}) {
  try { checkWriterSettings(profile); const status = await chatGptStatus({onRetry,contextUrl:profile.chatGptProjectUrl});
    if (status.ok) { const tab = await chatGptTab(); profile.resumeChatUrl = profile.chatGptProjectUrl || tab?.url || ''; }
    return status.ok ? { ok: true, model: MODEL } : status; }
  catch (error) { return { ok: false, error: error.message }; }
}
export async function writeResume(profile, job, signal) {
  checkWriterSettings(profile);
  const template = normalizeTemplate(profile.template), candidate = candidateFrom(profile);
  try {
    const contextUrl = profile.chatGptProjectUrl || profile.resumeChatUrl || (await chatGptTab())?.url || '';
    const generated = await generateResumeInChat({projectUrl:contextUrl,jd:job.jd,candidate,model:MODEL,signal,label:[job.company,job.title].filter(Boolean).join(' · ')});
    const document = applyTemplate(generated.document, template);
    const pdf = await buildDocumentPdf(document, template.theme);
    return { ...generated, document, pdf, settings: { candidate, theme: template.theme, model: MODEL } };
  } catch (error) {
    // Missing candidate context affects every job. Stop for setup instead
    // of failing each posting and putting it into the retry cooldown.
    if (error.contextRequired) throw new WriterError(error.message,401);
    if (error instanceof ProviderError) throw Object.assign(new WriterError(error.message, error.status),{retryable:error.retryable});
    throw error;
  }
}
/** Generate only supporting material that a real form asks for. Never rerun High. */
export async function completeApplicationSupport(profile,application,needs,checkpoint={}) {
 const candidate=candidateFrom(profile),theme=normalizeTemplate(profile.template).theme;
 if(needs.letter&&!application.letter){
  const letter=await stage(checkpoint,'letter',()=>application.letterText?{text:application.letterText}:generateCoverLetter(application.jd,{role:application.title,company:application.company,resume:application.resumeData,extraInstructions:profile.letterInstructions},undefined));
  const pdf=await stage(checkpoint,'letterPdf',()=>buildCoverLetterPdf(letter.text,{name:candidate.name,contact:application.resumeData?.contact||candidate},theme));
  application.letterText=letter.text;application.letter=new Blob([pdf.slice()],{type:'application/pdf'});
  application.letterName ||= `${candidate.name.replace(/[^a-z\d]+/gi,'_')||'Applicant'}_Cover_Letter.pdf`;
  if(letter.usage)record(MODEL,letter.usage);
 }
 const research=application.compensation,age=Date.now()-(research?.researchedAt||0);
 if(needs.compensation&&(!research||research.status==='not-requested'||age<0||age>21600000)){
  application.compensation=await stage(checkpoint,'research',()=>researchCompensation({jd:application.jd,title:application.title,company:application.company,url:application.originalUrl||application.applyUrl}));
 }
 application.timings={...application.timings,...checkpoint.timings};
 return application;
}
export async function writeApplication(profile, job, signal, checkpoint = {}) {
  try {
  const prior=checkpoint.resumeSnapshot, reusable=Boolean(job.documentKey&&prior?.documentKey===job.documentKey&&prior.pdf instanceof Blob&&prior.document?.sections?.length&&prior.aiMode?.selected==='high');
  // The posting's own saved document first, because that one is exact.
  // Only when there is none does the role family get a say.
  const familyKey=reusable||profile.resumeReuse==='posting'?'':reuseKey(profile,job), held=familyDocument(familyKey);
  const { resume, document, pdf, usage, violations, settings, coverLetter,aiMode } = await stage(checkpoint,'documents',async() => reusable ? {
    resume:normalizeResume(toResume(prior.document,candidateFrom(profile))),document:prior.document,pdf:new Uint8Array(await prior.pdf.arrayBuffer()),usage:{calls:0},violations:[],aiMode:prior.aiMode,coverLetter:prior.letter||'',
    settings:{candidate:candidateFrom(profile),theme:normalizeTemplate(profile.template).theme,model:MODEL},
  } : held ? fromFamily(held,profile,job) : rememberFamilyDocument(familyKey,await writeResume(profile, job, signal)));
  const role = job.title || resume.targetTitle || 'the role', company = job.company || '';
  const id = checkpoint.id ||= job.libraryId||crypto.randomUUID(), createdAt = checkpoint.createdAt ||= reusable?prior.createdAt:Date.now();
  const resumeBlob = new Blob([pdf.slice()], { type: 'application/pdf' });
  const savedDocument = {...(reusable?prior:{}),id,kind:'generated',name:[company,role].filter(Boolean).join(' - '),templateId:profile.activeTemplateId,document,sourceText:documentText(document),pdf:resumeBlob,aiMode,documentKey:job.documentKey,job:{title:role,company,url:job.url || ''},createdAt};
  // Keep the real generated resume even if a later external step fails.
  await stage(checkpoint,'saveResume',() => saveResume({...savedDocument,timings:{...checkpoint.timings}}));
  const letter = await stage(checkpoint,'letter',() => coverLetter ? {text:coverLetter,usage:{calls:0}} : job.deferSupporting ? {text:'',usage:{calls:0}} : generateCoverLetter(job.jd, { ...settings, role, company, resume, extraInstructions: profile.letterInstructions }, signal));
  const letterPdf = letter.text ? await stage(checkpoint,'letterPdf',() => buildCoverLetterPdf(letter.text, { name: resume.name, contact: resume.contact }, settings.theme)) : null;
  const letterBlob = letterPdf ? new Blob([letterPdf.slice()], { type: 'application/pdf' }) : null;
  await stage(checkpoint,'saveLetter',() => saveResume({...savedDocument,letter:letter.text,letterPdf:letterBlob,timings:{...checkpoint.timings}}));
  let compensation;
  try { compensation = job.deferSupporting ? prior?.compensation||{status:'not-requested'} : await stage(checkpoint,'research',() => researchCompensation(job,signal)); }
  catch (error) { throw Object.assign(new WriterError(error.message,error.status || 500),{retryable:error.retryable}); }
  await stage(checkpoint,'save',() => saveResume({...savedDocument,letter:letter.text,letterPdf:letterBlob,compensation,timings:{...checkpoint.timings}}));
  const filename = (value, kind) => `${value.replace(/[^a-z\d]+/gi, '_') || 'Applicant'}_${kind}.pdf`;
  return { resume, resumeText: resumeToText(resume), resumeBlob, letterBlob, resumeName: filename(resume.name, 'Resume'), letterName: letterBlob ? filename(resume.name, 'Cover_Letter') : '', letterText: letter.text, role, company, aiMode, violations: violations || [], spend: { resume: record(MODEL, usage || {}), letter: record(MODEL, letter.usage || {}) }, libraryId: id, compensation, timings:{...checkpoint.timings} };
  } catch(error) { if(error instanceof ProviderError) throw Object.assign(new WriterError(error.message,error.status),{retryable:error.retryable}); throw error; }
}
