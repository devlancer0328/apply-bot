/**
 * Workable postings, read from Workable's public careers API rather than the page.
 *
 * A posting lives at apply.workable.com/<account>/j/<CODE>/, its form one
 * step on at /apply/; the short link apply.workable.com/j/<CODE> redirects
 * to the first. apply.workable.com/api/v2/accounts/<account>/jobs/<CODE>
 * returns the posting - description, requirements, benefits as HTML,
 * location, remote or not - in one request, and the account's widget feed
 * names the company. A short link's account is learnt by following it once.
 */

const BOARD_TTL_MS = 10 * 60 * 1000;
const accounts = new Map();
const names = new Map();

/** Whether an address is a Workable posting or application form. */
export function isWorkableUrl(url) {
  try {
    return /(^|\.)workable\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The account slug (when the address carries it) and posting code in a
 * Workable address, or null. Codes are ten hex-ish characters, upper case.
 */
export function workableIds(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)workable\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/(?:([^/]+)\/)?j\/([A-Z0-9]{6,16})(?:\/|$)/i);
    if (!match) return null;
    return { account: match[1] ? match[1].toLowerCase() : "", code: match[2].toUpperCase() };
  } catch {
    return null;
  }
}

/** The application form's address for a posting, with any tracking query gone. */
export function workableApplyUrl(url) {
  const ids = workableIds(url);
  if (!ids) return url;
  return ids.account ? `https://apply.workable.com/${ids.account}/j/${ids.code}/apply/` : `https://apply.workable.com/j/${ids.code}/apply`;
}

/** The posting's own page, for the record. */
export function workablePostingUrl(url) {
  const ids = workableIds(url);
  if (!ids) return url;
  return ids.account ? `https://apply.workable.com/${ids.account}/j/${ids.code}/` : `https://apply.workable.com/j/${ids.code}`;
}

const stripTags = (html) =>
  String(html ?? "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h\d|ul|ol|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The account behind a short link, learnt by following the redirect once. */
async function accountFor(ids) {
  if (ids.account) return ids.account;
  const cached = accounts.get(ids.code);
  if (cached) return cached;
  const response = await fetch(`https://apply.workable.com/j/${ids.code}`, { redirect: "follow",signal:AbortSignal.timeout(15000) });
  const landed = workableIds(response.url);
  if (!landed?.account) throw new Error(`Workable's short link for ${ids.code} did not say which account it belongs to`);
  accounts.set(ids.code, landed.account);
  return landed.account;
}

/** The company's name, from the account's widget feed; the slug when that fails. */
async function companyName(account) {
  const cached = names.get(account);
  if (cached && Date.now() - cached.at < BOARD_TTL_MS) return cached.name;
  let name = "";
  try {
    const response = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}`,{signal:AbortSignal.timeout(15000)});
    if (response.ok) name = String((await response.json())?.name ?? "").trim();
  } catch {
    name = "";
  }
  if (!name) {
    name = account
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  names.set(account, { at: Date.now(), name });
  return name;
}

/**
 * The posting behind a Workable address: title, company, description and the
 * form's address. Null when the address is not a posting or the posting is
 * gone (a closed one answers 404, or comes back no longer published).
 */
export async function workablePosting(url) {
  const ids = workableIds(url);
  if (!ids) return null;
  const account = await accountFor(ids);
  const response = await fetch(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${ids.code}`,{signal:AbortSignal.timeout(15000)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Workable's careers API answered ${response.status} for ${account}`);
  const job = await response.json();
  if (!job || !job.title) return null;
  if (job.state && job.state !== "published") return null;

  const place = job.location ? [job.location.city, job.location.region, job.location.country].filter(Boolean).join(", ") : "";
  const where = [place, job.workplace === "remote" || job.remote===true ? "Remote" : job.workplace === "hybrid" ? "Hybrid" : ""].filter(Boolean).join(" · ");
  const sections = [
    stripTags(job.description),
    job.requirements ? `Requirements\n${stripTags(job.requirements)}` : "",
    job.benefits ? `Benefits\n${stripTags(job.benefits)}` : "",
  ].filter(Boolean);
  const company = await companyName(account);
  const canonical = `https://apply.workable.com/${account}/j/${ids.code}/`;

  return {
    title: String(job.title).trim(),
    company,
    metadata:{location:place,workplaceType:job.workplace==='remote'||job.remote===true?'Remote':job.workplace==='hybrid'?'Hybrid':''},
    jd: [job.title, where, "", ...sections].join("\n").trim(),
    applyUrl: workableApplyUrl(canonical),
    postingUrl: workablePostingUrl(canonical),
  };
}
