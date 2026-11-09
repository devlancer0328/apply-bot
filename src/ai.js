/** Application answers are grounded in the generated documents, profile facts and cited compensation research. */

import { callModel, ProviderError } from "./vendor/generation.js";
import { record } from "./spend.js";
import { isCompensationQuestion, hasCompensationResearch } from "./salary.js";
import { MODEL } from "./writer.js";

/**
 * Keeps a signed-out tab or a usage limit from looking like a hundred unanswerable forms.
 *
 * `fatal` separates the two things that used to be one. A ChatGPT tab that is
 * signed out or at its limit means the next job fails identically, so the run
 * should end rather than burn a page load per link proving it. A cut-off
 * answer or a page hiccup is about this question, and ending a queue of forty
 * over one of them is its own kind of wrong.
 */
export class AiError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.name = "AiError";
    this.fatal = fatal;
  }
}

/** Carried in the request shape; the tab has no token budget to set. */
const MAX_TOKENS = 4000;

/**
 * What is true of the candidate regardless of the job, stated outright.
 *
 * The resume is the model's main source, and its employers have cities. Asked
 * "where will you work from", a model with nothing else to go on answered
 * "San Francisco, where I've been based" - the city of the resume's last
 * employer - two fields below a location box that said Friendswood, Texas.
 * Inference from the resume is right for "describe your experience with X"
 * and wrong for anything about the person, so the facts about the person
 * come first and the model is told they win.
 */
