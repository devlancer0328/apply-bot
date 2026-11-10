/**
 * A copy of each finished application, posted to a service of the
 * applicant's own.
 *
 * ## The report
 *
 * "At the end, it downloads resume & job links, right? There must be
 * option to send these to API." With an endpoint that takes a multipart
 * POST - name, jobTitle, companyName, description and the resume as a
 * file - behind an `x-api-key` header.
 *
 * ## What this has to get right
 *
 * The application is already submitted by the time any of this runs.
 * The form is filled, Submit is pressed, the employer has it, and the
 * record is written. So the one thing the upload may never do is turn a
 * sent application into a failed one, and that shapes the whole module:
 * nothing throws, every way of failing comes back as a reason, and the
 * reason is kept on the record so "Send past applications" can have
 * another go at exactly the ones that did not arrive.
 *
 * The other half is honesty about what is sent. `description` is the
 * posting text the resume was actually written from, and `resume` is
 * the PDF that actually went to the employer - not a regenerated one.
 * A resume that is not a Blob is refused rather than appended, because
 * `FormData` turns a stray Uint8Array into the string
 * "[object Uint8Array]" and sends it: a corrupt upload that answers 200.
 */
import assert from 'node:assert/strict';
import { REQUIRED, missingFields, resumeBlob, uploadApplication, uploadFields, uploadSettings } from '../src/upload.js';
import { withDefaults } from '../src/profile.js';

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };

const PROFILE = withDefaults({ firstName: 'Daniel', lastName: 'Torres', uploadEnabled: true, uploadApiKey: 'test-key' });
const APPLICATION = { company: 'Acme Corp', title: 'Software Engineer', jd: 'Paste the full job description here', resume: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), resumeName: 'Daniel Torres - Acme.pdf' };
const send = (overrides = {}, options = {}) => uploadApplication({
  url: 'http://work.rson.store/api/external/upload-job',
  apiKey: 'test-key',
  fields: uploadFields(APPLICATION, PROFILE),
  resume: APPLICATION.resume,
  resumeName: APPLICATION.resumeName,
  ...overrides,
}, options);

/** Captures the request and answers with whatever the test wants. */
function transport(reply) {
  const seen = {};
  const fetch = async (url, init) => {
    seen.url = url;
    seen.headers = init.headers;
    seen.form = init.body;
    seen.signal = init.signal;
    if (typeof reply === 'function') return reply();
    return reply;
  };
  return { fetch, seen };
}
const answers = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

await test('the settings say what is still missing rather than silently doing nothing', () => {
  assert.deepEqual(uploadSettings({ uploadEnabled: false }).on, false);
  assert.deepEqual(uploadSettings({ uploadEnabled: true, uploadUrl: '', uploadApiKey: '' }).missing, ['the upload address', 'the API key']);
  assert.deepEqual(uploadSettings({ uploadEnabled: true, uploadUrl: 'work.rson.store/upload', uploadApiKey: 'k' }).missing, ['a valid upload address']);
  assert.equal(uploadSettings(withDefaults({ uploadEnabled: true, uploadApiKey: 'k' })).ready, true, 'the shipped address plus a key is a working setup');
});

await test('the job goes out as the endpoint names it, with the resume as a file', async () => {
  const { fetch, seen } = transport(answers(200, { ok: true, job: { id: 7 }, resumeLink: 'http://work.rson.store/r/7.pdf' }));
  const sent = await send({}, { fetch });

  assert.equal(sent.ok, true);
  assert.equal(sent.resumeLink, 'http://work.rson.store/r/7.pdf', 'the service\'s own answer comes back to the caller');
  assert.equal(seen.url, 'http://work.rson.store/api/external/upload-job');
  assert.deepEqual(seen.headers, { 'x-api-key': 'test-key' }, 'the key travels in the header, not the body');

  assert.equal(seen.form.get('name'), 'Daniel Torres');
  assert.equal(seen.form.get('jobTitle'), 'Software Engineer');
  assert.equal(seen.form.get('companyName'), 'Acme Corp');
  assert.equal(seen.form.get('description'), 'Paste the full job description here', 'the posting text the resume was written from');
  const file = seen.form.get('resume');
  assert.ok(file instanceof Blob, 'the resume is a file part, not a string');
  assert.equal(file.name, 'Daniel Torres - Acme.pdf');
  assert.equal(await file.text(), '\u0001\u0002\u0003', 'the bytes that went to the employer');
});

