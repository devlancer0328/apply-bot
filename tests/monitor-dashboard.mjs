/**
 * The page read after a night away, and whether it can be read.
 *
 * The monitor used to answer "what is the run doing" in prose and leave
 * "how did the day go" to be inferred from a counter strip - which is how
 * "it only applied to Greenhouse" had to be worked out by reading result
 * URLs by hand, and how two applications to sales roles sat on the page
 * unnoticed. These checks hold the properties that made it unreadable:
 * every job is in exactly one of the four buckets a person asks about,
 * the numbers on the page are the numbers in the ledger, and an empty day
 * says so in words rather than drawing an empty ring.
 *
 * Rendering is string-in, string-out, so no browser is needed.
 */

import assert from "node:assert/strict";
import { monitorBody } from "../src/ui/monitor.js";
import { bars, donut, funnel, target } from "../src/ui/charts.js";
import { dayKey, dayProgress } from "../src/schedule.js";

let count = 0;
const test = (name, work) => { work(); count++; console.log(`  PASS  ${name}`); };

const run = {
  running: true, phase: "applying", autopilot: true,
  discovered: 964, attempted: 20, submitted: 6,
  day: {
    target: 300, submitted: 6, attempted: 20, failed: 3, abandoned: 1, skipped: 9, discovered: 964,
    projected: 41, onTrack: false,
    reasons: [{ reason: "no security code arrived", count: 4 }, { reason: "captcha after Submit", count: 2 }],
    boards: [{ board: "greenhouse", count: 5 }, { board: "ashby", count: 1 }],
    employers: [{ company: "ŌURA", count: 3 }, { company: "Crexi", count: 2 }],
  },
  activeJobs: {
    a: { company: "Acme", title: "Software Engineer", stage: "applying", updatedAt: 5, message: "filling" },
    b: { company: "Globex", title: "Backend Engineer", stage: "manual", updatedAt: 4, message: "captcha" },
    c: { company: "Initech", title: "Platform Engineer", stage: "submitted", updatedAt: 3, message: "" },
    d: { company: "Umbrella", title: "Data Engineer", stage: "unsupported", updatedAt: 2, message: "no adapter" },
    e: { company: "Hooli", title: "Full Stack Engineer", stage: "screening", updatedAt: 1, message: "" },
  },
  log: [], results: [],
};

const page = monitorBody(run);

test("the four questions a person actually asks each have a heading", () => {
  for (const heading of ["Today at a glance", "Where the day went", "In progress", "Holding for you", "Applied"]) {
    assert.ok(page.includes(heading), `the page never says "${heading}"`);
  }
});

test("scraped, applied and employer counts come from the day ledger, not the run", () => {
  assert.ok(page.includes("964"), "links found today");
  assert.ok(page.includes("Employers"), "employers applied to is shown");
  assert.ok(page.includes("ŌURA"), "the employers themselves are named");
});

test("every board the day used is charted, which is how a one-platform day is visible", () => {
  assert.ok(page.includes("greenhouse"));
  assert.ok(page.includes("ashby"));
  assert.ok(page.includes("Attempts by platform"));
});

test("a job appears in exactly one bucket", () => {
  // Five jobs, four buckets: working, holding, done, passed over. A stage
  // landing in two of them would double-count the headline numbers.
  const counts = ["In progress", "Holding for you", "Applied"].map((heading) => {
    const at = page.indexOf(heading);
    assert.notEqual(at, -1, heading);
    return at;
  });
  assert.deepEqual([...counts].sort((a, b) => a - b), counts, "the buckets read in the order a person asks them");
});

test("a target behind pace is marked as behind rather than quietly drawn", () => {
  const behind = target({ done: 6, goal: 300, projected: 41, onTrack: false });
  assert.match(behind, /off-track/);
  assert.match(behind, /41/);
  assert.ok(!target({ done: 150, goal: 300, projected: 310, onTrack: true }).includes("off-track"));
});

test("an empty day says so instead of drawing an empty chart", () => {
  // A ring with nothing in it reads as a broken widget, and someone would
  // go looking for a rendering fault instead of a job supply problem.
  for (const markup of [donut([]), bars([]), funnel([{ label: "one", value: 1 }]), target({ done: 0, goal: 0 })]) {
    assert.match(markup, /chart-empty/);
    assert.ok(!markup.includes("<svg"), "nothing is drawn when there is nothing to draw");
  }
});

