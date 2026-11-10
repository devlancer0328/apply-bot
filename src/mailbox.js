/**
 * Reads a security code out of the applicant's mailbox.
 *
 * Some Greenhouse boards hold an application after Submit until the applicant
 * types a code that was mailed to them. The mail comes from Greenhouse's own
 * sender - no-reply@us.greenhouse-mail.io on American boards and
 * no-reply@eu.greenhouse-mail.io on European ones - with the subject
 * "Security code for your application to <Company>" and the code in the first
 * sentence of the body, which is also the snippet both webmail clients show
 * in their list. So the list is enough: the mailbox is opened on a search for
 * those mails, and the row for this company is read without opening it.
 *
 * Gmail and Outlook are both read, and which one is a question for
 * `pickProvider` rather than for anything here. The selectors and the
 * search dialect live in mail-providers.js; what is left in this file is
 * the part that is the same either way - which mail belongs to this
 * application, and what to do while waiting for it.
 *
 * This is screen-reading, not an API. Webmail markup is undocumented and
 * changes, so the selectors used are the ones that have been stable for
 * years and the text of a row is read whole rather than cell by cell. The
 * alternative - Google's API with an OAuth client, or Microsoft Graph with
 * an app registration - would need a cloud project per user, which is more
 * setup than anyone installing an extension will do.
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
 * readers go through it, and it refuses rather than guesses. That is also
 * what lets Outlook's coarser search in: its dialect can only bound by the
 * day, and the bound was never what kept a stale code out.
 */

import { focus, findTab } from "./tabs.js";
import {
  PROVIDERS,
  clearSearch,
  clickRefresh,
  goToHash,
  inboxUrl,
  openWorkdayRow,
  pickProvider,
  providerById,
  readRows,
  readWorkdayMessage,
  searchFor,
  typeSearch,
} from "./mail-providers.js";

// Re-exported under the names three tests, background.js and
// apply/verification.js already import. The page functions are the
// fragile part and there is one copy of each; this is only where they
// are reached from.
export { clickRefresh, goToHash, openWorkdayRow, readRows, readWorkdayMessage };

export const SEARCH = searchFor(providerById("gmail"), "code");
// A Gmail row reads "Greenhouse, Security code for your application to
// Scale AI, has attachment, 4:32 PM, Greenhouse Recruiting. Copy and paste
// this code into the security code field on your application: 06053840.
// After ..." - cells separated by commas, which is where the company name
// used to be taken to end.
//
// Outlook's row is spans rather than cells and they abut, so its text runs
// "...application to Scale AICopy and paste this code into..." with no
// comma anywhere. Reading to the next comma then swallowed the whole body
// into the company name. So the body's own opening is a boundary too: the
// sentence Greenhouse puts first is the snippet both clients show, and it
// is the one thing guaranteed to follow the subject.
const SUBJECT = /security code for your application to\s+(.+?)\s*(?:,|\.|$|(?=copy and paste))/i;
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
export function mailboxUrl(email, provider = pickProvider({ email })) {
  if (provider.id !== "gmail") return inboxUrl(provider, email);
  const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
  return `https://mail.google.com/mail/${account}#search/${encodeURIComponent(searchFor(provider, "code"))}`;
}

/* ------------------------------------------------- the mailbox tab */

/**
 * A webmail client is slow to start - ten to twenty seconds of loading on a
 * fresh tab - which is most of the wait at a verification step. So the user
 * keeps the mailbox open in a tab, and the search runs in that tab: Gmail
 * answers a hash change in a second or two without reloading, and Outlook
 * answers a query typed into its own search box just as quickly. The tab is
 * handed back on the view it was on when done.
 *
 * Only when no mailbox tab is open does a fresh one get opened, as before.
 * Which client that is, when there is nothing open to tell us, is
 * `pickProvider`'s question.
 */
async function openTabFor(provider) {
  return findTab(provider.patterns, (tab) => !tab.discarded);
}

function runIn(tabId, func, args = []) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func, args })
    .then((results) => results[0]?.result)
    .catch(() => null);
}

/**
 * Showing a search, and putting the view back, in whichever client this is.
 *
 * Gmail routes on the hash so a search is a URL; Outlook has no such URL
 * and its search is a control, so the query is typed into the box and
 * entered. This is the only behaviour the two clients do not share, which
 * is why it is the only thing switched on here rather than described in a
 * spec.
 */
const showSearch = (tabId, provider, search) =>
  provider.id === "gmail"
    ? runIn(tabId, goToHash, [`#search/${encodeURIComponent(search)}`])
    : runIn(tabId, typeSearch, [search, provider.spec.box]);

const restoreView = (tabId, provider, previous) =>
  provider.id === "gmail" ? runIn(tabId, goToHash, [previous || "#inbox"]) : runIn(tabId, clearSearch, [provider.spec.box]);

/**
 * The tab the mail is read in, with the search showing.
 *
 * `release` puts the tab back: a borrowed tab is returned to the view it was
 * on, a tab opened here is closed.
 */
