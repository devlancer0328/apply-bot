/**
 * A job link and the resume that must go with it.
 *
 * The two older ways in - a feed, or a bare list of links - both leave the
 * choice of document to the bot, which is right when nobody has made that
 * choice already. When someone has, replacing their file with a generated one
 * is not a better resume, it is the wrong application: they wrote that
 * document for that posting and will never see that it was swapped. So a
 * pairing is a promise, and the only honest way to keep it is to upload the
 * supplied bytes unchanged and never run the writer for that job at all.
 *
 * A pairing arrives either as a line of text naming a resume already in the
 * library, or as a folder laid out one directory per employer, each holding
 * the saved link and the PDF that was written for it. Both end as the same
 * record, so the run sees one kind of paired job however it was entered.
 *
 * Reading files is the caller's job. Nothing here touches the DOM, the
 * network or chrome.*, so a layout can be checked without a browser - which
 * matters because a pairing that is wrong must be refused while the person is
 * still looking at it, not three hundred applications later.
 */

import { canonicalUrl } from "./join.js";
import { extractHistoryLinks, historyIndex, jobIdentityKeys } from "./history.js";
import { toResume } from "./resume.js";

const LINK_FILE = /^(?:job[- _]?link|posting|link)\.txt$/i;
const DOCUMENT_FILE = /^resume\.json$/i;
const RESUME_NAME = /resume|cv/i;

/** The label a fault is reported against: an employer and role if the layout gave them, else whatever does identify the row. */
export const pairingLabel = (record) => [record?.company, record?.title].filter(Boolean).join(" · ") || record?.folder || record?.resumeName || record?.link || "this pairing";

/**
 * Paths grouped into one candidate pairing per directory.
 *
 * The directory names carry the employer and the role, the same reading
 * `historyCandidates` already makes of an exported folder, so a corpus
 * written for one importer is not re-arranged for the other. The chosen
 * folder's own name is dropped: it is the applicant's, not an employer's.
 */
export function pairingFolders(paths) {
  const groups = new Map();
  for (const value of paths) {
    const pieces = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const name = pieces.at(-1) || "";
    if (pieces.length < 2 || name.startsWith(".")) continue;
    const folder = pieces.slice(0, -1).join("/");
    if (!groups.has(folder)) {
      const above = pieces.slice(1, -1);
      groups.set(folder, { folder, company: (above.length > 1 ? above.at(-2) : above.at(-1)) || "", title: above.length > 1 ? above.at(-1) : "", files: [] });
    }
    groups.get(folder).files.push({ path: value, name });
  }
  return [...groups.values()];
}

/**
 * Which file in a directory is the link, which is the resume, which is the
 * structured copy - and why the directory cannot be used when one is absent.
 *
 * A directory with several PDFs and none named like a resume is refused
 * rather than guessed at, because guessing here uploads a cover letter or a
 * reference list to an employer under the heading "Resume".
 */
export function classifyPairingFolder(group) {
  const linkFile = group.files.find((file) => LINK_FILE.test(file.name)) || null;
  const pdfs = group.files.filter((file) => /\.pdf$/i.test(file.name));
  const resumeFile = (pdfs.length > 1 ? pdfs.find((file) => RESUME_NAME.test(file.name)) : pdfs[0]) || null;
  const fault = !linkFile ? "no job-link.txt in this folder" : !pdfs.length ? "no resume PDF in this folder" : !resumeFile ? `${pdfs.length} PDFs in this folder and none is named like a resume` : "";
  return { ...group, linkFile, resumeFile, documentFile: group.files.find((file) => DOCUMENT_FILE.test(file.name)) || null, fault };
}

/** The job link saved beside a resume, read the same way imported history reads one. */
export const pairingLink = (text) => extractHistoryLinks(text)[0] || "";

/**
 * Lines of "link, then resume label" as records.
 *
 * The separator is whatever the person used. A pasted two-column selection
 * arrives tab separated, a spreadsheet cell pair comma separated, and a line
 * typed by hand usually has a pipe in it; refusing two of the three would
 * read as the paste being broken.
 */
