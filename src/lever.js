/**
 * Lever postings, read from Lever's public postings API rather than the page.
 *
 * A posting lives at jobs.lever.co/<org>/<uuid>, its form one step on at
 * /apply. api.lever.co/v0/postings/<org>/<uuid> returns the posting as plain
 * text - opening, body, the bulleted lists, the closing - in one request,
 * which beats loading a page for it. The company's name is not in the API;
 * it is in the posting page's <title>, "Bellota Labs - Senior Engineer",
 * which is server-rendered and so can be fetched without a tab.
 */

const titles = new Map();

/** Whether an address is a Lever posting or application form. */
export function isLeverUrl(url) {
  try {
    return /(^|\.)lever\.co$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The organisation slug and posting id in a Lever address, or null. */
export function leverIds(url) {
  try {
    const parsed = new URL(url);
    const [org, id] = parsed.pathname.split("/").filter(Boolean);
    if (!org || !/^[0-9a-f-]{36}$/i.test(id ?? "")) return null;
    return { org, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

/** The application form's address for a posting, with any tracking query gone. */
export function leverApplyUrl(url) {
  const ids = leverIds(url);
  return ids ? `https://jobs.lever.co/${ids.org}/${ids.id}/apply` : url;
}

/** The posting's own page, for the record. */
export function leverPostingUrl(url) {
  const ids = leverIds(url);
  return ids ? `https://jobs.lever.co/${ids.org}/${ids.id}` : url;
}

const stripTags = (html) =>
  String(html ?? "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h\d|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function companyFromSlug(org) {
  return org
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** "Bellota Labs - Senior Engineer" → "Bellota Labs"; null when the page gives nothing usable. */
async function companyFromPage(url, jobTitle) {
  const cached = titles.get(url);
  if (cached !== undefined) return cached;
  let company = null;
  try {
    const html = await fetch(url,{signal:AbortSignal.timeout(15000)}).then((response) => (response.ok ? response.text() : ""));
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const parts = title.split(/\s+[-–|]\s+/);
    if (parts.length >= 2) company = parts.find((part) => part.trim() !== jobTitle.trim())?.trim() || null;
  } catch {
    company = null;
  }
  titles.set(url, company);
  return company;
}

/**
 * The posting behind a Lever address: title, company, description and the
 * form's address. Null when the address is not a posting or the posting is
 * gone (a closed Lever posting answers 404 from the API first).
 */
export async function leverPosting(url) {
  const ids = leverIds(url);
  if (!ids) return null;
  const response = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(ids.org)}/${ids.id}`,{signal:AbortSignal.timeout(15000)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Lever's postings API answered ${response.status} for ${ids.org}`);
  const job = await response.json();
  if (!job || !job.text) return null;

  const where = [job.categories?.location, job.categories?.commitment, job.workplaceType].filter(Boolean).join(" · ");
  const sections = [
    job.openingPlain || stripTags(job.opening),
    job.descriptionBodyPlain || job.descriptionPlain || stripTags(job.descriptionBody || job.description),
    ...(Array.isArray(job.lists) ? job.lists.map((list) => `${list.text}\n${stripTags(list.content)}`) : []),
    job.additionalPlain || stripTags(job.additional),
    job.salaryDescriptionPlain || "",
  ].filter((section) => section && section.trim());

  const postingUrl = leverPostingUrl(job.hostedUrl || url);
  const company = (await companyFromPage(postingUrl, job.text)) || companyFromSlug(ids.org);
  return {
    title: String(job.text).trim(),
    company,
    jd: [job.text, where, "", ...sections].join("\n").trim(),
    applyUrl: leverApplyUrl(job.applyUrl || url),
    postingUrl,
  };
}
