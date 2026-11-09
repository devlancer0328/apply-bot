/**
 * Workday postings, read from the career site's own JSON rather than the page.
 *
 * A posting lives at <tenant>.wd<n>.myworkdayjobs.com/[<lang>/]<site>/job/
 * <location>/<slug>_<requisition>. The React page that renders it loads its
 * data from /wday/cxs/<tenant>/<site>/job/<location>/<slug>_<requisition>,
 * which answers with the title, the hiring organisation, the description as
 * HTML - in one request, without a tab. The application form is one step on
 * from the posting, at /apply/applyManually. The other door, "Autofill with
 * Resume", is not used: Workday's parser invents jobs and misreads company
 * names, and every field it would have guessed is written from the profile
 * and the resume anyway.
 */

/** Whether an address is on a Workday career site. */
export function isWorkdayUrl(url) {
  try {
    return /(^|\.)myworkdayjobs\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The parts of a Workday posting address, or null.
 *
 * `tenant` is the first host label (hcsc in hcsc.wd1.myworkdayjobs.com),
 * `site` the career site (hcsc_external), and `path` the posting's path
 * under /job/ - location and slug - with the aggregator's tracking gone.
 */
export function workdayIds(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)myworkdayjobs\.com$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Optional language first: en-US, fr-CA, and so on.
  if (segments.length > 0 && /^[a-z]{2}-[A-Z]{2}$/.test(segments[0])) segments.shift();
  const marker = segments.findIndex((segment) => segment === "job" || segment === "details");
  if (marker < 1 || segments.length < marker + 2) return null;
  const site = segments[0];
  const after = segments.slice(marker + 1);
  // Anything from /apply onwards belongs to the form, not the posting.
  const applyAt = after.indexOf("apply");
  const path = (applyAt >= 0 ? after.slice(0, applyAt) : after).join("/");
  if (!path) return null;
  return {
    host: parsed.hostname,
    tenant: parsed.hostname.split(".")[0].toLowerCase(),
    site,
    path,
  };
}

/** The posting's own page, tracking gone. */
export function workdayPostingUrl(url) {
  const ids = workdayIds(url);
  return ids ? `https://${ids.host}/en-US/${ids.site}/job/${ids.path}` : url;
}

/** The application form's address for a posting: the "Apply Manually" door. */
export function workdayApplyUrl(url) {
  const ids = workdayIds(url);
  if (!ids) return url;
  return `${workdayPostingUrl(url)}/apply/applyManually`;
}

const stripTags = (html) =>
  String(html ?? "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h\d|ul|ol|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The posting behind a Workday address: title, company, description and the
 * form's address. Null when the address is not a posting or the posting has
 * closed (the API answers 404 or an empty body).
 */
export async function workdayPosting(url) {
  const ids = workdayIds(url);
  if (!ids) return null;
  const endpoint = `https://${ids.host}/wday/cxs/${encodeURIComponent(ids.tenant)}/${encodeURIComponent(ids.site)}/job/${ids.path}`;
  // Asked as a stranger: signed in as a candidate with an application
  // already begun on this posting, Workday answers canApply=false, which
  // reads as "closed" and stopped the bot from finishing what it started.
  const response = await fetch(endpoint, { headers: { Accept: "application/json" }, credentials: "omit",signal:AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Workday answered ${response.status} for ${ids.tenant}`);
  const body = await response.json().catch(() => null);
  const info = body?.jobPostingInfo;
  if (!info?.title) return null;
  if (info.canApply === false) return null;

  const company = String(body?.hiringOrganization?.name ?? "").trim() || companyFromTenant(ids.tenant);
  const where = [info.location, info.remoteType, info.timeType].filter(Boolean).join(" · ");
  const jd = [info.title, company, where, "", stripTags(info.jobDescription)].filter((line) => line !== undefined).join("\n").trim();
  return {
    title: String(info.title).trim(),
    company,
    metadata:{location:String(info.location||''),workplaceType:String(info.remoteType||'')},
    jd,
    applyUrl: workdayApplyUrl(url),
    postingUrl: workdayPostingUrl(url),
  };
}

function companyFromTenant(tenant) {
  return tenant
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
