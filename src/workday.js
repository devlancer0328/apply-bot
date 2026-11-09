/**
 * The Workday side of an application: runs inside a myworkdayjobs.com page.
 *
 * Workday is not one form but a wizard - Create Account or Sign In, My
 * Information, My Experience, Application Questions,
 * Voluntary Disclosures, sometimes Self Identify, Review - each page saved
 * on "Save and Continue". The extension's background drives the wizard from
 * outside; this script answers two questions for it - which page is this,
 * and what is on it - and does the writing, which on Workday means knowing
 * its widgets:
 *
 * - Every control sits in a `[data-automation-id="formField-<name>"]` block
 *   whose <label> or <legend> is the question.
 * - A single choice is a `button[aria-haspopup="listbox"]` that opens a
 *   `ul[role="listbox"]` of `li[role="option"]`.
 * - A searchable choice ("How did you hear about us", field of study) is a
 *   text box inside `multiSelectContainer`; the chosen values show as pills.
 * - A date is month and year spinbuttons inside `dateInputWrapper`, and the
 *   wizard only takes the date through the widget's own commit, which runs
 *   on real focus leaving it. Typing through the DOM leaves the display
 *   right and the form empty, so the date goes in through the widget's
 *   React handler instead - the one route found to work.
 * - Submit buttons are wrapped in `noCaptchaWrapper`; the visible target is
 *   the `click_filter` div over the button, and that is what gets clicked.
 * - Text boxes are uncontrolled and commit on focusout, so every write ends
 *   with a focusout event.
 */
