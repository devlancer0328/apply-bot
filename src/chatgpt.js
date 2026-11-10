/** Browser-based ChatGPT transport with bounded requests and isolated worker conversations. */

import { ProviderError, setModelTransport,extractJsonObject,parseModelJson } from "./vendor/generation.js";
import {jobHtmlText} from './greenhouse.js';
import { atFront, disown, findTab, focus, navigate, ourTabs, own, reapTabs, settled, touch } from "./tabs.js";
import {ChatWorkerPool,parallelChatUrl} from './chat-workers.js';
import {deadline} from './deadline.js';
import {withChatRecovery} from './chat-recovery.js';
import {taskMode,selectChatGptMode} from './chatgpt-mode.js';

export const CHATGPT_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];

/**
 * A fresh chat. Temporary, so a run of forty applications does not leave
 * forty conversations in the user's history; the parameter is ignored on an
 * account that does not offer it, which only means the chats are kept.
 */
const NEW_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

/** How long one reply may take. A full resume streams in well under this. */
const REPLY_TIMEOUT_MS = 6 * 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ChatGPT tab the user keeps open, or null. First by window and position, so the ChatGPT tab wins. */
const ownedTabs=new Set(),workerTabs=new Map();
const workerTabKey=(slot,request)=>slot+':'+(request.verbatim?'resume':request.task==='form-answers'?'answers':request.webSearch?'research':'letter');
const locked=(name,work,mode='exclusive')=>globalThis.navigator?.locks?navigator.locks.request(name,{mode},work):work();
const front=work=>atFront(()=>locked('apply-bot-chatgpt-ui',work));
// Ownership is the shared tab ledger's (see tabs.js), not a second list
// kept here. There was a second list, and the cost of it was that only
// ChatGPT tabs could ever be tidied up: everything else this bot opened
// had no record saying it was ours, so nothing dared close it.
async function sharedOwnedTabs(){return (await ourTabs('chatgpt')).map(lease=>lease.tabId);}
async function rememberOwned(tabId,add,lease={}){add?await own(tabId,'',{purpose:'chatgpt',...lease}):await disown(tabId);}
export const chatGptTab = async()=>{const other=new Set(await sharedOwnedTabs());return findTab(CHATGPT_PATTERNS,tab=>!ownedTabs.has(tab.id)&&!other.has(tab.id));};

/* -------------------------------------------------------------- in-page */

/**
 * Runs inside the ChatGPT page. What is on it: whether a composer is there
 * to type into, whether the page is asking for a sign-in, whether a reply
 * is streaming. Self-contained, since it is serialised into the page.
 */
function probePage() {
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const composer = [
    "#prompt-textarea",
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][data-placeholder]",
    "textarea[name='prompt']",
    "textarea[placeholder*='Ask' i]",
    "textarea[placeholder*='Message' i]",
    "[role='textbox'][contenteditable='true']",
  ]
    .map((selector) => document.querySelector(selector))
    .find(element=>visible(element)&&!/^pending[-_]/i.test(element.id||''));
  const buttons = [...document.querySelectorAll("button, a[role='button']")];
  const labelled = (pattern) => buttons.find((button) => pattern.test(`${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("data-testid") ?? ""} ${button.textContent ?? ""}`) && visible(button));
  const signIn = labelled(/^\s*(log in|sign in|login)\s*$/i) ?? document.querySelector("[data-testid='login-button'], a[href*='auth/login'], a[href*='/log-in']");
  const stop = document.querySelector("[data-testid='stop-button']") ?? labelled(/stop (streaming|generating)|^stop$/i);
  return {
    href: location.href,
    composer: Boolean(composer),
    composerKind: composer ? (composer.tagName === "TEXTAREA" ? "textarea" : "editor") : null,
    // Signed in, the page shows an account; signed out, it offers a log-in.
    signedOut: Boolean(visible(signIn)),
    streaming: Boolean(visible(stop)),
    assistantTurns: document.querySelectorAll("[data-message-author-role='assistant'], article[data-turn='assistant'], [data-markdown-text-style='assistant-message']").length,
  };
}

/**
 * Runs inside the ChatGPT page. Types the prompt, sends it, waits for the
 * reply to finish and returns its text. Self-contained for the same reason.
 *
 * The page's markup has changed every few months for years, so each step
 * tries the current selectors first and falls back to anything that looks
 * right: a contenteditable or textarea where the prompt goes, a button
 * labelled send, a button labelled stop while the reply is streaming, and
 * the last block marked as the assistant's for the reply. Code blocks in the
 * reply are fenced again on the way out, since the JSON parser downstream
 * knows what to do with a fence and nothing about a "Copy code" button.
 */
