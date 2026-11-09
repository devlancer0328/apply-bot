/** Read-only public Job Board API; form filling still uses the actual page. */
const cache = new Map(), TTL = 5 * 60 * 1000;
export function greenhouseIds(value) {
  try {
    const url = new URL(value);
    if (!/^(?:boards|job-boards)\.greenhouse\.io$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/application)?\/?$/i);
    if (match) return {board:match[1],id:match[2]};
    if (/^\/embed\/job_app\/?$/i.test(url.pathname) && url.searchParams.get('for') && /^\d+$/.test(url.searchParams.get('token') || '')) return {board:url.searchParams.get('for'),id:url.searchParams.get('token')};
  } catch {}
  return null;
}
export const greenhouseApplyUrl = value => value;
export function jobHtmlText(content) {
  let text = String(content || '');
  const entities = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  for (let i=0;i<2;i++) text = text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(all,key) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] || all;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
}
export async function greenhousePosting(value,{refresh=false}={}) {
  const ids = greenhouseIds(value); if (!ids) return null;
  const key = `${ids.board}:${ids.id}`, saved = cache.get(key);
  if (!refresh && saved && Date.now()-saved.at < TTL) return saved.value;
  const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ids.board)}/jobs/${encodeURIComponent(ids.id)}`,{signal:AbortSignal.timeout(8000)});
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`Greenhouse's posting API answered ${response.status}`);
  const data = await response.json(), jd = jobHtmlText(data.content);
  if (String(data.id) !== ids.id || !data.title || !data.company_name || jd.length < 200) throw new Error('Greenhouse returned incomplete posting data; use the page.');
  const posting = {title:String(data.title),company:String(data.company_name || ''),jd,applyUrl:value,metadata:{location:String(data.location?.name||''),updatedAt:data.updated_at||null}};
  cache.set(key,{at:Date.now(),value:posting});
  return posting;
}
