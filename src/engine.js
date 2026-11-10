import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
export { DEFAULT_THEME, FONT_OPTIONS, marked, unmarked } from "./templates.js";
import { DEFAULT_THEME, marked } from "./templates.js";

export class ProviderError extends Error { constructor(message, status = 500) { super(message); this.name = "ProviderError"; this.status = status; } }
let transport;
export const setModelTransport = value => { transport = value; };
export async function callModel(request) { if (!transport) throw new ProviderError("Connect the ChatGPT tab first."); return transport(request); }
export function extractJsonObject(raw) {
  const value = String(raw || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = value.indexOf("{"), end = value.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The reply contains no JSON object.");
  return value.slice(start, end + 1);
}
export const parseModelJson = value => JSON.parse(value);
const Role = z.object({ company: z.string().min(1), role: z.string().min(1), location: z.string(), startDate: z.string(), endDate: z.string(), bullets: z.array(z.string()), scope: z.string().optional(), environment: z.array(z.string()).optional() });
export const ResumeSchema = z.object({ name: z.string().min(1), targetTitle: z.string(), contact: z.object({ email: z.string(), phone: z.string(), location: z.string(), links: z.array(z.object({ label: z.string().optional(), url: z.string() })).optional() }), summary: z.string(), coreSkills: z.array(z.object({ category: z.string(), skills: z.array(z.string()) })), experience: z.array(Role), education: z.object({ degree: z.string(), school: z.string(), location: z.string(), year: z.string() }), tailoring: z.any().optional(), highlights: z.array(z.string()).optional() });
export const normalizeResume = value => value;

function printable(value) {
  const replacements = { "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00a0": " " };
  return String(value || "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,'').replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0]/g, c => replacements[c]);
}
/**
 * The PDF's fourteen built-in fonts, under the names people choose from.
 *
 * Nothing here is embedded, so the choice is between the four typefaces a
 * reader is guaranteed to have rather than between the named fonts
 * themselves - which is why Georgia has always drawn as Times. Calibri is
 * a humanist sans and draws as Helvetica, the same substitution Arial has
 * always made. Shipping the real thing would mean shipping Microsoft's
 * font file, which is not ours to put in a zip.
 */
const fontNames = {
  Arial: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique],
  Calibri: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique],
  Georgia: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic],
  "Times New Roman": [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic],
  "Courier New": [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique],
};
async function canvas(theme) {
  const pdf = await PDFDocument.create();
  const fonts = await Promise.all((fontNames[theme.fontFamily] || fontNames.Arial).map(f => pdf.embedFont(f)));
  const margin = theme.margin || 42, body = theme.baseSize || 10.5, width = 612 - 2 * margin;
  const color = String(theme.accentColor || "1D4ED8").replace(/^#/, "");
  const accent = rgb(...[0, 2, 4].map(i => parseInt(color.slice(i, i + 2), 16) / 255));
  const ink = rgb(0.13, 0.17, 0.23), muted = rgb(0.36, 0.40, 0.47);
  const scale = { compact: 1.18, normal: 1.35, roomy: 1.55 }[theme.density] || 1.35;
  let page, y;
  function next() { page = pdf.addPage([612, 792]); y = 792 - margin; }
  next();
  function ensure(height) { if (y - height < margin) next(); }
  /**
   * One value, wrapped and drawn, in as many fonts as it turns out to need.
   *
   * This used to pick a font once and draw each wrapped line with it,
   * which is all a value needs when its emphasis is uniform. A highlighted
   * word is emphasis inside a line, so a line is now a list of words each
   * carrying the font it is drawn in, and is drawn a word at a time with x
   * advanced by what was just written. Wrapping has to measure the same
   * way, because a bold word is wider than the plain one beside it.
   */
  function text(value, options = {}) {
    const size = options.size || body, indent = options.indent || 0;
    const base = fonts[options.bold ? 1 : options.italic ? 2 : 0];
    const available = width - indent;
    const measure = (t, font) => { try { return font.widthOfTextAtSize(t, size); } catch { throw new Error("The built-in PDF font cannot display a character in this resume. Use text supported by the built-in Latin fonts."); } };
    const gap = font => measure(" ", font);
    const spanOf = atom => atom.reduce((total, piece) => total + measure(piece.word, piece.font), 0);
    const lineWidth = atoms => atoms.reduce((total, atom, index) => total + (index ? gap(atom[0].font) : 0) + spanOf(atom), 0);

    // Paragraphs of atoms, where an atom is what must not be split up and a
    // piece is a stretch of it in one font. The distinction exists because
    // a tag boundary is not a word boundary: "<highlight>TypeScript</highlight>,
    // focused on" is three runs, and treating each run's words as separate
    // words puts a space in front of the comma. The comma is a piece of the
    // same atom, drawn in the plain font, hard against the word before it.
    const paragraphs = [[]];
    let attached = false;
    for (const run of marked(printable(value))) {
      const font = run.strong ? fonts[1] : base;
      run.text.split("\n").forEach((part, index) => {
        if (index > 0) { paragraphs.push([]); attached = false; }
        const atoms = paragraphs[paragraphs.length - 1];
        const joins = attached && !/^\s/.test(part) && atoms.length > 0;
        const words = part.split(/\s+/).filter(Boolean);
        words.forEach((word, at) => {
          if (at === 0 && joins) atoms[atoms.length - 1].push({ word, font });
          else atoms.push([{ word, font }]);
        });
        attached = words.length > 0 ? !/\s$/.test(part) : attached && part.length === 0;
      });
    }

    // An atom wider than a whole line, split into the most that fits and
    // the rest - the long-word break the plain renderer always had, now
    // able to cross a font change partway through.
    const splitAtom = (atom) => {
      const head = [];
      let used = 0;
      for (let index = 0; index < atom.length; index++) {
        const piece = atom[index];
        const room = measure(piece.word, piece.font);
        if (used + room <= available) { head.push(piece); used += room; continue; }
        let n = piece.word.length - 1;
        while (n > 1 && used + measure(piece.word.slice(0, n), piece.font) > available) n--;
        if (n >= 1) head.push({ word: piece.word.slice(0, n), font: piece.font });
        return [head, [{ word: piece.word.slice(n), font: piece.font }, ...atom.slice(index + 1)]];
      }
      return [head, []];
    };

    for (const atoms of paragraphs) {
      const lines = [];
      let line = [];
      const close = () => { if (line.length) { lines.push(line); line = []; } };
      for (let atom of atoms) {
        while (atom.length > 0 && spanOf(atom) > available) {
          const [head, rest] = splitAtom(atom);
          if (head.length === 0) break;
          close();
          lines.push([head]);
          atom = rest;
        }
        if (atom.length === 0) continue;
        if (line.length && lineWidth([...line, atom]) > available) close();
        line.push(atom);
      }
      close();

      for (const output of lines) {
        ensure(size * scale);
        const align = options.align || "left";
        let x = align === "center" ? margin + (width - lineWidth(output)) / 2 : margin + indent;
        for (const [index, atom] of output.entries()) {
          if (index) x += gap(atom[0].font);
          for (const piece of atom) {
            page.drawText(piece.word, { x, y: y - size, size, font: piece.font, color: options.color || ink });
            x += measure(piece.word, piece.font);
          }
        }
        y -= size * scale;
      }
    }
  }
  function space(value) { y -= value; }
  function heading(value) {
    ensure(body * 6); space(body * 1.1); text(value.toUpperCase(), { bold: true, color: accent, size: body }); space(3);
    if (theme.headingStyle !== "plain") { page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.7, color: accent }); space(7); }
  }
  return { pdf, text, space, heading, ensure, accent, muted, body };
}
export async function buildDocumentPdf(document, theme = DEFAULT_THEME) {
  const c = await canvas({ ...DEFAULT_THEME, ...theme });
  const { text, space, heading, body, accent, muted } = c;
  const align = theme.headerAlign || "left";
  c.pdf.setTitle([document.name, document.targetTitle].filter(Boolean).join(" - ")); c.pdf.setAuthor(document.name || "");
  text(document.name, { size: body + 12, bold: true, color: accent, align });
  if (document.targetTitle) { space(3); text(document.targetTitle, { size: body + 2, bold: true, align }); }
  const contact = document.contact || {};
  space(5); text([contact.email, contact.phone, contact.location, ...(contact.links || []).map(l => l.url)].filter(Boolean).join("  |  "), { size: body - 1, color: muted, align });
  for (const section of document.sections || []) {
    const hasContent = [...(section.paragraphs || []), ...(section.lines || []), ...(section.roles || []), ...(section.entries || []), ...(section.bullets || [])].some(Boolean);
    if (!hasContent) continue;
    heading(section.heading || "");
    for (const p of section.paragraphs || []) { text(p); space(4); }
    for (const line of section.lines || []) text([line.label, line.text].filter(Boolean).join(": "));
    for (const point of section.bullets || []) text(`\u2022 ${point}`, { indent: 7 });
    for (const role of section.roles || []) {
      c.ensure(body * 5); text([role.role, role.company].filter(Boolean).join(" | "), { bold: true });
      text([role.location, [role.startDate, role.endDate].filter(Boolean).join(" - ")].filter(Boolean).join(" | "), { size: body - 1, color: muted });
      if (role.note) text(role.note, { italic: true, size: body - 0.5 });
      for (const line of role.lines || []) text(`${line.label}: ${line.text}`, { size: body - 0.5 });
      for (const bullet of role.bullets || []) text(`\u2022 ${bullet}`, { indent: 7 });
      space(7);
    }
    for (const e of section.entries || []) { c.ensure(body * 4); text([e.title, e.right].filter(Boolean).join(" | "), { bold: true }); text(e.subtitle, { color: muted }); if (e.detail) text(e.detail); space(5); }
  }
  return c.pdf.save();
}
export async function buildCoverLetterPdf(value, header, theme = DEFAULT_THEME) {
  const c = await canvas({ ...DEFAULT_THEME, ...theme });
  c.text(header.name, { bold: true, size: c.body + 8, color: c.accent }); c.space(6);
  c.text([header.contact?.email, header.contact?.phone].filter(Boolean).join(" | "), { color: c.muted }); c.space(20);
  for (const paragraph of String(value || "").split(/\n\s*\n/)) { c.text(paragraph); c.space(12); }
  return c.pdf.save();
}
export async function generateCoverLetter(jd, options, signal) {
  const reply = await callModel({ system: "Write a concise professional cover letter using only the supplied resume. Do not invent skills, employment, metrics or personal facts.", messages: [{ role: "user", content: `Write a cover letter for ${options.role} at ${options.company}. Sign with ${options.resume.name}.\nRESUME:\n${JSON.stringify(options.resume)}\nJOB:\n${jd.slice(0, 18000)}\nSTYLE:\n${options.extraInstructions || "Three short paragraphs, direct and specific."}` }], format: "text", signal });
  return { text: reply.text.trim(), usage: reply, violations: [] };
}