function facts(context) {
  const lines = [
    context.location && `Lives in ${context.location}. This is where they are based and would work from.`,
    context.country && `Current country of residence: ${context.country}. This does not establish citizenship or work authorization.`,
    context.remotePreference && `Preferred working arrangement: ${context.remotePreference}.`,
    context.startDate && `Can start: ${context.startDate}.`,
    context.workAuthorization && `Work authorization: ${context.workAuthorization}.`,
    context.sponsorship && `Visa sponsorship: ${context.sponsorship}.`,
    context.relocation && `Relocation: ${context.relocation}.`,
    context.travel && `Travel: ${context.travel}.`,

    "Employment history and current employment status must be read from the resume's dates; do not assume the candidate is unemployed.",
    context.phone && `Phone: ${context.phone}.`,
    context.email && `Email: ${context.email}.`,
    ...(context.extraFacts ?? []),
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "";
}

/** Required fields still need supported candidate facts. */
const MUST = `- This field is required, but factual support is still required. If the supplied profile and resume cannot establish the answer, return exactly INSUFFICIENT.
- Never infer legal eligibility, licenses, personal relationships, demographic answers, dates, credentials or technology experience from silence.
- A required field is not permission to choose a default, a decline option, N/A, or the first available option.`;

/** Everything the model may draw on, in descending order of how much it knows about this job. */
function sources(context) {
  return [
    facts(context) && `FACTS ABOUT THE CANDIDATE (these override anything the resume implies):\n${facts(context)}`,
    context.letter && `COVER LETTER FOR THIS JOB:\n${context.letter.slice(0, 6000)}`,
    context.resume && `RESUME SUBMITTED WITH THIS APPLICATION:\n${context.resume.slice(0, 8000)}`,
    context.jd && `JOB DESCRIPTION:\n${context.jd.slice(0, 8000)}`,
    // Skipped when a tailored resume is present: the two describe the same
    // career, and the tailored one describes it as this application does.
    hasCompensationResearch(context.compensation) && `COMPENSATION WEB RESEARCH (the only source for pay answers; respect currency, period, location and base versus total):\n${JSON.stringify(context.compensation)}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

const PROSE = "Answer in first person, plain prose, no greeting and no sign-off. Keep it to roughly 80-150 words, in two or three short paragraphs separated by a blank line: the direct answer first, the specifics from the candidate's experience next, and one closing sentence on what it means for this role. No headings, no bullet points.";
const ONE_LINE = "This is a one-line box. Answer with a short phrase or a single short sentence - a title, a name, a number, a place - not a paragraph.";

/** How one question wants its answer shaped: an option off its list, prose, or a phrase. */
function shapeOf(question) {
  if (question.options && question.options.length > 0) {
    return `Answer with exactly one of these options, copied verbatim - the option text alone, with no reasoning before or after it:\n${question.options.map((option) => `- ${option.label || option.value}`).join("\n")}`;
  }
  return question.multiline ? PROSE : ONE_LINE;
}

/** The user's own guidance on answers, when any was given in settings. */
function ownRules(settings) {
  const own = String(settings?.answerInstructions ?? "").trim();
  return own ? `\n\nFURTHER INSTRUCTIONS FROM THE CANDIDATE:\n${own}` : "";
}

function prompt(question, context, must, settings) {
  const choices = `\n\n${shapeOf(question)}`;

  return `You are filling in one field of ${context.company || "a company"}'s application form for the ${
    context.title || "role"
  }, on behalf of the candidate described below. Write as the candidate.

${sources(context)}

---

FORM QUESTION: ${question.question}${choices}

Rules:
- Use only what the sources above support. Do not invent employers, dates, numbers or credentials.
- For compensation questions, reason from COMPENSATION WEB RESEARCH only. The AI chooses the appropriate answer for the requested range/amount, currency, period and base/total pay. Do not apply a default midpoint, invent a fallback, or treat an employer budget as candidate salary history. If unsupported or no offered option fits, return INSUFFICIENT even for REQUIRED fields.
- Where the candidate lives, works from, or can start comes only from FACTS ABOUT THE CANDIDATE, never from the cities of past employers on the resume.
${must ? MUST : "- No placeholders of any kind. If the sources cannot support an answer, reply with exactly: INSUFFICIENT"}
- Return only the answer text itself.${ownRules(settings)}`;
}

const labelsOf = (options) => (options ?? []).map((option) => option.label || option.value || String(option)).filter(Boolean);

/**
 * The option a reply names, when the reply is not simply the option.
 *
 * Asked to copy one entry verbatim, a reasoning model will sometimes think
 * aloud first and name its choice at the end - "...so the most reasonable
 * selection is: January". The choice is in there; this finds it. Exact
 * first, then the longest option the reply contains, then an option that
 * contains the whole reply. Null when the reply names nothing on the list.
 */
export function snapToOption(answer, options) {
  const labels = labelsOf(options);
  if (labels.length === 0) return null;
  const fold = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const reply = fold(answer);
  if (!reply) return null;

  const exact = labels.find((label) => fold(label) === reply);
  if (exact) return exact;

  const within = labels
    .filter((label) => fold(label).length >= 2 && reply.includes(fold(label)))
    .sort((a, b) => b.length - a.length)[0];
  if (within) return within;

  return labels.find((label) => fold(label).includes(reply)) ?? null;
}

/**
 * Answers one question, or returns null when it should be left alone.
 *
 * Null is a real outcome rather than a failure: a model that has nothing to go
 * on writes something plausible and false, and the caller can decide to skip an
 * optional field or abandon the job over a required one. A thrown AiError means
 * the service itself is unusable, which is a different problem and stops the
 * run instead of poisoning every remaining application.
 */
export async function answerQuestion(question, context, settings, { must = false } = {}) {
  // The same tab that wrote the resume answers the form. `settings` is the
  // profile, kept in the signature for the callers; nothing in it is a key.
  if (isCompensationQuestion(question.question) && !hasCompensationResearch(context.compensation)) return null;
  if (isCompensationQuestion(question.question)) must = false;
  let reply;
  // A page hiccup is a pause, not a verdict: tried again twice before it
  // counts as a failed answer. A signed-out tab or a usage limit is final.
  for (let attempt = 0; ; attempt += 1) {
    try {
      reply = await callModel({
        task: 'form-answers',
        provider: "openai",
        model: MODEL,
        apiKey: "",
        temperature: 0.4,
        maxTokens: MAX_TOKENS,
        format: "text",
        system: "You fill in one field of a job application form, writing as the candidate.",
        messages: [{ role: "user", content: prompt(question, context, must, settings) }],
      });
      break;
    } catch (error) {
      if (error instanceof ProviderError) {
        if ([401,402,403,409,412,429].includes(error.status)) throw new AiError(error.message, { fatal: true });
        if (error.status >= 500 && error.retryable!==false && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
          continue;
        }
        throw new AiError(error.message);
      }
      throw new AiError(error?.message ?? String(error));
    }
  }

  record(MODEL, reply);
  return settle(String(reply?.text ?? ""), question, must);
}

/**
 * A reply as it goes into the box: nothing for unsupported answers, an entry
 * off the list for a list question, paragraphs for a long box.
 */
function settle(raw, question, must) {
  if (isCompensationQuestion(question.question)) must = false;
  const answer = String(raw ?? "").trim();
  if (isCompensationQuestion(question.question) && /^(?:N\/A|not applicable|none|unknown|negotiable)$/i.test(answer)) return null;
  if (!answer || /^INSUFFICIENT\b/i.test(answer) || /^(?:N\/A|not applicable|unknown|prefer not to say|decline to (?:answer|self.identify))$/i.test(answer)) {
    // Missing evidence remains unanswered even when the form requires it.
    return null;
  }

  // Models like to wrap prose in quotes when told to return only the text.
  const cleaned = answer.replace(/^["'`]+|["'`]+$/g, "").trim();

  // A list question is answered with an entry on the list, or not at all.
  if (question.options && question.options.length > 0) {
    const snapped = snapToOption(cleaned, question.options);
    if (snapped) return snapped;
    return null;
  }

  // A box that asked for an account of something cannot be answered with a
  // yes. Where that happened the model had been told the box was one line -
  // which is what a board rendering a paragraph question as a long input
  // looks like from here - and "Paste your full resume text below" went to
  // DataCamp as the word "Yes". Nothing is better than that.
  if (question.multiline && /^(?:y|n|yes|no|true|false|n\/a|na|none)\.?$/i.test(cleaned)) return null;

  return question.multiline ? paragraphed(cleaned) : cleaned;
}

/**
 * The whole page's questions in one call.
 *
 * The sources - the letter, the resume, the posting - are most of every
 * prompt, and asking seven questions one at a time sent them seven times.
 * Sent once with the questions numbered, the reply is an object keyed by
 * number, each value the answer under that question's own rules. A question
 * the sources cannot support is INSUFFICIENT, unless it is marked as one the
 * form will not send without.
 */
function batchPrompt(questions, context, must, settings) {
  const asked = questions
    .map((question, index) => {
      const required = must.has(index);
      return `[${index + 1}]${required ? " (REQUIRED - unsupported facts must still be INSUFFICIENT)" : ""} ${question.question}\n${shapeOf(question)}`;
    })
    .join("\n\n");

  return `You are filling in ${questions.length} fields of ${context.company || "a company"}'s application form for the ${
    context.title || "role"
  }, on behalf of the candidate described below. Write as the candidate.

${sources(context)}

---

FORM QUESTIONS:

${asked}

Rules:
- Use only what the sources above support. Do not invent employers, dates, numbers or credentials.
- Where the candidate lives, works from, or can start comes only from FACTS ABOUT THE CANDIDATE, never from the cities of past employers on the resume.
- For a question not marked REQUIRED: no placeholders of any kind; if the sources cannot support an answer, its value is exactly "INSUFFICIENT".
${must.size > 0 ? MUST.replace(/^- This field is REQUIRED[^\n]*\n/, "- For a question marked REQUIRED, answer it:\n") : ""}
- Reply with a JSON object only, no commentary: the keys are the question numbers as strings ("1", "2", ...), every question present, each value the answer text for that question alone.${ownRules(settings)}`;
}

/** The object in a reply that was asked for one, however it was wrapped. */
export function parseAnswers(text) {
  const raw = String(text ?? "").trim();
  const candidates = [raw, raw.replace(/^```(?:json)?\s*|\s*```$/g, ""), raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // The next shape may parse.
    }
  }
  return null;
}

