/**
 * What the model is being asked, counted as it happens.
 *
 * Every reply goes through here on its way back, so the log can say after
 * each resume, letter and page of questions how many it took, and the run
 * can be totalled at the end. With ChatGPT in a tab there are no tokens and
 * no bill, so the count is of replies; the price table is kept for a
 * transport that reports tokens, where the figure is an estimate rather
 * than an invoice.
 */

/** [prefix, input, output, cached input] in dollars per million tokens. */
const PRICES = [
  ["claude-opus-4", 5, 25, 0.5],
  ["claude-sonnet-4", 3, 15, 0.3],
  ["claude-haiku-4", 1, 5, 0.1],
  ["claude-3-7-sonnet", 3, 15, 0.3],
  ["claude-3-5-haiku", 0.8, 4, 0.08],
  ["gpt-5-mini", 0.25, 2, 0.025],
  ["gpt-5-nano", 0.05, 0.4, 0.005],
  ["gpt-5", 1.25, 10, 0.125],
  ["gpt-4.1-mini", 0.4, 1.6, 0.1],
  ["gpt-4.1-nano", 0.1, 0.4, 0.025],
  ["gpt-4.1", 2, 8, 0.5],
  ["gpt-4o-mini", 0.15, 0.6, 0.075],
  ["gpt-4o", 2.5, 10, 1.25],
  ["o4-mini", 1.1, 4.4, 0.275],
  ["o3", 2, 8, 0.5],
  ["gemini-2.5-pro", 1.25, 10, 0.31],
  ["gemini-2.5-flash-lite", 0.1, 0.4, 0.025],
  ["gemini-2.5-flash", 0.3, 2.5, 0.075],
  ["gemini-2.0-flash", 0.1, 0.4, 0.025],
];

function priceOf(model) {
  const name = String(model ?? "").toLowerCase().replace(/^models\//, "");
  return PRICES.find(([prefix]) => name.startsWith(prefix)) ?? null;
}

/** Dollars for one call's tokens, or null for a model the table does not know. */
export function costOf(model, { inputTokens = 0, outputTokens = 0, cachedTokens = 0 } = {}) {
  const price = priceOf(model);
  if (!price) return null;
  const [, input, output, cached] = price;
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (fresh * input + cachedTokens * cached + outputTokens * output) / 1_000_000;
}

const empty = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, dollars: 0, priced: true });

let run = empty();

function add(bucket, model, usage) {
  bucket.calls += usage.calls ?? 1;
  bucket.inputTokens += usage.inputTokens ?? 0;
  bucket.outputTokens += usage.outputTokens ?? 0;
  bucket.cachedTokens += usage.cachedTokens ?? 0;
  const dollars = costOf(model, usage);
  if (dollars === null) bucket.priced = false;
  else bucket.dollars += dollars;
}

/**
 * Counts one piece of work - a resume, a letter, a page of answers - that
 * may have been several calls. Returns the words for the log.
 */
export function record(model, usage) {
  const tally = { calls: usage.calls ?? 1, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cachedTokens: usage.cachedTokens ?? 0 };
  add(run, model, tally);
  return describe(model, tally);
}

export function runTotal() {
  return { ...run };
}

export function resetRun() {
  run = empty();
}

const n = (value) => Math.round(value).toLocaleString("en-US");

/**
 * "2 calls, 9,120 tokens in (6,800 cached), 4,300 out, ≈ $0.08" - or, for
 * the ChatGPT tab, which reports no tokens and bills nothing, "2 replies".
 */
export function describe(model, usage) {
  const calls = usage.calls ?? 1;
  // A reused resume or letter is counted as the zero calls it was, and
  // said in words, because "0 replies from ChatGPT" in the log reads like
  // a failure rather than like the two minutes that were not spent.
  if (calls === 0) return "reused; no ChatGPT reply needed";
  if (!(usage.inputTokens > 0) && !(usage.outputTokens > 0)) return `${calls} ${calls === 1 ? "reply" : "replies"} from ChatGPT`;
  const parts = [`${calls} call${calls === 1 ? "" : "s"}`, `${n(usage.inputTokens ?? 0)} tokens in${usage.cachedTokens > 0 ? ` (${n(usage.cachedTokens)} cached)` : ""}`, `${n(usage.outputTokens ?? 0)} out`];
  const dollars = usage.dollars !== undefined ? (usage.priced ? usage.dollars : null) : costOf(model, usage);
  if (dollars !== null && dollars !== undefined) parts.push(`≈ $${dollars < 0.1 ? dollars.toFixed(3) : dollars.toFixed(2)}`);
  return parts.join(", ");
}
