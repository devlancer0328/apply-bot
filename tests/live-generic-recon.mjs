/**
 * The generic adapter's two judgements, against the real pages it would
 * have to drive.
 *
 * `sourceFromLink` in src/background.js refuses any board outside
 * `FILLABLE` before a form is ever opened, so the generic adapter cannot
 * currently be reached from the run loop at all. Lifting that gate is the
 * single largest throughput change available - nine of thirty-one corpus
 * postings are behind it - and it is also irreversible per posting, since
 * what comes through it goes to a real employer. So the gate stays shut
 * until the two things that would make lifting it dangerous have been
 * measured on the actual pages rather than argued about:
 *
 *   - Does `probeForm` recognise a React careers page? Gem renders Helix's
 *     application with zero `<form>` elements and custom "Please select"
 *     menus in place of `<select>`, which is the shape most likely to read
 *     as "not an application" and park a board that is perfectly fillable.
 *   - Does `submitChoices` false-positive? It stops the adapter when a
 *     page offers two differently-worded Submits, on the reasoning that
 *     one of them is wrong. A sticky "Apply" header sitting above a
 *     "Submit application" button is two wordings and one meaning, and if
 *     real pages are built that way the rule parks entire boards for a
 *     reason that is not real.
 *
 * Both functions are imported from the adapter rather than restated here,
 * so this measures the shipping code. Nothing is filled and nothing is
 * pressed: every posting is opened, read and closed.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { probeForm } from "../src/apply/adapters/generic.js";
import { submitChoices } from "../src/apply/form-ops.js";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);
const only = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;

/**
 * The unserved corpus postings, by the board each one is really served by.
 *
 * URLS overrides the list with its own `[company, board, url]` triples,
 * which is how the second stage is run: `reach` resolves most of these to
 * a form one link on, and the probe's verdict on the posting says nothing
 * about its verdict on the form that actually gets filled.
 */
const POSTINGS = process.env.URLS ? JSON.parse(process.env.URLS) : [
  ["EPAM", "epam", "https://careers.epam.com/en/vacancy/python-ai-engineer-bltc0n28xcft79j2cx1_en"],
  ["SteadyIQ", "odoo", "https://steadyiq.odoo.com/jobs/senior-software-engineer-4"],
  ["Mindrift", "workable", "https://apply.workable.com/toloka-ai/j/8A10343CF6/"],
  ["Initiate Government Solutions", "paylocity", "https://recruiting.paylocity.com/Recruiting/Jobs/Details/4640937"],
  ["Helix", "gem", "https://jobs.gem.com/helix/am9icG9zdDpn-MVK4vjTpWoBb_iLd-Ac"],
  ["Ascend Learning", "successfactors", "https://ascendlearning.jobs.hr.cloud.sap/job/Sr-Data-&-AI-Scientist-UT/1421626400/"],
  ["Float", "pinpoint", "https://float.pinpointhq.com/en/postings/ec4cb2df-e76a-40b2-9858-b17f92783e1f"],
  ["Direct Agents", "applytojob", "https://directagents.applytojob.com/apply/vw54jyjnlh/FullStack-Developer-AI-Systems-Agent-Engineering"],
];

/**
 * Runs in the page. The facts behind whatever the two probes decided.
 *
 * A verdict on its own cannot be acted on: "no form" is a different
 * problem depending on whether the page had three controls or thirty, and
 * a false-positive Submit can only be fixed by someone who can see which
 * two wordings collided.
 */
