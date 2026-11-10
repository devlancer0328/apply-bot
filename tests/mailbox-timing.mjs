/**
 * Why a security code that had arrived was found late, or not at all.
 *
 * Two independent defects, both in the screen-reading rather than in the
 * waiting, and both invisible from the outside because each failure
 * looks exactly like mail that has not been sent yet.
 *
 *   - The list never read as settled, so every look at the mailbox spent
 *     its whole forty-second budget before using the rows anyway. On a
 *     two-and-a-half minute wait that is three looks instead of thirty.
 *   - A row whose send time could not be read fell back to "was this
 *     code in the box when the wait began" - and the wait begins after
 *     Submit while the code is mailed within a second or two of it. So
 *     the normal case, a code that arrives promptly, was recorded as
 *     having been there all along and then refused for the whole wait.
 *
 * These run the real page functions against Gmail's markup rather than a
 * description of it, because the markup is the part that was wrong.
 */
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { codeForCompany, parseRow, readRows, ROW_MINUTE_MS } from '../src/mailbox.js';
import { providerById } from '../src/mail-providers.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const SEARCH = '{subject:"security code for your application" from:greenhouse-mail.io} newer_than:2h';
const body = (company, code) => `Greenhouse, Security code for your application to ${company}, Copy and paste this code into the security code field on your application: ${code}. After that you can...`;

/**
 * One Gmail list, as the page sees it. `box` is what Gmail put in its own
 * search input, which is never the query as it was written.
 */
function gmail({ rows = [], box = '', hash = '', main = '' } = {}) {
  const list = rows.map((row) => `<tr class="zA">
    <td><span title="${row.sender ?? 'Greenhouse Recruiting'}">Greenhouse</span></td>
    <td>${row.text}</td>
    <td${row.tooltip ? ` title="${row.tooltip}"` : ''}>${row.shown ?? ''}</td>
  </tr>`).join('');
  const { document, window } = parseHTML(`<html><body>
    <form role="search"><input name="q" value="${box}"></form>
    <div role="main">${main}<table>${list}</table></div>
  </body></html>`);
  // linkedom gives no layout, so every element reports no client rects and
  // the visibility filter would drop the whole list.
  for (const row of document.querySelectorAll('tr.zA')) row.getClientRects = () => [{}];
  window.location = { href: 'https://mail.google.com/mail/u/0/' + hash, hash };
  const globals = { document, location: window.location };
  const saved = Object.fromEntries(Object.keys(globals).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try { return readRows(SEARCH, providerById('gmail').spec); } finally { Object.assign(globalThis, saved); }
}

/* ------------------------------------------------- the settle test */

test('the list reads as settled once Gmail shows the query, however it rewrote it', () => {
  const rows = [{ text: body('Scale AI', 'A1B2C3D4'), tooltip: 'Mon, Nov 9, 2026, 4:32 PM', shown: '4:32 PM' }];
  // What Gmail actually puts in its box: the braces of the OR group are
  // gone, the operators have become chips, the spacing has moved. The old
  // test looked for the literal `{subject:"security`, which is a string
  // Gmail never shows - so this could not pass and no look ever settled.
  for (const box of [
    'subject:security code for your application from:greenhouse-mail.io newer_than:2h',
    'subject:(security code for your application)',
    '{subject:"security code for your application" from:greenhouse-mail.io} newer_than:2h',
  ]) {
    assert.equal(gmail({ rows, box }).settled, true, `settled for box: ${box}`);
  }
});

test('a tab still showing the inbox is not mistaken for the search', () => {
  // The guard the old test was there for, and it still holds: rows are on
  // screen, but they are the view the tab was on a moment ago.
  const rows = [{ text: 'Mum, dinner on Sunday?', shown: '2:01 PM' }];
  assert.equal(gmail({ rows, box: '' }).settled, false);
  assert.equal(gmail({ rows, box: 'in:inbox' }).settled, false);
});

test('an empty search settles instead of being waited out', () => {
  const settled = gmail({ rows: [], box: 'subject:security code', main: 'No messages matched your search.' });
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.rows, []);
});

