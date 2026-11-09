/**
 * The form nobody wrote an adapter for.
 *
 * `CONFIDENCE.GENERIC` has been reserved since the contract was written and
 * has sat empty, which meant the architecture's central claim - that an
 * unknown careers site is the ordinary case handled poorly rather than a
 * case refused outright - was only ever a claim. Nine of thirty-one corpus
 * postings, something near eighty-seven of a three-hundred-a-day target,
 * parked with "no adapter recognises <host>" and were never touched. This
 * is that rank occupied.
 *
 * It reasons about the form's own structure and nothing else: what the
 * controls are, what the labels say, which are required, where the file
 * inputs are, and what could be the button that sends it. Everything after
 * that - resolving each field against the profile, asking the model only
 * what the profile cannot answer, re-reading the page to see what actually
 * landed - is the engine's, unchanged, which is the point of having built
 * the engine that way.
 *
 * ## What it refuses, and why refusing is the feature
 *
 * These are real applications to real employers, and an application cannot
 * be taken back. A parked posting costs one application; a garbled one
 * costs the candidate that employer. So every judgement here is biased the
 * same way, and the adapter declines outright on five things:
 *
 *   - A page carrying a password box. That is a sign-in or a registration
 *     wall, and creating an account on an employer's system is a durable
 *     record under a real name that nobody can delete. `capabilities`
 *     says `account: false` and this is the same refusal said earlier.
 *   - A page that does not look like an application: fewer than four
 *     controls, or no two of the facts every application asks for, or
 *     nothing that could be a Submit. A newsletter box and a job-alert
 *     signup both pass a looser test than this, and both are forms.
 *   - A required field still empty after the engine has filled, rescued
 *     and re-read the page. A board-specific adapter is allowed to send
 *     anyway and let the board complain, because it knows what that
 *     board's complaint looks like. This one knows neither the board nor
 *     the field, so an empty required box means the form was not
 *     understood (see `submitStop`).
 *   - A page offering two differently-worded Submits. One of them is
 *     wrong and there is no way from shape alone to know which.
 *   - A visible human check. A form with an unticked captcha beside
 *     Submit has not been understood by anything that cannot tick it.
 *
 * ## Reaching a form that is not on the page yet
 *
 * Five of the nine unserved corpus postings show no form at all on
 * arrival: EPAM, Odoo, Paylocity and SuccessFactors each put it behind an
 * "Apply" control. Following one is worth doing and is also the most
 * dangerous thing in this file, because "Easy Apply" and "Apply with
 * LinkedIn" are buttons that send an application rather than open a form.
 * So only a link is ever followed, never a button: a navigation can be
 * walked back from and a press on an unidentified control on an
 * employer's site cannot. The wordings excluded here are the ones
 * `src/extract.js` learned on the aggregators, which is where they were
 * paid for.
 */

import { CONFIDENCE } from "../contract.js";
import { submitStop } from "../form-ops.js";

export const genericAdapter = {
  name: "generic",

  capabilities: { multiPage: false, upload: true, verifyAccepted: true, submit: true, receipt: true, account: false },

  /**
   * Always the lowest rank there is, so this only ever drives a page every
   * other adapter has already declined. A board that grows an adapter
   * later takes its own postings back by registering, with nothing here
   * to change.
   */
  async detect({ browser, tabId }) {
    const frames = await browser.inFrame(tabId, undefined, probeForm).catch(() => []);
    return frames.some((frame) => frame.result?.shape) ? CONFIDENCE.GENERIC : CONFIDENCE.NONE;
  },

  async reach({ browser, tabId, request, log }) {
    const seen = (await browser.inFrame(tabId, undefined, probeForm).catch(() => [])).map((frame) => frame.result).filter(Boolean);
    if (seen.some((result) => result.shape === "form")) return { reached: true };

    const onward = seen.find((result) => result.onward);
    if (!onward) return { park: seen.find((result) => result.blocked)?.blocked ?? "no application form and no way through to one was found on this page" };

    log("info", `${request.company} - the posting holds no form; following "${onward.text}" to ${onward.onward}`);
    await browser.navigate(tabId, onward.onward);
    return { reached: true };
  },

  /**
   * The gate, taken before the engine claims the company and presses
   * Submit. Strict, which is the whole difference between this adapter and
   * one that knows its board; see `submitStop`.
   */
  async advance(context) {
    const stop = await submitStop(context, { strict: true });
    return stop ? { park: `${stop}; left filled for a person rather than sent on a guess` } : { done: true };
  },
};

/**
 * Runs in the page. What this page is, judged on its shape alone.
 *
 * `{shape: "form"}` is an application form here and now. `{shape:
 * "posting", onward}` is a posting whose form is one link away.
 * `{shape: "posting", blocked}` is a posting whose only way on is
 * something this must not press. Null is neither, and the engine parks the
 * attempt with the page untouched.
 *
 * Exported because the only way to find out whether it recognises a real
 * careers page is to run it against one, and a harness that re-typed it
 * would be measuring its own copy. It closes over nothing, so it survives
 * being serialised into a page by a driver.
 */
