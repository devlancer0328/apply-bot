import {withDefaults} from './profile.js';
/** The service worker owns SQLite. OPFS holds an actual SQLite database file. */
import initSqlJs from "./vendor/sqlite.js";
import { bytesToBase64, base64ToBytes, pack } from "./codec.js";
import { historyIndex, historyUrls, jobIdentityKeys, previewHistory } from './history.js';
import {companyKey,companyResolved,roleKey} from './companies.js';
import {questionKey,recordQuestion,answerQuestion} from './question-pack.js';
const LEGACY_TABLES = ["applications", "results", "resumes", "templates", "files"];
const TABLES = new Set([...LEGACY_TABLES, 'history','jobs','questions']);
const FILE = "apply-bot.sqlite3";
let connection, engine, directory, ready, queue = Promise.resolve();
function schema(db) {
  db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
  for (const table of TABLES) db.run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run("PRAGMA user_version = 7");
}
function rows(sql, args = []) {
  const statement = connection.prepare(sql);
  try { statement.bind(args); const result = []; while (statement.step()) result.push(statement.getAsObject()); return result; }
  finally { statement.free(); }
}
function readSetting(key) { return rows("SELECT json FROM settings WHERE key = ?", [key]).map(r => JSON.parse(r.json))[0]; }
function writeSetting(key, value) { connection.run("INSERT OR REPLACE INTO settings (key, json) VALUES (?, ?)", [key, JSON.stringify(value)]); }
function put(table, value) {
  if (!value || typeof value !== "object" || !String(value.id || "").trim()) throw new Error("A record needs an id.");
  connection.run(`INSERT OR REPLACE INTO ${table} (id, json, updated_at) VALUES (?, ?, ?)`, [String(value.id), JSON.stringify(value), Date.now()]);
}
async function persist() {
  const handle = await directory.getFileHandle(FILE, { create: true });
  const stream = await handle.createWritable();
  try { await stream.write(connection.export()); await stream.close(); }
  catch (error) { await stream.abort().catch(() => {}); throw error; }
}
async function legacyRecords() {
  const databases = await indexedDB.databases();
  if (!databases.some(db => db.name === "greenhouse-apply")) return {};
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("greenhouse-apply");
    request.onerror = () => reject(request.error);
    request.onsuccess = async () => {
      const db = request.result, records = {};
      try {
        for (const name of ["applications", "results"]) {
          if (!db.objectStoreNames.contains(name)) continue;
          records[name] = await new Promise((res, rej) => {
            const tx = db.transaction(name), read = tx.objectStore(name).getAll();
            read.onsuccess = () => res(read.result); read.onerror = () => rej(read.error);
          });
        }
        resolve(records);
      } catch (error) { reject(error); } finally { db.close(); }
    };
  });
}
async function open() {
  // Given a URL, sql.js compiles the wasm streaming, and Chrome refuses to
  // stream-compile a chrome-extension:// response: every start logged a
  // failed streaming compile and then fetched the identical bytes a second
  // time to instantiate them from an ArrayBuffer. Handing over the bytes
  // takes the path that already worked and drops the attempt that never did.
  engine = await initSqlJs({ wasmBinary: await (await fetch(chrome.runtime.getURL("src/vendor/sql-wasm.wasm"))).arrayBuffer() });
  if (!navigator.storage?.getDirectory) throw new Error("SQLite storage needs Chrome 120 or later with local filesystem storage enabled.");
  directory = await navigator.storage.getDirectory();
  let bytes;
  try { bytes = new Uint8Array(await (await (await directory.getFileHandle(FILE)).getFile()).arrayBuffer()); }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
  connection = bytes?.length ? new engine.Database(bytes) : new engine.Database();
  schema(connection);
  if (!readSetting("sqliteMigrated")) {
    const previous = connection.export();
    try {
      const stored = await chrome.storage.local.get(null), legacy = await legacyRecords();
      connection.run("BEGIN");
      for (const [key, value] of Object.entries(stored)) writeSetting(key, await pack(value));
      for (const table of ["applications", "results"]) for (const value of legacy[table] || []) put(table, await pack(value));
      writeSetting("sqliteMigrated", { at: Date.now(), from: "chrome.storage.local + IndexedDB" });
      connection.run("COMMIT"); await persist();
    } catch (error) { connection.close(); connection = new engine.Database(previous); throw error; }
  }
  const beforeMigration=connection.export();
  try { if(migrateChatContext()) await persist(); }
  catch(error) { connection.close(); connection=new engine.Database(beforeMigration); throw error; }
}
function migrateChatContext() {
  if (readSetting('chatContextFlow')) return false;
  connection.run('BEGIN');
  const profile=readSetting('profile'); if(profile) writeSetting('profile',withDefaults(profile));
  const allowed=new Set(['id','name','kind','document','sourceText','pdf','originalPdf','letter','letterPdf','job','templateId','compensation','createdAt','updatedAt']);
  for(const row of rows('SELECT json FROM resumes')) {
    const value=JSON.parse(row.json),kept=Object.fromEntries(Object.entries(value).filter(([key])=>allowed.has(key)));
    kept.kind=['generated','tailored'].includes(value.kind)?'generated':'saved'; put('resumes',kept);
  }
  writeSetting('chatContextFlow',1); connection.run('COMMIT'); return true;
}

