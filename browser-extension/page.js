/* Functions injected into pages with chrome.scripting.executeScript. Each one
 * must be self-contained: it runs in the page's isolated world, not here.
 * Refs live in that isolated world (globalThis.__maestro), so the page's own
 * scripts never see them and the DOM is never marked. */

/** A readable outline of the page: interactive elements (or everything
 *  meaningful with filter "all"), each with a ref the other tools accept. */
export function snapshotPage(filter, maxItems) {
  const S = (globalThis.__maestro ??= { refs: new Map(), next: 1, byEl: new WeakMap() });
  const W = innerWidth, H = innerHeight;
  const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary", "details", "option"]);
  const ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|textbox|searchbox|slider|spinbutton|treeitem)$/;
  const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const visible = (el, r) => {
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const nameOf = (el) => {
    const label = el.getAttribute("aria-label");
    if (label) return clean(label);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.innerText ?? "").join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.labels?.length) return clean([...el.labels].map((l) => l.innerText).join(" "));
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return clean(el.placeholder || el.title || el.name || "");
    if (tag === "img") return clean(el.alt || el.title || "");
    return clean(el.innerText || el.textContent || el.title || el.getAttribute("alt") || "");
  };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "text";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      return t === "checkbox" || t === "radio" ? t : t === "submit" || t === "button" ? "button" : t === "search" ? "searchbox" : "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (el.isContentEditable) return "textbox";
    return tag === "summary" ? "button" : tag;
  };
  const isInteractive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE.has(tag)) return !(tag === "a" && !el.hasAttribute("href") && !el.onclick);
    const role = el.getAttribute("role");
    if (role && ROLES.test(role)) return true;
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return true;
    if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") return true;
    // Clickable by look only: keep the outermost pointer element, not every
    // child that inherits the cursor.
    if (getComputedStyle(el).cursor !== "pointer") return false;
    const up = el.parentElement;
    return !!up && getComputedStyle(up).cursor !== "pointer" && !up.closest("a,button,[role=button],[role=link]");
  };
  const isMeaningful = (el) => /^h[1-6]$/i.test(el.tagName) || el.tagName === "IMG" || el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alert";
  const refFor = (el) => {
    let id = S.byEl.get(el);
    if (!id) { id = "ref_" + S.next++; S.byEl.set(el, id); S.refs.set(id, new WeakRef(el)); }
    return id;
  };
  const out = [];
  let skipped = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      const want = isInteractive(el) || (filter === "all" && isMeaningful(el));
      if (!want) continue;
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      if (out.length >= maxItems) { skipped++; continue; }
      const role = roleOf(el);
      let line = `[${refFor(el)}] ${role} "${cut(nameOf(el))}"`;
      if ("value" in el && (role === "textbox" || role === "searchbox" || role === "combobox") && el.value) line += ` value="${cut(String(el.value), 60)}"`;
      if (el.checked) line += " checked";
      if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " disabled";
      if (el.getAttribute("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      line += cy < 0 || cy > H || cx < 0 || cx > W ? " (offscreen)" : ` @${cx},${cy}`;
      out.push(line);
    }
  };
  walk(document);
  const frames = document.querySelectorAll("iframe").length;
  return {
    title: document.title,
    url: location.href,
    viewport: `${W}x${H}`,
    lines: out,
    note: [skipped ? `${skipped} more elements not listed` : "", frames ? `${frames} iframe(s) not included` : ""].filter(Boolean).join("; "),
  };
}

/** The element behind a ref: scrolled into view, with its centre. */
export function locateRef(ref) {
  const el = globalThis.__maestro?.refs.get(ref)?.deref();
  if (!el || !el.isConnected) return { error: `${ref} is gone from the page. Call browser_read_page again.` };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

/** Set a form control's value the way typing would, so frameworks notice. */
export function fillRef(ref, value) {
  const el = globalThis.__maestro?.refs.get(ref)?.deref();
  if (!el || !el.isConnected) return { error: `${ref} is gone from the page. Call browser_read_page again.` };
  const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    const opt = [...el.options].find((o) => o.value === value || o.text.trim() === value);
    if (!opt) return { error: `No option "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(", ")}` };
    el.value = opt.value;
  } else if (el.type === "checkbox" || el.type === "radio") {
    el.checked = value === true || value === "true" || value === "on" || value === "1";
  } else if (el.isContentEditable) {
    el.focus();
    el.textContent = String(value);
  } else {
    el.focus();
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
  }
  fire("input");
  fire("change");
  return { ok: true };
}

/** Elements whose name or text contains every word of the query. */
export function findInPage(query, maxItems) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const S = (globalThis.__maestro ??= { refs: new Map(), next: 1, byEl: new WeakMap() });
  const hits = [];
  const CONTROL = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/;
  for (const el of document.querySelectorAll("a,button,input,select,textarea,[role],[aria-label],label,h1,h2,h3,h4,li,td,span,div,p")) {
    if (hits.length >= maxItems * 3) break;
    const text = (el.getAttribute("aria-label") || el.placeholder || el.labels?.[0]?.innerText || el.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 200) continue;
    const low = text.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    // keep the innermost match only
    if ([...el.children].some((c) => words.every((w) => (c.innerText || "").toLowerCase().includes(w)))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    let id = S.byEl.get(el);
    if (!id) { id = "ref_" + S.next++; S.byEl.set(el, id); S.refs.set(id, new WeakRef(el)); }
    const control = CONTROL.test(el.tagName) || /^(button|link|textbox|checkbox|combobox|tab|menuitem)$/.test(el.getAttribute("role") ?? "");
    hits.push({ control, line: `[${id}] ${el.getAttribute("role") || el.tagName.toLowerCase()} "${text.slice(0, 80)}" @${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}` });
  }
  // Things you can act on first: a field named "Email" before its label.
  return hits.sort((a, b) => Number(b.control) - Number(a.control)).slice(0, maxItems).map((h) => h.line);
}

export function pageText(maxChars) {
  const t = document.body?.innerText ?? "";
  return { title: document.title, url: location.href, text: t.length > maxChars ? t.slice(0, maxChars) + `\n… (${t.length - maxChars} more characters)` : t };
}
