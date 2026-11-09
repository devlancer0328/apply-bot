/**
 * Ashby, written third to answer a question the first two could not.
 *
 * Workable was chosen second because it disagreed with Greenhouse - a form
 * behind a navigation, a receipt that arrives as an HTTP status - on the
 * grounds that two similar adapters teach nothing. Ashby is the other
 * experiment: a board that resembles Greenhouse closely, written to find
 * out how little a similar adapter needs once the engine is carrying its
 * weight.
 *
 * The answer is detection and a navigation. Everything else - reading the
 * form, filling it, reading the values back, waiting out the uploads,
 * opening a menu to see what it offers, pressing Submit, and judging what
 * the page said afterwards - is inherited unchanged. Ashby's genuinely
 * unusual habits are all already handled a layer down, in `src/fill.js`,
 * and were handled there long before this file existed:
 *
 *   - questions built as blocks rather than labelled inputs, which is why
 *     the filler scopes to `.ashby-application-form-field-entry`
 *   - yes/no asked as a pair of buttons carrying `data-option` rather than
 *     as a radio group or a select
 *   - an autocomplete that opens from a sibling button and wants a plain
 *     click on the option rather than a keyboard commit
 *   - every answer saved to the server as it is given, and files sent
 *     straight to S3 on selection - so Submit has to wait for the requests
 *     in the air, which is the one board where that is true
 *
 * None of that is adapter business. It is how one page behaves, and it
 * belongs with the code that touches pages. If the split were wrong, this
 * file is where the evidence would show up - as an override for something
 * the engine does badly here. There are none, which is the result.
 */

import { CONFIDENCE } from "../contract.js";
import { ashbyApplyUrl, ashbyIds, isAshbyUrl } from "../../ashby.js";

export const ashbyAdapter = {
  name: "ashby",

  capabilities: { multiPage: false, upload: true, verifyAccepted: true, submit: true, receipt: true, account: false },

  /**
   * Ashby's own domain with an organisation slug and a posting uuid on it.
   *
   * Both halves are needed. `ashbyIds` reads the path alone, and a path of
   * a word followed by a uuid is not rare enough to claim a page on - it
   * would have this adapter answering for boards it has never seen. The
   * hostname narrows it to Ashby and the uuid confirms it is a posting.
   *
   * Companies also embed the board in their own careers page, where the
   * address says nothing at all, so a page that does not parse is still
   * asked what it is made of.
   */
  async detect({ url, browser, tabId }) {
    if (isAshbyUrl(url) && ashbyIds(url)) return CONFIDENCE.EXACT;
    const frames = await browser.inFrame(tabId, undefined, ashbyMarkup).catch(() => []);
    return frames.some((frame) => frame.result) ? CONFIDENCE.STRONG : CONFIDENCE.NONE;
  },

  /**
   * The form is one step on from the posting, at `/application`.
   *
   * Like Workable and for the same reason: a saved link is usually the
   * description, and the engine's wait for a form would otherwise spend
   * itself on a page that has none. Skipped when the tab is already there,
   * so a tab the person opened on the form is not reloaded out from under
   * them.
   *
   * The address is extended from where the tab actually is rather than
   * rebuilt from the ids, and that distinction is not cosmetic: a saved
   * link redirects, and a company serving Ashby from its own domain keeps
   * that domain all the way to the form. Rebuilding would send both to
   * jobs.ashbyhq.com, which is the right form for neither.
   *
   * That two of three boards need this is why `reach` is a declared step
   * rather than something folded into inspection.
   */
  async reach({ browser, tabId, request, log }) {
    const here = await browser.info(tabId);
    const current = here?.url || request.applyUrl;
    if (onForm(current)) return { reached: true };

    const form = formFrom(current) ?? ashbyApplyUrl(request.applyUrl);
    if (form === current) return { reached: true };

    log("info", `${request.company} - the posting is not the form; going on to ${form}`);
    await browser.navigate(tabId, form);
    return { reached: true };
  },
};

/**
 * Whether the tab is already on the form.
 *
 * Read off the path and not the whole address. Every saved link in the
 * corpus carries tracking on the end of it, and the Mapbox posting - saved
 * as `.../application?utm_source=...` - was already on the form and got
 * sent to `/application/application`, which Ashby serves as a page with no
 * form on it at all.
 */
function onForm(current) {
  try {
    return /\/application\/?$/.test(new URL(current).pathname);
  } catch {
    return /\/application\/?$/.test(current);
  }
}

/** `/application` on the page the tab is actually on, keeping its origin. */
function formFrom(current) {
  try {
    const url = new URL(current);
    const [, id] = url.pathname.split("/").filter(Boolean);
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/application`;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Runs in the page. Ashby's own domain, its form blocks, or its embed. */
function ashbyMarkup() {
  if (/(^|\.)ashbyhq\.com$/i.test(location.hostname)) return true;
  if (document.querySelector("#ashby_embed, .ashby-application-form-field-entry, .ashby-job-posting-brief, [class*='ashby-application-form']")) return true;
  return [...document.querySelectorAll("iframe")].some((frame) => /ashbyhq\.com/i.test(frame.src || ""));
}
