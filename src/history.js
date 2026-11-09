/** Company-first protection, with job URL identities retained for audit. */
import {companyKey,companyIdentityKeys,companyResolved} from './companies.js';
const TRACKING = /^(?:utm_.+|gh_src|source|ref|referrer|referral|trackingId|trk|lever-source|lever-origin|ashby_jid_source)$/i;
const boardHost = (host, domain) => host === domain || host.endsWith('.' + domain);
export function jobIdentityKeys(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return []; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return [];
  url.hash = ''; url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  const host = url.hostname, path = url.pathname.replace(/\/+$/, ''), keys = [];
  let match;
  if (boardHost(host, 'greenhouse.io')) {
    match = path.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/application)?$/i);
    const board = match?.[1] || (/\/embed\/job_app$/i.test(path) ? url.searchParams.get('for') : ''), id = match?.[2] || url.searchParams.get('token');
    if (board && id && /^\d+$/.test(id)) keys.push(`greenhouse:${board.toLowerCase()}:${id}`);
  }
  if (boardHost(host, 'ashbyhq.com') || boardHost(host, 'lever.co')) {
    match = path.match(/^\/([^/]+)\/([a-f0-9-]{36})(?:\/(?:application|apply))?$/i);
    if (match) keys.push(`${boardHost(host, 'lever.co') ? 'lever' : 'ashby'}:${match[1].toLowerCase()}:${match[2].toLowerCase()}`);
  }
  if (boardHost(host, 'workable.com')) {
    match = path.match(/^\/([^/]+)\/j\/([^/]+)(?:\/apply)?$/i);
    if (match) keys.push(`workable:${match[1].toLowerCase()}:${match[2]}`);
  }
  if (boardHost(host, 'myworkdayjobs.com')) {
    const pieces = path.split('/').filter(Boolean).filter(p => !/^[a-z]{2}-[a-z]{2}$/i.test(p));
    const job = pieces.indexOf('job'), requisition = pieces.slice(job + 1).find(p => /_(?:JR|REQ|R)[a-z0-9_-]+$/i.test(p));
    if (job >= 1 && requisition) keys.push(`workday:${host.replace(/\.wd\d+\./, '.')}:${pieces[job - 1]}:${requisition.match(/_((?:JR|REQ|R)[a-z0-9_-]+)$/i)[1]}`);
  }
  // Keep unknown query parameters: they may contain the only job ID.
  url.pathname = path || '/';
  keys.push(`url:${url.href.replace(/\/$/, '')}`);
  return [...new Set(keys)];
}
export const historyUrls = row => [...new Set([row.applyUrl, row.sourceUrl, row.url, ...(row.urls || []), /^https?:/i.test(row.id || '') ? row.id : ''].filter(Boolean))];
export function historyIndex(rows = []) {
  const keys = new Map(), companies = new Map();
  for (const row of rows) for (const url of historyUrls(row)) for (const key of jobIdentityKeys(url)) keys.set(key, row);
  for (const row of rows) for(const key of companyIdentityKeys(row)) companies.set(key,row);
  return {
    match: (...urls) => urls.flatMap(jobIdentityKeys).map(key => keys.get(key)).find(Boolean) || null,
    matchCompany: (company,...urls) => companyIdentityKeys({company,urls}).map(key=>companies.get(key)).find(Boolean) || null,
    add(row) { for (const url of historyUrls(row)) for (const key of jobIdentityKeys(url)) keys.set(key,row); for(const key of companyIdentityKeys(row)) companies.set(key,row); },
  };
}
export function extractHistoryLinks(value) {
  const matches = String(value || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return [...new Set(matches.map(v => v.replace(/[),.;\]}]+$/, '')).filter(v => jobIdentityKeys(v).length))];
}
export function historyCandidates(text, {path = '', now = Date.now()} = {}) {
  const pieces = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const title = pieces.length >= 4 ? pieces.at(-2) : '', company = pieces.length >= 4 ? pieces.at(-3) : '';
  const urls=extractHistoryLinks(text);
  return urls.length ? urls.map(url => ({id:`external:${jobIdentityKeys(url)[0]}`,kind:'external',applyUrl:url,urls:[url],company,title,path,importedAt:now})) : company ? [{id:`external:company:${companyKey(company)}`,kind:'external',company,title,path,urls:[],importedAt:now}] : [];
}
export function companyCandidates(text) {
  return String(text || '').split(/\r?\n/).map(company=>company.trim()).filter(company=>companyKey(company)).map(company=>({id:`external:company:${companyKey(company)}`,kind:'external',company,urls:[],importedAt:Date.now()}));
}
export function previewHistory(candidates, existing = []) {
  const index = historyIndex(existing), fresh = []; let duplicates = 0;
  for (const row of candidates) {
    if (!companyResolved(row) && !historyUrls(row).some(url => jobIdentityKeys(url).length)) continue;
    const match=index.matchCompany(row.company,...historyUrls(row)) || index.match(...historyUrls(row));
    if (match) {
      if(fresh.includes(match)) {
        match.urls=[...new Set([...historyUrls(match),...historyUrls(row)])];
        match.companyAliases=[...new Set([...(match.companyAliases || []),row.company,...(row.companyAliases || [])].filter(name=>companyKey(name) && companyKey(name)!==companyKey(match.company)))];
        index.add(match);
      }
      duplicates++; continue;
    }
    fresh.push(row); index.add(row);
  }
  return {fresh,duplicates,total:candidates.length};
}
export async function readHistoryFiles(files) {
  const selected = [...files], folder = selected.some(f => f.webkitRelativePath);
  const candidates = []; let ignored = 0, empty = 0;
  for (const file of selected) {
    if (folder && !/^(?:job[- _]?link|posting)\.txt$/i.test(file.name)) { ignored++; continue; }
    if (file.size > 1024 * 1024) throw new Error(`${file.name} is too large. Import link text files smaller than 1 MB.`);
    const body=await file.text();
    let rows;
    if(!folder && /\.json$/i.test(file.name)) {
      const value=JSON.parse(body);
      if(!Array.isArray(value.companies)) throw new Error('Choose an exported companies JSON file.');
      rows=value.companies.map(row=>({...row,kind:'external',company:String(row.company || ''),urls:historyUrls(row)}));
    } else rows = historyCandidates(body,{path:file.webkitRelativePath || file.name});
    if (!rows.length) empty++;
    candidates.push(...rows);
  }
  // Directory names are enough to exclude an employer even if its saved
  // link is missing. Do not read unrelated documents to obtain them.
  if(folder) for(const file of selected) {
    const row=historyCandidates('',{path:file.webkitRelativePath})[0];
    if(row && !candidates.some(r=>companyKey(r.company)===companyKey(row.company))) candidates.push(row);
  }
  return {candidates,ignored,empty};
}
