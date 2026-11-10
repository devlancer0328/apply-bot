/**
 * Why nothing ever appeared in Downloads, and what a refused download is
 * allowed to break.
 *
 * Three profiles pulled off machines that had been applying for days all
 * held `exportFiles: false` - the shipped default, switchable only from a
 * checkbox at the foot of the data page. Every document was in SQLite and
 * the "job applied-folder" the rest of the extension talks about had
 * never been written to.
 *
 * Two defects behind that, past the default itself:
 *
 *   - src/vault.js read `exportFiles` straight off the stored profile
 *     rather than through `withDefaults`, so a changed default could not
 *     reach a profile already on disk.
 *   - A download Chrome refused threw out of `save`, and `save` is called
 *     in sequence from `archive`. One refusal partway through took the
 *     letter, the answers and the confirmation screenshot out of SQLite
 *     too - of an application that had already been sent.
 */
import assert from 'node:assert/strict';
import { BUILD_VERSION, DATABASE_PROTOCOL } from '../src/update.js';
import { withDefaults } from '../src/profile.js';

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };

/**
 * The extension page half of the database transport, which is what
 * src/store.js talks to outside the service worker. Settings are held in
 * `kv`, files in `files`, and `download` decides what Chrome does with the
 * next download request.
 */
const kv = {};
const files = new Map();
let download = async () => 1;
const searched = new Map();
globalThis.Blob ??= (await import('node:buffer')).Blob;
globalThis.chrome = {
  runtime: {
    sendMessage: async ({ request }) => {
      const value = await (async () => {
        if (request.action === 'kvGet') return request.keys == null ? kv : Object.fromEntries((Array.isArray(request.keys) ? request.keys : [request.keys]).filter(k => k in kv).map(k => [k, kv[k]]));
        if (request.action === 'kvSet') { Object.assign(kv, request.value); return true; }
        if (request.action === 'put') { files.set(request.value.id, request.value); return true; }
        return null;
      })();
      return { protocol: DATABASE_PROTOCOL, build: BUILD_VERSION, ok: true, value };
    },
  },
  downloads: {
    download: (...args) => download(...args),
    search: async ({ id }) => (searched.has(id) ? [searched.get(id)] : []),
  },
};

const { save, onExportProblem, ROOT } = await import('../src/vault.js');

const reset = (profile) => {
  kv.profile = profile;
  files.clear();
  searched.clear();
  download = async () => 1;
};

await test('a profile written before the default changed starts writing to Downloads', () => {
  // The three field profiles: the key is stored, and stored false, so
  // neither `??` nor the boolean pass in `withDefaults` touches it. Only
  // the revision does.
  const field = withDefaults({ fullName: 'Steven', exportFiles: false });
  assert.equal(field.exportFiles, true);
  assert.equal(field.profileRevision, 1);
});

await test('turning the export off after the migration keeps it off', () => {
  const chosen = withDefaults({ fullName: 'Steven', exportFiles: false, profileRevision: 1 });
  assert.equal(chosen.exportFiles, false);
});

await test('a stored profile missing the key is read as writing to Downloads', async () => {
  reset({ fullName: 'Steven', exportFiles: false });
  const asked = [];
  download = async (options) => { asked.push(options); return 1; };
  const where = await save('applied/2026-11-09/Acme - Engineer [ab12cd34]/Steven_Resume.pdf', 'pdf bytes');
  assert.equal(asked.length, 1, 'the download was skipped on a profile that predates the default');
  assert.equal(asked[0].filename, `${ROOT}/applied/2026-11-09/Acme - Engineer [ab12cd34]/Steven_Resume.pdf`);
  assert.equal(where, asked[0].filename);
});

await test('the file reaches SQLite before the download is attempted', async () => {
  reset({ exportFiles: true, profileRevision: 1 });
  download = async () => { throw new Error('Invalid URL'); };
  await save('applied/2026-11-09/Acme - Engineer/Answers.txt', 'Q: why\nA: because');
  const row = files.get('applied/2026-11-09/Acme - Engineer/Answers.txt');
  assert.ok(row, 'the row is written first, so a refused download cannot cost the archive');
});

await test('a refused download does not throw, and the archive goes on', async () => {
  reset({ exportFiles: true, profileRevision: 1 });
  const problems = [];
  onExportProblem(message => problems.push(message));
  download = async () => { throw new Error('Invalid URL'); };

  // What `archive` does: several files in a row for one application.
  const folder = 'applied/2026-11-09/Acme - Engineer';
  const written = [];
  for (const name of ['Steven_Resume.pdf', 'Cover letter.txt', 'Answers.txt', 'Last page.png']) {
    written.push(await save(`${folder}/${name}`, 'content'));
  }
  assert.equal(written.length, 4, 'every file after the first refusal was still archived');
  assert.equal(files.size, 4);
  assert.deepEqual(written, [`${folder}/Steven_Resume.pdf`, `${folder}/Cover letter.txt`, `${folder}/Answers.txt`, `${folder}/Last page.png`], 'the returned path is the workspace one when the copy did not land');
  assert.equal(problems.length, 1, 'said once for the reason, not once per file');
  assert.match(problems[0], /Invalid URL/);
  onExportProblem(null);
});

await test('a download Chrome interrupts is reported rather than counted as written', async () => {
  reset({ exportFiles: true, profileRevision: 1 });
  const problems = [];
  onExportProblem(message => problems.push(message));
  // `download()` resolves with an id; the failure only shows up in the
  // item's state afterwards, which is how this one got through.
  download = async () => { searched.set(7, { id: 7, state: 'interrupted', error: 'FILE_NO_SPACE' }); return 7; };
  const where = await save('applied/2026-11-09/Acme - Engineer/Steven_Resume.pdf', 'pdf bytes');
  assert.equal(where, 'applied/2026-11-09/Acme - Engineer/Steven_Resume.pdf');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /FILE_NO_SPACE/);
  onExportProblem(null);
});

await test('a completed download reports nothing and returns the path on disk', async () => {
  reset({ exportFiles: true, profileRevision: 1 });
  const problems = [];
  onExportProblem(message => problems.push(message));
  download = async () => { searched.set(9, { id: 9, state: 'complete' }); return 9; };
  const where = await save('applied/2026-11-09/Acme - Engineer/Steven_Resume.pdf', 'pdf bytes');
  assert.equal(where, `${ROOT}/applied/2026-11-09/Acme - Engineer/Steven_Resume.pdf`);
  assert.deepEqual(problems, []);
  onExportProblem(null);
});

console.log(`\n${count} checks passed.`);
