/**
 * Resuming by hand after ChatGPT signs itself out.
 *
 * ## The report
 *
 * "If chatgpt signed out accidently, then user need to sign in again.
 * Then in this case, extension waits 5 mins, right? it is correct.. but
 * there must be resume button so that user can resume manually."
 *
 * The five minutes is real and it is `failureRetryMs`. A ChatGPT 401
 * ends the run with `code:'error'`, autopilot reads that as an ordinary
 * failure and schedules the next attempt one back-off away - five
 * minutes the first time, doubling to thirty. Signing back in takes
 * about fifteen seconds, so the rest of that wait is spent on a problem
 * that is already fixed, and the page gave no way to say so.
 *
 * ## What the button has to get right
 *
 * Not just "start a run now" - Run already did that. The trap is the
 * other direction: pressing it while the sign-in has not actually taken
 * ends the run four seconds later, which counts as another failure and
 * *doubles* the wait. So the check comes before the start, the failure
 * count is reset by a resume that worked, and a resume that found
 * ChatGPT still unreachable starts nothing and spends nothing.
 *
 * The rendering half is executed; the worker half is source-read,
 * because `resumeNow` reaches for tabs, scripting and SQLite and a
 * fixture for those could only restate the thing being checked.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { monitorBody } from '../src/ui/monitor.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/options.js', import.meta.url), 'utf8');
const schedule = await readFile(new URL('../src/schedule.js', import.meta.url), 'utf8');

const SIGNED_OUT = {
  running: false,
  stopping: false,
  autopilot: true,
  startedAt: Date.now() - 600000,
  finishedAt: Date.now() - 120000,
  stopReason: { code: 'error', message: 'Run stopped: ChatGPT is not signed in. Open its tab and sign in.' },
  lastError: { message: 'ChatGPT is not signed in. Open its tab and sign in.', status: 401 },
  resumeAt: Date.now() + 210000,
  health: { conditions: [{ id: 'writer-signed-out', title: 'The résumé writer is signed out or out of quota', detail: 'ChatGPT is not signed in. (401)', severity: 'stop', since: Date.now() - 120000, tried: 0 }] },
  day: { target: 20, submitted: 4 },
};

test('the five minutes is failureRetryMs, and an error end is what a 401 produces', () => {
  assert.match(schedule, /failureRetryMs:\s*5\s*\*\s*60000/, 'the wait the report describes should still be five minutes');
  assert.match(background, /state\.stopReason=\{code:'error'[^}]*Run stopped: '/, 'a thrown run error should still end the run with the error code');
  assert.match(background, /\[401,403\]\.includes\(error\?\.status\)\)\{health\.service\('writer'/, 'a 401 should still raise the writer condition');
});

test('a run waiting out the back-off offers the button and says how long is left', () => {
  const html = monitorBody(SIGNED_OUT);
  assert.match(html, /Waiting to try again/);
  assert.match(html, /data-action="resume-now"/, 'the resume button should be on the page');
  assert.match(html, /next run in 3m/, 'the remaining wait should be counted down, not just named');
  assert.match(html, /not signed in/, 'the reason the run stopped should be quoted, not summarised away');
  assert.match(html, /chatgpt\.com/, 'the tab they have to sign into should be one click away');
});

test('the button is not offered while a run is going', () => {
  assert.doesNotMatch(monitorBody({ ...SIGNED_OUT, running: true }), /data-action="resume-now"/);
  assert.doesNotMatch(monitorBody({ ...SIGNED_OUT, running: true, stopping: true }), /data-action="resume-now"/);
});

test('a healthy idle page is left alone', () => {
  const html = monitorBody({ running: false, autopilot: true, stopReason: null, resumeAt: 0, health: { conditions: [] }, day: { target: 20, submitted: 4 } });
  assert.doesNotMatch(html, /Waiting to try again/);
  assert.doesNotMatch(html, /data-action="resume-now"/);
});

test('a standing stop condition carries the button even with no scheduled retry', () => {
  const html = monitorBody({ ...SIGNED_OUT, resumeAt: 0, autopilot: false });
  assert.match(html, /data-action="resume-now"/);
  assert.match(html, /nothing scheduled/, 'autopilot off means no run is coming, and the page should say so');
});

test('the button appears once, with the health card pointing at it rather than repeating it', () => {
  const html = monitorBody(SIGNED_OUT);
  assert.equal(html.match(/data-action="resume-now"/g).length, 1, 'two resume buttons on one page is two answers to one question');
  assert.match(html, /Resume now, above/, 'the health card should say where the control is');
});

test('the worker checks ChatGPT before starting, not after', () => {
  const body = background.slice(background.indexOf('async function resumeNow()'));
  const fn = body.slice(0, body.indexOf('\nasync function stopAutopilot'));
  const check = fn.indexOf('checkWriter');
  const start = fn.indexOf('run();');
  const forget = fn.indexOf('health.forget()');
  assert.ok(check > -1 && start > -1 && forget > -1, 'resumeNow should check the writer, forget conditions and start');
  assert.ok(check < forget && forget < start, 'the check has to come before anything is cleared or started');
  assert.match(fn, /if \(!writer\.ok\) return \{ ok: false/, 'an unreachable writer must start nothing');
  assert.ok(fn.indexOf('if (!writer.ok)') < start, 'the refusal must be able to return before the run starts');
});

test('a hand resume clears the widening back-off and the stored wait', () => {
  const body = background.slice(background.indexOf('async function resumeNow()'));
  const fn = body.slice(0, body.indexOf('\nasync function stopAutopilot'));
  assert.match(fn, /runFailures = 0/, 'the exponent of the back-off should not survive a resume somebody watched');
  assert.match(fn, /autopilotResumeAt: 0/, 'the pending wait should go too');
  assert.match(fn, /durableHealth\.flush\(\)/, 'cleared conditions must reach storage before the run reloads them');
  assert.match(fn, /state\.running \|\| starting/, 'resuming into a run that is already going should refuse');
});

test('the page can see the wait it is counting down', () => {
  assert.match(background, /resumeAt: autopilotResumeAt/, 'the state message should carry the pending wait');
  assert.match(background, /message\?\.type === "resume-now"/, 'the worker should answer the button');
});

test('the button says it is working and the poll does not undo that', () => {
  assert.match(options, /'resume-now':async target=>/);
  assert.match(options, /Checking ChatGPT/, 'the check takes seconds and the button should say so');
  assert.match(options, /resuming=true/);
  assert.match(options, /if\(body&&!resuming\)/, 'the two-second redraw must not reset a button mid-check');
  assert.match(options, /finally\{resuming=false/, 'a failed check must release the redraw again');
});

console.log(`\n${count} resume-now checks passed`);
