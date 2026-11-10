/**
 * Operating an ordinary application form, which is what every board we
 * support turns out to be.
 *
 * ## Why this is the engine's default rather than a mixin
 *
 * Greenhouse and Workable were written as separate adapters and came out
 * holding six identical methods between them - inspect, fill, verify,
 * uploadsSettled, menuOptions, submit - each a one-line call into
 * `window.__ghApply`, the filler injected from `src/fill.js`. Writing Ashby
 * third would have made it three copies, which is the point at which a
 * duplicate stops being a coincidence and starts being a statement about
 * the defaults.
 *
 * The defaults were wrong. They refused: `inspect` returned nothing,
 * `submit` answered "this adapter cannot press Submit". That reads as
 * caution and is not - it meant the only way for an adapter to do the
 * ordinary thing was to re-implement the ordinary thing, so every adapter
 * paid for a safety property it did not want. And the property was already
 * held somewhere better: `capabilities` is what the engine checks before it
 * fills anything, and an adapter that genuinely cannot submit says so there
 * and is parked before a single field is typed. Encoding the same judgement
 * twice meant the second copy was the one getting in the way.
 *
 * So the default is now the common case, stated once. An adapter overrides
 * a method when its board does something else, and says nothing when it
 * does not - which leaves an adapter as what it should always have been:
 * the part that is actually particular to the board.
 *
 * ## What is genuinely board-specific, and therefore not here
 *
 * Detection, and reaching the form. Everything else the three boards do
 * differently turned out to be differently *shaped* rather than different:
 * Greenhouse's email code boxes and Workable's network receipt are both
 * read by functions that return null on a board that does not use them, so
 * asking every board about both costs nothing and means neither board needs
 * its own copy of the loop to ask.
 */

import { OUTCOMES } from "./contract.js";
import { captchaShowing, frameText, humanCheckShowing } from "./signals.js";
import { newConfirmation } from "../submission-evidence.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A complaint has to stay on screen this long before it is a refusal. */
const COMPLAINT_MS = 4000;

/** Gap between two passes over the page while waiting for it to say something. */
const POLL_MS = 600;

/**
 * How long the one question worth re-asking gets after the budget is gone.
 *
 * Short, because this is the tail of a read that has already overrun, and
 * long enough for a frame that has finished navigating to answer once.
 */
const GRACE_MS = 5000;

/**
 * A page question, abandoned when it stops being worth waiting for.
 *
 * Every read below goes through this, and the reason is a measurement: a
 * Greenhouse form served inside a company's careers page took a hundred
 * and twenty-nine seconds to finish a twenty-second outcome read. The
 * budget was never wrong; it was never applied. `inFrame` enumerates every
 * frame on the page and an embedded board that is mid-navigation answers
 * none of them, so a loop that consults the clock only between iterations
 * can spend six applications' worth of a slot inside one iteration of it.
 *
 * An abandoned question reads as null, which is deliberately the same
 * thing a failed question already read as - "the page did not say" rather
 * than "the page said no". Nothing downstream turns silence into a
 * refusal, so a read cut short can cost a receipt and can never invent a
 * rejection. The dangling work is left to settle into the void; it holds
 * no slot and its answer is simply no longer wanted.
 */
