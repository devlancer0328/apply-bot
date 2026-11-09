/**
 * The job list, read off a Hiring Cafe search.
 *
 * Hiring Cafe is the better of the two sources for this bot, for a reason
 * that is invisible on screen: the search page carries, in the data it was
 * rendered from, the real application address of every posting shown and
 * the name of the board behind it. So the Greenhouse postings can be picked
 * straight off the list, apply link in hand, and the other forty-odd per page
 * cost nothing - no tab, no page load, no "Original Job Post" to follow.
 *
 * Jobright gives none of that; each of its links has to be opened to learn
 * where it applies. It stays in the rotation because it is the applicant's
 * own recommendations, which are a different set of jobs.
 *
 * The search is paged, forty to a page, and a run reads one page per visit.
 * Which page is remembered between visits so that a run alternating the two
 * sources walks the whole search over time, and starts over from page one
 * when it reaches the end.
 *
 * ## The state this is in, as of the November 2026 runs
 *
 * None of the above is happening. Every round of a night's run reported "the
 * page holds no search data": the island this is built on is not in the page
 * any more. It cannot be checked from outside a browser either - the site
 * answers a plain HTTPS request with Cloudflare's interstitial and HTTP 403,
 * so there is no way to read its current markup except in a signed-in tab,
 * and a production run in flight is not a thing to point a browser at.
 *
 * So this has not been rewritten, and the code below is left intact against
 * the day the island comes back. What has changed is that the failure is no
 * longer quiet: `diagnoseSearch` says which of the four reasons it is, the
 * reader stops immediately rather than waiting twenty seconds per round on
 * the ones waiting cannot fix, and three failures running retire the source
 * from the rotation under a standing health condition instead of being a
 * warning line that scrolls past. A discovery source producing nothing while
 * reporting nothing is worse than one that is switched off and says so.
 *
 * Bringing it back means opening a search in a browser, seeing whether the
 * jobs now arrive as App Router flight chunks, and if so reading `apply_url`
 * out of those instead. The field names below are the site's own and should
 * survive a router change; the transport is all that has to be rewritten.
 */

import { findTab, focus, navigate } from "./tabs.js";

const PAGE_SIZE = 40;

