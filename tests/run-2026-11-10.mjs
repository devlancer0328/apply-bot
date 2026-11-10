/**
 * Three faults read out of the night of 10 November, from the run log
 * and the record beside it.
 *
 * ## What the night looked like
 *
 * Forty-eight attempts, twenty-four sent, nineteen failed and five
 * abandoned. The last run of the night never started at all: it logged
 * its settings, reached the line that opens the ChatGPT workers, and
 * died on "Wait for ChatGPT requests to finish before reconfiguring
 * workers." Autopilot then waited five minutes and started another run
 * into exactly the same wall.
 *
 * ## 1. A request that outlived its run took the next run with it
 *
 * The snapshot shows why. One worker was still busy with a web-research
 * request that had started *before* that run did, stuck on "Selecting
 * medium mode" at its third refresh retry, and its last progress is
 * stamped two minutes after the run it belonged to had already
 * finished. `configureChatGptWorkers` refused to touch a pool with
 * anything live in it, the refusal threw inside `run`, and a thrown
 * start is a failed run.
 *
 * The refusal was protecting something real: a second pool over the
 * same account would hand out slots the first pool had already given
 * away. But the pool moves its own width while requests are running
 * - it narrows to one after repeated failures and widens again after
 * four clean ones - so the width can simply be moved on the pool that
 * is already there, and the stale request keeps the slot it holds until
 * it finishes. Nothing else in the run depended on a brand-new pool.
 *
 * ## 2. "Worked for us as an employee" was not read as that question
 *
 * The previous-employment rule carries a guard list - remote, hybrid,
 * environment, industry, startup, team, "as a", with - that exists to
 * keep "have you previously worked in a remote environment" out of a
 * question about this employer. Both of the night's real employer-tie
 * questions contained one of those words inside the question itself:
 *
 *   "Have you previously worked for hims & hers as an employee or
 *    contractor/consultant?"
 *   "Have you ever worked for Clear Street as a full-time or part-time
 *    employee, as an intern or as a temporary/contract employee..."
 *
 * So the rule declined both, the model would not claim a tie it could
 * not source, and two applications parked on a question the profile
 * answers outright. The discriminator is the employer's own name: a
 * sentence that names the company it is being asked on behalf of is
 * this question whatever else it says, and the guard list is left for
 * the sentences that name nobody.
 *
 * ## 3. The word "extension" blanked a sponsorship question
 *
 * Hims & Hers asks for sponsorship in Greenhouse's long form, which
 * ends "...current work authorization, such as F-1 OPT, will expire
 * with no option for extension/further authorization". `phone-extension`
 * matches a bare `\bextension\b` and answers every match with an empty
 * string, and it is ordered above the sponsorship rule. A required
 * field answered with nothing is a blocked field, so the application
 * parked - while the same question asked in McKesson's shorter words
 * was answered "No" from the same profile on the same night.
 */
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { resolveField } from '../src/answers.js';
import { withDefaults } from '../src/profile.js';
import { ChatWorkerPool } from '../src/chat-workers.js';
import { codeForCompany, SEARCH } from '../src/mailbox.js';
import { PROVIDERS, readRows } from '../src/mail-providers.js';

