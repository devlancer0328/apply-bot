import {h} from './helpers.js';
export function compensationHtml(value) {
  if (!value) return '';
  if (value.status !== 'researched') return `<section class="card"><h2>Compensation research</h2><p class="muted">${h(value.reason || 'No cited company-specific range is available.')} No fallback amount is used.</p></section>`;
  return `<section class="card"><div class="card-head"><h2>Compensation research</h2><span class="pill green">ChatGPT Search</span></div><h3>${h(value.currency)} ${h(value.minimum.toLocaleString())}–${h(value.maximum.toLocaleString())} / ${h(value.period)}</h3><p class="muted">${h(value.basis)} compensation · ${h(value.company)} · ${h(value.role)}<br>${h(value.location)}</p><p class="muted">AI-selected application amount: ${h(value.recommendedAmount.toLocaleString())} ${h(value.currency)} / ${h(value.period)}</p><p class="muted">${h(value.rationale)}</p><div class="file-list">${value.sources.map(source=>`<a href="${h(source.url)}" target="_blank" rel="noreferrer">${h(source.title || source.url)} ↗</a><p class="hint">${h(source.details)}</p>`).join('')}</div></section>`;
}