/** The search address, pointed at a given page. */
export function pageUrl(searchUrl, page) {
  const url = new URL(searchUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

/** True when the address is a Hiring Cafe search. */
export const isHiringCafeSearch = (url) => /^https:\/\/(?:www\.)?(?:hiringcafe\.com|hiring\.cafe)\//i.test(String(url ?? "").trim());

/** The page number an address is on. */
const pageOf = (url) => {
  try {
    return Number(new URL(url).searchParams.get("page")) || 1;
  } catch {
    return 1;
  }
};

/** The search behind an address, with its page forgotten. */
const searchOf = (url) => {
  const parsed = new URL(url);
  parsed.searchParams.delete("page");
  return parsed.toString();
};

/**
 * Runs inside the page. Turns to the next page with the site's own button,
 * which the site answers without a page load, and waits for the cards to
 * change over.
 */
function clickNext(wanted) {
  const button = document.querySelector('a[aria-label="Next page"], button[aria-label="Next page"]');
  if (!button) return Promise.resolve({ clicked: false });
  const before = document.querySelector('a[href*="/job/"]')?.href ?? "";
  button.click();
  const started = Date.now();
  return new Promise((resolve) => {
    const look = () => {
      const page = Number(new URL(location.href).searchParams.get("page")) || 1;
      const first = document.querySelector('a[href*="/job/"]')?.href ?? "";
      if (page === wanted && first && first !== before) return resolve({ clicked: true, ms: Date.now() - started });
      if (Date.now() - started > 20000) return resolve({ clicked: true, timedOut: true, page });
      setTimeout(look, 250);
    };
    look();
  });
}

/**
 * Why there is no search data to read, judged from what is on screen.
 *
 * "the page holds no search data" was the whole of what a failure here used
 * to say, and it is the same sentence whether the tab is mid-navigation,
 * sitting on Cloudflare's interstitial, signed out, or showing a site that
 * has stopped serving the data island at all. Those want different answers
 * from a person and only some of them resolve themselves, so the reader
 * waited twenty seconds for every one and then reported the one thing it
 * was sure of - every round, all night, for a source producing nothing.
 *
 * `settled` marks the cases waiting cannot change, so the reader can stop
 * at once; `why` names what is actually on screen. Exported for the test
 * that holds the wording to the shapes it was written against, and inlined
 * into `collectCurrent` rather than called from it, because a function
 * serialised into a page by `chrome.scripting` arrives without its module.
 */
export function diagnoseSearch(document, title = "", text = "") {
  const cards = document.querySelectorAll('a[href*="/job/"]').length;
  if (/just a moment|checking your browser|verify you are human/i.test(`${title} ${text}`) || document.getElementById("challenge-running")) {
    return { settled: false, why: "Cloudflare is holding the tab on its challenge page, so the search never rendered" };
  }
  // The App Router streams its props as flight chunks written into inline
  // `self.__next_f.push(...)` scripts, and serves no `__NEXT_DATA__` island
  // and no `/_next/data/<buildId>` address behind it. This reader is built
  // on both of those, so a site that has migrated is not slow and not
  // blocked: it is unreadable by this code until the reader is rewritten
  // against the streamed payload, and waiting will never change that.
  if ([...document.querySelectorAll("script")].some((node) => (node.textContent || "").includes("__next_f"))) {
    return { settled: true, why: `the site now streams its search with the Next.js App Router, which serves no __NEXT_DATA__ island and no /_next/data address; ${cards} job card(s) are on screen but their apply addresses are not readable by this reader` };
  }
  if (/sign in|log in|create (an )?account/i.test(text) && cards === 0) {
    return { settled: true, why: "the search asked to be signed in and showed no results" };
  }
  return { settled: false, why: `the page holds no search data (${cards} job card(s) on screen)` };
}

/**
 * Runs inside the page. Reads the search data for the page on screen.
 *
 * After the site has turned a page itself, the data island in the page still
 * holds the page it was served with, so the data is asked for the way the
 * site asks for it - the Next.js data address for the current search - which
 * the site answers in a second or two and from inside its own tab, where
 * the challenge it gives servers does not apply. The island is still what
 * gives the build id that address needs, and the fallback when the fetch is
 * refused, which is what happens for a page served before a deploy.
 */
async function collectCurrent() {
  // The island is in the page's HTML, so it is there when the page is - but
  // what the tab holds for a moment after a slow navigation, or while the
  // site's challenge runs, is not yet the page. Waited for, within reason -
  // except where the page is one that will never grow one, which is worth
  // telling apart because twenty seconds of waiting per round, every round,
  // all night, is the price of not telling them apart.
  const diagnose = () => {
    const cards = document.querySelectorAll('a[href*="/job/"]').length;
    const title = document.title || "";
    const text = (document.body?.innerText || "").slice(0, 3000);
    if (/just a moment|checking your browser|verify you are human/i.test(`${title} ${text}`) || document.getElementById("challenge-running")) {
      return { settled: false, why: "Cloudflare is holding the tab on its challenge page, so the search never rendered" };
    }
    if ([...document.querySelectorAll("script")].some((node) => (node.textContent || "").includes("__next_f"))) {
      return { settled: true, why: `the site now streams its search with the Next.js App Router, which serves no __NEXT_DATA__ island and no /_next/data address; ${cards} job card(s) are on screen but their apply addresses are not readable by this reader` };
    }
    if (/sign in|log in|create (an )?account/i.test(text) && cards === 0) {
      return { settled: true, why: "the search asked to be signed in and showed no results" };
    }
    return { settled: false, why: `the page holds no search data (${cards} job card(s) on screen)` };
  };

  let node = document.getElementById("__NEXT_DATA__");
  for (let waited = 0; waited < 20000 && !node && !diagnose().settled; waited += 500) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    node = document.getElementById("__NEXT_DATA__");
  }
  if (!node) return { error: diagnose().why };

  let island;
  try {
    island = JSON.parse(node.textContent);
  } catch {
    return { error: "the search data could not be parsed" };
  }

  const here = new URL(location.href);
  let props = island.props?.pageProps ?? {};
  const shownPage = Number(here.searchParams.get("page")) || 1;

  if (Number(props.ssrPage) !== shownPage || !Array.isArray(props.ssrHits)) {
    try {
      const response = await fetch(`/_next/data/${island.buildId}${here.pathname}.json${here.search}`, { headers: { "x-nextjs-data": "1" },signal:AbortSignal.timeout(15000) });
      if (!response.ok) return { stale: true, error: `the search data answered HTTP ${response.status}` };
      props = (await response.json()).pageProps ?? {};
    } catch (error) {
      return { stale: true, error: `the search data could not be fetched: ${error?.message ?? error}` };
    }
  }
  if (props.ssrError) return { error: String(props.ssrError) };

  const hits = Array.isArray(props.ssrHits) ? props.ssrHits : [];

  // The card's own page on Hiring Cafe, found by the posting's id at the end
  // of the address. Kept as the "found via" link beside the apply address.
  const cards = new Map();
  for (const anchor of document.querySelectorAll('a[href*="/job/"]')) {
    const id = anchor.href.split("?")[0].split("-").pop();
    if (id && !cards.has(id)) cards.set(id, anchor.href.split("?")[0]);
  }

  return {
    page: Number(props.ssrPage) || shownPage,
    total: Number(props.ssrTotalCount) || hits.length,
    last: Boolean(props.ssrIsLastPage) || hits.length === 0,
    jobs: hits.map((hit) => ({
      applyUrl: String(hit.apply_url ?? ""),
      source: String(hit.source ?? ""),
      title: String(hit.job_information?.title ?? hit.v5_processed_job_data?.core_job_title ?? ""),
      company: String(hit.v5_processed_job_data?.company_name ?? hit.attributed_org?.name ?? ""),
      pageUrl: cards.get(String(hit.requisition_id ?? "")) ?? "",
    })),
  };
}

const run = (tabId, func, args = []) =>
  chrome.scripting.executeScript({ target: { tabId }, func, args }).then((results) => results[0]?.result);

/**
 * Reads one page of the search.
 *
 * The user keeps the search open in the Hiring Cafe tab, and the page is read
 * there. When the tab is on the page before the one wanted, the site's own
 * "Next page" button turns it, which is quick and leaves the tab showing
 * what the run is reading; otherwise the tab is pointed at the page. The
 * search in that tab is the one used, so a search opened there with
 * different filters is honoured over the one in settings. Only when no such
 * tab is open is one opened, and that one is closed afterwards.
 *
 * Returns every posting on the page, each with its real apply address and
 * the board behind it, plus whether this was the last page. The caller
 * decides which boards it can fill.
 */
export async function searchPage({ searchUrl, page = 1, openTab, closeTab, log }) {
  const kept = await findTab(["https://hiringcafe.com/*", "https://www.hiringcafe.com/*", "https://hiring.cafe/*", "https://www.hiring.cafe/*"]);
  const keptSearch = kept && isHiringCafeSearch(kept.url) && /[?&]searchState=/.test(kept.url) ? searchOf(kept.url) : "";
  const search = keptSearch || searchUrl;
  const tabId = kept ? kept.id : await openTab(pageUrl(search, page));

  try {
    if (kept) {
      if (keptSearch && searchOf(searchUrl) !== keptSearch) log?.("info", "Reading the Hiring Cafe search open in its tab rather than the one in settings");
      const shown = keptSearch ? pageOf(kept.url) : 0;
      if (kept.discarded || kept.status !== "complete" || !keptSearch) {
        await navigate(tabId, pageUrl(search, page));
      } else if (shown === page - 1) {
        await focus(tabId);
        const turned = await run(tabId, clickNext, [page]).catch(() => null);
        if (!turned?.clicked || turned.timedOut) await navigate(tabId, pageUrl(search, page));
      } else if (shown !== page) {
        await navigate(tabId, pageUrl(search, page));
      } else {
        await focus(tabId);
      }
    }

    let read = await run(tabId, collectCurrent);
    if (read?.stale) {
      // A page served before a deploy answers with an old build id; a
      // reload brings the current one.
      await navigate(tabId, pageUrl(search, page));
      read = await run(tabId, collectCurrent);
    }
    if (!read) throw new Error("the search page could not be read");
    if (read.error) throw new Error(read.error);
    return { ...read, pageSize: PAGE_SIZE };
  } finally {
    if (!kept) await closeTab(tabId);
  }
}
