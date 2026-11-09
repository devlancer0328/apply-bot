/**
 * Lever, the most common board nothing claimed.
 *
 * Two of the thirty-one corpus postings apply through it, and both of them
 * parked untouched with "no adapter recognises jobs.lever.co" - which is
 * the whole reason this file exists. There is very little in it, and that
 * is the result rather than an omission: Lever's form is server-rendered
 * into one `li.application-question` per question with the heading in
 * `.application-label`, and `src/fill.js` has read that markup since long
 * before the adapter layer did. Reading, filling, verifying, waiting out
 * the upload and pressing Submit are all inherited unchanged.
 *
 * What is Lever's own is the captcha, and getting that judgement right is
 * most of the value here. The run loop this module replaces refused to
 * send any Lever application at all, on the evidence that hCaptcha shows
 * the picture puzzle to a datacenter address - a reasonable rule when
 * every run came from one. It is the wrong rule now: both Lever postings
 * in the corpus carry hCaptcha at `size=invisible` with nothing but the
 * enclave frame mounted, which is the board scoring the session silently
 * and not a wall anybody has to climb. So the question is asked of the
 * page instead of assumed from the board, once, immediately before the
 * claim is taken - and a Lever posting that really is showing a puzzle
 * parks with its answers recorded, where one that is not goes out.
 */

import { CONFIDENCE } from "../contract.js";
import { submitStop } from "../form-ops.js";
import { isLeverUrl, leverIds } from "../../lever.js";

export const leverAdapter = {
  name: "lever",

  capabilities: { multiPage: false, upload: true, verifyAccepted: true, submit: true, receipt: true, account: false },

  /**
   * Both halves, for the reason Ashby needs both: a path of a slug and a
   * uuid is not rare enough to claim a page on. Companies also serve the
   * form from their own careers page, where the address says nothing, so
   * a page the address does not settle is still asked what it is made of.
   */
  async detect({ url, browser, tabId }) {
    if (isLeverUrl(url) && leverIds(url)) return CONFIDENCE.EXACT;
    const frames = await browser.inFrame(tabId, undefined, leverMarkup).catch(() => []);
    return frames.some((frame) => frame.result) ? CONFIDENCE.STRONG : CONFIDENCE.NONE;
  },

  /**
   * The form is one step on from the posting, at `/apply`.
   *
   * Extended from where the tab actually is rather than rebuilt from the
   * ids, which is the correction Ashby's `reach` already carries: a saved
   * link redirects, and rebuilding would send the redirected one back to
   * an address it had already left.
   */
  async reach({ browser, tabId, request, log }) {
    const current = (await browser.info(tabId))?.url || request.applyUrl;
    if (/\/apply\/?$/.test(pathOf(current))) return { reached: true };
    const form = `${current.split(/[?#]/)[0].replace(/\/$/, "")}/apply`;
    log("info", `${request.company} - the posting is not the form; going on to ${form}`);
    await browser.navigate(tabId, form);
    return { reached: true };
  },

  /** Asked before the claim is taken; see submitStop. */
  async advance(context) {
    const stop = await submitStop(context);
    return stop ? { park: `${stop}; the answers are recorded, so it can be redone by hand in a minute` } : { done: true };
  },
};

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

/** Runs in the page. Lever's own domain, its question markup, or its embed. */
function leverMarkup() {
  if (/(^|\.)lever\.co$/i.test(location.hostname)) return true;
  if (document.querySelector('.application-question, .application-form, .posting-apply, [name^="cards["], form[action*="lever.co"]')) return true;
  return [...document.querySelectorAll("iframe")].some((frame) => /lever\.co/i.test(frame.src || ""));
}
