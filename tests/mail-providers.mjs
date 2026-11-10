/**
 * Which mailbox gets read, and whether one reader can read both.
 *
 * The code reader was Gmail's alone: its hash routing, its search
 * dialect, its row class. Outlook asks for the same four things - show me
 * this search, give me the rows, refresh, put the tab back - so what
 * separates them is a spec, and the part that decides whether a code
 * belongs to this application stays single. These check the choosing and
 * the dialects; the markup itself cannot be checked without a signed-in
 * mailbox, which is what scripts/outlook-mail-probe.mjs is for.
 */
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { PROVIDERS, pickProvider, providerForUrl, inboxUrl, searchFor, readRows, providerById } from '../src/mail-providers.js';
import { parseRow, codeForCompany } from '../src/mailbox.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const gmail = providerById('gmail');
const outlook = providerById('outlook');

test('a mailbox already open is the answer, whatever the address says', () => {
  // The fast path and the strongest signal: a tab open now is evidence,
  // and borrowing it costs a second where a cold tab costs twenty.
  assert.equal(pickProvider({ openUrls: ['https://outlook.office.com/mail/0/inbox'], email: 'd@gmail.com' }).id, 'outlook');
  assert.equal(pickProvider({ openUrls: ['https://mail.google.com/mail/u/0/#inbox'], email: 'd@outlook.com' }).id, 'gmail');
});

test('the consumer domains are settled by the address alone', () => {
  for (const email of ['d@outlook.com', 'd@hotmail.com', 'd@live.com', 'd@msn.com', 'd@outlook.co.uk'])
    assert.equal(pickProvider({ email }).id, 'outlook', email);
  for (const email of ['d@gmail.com', 'd@googlemail.com']) assert.equal(pickProvider({ email }).id, 'gmail', email);
});

test('a custom domain falls to Gmail, which is what every profile had before', () => {
  // acme.com is as likely to be Microsoft 365 as Google Workspace and the
  // address cannot say which, so this is the case the setting exists for.
  assert.equal(pickProvider({ email: 'd@acme.com' }).id, 'gmail');
  assert.equal(pickProvider({ stated: 'outlook', email: 'd@acme.com' }).id, 'outlook');
});

test('the stated choice beats an open tab, because only it can be wrong on purpose', () => {
  assert.equal(pickProvider({ stated: 'outlook', openUrls: ['https://mail.google.com/mail/u/0/'], email: 'd@gmail.com' }).id, 'outlook');
  assert.equal(pickProvider({ stated: 'gmail', openUrls: ['https://outlook.live.com/mail/0/'], email: 'd@outlook.com' }).id, 'gmail');
});

test('a tab that is not a mailbox is not mistaken for one', () => {
  for (const url of ['https://job-boards.greenhouse.io/acme/jobs/1', 'https://mail.google.com.evil.test/', 'https://outlook.live.com.evil.test/mail/', ''])
    assert.equal(providerForUrl(url), null, url);
  assert.equal(providerForUrl('https://outlook.office365.com/mail/0/inbox')?.id, 'outlook');
});

