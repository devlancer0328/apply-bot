/**
 * Questions about the employer, which no amount of profile can answer.
 *
 * ## The report
 *
 * "For a question like 'is the following statement True or False?
 * SeatGeek was founded in 2008' - AI can make answers. It would be
 * better to generate all answers using AI that are not applicable to
 * answer with answers pack. Then if this way also cannot generate
 * correct answer, then ask user."
 *
 * The chain the report asks for was already there: the rules answer what
 * they can, everything else goes to the model, and what the model
 * refuses reaches the person. What stopped this question was the last
 * link but one. The model is told, in the strongest terms the prompt
 * has, to answer only from the profile, the resume, the letter and the
 * compensation research - so it returned INSUFFICIENT for a quiz about
 * the employer's founding year, the field came back unanswered, and an
 * application with a resume already written for it stopped to wait for
 * somebody to type "True".
 *
 * ## What changed, and what deliberately did not
 *
 * A question that is not about the candidate may now be answered from
 * the model's own knowledge. That rule is narrow on purpose, because the
 * thing it carves into is the reason this bot can be trusted with a real
 * application: it never states something about the candidate that the
 * sources do not support. A quiz about an employer's founding year
 * states nothing about the candidate at all.
 *
 * So the tests below are mostly about what still refuses. Anything in
 * the candidate's voice, anything demographic, anything about pay, and
 * anything that is merely unlabelled rather than genuinely general - all
 * of those keep the strict contract, and an unsure model still refuses
 * and still reaches the person.
 */
import assert from 'node:assert/strict';
import { asksGeneralKnowledge, answerAll } from '../src/ai.js';
import { resolveField } from '../src/answers.js';
import { setModelTransport } from '../src/vendor/generation.js';

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };

const QUIZ = { key: 'tf', question: 'Is the following statement True or False? SeatGeek was founded in 2008.', required: true, options: [{ label: 'True' }, { label: 'False' }] };
const CONTEXT = { company: 'SeatGeek', title: 'Engineer', resume: 'A career in software.' };

/** Captures the prompt and replies with whatever the test wants. */
function transport(reply) {
  const seen = { prompt: '' };
  setModelTransport(async (request) => {
    seen.prompt = request.messages.map((message) => message.content).join('\n');
    return { text: typeof reply === 'function' ? reply(seen.prompt) : reply };
  });
  return seen;
}

await test('the employer quiz is not something the rules claim to answer', () => {
  const ruled = resolveField({ label: QUIZ.question, type: 'radio', required: true, options: [{ label: 'True' }, { label: 'False' }] }, { firstName: 'A', lastName: 'B' }, { company: 'SeatGeek' });
  assert.equal(ruled.outcome, 'ask', 'the answer pack should hand this to the model rather than block it');
});

await test('a question about the employer is marked for the model as general knowledge', async () => {
  const seen = transport('{"1":"True"}');
  const result = await answerAll([QUIZ], CONTEXT, {});
  assert.match(seen.prompt, /GENERAL KNOWLEDGE/, 'the question should be marked');
  assert.match(seen.prompt, /well-established public knowledge/, 'and the permission spelled out');
  assert.doesNotMatch(seen.prompt, /\[1\] \(REQUIRED/, 'REQUIRED says the sources must establish it, which is the opposite of what this needs');
  assert.equal(result.answers.length, 1, 'the answer should be taken, not refused');
  assert.equal(result.answers[0].value, 'True');
  assert.equal(result.unanswered.length, 0);
});

await test('a model that is unsure still refuses, and the question still reaches the person', async () => {
  transport('{"1":"INSUFFICIENT"}');
  const result = await answerAll([QUIZ], CONTEXT, {});
  assert.equal(result.answers.length, 0, 'a guess is worse than a question');
  assert.equal(result.unanswered.length, 1, 'and what the model will not answer goes to the applicant');
  assert.equal(result.unanswered[0].required, true);
});

await test('the permission is scoped to the question, not to the form', async () => {
  // `must` is the flag that puts a question under the strictest wording
  // the prompt has; `required` alone only reaches it on a retry.
  const candidate = { key: 'auth', question: 'Are you authorized to work in the United States?', required: true, must: true, options: [{ label: 'Yes' }, { label: 'No' }] };
  const seen = transport('{"1":"True","2":"INSUFFICIENT"}');
  await answerAll([QUIZ, candidate], CONTEXT, {});
  const marked = seen.prompt.split('\n').filter((line) => line.includes('GENERAL KNOWLEDGE') && /^\[\d\]/.test(line));
  assert.equal(marked.length, 1, 'exactly one of the two questions carries the mark');
  assert.match(marked[0], /^\[1\]/, 'and it is the quiz, not the work-authorisation question');
  assert.match(seen.prompt, /\[2\] \(REQUIRED/, 'the candidate question keeps the strict contract');
});

await test('a claim about the candidate wearing a quiz\'s clothes stays strict', () => {
  for (const question of [
    'True or false: you are authorized to work in the United States.',
    'True or false: I hold an active security clearance.',
    'True or false: The candidate has five years of Java experience.',
    'True or false: my notice period is four weeks.',
    'True or false: we may contact your current employer.',
  ]) assert.equal(asksGeneralKnowledge({ question }, 'SeatGeek'), false, question);
});

await test('demographic and pay questions never qualify, however they are phrased', () => {
  for (const question of [
    'True or false: the applicant identifies as Hispanic or Latino.',
    'True or false: this role pays 180000 per year.',
    'True or false: the candidate is a protected veteran.',
    'True or false: the expected salary for this position is negotiable.',
  ]) assert.equal(asksGeneralKnowledge({ question }, 'SeatGeek'), false, question);
});

await test('an unlabelled box is not a general question just because it names nobody', () => {
  // The dangerous near-miss: no pronoun, no company, no quiz - and a
  // model given permission here would invent a number for it.
  for (const question of ['Years of experience', 'Notice period', 'Current salary', 'Highest level of education', 'Start date']) {
    assert.equal(asksGeneralKnowledge({ question }, 'SeatGeek'), false, question);
  }
});

await test('genuine employer questions qualify', () => {
  for (const question of [
    'Is the following statement True or False? SeatGeek was founded in 2008.',
    'In what year was SeatGeek founded?',
    'Who is the CEO of this company?',
    'Where is SeatGeek headquartered?',
  ]) assert.equal(asksGeneralKnowledge({ question }, 'SeatGeek'), true, question);
});

console.log(`\n${count} general-knowledge checks passed`);
