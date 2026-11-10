/**
 * <highlight>…</highlight>, and the font list it is drawn in.
 *
 * Asked for a resume as JSON, the model has no way to express emphasis,
 * so it marks the words that should carry it - a language, a tool, a
 * figure - with a tag. Nothing read the tag, so it was drawn, and
 * bullets went to employers reading "built <highlight>Python</highlight>
 * services".
 *
 * Drawing it properly is not a substitution but a layout change. The
 * renderer picked one font per call and drew each wrapped line with it,
 * which is all a line needs while its emphasis is uniform. Emphasis
 * inside a line means a line is now a sequence of pieces in different
 * fonts, and both the wrapping and the x advance have to measure each
 * piece in its own font, because a bold word is wider than the plain one
 * beside it.
 *
 * The case worth having a test for is the one that is invisible until you
 * look at the PDF: a tag boundary is not a word boundary.
 * "<highlight>TypeScript</highlight>, focused on" is three runs, and a
 * renderer that treats every run's words as words puts a space in front
 * of the comma.
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildDocumentPdf, marked, unmarked, FONT_OPTIONS } from "../src/engine.js";
import { documentText } from "../src/templates.js";
import { resumeToText } from "../src/writer.js";

let count = 0;
const test = async (name, work) => { await work(); count++; console.log("PASS " + name); };

/**
 * Every word the PDF draws, with the font it is drawn in.
 *
 * The content streams are deflated and the text is hex, so asserting on
 * the bytes directly proves nothing either way. pdf-lib names its font
 * resources `/Helvetica-Bold-7098480789`, and a word arrives as
 * `<507974686F6E> Tj` under whichever `Tf` was set last.
 */
function drawn(bytes) {
  const buffer = Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const ops = [];
  let at = 0;
  while ((at = source.indexOf("stream", at)) >= 0) {
    if (source.slice(at - 3, at) === "end") { at += 6; continue; }
    let start = at + 6;
    while (source[start] === "\r" || source[start] === "\n") start++;
    const end = source.indexOf("endstream", start);
    let content = "";
    try { content = zlib.inflateSync(buffer.subarray(start, end)).toString("latin1"); } catch { content = ""; }
    let font = "", size = 0, x = 0;
    for (const line of content.split("\n")) {
      const chose = /^\/(.+?)-\d+ ([\d.]+) Tf$/.exec(line.trim());
      if (chose) { font = chose[1]; size = Number(chose[2]); continue; }
      const placed = /^1 0 0 1 ([\d.-]+) ([\d.-]+) Tm$/.exec(line.trim());
      if (placed) { x = Number(placed[1]); continue; }
      const shows = /^<([0-9A-Fa-f]*)> Tj$/.exec(line.trim());
      if (shows) ops.push({ font, size, x, text: Buffer.from(shows[1], "hex").toString("latin1") });
    }
    at = end;
  }
  return ops;
}

const fontOf = (ops, word) => ops.find((op) => op.text === word)?.font;

const BULLET = "Built a service on <highlight>Amazon Bedrock</highlight>, cutting triage by <highlight>62%</highlight>.";

const resume = (bullet = BULLET) => ({
  name: "Daniel Torres", targetTitle: "Senior AI Engineer",
  contact: { email: "someone@example.test", phone: "(929) 489-1252", location: "Temple, Texas", links: [] },
  sections: [
    { id: "summary", heading: "Professional Summary", paragraphs: [`Nine years in <highlight>Python</highlight> and <highlight>TypeScript</highlight>.`] },
    { id: "experience", heading: "Professional Experience", roles: [{ role: "Senior Engineer", company: "Alarm.com", location: "Remote", startDate: "2021", endDate: "Present", bullets: [bullet] }] },
  ],
});

await test("the tag never reaches the PDF", async () => {
  const bytes = await buildDocumentPdf(resume());
  assert.ok(!/highlight/i.test(Buffer.from(bytes).toString("latin1")), "the markup was drawn into the document");
});

await test("a highlighted word is drawn bold and the words beside it are not", async () => {
  const ops = drawn(await buildDocumentPdf(resume()));
  assert.equal(fontOf(ops, "Python"), "Helvetica-Bold");
  assert.equal(fontOf(ops, "TypeScript"), "Helvetica-Bold");
  assert.equal(fontOf(ops, "Nine"), "Helvetica");
  assert.equal(fontOf(ops, "years"), "Helvetica");
  assert.equal(fontOf(ops, "and"), "Helvetica");
});

await test("the same words with no marks are drawn entirely plain", async () => {
  const ops = drawn(await buildDocumentPdf({
    ...resume(),
    sections: [{ id: "summary", heading: "Professional Summary", paragraphs: ["Nine years in Python and TypeScript."] }],
  }));
  assert.equal(fontOf(ops, "Python"), "Helvetica");
  assert.equal(fontOf(ops, "TypeScript."), "Helvetica");
});

