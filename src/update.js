/** Client/worker compatibility must be checked before trusting database replies. */
export const BUILD_VERSION = '4.8.3';
export const DATABASE_PROTOCOL = 6;
export class ExtensionUpdateError extends Error {
  constructor() {super('The popup and background are running different extension versions. Keep Developer mode on in chrome://extensions and reload to finish the update. Saved data stays in place.');this.name='ExtensionUpdateError';this.needsReload=true;}
}
export function databaseReply(response) {
  if(!response) throw new Error('The local database did not respond. Reload the extension.');
  if(response.protocol!==DATABASE_PROTOCOL || response.build!==BUILD_VERSION) throw new ExtensionUpdateError();
  if(!response.ok) throw new Error(response.error || 'The local database request failed.');
  return response.value;
}
export async function reloadExtension(runtime = chrome.runtime) {
  const state=await runtime.sendMessage({type:'state'});
  if(!state || typeof state.running!=='boolean') throw new Error('Could not check the run state. Open chrome://extensions and reload Apply Bot after the current run has stopped.');
  if(state.running) throw new Error('A run is still active. Stop it and wait for it to finish before reloading.');
  runtime.reload();
}
