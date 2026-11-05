import { h } from './dom';

// A chat message's text as DOM: paragraphs, lists, headings, `code`, **bold**, [links](…) and the pictures it names.
// Nothing in it is trusted as HTML. Shared by the terminal chat, the meeting room and the interview.

/** How a path or link in an answer becomes an address the page can load: a picture of the floor's own folder, or undefined. */
export type Source = (target: string) => string | undefined;

export const IMAGE = /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i;
const LINK = /!?\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const PATH = /(?:[A-Za-z]:[\\/]|\/[A-Za-z]:\/|~\/|\.{0,2}\/)?[^\s"'`<>|*?()[\]]+\.(?:png|jpe?g|webp|gif)\b/gi;
const MAX_PICTURES = 8;

/** The pictures a message talks about: markdown links and bare paths that end in an image name, once each. */
function picturesIn(text: string): string[] {
  const found = new Map<string, string>();
  const add = (target: string) => {
    if (/^https?:/i.test(target) || !IMAGE.test(target)) return;
    const key = target.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:)/, '').toLowerCase();
    if (!found.has(key) && found.size < MAX_PICTURES) found.set(key, target);
  };
  for (const m of text.matchAll(LINK)) add(m[2]);
  for (const m of text.matchAll(PATH)) add(m[0]);
  return [...found.values()];
}

/** `code`, **bold** and [links](…) inside a line, as DOM: agents answer in light markdown, and nothing here is trusted as HTML. */
function inline(text: string, source: Source): (Node | string)[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[[^\]\n]*\]\([^)\s]+\))/).filter(Boolean).map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return h('code', {}, part.slice(1, -1));
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return h('strong', {}, part.slice(2, -2));
    const link = /^!?\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, target] = link;
      const src = source(target);
      if (src) return h('a.rt-link', { href: src, target: '_blank', rel: 'noopener noreferrer' }, label || target);
      if (/^https?:\/\//i.test(target)) return h('a.rt-link', { href: target, target: '_blank', rel: 'noopener noreferrer', dir: 'ltr' }, label || target);
      return h('code', { title: target }, label || target);
    }
    return part;
  });
}

/** A picture under the message: it opens whole in a new tab, and goes away if it can't be loaded. */
function thumb(target: string, source: Source): HTMLElement | null {
  const src = source(target);
  if (!src) return null;
  const name = target.replace(/\\/g, '/').split('/').pop() ?? target;
  const img = h('img', { src, alt: name, loading: 'lazy' }) as HTMLImageElement;
  const card = h('a.rt-pic', { href: src, target: '_blank', rel: 'noopener noreferrer', title: target }, img, h('small', { dir: 'ltr' }, name));
  img.addEventListener('error', () => card.remove());
  return card;
}

/** An answer as paragraphs, lists, headings and code blocks, instead of one wall of text. */
export function rich(text: string, source: Source): HTMLElement[] {
  const out: HTMLElement[] = [];
  let list: HTMLElement | undefined;
  let code: string[] | undefined;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(h('p', { dir: 'auto' }, ...inline(para.join('\n'), source)));
    para = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) { out.push(h('pre', { dir: 'ltr' }, h('code', {}, code.join('\n')))); code = undefined; } else { flush(); list = undefined; code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /^\s*\d/.test(line);
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) out.push((list = h(ordered ? 'ol' : 'ul')));
      list.append(h('li', { dir: 'auto' }, ...inline(item[1], source)));
      continue;
    }
    list = undefined;
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    if (head) { flush(); out.push(h('div.rt-h', { dir: 'auto' }, ...inline(head[1], source))); continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  if (code) out.push(h('pre', { dir: 'ltr' }, h('code', {}, code.join('\n'))));
  flush();
  const pictures = picturesIn(text).map((t) => thumb(t, source)).filter((x): x is HTMLElement => !!x);
  if (pictures.length) out.push(h('div.rt-gallery', {}, ...pictures));
  return out.length ? out : [h('p', {}, text)];
}
