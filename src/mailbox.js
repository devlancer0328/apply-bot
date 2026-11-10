/**
 * Reads a security code out of the applicant's Gmail.
 *
 * Some Greenhouse boards hold an application after Submit until the applicant
 * types a code that was mailed to them. The mail comes from Greenhouse's own
 * sender - no-reply@us.greenhouse-mail.io on American boards and
 * no-reply@eu.greenhouse-mail.io on European ones - with the subject
 * "Security code for your application to <Company>" and the code in the first
 * sentence of the body, which is also the snippet Gmail shows in its list. So
 * the list is enough: the mailbox is opened on a search for those mails, and
 * the row for this company is read without opening it.
 *
 * The search is keyed on that subject rather than on the sender, because the
 * subject is the part that has held still. The sending domain already differs
 * by region and has moved before, and when it moves this search does not
 * break loudly - it returns an empty list, which reads exactly like a code
 * that has not arrived yet, and the application sits waiting for a person.
 * The sender is kept beside the subject as an alternative rather than a
 * requirement, so neither key alone can empty the list.
 *
 * This is screen-reading, not an API. Gmail's markup is undocumented and
 * changes, so the selectors here are the ones that have been stable for
 * years (the row class, the conversation count) and the text of a row is
 * read whole rather than cell by cell. The alternative - Google's API with an
 * OAuth client - would need a Cloud project per user, which is more setup
 * than anyone installing an extension will do.
 *
 * ## Why a row's time is read as well as its text
 *
 * Gmail threads by subject, and every code mail an employer sends carries
 * the same subject, so two applications to one employer put two codes in
 * one conversation row and the row shows only the newest. Worse, the
 * search looks back two hours, so a code from an earlier attempt at the
 * same employer is sitting there before this application was even sent.
 * Reading "a row naming this company, holding a code nobody has typed
 * yet" picked that stale code for Lively, Greenhouse answered "Incorrect
 * security code", and because Submit had genuinely been pressed the
 * employer could not be released - one posting permanently consumed with
 * no application behind it.
 *
 * So matching on the company is necessary and is not sufficient. A code is
 * only this application's if the mail carrying it was sent after this
 * application was: `codeForCompany` is the single place that decides, both
 * readers go through it, and it refuses rather than guesses.
 */

import { focus, findTab } from "./tabs.js";

export const SEARCH = '{subject:"security code for your application" from:greenhouse-mail.io} newer_than:2h';
// A row reads "Greenhouse, Security code for your application to Scale AI,
// has attachment, 4:32 PM, Greenhouse Recruiting. Copy and paste this code
// into the security code field on your application: 06053840. After ..."
const SUBJECT = /security code for your application to\s+([^,]+?)\s*(?:,|$)/i;
// Eight characters, which is what Greenhouse sends and what its own form
// asks for in as many words ("enter the 8-character code"). The looser
// six-to-ten this used to allow matched nothing real that eight does not,
// and would have taken a truncated snippet or a trailing reference number
// for a code.
const CODE = /security code field on your application:?\s*([A-Z0-9]{8})\b/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How much older than the submission a mail may claim to be and still be
 * this application's. Gmail's row time has no seconds in it, so a mail
 * sent at 5:54:50 reads as 5:54:00 and a submission at 5:54:30 would
 * otherwise reject its own code. A minute and a half covers that and
 * nothing else: two applications to one employer are held minutes apart
 * by the board pacing, so this cannot reach back to the previous one.
 */
export const ROW_MINUTE_MS = 90000;

/** Where to look. The address picks the account when several are signed in. */
export function mailboxUrl(email) {
  const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
  return `https://mail.google.com/mail/${account}#search/${encodeURIComponent(SEARCH)}`;
}

/* ------------------------------------------------- the mailbox tab */

/**
 * Gmail is slow to start - ten to twenty seconds of loading on a fresh tab -
 * which is most of the wait at a verification step. So the user keeps Gmail
 * open in the Gmail tab of the browser, and the search runs in that tab by
 * changing its hash: Gmail answers a hash change in a second or two without
 * reloading. The tab is handed back on the view it was on when done.
 *
 * Only when no Gmail tab is open does a fresh one get opened, as before.
 */
async function gmailTab() {
  return findTab(["https://mail.google.com/*"], tab => !tab.discarded);
}

function runIn(tabId, func, args = []) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func, args })
    .then((results) => results[0]?.result)
    .catch(() => null);
}

