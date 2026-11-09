// `npm run check` chains its suites with &&, so the first file to throw hides every
// file after it. That is fine for a single developer fixing one thing, but during a long
// unattended run several suites change at once, and one broken assertion can mask real
// regressions in the twenty-odd files that never got to execute. This runner executes
// every suite independently and reports the whole tally, so a known failure never buys
// silence for an unknown one. It never fails the build itself; read the tally.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chain = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.check;
const suites = chain.split("&&").map((part) => part.trim().replace(/^node\s+/, ""));

function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [suite], { cwd: root });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const passed = (output.match(/PASS/g) || []).length;
      resolve({ suite, code, passed, ms: Date.now() - started, output });
    });
  });
}

const results = [];
for (const suite of suites) {
  const result = await run(suite);
  results.push(result);
  const mark = result.code === 0 ? "ok  " : "FAIL";
  console.log(`${mark} ${suite.padEnd(34)} ${String(result.passed).padStart(4)} checks  ${(result.ms / 1000).toFixed(1)}s`);
}

const broken = results.filter((r) => r.code !== 0);
const passed = results.reduce((total, r) => total + r.passed, 0);
console.log(`\n${passed} checks passed across ${results.length - broken.length}/${results.length} suites.`);

// The reason each suite failed matters more than the tally, and the failure is almost
// always the last thing the suite said before it died.
for (const failure of broken) {
  const reason = failure.output.trim().split("\n").filter((line) => !/PASS/.test(line)).slice(-12).join("\n");
  console.log(`\n--- ${failure.suite} (exit ${failure.code}) ---\n${reason}`);
}
