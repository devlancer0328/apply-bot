/**
 * Which ATS an address belongs to, judged from the address alone.
 *
 * The same table exists in extract.js, which is a duplication worth naming
 * rather than hiding. That copy runs inside the page, injected as a script
 * with no module system, and cannot import this one.
 *
 * This copy answers a question the page is never asked: where did the apply
 * button lead? Answering it from the URL is what lets the destination be
 * recognised without loading it - which matters because the page behind an
 * aggregator's apply button is the same page the form will be opened on a
 * moment later, and loading it twice is most of what made a Jobright link
 * feel slow.
 *
 * Which of those names the bot can actually fill lives here too. It was
 * private to background.js, where the scrapers could not see it, so a feed
 * had no way to tell a Greenhouse posting from a Taleo one before handing
 * both on. Board identity and the list of boards worth acting on are the
 * same subject, and keeping them apart meant a second copy of the list.
 */
const HOSTS = [
  ["greenhouse", /(^|\.)greenhouse\.io$/i],
  ["lever", /(^|\.)lever\.co$/i],
  ["ashby", /(^|\.)ashbyhq\.com$/i],
  ["workday", /(^|\.)myworkdayjobs\.com$/i],
  ["rippling", /(^|\.)rippling\.com$/i],
  ["applytojob", /(^|\.)applytojob\.com$/i],
  ["smartrecruiters", /(^|\.)smartrecruiters\.com$/i],
  ["icims", /(^|\.)icims\.com$/i],
  ["bamboohr", /(^|\.)bamboohr\.com$/i],
  ["workable", /(^|\.)workable\.com$/i],
  ["taleo", /(^|\.)taleo\.net$/i],
  ["successfactors", /(^|\.)successfactors\.(com|eu)$/i],
  ["jobvite", /(^|\.)jobvite\.com$/i],
  ["oracle cloud", /(^|\.)oraclecloud\.com$/i],
  ["ukg", /(^|\.)(ultipro|ukg)\.com$/i],
  ["adp", /(^|\.)adp\.com$/i],
  ["paycom", /(^|\.)paycomonline\.net$/i],
  ["paylocity", /(^|\.)paylocity\.com$/i],
  ["eightfold", /(^|\.)eightfold\.ai$/i],
  ["dayforce", /(^|\.)dayforcehcm\.com$/i],
  ["linkedin", /(^|\.)linkedin\.com$/i],
  ["indeed", /(^|\.)indeed\.com$/i],
];

/** The boards whose forms this bot fills. */
export const FILLABLE = new Set(["greenhouse", "ashby", "lever", "workday", "rippling", "workable", "applytojob"]);

export function atsOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  return HOSTS.find(([, pattern]) => pattern.test(host))?.[0] ?? "";
}