test('with no search box at all the hash is believed', () => {
  const rows = [{ text: body('Scale AI', 'A1B2C3D4'), shown: '4:32 PM' }];
  const { document, window } = parseHTML('<html><body><div role="main"><table><tr class="zA"><td>' + body('Scale AI', 'A1B2C3D4') + '</td><td>4:32 PM</td></tr></table></div></body></html>');
  for (const row of document.querySelectorAll('tr.zA')) row.getClientRects = () => [{}];
  const hash = '#search/' + encodeURIComponent(SEARCH);
  const saved = { document: globalThis.document, location: globalThis.location };
  Object.assign(globalThis, { document, location: { hash } });
  try { assert.equal(readRows(SEARCH, providerById('gmail').spec).settled, true, 'markup that moved this far should not stall the reader'); }
  finally { Object.assign(globalThis, saved); }
  assert.ok(rows.length);
});

/* ---------------------------------------------------- the row time */

test("a row's send time is read from the tooltip, including the spelling Date.parse refuses", () => {
  for (const tooltip of [
    'Mon, Nov 9, 2026, 4:32 PM',
    'Mon, Nov 9, 2026 at 4:32 PM',
    'Nov 9, 2026, 4:32 PM',
  ]) {
    const [row] = gmail({ rows: [{ text: body('Scale AI', 'A1B2C3D4'), tooltip, shown: '4:32 PM' }], box: 'subject:security' }).rows;
    assert.ok(row.at > 0, `tooltip should give a time: ${tooltip}`);
    assert.equal(new Date(row.at).getFullYear(), 2026);
  }
});

test('with no tooltip at all the visible cell still dates the row', () => {
  // The defect this closes: no tooltip meant no time, no time meant the
  // code was judged on whether it was already in the box, and a code that
  // arrives within seconds of Submit always is.
  const [today] = gmail({ rows: [{ text: body('Scale AI', 'A1B2C3D4'), shown: '4:32 PM' }], box: 'subject:security' }).rows;
  assert.ok(today.at > 0, 'a time on the row means today');
  assert.equal(new Date(today.at).toDateString(), new Date().toDateString());

  const [older] = gmail({ rows: [{ text: body('Scale AI', 'A1B2C3D4'), shown: 'Nov 3' }], box: 'subject:security' }).rows;
  assert.ok(older.at > 0 && older.at < Date.now(), 'a date instead of a time is another day, and another day is never this application');
});

/* ------------------------------------------- what that time decides */

test('a code mailed seconds after Submit is used, not banked as pre-existing', () => {
  const submittedAt = Date.parse('2026-11-09T16:32:10');
  const row = { text: body('Scale AI', 'A1B2C3D4'), at: Date.parse('2026-11-09T16:32:00') };
  // The whole failure in one call: the first look has already recorded
  // this code as "seen", because it landed before the reader got there.
  const seen = new Set(['A1B2C3D4']);
  const since = submittedAt - ROW_MINUTE_MS;

  assert.equal(codeForCompany([row], { names: ['Scale AI'], since, seen }).code, 'A1B2C3D4',
    'a readable time outranks having been seen, which is why reading the time matters');

  // Without a time there is nothing to outrank it, and the code is lost
  // for the whole wait. This is the behaviour the row-time fallback above
  // exists to keep out of the common case.
  assert.equal(codeForCompany([{ ...row, at: 0 }], { names: ['Scale AI'], since, seen }).waiting, true);
});

test('a code from an earlier application at the same employer is still refused', () => {
  // The expensive mistake in the other direction, and it must not have
  // been loosened: Lively was sent a stale code off a threaded row, and a
  // sent application cannot be un-sent.
  const submittedAt = Date.parse('2026-11-09T17:00:00');
  const stale = { text: body('Lively', 'OLDCODE1'), at: Date.parse('2026-11-09T15:40:00') };
  assert.equal(codeForCompany([stale], { names: ['Lively'], since: submittedAt - ROW_MINUTE_MS }).waiting, true);
});

test('a row still parses into company and code', () => {
  const mail = parseRow({ text: body('Scale AI', 'A1B2C3D4'), at: 123 });
  assert.equal(mail.company, 'Scale AI');
  assert.equal(mail.code, 'A1B2C3D4');
  assert.equal(mail.at, 123);
});

console.log(`${count} mailbox timing and row-reading checks passed.`);
