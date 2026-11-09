/** Compensation is researched by ChatGPT Search for each company and role. No static salaries, ranges, midpoint or conversion rules. */
import { askChatGpt } from './chatgpt.js';
import { extractJsonObject, parseModelJson } from './vendor/generation.js';
import { record } from './spend.js';

export const SALARY_RESEARCH_PROMPT = `Based on JD and company, tell me what compensation this position would be.
Must be consider exact salary range of that kind of roles in the company.`;
export const isCompensationQuestion = value => !/salary history|current (?:salary|pay|compensation)|previous (?:salary|pay)|past (?:salary|pay)|last (?:salary|pay)/i.test(String(value || '')) && /salary|compensation|pay expectation|desired (?:pay|rate)|expected (?:pay|comp|rate)|pay range|base pay|total (?:cash|comp)|\bOTE\b|\b(?:hourly|annual|monthly|weekly|daily) (?:pay|rate|wage)/i.test(String(value || ''));
const companyKey = value => String(value || '').toLowerCase().replace(/\b(?:incorporated|inc|llc|ltd|corp|corporation|company|co)\b/g,'').replace(/[^a-z0-9]/g,'');
export function sourceUrl(value) {
  try { const url = new URL(value); if (!/^https?:$/.test(url.protocol)) return ''; url.hostname = url.hostname.replace(/^www\./,''); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key); url.searchParams.sort(); return url.href.replace(/\/$/,''); } catch { return ''; }
}
export function compensationPrompt(job) {
  return `${SALARY_RESEARCH_PROMPT}

Use ChatGPT's web search tool now. Research the actual company and this role, including seniority, location, remote eligibility and compensation basis. Do not answer from memory alone.
Prioritize the company's own current job postings and compensation disclosures, then reliable company-specific compensation reports. Where that exists, use it and cite it.
Where it does not, fall back in this order and say which you used: comparable roles at similar companies in the same market, then published market data for this role, seniority and location. A defensible estimate is wanted; returning nothing is the worst outcome, because it stops the application entirely.
Distinguish base salary from total compensation, bonus, equity and OTE. Keep the source currency and pay period explicit. The AI must choose the recommended application amount from the research; do not use a preset or automatic midpoint rule.
Never invent a source URL or cite a page you did not read. An honest uncited estimate is acceptable; a fabricated citation is not. Only return status unavailable if you cannot form a defensible range even from market data.
Return JSON in one code block, followed by native clickable web citations for the sources actually used:
{"status":"researched","company":"the employer","role":"this role","location":"the relevant location","currency":"ISO currency code","period":"year/month/week/day/hour","basis":"base/total/ote","basedOn":"company-evidence/comparable-companies/market-data","minimum":null,"maximum":null,"recommendedAmount":null,"rationale":"Explain matching role, seniority and location, uncertainty, base versus total, and the AI's amount choice.","sources":[{"url":"actual source URL","title":"source title","company":"the employer covered","role":"role covered","matchType":"exact-company-role or same-company-comparable-role","date":"publication date if available","details":"the compensation evidence used"}]}
Use JSON numbers for researched monetary values. If unavailable, return {"status":"unavailable","reason":"what evidence is missing","sources":[]}.
Company: ${job.company || ''}
Role: ${job.title || ''}
Job URL: ${job.url || ''}
JOB DESCRIPTION:
${String(job.jd || '').slice(0,22000)}`;
}
/**
 * The reply, checked for the things that would make it dangerous to type.
 *
 * This used to demand native web citations naming this exact employer,
 * and throw the whole answer away without them. The intent was that no
 * salary reach a form uncited; the measured effect was that almost none
 * reached one at all - fifteen finished applications in a single night
 * parked on "compensation research is unavailable or uncited", more
 * than any other cause, because ChatGPT does not reliably expose
 * citations in the shape that check wanted.
 *
 * What is still refused is an answer that is incoherent as a number: a
 * missing figure, a maximum under the minimum, a recommendation outside
 * its own range, an unstated currency or pay period. Those would put a
 * wrong or meaningless value in front of an employer. An honest
 * estimate from market data would not, and a salary expectation is a
 * negotiating position rather than a declaration - being high by ten
 * percent costs a conversation, where stopping costs the application.
 *
 * Citations are still collected and still recorded, and `basedOn` says
 * which tier of evidence the figure came from, so the run log can show
 * the difference between a cited company figure and a market estimate.
 */
