/**
 * Queueing a parked application while the run is still going.
 *
 * ## The report
 *
 * "When I try to Queue holded jobs again, it said 'Stop the current run
 * before changing applied history'. It is not good... user cannot monitor
 * this extension fully."
 *
 * Right on both counts. The moment a person is most likely to clear a
 * hold is while they are watching the run that parked it - they see the
 * captcha, they solve it, they press the button - and the answer was to
 * stop the night they were watching. The message was wrong as well as the
 * rule: nothing about offering a posting back touches applied history,
 * which is what that sentence is about and what the guard was written
 * for.
 *
 * ## Why it is safe without the guard, which is the part worth pinning
 *
 * Every page writes to SQLite through the background worker, so there is
 * one writer and no row to race, and the links list is written from pages
 * only. What the run genuinely needs is to be *told*, because it keeps
 * its own memory of what it has already tried this night - and a job that
 * parked an hour ago is in that memory. Written to `documents-ready` and
 * not told, the row would be skipped by every drain until the run ended,
 * which is precisely the "nothing happened" the button exists to answer.
 *
 * Source-read rather than executed: the handshake is two halves of
 * background.js that a fixture can only restate. What matters is that
 * both halves exist, that the forgetting happens before the drain, and
 * that the guard did not come back.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/options.js', import.meta.url), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');
/**
 * One action's handler, cut at the next one.
 *
 * The handlers are a single object literal and their bodies run from one
 * line to twenty, so the only boundary that holds for all of them is the
 * next key at the same indentation.
 */
const handlerFor = (action) => {
  const from = options.indexOf(`'${action}':`);
  assert.ok(from > 0, `no handler named ${action}`);
  const rest = options.slice(from + action.length);
  const next = rest.search(/\n  '[a-z-]+':/);
  return rest.slice(0, next > 0 ? next : rest.length);
};

test('the button no longer asks for the run to be stopped', () => {
  // Each of these is a person queueing work, which is not a person
  // editing applied history.
  for (const action of ['resume-parked', 'resume-parked-all', 'resume-unblocked', 'queue-eligible']) {
    assert.doesNotMatch(handlerFor(action), /requireIdle/, `${action} still requires an idle run`);
  }
});

test('editing applied history still does', () => {
  // The guard was not wrong, only misapplied. These are what it is for,
  // and its message is accurate about them.
  for (const action of ['commit-history', 'remove-history', 'mark-applied', 'set-history-company']) {
    assert.match(handlerFor(action), /requireIdle/, `${action} should still require an idle run`);
  }
});

test('the run in progress is told, not left to find out', () => {
  assert.match(squash(options), /chrome\.runtime\.sendMessage\(\{type:'requeue',ids:jobs\.map\(job=>job\.id\)\}\)/);
  // A worker that is asleep or restarting must not turn a queueing into
  // an error; the row is already written either way.
  assert.match(squash(options), /type:'requeue'[^;]*\.catch\(\(\)=>\(\{running:false\}\)\)/);
});

test('the message handler only records, and never starts work itself', () => {
  const handler = background.slice(background.indexOf('message?.type === "requeue"'));
  const body = handler.slice(0, handler.indexOf('return false;'));
  assert.match(body, /offeredBack\.add/);
  // Starting a drain from a message handler would run it beside the loop
  // that is already running one, with both drawing on the same workers.
  assert.doesNotMatch(body, /drainBanked|stagedBatch/);
  assert.match(body, /running: state\.running \|\| starting/);
});

test('the loop forgets the posting before it drains, or the drain skips it', () => {
  const at = background.indexOf('if (offeredBack.size > 0) {');
  const body = background.slice(at, background.indexOf('await drainBanked();', at) + 'await drainBanked();'.length);
  const forget = body.indexOf('seenThisRun.delete');
  assert.ok(forget > 0, 'the run never forgets it has seen the posting');
  assert.ok(body.indexOf('await drainBanked();') > forget, 'the drain runs before the forgetting');
  // Ids reach the run in whichever spelling the page had; both forms are
  // dropped rather than assuming which one the run recorded.
  assert.match(squash(body), /seenThisRun\.delete\(id\); seenThisRun\.delete\(canonicalUrl\(id\)\)/);
  assert.match(squash(body), /offeredBack\.clear\(\)/);
});

test('the handoff is checked every turn of the run loop, not once at the start', () => {
  // The drain at the top of the run is the cold one. A click arrives
  // mid-night, which is after that line has gone past for good.
  const start = background.indexOf('while (going && !state.stopping) {');
  const check = background.indexOf('if (offeredBack.size > 0) {');
  assert.ok(check > start, 'the check is outside the loop');
  assert.ok(check - start < 800, 'the check is not at the top of the loop body');
});

test('what the applicant is told depends on whether a run heard it', () => {
  // "Start Run to send it" read as an instruction to someone already
  // watching a run, and following it would have ended that run.
  assert.match(squash(options), /sent\?\.running\s*\?\s*`The run in progress will pick/);
  assert.match(squash(options), /: `Start Run to send/);
});

console.log(`\n${count} live-requeue checks passed.`);