export function probeForm() {
  const shown = (node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  /**
   * Everything that says what one control is for, including the part only
   * a person can see.
   *
   * Attributes alone were the whole of this and they are the half that a
   * component library is free not to emit. Gem's page is the proof: an
   * obvious application form - name, email, résumé, the lot - built from
   * React components that render no `name`, no `id`, no `placeholder` and
   * no `<label>` element at all, so the seven facts an application asks
   * for scored zero out of seven and the adapter walked away from a form
   * it could have filled. The words are on the screen; they are simply in
   * a `<div>` above the box rather than in an attribute on it.
   *
   * So the control's own container is read too. The climb stops at the
   * first ancestor holding a second control, which is what keeps "Email"
   * from being collected as the label of the phone box beneath it, and
   * `innerText` is used rather than `textContent` because the question is
   * what the applicant can read - a template, an off-screen helper or a
   * collapsed panel contributes nothing to recognising a form.
   */
  const describes = (node) => {
    const bits = [node.name, node.id, node.placeholder || "", node.getAttribute("aria-label") || ""];
    for (const id of (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) bits.push(document.getElementById(id)?.innerText || "");
    if (node.id) for (const label of document.querySelectorAll("label")) if (label.htmlFor === node.id) bits.push(label.innerText || "");
    const wrapping = node.closest("label");
    if (wrapping) bits.push(wrapping.innerText || "");
    let group = node.parentElement;
    let nearest = null;
    for (let depth = 0; group && depth < 4; depth++) {
      if (group.querySelectorAll("input, textarea, select").length > 1) break;
      nearest = group;
      group = group.parentElement;
    }
    if (nearest) bits.push((nearest.innerText || "").slice(0, 120));
    return bits.join(" ");
  };
  // A file input is exempt from the visibility test because every board
  // worth filling hides the real one under a styled drop zone, and a form
  // judged without its résumé upload is not judged as an application.
  const controls = [...document.querySelectorAll("input, textarea, select")].filter(
    (node) => !/^(?:hidden|submit|button|image|reset)$/i.test(node.type || "") && (node.type === "file" || shown(node)),
  );

  const pressable = [...document.querySelectorAll("button, input[type='submit'], [role='button'], a[href]")]
    .map((node) => ({ node, text: String(node.innerText || node.textContent || node.value || "").replace(/\s+/g, " ").trim() }))
    .filter((entry) => entry.text && entry.text.length <= 60);
  // The same geometry test `submitChoices` applies, and the same one on
  // purpose. The two used to disagree: this counted any control whose
  // wording looked like a Submit, while the gate that runs just before the
  // claim counted only ones with a box on screen. Paylocity draws a 0x0
  // "Apply", so the page read as a form here, got twenty-eight fields
  // filled, and then parked at the gate on "nothing here sends it" - the
  // worst of both answers, since the posting was spent and no application
  // existed. Agreeing means the page is judged a posting instead, and the
  // real form is one followed link away.
  const sized = (node) => {
    const box = node.getBoundingClientRect();
    return box.width >= 1 && box.height >= 1;
  };
  const sends = pressable.some((entry) => /^(?:submit|apply|send)\b|submit (?:your )?application/i.test(entry.text) && sized(entry.node));

  const words = [...controls.map(describes), ...[...document.querySelectorAll("legend")].map((node) => node.innerText || "")].join(" ").toLowerCase();
  const asked = [/first name|given name/, /last name|surname|family name/, /full name/, /e-?mail/, /phone|mobile/, /resume|\bcv\b|cover letter/, /linkedin/].filter((pattern) => pattern.test(words)).length;

  // A password box anywhere on the page ends it. The page is a sign-in or
  // a registration, and "Apply" on one of those creates an account rather
  // than sending an application - a durable record in an employer's system
  // under a real name that nobody can delete. Judged for the whole page
  // rather than the form, because the cost of declining a careers page
  // that merely carries a login widget is one posting, and the cost of
  // being wrong the other way is not recoverable.
  if (controls.some((node) => node.type === "password")) return null;
  if (sends && controls.length >= 4 && asked >= 2) return { shape: "form" };

  const absolute = (node) => {
    try {
      return new URL(node.getAttribute("href"), location.href).href;
    } catch {
      return "";
    }
  };
  const ways = pressable
    .filter((entry) => /\bapply\b|\bapplication\b/i.test(entry.text) && !/\b(?:filters?|applied|applicants|save|share|report)\b/i.test(entry.text))
    .map((entry) => ({
      text: entry.text,
      href: entry.node.tagName === "A" ? absolute(entry.node) : "",
      oneClick: /\b(?:easy|quick|instant|one[- ]?click|1[- ]?click)\s+apply\b|\bapply (?:with|using|via)\b|\bautofill\b/i.test(entry.text),
    }));
  if (ways.length === 0) return null;
  if (ways.every((way) => way.oneClick)) {
    return { shape: "posting", blocked: `the only way on from this page is "${ways[0].text}", which sends an application rather than opening a form` };
  }

  const here = location.href.split("#")[0];
  const link = ways.find((way) => {
    if (way.oneClick || !/^https?:/i.test(way.href) || way.href.split("#")[0] === here) return false;
    // Same origin only. A link off to another board is a board that
    // should have been detected on its own page, and sending this
    // adapter after it would have the lowest-confidence driver working a
    // form some other adapter understands properly.
    try {
      return new URL(way.href).origin === location.origin;
    } catch {
      return false;
    }
  });
  if (!link) return { shape: "posting", blocked: "the only way on from this page is a button, and pressing an unidentified control on an employer's site can send an application" };
  return { shape: "posting", onward: link.href, text: link.text };
}