export function validateCompensation(payload, reply, job) {
  if (payload?.status !== 'researched') throw new Error(payload?.reason || 'No supported compensation range was found.');
  if (!companyKey(job.company) || companyKey(payload.company) !== companyKey(job.company)) throw new Error('Compensation research does not match this employer.');
  const minimum = Number(payload.minimum), maximum = Number(payload.maximum), recommendedAmount = Number(payload.recommendedAmount);
  if (![minimum,maximum,recommendedAmount].every(n => Number.isFinite(n) && n > 0) || maximum < minimum || recommendedAmount < minimum || recommendedAmount > maximum) throw new Error('The researched range and AI-selected amount are incomplete or inconsistent.');
  if (!/^[A-Z]{3}$/.test(payload.currency || '') || !['year','month','week','day','hour'].includes(payload.period) || !['base','total','ote'].includes(payload.basis)) throw new Error('Research must specify currency, period and compensation basis.');
  const citations = (reply.searchEvidence?.nativeCitations || []).filter(c => sourceUrl(c.url));
  const sourceKeys = new Set(citations.map(c => sourceUrl(c.url)));
  // A source the model listed and the transcript actually cited. Kept
  // apart from the figure itself: these grade the evidence, they no
  // longer decide whether there is an answer.
  const sources = (payload.sources || []).filter(source => sourceKeys.has(sourceUrl(source.url)) && source.role && source.details);
  const basedOn = ['company-evidence','comparable-companies','market-data'].includes(payload.basedOn) ? payload.basedOn : (sources.length ? 'company-evidence' : 'market-data');
  return {status:'researched',company:String(payload.company),role:String(payload.role || job.title),location:String(payload.location || ''),currency:payload.currency,period:payload.period,basis:payload.basis,basedOn,minimum,maximum,recommendedAmount,rationale:String(payload.rationale || ''),sources,cited:sources.length > 0,evidence:{mode:sources.length ? 'chatgpt-native-citations' : 'chatgpt-estimate',nativeCitations:citations},researchedAt:Date.now(),prompt:SALARY_RESEARCH_PROMPT};
}
/** A figure coherent enough to type. Evidence quality is recorded on the result, not demanded here. */
export function hasCompensationResearch(value) {
  return value?.status === 'researched' && Number.isFinite(Number(value.recommendedAmount)) && Number(value.recommendedAmount) > 0;
}

/* ------------------------------------------- the applicant's own range */

export const SALARY_PERIODS = ['year','month','week','day','hour'];

/**
 * The range the applicant stated, or nothing.
 *
 * This file used to allow no static figure at all, and a retired
 * `salaryFallback` is still stripped out of old settings imports on
 * purpose. That rule was written against the wrong risk. What it
 * prevented was the bot inventing a number; what it actually cost was
 * fifteen finished applications in one night, parked on "compensation
 * research is unavailable or uncited" after the form was already
 * filled - the single largest reason anything parked.
 *
 * A range the applicant typed into their own profile is not an
 * invention, which is the whole distinction. Research still runs first
 * and still wins whenever it produces cited company evidence, because
 * a figure calibrated to the employer beats a standing one. This is
 * only what happens instead of stopping.
 */
export function statedRange(profile) {
  const min = Math.max(0, Number(profile?.salaryMin) || 0);
  const max = Math.max(0, Number(profile?.salaryMax) || 0);
  if (!min && !max) return null;
  const period = SALARY_PERIODS.includes(profile?.salaryPeriod) ? profile.salaryPeriod : 'year';
  const currency = /^[A-Za-z]{3}$/.test(String(profile?.salaryCurrency || '')) ? String(profile.salaryCurrency).toUpperCase() : 'USD';
  // One figure stated is a range of one; a reversed pair is the two
  // numbers the applicant meant, in the order they meant them.
  return { min: Math.min(min || max, max || min), max: Math.max(min, max), period, currency };
}

const money = (amount, currency) => `${currency === 'USD' ? '$' : ''}${Number(amount).toLocaleString('en-US')}${currency === 'USD' ? '' : ` ${currency}`}`;

/** "$150,000 - $180,000 per year", or a single figure where both ends agree. */
export function describeRange(range) {
  if (!range) return '';
  const span = range.min === range.max ? money(range.max, range.currency) : `${money(range.min, range.currency)} - ${money(range.max, range.currency)}`;
  return `${span} per ${range.period}`;
}

/**
 * What to type into one compensation field from the stated range.
 *
 * Which end of the range is used is decided by the question, never
 * computed: a box asking for a minimum gets the minimum and a box
 * asking what the applicant wants gets the top of their range, so every
 * figure that reaches an employer is one the applicant wrote down. No
 * midpoint, no derived third number - the thing this file refused to do
 * for researched figures, it does not do here either.
 */
export function statedCompensationAnswer(field, profile) {
  const range = statedRange(profile);
  if (!range) return '';
  const asked = `${field?.label ?? ''} ${field?.name ?? ''} ${field?.id ?? ''}`.toLowerCase();
  // A box with room for a sentence is answered with the range in words;
  // a number box cannot hold "150,000 - 180,000" and would be left
  // either invalid or silently truncated to the first figure.
  const prose = field?.type === 'textarea' || field?.tag === 'textarea';
  if (prose) return describeRange(range);
  if (/\bmin(?:imum)?\b|lowest|at least|floor|starting (?:salary|pay)/.test(asked)) return String(range.min);
  if (/\bmax(?:imum)?\b|highest|ceiling|upper/.test(asked)) return String(range.max);
  return String(range.max);
}
export async function researchCompensation(job, signal) {
  let reason = '';
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const reply = await askChatGpt({system:'Research compensation with live web search. Use cited evidence for the exact employer and role. Never invent salaries or source URLs.',messages:[{role:'user',content:compensationPrompt(job)+(reason ? `\nThe previous attempt could not be used: ${reason}. Search again and correct that problem.` : '')}],format:'json',webSearch:true,signal});
      record('ChatGPT',reply);
      const payload = parseModelJson(extractJsonObject(reply.text));
      if (payload.status === 'unavailable') return {status:'unavailable',reason:payload.reason || 'No company-specific compensation evidence found.',researchedAt:Date.now(),sources:[],prompt:SALARY_RESEARCH_PROMPT};
      return validateCompensation(payload,reply,job);
    } catch (error) {
      if ([401,403,412,429,499].includes(error.status)) throw error;
      reason = error.message || String(error);
    }
  }
  return {status:'unavailable',reason,researchedAt:Date.now(),sources:[],prompt:SALARY_RESEARCH_PROMPT};
}
