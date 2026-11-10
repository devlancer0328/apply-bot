/**
 * The half of the bot that touches the page.
 *
 * It is deliberately stupid. It reports what controls exist, sets the values it
 * is handed, says what is still empty, and clicks submit. It holds no profile,
 * no API key and no opinion about what any field should contain - those
 * decisions live in the extension, where they can be tested without a browser
 * and where a key is not one XSS away from the open internet.
 *
 * Nearly everything below is shaped by what a live Greenhouse form actually
 * does, which differed from the obvious guess in five ways worth naming:
 *
 *   - Required fields are marked with `aria-required`, not `required`.
 *   - Each dropdown hides an empty `<input required aria-hidden tabindex="-1">`
 *     behind it. Taken at face value, every form has unfillable required
 *     fields and nothing is ever submitted.
 *   - The upload inputs are both labelled "Attach"; only their ids say which
 *     is the resume and which the cover letter.
 *   - A dropdown clears its own text box on selection, so reading `value`
 *     reports every one of them as empty however well the filling went.
 *   - Attaching a file re-renders the form, detaching element references
 *     captured before it.
 *
 * Runs in the page's own world, which is not incidental: React installs its
 * own value setter on each input and tracks the last value it saw. Assigning
 * through that setter changes the box on screen and leaves React's state
 * untouched, so the form submits empty. The way past it is the prototype's own
 * setter, which only exists in this world.
 */

