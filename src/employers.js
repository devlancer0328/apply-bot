/**
 * How many applications one employer may receive in a day, and how far apart.
 *
 * The bot used to allow exactly one application per employer, ever. That rule
 * was never about politeness; it was about not looking like a machine. But it
 * also set the ceiling on the whole operation, because it made the day's
 * target a demand for that many *distinct never-applied employers*: three
 * hundred a day is nine thousand employers a month, and no feed the applicant
 * has access to carries that. The binding constraint was supply, and this
 * rule was most of it.
 *
 * Three roles at one employer is ordinary candidate behaviour - people apply
 * to the two or three openings they fit at a company they want to work for -
 * so the rule becomes a budget rather than a prohibition. What made the old
 * rule worth having is kept in two narrower forms. The exact posting is still
 * refused forever, by job identity rather than by employer, which is the
 * history index's job and not this file's. And the applications to one
 * employer are held apart in time, because three forms from one address
 * inside a minute is the signal a recruiter's tooling notices, where three
 * across an afternoon is not.
 *
 * The budget is a calendar day and resets with it. A reservation is taken
 * when a job is chosen rather than when its form opens, so two preparations
 * running at once cannot both read the last free slot; a preparation that
 * dies before reaching a form gives its reservation back, because a resume
 * that failed to generate should not cost the employer a slot for the day.
 *
 * An employer is counted under every identity it is known by at once - its
 * folded name and its slug on each board - because "Acme" reached through
 * Jobright and `boards.greenhouse.io/acme` reached through its own careers
 * page are one employer with two names, and budgeting them separately would
 * quietly allow double the intended number.
 */

import { companyIdentityKeys } from "./companies.js";
import { dayKey } from "./schedule.js";

export function employerDay({ limit = 3, gapMs = 0, now = () => Date.now() } = {}) {
  const used = new Map(), stamps = new Map(), bars = new Set();
  let day = dayKey(now());
  const keysOf = (company, urls = []) => companyIdentityKeys({ company, urls: (urls || []).filter(Boolean) });
  // A day that rolled over mid-run would otherwise leave yesterday's tallies
  // standing and spend the new day's budget on them, so the roll is checked
  // on every read rather than on a timer the service worker may not survive.
  const roll = (at) => { const today = dayKey(at); if (today !== day) { day = today; used.clear(); stamps.clear(); } };
  const peak = (keys, map) => keys.reduce((most, key) => Math.max(most, map.get(key) || 0), 0);
  const add = (keys, count) => keys.forEach((key) => used.set(key, Math.max(0, (used.get(key) || 0) + count)));
  const stop = (keys) => keys.some((key) => bars.has(key));
  return {
    get day() { return day; },
    /** Never this employer again, whatever the posting. For imported exclusions. */
    bar(company, urls = []) { keysOf(company, urls).forEach((key) => bars.add(key)); },
    excluded(company, urls = []) { return stop(keysOf(company, urls)); },
    count(company, urls = []) { roll(now()); return peak(keysOf(company, urls), used); },
    /**
     * Slots left today. An employer whose identity cannot be resolved at all
     * is not budgeted here: the callers refuse those outright for a better
     * reason than this one, and returning zero would read as "quota spent".
     */
    room(company, urls = []) {
      roll(now());
      const keys = keysOf(company, urls);
      if (!keys.length) return limit;
      return stop(keys) ? 0 : Math.max(0, limit - peak(keys, used));
    },
    claim(company, urls = []) {
      roll(now());
      const keys = keysOf(company, urls);
      if (!keys.length) return true;
      if (stop(keys) || peak(keys, used) >= limit) return false;
      add(keys, 1);
      return true;
    },
    release(company, urls = []) { roll(now()); add(keysOf(company, urls), -1); },
    /** An application already made today, read back from the record at run start. */
    seed(company, urls = [], at = now()) {
      roll(now());
      if (dayKey(at) !== day) return;
      const keys = keysOf(company, urls);
      add(keys, 1);
      keys.forEach((key) => stamps.set(key, Math.max(stamps.get(key) || 0, at)));
    },
    /** The moment this employer last saw a form open, which is what spaces them. */
    started(company, urls = [], at = now()) { roll(at); keysOf(company, urls).forEach((key) => stamps.set(key, at)); },
    waitMs(company, urls = [], at = now()) {
      roll(at);
      return gapMs > 0 ? Math.max(0, peak(keysOf(company, urls), stamps) + gapMs - at) : 0;
    },
  };
}
