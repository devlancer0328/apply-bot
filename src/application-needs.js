import {isCompensationQuestion} from './salary.js';
import {atsOf} from './ats.js';
/** Favor short supported forms and already prepared documents. */
export function applicationPriority(entry,known) {
 const board=atsOf(entry.originalUrl||known?.applyUrl||entry.link);
 return (known?.stage==='documents-ready'?100:0)+(['greenhouse','ashby','workable'].includes(board)?20:board==='workday'?1:board?5:0);
}
/**
 * Finished documents from an earlier run that nobody ever sent.
 *
 * Writing and sending fail for different reasons - writing needs
 * ChatGPT, sending needs a browser and a board that is answering - and
 * the handoff between them has always been a row at `documents-ready`.
 * What was missing is anybody picking those rows up again: a run that
 * was stopped, or that hit its target, or whose board went quarantined
 * with documents already banked, left finished work on the floor, and
 * the next run started at discovery and wrote new resumes while the old
 * ones aged out.
 *
 * Newest first, because a document decays - the compensation research
 * inside one expires after six hours and postings close - so the most
 * recent is both the most likely to still be usable and the most
 * expensive to have wasted.
 */
export function bankedJobs(jobs, { seen = new Set(), duplicate = () => false } = {}) {
 return (jobs ?? [])
  // `applicationData` is the metadata the attempt is rebuilt from. A row
  // at this stage without it was written by an older version and would
  // rehydrate into an application with no posting attached to it.
  .filter(job => job?.stage === 'documents-ready' && job.applicationData && (job.sourceUrl || job.applyUrl))
  // Picked up already by this run's own discovery, or applied to since
  // the document was written - in both cases sending it again is a
  // duplicate application under the candidate's name.
  .filter(job => !seen.has(job.id) && !duplicate(job))
  .sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
}
/** Legacy manual outcomes remain protected unless pre-submit failure is proven. */
export function protectsCompany(result) {
 return ['submitted','unconfirmed'].includes(result?.status)||(result?.status==='manual'&&result.detail?.submissionAttempted!==false);
}
const PARKED = new Set(['manual','review','failed']);
/**
 * Applications a person could put back in the queue, having cleared
 * whatever stopped them.
 *
 * The gate is `submissionAttempted === false` and nothing softer. Not
 * "not true", which would let a row from an older build with no flag on
 * it through; not the status, because `manual` covers both an
 * application nobody sent and one that may be sitting in an applicant
 * tracking system right now. A proven pre-submit stop is the only state
 * where the board has nothing and a second attempt is a first attempt.
 * This is `protectsCompany` read from the other side, and it has to stay
 * that way: the two disagreeing is a duplicate application under the
 * candidate's name.
 *
 * Questions are excluded deliberately. A posting held up by a question
 * nobody has answered has not changed, and one whose answers have since
 * arrived is already offered back by the bar above this one - listing it
 * twice would be two buttons for one job.
 *
 * `captcha` is passed through rather than filtered on, because it is the
 * one park this cannot read. The tab is left open for the applicant to
 * click the puzzle and press Submit themselves, and if they do, the flag
 * still says no submission was attempted - it is honest about what the
 * extension did and silent about what the person did next. Only they
 * know, so only they are asked.
 */
export function resumable(jobs, results) {
 const byId = new Map((results ?? []).map(result => [String(result.id), result]));
 return (jobs ?? [])
  .filter(job => PARKED.has(job.stage) && !(job.blockedBy ?? []).length && job.applicationData && (job.sourceUrl || job.applyUrl))
  .map(job => ({ job, result: byId.get(String(job.resultId)) }))
  .filter(({ result }) => result?.detail?.submissionAttempted === false)
  .map(({ job, result }) => ({ job, captcha: Boolean(result.detail.captcha), reason: job.reason || result.reason || '' }))
  .sort((a, b) => (b.job.updatedAt || 0) - (a.job.updatedAt || 0));
}
/** Read the actual form. Optional prose must not delay a required resume. */
export function applicationNeeds(fields=[],profile={}) {
 const editable=fields.filter(f=>!['hidden','submit','button'].includes(f.type));
 return {
  letter:editable.some(f=>/cover[ _-]?letter/i.test([f.label,f.name,f.id].filter(Boolean).join(' '))&&(f.required||profile.generateOptionalLetters)),
  compensation:editable.some(f=>isCompensationQuestion([f.label,f.name,f.id].filter(Boolean).join(' '))),
 };
}
/** Failed resolution is cached separately from an explicit user hold. */
export function extractionResting(job,now=Date.now()) {
 if(!job||job.stage==='discovered')return false;
 return (job.extractionRetryAt||(/Original posting needs review:/.test(job.reason||'')?(job.updatedAt||0)+1800000:0))>now;
}