/**
 * One call for a list of questions; null when the reply could not be read
 * as answers, in which case the caller falls back to asking one at a time.
 */
async function answerBatch(questions, context, settings, must) {
  let reply;
  for (let attempt = 0; ; attempt += 1) {
    try {
      reply = await callModel({
        task: 'form-answers',
        provider: "openai",
        model: MODEL,
        apiKey: "",
        temperature: 0.4,
        // Room for the thinking a reasoning model does first, then a page of answers.
        maxTokens: Math.min(16000, MAX_TOKENS + 1200 * questions.length),
        system: "You fill in the fields of a job application form, writing as the candidate, and reply with a JSON object.",
        messages: [{ role: "user", content: batchPrompt(questions, context, must, settings) }],
      });
      break;
    } catch (error) {
      if (error instanceof ProviderError) {
        if ([401,402,403,409,412,429].includes(error.status)) throw new AiError(error.message, { fatal: true });
        if (error.status >= 500 && error.retryable!==false && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
          continue;
        }
        throw new AiError(error.message);
      }
      throw new AiError(error?.message ?? String(error));
    }
  }
  record(MODEL, reply);

  const parsed = parseAnswers(reply?.text);
  if (!parsed) return null;
  return questions.map((question, index) => {
    const value = parsed[String(index + 1)] ?? parsed[index + 1];
    if (value === undefined || value === null) return undefined;
    return settle(typeof value === "string" ? value : JSON.stringify(value), question, must.has(index));
  });
}