export function parsePairedLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const link = line.match(/https?:\/\/[^\s",<>)|]+/i)?.[0]?.replace(/[.,;:]+$/, "") ?? "";
      return { link, label: (link ? line.slice(line.indexOf(link) + link.length) : line).replace(/^\s*[,|;\t]\s*/, "").trim() };
    });
}

/** Why a record cannot be queued, or null when it can. */
export function pairingFault(record) {
  if (record?.fault) return String(record.fault);
  if (!jobIdentityKeys(record?.link || "").length) return "no usable job link was found";
  if (!record?.resumeId) return "no resume is paired with this link";
  return null;
}

/**
 * The records split into what will be queued and what will not.
 *
 * Both halves are returned because the rejected half is the point: a pairing
 * whose PDF is missing has to be visible while the folder is still open, and
 * one whose employer was already applied to has to be dropped here rather
 * than discovered by a second application landing in the same inbox. The
 * duplicate test is the run's own index, so the two agree by construction.
 */
export function reviewPairings(records, { applied = [] } = {}) {
  const index = historyIndex(applied), seen = new Set(), queued = [], rejected = [], duplicates = [];
  for (const record of records) {
    const row = { ...record, where: pairingLabel(record) }, fault = pairingFault(record);
    if (fault) { rejected.push({ ...row, fault }); continue; }
    const key = canonicalUrl(record.link);
    if (seen.has(key)) { duplicates.push({ ...row, fault: "the same posting appears earlier in this import" }); continue; }
    seen.add(key);
    const match = index.matchCompany(record.company, record.link) || index.match(record.link);
    if (match) { duplicates.push({ ...row, fault: `already applied: ${match.company || match.applyUrl || match.id}` }); continue; }
    queued.push(row);
  }
  return { queued, rejected, duplicates };
}

/** The supplied file itself, whichever way the library record came to hold one. */
const suppliedPdf = (saved) => [saved?.pdf, saved?.originalPdf].find((value) => value instanceof Blob && value.size > 0) || null;

/**
 * The application a paired job is submitted with.
 *
 * Built from the stored record alone: no writer call, no template, no
 * tailoring pass, and no document signature to decide whether a cached
 * generation is still good, because none of that can apply to a file that is
 * already final. The structured copy, when the library has one, is used for
 * the form's own questions - current employer, education, the career the
 * model is answering from - which is reading the supplied resume rather than
 * rewriting it. A record that cannot supply the file throws here, before a
 * tab is opened, since a half-filled form with no resume on it is worse than
 * a job that never started.
 */
export function suppliedApplication(job, saved, candidate) {
  const named = job.resumeName || saved?.name || "the paired resume";
  if (!saved) throw new Error(`${named} is no longer in the resume library; import the pairing again before running.`);
  const pdf = suppliedPdf(saved);
  if (!pdf) throw new Error(`${saved.name || named} has no PDF to upload; import the pairing again with the resume file.`);
  const resumeText = String(saved.sourceText || "").trim();
  if (!resumeText) throw new Error(`No text could be read from ${saved.name || named}, so its career cannot answer this form.`);
  const resume = saved.document ? toResume(saved.document, candidate) : null;
  return {
    id: job.id, sourceUrl: job.sourceUrl, applyUrl: job.applyUrl, company: job.company, title: job.title, jd: job.jd,
    originalUrl: job.originalUrl, descriptionSource: job.descriptionSource,
    compensation: { status: "not-requested" },
    aiMode: { selected: "supplied", reason: "You paired this resume with this posting." },
    timings: { extraction: job.extractionMs || 0 },
    letterText: "", letter: null, letterName: "",
    resumeText, resumeData: resume,
    currentRole: resume?.experience?.[0]?.role || "", currentCompany: resume?.experience?.[0]?.company || "",
    education: resume?.education || null,
    resume: pdf,
    resumeName: saved.fileName || `${String(saved.name || "Resume").replace(/[^a-z\d]+/gi, "_")}.pdf`,
  };
}
