/**
 * The page a held application stopped on, kept and shown.
 *
 * ## The report
 *
 * "And if job holded, make screenshots for future debugging."
 *
 * Mostly already true, and worth saying which part was not. Every
 * attempt that reaches a tab photographs its last page on the way out -
 * the `finally` that ends an attempt does it whatever the outcome - so a
 * job parked on a captcha, a required field or an unanswered question
 * already had a `Last page.png` beside its documents.
 *
 * Two things were missing, and they are the two this covers.
 *
 * ## The ending that photographs nothing
 *
 * An abandoned attempt. The queue stops waiting for one precisely
 * because it has stopped answering, so it never reaches the `finally`
 * that would photograph it. The row was written saying "no answer after
 * twelve minutes; check Jobs for what it had reached" - and Jobs had
 * nothing to show, because the only thing that knew what it had reached
 * was a tab left open on a machine nobody was watching.
 *
 * ## The picture nobody could find
 *
 * The viewer existed on the Applications page only. Held jobs are dealt
 * with on the Questions page, abandoned ones on Jobs, and neither
 * offered the image that had been sitting in the workspace all along -
 * which is the difference between "a required field had no answer" and
 * knowing which field, on which page, with what already typed into it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resumable } from '../src/application-needs.js';
import { questions } from '../src/ui/questions.js';
import { jobDetails } from '../src/ui/jobs.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const parkedJob = (extra = {}) => ({
  id: 'job-1', company: 'Scale AI', title: 'Engineer', stage: 'manual',
  applicationData: { filled: 3 }, sourceUrl: 'https://example.com/a', resultId: 'r1',
  reason: 'A required field had no answer in the profile.', updatedAt: 2, ...extra,
});
const parkedResult = (detail = {}) => ({ id: 'r1', reason: '', detail: { submissionAttempted: false, ...detail } });

test('a parked job carries the page it stopped on', () => {
  const [entry] = resumable([parkedJob()], [parkedResult({ lastScreenshot: { path: 'Manual/Scale AI/Last page.png' } })]);
  assert.equal(entry.picture, 'Manual/Scale AI/Last page.png');
});

test('and carries one saved on the job itself, which is where an abandoned attempt puts it', () => {
  const [entry] = resumable([parkedJob({ lastScreenshot: { path: 'Manual/Scale AI/Abandoned page.png' } })], [parkedResult()]);
  assert.equal(entry.picture, 'Manual/Scale AI/Abandoned page.png');
});

test('a parked job with no picture says nothing rather than offering a broken link', () => {
  const [entry] = resumable([parkedJob()], [parkedResult()]);
  assert.equal(entry.picture, '');
  const html = questions({ questions: [], jobs: [parkedJob()], results: [parkedResult()] });
  assert.doesNotMatch(html, /show-last-page/);
});

test('the Questions page offers the picture beside the job it belongs to', () => {
  const html = questions({
    questions: [], jobs: [parkedJob()],
    results: [parkedResult({ lastScreenshot: { path: 'Manual/Scale AI/Last page.png' } })],
  });
  assert.match(html, /data-action="show-last-page"/, 'the button should be on the parked card');
  assert.match(html, /data-path="Manual\/Scale AI\/Last page\.png"/);
  assert.match(html, /id="parked-preview"/, 'and somewhere to render it without leaving the page');
});

test('the Jobs evidence view offers it too, and is honest when there is none', () => {
  const withPicture = jobDetails({ ...parkedJob({ stage: 'abandoned' }), lastScreenshot: { path: 'Manual/Scale AI/Abandoned page.png' }, screening: {}, jd: '' });
  assert.match(withPicture, /data-action="show-last-page"/);
  const without = jobDetails({ ...parkedJob({ stage: 'abandoned' }), screening: {}, jd: '' });
  assert.doesNotMatch(without, /data-action="show-last-page"/);
  assert.match(without, /nothing saved to look at/, 'an empty hand should be named, not left blank');
});

const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');

test('an abandoned attempt is photographed before its row is written', () => {
  const start = background.indexOf('const abandonCandidate=async(item,ms)=>{');
  const fn = background.slice(start, background.indexOf('\n  };', start));
  const shot = fn.indexOf('photographAbandoned');
  const row = fn.indexOf('saveJob(');
  assert.ok(shot > -1 && row > -1, 'the abandonment should photograph and then record');
  assert.ok(shot < row, 'the row carries the path, so the picture has to come first');
  assert.match(fn, /lastScreenshot:picture/, 'and the path has to reach the row');
});

test('the photograph is best-effort and cannot cost the record', () => {
  const start = background.indexOf('const photographAbandoned=async(item)=>{');
  const fn = background.slice(start, background.indexOf('\n  };', start));
  assert.match(fn, /if\(!health\.screenshots\)return null/, 'a full disk still skips pictures');
  assert.match(fn, /catch\(error\)/, 'a tab that will not answer must not throw into the abandonment');
  assert.match(fn, /attemptTabs\.get/, 'the right tab of several in the air');
});

test('every attempt registers its tab and gives it back', () => {
  assert.equal([...background.matchAll(/attemptTabs\.set\(application\.id, tabId\)/g)].length, 2, 'both the generic and the Workday path');
  assert.equal([...background.matchAll(/attemptTabs\.delete\(application\.id\)/g)].length, 2, 'and both release it, or the map grows all night');
  for (const match of background.matchAll(/attemptTabs\.delete\(application\.id\)/g)) {
    const before = background.slice(Math.max(0, match.index - 400), match.index);
    assert.match(before, /\}\s*finally\s*\{\s*\n\s*resident\(null\);/, 'released in the finally, so a thrown attempt releases it too');
  }
});

console.log(`\n${count} hold-screenshot checks passed`);
