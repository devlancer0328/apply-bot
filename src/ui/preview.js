import { buildDocumentPdf } from "../vendor/generation.js";
import { applyTemplate, normalizeTemplate } from "../templates.js";
import { h } from "./helpers.js";
import * as pdfjs from "../vendor/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("src/vendor/pdf.worker.mjs");
export async function extractPdf(file) {
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), text = await page.getTextContent();
      pages.push(text.items.map((item, i) => item.str + (item.hasEOL || (i < text.items.length - 1 && Math.abs(item.transform?.[5] - text.items[i + 1].transform?.[5]) > 3) ? "\n" : " ")).join(""));
    }
    return pages.join("\n\n");
  } finally { await task.destroy(); }
}
export function createPreview(container) {
  let revision = 0, timer, disposed = false, bytes = null;
  async function render(document, template) {
    const current = ++revision;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let pdf, task;
      try {
        const normalized = normalizeTemplate(template);
        const output = await buildDocumentPdf(applyTemplate(document, normalized), normalized.theme);
        if (disposed || current !== revision) return;
        bytes = output;
        task = pdfjs.getDocument({ data: output.slice(), useSystemFonts: true });
        pdf = await task.promise;
        const fragment = documentFragment();
        for (let n = 1; n <= pdf.numPages; n++) {
          if (disposed || current !== revision) return;
          const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1.3 });
          const canvas = window.document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
          canvas.setAttribute("aria-label", `Resume preview page ${n}`);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          fragment.append(canvas);
        }
        if (disposed || current !== revision) return;
        const caption = window.document.createElement("p"); caption.className = "muted"; caption.textContent = `${pdf.numPages} ${pdf.numPages === 1 ? "page" : "pages"} · US Letter · Actual PDF output`;
        fragment.append(caption); container.replaceChildren(fragment);
      } catch (error) { if (!disposed && current === revision) container.innerHTML = `<p class="info">${h(error.message)}</p>`; }
      finally { await task?.destroy(); }
    }, 180);
  }
  return { render, getBytes: () => bytes, dispose: () => { disposed = true; revision++; clearTimeout(timer); } };
}
const documentFragment = () => window.document.createDocumentFragment();
