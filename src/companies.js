/** Conservative employer identities shared by import, preparation and submission. */
export function companyKey(value) {
  let name=String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  name=name.replace(/[.,]/g,' ').replace(/\s+/g,' ').trim();
  // Legal endings do not create a new employer. Keep substantive words.
  let previous;
  do {previous=name;name=name.replace(/(?:^|\s)(?:incorporated|inc|llc|ltd|limited|corp|corporation|company|co|gmbh|plc)\s*$/i,'').trim();} while(name!==previous);
  name=name.replace(/&/g,'and').replace(/[^\p{L}\p{N}]+/gu,'');
  return /^(?:|confidential|undisclosed|unknown|unknowncompany|stealth|private|company|careers|jobapplication|examplecompany)$/.test(name) ? '' : name;
}
export function employerKeys(value) {
  try {
    const url=new URL(value), host=url.hostname.toLowerCase(), parts=url.pathname.split('/').filter(Boolean);
    if (host==='boards.greenhouse.io' || host==='job-boards.greenhouse.io') {
      const board=/^\/embed\/job_app/i.test(url.pathname) ? url.searchParams.get('for') : /\/jobs\/\d+/.test(url.pathname) ? parts[0] : '';
      return board ? [`employer:greenhouse:${board.toLowerCase()}`] : [];
    }
    if (/^(?:jobs\.)?(?:ashbyhq\.com|lever\.co)$/.test(host) && parts[0]) return [`employer:${host.includes('ashby') ? 'ashby' : 'lever'}:${parts[0].toLowerCase()}`];
    if (host==='apply.workable.com' && parts[0] && !/^(?:j|view|api)$/i.test(parts[0])) return [`employer:workable:${parts[0].toLowerCase()}`];
    if (/^[^.]+\.wd\d+\.myworkdayjobs\.com$/.test(host)) return [`employer:workday:${host.split('.')[0]}`];
  } catch {}
  return [];
}
export function companyIdentityKeys(row) {
  const urls=[row.applyUrl,row.sourceUrl,row.url,...(Array.isArray(row.urls)?row.urls:[])].filter(Boolean);
  return [...new Set([...[row.company,...(row.companyAliases || [])].map(companyKey).filter(Boolean).map(key=>'company:'+key),...urls.flatMap(employerKeys)])];
}
// An ATS slug identifies an employer on that board, but cannot prove its
// name on a different board. Require a reviewed name for past applications.
export const companyResolved = row => Boolean(companyKey(row.company));
/**
 * One opening at one employer, named by what it says rather than by where it is.
 *
 * The employer alone is no longer a refusal - three roles at a company in
 * a day is ordinary candidate behaviour and the whole of the supply fix
 * depends on it (employers.js) - so something narrower has to carry what
 * the blanket refusal used to carry. One posting reaches the bot by
 * several roads, Jobright's link and Hiring Cafe's and the board's own,
 * and each road has its own address: a check on addresses alone is how the
 * same job gets applied to twice. The bracketed tags aggregators add
 * ("[Remote]", "(Hybrid - Austin)") and the words that appear in every
 * title go, because those are the parts that differ between two listings
 * of one job. Empty when either half is unknown, and an empty key matches
 * nothing.
 */
export function roleKey(company, title) {
  const employer = companyKey(company);
  const role = String(title ?? '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g,' ').replace(/\b(?:remote|hybrid|onsite|on-site|usa?|us-based|united states)\b/g,' ').replace(/[^a-z0-9]+/g,'');
  return employer && role ? `${employer}|${role}` : '';
}
