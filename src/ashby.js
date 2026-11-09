/**
 * Ashby postings, read from Ashby's public posting API rather than the page.
 *
 * A posting lives at jobs.ashbyhq.com/<org>/<uuid>, its form one step on at
 * /application. The form page carries almost none of the description, and
 * the overview page is a React app that takes seconds to paint - while
 * api.ashbyhq.com/posting-api/job-board/<org> lists every open posting of
 * the organisation with its full plain-text description, in one request.
 * The board is read once and kept for a while, since a run meets the same
 * organisation's postings in a row.
 */

const BOARD_TTL_MS = 10 * 60 * 1000;
const boards = new Map();

/** Whether an address is an Ashby posting or application form. */
export function isAshbyUrl(url) {
  try {
    return /(^|\.)ashbyhq\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The organisation slug and posting id in an Ashby address, or null. */
export function ashbyIds(url) {
  try {
    const parsed = new URL(url);
    const [org, id] = parsed.pathname.split("/").filter(Boolean);
    if (!org || !/^[0-9a-f-]{36}$/i.test(id ?? "")) return null;
    return { org, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

/** The application form's address for a posting, with the tracking query gone. */
export function ashbyApplyUrl(url) {
  const ids = ashbyIds(url);
  return ids ? `https://jobs.ashbyhq.com/${ids.org}/${ids.id}/application` : url;
}

/** The posting's own page, for the record. */
export function ashbyPostingUrl(url) {
  const ids = ashbyIds(url);
  return ids ? `https://jobs.ashbyhq.com/${ids.org}/${ids.id}` : url;
}

async function board(org,{refresh=false}={}) {
  const cached = boards.get(org);
  if (!refresh && cached && Date.now() - cached.at < BOARD_TTL_MS) return cached.jobs;
  const response = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,{signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Ashby's posting API answered ${response.status} for ${org}`);
  const data = await response.json();
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  boards.set(org, { at: Date.now(), jobs });
  return jobs;
}

/** "trm-labs" as "TRM Labs" would be a guess; "Trm Labs" is at least honest about being one. */
function companyFromSlug(org) {
  return org
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The posting behind an Ashby address: title, company, description and the
 * form's address. Null when the address is not a posting or the board no
 * longer lists it (closed postings vanish from the API first).
 */
export async function ashbyPosting(url,options={}) {
  const ids = ashbyIds(url);
  if (!ids) return null;
  const jobs = await board(ids.org,options);
  const job = jobs.find((entry) => String(entry.id).toLowerCase() === ids.id);
  if (!job) return null;

  const description = String(job.descriptionPlain ?? "").trim() || String(job.descriptionHtml ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const where = [job.location, job.workplaceType].filter(Boolean).join(" · ");
  return {
    title: String(job.title ?? "").trim(),
    company: companyFromSlug(ids.org),
    metadata:{location:String(job.location||''),workplaceType:String(job.workplaceType||'')},
    jd: [job.title, where, "", description].filter((line) => line !== undefined).join("\n").trim(),
    applyUrl: ashbyApplyUrl(job.applyUrl || url),
    postingUrl: ashbyPostingUrl(job.jobUrl || url),
  };
}
