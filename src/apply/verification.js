/**
 * Codes and activation links, read out of a mailbox without holding the
 * foreground.
 *
 * ## The bug this file exists to delete
 *
 * Two boards stop an application until the applicant proves the address:
 * Greenhouse mails an eight-digit security code after Submit, and Workday
 * mails an activation link before the wizard will open at all. The old flow
 * read both out of Gmail, and read them like this:
 *
 *     code = await atFront(() => fetchSecurityCode({ ... }))   // 150s
 *     mail = await atFront(() => fetchWorkdayActivation({ ... })) // 180s
 *
 * `atFront` is the foreground queue (see tabs.js): one tab can be on screen,
 * so page work takes turns at it. Those two calls take a turn and then sit
 * inside it, polling Gmail for up to two and a half and three minutes. For
 * the whole of that time no other job can load a page, read a form or type
 * a character - not Workday jobs, every job. Three applications queued
 * behind one unanswered code mail is a nine-minute stall with nothing
 * running, and the twelve-hour stall in the audit was this shape.
 *
 * The fix is not a shorter timeout. The mail takes as long as it takes. The
 * fix is that waiting is not a turn.
 *
 * ## What a registered wait is
 *
 * Every look at the mailbox here is its own short turn - navigate the Gmail
 * tab to the search, read its rows, press refresh - and every gap between
 * looks is an ordinary `await` holding nothing. Between one look and the
 * next, the foreground belongs to whoever wants it. An attempt suspended on
 * `verification()` costs one pending promise and roughly one turn every
 * four seconds, so a second attempt walks a form at full speed beside it.
 *
 * The waits are registered in a map rather than merely existing, so "what
 * is this run doing" has an answer while nothing appears to be happening:
 * `waiting()` lists every suspended attempt with what it is waiting for and
 * how long it has been waiting, which is what the monitor shows instead of
 * a job that looks hung.
 *
 * ## The other bug: a code that was never this application's
 *
 * Waiting cheaply is half of it. The other half is that the code read at
 * the end of the wait has to be the one this application caused, and for a
 * while it did not have to be: a row naming the company and holding a code
 * nobody had typed yet was enough. Greenhouse threads every code mail
 * under one subject per employer and the search looks back two hours, so
 * for an employer with a second posting that row was already there, with
 * the previous attempt's code in it, before Submit was pressed. Lively was
 * sent that code, Greenhouse said "Incorrect security code", and a sent
 * application cannot be un-sent - the employer was consumed for nothing.
 *
 * `codeForCompany` in mailbox.js is now the only place that decides, and
 * `securityCode` below gives it the two things it needs to: when this
 * application was sent, and what was already in the box when the wait
 * began. It refuses where it cannot tell, and a refusal parks the attempt
 * for a person, which is the cheaper of the two mistakes by a long way.
 *
 * ## Why the page functions are imported rather than copied
 *
 * Gmail's markup is undocumented and moves. `readRows`, `openWorkdayRow`
 * and `readWorkdayMessage` are the selectors that have survived it, and
 * they come from mailbox.js unchanged - this is a port of the *structure*,
 * not of the screen-reading. background.js keeps calling the old functions
 * until it is cut over; both paths read the page the same way, so the
 * fragile part cannot drift into two versions.
 */

import {
  ROW_MINUTE_MS,
  SEARCH,
  WORKDAY_SEARCH,
  clickRefresh,
  codeForCompany,
  goToHash,
  openWorkdayRow,
  parseRow,
  readRows,
  readWorkdayMessage,
} from "../mailbox.js";

