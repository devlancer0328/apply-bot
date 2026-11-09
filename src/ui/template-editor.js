import { h, head, field, select, check, button, readFields, download } from "./helpers.js";
import { normalizeTemplate, FONT_OPTIONS } from "../templates.js";
import { createPreview } from "./preview.js";

export function mountTemplateEditor(container, record, document, callbacks) {
  let draft = normalizeTemplate(structuredClone(record)), preview, dirty = false, dragId = null;
  const mark = () => { dirty = true; callbacks.dirty(true); container.querySelector('[data-save-label]').textContent = 'Unsaved changes'; };
  function sectionRows() {
    return draft.sections.map((s, i) => `<div class="section-row" draggable="true" data-section="${s.id}"><span aria-hidden="true">⠿</span><input type="checkbox" aria-label="Include ${h(s.heading)}" data-enabled="${s.id}" ${s.enabled ? "checked" : ""} ${s.id === "experience" ? "disabled" : ""}><input type="text" aria-label="${h(s.id)} section heading" data-heading="${s.id}" value="${h(s.heading)}"><button class="icon-button" data-move="${i}" data-direction="-1" aria-label="Move ${h(s.heading)} up" ${i === 0 ? "disabled" : ""}>↑</button><button class="icon-button" data-move="${i}" data-direction="1" aria-label="Move ${h(s.heading)} down" ${i === draft.sections.length - 1 ? "disabled" : ""}>↓</button></div>`).join("");
  }
  container.innerHTML = head('DESIGN YOUR DOCUMENT', 'Template studio', 'Arrange sections and adjust the design. The preview is the exact PDF your applications will use.', button('back-templates', '← All templates')) + `
    <div class="editor-layout"><div class="editor-controls">
    <section class="card">${field('Template name', 'name', draft.name)}<div class="fields">${select('Font family', 'theme.fontFamily', draft.theme.fontFamily, FONT_OPTIONS.filter(f => f !== 'Georgia'))}${field('Accent color', 'theme.accentColor', '#' + draft.theme.accentColor, 'color')}${select('Spacing', 'theme.density', draft.theme.density, [['compact','Compact'],['normal','Comfortable'],['roomy','Airy']])}${select('Header alignment', 'theme.headerAlign', draft.theme.headerAlign, [['left','Left'],['center','Centered']])}${field('Text size (pt)', 'theme.baseSize', draft.theme.baseSize, 'number')}${field('Page margin (pt)', 'theme.margin', draft.theme.margin, 'number')}${select('Section headings', 'theme.headingStyle', draft.theme.headingStyle, [['rule','With divider'],['plain','Plain']])}</div>${check('Show professional headline','showTitle',draft.showTitle)}${check('Show profile links','showLinks',draft.showLinks)}</section>
    <section class="card"><h2>Sections</h2><p class="muted">Drag to reorder, or use the arrows. Rename headings to make the template yours.</p><div id="section-order">${sectionRows()}</div><p class="hint">Work history is always included. Empty sections are automatically omitted.</p></section>
    <div class="save-bar"><small data-save-label>All changes saved</small><div class="actions">${button('template-download','Download PDF')}${button('template-save','Save template','primary')}</div></div>
    </div><div class="preview-panel"><div class="preview-title"><span>LIVE PREVIEW · ${callbacks.sample ? 'SAMPLE CONTENT' : 'YOUR RESUME'}</span><span class="pill">PDF</span></div><div class="pdf-pages"><div class="pdf-loading">Rendering your template…</div></div></div></div>`;
  preview = createPreview(container.querySelector('.pdf-pages'));
  const update = () => { readFields(container, draft); draft = normalizeTemplate(draft); preview.render(document, draft); };
  update();
  container.querySelector('[data-key="theme.baseSize"]').setAttribute('min','9'); container.querySelector('[data-key="theme.baseSize"]').setAttribute('max','14'); container.querySelector('[data-key="theme.baseSize"]').setAttribute('step','.5');
  container.querySelector('[data-key="theme.margin"]').setAttribute('min','24'); container.querySelector('[data-key="theme.margin"]').setAttribute('max','72');
  const onInput = event => {
    if (event.target.dataset.heading) draft.sections.find(s => s.id === event.target.dataset.heading).heading = event.target.value;
    if (event.target.dataset.enabled) draft.sections.find(s => s.id === event.target.dataset.enabled).enabled = event.target.checked;
    mark(); update();
  };
  container.addEventListener('input', onInput);
  const onClick = async event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.move !== undefined) {
      const from = Number(target.dataset.move), to = from + Number(target.dataset.direction);
      [draft.sections[from], draft.sections[to]] = [draft.sections[to], draft.sections[from]];
      container.querySelector('#section-order').innerHTML = sectionRows(); mark(); update();
    }
    try {
      if (target.dataset.action === 'template-save') { target.disabled = true; await callbacks.save(normalizeTemplate(draft)); dirty = false; callbacks.dirty(false); container.querySelector('[data-save-label]').textContent = 'All changes saved'; }
      if (target.dataset.action === 'template-download') { const bytes = preview.getBytes(); if (bytes) download(bytes, `${draft.name}.pdf`, 'application/pdf'); }
    } catch (error) { callbacks.error(error); } finally { target.disabled = false; }
  };
  container.addEventListener('click', onClick);
  const dragStart = e => { const row = e.target.closest('[data-section]'); if (row) { dragId = row.dataset.section; row.classList.add('dragging'); e.dataTransfer.setData('text/plain', dragId); } };
  const dragOver = e => { if (e.target.closest('[data-section]')) e.preventDefault(); };
  const drop = e => {
    e.preventDefault(); const row = e.target.closest('[data-section]'); if (!row || !dragId) return;
    const from = draft.sections.findIndex(s => s.id === dragId), to = draft.sections.findIndex(s => s.id === row.dataset.section);
    const [entry] = draft.sections.splice(from,1); draft.sections.splice(to,0,entry); dragId = null;
    container.querySelector('#section-order').innerHTML = sectionRows(); mark(); update();
  };
  container.addEventListener('dragstart', dragStart); container.addEventListener('dragover', dragOver); container.addEventListener('drop', drop);
  return () => { preview.dispose(); container.removeEventListener('input', onInput); container.removeEventListener('click', onClick); container.removeEventListener('dragstart',dragStart); container.removeEventListener('dragover',dragOver); container.removeEventListener('drop',drop); };
}
