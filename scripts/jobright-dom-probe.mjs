/**
 * What the live Jobright feed tab actually contains, read without touching it.
 *
 * Two of the four candidate explanations for "the original employer posting
 * link could not be resolved" can only be settled on the signed-in page: does
 * the feed observer see Jobright's job-list responses at all, and does a card
 * carry the employer's address as an `<a href>` or only as a scripted button.
 * This attaches to the tab the applicant already has open over the DevTools
 * protocol and evaluates one expression that reads and returns; it never
 * navigates, clicks, types or closes anything, so it is safe to run against a
 * production run in flight.
 */

const ENDPOINT = process.env.ATTACH ?? 'http://127.0.0.1:9222';
const MATCH = process.argv[2] ?? 'jobright.ai';

const targets = await (await fetch(`${ENDPOINT}/json/list`)).json();
const target = targets.find(entry => entry.type === 'page' && entry.url.includes(MATCH));
if (!target) throw new Error(`no open tab matching ${MATCH}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

const evaluate = expression => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9);
  const onMessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    socket.removeEventListener('message', onMessage);
    if (message.error) reject(new Error(message.error.message));
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
    else resolve(message.result.result.value);
  };
  socket.addEventListener('message', onMessage);
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
});

const report = await evaluate(`(() => {
  const observer = window.__applyBotJobrightNetwork;
  const snapshot = observer?.snapshot?.() ?? null;
  const offsite = value => { try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) && !/(^|\\.)(jobright\\.ai|linkedin\\.com)$/i.test(u.hostname); } catch { return false; } };
  const cards = [...document.querySelectorAll('a[href*="/jobs/info/"]')];
  const controls = [...document.querySelectorAll('a[href], button, [role="button"]')]
    .map(node => ({ tag: node.tagName, text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 60), href: node.tagName === 'A' ? node.getAttribute('href') || '' : '' }))
    .filter(entry => entry.text && entry.text.length <= 60 && /\\b(apply|origin(al)?|view job|company site)\\b/i.test(entry.text));
  const island = document.getElementById('__NEXT_DATA__');
  let islandKeys = null, islandApply = null;
  if (island) { try { const data = JSON.parse(island.textContent); islandKeys = Object.keys(data.props?.pageProps ?? {}); islandApply = JSON.stringify(data.props?.pageProps ?? {}).match(/"(applyLink|originalUrl)":"[^"]{0,120}"/g)?.slice(0, 3) ?? []; } catch {} }
  return {
    url: location.href,
    observerPresent: Boolean(observer), observerRevision: observer?.revision ?? null,
    observed: snapshot && { ids: snapshot.ids.length, entries: snapshot.entries.length, withOriginal: snapshot.entries.filter(e => e.originalUrl).length, scope: snapshot.scope, hasMore: snapshot.hasMore, error: snapshot.error, sample: snapshot.entries.slice(0, 3) },
    cardAnchors: cards.length,
    offsiteAnchors: [...document.querySelectorAll('a[href]')].filter(a => offsite(a.getAttribute('href'))).map(a => a.getAttribute('href')).slice(0, 8),
    applyControls: controls.slice(0, 12),
    islandKeys, islandApply,
  };
})()`);

socket.close();
console.log(JSON.stringify(report, null, 2));