/** Between turns, never inside one. That is the whole point of this file. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a code is waited for before the attempt is handed to a person.
 *
 * Much longer than it looks like it needs to be, and the length is the
 * cheapest thing here. The mail itself lands within seconds, but Gmail's
 * *search* does not see a brand new message for a while, and the reader
 * can only find what the search returns: two real applications, to
 * different companies on different days, both took almost exactly 127
 * seconds from Submit to a code being typed, and Crexi ran out at four
 * minutes on a night when the same mailbox was answering in thirty.
 *
 * Running out is not a retry. The application has been sent, so the
 * employer stays claimed and the posting is gone whether or not anyone
 * ever types the code - which makes a few more minutes of waiting, on a
 * wait that holds no tab and no foreground, the cheapest insurance in
 * this file against the most expensive outcome in it.
 *
 * Seven minutes and not more because the attempt around this one is
 * abandoned by the queue at twelve (schedule.js, attemptDeadlineMs) and
 * it has already spent one to three getting to Submit. Waiting past that
 * does not buy a longer wait, it buys the same wait recorded as "no
 * answer from the queue" instead of as the code that never came.
 */
const CODE_MS = 420000;
/** Workday's activation mail is slower; the old path allowed three minutes. */
const ACTIVATION_MS = 180000;
/** Between looks at the list. Short, because the mail usually lands at once. */
const LOOK_MS = 4000;
/**
 * How long a look waits for Gmail's view to answer, and why the second
 * look waits far less than the first.
 *
 * Forty seconds is the cold-start budget: a tab that has just been moved
 * to this search may genuinely need it. Every look after that is a
 * refresh of a view already on screen, which Gmail answers in about a
 * second, and handing those the cold-start budget is what made a look
 * cost forty seconds whenever the settle test failed to pass. Four
 * seconds between looks on top of that bought three sights of the
 * mailbox in two and a half minutes.
 */
const SETTLE_LOOKS = 40;
const SETTLE_AGAIN = 12;
/** Verification mails opened per look before waiting for a newer one. */
const ROW_DEPTH = 3;

/**
 * Said at the end of every way this can fail, because none of them is a
 * retry. Submit was pressed before the board asked for a code, so the
 * application exists at the employer and the claim on it is correct; the
 * only thing left undone is eight digits, and the only thing that must
 * not happen is somebody reading "failed" and applying again.
 */
const UNSENT =
  "; the application was sent, so this employer stays claimed and must not be applied to again - the code is in Gmail and the saved copy of the form is waiting for it";

/**
 * The mailbox reader.
 *
 * `browser` is the ordinary BrowserOps, which is what keeps this honest:
 * every call it makes is one scheduler turn, and there is no way to ask it
 * for a long one.
 */
