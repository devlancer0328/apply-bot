/**
 * Why the carried session lands on the account chooser.
 *
 * The cookie jar has every name that matters - SID, LSID, the 1P/3P pair,
 * Gmail's own OSID and GMAIL_AT - and Google still refuses it. This tries
 * the four explanations that are worth separating before giving up on the
 * approach, in one browser, so the comparison is like for like:
 *
 *   base     - does the session work anywhere at all, or nowhere?
 *   u/0, u/1 - Profile 41 has two addresses on it, and Daniel may not be
 *              the zeroth. The chooser appears for an index nobody is
 *              signed in at.
 *   no-ts    - `__Secure-1PSIDTS`/`__Secure-3PSIDTS` are rotated by Google
 *              every few minutes. The user's own Chrome is still running
 *              and still rotating them, so the pair we lifted is stale the
 *              moment it is read, and a stale pair is downgraded rather
 *              than ignored. Dropping them lets Google re-mint.
 *
 * Read-only throughout. Nothing is typed, clicked or sent.
 */

import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchPath, releaseScratch } from "./scratch.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
await mkdir("test-results", { recursive: true });

const jar = JSON.parse(await readFile(process.env.COOKIES ?? "test-results/profile41-cookies.json", "utf8"));
const ROTATED = /^__Secure-[13]PSIDTS$/;

const look = async (context, url) => {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(8000);
  const read = await page.evaluate(() => ({
    url: location.href,
    chooser: /accounts\.google\.com/.test(location.href),
    rows: document.querySelectorAll("tr.zA").length,
    addresses: [...new Set(document.documentElement.innerHTML.match(/[\w.+-]+@gmail\.com/g) ?? [])].slice(0, 4),
    text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 140),
  }));
  await page.close();
  return read;
};

const report = {};

for (const variant of ["all-cookies", "without-rotated-ts"]) {
  const cookies = variant === "all-cookies" ? jar : jar.filter((cookie) => !ROTATED.test(cookie.name));
  const profilePath = scratchPath(`probe-${variant}`);
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    args: ["--no-proxy-server"],
  });
  await context.addCookies(cookies);

  report[variant] = {
    cookies: cookies.length,
    base: await look(context, "https://myaccount.google.com/"),
    u0: await look(context, "https://mail.google.com/mail/u/0/#inbox"),
    u1: await look(context, "https://mail.google.com/mail/u/1/#inbox"),
    byAddress: await look(context, "https://mail.google.com/mail/u/danieltorres3274@gmail.com/#inbox"),
  };
  await context.close();
  await releaseScratch(profilePath);

  console.log(`\n=== ${variant} (${cookies.length} cookies) ===`);
  for (const [name, read] of Object.entries(report[variant])) {
    if (name === "cookies") continue;
    console.log(`${name.padEnd(10)} chooser=${String(read.chooser).padEnd(5)} rows=${String(read.rows).padEnd(4)} ${read.addresses.join(",") || "-"}`);
    console.log(`           ${read.text.slice(0, 110)}`);
  }
}

await writeFile("test-results/gmail-session-probe.json", JSON.stringify(report, null, 2));
console.log("\nFull results: test-results/gmail-session-probe.json");
