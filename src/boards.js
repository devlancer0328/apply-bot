/**
 * The other roles at an employer the bot already knows about.
 *
 * Both feeds are curated lists: Jobright recommends, Hiring Cafe searches,
 * and each returns roughly one posting per employer because that is what a
 * list of recommendations is for. That was fine while the rule was one
 * application per employer, and became the binding constraint the moment
 * the rule changed - there is no point allowing three roles at a company if
 * the feed only ever names one of them.
 *
 * Greenhouse, Lever and Ashby each publish the whole job board of a company
 * at a fixed address, with no key and no sign-in, because that is how the
 * company's own careers page is built. So once a feed has named one posting
 * at an employer, the rest of that employer's openings can be read directly
 * from the board for the cost of a single request - and every one of them
 * arrives with a real application address on a board this bot fills, which
 * is not true of anything either feed returns.
 *
 * That inverts the supply problem rather than easing it. The old arithmetic
 * decayed: every application spent an employer, so the pool shrank as the
 * history grew. A roster built from the employers already seen refills
 * instead - each one is a board that publishes new postings on its own
 * schedule, for as long as the company is hiring - so a longer history
 * means more boards to read, not fewer employers left.
 *
 * Only the three boards with a public list endpoint are here. Workday
 * publishes per-tenant search APIs that differ between tenants and want a
 * POST body shaped to the tenant's own facets; Workable and ApplyToJob have
 * no documented list address. Guessing at those would turn a quiet
 * no-result into a run that spends its day on 404s, so they are left out
 * and the roster simply skips them.
 */

import { employerKeys } from "./companies.js";

const LIMIT = 8000;

