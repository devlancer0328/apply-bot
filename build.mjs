import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('src/vendor', { recursive: true });
await build({ entryPoints: ['src/engine.js'], outfile: 'src/vendor/generation.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
await build({ entryPoints: ['sql.js/dist/sql-wasm-browser.js'], outfile: 'src/vendor/sqlite.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', legalComments: 'eof' });
await copyFile('node_modules/sql.js/dist/sql-wasm-browser.wasm', 'src/vendor/sql-wasm.wasm');
await copyFile('node_modules/pdfjs-dist/build/pdf.mjs', 'src/vendor/pdf.mjs');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'src/vendor/pdf.worker.mjs');
for (const [name, license] of [['sql.js','LICENSE'],['pdf-lib','LICENSE.md'],['pdfjs-dist','LICENSE'],['zod','LICENSE']]) {
  await copyFile(`node_modules/${name}/${license}`, `src/vendor/${name}-LICENSE.txt`);
}
console.log('Built local PDF and SQLite engines. No external app source required.');
