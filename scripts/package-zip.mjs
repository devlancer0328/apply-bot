/**
 * The zip Chrome actually loads.
 *
 * Packing the whole directory would ship node_modules, the test suites,
 * the live-run scratch in test-results and the probe files left behind by
 * debugging - tens of megabytes of things no browser reads, and a few,
 * like a database dump of real applications, that should never leave this
 * machine. So this names what goes in rather than what stays out: the
 * manifest, and the source tree the manifest points at.
 *
 * Every path the manifest names is checked to exist before anything is
 * written, because a zip missing its service worker still installs and
 * then fails at the first click, which is a much worse way to find out.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const root = process.cwd();
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const out = `dist/apply-bot-${manifest.version}.zip`;

// Only files a browser loads. Anything else in src/ - a stray note, an
// editor backup - is left behind rather than shipped by accident.
const SHIPPED = new Set([".js", ".mjs", ".html", ".css", ".json", ".wasm", ".png", ".svg", ".woff2", ".txt"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(here);
    else if (SHIPPED.has(path.extname(entry.name).toLowerCase())) yield here;
  }
}

const files = ["manifest.json"];
for await (const file of walk("src")) files.push(file);

// The manifest is a promise about what is in the package; check it before
// making the package rather than after installing it.
const promised = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
].filter(Boolean);

const missing = [];
for (const file of promised) if (!(await stat(path.join(root, file)).catch(() => null))) missing.push(file);
if (missing.length) {
  console.error(`manifest.json names ${missing.length} file(s) that are not here: ${missing.join(", ")}`);
  process.exit(1);
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await run("zip", ["-q", "-X", "-9", out, ...files], { cwd: root, maxBuffer: 64 * 1024 * 1024 });

const { size } = await stat(out);
console.log(`${out}  ${(size / 1e6).toFixed(1)} MB  ${files.length} files`);
console.log(`${manifest.name} ${manifest.version}`);
console.log(`checked: ${promised.length} manifest path(s) all present`);
