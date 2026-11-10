/**
 * The two webmail clients this reads, described rather than branched on.
 *
 * Reading a code out of a mailbox is screen-reading - no API, no OAuth
 * client, no Cloud project per user - and the screen it reads belonged to
 * Gmail alone. Outlook asks for exactly the same four things (show me this
 * search, give me the rows, refresh, put the tab back), so what changes
 * between them is a handful of selectors and a search dialect, not the
 * reading. Those are the two things in here.
 *
 * ## Why one reader, parameterised, instead of one per provider
 *
 * The markup is the fragile part. `verification.js` already imports its
 * page functions from here rather than copying them, on the stated ground
 * that a selector which has survived Gmail's redesigns must not drift into
 * two versions - and a second provider is the same argument twice over.
 * Two `readRows` means two settle tests, two signed-out tests and two
 * row-time parsers, and the row-time parser is the one whose failure is
 * invisible: it degrades into "every code looks like it was already in the
 * box", which reads as a code that never arrived. So there is one of each,
 * and a provider supplies the selectors it needs through `spec`.
 *
 * Page functions are serialised to the tab by `chrome.scripting`, so they
 * cannot close over anything in this module. Everything they need arrives
 * as an argument, which is why a spec is plain strings - selectors and
 * regular expression *sources* - rather than compiled patterns.
 *
 * ## What is genuinely different
 *
 * Gmail routes on the hash, so a search is a URL and arriving at one is
 * setting `location.hash`. Outlook does not: its search is a control on
 * the page, and the only reliable way to a result list is to type in the
 * box and press Enter. That is the one place the two providers do not
 * share an implementation.
 *
 * The dialects differ too. Gmail reads `newer_than:2h` and an OR group in
 * braces; Outlook reads neither. Outlook's search is given the quoted
 * phrase on its own, which matches the subject and the body both, and a
 * `received>=` bound by date because that is the finest grain it offers.
 * Nothing about a mail's eligibility rests on either bound - `since`,
 * `used` and `seen` in `codeForCompany` decide that, from the row's own
 * time - so a dialect that bounds loosely costs extra rows and no safety.
 */

/* ------------------------------------------------------- page functions */

/**
 * Moves Gmail to a view in place. Runs inside the page.
 *
 * Exported under its old name because background.js, verification.js and
 * three tests import it by that name.
 */
export function goToHash(hash) {
  if (location.hash === hash) {
    // The same hash again is ignored, so bounce through the inbox.
    location.hash = "#inbox";
    setTimeout(() => {
      location.hash = hash;
    }, 150);
  } else {
    location.hash = hash;
  }
  return true;
}

/**
 * Puts a query in Outlook's search box and runs it. Runs inside the page.
 *
 * The value is set through the prototype's own setter rather than by
 * assignment. Outlook's box is a React-controlled input, and React caches
 * the last value it wrote: a plain `box.value = q` changes what is on
 * screen without telling React, so React's own `input` handler sees no
 * change, never updates its state, and the Enter that follows searches for
 * whatever was there before - usually nothing.
 *
 * Enter is dispatched rather than a button clicked because the submit
 * control is sometimes absent until the box has focus, and a keydown the
 * box itself handles needs no control at all.
 */