(() => {
  if (window.__ghApply) return;

  const KEY_ATTRIBUTE = "data-gh-apply-key";
  const registry = new Map();
  let counter = 0;

  // Ashby's forms are built from one block per question (.ashby-application-
  // form-field or a fieldset), each with a heading label. Its yes/no questions
  // are two buttons over a hidden checkbox, its radios and checkboxes are
  // custom-drawn over transparent inputs, and its menus are autocompletes
  // that keep the chosen text in the box. Each of those is handled where
  // it differs from Greenhouse below.
  const ASHBY = /(^|\.)ashbyhq\.com$/i.test(location.hostname);
  // Lever's form is server-rendered: one li.application-question per
  // question, the heading in .application-label, the control(s) in
  // .application-field, and the whole of it wrapped in one <label>.
  const LEVER = /(^|\.)lever\.co$/i.test(location.hostname);
  // Rippling's form is a Next.js app: one div[data-testid="field"] per
  // question with the heading as its first child, inputs named by
  // aria-labelledby, menus that are divs with role=combobox (or a search
  // box for the long ones), radios drawn as divs with role=radio over
  // hidden inputs, and a location box that geocodes as you type.
  const RIPPLING = /(^|\.)rippling\.com$/i.test(location.hostname);
  // Workable's form is a React app with data-ui on everything: each
  // question is a child of [data-ui="section-fields"] with its label first,
  // yes/no questions are fieldsets of role=radio divs over hidden inputs,
  // and the icons carry "SVGs not supported" fallback text that leaks into
  // every label read naively.
  const WORKABLE = /(^|\.)workable\.com$/i.test(location.hostname);
  // ApplyToJob (JazzHR) is a classic form: label[for] on everything, a
  // multipart POST on Submit that carries the resume with it, so there is
  // no upload to wait for.
  const APPLYTOJOB = /(^|\.)applytojob\.com$/i.test(location.hostname);
  /** One question's block: its heading label and whatever control(s) answer it. */
  const BLOCK = "fieldset, .ashby-application-form-field-entry, .application-question, [data-testid='field']";

  /**
   * The heading over a control in its block: walking down from the block,
   * the first sibling-with-text that does not hold the control, at whatever
   * depth the two part ways. Empty when there is none.
   */
  function headingOf(element) {
    const block = blockOf(element);
    let node = block;
    while (node && node !== element) {
      const children = [...node.children];
      const beside = children.find((child) => !child.contains(element) && contentOf(child));
      if (beside) return contentOf(beside);
      node = children.find((child) => child.contains(element)) ?? null;
    }
    // Rippling puts the heading of a custom question, and of each EEOC
    // one, just before the block rather than in it.
    const before = block?.previousElementSibling;
    if (before && !before.matches(BLOCK) && !before.querySelector(CONTROLS) && contentOf(before)) return contentOf(before);
    return "";
  }

  /**
   * The block holding one question on the boards that build their forms
   * from blocks; null elsewhere.
   */
  function blockOf(element) {
    if (RIPPLING) return element.closest("[data-testid='field']");
    if (WORKABLE) {
      let node = element;
      while (node.parentElement && node.parentElement.getAttribute("data-ui") !== "section-fields") node = node.parentElement;
      return node.parentElement ? node : element.closest("fieldset");
    }
    return ASHBY || LEVER ? element.closest(BLOCK) : null;
  }

  /**
   * How many of the page's own requests are still in the air.
   *
   * Ashby saves every answer to its server as it is given and uploads the
   * resume the moment it is chosen, and a Submit pressed while any of that
   * is still going is ignored without a word. There is no way to see an
   * unfinished request from outside, so fetch and XMLHttpRequest are wrapped
   * once and counted. Kept on the window so a second injection shares it.
   */
  const inflight = window.__ghApplyInflight ?? (window.__ghApplyInflight = { count: 0 });
  /**
   * The page's own writes, as they answer: method, address, status, when.
   * A board that sends the application from a script (Rippling, Workable)
   * says nothing on the page a reader could count on - a toast, a brief
   * spinner - but its request to /apply answered 200 or 401, and that is
   * the fact. Kept on the window so a second injection shares it.
   */
  const requests = window.__ghApplyRequests ?? (window.__ghApplyRequests = []);
  const noteRequest = (method, url, status) => {
    if (!/^(?:POST|PUT|PATCH)$/i.test(String(method ?? "GET"))) return;
    let address = String(url);
    try {
      address = new URL(address, location.href).href;
    } catch {
      // A request to an address that will not parse is still a request.
    }
    requests.push({ method: String(method).toUpperCase(), url: address, status: Number(status) || 0, at: performance.now() });
    if (requests.length > 40) requests.splice(0, requests.length - 40);
  };
  if (!window.__ghApplyTracking && typeof window.fetch === "function" && typeof XMLHttpRequest === "function") {
    window.__ghApplyTracking = true;
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      inflight.count += 1;
      const done = () => {
        inflight.count = Math.max(0, inflight.count - 1);
      };
      const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET");
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      return nativeFetch.apply(this, args).then(
        (response) => {
          done();
          noteRequest(method, url, response.status);
          return response;
        },
        (error) => {
          done();
          noteRequest(method, url, 0);
          throw error;
        },
      );
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ghApplyRequest = { method, url };
      return open.call(this, method, url, ...rest);
    };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      inflight.count += 1;
      this.addEventListener("loadend", () => {
        inflight.count = Math.max(0, inflight.count - 1);
        noteRequest(this.__ghApplyRequest?.method, this.__ghApplyRequest?.url, this.status);
      }, { once: true });
      return send.apply(this, args);
    };
  }

  /** Whether the page has nothing in the air and the Submit button would take a press. */
  function quiet() {
    const button = findSubmit();
    const enabled = Boolean(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    // Only Ashby is known to drop a press over a request in the air; another
    // board's long-lived requests would hold Submit for no reason.
    return enabled && (!ASHBY || inflight.count === 0);
  }

  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  /** A node's text without its icons' fallback text ("SVGs not supported by this browser."). */
  function contentOf(node) {
    if (!node) return "";
    if (!node.querySelector?.("svg")) return text(node.textContent);
    const clone = node.cloneNode(true);
    clone.querySelectorAll("svg").forEach((icon) => icon.remove());
    return text(clone.textContent);
  }
  /** The asterisk a required field wears, either side. */
  const unstarred = (label) => label.replace(/^\s*[*✱]\s*|\s*[*✱]\s*$/g, "");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /* ---------------------------------------------------------------- reading */

  /**
   * The question a control is actually asking.
   *
   * Tried in descending order of how deliberate each source is. A `for`
   * attribute is someone saying which label belongs to which input; a nearby
   * heading is a guess that happens to be right most of the time.
   */
  function labelFor(element) {
    if (RIPPLING || WORKABLE) {
      // aria-labelledby is the deliberate one here; aria-label is the
      // widget's own word for itself ("Search", "Select...", "textbox").
      const named = element.getAttribute("aria-labelledby");
      if (named) {
        const labels = named.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(contentOf).filter(Boolean);
        if (labels.length > 0) return text(labels.join(" "));
      }
      // The country picker beside Rippling's phone box, which has no label
      // of its own and sits in a block with no text at all.
      if (element.closest("[data-testid$='-code']")) return "Phone country code";
      // Workable's "Address" wants the city, region and country, as its
      // helper text says, not a street; said so in the label, so the
      // street rule passes it by and the city rule takes it.
      if (WORKABLE && element.getAttribute("data-ui") === "address") return "Address (your city)";
      // The block's heading: the first thing in it that is not the control.
      // The upload's own label says "Drop or select", and the heading above
      // it says "Résumé".
      const heading = headingOf(element);
      if (heading) return heading;
      const byFor = element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (byFor && contentOf(byFor)) return contentOf(byFor);
      return text(element.placeholder || "");
    }

    // A label's text less any control inside it: a <select> wrapped in its
    // own label (ApplyToJob's EEO menus) would otherwise contribute every
    // option to the question.
    const labelText = (label) => {
      const clone = label.cloneNode(true);
      clone.querySelectorAll("select, textarea, input, svg").forEach((node) => node.remove());
      return text(clone.textContent);
    };

    const byFor = element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (byFor) return labelText(byFor);

    const wrapping = element.closest("label");
    if (wrapping) {
      // A label wrapped around the whole question block, heading and
      // helper text included, names the question in its own heading child.
      const heading = wrapping.querySelector(".application-label, [class*='label']");
      if (heading && !heading.contains(element) && element.type !== "radio" && element.type !== "checkbox") return text(heading.textContent);
      return labelText(wrapping);
    }

    const aria = element.getAttribute("aria-label");
    if (aria) return text(aria);

    const describedBy = element.getAttribute("aria-labelledby");
    if (describedBy) {
      const labels = describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => text(node.textContent));
      if (labels.length > 0) return text(labels.join(" "));
    }

    // The question's block first, then the nearest ancestor with a heading
    // of any kind. The order matters: the nearest div around an Ashby
    // autocomplete is a container holding only the box and its button.
    const field = ((ASHBY || LEVER) && element.closest(BLOCK)) || element.closest("[class*='field'], fieldset, .application-question, div");
    const heading = field && field.querySelector(".application-label, label, legend, .label, h3, h4");
    if (heading && !heading.contains(element)) return text(heading.textContent);

    return text(element.placeholder || element.name || "");
  }

  /**
   * The question over a group of radios or a question block, as distinct
   * from the label on one option. A radio's own label is "1-2 weeks"; what
   * the form is asking sits in the fieldset's legend or heading label.
   */
  function questionFor(element) {
    if (RIPPLING || WORKABLE) return labelFor(element);
    if (element.type === "radio" || element.type === "checkbox" || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      const block = questionBlock(element);
      const heading =
        block?.querySelector("legend, label[class*='heading'], .application-label") ??
        [...(block?.querySelectorAll("label") ?? [])].find((label) => !label.htmlFor || !block.querySelector(`input[id="${CSS.escape(label.htmlFor)}"]`));
      if (heading && !heading.contains(element)) return text(heading.textContent);
    }
    return labelFor(element);
  }

  /**
   * The block holding one question and nothing else. A fieldset around the
   * whole form is not one: a question's block holds only its own options.
   */
  function questionBlock(element) {
    const block = element.closest(BLOCK) ?? element.closest(".application-question, [class*='field']");
    if (!block) return null;
    const others = block.querySelectorAll("input:not([type='radio']):not([type='checkbox']):not([type='hidden']), textarea, select");
    return others.length === 0 || ASHBY ? block : null;
  }

  /**
   * Whether the form will refuse to send without this.
   *
   * The `required` attribute is the least reliable signal here - Greenhouse
   * puts it only on the hidden placeholders - so `aria-required` and the
   * asterisk a person actually reads carry the weight.
   */
  function isRequired(element, label) {
    if (element.getAttribute("aria-required") === "true") return true;
    if (element.required) return true;
    if (/[*✱]/.test(label)) return true;
    // A group drawn over hidden inputs is as required as the inputs are.
    if (!(element instanceof HTMLInputElement) && element.querySelector?.("input[aria-required='true'], input[required]")) return true;
    if (RIPPLING || WORKABLE) return /[*✱]/.test(headingOf(element));
    const container = ((ASHBY || LEVER) && element.closest(BLOCK)) || element.closest("[class*='field'], [class*='question']");
    if (!container) return false;
    if (/required/i.test(container.className)) return true;
    // Ashby marks the heading label, not the input.
    return Boolean(container.querySelector("label[class*='required'], legend[class*='required']"));
  }

  /** A react-select style control: a text box over a menu, with no value of its own. */
  function isCombobox(element) {
    return (
      element.getAttribute("role") === "combobox" ||
      element.getAttribute("aria-haspopup") === "listbox" ||
      Boolean(element.closest("[class*='select__'], [class*='react-select']"))
    );
  }

  function optionsFor(element) {
    if (element.tagName === "SELECT") {
      return [...element.options].map((option) => ({ value: option.value, label: text(option.textContent) }));
    }

    if (element.type === "radio" && element.name) {
      return [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`)].map((radio) => ({
        value: radio.value,
        label: labelFor(radio) || radio.value,
      }));
    }

    // A closed dropdown has no options anywhere in the document; its menu is
    // built when it opens. The extension is told so, and sends the wordings it
    // would accept rather than a single value to look up.
    return [];
  }

  const CONTROLS = "input, select, textarea";
  /** Rippling's short menus are divs that open a listbox; they have no input at all. */
  const DIV_MENUS = "div[role='combobox'][aria-haspopup='listbox']";

  function controls() {
    const seenRadioGroups = new Set();

    return [...document.querySelectorAll(RIPPLING ? `${CONTROLS}, ${DIV_MENUS}` : CONTROLS)].filter((element) => {
      if (element.disabled) return false;
      if (element.type === "hidden") return false;

      // The placeholders parked behind every dropdown. Attribute rather than
      // property for tabindex, since `tabIndex` defaults differently across
      // implementations and what is on the page is a literal -1.
      if (element.getAttribute("aria-hidden") === "true") return false;

      const styles = getComputedStyle(element);
      const isFile = element.type === "file";
      // A custom-drawn radio or checkbox sits transparent over its styled
      // twin: opacity 0, but a real control with a real box. Only the
      // text-like controls are judged by opacity.
      const drawnOver = element.type === "radio" || element.type === "checkbox";
      const selectedCombobox = isCombobox(element) && element.closest("[class*='select__control']");
      if (!isFile && !drawnOver && (element.getAttribute("tabindex") === "-1" || (styles.opacity === "0" && !selectedCombobox))) return false;

      // A control nobody can see is either a leftover or the shadow half of a
      // custom widget. File inputs are exempt: every board hides them behind
      // its own Attach button, and the phone widget keeps a country search box
      // and 244 country options mounted inside a hidden container at all times.
      const box = element.getBoundingClientRect();
      const invisible = styles.visibility === "hidden" || styles.display === "none";
      if (!isFile && (invisible || (box.width === 0 && box.height === 0))) return false;

      // Ashby's "autofill from a resume" upload at the top of the form,
      // which is not the resume field.
      if (isFile && (/autofill/i.test(labelFor(element)) || (ASHBY && !element.id))) return false;

      // Checkboxes that belong to a group are reported as the group.
      if (element.type === "checkbox" && groupOf(element)) return false;

      if (element.type === "radio" && element.name) {
        if (seenRadioGroups.has(element.name)) return false;
        seenRadioGroups.add(element.name);
      }

      return true;
    });
  }

  /**
   * The block a checkbox belongs to when that block is a multiple-choice
   * question - two or more checkboxes under one heading, "select all that
   * apply" - rather than a lone acknowledgement box.
   */
  function groupOf(checkbox) {
    const block = questionBlock(checkbox);
    if (!block) return null;
    const boxes = [...block.querySelectorAll("input[type='checkbox']")].filter((box) => getComputedStyle(box).display !== "none");
    return boxes.length >= 2 ? block : null;
  }

  /**
   * Questions with no control of their own to list: Ashby's yes/no pairs
   * (two buttons, data-option yes|no, over a checkbox that is display:none)
   * and multiple-choice checkbox groups. Each is reported as one field
   * whose element is the block itself.
   */
  function groupedControls() {
    const found = [];
    const seen = new Set();
    // Radios and checkboxes drawn as divs with a role, over inputs the page
    // hides (Rippling, Workable). The group is the control.
    for (const group of document.querySelectorAll("[role='radiogroup'], [role='group']")) {
      const choices = [...group.querySelectorAll("[role='radio'], [role='checkbox']")].filter((node) => !(node instanceof HTMLInputElement));
      if (choices.length === 0 || seen.has(group)) continue;
      seen.add(group);
      const kind = choices.some((node) => node.getAttribute("role") === "checkbox") ? "checkboxes" : "radios";
      found.push({ element: group, kind, options: choices.map((node) => ({ value: node.getAttribute("data-value") || choiceText(node), label: choiceText(node) })) });
    }
    for (const block of document.querySelectorAll(BLOCK)) {
      if (block.matches("[role='radiogroup'], [role='group']") && seen.has(block)) continue;
      if (!ASHBY && block.querySelector("input:not([type='radio']):not([type='checkbox']):not([type='hidden']), textarea, select")) continue;
      if (block.querySelector("button[data-option='yes'], button[data-option='no']")) {
        found.push({ element: block, kind: "yesno", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] });
        continue;
      }
      const boxes = [...block.querySelectorAll("input[type='checkbox']")].filter((box) => getComputedStyle(box).display !== "none");
      if (boxes.length >= 2) {
        found.push({ element: block, kind: "checkboxes", options: boxes.map((box) => ({ value: box.value || labelFor(box), label: labelFor(box) || box.value })) });
      }
    }
    return found;
  }

  /**
   * How to find this control again later.
   *
   * Holding the element itself is not enough. Attaching a file makes
   * Greenhouse re-render the form, and every reference taken before that
   * points at a node no longer in the document - so filling silently does
   * nothing to the form the applicant actually sends.
   */
  function selectorFor(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    if (element.name) {
      const type = element.type === "radio" ? `[type="radio"]` : "";
      return `${element.tagName.toLowerCase()}[name="${CSS.escape(element.name)}"]${type}`;
    }
    // Rippling's upload inputs have neither id nor name, only a test id;
    // Workable's have a random id and a steady data-ui.
    for (const attribute of ["data-testid", "data-ui"]) {
      const value = element.getAttribute(attribute);
      if (value && document.querySelectorAll(`${element.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`).length === 1) {
        return `${element.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
      }
    }
    return "";
  }

  function locate(key) {
    const entry = registry.get(key);
    if (!entry) return null;

    const tagged = document.querySelector(`[${KEY_ATTRIBUTE}="${key}"]`);
    if (tagged) return tagged;

    if (entry.selector) {
      const found = document.querySelector(entry.selector);
      if (found) {
        found.setAttribute(KEY_ATTRIBUTE, key);
        return found;
      }
    }

    return entry.element?.isConnected ? entry.element : null;
  }

  /** Describes every control on the page and remembers how to find it again. */
  function inventory() {
    registry.clear();
    const fields = [];

    for (const element of controls()) {
      const key = `f${(counter += 1)}`;
      element.setAttribute(KEY_ATTRIBUTE, key);
      registry.set(key, { element, selector: selectorFor(element) });

      const label = questionFor(element);
      fields.push({
        key,
        tag: element.tagName.toLowerCase(),
        type: element.type || element.tagName.toLowerCase(),
        name: element.name || "",
        id: element.id || "",
        label: unstarred(label),
        required: isRequired(element, label),
        combobox: isCombobox(element),
        options: optionsFor(element),
      });
    }

    for (const group of groupedControls()) {
      const key = `f${(counter += 1)}`;
      group.element.setAttribute(KEY_ATTRIBUTE, key);
      registry.set(key, { element: group.element, selector: group.element.id ? `#${CSS.escape(group.element.id)}` : "" });
      const label = questionFor(group.element);
      fields.push({
        key,
        tag: group.kind,
        type: group.kind,
        name: group.element.getAttribute("data-field-path") || "",
        id: group.element.id || "",
        label: unstarred(label),
        required: isRequired(group.element, label),
        combobox: false,
        options: group.options,
      });
    }

    return { url: location.href, title: document.title, fields, submit: describeSubmit() };
  }

  function describeSubmit() {
    const button = findSubmit();
    return button ? { label: text(button.textContent) || button.value || "Submit", found: true } : { found: false };
  }

  /* ---------------------------------------------------------------- writing */

  /**
   * Sets a value the way the page's own framework will notice.
   *
   * React replaces the element's value setter and keeps the last value it wrote
   * in a tracker; writing through the replacement updates neither, so the input
   * looks filled and submits blank. Calling the prototype setter writes the DOM
   * directly, and the input event that follows is what React listens for.
   */
  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * A whole pointer interaction, not just a click.
   *
   * react-select opens on the pointer sequence and ignores both a bare
   * `click()` and a lone `mousedown`. This was established by trying each
   * against a live board, which is the only way such a thing gets established.
   */
  function pointerThrough(node) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Constructor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true, composed: true, button: 0, isPrimary: true }));
    }
  }

  /**
   * Finds the one option that says what we meant.
   *
   * Candidates arrive already ordered by preference, because the same answer is
   * worded differently on every board - "I don't wish to answer" here,
   * "Decline to self-identify" there - and only the extension knows which
   * phrasings mean the same thing.
   *
   * Containment is checked on word boundaries rather than as a bare substring.
   * Without that, the candidate "No" matches "I am not a protected veteran",
   * which is not a near miss but the opposite answer.
   */
  /**
   * The option a number falls in.
   *
   * "How many years with X" is answered with a number, and the menu offers
   * bands: "0-1", "2-3", "4-6", "7+", "10+ years", "Less than 1", "More
   * than 5", or a bare 1..10. Each label is read as a range and the one
   * holding the number wins; failing that, the highest band that starts
   * below it. Labels with no number at all - Beginner, Intermediate,
   * Advanced, Expert - are a ladder, and the number is a rung out of ten.
   */
  const LEVELS = ["none", "beginner", "novice", "basic", "familiar", "intermediate", "proficient", "advanced", "expert"];
  function pickByNumber(nodes, target, textOf) {
    const ranges = nodes.map((node) => {
      const label = textOf(node).toLowerCase();
      const numbers = (label.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (numbers.length === 0) return null;
      if (/less than|under|fewer than|below|<\s*\d/.test(label)) return { node, low: 0, high: numbers[0] - 0.01 };
      if (/more than|over|greater than|above|\+|>\s*\d|or more/.test(label)) return { node, low: numbers[0], high: Infinity };
      if (numbers.length >= 2) return { node, low: Math.min(numbers[0], numbers[1]), high: Math.max(numbers[0], numbers[1]) };
      return { node, low: numbers[0], high: numbers[0] };
    });
    const numbered = ranges.filter(Boolean);

    if (numbered.length > 0) {
      const holding = numbered.find((range) => target >= range.low && target <= range.high);
      if (holding) return holding.node;
      const below = numbered.filter((range) => range.low <= target).sort((a, b) => b.low - a.low)[0];
      if (below) return below.node;
      return numbered.sort((a, b) => a.low - b.low)[0].node;
    }

    // A ladder of words: the rung is the number out of ten.
    const rungs = nodes
      .map((node) => ({ node, rank: LEVELS.findIndex((level) => textOf(node).toLowerCase().includes(level)) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank);
    if (rungs.length === 0) return null;
    const index = Math.min(rungs.length - 1, Math.max(0, Math.round((target / 10) * (rungs.length - 1))));
    return rungs[index].node;
  }

  function matchOption(nodes, candidates, textOf, exactOnly = false) {
    for (const candidate of candidates) {
      const want = text(candidate).toLowerCase();
      if (!want) continue;

      const exact = nodes.find((node) => textOf(node).toLowerCase() === want);
      if (exact) return exact;
      if (exactOnly) continue;

      // The shortest wording that contains it: "United States" is "United
      // States of America", not "United States Minor Outlying Islands".
      const boundary = new RegExp(`\\b${escapeRegExp(want)}\\b`);
      const contained = nodes.filter((node) => boundary.test(textOf(node).toLowerCase())).sort((a, b) => textOf(a).length - textOf(b).length)[0];
      if (contained) return contained;
    }
    return null;
  }

  /**
   * The menu belonging to this control, and only this one.
   *
   * Both routes are keyed to the control's own identity, and there is no
   * document-wide fallback on purpose. Searching the page for `[role=option]`
   * would reach the phone widget's permanently mounted country list, where
   * "No" resolves to Norway - a wrong answer that looks like a right one.
   */
  function listboxFor(element) {
    const owned = element.getAttribute("aria-controls") || element.getAttribute("aria-owns");
    if (owned) {
      const node = document.getElementById(owned);
      if (node) return node;
    }
    return element.id ? document.getElementById(`react-select-${element.id}-listbox`) : null;
  }

  /** Waits for a menu to have something on it, rather than guessing how long it takes. */
  async function optionsWithin(element, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const list = listboxFor(element);
      const options = list ? [...list.querySelectorAll("[role='option']")] : [];
      if (options.length > 0) return options;
      await wait(100);
    }
    const list = listboxFor(element);
    return list ? [...list.querySelectorAll("[role='option']")] : [];
  }

  /**
   * Drives a react-select style control.
   *
   * There is no value to set, so this does what a person does: open the menu,
   * look at what is on it, and click the right one. Typing comes second and
   * only when nothing matched, because typing filters - and filtering a list
   * for "decline" when the option reads "I don't wish to answer" empties it.
   */
  // Why the last menu fill came up empty, for the log.
  let lastMiss = "";
  /**
   * Opens a dropdown's menu. Ashby's autocomplete opens from the toggle
   * button beside the box; react-select opens from a pointer on the control.
   */
  function openMenu(element) {
    element.focus();
    if (listboxFor(element)?.querySelector("[role='option']")) return;
    const toggle = ASHBY ? element.parentElement?.querySelector("button") : null;
    if (toggle) toggle.click();
    // Rippling's menus listen on the control itself, div or box.
    else if (RIPPLING) pointerThrough(element);
    else pointerThrough(element.closest("[class*='select__control']") ?? element.parentElement);
  }

  /**
   * Types a query the way keys would arrive, one character at a time with
   * an input event for each. A geocoder (Rippling's location box) searches
   * on keystrokes and ignores a value that appears whole.
   */
  async function typeInto(element, query) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(100);
    for (const character of query) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
      setter.call(element, element.value + character);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
      await wait(20);
    }
  }

  function selectedLabels(element) {
    const control = element.closest("[class*='select__control']");
    const chips = control ? [...control.querySelectorAll("[class*='multi-value__label'], [class*='multiValueLabel']")] : [];
    return chips.length ? chips.map(node=>text(node.textContent)) : [selectedLabel(element)].filter(Boolean);
  }

  async function setCombobox(element, candidates, sole = false, pick = null, replace = false) {
    lastMiss = "";
    // A box that already says what we meant - Rippling's country picker
    // comes up "+1 US" - is left as it is; opening it shows the first page
    // of two hundred countries, where "United States" is not.
    const selected = selectedLabels(element);
    if (selected.length && (!replace || selected.length === 1) && selected.every(label=>matchOption([label], candidates, value=>value, replace))) return true;
    openMenu(element);

    let options = await optionsWithin(element, 2500);
    const opened = options;
    let match = matchOption(options, candidates, (node) => text(node.textContent), replace);

    // An acknowledgement menu with a single entry: "Acknowledge/Confirm" is
    // not a wording anyone would list in advance, and it is the only choice.
    if (!match && sole && options.length === 1) match = options[0];
    // A number against a menu of bands: the band it falls in.
    if (!match && pick !== null && options.length > 0) match = pickByNumber(options, pick, (node) => text(node.textContent));

    // A location or country box starts empty and only fetches once there is
    // something to search on. What is typed is the part before the first
    // comma: a geocoder asked for "Friendswood" answers, and asked for
    // "Friendswood, TX" often does not, because it does not spell states that
    // way and treats the whole string as the place name.
    // A short menu that listed its entries has been read in full and nothing
    // matched; typing into it can only filter the same entries down to
    // none, four seconds later. A menu that opened empty is a search box,
    // and one showing a hundred entries is a long list showing its first
    // page - "Aalborg University" onward - so both are typed into.
    if (!match && (opened.length === 0 || opened.length >= 50) && element instanceof HTMLInputElement) {
      const query = String(candidates[0] ?? "").split(",")[0].trim();
      if (RIPPLING) await typeInto(element, query);
      else {
        setNativeValue(element, "");
        await wait(120);
        setNativeValue(element, query);
      }
      options = await optionsWithin(element, 4000);
      match = matchOption(options, candidates, (node) => text(node.textContent), replace);
      // A search box that answered the query with places beginning with it
      // - "Friendswood, TX, USA" for "Friendswood" - has answered; the
      // first hit is the place, however the state is spelt.
      if (!replace && !match && opened.length === 0 && options.length > 0 && text(options[0].textContent).toLowerCase().startsWith(query.toLowerCase())) match = options[0];
    }

    // A profile answer replaces stale multi-select chips, including an old
    // decline choice. Confirm an offered or already selected match first.
    const existingMatch = replace ? matchOption(selected, candidates, value=>value, true) : null;
    if (replace && selected.length && (match || existingMatch)) {
      const control = element.closest("[class*='select__control']");
      if (control?.querySelector("[class*='multi-value'], [class*='multiValue']")) {
        const chosen = match ? text(match.textContent) : existingMatch;
        element.dispatchEvent(new KeyboardEvent("keydown", {key:'Escape',bubbles:true}));
        const clear = control.querySelector('[data-testid="clear-selection"], [aria-label="Clear selections"], [class*="clear-indicator"]');
        if (!clear) { lastMiss = 'existing multi-select answers could not be replaced'; return false; }
        const elementId = element.id;
        pointerThrough(clear);
        await wait(100);
        element = (elementId && document.getElementById(elementId)) || element;
        openMenu(element);
        options = await optionsWithin(element, 2500);
        match = matchOption(options, [chosen], node=>text(node.textContent));
      }
    }

    if (!match) {
      // What was on the menu before typing filtered it, so the caller can
      // come back with a choice made from the real list.
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      lastMiss = `menu showed ${opened.length} option(s) on opening${opened.length > 0 ? ` (${opened.slice(0, 3).map((node) => text(node.textContent)).join(" / ")})` : ""}, ${options === opened ? "not typed into" : `${options.length} after typing`}`;
      return false;
    }

    const chosenLabel = text(match.textContent).toLowerCase();
    const selectionMatches = () => {
      const values = selectedLabels(element).map(label=>label.toLowerCase());
      return values.includes(chosenLabel) && (!replace || values.length === 1);
    };
    pointerThrough(match);
    await wait(150);
    if (selectionMatches()) return true;
    // Ashby's autocomplete takes a plain click on the option and keeps the
    // chosen text in the box; a pointer sequence alone sometimes leaves it
    // highlighted and unchosen.
    if (ASHBY && match.isConnected) {
      match.click();
      await wait(150);
    }
    return selectionMatches();
  }

  /**
   * The choices a control offers, read off the page.
   *
   * For a menu that only renders when opened this opens it, reads it and
   * closes it again. Used when a value found no match the first time: the
   * list is then put to the model, which picks from what is actually there
   * rather than from what the profile hoped would be.
   */
  async function menuOptions(key) {
    const element = locate(key);
    if (!element) return [];
    const labels = (nodes, textOf) => [...new Set(nodes.map((node) => text(textOf(node))).filter(Boolean))].slice(0, 80);

    if (element.tagName === "SELECT") return labels([...element.options].filter((option) => option.value !== ""), (node) => node.textContent);
    if (element.querySelector?.("button[data-option]")) return ["Yes", "No"];
    if (element.matches?.("[role='radiogroup'], [role='group']") && element.querySelector("[role='radio'], [role='checkbox']")) {
      return labels([...element.querySelectorAll("[role='radio'], [role='checkbox']")].filter((node) => !(node instanceof HTMLInputElement)), choiceText);
    }
    if (element.tagName !== "INPUT" && element.querySelector?.("input[type='checkbox']")) {
      return labels([...element.querySelectorAll("input[type='checkbox']")], (box) => labelFor(box) || box.value);
    }
    if (element.type === "radio") {
      const group = element.name ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`)] : [element];
      return labels(group, (radio) => labelFor(radio));
    }
    if (!isCombobox(element)) return [];

    element.focus();
    if (element instanceof HTMLInputElement) setNativeValue(element, "");
    openMenu(element);
    const options = await optionsWithin(element, 2500);
    const found = labels(options, (node) => node.textContent);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return found;
  }

  function setSelect(element, candidates, sole = false, pick = null) {
    const options = [...element.options];
    const byValue = candidates.map((candidate) => options.find((option) => option.value === candidate)).find(Boolean);

    let option = byValue ?? matchOption(options, candidates, (node) => text(node.textContent));
    const real = options.filter((entry) => entry.value !== "" && text(entry.textContent));
    if (!option && sole && real.length === 1) option = real[0];
    if (!option && pick !== null) option = pickByNumber(real, pick, (node) => text(node.textContent));
    if (!option) return false;

    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setRadio(element, candidates, pick = null) {
    const group = element.name
      ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`)]
      : [element];

    const byValue = candidates.map((candidate) => group.find((radio) => radio.value === candidate)).find(Boolean);
    let match = byValue ?? matchOption(group, candidates, (radio) => labelFor(radio));
    if (!match && pick !== null) match = pickByNumber(group, pick, (radio) => labelFor(radio));
    if (!match) return false;

    match.click();
    return true;
  }

  /**
   * Puts a file into an upload control without a file dialog.
   *
   * A FileList cannot be built, only handed over, and a DataTransfer is the one
   * place the page is allowed to make one. The change event afterwards is what
   * the board's own uploader is waiting on.
   */
  /**
   * A plain text box that searches as you type and lists results beside
   * itself - Lever's "Current location", which also keeps the chosen place
   * in a hidden input the form will not send without.
   */
  function searchResultsFor(element) {
    if (element.tagName !== "INPUT" || element.type !== "text") return null;
    const field = element.closest(".application-field") ?? element.parentElement;
    return field?.querySelector(".dropdown-results, [class*='dropdown-results']") ?? null;
  }

  async function setSearchBox(element, candidates) {
    const results = searchResultsFor(element);
    const chosen = () => element.closest(".application-field")?.querySelector("input[type='hidden']");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const candidate of candidates) {
      // The box searches on each keystroke, not on a value that appears
      // whole; so the place is typed a character at a time.
      element.focus();
      valueSetter.call(element, "");
      for (const character of candidate) {
        element.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
        valueSetter.call(element, element.value + character);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
        await wait(15);
      }
      const deadline = performance.now() + 5000;
      let options = [];
      while (performance.now() < deadline) {
        await wait(100);
        options = [...results.children].filter((node) => text(node.textContent).length > 0);
        if (options.length > 0) break;
      }
      if (options.length === 0) continue;
      const match = matchOption(options, [candidate, candidate.split(",")[0]], (node) => node.textContent) ?? options[0];
      for (const type of ["pointerdown", "mousedown"]) match.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      await wait(50);
      for (const type of ["mouseup", "click"]) match.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      await wait(300);
      const hidden = chosen();
      if (!hidden || hidden.value) return true;
    }
    return false;
  }

  /** Ashby's yes/no pair: the button whose data-option the answer means. */
  function setYesNo(block, candidates) {
    const want = candidates.map((candidate) => text(candidate).toLowerCase()).find((candidate) => /^(yes|no)\b/.test(candidate));
    if (!want) return false;
    const button = block.querySelector(`button[data-option='${want.startsWith("yes") ? "yes" : "no"}']`);
    if (!button) return false;
    if (button.getAttribute("aria-pressed") !== "true") button.click();
    return true;
  }

  /** A multiple-choice checkbox group: the one box that says what we meant. */
  function setCheckboxGroup(block, candidates, pick = null) {
    const boxes = [...block.querySelectorAll("input[type='checkbox']")].filter((box) => getComputedStyle(box).display !== "none");
    let match = matchOption(boxes, candidates, (box) => labelFor(box) || box.value);
    if (!match && pick !== null) match = pickByNumber(boxes, pick, (box) => labelFor(box) || box.value);
    if (!match) return false;
    if (!match.checked) (match.labels?.[0] ?? match).click();
    if (!match.checked) match.click();
    return match.checked;
  }

  /** What a div drawn as a radio or checkbox says: its own label, or the one it points at. */
  function choiceText(node) {
    const named = node.getAttribute("aria-labelledby");
    const pointed = named ? named.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).filter((label) => node.contains(label) || !label.id.endsWith("_label")) : [];
    const own = pointed.length > 0 ? pointed.map(contentOf).join(" ") : contentOf(node);
    return text(own);
  }

  /** A group of divs with role=radio or role=checkbox: the one that says what we meant, pressed. */
  async function setAriaChoices(group, candidates, pick = null) {
    const choices = [...group.querySelectorAll("[role='radio'], [role='checkbox']")].filter((node) => !(node instanceof HTMLInputElement));
    let match = matchOption(choices, candidates, choiceText);
    if (!match && pick !== null) match = pickByNumber(choices, pick, choiceText);
    if (!match) return false;
    if (match.getAttribute("aria-checked") === "true") return true;
    pointerThrough(match);
    await wait(100);
    if (match.getAttribute("aria-checked") !== "true") {
      // The hidden input behind it, for a widget that listens there.
      const input = match.querySelector("input[type='radio'], input[type='checkbox']");
      if (input) input.click();
      await wait(100);
    }
    return match.getAttribute("aria-checked") === "true" || Boolean(match.querySelector("input:checked"));
  }

  function setFile(element, attachment) {
    const bytes = Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
    const file = new File([bytes], attachment.name, { type: attachment.type });

    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.files = transfer.files;

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    // Some boards listen for a drop on the surrounding zone rather than for a
    // change on the input they keep hidden.
    const zone = element.closest("[class*='drop'], [class*='upload'], [class*='attach']");
    if (zone) zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));

    return element.files.length === 1;
  }

  /**
   * Applies a whole plan, reporting each field rather than stopping at the
   * first failure.
   *
   * Uploads go first and everything else waits on them, because attaching a
   * file re-renders the form. Filling before that point writes into nodes that
   * are about to be thrown away.
   */
  async function apply(plan) {
    const applied = [];
    const failed = [];
    // How long each field took, so a slow form can be read off the log
    // rather than guessed at.
    const timings = [];

    if ((plan.attachments ?? []).length > 0) uploadMark = { at: performance.now(), expected: 0, names: [] };

    for (const attachment of plan.attachments ?? []) {
      const element = locate(attachment.key);
      if (!element) {
        failed.push({ key: attachment.key, reason: "the upload control is no longer on the page" });
        continue;
      }
      try {
        if (setFile(element, attachment)) {
          applied.push(attachment.key);
          uploadMark.expected += 1;
          uploadMark.names.push(attachment.name);
        } else failed.push({ key: attachment.key, reason: "the file did not attach" });
      } catch (error) {
        failed.push({ key: attachment.key, reason: error?.message ?? String(error) });
      }
      // Rippling re-renders the form as each file goes up; the next upload
      // control is found again by its test id once that has happened.
      if (RIPPLING) await wait(600);
    }

    if ((plan.attachments ?? []).length > 0 && !LEVER) await wait(800);

    // What each plain box was given, to put back should the page change it.
    const typed = new Map();

    for (const instruction of plan.fills ?? []) {
      const element = locate(instruction.key);
      if (!element) {
        failed.push({ key: instruction.key, reason: "the control is no longer on the page" });
        continue;
      }

      // One intent, several wordings it might appear under. A plain text box
      // uses the first; anything with a menu tries them in turn.
      const candidates = instruction.candidates?.length > 0 ? instruction.candidates : [instruction.value];
      // A number to place on whatever scale the control offers.
      const pick = Number.isFinite(instruction.pick) ? instruction.pick : null;
      const startedAt = performance.now();

      try {
        let ok;
        if (element.tagName === "SELECT") ok = setSelect(element, candidates, Boolean(instruction.sole), pick);
        else if (element.matches?.("[role='radiogroup'], [role='group']") && element.querySelector("[role='radio'], [role='checkbox']")) ok = await setAriaChoices(element, candidates, pick);
        else if (searchResultsFor(element)) ok = await setSearchBox(element, candidates);
        else if (element.querySelector?.("button[data-option]")) ok = setYesNo(element, candidates);
        else if (element.tagName !== "INPUT" && element.querySelector?.("input[type='checkbox']")) ok = setCheckboxGroup(element, candidates, pick);
        else if (element.type === "radio") ok = setRadio(element, candidates, pick);
        else if (element.type === "checkbox") {
          const on = !/^(no|false|off|unchecked)$/i.test(String(instruction.value));
          if (element.checked !== on) element.click();
          ok = element.checked === on;
        } else if (isCombobox(element)) ok = await setCombobox(element, candidates, Boolean(instruction.sole), pick, Boolean(instruction.replace));
        else {
          setNativeValue(element, instruction.value);
          typed.set(instruction.key, instruction.value);
          ok = true;
        }

        if (ok) applied.push(instruction.key);
        else failed.push({ key: instruction.key, reason: `nothing on the control matched "${instruction.value}"${lastMiss ? `; ${lastMiss}` : ""}` });
      } catch (error) {
        failed.push({ key: instruction.key, reason: error?.message ?? String(error) });
      }
      timings.push({ key: instruction.key, ms: Math.round(performance.now() - startedAt) });
    }

    // Lever reads the resume it was given - ten seconds or so - and then
    // writes the name, email, phone and company it found over whatever is
    // in those boxes. The boxes were filled during the reading rather than
    // after it; now the reading is waited out and the profile's own values
    // put back wherever the page's guess differs.
    // Rippling does the same: the résumé goes to a parser the moment it
    // is chosen, and the parser's name, email, phone and current company
    // land in the boxes a few seconds later, over what was typed.
    if (RIPPLING && uploadMark.expected > 0) {
      const startedAt = performance.now();
      const parsed = () => performance.getEntriesByType("resource").some((entry) => entry.startTime >= uploadMark.at && /parse_resume/.test(entry.name));
      while (performance.now() - startedAt < 15000 && !parsed()) await wait(250);
      await wait(parsed() ? 800 : 0);
      for (const [key, value] of typed) {
        const element = locate(key);
        if (element && element.value !== value) setNativeValue(element, value);
      }
      timings.push({ key: "resume parse", ms: Math.round(performance.now() - startedAt) });
    }

    if (LEVER && uploadMark.expected > 0) {
      const startedAt = performance.now();
      const deadline = startedAt + 15000;
      while (performance.now() < deadline && !leverResumeDone()) await wait(200);
      await wait(400);
      for (const [key, value] of typed) {
        const element = locate(key);
        if (element && element.value !== value) setNativeValue(element, value);
      }
      // And what the parser put into boxes this run left alone - a "current
      // company" read off the resume's latest job, say - goes back out: the
      // applicant is between contracts, and a box left blank was blank on
      // purpose.
      const touched = new Set((plan.fills ?? []).map((fill) => fill.key));
      for (const [key, { element }] of registry) {
        if (touched.has(key) || element.tagName !== "INPUT" || element.type !== "text" || !element.value) continue;
        if (/^org$|company|employer/i.test(`${element.name} ${labelFor(element)}`)) setNativeValue(element, "");
      }
      timings.push({ key: "resume parse", ms: Math.round(performance.now() - startedAt) });
    }

    return { applied, failed, timings };
  }

  /**
   * Whether every attached file has finished uploading.
   *
   * Putting a file into the input is not the end of it: the board uploads
   * it in the background, and a Submit pressed before that point is refused
   * with "Resume/CV is required" - the file in the input and not yet on
   * their server.
   */
  // What the page had fetched before the files went in, and how many went.
  let uploadMark = { at: 0, expected: 0, names: [] };
  const UPLOAD_HOST = /s3\.amazonaws\.com|\/upload|\/attachments?\b|\/files?\b/i;
  /** Whether Lever has finished taking the resume, well or badly. */
  function leverResumeDone() {
    const visible = (selector) => [...document.querySelectorAll(selector)].some((node) => node.offsetParent !== null);
    if (document.querySelector("input[name='resumeStorageId']")?.value) return true;
    return visible(".resume-upload-success, .resume-upload-failure") && !visible(".resume-upload-working");
  }

  function uploadsSettled() {
    if (LEVER && uploadMark.expected > 0) {
      return leverResumeDone() ? { settled: true, pending: [] } : { settled: false, pending: ["resume"] };
    }
    // Ashby: the file went to S3 on selection and every answer is being
    // saved; settled means all of that has come back and Submit is live.
    if (ASHBY) {
      const bodyText = document.body?.innerText ?? "";
      const named = uploadMark.names.every((name) => bodyText.includes(name));
      const pending = [...(named ? [] : ["resume"]), ...(inflight.count > 0 ? [`${inflight.count} request(s)`] : []), ...(quiet() ? [] : ["submit button"])];
      return pending.length === 0 ? { settled: true, pending: [] } : { settled: false, pending };
    }
    if (uploadMark.expected === 0 || APPLYTOJOB) return { settled: true, pending: [] };
    // Rippling says so on the page, once per file: "File x.pdf uploaded
    // successfully". Twenty seconds without is left to the board to refuse.
    if (RIPPLING) {
      const done = (document.body?.innerText.match(/uploaded successfully/gi) ?? []).length;
      if (done >= uploadMark.expected || performance.now() - uploadMark.at > 20000) return { settled: true, pending: [] };
      return { settled: false, pending: [`${uploadMark.expected - done} upload(s)`] };
    }
    // Each upload is one request, and a request appears in the page's
    // resource timeline the moment it finishes. The board itself swaps the
    // file input for a chip with the file's name as soon as a file is
    // chosen, so the page's text says nothing about whether the bytes have
    // arrived. The timeline does.
    const finished = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.startTime >= uploadMark.at && UPLOAD_HOST.test(entry.name)).length;
    if (finished >= uploadMark.expected) return { settled: true, pending: [] };
    // A board that uploads some other way would wait forever on a signal that
    // never comes. After a while, with the chips in place, it is taken as
    // done; the board's own refusal is what catches a file that did not land.
    const elapsed = performance.now() - uploadMark.at;
    const chips = document.querySelectorAll("[class*='file-upload__filename'], [class*='filename'], [class*='file-name']").length;
    const bodyText = document.body?.innerText ?? "";
    const named = uploadMark.names.every((name) => bodyText.includes(name));
    if (elapsed > 12000 && (chips >= uploadMark.expected || named)) return { settled: true, pending: [] };
    return { settled: false, pending: [`${uploadMark.expected - finished} upload(s)`] };
  }

  /** What a dropdown is currently showing, which is not what its input holds. */
  function selectedLabel(element) {
    const control = element.closest("[class*='select__control']");
    // A menu that is a div shows its choice as its own text, and a
    // placeholder ("Select", "Select...") until one is made.
    if (!control && !(element instanceof HTMLInputElement)) {
      const shown = contentOf(element);
      return /^(?:select|choose)(?:\s*(?:one|\.{3}|…))?$/i.test(shown) ? "" : shown;
    }
    // An autocomplete that is not a react-select keeps what was chosen in
    // the box itself.
    if (!control) return text(element.value);
    const chosen = control.querySelector("[class*='single-value'], [class*='singleValue'], [class*='multi-value']");
    return chosen ? text(chosen.textContent) : "";
  }

  /**
   * What is still empty that the form will not send without.
   *
   * Scanned fresh rather than walked over the plan. The page is not the page
   * that was read a moment ago - uploads have re-rendered parts of it, and
   * answering one question can reveal another - so the only trustworthy
   * account of what is still missing is the one taken now.
   */
  /**
   * A control that was not there at inventory time - the "which job board?"
   * that appears once "Other job board" is chosen - gets a key now, so the
   * second pass can be told about it and fill it.
   */
  /**
   * Whether a board has taken a file and then emptied the input it came
   * through. Rippling does: the input reads no files, and the block beside
   * it says "File x.pdf uploaded successfully". Workable shows the file's
   * name in the block in place of the drop zone.
   */
  function fileTaken(element) {
    const block = blockOf(element);
    if (!block) return false;
    const said = contentOf(block);
    if (/uploaded successfully|\b[1-9]\d* files? selected/i.test(said)) return true;
    return uploadMark.names.some((name) => name && said.includes(name));
  }

  function register(element, selector) {
    if (element.getAttribute(KEY_ATTRIBUTE)) return element.getAttribute(KEY_ATTRIBUTE);
    const key = `f${(counter += 1)}`;
    element.setAttribute(KEY_ATTRIBUTE, key);
    registry.set(key, { element, selector });
    return key;
  }

  function verify() {
    const empty = [];

    const everything = [
      ...controls().map((element) => ({ element, selector: selectorFor(element) })),
      ...groupedControls().map((group) => ({ element: group.element, selector: group.element.id ? `#${CSS.escape(group.element.id)}` : "" })),
    ];
    for (const { element, selector } of everything) {
      const label = questionFor(element);
      if (!isRequired(element, label)) continue;

      let filled;
      if (element.matches?.("[role='radiogroup'], [role='group']") && element.querySelector("[role='radio'], [role='checkbox']")) filled = Boolean(element.querySelector("[role='radio'][aria-checked='true'], [role='checkbox'][aria-checked='true'], input:checked"));
      else if (element.querySelector?.("button[data-option]")) filled = Boolean(element.querySelector("button[data-option][aria-pressed='true']"));
      else if (element.tagName !== "INPUT" && element.querySelector?.("input[type='checkbox']")) filled = [...element.querySelectorAll("input[type='checkbox']")].some((box) => box.checked);
      else if (element.type === "file") filled = (element.files && element.files.length > 0) || fileTaken(element);
      else if (element.type === "checkbox") filled = element.checked;
      else if (element.type === "radio") {
        filled = element.name
          ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`)].some((radio) => radio.checked)
          : element.checked;
      } else if (isCombobox(element)) {
        // A react-select clears its own text box on selection and shows the
        // chosen option in a sibling element instead. Reading `value` here
        // reports every dropdown as empty, however well the filling went.
        filled = selectedLabel(element).length > 0;
      } else if (searchResultsFor(element)) {
        // The place is only sent once chosen from the results, into the
        // hidden box beside it; text alone in the visible one is not kept.
        const hidden = element.closest(".application-field")?.querySelector("input[type='hidden']");
        filled = text(element.value).length > 0 && (!hidden || hidden.value.length > 0);
      } else filled = text(element.value).length > 0;

      if (!filled) {
        empty.push({
          key: register(element, selector),
          label: unstarred(label),
          type: element.type || element.tagName.toLowerCase(),
          combobox: isCombobox(element),
          multiline: element.tagName === "TEXTAREA",
        });
      }
    }

    return { empty };
  }

  function findSubmit() {
    // ApplyToJob's Submit is an <a href="#" class="btn">.
    const candidates = [...document.querySelectorAll("button, input[type='submit'], [role='button'], a.btn, a[href='#']")];
    return (
      candidates.find((button) => /^submit application$/i.test(text(button.textContent) || button.value || "")) ??
      candidates.find((button) => /submit/i.test(text(button.textContent) || button.value || "")) ??
      candidates.find((button) => /^apply(?: now)?$/i.test(text(button.textContent) || button.value || "")) ??
      candidates.find((button) => button.type === "submit") ??
      null
    );
  }

  async function submit() {
    let button = findSubmit();
    if (!button) return { clicked: false, reason: "no submit button on the page" };
    // A press on a disabled button, or one the page is not ready for, goes
    // nowhere and says nothing. Up to ten seconds for the page to be ready.
    const deadline = performance.now() + 10000;
    while (!quiet() && performance.now() < deadline) await wait(200);
    button = findSubmit() ?? button;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return { clicked: false, reason: "the submit button stayed disabled" };
    }
    submitMark = performance.now();
    button.click();
    return { clicked: true, label: text(button.textContent) || button.value || "" };
  }

  /** When Submit was last pressed, on the page's clock. */
  let submitMark = 0;

  /**
   * The board's answer to the application, if it sent one from a script:
   * the first write to an apply/application address since Submit was
   * pressed, with its status. Null until there is one.
   */
  function sent() {
    const answer = requests.find((request) => request.at >= submitMark && /\/apply\b|\/applications?\b|\/submit\b|\/candidates?\b/i.test(request.url));
    return answer ? { url: answer.url, status: answer.status, ok: answer.status >= 200 && answer.status < 300 } : null;
  }

  /**
   * Everything the page sent since Submit, for an attempt that ended
   * without a confirmation.
   *
   * `sent` above answers one question - did the board's own apply
   * endpoint return 2xx - and when the answer is no there is no way to
   * tell which of the several reasons it was. Workable has never once
   * confirmed, nor Rippling; on a night of thirty-nine attempts every
   * application to either was filed as "possibly sent", which is an
   * application the run cannot account for and will not retry.
   *
   * The candidates are: the board posted somewhere this does not
   * recognise as an apply address, it used a transport this does not
   * watch, or it navigated on Submit and took this recorder with it. All
   * three look identical from `sent`, and are immediately distinct from
   * the list below - an empty list means the recorder died or never saw
   * anything, and a list of addresses means the pattern is the problem.
   */
  function traffic() {
    return {
      submitAt: submitMark,
      since: requests.filter((request) => request.at >= submitMark).map((request) => ({ method: request.method, url: request.url, status: request.status })),
      total: requests.length,
    };
  }

  /**
   * What the form is complaining about, if anything, after Submit was pressed.
   *
   * Only visible complaints count. Boards keep empty error containers mounted
   * beside every field, and a hidden one with no text is not a rejection.
   */
  function complaints() {
    // Next.js keeps a role=alert for screen readers that announces the
    // page's title on every route (Rippling); it is clipped to a pixel and
    // is not a complaint.
    const announcer = (node) => node.id === "__next-route-announcer__" || node.closest("#__next-route-announcer__");
    const visible = (node) => {
      if (node.offsetParent === null || text(node.textContent).length === 0 || announcer(node)) return false;
      const box = node.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
    };
    const nodes = [...document.querySelectorAll('[role="alert"], [aria-invalid="true"] ~ *, [class*="error"], [class*="invalid"], [id*="error"]')];
    const messages = nodes.filter(visible).map((node) => text(node.textContent)).filter((message) => message.length < 200);
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].map((node) => labelFor(node)).filter(Boolean);
    return { messages: [...new Set(messages)].slice(0, 8), invalid: [...new Set(invalid)].slice(0, 8), formPresent: Boolean(findSubmit()) };
  }

  /**
   * The email check some boards add after Submit.
   *
   * Greenhouse can hold an application until the applicant proves they own the
   * address: "A verification code was sent to x@y. To submit your application,
   * enter the 8-character code" over a row of one-character boxes, with Submit
   * greyed out until all of them are filled. Found by the boxes rather than the
   * sentence, because the sentence is the part that gets reworded.
   */
  function codeBoxes() {
    const byId = [...document.querySelectorAll('input[id^="security-input-"]')];
    if (byId.length > 0) return byId;
    const wrapper = document.querySelector('[class*="email-verification"], [class*="verification-code"], [class*="security-code"]');
    return wrapper ? [...wrapper.querySelectorAll("input")].filter((input) => input.maxLength === 1) : [];
  }

  function verification() {
    const boxes = codeBoxes().filter((box) => box.offsetParent !== null);
    if (boxes.length === 0) return null;
    const context = (boxes[0].closest("fieldset, section, div[class*='verification']") ?? boxes[0].parentElement)?.textContent ?? "";
    const address = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
    const email = text(document.body.textContent).match(new RegExp(`code was sent to\\s+(${address.source})`, "i"))?.[1] ?? text(context).match(address)?.[0] ?? "";
    return { boxes: boxes.length, email, filled: boxes.every((box) => box.value) };
  }

  /** Types the code one box at a time, which is the only way the row accepts it. */
  function enterCode(code) {
    const boxes = codeBoxes();
    if (boxes.length === 0) return { entered: false, reason: "no code boxes on the page" };
    const characters = String(code).replace(/\s+/g, "");
    if (characters.length !== boxes.length) {
      return { entered: false, reason: `the code has ${characters.length} characters and the form wants ${boxes.length}` };
    }
    boxes.forEach((box, index) => {
      box.focus();
      setNativeValue(box, characters[index]);
    });
    const button = findSubmit();
    return { entered: true, submitEnabled: Boolean(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true" };
  }

  /**
   * A reportable dump of the form, for building the field map against pages
   * that actually exist rather than pages as remembered.
   */
  function probe() {
    const report = inventory();
    return {
      ...report,
      frames: [...document.querySelectorAll("iframe")].map((frame) => frame.src || "(no src)"),
      forms: document.querySelectorAll("form").length,
      counts: {
        total: report.fields.length,
        required: report.fields.filter((field) => field.required).length,
        selects: report.fields.filter((field) => field.options.length > 0).length,
        comboboxes: report.fields.filter((field) => field.combobox).length,
        files: report.fields.filter((field) => field.type === "file").length,
      },
    };
  }

  window.__ghApply = { inventory, apply, verify, submit, sent, traffic, complaints, verification, enterCode, probe, menuOptions, uploadsSettled };
})();
