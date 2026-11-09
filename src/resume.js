/** Generate a resume through ChatGPT context and parse its document structure. */

import { extractJsonObject, normalizeResume, parseModelJson, ResumeSchema } from "./vendor/generation.js";
import { educationFromDocument } from "./templates.js";
import { askChatGpt } from "./chatgpt.js";

/** The ChatGPT project owns generation instructions. Send only the full JD. */
export const resumePrompt = jd => String(jd || '');

const text = (value) => String(value ?? "").trim();
const strings = (value) =>
  Array.isArray(value)
    ? value.map((item) => text(item)).filter(Boolean)
    : text(value)
        .split(/\s*[,;|•]\s*/)
        .map((item) => item.trim())
        .filter(Boolean);
/** Labelled lines however the reply wrote them: {label, text}, {category, skills[]}, or a bare string. */
const labelledLines = (value) =>
  (Array.isArray(value) ? value : [])
    .map((line) => {
      if (!line || typeof line !== "object") return { label: "", text: text(line) };
      const body = line.text ?? line.skills ?? line.items ?? line.value;
      return { label: text(line.label ?? line.category ?? line.name), text: Array.isArray(body) ? strings(body).join(", ") : text(body) };
    })
    .filter((line) => line.label || line.text);
const splitDates = (value) => {
  const [start, end] = text(value)
    .split(/\s*[-–—]+\s*|\s+to\s+/i)
    .map((part) => part.trim());
  return { startDate: start ?? "", endDate: end ?? "" };
};

/**
 * A flat reply - summary, skills, experience at the top, the shape a
 * project's own instructions may insist on - as sections in the plain
 * order, so it is drawn rather than refused.
 */
function flatSections(source) {
  const sections = [];
  if (source.summary || source.profile) sections.push({ heading: "Professional Summary", paragraphs: source.summary ?? source.profile });
  if (Array.isArray(source.highlights) && source.highlights.length) sections.push({ heading: "Key Achievements", bullets: source.highlights });
  const skills = source.coreSkills ?? source.technicalskills ?? source.technicalSkills ?? source.skills;
  if (skills) sections.push({ heading: "Core Skills", lines: skills });
  if (Array.isArray(source.experience) && source.experience.length) sections.push({ heading: "Professional Experience", roles: source.experience });
  if (Array.isArray(source.certifications) && source.certifications.length) sections.push({heading:'Certifications',entries:source.certifications.map(entry=>typeof entry==='string'?{title:entry}:entry)});
  if (source.education) {
    const entries = Array.isArray(source.education) ? source.education : [source.education];
    sections.push({ heading: "Education", entries: entries.map((entry) => (entry && typeof entry === "object" ? { ...entry, subtitle: entry.subtitle ?? [entry.school, entry.location].filter(Boolean).join(", ") } : { title: text(entry) })) });
  }
  return sections;
}

/**
 * The reply as a document: its sections cleaned to what the PDF draws,
 * whatever naming the project's own instructions gave the parts ("title"
 * for role, a single "dates" string, skills as an object keyed by category).
 * Identity is the profile's, never the reply's.
 */
export function toDocument(parsed, candidate) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const raw = Array.isArray(source.sections) && source.sections.length > 0 ? source.sections : flatSections(source);

  const sections = raw
    .filter((section) => section && typeof section === "object")
    .map((section) => {
      const out = { id: section.id, heading: text(section.heading ?? section.title) };
      const prose = section.paragraphs ?? section.text ?? section.summary ?? section.content;
      if (prose !== undefined && prose !== null) {
        const paragraphs = Array.isArray(prose)
          ? prose.map(text).filter(Boolean)
          : text(prose)
              .split(/\n\s*\n/)
              .map((part) => part.trim())
              .filter(Boolean);
        if (paragraphs.length) out.paragraphs = paragraphs;
      }

      let lines = section.lines ?? section.skills;
      if (lines && !Array.isArray(lines) && typeof lines === "object") lines = Object.entries(lines).map(([label, items]) => ({ label, text: strings(items).join(", ") }));
      if (lines) out.lines = labelledLines(lines);

      if (section.bullets) out.bullets = strings(section.bullets);

      const roles = section.roles ?? section.experience;
      if (Array.isArray(roles)) {
        out.roles = roles
          .filter((role) => role && typeof role === "object")
          .map((role) => {
            const dates = role.startDate || role.endDate ? { startDate: text(role.startDate), endDate: text(role.endDate) } : splitDates(role.dates);
            const entry = { company: text(role.company), role: text(role.role ?? role.title), location: text(role.location), ...dates, bullets: strings(role.bullets) };
            const note = text(role.note ?? role.scope ?? role.companyContext ?? role.description);
            if (note) entry.note = note;
            let roleLines = role.lines;
            if (!roleLines && (role.environment || role.stack)) roleLines = [{ label: "Stack", text: strings(role.environment ?? role.stack).join(", ") }];
            if (roleLines) entry.lines = labelledLines(roleLines);
            return entry;
          });
      }

      if (Array.isArray(section.entries)) {
        out.entries = section.entries
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({ title: text(entry.title ?? entry.degree), subtitle: text(entry.subtitle ?? entry.school), right: text(entry.right ?? entry.year ?? entry.dates), detail: text(entry.detail) }))
          .filter((entry) => entry.title || entry.subtitle);
      }
      return out;
    })
    .filter((section) => section.heading || section.paragraphs?.length || section.lines?.length || section.bullets?.length || section.roles?.length || section.entries?.length);

  return {
    name: candidate.name,
    targetTitle: text(source.targetTitle ?? source.subtitle ?? source.title),
    contact: {
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.location,
      ...(candidate.links?.length ? { links: candidate.links } : {}),
    },
    sections,
    tailoring: source.tailoring && typeof source.tailoring === "object" ? source.tailoring : undefined,
  };
}

