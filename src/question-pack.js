/**
 * The questions this bot could not answer, and the answers the applicant
 * gave them.
 *
 * Every parked application ends at a question: a required box whose
 * answer no stored fact reaches, or one the model was not allowed to
 * guess at. Until now that question existed only inside a handoff
 * message - "required candidate information needs review: ..." - which
 * is a sentence in a log, not something anybody can answer. So the same
 * question parked the same application every night, and the only way to
 * fix one was to notice it in the log, work out the phrasing, and write
 * an `answerBank` line by hand.
 *
 * This file is that loop closed. A question nobody could answer is
 * written down with the form it came off; the applicant answers it once
 * on the Questions page; and the next form to ask it is filled from
 * that answer instead of parking. `profile.answerBank` still exists and
 * still wins - it is the applicant writing a rule on purpose, where this
 * is the applicant answering what they were asked.
 *
 * Nothing here talks to the database or to Chrome. It is the matching
 * and the merging, which is the part that has to be right.
 */

/** Everything that is not a word, collapsed, so spacing and punctuation cannot split one question into two. */
const normalise = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9'?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The employer's name taken out of the question.
 *
 * "Do you know anyone who works at Smartsheet?" and the same question
 * from Datadog are one question, and an applicant who had to answer it
 * once per employer would be doing the work this file exists to remove.
 * So the company name becomes a placeholder and the answer covers every
 * employer that asks it.
 *
 * Only the name actually on the application is removed, never a guess at
 * which words might be a company: "do you have a Series 7" keeps every
 * word it has. A one or two character name is left alone as well, since
 * taking "we" or "X" out of a sentence changes a different sentence.
 */
export function templateQuestion(question, company = "") {
  const asked = normalise(question);
  const name = normalise(company);
  if (!asked) return "";
  if (name.length < 3) return asked;
  // Longest-first so "Acme Health" is replaced whole rather than leaving
  // "health" behind as a word the next employer's question cannot match.
  const parts = [name, ...name.split(" ").filter((word) => word.length >= 4)].sort((a, b) => b.length - a.length);
  let templated = asked;
  for (const part of parts) {
    templated = templated.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "{company}");
  }
  // "{company} {company}" from a name repeated in one sentence is still one question.
  return templated.replace(/(?:\{company\} )+\{company\}/g, "{company}").trim();
}

/**
 * The identity of a question, as stored.
 *
 * The templated text and nothing else. Not the field's name or id -
 * Greenhouse calls the same question `question_12345` on one posting and
 * `question_98765` on the next, so keying on those would store the same
 * question once per employer and answer none of them.
 */
export const questionKey = (question, company = "") => templateQuestion(question, company);

/** Is this stored entry answered? An entry exists from the moment it is asked; the answer arrives later. */
export const isAnswered = (entry) => String(entry?.answer ?? "").trim() !== "";

/**
 * A question seen on a form, folded into whatever the pack already holds.
 *
 * Asking again never touches an answer that is already there and never
 * resets the entry - it bumps the count and the timestamp and records
 * the employer. The count is the whole of the triage on the Questions
 * page: a question that has parked eleven applications is worth a
 * minute, and one seen once on a posting nobody wants is not.
 */
export function recordQuestion(pack, sighting, now = Date.now()) {
  const { question, company = "", options = [], required = false, type = "", url = "", reason = "" } = sighting ?? {};
  const key = questionKey(question, company);
  if (!key) return pack;
  const existing = pack[key];
  const employers = new Set(existing?.employers ?? []);
  if (String(company).trim()) employers.add(String(company).trim());
  pack[key] = {
    key,
    // The first wording seen, kept verbatim, because the templated key is
    // unreadable and the page has to show a person an actual question.
    question: existing?.question ?? String(question ?? "").trim(),
    answer: existing?.answer ?? "",
    // Whether the answer came from the applicant or was carried in from
    // an older answerBank line, which the page says out loud.
    source: existing?.source ?? "",
    options: existing?.options?.length ? existing.options : options,
    type: existing?.type || type,
    required: Boolean(existing?.required || required),
    reason: reason || existing?.reason || "",
    url: existing?.url || url,
    employers: [...employers].slice(0, 50),
    asked: (existing?.asked ?? 0) + 1,
    firstAskedAt: existing?.firstAskedAt ?? now,
    lastAskedAt: now,
    answeredAt: existing?.answeredAt ?? 0,
    usedCount: existing?.usedCount ?? 0,
  };
  return pack;
}

/** The applicant's answer to one stored question. An empty answer puts it back on the unanswered list. */
export function answerQuestion(pack, key, answer, now = Date.now()) {
  const entry = pack[key];
  if (!entry) return pack;
  const given = String(answer ?? "").trim();
  pack[key] = { ...entry, answer: given, source: given ? "applicant" : "", answeredAt: given ? now : 0 };
  return pack;
}

/**
 * The stored answer for a question a form is asking, or nothing.
 *
 * Exact on the templated key, which is the only safe match. A fuzzy one
 * would eventually answer a question the applicant never read with words
 * they wrote for a different one, and the cost of that is a wrong answer
 * on a real employer's form under their name. A question worded a new
 * way is a new entry, asked once and answered once.
 */
export function packAnswer(pack, question, company = "") {
  const entry = pack?.[questionKey(question, company)];
  return isAnswered(entry) ? entry.answer : "";
}

/**
 * The answer with the employer's name written back into it.
 *
 * The stored answer may carry the placeholder - "I have no connection to
 * {company}" - because the applicant answered it on a form from somebody
 * else. Left as it is, that is what the next employer reads.
 */
export const fillCompany = (answer, company = "") => String(answer ?? "").replace(/\{company\}/g, String(company ?? "").trim());

/**
 * Applications parked on a question, where every question they parked on
 * now has an answer.
 *
 * The point of the whole file. An answer typed on the Questions page is
 * worth nothing until the application it was typed for is tried again,
 * and nobody is going to remember which of last night's parked jobs was
 * waiting on which question.
 *
 * Settled outcomes are never resumed. An application that reached submit
 * is finished whatever questions it asked along the way, and sending it
 * twice under the candidate's name is the one mistake here that cannot
 * be taken back - so this reads as a deny list of outcomes rather than
 * an allow list of parked stages, which would resume a stage added later
 * and never added to the list.
 */
const SETTLED = new Set(["submitted", "unconfirmed", "duplicate", "closed", "applying"]);

export function unblocked(jobs, pack) {
  return (jobs ?? []).filter((job) => {
    const keys = job?.blockedBy ?? [];
    return keys.length > 0 && !SETTLED.has(job.stage) && keys.every((key) => isAnswered(pack?.[key]));
  });
}

/** Unanswered first, then by how many applications the question has cost. */
export const triage = (pack) =>
  Object.values(pack ?? {}).sort(
    (a, b) => Number(isAnswered(a)) - Number(isAnswered(b)) || (b.asked ?? 0) - (a.asked ?? 0) || (b.lastAskedAt ?? 0) - (a.lastAskedAt ?? 0),
  );

/** How the page and the run log describe the pack in one line. */
export function packSummary(pack) {
  const all = Object.values(pack ?? {});
  const answered = all.filter(isAnswered);
  return {
    total: all.length,
    answered: answered.length,
    waiting: all.length - answered.length,
    // Applications these questions have parked and would park again.
    blocking: all.filter((entry) => !isAnswered(entry)).reduce((count, entry) => count + (entry.asked ?? 0), 0),
    used: answered.reduce((count, entry) => count + (entry.usedCount ?? 0), 0),
  };
}