test('a cold tab opens on the host the account actually lives on', () => {
  // A work account is not reachable at outlook.live.com and a consumer one
  // is not reachable at outlook.office.com; each redirects to a sign-in,
  // which this module would read as a signed-out mailbox.
  assert.match(inboxUrl(outlook, 'd@outlook.com'), /outlook\.live\.com/);
  assert.match(inboxUrl(outlook, 'd@acme.com'), /outlook\.office\.com/);
  // Never onto the search itself; see the note on `borrow`.
  assert.match(inboxUrl(gmail, 'd@gmail.com'), /#inbox$/);
  assert.match(inboxUrl(gmail, 'd@gmail.com'), /authuser=d%40gmail\.com/);
});

test('each client is asked in its own dialect', () => {
  // Gmail reads an OR group in braces and newer_than; Outlook reads
  // neither, so it gets the quoted phrase - which it matches against the
  // body as well as the subject - and a date bound, the finest grain it
  // offers.
  assert.match(searchFor(gmail, 'code'), /newer_than:2h/);
  assert.match(searchFor(gmail, 'workday'), /newer_than:3h/);
  const code = searchFor(outlook, 'code');
  assert.match(code, /^"security code for your application" received>=\d{1,2}\/\d{1,2}\/\d{4}$/);
  assert.doesNotMatch(code, /newer_than|[{}]/);
  assert.match(searchFor(outlook, 'workday'), /^"verify your candidate account" received>=/);
});

test("the date bound reaches back a day, so a code sent before midnight is not cut off", () => {
  const [month, day, year] = searchFor(outlook, 'code').match(/(\d+)\/(\d+)\/(\d+)/).slice(1).map(Number);
  const bound = new Date(year, month - 1, day).getTime();
  const ago = Date.now() - bound;
  assert.ok(ago >= 86400000 && ago < 86400000 * 2 + 3600000 * 25, `bound is ${ago}ms back`);
});

/* ---------------------------------------- one reader, two sets of markup */

const page = (html, url, rowSelector) => {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  // linkedom gives no layout, so every element reports no client rects and
  // the on-screen filter would drop the whole list.
  for (const row of document.querySelectorAll(rowSelector)) row.getClientRects = () => [{}];
  return { document, location: { href: url, hash: new URL(url).hash } };
};
const withGlobals = (globals, work) => {
  const saved = Object.fromEntries(Object.keys(globals).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try { return work(); } finally { Object.assign(globalThis, saved); }
};

const BODY = 'Copy and paste this code into the security code field on your application: 06053840. After that';
const SUBJECT = 'Security code for your application to Scale AI';

test("Gmail's rows are read as they always were", () => {
  const window = page(`<div role="main"><table><tr class="zA">
    <td><span>Greenhouse</span></td>
    <td>${SUBJECT}, ${BODY}</td>
    <td><span title="Mon, Nov 9, 2026 at 4:32 PM">4:32 PM</span></td>
  </tr></table></div><form role="search"><input name="q" value='{subject:"security code for your application"}'></form>`, 'https://mail.google.com/mail/u/0/', 'tr.zA');
  const read = withGlobals(window, () => readRows(searchFor(gmail, 'code'), gmail.spec));
  assert.equal(read.signedOut, false);
  assert.equal(read.settled, true);
  const mail = parseRow(read.rows[0]);
  assert.equal(mail.company, 'Scale AI');
  assert.equal(mail.code, '06053840');
  assert.equal(new Date(mail.at).getFullYear(), 2026);
});

test("Outlook's rows reach the same mail through different markup", () => {
  // Outlook hangs the whole summary, date included, on the row itself
  // rather than on a cell inside it - which is why `timeOf` looks at the
  // row's own label before it falls back to reading text.
  const window = page(`<div role="main"><div role="listbox">
    <div role="option" data-convid="1" aria-label="Unread, Greenhouse, ${SUBJECT}, Mon, Nov 9, 2026 4:32 PM">
      <span>Greenhouse</span><span>${SUBJECT}</span><span>${BODY}</span><span>4:32 PM</span>
    </div>
  </div></div><input id="topSearchInput" value='"security code for your application" received>=11/8/2026'>`, 'https://outlook.live.com/mail/0/', 'div[role="option"]');
  const read = withGlobals(window, () => readRows(searchFor(outlook, 'code'), outlook.spec));
  assert.equal(read.signedOut, false);
  assert.equal(read.settled, true);
  const mail = parseRow(read.rows[0]);
  assert.equal(mail.company, 'Scale AI');
  assert.equal(mail.code, '06053840');
  assert.equal(new Date(mail.at).getFullYear(), 2026);
});

test('the rule about whose code this is does not change with the client', () => {
  // The one decision that must never fork: a code is this application's
  // only if the mail carrying it was sent after the application was.
  const mail = (at) => ({ text: `Greenhouse, ${SUBJECT}, ${BODY}`, at });
  const sent = Date.parse('2026-11-09T16:32:00Z');
  for (const provider of PROVIDERS) {
    const fresh = codeForCompany([mail(sent + 1000)], { names: ['Scale AI'], since: sent });
    assert.equal(fresh.code, '06053840', provider.id);
    const stale = codeForCompany([mail(sent - 600000)], { names: ['Scale AI'], since: sent });
    assert.equal(stale.waiting, true, provider.id);
  }
});

test('a signed-out mailbox is recognised in either client', () => {
  const google = page('', 'https://accounts.google.com/signin/v2/identifier', 'tr.zA');
  assert.equal(withGlobals(google, () => readRows('', gmail.spec)).signedOut, true);
  const microsoft = page('', 'https://login.microsoftonline.com/common/oauth2/authorize', 'div[role="option"]');
  assert.equal(withGlobals(microsoft, () => readRows('', outlook.spec)).signedOut, true);
  // And a mailbox that is merely empty is not read as signed out.
  const empty = page('<div role="main">We didn\'t find anything to show here.</div><input id="topSearchInput" value=\'"security code for your application"\'>', 'https://outlook.live.com/mail/0/', 'div[role="option"]');
  const read = withGlobals(empty, () => readRows(searchFor(outlook, 'code'), outlook.spec));
  assert.equal(read.signedOut, false);
  assert.equal(read.settled, true);
  assert.deepEqual(read.rows, []);
});

test('a view that has not caught up yet is not read as an empty mailbox', () => {
  // The tab still shows what it showed a moment ago. Reading that as "no
  // code yet" is how a code already in the box gets missed.
  const stale = page(`<div role="main">Inbox</div><input id="topSearchInput" value="">`, 'https://outlook.live.com/mail/0/', 'div[role="option"]');
  assert.equal(withGlobals(stale, () => readRows(searchFor(outlook, 'code'), outlook.spec)).settled, false);
});

console.log(`\n${count} mail-provider checks passed.`);
