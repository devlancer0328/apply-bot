import {captureFinalView} from './evidence.js';
import {atFront} from './tabs.js';
import {applicationFolder,MANUAL_ROOT,save} from './vault.js';

/**
 * Save before closing. Capture/storage failures keep the application available for review.
 *
 * `keepPicture` is false only when health.js has reported the disk too
 * full to spend two hundred kilobytes on a screenshot. The page is still
 * photographed and still checked for having changed underneath, because
 * that check is what decides whether the tab is safe to close - dropping
 * it along with the file would leave a closed tab on a page nobody looked
 * at.
 */
export async function finishApplicationTab({tabId,application,result,keepOpen=false,keepPicture=true}) {
  if (!result) return {closed:false,error:'No application outcome was available; the tab was kept open.'};
  return atFront(async()=>{
    try {
      const picture = await captureFinalView(tabId);
      const root = keepOpen ? 'review' : ['submitted','unconfirmed'].includes(result.status) ? 'applied' : MANUAL_ROOT;
      const folder = result.detail?.folder || applicationFolder(application,root);
      const path = `${folder}/Last page.png`;
      if (keepPicture) await save(path,picture.content,{type:'image/png',overwrite:true});
      result.detail = {...result.detail,folder,...(keepPicture?{lastScreenshot:{path,url:picture.url,title:picture.title,capturedAt:picture.capturedAt}}:{})};
      delete result.detail.screenshotError;
      if (!keepOpen) {
        const current = await chrome.tabs.get(tabId);
        if (current.url !== picture.url) throw new Error('The page changed after its screenshot was saved; the tab was kept open.');
        await chrome.tabs.remove(tabId);
      }
      return {closed:!keepOpen,path:keepPicture?path:''};
    } catch (error) {
      const message = error?.message || String(error);
      result.detail = {...result.detail,screenshotError:message};
      return {closed:false,error:message};
    }
  });
}
