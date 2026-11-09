/** Optional user-owned rules; absent evidence stays unknown. */
import {companyKey} from './companies.js';
import {roleAllowed,roleRejection} from './roles.js';
export const FILTER_DEFAULTS={screeningEnabled:false,screeningUnknown:'balanced',screeningWorkplace:'any',screeningTravel:'any',screeningClearance:'any',screeningInterview:'any',screeningLocation:'any',screeningEmployment:'any',screeningSponsorship:'any',screeningRelocation:'any',screeningOnCall:'any',screeningTitles:'',screeningExcludedCompanies:'',screeningOtherRules:'',screeningBatchSize:12};
export const FILTER_FIELDS={
 workplace:{label:'Work arrangement',options:[['any','Any arrangement'],['remote','Remote only'],['remote-hybrid','Remote or hybrid'],['hybrid','Hybrid only'],['onsite','On-site only']],values:['remote','hybrid','onsite']},
 travel:{label:'Required travel',options:[['any','Any travel requirement'],['none','No required travel']],values:['required','none','optional']},
 clearance:{label:'Security clearance',options:[['any','Any clearance requirement'],['none','No security clearance required'],['no-active','No active clearance required']],values:['active','obtain','public-trust','none'],gate:/clearance|public trust|polygraph|\bts\/sci\b|top secret/i},
 interview:{label:'On-site interviews',options:[['any','Any interview process'],['none','No required on-site interview']],values:['required','virtual','optional']},
 location:{label:'Location eligibility',options:[['any','No location filter'],['profile','Must allow my profile location']],values:['eligible','ineligible'],gate:/eligib|reside|resident|located in|must be based|time ?zone|authoriz(?:ed|ation) to work/i},
 employment:{label:'Employment type',options:[['any','Any employment type'],['full-time','Full-time only'],['contract','Contract only'],['part-time','Part-time only']],values:['full-time','contract','part-time','temporary','internship']},
 sponsorship:{label:'Visa sponsorship',options:[['any','No sponsorship filter'],['available','Sponsorship must be available']],values:['available','unavailable'],gate:/sponsor|\bvisa\b|h-?1b|work authoriz|right to work/i},
 relocation:{label:'Relocation',options:[['any','Any relocation requirement'],['none','No required relocation']],values:['required','none','optional']},
 onCall:{label:'On-call work',options:[['any','Any on-call requirement'],['none','No required on-call work']],values:['required','none','optional']},
 other:{label:'Additional rules',values:['meets','conflict'],gate:true},
};
export const filterKey=key=>`screening${key[0].toUpperCase()}${key.slice(1)}`;
export function normalizeFilters(profile={}) {
 const p={...FILTER_DEFAULTS,...Object.fromEntries(Object.keys(FILTER_DEFAULTS).filter(k=>profile[k]!==undefined).map(k=>[k,profile[k]]))};
 // 'review' was the old name for 'strict' and was also the old default, so a
 // stored 'review' is almost always a value nobody chose; it folds to balanced.
 p.screeningEnabled=p.screeningEnabled===true;p.screeningUnknown=['strict','allow'].includes(p.screeningUnknown)?p.screeningUnknown:'balanced';
 p.screeningBatchSize=Math.min(30,Math.max(3,Math.floor(Number(p.screeningBatchSize)||12)));
 for(const [key,d]of Object.entries(FILTER_FIELDS))if(key!=='other'&&!d.options.some(([v])=>v===p[filterKey(key)]))p[filterKey(key)]='any';
 for(const k of ['screeningTitles','screeningExcludedCompanies','screeningOtherRules'])p[k]=String(p[k]||'').trim().slice(0,3000);
 return p;
}
export function activeFilters(profile){const p=normalizeFilters(profile);return p.screeningEnabled?Object.keys(FILTER_FIELDS).filter(k=>k==='other'?!!p.screeningOtherRules:p[filterKey(k)]!=='any'):[];}
const terms=s=>String(s||'').split(/[\n,;]/).map(s=>s.trim()).filter(Boolean);
export function localFilter(job,profile){const p=normalizeFilters(profile);
 // The role filter stands on its own and is checked before the research
 // suite's switch, because wanting a title filter must not oblige the
 // applicant to turn on a web-search pass over every posting as well.
 if(!roleAllowed(job.title,profile))return{decision:'rejected',reason:roleRejection(profile),findings:{},checkedAt:Date.now(),mode:'role-filter'};
 if(!p.screeningEnabled)return null;
 if(terms(p.screeningExcludedCompanies).some(name=>companyKey(name)===companyKey(job.company)))return{decision:'rejected',reason:'Employer is on your excluded-company list.',findings:{},checkedAt:Date.now(),mode:'user-rule'};
 const titles=terms(p.screeningTitles);if(titles.length&&!titles.some(t=>String(job.title||'').toLowerCase().includes(t.toLowerCase())))return{decision:'rejected',reason:'Job title does not match your allowed title phrases.',findings:{},checkedAt:Date.now(),mode:'user-rule'};
 return null;
}
function matches(k,v,p){const rule=p[filterKey(k)];
 if(k==='workplace')return(rule==='remote-hybrid'?['remote','hybrid']:[rule]).includes(v);
 if(['travel','relocation','onCall'].includes(k))return['none','optional'].includes(v);
 if(k==='clearance')return rule==='no-active'?['none','obtain','public-trust'].includes(v):v==='none';
 if(k==='interview')return['virtual','optional'].includes(v);
 if(k==='location')return v==='eligible';if(k==='employment')return v===rule;
 if(k==='sponsorship')return v==='available';if(k==='other')return v==='meets';return false;
}
/**
 * What an unverified requirement is worth.
 *
 * Research answers 'unknown' for anything it cannot quote, and it is told
 * never to read 'no clearance' or 'virtual interviews' out of silence -
 * which is right, because silence is not evidence. Turning every unknown
 * into a hold was the part that was wrong. On 8 Nov a run found 13,333
 * job links, held 71 postings and attempted 19; 44 of those holds read
 * "Not verified: Security clearance, On-site interviews", two rules that
 * essentially no software posting ever states, so they could only ever
 * come back unknown. The day became a review queue nobody empties.
 *
 * The line is whether being wrong costs the application or costs a
 * preference. Clearance, sponsorship and location eligibility are gates:
 * fail one and the employer cannot hire this candidate at all, so an
 * unknown there is worth a human. Work arrangement, travel, interview
 * format, relocation, on-call and employment type are preferences - an
 * on-site final round is something to decline in two weeks, not a reason
 * to skip applying today. A free-text rule is a gate because the person
 * wrote the clause themselves.
 *
 * Gates hold only when the posting raises the subject. A requirement
 * nobody wrote down is not an unverified requirement, it is an absent
 * one, and holding on those holds everything. None of this touches what
 * the forms are told: clearance and authorisation answers come from the
 * saved profile facts either way, so applying wider never means claiming
 * more than the candidate has.
 */