(() => {
  if (window.__wdApply) return;

  const KEY_ATTRIBUTE = "data-wd-key";
  const registry = new Map();
  let counter = 0;

  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const byId = (id, root = document) => root.querySelector(`[data-automation-id="${id}"]`);
  const visible = (node) => Boolean(node) && node.offsetParent !== null;

  /* ------------------------------------------------------------- where */

  /** Notices that sit over the page until dismissed. */
  function dismissNotices() {
    pressIf(byId("legalNoticeAcceptButton"));
  }

  const PAGES = [
    ["applyFlowAutoFillPage", "autofill"],
    ["applyFlowMyInfoPage", "myinfo"],
    ["applyFlowMyExpPage", "experience"],
    ["applyFlowPrimaryQuestionsPage", "questions"],
    ["applyFlowVoluntaryDisclosuresPage", "disclosures"],
    ["applyFlowSelfIdentificationPage", "selfid"],
    ["applyFlowSelfIdentifyPage", "selfid"],
    ["applyFlowReviewPage", "review"],
  ];

  // Tenants word the receipt themselves. Tandem says "successfully
  // submitted", OneSource Virtual's dialog says "Application Submitted"
  // over "Thank you for completing your application" - neither phrase was
  // in here, so a sent application came back as uncertain and would have
  // been applied for twice.
  const CONFIRMED =
    /thank you for applying|thanks for applying|thank you for (?:completing|submitting) your application|application (?:has been|was) (?:submitted|received)|application submitted|successfully submitted|we(?:'ve| have) received your application/i;

  function pageErrors() {
    const heading = text(byId("errorHeading")?.textContent);
    const alerts = $$('[data-automation-id="inputAlert"], [data-automation-id="errorMessage"], [data-automation-id="signInContent"] [role="alert"]').map((node) => text(node.textContent)).filter(Boolean);
    const invalid = $$("[aria-invalid='true']").map((node) => node.id).filter(Boolean);
    return { heading, alerts: [...new Set(alerts)], invalid };
  }

  /** Which page of the wizard is showing, and what it is saying. */
  function state() {
    dismissNotices();
    const url = location.href;
    const step = text(byId("progressBarActiveStep")?.textContent).replace(/^current step \d+ of \d+/i, "").trim();
    const alert = text(byId("alertMessage")?.textContent);
    let loading = Boolean(byId("applyFlowLoadingPage")) || /page is loading/i.test(text(byId("applyFlowPage")?.getAttribute("aria-label")));
    const errors = pageErrors();
    const rawMain=String((byId("applyFlowPage") || byId("pageMainContent") || document.body)?.innerText ?? "");
    const main = text(rawMain).slice(0, 4000);

    let kind = "unknown";
    const page = PAGES.find(([id]) => byId(id));
    if (byId("createAccountSubmitButton")) kind = "create";
    else if (byId("signInSubmitButton")) kind = "signin";
    else if (byId("SignInWithEmailButton") || byId("CreateAccountWithEmailButton")) kind = "chooseSignIn";
    else if (page) kind = page[1];
    else if ($('[data-automation-id^="applyFlow"][data-automation-id$="Page"]:not([data-automation-id="applyFlowPage"])')) kind = "form";
    else if (byId("autofillWithResume") || byId("applyManually") || byId("useMyLastApplication")) kind = "choose";
    else if (byId("adventureButton")) kind = "posting";
    else if (byId("applyFlowPage") && !loading) {
      // The wizard's shell with no page named in it: the moment between
      // one page leaving and the next arriving, unless fields are showing.
      kind = "form";
      if (!$('[data-automation-id^="formField"]')) loading = true;
    }

    // A wizard page's frame is drawn before its fields and its footer; the
    // page is not there to be worked until Continue is.
    if ((page || kind === "form") && !byId("pageFooterNextButton") && !byId("bottom-navigation-next-button") && !errors.heading && !CONFIRMED.test(main)) loading = true;

    // Only a page that is none of the wizard's can be the board's thanks.
    // The review page quotes the questions back, and the account page on
    // some sites tells the applicant to look for the "Thank you for
    // applying" email later - words that read as a confirmation if the
    // page they are on is not looked at first.
    const guestQuote=String(document.body?.innerText||'').split('\n').map(text).find(line=>/^you have successfully applied for this position\b/i.test(line))||'';
    const guestReceipt=/[?&]Job_Application_ID=[^&#]+/i.test(url)&&!page&&!byId('pageFooterNextButton')&&['unknown','create','signin','chooseSignIn'].includes(kind)&&Boolean(guestQuote);
    const confirmed = guestReceipt||(kind === "unknown" && !byId('jobPostingDescription') && CONFIRMED.test(main) && !byId("pageFooterNextButton"));
    const quote = guestReceipt?guestQuote:confirmed ? rawMain.split('\n').map(text).find(line=>CONFIRMED.test(line))||'' : "";

    // What is drawn so far. A page's fields arrive a few at a time over
    // several seconds, and a prefilled menu says "Select One" until its
    // value is fetched; the caller waits for these to hold still.
    const drawn = $$('[data-automation-id^="formField-"]');
    const menus = drawn.map((block) => text($('button[aria-haspopup="listbox"]', block)?.textContent ?? "")).join("|");

    // Workday's own failure page: "Something went wrong. Please refresh the
    // page and then try again." It means what it says, and a reload fixes it.
    const broken = /something went wrong/i.test(main) && /refresh the page/i.test(main);

    return {
      url,
      kind: confirmed ? "done" : kind,
      step,
      alert,
      loading: loading && !broken,
      broken,
      errors,
      quote,
      drawn: drawn.length,
      menus,
      nextLabel: text(byId("pageFooterNextButton")?.textContent),
      signedIn: !byId("utilityButtonSignIn"),
    };
  }

  /* ------------------------------------------------------------ writing */

  /** Writes a value the way Workday's own typing would be noticed, commit included. */
  function setValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    element.focus();
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("blur"));
  }

  /** The visible target of a button Workday wraps against scripted clicks. */
  function pressWrapped(button) {
    if (!button) return false;
    const wrapper = button.closest('[data-automation-id="noCaptchaWrapper"]');
    const filter = wrapper?.querySelector('[data-automation-id="click_filter"]');
    press(filter ?? button);
    return true;
  }

  /**
   * A press as a pointer makes it: over, down, up, click. A bare click()
   * on the first page after a load was ignored by Workday's footer; the
   * whole sequence is taken.
   */
  function pressIf(target) {
    if (target) press(target);
    return Boolean(target);
  }

  function press(target) {
    if (reactClick(target)) return;
    domPress(target);
  }

  /**
   * Workday drops scripted clicks on some pages - a bare click() on the
   * footer's Save and Continue did nothing on a freshly loaded page and on
   * the Self Identify page, while the same handler called directly moved
   * on. So the React handler is called as React would call it, with the
   * event it expects; the DOM is only clicked where there is no handler.
   */
  function reactClick(target) {
    // A control carries its own handler; a menu entry's may sit on a row above it.
    const reach = /^(?:button|a|input)$/i.test(target.tagName) ? 1 : 4;
    let node = target;
    for (let hops = 0; node && hops < reach; hops += 1, node = node.parentElement) {
      const key = Object.keys(node).find((name) => name.startsWith("__reactProps"));
      const props = key ? node[key] : null;
      if (props && typeof props.onClick === "function") {
        const native = new MouseEvent("click", { bubbles: true, cancelable: true });
        props.onClick({
          type: "click",
          target,
          currentTarget: node,
          nativeEvent: native,
          button: 0,
          buttons: 0,
          detail: 1,
          clientX: 0,
          clientY: 0,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault() {},
          stopPropagation() {},
          persist() {},
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
        });
        return true;
      }
    }
    return false;
  }

  function domPress(target) {
    const rect = target.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    target.focus?.();
    target.dispatchEvent(new PointerEvent("pointerover", at));
    target.dispatchEvent(new MouseEvent("mouseover", at));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...at, buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    target.dispatchEvent(new PointerEvent("pointerup", at));
    target.dispatchEvent(new MouseEvent("mouseup", at));
    target.dispatchEvent(new MouseEvent("click", at));
  }

  function setCheckbox(element, on) {
    if (element.checked !== on) element.click();
    return element.checked === on;
  }

  /* --------------------------------------------------------- choosing */

  const LEVELS = ["none", "beginner", "novice", "basic", "familiar", "intermediate", "proficient", "advanced", "expert"];
  function pickByNumber(nodes, target, textOf) {
    const ranges = nodes
      .map((node) => {
        const label = textOf(node).toLowerCase();
        const numbers = (label.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
        if (numbers.length === 0) return null;
        if (/less than|under|fewer than|below|<\s*\d/.test(label)) return { node, low: 0, high: numbers[0] - 0.01 };
        if (/more than|over|greater than|above|\+|>\s*\d|or more/.test(label)) return { node, low: numbers[0], high: Infinity };
        if (numbers.length >= 2) return { node, low: Math.min(numbers[0], numbers[1]), high: Math.max(numbers[0], numbers[1]) };
        return { node, low: numbers[0], high: numbers[0] };
      })
      .filter(Boolean);
    if (ranges.length > 0) {
      const holding = ranges.find((range) => target >= range.low && target <= range.high);
      if (holding) return holding.node;
      const below = ranges.filter((range) => range.low <= target).sort((a, b) => b.low - a.low)[0];
      return below ? below.node : ranges.sort((a, b) => a.low - b.low)[0].node;
    }
    const rungs = nodes
      .map((node) => ({ node, rank: LEVELS.findIndex((level) => textOf(node).toLowerCase().includes(level)) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank);
    if (rungs.length === 0) return null;
    return rungs[Math.min(rungs.length - 1, Math.max(0, Math.round((target / 10) * (rungs.length - 1))))].node;
  }

  /**
   * The option that says what we meant: an exact match first, then the
   * wording contained on word boundaries, then yes/no read off a longer
   * wording ("No, I am not" for "No").
   */
  function matchOption(nodes, candidates, textOf) {
    const usable = nodes.filter((node) => !/^select one$/i.test(textOf(node)));
    for (const candidate of candidates) {
      const want = text(candidate).toLowerCase();
      if (!want) continue;
      const exact = usable.find((node) => textOf(node).toLowerCase() === want);
      if (exact) return exact;
    }
    for (const candidate of candidates) {
      const want = text(candidate).toLowerCase();
      if (!want) continue;
      // The shortest wording that contains it: "United States" is "United
      // States of America", not "United States Minor Outlying Islands".
      const boundary = new RegExp(`\\b${escapeRegExp(want)}\\b`);
      const contained = usable.filter((node) => boundary.test(textOf(node).toLowerCase())).sort((a, b) => textOf(a).length - textOf(b).length)[0];
      if (contained) return contained;
    }
    for (const candidate of candidates) {
      const want = text(candidate).toLowerCase();
      if (/^(yes|no)$/.test(want)) {
        const lead = usable.find((node) => new RegExp(`^${want}\\b`).test(textOf(node).toLowerCase()));
        if (lead) return lead;
      }
    }
    return null;
  }

  /** The list a dropdown button opened, once it has options in it. */
  async function openListbox(button, timeout = 4000) {
    // Another menu left open would be read as this one's.
    if (listboxOpen(null)) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      await wait(100);
      if (listboxOpen(null)) press(document.body);
      await wait(100);
    }
    const started = performance.now();
    press(button);
    // The menu's entries arrive after the menu: the first paint is "Select
    // One" alone, the rest a fetch later. Wait for more than that, or for
    // the list to stop growing.
    let seen = 0;
    let since = performance.now();
    while (performance.now() - started < timeout) {
      await wait(80);
      const expanded = button.getAttribute("aria-expanded") === "true";
      const lists = $$('ul[role="listbox"]').filter((list) => list.getAttribute("data-automation-id") !== "selectedItemList" && visible(list));
      const list = lists.find((candidate) => candidate.id && button.getAttribute("aria-controls") === candidate.id) ?? lists[lists.length - 1];
      const options = list ? $$('li[role="option"]', list) : [];
      if (options.length !== seen) {
        seen = options.length;
        since = performance.now();
        continue;
      }
      const real = options.filter((node) => !/^select one$/i.test(text(node.textContent)));
      if (options.length > 0 && (expanded || lists.length > 0) && (real.length > 0 || performance.now() - since > 2500)) return options;
    }
    return [];
  }

  const listboxOpen = (button) =>
    button?.getAttribute("aria-expanded") === "true" ||
    $$('ul[role="listbox"]').some((list) => list.getAttribute("data-automation-id") !== "selectedItemList" && visible(list));

  /** Closes a menu and makes sure it is closed: an open one swallows the next click on the page. */
  async function closeListbox(button) {
    if (!listboxOpen(button)) return;
    (button ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    await wait(120);
    if (listboxOpen(button) && button) {
      press(button);
      await wait(120);
    }
    if (listboxOpen(button)) {
      press(document.body);
      await wait(120);
    }
  }

  async function setListbox(button, candidates, pick,strict=false) {
    const options = await openListbox(button);
    if (options.length === 0) return { ok: false, reason: "the menu did not open" };
    const textOf = (node) => text(node.textContent);
    const identity=value=>text(value).toLowerCase().replace(/\s*\((?:united states(?: of america)?|u\.?s\.?a?\.?)\)\s*$/i,'').trim();
    const option = strict?options.find(node=>candidates.some(candidate=>identity(textOf(node))===identity(candidate))):matchOption(options, candidates, textOf) ?? (Number.isFinite(pick) ? pickByNumber(options, pick, textOf) : null);
    if (!option) {
      await closeListbox(button);
      return { ok: false, reason: `offers ${options.map(textOf).slice(0, 8).join(" / ")}` };
    }
    const expected=textOf(option);press(option);
    await wait(150);
    const chosen = text(button.textContent);
    if (chosen && chosen !== textOf(option) && !/^select one$/i.test(textOf(option))) {
      // A click that did not land. Keyboard it.
      const reopened=await openListbox(button),fresh=reopened.find(node=>textOf(node)===expected);
      fresh?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(150);
    }
    await closeListbox(button);
    const actual=text(button.textContent);
    return strict?{ok:identity(actual)===identity(expected),reason:identity(actual)===identity(expected)?undefined:'The demographic selection did not retain the saved profile answer.'}:{ ok: !/^select one$/i.test(actual) && actual !== "" };
  }

  /* ------------------------------------------------------- multiselect */

  const promptList = () => byId("activeListContainer");
  // Entries are "promptOption" on most sites and "menuItem" rows with an
  // option role on the virtualised lists some tenants use.
  const promptOptions = () => (promptList() ? [...new Set($$('[data-automation-id="promptOption"], [role="option"]', promptList()))] : []);

  /**
   * A list entry's click handler sits on the "promptLeafNode" inside the
   * row on the virtualised lists, not on the row itself: pressing the row
   * there does nothing, which is how a required "How did you hear about
   * us?" was left empty.
   */
  function pressOption(node) {
    press($('[data-automation-id="promptLeafNode"]', node) ?? node);
  }

  function pillsOf(root) {
    return $$('[data-automation-id="selectedItem"]', root).map((pill) => text(pill.textContent));
  }

  async function openPrompt(input, timeout = 3000) {
    input.focus();
    press(input);
    const started = performance.now();
    while (performance.now() - started < timeout) {
      await wait(100);
      if (promptOptions().length > 0) return true;
    }
    return promptList() !== null;
  }

  function closePrompt(input) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.click();
  }

  /** Types into the search box and waits for the list to answer the search. */
  async function searchPrompt(input, term) {
    const before = promptOptions().map((node) => text(node.textContent)).join("|");
    setValueNoCommit(input, term);
    await wait(250);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    const started = performance.now();
    let gone = 0;
    while (performance.now() - started < 4000) {
      await wait(150);
      const now = promptOptions();
      if (now.length > 0 && now.map((node) => text(node.textContent)).join("|") !== before) return gatherPrompt();
      if (promptList() && /no (?:results|matches|items)/i.test(text(promptList().textContent))) return [];
      // The list is taken down while the search runs - half a second or so
      // - and stays down when the search finds nothing.
      if (!promptList() && (gone += 1) >= 16) return [];
    }
    return gatherPrompt();
  }

  /**
   * Every entry the open list holds. Some tenants draw the list virtualised
   * - only the rows in view exist, two of them when the tab is in the
   * background - so it is scrolled through, a row at a time, and each entry
   * is remembered with the scroll position it was seen at.
   */
  async function gatherPrompt(limit = 80) {
    const list = promptList();
    if (!list) return [];
    const seen = new Map();
    const collect = (top) => {
      for (const node of promptOptions()) {
        const label = text(node.textContent);
        if (label && !seen.has(label)) seen.set(label, { label, top });
      }
    };
    if (list.scrollTop > 0) {
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await wait(90);
    }
    collect(0);
    if (list.scrollHeight > list.clientHeight + 2) {
      const row = promptOptions()[0]?.getBoundingClientRect().height || 30;
      const step = Math.max(20, Math.round(row));
      let top = 0;
      while (top + step < list.scrollHeight && seen.size < limit) {
        top += step;
        list.scrollTop = top;
        list.dispatchEvent(new Event("scroll", { bubbles: true }));
        await wait(90);
        collect(list.scrollTop);
        if (list.scrollTop + 1 < top) break;
      }
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await wait(90);
    }
    return [...seen.values()];
  }

  /** Clicks an entry found by gatherPrompt, scrolling it back into existence if it has to. */
  async function clickPromptEntry(entry) {
    const list = promptList();
    if (!list || !entry) return false;
    const find = () => promptOptions().find((node) => text(node.textContent) === entry.label);
    let node = find();
    if (!node) {
      list.scrollTop = entry.top;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await wait(200);
      node = find();
    }
    if (!node) return false;
    pressOption(node);
    return true;
  }

  function setValueNoCommit(element, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
  }

  /** Picks a pill for a searchable choice, by browsing its list and then by searching it. */
  async function setMultiselect(root, candidates) {
    const input = $('input[type="text"]', root) ?? $("input", root);
    if (!input) return { ok: false, reason: "no search box" };
    const textOf = (node) => text(node.textContent);
    const have = pillsOf(root);
    if (have.length > 0 && matchOption(have.map((label) => ({ textContent: label })), candidates, textOf)) return { ok: true, kept: true };

    // What is already chosen goes, so the answer is ours and not a sum.
    for (const charm of $$('[data-automation-id="DELETE_charm"]', root)) {
      press(charm);
      await wait(120);
    }

    // Entries are matched as labels, since on a virtualised list the node
    // for an entry exists only while it is scrolled into view.
    const labelOf = (entry) => entry.label;
    const choose = async (entries, wanted) => {
      const entry = matchOption(entries, wanted, labelOf);
      if (!entry || !(await clickPromptEntry(entry))) return null;
      await wait(300);
      return pillsOf(root)[0] ?? null;
    };

    const opened = await openPrompt(input);
    let entries = [];
    if (opened) {
      entries = await gatherPrompt(40);
      const direct = await choose(entries, candidates);
      if (direct) return { ok: true, via: "list", chose: direct };
    }

    // Searching finds entries at any depth, and is quicker than browsing.
    // The whole wording first, then its first word alone, which is how
    // "Computer Science" finds "Computer and Information Science" on a site
    // that lacks the former.
    const tried = new Set();
    for (const candidate of candidates) {
      const term = text(candidate);
      if (!term) continue;
      const whole = term.split(/[(,/]/)[0].trim();
      const firstWord = whole.split(/\s+/)[0];
      for (const searched of [whole, firstWord.length >= 4 && firstWord !== whole ? firstWord : ""]) {
        if (!searched || tried.has(searched.toLowerCase())) continue;
        tried.add(searched.toLowerCase());
        if (!promptList()) await openPrompt(input);
        const results = await searchPrompt(input, searched);
        // A prompt that takes what is typed - the school box on some
        // tenants - makes a pill of the search itself on Enter.
        const typed = pillsOf(root);
        if (typed.length > 0 && matchOption(typed.map((label) => ({ textContent: label })), [term, whole], textOf)) return { ok: true, via: "typed", chose: typed[0] };
        if (results.length === 0) continue;
        // The entry that says it, or failing that one that at least contains
        // the first word searched for - never just whatever is at the top,
        // which on an unfiltered list is the alphabetically first entry.
        const entry =
          matchOption(results, [term, whole], labelOf) ??
          results.find((candidateEntry) => firstWord.length >= 4 && candidateEntry.label.toLowerCase().includes(firstWord.toLowerCase())) ??
          null;
        if (entry && (await clickPromptEntry(entry))) {
          await wait(300);
          const pills = pillsOf(root);
          if (pills.length > 0) return { ok: true, via: "search", chose: pills[0] };
        }
      }
    }

    // A list of categories ("Job Boards" holding "LinkedIn"): look one
    // level down in each. Last, because on a flat list every click here
    // chooses an entry instead of opening one.
    if (opened && entries.length > 0) {
      if (!promptList()) await openPrompt(input);
      for (const category of entries.slice(0, 12)) {
        if (pillsOf(root).length > 0) {
          for (const charm of $$('[data-automation-id="DELETE_charm"]', root)) {
            press(charm);
            await wait(120);
          }
        }
        if (!promptList()) await openPrompt(input);
        const before = promptOptions().map(textOf).join("|");
        if (!(await clickPromptEntry(category))) continue;
        await wait(400);
        if (pillsOf(root).length > 0 || promptOptions().map(textOf).join("|") === before) continue;
        const inside = await choose(await gatherPrompt(40), candidates);
        if (inside) return { ok: true, via: `list/${category.label}`, chose: inside };
        // Back up a level.
        const back = promptList() ? $('[data-automation-id="promptBackButton"], button[aria-label*="Back" i]', promptList()) : null;
        if (back) {
          press(back);
          await wait(300);
        } else {
          closePrompt(input);
          await openPrompt(input);
        }
      }
    }
    // Nothing fitting; a wrong pill is worse than none.
    for (const charm of $$('[data-automation-id="DELETE_charm"]', root)) {
      press(charm);
      await wait(120);
    }
    closePrompt(input);
    return { ok: false, reason: `nothing on the list matched ${candidates.slice(0, 3).join(" / ")}` };
  }

  /** The first thing the list offers, for a required choice nothing matched. */
  async function setMultiselectAny(root) {
    const input = $("input", root);
    if (!input || !(await openPrompt(input))) return false;
    const textOf = (node) => text(node.textContent);
    const first = promptOptions()[0];
    if (!first) return false;
    const before = promptOptions().map(textOf).join("|");
    pressOption(first);
    await wait(400);
    if (pillsOf(root).length > 0) return true;
    if (promptOptions().map(textOf).join("|") !== before && promptOptions()[0]) {
      pressOption(promptOptions()[0]);
      await wait(400);
    }
    return pillsOf(root).length > 0;
  }

  /* ---------------------------------------------------------------- dates */

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  /** "Mar 2024", "03/2024", "2024-03", "March 2024", "2024" → { mm, yyyy }; "Present" → null. */
  function parseMonthYear(value) {
    const raw = text(value);
    if (!raw || /present|current|now|ongoing/i.test(raw)) return null;
    let match = raw.match(/\b(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?\b/);
    if (match) return { yyyy: match[1], mm: pad(match[2]), dd: match[3] ? pad(match[3]) : undefined };
    match = raw.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
    if (match) return { mm: pad(match[1]), dd: pad(match[2]), yyyy: match[3] };
    match = raw.match(/\b(\d{1,2})[-/](\d{4})\b/);
    if (match) return { mm: pad(match[1]), yyyy: match[2] };
    match = raw.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
    if (match && MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) >= 0) {
      return { mm: pad(MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1), dd: pad(match[2]), yyyy: match[3] };
    }
    match = raw.match(/\b([A-Za-z]{3,})\.?,?\s+(\d{4})\b/);
    if (match && MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) >= 0) {
      return { mm: pad(MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1), yyyy: match[2] };
    }
    match = raw.match(/\b(\d{4})\b/);
    if (match) return { yyyy: match[1] };
    return null;
  }
  const pad = (number) => String(number).padStart(2, "0");

  function today() {
    const now = new Date();
    return { mm: pad(now.getMonth() + 1), dd: pad(now.getDate()), yyyy: String(now.getFullYear()) };
  }

  /** The React component behind a date widget, whose onDatePicked is the commit. */
  function dateComponent(wrapper) {
    const fiberKey = Object.keys(wrapper).find((key) => key.startsWith("__reactFiber"));
    let fiber = fiberKey ? wrapper[fiberKey] : null;
    for (let depth = 0; fiber && depth < 25; depth += 1) {
      const props = fiber.memoizedProps;
      if (props && typeof props.onDatePicked === "function" && typeof props.dateFormat === "string") return props;
      fiber = fiber.return;
    }
    return null;
  }

  /** Reads the date the widget holds, as the form knows it. */
  function readDate(wrapper) {
    const props = dateComponent(wrapper);
    return props?.value ?? null;
  }

  /**
   * Sets a date widget. `parts` holds whichever of mm, dd, yyyy the widget's
   * format wants; missing parts are left empty, which the widget treats as
   * no date.
   */
  async function setDate(wrapper, parts) {
    const props = dateComponent(wrapper);
    if (!props) return setDateByTyping(wrapper, parts);
    const format = props.dateFormat; // mmyyyy, yyyy, mmddyyyy, ddmmyyyy
    const value = {};
    if (format.includes("mm")) value.mm = parts?.mm ?? "";
    if (format.includes("dd")) value.dd = parts?.dd ?? "";
    if (format.includes("yyyy")) value.yyyy = parts?.yyyy ?? "";
    try {
      await props.onDatePicked(value);
    } catch {
      return setDateByTyping(wrapper, parts);
    }
    await wait(150);
    const after = readDate(wrapper);
    const ok = Boolean(after) && Object.entries(value).every(([key, part]) => String(after[key] ?? "") === String(part));
    return ok || setDateByTyping(wrapper, parts);
  }

  /** The fallback: type into the segments and leave the widget. */
  async function setDateByTyping(wrapper, parts) {
    const segment = (id, part) => {
      const input = $(`[data-automation-id="${id}"]`, wrapper);
      if (!input || part === undefined) return;
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: String(part)[0], bubbles: true }));
      setValueNoCommit(input, String(Number(part)));
    };
    segment("dateSectionMonth-input", parts?.mm);
    segment("dateSectionDay-input", parts?.dd);
    segment("dateSectionYear-input", parts?.yyyy);
    await wait(60);
    const away = byId("pageFooterNextButton") || document.body;
    away.focus?.();
    wrapper.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: away }));
    await wait(150);
    const after = readDate(wrapper);
    return Boolean(after && (!parts?.yyyy || String(after.yyyy) === String(parts.yyyy)));
  }

  /* ---------------------------------------------------------------- files */

  const fileItems = (root = document) => $$('[data-automation-id="file-upload-item"]', root);
  const fileNames = (root = document) => fileItems(root).map((item) => text($('[data-automation-id="file-upload-item-name"]', item)?.textContent));

  /**
   * Puts a file into an upload zone and waits for the board to take it.
   * Files already in the zone under other names are removed first, so the
   * resume that goes is this posting's.
   */
  async function upload(zoneRoot, attachment) {
    const root = zoneRoot ?? document;
    if (fileNames(root).includes(attachment.name)) {
      return { ok: true, present: true, names: fileNames(root) };
    }
    for (const item of fileItems(root)) {
      if (text($('[data-automation-id="file-upload-item-name"]', item)?.textContent) === attachment.name) continue;
      pressIf($('[data-automation-id="delete-file"]', item));
      await wait(400);
    }
    const input = $('input[type="file"]', root) ?? $('[data-automation-id="file-upload-input-ref"]');
    if (!input) return { ok: false, reason: "no file input" };

    const bytes = Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
    const file = new File([bytes], attachment.name, { type: attachment.type || "application/pdf" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const started = performance.now();
    while (performance.now() - started < 45000) {
      await wait(300);
      const item = fileItems(root).find((candidate) => text($('[data-automation-id="file-upload-item-name"]', candidate)?.textContent) === attachment.name);
      if (item && $('[data-automation-id="file-upload-successful"]', item)) return { ok: true, names: fileNames(root) };
      if (item && /error|failed|not (?:be )?uploaded|too large|unsupported/i.test(text(item.textContent))) return { ok: false, reason: text(item.textContent).slice(0, 160) };
      const alert = text(byId("errorMessage")?.textContent);
      if (alert) return { ok: false, reason: alert.slice(0, 160) };
    }
    return { ok: false, reason: "the upload did not finish in 45 seconds" };
  }

  /** The upload zone on the autofill page, or the resume section of My Experience. */
  function resumeZone() {
    return byId("resumeUpload") || byId("attachments-FileUpload")?.closest('[data-automation-id^="formField"]') || byId("attachments-FileUpload") || byId("file-upload-drop-zone")?.closest('[data-automation-id^="formField"]') || null;
  }

  async function uploadResume(attachment) {
    const zone = resumeZone();
    if (!zone) return { ok: false, reason: "no upload zone on this page" };
    return upload(zone, attachment);
  }

  /* ------------------------------------------------------------ account */

  async function createAccount(email, password) {
    const emailBox = byId("email");
    const passwordBox = byId("password");
    const verifyBox = byId("verifyPassword");
    if (!emailBox || !passwordBox) return { ok: false, reason: "no account form" };
    setValue(emailBox, email);
    setValue(passwordBox, password);
    if (verifyBox) setValue(verifyBox, password);
    const consent = byId("createAccountCheckbox");
    if (consent) setCheckbox(consent, true);
    await wait(200);
    return { ok: pressWrapped(byId("createAccountSubmitButton")) };
  }

  async function signIn(email, password) {
    const emailBox = byId("email");
    const passwordBox = byId("password");
    if (!emailBox || !passwordBox) return { ok: false, reason: "no sign-in form" };
    setValue(emailBox, email);
    setValue(passwordBox, password);
    await wait(200);
    return { ok: pressWrapped(byId("signInSubmitButton")) };
  }

  /**
   * Some tenants put a chooser in front of the account form - "Sign in with
   * Google", "Sign in with LinkedIn", or "Sign in with email". Email is the
   * one with a form behind it that this bot can fill.
   */
  /**
   * The chooser - Google, LinkedIn, email - taken by email. A site never
   * seen before has no account to sign into, so its "Create account with
   * email" door is the one to take when it offers one.
   */
  function withEmail(preferCreate = false) {
    const signIn = byId("SignInWithEmailButton");
    const create = byId("CreateAccountWithEmailButton");
    const button = preferCreate ? create || signIn : signIn || create;
    pressIf(button);
    return Boolean(button);
  }

  function toSignIn() {
    const link = byId("signInLink");
    pressIf(link);
    return Boolean(link);
  }

  function toCreateAccount() {
    const link = byId("createAccountLink");
    pressIf(link);
    return Boolean(link);
  }

  /* -------------------------------------------------- password recovery */

  /**
   * Getting back into an account that already exists under this address.
   *
   * Two tenants a night end with "could not sign in": the applicant - or
   * an older build of this extension, which shipped its own password -
   * made a candidate account there once, and nothing on this machine
   * holds what it was set to. Workday has no second credential and no way
   * to delete the account, so without this that employer is lost
   * permanently and the set only grows.
   *
   * The ids are tried in lists and then by the words on the control
   * because this corner of Workday is the least consistent part of it:
   * tenants on different releases label the same button three ways. Being
   * unable to find a control is answered with a sentence rather than a
   * guess at a nearby one, because the nearby one on a sign-in page is
   * Sign In and on a reset page is the thing that changes a real
   * password.
   */
  const firstById = (...ids) => ids.map((id) => byId(id)).find((node) => node && visible(node)) ?? null;
  const byWords = (pattern) => $$('button, a, [role="button"], input[type="submit"]').find((node) => visible(node) && pattern.test(text(node.textContent || node.value))) ?? null;

  /**
   * Asks the tenant to mail a reset link. Changes nothing by itself - the
   * password is still whatever it was until the link is followed and
   * `setNewPassword` saves one - so this is safe to have asked for and
   * then abandoned, which is what happens when the mail cannot be read.
   */
  async function forgotPassword(email) {
    const link = firstById("forgotPasswordLink", "forgotPassword") ?? byWords(/forgot (?:your )?password/i);
    if (!link) return { ok: false, reason: "this tenant's sign-in page offers no 'forgot your password' link" };
    press(link);
    // The sign-in button leaving is how the reset page announces itself;
    // an email box alone is not, because the sign-in page has one too.
    for (let look = 0; look < 20 && byId("signInSubmitButton"); look++) await wait(300);
    if (byId("signInSubmitButton")) return { ok: false, reason: "the 'forgot your password' link did not open the reset page" };
    const box = firstById("email", "userName", "username");
    const submit = firstById("submitButton", "forgotPasswordSubmitButton", "resetPasswordSubmitButton") ?? byWords(/^(?:submit|send|continue|reset password)$/i);
    if (!box || !submit) return { ok: false, reason: "the reset page offered no email box to send a link to" };
    setValue(box, email);
    await wait(200);
    return { ok: pressWrapped(submit), sentTo: email };
  }

  /**
   * The page the mailed link lands on, set to the password the profile
   * already holds.
   *
   * Setting it to the stored one rather than a fresh one is what makes
   * the whole recovery idempotent: there is no new secret to write down,
   * running it twice ends in the same place, and a tenant that has been
   * through it signs in by the ordinary path forever after.
   */
  async function setNewPassword(password) {
    if (byId("signInSubmitButton") || byId("createAccountSubmitButton")) {
      return { ok: false, reason: "the reset link landed back on the sign-in page, so it has expired or was already used" };
    }
    const box = firstById("password", "newPassword");
    const verify = firstById("verifyPassword", "verifyNewPassword", "confirmPassword");
    if (!box || !verify) return { ok: false, reason: "the page behind the reset link has no new-password form" };
    setValue(box, password);
    setValue(verify, password);
    await wait(200);
    const submit = firstById("submitButton", "changePasswordSubmitButton", "resetPasswordSubmitButton") ?? byWords(/^(?:submit|save|change password|reset password|continue)$/i);
    if (!submit) return { ok: false, reason: "no button on the reset page to save the new password" };
    pressWrapped(submit);
    await wait(1500);
    // A tenant refusing to reuse a previous password says so here, and it
    // is the one failure retrying cannot turn into a success.
    const complaint = [pageErrors().heading, ...pageErrors().alerts].filter(Boolean).join("; ");
    return complaint ? { ok: false, reason: complaint.slice(0, 200) } : { ok: true };
  }

  /** On the posting page: Apply, then the way in - "Apply Manually" wherever it is offered. */
  async function startApplication() {
    const choose = () => byId("applyManually") || byId("autofillWithResume") || byId("useMyLastApplication");
    if (!choose()) {
      pressIf(byId("adventureButton"));
      const started = performance.now();
      while (performance.now() - started < 4000 && !choose()) await wait(100);
    }
    const way = choose();
    if (!way) return { ok: false, reason: "no apply button" };
    const href = way.getAttribute("href");
    if (href) location.assign(href);
    else press(way);
    return { ok: true, via: way.getAttribute("data-automation-id") };
  }

  /* ---------------------------------------------------------- inventory */

  function labelOf(block) {
    const node = $("label, legend", block);
    const raw = text(node?.textContent ?? "");
    if (raw) return { label: raw.replace(/\s*\*\s*$/, "").trim(), required: /\*\s*$/.test(raw) || Boolean($('abbr[title="required"], .requiredAsterisk', block)) };
    const own = text(block.innerText ?? "").split("\n")[0];
    return { label: own.replace(/\s*\*\s*$/, "").trim(), required: /\*/.test(own) };
  }

  const radioLabel = (radio) => {
    // Called with the result of a `:checked` query, which is null whenever
    // the page re-rendered between the click and the read back. That is a
    // value nobody could read, not a reason to fail the whole fill.
    if (!radio) return "";
    const explicit = radio.id ? $(`label[for="${CSS.escape(radio.id)}"]`) : null;
    return text(explicit?.textContent ?? radio.closest("label")?.textContent ?? radio.parentElement?.textContent ?? radio.value);
  };

  /**
   * Reads one control block into the shape the extension's answer rules
   * expect: what it asks, what it is, what it offers.
   */
  function describe(block) {
    let { label, required } = labelOf(block);
    const disabilityChoice=block.getAttribute('data-automation-id')==='formField-disabilityStatus'&&Boolean($('input[type="radio"],input[type="checkbox"]',block))&&/\bdisabilit/i.test(block.innerText||block.textContent||'');
    if(disabilityChoice){
      if(!/\bdisabilit/i.test(label))label='Disability: '+label;
      required ||= Boolean(byId('applyFlowSelfIdentifyPage')||byId('applyFlowSelfIdentificationPage'));
    }
    const radios = $$('input[type="radio"]', block);
    if (radios.length > 0) {
      return { kind: "radio", element: block, label, required: required || radios.some((radio) => radio.required || radio.getAttribute("aria-required") === "true"), tag: "radio", type: "radio", options: radios.map((radio) => ({ label: radioLabel(radio), value: radio.value })) };
    }
    const listbox = $('button[aria-haspopup="listbox"]', block);
    if (listbox) {
      const formLanguage=block.getAttribute('data-automation-id')==='formField-disabilityForm'&&/^language$/i.test(label)&&Boolean(byId('applyFlowSelfIdentifyPage')||byId('applyFlowSelfIdentificationPage'));
      return { kind: "select", element: listbox, label, required: required || listbox.getAttribute("aria-required") === "true" || /required/i.test(listbox.getAttribute("aria-label") ?? ""), tag: "button", type: "select", combobox: true, options: [], current: text(listbox.textContent),...(formLanguage?{purpose:'display-language'}:{}) };
    }
    const multi = byId("multiSelectContainer", block);
    if (multi) {
      return { kind: "multiselect", element: multi, label, required: required || Boolean($('input[aria-required="true"]', multi)), tag: "input", type: "search", combobox: true, options: [], current: pillsOf(multi).join(", ") };
    }
    const date = byId("dateInputWrapper", block);
    if (date) {
      const parts = readDate(date);
      return { kind: "date", element: date, label, required: required || Boolean($('input[aria-required="true"]', date)), tag: "input", type: "date", options: [], current: parts ? Object.values(parts).filter(Boolean).join("/") : "" };
    }
    const file = $('input[type="file"]', block);
    if (file) {
      // The résumé zone on My Experience labels itself with its own
      // instructions - "Upload a file (5MB max)" - and on several tenants
      // its block carries no automation name at all, so nothing the
      // resolver reads says "resume" and the single upload the whole
      // application depends on was refused as a document nobody supplied.
      // The page already knows which zone this is; saying so is what was
      // missing.
      const zone = resumeZone();
      const isResume = zone && (zone === block || block.contains(zone) || zone.contains(block));
      return { kind: "file", element: block, label: isResume && !/\bresume\b|\bcv\b/i.test(label) ? "Resume/CV" : label, required, tag: "input", type: "file", options: [], current: fileNames(block).join(", ") };
    }
    const checkboxes = $$('input[type="checkbox"]', block);
    if (checkboxes.length > 1) {
      // Several boxes under one question - the disability form's three
      // statements - are one choice, not three consents.
      return { kind: "checkboxgroup", element: block, label, required:required||checkboxes.some(box=>box.required||box.getAttribute('aria-required')==='true')||Boolean($('[aria-required="true"]',block)), tag: "checkboxgroup", type: "checkboxgroup", options: checkboxes.map((box) => ({ label: radioLabel(box), value: box.value })), current: checkboxes.filter((box) => box.checked).map(radioLabel).join(", ") };
    }
    const checkbox = checkboxes[0];
    if (checkbox) {
      return { kind: "checkbox", element: checkbox, label: label || text(checkbox.closest("label")?.textContent), required: required || checkbox.getAttribute("aria-required") === "true", tag: "input", type: "checkbox", options: [], current: checkbox.checked ? "checked" : "" };
    }
    const area = $("textarea", block);
    if (area) {
      return { kind: "textarea", element: area, label, required: required || area.getAttribute("aria-required") === "true", tag: "textarea", type: "textarea", options: [], current: area.value };
    }
    const input = $('input:not([type="hidden"]):not([type="file"])', block);
    if (input) {
      return { kind: "text", element: input, label, required: required || input.getAttribute("aria-required") === "true" || input.required, tag: "input", type: input.type || "text", options: [], current: input.value };
    }
    return null;
  }

  /** The control blocks on the page, outermost only, structured sections aside. */
  function blocks({ skipStructured = true } = {}) {
    return $$('[data-automation-id^="formField-"]').filter((block) => {
      if (block.parentElement?.closest('[data-automation-id^="formField-"]')) return false;
      if (!skipStructured) return true;
      // "Type to Add Skills", an optional tag box on My Experience: not a
      // question, and the model answered it with the list's "No Items."
      if (block.getAttribute("data-automation-id") === "formField-skills" && !$('input[aria-required="true"]', block)) return false;
      return !block.closest('[data-fkit-id^="workExperience-"], [data-fkit-id^="education-"], [data-fkit-id^="languages-"], [data-fkit-id^="language-"]');
    });
  }

  function inventory(options = {}) {
    registry.clear();
    const fields = [];
    for (const block of blocks(options)) {
      const described = describe(block);
      if (!described) continue;
      const key = `w${(counter += 1)}`;
      const automationId = block.getAttribute("data-automation-id");
      block.setAttribute(KEY_ATTRIBUTE, key);
      registry.set(key, { ...described, block, automationId });
      const name = automationId.replace(/^formField-/, "");
      fields.push({
        key,
        tag: described.tag,
        type: described.type,
        name,
        id: described.element?.id || "",
        label: described.label,
        required: Boolean(described.required),
        combobox: Boolean(described.combobox),
        options: described.options ?? [],
        current: described.current ?? "",
        ...(described.purpose?{purpose:described.purpose}:{}),
        kind: described.kind,
      });
    }
    return { url: location.href, kind: state().kind, fields };
  }

  /**
   * The control a key names, as it is now.
   *
   * The marker attribute is the fast path and it is not enough on its own.
   * Workday redraws whole sections of a page in answer to one value -
   * choosing a country replaces the entire name and address block, because
   * those fields are country-specific - and the replacement nodes are new
   * ones that carry no marker. Every key written before that point then
   * reported "the control is no longer on the page", which is how a My
   * Information page with a first name typed into it reached Continue and
   * was refused for having no first name.
   *
   * So the block is found again by the automation id it was inventoried
   * under, which survives the redraw, and re-marked. A caller refilling
   * what emptied is then refilling the live control rather than failing on
   * a node that has been thrown away.
   */
  function locate(key) {
    const entry = registry.get(key);
    if (entry && entry.block.isConnected) return entry;
    const block = $(`[${KEY_ATTRIBUTE}="${key}"]`) ?? (entry?.automationId ? byId(entry.automationId) : null);
    if (!block) return null;
    const described = describe(block);
    if (!described) return null;
    block.setAttribute(KEY_ATTRIBUTE, key);
    const refreshed = { ...described, block, automationId: entry?.automationId ?? block.getAttribute("data-automation-id") };
    registry.set(key, refreshed);
    return refreshed;
  }

  /** What a menu offers, read by opening it. */
  async function menuOptions(key) {
    const entry = locate(key);
    if (!entry) return [];
    const textOf = (node) => text(node.textContent);
    if (entry.kind === "select") {
      const options = await openListbox(entry.element);
      const labels = options.map(textOf).filter((label) => !/^select one$/i.test(label));
      await closeListbox(entry.element);
      return labels;
    }
    if (entry.kind === "multiselect") {
      const input = $("input", entry.element);
      if (!input || !(await openPrompt(input))) return [];
      const labels = (await gatherPrompt(60)).map((entry) => entry.label);
      closePrompt(input);
      return labels;
    }
    if (entry.kind === "radio" || entry.kind === "checkboxgroup") return entry.options.map((option) => option.label);
    return [];
  }

  /* -------------------------------------------------------------- apply */

  /**
   * A phone number as Workday's box will take it.
   *
   * The dialling code is its own menu on this page, so the number box is
   * the national part and nothing else: "+1 (929) 489-1252" comes back
   * "Enter a valid format for Phone Number", because the + and the 1
   * belong to the field next to it. A profile holds one phone number in
   * one human format, which is right for every other board, so the
   * splitting is done here where the board's shape is known.
   */
  function nationalNumber(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  }

  async function place(entry, instruction) {
    const candidates = instruction.candidates?.length > 0 ? instruction.candidates : [instruction.value];
    const pick = Number.isFinite(instruction.pick) ? instruction.pick : null;
    const value = String(instruction.value ?? "");
    switch (entry.kind) {
      case "text":
      case "textarea":
        setValue(entry.element, /phone/i.test(entry.automationId ?? "") ? nationalNumber(value) : value);
        return { ok: true };
      case "checkbox": {
        const on = !/^(no|false|off|unchecked)$/i.test(value);
        return { ok: setCheckbox(entry.element, on) };
      }
      case "radio": {
        const radios = $$('input[type="radio"]', entry.element);
        const textOf = (radio) => radioLabel(radio);
        const radio = matchOption(radios, candidates, textOf) ?? (pick !== null ? pickByNumber(radios, pick, textOf) : null);
        if (!radio) return { ok: false, reason: `offers ${radios.map(textOf).join(" / ")}` };
        if (!radio.checked) {
          radio.click();
          if (!radio.checked) (radio.id ? $(`label[for="${CSS.escape(radio.id)}"]`) : radio.closest("label"))?.click();
        }
        return { ok: radio.checked };
      }
      case "checkboxgroup": {
        const boxes = $$('input[type="checkbox"]', entry.element);
        const textOf = (box) => radioLabel(box);
        const box = matchOption(boxes, candidates, textOf) ?? (pick !== null ? pickByNumber(boxes, pick, textOf) : null);
        if (!box) return { ok: false, reason: `offers ${boxes.map(textOf).join(" / ")}` };
        for (const other of boxes) if (other !== box && other.checked) other.click();
        setCheckbox(box, true);
        return { ok: box.checked };
      }
      case "select":
        return setListbox(entry.element, candidates, pick,Boolean(instruction.replace));
      case "multiselect":
        return setMultiselect(entry.element, candidates);
      case "date": {
        const parts = parseMonthYear(value) ?? today();
        return { ok: await setDate(entry.element, parts) };
      }
      case "file":
        return { ok: false, reason: "files go through upload()" };
      default:
        return { ok: false, reason: `unknown control ${entry.kind}` };
    }
  }

  /**
   * The controls that rebuild the page around them, and so go in first.
   *
   * Country is the one that matters on My Information: an address is
   * country-shaped, so choosing one swaps the whole block - different
   * fields, different labels, a region menu that was "Prefecture" a moment
   * ago and is "State" now. `locate` can find the survivors again, but
   * everything typed before the swap is still a wasted write and a second
   * pass to put back, so the swap is made to happen first.
   */
  const RESHAPES_PAGE = /country/i;

  /** Applies a plan - fills and attachments - reporting each field. */
  async function apply(plan) {
    const applied = [];
    const failed = [];
    const timings = [];
    const values = {};

    for (const attachment of plan.attachments ?? []) {
      const entry = locate(attachment.key);
      if (!entry) {
        failed.push({ key: attachment.key, reason: "the upload control is no longer on the page" });
        continue;
      }
      const result = await upload(entry.block, attachment);
      if (result.ok) applied.push(attachment.key);
      else failed.push({ key: attachment.key, reason: result.reason });
    }

    const reshapes = (instruction) => (RESHAPES_PAGE.test(registry.get(instruction.key)?.automationId ?? "") ? 0 : 1);
    for (const instruction of [...(plan.fills ?? [])].sort((a, b) => reshapes(a) - reshapes(b))) {
      const entry = locate(instruction.key);
      if (!entry) {
        failed.push({ key: instruction.key, reason: "the control is no longer on the page" });
        continue;
      }
      const startedAt = performance.now();
      try {
        const result = await place(entry, instruction);
        if (result.ok) {
          applied.push(instruction.key);
          if(instruction.replace){
            if(entry.kind==='select')values[instruction.key]=text(entry.element.textContent);
            else if(entry.kind==='radio')values[instruction.key]=radioLabel($('input[type="radio"]:checked',entry.element));
            else if(entry.kind==='checkboxgroup')values[instruction.key]=$$('input[type="checkbox"]:checked',entry.element).map(radioLabel).join(', ');
            else if(entry.kind==='multiselect')values[instruction.key]=pillsOf(entry.element).join(', ');
          }
        }
        else failed.push({ key: instruction.key, reason: result.reason ?? `nothing matched "${instruction.value}"` });
      } catch (error) {
        failed.push({ key: instruction.key, reason: error?.message ?? String(error) });
      }
      timings.push({ key: instruction.key, ms: Math.round(performance.now() - startedAt) });
    }
    return { applied, failed, timings,values };
  }

  /** Required controls still empty, read back off the page. */
  function verify() {
    const empty = [];
    for (const [key, stale] of registry) {
      const entry = locate(key) ?? stale;
      if (!entry.block.isConnected || !entry.required) continue;
      let filled;
      switch (entry.kind) {
        case "text":
        case "textarea":
          filled = text(entry.element.value) !== "";
          break;
        case "checkbox":
          filled = entry.element.checked;
          break;
        case "radio":
          filled = $$('input[type="radio"]', entry.element).some((radio) => radio.checked);
          break;
        case "checkboxgroup":
          filled = $$('input[type="checkbox"]', entry.element).some((box) => box.checked);
          break;
        case "select":
          filled = !/^select one$|^$/i.test(text(entry.element.textContent));
          break;
        case "multiselect":
          filled = pillsOf(entry.element).length > 0;
          break;
        case "date": {
          const parts = readDate(entry.element);
          filled = Boolean(parts && Object.values(parts).some((part) => String(part ?? "") !== ""));
          break;
        }
        case "file":
          filled = fileNames(entry.block).length > 0;
          break;
        default:
          filled = true;
      }
      if (!filled) empty.push({ key, label: entry.label, kind: entry.kind, tag: entry.tag, type: entry.type });
    }
    return { empty };
  }

  /** Any required choice still empty gets the first thing offered. Last resort before Save. */
  async function fillAnyRequired() {
    const done = [];
    for (const field of verify().empty) {
      const entry = locate(field.key);
      if (!entry) continue;
      if (entry.kind === "select") {
        const options = await openListbox(entry.element);
        const first = options.find((option) => !/^select one$/i.test(text(option.textContent)));
        pressIf(first);
        await wait(150);
        await closeListbox(entry.element);
        if (first) done.push(entry.label);
      } else if (entry.kind === "multiselect") {
        if (await setMultiselectAny(entry.element)) done.push(entry.label);
      } else if (entry.kind === "radio") {
        const radio = $$('input[type="radio"]', entry.element).find((candidate) => /^no\b/i.test(radioLabel(candidate))) ?? $('input[type="radio"]', entry.element);
        radio?.click();
        if (radio) done.push(entry.label);
      } else if (entry.kind === "checkbox") {
        setCheckbox(entry.element, true);
        done.push(entry.label);
      } else if (entry.kind === "date") {
        if (await setDate(entry.element, today())) done.push(entry.label);
      }
    }
    return done;
  }

  /* ---------------------------------------------------------- experience */

  const panelsOf = (section) => $$(`[role="group"][aria-labelledby^="${section}-"][aria-labelledby$="-panel"]`);
  const sectionOf = (section) => $(`[role="group"][aria-labelledby="${section}-section"]`) ?? (panelsOf(section)[0]?.parentElement ?? null);

  function addButton(section) {
    const scope = sectionOf(section);
    if (!scope) return null;
    return $$('[data-automation-id="add-button"], button', scope).find((button) => /^add(?: another)?$/i.test(text(button.textContent))) ?? null;
  }

  function deleteButton(panel) {
    return $$("button", panel).find((button) => /^(delete|remove)$/i.test(text(button.textContent)) || /delete|remove/i.test(button.getAttribute("aria-label") ?? "")) ?? null;
  }

  /** Grows or shrinks a repeating section to exactly `count` panels. */
  async function sizeSection(section, count) {
    for (let guard = 0; guard < 12 && panelsOf(section).length > count; guard += 1) {
      const panels = panelsOf(section);
      const remove = deleteButton(panels[panels.length - 1]) ?? deleteButton(panels[1]);
      if (!remove) break;
      press(remove);
      await wait(500);
      // A confirmation, if one is asked.
      pressIf($$('[role="dialog"] button').find((button) => /^(delete|yes|ok|remove)$/i.test(text(button.textContent))));
    }
    for (let guard = 0; guard < 12 && panelsOf(section).length < count; guard += 1) {
      const add = addButton(section);
      if (!add) break;
      const before = panelsOf(section).length;
      press(add);
      const started = performance.now();
      while (performance.now() - started < 4000 && panelsOf(section).length === before) await wait(100);
      if (panelsOf(section).length === before) break;
      await wait(200);
    }
    return panelsOf(section).length;
  }

  const inPanel = (panel, suffix) => $(`[id$="--${suffix}"], [name="${suffix}"]`, panel);
  const cleanBullet = (bullet) =>
    text(bullet)
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^[-•*]\s*/, "");

  /**
   * Writes one job into a Work Experience panel. The parser's guess at the
   * description is replaced whole with the resume's bullets, one per line.
   */
  async function writeJob(panel, job) {
    const notes = [];
    const title = inPanel(panel, "jobTitle");
    const company = inPanel(panel, "companyName");
    const where = inPanel(panel, "location");
    const current = inPanel(panel, "currentlyWorkHere");
    const description = $("textarea", panel) ?? inPanel(panel, "roleDescription");

    // Reported rather than skipped quietly. A panel whose boxes were never
    // found looks identical afterwards to a panel that was filled and then
    // redrawn, and the caller counted both as written - so "4 jobs written
    // from the resume" was logged against a page that went on to refuse
    // Continue for four missing job titles.
    if (title) setValue(title, job.role ?? "");
    else notes.push("no Job Title box in the work experience panel");
    if (company) setValue(company, job.company ?? "");
    else notes.push("no Company box in the work experience panel");
    if (where) setValue(where, job.location ?? "");

    const end = parseMonthYear(job.endDate);
    const ongoing = !end;
    if (current) {
      setCheckbox(current, ongoing);
      await wait(200);
    }
    const start = parseMonthYear(job.startDate);
    const startWrapper = $('[id$="--startDate"][data-automation-id="dateInputWrapper"]', panel) ?? $$('[data-automation-id="dateInputWrapper"]', panel)[0];
    const endWrapper = $('[id$="--endDate"][data-automation-id="dateInputWrapper"]', panel) ?? $$('[data-automation-id="dateInputWrapper"]', panel)[1];
    if (startWrapper && start && !(await setDate(startWrapper, start))) notes.push(`start date ${job.startDate} not taken`);
    if (!ongoing && endWrapper && end && !(await setDate(endWrapper, end))) notes.push(`end date ${job.endDate} not taken`);

    if (description) {
      const lines = (job.bullets ?? []).map(cleanBullet).filter(Boolean);
      const body = lines.length > 0 ? lines.map((line) => `• ${line}`).join("\n") : text(job.summary ?? "");
      setValue(description, body.slice(0, 4000));
    }
    return notes;
  }

  async function writeEducation(panel, education, { degreeWords, fieldWords }) {
    const notes = [];
    // The school is a plain box on most tenants and a searchable prompt on
    // some, one that takes the typed name when its list has no match.
    const school = inPanel(panel, "schoolName") ?? inPanel(panel, "school");
    const schoolBlock = $('[data-automation-id="formField-school"], [data-automation-id="formField-schoolName"]', panel);
    const schoolContainer = schoolBlock ? byId("multiSelectContainer", schoolBlock) : null;
    if (schoolContainer && education.school) {
      const result = await setMultiselect(schoolContainer, [education.school]);
      if (!result.ok) notes.push(`school: ${result.reason ?? "not taken"}`);
    } else if (school && education.school) {
      setValue(school, education.school);
    }

    const degree = $('button[aria-haspopup="listbox"]', panel);
    if (degree && degreeWords.length > 0) {
      const result = await setListbox(degree, degreeWords, null);
      if (!result.ok) notes.push(`degree: ${result.reason ?? "no match"}`);
    }

    const fieldBlock = $('[data-automation-id="formField-fieldOfStudy"]', panel);
    const fieldContainer = fieldBlock ? byId("multiSelectContainer", fieldBlock) : null;
    if (fieldContainer && fieldWords.length > 0) {
      const result = await setMultiselect(fieldContainer, fieldWords);
      if (!result.ok) notes.push(`field of study: ${result.reason ?? "no match"}`);
    }

    const year = String(education.year ?? "").match(/\d{4}/)?.[0];
    if (year) {
      const first = $('[id$="--firstYearAttended"][data-automation-id="dateInputWrapper"]', panel);
      const last = $('[id$="--lastYearAttended"][data-automation-id="dateInputWrapper"]', panel);
      if (first) await setDate(first, { yyyy: String(Number(year) - 4) });
      if (last) await setDate(last, { yyyy: year });
    }
    return notes;
  }

  /** The degree wordings a Workday menu is likely to use, from the resume's degree line. */
  function degreeCandidates(degree) {
    const line = text(degree).toLowerCase();
    if (/ph\.?d|doctor/.test(line)) return ["Doctorate", "PhD", "Doctor of Philosophy", "Doctoral"];
    if (/master|m\.?s\.?\b|m\.?sc|mba|m\.?eng/.test(line)) return ["Master's Degree", "Masters", "Master of Science", "Master", "MS", "Master's"];
    if (/bachelor|b\.?s\.?\b|b\.?sc|b\.?e\.?\b|b\.?eng|b\.?tech|b\.?a\.?\b/.test(line)) return ["Bachelor's Degree", "Bachelors", "Bachelor of Science", "Bachelor", "BS", "Bachelor's"];
    if (/associate/.test(line)) return ["Associate's Degree", "Associate", "Associates"];
    if (/high school|diploma|ged/.test(line)) return ["High School", "High School Diploma", "Secondary"];
    return [text(degree)];
  }

  function fieldCandidates(degree) {
    const line = text(degree);
    const field = line.match(/\bin\s+([A-Za-z &/-]+)$/i)?.[1] ?? line.match(/(?:of|,)\s+([A-Za-z &/-]+)$/i)?.[1] ?? "";
    const clean = text(field);
    const out = [];
    if (clean) out.push(clean);
    if (/computer|software|information/i.test(line)) out.push("Computer Science", "Computer Engineering", "Information Technology", "Software Engineering");
    if (/electrical|electronic/i.test(line)) out.push("Electrical Engineering");
    if (/mechanical/i.test(line)) out.push("Mechanical Engineering");
    if (/math/i.test(line)) out.push("Mathematics");
    if (/business|management/i.test(line)) out.push("Business Administration", "Management");
    if (/engineering/i.test(line)) out.push("Engineering");
    return [...new Set(out)];
  }

  /**
   * Rewrites the My Experience page from the resume: as many Work Experience
   * panels as the resume has jobs, each written over whatever the parser
   * guessed; one Education panel; the resume attached. The rest of the page
   * is left to the generic pass.
   */
  async function fillExperience({ experience = [], education = null, resume = null }) {
    const notes = [];
    const report = { jobs: 0, education: false, resume: null, notes };

    if (sectionOf("Work-Experience") && experience.length > 0) {
      const wanted = Math.min(experience.length, 6);
      const have = await sizeSection("Work-Experience", wanted);
      if (have !== wanted) notes.push(`work experience panels: wanted ${wanted}, have ${have}`);
      const panels = panelsOf("Work-Experience");
      for (let index = 0; index < Math.min(panels.length, wanted); index += 1) {
        notes.push(...(await writeJob(panels[index], experience[index])));
        if (text(inPanel(panels[index], "jobTitle")?.value) !== "") report.jobs += 1;
      }
    }

    if (sectionOf("Education") && education) {
      const have = await sizeSection("Education", 1);
      const panel = panelsOf("Education")[0];
      if (panel) {
        notes.push(...(await writeEducation(panel, education, { degreeWords: degreeCandidates(education.degree), fieldWords: fieldCandidates(education.degree) })));
        report.education = Boolean(education.school || education.degree);
      } else notes.push(`education panels: ${have}`);
    }

    if (resume) {
      const zone = byId("attachments-FileUpload") || $$('input[type="file"]').map((input) => input.closest('[data-automation-id^="formField"]')).find(Boolean) || null;
      if (zone) report.resume = await upload(zone, resume);
    }

    return report;
  }

  /* ------------------------------------------------------------ moving */

  function next() {
    const button = byId("pageFooterNextButton") ?? byId("bottom-navigation-next-button");
    if (!button) return { clicked: false, reason: "no Continue button" };
    const label = text(button.textContent);
    window.scrollTo(0, document.body.scrollHeight);
    pressWrapped(button);
    return { clicked: true, label };
  }

  /** Required uploads that are not the resume: a government ID, a certificate. */
  function foreignUploads() {
    return blocks({ skipStructured: false })
      .map((block) => ({ block, ...labelOf(block) }))
      .filter(({ block, required, label }) => required && $('input[type="file"]', block) && !/resume|cv\b|curriculum|cover letter|attachments?$|upload a file/i.test(label) && fileNames(block).length === 0)
      .map(({ label }) => label);
  }

  function idRequested() {
    const wanted = foreignUploads();
    const body = text(document.body.innerText ?? "");
    const mentions = /(?:government|photo|national)[- ]issued id|\bgovernment id\b|\bpassport\b|driver'?s licen[cs]e|identity document|proof of identity|\bid card\b/i.test(body);
    return { uploads: wanted, mentionsId: mentions && wanted.length > 0 };
  }

  window.__wdApply = {
    state,
    inventory,
    menuOptions,
    apply,
    verify,
    fillAnyRequired,
    fillExperience,
    uploadResume,
    createAccount,
    signIn,
    withEmail,
    toSignIn,
    toCreateAccount,
    forgotPassword,
    setNewPassword,
    startApplication,
    next,
    errors: pageErrors,
    idRequested,
    fileNames: () => fileNames(),
  };
})();