async function converse(prompt, options) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const buttons = () => [...document.querySelectorAll("button, a[role='button']")];
  const labelled = (pattern) =>
    buttons().find((button) => visible(button) && (pattern.test(`${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("data-testid") ?? ""}`) || pattern.test((button.textContent ?? "").trim())));
  const diagnostics = [];

  const findComposer = () =>
    [
      "#prompt-textarea",
      "div.ProseMirror[contenteditable='true']",
      "[contenteditable='true'][data-placeholder]",
      "textarea[name='prompt']",
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='Message' i]",
      "[role='textbox'][contenteditable='true']",
    ]
      .map((selector) => document.querySelector(selector))
      .find(element=>visible(element)&&!/^pending[-_]/i.test(element.id||''));

  // The assistant's turns, under whichever of the markups the page uses:
  // the long-standing data-message-author-role, the 2025 article turns, or
  // the 2026 renderer's markdown roots. The first family with any match
  // wins, so a page carrying two of them does not count each turn twice.
  const TURN_SELECTORS = ["[data-message-author-role='assistant']", "article[data-turn='assistant']", "[data-markdown-text-style='assistant-message']"];
  const turns = () => {
    for (const selector of TURN_SELECTORS) {
      const found = [...document.querySelectorAll(selector)];
      if (found.length > 0) return found;
    }
    return [];
  };
  const stopButton = () => document.querySelector("[data-testid='stop-button']") ?? labelled(/stop[ -](streaming|generating)|^stop$/i);
  /** Whether a turn is still being written, by the page's own marking of it. */
  const inProgress = (turn) => {
    const state = turn.closest("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state");
    return (state !== null && state !== undefined && state !== "complete") || turn.querySelector(".result-streaming") !== null;
  };
  const sendButton = () => document.querySelector("[data-testid='send-button']") ?? labelled(/^send( message| prompt)?$/i) ?? labelled(/send/i);

  /** The reply as text: paragraphs kept, code blocks fenced, the page's buttons left out. */
  const textOf = (turn) => {
    const clone = turn.cloneNode(true);
    // A "writing block" - the document widget longer prose is shown in -
    // carries its plain text as an attribute, which beats reading it out
    // of the widget around its header and toolbar.
    for (const block of clone.querySelectorAll("[data-markdown-copy-text]")) {
      const plain = document.createElement("div");
      plain.style.whiteSpace = "pre-wrap";
      plain.textContent = `\n${block.getAttribute("data-markdown-copy-text")}\n`;
      block.replaceWith(plain);
    }
    // Buttons, icons, widget headers, and the code block's own header ("JSON", "Copy").
    for (const junk of clone.querySelectorAll("button, [role='button'], [aria-hidden='true'], svg, nav, header, [data-markdown-copy='exclude']")) junk.remove();
    for (const pre of clone.querySelectorAll("pre")) {
      const code = pre.querySelector("code") ?? pre;
      const fence = document.createElement("div");
      // Read back through innerText, which keeps newlines only where the
      // style does.
      fence.style.whiteSpace = "pre-wrap";
      fence.textContent = `\n\`\`\`\n${code.textContent}\n\`\`\`\n`;
      pre.replaceWith(fence);
    }
    // Block elements end lines when read as innerText; the clone has to be
    // in the document for that, so it goes in off screen for a moment. Not
    // hidden: innerText leaves out text that is visibility: hidden.
    clone.style.position = "fixed";
    clone.style.left = "-100000px";
    clone.style.top = "0";
    clone.style.opacity = "0";
    clone.style.pointerEvents = "none";
    document.body.append(clone);
    const text = clone.innerText ?? clone.textContent ?? "";
    clone.remove();
    return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  };

  // 1. Somewhere to type.
  // On the new-chat home page the account can hydrate after the editor
  // appears. Wait before acquiring the editor; retaining its old node
  // across hydration can type into a detached editor and send a stale draft.
  if (options.freshChat && location.pathname === '/') await wait(2000);
  let composer = null;
  for (let waited = 0; waited < 20000 && !composer; waited += 250) {
    composer = findComposer();
    if (!composer) await wait(250);
  }
  const signIn = () => {
    const button=buttons().find((button)=>/^\s*(log in|sign in|login)\s*$/i.test(button.textContent??'')&&visible(button))||document.querySelector("[data-testid='login-button']");
    return visible(button)?button:null;
  };
  const accountLimited=()=>{
    const content='[data-message-author-role], [data-user-message-bubble], article[data-turn], [data-markdown-text-style], [data-content-search-unit-key], nav, aside, [role="menu"], [role="listbox"]';
    const notices=[...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [data-testid*="limit"], [data-testid*="error"], p, span')]
      .filter(node=>visible(node)&&!node.closest(content)&&!node.closest('#prompt-textarea, [contenteditable="true"]'))
      .map(node=>(node.innerText||node.textContent||'').trim()).filter(value=>value.length<1500).join('\n');
    return /usage cap|(?:usage|message|daily) limit (?:reached|exceeded)|(?:you(?:['’]ve| have)?\s+)?(?:reached|hit|exceeded) (?:your|the|a|.*?message) limit|too many requests|rate[ -]limit(?:ed| exceeded| reached)/i.test(notices);
  };
  if (signIn()) return { ok: false, reason: "signed-out", diagnostics: [`a log-in button is showing on ${location.href}`] };
  if(accountLimited())return {ok:false,reason:'rate-limited',diagnostics};
  if (!composer) return { ok: false, reason: "no-composer", diagnostics: [`no composer on ${location.href}`] };
  const modeMatches=()=>{
    if(!options.expectedMode)return true;
    const mode=value=>({none:'instant',instant:'instant',medium:'medium',high:'high'})[String(value||'').trim().toLowerCase()]||'';
    const selected=[...document.querySelectorAll('button[aria-label="Select ChatGPT model"], [data-composer-navigation-target="reasoning"], [data-testid="model-switcher-dropdown-button"], button[aria-label*="reasoning effort" i], button[aria-label*="thinking effort" i]')].filter(visible).map(button=>mode(button.getAttribute('data-selected-reasoning-effort'))||mode(button.getAttribute('data-selected-mode'))||mode(button.innerText||button.textContent)).find(Boolean);
    return selected===options.expectedMode;
  };
  diagnostics.push(`composer: ${composer.tagName.toLowerCase()}${composer.id ? `#${composer.id}` : ""}`);
  if (options.webSearch) {
    const composeArea = composer.closest('form') || composer.parentElement?.parentElement;
    const search = [...(composeArea?.querySelectorAll('button') || [])].find(b => visible(b) && /^(?:search|search the web|web search)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    if (search && search.getAttribute('aria-pressed') !== 'true' && !search.disabled) { search.click(); await wait(200); diagnostics.push('requested web search in composer'); }
  }

  const canonical=value=>String(value||'').replace(/&(?:#\d+|#x[a-f\d]+|[a-z][a-z\d]+);/gi,entity=>{const node=document.createElement('span');node.innerHTML=entity;return node.textContent;}).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\s]/g,'').replace(/(\{[^{}]*?"(?:url|href)":")\[(https?:\/\/)/gi,'[$1$2');
  const promptText=node=>{const copy=node?.cloneNode(true);for(const junk of copy?.querySelectorAll('style,script,svg,[data-inline-url-icon]')||[])junk.remove();return copy?.textContent||'';};
  let before = turns().length;
  if(options.resumeOnly) {
    const users=()=>[...document.querySelectorAll("[data-message-author-role='user'], article[data-turn='user'], [data-user-message-bubble], [data-content-search-unit-key$=':user']")];
    let user=users().at(-1);
    const expand=[...(user?.querySelectorAll('button')||[])].find(b=>/^show more$/i.test((b.innerText||b.textContent||'').trim()));
    if(expand){expand.click();await wait(200);user=users().at(-1);}
    if(!user||!canonical(promptText(user)).includes(canonical(prompt)))return {ok:false,reason:'prompt-not-found',diagnostics};
    const after=turns().filter(turn=>Boolean(user.compareDocumentPosition(turn)&4));
    before=turns().length-after.length;
    diagnostics.push('Recovered the exact assigned prompt after refresh; no message resent.');
  }
  const continuingConversation=/\/c\//.test(location.pathname||'');

  // 2. The prompt into it. A textarea takes a value; the editor takes typed
  //    text, or a paste, or as a last resort its paragraphs written in.
  const typePrompt = async () => {
  composer.focus();
  await wait(100);
  if (composer.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(composer, prompt);
    else composer.value = prompt;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // The editor keeps paragraphs as elements, so the check is against the
    // first line alone, which has no newline to lose.
    const opening = (prompt.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 40);
    const holds = () => (composer.textContent ?? "").includes(opening);
    // Emptied first, so nothing the user left in the box is sent along, and
    // again before each fallback, so a half-success is not sent twice.
    const clear = () => {
      composer.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    };
    clear();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, prompt) && holds();
      diagnostics.push(`insertText: ${inserted}`);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      clear();
      try {
        const data = new DataTransfer();
        data.setData("text/plain", prompt);
        composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        await wait(300);
        inserted = holds();
        diagnostics.push(`paste: ${inserted}`);
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      clear();
      composer.innerHTML = prompt
        .split("\n")
        .map((line) => `<p>${line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) || "<br>"}</p>`)
        .join("");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(300);
      inserted = holds();
      diagnostics.push(`innerHTML: ${inserted}`);
    }
    if (!inserted) return { ok: false, reason: "could not type into the composer", diagnostics };
  }
  await wait(400);
  };

  const normalized = value => String(value || '').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,'').replace(/\s+/g,' ').trim();
  if(!options.resumeOnly) {
  let verified = false;
  for (let attempt=0;attempt<3;attempt++) {
    composer = findComposer();
    if (!composer) { await wait(250); continue; }
    const typed = await typePrompt();
    if (typed?.ok === false) return typed;
    const activeComposer = findComposer();
    // innerText adds visual spacing around auto-linked URLs, even inside
    // JSON strings. Read the editor's actual text nodes, keeping paragraph
    // boundaries, so presentation cannot change prompt verification.
    const editorCopy=activeComposer?.cloneNode(true);
    // URL chips include SVG <style> text. It is decoration, not prompt text.
    for(const node of editorCopy?.querySelectorAll('style, script, svg, [data-inline-url-icon]')||[])node.remove();
    const actualPrompt = activeComposer?.tagName === 'TEXTAREA' ? activeComposer.value : [...(editorCopy?.childNodes || [])].map(node=>node.textContent || '').join('\n');
    if (activeComposer === composer && composer.isConnected && normalized(actualPrompt) === normalized(prompt)) { verified=true; break; }
    const intendedText=normalized(prompt),actualText=normalized(actualPrompt);
    let difference=0;while(difference<Math.min(intendedText.length,actualText.length)&&intendedText[difference]===actualText[difference])difference++;
    diagnostics.push(`message box verification ${attempt+1}: same editor=${activeComposer===composer}, expected=${intendedText.length}, actual=${actualText.length}, first difference=${difference}`);
    await wait(300);
  }
  if (!verified) {
    return {ok:false,reason:'composer-changed',diagnostics:[...diagnostics,'the visible message box no longer contains the complete intended prompt']};
  }

  // 3. Send.
  if(!modeMatches())return {ok:false,reason:'mode-changed',diagnostics:[...diagnostics,'The selected ChatGPT mode changed before sending. No prompt was sent.']};
  let sent = false;
  for (let attempt = 0; attempt < 80 && !sent; attempt += 1) {
    if(signIn())return {ok:false,reason:'signed-out',diagnostics};
    if(accountLimited())return {ok:false,reason:'rate-limited',diagnostics};
    if(!modeMatches())return {ok:false,reason:'mode-changed',diagnostics:[...diagnostics,'The selected ChatGPT mode changed while waiting for Send. No prompt was sent.']};
    const button = sendButton();
    if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
      button.click();
      sent = true;
      diagnostics.push("sent: button");
    } else {
      await wait(250);
    }
  }
  if (!sent) {
    return {ok:false,reason:'send-not-ready',diagnostics:[...diagnostics,'The Send button did not become enabled; no keyboard fallback was attempted and no send was claimed.']};
  }

  }

  // 4. The reply: a new assistant turn that has stopped changing, with no
  //    stop button on the page. The text is sampled rather than the DOM
  //    watched, so a page that re-renders the same words is not mistaken
  //    for one still streaming.
  const started = Date.now();
  let lastText = "";
  let stableSince = 0;
  let began = false;
  let retryNoticeUntil=0;
  const untrustedNotice="[data-message-author-role='user'], article[data-turn='user'], [data-user-message-bubble], [data-content-search-unit-key$=':user'], nav, aside, pre, code";
  const platformRetry=()=>buttons().find(button=>visible(button)&&/^retry$/i.test((button.innerText||button.textContent||'').trim())&&!button.closest(untrustedNotice));
  const inspectReply=async(foreground=false,errorsOnly=false)=>{
    if (Date.now() - started > options.timeoutMs) return { ok: false, reason: "timeout", diagnostics, partial: lastText };
    if(signIn())return {ok:false,reason:'signed-out',diagnostics};

    // The page's own failure notices, with their Retry button: a dropped
    // upstream connection, a stream that ended early. Reported as such so
    // the exchange is tried again in a fresh chat rather than waited on.
    // Long job prompts can push an error past the body-text prefix. Read
    // visible alerts separately so session errors are not missed there.
    const notices = [...document.querySelectorAll('[role="alert"], [role="status"], [data-testid*="error"]')].filter(node=>visible(node)&&!node.closest(untrustedNotice)).map(element => (element.innerText || element.textContent || '').slice(0,2000));
    const retry=platformRetry();
    for(let node=retry?.parentElement,depth=0;node&&node!==document.body&&depth<3;node=node.parentElement,depth++){
      if(node.closest(untrustedNotice)||node.querySelector(untrustedNotice))break;
      const value=(node.innerText||node.textContent||'').trim();if(value.length<=2500)notices.push(value);
    }
    const banner = notices.join('\n');
    if (Date.now()>=retryNoticeUntil && /your account changed\.?\s*send your message again/i.test(banner) && retry) {
      return { ok: false, reason: 'account-changed', diagnostics: [...diagnostics, 'ChatGPT reported that the signed-in account changed'] };
    }
    const failed = /something went wrong|network error|an error occurred|upstream connect error|connection failure|failed to (?:send|get a response)|error (?:generating|in message stream)|try again later/i.test(banner);
    if (Date.now()>=retryNoticeUntil && failed && retry) {
      return { ok: false, reason: "page-error", diagnostics: [...diagnostics, `the page reported an error: ${banner.match(/[^\n]*(?:error|failed|wrong|failure)[^\n]*/i)?.[0]?.slice(0, 160) ?? "unknown"}`], partial: lastText };
    }
    // Requirements about rate limiting are job data, not account notices.
    if (accountLimited()) {
      return { ok: false, reason: "rate-limited", diagnostics };
    }
    if(errorsOnly)return null;

    const current = turns();
    if (current.length <= before) {
      if (Date.now() - started > 45000 && !began) {
        return { ok: false, reason: "no-reply", diagnostics: [...diagnostics, "nothing appeared after sending"] };
      }
      return null;
    }
    began = true;
    const text = textOf(current[current.length - 1]);
    const streaming = visible(stopButton()) || inProgress(current[current.length - 1]);
    if (text !== lastText) {
      lastText = text;
      stableSince = Date.now();
      return null;
    }
    if (!streaming && text && Date.now() - stableSince >= options.settleMs) {
      let turn = current[current.length - 1];
      const nativeCitations = [...turn.querySelectorAll('a[href]')].filter(a => a.matches('[data-testid*="citation"], [data-citation-id], [class*="citation"]') || a.closest('[data-testid*="citation"], [data-citation-id], [class*="citation"]')).map(a => ({url:a.href,title:(a.textContent || a.getAttribute('aria-label') || '').trim()})).filter(c => /^https?:\/\//i.test(c.url));
      const nativeSourceCards=[];
      if(options.detached&&options.webSearch&&!nativeCitations.length&&!foreground)return {ok:true,needsForeground:true};
      if(options.webSearch && !nativeCitations.length) {
        let trigger=null;
        // Source badges hydrate after the answer, especially when a hidden
        // worker comes forward. Do not turn a completed Search into missing
        // evidence because its badge was absent on the first foreground read.
        for(let attempt=0;attempt<21;attempt++){
          turn=turns().at(-1)||turn;
          const scope=turn.closest('[data-content-search-unit-key$=":assistant"]')||turn;
          for(const a of scope.querySelectorAll('a[href]'))if((a.matches('[data-testid*="citation"], [data-citation-id], [class*="citation"]')||a.closest('[data-testid*="citation"], [data-citation-id], [class*="citation"]'))&&/^https?:\/\//i.test(a.href)&&!nativeCitations.some(c=>c.url===a.href))nativeCitations.push({url:a.href,title:(a.textContent||a.getAttribute('aria-label')||'').trim()});
          trigger=[...scope.querySelectorAll('[data-d-component="popover-trigger"][aria-haspopup="dialog"]')].find(node=>visible(node)&&node.querySelector('[data-d-component="badge"] [data-d-component="favicon"]'));
          if(trigger||nativeCitations.length)break;
          if(attempt<20)await wait(150);
        }
        if(trigger) {
          const alreadyOpen=trigger.getAttribute('aria-expanded')==='true';
          const beforeDialogs=new Set(document.querySelectorAll('[role="dialog"]'));
          if(!alreadyOpen)trigger.click();
          try {
            for(let attempt=0;attempt<10&&!nativeSourceCards.length;attempt++) {
              await wait(100);
              const popup=[...document.querySelectorAll('[role="dialog"]')].find(node=>(alreadyOpen||!beforeDialogs.has(node))&&node.querySelector('[data-d-component="pressable"][aria-label^="Open "] [data-d-component="favicon"]'));
              for(const button of popup?.querySelectorAll('[data-d-component="pressable"][aria-label^="Open "]') || []) {
                const title=button.querySelector('[data-d-weight="medium"]')?.textContent?.trim();
                const favicon=button.querySelector('[data-d-component="favicon"] img');
                try {const domain=new URL(favicon.src).searchParams.get('domain');if(title&&domain)nativeSourceCards.push({title,domain:new URL(domain.includes('://')?domain:`https://${domain}`).hostname});}catch{}
              }
            }
          } finally {if(!alreadyOpen&&trigger.getAttribute('aria-expanded')==='true')trigger.click();}
        }
      }
      return { ok: true, text, diagnostics, searchEvidence:{nativeCitations,nativeSourceCards} };
    }
    return null;
  };
  if(options.resumeOnly){
    const failure=await inspectReply(true,true);
    if(failure){
      const retry=platformRetry();
      if(['account-changed','page-error'].includes(failure.reason)&&retry){
        if(!modeMatches())return {ok:false,reason:'mode-changed',diagnostics};
        // The exact latest user prompt was checked above. Retry that turn
        // in place after refresh, preserving its project and prior context.
        retryNoticeUntil=Date.now()+2000;before=Math.max(0,turns().length-1);
        retry.click();diagnostics.push('Retried the verified assigned turn after refresh.');await wait(300);
      }else return failure;
    }
  }
  if(options.detached){
    // The posted-message renderer decodes entities and can move the '['
    // before a JSON URL object into its inline link label. Compare that
    // presentation canonically; the composer was verified verbatim above.
    const displayed=value=>normalized(String(value||'').replace(/&(?:#\d+|#x[a-f\d]+|[a-z][a-z\d]+);/gi,entity=>{const node=document.createElement('span');node.innerHTML=entity;return node.textContent;})).replace(/\s/g,'').replace(/(\{[^{}]*?"(?:url|href)":")\[(https?:\/\/)/gi,'[$1$2');
    const identity=()=>{const u=new URL(location.href),c=u.pathname.match(/\/c\/([^/]+)/);return u.origin+(c?'/c/'+c[1]:u.pathname);};
    // ChatGPT first assigns local-chatgpt:<uuid>, then replaces it with the
    // server conversation ID. Only the latter is a durable task identity.
    const stableConversation=()=>{const id=(location.pathname||'').match(/\/c\/([^/]+)/)?.[1];return !!id&&!/^local-chatgpt(?::|%3a)/i.test(id);};
    const task={id:options.taskId,conversation:continuingConversation&&stableConversation()?identity():'',initial:identity(),startedAt:started,check:async foreground=>{
      if(!task.conversation){const failure=await inspectReply(foreground,true);if(failure)return failure;}
      if(!task.conversation&&!stableConversation()&&Date.now()-started>45000)return {ok:false,reason:'no-reply',diagnostics:[...diagnostics,'ChatGPT did not assign a server conversation within 45 seconds.']};
      const path=location.pathname||'';
      if(task.conversation&&identity()!==task.conversation)return {ok:false,reason:'conversation-changed',diagnostics:[...diagnostics,`Assigned ${task.conversation}; now ${identity()}`]};
      if(!task.conversation&&stableConversation()){
        task.bindingStarted ||= Date.now();
        const expected=displayed(prompt);
        const users=()=>[...document.querySelectorAll("[data-message-author-role='user'], article[data-turn='user'], [data-markdown-text-style='user-message'], [data-user-message-bubble], [data-content-search-unit-key$=':user']")];
        let userNodes=users();
        const expand=userNodes.flatMap(node=>[...node.querySelectorAll('button')]).find(node=>/^show more$/i.test((node.innerText||node.textContent||'').trim()));
        if(expand&&!task.expandedAt){if(!foreground)return {ok:true,needsForeground:true};task.expandedAt=Date.now();expand.click();await wait(150);userNodes=users();}
        const ours=userNodes.some(node=>displayed(promptText(node)).includes(expected));
        if(ours)task.conversation=identity();
        else if(Date.now()-Math.max(task.bindingStarted,task.expandedAt||0)>10000){
          const actual=displayed(promptText(userNodes.at(-1)));let difference=0;while(difference<Math.min(expected.length,actual.length)&&expected[difference]===actual[difference])difference++;
          return {ok:false,reason:'conversation-changed',diagnostics:[...diagnostics,`The new conversation does not contain the complete assigned job prompt (expected ${expected.length}, displayed ${actual.length}, first difference ${difference}).`]};
        }
        else return {ok:true,pending:true,characters:0,lastProgressAt:started,startedAt:started};
      }
      if(!task.conversation&&identity()!==task.initial&&!/\/c\//.test(path))return {ok:false,reason:'conversation-changed',diagnostics};
      if(!task.conversation)return {ok:true,pending:true,characters:0,lastProgressAt:started,startedAt:started};
      return (await inspectReply(foreground))||{ok:true,pending:true,characters:lastText.length,lastProgressAt:stableSince||started,startedAt:started};
    }};
    window.__applyBotChatTask=task;
    return {ok:true,started:true,taskId:task.id};
  }
  for(;;){await wait(500);const result=await inspectReply(true);if(result)return result;}
}

/* --------------------------------------------------------------- bridge */

/**
 * The chat the tab is on and what has been said in it, so a call that
 * continues the previous one is sent as its next turn.
 */
const conversations=new Map();
let workerPool=new ChatWorkerPool(1),workerContext=null,workerSession=false,onRecovery=()=>{};
export function configureChatGptWorkers({limit=1,contextUrl='',onChange=()=>{},onRetry=()=>{}}={}){
  workerContext=parallelChatUrl(contextUrl);onRecovery=onRetry;
  workerSession=true;
  // Width needs a project or GPT address: every worker beyond the first
  // opens its own conversation inside it, and a standalone conversation
  // cannot be written to by two of them. Without one there is a single
  // worker whatever the setting says.
  // One worker kept back for form answers once there is more than one.
  // Not a partition: writing may use every worker but this one, and this
  // one returns to writing the instant no answer wants it.
  const width=workerContext?limit:1;
  // A request still running from the previous run used to refuse the new
  // one outright, and the refusal ended the run on an error - so autopilot
  // waited five minutes and started another run into the same wedged
  // request, for as long as it stayed wedged. A request that outlives its
  // run is not a reason to lose the next one: the pool keeps the slot that
  // request is holding and takes the new width around it.
  if(workerPool.active.size||workerPool.queue.length){
    workerPool.onChange=onChange;
    workerPool.reconfigure(width,{reserve:1});
  }else{
    workerPool=new ChatWorkerPool(width,onChange,{reserve:1});
  }
  workerPool.emit();return {...workerPool.status(),contextSupported:!!workerContext};
}
export const chatGptWorkerStatus=()=>workerPool.status();

/**
 * Close the ChatGPT tabs nothing is using.
 *
 * A worker keeps one tab per kind of task - resume, answers, research,
 * letter - and holds it with `autoDiscardable:false` so the browser cannot
 * reclaim it either. That is right while the kind is busy, because a fresh
 * tab costs a load and a sign-in check on every request, and wrong for the
 * rest of a twelve-hour night: at two workers it pins eight renderers for
 * work that finished hours ago, on a machine whose disk pressure has
 * already killed the browser once.
 *
 * A tab is only closed when nothing is using the tab itself, so a request
 * in flight can never have the page pulled out from under it, and the key
 * is dropped with the tab so the next request of that kind simply opens a
 * new one. Nothing is lost: a new request starts a new conversation anyway.
 *
 * "Nothing is using the tab" used to be read as "this tab's worker slot is
 * idle", which is a different and much larger claim: a slot holds one tab
 * per kind of task, so a busy pool protected all four of its tabs at once
 * and a run that never stopped asking for resumes never dropped the
 * research tab it had finished with at nine. Measured on a live run: two
 * worker tabs idle for seven minutes, both spared, because the slot that
 * owned them was busy in a different tab the whole time. So the question
 * is asked of the tab - which one is this request actually in - with the
 * slot kept only for the moment between a request starting and saying.
 *
 * The judging itself is the shared reaper's (see tabs.js); what belongs
 * here is only what this module knows and that file must not: which tabs
 * requests are in, whether a page is still writing out a reply, and what
 * to forget when a tab goes.
 */
export const chatTabContext=()=>{
  const tasks=[...workerPool.tasks.values()];
  return {
    busy:new Set(tasks.map(task=>task.tabId).filter(Boolean)),
    // A request that has a slot but has not reported its tab yet. The gap
    // is a few statements wide and the tab it is about to take is already
    // safe on its own freshness, but a slot nobody can place is not a slot
    // anything should be closed around.
    active:new Set(tasks.filter(task=>!task.tabId).map(task=>task.slot)),
    replying:async tabId=>{
      const [probe]=await chrome.scripting.executeScript({target:{tabId},func:probePage}).catch(()=>[]);
      return Boolean(probe?.result?.streaming);
    },
    forget(tabId){
      ownedTabs.delete(tabId);conversations.delete(tabId);
      for(const [key,id] of [...workerTabs])if(id===tabId)workerTabs.delete(key);
    },
  };
};
export async function reapIdleChatGptTabs(options={}){
  const closed=await reapTabs({...options,only:'chatgpt',chat:chatTabContext()});
  return closed.map(entry=>entry.key||String(entry.tabId));
}
export async function closeChatGptWorkers(){
  if(workerPool.active.size||workerPool.queue.length)throw new Error('ChatGPT requests are still active; their tabs were kept open.');
  for(const tabId of [...ownedTabs]){
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(tab&&(isChatGptUrl(tab.url)||tab.url==='about:blank'))await chrome.tabs.remove(tabId).catch(()=>{});
    await rememberOwned(tabId,false);ownedTabs.delete(tabId);conversations.delete(tabId);
  }
  workerTabs.clear();
  workerSession=false;workerContext=null;onRecovery=()=>{};
}

/** Native source cards expose titles/domains rather than hrefs. Verify each
 * candidate URL against its native card and the fetched page's actual title. */
export async function verifyNativeSourceCards(reply) {
  const cards=reply.searchEvidence?.nativeSourceCards || [];
  if(!cards.length)return [];
  let payload;try {payload=parseModelJson(extractJsonObject(reply.text));}catch{return [];}
  const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const host=value=>String(value||'').toLowerCase().replace(/^www\./,'');
  const candidates=(Array.isArray(payload.sources)?payload.sources:[]).slice(0,6).flatMap(source=>{
    try {const url=new URL(source.url);if(url.protocol!=='https:'||url.username||url.password)return [];const sameDomain=cards.filter(card=>host(card.domain)===host(url.hostname)&&normalize(card.title).length>=20);const card=sameDomain.find(card=>normalize(source.title).includes(normalize(card.title)))||sameDomain[0];return card?[{url:url.href,card}]:[];}catch{return [];}
  }).slice(0,3);
  const verified=await Promise.all(candidates.map(async({url,card})=>{
    try {
      const response=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(5000)});
      if(!response.ok||host(new URL(response.url||url).hostname)!==host(card.domain))return null;
      const html=await response.text(),title=jobHtmlText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
      if(!normalize(title).includes(normalize(card.title)))return null;
      return {url,title:card.title,verification:'native-source-card-and-page-title',domain:card.domain};
    }catch{return null;}
  }));
  return verified.filter(Boolean);
}

/** All calls take turns at the tab. */
let line = Promise.resolve();

export class ChatGptError extends ProviderError {
  constructor(message, status) {
    super(message, status, "chatgpt");
    this.name = "ChatGptError";
  }
}

/**
 * The tab, opened if the user has not. A missing service tab is opened automatically and can be signed in by the user.
 */
async function ensureTab() {
  const open = await chatGptTab();
  if (open) return open.id;
  const tab = await chrome.tabs.create({ url: NEW_CHAT_URL, active: true });
  await settled(tab.id);
  return tab.id;
}

/** One prompt from a system instruction and the turns so far, for a fresh chat. */
function flatten(system, messages) {
  const parts = [];
  if (system?.trim()) parts.push(`INSTRUCTIONS\n\n${system.trim()}`);
  for (const message of messages) {
    if (message.role === "assistant") parts.push(`YOUR EARLIER REPLY\n\n${message.content}`);
    else parts.push(parts.length === 0 ? message.content : `REQUEST\n\n${message.content}`);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * What a reply has to look like, said once at the end where it is remembered.
 * A request that does not say is a JSON one, as it is for the providers,
 * whose strict JSON mode is on unless the request asks for text.
 */
function shaping(format) {
  if (format === "text") return "\n\nReply with the text asked for only: no preamble, no closing remark, no heading.";
  return "\n\nReply with the JSON object only, inside a single ```json code block, with no words before or after it.";
}

/**
 * Whether this request continues the chat the tab is already on: the same
 * instructions, and every turn but the last already exchanged there.
 */
function continues(tabId, request) {
  const current=conversations.get(tabId)||{tabId:null,system:'',sent:[]};
  if (current.tabId !== tabId || current.system !== request.system) return false;
  const prior = request.messages.slice(0, -1);
  if (prior.length === 0 || prior.length !== current.sent.length) return false;
  return prior.every((message, index) => message.role === current.sent[index].role && message.content === current.sent[index].content);
}

/**
 * The transport: a model call, answered by the tab.
 *
 * Raises ProviderError with the statuses the callers already understand -
 * 401 for a page asking to sign in, 429 for a usage limit, 502 for a reply
 * that never came - so the rest of the bot treats a signed-out ChatGPT the
 * way it treated a rejected key: stop the run and say so.
 */
export async function askChatGpt(request) {
  if(!workerSession&&workerPool.closed&&!workerPool.active.size)workerPool=new ChatWorkerPool(1);
  // Stateless web research can overlap in temporary chats without inheriting
  // the resume project's instructions or touching the user's conversation.
  const owned=Boolean(workerSession&&(!request.verbatim||(workerContext&&workerPool.configured>1)));
  /**
   * A form answer goes to the front of the queue; a resume waits its turn.
   *
   * Both used to be first-come, and they are not worth the same. Writing
   * a resume holds nothing: it is a prompt and a wait, and starting it a
   * minute later costs a minute. Answering a form question holds an
   * employer's page open with half a form filled into it, inside an
   * attempt deadline that is counting - so every second it spends behind
   * a queue of resumes is a second of that deadline spent waiting for
   * work that was not in a hurry, and the attempt that times out over it
   * loses the document that was already written for it.
   *
   * Measured on a simulated night at four workers, this and the slot the
   * pool keeps back for it are worth about five per cent of throughput;
   * the structure around them is worth more, but this is the half that
   * costs nothing and cannot overshoot an account's concurrency limit.
   */
  const urgent=request.task==='form-answers';
  const work=()=>workerPool.run(slot=>{
    const execute=()=>exchange(request,owned?slot:null,slot);
    return globalThis.navigator?.locks?navigator.locks.request('apply-bot-chatgpt',{mode:workerPool.limit>1?'shared':'exclusive'},execute):execute();
  },{urgent,label:request.tracking?.label||request.tracking?.company|| (request.verbatim?'Resume':request.webSearch?'Web research':request.format==='text'?'Cover letter':'Form answers'),mode:taskMode(request),stage:'Starting'});
  if(owned)return work();
  const turn = line.then(work, work);
  line = turn.then(
    () => {},
    () => {},
  );
  return turn;
}

/**
 * A reply that declines the request instead of answering it.
 *
 * ChatGPT answers the same prompt differently from one chat to the next,
 * and now and then it declines to write a resume at all and says so in
 * prose - or in a JSON object with nothing but an "error" in it. Either way
 * the reply holds none of what was asked for, so it is named for what it
 * is rather than handed to the parser to be reported as a schema problem.
 */
function declined(text, format) {
  // A completed payload may discuss fabrication, fictional data or an error
  // as part of legitimate resume/research content. Those words alone must
  // not turn a usable document into a refusal.
  try {
    const payload=parseModelJson(extractJsonObject(text));
    if(payload && typeof payload==='object' && !payload.error && !payload.contextRequired &&
      ['sections','experience','summary','coreSkills','answers','findings','sources','1'].some(key=>payload[key]!==undefined))return false;
  } catch {}
  const refusing =
    /\b(?:I\s+(?:can(?:'|’)?t|cannot|won(?:'|’)?t|am\s+unable\s+to|am\s+not\s+able\s+to)\s+(?:help|assist|create|write|produce|generate|provide|do|invent|fabricate|present|comply)|fabricat|falsif|misrepresent|fiction(?:al|itious)|invent(?:ed|ing)?\s+(?:employ|work|job|career|experience)|not\s+able\s+to\s+comply|"error"\s*:)/i.test(
      text,
    );
  if (!refusing) return false;
  if (format === "text") return !/^\s*Dear\b/m.test(text);
  // A JSON reply that was written holds the fields asked for, not an apology.
  return !/"(?:experience|coreSkills|answers|1)"\s*:\s*[[{"]/.test(text);
}

async function exchange(request,slot=null,poolSlot=0) {
  const recovery={};
  try{return await withChatRecovery(()=>exchangeOnce(request,slot,poolSlot,recovery),{
    signal:request.signal,
    progress:info=>{workerPool.progress(poolSlot,{stage:'Refreshing ChatGPT - Retry '+info.retry+'/'+info.limit,retry:info.retry,lastProgressAt:Date.now()});onRecovery(info);},
    refresh:async()=>front(async()=>{
      if(request.signal?.aborted)throw new ChatGptError('The run was stopped.',499);
      const tab=await chrome.tabs.get(recovery.tabId).catch(()=>null);
      if(!tab) {recovery.resume=false;return;}
      if(!isChatGptUrl(tab.url))throw Object.assign(new ChatGptError('The assigned tab is no longer ChatGPT; it was left untouched.',409),{retryable:false});
      if(recovery.conversation) {
        const actual=new URL(tab.url).pathname.match(/\/c\/([^/]+)/)?.[1];
        if(!actual||!recovery.conversation.endsWith('/c/'+actual))throw Object.assign(new ChatGptError('The assigned conversation changed during recovery; the other conversation was left untouched.',409),{retryable:false});
      }
      await chrome.tabs.reload(tab.id,{bypassCache:true});
      await settled(tab.id,30000);
      conversations.delete(tab.id);recovery.resume=true;
    })
  });}catch(error){
    // Retire a renderer that stayed unusable through this request's entire
    // retry budget. This does not retry the failed job or bypass account limits.
    if(slot!==null&&error.workerFailure&&error.retryable===false&&['no-composer','no-reply','send-not-ready','mode-control-missing','task-lost','page-error','timeout'].includes(error.reason||'page-error')&&ownedTabs.has(recovery.tabId)){
      const tabId=recovery.tabId,tab=await chrome.tabs.get(tabId).catch(()=>null);
      if(tab&&isChatGptUrl(tab.url))await chrome.tabs.remove(tabId).catch(()=>{});
      await rememberOwned(tabId,false);ownedTabs.delete(tabId);conversations.delete(tabId);
      const key=workerTabKey(slot,request);if(workerTabs.get(key)===tabId)workerTabs.delete(key);
    }
    throw error;
  }
}

async function exchangeOnce(request,slot=null,poolSlot=0,recovery={}) {
  if (request.signal?.aborted) throw new ChatGptError("The run was stopped.", 499);
  let tabId;
  if(slot!==null){
    const key=workerTabKey(slot,request);tabId=workerTabs.get(key);
    if(tabId&&!(await chrome.tabs.get(tabId).catch(()=>null))){await rememberOwned(tabId,false);ownedTabs.delete(tabId);conversations.delete(tabId);workerTabs.delete(key);tabId=null;}
    if(!tabId){const tab=await chrome.tabs.create({url:'about:blank',active:false});tabId=tab.id;ownedTabs.add(tabId);workerTabs.set(key,tabId);await rememberOwned(tabId,true,{key,slot});await chrome.tabs.update(tabId,{autoDiscardable:false}).catch(()=>{});}
    // The lease carries when this kind of task last ran, which is what the
    // reaper ages a worker tab by - and it is in session storage, so a tab
    // whose service worker died is still datable rather than simply unknown.
    await touch(tabId,{key,slot});
  }else tabId = await ensureTab();
  recovery.tabId=tabId;
  const current=conversations.get(tabId)||{tabId:null,system:'',sent:[]};
  const last = request.messages[request.messages.length - 1];
  if (!last || last.role !== "user") throw new ChatGptError("Nothing to ask: the last turn is not a question.", 400);

  const same = continues(tabId, request);
  // Resume generation follows the user's ChatGPT project instructions. In
  // verbatim mode send the supplied description byte-for-byte, with no
  // system wrapper, output contract, or formatting suffix.
  let prompt = recovery.prompt || (request.verbatim ? last.content : (same ? last.content : flatten(request.system, request.messages)) + shaping(request.format) + (request.webSearch ? '\nUse web search now and include native clickable web citations after the JSON code block. A plain answer without search evidence cannot be used.' : ''));
  recovery.prompt=prompt;
  // A fresh chat opens where the request says - a project of the user's,
  // whose instructions then apply - or as a temporary chat otherwise.
  const chatUrl = (slot!==null&&request.verbatim?workerContext:String(request.chatUrl ?? "").trim()) || NEW_CHAT_URL;
  const taskId=crypto.randomUUID();
  workerPool.progress(poolSlot,{tabId,taskId,stage:'Sending prompt'});

  const result = await front(async () => {
    if (!same&&!recovery.resume) {
      await navigate(tabId, chatUrl);
      // converse waits for the actual composer; no additional fixed delay.
    } else {
      await focus(tabId);
    }
    let injected;
    const selectMode=async()=>{
      workerPool.progress(poolSlot,{stage:'Selecting '+taskMode(request)+' mode'});
      const [selection]=await deadline(chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:selectChatGptMode,args:[taskMode(request)]}),45000,'ChatGPT mode selection did not respond.');
      const mode=selection?.result;
      if(!mode?.ok)throw Object.assign(new ChatGptError(mode?.error||'ChatGPT mode could not be verified.',mode?.reason==='mode-unavailable'?412:502),{reason:mode?.reason,workerFailure:mode?.reason==='mode-control-missing',chatRecovery:mode?.reason!=='mode-unavailable',retryable:mode?.reason!=='mode-unavailable'});
      recovery.mode=mode;options.expectedMode=mode.selected;
      workerPool.progress(poolSlot,{mode:mode.selected,stage:'Sending prompt'});
    };
    const options={timeoutMs:REPLY_TIMEOUT_MS,settleMs:2500,webSearch:Boolean(request.webSearch),freshChat:!same,detached:true,taskId,expectedMode:recovery.mode?.selected};
    try {
      if(recovery.resume) {
        [injected]=await deadline(chrome.scripting.executeScript({target:{tabId},func:converse,args:[prompt,{...options,resumeOnly:true}]}),30000,'ChatGPT could not inspect its refreshed conversation.');
        const resumeReply=injected?.result;
        if(resumeReply?.started||resumeReply?.ok)return resumeReply;
        if(resumeReply?.reason==='mode-changed'){
          await selectMode();
          [injected]=await deadline(chrome.scripting.executeScript({target:{tabId},func:converse,args:[prompt,{...options,resumeOnly:true}]}),30000,'ChatGPT could not retry its verified turn after selecting the required mode.');
          if(injected?.result?.started||injected?.result?.ok)return injected.result;
        }
        if(['signed-out','no-composer','rate-limited'].includes(resumeReply?.reason))return resumeReply;
        await navigate(tabId,chatUrl);
        if(!request.verbatim)prompt=flatten(request.system,request.messages)+shaping(request.format)+(request.webSearch?'\nUse web search now and include native clickable web citations after the JSON code block.':'');
        recovery.prompt=prompt;
        recovery.resume=false;
      }
      await selectMode();
      [injected] = await deadline(chrome.scripting.executeScript({
      target: { tabId },
      func: converse,
      args: [prompt, options],
    }),45000,'ChatGPT did not acknowledge sending within 45 seconds.');}
    catch(error){if(error instanceof ChatGptError)throw error;throw Object.assign(new ChatGptError(error.message,502),{workerFailure:true,chatRecovery:true});}
    return injected?.result ?? { ok: false, reason: "no result from the page" };
  }).catch(error=>{if(error instanceof ChatGptError)throw error;throw Object.assign(new ChatGptError('ChatGPT could not start its assigned request: '+error.message,502),{workerFailure:true,chatRecovery:true});});

  let reply=result;
  const readTask=async foreground=>{
    try{const [value]=await deadline(chrome.scripting.executeScript({target:{tabId},func:async(id,front)=>{
      const task=window.__applyBotChatTask;
      if(!task||task.id!==id)return {ok:false,reason:'task-lost',diagnostics:['The original ChatGPT task is no longer on its assigned tab.']};
      return {...await task.check(front),assignedConversation:task.conversation};
    },args:[taskId,foreground]}),15000,'ChatGPT response inspection stopped responding.');
    if(value?.result?.assignedConversation)recovery.conversation=value.result.assignedConversation;
    return value?.result||{ok:false,reason:'task-lost',diagnostics:[]};}
    catch(error){throw Object.assign(new ChatGptError('The assigned ChatGPT tab could not be read: '+error.message,502),{workerFailure:true,chatRecovery:true});}
  };
  if(reply.started){
    workerPool.progress(poolSlot,{stage:'Waiting for response',lastProgressAt:Date.now()});
    const deadline=Date.now()+REPLY_TIMEOUT_MS+5000;
    do{
      if(request.signal?.aborted)throw new ChatGptError('The run was stopped.',499);
      await wait(750);reply=await readTask(false);
      if(reply.pending)workerPool.progress(poolSlot,{stage:'Waiting for response',characters:reply.characters||0,lastProgressAt:reply.lastProgressAt});
      if(reply.needsForeground)reply=await front(async()=>{await focus(tabId);return readTask(true);});
    }while(reply.pending&&Date.now()<deadline);
    if(reply.pending)reply={ok:false,reason:'timeout',diagnostics:[]};
  }
  if(reply.ok&&request.webSearch&&!reply.searchEvidence?.nativeCitations?.length){
    const citations=await verifyNativeSourceCards(reply);reply.searchEvidence={...reply.searchEvidence,nativeCitations:citations};
  }

  if (!reply.ok) {
    conversations.delete(tabId);
    const detail = (reply.diagnostics ?? []).join("; ");
    const recoverable=(message,status,extra={})=>Object.assign(new ChatGptError(message,status),{chatRecovery:true,reason:reply.reason,...extra});
    switch (reply.reason) {
      case 'conversation-changed':
        throw Object.assign(new ChatGptError('The assigned ChatGPT conversation changed; its response was not used. ('+detail+')',502),{workerFailure:true,retryable:false,reason:'conversation-changed'});
      case 'task-lost':
        throw recoverable('The assigned ChatGPT task was interrupted; recovering its exact prompt and response. ('+detail+')',502,{workerFailure:true});
      case 'composer-changed':
        throw recoverable(`ChatGPT replaced its message box before sending. (${detail})`,409);
      case 'mode-changed':
        throw recoverable(`ChatGPT changed its selected mode before sending. (${detail})`,409);
      case 'account-changed':
        throw recoverable('ChatGPT reported that your account changed.',401);
      case "signed-out":
        throw recoverable(`ChatGPT is not signed in. (${detail})`,401);
      case "no-composer":
        throw recoverable(`ChatGPT's message box did not finish loading. (${detail})`,502,{workerFailure:true});
      case 'send-not-ready':
        throw recoverable(`ChatGPT's Send button is not ready. (${detail})`,502,{workerFailure:true});
      case "rate-limited":
        throw recoverable("ChatGPT says the usage limit for this account has been reached.",429);
      case "timeout":
        throw recoverable(`ChatGPT did not finish its reply within ${Math.round(REPLY_TIMEOUT_MS / 60000)} minutes.`,502,{workerFailure:true});
      case "page-error":
      case "no-reply":
        throw recoverable(`ChatGPT did not reply: ${reply.reason}. (${detail})`,502,{workerFailure:true});
      default:
        throw recoverable(`ChatGPT did not reply: ${reply.reason}. (${detail})`,502,{workerFailure:true});
    }
  }

  if (declined(reply.text, request.format)) {
    conversations.delete(tabId);
    const excerpt = reply.text.replace(/\s+/g, " ").slice(0, 200);
    throw new ChatGptError(`ChatGPT declined to write this one: "${excerpt}"`, 422);
  }

  // Remembered, so a repair pass is the next turn of this chat.
  conversations.set(tabId,{
    tabId,
    system: request.system,
    sent: [...(same ? current.sent : request.messages.slice(0, -1)), last, { role: "assistant", content: reply.text }],
  });

  // Tokens are not reported by the page; the counts are left at zero and the
  // log counts replies instead.
  return { text: reply.text, inputTokens: 0, outputTokens: 0, cachedTokens: 0, mode:recovery.mode||null, searchEvidence:reply.searchEvidence || {nativeCitations:[]} };
}

/**
 * Whether the tab is there and usable, for the settings page and the start
 * of a run. Looks without typing anything.
 */
export async function chatGptStatus({onRetry=onRecovery,contextUrl=''}={}) {
  const probe=Boolean(contextUrl&&isChatGptUrl(contextUrl));
  const tab=probe?await chrome.tabs.create({url:contextUrl,active:true}):await chatGptTab();
  if(!tab)return {ok:false,error:'No ChatGPT tab is open. Open https://chatgpt.com, sign in, and leave it open.'};
  if(probe){ownedTabs.add(tab.id);await rememberOwned(tab.id,true);}
  try {
    return await withChatRecovery(()=>front(async()=>{
      try {
      await focus(tab.id);
      await settled(tab.id,30000);
      let page;
      for(let i=0;i<40;i++){
        const [probe]=await deadline(chrome.scripting.executeScript({target:{tabId:tab.id},func:probePage}),5000,'ChatGPT readiness inspection did not respond.');
        page=probe?.result;if(page?.composer||page?.signedOut)break;
        await wait(500);
      }
      if(page?.signedOut)throw Object.assign(new ChatGptError('ChatGPT is not signed in. Open its tab and sign in.',401),{chatRecovery:true});
      if(!page?.composer)throw Object.assign(new ChatGptError("ChatGPT's message box did not finish loading after the page was brought to the front.",502),{chatRecovery:true,workerFailure:true,reason:'no-composer'});
      return {ok:true,tabId:tab.id,composer:page.composerKind};
      }catch(error){throw Object.assign(error,{chatRecovery:true});}
    }),{refresh:()=>front(async()=>{await chrome.tabs.reload(tab.id,{bypassCache:true});await settled(tab.id,30000);}),progress:onRetry});
  }catch(error){return {ok:false,error:error.message};}
  finally{if(probe){await chrome.tabs.remove(tab.id).catch(()=>{});ownedTabs.delete(tab.id);await rememberOwned(tab.id,false);}}
}

/**
 * A round trip, for the settings page's check button: one short question,
 * one short answer, so a page whose markup has moved is found out before a
 * run spends a posting on it.
 */
export async function chatGptRoundTrip() {
  const status = await chatGptStatus();
  if (!status.ok) return status;
  try {
    const reply = await askChatGpt({
      system: "You answer in as few words as possible.",
      messages: [{ role: "user", content: "Reply with the single word READY and nothing else." }],
      format: "text",
    });
    const text = String(reply.text ?? "").trim();
    if (!/ready/i.test(text)) return { ok: false, error: `ChatGPT replied, but not as asked: "${text.slice(0, 80)}". A run would likely still work; check the tab is on a normal chat.` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Points the bundle's model calls at the tab. Imported once by whoever writes. */
export function useChatGpt() {
  setModelTransport(askChatGpt);
}

/** Whether an address is somewhere on chatgpt.com a chat can start - a project, a GPT, the home page. */
export function isChatGptUrl(url) {
  try {
    const parsed = new URL(String(url ?? "").trim());
    return parsed.protocol === "https:" && /^(?:chatgpt\.com|chat\.openai\.com)$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}
