/**
 * Whether taking the pacing gaps off cost anything.
 *
 * The 45-second gap between two applications to one board was the only
 * thing standing between this and a board deciding the traffic is
 * automated. Removing it is a bet that one application per employer is
 * unremarkable enough on its own; this is how the bet gets settled with
 * evidence rather than by waiting to notice.
 *
 * A block does not announce itself as a block. It arrives as the same
 * board failing attempt after attempt, or as captcha challenges appearing
 * where they did not before - so those two, per board, are what is
 * counted. A board that fails once is weather. A board that fails three
 * times running has stopped accepting this traffic, and every remaining
 * application there will be wasted until it is left alone.
 *
 * Read-only, like watch-run. Checking cannot become part of what is
 * being measured.
 */

import { chromium } from "playwright";
import { appendFile, mkdir } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const EXT_ID = process.env.EXT_ID ?? "cmndpkaonfgknkjeijmhhiiodmjmekpn";
const EVERY = Number(process.env.EVERY ?? 90000);
const LOG = "test-results/board-watch.log";

await mkdir("test-results", { recursive: true });

const stamp = () => new Date().toLocaleTimeString();
const say = async (line) => {
  console.log(line);
  await appendFile(LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {});
};

// Counted since the gaps came off, not since the day started, so an
// earlier captcha from a paced hour cannot be read as evidence against
// the change.
const baseline = { captcha: 0, failed: 0 };
let primed = false;
let streak = new Map();
// Duplicate counts already reported, so a known one is not re-announced.
const seenDupes = new Map();

const challenged = /captcha|challenge|blocked|rate.?limit|too many|forbidden|403|429|unusual traffic|verify you are human/i;

// A result records where it was sent, not which board sent it, so the
// board is read back off the apply URL the way the adapters recognise it.
const BOARDS = [[/ashbyhq\.com/i, "ashby"], [/greenhouse\.io/i, "greenhouse"], [/lever\.co/i, "lever"],
  [/myworkdayjobs\.com|workday/i, "workday"], [/rippling(ats)?\.com/i, "rippling"],
  [/workable\.com/i, "workable"], [/applytojob\.com|jazz\.co/i, "applytojob"]];
const boardOf = (row) => {
  const url = `${row.applyUrl ?? ""} ${row.sourceUrl ?? ""}`;
  return BOARDS.find(([pattern]) => pattern.test(url))?.[1] ?? "other";
};

async function read(browser) {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${EXT_ID}/src/options.html`, { waitUntil: "domcontentloaded" });
    return await page.evaluate(async () => {
      const state = await chrome.runtime.sendMessage({ type: "state" });
      const db = await chrome.runtime.sendMessage({ type: "database", request: { action: "list", table: "results" } });
      return { run: state?.run ?? state, results: db?.value ?? [] };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await chromium.connectOverCDP(ATTACH);
await say(`watching every ${EVERY / 1000}s · board gaps are off · alerting on repeated failures or new captchas`);

for (;;) {
  try {
    const { run, results } = await read(browser);
    const day = run?.day ?? {};

    // Per board: how many of its attempts ended badly, and how many of
    // those were the board asking for proof of a human.
    const board = new Map();
    for (const row of results) {
      const name = boardOf(row);
      const row_ = board.get(name) ?? { total: 0, bad: 0, captcha: 0 };
      row_.total += 1;
      const text = `${row.stage ?? ""} ${row.status ?? ""} ${row.reason ?? ""} ${row.detail?.message ?? ""}`;
      if (/fail|error|manual|abandon/i.test(text)) row_.bad += 1;
      if (challenged.test(text) || row.detail?.captcha) row_.captcha += 1;
      board.set(name, row_);
    }

    const captcha = [...board.values()].reduce((n, b) => n + b.captcha, 0);
    const failed = day.failed ?? 0;
    if (!primed) { baseline.captcha = captcha; baseline.failed = failed; primed = true; }

    const shape = [...board.entries()].sort((a, b) => b[1].total - a[1].total)
      .map(([name, b]) => `${name} ${b.total}·${b.bad}bad${b.captcha ? `·${b.captcha}cap` : ""}`).join("  ") || "no attempts yet";
    await say(`${stamp()} ${day.submitted ?? 0} sent / ${day.attempted ?? 0} tried / ${day.discovered ?? 0} found · ${shape}`);

    // Three bad attempts in a row on one board is the shape of a block.
    for (const [name, b] of board) {
      const was = streak.get(name) ?? 0;
      streak.set(name, b.bad);
      if (b.bad >= 3 && b.bad > was) await say(`ALERT board trouble: ${name} has ${b.bad} failed attempt(s) of ${b.total}. Putting the board gap back is the remedy.`);
    }
    // One application per employer per day is the rule now, and the gate
    // that enforces it is built when a run starts - so a limit changed
    // mid-run is not in force until the next one. That is how Substack
    // received a second application six minutes after the rule came in,
    // and it is worth being told rather than found later in the table.
    const perEmployer = new Map();
    for (const row of results) {
      if (!/submit/i.test(`${row.status ?? ""}`)) continue;
      const name = (row.company ?? "").trim().toLowerCase();
      if (name) perEmployer.set(name, (perEmployer.get(name) ?? 0) + 1);
    }
    // Only a count that has grown since the last look is news. Saying the
    // same duplicate every ninety seconds trained the reader to skim the
    // word ALERT, which is the one thing this must not do.
    const repeated = [...perEmployer].filter(([name, n]) => n > 1 && n > (seenDupes.get(name) ?? 1));
    for (const [name, n] of perEmployer) seenDupes.set(name, Math.max(seenDupes.get(name) ?? 0, n));
    if (repeated.length) await say(`ALERT duplicate employer: ${repeated.map(([name, n]) => `${name} x${n}`).join(", ")}. One per employer per day is the rule; a run started before the rule changed does not enforce it.`);

    if (captcha > baseline.captcha) {
      await say(`ALERT new captcha: ${captcha - baseline.captcha} challenge(s) since the gaps came off. That is the signal the pacing was buying.`);
      baseline.captcha = captcha;
    }
    if (run && !run.running) await say(`${stamp()} run is not running (${run.stopReason?.message ?? "idle"})`);
  } catch (error) {
    await say(`${stamp()} could not read the run: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, EVERY));
}
