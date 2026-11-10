/**
 * The forty-two applications that were written, filled and then parked in
 * one night on three machines, question by question.
 *
 * Every label below is verbatim from the results table of those three
 * databases, with the profile each machine was actually carrying. They
 * are grouped by the defect that stopped them, because they are four
 * separate defects and only one of them is about an unanswerable
 * question:
 *
 *   - Rule order. "Do you live with a disability (as outlined by the
 *     ADA)?" matched the residence rule, which asks the profile where
 *     the applicant lives and parked when it had no such place on file -
 *     four applications, for an answer the profile was holding.
 *   - Pronoun spelling. A profile saying "He/Him" against a control
 *     listing "He/him/his" is the same person said two ways - four more.
 *   - Sentence splitting. The dots in "i.e." ended a sentence, so
 *     Coinbase's conflict question was read as the list in its own
 *     parenthesis and the question that list qualified was discarded.
 *   - Questions with no rule at all: debarment, holding public office,
 *     a prior rotation at the hospital, and the short wording of the
 *     referral question.
 */
import assert from 'node:assert/strict';
import { resolveField } from '../src/answers.js';
import { withDefaults } from '../src/profile.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

/** The three machines, as their settings rows actually read that night. */
const MACHINES = {
  marcus: withDefaults({ gender: 'Male', pronouns: 'He/him/his', race: 'Asian', hispanic: 'no', veteran: 'I do not wish to answer', disability: 'I do not wish to answer', transgender: 'no', sexualOrientation: 'Straight', howHeard: 'Company website', criminalRecord: 'none' }),
  david: withDefaults({ gender: 'Male', pronouns: 'He/Him', race: 'White', hispanic: 'no', veteran: 'No', disability: 'No', transgender: 'no', sexualOrientation: 'Straight', howHeard: 'Company website', criminalRecord: 'none' }),
  daniel: withDefaults({ gender: 'Male', pronouns: 'He/his', race: 'East Asian', hispanic: 'no', veteran: 'No', disability: 'No', transgender: 'no', sexualOrientation: 'Straight', howHeard: 'Company website', criminalRecord: 'none' }),
};

const yesNo = (label) => ({ key: label, label, type: 'select', required: true, options: [{ label: 'Yes', value: '1' }, { label: 'No', value: '2' }] });
const choose = (label, options) => ({ key: label, label, type: 'select', required: true, options: options.map((entry, index) => ({ label: entry, value: String(index + 1) })) });
const answer = (field, profile, company = '') => {
  const result = resolveField(field, profile, { company, resume: '' });
  assert.equal(result.outcome, 'fill', `${field.label}\n  -> ${result.outcome}: ${result.reason ?? ''}`);
  return result;
};

/* ------------------------------------------------- Reddit, four parks */

await test('a disability question phrased as "do you live with" is a disability question', () => {
  // The wording that matched the residence rule first. Both the saved
  // "No" and the saved decline are answers the profile holds.
  const field = choose('Do you live with a disability (as outlined by the ADA)?', ['Yes', 'No', 'I prefer not to say']);
  assert.deepEqual(answer(field, MACHINES.daniel, 'Reddit').candidates, ['No']);
  assert.deepEqual(answer(field, MACHINES.marcus, 'Reddit').candidates, ['I prefer not to say']);
});

await test('a residence question is still answered by the residence rule', () => {
  // The guard above may not cost the rule it jumped ahead of.
  const profile = withDefaults({ ...MACHINES.daniel, country: 'United States', state: 'WA' });
  const result = resolveField(yesNo('Do you currently reside in the United States?'), profile, { company: 'Reddit' });
  assert.equal(result.rule, 'residence');
  assert.equal(result.outcome, 'fill');
});

/* ------------------------------------- Iterable and Affirm, four parks */

await test('a pronoun set is the same answer however many of it a control lists', () => {
  // Affirm's menu, verbatim from the park reason, against the profile
  // that said "He/Him" - and against the two other spellings the three
  // machines were carrying.
  const affirm = choose('Pronouns', ['He/him/his', 'She/her/hers', 'They/them/theirs']);
  for (const [name, profile] of Object.entries(MACHINES)) {
    assert.deepEqual(answer(affirm, profile, 'Affirm').candidates, ['He/him/his'], name);
  }
  // And the other direction, with the spacing boards put around a slash.
  const spaced = choose('Pronouns', ['He / Him', 'She / Her', 'They / Them']);
  assert.deepEqual(answer(spaced, MACHINES.marcus, 'Iterable').candidates, ['He / Him']);
  const short = choose('Pronouns', ['He/Him', 'She/Her', 'They/Them', 'Prefer not to say']);
  assert.deepEqual(answer(short, MACHINES.marcus, 'Iterable').candidates, ['He/Him']);
});

