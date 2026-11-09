/**
 * Greenhouse.
 *
 * The first adapter written, and for a while the longest - it carried its
 * own copy of inspecting, filling, verifying, settling uploads, reading
 * menus, pressing Submit and reading the result. All of that was the
 * ordinary way of working a form rather than anything about Greenhouse, and
 * it now lives in the engine's defaults (see form-ops.js). What is left is
 * the one thing that is genuinely Greenhouse's: knowing a Greenhouse page
 * when it is looking at one.
 *
 * That is harder than a hostname test, which is why it is the part worth
 * keeping. Greenhouse is served two ways - as its own page on
 * boards.greenhouse.io, and as an iframe inside a company's careers site -
 * and the second is the common case rather than the exception. A posting
 * address the API parses settles it outright; anything else has to ask the
 * page, every frame of it.
 *
 * The board's other distinguishing habit - holding an application after
 * Submit until the applicant proves they own the address, which arrives as
 * a row of code boxes rather than an error - needs no code here either. The
 * default outcome reader asks every board whether code boxes appeared,
 * because the question costs nothing on a board that never shows them.
 */

import { CONFIDENCE } from "../contract.js";
import { greenhouseIds } from "../../greenhouse.js";

export const greenhouseAdapter = {
  name: "greenhouse",

  capabilities: { multiPage: false, upload: true, verifyAccepted: true, submit: true, receipt: true, account: false },

  async detect({ url, browser, tabId }) {
    if (greenhouseIds(url)) return CONFIDENCE.EXACT;
    const frames = await browser.inFrame(tabId, undefined, greenhouseMarkup).catch(() => []);
    return frames.some((frame) => frame.result) ? CONFIDENCE.STRONG : CONFIDENCE.NONE;
  },
};

/** Runs in the page. Greenhouse's own domain, its form, or its embed. */
function greenhouseMarkup() {
  if (/(^|\.)greenhouse\.io$/i.test(location.hostname)) return true;
  if (document.querySelector('#application_form, #grnhse_app, #grnhse_iframe, form[action*="greenhouse.io"]')) return true;
  return [...document.querySelectorAll("iframe")].some((frame) => /greenhouse\.io/i.test(frame.src || ""));
}
