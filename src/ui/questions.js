/**
 * The Questions page: every question the bot could not answer, and the
 * box the applicant answers it in.
 *
 * The answering happens here and not on the employer's form on purpose.
 * A form only exists while its tab is open, so an application that waits
 * for a person waits with a browser tab held hostage, and by the time
 * anybody looks the posting has been open for nine hours. Here the
 * question outlives the attempt: the application parks, the question is
 * written down, the applicant answers it whenever they get to it, and
 * the job is offered back with the answer already in the pack.
 *
 * It is also how the pack gets built. The hundredth application asks
 * almost nothing new, because the first ninety-nine wrote their
 * questions down here and each was answered once.
 */
import { h, head, button } from "./helpers.js";
import { isAnswered, packSummary, triage, unblocked } from "../question-pack.js";

/** Multiple choice where the form offered a list, free text otherwise. */
function answerInput(entry) {
  const id = `answer-${h(entry.key)}`;
  if (entry.options?.length) {
    // The blank stays available after answering: it is how an answer is
    // taken back, and a radio group with no empty option cannot be.
    return `<select id="${id}" class="answer-input" data-key="${h(entry.key)}">
      <option value="">Not answered yet…</option>
      ${entry.options.map((option) => `<option value="${h(option)}" ${entry.answer === option ? "selected" : ""}>${h(option)}</option>`).join("")}
    </select>`;
  }
  const long = (entry.type === "textarea") || String(entry.question ?? "").length > 120;
  return long
    ? `<textarea id="${id}" class="answer-input" data-key="${h(entry.key)}" rows="3" placeholder="Your answer…">${h(entry.answer)}</textarea>`
    : `<input id="${id}" class="answer-input" data-key="${h(entry.key)}" type="text" value="${h(entry.answer)}" placeholder="Your answer…">`;
}

/**
 * Who asked, and how often.
 *
 * The count is the triage: a question that has parked eleven
 * applications is worth a minute of somebody's evening and one seen once
 * on a posting nobody wants is not.
 */
function provenance(entry) {
  const employers = (entry.employers ?? []).slice(0, 4);
  const more = (entry.employers?.length ?? 0) - employers.length;
  return [
    `asked ${entry.asked ?? 1}×`,
    employers.length ? `${employers.map(h).join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "",
    entry.required ? "required" : "optional",
    isAnswered(entry) && entry.usedCount ? `filled ${entry.usedCount} form${entry.usedCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
}

function card(entry) {
  const answered = isAnswered(entry);
  return `<div class="card" data-question="${h(entry.key)}">
    <div class="card-head">
      <h2>${h(entry.question)}</h2>
      <span class="pill ${answered ? "green" : "amber"}">${answered ? "Answered" : "Waiting"}</span>
    </div>
    <p class="hint">${h(provenance(entry))}${entry.reason ? ` · ${h(entry.reason)}` : ""}</p>
    ${answerInput(entry)}
    <div class="actions">
      ${button("save-answer", "Save answer", "primary", `data-key="${h(entry.key)}"`)}
      ${button("forget-question", "Remove", "quiet", `data-key="${h(entry.key)}"`)}
    </div>
  </div>`;
}

/**
 * The jobs waiting on nothing but a run.
 *
 * Shown as a count and one button rather than a list to tick through.
 * The applicant has already made every decision this needs by answering
 * the questions; asking them to also pick which jobs that applies to is
 * asking the same question twice.
 */
function resumeBar(jobs, pack) {
  const ready = unblocked(jobs, pack);
  if (!ready.length) {
    return `<section class="card"><h2>Parked applications</h2><p class="muted">Nothing is waiting on an answer right now. Applications that stop on a question will appear here, and answering it offers them back.</p></section>`;
  }
  const names = [...new Set(ready.map((job) => job.company).filter(Boolean))].slice(0, 6);
  return `<section class="card"><h2>${ready.length} application${ready.length === 1 ? "" : "s"} can go again</h2>
    <p class="muted">Every question ${ready.length === 1 ? "this one" : "these"} stopped on now has an answer${names.length ? `: ${h(names.join(", "))}` : ""}. They go back in the queue and the next run takes them - nothing is sent until then.</p>
    <div class="actions">${button("resume-unblocked", `Queue ${ready.length} application${ready.length === 1 ? "" : "s"}`, "primary")}</div>
  </section>`;
}

export function questions({ questions: rows = [], jobs = [] }) {
  const pack = Object.fromEntries(rows.map((row) => [row.key ?? row.id, row]));
  const summary = packSummary(pack);
  const sorted = triage(pack);
  const waiting = sorted.filter((entry) => !isAnswered(entry));
  const answered = sorted.filter(isAnswered);
  return head(
    "ANSWER ONCE, FILL FOREVER",
    "Questions",
    "Questions no stored fact could answer. Answer one here and every form that asks it again is filled from your answer.",
  ) + `
    <div class="stats">
      <div class="stat"><small>Waiting for you</small><strong>${summary.waiting}</strong><span>questions nothing could answer</span></div>
      <div class="stat"><small>Answered</small><strong>${summary.answered}</strong><span>in your answer pack</span></div>
      <div class="stat"><small>Applications stopped</small><strong>${summary.blocking}</strong><span>by the questions still waiting</span></div>
      <div class="stat"><small>Forms filled</small><strong>${summary.used}</strong><span>from answers you gave once</span></div>
    </div>
    ${resumeBar(jobs, Object.fromEntries(Object.entries(pack).filter(([, entry]) => isAnswered(entry))))}
    ${waiting.length
      ? `<h2>Waiting for an answer</h2>${waiting.map(card).join("")}`
      : `<section class="card"><h2>Nothing to answer</h2><p class="muted">Every question a form has asked has an answer. New ones appear here the moment an application stops on one.</p></section>`}
    ${answered.length ? `<h2>Answered</h2>${answered.map(card).join("")}` : ""}
  `;
}
