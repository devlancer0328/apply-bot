/**
 * What a live Lever apply page actually mounts for hCaptcha.
 *
 * `humanCheckShowing` in src/apply/signals.js decides whether a Lever
 * posting may be sent, and it decides it by excluding two frame kinds -
 * `size=invisible` and hCaptcha's `frame=enclave` - and then asking
 * whether anything captcha-shaped is larger than 100x40. That rule was
 * derived from frame attributes copied out of saved recon data, which
 * records a `src` and nothing about geometry. So the two ways it can be
 * wrong have both never been looked at: an enclave frame that really
 * measures large would park every Lever posting forever, and a threshold
 * set too low would send an application into a puzzle a person has to
 * clear. This reads the real numbers off the real page.
 *
 * Attaches to the browser the person already has open. It never launches
 * one, never signs anything in, and closes only the tabs it opened.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 9000);

const PAGES = [
  ["Provectus", "https://jobs.lever.co/provectus/9509af76-071c-411d-9856-a44d5aee2a9a/apply"],
  ["VGS", "https://jobs.lever.co/verygoodsecurity/1cc60b9d-5bf6-47b2-b640-a20f02084712/apply"],
];

/**
 * Runs in the page, once per frame. Every iframe this frame owns, with the
 * geometry the signal reads and the two verdicts it would reach, so the
 * measurement and the rule it is testing come from the same observation
 * rather than from a rule re-typed into the harness and drifting.
 */
function measureFrames() {
  const CAPTCHA = /hcaptcha\.com|recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)|arkoselabs|funcaptcha|challenges\.cloudflare|turnstile/i;
  const PUZZLE = /hcaptcha\.com|recaptcha\/(?:api2|enterprise)\/bframe|arkoselabs|funcaptcha|challenges\.cloudflare/i;
  return [...document.querySelectorAll("iframe")].map((frame) => {
    const src = frame.src || "";
    const box = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const visible = style.visibility !== "hidden" && style.display !== "none";
    const excluded = /size=invisible|frame=enclave/i.test(src);
    return {
      src: src.slice(0, 300),
      title: frame.title || "",
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100,
      top: Math.round(box.top),
      left: Math.round(box.left),
      visibility: style.visibility,
      display: style.display,
      opacity: style.opacity,
      position: style.position,
      zIndex: style.zIndex,
      offsetParent: Boolean(frame.offsetParent),
      captchaSrc: CAPTCHA.test(src),
      excludedByRule: excluded,
      overThreshold: box.width > 100 && box.height > 40,
      countsAsHumanCheck: CAPTCHA.test(src) && !excluded && visible && box.width > 100 && box.height > 40,
      countsAsPuzzle: PUZZLE.test(src) && visible && box.width > 200 && box.height > 200,
    };
  });
}

/** Runs in the page. Enough of the form to tell a reached form from a wall. */
function formShape() {
  const text = (document.body?.innerText || "").replace(/\s+/g, " ");
  return {
    url: location.href,
    questions: document.querySelectorAll("li.application-question").length,
    labels: document.querySelectorAll(".application-label").length,
    fileInputs: document.querySelectorAll("input[type=file]").length,
    submitButtons: [...document.querySelectorAll("button, input[type=submit]")]
      .map((node) => String(node.innerText || node.value || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12),
    mentionsCaptcha: /captcha|verify you are human|i am human/i.test(text),
    textHead: text.slice(0, 400),
  };
}

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
const report = { startedAt: new Date().toISOString(), attach: ATTACH, settleMs: SETTLE_MS, pages: [] };

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);

  for (const [company, url] of PAGES) {
    const page = await context.newPage();
    const entry = { company, url, passes: [] };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Two readings, because the one that matters is the late one. hCaptcha
      // mounts its frames after the page settles, so a measurement taken at
      // DOMContentLoaded would record an absence the adapter never sees and
      // call the rule safe on evidence that was simply early.
      for (const [label, wait] of [["on load", 1500], ["settled", SETTLE_MS]]) {
        await page.waitForTimeout(wait);
        const frames = [];
        for (const frame of page.frames()) {
          const found = await frame.evaluate(measureFrames).catch((error) => ({ error: String(error).slice(0, 200) }));
          if (Array.isArray(found) && found.length > 0) frames.push({ frameUrl: frame.url().slice(0, 200), iframes: found });
        }
        entry.passes.push({
          label,
          frameCount: page.frames().length,
          frames,
          humanCheckShowing: frames.some((frame) => frame.iframes.some((found) => found.countsAsHumanCheck)),
          captchaShowing: frames.some((frame) => frame.iframes.some((found) => found.countsAsPuzzle)),
        });
      }

      entry.form = await page.evaluate(formShape).catch(() => null);
      await page.screenshot({ path: `test-results/lever-captcha-${company.toLowerCase()}.png`, fullPage: false }).catch(() => {});
    } catch (error) {
      entry.error = String(error).slice(0, 400);
    } finally {
      await page.close().catch(() => {});
    }
    report.pages.push(entry);
    console.log(`${company}: ${JSON.stringify(entry.passes.at(-1)?.humanCheckShowing)} humanCheck, ${entry.passes.at(-1)?.frames.flatMap((f) => f.iframes).length ?? 0} iframes`);
  }
} finally {
  await writeFile("test-results/lever-captcha.json", JSON.stringify(report, null, 2));
  await browser.close();
}
