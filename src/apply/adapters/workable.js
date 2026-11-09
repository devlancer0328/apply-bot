/**
 * Workable, chosen second for the two ways it disagreed with Greenhouse.
 *
 * ## The form is not where the link points
 *
 * A saved Workable link is the posting - description, requirements, an
 * "Apply for this job" button - and the form is one step on at `/apply/`.
 * The corpus proved it: the one Workable posting in it reported zero inputs
 * and zero forms on arrival, with the application nowhere on the page. So
 * this adapter has a `reach`, and that is most of what it is.
 *
 * ## The receipt is a network response, not a sentence
 *
 * Greenhouse replaces the form with a thank-you. Workable sends the
 * application from a script and says very little on the page - what it
 * shows is brief and can be gone before anyone looks. The honest signal is
 * its own request: a 2xx to the candidates endpoint is an application
 * accepted.
 *
 * This is the half of the adapter that no longer exists, and the fact that
 * it does not is the interesting result. The claim the adapter boundary
 * makes is that the engine reads a status and a receipt off an outcome and
 * holds no opinion about where either came from. That held - and held so
 * completely that asking the network turned out to be worth doing on every
 * board, not just this one, so it moved into the default outcome reader
 * and Workable stopped needing a version of its own.
 */

import { CONFIDENCE } from "../contract.js";
import { workableApplyUrl, workableIds } from "../../workable.js";

export const workableAdapter = {
  name: "workable",

  capabilities: { multiPage: false, upload: true, verifyAccepted: true, submit: true, receipt: true, account: false },

  /**
   * The address usually settles it - Workable's posting codes are a
   * distinctive shape and parse or do not. Companies also serve the form
   * from their own careers page through Workable's embed, so a page that
   * does not parse is still asked whether Workable built it.
   */
  async detect({ url, browser, tabId }) {
    if (workableIds(url)) return CONFIDENCE.EXACT;
    const frames = await browser.inFrame(tabId, undefined, workableMarkup).catch(() => []);
    return frames.some((frame) => frame.result) ? CONFIDENCE.STRONG : CONFIDENCE.NONE;
  },

  /**
   * The application is one step on from the posting.
   *
   * Taken by address rather than by pressing "Apply for this job", because
   * Workable's address for a form is derivable and a button is not: a
   * button moves, gets a cookie banner on top of it, or turns into a modal.
   * Skipped when the tab is already on the form, so adopting a tab the
   * person opened there does not reload it out from under them.
   */
  async reach({ browser, tabId, request, log }) {
    const here = await browser.info(tabId);
    const current = here?.url || request.applyUrl;
    // The path, not the whole address: every saved link carries tracking,
    // and a link already on the form would otherwise be sent one hop past
    // it. Ashby had exactly that bug against a `?utm_source=` link.
    if (onForm(current)) return { reached: true };

    const form = formFrom(current) ?? workableApplyUrl(request.applyUrl);
    log("info", `${request.company} - the posting is not the form; going on to ${form}`);
    await browser.navigate(tabId, form);
    return { reached: true };
  },
};

/** Whether the tab is already on the form, judged on the path alone. */
function onForm(current) {
  try {
    return /\/apply\/?$/.test(new URL(current).pathname);
  } catch {
    return /\/apply\/?$/.test(current);
  }
}

/**
 * The form's address, worked out from where the tab actually is rather than
 * from the link that was saved.
 *
 * The saved link redirects - short links especially - and a company serving
 * Workable from its own domain keeps that domain all the way to the form.
 * Rebuilding the address from scratch would send both somewhere else.
 */
function formFrom(current) {
  try {
    const url = new URL(current);
    if (!/\/j\/[A-Z0-9]{6,16}\/?$/i.test(url.pathname)) return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/apply/`;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Runs in the page. Workable's own domain, its markup, or its embed. */
function workableMarkup() {
  if (/(^|\.)workable\.com$/i.test(location.hostname)) return true;
  if (document.querySelector('[data-ui="application_form"], [class*="styles__application"], form[action*="workable.com"]')) return true;
  return [...document.querySelectorAll("iframe")].some((frame) => /workable\.com/i.test(frame.src || ""));
}