await test('a pronoun answer never reaches for somebody else\u2019s set', () => {
  const profile = withDefaults({ ...MACHINES.daniel, pronouns: 'She/her/hers' });
  assert.deepEqual(answer(choose('Pronouns', ['He/him/his', 'She/her/hers']), profile).candidates, ['She/her/hers']);
  const nothing = resolveField(choose('Pronouns', ['He/him/his', 'She/her/hers']), withDefaults({ ...MACHINES.daniel, pronouns: '', gender: '' }), {});
  assert.equal(nothing.outcome, 'blocked', 'a profile with no pronoun still stops rather than guessing');
});

/* ------------------------------ Coinbase, Postman, HonorHealth, NeueHealth */

await test('"i.e." does not end the sentence the question is in', () => {
  // Split on its dots, the operative question became ", child/step-child,
  // spouse/partner, parent/guardian, aunt/uncle, first cousin, in-law)?"
  // - a list of relatives with nothing to say what about them was asked.
  const field = yesNo('Are you a close relative of a government official (i.e., child/step-child, spouse/partner, parent/guardian, aunt/uncle, first cousin, in-law)?');
  assert.deepEqual(answer(field, MACHINES.marcus, 'Coinbase').candidates, ['No']);
});

await test('the compliance screens every finance and healthcare board asks are answered no', () => {
  const asked = [
    ['Are you a current government official or were you a government official in the last five years (e.g., employee of a government agency or a government owned/controlled company, holder of public office or a civil service position)?', 'Coinbase'],
    ['Are you currently debarred, excluded or otherwise made ineligible from participating in any federal or state funded programs?', '70 HonorHealth Support Services'],
    ['To your knowledge, do you or a close relative currently hold a role, have a significant financial interest in, or maintain a close personal relationship with a senior leader at a company connected to Coinbase that could create an actual or perceived conflict of interest?', 'Coinbase'],
    ['Do you know anyone currently working at Postman?', 'Postman, Inc.'],
    ['Do you have any relatives currently employed at HonorHealth?', '70 HonorHealth Support Services'],
    ['Are you related to, or in a personal relationship with, any current NeueHealth or affiliate employee?', 'NeueHealth'],
  ];
  for (const [label, company] of asked) assert.deepEqual(answer(yesNo(label), MACHINES.marcus, company).candidates, ['No'], label);
});

await test('a referral question is answered no however briefly it is put', () => {
  const asked = [
    ['Did an employee refer you to apply?', 'Machinify'],
    ['Were you referred to this position by a current or former team member? If so, please list their name below.', 'Customer.io'],
    ['To your knowledge, were you referred to this position by a senior leader or decision-maker at a current or prospective institutional client, business partner, or vendor of Coinbase?', 'Coinbase'],
  ];
  for (const [label, company] of asked) assert.deepEqual(answer(yesNo(label), MACHINES.marcus, company).candidates, ['No'], label);
});

await test('a prior unpaid tie to the employer is the previous-employment question', () => {
  const field = yesNo('Have you had a student externship/practicum/clinical rotation or ever volunteered at one of the HonorHealth hospitals?');
  const result = answer(field, MACHINES.marcus, '70 HonorHealth Support Services');
  assert.equal(result.rule, 'previous-employment');
  assert.deepEqual(result.candidates, ['No']);
  // Still the applicant's own answer where they have said otherwise.
  const worked = withDefaults({ ...MACHINES.marcus, previousEmployers: 'HonorHealth' });
  assert.deepEqual(resolveField(field, worked, { company: 'HonorHealth', resume: '' }).candidates, ['Yes']);
});

await test('the how-heard menu is not swallowed by the referral rule', () => {
  const field = choose('How did you hear about this role?', ['LinkedIn', 'Company website', 'A friend', 'Other']);
  const result = answer(field, MACHINES.marcus, 'Reddit');
  assert.equal(result.rule, 'how-heard');
  assert.deepEqual(result.candidates, ['Company website']);
});

console.log(`\n${count} parked-question checks passed.`);
