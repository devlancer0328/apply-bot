/**
 * ApplyToJob (JazzHR) postings, read from the page's HTML without a tab.
 *
 * A posting lives at <company>.applytojob.com/apply/<id>/<Title>, and the
 * application form is on the same page, under the description - there is
 * no separate form address. The page is server-rendered: the title in
 * <title> ("Full Stack Developer III - BAM Technologies, LLC - Career
 * Page"), the company in a JSON-LD Organization, the description in
 * #job-description. One fetch has all of it. A posting that has closed
 * answers with the company's job list instead, which has no description.
 */

/** Whether an address is an ApplyToJob posting. */
export function isApplyToJobUrl(url) {
  try {
    return /(^|\.)applytojob\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The company subdomain and posting id in an ApplyToJob address, or null. */
export function applyToJobIds(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.match(/^([^.]+)\.applytojob\.com$/i);
    if (!host || host[1].toLowerCase() === "www") return null;
    const match = parsed.pathname.match(/^\/(?:apply|app\/share)\/([A-Za-z0-9]{6,20})(?:\/([^/?#]+))?/);
    if (!match) return null;
    return { company: host[1].toLowerCase(), id: match[1], slug: match[2] ?? "" };
  } catch {
    return null;
  }
}

/** The posting's address, which is also the form's, with any tracking query gone. */
export function applyToJobPostingUrl(url) {
  const ids = applyToJobIds(url);
  return ids ? `https://${ids.company}.applytojob.com/apply/${ids.id}${ids.slug ? `/${ids.slug}` : ""}` : url;
}

export const applyToJobApplyUrl = applyToJobPostingUrl;

const decode = (html) =>
  String(html ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

const stripTags = (html) =>
  decode(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|h\d|ul|ol|li|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The text of an element by id, the element's own tags balanced. */
function sectionById(html, id) {
  const start = html.search(new RegExp(`<([a-z]+)[^>]*\\bid=["']${id}["']`, "i"));
  if (start < 0) return "";
  const tag = html.slice(start).match(/^<([a-z]+)/i)?.[1];
  const opener = new RegExp(`<${tag}\\b`, "gi");
  const closer = new RegExp(`</${tag}>`, "gi");
  let depth = 0;
  let position = start;
  for (;;) {
    opener.lastIndex = position;
    closer.lastIndex = position;
    const open = opener.exec(html);
    const close = closer.exec(html);
    if (!close) return html.slice(start);
    if (open && open.index < close.index) {
      depth += 1;
      position = open.index + 1;
    } else {
      depth -= 1;
      position = close.index + 1;
      if (depth === 0) return html.slice(start, close.index);
    }
  }
}

/**
 * The posting behind an ApplyToJob address: title, company, description
 * and the form's address (the same address). Null when the address is not
 * a posting or the page has no description to speak of - a closed posting
 * sends the company's job list in its place.
 */
export async function applyToJobPosting(url) {
  const ids = applyToJobIds(url);
  if (!ids) return null;
  const postingUrl = applyToJobPostingUrl(url);
  const response = await fetch(postingUrl, { redirect: "follow",signal:AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ApplyToJob answered ${response.status} for ${ids.company}`);
  const html = await response.text();

  const pageTitle = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const parts = pageTitle.split(/\s+-\s+/).map((part) => part.trim());
  const organisation = html.match(/"@type"\s*:\s*"Organization"[\s\S]{0,200}?"name"\s*:\s*"([^"]+)"/)?.[1];
  const title = decode(html.match(/<h2[^>]*>([^<]*)<\/h2>\s*<div class="job-attributes-container"/i)?.[1] ?? "").trim() || parts[0] || "";
  const company = decode(organisation ?? "").trim() || (parts.length >= 3 ? parts[parts.length - 2] : "") || ids.company;

  const attributes = stripTags(html.match(/<div class="job-attributes-container">([\s\S]*?)<div class="social-tools">/i)?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ");
  const description = stripTags(sectionById(html, "job-description"));
  if (!title || description.length < 80) return null;

  return {
    title,
    company,
    jd: [title, attributes, "", description].join("\n").trim(),
    applyUrl: postingUrl,
    postingUrl,
  };
}