/**
 * Moves Gmail to a view in place. Runs inside the page.
 *
 * This and the four page functions below are exported for the apply
 * module's own reader (apply/verification.js), which runs the same
 * screen-reading one short foreground turn at a time instead of holding the
 * front for the whole wait. Gmail's markup is the fragile part and there is
 * no reason to have two guesses at it, so the port took the polling
 * structure and left these where they are.
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

/** Asks Gmail to re-run the current view. Runs inside the page. */
export function clickRefresh() {
  const button = [...document.querySelectorAll('[role="button"]')].find((node) =>
    /^refresh$/i.test(node.getAttribute("aria-label") ?? node.getAttribute("data-tooltip") ?? ""),
  );
  if (!button) return false;
  button.click();
  return true;
}

/**
 * The tab the mail is read in, with the search showing.
 *
 * `release` puts the tab back: a borrowed tab is returned to the view it was
 * on, a tab opened here is closed.
 */
async function openMailbox({ email, search, openTab, closeTab, log }) {
  const hash = `#search/${encodeURIComponent(search)}`;
  const borrowed = await gmailTab();

  if (borrowed) {
    const previous = (() => {
      try {
        return new URL(borrowed.url).hash || "#inbox";
      } catch {
        return "#inbox";
      }
    })();
    await focus(borrowed.id);
    await runIn(borrowed.id, goToHash, [hash]);
    return {
      tabId: borrowed.id,
      show: () => runIn(borrowed.id, goToHash, [hash]),
      refresh: async () => {
        if (!(await runIn(borrowed.id, clickRefresh))) await runIn(borrowed.id, goToHash, [hash]);
      },
      release: () => runIn(borrowed.id, goToHash, [previous]),
    };
  }

  log?.("info", "Gmail is not open in a tab; opening one. Keep Gmail open in the Gmail tab to make this faster");
  const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
  // Opened on the inbox and moved to the search afterwards, never started on
  // the search itself. Gmail booted straight onto a search hash runs the
  // search but never fills its own search box, and that box is the only
  // thing telling this view apart from the one the tab was on a moment ago.
  // A tab opened the other way therefore never reads as settled: every look
  // waits out all forty tries and then uses the rows anyway, which turned
  // one look into forty seconds and spent most of the code's budget on it.
  const tabId = await openTab(`https://mail.google.com/mail/${account}#inbox`);
  await drawn(tabId);
  await runIn(tabId, goToHash, [hash]);
  return {
    tabId,
    show: () => runIn(tabId, goToHash, [hash]),
    refresh: async () => {
      if (!(await runIn(tabId, clickRefresh))) await runIn(tabId, goToHash, [hash]);
    },
    release: () => closeTab(tabId),
  };
}

/**
 * Waits for a newly opened Gmail to finish drawing.
 *
 * A hash set while Gmail is still starting is set on a page whose router is
 * not listening yet, so it is simply lost and the tab stays on the inbox.
 * Asking for the rows with no search is the same readiness test the reader
 * already uses, with the part about which view it is left out.
 */
async function drawn(tabId) {
  for (let i = 0; i < 30; i++) {
    if ((await runIn(tabId, readRows, [""]))?.settled) return true;
    await wait(1000);
  }
  return false;
}

/**
 * Polls until the list has answered, or the page has failed or signed out.
 *
 * `looks` is the whole budget and it shrinks after the first one. Waiting
 * forty seconds is right for a view that has not drawn yet and wrong for
 * every look after that: by then Gmail is up and showing this search, and
 * a refresh it answers in a second was being given the cold-start budget
 * every time round the loop. With a look costing forty seconds and the
 * pause between looks four, a two-and-a-half minute wait bought three
 * sights of the mailbox.
 */
export const SETTLE_FIRST = 40;
export const SETTLE_AFTER = 12;

async function settledList(tabId, search, signedOutMessage, looks = SETTLE_FIRST) {
  let page = null;
  for (let i = 0; i < looks && !page?.settled && !page?.failure; i++) {
    await wait(i === 0 ? 400 : 1000);
    page = await runIn(tabId, readRows, [search]);
    if (page?.signedOut) throw new Error(signedOutMessage);
  }
  return page;
}

