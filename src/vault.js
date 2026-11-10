import { atsOf } from "./ats.js";

/** Application artifacts stored in SQLite, with optional exports through the downloads API. */

import { toBase64, db, stateStorage } from "./store.js";
import { withDefaults } from "./profile.js";

export const ROOT = "job applied-folder";

/** A file name every filesystem will take, Windows being the strictest. */
export const safeName = (name) =>
  String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 80);

/** 2026-10-31 18-14-36: sorts as time does, and is legal in a file name. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** Include the year so application archives do not collide across years. */
export const dayFolder = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * The folder one application's files go in: under the day it was made, the
 * company and the role, nothing else. The time is on the screenshot inside
 * it, and a job is applied to once, so the name needs no stamp to stay
 * unique.
 */
export const applicationFolder = (application, root = "applied", date = new Date()) => {
  const key = application.id || application.applyUrl || "";
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${root}/${dayFolder(date)}/${safeName(application.company) || "application"}${application.title ? ` - ${safeName(application.title)}` : ""}${key ? ` [${hash.toString(16)}]` : ""}`;
};

/** Where the day's table of jobs left to be sent by hand goes: "other links/11-2.csv". */
export const otherLinksPath = (date = new Date()) => `other links/${dayFolder(date)}.csv`;

const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** Where the documents for jobs the applicant sends by hand go. */
export const MANUAL_ROOT = "manual application";

/**
 * The board a job the bot did not send applies through, for a column a
 * spreadsheet can filter on: a named ATS, "email" for a mailto: link, and
 * "company site" for everything else.
 */
export function boardLabel(url) {
  const link = String(url ?? "").trim();
  if (/^mailto:/i.test(link)) return "email";
  return atsOf(link) || "company site";
}

/**
 * "other links/<day>.csv": every job this bot wrote up but did not send that
 * day, oldest first - one row per job, with the board it applies through, the link the
 * job was found at, the link to apply at, the folder holding its resume and
 * letter, and why it was left to be sent by hand. Written with a byte-order
 * mark and CRLF line ends so Excel opens it as-is.
 */
export function otherLinksCsv(rows) {
  const header = ["date", "company", "role", "board", "job link", "application link", "folder", "why"];
  const lines = [...rows]
    .sort((a, b) => a.at - b.at)
    .map((row) =>
      [
        new Date(row.at).toISOString().slice(0, 10),
        row.company || "",
        row.title || "",
        boardLabel(row.applyUrl),
        row.sourceUrl || row.applyUrl || "",
        row.applyUrl || "",
        row.folder || "",
        row.reason || "",
      ]
        .map(cell)
        .join(","),
    );
  return `\ufeff${[header.map(cell).join(","), ...lines].join("\r\n")}\r\n`;
}

async function asDataUrl(content, type) {
  if (content instanceof Blob) return `data:${content.type || type};base64,${await toBase64(content)}`;
  // Text goes through the same base64 route: a data: URL with raw text in it
  // is subject to percent-decoding, which mangles anything with a % in it.
  const bytes = new TextEncoder().encode(String(content));
  return `data:${type};base64,${await toBase64(new Blob([bytes]))}`;
}

/**
 * Writes one file. `overwrite` is for the index files, which are rewritten
 * whole; everything else is written once and never collides, but is
 * uniquified rather than overwritten should it.
 */
export async function save(path, content, { overwrite = false, type = "text/plain" } = {}) {
  // Documents and evidence live in SQLite. Downloads are optional exports.
  const blob = content instanceof Blob ? content : new Blob([String(content)], { type });
  await db({ action: "put", table: "files", value: { id: path, path, content: blob, type: blob.type || type, at: Date.now() } });
  const { profile } = await stateStorage.get("profile");
  // Through `withDefaults` rather than straight off the stored object: the
  // profile on disk predates this default and does not carry the key.
  if (!withDefaults(profile).exportFiles) return path;
  const filename = `${ROOT}/${path}`;
  // The copy in Downloads is a copy. It is written after the row above and
  // its failure is reported rather than thrown, because the caller is
  // partway through archiving an application that was already sent: a
  // refused download used to abort the archive and take the letter, the
  // answers and the confirmation screenshot down with it.
  try {
    const url = await asDataUrl(content, type);
    // One write to a file at a time. Two overwrites of the run log started
    // in the same instant - one after the last job, one as the run ended -
    // and Chrome, finding the file already being written, put up a "Save
    // as" dialog for the second. Each write waits for the previous write to
    // the same file to finish.
    const previous = writing.get(filename) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => chrome.downloads.download({ url, filename, conflictAction: overwrite ? "overwrite" : "uniquify", saveAs: false }))
      .then(untilDone);
    writing.set(filename, current);
    await current;
    if (writing.get(filename) === current) writing.delete(filename);
    return filename;
  } catch (error) {
    reportExport(filename, error?.message ?? String(error));
    return path;
  }
}

const writing = new Map();

/**
 * Said once per reason rather than once per file. A download that is
 * refused is refused for every file after it, and a run writes a dozen per
 * application, so the untrimmed version buries the log it is written into.
 */
let report = () => {};
const reported = new Set();
export const onExportProblem = (fn) => {
  report = typeof fn === "function" ? fn : () => {};
  reported.clear();
};
function reportExport(filename, message) {
  if (reported.has(message)) return;
  reported.add(message);
  report(`Could not write ${filename} to Downloads: ${message}. The file is in the extension's workspace; the copy on disk was skipped.`);
}

/**
 * Resolves once a download has left the in-progress state, or after a few
 * seconds regardless. A download Chrome gave up on reads as "interrupted"
 * rather than as an error from `download()`, so it is raised here - the
 * caller turns it into one report, not a thrown archive.
 */
async function untilDone(downloadId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    if (!item) return;
    if (item.state === "interrupted") throw new Error(item.error || "the download was interrupted");
    if (item.state !== "in_progress") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const saveJson = (path, value, options) => save(path, JSON.stringify(value, null, 2), { ...options, type: "application/json" });

/** The whole results table, as a CSV any spreadsheet opens. */
export function resultsCsv(results) {
  const header = ["when", "company", "role", "status", "reason", "seconds", "apply url", "found via", "folder"];
  const rows = [...results]
    .sort((a, b) => a.at - b.at)
    .map((result) =>
      [
        new Date(result.at).toISOString(),
        result.company,
        result.title,
        result.status,
        result.reason,
        Math.round((result.took ?? 0) / 1000),
        result.applyUrl,
        result.sourceUrl ?? "",
        result.detail?.folder ?? "",
      ]
        .map(cell)
        .join(","),
    );
  return [header.map(cell).join(","), ...rows].join("\n");
}

/** The log of a run, as it was shown in the popup. */
export function logText(entries) {
  return entries
    .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.level.padEnd(5)} ${entry.message}${entry.detail ? `  ${JSON.stringify(entry.detail)}` : ""}`)
    .join("\n");
}