export function createVerificationService({ browser, log = () => {}, used = new Set(), now = () => Date.now(), lookMs = LOOK_MS }) {
  const waits = new Map();
  let serial = 0;

  /**
   * Suspend this attempt until the mail arrives.
   *
   * Resolves `{code}` or `{link}`; throws when nothing arrived in time,
   * which the engine turns into a parked attempt rather than a failure -
   * the application is still sitting there waiting for a person to type
   * eight digits, and calling that "failed" loses it.
   */
  async function verification(need = {}) {
    const id = `${need.kind ?? "email-code"}:${++serial}`;
    const wait = {
      id,
      kind: need.kind ?? "email-code",
      company: need.company ?? "",
      waitingFor: need.kind === "workday-account" ? "an account activation mail" : "an emailed security code",
      since: now(),
    };
    waits.set(id, wait);
    try {
      return need.kind === "workday-account" ? await activation(need) : await securityCode(need);
    } finally {
      waits.delete(id);
    }
  }

  /** Every attempt currently suspended on a mailbox, for the monitor. */
  const waiting = () => [...waits.values()].map((wait) => ({ ...wait, forMs: now() - wait.since }));

  /* ------------------------------------------------------------- Greenhouse */

  /**
   * `submittedAt` is when this application was sent, and everything older
   * than it in the box belongs to somebody else's application - usually
   * this employer's previous posting, since the search looks back two
   * hours and Greenhouse threads every code mail under one subject. The
   * caller is not obliged to supply it: this runs within a second or two
   * of Submit, so entering the wait is a good enough stand-in, and the
   * codes already in the box are recorded as `before` for the rows whose
   * own time Gmail will not give up.
   */
  async function securityCode({ email, company, board, submittedAt, timeoutMs = CODE_MS }) {
    const names = [company, board].filter(Boolean);
    const since = (submittedAt ?? now()) - ROW_MINUTE_MS;
    const before = new Set();
    const mailbox = await borrow({ browser, email, search: SEARCH, log });
    const deadline = now() + timeoutMs;
    let announced = false, looked = 0;

    try {
      while (now() < deadline) {
        // Only the first look pays the cold-start budget; see SETTLE_LOOKS.
        const page = await settledList(mailbox, SEARCH, "Gmail is not signed in on this browser, so the code cannot be read", looked++ ? SETTLE_AGAIN : SETTLE_LOOKS);

        if (page?.failure) {
          log("warn", "Gmail showed an error page; looking again");
        } else {
          const rows = page?.rows ?? [];
          if (!announced) {
            const mails = rows.map(parseRow).filter(Boolean);
            for (const mail of mails) before.add(mail.code);
            // Gmail's row tooltip is where a mail's own time comes from,
            // and it is undocumented markup that can move. When it has,
            // every code falls back to "was it in the box before this
            // wait" - still safe, but worth seeing in the log rather
            // than inferring from a run full of unexplained parks.
            if (mails.length > 0 && !mails.some((mail) => mail.at)) log("warn", "Gmail is not showing send times on its rows; codes are being told apart only by what was in the box before this application was sent");
          }
          const found = codeForCompany(rows, { names, since, used, seen: before });
          // Refusing is final and deliberate: nothing later in the wait
          // can tell two look-alike companies apart, and the application
          // is better parked for a person than sent a code at random.
          if (found.refused) throw new Error(`${found.refused}; no code was used${UNSENT}`);
          if (found.code) {
            // Two open roles at one company mail two codes into the same
            // conversation row, so a code typed once is never typed again.
            used.add(found.code);
            return { code: found.code };
          }
          if (!announced) {
            announced = true;
            log("info", before.size > 0
              ? `${company} - no code for this company yet (${before.size} earlier code mail(s) in the box); waiting`
              : `${company} - no code mail yet; waiting`);
          }
        }

        await pause(lookMs);
        await mailbox.refresh();
      }
      throw new Error(`no security code mail for ${company} arrived within ${Math.round(timeoutMs / 1000)} seconds${UNSENT}`);
    } finally {
      await mailbox.release();
    }
  }

  /* ---------------------------------------------------------------- Workday */

  /**
   * Workday's mail carries a link rather than a code on most tenants, and
   * the link is only in the opened message - so the row is clicked and the
   * message read. Clicking is a turn; waiting for the message to draw is
   * not.
   *
   * The hard part is which row. A mailbox doing this for a living holds
   * dozens of "Verify your candidate account" mails from dozens of
   * employers, every one of them indistinguishable in the list except for
   * a sender name that is the employer's branding rather than the tenant
   * slug in its address - "OneSource Virtual" for `vhr-osvhr`. So several
   * names are offered, and if none of them matches anything the newest few
   * verification mails are opened in turn instead of giving up. Opening
   * the wrong one costs a few seconds and nothing else: the link is only
   * accepted when it points at the host being applied to, so the message
   * itself is what confirms the guess. A bare code has no host in it to
   * check against, so that is only taken off a row that matched by name.
   */
  async function activation({ email, host, company, timeoutMs = ACTIVATION_MS }) {
    const tenant = String(host ?? "").split(".")[0];
    const names = [...new Set([tenant, ...tenant.split(/[-_.]/), company].filter((name) => String(name ?? "").trim().length >= 3))];
    const mailbox = await borrow({ browser, email, search: WORKDAY_SEARCH, log });
    const deadline = now() + timeoutMs;
    let announced = false, looked = 0;

    try {
      while (now() < deadline) {
        // Only the first look pays the cold-start budget; see SETTLE_LOOKS.
        const page = await settledList(mailbox, WORKDAY_SEARCH, "Gmail is not signed in on this browser, so the account mail cannot be read", looked++ ? SETTLE_AGAIN : SETTLE_LOOKS);

        if (page?.failure) {
          log("warn", "Gmail showed an error page; looking again");
        } else {
          for (let row = 0; row < ROW_DEPTH && now() < deadline; row++) {
            const opened = await mailbox.run(openWorkdayRow, [names, row]);
            if (!opened?.clicked) {
              if (row === 0 && !announced) {
                announced = true;
                log("info", `${tenant} - no account mail from Workday yet (${opened?.rows ?? 0} other mail(s) in the search); waiting`);
              }
              break;
            }
            for (let look = 0; look < 10; look++) {
              await pause(700);
              const message = await mailbox.run(readWorkdayMessage, [host]);
              if (message?.link) return { link: message.link };
              if (message?.code && opened.named) return { code: message.code };
              if (message?.opened) break;
            }
            // Opening a row leaves the tab on the message; back to the list
            // before the next one is tried, or the same row is clicked again.
            await mailbox.show();
            await pause(800);
          }
        }

        await pause(lookMs);
        await mailbox.show();
        await pause(800);
        await mailbox.refresh();
      }
      throw new Error(`no account mail from ${tenant} arrived within ${Math.round(timeoutMs / 1000)} seconds`);
    } finally {
      await mailbox.release();
    }
  }

  /* ------------------------------------------------------------- the list */

  /**
   * One look, taken a turn at a time until the list has answered.
   *
   * The loop looks like the old one and is not: `mailbox.run` is a turn
   * that returns, and the second between tries is an await on nothing. The
   * old version held the front across all forty.
   */
  async function settledList(mailbox, search, signedOutMessage, looks = SETTLE_LOOKS) {
    let page = null;
    for (let look = 0; look < looks && !page?.settled && !page?.failure; look++) {
      await pause(look === 0 ? 400 : 1000);
      page = await mailbox.run(readRows, [search]);
      if (page?.signedOut) throw new Error(signedOutMessage);
    }
    return page;
  }

  return { verification, waiting };
}

