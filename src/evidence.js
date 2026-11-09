/** Capture the unmodified final application viewport through Chrome. */
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));

let lastFinalCapture = 0;
/** The actual final viewport: no scrolling, hidden messages, stitching or drawn browser frame. */
export async function captureFinalView(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, {active:true});
  await chrome.windows.update(tab.windowId, {focused:true});
  // Chrome permits at most two captures per second.
  const pause = 600 - (Date.now() - lastFinalCapture);
  if (pause > 0) await wait(pause);
  const [active] = await chrome.tabs.query({active:true,windowId:tab.windowId});
  if (active?.id !== tabId) throw new Error('The active tab changed before the final screenshot.');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format:'png'});
  lastFinalCapture = Date.now();
  const [after, activeAfter] = await Promise.all([
    chrome.tabs.get(tabId), chrome.tabs.query({active:true,windowId:tab.windowId}),
  ]);
  if (activeAfter[0]?.id !== tabId || after.url !== tab.url) throw new Error('The application changed during the final screenshot.');
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Chrome did not return a PNG screenshot.');
  const content = await (await fetch(dataUrl)).blob();
  if (!content.size) throw new Error('Chrome returned an empty screenshot.');
  return {content,url:after.url,title:after.title || '',capturedAt:Date.now()};
}
