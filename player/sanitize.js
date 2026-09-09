// Allowlist HTML sanitiser for `message.content`.
//
// A .ronu file is untrusted by design (it arrives over WhatsApp), so rich text
// is rebuilt element by element from a parsed copy: only allowlisted tags are
// created, only allowlisted attributes are copied, and nothing is ever set
// through innerHTML. Everything else is unwrapped (its text survives) or, for
// active content, dropped with its children.

const ALLOWED = {
  p: [], br: [], strong: [], em: [], u: [], ul: [], ol: [], li: [], h1: [], h2: [], h3: [], h4: [],
  a: ['href'], img: ['src', 'alt'], blockquote: [], code: [], pre: [],
};
const ALIAS = { b: 'strong', i: 'em', h5: 'h4', h6: 'h4' };
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'noscript', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'frame', 'frameset', 'applet', 'canvas', 'head', 'title']);

const isHttp = (s) => /^https?:\/\//i.test(s);

/**
 * @param {string} html
 * @param {(ref: string) => string|null} resolveUrl  bundle path -> URL (blob), or null
 * @returns {DocumentFragment}
 */
export function sanitizeHtml(html, resolveUrl = () => null) {
  const frag = document.createDocumentFragment();
  if (typeof html !== 'string' || html === '') return frag;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  copyChildren(doc.body, frag, resolveUrl);
  return frag;
}

function copyChildren(from, to, resolveUrl) {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      to.appendChild(document.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, etc.
    const raw = child.localName.toLowerCase();
    if (DROP.has(raw)) continue;
    const tag = ALIAS[raw] ?? raw;
    const attrs = ALLOWED[tag];
    if (!attrs) {
      copyChildren(child, to, resolveUrl); // unwrap unknown element, keep its content
      continue;
    }
    const el = document.createElement(tag);
    if (tag === 'a') {
      const href = (child.getAttribute('href') ?? '').trim();
      if (isHttp(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'img') {
      const src = (child.getAttribute('src') ?? '').trim();
      const resolved = isHttp(src) ? src : resolveUrl(src);
      if (!resolved || !(isHttp(resolved) || resolved.startsWith('blob:'))) {
        // Unresolvable image (platform storage ref, data: URI, or missing): show its alt text instead.
        const alt = child.getAttribute('alt');
        if (alt) to.appendChild(document.createTextNode(`[${alt}]`));
        continue;
      }
      el.setAttribute('src', resolved);
      el.setAttribute('alt', child.getAttribute('alt') ?? '');
      el.setAttribute('loading', 'lazy');
    }
    to.appendChild(el);
    if (tag !== 'img' && tag !== 'br') copyChildren(child, el, resolveUrl);
  }
}

/** Plain text (no markup at all), for titles, questions and labels. */
export function textNode(s) {
  return document.createTextNode(s == null ? '' : String(s));
}
