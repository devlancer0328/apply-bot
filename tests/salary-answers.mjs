/**
 * What reaches an employer when they ask what you want to be paid.
 *
 * Three tiers, in order: a figure ChatGPT researched for this employer,
 * then the range the applicant stated in their profile, then a person.
 * Every case here is the second tier, which did not exist on the night
 * fifteen finished applications stopped on "compensation research is
 * unavailable or uncited" - more than any other single cause.
 *
 * The refusals matter as much as the answers. Loosening the citation
 * rule was deliberate; loosening the arithmetic was not, and a payload
 * whose recommendation sits outside its own range still goes nowhere
 * near a form.
 */
import assert from 'node:assert/strict';
import { resolveField } from '../src/answers.js';
import { withDefaults } from '../src/profile.js';
import { describeRange, hasCompensationResearch, statedRange, validateCompensation } from '../src/salary.js';

let count = 0;
const test = (name, work) => { work(); console.log(`PASS ${name}`); count++; };

const PROFILE = withDefaults({ firstName: 'Daniel', lastName: 'Torres', email: 'd@example.com', salaryMin: 150000, salaryMax: 180000 });
const BARE = withDefaults({ firstName: 'Daniel', lastName: 'Torres', email: 'd@example.com' });
const CONTEXT = { company: 'Acme', title: 'Software Engineer', compensation: { status: 'unavailable' } };
const ask = (label, extra = {}) => ({ key: label, label, type: 'text', required: true, options: [], ...extra });

const JOB = { company: 'Postman, Inc.', title: 'Frontier AI Engineer' };
const PAYLOAD = { status: 'researched', company: 'Postman', role: 'Frontier AI Engineer', currency: 'USD', period: 'year', basis: 'base', minimum: 180000, maximum: 240000, recommendedAmount: 220000 };
const reply = (citations = []) => ({ searchEvidence: { nativeCitations: citations } });

/* --------------------------------------- the applicant's stated range */

test('which end of the range is used is decided by the question, never computed', () => {
  const cases = [
    ['Desired salary', '180000'],
    ['Expected base pay', '180000'],
    ['Minimum salary expectation', '150000'],
    ['Maximum salary', '180000'],
  ];
  for (const [label, expected] of cases) {
    const resolved = resolveField(ask(label), PROFILE, CONTEXT);
    assert.equal(resolved.outcome, 'fill', label);
    assert.equal(resolved.rule, 'salary-stated', label);
    assert.equal(resolved.value, expected, label);
  }
  // No midpoint and no third number: every figure typed is one of the two written down.
  const typed = new Set(cases.map(([, value]) => value));
  for (const value of typed) assert.ok(['150000', '180000'].includes(value));
});

test('a box with room for a sentence gets the range in words, not a bare number', () => {
  const prose = resolveField(ask('What are your salary expectations?', { type: 'textarea', tag: 'textarea' }), PROFILE, CONTEXT);
  assert.equal(prose.value, '$150,000 - $180,000 per year');
});

test('one figure stated is a range of one, and a reversed pair is still the pair', () => {
  assert.equal(describeRange(statedRange({ salaryMin: 0, salaryMax: 170000 })), '$170,000 per year');
  const reversed = statedRange({ salaryMin: 180000, salaryMax: 150000 });
  assert.deepEqual([reversed.min, reversed.max], [150000, 180000]);
  assert.equal(describeRange(statedRange({ salaryMin: 90, salaryMax: 120, salaryPeriod: 'hour' })), '$90 - $120 per hour');
});

test('with no range stated the question still stops for a person, exactly as before', () => {
  const parked = resolveField(ask('Desired salary'), BARE, CONTEXT);
  assert.equal(parked.outcome, 'blocked');
  assert.equal(parked.rule, 'salary-research');
  // And an optional one is skipped rather than blocking the application.
  assert.equal(resolveField(ask('Desired salary', { required: false }), BARE, CONTEXT).outcome, 'skip');
});

test('researched evidence still outranks the stated range', () => {
  const researched = { ...PAYLOAD, sources: [{}], evidence: { mode: 'chatgpt-native-citations', nativeCitations: [{}] } };
  const resolved = resolveField(ask('Desired salary'), PROFILE, { ...CONTEXT, compensation: researched });
  assert.notEqual(resolved.rule, 'salary-stated');
  assert.equal(resolved.outcome, 'ask');
});

/* ------------------------------------------ what the model may return */

test('an honest uncited estimate is usable, and says so on the record', () => {
  const estimate = validateCompensation({ ...PAYLOAD, basedOn: 'market-data' }, reply(), JOB);
  assert.equal(estimate.recommendedAmount, 220000);
  assert.equal(estimate.cited, false);
  assert.equal(estimate.basedOn, 'market-data');
  assert.equal(estimate.evidence.mode, 'chatgpt-estimate');
  assert.ok(hasCompensationResearch(estimate));
});

test('a cited company figure is recorded as the better evidence it is', () => {
  const citations = [{ url: 'https://example.com/postman-pay' }];
  const cited = validateCompensation({ ...PAYLOAD, basedOn: 'company-evidence', sources: [{ url: 'https://example.com/postman-pay', role: 'Frontier AI Engineer', details: 'posted band' }] }, reply(citations), JOB);
  assert.equal(cited.cited, true);
  assert.equal(cited.evidence.mode, 'chatgpt-native-citations');
  assert.equal(cited.sources.length, 1);
});

test('a figure that is incoherent as a number never reaches a form', () => {
  const broken = [
    ['maximum below minimum', { maximum: 100 }],
    ['recommendation above its own range', { recommendedAmount: 900000 }],
    ['recommendation below its own range', { recommendedAmount: 1 }],
    ['no minimum at all', { minimum: null }],
    ['currency that is not a code', { currency: 'dollars' }],
    ['a pay period nobody uses', { period: 'fortnight' }],
    ['an unstated basis', { basis: '' }],
  ];
  for (const [why, patch] of broken) {
    assert.throws(() => validateCompensation({ ...PAYLOAD, ...patch }, reply(), JOB), undefined, why);
  }
});

test('research about a different employer is still refused', () => {
  assert.throws(() => validateCompensation({ ...PAYLOAD, company: 'Datadog' }, reply(), JOB), /does not match this employer/);
  // The employer's legal suffix is not a difference.
  assert.equal(validateCompensation({ ...PAYLOAD, company: 'Postman Inc.' }, reply(), JOB).company, 'Postman Inc.');
});

test('a model that gives up is still allowed to give up', () => {
  assert.throws(() => validateCompensation({ status: 'unavailable', reason: 'nothing found' }, reply(), JOB), /nothing found/);
  assert.equal(hasCompensationResearch({ status: 'unavailable' }), false);
  assert.equal(hasCompensationResearch(null), false);
});

console.log(`${count} salary answer checks passed.`);