/** `readRows` is written to run inside the page, so it is given a page. */
function run(work, args, globals) {
  const saved = Object.entries(globals).map(([key, value]) => [key, globalThis[key], key in globalThis]);
  Object.assign(globalThis, globals);
  try { return work(...args); }
  finally { for (const [key, value, had] of saved) { if (had) globalThis[key] = value; else delete globalThis[key]; } }
}

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };
/** The pool starts work on a microtask, so a request is in flight one tick after `run`. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The profile as it stood that night, in the parts these questions read.
const PROFILE = withDefaults({
  firstName: 'Daniel', lastName: 'Torres', city: 'Temple', state: 'Texas', zip: '76504',
  workAuthorization: 'us-citizen', requiresSponsorship: 'no',
  previouslyEmployed: 'no', previousEmployers: '',
});

const ask = (label, company, options = []) =>
  resolveField({ label, type: options.length ? 'radio' : 'text', required: true, options: options.map((l) => ({ label: l, value: l })) }, PROFILE, { company });

// 1. The pool.

await test('a run starting while a request is still in flight is not refused', async () => {
  const pool = new ChatWorkerPool(2, () => {}, { reserve: 1 });
  let finish;
  pool.run(() => new Promise((resolve) => { finish = resolve; }), { label: 'Web research' });
  await tick();
  assert.equal(pool.active.size, 1, 'the stale request is running');
  // What the next run does at startup. Before the fix this threw.
  pool.reconfigure(2, { reserve: 1 });
  assert.equal(pool.closed, false, 'the new run has a pool it may queue on');
  assert.equal(pool.active.size, 1, 'and the request in flight still holds its slot');
  finish('done');
});

await test('the slot a stale request holds is honoured, then returned', async () => {
  const pool = new ChatWorkerPool(2, () => {}, { reserve: 1 });
  let finish;
  pool.run(() => new Promise((resolve) => { finish = resolve; }), { label: 'Web research' });
  await tick();
  pool.reconfigure(2, { reserve: 1 });
  // Width 2 with one slot reserved and one slot stale: nothing else starts yet.
  let started = 0;
  pool.run(async () => { started++; }, { label: 'Resume' });
  await tick();
  assert.equal(started, 0, 'the new run cannot spend a slot the old request is using');
  finish('done');
  await tick();
  assert.equal(started, 1, 'and gets it the moment that request finishes');
});

await test('a pool stopped by a sign-out last night is usable again tonight', async () => {
  const pool = new ChatWorkerPool(2, () => {}, { reserve: 1 });
  let finish;
  pool.run(() => new Promise((resolve) => { finish = resolve; }), { label: 'Web research' });
  await tick();
  pool.stop(Object.assign(new Error('signed out'), { status: 401 }));
  assert.notEqual(pool.closed, false, 'the sign-out closed it');
  pool.reconfigure(2, { reserve: 1 });
  assert.equal(pool.closed, false, 'and the next run clears that rather than inheriting it');
  finish('done');
});

await test('a narrower width is taken even while a request runs', async () => {
  const pool = new ChatWorkerPool(4, () => {}, { reserve: 1 });
  let finish;
  pool.run(() => new Promise((resolve) => { finish = resolve; }), {});
  await tick();
  pool.reconfigure(1, { reserve: 0 });
  assert.equal(pool.limit, 1, 'the run that asked for one worker gets one');
  assert.equal(pool.reserve, 0, 'and a single worker reserves nothing, or it could never start');
  finish('done');
});

// 2. The employer-tie questions.

await test('the two questions that parked that night are answered from the profile', () => {
  for (const [label, company] of [
    ['Have you previously worked for hims & hers as an employee or contractor/consultant?', 'Hims And Hers'],
    ['Have you ever worked for Clear Street as a full-time or part-time employee, as an intern or as a temporary/contract employee or through a third-party?', 'Clear Street'],
    ['Are you an employee of Lyra, Bend or an affiliated company (Currently or Previously)?', 'Lyra Health'],
  ]) {
    const result = ask(label, company, ['Yes', 'No']);
    assert.equal(result.outcome, 'fill', label);
    assert.equal(result.rule, 'previous-employment', label);
    assert.equal(result.value, 'No', label);
  }
});

await test('a profile that does name the employer still answers yes', () => {
  const worked = withDefaults({ ...PROFILE, previousEmployers: 'Clear Street, Stripe' });
  const result = resolveField(
    { label: 'Have you ever worked for Clear Street as a full-time employee?', type: 'radio', required: true, options: [{ label: 'Yes' }, { label: 'No' }] },
    worked, { company: 'Clear Street' },
  );
  assert.equal(result.value, 'Yes', 'the rule reads the profile, it does not always say no');
});

await test('the guard still keeps out the questions that name no employer', () => {
  for (const label of [
    'Have you previously worked in a remote environment?',
    'Have you ever worked with a distributed team?',
    'Have you previously worked in the healthcare industry?',
    'Have you previously worked in a startup environment?',
    'Describe a time you previously worked as an intern on a research project',
  ]) assert.notEqual(ask(label, 'Acme').rule, 'previous-employment', label);
});

// 3. The sponsorship question.

await test('Greenhouse\'s long sponsorship question is answered, not blanked', () => {
  const label = 'Do you now or will you in the future need an employer to sponsor you for a visa to work in the United States (e.g., H-1B; O-1; TN; E-3; current work authorization, such as F-1 OPT, will expire with no option for extension/further authorization)?';
  const result = ask(label, 'Hims And Hers', ['Yes', 'No']);
  assert.equal(result.rule, 'sponsorship', 'the word "extension" must not win this question');
  assert.equal(result.value, 'No');
});

await test('McKesson\'s shorter wording still answers the same way', () => {
  const result = ask('Will you now or in the future require immigration support or sponsorship to work in the US?', 'McKesson', ['Yes', 'No']);
  assert.equal(result.rule, 'sponsorship');
  assert.equal(result.value, 'No');
});

// 4. A mail whose send time reads as the future.

await test('a row time ahead of the clock is not a send time', () => {
  // The date cell selector is `td:last-child`, so a row Gmail draws with
  // one cell hands the whole snippet to the time reader - and the
  // snippet carries a clock of its own. Read as today's time it lands in
  // the future for the rest of the day, and a future send time is newer
  // than any `since`, so the previous application's code is taken as
  // this one's.
  const clock = new Date(Date.now() + 3 * 3600000);
  const shown = `${((clock.getHours() + 11) % 12) + 1}:${String(clock.getMinutes()).padStart(2, '0')} ${clock.getHours() < 12 ? 'AM' : 'PM'}`;
  const mail = `Greenhouse 2, Security code for your application to Lively, ${shown}, Copy and paste this code into the security code field on your application: 11110000. After that...`;
  const { document } = parseHTML(`<html><body><table><tr class="zA"><td>${mail}</td></tr></table></body></html>`);
  for (const element of document.querySelectorAll('*')) element.getClientRects = () => [{}];

  const page = run(readRows, [SEARCH, PROVIDERS[0].spec], { document, location: { href: 'https://mail.google.com/mail/u/0/#search/x' } });
  assert.equal(page.rows.length, 1, 'the row is read');
  assert.equal(page.rows[0].at, 0, 'a time three hours from now is a misread, and a misread is no time at all');

  // Which is what leaves the decision to the box, where this code was.
  assert.deepEqual(
    codeForCompany(page.rows, { names: ['Lively'], since: Date.now(), used: new Set(), seen: new Set(['11110000']) }),
    { waiting: true },
    'the code the box already held is not this application\'s',
  );
});

await test('a phone extension box is still left empty', () => {
  // Workday's extension box sits beside the number and is never required,
  // which is why blanking it was safe until a required field matched.
  for (const label of ['Extension', 'Phone Extension', 'Phone Ext.', 'Ext']) {
    const result = resolveField({ label, type: 'text', required: false, options: [] }, PROFILE, { company: 'Acme' });
    assert.equal(result.rule, 'phone-extension', label);
    assert.equal(result.outcome, 'skip', `${label} is claimed by the rule and left alone, not given the number`);
  }
});

console.log(`\n${count} checks passed for the run of 2026-11-10`);
