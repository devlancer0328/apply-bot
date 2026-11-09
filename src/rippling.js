/**
 * Rippling postings, read from Rippling's public board API rather than the page.
 *
 * A posting lives at ats.rippling.com/<org>/jobs/<uuid>, its form one step on
 * at /apply. api.rippling.com/platform/api/ats/v1/board/<org>/jobs/<uuid>
 * returns the posting whole - title, company, the description in two HTML
 * halves (about the company, about the role), locations, pay - in one
 * request, which beats loading a Next.js page for it. A closed posting
 * answers 404.
 */

/** Whether an address is a Rippling posting or application form. */
export function isRipplingUrl(url) {
  try {
    return /(^|\.)rippling\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The organisation slug and posting id in a Rippling address, or null. */
export function ripplingIds(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)rippling\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/([0-9a-f-]{36})(?:\/|$)/i);
    if (!match) return null;
    return { org: match[1], id: match[2].toLowerCase() };
  } catch {
    return null;
  }
}

/** The application form's address for a posting, with any tracking query gone. */
export function ripplingApplyUrl(url) {
  const ids = ripplingIds(url);
  return ids ? `https://ats.rippling.com/${ids.org}/jobs/${ids.id}/apply` : url;
}

/** The posting's own page, for the record. */
export function ripplingPostingUrl(url) {
  const ids = ripplingIds(url);
  return ids ? `https://ats.rippling.com/${ids.org}/jobs/${ids.id}` : url;
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

function companyFromSlug(org) {
  return org
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** "$113,000 - $153,000 a year", from the posting's pay range when it has one. */
function payLine(ranges) {
  const range = Array.isArray(ranges) ? ranges.find((entry) => entry.rangeStart || entry.rangeEnd) : null;
  if (!range) return "";
  const money = (amount) => `$${Math.round(Number(amount)).toLocaleString("en-US")}`;
  const per = range.frequency === "YEAR" ? " a year" : range.frequency === "HOUR" ? " an hour" : "";
  const span = range.rangeStart && range.rangeEnd ? `${money(range.rangeStart)} - ${money(range.rangeEnd)}` : money(range.rangeStart || range.rangeEnd);
  return `Pay: ${span}${per}${range.location ? ` (${range.location})` : ""}`;
}

/**
 * The posting behind a Rippling address: title, company, description and the
 * form's address. Null when the address is not a posting or the posting is
 * gone.
 */
export async function ripplingPosting(url) {
  const ids = ripplingIds(url);
  if (!ids) return null;
  const response = await fetch(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(ids.org)}/jobs/${ids.id}`,{signal:AbortSignal.timeout(15000)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Rippling's board API answered ${response.status} for ${ids.org}`);
  const job = await response.json();
  if (!job || !job.name) return null;

  const locations = (Array.isArray(job.workLocations) ? job.workLocations : []).map((entry) => (typeof entry === "string" ? entry : entry?.label)).filter(Boolean);
  const where = [locations.join(" / "), job.employmentType?.id || job.employmentType?.label].filter(Boolean).join(" · ");
  const sections = [stripTags(job.description?.role), stripTags(job.description?.company), payLine(job.payRangeDetails)].filter(Boolean);
  const company = String(job.companyName || job.board?.companyName || "").trim() || companyFromSlug(ids.org);

  return {
    title: String(job.name).trim(),
    company,
    metadata:{location:locations.join(' / ')},
    jd: [job.name, where, "", ...sections].join("\n").trim(),
    applyUrl: ripplingApplyUrl(job.url || url),
    postingUrl: ripplingPostingUrl(job.url || url),
  };
}
