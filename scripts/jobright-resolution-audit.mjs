/**
 * Why a Jobright card does or does not yield an employer posting URL.
 *
 * The run reports "the original employer posting link could not be resolved"
 * for roughly two cards in five and the log cannot say which of the four
 * possible causes fired, so this asks the cards themselves. Jobright's
 * `/jobs/info/<id>` page is server-rendered Next.js and answers an anonymous
 * request with the whole `__NEXT_DATA__` island, which means the question
 * "does this posting carry an employer address at all" can be settled from
 * outside the browser - no tab, no session, nothing that could disturb a run
 * that is live.
 *
 * Reads only. Give it a file of 24-hex job ids, one per line.
 */

import { readFile, writeFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const ATS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|rippling\.com|applytojob\.com|smartrecruiters\.com|icims\.com|bamboohr\.com|workable\.com|jobvite\.com|taleo\.net|successfactors\.com|paylocity\.com|dayforcehcm\.com|breezy\.hr|recruitee\.com|teamtailor\.com|pinpointhq\.com|gem\.com|eightfold\.ai|oraclecloud\.com|adp\.com)$/i;

const ids = (await readFile(process.argv[2] ?? '/tmp/tonight-ids.txt', 'utf8')).split('\n').map(line => line.trim()).filter(id => /^[a-f0-9]{24}$/i.test(id));
const rows = [];

for (const id of ids) {
  const row = { id };
  try {
    const response = await fetch(`https://jobright.ai/jobs/info/${id}`, { headers: { 'user-agent': UA, accept: 'text/html' } });
    row.status = response.status;
    const html = await response.text();
    const island = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    row.ssr = Boolean(island);
    if (island) {
      const source = JSON.parse(island[1])?.props?.pageProps?.dataSource ?? {};
      const job = source.jobResult ?? {};
      Object.assign(row, {
        title: job.jobTitle ?? '', company: source.companyResult?.companyName ?? '',
        hidden: job.hiddenJob === true, companySiteLink: job.isCompanySiteLink === true, deleted: job.isDeleted === true,
        source: job.source ?? null, easyApply: job.jobtargetEasyapply === true,
        // Any field anywhere in the payload whose value is an off-site URL is
        // a candidate apply address; naming the fields in advance is what the
        // network observer already does and what evidently finds nothing.
        urls: [...new Set([...JSON.stringify(source).matchAll(/https?:\\?\/\\?\/[^"\\\s<>]{6,300}/g)].map(match => match[0].replace(/\\/g, '')))]
          .filter(url => { try { const host = new URL(url).hostname; return !/jobright|licdn|googleapis|gstatic|crunchbase|morningstar|wikipedia|w3\.org|schema\.org/i.test(host); } catch { return false; } }),
      });
      row.ats = row.urls.filter(url => { try { return ATS.test(new URL(url).hostname); } catch { return false; } });
    }
  } catch (error) { row.error = error.message; }
  rows.push(row);
  process.stderr.write(`${rows.length}/${ids.length}\r`);
  await new Promise(resolve => setTimeout(resolve, 400));
}

await writeFile('test-results/jobright-resolution-audit.json', JSON.stringify(rows, null, 2));

const count = predicate => rows.filter(predicate).length;
console.log(`cards read: ${rows.length}; server-rendered: ${count(row => row.ssr)}; non-200: ${count(row => row.status !== 200)}`);
console.log(`hiddenJob: ${count(row => row.hidden)}; isCompanySiteLink: ${count(row => row.companySiteLink)}; isDeleted: ${count(row => row.deleted)}`);
console.log(`an off-site URL anywhere in the payload: ${count(row => row.urls?.length)}; one that names a known ATS: ${count(row => row.ats?.length)}`);
const sources = {};
for (const row of rows) sources[row.source] = (sources[row.source] ?? 0) + 1;
console.log('source codes:', sources);
for (const row of rows.filter(row => row.ats?.length).slice(0, 10)) console.log(`  ATS ${row.company}: ${row.ats[0]}`);