const normalize = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\b(the|inc|llc|ltd|corp|co|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Does the subject name this company?
 *
 * The name on the board is not always the name on the resume: "AlphaSense"
 * against "AlphaSense, Inc.", "Mercury" against "Mercury Technologies",
 * "Scale" against "Scale AI". What all of those have in common is that the
 * shorter name is how the longer one starts, so that is the test: one name
 * is the opening run of words of the other.
 *
 * Whole words, and from the beginning, because the looser readings are both
 * wrong in the same expensive way. Matching a shared first word alone makes
 * "Scale AI" and "Scale Computing" the same company, and matching on
 * substrings makes "Scale" a match for "Upscale Media" - and a code typed
 * into the wrong company's application is the one mistake here that cannot
 * be taken back.
 */
export function namesMatch(subjectCompany, candidates) {
  const subject = words(subjectCompany);
  if (subject.length === 0) return false;
  return candidates.map(words).some((name) => {
    if (name.length === 0) return false;
    const [shorter, longer] = name.length <= subject.length ? [name, subject] : [subject, name];
    return shorter.every((word, at) => longer[at] === word);
  });
}

const words = (name) => normalize(name).split(" ").filter(Boolean);

/** The rows of a Gmail list, as this module reads them. Runs inside the page. */
export function readRows(search) {
  const signedOut = /accounts\.google\.com/.test(location.href);
  // When the mail was sent, which decides whether its code belongs to this
  // application or to the last one at the same employer. The visible cell
  // says "4:32 PM" with no date; the full date is in that cell's tooltip,
  // and a year is what tells it apart from the sender name and the
  // attachment marker, which carry tooltips of their own on the same row.
  //
  // Falling back to the visible cell matters more than it looks. A row
  // whose time cannot be read is not merely undated: `codeForCompany`
  // then falls back to "was this code in the box when the wait began",
  // and the wait begins after Submit while Greenhouse mails the code
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
    // The date cell itself, which is the last cell of the row and the most
    // stable thing in it. Today's mail reads "4:32 PM"; anything older
    // reads "Nov 8", which is all this needs to know - a code from another
    // day is never this application's.
    const shown = String(row.querySelector("td:last-child")?.textContent ?? row.textContent.split(/\s+/).slice(-3).join(" ")).trim();
    const clock = shown.match(/\b(\d{1,2}):(\d{2})\s*([AaPp])?\.?[Mm]?\.?\b/);
    if (clock) {
      const hour = Number(clock[1]) % 12 + (/[Pp]/.test(clock[3] ?? "") ? 12 : 0);
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
  // screen is the search.
  const rows = [...document.querySelectorAll("tr.zA")]
    .filter((row) => row.getClientRects().length > 0)
    .map((row) => ({ text: row.textContent.replace(/\s+/g, " ").trim(), at: timeOf(row) }));
  const main = document.querySelector('[role="main"]')?.textContent ?? "";
  // A tab moved here from the inbox still shows the inbox for a moment, so
  // the list only counts once Gmail has put this search in its box.
  //
  // Matched on the query's plain words rather than on its first
  // space-delimited token, which for the code search is `{subject:"security`
  // - a string Gmail never shows, because it rewrites what it puts in the
  // box: the operator syntax becomes chips, quoting and spacing move, and
  // the braces of an OR group do not survive at all. So this test could
  // not pass, nothing ever read as settled, and every look at the mailbox
  // spent its whole forty-second budget before using the rows anyway. On a
  // two-and-a-half minute wait that is three looks instead of thirty, and
  // it is most of why a code that had arrived was found late or not at all.
  const box = document.querySelector('form[role="search"] input, input[name="q"], input[aria-label="Search mail"], input[aria-label^="Search"]');
  const terms = String(search ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const typed = String(box?.value ?? "").toLowerCase();
  // No box at all is markup that has moved further than this function can
  // follow; the hash is what was asked for and is the honest fallback.
  const searching = !search || !terms.length || (box ? terms.some((term) => typed.includes(term)) : decodeURIComponent(location.hash || "").toLowerCase().includes(terms[0]));
  // The frame of the page is up long before the search has answered, so
  // "loaded" means the list has rows or Gmail has said there are none.
  const settled = searching && (rows.length > 0 || /no messages matched|nothing matched|no results/i.test(main));
  const failure = /temporary error|something went wrong/i.test(document.body?.textContent?.slice(0, 2000) ?? "");
  return { signedOut, settled, failure, rows };
}

/** A row as a piece of mail: who it names, the code in it, when it was sent. */
export function parseRow(row) {
  const text = String((typeof row === "string" ? row : row?.text) ?? "");
  const company = text.match(SUBJECT)?.[1]?.trim() ?? "";
  const code = text.match(CODE)?.[1] ?? "";
  return company && code ? { company, code, at: (typeof row === "string" ? 0 : row?.at) || 0 } : null;
}

/**
 * The one code this application may type, out of everything in the box.
 *
 * Three ways a code in the list is not this application's. The last of
 * them cost Lively; the first is the same mistake waiting to happen:
 *
 *   - it was sent to a different company whose name happens to begin the
 *     same way. `namesMatch` is deliberately generous because the board's
 *     name and the subject's rarely agree exactly, and generous means a
 *     board calling itself "Scale" matches both "Scale AI" and "Scale
 *     Computing". When the matched rows name more than one company, an
 *     exact name settles it and nothing else does: two candidates and no
 *     exact match is refused outright, because a code typed into the
 *     wrong employer's application cannot be taken back.
 *   - it was typed into an application already. That is `used`, shared
 *     across the run.
 *   - it was sent before this application was. `since` is the moment
 *     Submit was pressed, less a minute and a half for the fact that
 *     Gmail's row times have no seconds in them. A row whose time cannot
 *     be read falls back to `seen`, the codes that were already in the
 *     box when this wait began - either way a code that predates the
 *     submission is never used, which is the Lively failure.
 *
 * Returns the code, or why there is not one yet: `refused` is final and
 * `waiting` means look again.
 */
export function codeForCompany(rows, { names, since = 0, used = new Set(), seen = new Set() } = {}) {
  const wanted = [].concat(names).filter(Boolean);
  const mail = rows.map(parseRow).filter(Boolean).filter((row) => namesMatch(row.company, wanted));
  const companies = [...new Set(mail.map((row) => normalize(row.company)))];
  let mine = mail;
  if (companies.length > 1) {
    mine = mail.filter((row) => wanted.some((name) => normalize(name) === normalize(row.company)));
    if (new Set(mine.map((row) => normalize(row.company))).size !== 1)
      return { refused: `the mailbox holds security codes for ${mail.map((row) => row.company).join(" and ")}, and none of them is exactly ${wanted[0]}` };
  }
  const fresh = mine.find((row) => !used.has(row.code) && (row.at ? row.at >= since : !seen.has(row.code)));
  return fresh ? { code: fresh.code, company: fresh.company } : { waiting: true };
}

/**
 * Waits for the code mailed for this application and returns it.
 *
 * `used` is the set of codes already typed into forms this run and `seen`
 * is filled here with whatever was in the box before this wait began;
 * `codeForCompany` wants both, and between them a code can neither be
 * typed twice nor be one that predates the submission.
 */
export async function fetchSecurityCode({ email, company, board, used, submittedAt, openTab, closeTab, log, timeoutMs = 150000 }) {
  const mailbox = await openMailbox({ email, search: SEARCH, openTab, closeTab, log });
  const { tabId } = mailbox;
  const since = (submittedAt ?? Date.now()) - ROW_MINUTE_MS;
  const seen = new Set();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  try {
    while (Date.now() < deadline) {
      attempt += 1;
      const page = await settledList(tabId, SEARCH, "Gmail is not signed in on this browser, so the code cannot be read", attempt === 1 ? SETTLE_FIRST : SETTLE_AFTER);

      if (page?.failure) {
        log?.("warn", "Gmail showed an error page; retrying");
      } else {
        const rows = page?.rows ?? [];
        if (attempt === 1) for (const mail of rows.map(parseRow).filter(Boolean)) seen.add(mail.code);
        const found = codeForCompany(rows, { names: [company, board], since, used, seen });
        if (found.refused) throw new Error(found.refused);
        if (found.code) return found.code;
        if (attempt === 1) {
          log?.(
            "info",
            seen.size > 0
              ? `${company} - no code for this company yet (${seen.size} earlier code mail(s) in the box); waiting`
              : `${company} - no code mail yet; waiting`,
          );
        }
      }

      // The code mail is usually in the box within seconds of Submit, so a
      // short gap between looks is what keeps this step quick.
      await wait(4000);
      await mailbox.refresh();
    }
    throw new Error(`no security code mail for ${company} arrived within ${Math.round(timeoutMs / 1000)} seconds`);
  } finally {
    await mailbox.release();
  }
}

/* ----------------------------------------------------------- Workday */

/**
 * Workday's account mail. A new candidate account on a Workday career
 * site is confirmed by "Verify your candidate account", carrying an
 * activation link into the site, and some sites mail a one-time code
 * instead. The list row carries the sender and the start of the body; the
 * link is only in the opened message, so the row is clicked and the
 * message read.
 *
 * Keyed on the subject with the sender beside it rather than on the sender
 * alone, for the reason the Greenhouse search above is: a sender key that
 * has drifted returns an empty list, which reads exactly like mail that
 * has not arrived, and the account then waits out its full three minutes
 * for a letter already in the box. Forty-one of these mails in one real
 * mailbox were counted, and three of them did not come from Workday's own
 * `<tenant>@otp.workday.com` at all - a tenant may relay the same letter
 * from its own domain (`MyWorkday@group1001.com`,
 * `Roche-Workday-DoNotReply@roche.com`, `mymoose@myworkday.com`). The
 * subject was identical on all forty-one, so that is the half to trust;
 * the sender is kept as an alternative so neither key alone can empty the
 * list.
 */
export const WORKDAY_SEARCH = '{subject:"verify your candidate account" from:otp.workday.com} newer_than:3h';

/** The activation link or code in an opened message. Runs inside the page. */
export function readWorkdayMessage(host) {
  const links = [...document.querySelectorAll('[role="main"] a[href]')]
    .map((anchor) => anchor.href)
    .filter((href) => /\/activate\//i.test(href) && href.toLowerCase().includes(host.toLowerCase()));
  const body = document.querySelector('[role="main"]')?.innerText ?? "";
  const code = body.match(/\b(?:code|passcode)\b[^\d]{0,40}(\d{6,8})\b/i)?.[1] ?? "";
  return { link: links[0] ?? "", code, opened: Boolean(document.querySelector('[role="main"] .a3s, [role="main"] [data-message-id]')) };
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
export function openWorkdayRow(names, index = 0) {
  const wanted = [].concat(names).map((name) => String(name ?? "").toLowerCase()).filter((name) => name.length >= 3);
  const rows = [...document.querySelectorAll("tr.zA")].filter((row) => row.getClientRects().length > 0);
  const verification = rows.filter((row) => /verify|activate|verification|code|confirm/i.test(row.textContent));
  const mine = verification.filter((row) => wanted.some((name) => row.textContent.toLowerCase().includes(name)));
  // Gmail lists newest first, so index 0 is the mail this attempt just
  // caused and anything below it belongs to an earlier one.
  const named = mine.length > 0;
  const row = (named ? mine : verification)[index];
  if (!row) return { clicked: false, rows: rows.length, candidates: verification.length };
  row.click();
  return { clicked: true, named, rows: rows.length, candidates: (named ? mine : verification).length, text: row.textContent.replace(/\s+/g, " ").slice(0, 200) };
}

export async function fetchWorkdayActivation({ email, host, openTab, closeTab, log, timeoutMs = 180000 }) {
  const tenant = String(host).split(".")[0];
  const mailbox = await openMailbox({ email, search: WORKDAY_SEARCH, openTab, closeTab, log });
  const { tabId } = mailbox;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      attempt += 1;
      const page = await settledList(tabId, WORKDAY_SEARCH, "Gmail is not signed in on this browser, so the account mail cannot be read", attempt === 1 ? SETTLE_FIRST : SETTLE_AFTER);
      if (page?.failure) {
        log?.("warn", "Gmail showed an error page; retrying");
      } else {
        const opened = await runIn(tabId, openWorkdayRow, [tenant, 0]);
        if (opened?.clicked) {
          let message = null;
          for (let i = 0; i < 12; i++) {
            await wait(700);
            message = await runIn(tabId, readWorkdayMessage, [host]);
            if (message?.link || message?.code) break;
          }
          if (message?.link) return { link: message.link };
          if (message?.code) return { code: message.code };
          log?.("info", `${tenant} - the mail opened but held no activation link yet; looking again`);
        } else if (attempt === 1) {
          log?.("info", `${tenant} - no account mail from Workday yet (${opened?.rows ?? 0} other mail(s) in the search); waiting`);
        }
      }
      await wait(5000);
      // Opening a row leaves the tab on the message; back to the list, fresh.
      await mailbox.show();
      await wait(800);
      await mailbox.refresh();
    }
    throw new Error(`no account mail from ${tenant} arrived within ${Math.round(timeoutMs / 1000)} seconds`);
  } finally {
    await mailbox.release();
  }
}
