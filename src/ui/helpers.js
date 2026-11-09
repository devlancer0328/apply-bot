export const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const h = escapeHtml;
export const button = (action, label, style = "", extra = "") => `<button type="button" class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;
export function field(label, key, value = "", type = "text", hint = "") {
  const id = `field-${key.replaceAll(".", "-")}`;
  return `<div class="field"><label for="${id}">${h(label)}</label>${type === "textarea" ? `<textarea id="${id}" data-key="${h(key)}">${h(value)}</textarea>` : `<input id="${id}" data-key="${h(key)}" type="${type}" value="${h(value)}" ${type === "number" ? 'min="0"' : ""}>`}${hint ? `<p class="hint">${h(hint)}</p>` : ""}</div>`;
}
export function select(label, key, value, choices, hint = "") {
  return `<div class="field"><label for="field-${h(key)}">${h(label)}</label><select id="field-${h(key)}" data-key="${h(key)}">${choices.map(c => { const [v, text] = Array.isArray(c) ? c : [c, c]; return `<option value="${h(v)}" ${String(value) === String(v) ? "selected" : ""}>${h(text)}</option>`; }).join("")}</select>${hint ? `<p class="hint">${h(hint)}</p>` : ""}</div>`;
}
export const check = (label, key, value, hint = "") => `<label class="check"><input type="checkbox" data-key="${h(key)}" ${value ? "checked" : ""}><span><strong>${h(label)}</strong>${hint ? `<small>${h(hint)}</small>` : ""}</span></label>`;
export const head = (eyebrow, title, description, actions = "") => `<div class="page-head"><div><div class="eyebrow">${h(eyebrow)}</div><h1>${h(title)}</h1><p class="subtext">${h(description)}</p></div><div class="actions">${actions}</div></div>`;
export const paper = '<div class="paper-icon"><i></i><i></i><i></i><i style="width:70%"></i><i></i><i style="width:85%"></i></div>';
export function download(content, name, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type || "application/octet-stream" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function readFields(container, target) {
  for (const element of container.querySelectorAll("[data-key]")) {
    const path = element.dataset.key.split("."); let value = target;
    for (const key of path.slice(0, -1)) value = value[key] ??= {};
    value[path.at(-1)] = element.type === "checkbox" ? element.checked : element.type === "number" || element.type === "range" ? Number(element.value) : element.value;
  }
  return target;
}