/* -------------------------------------------------------------- the tab */

/**
 * The tab the mail is read in, showing the search.
 *
 * A Gmail tab the person already has open is borrowed by changing its hash,
 * which Gmail answers in a second; a cold tab is ten to twenty seconds of
 * loading, and at a verification step that is most of the wait. The tab is
 * handed back on the view it was on.
 */
async function borrow({ browser, email, search, log }) {
  const hash = `#search/${encodeURIComponent(search)}`;
  const open = typeof browser.findTab === "function" ? await browser.findTab(["https://mail.google.com/*"]) : null;

  if (open?.id) {
    const previous = hashOf(open.url);
    await browser.inFrame(open.id, 0, goToHash, [hash]);
    return tab(browser, open.id, hash, () => browser.inFrame(open.id, 0, goToHash, [previous]).catch(() => {}));
  }

  log("info", "Gmail is not open in a tab; opening one. Keep Gmail open to make this faster");
  const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
  // On the inbox first, and onto the search once it has drawn. Gmail booted
  // straight onto a search hash runs the search but leaves its own search
  // box empty, and that box is how `readRows` knows it is looking at this
  // search rather than at whatever the tab showed before - so a tab opened
  // that way never settles, and every look spends its full forty tries.
  // Still one turn at a time: the waiting here is an await on nothing.
  const tabId = await browser.openTab(`https://mail.google.com/mail/${account}#inbox`);
  const cold = tab(browser, tabId, hash, () => browser.closeTab(tabId).catch(() => {}));
  for (let look = 0; look < 30 && !(await cold.run(readRows, [""]))?.settled; look++) await pause(1000);
  await cold.show();
  return cold;
}

function tab(browser, tabId, hash, release) {
  const run = (fn, args = []) => browser.inFrame(tabId, 0, fn, args).catch(() => null);
  return {
    tabId,
    run,
    show: () => run(goToHash, [hash]),
    refresh: async () => {
      if (!(await run(clickRefresh))) await run(goToHash, [hash]);
    },
    release,
  };
}

const hashOf = (url) => {
  try {
    return new URL(url).hash || "#inbox";
  } catch {
    return "#inbox";
  }
};
