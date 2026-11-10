/**
 * The twelve-hour stall, as a test.
 *
 * One tab can be on screen, so page work takes turns at the foreground
 * queue in tabs.js. The old mailbox readers took a turn and then sat inside
 * it polling Gmail for up to two and a half minutes (`fetchSecurityCode`)
 * and three (`fetchWorkdayActivation`), during which no other job could
 * load a page, read a form or type a character.
 *
 * This file runs the real `atFront` from tabs.js - not a copy of it - with
 * one attempt suspended on a verification code and a second attempt doing
 * ordinary page work beside it, and measures whether the second one gets
 * the foreground. The old shape is run as well, so the numbers are a
 * comparison rather than an assertion about what "fast" means.
 *
 * Gmail is a fixture here and no mail is sent anywhere. The mailbox the
 * reader screen-reads is linkedom holding the markup Gmail actually
 * produces for a list row, which is what `readRows` and `parseRow` parse.
 */

import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { atFront, resident } from "../src/tabs.js";
import { SEARCH, WORKDAY_SEARCH } from "../src/mailbox.js";
import { createVerificationService } from "../src/apply/verification.js";

let count = 0;
const test = async (name, work) => {
  await work();
  count++;
  console.log("PASS " + name);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Printed at the end: the point of this file is the numbers, not the ticks. */
const measured = [];

/* ------------------------------------------------------------- the fixture */

/**
 * A Gmail list row, in the markup the reader expects to find - including
 * the date cell's tooltip, which is the only place the mail's own time
 * appears and is now what decides whether its code is this application's.
 */
const row = (text, at = Date.now()) =>
  `<tr class="zA"><td>${text}</td>${at ? `<td class="xW xY"><span title="${new Date(at).toUTCString()}">5:54 PM</span></td>` : ""}</tr>`;
/**
 * The clock Gmail prints inside the snippet, kept away from the current
 * minute.
 *
 * Gmail puts the row's time in the snippet text as well as in the date
 * cell, and a row drawn without that cell hands the snippet to the time
 * reader - which is the whole point of the stale-code test below. A
 * fixed "5:54 PM" therefore made this file fail for the ninety seconds
 * a day when 5:54 PM is now: the reader parses it as today at 5:54,
 * which is neither in the future (so it is not discarded) nor safely in
 * the past (so it clears `since`), and the stale code is accepted.
 * Three hours ahead is never the current minute, whatever time the
 * suite is run at.
 */
const shownTime = () => {
  const at = new Date(Date.now() + 3 * 3600000);
  return `${((at.getHours() + 11) % 12) + 1}:${String(at.getMinutes()).padStart(2, "0")} ${at.getHours() < 12 ? "AM" : "PM"}`;
};
const codeMail = (company, code) =>
  `Greenhouse 2, Security code for your application to ${company}, ${shownTime()}, Copy and paste this code into the security code field on your application: ${code}. After that...`;
const CODE_MAIL = codeMail("Example Corp", "53329416");
const WORKDAY_MAIL = `Example Tenant, Verify your candidate account, ${shownTime()}, Please verify your account to continue.`;
/**
 * Gmail's own search box, holding both searches at once so one fixture
 * serves both readers. Taken from the exported constants rather than
 * written out: `readRows` only counts a list as settled when the box holds
 * the query that was asked for, so a fixture with yesterday's wording
 * leaves every look here waiting out all forty tries for nothing.
 */
const SEARCH_BOX = `${SEARCH} ${WORKDAY_SEARCH}`.replaceAll('"', "&quot;");

/**
 * A browser whose every call is one short turn on the real queue.
 *
 * This is `chrome-ops.js` with linkedom where Chrome would be: same shape,
 * same `turn(work)` around every method, so what is being measured is the
 * scheduler and the caller's use of it rather than a reimplementation of
 * either.
 */
/**
 * `mails` is the inbox when a test wants to say exactly what is in it:
 * `{text, afterMs, at}`, where `at` of zero is a row whose time Gmail will
 * not give up and `afterMs` is when the mail turns up. Left out, the
 * inbox is the one code mail and the one Workday mail the older tests use.
 */
function fakeBrowser({ mailAfterMs = 0, mails = null, now = () => Date.now(), turns = [] } = {}) {
  const started = now();
  const pages = new Map();
  let nextId = 100;

  const gmail = () => {
    const has = now() - started >= mailAfterMs;
    const listed = mails
      ? mails.filter((mail) => now() - started >= (mail.afterMs ?? 0)).map((mail) => row(mail.text, mail.at === 0 ? 0 : (mail.at ?? started + (mail.afterMs ?? 0))))
      : has
        ? [row(CODE_MAIL, started + mailAfterMs), row(WORKDAY_MAIL, started + mailAfterMs)]
        : [];
    const { document, window } = parseHTML(
      `<html><body>
        <form role="search"><input name="q" value="${SEARCH_BOX}"></form>
        <div role="main">${listed.length ? "" : "No messages matched your search."}
          ${listed.join("")}
          ${!mails && has ? '<div data-message-id="m1"><a href="https://example.wd1.myworkdayjobs.com/activate/abc">Verify</a> Your code is 884422</div>' : ""}
        </div>
        <div role="button" aria-label="Refresh"></div>
      </body></html>`,
    );
    // linkedom has no layout, so every node reports no client rects; the
    // reader filters on those to skip Gmail's hidden lists.
    for (const node of document.querySelectorAll("tr.zA")) node.getClientRects = () => [{ width: 100, height: 20 }];
    return { document, window, location: { href: "https://mail.google.com/mail/#search/x", hash: "#search/x" } };
  };

  const turn = async (name, work) => {
    const queued = now();
    return atFront(async () => {
      const at = now();
      const value = await work();
      turns.push({ name, waited: at - queued, held: now() - at, at });
      return value;
    });
  };

  return {
    openTab: async (url) => {
      const id = ++nextId;
      pages.set(id, url);
      return turn("openTab", async () => id);
    },
    closeTab: (tabId) => turn("closeTab", async () => pages.delete(tabId)),
    navigate: (tabId, url) => turn("navigate", async () => pages.set(tabId, url)),
    findTab: async (patterns) => (patterns.some((pattern) => /mail\.google/.test(pattern)) ? { id: 7, url: "https://mail.google.com/mail/#inbox" } : null),
    inject: (tabId, files) => turn("inject", async () => files),
    info: async (tabId) => ({ url: pages.get(tabId) ?? "https://mail.google.com/", status: "complete", title: "" }),
    capture: (tabId) => turn("capture", async () => ({ url: pages.get(tabId), title: "", capturedAt: now() })),
    frames: (tabId) => turn("frames", async () => []),
    /** Runs the page function against the fixture, exactly as executeScript would. */
    inFrame: (tabId, frameId, fn, args = []) =>
      turn("inFrame", async () => {
        const page = gmail();
        const previous = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
        Object.assign(globalThis, { window: page.window, document: page.document, location: page.location });
        try {
          return fn(...args);
        } finally {
          Object.assign(globalThis, previous);
        }
      }),
  };
}

/* ------------------------------------------------------------------ tests */

await test("The mailbox reader finds a code without ever holding the foreground for longer than a turn", async () => {
  const turns = [];
  const browser = fakeBrowser({ mailAfterMs: 0, turns });
  const { verification, waiting } = createVerificationService({ browser, log: () => {} });

  assert.deepEqual(waiting(), []);
  const asked = verification({ kind: "email-code", email: "someone@example.test", company: "Example Corp" });
  await pause(50);
  const suspended = waiting();
  assert.equal(suspended.length, 1, "an attempt waiting on a mailbox is registered, so the monitor can say what it is doing");
  assert.equal(suspended[0].waitingFor, "an emailed security code");

  assert.deepEqual(await asked, { code: "53329416" });
  assert.deepEqual(waiting(), [], "the wait is deregistered when it resolves");
  assert.ok(turns.length >= 2, "the reader took turns rather than one long one");
  const longest = Math.max(...turns.map((entry) => entry.held));
  assert.ok(longest < 100, `no turn may sit waiting; the longest held the front for ${longest}ms`);
});

await test("A second attempt keeps the foreground while the first is suspended on a code that has not arrived", async () => {
  const turns = [];
  // The mail lands after a second. The old code would have held the front
  // for the whole of that; this run has to give it away ten times over.
  const browser = fakeBrowser({ mailAfterMs: 1000, turns });
  const { verification, waiting } = createVerificationService({ browser, log: () => {} });

  const waiter = verification({ kind: "email-code", email: "someone@example.test", company: "Example Corp" });

  // The other job: ordinary page work, the kind every queued application is
  // made of. It starts after the mailbox reader has already suspended.
  await pause(60);
  const progress = [];
  const worker = (async () => {
    for (let step = 0; step < 10; step++) {
      const at = Date.now();
      await browser.inFrame(999, 0, () => 1);
      progress.push({ step, waitedMs: Date.now() - at });
      await pause(20);
    }
  })();

  const [code] = await Promise.all([waiter, worker]);
  assert.deepEqual(code, { code: "53329416" });

  assert.equal(progress.length, 10, "every turn the second attempt asked for was taken");
  const worst = Math.max(...progress.map((entry) => entry.waitedMs));
  assert.ok(worst < 250, `a queued job waited ${worst}ms for the foreground while a mailbox was being read`);

  // The property, stated the way the bug was: work from the second attempt
  // is interleaved *between* the mailbox reader's turns rather than queued
  // behind all of them.
  const reader = turns.filter((entry) => entry.name === "inFrame").length;
  assert.ok(reader > 10, "the mailbox was polled many times, so there was something to starve");
  const longest = Math.max(...turns.map((entry) => entry.held));
  assert.ok(longest < 100, `the longest single turn held the front for ${longest}ms`);
  measured.push(`  mailbox read over ${reader} turns; longest turn ${longest}ms; worst wait for a queued job ${worst}ms`);
});

await test("The old shape starves the queue for the whole of its timeout, which is the regression being guarded", async () => {
  // `fetchSecurityCode` wrapped in `atFront`, reduced to its one relevant
  // property: a turn that contains the wait. Run against the same queue so
  // the comparison is like for like.
  const held = 400;
  const other = [];
  const stalled = atFront(async () => {
    await pause(held);
    return "53329416";
  });
  await pause(20);
  const at = Date.now();
  await atFront(async () => other.push(Date.now() - at));
  assert.equal(await stalled, "53329416");
  assert.ok(other[0] > held - 120, `the old shape made a queued job wait ${other[0]}ms, which is the stall`);
  measured.push(`  old shape: one ${held}ms held turn made a queued job wait ${other[0]}ms - at the real 150000ms timeout that is the stall`);
});

await test("Workday's activation mail is read the same way, and yields the link rather than a code", async () => {
  const turns = [];
  const browser = fakeBrowser({ mailAfterMs: 0, turns });
  const { verification } = createVerificationService({ browser, log: () => {} });
  const mail = await verification({ kind: "workday-account", email: "someone@example.test", host: "example.wd1.myworkdayjobs.com", company: "Example Tenant" });
  assert.equal(mail.link, "https://example.wd1.myworkdayjobs.com/activate/abc");
  const longest = Math.max(...turns.map((entry) => entry.held));
  assert.ok(longest < 100, `no turn may sit waiting; the longest held the front for ${longest}ms`);
});

await test("A code that never arrives times out as a thrown error, so the attempt parks rather than failing silently", async () => {
  const browser = fakeBrowser({ mailAfterMs: 10 * 60 * 1000 });
  const { verification, waiting } = createVerificationService({ browser, log: () => {}, lookMs: 150 });
  await assert.rejects(
    verification({ kind: "email-code", email: "someone@example.test", company: "Example Corp", timeoutMs: 1200 }),
    /no security code mail for Example Corp arrived/,
  );
  assert.deepEqual(waiting(), [], "a wait that timed out is deregistered too");
});

await test("A code is never typed into two applications", async () => {
  const used = new Set();
  const browser = fakeBrowser({ mailAfterMs: 0 });
  const { verification } = createVerificationService({ browser, log: () => {}, used, lookMs: 150 });
  assert.deepEqual(await verification({ kind: "email-code", email: "x@example.test", company: "Example Corp" }), { code: "53329416" });
  await assert.rejects(
    verification({ kind: "email-code", email: "x@example.test", company: "Example Corp", timeoutMs: 900 }),
    /arrived within/,
    "the same code is not handed to a second application for the same company",
  );
});

/* ------------------------------------------- the code belongs to the company */

/** A mailbox doing this for a living: several employers' codes at once. */
const BUSY_INBOX = [
  { text: codeMail("Crexi", "11112222"), afterMs: 0 },
  { text: codeMail("Omada Health", "33334444"), afterMs: 0 },
  { text: codeMail("Lively", "55556666"), afterMs: 0 },
];

await test("Three companies' codes are in the box and only the one this application was sent gets used", async () => {
  const used = new Set();
  for (const [company, code] of [["Crexi", "11112222"], ["Omada Health", "33334444"], ["Lively", "55556666"]]) {
    // Each attempt submits now, so all three mails read as its own; the
    // company name is the only thing telling them apart here.
    const browser = fakeBrowser({ mails: BUSY_INBOX });
    const { verification } = createVerificationService({ browser, log: () => {}, used, lookMs: 100 });
    assert.deepEqual(await verification({ kind: "email-code", email: "x@example.test", company }), { code });
  }
  assert.deepEqual([...used].sort(), ["11112222", "33334444", "55556666"]);
});

await test("A company whose name merely begins the same way is refused rather than guessed at", async () => {
  // "Scale" is how a board names itself and how both of these start, which
  // is exactly the generosity that makes the match work for "AlphaSense"
  // against "AlphaSense, Inc." - so the tie is refused instead of taken.
  const browser = fakeBrowser({
    mails: [{ text: codeMail("Scale AI", "77778888") }, { text: codeMail("Scale Computing", "99990000") }],
  });
  const { verification } = createVerificationService({ browser, log: () => {}, lookMs: 100 });
  await assert.rejects(
    verification({ kind: "email-code", email: "x@example.test", company: "Scale", timeoutMs: 4000 }),
    /holds security codes for Scale AI and Scale Computing.*no code was used/s,
  );
});

await test("An exact name settles the tie, so the near miss costs the right company nothing", async () => {
  const browser = fakeBrowser({
    mails: [{ text: codeMail("Scale AI", "77778888") }, { text: codeMail("Scale Computing", "99990000") }],
  });
  const { verification } = createVerificationService({ browser, log: () => {}, lookMs: 100 });
  assert.deepEqual(await verification({ kind: "email-code", email: "x@example.test", company: "Scale AI" }), { code: "77778888" });
});

await test("The Lively failure: a code sent before this application was is never typed into it", async () => {
  // One employer, two postings. The first attempt's code has been sitting
  // in the conversation row for four minutes; this attempt submitted just
  // now. Taking the old one is what burned the employer.
  const submittedAt = Date.now();
  const browser = fakeBrowser({
    mails: [
      { text: codeMail("Lively", "11110000"), at: submittedAt - 240000 },
      { text: codeMail("Lively", "22220000"), afterMs: 300, at: submittedAt + 1000 },
    ],
  });
  const { verification } = createVerificationService({ browser, log: () => {}, lookMs: 100 });
  assert.deepEqual(await verification({ kind: "email-code", email: "x@example.test", company: "Lively", submittedAt }), { code: "22220000" });
});

await test("A stale code on a row with no readable time is refused on what the box held when the wait began", async () => {
  const browser = fakeBrowser({ mails: [{ text: codeMail("Lively", "11110000"), at: 0 }] });
  const { verification } = createVerificationService({ browser, log: () => {}, lookMs: 100 });
  await assert.rejects(
    verification({ kind: "email-code", email: "x@example.test", company: "Lively", timeoutMs: 1200 }),
    /must not be applied to again/,
    "a code already in the box is not this application's, and running out says so without inviting a second application",
  );
});

resident(null);
console.log(measured.join("\n"));
console.log(`${count} foreground-starvation checks passed.`);
