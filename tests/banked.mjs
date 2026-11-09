/**
 * Resumes written by one run and sent by the next.
 *
 * The handoff between writing and sending has always been a row at
 * `documents-ready`; nothing ever picked those rows up again. A run that
 * was stopped, hit its target, or found its board quarantined with
 * documents already banked left finished work on the floor, and the next
 * run started at discovery and wrote new resumes while the old ones aged
 * out. These check which rows are worth picking up and - the part that
 * matters - which are not.
 */
import assert from 'node:assert/strict';
import { bankedJobs } from '../src/application-needs.js';

let count = 0;
const test = (name, work) => { work(); count++; console.log(`PASS ${name}`); };

const ready = (id, extra = {}) => ({ id, stage: 'documents-ready', applicationData: { id }, sourceUrl: `https://boards.test/${id}`, applyUrl: `https://boards.test/${id}`, company: id, updatedAt: 1000, ...extra });

test('only rows that actually carry a finished application are picked up', () => {
  const jobs = [
    ready('ok'),
    { ...ready('mid-flight'), stage: 'applying' },
    { ...ready('sent'), stage: 'submitted' },
    { ...ready('rejected'), stage: 'rejected' },
    // Written by an older version: the stage says ready, but there is
    // nothing to rebuild the attempt from.
    { ...ready('no-metadata'), applicationData: null },
    { ...ready('no-url'), sourceUrl: '', applyUrl: '' },
  ];
  assert.deepEqual(bankedJobs(jobs).map((job) => job.id), ['ok']);
});

test('a posting this run already discovered is not sent twice', () => {
  const jobs = [ready('fresh'), ready('already-seen')];
  const picked = bankedJobs(jobs, { seen: new Set(['already-seen']) });
  assert.deepEqual(picked.map((job) => job.id), ['fresh']);
});

test('an employer applied to since the document was written is left alone', () => {
  // The expensive mistake: a document banked on Monday, the company
  // applied to on Tuesday, and this sending it again on Wednesday under
  // the candidate's name.
  const jobs = [ready('open'), ready('applied-since')];
  const picked = bankedJobs(jobs, { duplicate: (job) => job.id === 'applied-since' });
  assert.deepEqual(picked.map((job) => job.id), ['open']);
});

test('newest first, because a document decays', () => {
  const jobs = [ready('old', { updatedAt: 100 }), ready('newest', { updatedAt: 900 }), ready('middle', { updatedAt: 500 })];
  assert.deepEqual(bankedJobs(jobs).map((job) => job.id), ['newest', 'middle', 'old']);
});

test('an empty or missing bank is nothing to do, not an error', () => {
  assert.deepEqual(bankedJobs([]), []);
  assert.deepEqual(bankedJobs(undefined), []);
  assert.deepEqual(bankedJobs([null, undefined]), []);
});

console.log(`${count} banked-document checks passed.`);
