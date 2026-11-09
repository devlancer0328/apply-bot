import {isCompensationQuestion} from './salary.js';
import {atsOf} from './ats.js';
/** Favor short supported forms and already prepared documents. */
export function applicationPriority(entry,known) {
 const board=atsOf(entry.originalUrl||known?.applyUrl||entry.link);
 return (known?.stage==='documents-ready'?100:0)+(['greenhouse','ashby','workable'].includes(board)?20:board==='workday'?1:board?5:0);
}
/** Legacy manual outcomes remain protected unless pre-submit failure is proven. */
export function protectsCompany(result) {
 return ['submitted','unconfirmed'].includes(result?.status)||(result?.status==='manual'&&result.detail?.submissionAttempted!==false);
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
