/**
 * BrowserOps, over Chrome, in this process.
 *
 * This is the only file in the apply module that knows `chrome` exists. The
 * point of the seam is that the same methods implemented over a socket would
 * put the engine in a local helper with nothing above this line changing, so
 * the helper stays an option we can take later rather than a rewrite.
 *
 * Every method takes one turn at the front and gives it back. Chrome will
 * only capture, type into, or reliably render the active tab of the focused
 * window, so page work is serialised through `atFront` (see tabs.js) - and
 * because each call here is one short turn rather than a held lock, the
 * engine's polling loops interleave with every other job instead of
 * starving them.
 *
 * The one thing deliberately missing is a wait. There is no `waitFor`, no
 * `sleep`, no `untilVisible`: a turn that sits waiting is the exact failure
 * this design exists to prevent, so the vocabulary does not offer one.
 */

import { atFront, findTab, focus, navigate as goTo, openTab as openInFront, resident } from "../tabs.js";
import { captureFinalView } from "../evidence.js";

export function chromeBrowserOps() {
  const turn = (work) => atFront(work);

  return {
    async openTab(url) {
      const tabId = await turn(() => openInFront(url));
      // The form being filled stays in front between turns; see tabs.js.
      resident(tabId);
      return tabId;
    },

    /**
     * Take over a tab the person already had open. Returns what is actually
     * there so the caller can confirm it is the posting it thinks it is -
     * adopting the wrong tab would fill a stranger's form.
     */
    async adoptTab(tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return null;
      await turn(() => focus(tabId));
      resident(tabId);
      return { id: tab.id, url: tab.url, title: tab.title };
    },

    /**
     * A tab the person already has open, by address.
     *
     * Here because the mailbox reader needs it: a cold Gmail tab is twenty
     * seconds of loading at every verification step, and the one already
     * open answers a changed hash in one. Finding costs no turn - nothing
     * is focused or run - so it is outside the queue deliberately.
     */
    findTab: (patterns) => findTab(patterns, (tab) => !tab.discarded).then((tab) => (tab ? { id: tab.id, url: tab.url, title: tab.title } : null)),

    async closeTab(tabId) {
      resident(null);
      await chrome.tabs.remove(tabId).catch(() => {});
    },

    navigate: (tabId, url) => turn(() => goTo(tabId, url)),

    inject: (tabId, files) => turn(() => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files })),

    /**
     * Run a function in the page.
     *
     * With a frame, the frame's own answer. Without one, every frame's -
     * which is not a convenience: a careers site embeds its board in an
     * iframe, so the question "is there a form here" has no single frame to
     * ask, and the answers have to be compared.
     */
    inFrame: (tabId, frameId, func, args = []) =>
      turn(async () => {
        const target = frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
        const results = await chrome.scripting.executeScript({ target, world: "MAIN", func, args });
        return frameId === undefined ? results.map((result) => ({ frameId: result.frameId, result: result.result })) : results[0]?.result;
      }),

    frames: (tabId) =>
      turn(async () => {
        const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: () => location.href });
        return results.map((result) => ({ frameId: result.frameId, url: result.result }));
      }),

    info: (tabId) => chrome.tabs.get(tabId).then((tab) => ({ url: tab.url, status: tab.status, title: tab.title })).catch(() => null),

    capture: (tabId) => turn(() => captureFinalView(tabId)),
  };
}