async function openMailbox({ email, provider, search, openTab, closeTab, log }) {
  const borrowed = await openTabFor(provider);
  const controls = (tabId, release) => ({
    tabId,
    provider,
    show: () => showSearch(tabId, provider, search),
    refresh: async () => {
      if (!(await runIn(tabId, clickRefresh, [provider.spec.refresh]))) await showSearch(tabId, provider, search);
    },
    release,
  });

  if (borrowed) {
    const previous = (() => {
      try {
        return new URL(borrowed.url).hash || "#inbox";
      } catch {
        return "#inbox";
      }
    })();
    await focus(borrowed.id);
    await showSearch(borrowed.id, provider, search);
    return controls(borrowed.id, () => restoreView(borrowed.id, provider, previous));
  }

  log?.("info", `${provider.name} is not open in a tab; opening one. Keep ${provider.name} open in a tab to make this faster`);
  // Opened on the inbox and moved to the search afterwards, never started on
  // the search itself. Gmail booted straight onto a search hash runs the
  // search but never fills its own search box, and that box is the only
  // thing telling this view apart from the one the tab was on a moment ago.
  // A tab opened the other way therefore never reads as settled: every look
  // waits out all forty tries and then uses the rows anyway, which turned
  // one look into forty seconds and spent most of the code's budget on it.
  const tabId = await openTab(inboxUrl(provider, email));
  await drawn(tabId, provider);
  await showSearch(tabId, provider, search);
  return controls(tabId, () => closeTab(tabId));
}

/**
 * Waits for a newly opened mailbox to finish drawing.
 *
 * A hash set while Gmail is still starting is set on a page whose router is
 * not listening yet, so it is simply lost and the tab stays on the inbox;
 * a query typed into an Outlook search box that has not been built yet goes
 * nowhere at all. Asking for the rows with no search is the same readiness
 * test the reader already uses, with the part about which view it is left
 * out.
 */
async function drawn(tabId, provider) {
  for (let i = 0; i < 30; i++) {
    if ((await runIn(tabId, readRows, ["", provider.spec]))?.settled) return true;
    await wait(1000);
  }
  return false;
}

/**
 * Polls until the list has answered, or the page has failed or signed out.
 *
 * `looks` is the whole budget and it shrinks after the first one. Waiting
 * forty seconds is right for a view that has not drawn yet and wrong for
 * every look after that: by then the client is up and showing this search,
 * and a refresh it answers in a second was being given the cold-start
 * budget every time round the loop. With a look costing forty seconds and
 * the pause between looks four, a two-and-a-half minute wait bought three
 * sights of the mailbox.
 */
export const SETTLE_FIRST = 40;
export const SETTLE_AFTER = 12;

async function settledList(tabId, provider, search, signedOutMessage, looks = SETTLE_FIRST) {
  let page = null;
  for (let i = 0; i < looks && !page?.settled && !page?.failure; i++) {
    await wait(i === 0 ? 400 : 1000);
    page = await runIn(tabId, readRows, [search, provider.spec]);
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
export async function fetchSecurityCode({ email, company, board, used, submittedAt, openTab, closeTab, log, provider = pickProvider({ email }), timeoutMs = 150000 }) {
  const search = searchFor(provider, "code");
  const mailbox = await openMailbox({ email, provider, search, openTab, closeTab, log });
  const { tabId } = mailbox;
  const since = (submittedAt ?? Date.now()) - ROW_MINUTE_MS;
  const seen = new Set();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  try {
    while (Date.now() < deadline) {
      attempt += 1;
      const page = await settledList(tabId, provider, search, `${provider.name} is not signed in on this browser, so the code cannot be read`, attempt === 1 ? SETTLE_FIRST : SETTLE_AFTER);

      if (page?.failure) {
        log?.("warn", `${provider.name} showed an error page; retrying`);
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
export const WORKDAY_SEARCH = searchFor(providerById("gmail"), "workday");

export async function fetchWorkdayActivation({ email, host, openTab, closeTab, log, provider = pickProvider({ email }), timeoutMs = 180000 }) {
  const tenant = String(host).split(".")[0];
  const search = searchFor(provider, "workday");
  const mailbox = await openMailbox({ email, provider, search, openTab, closeTab, log });
  const { tabId } = mailbox;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      attempt += 1;
      const page = await settledList(tabId, provider, search, `${provider.name} is not signed in on this browser, so the account mail cannot be read`, attempt === 1 ? SETTLE_FIRST : SETTLE_AFTER);
      if (page?.failure) {
        log?.("warn", `${provider.name} showed an error page; retrying`);
      } else {
        const opened = await runIn(tabId, openWorkdayRow, [tenant, 0, provider.spec.rows]);
        if (opened?.clicked) {
          let message = null;
          for (let i = 0; i < 12; i++) {
            await wait(700);
            message = await runIn(tabId, readWorkdayMessage, [host, provider.spec.message, provider.spec.opened]);
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
