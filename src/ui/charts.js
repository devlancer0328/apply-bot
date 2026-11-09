/**
 * Small inline-SVG charts for the run monitor.
 *
 * Drawn as markup rather than with a charting library because this page
 * runs under an extension content security policy: there is no CDN to pull
 * from and no inline script to run, so anything that needs a canvas and a
 * bundle is out. Everything here returns a string, which is what the rest
 * of the UI is made of, and redraws on the monitor's two-second poll
 * without any teardown.
 *
 * The rule each chart follows is that an empty series says so in words
 * instead of drawing an empty frame. A ring with nothing in it looks like
 * a broken widget; "nothing applied for yet" looks like Tuesday morning.
 */

import { h } from "./helpers.js";

// Colour carries meaning across every chart on the page, so it is defined
// once: sent is the accent, waiting is amber, lost is red, and anything
// the run merely passed over is grey and recedes.
export const TONE = {
  sent: "#4d49d9",
  working: "#5b8def",
  holding: "#e8a33d",
  failed: "#d4564f",
  skipped: "#b8bfcd",
  spare: "#2eab80",
};

const sum = (rows) => rows.reduce((total, row) => total + (Number(row.value) || 0), 0);
const empty = (message) => `<p class="muted chart-empty">${h(message)}</p>`;

/**
 * A ring with the headline number in the middle.
 *
 * Built from one circle per slice with a dash offset rather than arc paths,
 * which keeps the maths to a single circumference and cannot produce the
 * malformed arc a 100%-of-one-category day otherwise gives.
 */
export function donut(rows = [], { total = null, caption = "", hole = 0.64, size = 168 } = {}) {
  const data = rows.filter((row) => Number(row.value) > 0);
  if (!data.length) return empty("Nothing to chart yet.");

  const whole = sum(data);
  // A stroke straddles its circle, half of it outside the radius, so the
  // radius is the ring's centreline and not its edge. Sized as an edge,
  // the band spilled 16px past the viewBox on every side and the square
  // clipped the ring into an octagon.
  const outer = size / 2 - 2;
  const width = outer * (1 - hole);
  const radius = outer - width / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const slices = data.map((row) => {
    const length = (row.value / whole) * circumference;
    const segment = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${row.color || TONE.sent}" stroke-width="${width}"
      stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${h(row.label)}: ${row.value}</title></circle>`;
    offset += length;
    return segment;
  }).join("");

  const headline = total === null ? whole : total;
  return `<div class="chart-donut">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${h(caption || "Breakdown")}">
      ${slices}
      <text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" class="donut-value">${h(String(headline))}</text>
      <text x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" class="donut-label">${h(caption)}</text>
    </svg>
    <ul class="chart-key">${data.map((row) => `<li><i style="background:${row.color || TONE.sent}"></i><span>${h(row.label)}</span><strong>${row.value}</strong></li>`).join("")}</ul>
  </div>`;
}

/**
 * Horizontal bars, longest first, for anything with a name and a count.
 *
 * Horizontal because every series here is labelled with a sentence - a park
 * reason, an employer, a board - and vertical bars would turn those into
 * rotated text nobody reads.
 */
export function bars(rows = [], { max = null, tone = TONE.sent, limit = 8, unit = "" } = {}) {
  const data = rows.filter((row) => Number(row.value) > 0).slice(0, limit);
  if (!data.length) return empty("Nothing recorded yet.");
  const ceiling = max ?? Math.max(...data.map((row) => row.value));
  return `<ul class="chart-bars">${data.map((row) => `<li>
    <span class="bar-label" title="${h(row.label)}">${h(row.label)}</span>
    <span class="bar-track"><i style="width:${Math.max(2, (row.value / ceiling) * 100)}%;background:${row.color || tone}"></i></span>
    <strong>${row.value}${h(unit)}</strong>
  </li>`).join("")}</ul>`;
}

/**
 * The pipeline, stage by stage, with the drop between each one named.
 *
 * This is the chart that answers "where does the day go", and the falloff
 * matters more than the totals: 964 links becoming 20 attempts is the whole
 * story of a night, and it is invisible in a list of counters.
 */
export function funnel(stages = []) {
  const data = stages.filter((stage) => Number.isFinite(Number(stage.value)));
  if (data.length < 2) return empty("The pipeline fills in once a run starts.");
  const top = Math.max(1, ...data.map((stage) => stage.value));
  return `<ul class="chart-funnel">${data.map((stage, index) => {
    const previous = index ? data[index - 1].value : null;
    // A tenth of a percent is the normal shape of a night - twenty
    // attempts out of nine thousand links - and rounding that to "0%"
    // reads as nothing having happened at all.
    const share = previous > 0 ? (stage.value / previous) * 100 : 0;
    const kept = previous === null ? null : share >= 10 || share === 0 ? Math.round(share) : Number(share.toPrecision(2));
    return `<li>
      <span class="funnel-label">${h(stage.label)}</span>
      <span class="funnel-track"><i style="width:${Math.max(2, (stage.value / top) * 100)}%;background:${stage.color || TONE.sent}"></i></span>
      <strong>${stage.value}</strong>
      <em>${kept === null ? "" : `${kept}% of the step above`}</em>
    </li>`;
  }).join("")}</ul>`;
}

/** A target bar: how much of today's goal is done, and whether the pace holds it. */
export function target({ done = 0, goal = 0, projected = null, onTrack = true } = {}) {
  if (!goal) return empty("No daily target is set.");
  const pct = Math.min(100, Math.round((done / goal) * 100));
  const forecast = projected === null ? null : Math.min(100, Math.round((projected / goal) * 100));
  return `<div class="chart-target">
    <div class="target-track">
      ${forecast !== null && forecast > pct ? `<i class="target-forecast" style="width:${forecast}%"></i>` : ""}
      <i class="target-done" style="width:${pct}%;background:${onTrack ? TONE.sent : TONE.holding}"></i>
    </div>
    <div class="target-legend"><span><strong>${done}</strong> of ${goal} sent · ${pct}%</span>${projected === null ? "" : `<span class="${onTrack ? "" : "off-track"}">pace ends the day near <strong>${projected}</strong></span>`}</div>
  </div>`;
}
