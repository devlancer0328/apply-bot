/** Structured templates shared by the editor, previews, prompts and PDF renderer. */
export const FONT_OPTIONS = ["Arial", "Calibri", "Georgia", "Times New Roman", "Courier New"];
export const DEFAULT_THEME = { fontFamily: "Arial", accentColor: "1D4ED8", density: "normal", baseSize: 10.5, margin: 42, headerAlign: "left", headingStyle: "rule" };
/**
 * <highlight>…</highlight>, as the model writes it.
 *
 * Asked for a resume as JSON, the model has no way to express emphasis -
 * JSON has no bold - so it marks the words that should carry it with a
 * tag, around a language, a tool, or a figure. Nothing read the tag, so
 * it was drawn: bullets came out reading "built <highlight>Python</highlight>
 * services", with the markup in the PDF sent to the employer.
 *
 * `marked` turns a value into the runs it is made of, which is what the
 * PDF needs to draw part of a line in bold. `unmarked` is for everything
 * that is not drawing it - the plain-text copy, the keyword text an ATS
 * is matched against - where the tag is noise and the words inside it are
 * ordinary words.
 */
const HIGHLIGHT = /<highlight>([\s\S]*?)<\/highlight>/gi;

export function marked(value) {
  const source = String(value ?? "");
  const runs = [];
  let at = 0;
  for (const match of source.matchAll(HIGHLIGHT)) {
    if (match.index > at) runs.push({ text: source.slice(at, match.index), strong: false });
    if (match[1]) runs.push({ text: match[1], strong: true });
    at = match.index + match[0].length;
  }
  if (at < source.length) runs.push({ text: source.slice(at), strong: false });
  // A tag the model opened and never closed is still not text to draw.
  return (runs.length ? runs : [{ text: source, strong: false }]).map((run) => ({ ...run, text: run.text.replace(/<\/?highlight>/gi, "") }));
}

export const unmarked = (value) => String(value ?? "").replace(HIGHLIGHT, "$1").replace(/<\/?highlight>/gi, "");

export const DEFAULT_TEMPLATE = {
  id: "default", name: "Clean professional", theme: DEFAULT_THEME, showTitle: true, showLinks: true,
  sections: [
    { id: "summary", heading: "Professional Summary", enabled: true },
    { id: "skills", heading: "Core Skills", enabled: true },
    { id: "experience", heading: "Professional Experience", enabled: true },
    { id: "education", heading: "Education", enabled: true },
    { id: "projects", heading: "Projects", enabled: true },
    { id: "certifications", heading: "Certifications", enabled: true },
  ],
};

