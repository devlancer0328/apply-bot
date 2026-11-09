/**
 * Turning two piles of files into a list of applications to send.
 *
 * Neither pile is enough alone. The folders Resume Builder wrote hold the
 * documents and the posting link, but not the employer's application form. The
 * JSON the capture extension exports holds that form's address and the job
 * description, but no documents. They share the posting URL, so that is the
 * seam they are joined on.
 *
 * Nothing here touches the DOM, the network or chrome.*, which is what makes
 * the matching testable off a browser.
 */

/** Hosts whose application forms this bot knows how to fill. */
const GREENHOUSE = /(^|\.)greenhouse\.io$/i;

const KNOWN_BOARDS = [
  { pattern: /(^|\.)greenhouse\.io$/i, name: "greenhouse" },
  { pattern: /(^|\.)lever\.co$/i, name: "lever" },
  { pattern: /(^|\.)ashbyhq\.com$/i, name: "ashby" },
  { pattern: /(^|\.)myworkdayjobs\.com$/i, name: "workday" },
  { pattern: /(^|\.)smartrecruiters\.com$/i, name: "smartrecruiters" },
  { pattern: /(^|\.)icims\.com$/i, name: "icims" },
  { pattern: /(^|\.)bamboohr\.com$/i, name: "bamboohr" },
  { pattern: /(^|\.)workable\.com$/i, name: "workable" },
];

/** Which applicant tracking system a link leads to, for grouping and filtering. */
export function applyHost(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  const known = KNOWN_BOARDS.find((board) => board.pattern.test(host));
  return known ? known.name : "other";
}

export function isGreenhouse(url) {
  try {
    return GREENHOUSE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The posting link out of a Posting.txt.
 *
 * The file is written by the app as "<role> at <company>", the link, then the
 * date it was saved. Read by shape rather than by line number, so a file that
 * gains a line later still resolves.
 */
export function postingUrlFrom(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^https?:\/\//i.test(entry));
  return line ?? "";
}

/**
 * Ignores the parts of a link that do not change which job it is.
 *
 * The same posting arrives with a tracking parameter on one capture and
 * without it on the next, and a trailing slash either way. Comparing those
 * literally would leave every folder unmatched.
 */
export function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    // An embedded Greenhouse form is one path for every company and every
    // job - /embed/job_app?for=acme&token=123 - and is nothing without its
    // query. Dropped, every embedded form became "already applied to".
    // Unknown parameters can identify a job (?jobId=...), so remove only
    // recognized tracking keys and keep the rest in a stable order.
    for (const key of [...parsed.searchParams.keys()]) if (/^(?:utm_.+|gh_src|source|ref|referrer|referral|trackingId|trk|lever-source|lever-origin)$/i.test(key)) parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return String(url ?? "").trim().replace(/\/+$/, "");
  }
}

/**
 * Reads the flat FileList a directory picker produces back into folders.
 *
 * `webkitdirectory` hands over every file in the tree with its relative path
 * attached and no structure, so the structure is rebuilt from those paths. The
 * File System Access API would give the structure directly, but it is also what
 * fails to write on some Windows machines, and a picker that cannot be trusted
 * to write is not one to depend on for reading either.
 */
export function groupByFolder(files) {
  const folders = new Map();

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split("/").filter(Boolean);
    // <chosen folder>/<Company - Role>/<file>. Anything shallower is loose at
    // the top level and belongs to no application.
    if (parts.length < 2) continue;

    const name = parts[parts.length - 2];
    const entry = folders.get(name) ?? { name, files: new Map() };
    entry.files.set(parts[parts.length - 1], file);
    folders.set(name, entry);
  }

  return [...folders.values()];
}

const RESUME = /resume\.(pdf|docx)$/i;
const COVER_LETTER = /cover letter\.txt$/i;
const POSTING = /^posting\.txt$/i;

function pick(files, pattern) {
  for (const [name, file] of files) if (pattern.test(name)) return file;
  return null;
}

/**
 * Pairs each folder with the posting it was generated from.
 *
 * Returns everything, sorted into what can be applied and what cannot, because
 * a folder that quietly vanishes from the run is indistinguishable from one
 * that was never there. Each problem carries the reason it was set aside.
 */
export function joinApplications(folders, postings) {
  const byUrl = new Map();
  for (const posting of postings ?? []) {
    if (posting && posting.url) byUrl.set(canonicalUrl(posting.url), posting);
  }

  const ready = [];
  const problems = [];

  for (const folder of folders) {
    const resume = pick(folder.files, RESUME);
    const letter = pick(folder.files, COVER_LETTER);
    const postingFile = pick(folder.files, POSTING);

    if (!resume) {
      problems.push({ folder: folder.name, reason: "no resume in the folder" });
      continue;
    }
    if (!postingFile) {
      problems.push({ folder: folder.name, reason: "no Posting.txt, so the job it belongs to is unknown" });
      continue;
    }

    ready.push({ folder, resume, letter, postingFile, byUrl });
  }

  return { pending: ready, problems, byUrl };
}

/**
 * Finishes the join once the Posting.txt files have been read.
 *
 * Split from joinApplications because reading a file is asynchronous and the
 * matching itself is not; keeping the decisions synchronous is what lets them
 * be tested without a File implementation.
 */
export function resolveApplication(entry, postingText) {
  const { folder, resume, letter } = entry;
  const url = postingUrlFrom(postingText);

  if (!url) {
    return { ok: false, folder: folder.name, reason: "Posting.txt holds no link" };
  }

  const posting = entry.byUrl.get(canonicalUrl(url));
  if (!posting) {
    return {
      ok: false,
      folder: folder.name,
      url,
      reason: "no posting in the exported JSON matches this link - export again after capturing it",
    };
  }
  if (!posting.applyUrl) {
    return { ok: false, folder: folder.name, url, reason: "the posting carries no apply link" };
  }

  const board = applyHost(posting.applyUrl);
  if (board !== "greenhouse") {
    return { ok: false, folder: folder.name, url, board, reason: `applies through ${board}, which this bot does not fill` };
  }

  return {
    ok: true,
    id: posting.id ?? canonicalUrl(url),
    folder: folder.name,
    company: posting.company ?? "",
    title: posting.title ?? "",
    url,
    applyUrl: posting.applyUrl,
    jd: posting.jd ?? "",
    resume,
    letter,
  };
}

/** Counts for the options page, so an empty run explains itself before it starts. */
export function summarise(applications, problems) {
  const byReason = new Map();
  for (const problem of problems) {
    const key = problem.board ? `applies through ${problem.board}` : problem.reason;
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  return {
    ready: applications.length,
    skipped: problems.length,
    reasons: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}