/**
 * Prose for a text box, in paragraphs.
 *
 * A long answer that arrives as one block is hard to read in a form's box,
 * and the model does not always break it up when asked. Anything already in
 * paragraphs is left as it is; a single block of four or more sentences is
 * split at sentence ends into two or three paragraphs of roughly even size.
 */
export function paragraphed(text) {
  const clean = String(text ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.includes("\n")) return clean;
  const sentences = clean.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length < 4) return clean;
  const parts = sentences.length >= 6 ? 3 : 2;
  const paragraphs = [];
  let from = 0;
  for (let i = 0; i < parts; i++) {
    const to = i === parts - 1 ? sentences.length : Math.round(((i + 1) * sentences.length) / parts);
    paragraphs.push(sentences.slice(from, to).join(" "));
    from = to;
  }
  return paragraphs.filter(Boolean).join("\n\n");
}

/**
 * Answers a form's worth of questions in one call, two at most.
 *
 * Explicitly unsupported facts are final for this input. Only malformed or
 * missing batch entries get one repair request. A second malformed reply
 * remains unanswered rather than starting a request for every field.
 */
export async function answerAll(questions, context, settings) {
  const restricted = questions.filter(q=>isCompensationQuestion(q.question) && !hasCompensationResearch(context.compensation));
  if (restricted.length) {
    const result = await answerAll(questions.filter(q=>!restricted.includes(q)),context,settings);
    result.unanswered.push(...restricted.map(q=>({key:q.key,question:q.question,required:q.required})));
    return result;
  }
  const results = new Array(questions.length);
  if (questions.length === 0) return { answers: [], unanswered: [], forced: [] };

  const BATCH = 10;
  for (let from = 0; from < questions.length; from += BATCH) {
    const slice = questions.slice(from, from + BATCH);
    const must = new Set(slice.map((question, index) => (question.must ? index : -1)).filter((index) => index >= 0));
    const first = await answerBatch(slice, context, settings, must);

    // The required ones that came back declined, and anything unreadable.
    const again = [];
    slice.forEach((question, index) => {
      const answer = first ? first[index] : undefined;
      if (answer === undefined) again.push(index);
      else results[from + index] = { question, answer, wasForced: false };
    });

    if (again.length > 0) {
      const retry = again.map((index) => slice[index]);
      const second = await answerBatch(retry, context, settings, new Set(retry.map((question, index) => (question.required || question.must ? index : -1)).filter((index) => index >= 0)));
      for (let position = 0; position < again.length; position += 1) {
        const index = again[position];
        const question = slice[index];
        let answer = second ? second[position] : undefined;
        if (answer === undefined) {
          answer = null;
        }
        results[from + index] = { question, answer, wasForced: false };
      }
    }
  }

  const answers = [];
  const unanswered = [];
  const forced = [];
  for (const { question, answer, wasForced } of results) {
    if (wasForced) forced.push({ key: question.key, question: question.question, answer });
    if (answer === null) {
      unanswered.push({ key: question.key, question: question.question, required: question.required });
      continue;
    }
    answers.push({ key: question.key, value: answer, rule: "ai" });
  }

  return { answers, unanswered, forced };
}