const SUMMARY = /summary|profile|objective|about/i;
const SKILLS = /skill|technolog|competenc|tool|stack|expertise|proficienc/i;
const STACK = /stack|environment|technolog|tools?$/i;

/**
 * The app's Resume, read out of a document: the summary is the first prose
 * section (a "Summary" or "Profile" one for preference), the skills the
 * labelled lines of a skills section, the roles the one section that has
 * them, and education from the ChatGPT document. What the cover letter and the form
 * answers are written from; the PDF is drawn from the document itself.
 */
export function toResume(document, candidate) {
  const sections = document?.sections ?? [];
  const prose = sections.filter((section) => section.paragraphs?.length);
  const summarySection = prose.find((section) => SUMMARY.test(section.heading)) ?? prose[0];
  const lined = sections.filter((section) => section.lines?.length);
  const skillsSection = lined.find((section) => SKILLS.test(section.heading)) ?? lined[0];
  const roleSection = sections.find((section) => section.roles?.length);
  const highlights = sections.find((section) => section.bullets?.length && !section.roles?.length);

  const experience = (roleSection?.roles ?? []).map((role) => {
    const stack = (role.lines ?? []).find((line) => STACK.test(line.label));
    return {
      company: role.company,
      role: role.role,
      location: role.location,
      startDate: role.startDate,
      endDate: role.endDate,
      ...(role.note ? { scope: role.note } : {}),
      ...(stack ? { environment: strings(stack.text) } : {}),
      bullets: role.bullets ?? [],
    };
  });

  return {
    name: candidate.name,
    targetTitle: text(document?.targetTitle),
    contact: document?.contact ?? {
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.location,
      ...(candidate.links?.length ? { links: candidate.links } : {}),
    },
    summary: (summarySection?.paragraphs ?? []).join(" "),
    ...(highlights ? { highlights: highlights.bullets } : {}),
    coreSkills: (skillsSection?.lines ?? []).map((line) => ({ category: line.label, skills: strings(line.text) })).filter((bucket) => bucket.category && bucket.skills.length > 0),
    experience,
    education: educationFromDocument(document),
    tailoring: document?.tailoring,
  };
}

/** The document and resume in a reply, checked against the schema; throws with the reason when they are not. */
function parseReply(reply, candidate) {
  const document = toDocument(parseModelJson(extractJsonObject(reply)), candidate);
  const result = ResumeSchema.safeParse(toResume(document, candidate));
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The reply did not match the resume shape (${issues}).`);
  }
  return { document, resume: result.data };
}

/** Validate output shape without comparing it with a local source resume. */
export function documentFault({document}) {
  if (!document?.sections?.length) return 'the reply has no resume sections';
  if (!document.sections.some(s => s.paragraphs?.length || s.roles?.length || s.lines?.length || s.entries?.length || s.bullets?.length)) return 'the resume is empty';
  return null;
}

/** Read the project's response locally; never send a formatting repair prompt. */
export async function generateResumeInChat({projectUrl, jd, candidate, model, signal,label}) {
  const reply = await askChatGpt({task:'resume',provider:'openai',model,apiKey:'',system:'',messages:[{role:'user',content:resumePrompt(jd)}],format:'text',chatUrl:projectUrl,signal,verbatim:true,tracking:{label}});
  const payload = parseModelJson(extractJsonObject(reply.text));
  if (payload.contextRequired) { const error = new Error(payload.message || 'Add candidate information to your ChatGPT project or conversation first.'); error.contextRequired = true; throw error; }
  const parsed = parseReply(reply.text,candidate);
  const fault = documentFault(parsed);
  if(fault)throw new Error("ChatGPT's resume could not be read: "+fault+'. Review its reply in the selected project.');
  return {...parsed,resume:normalizeResume(parsed.resume),aiMode:reply.mode,coverLetter:typeof payload.coverLetter==='string'?payload.coverLetter.trim():'',violations:[],usage:{calls:1,inputTokens:0,outputTokens:0,cachedTokens:0},repairPasses:0};
}