await test("a multi-word highlight is bold in both of its words", async () => {
  const ops = drawn(await buildDocumentPdf(resume()));
  assert.equal(fontOf(ops, "Amazon"), "Helvetica-Bold");
  assert.equal(fontOf(ops, "Bedrock"), "Helvetica-Bold");
  assert.equal(fontOf(ops, "cutting"), "Helvetica");
});

await test("punctuation after a highlight is flush against it, not a space away", async () => {
  // The bold word and its punctuation are two draw operations - they are
  // in different fonts, so they have to be - and what matters is the
  // distance between them. Drawn as separate *words* they sit a space
  // apart and the line reads "TypeScript , focused on". Drawn as pieces
  // of one word they are flush. Measured against the real font metrics,
  // the advance is the width of the word and nothing more.
  const scratch = await PDFDocument.create();
  const bold = await scratch.embedFont(StandardFonts.HelveticaBold);
  const plain = await scratch.embedFont(StandardFonts.Helvetica);

  const ops = drawn(await buildDocumentPdf(resume()));
  for (const [word, tail] of [["TypeScript", "."], ["62%", "."]]) {
    const first = ops.findIndex((op) => op.text === word);
    assert.notEqual(first, -1, `${word} was never drawn`);
    const next = ops[first + 1];
    assert.equal(next?.text, tail, `${word} was not followed by "${tail}"`);

    const advance = next.x - ops[first].x;
    const bare = bold.widthOfTextAtSize(word, ops[first].size);
    const space = plain.widthOfTextAtSize(" ", ops[first].size);
    assert.ok(Math.abs(advance - bare) < 0.01, `"${tail}" sits ${(advance - bare).toFixed(2)}pt past the end of "${word}"`);
    assert.ok(advance < bare + space, `"${word}" gained a space before "${tail}"`);
  }
});

await test("a tag boundary is not a word boundary", () => {
  // The comma belongs to the word before it. Three runs, two atoms.
  const runs = marked("on <highlight>Bedrock</highlight>, cutting");
  assert.deepEqual(runs, [
    { text: "on ", strong: false },
    { text: "Bedrock", strong: true },
    { text: ", cutting", strong: false },
  ]);
});

await test("a tag the model opened and never closed is still not text", () => {
  assert.equal(unmarked("an <highlight>unclosed tag"), "an unclosed tag");
  assert.ok(!marked("an <highlight>unclosed tag").some((run) => /highlight/.test(run.text)));
  assert.ok(!marked("stray </highlight> close").some((run) => /highlight/.test(run.text)));
});

await test("text that is read rather than drawn has the marks taken out", () => {
  // The ATS keyword text and the plain-text copy are matched and searched,
  // and "<highlight>Python</highlight>" matches no search for Python.
  const document = resume();
  assert.ok(!/highlight/i.test(documentText(document)));
  assert.ok(documentText(document).includes("Amazon Bedrock"));
  const flat = resumeToText({ name: "Daniel Torres", summary: "Nine years in <highlight>Python</highlight>.", experience: [{ company: "Alarm.com", role: "Engineer", startDate: "2021", endDate: "Present", bullets: [BULLET] }] });
  assert.ok(!/highlight/i.test(flat));
  assert.ok(flat.includes("62%"));
});

await test("an ordinary resume renders exactly as it did before", () => {
  assert.deepEqual(marked("no marks at all here"), [{ text: "no marks at all here", strong: false }]);
  assert.equal(unmarked("no marks at all here"), "no marks at all here");
});

await test("Calibri is offered and draws", async () => {
  assert.ok(FONT_OPTIONS.includes("Calibri"));
  const bytes = await buildDocumentPdf(resume(), { fontFamily: "Calibri" });
  assert.ok(bytes.length > 1000);
  // Not embedded - the PDF's own humanist sans stands in for it, the same
  // substitution Arial has always made, so a Calibri resume draws
  // identically to an Arial one.
  const asCalibri = drawn(bytes).map((op) => `${op.font} ${op.text}`);
  const asArial = drawn(await buildDocumentPdf(resume(), { fontFamily: "Arial" })).map((op) => `${op.font} ${op.text}`);
  assert.ok(asCalibri.every((op) => op.startsWith("Helvetica")), "Calibri drew in something other than the built-in sans");
  assert.deepEqual(asCalibri, asArial);
});

await test("every offered font builds a document", async () => {
  for (const fontFamily of FONT_OPTIONS) {
    const bytes = await buildDocumentPdf(resume(), { fontFamily });
    assert.ok(bytes.length > 1000, fontFamily);
  }
});

console.log(`${count} resume highlight checks passed.`);