const postingText=job=>job?[job.title,job.jd,...Object.values(job.metadata||{})].filter(v=>typeof v==='string').join('\n'):null;
function holdsOnUnknown(key,p,job){
 if(p.screeningUnknown==='allow')return false;
 if(p.screeningUnknown==='strict')return true;
 const gate=FILTER_FIELDS[key].gate;if(!gate)return false;
 const text=postingText(job);
 return gate===true||text===null||gate.test(text);
}
export function evaluateFilters(findings,profile,job){const p=normalizeFilters(profile),conflicts=[],unknown=[],holds=[];
 for(const k of activeFilters(p)){const f=findings[k];
  if(!f?.verified||!FILTER_FIELDS[k].values.includes(f.value)){unknown.push(FILTER_FIELDS[k].label);if(holdsOnUnknown(k,p,job))holds.push(FILTER_FIELDS[k].label);}
  else if(!matches(k,f.value,p))conflicts.push(FILTER_FIELDS[k].label);}
 return conflicts.length?{decision:'rejected',reason:`Conflicts with your filters: ${conflicts.join(', ')}.`,conflicts,unknown,holds}:holds.length?{decision:'review',reason:`Not verified: ${holds.join(', ')}.`,conflicts,unknown,holds}:{decision:'eligible',reason:unknown.length?`Unverified, and not a disqualifier at your screening strictness: ${unknown.join(', ')}.`:activeFilters(p).length?'All enabled research filters are supported by evidence.':'No research restrictions are enabled.',conflicts,unknown,holds};
}
/**
 * Which roles a batch takes at each employer, and in what order.
 *
 * `limit` is how many one employer may have; `room` narrows it for an
 * employer that has already had some today, so a batch cannot hand out a
 * fourth by being the second batch to offer a third. The chosen roles come
 * back round-robin - every employer's best role, then every employer's
 * second - rather than grouped, because the queue sends them in this order
 * and three forms at one company back to back is the thing worth avoiding.
 * Everything over the limit stays an alternative, as it always did.
 */
export function selectCompanyRoles(jobs,{limit=1,room=()=>limit}={}){const groups=new Map();for(const j of jobs){const k=companyKey(j.company);if(!k)continue;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(j);}const taken=[],alternatives=[];
 for(const group of groups.values()){group.sort((a,b)=>Number(b.mode==='fillable')-Number(a.mode==='fillable')||Object.values(b.screening?.findings||{}).filter(f=>f.verified).length-Object.values(a.screening?.findings||{}).filter(f=>f.verified).length||String(a.id).localeCompare(String(b.id)));
  const allowed=Math.max(0,Math.min(Math.max(1,limit),Number(room(group[0]))||0));taken.push(group.slice(0,allowed));alternatives.push(...group.slice(allowed));}
 const selected=[];for(let round=0;round<Math.max(0,...taken.map(g=>g.length));round++)for(const group of taken)if(group[round])selected.push(group[round]);
 return{selected,alternatives};}
