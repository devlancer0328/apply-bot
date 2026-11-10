/**
 * Offering back an application that stopped on something other than a
 * question.
 *
 * Three machines in the field parked 42 applications. Every one of them
 * had filled its form and stopped before Submit - a captcha, a required
 * field, a demographic answer the profile has since gained - and every
 * one of them stayed parked, because the only resume path that existed
 * read the answer pack and these were not waiting on an answer.
 *
 * They are safe to send precisely once and never twice, and the
 * difference between those is one flag. `submissionAttempted === false`
 * is a proven pre-submit stop: the board has nothing, and a second
 * attempt is a first attempt. Anything else - true, or missing because
 * an older build never wrote it - may be sitting in an applicant
 * tracking system right now, and sending it again puts a duplicate
 * application under the candidate's name.
 *
 * These check that the gate is exactly that flag, and that the one park
 * the flag cannot speak for is marked as needing a person.
 */
import assert from 'node:assert/strict';
import { resumable, protectsCompany } from '../src/application-needs.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const job = (id, extra = {}) => ({ id, stage: 'manual', resultId: `r-${id}`, applicationData: { id }, sourceUrl: `https://boards.test/${id}`, applyUrl: `https://boards.test/${id}`, company: id, blockedBy: [], updatedAt: 1000, ...extra });
const result = (id, detail = {}, extra = {}) => ({ id: `r-${id}`, status: 'manual', detail: { submissionAttempted: false, ...detail }, ...extra });

test('a form filled but never submitted can be offered back', () => {
  const picked = resumable([job('acme')], [result('acme')]);
  assert.deepEqual(picked.map((entry) => entry.job.id), ['acme']);
  assert.equal(picked[0].captcha, false);
});

test('anything that may already be with the employer is never offered', () => {
  const jobs = [
    job('sent', { stage: 'submitted' }),
    job('uncertain', { stage: 'unconfirmed' }),
    job('pressed'),
    job('older-build'),
  ];
  const results = [
    result('sent', { submissionAttempted: true }, { status: 'submitted' }),
    result('uncertain', { submissionAttempted: true }, { status: 'unconfirmed' }),
    result('pressed', { submissionAttempted: true }),
    // Written before the flag existed. Absent is not the same as false,
    // and treating it as false is the duplicate this exists to prevent.
    { id: 'r-older-build', status: 'manual', detail: {} },
  ];
  assert.deepEqual(resumable(jobs, results), []);
});

test('the resume gate and the duplicate guard never disagree', () => {
  const outcomes = [
    result('a'),
    result('b', { submissionAttempted: true }),
    result('c', { submissionAttempted: true }, { status: 'submitted' }),
    result('d', { submissionAttempted: true }, { status: 'unconfirmed' }),
    { id: 'r-e', status: 'manual', detail: {} },
  ];
  for (const outcome of outcomes) {
    const id = outcome.id.slice(2);
    const offered = resumable([job(id)], [outcome]).length === 1;
    assert.equal(offered, !protectsCompany(outcome), `${outcome.id} is offered and protected at the same time`);
  }
});

test('a captcha park is flagged for the applicant rather than queued quietly', () => {
  // The tab was left open for them to click the puzzle and press Submit.
  // If they did, the flag still says no submission was attempted - it is
  // honest about the extension and silent about the person.
  const picked = resumable([job('lever')], [result('lever', { captcha: true })]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].captcha, true);
});

test('an application waiting on an unanswered question stays with the questions', () => {
  const jobs = [job('asked', { blockedBy: ['why-us'] }), job('clear')];
  const results = [result('asked'), result('clear')];
  assert.deepEqual(resumable(jobs, results).map((entry) => entry.job.id), ['clear']);
});

test('a row with no documents on it is not offered as a cheap resend', () => {
  const jobs = [job('hollow', { applicationData: null }), job('no-link', { sourceUrl: '', applyUrl: '' })];
  assert.deepEqual(resumable(jobs, [result('hollow'), result('no-link')]), []);
});

test('an outcome that no longer exists is not treated as never submitted', () => {
  assert.deepEqual(resumable([job('orphan')], []), []);
});

test('the most recently parked is offered first', () => {
  const jobs = [job('old', { updatedAt: 10 }), job('new', { updatedAt: 90 })];
  assert.deepEqual(resumable(jobs, [result('old'), result('new')]).map((entry) => entry.job.id), ['new', 'old']);
});

test('nothing parked means nothing offered', () => {
  assert.deepEqual(resumable([], []), []);
  assert.deepEqual(resumable(undefined, undefined), []);
});

console.log(`\n${count} parked-resume checks passed.`);
