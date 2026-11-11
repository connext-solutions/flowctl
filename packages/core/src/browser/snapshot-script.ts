/**
 * Browser-side script listing the visible, enabled controls of a page and its visible text.
 *
 * @remarks Ported from jev-ultrafast `snapshot.js` (MIT, © 2026 Browser Use, commit 1231850; see
 *   `THIRD_PARTY_NOTICES.md`). Changes: one control per element carrying its operations (a native
 *   select is one SELECT control, not one action per option); `ignore` selectors drop dev overlays
 *   from controls and text; at most 250 controls; no geometry guards (Playwright's actionability
 *   checks run instead); marks from the previous action are cleared. Password, file and hidden
 *   inputs are never listed, so credentials cannot reach System 1. Element ids are kept in
 *   `window.__flowctl` so one element keeps its id across snapshots of the same document. Kept as
 *   a string so no bundler helper can leak into code that runs in the page.
 * @param ignore CSS selectors whose subtrees are left out (`snapshotIgnore`).
 */
export const snapshotScript = (ignore: string[]): string => String.raw`(() => {
  const IGNORE = ${JSON.stringify(ignore)};
  const MARK = 'data-flowctl-target';
  const cache = (window.__flowctl ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  for (const e of document.querySelectorAll('[' + MARK + ']')) e.removeAttribute(MARK);
  const ignored = (e) => IGNORE.some((s) => e.closest(s) !== null);
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    ROLES.map((r) => '[role="' + r + '"]').join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (ROLES.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel', 'date'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  const controls = [];
  for (const e of document.querySelectorAll(selector)) {
    if (controls.length >= 250) break;
    if (!safe(e) || ignored(e) || !visible(e) || e.matches(':disabled') ||
      e.closest('[aria-disabled="true"]')) continue;
    const kind = role(e);
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!kind || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (kind === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const c = { id: identity(e), role: kind, name: name(e) || kind, ops: [], value: '' };
    for (const key of ['checked', 'selected', 'expanded']) {
      const v = e.getAttribute('aria-' + key);
      if (v !== null) c[key] = v;
    }
    if (['checkbox', 'radio'].includes(e.type)) c.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      c.ops.push('SELECT');
      c.value = [...e.selectedOptions].map((o) => o.label).join(', ');
      c.options = [...e.options].filter((o) => !o.disabled).map((o) => o.label);
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(kind) ||
          (kind === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      c.value = 'value' in e ? String(e.value) :
        e.isContentEditable || kind === 'combobox' ? e.innerText.trim() : '';
      c.ops.push('CLICK');
      if (editable) c.ops.push('TYPE_TEXT');
    }
    controls.push(c);
  }
  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node, length = 0;
  while ((node = walker.nextNode()) && length < 6000) {
    const value = node.textContent.trim(), parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') ||
      ignored(parent) || !visible(parent)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
      words.push(value);
      length += value.length;
    }
  }
  const height = document.documentElement.scrollHeight;
  return {
    url: location.href, title: document.title, text: words.join('\n').slice(0, 6000), controls,
    canScrollUp: scrollY > 0, canScrollDown: scrollY + innerHeight < height - 2,
  };
})()`;
