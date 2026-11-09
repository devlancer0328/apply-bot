/**
 * Answer once on the Questions page, and the application it parked goes
 * again.
 *
 * The loop these check is the whole feature: a form asks something no
 * stored fact reaches; the application parks and the question is written
 * down against it; the applicant answers it in the extension rather than
 * on the employer's site; and the parked application is offered back with
 * the answer in place.
 */
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { answerQuestion, isAnswered, packAnswer, questionKey, recordQuestion, unblocked } from '../src/question-pack.js';
import { questions as questionsPage } from '../src/ui/questions.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const ask = (pack, question, company, extra = {}) => recordQuestion(pack, { question, company, required: true, ...extra });
// The page escapes with CSS.escape, which only the browser has; the keys
// here are plain enough that quoting the attribute is the same selector.
const byKey = (key) => `[data-question="${key}"]`;
const render = (html) => { const { document } = parseHTML('<html><body></body></html>'); document.body.innerHTML = html; return document; };

test('a question parks under one key however many employers ask it', () => {
  const pack = {};
  ask(pack, 'Do you know anyone who works at Smartsheet?', 'Smartsheet');
  ask(pack, 'Do you know anyone who works at Datadog?', 'Datadog');
  assert.equal(Object.keys(pack).length, 1, 'the employer is not part of the question');
  const [entry] = Object.values(pack);
  assert.equal(entry.asked, 2);
  assert.deepEqual(entry.employers, ['Smartsheet', 'Datadog']);
  // Answered once, and both employers are covered.
  answerQuestion(pack, entry.key, 'No');
  assert.equal(packAnswer(pack, 'Do you know anyone who works at Smartsheet?', 'Smartsheet'), 'No');
  assert.equal(packAnswer(pack, 'Do you know anyone who works at Datadog?', 'Datadog'), 'No');
});

test('a parked application is offered back only once every question it stopped on is answered', () => {
  const pack = {};
  ask(pack, 'Do you require sponsorship?', 'Acme');
  ask(pack, 'What is your notice period?', 'Acme');
  const [sponsorship, notice] = Object.keys(pack);
  const job = { id: 'job-1', company: 'Acme', stage: 'manual', blockedBy: [sponsorship, notice] };

  const answered = () => Object.fromEntries(Object.entries(pack).filter(([, entry]) => isAnswered(entry)));
  assert.deepEqual(unblocked([job], answered()), [], 'nothing answered yet');

  answerQuestion(pack, sponsorship, 'No');
  assert.deepEqual(unblocked([job], answered()), [], 'one of two is not enough - the form would park again');

  answerQuestion(pack, notice, 'Two weeks');
  assert.deepEqual(unblocked([job], answered()).map((row) => row.id), ['job-1']);
});

test('an application that reached submit is never offered back', () => {
  const pack = {};
  ask(pack, 'Do you require sponsorship?', 'Acme');
  const key = Object.keys(pack)[0];
  answerQuestion(pack, key, 'No');
  const blocked = [key];
  for (const stage of ['submitted', 'unconfirmed', 'duplicate', 'closed', 'applying']) {
    assert.deepEqual(unblocked([{ id: stage, stage, blockedBy: blocked }], pack), [], `${stage} must stay settled`);
  }
  assert.equal(unblocked([{ id: 'parked', stage: 'manual', blockedBy: blocked }], pack).length, 1);
});

test('a job that parked on something other than a question is left alone', () => {
  const pack = { 'do you require sponsorship?': { key: 'do you require sponsorship?', answer: 'No' } };
  assert.deepEqual(unblocked([{ id: 'x', stage: 'failed', blockedBy: [] }], pack), []);
  assert.deepEqual(unblocked([{ id: 'y', stage: 'failed' }], pack), []);
});

test('the page shows the question, its choices and the resume button', () => {
  const pack = {};
  ask(pack, 'Are you legally authorised to work in the United States?', 'Acme', { options: ['Yes', 'No'], type: 'select' });
  ask(pack, 'Describe your experience with Kubernetes', 'Acme');
  const [authorisation, kubernetes] = Object.keys(pack);
  answerQuestion(pack, authorisation, 'Yes');
  const rows = Object.values(pack);
  const job = { id: 'job-1', company: 'Acme', stage: 'manual', blockedBy: [authorisation] };

  const document = render(questionsPage({ questions: rows, jobs: [job] }));

  // The selectable question is answered with its own choices, not a text box.
  const choice = document.querySelector(`${byKey(authorisation)} select.answer-input`);
  assert.ok(choice, 'a question with options gets its options');
  assert.deepEqual([...choice.options].map((option) => option.value), ['', 'Yes', 'No']);
  assert.equal(choice.value, 'Yes', 'the saved answer is shown back');

  // The open one gets a box, and is still waiting.
  assert.ok(document.querySelector(`${byKey(kubernetes)} .answer-input`));
  assert.match(document.body.textContent, /Describe your experience with Kubernetes/);

  // And the parked application is offered back, from the page, in one press.
  const resume = document.querySelector('[data-action="resume-unblocked"]');
  assert.ok(resume, 'the resume control is on the page');
  assert.match(resume.textContent, /1 application/);
  assert.match(document.body.textContent, /Acme/);
});

test('with nothing unblocked the page says so instead of offering an empty resume', () => {
  const pack = {};
  ask(pack, 'Do you require sponsorship?', 'Acme');
  const document = render(questionsPage({ questions: Object.values(pack), jobs: [] }));
  assert.equal(document.querySelector('[data-action="resume-unblocked"]'), null);
  assert.match(document.body.textContent, /Nothing is waiting on an answer/);
});

test('an answer is taken back by clearing it, and the question returns to the waiting list', () => {
  const pack = {};
  ask(pack, 'Do you require sponsorship?', 'Acme');
  const key = Object.keys(pack)[0];
  answerQuestion(pack, key, 'No');
  assert.equal(isAnswered(pack[key]), true);
  answerQuestion(pack, key, '   ');
  assert.equal(isAnswered(pack[key]), false, 'whitespace is not an answer');
  assert.equal(pack[key].source, '');
  assert.equal(unblocked([{ id: 'j', stage: 'manual', blockedBy: [key] }], {}).length, 0);
});

test('the key a form is answered by is the key the page saves under', () => {
  // The two halves of the loop have to agree, or an answer lands in a row
  // no form will ever look up.
  const asked = questionKey('Do you know anyone who works at Smartsheet?', 'Smartsheet');
  const pack = {};
  ask(pack, 'Do you know anyone who works at Smartsheet?', 'Smartsheet');
  assert.ok(pack[asked], 'recordQuestion stores under the same key packAnswer reads');
});

console.log(`${count} question-pack and Questions page checks passed.`);