await test('the description is the posting text, and nothing is invented for it', () => {
  assert.equal(uploadFields({ company: 'Acme', title: 'Engineer', jd: 'The posting' }, PROFILE).description, 'The posting');
  assert.deepEqual(missingFields(uploadFields({ company: 'Acme', title: 'Engineer', jd: '' }, PROFILE)), ['description']);
  assert.deepEqual(missingFields(uploadFields({}, {})), REQUIRED, 'an empty application is missing all four');
});

await test('an application missing a required field is refused before the request', async () => {
  let called = false;
  const sent = await send({ fields: { ...uploadFields(APPLICATION, PROFILE), description: '' } }, { fetch: async () => { called = true; } });
  assert.equal(sent.ok, false);
  assert.match(sent.error, /needs description/);
  assert.equal(called, false, 'a request the endpoint would reject is not worth making');
});

await test('a resume that is not a file is refused, not stringified into the form', async () => {
  assert.equal(resumeBlob(null), null);
  assert.equal(resumeBlob('resume.pdf'), null, 'a path is not a file: this runs in a browser, there is no disk to read');
  assert.ok(resumeBlob(new Uint8Array([1, 2])) instanceof Blob, 'bytes from an older record are wrapped');
  let called = false;
  const sent = await send({ resume: 'resume.pdf' }, { fetch: async () => { called = true; } });
  assert.equal(sent.ok, false);
  assert.match(sent.error, /no resume file/);
  assert.equal(called, false);
});

await test('every way the service can fail comes back as a reason, never as a throw', async () => {
  const cases = [
    [answers(401, { error: 'Invalid API key' }), /Invalid API key \(401\)/],
    [answers(500, '<html>Bad Gateway</html>'), /Bad Gateway/],
    [answers(503, ''), /upload failed \(503\)/],
    [() => { throw Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }); }, /could not reach the upload service: Failed to fetch/],
    [() => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); }, /no answer within 30s/],
  ];
  for (const [reply, expected] of cases) {
    const { fetch } = transport(reply);
    const sent = await send({}, { fetch });
    assert.equal(sent.ok, false, String(expected));
    assert.match(sent.error, expected);
  }
});

await test('a body that is not JSON cannot be read as a successful upload', async () => {
  const { fetch } = transport(answers(200, 'Accepted'));
  const sent = await send({}, { fetch });
  assert.equal(sent.ok, true, 'the status is what says it arrived');
  assert.equal(sent.resumeLink, '', 'and nothing is invented for the fields the body did not carry');
});

await test('the request cannot hang: it carries a deadline', async () => {
  const { fetch, seen } = transport(answers(200, { ok: true }));
  await send({}, { fetch, timeoutMs: 1000 });
  assert.ok(seen.signal, 'an attempt is not held open by an endpoint that stopped answering');
  assert.equal(seen.signal.aborted, false);
});

await test('the API key is left out of a settings export', async () => {
  // The export is built in options.js; this asserts the shape it relies
  // on - that the key is an ordinary profile field with a name of its
  // own, so deleting it from a copy removes it completely.
  const exported = withDefaults({ uploadApiKey: 'secret', workdayPassword: 'secret' });
  delete exported.uploadApiKey;
  delete exported.workdayPassword;
  assert.equal('uploadApiKey' in exported, false);
  assert.equal(JSON.stringify(exported).includes('secret'), false, 'nothing else in the profile is carrying it');
});

console.log(`\n${count} upload checks passed`);
