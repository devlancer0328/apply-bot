/**
 * The workspace as Chrome's side panel, and whether it still fits.
 *
 * The panel runs src/options.html at about 350px - the same document, the
 * same router, the same monitor dashboard - so there is no second UI to
 * keep in step. What there is instead is a width nothing was drawn for,
 * and three ways to lose the panel outright: a manifest that names a file
 * that is not there, an action that still declares a popup (Chrome lets
 * the popup win the click and openPanelOnActionClick is quietly ignored,
 * so the toolbar button appears to do nothing), and a fixed 232px rail
 * sitting in a 350px frame.
 *
 * The layout half reads workspace.css rather than a browser, because the
 * question asked here - which declaration wins at this width - is a
 * question about the file. Whether it looks right is a question for
 * scripts/panel-shots.mjs, which photographs it.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("manifest.json").replace(/^\uFEFF/, ""));
const css = read("src/workspace.css");

let count = 0;
const test = (name, work) => { work(); count++; console.log(`  PASS  ${name}`); };

/* ----------------------------------------------------------- the wiring */

test("the panel is declared, and the file it names is on disk", () => {
  assert.ok(manifest.permissions.includes("sidePanel"), "the sidePanel permission is missing");
  const path = manifest.side_panel?.default_path;
  assert.ok(path, "no side_panel.default_path");
  assert.ok(existsSync(join(root, path)), `side_panel.default_path points at ${path}, which does not exist`);
});

test("every file the manifest names exists", () => {
  // A manifest naming a file that was renamed loads as a broken extension
  // with no error anyone sees until the surface is opened.
  const paths = [];
  const walk = (value) => {
    if (typeof value === "string") { if (/^[\w./-]+\.(?:html|js|css|json|png|svg)$/.test(value)) paths.push(value); return; }
    if (value && typeof value === "object") for (const child of Object.values(value)) walk(child);
  };
  walk(manifest);
  assert.ok(paths.length >= 3, `only found ${paths.length} asset paths in the manifest`);
  for (const path of paths) assert.ok(existsSync(join(root, path)), `the manifest names ${path}, which does not exist`);
});

test("the action declares no popup, which is the only way the panel gets the click", () => {
  // Chrome ignores openPanelOnActionClick while default_popup is set. The
  // popup and the panel cannot both own the toolbar button, and the panel
  // shows the whole workspace the popup only summarised.
  assert.equal(manifest.action.default_popup, undefined, "default_popup would win the toolbar click and the panel would never open");
  assert.equal(manifest.options_page, "src/options.html", "the full-tab workspace is still reachable from the extensions menu");
});

test("the worker asks for the toolbar button to open the panel", () => {
  // background.js cannot be imported - it reaches `chrome` at the top
  // level - so the seam is asserted by source, as health.mjs does.
  const source = read("src/background.js");
  assert.match(source, /chrome\.sidePanel\.setPanelBehavior\(\{\s*openPanelOnActionClick:\s*true\s*\}\)/);
});

test("the panel knows it is a panel, and offers a way out to a full tab", () => {
  // A side panel is not a tab, which is the only thing telling the two
  // apart from inside a document they both load.
  const page = read("src/options.html"), script = read("src/options.js");
  assert.match(page, /id="open-workspace"/, "the panel has no control for reopening a route in a tab");
  assert.match(script, /chrome\.tabs\.getCurrent\(\)/);
  assert.match(script, /dataset\.surface\s*=\s*'panel'/);
  // Following the anchor would navigate the panel itself, which is the
  // opposite of what it says it does.
  assert.match(script, /fullTab\.addEventListener\('click',event\s*=>\s*\{\s*event\.preventDefault\(\);\s*chrome\.tabs\.create/);
  assert.match(script, /fullTab\.href\s*=\s*chrome\.runtime\.getURL\(`src\/options\.html\$\{currentHash\}`\)/, "the way out drops the route it was opened from");
});

/* ---------------------------------------------------------- the layout */

/**
 * The declarations that survive at one viewport width, in source order.
 *
 * Specificity is not modelled: every assertion below names a selector
 * exactly as the file writes it, so the last one to set a property wins,
 * which is what the cascade does for identical selectors anyway.
 */
function declarations(width) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  const collect = (text) => { for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) found.push({ selector: rule[1].trim(), body: rule[2] }); };
  let at = 0;
  while (at < clean.length) {
    const start = clean.indexOf("@media", at);
    if (start === -1) { collect(clean.slice(at)); break; }
    collect(clean.slice(at, start));
    const open = clean.indexOf("{", start);
    let depth = 1, index = open + 1;
    while (depth > 0 && index < clean.length) { if (clean[index] === "{") depth++; else if (clean[index] === "}") depth--; index++; }
    const query = clean.slice(start, open);
    const max = /max-width:\s*(\d+)px/.exec(query), min = /min-width:\s*(\d+)px/.exec(query);
    if ((!max || width <= Number(max[1])) && (!min || width >= Number(min[1]))) collect(clean.slice(open + 1, index - 1));
    at = index;
  }
  return found;
}

