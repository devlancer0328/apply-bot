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
Prioritize the company's own current job postings and compensation disclosures, then reliable company-specific compensation reports. Use exact company/role evidence when available; label comparable roles at the same company clearly. Competitor-only or generic market figures are insufficient.
Distinguish base salary from total compensation, bonus, equity and OTE. Keep the source currency and pay period explicit. The AI must choose the recommended application amount from the research; do not use a preset or automatic midpoint rule.
If company-specific evidence cannot support a range, return status unavailable. Never manufacture precision, sources, a range or an amount.
Return JSON in one code block, followed by native clickable web citations for the sources actually used:
{"status":"researched","company":"the employer","role":"this role","location":"the relevant location","currency":"ISO currency code","period":"year/month/week/day/hour","basis":"base/total/ote","minimum":null,"maximum":null,"recommendedAmount":null,"rationale":"Explain matching role, seniority and location, uncertainty, base versus total, and the AI's amount choice.","sources":[{"url":"actual source URL","title":"source title","company":"the employer covered","role":"role covered","matchType":"exact-company-role or same-company-comparable-role","date":"publication date if available","details":"the compensation evidence used"}]}
Use JSON numbers for researched monetary values. If unavailable, return {"status":"unavailable","reason":"what evidence is missing","sources":[]}.
Company: ${job.company || ''}
Role: ${job.title || ''}
Job URL: ${job.url || ''}
JOB DESCRIPTION:
${String(job.jd || '').slice(0,22000)}`;
}
export function validateCompensation(payload, reply, job) {
  if (payload?.status !== 'researched') throw new Error(payload?.reason || 'No supported company-specific compensation range was found.');
  const citations = (reply.searchEvidence?.nativeCitations || []).filter(c => sourceUrl(c.url));
  if (!citations.length) throw new Error('ChatGPT did not expose native web citations for this research. Enable Search in ChatGPT and retry.');
  if (!companyKey(job.company) || companyKey(payload.company) !== companyKey(job.company)) throw new Error('Compensation research does not match this employer.');
  const minimum = Number(payload.minimum), maximum = Number(payload.maximum), recommendedAmount = Number(payload.recommendedAmount);
  if (![minimum,maximum,recommendedAmount].every(n => Number.isFinite(n) && n > 0) || maximum < minimum || recommendedAmount < minimum || recommendedAmount > maximum) throw new Error('The researched range and AI-selected amount are incomplete or inconsistent.');
  if (!/^[A-Z]{3}$/.test(payload.currency || '') || !['year','month','week','day','hour'].includes(payload.period) || !['base','total','ote'].includes(payload.basis)) throw new Error('Research must specify currency, period and compensation basis.');
  const sourceKeys = new Set(citations.map(c => sourceUrl(c.url)));
  const sources = (payload.sources || []).filter(source => sourceKeys.has(sourceUrl(source.url)) && companyKey(source.company) === companyKey(job.company) && source.role && source.details && ['exact-company-role','same-company-comparable-role'].includes(source.matchType));
  if (!sources.length) throw new Error('No native citation supports an exact or comparable role at this company.');
  return {status:'researched',company:String(payload.company),role:String(payload.role || job.title),location:String(payload.location || ''),currency:payload.currency,period:payload.period,basis:payload.basis,minimum,maximum,recommendedAmount,rationale:String(payload.rationale || ''),sources,evidence:{mode:'chatgpt-native-citations',nativeCitations:citations},researchedAt:Date.now(),prompt:SALARY_RESEARCH_PROMPT};
}
export function hasCompensationResearch(value) { return value?.status === 'researched' && value.evidence?.mode === 'chatgpt-native-citations' && value.evidence.nativeCitations?.length > 0 && value.sources?.length > 0; }
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
