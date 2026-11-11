/**
 * Browser-side script that reads what a crawl keeps of a page besides its snapshot controls: the document status,
 * the title, every `a[href]` and `area[href]` (hidden ones too: a collapsed menu still offers its links) and every
 * form with its field model. It reads attributes and label text only, never a field's value, so no typed or
 * prefilled secret leaves the page. Kept as a string so no bundler helper can leak into code that runs in the page.
 *
 * @remarks The status comes from the Navigation Timing entry (`responseStatus`, Chromium 109 and later): the answer
 *   of the final hop, 0 when the browser does not know it. Counts are capped here (2,000 links, 50 forms, 200 fields
 *   per form) before anything crosses to Node; text is capped at 300 characters.
 */
export const PAGE_SCRIPT = String.raw`(() => {
  const text = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const own = (e) => {
    const c = e.cloneNode(true);
    for (const x of c.querySelectorAll('input,select,textarea,button')) x.remove();
    return text(c.textContent);
  };
  const byIds = (ids) => text((ids || '').split(/\s+/).map((id) => {
    const e = id && document.getElementById(id);
    return e ? own(e) : '';
  }).join(' '));
  const label = (e) => byIds(e.getAttribute('aria-labelledby')) || text(e.getAttribute('aria-label')) ||
    text([...(e.labels || [])].map(own).join(' ')) || text(e.getAttribute('placeholder')) ||
    text(e.getAttribute('title')) || text(e.getAttribute('name'));
  const FIELD_ROLES = ['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider'];
  const SKIP = ['hidden', 'submit', 'reset', 'button', 'image'];
  const role = (e) => {
    const r = e.getAttribute('role');
    if (FIELD_ROLES.includes(r)) return r;
    if (e.tagName === 'SELECT') return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
    if (e.tagName === 'TEXTAREA') return 'textbox';
    const t = e.type;
    if (t === 'checkbox' || t === 'radio') return t;
    if (t === 'search') return 'searchbox';
    if (t === 'number') return 'spinbutton';
    if (t === 'range') return 'slider';
    if (t === 'file') return 'button';
    return 'textbox';
  };
  const SUBMIT = 'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]';
  const forms = [...document.forms].slice(0, 50).map((f) => {
    const s = f.querySelector(SUBMIT);
    const fields = [...f.elements]
      .filter((e) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) && !SKIP.includes(e.type))
      .slice(0, 200)
      .map((e) => ({
        role: role(e),
        name: label(e),
        type: e.tagName === 'INPUT' ? e.getAttribute('type') : null,
        required: e.required === true || e.getAttribute('aria-required') === 'true',
      }));
    return {
      name: byIds(f.getAttribute('aria-labelledby')) || text(f.getAttribute('aria-label')) || null,
      submit: s ? text(s.getAttribute('aria-label')) || text(s.innerText) || text(s.value) || text(s.alt) || null : null,
      fields,
    };
  });
  const links = [...document.querySelectorAll('a[href],area[href]')].slice(0, 2000).map((a) => ({
    href: a.href,
    target: (a.getAttribute('target') || '').toLowerCase(),
    download: a.hasAttribute('download'),
    name: text(a.getAttribute('aria-label')) || text(a.innerText) || text(a.getAttribute('title')) || text(a.getAttribute('alt')),
  }));
  const nav = performance.getEntriesByType('navigation')[0];
  return { status: (nav && nav.responseStatus) || 0, title: text(document.title), links, forms };
})()`;