/** A board and the employer's slug on it, read off any posting address. */
export function boardSlug(url) {
  const [key] = employerKeys(url);
  if (!key) return null;
  const [, board, slug] = key.split(":");
  return ROSTERS[board] && slug ? { board, slug } : null;
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Each board's list address and how to read one row of its answer.
 *
 * The apply address is taken as the board gave it. A Greenhouse board that
 * has been pointed at a hosting service answers with that service's address
 * rather than a greenhouse.io one, and rewriting it back would send the run
 * to a page the employer no longer uses; the caller names the board from
 * the address it got, not from the roster it came out of.
 */
const ROSTERS = {
  greenhouse: {
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    rows: (data) => data?.jobs,
    // A Greenhouse board gives `absolute_url` as wherever the employer
    // chose to show the posting, which for a third of the boards measured
    // is their own careers page or a hosting service. Those addresses carry
    // no board, no job identity and no form, so the run would file them as
    // "site not named" and open a tab to find out. The board and the id are
    // both already in hand, and the address built from them is the one the
    // posting API and the filler both understand.
    read: (row, slug) => ({ applyUrl: /^\d+$/.test(String(row.id)) ? `https://job-boards.greenhouse.io/${slug}/jobs/${row.id}` : text(row.absolute_url), title: text(row.title), location: text(row.location?.name) }),
  },
  lever: {
    url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    rows: (data) => data,
    read: (row) => ({ applyUrl: text(row.applyUrl) || text(row.hostedUrl), title: text(row.text), location: text(row.categories?.location) }),
  },
  ashby: {
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    rows: (data) => data?.jobs,
    read: (row) => ({ applyUrl: text(row.applyUrl) || text(row.jobUrl), title: text(row.title), location: text(row.location) }),
  },
};

/**
 * Every open posting on one employer's board.
 *
 * A board that answers 404 is an employer that has closed its board or
 * renamed its slug, and is reported as an empty roster rather than as a
 * failure: one dead slug out of two hundred must not be able to stop a
 * discovery round. Anything else - a timeout, a 500, a body that is not the
 * shape this board documents - is thrown, because a source that has started
 * answering differently is worth seeing in the log rather than reading as
 * "this employer has no jobs".
 */
export async function boardRoster({ board, slug }, { fetch: get = fetch, timeoutMs = 12000 } = {}) {
  const roster = ROSTERS[board];
  if (!roster || !slug) return [];
  const response = await get(roster.url(slug), { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404 || response.status === 410) return [];
  if (!response.ok) throw new Error(`${board}'s job board API answered ${response.status} for ${slug}`);
  const rows = roster.rows(await response.json());
  // An empty board answers with an empty list, so a missing one means the
  // API has changed shape. Said out loud, because the alternative is a
  // roster that quietly reports every employer as having no openings.
  if (!Array.isArray(rows)) throw new Error(`${board}'s job board API returned an unreadable list for ${slug}`);
  return rows.slice(0, LIMIT).map((row) => roster.read(row, slug)).filter((row) => row.applyUrl && row.title);
}

/**
 * The employers worth reading, best first.
 *
 * An employer is worth a request when a posting of theirs has been seen and
 * the day's budget still has room for another role there; an employer whose
 * three are already spent would cost a request to learn nothing. Ordering
 * is by how much room is left, so that a run which gets through only part
 * of the roster spends its requests where the most applications can come
 * from.
 */
export function rosterSeeds(records = [], { room = () => 1 } = {}) {
  const seen = new Map();
  for (const record of records) {
    const { url, company = "" } = typeof record === "string" ? { url: record } : record || {};
    const found = boardSlug(url);
    if (!found) continue;
    const key = `${found.board}:${found.slug}`;
    // The employer's own name is kept from whichever record first named it,
    // because the board list APIs return titles and locations but never the
    // company: the slug is the only name the roster itself knows.
    if (!seen.has(key)) seen.set(key, { ...found, url, company: text(company) });
    else if (!seen.get(key).company) seen.get(key).company = text(company);
  }
  return [...seen.values()]
    .map((seed) => ({ ...seed, room: Math.max(0, Number(room(seed)) || 0) }))
    .filter((seed) => seed.room > 0)
    .sort((a, b) => b.room - a.room || a.slug.localeCompare(b.slug));
}

// Words that appear in every other job title and so distinguish nothing.
const NOISE = /^(?:senior|sr|junior|jr|staff|principal|lead|head|director|manager|associate|assistant|chief|vp|vice|president|i|ii|iii|iv|the|of|and|for|with|to|at|in|on|a|an|remote|hybrid|onsite|us|usa|united|states|full|part|time|contract|intern|internship|new|grad|graduate|level|entry|mid|team|global|regional)$/i;

const words = (value) => String(value || "").toLowerCase().split(/[^a-z0-9+#]+/).filter((word) => word.length > 1 && !NOISE.test(word));

/**
 * Which of an employer's openings this applicant would actually apply to.
 *
 * A job board is the whole company, not the engineering team: of the five
 * hundred and eighty-one postings measured across fifteen employers, barely
 * half had an engineering title and the rest were sales, finance and
 * support. The feeds never had this problem because they were already
 * filtered to the applicant, and dropping an unfiltered board into the same
 * queue would spend the day's quota writing tailored resumes for an
 * accounts payable role.
 *
 * The filter is the applicant's own history rather than a list of job
 * titles kept in this file: the roles they have already applied to are the
 * best available statement of what they are looking for, they cost nothing
 * to collect, and they stay right when the applicant changes direction. A
 * posting has to share words that are not furniture - "senior", "remote"
 * and "manager" are in every title and separate nothing - and the ones
 * sharing most come first. With no history to go on nothing is dropped,
 * because an empty vocabulary is not evidence that a posting is wrong.
 *
 * ## Why a share of the title and not a single word
 *
 * One shared word was the original bar, and it sent a software engineer to
 * "Enterprise Account Executive" - matched on "enterprise", which had
 * entered the vocabulary from "Full Stack Software Engineer - Enterprise".
 * Because the vocabulary is built from the run's own history, that sale
 * then taught it "account" and "executive", and the next round matched
 * sales roles outright. A single incidental word is enough to start a
 * drift that feeds itself.
 *
 * So the test is most of what the title says, not any of it: at least half
 * a posting's distinguishing words have to be words this applicant pursues.
 * "Site Reliability Engineer" keeps all three and stays; "Enterprise
 * Account Executive" keeps one of three and goes. That is a property of
 * the overlap rather than a list of banned departments, so it needs no
 * maintenance as the applicant moves between kinds of engineering.
 */
export function relevantPostings(postings = [], { reference = [], perEmployer = 0, share = 0.4 } = {}) {
  const vocabulary = new Set(reference.flatMap(words));
  // How many of the applicant's titles each word appears in. "engineer" is
  // in every one of them and names the work; "enterprise" was in a single
  // title and is scenery. A word carried by a third of the history is
  // treated as naming the discipline, and one of those is enough on its
  // own - otherwise "Machine Learning Engineer" is dropped for saying two
  // things the history has not said yet, which is the opposite of the point.
  const spread = new Map();
  for (const title of reference) for (const word of new Set(words(title))) spread.set(word, (spread.get(word) ?? 0) + 1);
  const core = new Set([...spread].filter(([, seen]) => seen >= Math.max(2, reference.length / 3)).map(([word]) => word));

  const scored = postings.map((posting) => {
    const own = words(posting.title);
    const hits = own.filter((word) => vocabulary.has(word)).length;
    const anchored = own.some((word) => core.has(word));
    return { posting, score: vocabulary.size ? hits : 1, enough: vocabulary.size ? own.length > 0 && (anchored || hits / own.length >= share) : true };
  });
  const kept = scored.filter((row) => row.enough).sort((a, b) => b.score - a.score);
  const perSlug = new Map(), titles = new Set();
  return kept.filter((row) => {
    const slug = `${row.posting.board}:${row.posting.slug}`;
    // One posting per role per employer. Boards carry the same opening
    // several times over - Lever repeats a role verbatim and Greenhouse
    // splits one into "(Canada)" and "(UK)" - and three applications to one
    // company for one job is the thing the budget is meant not to become,
    // so the qualifier in brackets is dropped before the titles are
    // compared. Different openings keep their own words and survive it.
    const role = `${slug}|${row.posting.title.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, "")}`;
    if (titles.has(role)) return false;
    const used = perSlug.get(slug) || 0;
    if (perEmployer > 0 && used >= perEmployer) return false;
    titles.add(role);
    perSlug.set(slug, used + 1);
    return true;
  }).map((row) => row.posting);
}

/**
 * Reads a run of employers' boards and returns their postings.
 *
 * Bounded three at a time: these are other people's APIs being asked for a
 * whole job board, and the run is not in a hurry for them - the postings go
 * into a queue that takes minutes per application. One board's failure is
 * recorded and the rest carry on, for the same reason `boardRoster` treats
 * a 404 as empty.
 */
export async function harvestBoards(seeds, { fetch: get = fetch, concurrency = 3, perEmployer = 0, log } = {}) {
  const postings = [], failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, seeds.length)) }, async () => {
    for (let i = next++; i < seeds.length; i = next++) {
      const seed = seeds[i];
      try {
        const rows = await boardRoster(seed, { fetch: get });
        const wanted = perEmployer > 0 ? rows.slice(0, perEmployer) : rows;
        for (const row of wanted) postings.push({ ...row, board: seed.board, slug: seed.slug, company: seed.company || "" });
      } catch (error) {
        failures.push({ ...seed, message: error?.message ?? String(error) });
        log?.("warn", `Could not read ${seed.board} board ${seed.slug}: ${error?.message ?? error}`);
      }
    }
  }));
  return { postings, failures, employers: seeds.length };
}
