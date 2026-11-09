/** Fixed task policy; model choice stays with the user's ChatGPT account. */
export const taskMode=request=>request.verbatim||request.task==='resume'?'high':request.task==='form-answers'&&!request.webSearch?'instant':'medium';

/** Self-contained: runs in ChatGPT before typing, inside the shared UI lock. */
export async function selectChatGptMode(requested) {
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const visible=node=>Boolean(node&&node.getClientRects().length&&!node.closest('[inert], [aria-hidden="true"]'));
  const mode=value=>({none:'instant',instant:'instant',medium:'medium',high:'high'})[String(value||'').trim().toLowerCase()]||'';
  // A modal menu marks the rest of the page aria-hidden. Its trigger still
  // carries the authoritative selected value while that menu is open.
  const triggerOf=()=>{const candidates=[...document.querySelectorAll('button[aria-label="Select ChatGPT model"], [data-composer-navigation-target="reasoning"], [data-testid="model-switcher-dropdown-button"], button[aria-label*="reasoning effort" i], button[aria-label*="thinking effort" i]')].filter(node=>node.getClientRects().length);return candidates.find(node=>current(node))||candidates[0];};
  const current=trigger=>mode(trigger?.getAttribute('data-selected-reasoning-effort'))||mode(trigger?.getAttribute('data-selected-mode'))||mode((trigger?.innerText||trigger?.textContent||'').trim());
  const allowed=requested==='high'?['high']:[requested,requested==='medium'?'instant':'medium'];
  let trigger;
  const editorReady=()=>Boolean(document.querySelector('div.ProseMirror[contenteditable="true"], #prompt-textarea, textarea[name="prompt"]'));
  const interactive=node=>node&&(typeof node.onclick==='function'||Object.keys(node).some(key=>/^__reactProps/.test(key)&&['onClick','onPointerDown','onKeyDown'].some(name=>typeof node[key]?.[name]==='function')));
  for(let i=0;i<80&&!trigger;i++){const candidate=triggerOf();if(editorReady()&&(interactive(candidate)||current(candidate)===requested))trigger=candidate;if(!trigger)await pause(250);}
  if(!trigger){const selected=current(triggerOf());if(requested!=='high'&&editorReady()&&allowed.includes(selected))return {ok:true,requested,selected,changed:false,fallback:true};return {ok:false,reason:'mode-control-missing',requested,error:'ChatGPT did not show its mode control.'};}
  await pause(300);trigger=triggerOf()||trigger;
  const before=current(trigger);
  if(before===requested)return {ok:true,requested,selected:before,changed:false};
  const menuOf=()=>{const id=triggerOf()?.getAttribute('aria-controls');return (id&&document.getElementById(id))||[...document.querySelectorAll('[role="menu"], [role="listbox"]')].find(visible);};
  const close=async()=>{const menu=menuOf();if(menu){menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await pause(100);}const button=triggerOf();if(button?.getAttribute('aria-expanded')==='true'){button.click();await pause(100);}};
  let result,selection;const observed=[before];
  try {
    // The first visible button can still be SSR markup. Reacquire it while
    // React hydrates instead of clicking one detached node repeatedly.
    for(let attempt=0;attempt<20&&!menuOf()?.getClientRects().length;attempt++){
      trigger=triggerOf();if(!trigger){await pause(250);continue;}
      if(trigger.getAttribute('aria-expanded')!=='true')trigger.click();await pause(250);
      if(!menuOf()?.getClientRects().length){trigger=triggerOf();trigger?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));await pause(250);}
    }
    let menu=menuOf();
    observed.push('menu:'+Boolean(menu)+'; expanded:'+triggerOf()?.getAttribute('aria-expanded')+'; sliders:'+(menu?.querySelectorAll('[role="slider"]').length||0));
    if(!menu?.getClientRects().length){
      // Non-resume work permits Instant or Medium. A verified allowed mode
      // already on the composer is usable even if its picker cannot open;
      // refreshing it three times would add minutes without changing policy.
      const selected=current(triggerOf());
      if(requested!=='high'&&allowed.includes(selected))return {ok:true,requested,selected,changed:before!==selected,fallback:true};
      return {ok:false,reason:'mode-control-missing',requested,error:'ChatGPT mode control has not finished loading. No prompt was sent.'};
    }
    const choices=()=>[...(menuOf()?.querySelectorAll('[role="menuitemradio"], [role="option"], [role="menuitem"], button')||[])].filter(node=>visible(node)&&node.getAttribute('aria-disabled')!=='true'&&!node.disabled);
    const label=node=>mode(node.getAttribute('data-reasoning-effort'))||mode(node.getAttribute('aria-label'))||mode((node.innerText||node.textContent||'').trim())||mode([...node.querySelectorAll('span')].find(n=>mode(n.textContent))?.textContent);
    for(let i=0;i<25&&!choices().some(node=>label(node))&&!menuOf()?.querySelector('[role="slider"][aria-valuemax]');i++)await pause(200);
    for(const desired of allowed){
      const option=choices().find(node=>label(node)===desired);
      if(option){option.click();await pause(250);if(current(triggerOf())===desired){result=desired;break;}}
    }
    // Current ChatGPT exposes effort as a keyboard-controlled discrete slider.
    // It can be aria-hidden while its parent presents the accessible summary.
    if(!result){
      menu=menuOf();let slider=menu?.querySelector('[data-model-picker-power-slider] [role="slider"], [role="slider"]');
      if(slider){
        const maximum=Math.min(12,Math.max(0,Number(slider.getAttribute('aria-valuemax')||0)));
        const move=async key=>{slider=menuOf()?.querySelector('[data-model-picker-power-slider] [role="slider"], [role="slider"]');if(!slider)return;slider.focus();for(const type of ['keydown','keyup'])slider.dispatchEvent(new KeyboardEvent(type,{key,code:key,bubbles:true,cancelable:true}));await pause(300);observed.push(current(triggerOf()));};
        await move('Home');let fallback='';
        for(let step=0;step<=maximum;step++){
          const selected=current(triggerOf());if(selected===requested){result=selected;break;}if(allowed.includes(selected))fallback=selected;
          if(step<maximum)await move('ArrowRight');
        }
        if(!result&&fallback){await move('Home');for(let step=0;step<=maximum;step++){if(current(triggerOf())===fallback){result=fallback;break;}if(step<maximum)await move('ArrowRight');}}
      }
    }
    // Verify the actual control after React has updated; clicking is not proof.
    trigger=triggerOf();const selected=current(trigger);
    if(!result&&allowed.includes(selected))result=selected;
    selection=result&&selected===result?{ok:true,requested,selected,changed:before!==selected}:{ok:false,reason:'mode-unavailable',requested,selected,observed,error:`ChatGPT could not select ${allowed.join(' or ')} (observed: ${observed.join(', ')||'unknown'}). No prompt was sent.`};
  }finally{await close();}
  await pause(200);const committed=current(triggerOf());
  return selection?.ok&&committed!==selection.selected?{ok:false,reason:'mode-unavailable',requested,selected:committed,observed,error:'ChatGPT did not retain the selected mode after closing its menu. No prompt was sent.'}:selection;
}
