/**
 * What the Lever page looks like when hCaptcha actually asks something.
 *
 * The passive reading (tests/live-lever-captcha.mjs) only ever sees the
 * resting state, where hCaptcha is scoring the session and showing
 * nothing. That half proves the adapter will send a Lever application; it
 * says nothing about the half that matters more, which is whether the
 * adapter would notice a puzzle if one appeared and stop. Asserting that
 * from the resting measurement would be assuming the answer.
 *
 * So the challenge is provoked deliberately: `hcaptcha.execute()` is what
 * Lever's own Submit handler calls, and calling it directly runs exactly
 * the path a real submission would without sending anything. Nothing here
 * presses Submit and nothing here fills a field.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const ATTACH = process.env.ATTACH ?? "http://127.0.0.1:9222";
const URL_UNDER_TEST = process.env.URL ?? "https://jobs.lever.co/provectus/9509af76-071c-411d-9856-a44d5aee2a9a/apply";

/** Runs in the page, once per frame. Same geometry the signal reads. */
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
      kind: /frame=([a-z-]+)/i.exec(src)?.[1] ?? (CAPTCHA.test(src) ? "captcha" : "other"),
      size: /size=([a-z]+)/i.exec(src)?.[1] ?? "",
      width: Math.round(box.width),
      height: Math.round(box.height),
      top: Math.round(box.top),
      visibility: style.visibility,
      display: style.display,
      opacity: style.opacity,
      captchaSrc: CAPTCHA.test(src),
      excludedByRule: excluded,
      countsAsHumanCheck: CAPTCHA.test(src) && !excluded && visible && box.width > 100 && box.height > 40,
      countsAsPuzzle: PUZZLE.test(src) && visible && box.width > 200 && box.height > 200,
    };
  });
}

async function readAll(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const found = await frame.evaluate(measureFrames).catch(() => null);
    if (Array.isArray(found) && found.length > 0) frames.push({ frameUrl: frame.url().slice(0, 120), iframes: found });
  }
  const flat = frames.flatMap((frame) => frame.iframes);
  return {
    frames,
    humanCheckShowing: flat.some((found) => found.countsAsHumanCheck),
    captchaShowing: flat.some((found) => found.countsAsPuzzle),
  };
}

await mkdir("test-results", { recursive: true });
const browser = await chromium.connectOverCDP(ATTACH);
const report = { startedAt: new Date().toISOString(), url: URL_UNDER_TEST, stages: [] };

try {
  const context = browser.contexts()[0];
  if (!context) throw new Error(`nothing to attach to at ${ATTACH}`);
  const page = await context.newPage();
  try {
    await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);
    report.stages.push({ label: "resting", ...(await readAll(page)) });

    report.widget = await page
      .evaluate(() => ({
        hasApi: typeof window.hcaptcha !== "undefined",
        methods: window.hcaptcha ? Object.keys(window.hcaptcha) : [],
        containers: [...document.querySelectorAll(".h-captcha, [data-hcaptcha-widget-id], [data-sitekey]")].map((node) => ({
          cls: node.className,
          sitekey: node.getAttribute("data-sitekey") || "",
          size: node.getAttribute("data-size") || "",
          widgetId: node.getAttribute("data-hcaptcha-widget-id") || "",
        })),
      }))
      .catch((error) => ({ error: String(error).slice(0, 200) }));

    report.executed = await page
      .evaluate(() => {
        if (!window.hcaptcha?.execute) return "no hcaptcha.execute on the page";
        try {
          window.hcaptcha.execute();
          return "called";
        } catch (error) {
          return `threw: ${String(error).slice(0, 200)}`;
        }
      })
      .catch((error) => `evaluate failed: ${String(error).slice(0, 200)}`);

    // Read repeatedly. A challenge that takes a moment to paint and a
    // challenge that never comes look identical at one instant, and the
    // difference between them is the whole result.
    for (const wait of [1200, 2500, 4000, 6000]) {
      await page.waitForTimeout(wait);
      report.stages.push({ label: `after execute +${wait}ms`, ...(await readAll(page)) });
    }
    await page.screenshot({ path: "test-results/lever-puzzle-forced.png" }).catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await writeFile("test-results/lever-puzzle.json", JSON.stringify(report, null, 2));
  await browser.close();
}

for (const stage of report.stages) {
  const shown = stage.frames.flatMap((frame) => frame.iframes).filter((found) => found.captchaSrc && found.visibility !== "hidden" && found.display !== "none");
  console.log(`${stage.label}: humanCheck=${stage.humanCheckShowing} puzzle=${stage.captchaShowing} visibleCaptchaFrames=${JSON.stringify(shown.map((f) => `${f.kind}${f.size ? `/${f.size}` : ""} ${f.width}x${f.height}`))}`);
}
console.log("widget:", JSON.stringify(report.widget));
console.log("execute:", report.executed);