const within = (ms, work) => {
  if (!(ms > 0)) return Promise.resolve(null);
  let timer;
  const asked = Promise.resolve().then(work).catch(() => null);
  return Promise.race([asked, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
};

/** In-page helper, or null where the filler has not been injected. */
const ask = (browser, tabId, frameId, fn, args) => browser.inFrame(tabId, frameId, fn, args).catch(() => null);

export const formOps = {
  /**
   * The form, wherever it turns out to be.
   *
   * Every frame is asked rather than the top one, and the busiest answer
   * wins. A board served inside a company's careers page has no form in the
   * top frame at all, and that is the ordinary case rather than the
   * exception - judging from the top frame is how an embedded form reads as
   * an empty page.
   */
  async inspect({ browser, tabId }) {
    await browser.inject(tabId, ["src/fill.js"]);
    const frames = await browser.inFrame(tabId, undefined, () => (window.__ghApply ? window.__ghApply.inventory() : null));
    const best = frames.filter((frame) => frame.result?.fields?.length > 0).sort((a, b) => b.result.fields.length - a.result.fields.length)[0];
    return best ? { frameId: best.frameId, fields: best.result.fields } : null;
  },

  fill: ({ browser, tabId, frameId, fills, attachments }) =>
    browser.inFrame(tabId, frameId, (payload) => window.__ghApply.apply(payload), [{ fills, attachments }]),

  verify: ({ browser, tabId, frameId }) => browser.inFrame(tabId, frameId, () => window.__ghApply.verify()),

  uploadsSettled: ({ browser, tabId, frameId }) => browser.inFrame(tabId, frameId, () => window.__ghApply.uploadsSettled()),

  menuOptions: ({ browser, tabId, frameId, key }) => browser.inFrame(tabId, frameId, (name) => window.__ghApply.menuOptions(name), [key]),

  submit: ({ browser, tabId, frameId }) => browser.inFrame(tabId, frameId, () => window.__ghApply.submit()),

  enterCode: ({ browser, tabId, frameId, code }) => browser.inFrame(tabId, frameId, (value) => window.__ghApply.enterCode(value), [code]),

  /**
   * What the board did with the application.
   *
   * Five questions asked in one order, and the order is the whole of the
   * judgement:
   *
   * A confirmation line that was not on the page before is the best answer
   * there is, so it is asked for first and quoted rather than paraphrased.
   *
   * Code boxes come next, and deliberately before the network. A board that
   * answers 2xx and then asks for an emailed code has not taken the
   * application - it has parked it - and reading the status first would
   * file a pending application as a sent one.
   *
   * Then the board's own request. A 2xx to its application endpoint is a
   * receipt from the only party that knows, which is why a board that says
   * nothing on screen still reaches `confirmed` instead of being guessed at.
   *
   * Then a captcha, which is a person's job.
   *
   * Then complaints, but only ones that persist. Messages from a refused
   * first attempt are still on screen while a resubmit is in the air; read
   * at once they would call a sent application failed.
   *
   * And silence is `uncertain`, never `rejected`. The application may have
   * gone, the company stays protected, and a person looks - because
   * pressing Submit twice is the one mistake this must never make.
   */
  async readOutcome({ browser, tabId, frameId, before = [], timeoutMs = 20000 }) {
    const deadline = Date.now() + timeoutMs;
    const left = () => deadline - Date.now();
    let complainedAt = 0;

    while (left() > 0) {
      await pause(Math.min(POLL_MS, left()));

      const receipt = (await within(left(), () => frameText(browser, tabId)) ?? []).map((text) => newConfirmation(text, before)).find(Boolean);
      if (receipt) return { status: OUTCOMES.CONFIRMED, receipt };

      // Empty boxes are a prompt for a code. Full ones are the code this
      // attempt just typed, with the page still deciding, which is waiting.
      const verification = await within(left(), () => ask(browser, tabId, frameId, () => (window.__ghApply ? window.__ghApply.verification() : null)));
      if (verification && !verification.filled) {
        return { status: OUTCOMES.CHALLENGE, challenge: { kind: "email-code", email: verification.email }, reason: "the board wants an emailed security code" };
      }

      const answer = await within(left(), () => ask(browser, tabId, frameId, () => (window.__ghApply ? window.__ghApply.sent() : null)));
      if (answer?.ok) return { status: OUTCOMES.CONFIRMED, receipt: `the board accepted the application (${answer.status} from ${pathOf(answer.url)})` };
      if (answer && answer.status >= 400) {
        return { status: OUTCOMES.REJECTED, complaints: `the board answered ${answer.status}`, reason: `the board answered ${answer.status} to the application` };
      }

      if (await within(left(), () => captchaShowing(browser, tabId))) {
        return { status: OUTCOMES.CHALLENGE, challenge: { kind: "captcha" }, reason: "the board put up a captcha puzzle after Submit" };
      }

      const complaints = await within(left(), () => ask(browser, tabId, frameId, () => (window.__ghApply ? window.__ghApply.complaints() : null)));
      if (complaints?.messages?.length > 0 || complaints?.invalid?.length > 0) {
        complainedAt ||= Date.now();
        if (Date.now() - complainedAt >= COMPLAINT_MS) {
          const said = [...(complaints.invalid ?? []), ...(complaints.messages ?? [])].join("; ");
          return { status: OUTCOMES.REJECTED, complaints: said, reason: `the form rejected the submission: ${said}` };
        }
      } else {
        complainedAt = 0;
      }
    }

    // The budget is spent, and exactly one answer is still worth paying for.
    // A page that was too busy to answer while the clock ran down is the
    // page most likely to have been busy *navigating to its own
    // confirmation*, so writing it off unread is how a sent application
    // loses its receipt. Nothing else is asked again: a complaint or a
    // captcha that could not be read in twenty seconds changes what a
    // person does, not what the run records, and both are already covered
    // by `uncertain` leaving the claim standing and the posting flagged.
    const grace = Date.now() + GRACE_MS;
    const receipt = (await within(GRACE_MS, () => frameText(browser, tabId)) ?? []).map((text) => newConfirmation(text, before)).find(Boolean);
    if (receipt) return { status: OUTCOMES.CONFIRMED, receipt };
    const answer = await within(Math.max(0, grace - Date.now()), () => ask(browser, tabId, frameId, () => (window.__ghApply ? window.__ghApply.sent() : null)));
    if (answer?.ok) return { status: OUTCOMES.CONFIRMED, receipt: `the board accepted the application (${answer.status} from ${pathOf(answer.url)})` };

    // What the page actually did, for the one outcome that cannot say why
    // it happened. Best-effort: a page that will not answer this is a page
    // that has already told us what we needed to know.
    const traffic = await within(2000, () => ask(browser, tabId, frameId, () => (window.__ghApply ? window.__ghApply.traffic() : null)));
    return { status: OUTCOMES.UNCERTAIN, reason: "pressed Submit, but no confirmation appeared; treated as sent", traffic };
  },
};

/**
 * Why this filled form must not be sent, or null when nothing says so.
 *
 * Asked from an adapter's `advance`, which is the last step before the
 * engine takes the duplicate claim and presses Submit, and that placement
 * is the whole value of it. Refusing from `submit` instead would be too
 * late twice over: the attempt is already marked as submitted by then, and
 * the company has already been claimed - so a form we declined to send
 * would leave the employer protected against the application nobody made.
 *
 * `strict` is what a generic adapter adds to a board-specific one. An
 * adapter that knows its board can let that board complain about a field
 * it reads as empty, because it knows what the complaint will look like
 * and the board is usually right. An adapter working from shape alone
 * knows neither, so an unanswered required field and a page offering two
 * plausible Submits are both "this form has not been understood" - and a
 * posting parked for a person costs one application, where a half-filled
 * one sent to a real employer cannot be taken back.
 */
export async function submitStop({ browser, tabId, frameId }, { strict = false } = {}) {
  if (await humanCheckShowing(browser, tabId)) return "the form carries a human check (captcha) that only a person can clear";
  if (!strict) return null;

  const unanswered = ((await ask(browser, tabId, frameId, () => (window.__ghApply ? window.__ghApply.verify() : null)))?.empty ?? [])
    .map((field) => field.label || field.key)
    .filter(Boolean);
  if (unanswered.length > 0) return `required field(s) on this form were not answered: ${unanswered.slice(0, 5).join("; ")}`;

  const choices = await ask(browser, tabId, frameId, submitChoices);
  if (!choices || choices.length === 0) return "no control on this page is recognisably the one that sends the application";
  if (choices.length > 1) return `more than one control could be the one that sends the application (${choices.join("; ")})`;
  return null;
}

/**
 * Runs in the page. The distinct wordings of every visible control that
 * could be the Submit, which is how a form gets to say it is ambiguous.
 *
 * Wording rather than element, because a board that draws its Submit twice
 * - once in a sticky footer, once at the end of the form - is offering one
 * choice, not two, and `findSubmit` would take either. Two *different*
 * words is the case worth stopping on: a page carrying both "Submit
 * application" and "Apply with LinkedIn" has a cheap wrong answer on it.
 *
 * Exported for the same reason as `probeForm`: whether this false-positives
 * on a real page decides whether a whole board parks, and that can only be
 * answered by running this exact function against real pages.
 */
export function submitChoices() {
  const seen = new Set();
  for (const node of document.querySelectorAll("button, input[type='submit'], [role='button'], a.btn, a[href='#']")) {
    const label = String(node.innerText || node.textContent || node.value || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 60 || !/^(?:submit|apply|send)\b|submit (?:your )?application/i.test(label)) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    seen.add(label.toLowerCase());
  }
  return [...seen];
}

/** The path of an address, or the address itself when it will not parse. */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}