export function typeSearch(query, selector) {
  const box = document.querySelector(selector);
  if (!box) return false;
  box.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(box, query);
  else box.value = query;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  for (const type of ["keydown", "keypress", "keyup"]) {
    box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
  return true;
}

/** Empties Outlook's search box, which is how its tab is handed back. */
export function clearSearch(selector) {
  const box = document.querySelector(selector);
  if (!box) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(box, "");
  else box.value = "";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
  return true;
}

/**
 * Asks the client to re-run the current view. Runs inside the page.
 *
 * `labels` is a regular expression source rather than the exact word, so
 * one function covers Gmail's "Refresh" and Outlook's "Sync this folder".
 * A client with no such control at all is not a failure here: the caller
 * falls back to showing the search again, which re-runs it.
 */
export function clickRefresh(labels = "^refresh$") {
  const wanted = new RegExp(labels, "i");
  const button = [...document.querySelectorAll('[role="button"], button')].find((node) =>
    wanted.test(node.getAttribute("aria-label") ?? node.getAttribute("data-tooltip") ?? node.getAttribute("title") ?? ""),
  );
  if (!button) return false;
  button.click();
  return true;
}

/**
 * The rows of a mail list, as this module reads them. Runs inside the page.
 *
 * `spec` is the provider's half: which elements are rows, what a signed-out
 * page looks like, how the client words an empty result, and where its
 * search box is. Everything else here is the same question asked of either
 * client, and is deliberately shared - see the note at the top of the file
 * about why the row-time parser in particular may not exist twice.
 */
export function readRows(search, spec) {
  const signedOut = new RegExp(spec.signedOut, "i").test(location.href);
  // When the mail was sent, which decides whether its code belongs to this
  // application or to the last one at the same employer. The visible cell
  // says "4:32 PM" with no date; the full date is in that cell's tooltip,
  // and a year is what tells it apart from the sender name and the
  // attachment marker, which carry tooltips of their own on the same row.
  //
  // Falling back to the visible cell matters more than it looks. A row
  // whose time cannot be read is not merely undated: `codeForCompany`
  // then falls back to "was this code in the box when the wait began",
  // and the wait begins after Submit while the board mails the code
  // within a second or two of it. So a code that arrived promptly - the
  // normal case - gets recorded as having been there all along and is
  // then refused for the whole seven minutes. That is the shape of a
  // code the reader never finds at all, and it depends entirely on one
  // undocumented tooltip.
  const timeOf = (row) => {
    for (const node of row.querySelectorAll("[title], [aria-label]")) {
      for (const value of [node.getAttribute("title"), node.getAttribute("aria-label")]) {
        if (!value || !/\b(?:19|20)\d{2}\b/.test(value)) continue;
        // "Mon, Nov 9, 2026 at 4:32 PM" is one of the spellings Gmail uses
        // and the one spelling Date.parse refuses, over the word "at".
        const at = Date.parse(value) || Date.parse(value.replace(/\bat\b/i, ","));
        if (at) return at;
      }
    }
    // Outlook puts the whole summary on the row itself rather than on a
    // cell inside it, so the row's own label is worth the same look.
    const own = row.getAttribute("aria-label") ?? "";
    if (/\b(?:19|20)\d{2}\b/.test(own)) {
      const at = Date.parse(own) || Date.parse(own.replace(/\bat\b/i, ","));
      if (at) return at;
    }
    // The date cell itself, which is the last cell of the row and the most
    // stable thing in it. Today's mail reads "4:32 PM"; anything older
    // reads "Nov 8", which is all this needs to know - a code from another
    // day is never this application's.
    const cell = spec.dateCell ? row.querySelector(spec.dateCell) : null;
    const shown = String(cell?.textContent ?? row.textContent.split(/\s+/).slice(-3).join(" ")).trim();
    const clock = shown.match(/\b(\d{1,2}):(\d{2})\s*([AaPp])?\.?[Mm]?\.?\b/);
    if (clock) {
      const hour = (Number(clock[1]) % 12) + (/[Pp]/.test(clock[3] ?? "") ? 12 : 0);
      const today = new Date();
      today.setHours(clock[3] ? hour : Number(clock[1]), Number(clock[2]), 0, 0);
      return today.getTime();
    }
    // A bare day and month: older than today, so dated to the start of
    // that day, which is early enough to be refused by any `since`.
    const day = Date.parse(`${shown} ${new Date().getFullYear()}`);
    return day && day <= Date.now() ? day : 0;
  };
  // Gmail keeps the lists of views it has shown in the page, hidden, so a
  // tab that was on the inbox still holds those rows; only what is on
  // screen is the search. Outlook virtualises its list, which drops the
  // same rows for a different reason and wants the same filter.
  const rows = [...document.querySelectorAll(spec.rows)]
    .filter((row) => row.getClientRects().length > 0)
    .map((row) => ({ text: (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim(), at: timeOf(row) }))
    .filter((row) => row.text);
  const main = document.querySelector('[role="main"]')?.textContent ?? document.body?.textContent?.slice(0, 4000) ?? "";
  // A tab moved here from the inbox still shows the inbox for a moment, so
  // the list only counts once the client has put this search in its box.
  //
  // Matched on the query's plain words rather than on its first
  // space-delimited token, which for Gmail's code search is
  // `{subject:"security` - a string Gmail never shows, because it rewrites
  // what it puts in the box: the operator syntax becomes chips, quoting and
  // spacing move, and the braces of an OR group do not survive at all. So
  // this test could not pass, nothing ever read as settled, and every look
  // at the mailbox spent its whole forty-second budget before using the
  // rows anyway. On a two-and-a-half minute wait that is three looks
  // instead of thirty, and it is most of why a code that had arrived was
  // found late or not at all.
  const box = document.querySelector(spec.box);
  const terms = String(search ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const typed = String(box?.value ?? "").toLowerCase();
  // No box at all is markup that has moved further than this function can
  // follow; the hash is what was asked for and is the honest fallback.
  const searching =
    !search ||
    !terms.length ||
    (box ? terms.some((term) => typed.includes(term)) : decodeURIComponent(location.hash || "").toLowerCase().includes(terms[0]));
  // The frame of the page is up long before the search has answered, so
  // "loaded" means the list has rows or the client has said there are none.
  const settled = searching && (rows.length > 0 || new RegExp(spec.empty, "i").test(main));
  const failure = new RegExp(spec.failure, "i").test(document.body?.textContent?.slice(0, 2000) ?? "");
  return { signedOut, settled, failure, rows };
}

/**
 * The activation link or code in an opened message. Runs inside the page.
 *
 * `container` is the reading pane, which both clients mark `role="main"`
 * but Outlook also gives an id of its own; the opened test is what tells
 * a drawn message from the frame around it.
 */
export function readWorkdayMessage(host, container = '[role="main"]', opened = '[role="main"] .a3s, [role="main"] [data-message-id]') {
  const root = document.querySelector(container) ?? document.body;
  const links = [...root.querySelectorAll("a[href]")]
    .map((anchor) => anchor.href)
    .filter((href) => /\/activate\//i.test(href) && href.toLowerCase().includes(String(host).toLowerCase()));
  const body = root.innerText ?? root.textContent ?? "";
  const code = body.match(/\b(?:code|passcode)\b[^\d]{0,40}(\d{6,8})\b/i)?.[1] ?? "";
  return { link: links[0] ?? "", code, opened: Boolean(document.querySelector(opened)) };
}

/**
 * Clicks the nth verification row, preferring the ones that name this
 * tenant. Runs inside the page.
 *
 * The name on the row is the sender's display name, and it is the tenant's
 * branding rather than the tenant's slug in the address: "OneSource
 * Virtual" for `vhr-osvhr`, "Highmark Health" for `highmarkhealth`. So the
 * caller passes every name the mail might carry and a row matching any of
 * them wins - but a row matching none is still offered, in order, because
 * a tenant whose branding matches nothing we know is exactly the case
 * where refusing to look costs the whole application. What makes that safe
 * is `readWorkdayMessage`, which only accepts a link on the host being
 * applied to: an unnamed row is a guess the opened message then has to
 * confirm. `named` says which of the two happened, so a caller can refuse
 * a bare code - the one payload with no host in it to check - off a row
 * nobody vouched for.
 */
export function openWorkdayRow(names, index = 0, rowSelector = "tr.zA") {
  const wanted = [].concat(names).map((name) => String(name ?? "").toLowerCase()).filter((name) => name.length >= 3);
  const rows = [...document.querySelectorAll(rowSelector)].filter((row) => row.getClientRects().length > 0);
  const text = (row) => (row.innerText || row.textContent || "").toLowerCase();
  const verification = rows.filter((row) => /verify|activate|verification|code|confirm/i.test(text(row)));
  const mine = verification.filter((row) => wanted.some((name) => text(row).includes(name)));
  // Both clients list newest first, so index 0 is the mail this attempt
  // just caused and anything below it belongs to an earlier one.
  const named = mine.length > 0;
  const row = (named ? mine : verification)[index];
  if (!row) return { clicked: false, rows: rows.length, candidates: verification.length };
  row.click();
  return { clicked: true, named, rows: rows.length, candidates: (named ? mine : verification).length, text: text(row).replace(/\s+/g, " ").slice(0, 200) };
}

/* ------------------------------------------------------------ the specs */

/** A date Outlook's `received>=` understands, a day back for the rollover. */
const sinceYesterday = (now = new Date()) => {
  const day = new Date(now.getTime() - 86400000);
  return `${day.getMonth() + 1}/${day.getDate()}/${day.getFullYear()}`;
};

const GMAIL = {
  id: "gmail",
  name: "Gmail",
  patterns: ["https://mail.google.com/*"],
  home: "https://mail.google.com/",
  spec: {
    rows: "tr.zA",
    signedOut: "accounts\\.google\\.com",
    empty: "no messages matched|nothing matched|no results",
    failure: "temporary error|something went wrong",
    box: 'form[role="search"] input, input[name="q"], input[aria-label="Search mail"], input[aria-label^="Search"]',
    dateCell: "td:last-child",
    refresh: "^refresh$",
    message: '[role="main"]',
    opened: '[role="main"] .a3s, [role="main"] [data-message-id]',
  },
  // Keyed on the subject rather than on the sender, because the subject is
  // the part that has held still: the sending domain already differs by
  // region and has moved before, and when it moves this search does not
  // break loudly - it returns an empty list, which reads exactly like a
  // code that has not arrived. The sender is kept beside it as an
  // alternative so neither key alone can empty the list.
  code: '{subject:"security code for your application" from:greenhouse-mail.io} newer_than:2h',
  workday: '{subject:"verify your candidate account" from:otp.workday.com} newer_than:3h',
};

const OUTLOOK = {
  id: "outlook",
  name: "Outlook",
  // Personal Outlook.com and the two hosts a work or school account lands
  // on. All three run the same client, which is the whole reason one spec
  // covers them.
  patterns: ["https://outlook.live.com/mail/*", "https://outlook.office.com/mail/*", "https://outlook.office365.com/mail/*"],
  home: "https://outlook.live.com/mail/0/",
  spec: {
    // `data-convid` is the message list's own handle on a conversation and
    // the narrowest of the three; the plain roles are there because the
    // attribute has been renamed before and a role has not.
    rows: 'div[role="option"][data-convid], div[role="option"], div[data-convid][role="listitem"]',
    signedOut: "login\\.microsoftonline\\.com|login\\.live\\.com|/common/oauth2|signin",
    empty: "we didn't find anything|we didn.t find anything|no results|no messages found|nothing to show here|no items match",
    failure: "something went wrong|temporarily unavailable|couldn't complete your search",
    box: 'input#topSearchInput, input[aria-label^="Search"], input[type="search"], [role="searchbox"] input, [role="searchbox"]',
    // Outlook's row has no cell structure worth naming; the time ends up
    // in the row's own label, which `timeOf` looks at before it gets here.
    dateCell: "",
    refresh: "refresh|sync this folder|^sync$",
    message: '#ReadingPaneContainerId, [role="main"]',
    opened: "#ReadingPaneContainerId [role=\"document\"], [role=\"main\"] [role=\"document\"], #ReadingPaneContainerId",
  },
  // No operator group and no `newer_than`: Outlook reads neither. The
  // quoted phrase alone is stronger than it looks - Outlook searches the
  // body as well as the subject, so this is both halves of Gmail's OR in
  // one term - and `received>=` bounds it to the coarsest grain Outlook
  // offers, which is a day. Neither bound is load-bearing: a mail's
  // eligibility is decided by `codeForCompany` from the row's own time.
  code: () => `"security code for your application" received>=${sinceYesterday()}`,
  workday: () => `"verify your candidate account" received>=${sinceYesterday()}`,
};

export const PROVIDERS = [GMAIL, OUTLOOK];
export const PROVIDER_IDS = ["auto", ...PROVIDERS.map((provider) => provider.id)];

/** The search string for a kind of mail, which Outlook dates and Gmail does not. */
export const searchFor = (provider, kind) => {
  const query = provider[kind];
  return typeof query === "function" ? query() : query;
};

export const providerById = (id) => PROVIDERS.find((provider) => provider.id === id) ?? GMAIL;

/** Which provider a tab belongs to, or nothing if it is not a mailbox. */
export const providerForUrl = (url) =>
  PROVIDERS.find((provider) =>
    provider.patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*")}$`).test(String(url ?? ""))),
  ) ?? null;

/** Every mailbox tab pattern, for the health reload and the connections list. */
export const ALL_PATTERNS = PROVIDERS.flatMap((provider) => provider.patterns);

const OUTLOOK_DOMAINS = /^(?:outlook|hotmail|live|msn|passport)\./;

/**
 * Which mailbox to read.
 *
 * A stated choice first, because it is the only thing that can settle the
 * case nothing else can: a custom domain says nothing about who hosts it,
 * and `daniel@acme.com` is as likely to be Microsoft 365 as Google
 * Workspace. Then an open tab, which is evidence rather than inference and
 * is also the fast path - a mailbox already open is read in a second
 * where a cold one costs ten to twenty. Then the address, which settles
 * the consumer domains and nothing else. Gmail last, because it is what
 * every profile had before this existed and changing that silently would
 * move a working setup.
 */
export function pickProvider({ stated = "auto", openUrls = [], email = "" } = {}) {
  if (stated && stated !== "auto") return providerById(stated);
  for (const url of openUrls) {
    const open = providerForUrl(url);
    if (open) return open;
  }
  const domain = String(email).split("@")[1] ?? "";
  if (OUTLOOK_DOMAINS.test(`${domain}.`)) return OUTLOOK;
  return GMAIL;
}

/**
 * Where a cold tab opens.
 *
 * On the inbox, never on the search itself. Gmail booted straight onto a
 * search hash runs the search but never fills its own search box, and that
 * box is the only thing telling this view apart from the one the tab was
 * on a moment ago - so a tab opened that way never reads as settled, every
 * look waits out all forty tries, and one look costs forty seconds. Outlook
 * has no search URL to get this wrong with.
 */
export function inboxUrl(provider, email = "") {
  if (provider.id === "gmail") {
    return `https://mail.google.com/mail/${email ? `?authuser=${encodeURIComponent(email)}` : ""}#inbox`;
  }
  const domain = String(email).split("@")[1] ?? "";
  // A work or school account is not reachable at outlook.live.com and a
  // consumer one is not reachable at outlook.office.com; each redirects to
  // a sign-in rather than to the other, which reads to this module as a
  // signed-out mailbox.
  return OUTLOOK_DOMAINS.test(`${domain}.`) || !domain ? "https://outlook.live.com/mail/0/" : "https://outlook.office.com/mail/";
}