function pageFacts() {
  const shown = (node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const controls = [...document.querySelectorAll("input, textarea, select")].filter(
    (node) => !/^(?:hidden|submit|button|image|reset)$/i.test(node.type || "") && (node.type === "file" || shown(node)),
  );
  const words = [
    ...controls.map((node) => `${node.name} ${node.id} ${node.placeholder || ""} ${node.getAttribute("aria-label") || ""}`),
    ...[...document.querySelectorAll("label, legend")].map((node) => node.textContent || ""),
  ].join(" ").toLowerCase();
  const asked = [/first name|given name/, /last name|surname|family name/, /full name/, /e-?mail/, /phone|mobile/, /resume|\bcv\b|cover letter/, /linkedin/].filter((pattern) => pattern.test(words));

  return {
    url: location.href,
    forms: document.querySelectorAll("form").length,
    controls: controls.length,
    byType: controls.reduce((into, node) => ({ ...into, [node.type || node.tagName.toLowerCase()]: (into[node.type || node.tagName.toLowerCase()] || 0) + 1 }), {}),
    selects: document.querySelectorAll("select").length,
    fileInputs: document.querySelectorAll("input[type=file]").length,
    passwords: document.querySelectorAll("input[type=password]").length,
    askedFacts: asked.map(String),
    comboboxes: document.querySelectorAll('[role="combobox"], [role="listbox"]').length,
    pleaseSelect: [...document.querySelectorAll("button, [role='button'], [role='combobox'], div")]
      .map((node) => String(node.innerText || "").trim())
      .filter((text) => /^please select$|^select\.\.\.$|^select$/i.test(text)).length,
    // Every control that could read as a Submit, with its geometry, which
    // is the only way to tell a sticky duplicate from a real second choice.
    sendLike: [...document.querySelectorAll("button, input[type='submit'], [role='button'], a.btn, a[href='#'], a[href]")]
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        text: String(node.innerText || node.textContent || node.value || "").replace(/\s+/g, " ").trim(),
        box: node.getBoundingClientRect(),
        position: getComputedStyle(node.parentElement || node).position,
      }))
      .filter((entry) => entry.text && entry.text.length <= 60 && /^(?:submit|apply|send)\b|submit (?:your )?application/i.test(entry.text))
      .map((entry) => ({ tag: entry.tag, text: entry.text, w: Math.round(entry.box.width), h: Math.round(entry.box.height), top: Math.round(entry.box.top), sticky: entry.position === "fixed" || entry.position === "sticky" })),
    title: document.title.slice(0, 120),
  };
}

/** Both probes and the facts, for one frame. */
async function readFrame(frame) {
  const [probe, choices, facts] = await Promise.all([
    frame.evaluate(probeForm).catch((error) => ({ error: String(error).slice(0, 160) })),
    frame.evaluate(submitChoices).catch((error) => ({ error: String(error).slice(0, 160) })),
    frame.evaluate(pageFacts).catch((error) => ({ error: String(error).slice(0, 160) })),
  ]);
  return { frameUrl: frame.url().slice(0, 150), probeForm: probe, submitChoices: choices, facts };
}

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
const report = { startedAt: new Date().toISOString(), settleMs: SETTLE_MS, postings: [] };

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);

  for (const [company, board, url] of POSTINGS) {
    if (only && !only.test(company) && !only.test(board)) continue;
    const page = await context.newPage();
    const entry = { company, board, url };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      entry.frames = [];
      for (const frame of page.frames()) entry.frames.push(await readFrame(frame));

      // What the adapter would conclude: `detect` takes any frame claiming a
      // form, and `reach` follows the first onward link it is offered.
      const results = entry.frames.map((frame) => frame.probeForm).filter((result) => result && !result.error);
      entry.detect = results.some((result) => result?.shape === "form") ? "GENERIC (form here)" : results.some((result) => result?.shape === "posting") ? "GENERIC (posting)" : "NONE";
      entry.reach = results.find((result) => result?.shape === "form") ? "already on the form" : results.find((result) => result?.onward)?.onward ?? results.find((result) => result?.blocked)?.blocked ?? "nothing found";
      entry.submitChoices = [...new Set(entry.frames.flatMap((frame) => (Array.isArray(frame.submitChoices) ? frame.submitChoices : [])))];
      await page.screenshot({ path: `test-results/generic-recon-${board}.png` }).catch(() => {});
    } catch (error) {
      entry.error = String(error).slice(0, 300);
    } finally {
      await page.close().catch(() => {});
    }
    report.postings.push(entry);
    console.log(`${company.padEnd(30)} ${board.padEnd(15)} detect=${(entry.detect ?? "ERROR").padEnd(22)} submitChoices=${JSON.stringify(entry.submitChoices ?? [])}`);
    if (entry.error) console.log(`   error: ${entry.error}`);
  }
} finally {
  await writeFile("test-results/generic-recon.json", JSON.stringify(report, null, 2));
  await browser.close();
}
