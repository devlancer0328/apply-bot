/**
 * The job list, read off Jobright's recommendations page.
 *
 * The applicant's own account recommends jobs; this takes that list as it
 * stands, in the order shown, and the run works through it. Nothing has to be
 * copied anywhere. The page is a signed-in one, so it is read in the browser
 * the applicant is signed in with rather than fetched.
 *
 * The list grows as it is scrolled. Each read has a bounded number of
 * scrolls and reports whether more remain; the next read continues from
 * that position. Only a completed feed is refreshed from the beginning.
 *
 * Each job is also named with the board it applies through, as far as that
 * can be told here. Jobright's own feed responses carry the employer's apply
 * address for most jobs, and the card's "Apply now" button carries it for
 * some of the rest, so a Taleo posting can be recognised as one before a tab
 * is spent opening it. What neither names is left unnamed rather than
 * guessed at: an unrecognised job is still a job, and a feed that quietly
 * shed the ones it could not classify would lose Greenhouse postings
 * reached through a company's own careers page.
 */

import { findTab, focus, reload } from "./tabs.js";
import { atsOf, FILLABLE } from "./ats.js";
import {deadline} from './deadline.js';

export const RECOMMEND_URL = "https://jobright.ai/jobs/recommend?from=homepage";

/** Runs inside the page. Scrolls the feed out and returns the job links in order. */
function collect(rounds,continuing=false,options={}) {
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),started=Date.now();
  const budget=Math.min(35000,Math.max(1000,options.budgetMs||35000));
  const stepWait=Math.max(250,options.stepWaitMs||650),quietWindow=Math.max(5000,options.bottomStableMs||12000);
  const visible=node=>Boolean(node&&(node.offsetWidth||node.offsetHeight||node.getClientRects?.().length));
  const canonical=value=>{try{const u=new URL(value,location.href);if(!/(^|\.)jobright\.ai$/i.test(u.hostname)||!/^\/jobs\/info\/[^/?#]+\/?$/.test(u.pathname))return '';u.hostname=u.hostname.replace(/^www\./,'');u.search='';u.hash='';return u.href.replace(/\/$/,'');}catch{return '';}};
  const anchors=()=>[...document.querySelectorAll('a[href*="/jobs/info/"]')];
  const offsite=value=>{try{const u=new URL(value,location.href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password&&!/(^|\.)(jobright\.ai|linkedin\.com|hiringcafe\.com)$/i.test(u.hostname)?u.href:'';}catch{return '';}};
  // The green "Apply now" button on a card leads to the employer's own
  // application site, so where it is a plain link its destination is readable
  // from here and the card never has to be opened to learn where it goes. The
  // card's bounds are found by climbing until the ancestor would take in a
  // second card, because an address borrowed from the neighbouring job is
  // worse than none. A scripted button leaves nothing to read, and that job
  // is reported with no address rather than a guessed one.
  const applyLink=anchor=>{try{let card=anchor;for(let node=anchor.parentElement,depth=0;node&&depth<8;node=node.parentElement,depth++){if(node.querySelectorAll('a[href*="/jobs/info/"]').length>1)break;card=node;}for(const link of card.querySelectorAll('a[href]')){const url=offsite(link.href);if(url)return url;}}catch{}return '';};
  const root=()=>document.scrollingElement||document.documentElement;
  const metrics=target=>{const isRoot=target===root()||target===document.body;return {top:Number(target?.scrollTop||0),height:Number(target?.scrollHeight||0),client:Number(isRoot?(window.innerHeight||target?.clientHeight):target?.clientHeight)||800};};
  const scroll=(target,top)=>{target.scrollTop=top;if(target===root()||target===document.body)window.scrollTo(0,top);};
  const scrollable=node=>visible(node)&&/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight+80&&node.clientHeight>180;
  const findTarget=()=>{
    const scores=new Map();
    for(const anchor of anchors())for(let node=anchor.parentElement,depth=0;node&&depth<14;node=node.parentElement,depth++)if(scrollable(node))scores.set(node,(scores.get(node)||0)+10000-depth*100);
    if(!scores.size)for(const node of document.querySelectorAll('main,section,div'))if(scrollable(node))scores.set(node,node.clientHeight);
    return [...scores].sort((a,b)=>b[1]-a[1])[0]?.[0]||root();
  };
  return (async()=>{
    const key=location.href,network=window.__applyBotJobrightNetwork;
    let state=window.__applyBotJobrightScan;
    const restarted=!continuing||!state||state.revision!==1||state.key!==key;
    if(restarted){network?.reset();state={revision:1,key,links:new Set(),jobs:new Map(),cards:new Map(),target:null,cursor:0,scope:'',observedStall:0};window.__applyBotJobrightScan=state;}
    state.jobs ||= new Map();
    state.cards ||= new Map();
    const capture=()=>{
      const count=state.links.size;
      for(const anchor of anchors()){const href=canonical(anchor.href);if(!href)continue;state.links.add(href);if(!state.cards.has(href)){const url=applyLink(anchor);if(url)state.cards.set(href,url);}}
      const net=network?.snapshot()||{};
      if(net.scope&&state.scope&&net.scope!==state.scope){state.links.clear();state.jobs.clear();state.cards.clear();state.target=null;state.cursor=0;state.observedStall=0;state.progressCount=0;state.progressHeight=0;state.scope=net.scope;return {changed:true,scopeChanged:true,net};}
      if(net.scope)state.scope=net.scope;
      for(const id of net.ids||[])state.links.add('https://jobright.ai/jobs/info/'+id);
      for(const entry of net.entries||[])if(/^[a-f0-9]{24}$/i.test(entry.id||'')){const link='https://jobright.ai/jobs/info/'+entry.id;state.jobs.set(link,{...entry,link});}
      return {changed:state.links.size!==count,net};
    };
    capture();
    for(let waited=0;!state.links.size&&waited<15000;waited+=500){await pause(500);capture();if(/no (?:matching |recommended |new |more |available )?(?:jobs|results)|no recommendations|all caught up/i.test(document.body?.innerText||''))break;}
    if(state.target&&!state.target.isConnected){state.cursor=0;state.lastHeight=undefined;state.lastNetwork=undefined;state.observedStall=0;}
    let target=state.target?.isConnected?state.target:findTarget();state.target=target;
    if(!target)return {links:[...state.links],more:true,complete:false,unavailable:true,error:'The Jobright job-list scroll container could not be found.'};
    scroll(target,restarted?0:state.cursor);await pause(300);capture();
    let moves=0,quietSince=null,confirmations=0,lastHeight=state.lastHeight??-1,lastNetwork=state.lastNetwork??-1,complete=false,reason='chunk-limit',error='';
    while(Date.now()-started<budget){
      if(!target.isConnected){target=findTarget();if(!target){error='Jobright replaced its job list and the new list could not be found.';break;}state.target=target;state.cursor=0;scroll(target,0);quietSince=null;await pause(stepWait);}
      const sample=capture();
      if(sample.scopeChanged){target=findTarget();state.target=target;scroll(target,0);quietSince=null;confirmations=0;await pause(stepWait);continue;}
      const net=sample.net,m=metrics(target),maximum=Math.max(0,m.height-m.client),atBottom=m.top>=maximum-6;
      const changed=sample.changed||m.height!==lastHeight||(net.version||0)!==lastNetwork;
      if(changed){quietSince=null;confirmations=0;}
      if(state.links.size>(state.progressCount||0)||m.height>(state.progressHeight||0)+m.client*.5){state.observedStall=0;state.progressCount=state.links.size;state.progressHeight=m.height;}
      lastHeight=state.lastHeight=m.height;lastNetwork=state.lastNetwork=net.version||0;state.cursor=m.top;
      if(!atBottom){
        if(moves>=Math.max(1,rounds||8))break;
        scroll(target,Math.min(maximum,m.top+Math.max(100,Math.floor(m.client*.78))));moves++;await pause(stepWait);continue;
      }
      const loading=[...target.querySelectorAll('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning, [class*="loading"], [class*="spinner"]')].some(visible);
      if(net.error){error=net.error;break;}
      if(loading||net.inflight>0){quietSince=null;confirmations=0;reason=loading?'waiting-for-loader':'waiting-for-network';}
      else {
        quietSince??=Date.now();
        if(Date.now()-quietSince>=quietWindow&&net.hasMore!==true){
          if(++confirmations>=3){complete=true;reason=net.terminal?'backend-end-confirmed':'stable-bottom-confirmed';break;}
        }
        reason=net.hasMore===true?'waiting-for-next-page':'confirming-bottom';
      }
      if(state.observedStall>=45000){error='Jobright still has a loader, pending request, or another page, but the feed did not advance during 45 seconds of active checking.';break;}
      const before=Date.now();
      // A small bounce re-triggers lazy loaders without skipping any cards.
      if(!loading&&!net.inflight&&maximum>120){scroll(target,maximum-Math.min(120,Math.floor(m.client*.12)));await pause(150);scroll(target,maximum);}
      await pause(650);state.observedStall+=Date.now()-before;
    }
    const finalSample=capture(),end=metrics(target);state.cursor=finalSample.scopeChanged?0:end.top;
    if(finalSample.scopeChanged){complete=false;reason='chunk-limit';}
    const text=(document.body?.innerText||'').slice(0,6000);
    const signedOut=/\/(?:login|signin|sign-in|signup|onboarding)/i.test(location.pathname)||(!state.links.size&&/sign in|log in|sign up/i.test(text));
    const empty=!state.links.size&&/no (?:matching |recommended |new |more |available )?(?:jobs|results)|no recommendations|all caught up|nothing found/i.test(text);
    if(empty&&!signedOut){complete=true;reason='confirmed-empty-feed';}
    if(!state.links.size&&!empty&&!signedOut)error||='Jobright showed neither job cards nor a confirmed empty feed.';
    return {links:[...state.links],entries:[...state.links].map(link=>({...state.jobs.get(link),link,...(state.cards.get(link)?{cardUrl:state.cards.get(link)}:{})})),signedOut,unavailable:Boolean(error),error,more:!complete,complete,url:location.href,scan:{reason:error?'feed-error':reason,complete,unique:state.links.size,steps:moves,top:Math.round(end.top),height:end.height,percent:Math.min(100,Math.round(end.top/Math.max(1,end.height-end.client)*100)),elapsedMs:Date.now()-started,restarted,networkObserved:Boolean(network),error}};
  })();
}

/** The tab the user keeps the recommendations open in, if there is one. */
const openRecommendations = () => findTab(["https://jobright.ai/jobs/recommend*", "https://jobright.ai/jobs/recommend"]);

/**
 * Names the board each job applies through, and counts the three answers.
 *
 * The feed's own apply address is preferred over the card's link, because it
 * is the one Jobright published for the purpose. The card's link is trusted
 * only when it names a board at all: an unrecognised address found inside a
 * card is as likely to be the employer's home page or a share link as its
 * application form, and passing that on as the apply address would send the
 * run to the wrong page. Everything else is left with no board, which reads
 * as "not known" rather than "not supported" everywhere downstream.
 *
 * The one exception is a job the feed says outright has no employer link.
 * That is not "not known": Jobright publishes the flag because those
 * postings apply through its own flow and there is no employer address to
 * find, by this route or by opening the card. Counted separately so the
 * scan line can say how much of a round is unreachable before a tab is
 * spent discovering it one job at a time.
 */
export function classified(entries=[]) {
  const named=(entries||[]).map(({cardUrl,...entry})=>{const url=entry.originalUrl||(atsOf(cardUrl)?cardUrl:'');return {...entry,...(url?{originalUrl:url}:{}),ats:atsOf(url)};});
  const unknown=named.filter(entry=>!entry.ats).length,elsewhere=named.filter(entry=>entry.ats&&!FILLABLE.has(entry.ats)).length;
  const unreachable=named.filter(entry=>!entry.originalUrl&&entry.companySiteLink===false).length;
  return {entries:named,boards:{fillable:named.length-unknown-elsewhere,elsewhere,unknown,unreachable}};
}

/**
 * Reads the recommendations and returns the links.
 *
 * The user keeps the page open in the Jobright tab, so the feed is read there
 * by scrolling it out - no page load at all on the first look. On later
 * rounds the tab is reloaded first, because the feed has moved on by then
 * and what is on screen is the hour-old list. Only when no such tab is open
 * is one opened, and that one is closed afterwards.
 *
 * `openTab` and `closeTab` are the run's own, so a tab opened here behaves
 * like every other one the run opens - in the background unless the run has
 * been told otherwise.
 */
export async function recommendedJobs({ openTab, closeTab, rounds = 8, refresh = false, detailed=false, continueFeed=false, log }) {
  const kept = await openRecommendations();
  const tabId = kept ? kept.id : await openTab(RECOMMEND_URL);
  let retained=false;
  try {
    if (kept && (refresh || kept.discarded || kept.status !== "complete")) {
      await reload(tabId);
    } else if (kept) {
      await focus(tabId);
      log?.("info", "Reading Jobright's recommendations from the tab already open");
    }
    // The feed is rendered after the page loads, so the first look waits.
    await new Promise((resolve) => setTimeout(resolve, kept && !refresh ? 500 : 2500));
    await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['src/jobright-network.js']});
    const [result] = await deadline(chrome.scripting.executeScript({ target: { tabId },world:'MAIN',func: collect,args:[rounds,continueFeed&&!refresh] }),50000,'Jobright feed inspection did not respond within 50 seconds.');
    const page = result?.result;
    if (!page) throw new Error("the recommendations page could not be read");
    if (page.signedOut) throw new Error("Jobright is not signed in on this browser, so its recommendations cannot be read");
    if(page.unavailable)throw new Error(page.error||'The Jobright feed could not be verified.');
    if(typeof page.complete!=='boolean'||page.more===page.complete)throw new Error('Jobright did not provide a consistent scan completion result.');
    const {entries,boards}=classified(page.entries);
    log?.('info',`Jobright scan: ${page.links.length} unique links, ${page.scan?.percent||0}% scroll; ${page.complete?'complete':'more remains'} (${page.scan?.reason||'unknown'}). ${boards.fillable} on a board this bot fills, ${boards.elsewhere} on one it cannot, ${boards.unknown} whose site the feed did not name${boards.unreachable?`, of which ${boards.unreachable} the feed says have no employer link at all`:''}.`);
    retained=detailed&&page.more&&!kept;
    return detailed?{...page,entries,scan:{...page.scan,boards},openedTabId:retained?tabId:null}:page.links;
  } finally {
    if (!kept&&!retained) await closeTab(tabId);
  }
}
