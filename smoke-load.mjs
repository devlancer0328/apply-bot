import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ext = process.cwd();
const profile = await mkdtemp(join(tmpdir(), 'apply-bot-smoke-'));
const errors = [];

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

ctx.on('weberror', (e) => errors.push(`page: ${e.error().message}`));

let worker = ctx.serviceWorkers()[0];
if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
worker.on('console', (m) => { if (m.type() === 'error') errors.push(`sw: ${m.text()}`); });

const id = new URL(worker.url()).host;
console.log('service worker registered:', worker.url());

for (const page of ['popup.html', 'options.html']) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${page}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${page}: ${m.text()}`); });
  await p.goto(`chrome-extension://${id}/src/${page}`, { waitUntil: 'load' });
  await p.waitForTimeout(3000);
  console.log(`${page} loaded, title: ${JSON.stringify(await p.title())}`);
  await p.close();
}

await ctx.close();
await rm(profile, { recursive: true, force: true });

if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
console.log('\nExtension loaded with no console or page errors.');
