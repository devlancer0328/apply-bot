/**
 * The roles the applicant will actually take, in their own words.
 *
 * Two filters already decided this and neither is the applicant's. The
 * board harvester infers it from history, which is automatic and therefore
 * drifts - one shared word walked a software engineer into "Enterprise
 * Account Executive" on 8 Nov, and because the vocabulary is built from the
 * run's own applications the drift compounded. And `screeningTitles` in
 * filters.js does hold title phrases, but it only applies when
 * `screeningEnabled` is on, which also switches on the whole AI-researched
 * eligibility suite - so wanting a title filter meant buying a web-search
 * pass on every posting.
 *
 * This is the plain statement: a list of phrases, on or off by itself. When
 * it is on it is authoritative, because a person naming the jobs they want
 * outranks anything inferred from what they happened to apply to last week.
 * When it is off the automatic relevance is what remains, which is the
 * behaviour that existed before this module and is not nothing - a company
 * job board is mostly accounts payable and regional sales, and answering
 * "no role filter" with "apply to all of it" would be a worse bot, not a
 * freer one.
 *
 * Matching is substring, case-insensitive, on the posting title: "machine
 * learning" takes "Senior Machine Learning Engineer, Ranking" without the
 * applicant having to predict the seniority or the team.
 */

export const ROLE_DEFAULTS = { roleFilterEnabled: false, roleFilterTitles: "" };

/** The phrases, one per line or comma separated, blanks dropped. */
export const roleTerms = (value) =>
  String(value || "")
    .split(/[\n,;]/)
    .map((term) => term.trim())
    .filter(Boolean);

/**
 * Whether the filter has anything to say. An empty list with the switch on
 * is treated as off rather than as "allow nothing", because a filter that
 * silently rejects every posting looks exactly like a broken feed.
 */
export const roleFilterActive = (profile) =>
  profile?.roleFilterEnabled === true && roleTerms(profile.roleFilterTitles).length > 0;

/** Whether a posting's title is one of the roles the applicant asked for. */
export function roleAllowed(title, profile) {
  if (!roleFilterActive(profile)) return true;
  const subject = String(title || "").toLowerCase();
  return roleTerms(profile.roleFilterTitles).some((term) => subject.includes(term.toLowerCase()));
}

/** Why a posting was passed over, in the words the day's table will carry. */
export const roleRejection = (profile) =>
  `The title is not one of your roles (${roleTerms(profile.roleFilterTitles).join(", ")}).`;
