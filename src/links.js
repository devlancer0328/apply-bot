/**
 * Turning a list of job links into a queue.
 *
 * The input is whatever the applicant collected while browsing: a column in a
 * Google Sheet, or a block of links pasted into the options page. Both are
 * treated the same way, because the useful property of a link list is that it
 * needs no schema - a cell either holds a URL or it does not.
 *
 * Nothing here touches the DOM, the network or chrome.*, so the parsing is
 * testable off a browser.
 */

import { canonicalUrl } from "./join.js";

/**
 * Rewrites a Google Sheets address into one that returns CSV.
 *
 * Pasting the address from the browser's bar is the thing anyone will actually
 * do, and that address returns an HTML application, not data. The sheet still
 * has to be shared - "anyone with the link" or published - since this fetch
 * carries no Google credentials.
 */
export function sheetCsvUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (!/(^|\.)google\.com$/i.test(parsed.hostname)) return raw;

  // Already a CSV export or a published CSV: leave it alone.
  if (/output=csv|\/export\?/i.test(parsed.search) || /\/pub\b/.test(parsed.pathname)) {
    if (/output=csv/i.test(parsed.search)) return raw;
    parsed.searchParams.set("output", "csv");
    return parsed.href;
  }

  const id = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
  if (!id) return raw;

  // The tab is in the fragment on an edit URL, which is not sent to a server,
  // so it has to be lifted into the query to survive the rewrite.
  const gid = parsed.hash.match(/gid=(\d+)/)?.[1] ?? parsed.searchParams.get("gid") ?? "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

/**
 * Splits CSV into cells, honouring quotes.
 *
 * A job title with a comma in it is common enough that splitting on commas
 * alone would shift every later column, and a shifted column is how a link
 * ends up half-read rather than visibly missing.
 */
export function csvCells(text) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character !== '"') {
        cell += character;
      } else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (character === '"') quoted = true;
    else if (character === "," || character === "\n" || character === "\r") {
      cells.push(cell);
      cell = "";
    } else cell += character;
  }

  cells.push(cell);
  return cells;
}

/**
 * Every link in a block of text, in the order they appear.
 *
 * Deliberately indifferent to where they came from: one per line, several to a
 * line, wrapped in a spreadsheet's quotes, or trailed by a comma. Trailing
 * punctuation is stripped because a link at the end of a sentence collects it.
 */
export function extractLinks(text) {
  const matches = String(text ?? "").match(/https?:\/\/[^\s",<>)]+/gi) ?? [];
  return matches.map((link) => link.replace(/[.,;:]+$/, ""));
}

/**
 * The queue, in order, with repeats removed.
 *
 * Order is kept because the applicant's own ordering is usually priority, and
 * repeats are dropped by canonical form so the same posting pasted twice with
 * a different tracking parameter is still one application.
 */
export function buildQueue(sources) {
  const seen = new Set();
  const queue = [];

  for (const source of sources) {
    for (const link of extractLinks(source)) {
      const key = canonicalUrl(link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      queue.push(link);
    }
  }
  return queue;
}

/**
 * Whether what came back is a page rather than a sheet.
 *
 * A sheet that is not shared does not answer with an error. It answers 200
 * with Google's sign-in page, which parses as CSV perfectly well and yields no
 * links - reporting as "your sheet is empty" when the truth is "nobody can
 * read your sheet", and sending the reader off to check the wrong thing.
 */
export function isSignInPage(text) {
  return /^\s*</.test(String(text ?? ""));
}

/** Links out of a fetched CSV, read cell by cell rather than column by column. */
export function linksFromCsv(csv) {
  return buildQueue(csvCells(String(csv ?? "")));
}
