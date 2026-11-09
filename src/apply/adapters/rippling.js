/**
 * Rippling, which was listed as fillable for weeks without being reachable.
 *
 * `FILLABLE` in ats.js named rippling, so the scraper surfaced Rippling
 * postings and the run claimed the employer for one - but the modular
 * registry held no Rippling adapter and the legacy routing list did not
 * name it either, so every posting fell through to the generic adapter,
 * which is gated off by default. The result was the worst of both: a
 * company spent out of the day's allowance on an application that could
 * never be filled. A board is only supported when something can fill it.
 *
 * The form is one step past the posting, exactly as on Workable: a posting
 * sits at ats.rippling.com/<org>/jobs/<uuid> and its form at the same
 * address with /apply on the end. `ripplingApplyUrl` already builds that,
 * so this adapter is mostly a `reach` - everything after it is ordinary
 * form filling that the engine already does.
 */

import { CONFIDENCE } from "../contract.js";
import { ripplingApplyUrl, ripplingIds } from "../../rippling.js";

export const ripplingAdapter = {
  name: "rippling",

  capabilities: { multiPage: false, upload: true, verifyAccepted: true, submit: true, receipt: true, account: false },

  /**
   * Rippling's posting addresses carry an organisation slug and a UUID, so
   * they parse or they do not. A company serving the board from its own
   * domain still loads Rippling's form, so a page that does not parse is
   * asked whether Rippling built it.
   */
  async detect({ url, browser, tabId }) {
    if (ripplingIds(url)) return CONFIDENCE.EXACT;
    const frames = await browser.inFrame(tabId, undefined, ripplingMarkup).catch(() => []);
    return frames.some((frame) => frame.result) ? CONFIDENCE.STRONG : CONFIDENCE.NONE;
  },

  /**
   * On to the form, unless the tab is already there.
   *
   * Judged on the path rather than the whole address, because saved links
   * carry tracking query and a link already on the form would otherwise be
   * sent one hop past it - the bug Ashby had against a `?utm_source=` link.
   */
  async reach({ browser, tabId, request, log }) {
    const here = await browser.info(tabId);
    const current = here?.url || request.applyUrl;
    if (onForm(current)) return { reached: true };

    const form = ripplingApplyUrl(current) !== current ? ripplingApplyUrl(current) : ripplingApplyUrl(request.applyUrl);
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

/** Runs in the page. Rippling's own domain, its markup, or its embed. */
function ripplingMarkup() {
  if (/(^|\.)rippling\.com$/i.test(location.hostname)) return true;
  if (document.querySelector('form[action*="rippling.com"], [class*="rippling-"], [data-testid*="rippling"]')) return true;
  return [...document.querySelectorAll("iframe")].some((frame) => /rippling\.com/i.test(frame.src || ""));
}
