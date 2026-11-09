/** Shared persistence API. Only the service worker opens SQLite. */
import { databaseRequest } from './database.js';
import { pack, unpack, bytesToBase64 } from './codec.js';
import { withDefaults } from './profile.js';
import { DEFAULT_TEMPLATE, normalizeTemplate } from './templates.js';
import {databaseReply} from './update.js';
export async function db(request) {
  const encoded = await pack(request);
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) return unpack(await databaseRequest(encoded));
  const response = await chrome.runtime.sendMessage({ type: 'database', request: encoded });
  return unpack(databaseReply(response));
}
export const stateStorage = {
  get: keys => db({ action: 'kvGet', keys }),
  set: value => db({ action: 'kvSet', value }),
  remove: keys => db({ action: 'kvRemove', keys }),
};
export const allApplications = () => db({ action: 'list', table: 'applications' });
export const getApplication = id => db({ action: 'get', table: 'applications', id });
export const saveApplications = value => db({ action: 'replace', table: 'applications', value });
export const recordResult = value => db({ action: 'put', table: 'results', value });
export const allResults = () => db({ action: 'list', table: 'results' });
export const clearResults = () => db({ action: 'replace', table: 'results', value: [] });
export const allJobs = () => db({action:'list',table:'jobs'});
export const getJob = id => db({action:'get',table:'jobs',id});
export const saveJob = value => db({action:'put',table:'jobs',value:{...value,updatedAt:Date.now()}});
export const allHistory = () => db({action:'list',table:'history'});
/* The questions nobody could answer, and the answers given since. */
export const allQuestions = () => db({action:'list',table:'questions'});
export const askedQuestions = sightings => db({action:'questionAsk',value:sightings});
export const answerAsked = (key,answer) => db({action:'questionAnswer',value:{key,answer}});
export const usedAnswers = keys => db({action:'questionUsed',value:keys});
export const forgetQuestion = id => db({action:'delete',table:'questions',id});
/** The pack as the answer rules want it: keyed by question, answered entries only. */
export async function answerPack() {
  const rows = await allQuestions().catch(() => []);
  return Object.fromEntries(rows.filter(row => String(row?.answer ?? '').trim()).map(row => [row.id ?? row.key, row]));
}
export const importHistory = rows => db({action:'historyImport',value:rows});
export const deleteHistory = id => db({action:'delete',table:'history',id});
export const setHistoryCompany = (id,company,aliases=[]) => db({action:'historyCompany',value:{id,company,aliases}});
export const claimSubmission = application => db({action:'claimSubmission',value:{applyUrl:application.applyUrl,sourceUrl:application.sourceUrl,id:application.id,company:application.company,title:application.title}});
export const releaseSubmission = application => db({action:'releaseSubmission',value:{applyUrl:application.applyUrl}});
export const saveLinks = links => stateStorage.set({ links, linksLoadedAt: Date.now() });
export async function allLinks() { const v = await stateStorage.get(['links', 'linksLoadedAt']); return { links: v.links || [], at: v.linksLoadedAt || 0 }; }
export const clearLinks = () => stateStorage.remove(['links', 'linksLoadedAt']);
export const savePairings = pairings => stateStorage.set({ pairings, pairingsLoadedAt: Date.now() });
export async function allPairings() { const v = await stateStorage.get('pairings'); return Array.isArray(v.pairings) ? v.pairings.filter(row => row && row.link && row.resumeId) : []; }
export const clearPairings = () => stateStorage.remove(['pairings', 'pairingsLoadedAt']);
export const allResumes = () => db({ action: 'list', table: 'resumes' });
export const getResume = id => db({ action: 'get', table: 'resumes', id });
export const saveResume = value => db({ action: 'put', table: 'resumes', value: { ...value, updatedAt: Date.now() } });
export const deleteResume = id => db({ action: 'delete', table: 'resumes', id });
export async function allTemplates() { const saved = await db({ action: 'list', table: 'templates' }); return saved.some(t => t.id === 'default') ? saved : [structuredClone(DEFAULT_TEMPLATE), ...saved]; }
export async function getTemplate(id = 'default') { return normalizeTemplate(await db({ action: 'get', table: 'templates', id }) || DEFAULT_TEMPLATE); }
export const saveTemplate = value => db({ action: 'put', table: 'templates', value: normalizeTemplate(value) });
export const deleteTemplate = id => db({ action: 'delete', table: 'templates', id });
export async function readProfile() {
  const { profile: stored } = await stateStorage.get('profile');
  const profile = withDefaults(stored);
  const template = await getTemplate(profile.activeTemplateId);
  return { ...profile, template };
}
export async function writeProfile(value) {
  const stored = (await stateStorage.get('profile')).profile || {};
  const profile = withDefaults({ ...stored, ...value });
  await stateStorage.set({ profile });
  return profile;
}
export async function forgetKeys() {
  const stored = (await stateStorage.get('profile')).profile;
  if (stored && JSON.stringify(stored) !== JSON.stringify(withDefaults(stored))) await stateStorage.set({ profile: withDefaults(stored) });
}
export const toBase64 = async blob => bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
