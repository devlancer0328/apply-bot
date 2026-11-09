/**
 * Things every board's page says the same way.
 *
 * A captcha puzzle and a thank-you line are not Greenhouse facts, they are
 * facts about the web, so they live here rather than in any one adapter.
 * Keeping them out of the adapters is also what stops the second adapter
 * from arriving with its own slightly different idea of what a visible
 * captcha is - the kind of drift that makes two boards behave differently
 * for no reason anybody chose.
 *
 * Everything here is a probe: it reads the page and returns, and never waits
 * on it. Waiting is the caller's business, between turns.
 */

import { confirmationSnapshot } from "../submission-evidence.js";

/**
 * The confirmation lines already on the page before Submit was pressed.
 *
 * A careers site that lists "Application submitted" beside a previous
 * application will read as a receipt for this one unless the before picture
 * is taken first. The audit found exactly one of these - a welcome page
 * filed as a success - and this is the guard against it.
 */
export async function confirmationBaseline(browser, tabId) {
  const frames = await browser.inFrame(tabId, undefined, confirmationSnapshot).catch(() => []);
  return frames.flatMap((frame) => frame.result || []);
}

/**
 * Whether a captcha puzzle is on screen, as opposed to the invisible kind
 * that decides in silence. Only a shown puzzle means a person is required;
 * a hidden frame is the board scoring the session and is none of our
 * business.
 */
export async function captchaShowing(browser, tabId) {
  const frames = await browser.inFrame(tabId, undefined, () =>
    [...document.querySelectorAll("iframe")].some((frame) => {
      if (!/hcaptcha\.com|recaptcha\/(?:api2|enterprise)\/bframe|arkoselabs|funcaptcha|challenges\.cloudflare/i.test(frame.src)) return false;
      const box = frame.getBoundingClientRect();
      return getComputedStyle(frame).visibility !== "hidden" && getComputedStyle(frame).display !== "none" && box.width > 200 && box.height > 200;
    }),
  ).catch(() => []);
  return frames.some((frame) => frame.result === true);
}

/**
 * Whether a human check of any kind is waiting on the form, puzzle or not.
 *
 * Deliberately a wider question than `captchaShowing`, and asked at a
 * different moment. That one answers "did a puzzle appear after Submit",
 * where a tick-box widget sitting unanswered beside Submit is not a puzzle
 * and is not large: ApplyToJob's "Human Check" is reCAPTCHA's anchor frame
 * at 300x78, which the puzzle test passes straight over. A form carrying
 * one of those has not been understood by anything that cannot tick it, so
 * an adapter that reasons about shape alone has to stop here rather than
 * send a form the board will score as a robot.
 *
 * What is still excluded is the plumbing every captcha mounts whether or
 * not it ever asks anything: a frame declared `size=invisible`, and
 * hCaptcha's `frame=enclave`, which is where it keeps its own state. Both
 * Lever postings in the corpus carry exactly those two and nothing else,
 * so Lever reads as scored rather than walled - which is the distinction
 * that decides whether that board is worth an adapter at all.
 */
export async function humanCheckShowing(browser, tabId) {
  const frames = await browser.inFrame(tabId, undefined, () =>
    [...document.querySelectorAll("iframe")].some((frame) => {
      if (!/hcaptcha\.com|recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)|arkoselabs|funcaptcha|challenges\.cloudflare|turnstile/i.test(frame.src || "")) return false;
      if (/size=invisible|frame=enclave/i.test(frame.src || "")) return false;
      const box = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 100 && box.height > 40;
    }),
  ).catch(() => []);
  return frames.some((frame) => frame.result === true);
}

/** The visible text of every frame, which is where a receipt turns up. */
export async function frameText(browser, tabId) {
  const frames = await browser.inFrame(tabId, undefined, () => (document.body?.innerText || "").slice(0, 6000)).catch(() => []);
  return frames.map((frame) => frame.result || "");
}