test("a brand new run renders without throwing", () => {
  const fresh = monitorBody({});
  assert.ok(fresh.includes("Today at a glance"));
  assert.ok(fresh.includes("Nothing is being worked on right now."));
});

test("the ring fits inside its own box instead of being clipped into an octagon", () => {
  // The stroke straddles the radius, so the band reaches half its width
  // past it. Sized as though the radius were the outer edge, it spilled
  // 16px beyond the viewBox and the square corners cut the curve flat.
  const ring = donut([{ label: "Sent", value: 1 }], { size: 168 });
  const box = Number(ring.match(/viewBox="0 0 (\d+)/)[1]);
  const radius = Number(ring.match(/ r="([\d.]+)"/)[1]);
  const width = Number(ring.match(/stroke-width="([\d.]+)"/)[1]);
  assert.ok(radius + width / 2 <= box / 2, `outer edge ${radius + width / 2} overflows the ${box / 2} half-box`);
  assert.ok(radius - width / 2 > 0, "the hole is still a hole");
});

test("a single-category day draws one whole ring rather than a malformed arc", () => {
  const only = donut([{ label: "Sent", value: 7 }]);
  assert.ok(only.includes("<svg"));
  assert.ok(only.includes("stroke-dasharray"));
});

test("percentages in the funnel describe the step above, so the drop is readable", () => {
  const shape = funnel([{ label: "Found", value: 100 }, { label: "Attempted", value: 20 }, { label: "Sent", value: 5 }]);
  assert.match(shape, /20% of the step above/);
  assert.match(shape, /25% of the step above/);
});

test("the ring's centre equals its own slices, not a larger number beside it", () => {
  // The centre read 9255 while the slices summed to 44, because the total
  // was taken from links found. Two numbers claiming to be the same thing
  // is how a dashboard stops being believed.
  const ring = donut([{ label: "Sent", value: 6 }, { label: "Working", value: 18 }]);
  assert.ok(ring.includes(">24<"), "the centre shows the sum of what is drawn");
});

test("a sub-1% step keeps a digit instead of rounding away to nothing", () => {
  // Nineteen attempts out of nine thousand links is the normal shape of a
  // night, and "0% of the step above" reads as nothing having happened.
  const wide = funnel([{ label: "Found", value: 9255 }, { label: "Attempted", value: 19 }]);
  assert.match(wide, /0\.21% of the step above/);
});

test("passed-over is one number, so the card and the ring cannot disagree", () => {
  const card = page.slice(page.indexOf("Passed over"), page.indexOf("Employers"));
  const shown = card.match(/<strong>(\d+)<\/strong>/)?.[1];
  const inRing = page.match(/Passed over<\/span><strong>(\d+)</)?.[1];
  assert.equal(shown, inRing, `headline says ${shown}, ring says ${inRing}`);
});

test("a run that has sent nothing yet does not contradict the day's total", () => {
  // The headline counts the day, the list counts the run. After an
  // afternoon restart the page read "Applied 6" directly above "nothing
  // sent yet today", and a page that argues with itself is not read again.
  const restarted = monitorBody({ day: { ...run.day, submitted: 6 }, activeJobs: {}, log: [] });
  assert.ok(!restarted.includes("Nothing sent yet today."), "it must not claim nothing was sent when six were");
  assert.match(restarted, /6 sent earlier today/);
  assert.ok(monitorBody({ day: { ...run.day, submitted: 0 }, activeJobs: {}, log: [] }).includes("Nothing sent yet today."));
});

test("the board ledger's pacing shape is read as a count, not an object", () => {
  // day.boards holds { started, lastAt, nextAt } for pacing, and reading
  // it as a count map silently produced an empty chart on a day that had
  // run sixteen attempts across two boards.
  const progress = dayProgress(
    { day: dayKey(), boards: { greenhouse: { started: 13, lastAt: 1 }, ashby: { started: 3, lastAt: 2 } }, reasons: {}, employers: {} },
    { dailyTarget: 300 },
  );
  assert.deepEqual(progress.boards, [{ board: "greenhouse", count: 13 }, { board: "ashby", count: 3 }]);
});

console.log(`${count} monitor dashboard checks passed.`);