function initialize() {
  if (!ready) ready = open().catch(error => { ready = null; connection?.close(); connection = null; throw error; });
  return ready;
}
/** Only an allowlisted API is exposed to extension pages. */
export function databaseRequest(request) {
  const next = queue.then(async () => {
    await initialize();
    const { action, table, id, value, keys } = request;
    if (table && !TABLES.has(table)) throw new Error("Unknown database table.");
    if (["get", "list", "put", "replace", "delete"].includes(action) && !TABLES.has(table)) throw new Error("A database table is required.");
    if (action === "get") return rows(`SELECT json FROM ${table} WHERE id = ?`, [String(id)]).map(r => JSON.parse(r.json))[0] ?? null;
    if (action === "list") return rows(`SELECT json FROM ${table} ORDER BY updated_at DESC, id`).map(r => JSON.parse(r.json));
    if(action==='fileMetadata'){const prefix=String(request.prefix||'');return rows('SELECT json FROM files WHERE substr(id,1,length(?))=?',[prefix,prefix]).map(row=>{const {content,...metadata}=JSON.parse(row.json);return metadata;});}
    if (action === "kvGet") {
      const selected = keys == null ? rows("SELECT key, json FROM settings") : (Array.isArray(keys) ? keys : [keys]).flatMap(key => rows("SELECT key, json FROM settings WHERE key = ?", [key]));
      return Object.fromEntries(selected.map(r => [r.key, JSON.parse(r.json)]));
    }
    if (action === "stats") return { engine: "SQLite", file: FILE, bytes: rows('PRAGMA page_count')[0].page_count * rows('PRAGMA page_size')[0].page_size, tables: Object.fromEntries([...TABLES].map(t => [t, rows(`SELECT COUNT(*) AS count FROM ${t}`)[0].count])) };
    if (action === "export") return bytesToBase64(connection.export());
    // Transactions roll back SQL failures without copying every stored PDF.
    // Keep a snapshot only for a restore, which replaces the connection itself.
    const before = action === 'import' ? connection.export() : null;
    let inTransaction = false, committed = false, released = false;
    try {
      if (action === "import") {
        const imported = new engine.Database(base64ToBytes(value));
        try {
          if (imported.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] !== "ok") throw new Error("The SQLite backup failed its integrity check.");
          const names = imported.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat() || [];
          if (!["settings", ...LEGACY_TABLES].every(t => names.includes(t))) throw new Error("Choose an Apply Bot SQLite backup.");
          for (const t of ["settings", ...TABLES].filter(t => names.includes(t))) {
            const columns = imported.exec(`PRAGMA table_info(${t})`)[0]?.values.map(row => row[1]) || [];
            if (!(t === "settings" ? ["key", "json"] : ["id", "json", "updated_at"]).every(c => columns.includes(c))) throw new Error("The backup has an incompatible schema.");
          }
          schema(imported);
          const previousConnection=connection;
          connection=imported;
          try { migrateChatContext(); }
          catch(error) { connection=previousConnection; throw error; }
          previousConnection.close();
        } catch (error) { imported.close(); throw error; }
      } else {
        connection.run("BEGIN"); inTransaction = true;
        if (action === "put") {
          const old = table === "results" ? rows("SELECT json FROM results WHERE id = ?", [String(value.id)]).map(r => JSON.parse(r.json))[0] : null;
          if (!(old && ["submitted", "unconfirmed"].includes(old.status) && !["submitted", "unconfirmed"].includes(value.status))) {
            put(table, value);
            if (table === 'results') {
              const markers = rows('SELECT json FROM history').map(r=>JSON.parse(r.json)).filter(r=>r.kind === 'submission');
              for (const marker of markers) if(historyIndex([marker]).match(...historyUrls(value))) put('history',{...marker,status:value.status});
            }
          }
        } else if (action === 'historyImport') {
          if (!Array.isArray(value) || value.length > 10000) throw new Error('Import at most 10,000 links at a time.');
          const current = rows('SELECT json FROM history').map(r => JSON.parse(r.json));
          const valid = value.map(row => ({id:`external:${crypto.randomUUID()}`,kind:'external',applyUrl:row.applyUrl || '',urls:historyUrls(row).filter(url=>jobIdentityKeys(url).length),company:String(row.company || ''),companyAliases:(Array.isArray(row.companyAliases)?row.companyAliases:[]).map(String).filter(companyKey),title:String(row.title || ''),path:String(row.path || ''),importedAt:Date.now()}));
          if (valid.some(row => !companyResolved(row) && !jobIdentityKeys(row.applyUrl).length)) throw new Error('Each entry needs a company name or valid job link.');
          const preview = previewHistory(valid,current);
          for (const row of preview.fresh) put('history',row);
        } else if (action === 'historyCompany') {
          if(!companyKey(value.company)) throw new Error('Enter the actual company name.');
          const row=rows('SELECT json FROM history WHERE id=?',[String(value.id)]).map(r=>JSON.parse(r.json))[0];
          if(!row) throw new Error('This history entry no longer exists.');
          put('history',{...row,company:String(value.company).trim(),companyAliases:[...new Set((value.aliases || []).filter(name=>companyKey(name) && companyKey(name)!==companyKey(value.company)))]});
        } else if (action === 'claimSubmission') {
          const current = rows('SELECT json FROM history').map(r=>JSON.parse(r.json));
          const previous = rows('SELECT json FROM results').map(r=>JSON.parse(r.json)).filter(r=>['submitted','unconfirmed'].includes(r.status));
          const legacySent = readSetting('submitted') || [];
          const index = historyIndex([...current,...previous,...legacySent.map(url=>({applyUrl:url}))]);
          // What a company-level refusal is allowed to mean, which is less
          // than it used to. This matched every row, so the second role at
          // an employer already applied to was refused here - at the last
          // gate, after its resume had been written, its form filled and
          // its slot spent - which quietly cancelled the per-employer
          // budget the whole supply fix is built on (employers.js) and most
          // of what reading an employer's own board is for (boards.js). It
          // now means what it means everywhere else: an imported "never
          // this employer again", a row carrying no posting of its own.
          const barred = historyIndex(current.filter(row=>!historyUrls(row).some(url=>jobIdentityKeys(url).length)));
          // And the protection that narrowing gives up is taken back
          // exactly, rather than dropped. One posting has several
          // addresses - Jobright's, Hiring Cafe's, the board's own - so
          // refusing by address alone lets the same job through twice. The
          // employer and the role together are what identify it, and only
          // this bot's own sends count: an imported folder name is not
          // evidence of which opening it was.
          const roles = new Set([...current.filter(row=>row.kind==='submission'),...previous].map(row=>roleKey(row.company,row.title)).filter(Boolean));
          if(current.some(r=>r.kind === 'external' && !companyResolved(r))) throw new Error('Resolve company names in Already applied before submitting.');
          if(!companyKey(value?.company)) throw new Error('The hiring company must be verified before submitting.');
          if (!jobIdentityKeys(value?.applyUrl).length) throw new Error('Cannot submit without a valid application URL.');
          const role = roleKey(value.company,value.title);
          const match = barred.matchCompany(value.company,...historyUrls(value)) || index.match(...historyUrls(value)) || (role && roles.has(role) ? {company:value.company,title:value.title,kind:'role'} : null);
          if (match) { connection.run('ROLLBACK'); inTransaction = false; return {claimed:false,record:match}; }
          put('history',{...value,id:`submission:${jobIdentityKeys(value.applyUrl)[0]}`,kind:'submission',importedAt:Date.now()});
        } else if (action === 'releaseSubmission') {
          // The other half of a claim, and the half that was missing.
          // `claimSubmission` is taken in the last moment before Submit, so
          // every way an attempt can end badly after that point - a puzzle
          // the board only shows once the form is sent, a refusal, a button
          // that would not click - left the employer marked as applied to
          // with no application anywhere. There was no way back from that
          // state, which at two burns in five attempts would have cost an
          // unattended night a large share of the employers it touched.
          //
          // Narrow on purpose. Only a row this bot wrote itself, addressed
          // exactly as `claimSubmission` addressed it, is ever removed. An
          // imported "already applied" row is the applicant's own statement
          // about their own history, and a release that could delete one
          // would quietly reopen an employer they asked never to approach.
          const key = jobIdentityKeys(value?.applyUrl)[0];
          const held = key ? rows('SELECT json FROM history WHERE id = ?',[`submission:${key}`]).map(r=>JSON.parse(r.json))[0] : null;
          if (!held || held.kind !== 'submission') { connection.run('ROLLBACK'); inTransaction = false; return {released:false}; }
          connection.run('DELETE FROM history WHERE id = ?',[`submission:${key}`]);
          released = true;
        } else if (action === 'questionAsk') {
          // Read, merge, write, inside the one transaction. Two attempts
          // parking on the same question in the same second is ordinary
          // at this concurrency, and a read-modify-write split across
          // them would lose a count or, worse, an answer typed between
          // the read and the write.
          for (const sighting of Array.isArray(value) ? value : [value]) {
            const key = questionKey(sighting?.question, sighting?.company);
            if (!key) continue;
            const existing = rows('SELECT json FROM questions WHERE id = ?', [key]).map(r => JSON.parse(r.json))[0];
            const merged = recordQuestion(existing ? { [key]: existing } : {}, sighting);
            put('questions', { ...merged[key], id: key });
          }
        } else if (action === 'questionAnswer') {
          const key = String(value?.key ?? '');
          const row = rows('SELECT json FROM questions WHERE id = ?', [key]).map(r => JSON.parse(r.json))[0];
          if (!row) throw new Error('That question is no longer in the pack.');
          put('questions', { ...answerQuestion({ [key]: row }, key, value?.answer)[key], id: key });
        } else if (action === 'questionUsed') {
          // Said after a form was actually filled from the pack, so the
          // page can show which answers are earning their place.
          for (const key of (Array.isArray(value) ? value : [value]).map(String)) {
            const row = rows('SELECT json FROM questions WHERE id = ?', [key]).map(r => JSON.parse(r.json))[0];
            if (row) put('questions', { ...row, usedCount: (row.usedCount ?? 0) + 1, lastUsedAt: Date.now() });
          }
        } else if (action === "replace") { connection.run(`DELETE FROM ${table}`); for (const row of value) put(table, row); }
        else if (action === "delete") connection.run(`DELETE FROM ${table} WHERE id = ?`, [String(id)]);
        else if (action === "kvSet") for (const [key, item] of Object.entries(value)) writeSetting(key, item);
        else if (action === "kvRemove") for (const key of Array.isArray(keys) ? keys : [keys]) connection.run("DELETE FROM settings WHERE key = ?", [key]);
        else throw new Error("Unknown database operation.");
      }
      if (inTransaction) { connection.run('COMMIT'); inTransaction = false; committed = true; }
      await persist();
      if (action === 'claimSubmission') return {claimed:true};
      return action === 'releaseSubmission' ? {released} : true;
    } catch (error) {
      if (before) { connection.close(); connection = new engine.Database(before); }
      else if (inTransaction) connection.run('ROLLBACK');
      else if (committed) { connection.close(); connection = null; ready = null; }
      throw error;
    }
  });
  queue = next.catch(() => {});
  return next;
}