function value(selector, property, width) {
  let winner = null;
  for (const rule of declarations(width)) {
    if (!rule.selector.split(",").some((part) => part.trim() === selector)) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0 && declaration.slice(0, colon).trim() === property) winner = declaration.slice(colon + 1).trim();
    }
  }
  return winner;
}

/** How many tracks a grid-template-columns value actually lays out. */
const columns = (track) => {
  assert.ok(track, "this grid sets no column track at this width");
  const repeated = /^repeat\((\d+)\s*,/.exec(track);
  return repeated ? Number(repeated[1]) : track.trim().split(/\s+(?![^(]*\))/).length;
};

const PANEL = 350;

test("the 232px rail does not survive a 350px frame", () => {
  assert.equal(value(".sidebar", "position", 1440), "fixed");
  assert.equal(value(".sidebar", "width", 1440), "232px");
  assert.equal(value(".sidebar", "position", PANEL), "relative");
  assert.equal(value(".sidebar", "width", PANEL), "100%");
  assert.equal(value("main", "margin", PANEL), "0", "content still sits behind where the rail used to be");
});

test("every multi-column grid collapses at panel width", () => {
  for (const selector of [".cols", ".fields", ".resume-grid"]) {
    assert.equal(columns(value(selector, "grid-template-columns", PANEL)), 1, `${selector} is still multi-column at ${PANEL}px`);
  }
  // Two stat cards still read at 350px and six do not; the point is that
  // the number is not the desktop number.
  assert.ok(columns(value(".stats", "grid-template-columns", PANEL)) <= 2);
  assert.ok(columns(value(".dash-stats", "grid-template-columns", PANEL)) <= 2);
  assert.equal(value(".editor-layout", "display", PANEL), "block", "the two-pane editor still tries for two panes");
});

test("the dashboard charts are given room rather than squeezed", () => {
  // A 90px label column and a 1.6fr bar leave the bar a sliver at 350px,
  // and the reason - which is a whole sentence - an ellipsis. The label
  // takes its own row instead, so both survive.
  assert.equal(columns(value(".chart-bars li", "grid-template-columns", PANEL)), 2);
  assert.equal(value(".bar-label", "grid-column", PANEL), "1/-1");
  assert.ok(columns(value(".chart-funnel li", "grid-template-columns", PANEL)) === 3);
  assert.match(value(".chart-funnel li", "grid-template-columns", PANEL), /minmax\((\d+)px/);
  assert.ok(Number(/minmax\((\d+)px/.exec(value(".chart-funnel li", "grid-template-columns", PANEL))[1]) < 110, "the funnel label still claims a desktop column");
});

test("nothing unbreakable can push the panel sideways", () => {
  // Jobs with no company are listed by their URL, and a 326px URL in a
  // 345px frame is how the monitor got a horizontal scrollbar.
  assert.equal(value("#content", "overflow-wrap", PANEL), "anywhere");
  assert.equal(value("#content", "overflow-wrap", 1440), null, "the wide workspace does not need to break words mid-URL");
});

test("the toast fits a panel instead of hanging off the side of it", () => {
  assert.equal(value("#notice", "max-width", 1440), "430px");
  assert.equal(value("#notice", "max-width", PANEL), "none");
  assert.equal(value("#notice", "left", PANEL), "12px");
});

test("panel-only chrome is keyed on the panel, not on a width", () => {
  // Chrome draws its own header above the panel, so the brand and
  // breadcrumb repeat it - but a workspace tab dragged narrow has no such
  // header, and hiding them there would leave it unlabelled. These rules
  // sit outside every media block for that reason.
  for (const width of [PANEL, 500, 1440]) {
    assert.equal(value("body[data-surface=panel] .topbar", "position", width), "sticky");
    assert.equal(value("body[data-surface=panel] .brand", "display", width), "none");
  }
});

test("the full-tab workspace keeps the layout it had", () => {
  // Everything above is a narrow-width addition. A desktop regression here
  // would mean the panel was bought with the workspace.
  assert.equal(value("main", "margin-left", 1440), "232px");
  assert.equal(columns(value(".stats", "grid-template-columns", 1440)), 4);
  assert.equal(columns(value(".dash-stats", "grid-template-columns", 1440)), 6);
  assert.equal(columns(value(".cols", "grid-template-columns", 1440)), 2);
  assert.equal(columns(value(".editor-layout", "grid-template-columns", 1440)), 2);
});

console.log(`${count} side panel checks passed.`);