export function normalizeTemplate(value = {}) {
  const theme = { ...DEFAULT_THEME, ...value.theme };
  if (!FONT_OPTIONS.includes(theme.fontFamily)) theme.fontFamily = DEFAULT_THEME.fontFamily;
  theme.accentColor = String(theme.accentColor).replace(/^#/, "");
  if (!/^[a-f\d]{6}$/i.test(theme.accentColor)) theme.accentColor = DEFAULT_THEME.accentColor;
  theme.baseSize = Math.max(9, Math.min(14, Number(theme.baseSize) || 10.5));
  theme.margin = Math.max(24, Math.min(72, Number(theme.margin) || 42));
  if (!["compact", "normal", "roomy"].includes(theme.density)) theme.density = "normal";
  if (!["left", "center"].includes(theme.headerAlign)) theme.headerAlign = "left";
  if (!["rule", "plain"].includes(theme.headingStyle)) theme.headingStyle = "rule";
  const input = Array.isArray(value.sections) ? value.sections : DEFAULT_TEMPLATE.sections;
  const seen = new Set();
  const sections = input.filter(s => s && DEFAULT_TEMPLATE.sections.some(d => d.id === s.id) && !seen.has(s.id) && seen.add(s.id))
    .map(s => ({ id: s.id, heading: String(s.heading || DEFAULT_TEMPLATE.sections.find(d => d.id === s.id).heading).slice(0, 80), enabled: s.id === "experience" || s.enabled !== false }));
  for (const section of DEFAULT_TEMPLATE.sections) if (!seen.has(section.id)) sections.push({ ...section });
  return { id: value.id || "default", name: String(value.name || "Untitled template").slice(0, 100), theme, sections, showTitle: value.showTitle !== false, showLinks: value.showLinks !== false };
}

export function sectionKind(section) {
  if (DEFAULT_TEMPLATE.sections.some(s => s.id === section.id)) return section.id;
  if (section.roles) return "experience";
  const name = String(section.heading || "").toLowerCase();
  if (/summary|profile|objective|about/.test(name)) return "summary";
  if (/skill|competenc|technolog/.test(name)) return "skills";
  if (/educat|academic/.test(name)) return "education";
  if (/certif|licen/.test(name)) return "certifications";
  if (/project/.test(name)) return "projects";
  return section.paragraphs ? "summary" : section.lines ? "skills" : section.entries ? "education" : "projects";
}

export function applyTemplate(document, value) {
  const template = normalizeTemplate(value);
  const source = document.sections || [];
  return {
    ...document, targetTitle: template.showTitle ? document.targetTitle : "",
    contact: { ...document.contact, links: template.showLinks ? document.contact?.links || [] : [] },
    sections: template.sections.filter(s => s.enabled).flatMap(config => source.filter(s => sectionKind(s) === config.id).map(s => ({ ...s, id: config.id, heading: config.heading }))),
  };
}

export function templateInstructions(value) {
  const template = normalizeTemplate(value);
  return `Use these sections in this order, including a section only when the candidate context in ChatGPT supports content for it:\n${template.sections.filter(s => s.enabled).map(s => `- ${s.id}: heading "${s.heading}"`).join("\n")}\nKeep each section's semantic id in the JSON as "id". Do not invent missing candidate facts. ${template.showTitle ? "Include the candidate's supported professional headline." : "Leave targetTitle empty."} Single column; styling is applied by the extension.`;
}

export function educationFromDocument(document) {
  const entry = document?.sections?.find(s => sectionKind(s) === "education")?.entries?.[0];
  return { degree: entry?.title || "", school: entry?.subtitle || "", location: entry?.detail || "", year: entry?.right || "" };
}

export function documentText(document) {
  if (!document) return "";
  // Marks taken out: this is read, matched and searched, never drawn.
  return unmarked([document.name, document.targetTitle, ...Object.values(document.contact || {}).filter(v => typeof v === "string"), ...(document.sections || []).flatMap(s => [s.heading, ...(s.paragraphs || []), ...(s.lines || []).map(l => `${l.label}: ${l.text}`), ...(s.bullets || []), ...(s.roles || []).flatMap(r => [r.company, r.role, r.location, `${r.startDate} - ${r.endDate}`, ...(r.bullets || [])]), ...(s.entries || []).map(e => [e.title, e.subtitle, e.right, e.detail].filter(Boolean).join(" | "))])].filter(Boolean).join("\n"));
}

export function blankDocument() {
  return { name: "", targetTitle: "", contact: { email: "", phone: "", location: "", links: [] }, sections: [
    { id: "summary", heading: "Professional Summary", paragraphs: [""] },
    { id: "skills", heading: "Core Skills", lines: [] },
    { id: "experience", heading: "Professional Experience", roles: [] },
    { id: "education", heading: "Education", entries: [] },
    { id: "projects", heading: "Projects", entries: [] },
    { id: "certifications", heading: "Certifications", entries: [] },
  ] };
}

export function sampleDocument() {
  const doc = blankDocument();
  doc.name = "Alex Morgan"; doc.targetTitle = "Software Engineer";
  doc.contact = { email: "alex@example.com", phone: "+1 555 010 2020", location: "Seattle, WA", links: [{ url: "github.com/example" }] };
  doc.sections[0].paragraphs = ["Software engineer building reliable web applications and thoughtful tools. Experienced in translating customer needs into maintainable products and improving performance through careful measurement."];
  doc.sections[1].lines = [{ label: "Languages", text: "TypeScript, Python, SQL" }, { label: "Tools", text: "React, PostgreSQL, Docker" }];
  doc.sections[2].roles = [{ company: "Example Company", role: "Software Engineer", location: "Remote", startDate: "Jan 2022", endDate: "Present", bullets: ["Built a customer dashboard with accessible interfaces and clear reporting.", "Improved release reliability with automated checks and documented workflows."] }];
  doc.sections[3].entries = [{ title: "B.S. Computer Science", subtitle: "Example University", right: "2021", detail: "Seattle, WA" }];
  return doc;
}
