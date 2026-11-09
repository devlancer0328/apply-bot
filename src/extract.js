/**
 * Reading a job link: where does it apply, and what does it say?
 *
 * A link from a spreadsheet is rarely an application form. It is a LinkedIn
 * posting, an aggregator, or the company's own careers page, and the form is
 * one hop further on behind "Apply". This script runs on whatever that link
 * opened and answers two questions: which address is the actual application,
 * and what is the job description's text.
 *
 * The order matters more than it looks. The address is what decides whether
 * this job is worth anything at all - a posting that does not apply through
 * Greenhouse cannot be filled by this bot, and generating a resume for it
 * would spend a model call on an application that will never be sent. So the
 * address is read first and the description comes back alongside it, used only
 * if the address turns out to be one we can use.
 *
 * Runs in the page's own world for the same reason fill.js does, and holds no
 * profile, no key and no opinions.
 */

(() => {
  if (window.__ghExtract) return;

  const ATS = [
    { name: "greenhouse", pattern: /(^|\.)greenhouse\.io$/i },
    { name: "lever", pattern: /(^|\.)lever\.co$/i },
    { name: "ashby", pattern: /(^|\.)ashbyhq\.com$/i },
    { name: "workday", pattern: /(^|\.)myworkdayjobs\.com$/i },
    { name: "rippling", pattern: /(^|\.)rippling\.com$/i },
    { name: "applytojob", pattern: /(^|\.)applytojob\.com$/i },
    { name: "smartrecruiters", pattern: /(^|\.)smartrecruiters\.com$/i },
    { name: "icims", pattern: /(^|\.)icims\.com$/i },
    { name: "bamboohr", pattern: /(^|\.)bamboohr\.com$/i },
    { name: "workable", pattern: /(^|\.)workable\.com$/i },
  ];

  function atsOf(url) {
    let host;
    try {
      host = new URL(url, location.href).hostname;
    } catch {
      return "";
    }
    return ATS.find((entry) => entry.pattern.test(host))?.name ?? "";
  }

  const absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  };

  /**
   * Every address on the page that could be the application form.
   *
   * Links are the obvious source, but a Greenhouse board is just as often
   * embedded in an iframe on the company's own careers page, or named in a
   * data attribute by Greenhouse's own embed script. All three are collected
   * because which one a given company used is not knowable in advance.
   */
  function candidates() {
    const found = [];
    const add = (url, origin) => {
      const href = absolute(url);
      if (href && /^https?:/i.test(href)) found.push({ url: href, origin });
    };

    for (const frame of document.querySelectorAll("iframe[src]")) add(frame.src, "iframe");

    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      add(href, "link");

      // Aggregators route their apply buttons through a counter, and most of
      // them carry the real destination in the query string. Reading it is a
      // whole page load cheaper than following the redirect to find out.
      const absolutised = absolute(href);
      if (!absolutised) continue;
      try {
        for (const value of new URL(absolutised).searchParams.values()) {
          if (/^https?:\/\//i.test(value)) add(value, "redirect");
        }
      } catch {
        // Not a URL this browser will parse; the plain href above still counts.
      }
    }

    // Greenhouse's embed names the board in an attribute and builds the
    // iframe later, so on a slow page the attribute is there before the frame.
    for (const node of document.querySelectorAll("[data-mapped-url], [data-board-token], #grnhse_app[data-token]")) {
      const mapped = node.getAttribute("data-mapped-url");
      if (mapped) add(mapped, "embed");
      const token = node.getAttribute("data-board-token") || node.getAttribute("data-token");
      if (token) add(`https://boards.greenhouse.io/embed/job_board?for=${token}`, "embed");
    }

    return found;
  }

  /**
   * The address this posting applies through.
   *
   * The current page wins outright when it is already on an ATS, since a link
   * that landed there needs no hop. Otherwise the candidates are ranked, and
   * an application form ranks above a board's front page: a link into
   * `/jobs/123` or `?gh_jid=` is a specific posting, while the bare board is
   * the careers index that every page on the site links to in its footer.
   */
  function applyTarget() {
    const here = atsOf(location.href);
    if (here) return { url: location.href, ats: here, via: "self" };

    let best = null;
    for (const candidate of candidates()) {
      const ats = atsOf(candidate.url);
      if (!ats) continue;

      const specific = /\/jobs?\/\d|gh_jid=|\/job_app|\/application|\/apply\b|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(candidate.url);
      // The boards this bot fills outrank the rest; a Lever link is still
      // reported so the skip says why.
      const fillable = ats === "greenhouse" || ats === "ashby" || ats === "lever" || ats === "rippling" || ats === "workable" || ats === "applytojob";
      const score = (fillable ? 4 : 0) + (specific ? 2 : 0) + (candidate.origin === "iframe" ? 1 : 0);

      if (!best || score > best.score) best = { url: candidate.url, ats, via: candidate.origin, score };
    }

    return best ? { url: best.url, ats: best.ats, via: best.via } : null;
  }

  /**
   * The posting's text.
   *
   * Taken from the densest plausible container rather than the whole body,
   * because the body on an aggregator is mostly navigation, related jobs and
   * cookie notices - and a description padded with other people's job titles
   * produces a resume tailored to the sidebar.
   */
  let ambiguousStructured=false;
  function structuredPosting() {
    const flatten=value=>Array.isArray(value)?value.flatMap(flatten):value&&typeof value==='object'?[value,...flatten(value['@graph']||[])]:[];
    const postings=[];
    for(const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {postings.push(...flatten(JSON.parse(node.textContent||'{}')).filter(x=>[x['@type']].flat().includes('JobPosting')));}catch{}
    }
    ambiguousStructured=false;
    if(postings.length===1)return postings[0];
    const path=value=>{try{const u=new URL(value,location.href);return u.origin+u.pathname.replace(/\/(?:apply|application)\/?$/,'').replace(/\/$/,'');}catch{return '';}};
    const matched=postings.find(p=>[p.url,p.mainEntityOfPage?.['@id'],typeof p.mainEntityOfPage==='string'?p.mainEntityOfPage:''].some(url=>url&&path(url)===path(location.href)))||null;
    ambiguousStructured=postings.length>1&&!matched;
    return matched;
  }
  let lastDescriptionMethod='body';
  function description() {
    lastDescriptionMethod='body';
    const posting=structuredPosting();
    if(posting?.description) {
      const node=document.createElement('div');node.innerHTML=posting.description;
      for(const junk of node.querySelectorAll('script,style'))junk.remove();
      for(const item of node.querySelectorAll('p,li,div,h1,h2,h3,h4,br'))item.append(document.createTextNode('\n'));
      const text=(node.innerText||node.textContent||'').trim();
      if(text.length>=200){lastDescriptionMethod='structured-data';return text;}
    }
    const containers = [
      ...document.querySelectorAll(
        "#content, .job__description, .job-description, [class*='description'], [class*='job-details'], article, main, section",
      ),
    ];

    let best = { text: "", length: 0 };
    for (const container of containers) {
      // Skip anything holding another candidate: the outer one is the page,
      // the inner one is the description.
      if (containers.some((other) => other !== container && container.contains(other))) continue;
      const text = (container.innerText || container.textContent || "").trim();
      if (text.length > best.length) best = { text, length: text.length };
    }

    const body = (document.body?.innerText || document.body?.textContent || "").trim();
    // A container that holds nearly nothing means the guess missed; the body
    // is worse but it is at least the posting.
    const text = best.length > 400 ? best.text : body;
    if(best.length>400)lastDescriptionMethod='container';
    return text.replace(/\n{3,}/g, "\n\n");
  }

  /** The role and employer, for naming and for the cover letter's address. */
  function identity() {
    const meta = (name) =>
      document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";

    let role = String(structuredPosting()?.title||'').trim();
    let company = String(structuredPosting()?.hiringOrganization?.name||'').trim();

    // Job postings carry schema.org JobPosting far more often than not, and it
    // names the employer outright instead of leaving it to be cut out of a title.
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || "{}");
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          if (entry?.["@type"] !== "JobPosting") continue;
          role = role || String(entry.title ?? "").trim();
          company = company || String(entry.hiringOrganization?.name ?? (typeof entry.hiringOrganization==='string'?entry.hiringOrganization:'')).trim();
        }
      } catch {
        // A malformed block is one source of two; the heading below still works.
      }
    }

    const heading = document.querySelector("h1")?.textContent?.trim() ?? "";
    role = role || heading || meta("og:title") || document.title.trim();
    company = company || meta("og:site_name");

    return { role: role.slice(0, 200), company: company.slice(0, 200) };
  }

  /**
   * The control that leads out of an aggregator to the real application.
   *
   * On Jobright, Hiring Cafe and the rest, the apply button is frequently not
   * a link to the employer at all: it is a button, or a link into the site's
   * own redirect counter, and where it goes is only knowable by going there.
   * This finds the thing to press.
   */
  function applyControl() {
    // `origin(al)` is deliberately loose. Jobright labels the way out "Origin
    // Job", others say "Original Job", "Original posting" or "Go to original",
    // and a pattern that insisted on the word "posting" after it matched none
    // of them - so the one button that actually leaves the aggregator was the
    // one control this never pressed. Breadth is safe here because only short
    // text on a link or button is considered at all.
    const WANTED = [
      /\bapply\b/i,
      /\borigin(al)?\b/i,
      /\bview (the )?job\b/i,
      /\b(company|employer) (site|website|page)\b/i,
    ];
    // "Apply filters" on a search page, and "Applied" on one already sent.
    //
    // "Autofill" is the dangerous one. Jobright's own button reads "APPLY WITH
    // AUTOFILL", which satisfies every test for an apply control and leads
    // somewhere this bot must never go: Jobright's internal application flow,
    // metered against the user's credits there, submitting on their behalf
    // rather than through the employer's Greenhouse form. The way out of an
    // aggregator is always the link to the employer, never the aggregator's
    // offer to do it for you.
    const UNWANTED = /\b(filters?|applied|applicants|autofill|save|share|report)\b/i;

    let best = null;
    for (const node of document.querySelectorAll('a[href], button, [role="button"]')) {
      const text = (node.innerText || node.textContent || node.getAttribute("aria-label") || "").trim();
      // A long string is prose that mentions applying, not a button.
      if (!text || text.length > 60) continue;
      if (!WANTED.some((pattern) => pattern.test(text)) || UNWANTED.test(text)) continue;

      const href = node.tagName === "A" ? absolute(node.getAttribute("href")) : "";
      let offsite = false;
      try {
        offsite = Boolean(href) && new URL(href).hostname !== location.hostname;
      } catch {
        offsite = false;
      }

      // Leaving the site is the strongest signal that this is the way out,
      // and an in-page button beats nothing at all.
      // "Apply" and "Origin Job" sit side by side on Jobright, and only one of
      // them leaves the site: the first opens their own form, the second is
      // the employer's posting. Leaving outranks the word, which is why
      // `offsite` is weighted above the text at all.
      const score = (/\borigin(al)?\b/i.test(text) ? 10 : 0) + (offsite ? 4 : 0) + (href ? 1 : 0) + (/\b(apply|origin(al)?)\b/i.test(text) ? 2 : 0);
      if (!best || score > best.score) best = { node, href, text, score };
    }

    return best;
  }

  /**
   * Takes the hop, and says which kind it was.
   *
   * A link is navigated rather than clicked wherever possible: clicking one
   * marked `target="_blank"` spawns a tab that then has to be found, waited
   * for and tidied up, where navigating stays in the tab already being
   * watched. Only a button with no address of its own is clicked.
   */
  function followApply() {
    const control = applyControl();
    if (!control) return { acted: false };

    if (control.href && /^https?:/i.test(control.href)) {
      return { acted: true, navigate: control.href, text: control.text };
    }

    control.node.click();
    return { acted: true, clicked: true, text: control.text };
  }

  function read() {
    const target = applyTarget();
    const posting=structuredPosting();
    const expiry=posting?.validThrough?Date.parse(posting.validThrough):NaN;
    return {
      url: location.href,
      title: document.title,
      apply: target,
      jd: description(),
      descriptionMethod:lastDescriptionMethod,
      ambiguousPosting:ambiguousStructured,
      closed:Number.isFinite(expiry)&&expiry<Date.now(),
      ...identity(),
    };
  }

  // An address on the aggregator itself, or on another list of other
  // people's postings, is never the employer's posting.
  const AGGREGATORS = /(^|\.)(jobright\.ai|hiringcafe\.com|hiring\.cafe|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com)$/i;
  const offsite = (value) => {
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.hostname !== location.hostname && !AGGREGATORS.test(url.hostname);
    } catch {
      return false;
    }
  };

  /**
   * The employer's address as the aggregator itself already holds it.
   *
   * Jobright's "APPLY NOW" is a `<button>` whose handler calls `window.open`
   * on an address kept in the card's own props. There is no `href` anywhere
   * on the card for `applyControl` to read, so the only route left was to
   * press the button and watch where the browser went - and a programmatic
   * press carries no user activation, so Chrome's popup blocker swallows the
   * `window.open` and the hop waits out its full twenty seconds having
   * learned nothing. Measured over a night's run that was the commonest way
   * a Jobright link died, two in every five.
   *
   * The address is in the page the whole time: Next.js serialises the props
   * the card was rendered from into `__NEXT_DATA__` before any of its script
   * runs. Read from there it cannot be blocked, costs no hop and no second
   * tab, and is available at the first look rather than thirty seconds in.
   *
   * Only the handful of field names aggregators use for it are accepted. A
   * loose hunt for anything URL-shaped through a quarter-megabyte of props
   * finds the logo CDN, the company's home page and an investor article, and
   * sending the run to any of those is worse than finding nothing.
   */
  const ISLAND_LINK = ["applylink", "originalurl", "externalapplyurl", "applyurl", "jobapplyurl", "atsurl"];
  function islandPosting() {
    const node = document.getElementById("__NEXT_DATA__");
    if (!node) return null;

    let data;
    try {
      data = JSON.parse(node.textContent || "");
    } catch {
      return null;
    }

    const links = new Map();
    let offered = null;
    let visited = 0;
    const walk = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 8 || visited++ > 20000) return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      for (const [name, child] of Object.entries(value)) {
        const key = name.toLowerCase().replace(/[^a-z]/g, "");
        if (typeof child === "string") {
          if (ISLAND_LINK.includes(key) && !links.has(key) && /^https?:\/\//i.test(child)) links.set(key, child);
        } else if (typeof child === "boolean") {
          // Jobright marks the cards it holds no employer link for. Knowing
          // it here is what lets one be let go in a second rather than
          // costing a tab and the full hop to find out the same thing.
          if (key === "iscompanysitelink") offered = child;
        } else walk(child, depth + 1);
      }
    };
    walk(data, 0);

    return { url: ISLAND_LINK.map((key) => links.get(key)).find(Boolean) ?? "", offered };
  }

  // Discovery pages supply identity and the original-posting control only.
  // Do not wait for, read, or cache their rewritten job descriptions.
  function discover() {
    const control = applyControl();
    const island = islandPosting();
    const fromIsland = Boolean(island?.url);
    // Whichever answer arrived, an aggregator's own redirect counter wrapping
    // it carries the real destination in its query string, so it is unwrapped
    // before being judged - reading it is a whole page load cheaper than
    // following it to find out, and a counter address would otherwise be
    // thrown away for being on the aggregator's own host.
    let url = island?.url || (control?.href ? absolute(control.href) : "");
    if (url) {
      try {
        for (const value of new URL(url).searchParams.values()) if (/^https?:\/\//i.test(value)) { url = value; break; }
      } catch {
        // Not a URL this browser will parse; what it already was still counts.
      }
    }
    if (!offsite(url)) url = "";
    const ats = atsOf(url);
    return {
      url: location.href,
      title: document.title,
      ...identity(),
      jd: "",
      apply: ats ? { url, ats, via: fromIsland ? "data-island" : "discovery-link" } : null,
      originalControl: Boolean(control) || Boolean(url),
      originalUrl: url,
      employerLinkOffered: island ? island.offered : null,
    };
  }

  window.__ghExtract = { read, discover, applyTarget, applyControl, followApply, description, identity };
})();
