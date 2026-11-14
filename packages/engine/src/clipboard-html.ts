/**
 * Clipboard HTML without an embedded CDM fragment, turned into a fragment through a whitelist (FE-054;
 * 02 §5.2; SEC-005 to SEC-009). The HTML is parsed into an inert document by `DOMParser`: no script
 * runs, and no image, frame or style sheet loads. Only the elements and attributes below reach the
 * fragment. Everything else is dropped, or its text is kept when the element is only a wrapper.
 *
 * - Scripted and embedded elements (`script`, `iframe`, `object`, `embed`, `svg`, `math`, forms and
 *   so on) are dropped with their content. No attribute is copied except a link's `href`, so no event
 *   handler and no style reaches the document.
 * - A link keeps its target only when it matches the link pattern of the model (I9: http, https,
 *   mailto or an in-document target). Any other scheme drops the link and keeps the text.
 * - Block elements become paragraphs; `strong` and `b` become bold, `em` and `i` italic. A line break
 *   becomes a space. Headings become plain paragraphs with bold text: mapping them to the document's
 *   heading styles is not done here (FE-054 criterion 4 stays open).
 * - Pictures are not part of the fragment (`img` is dropped). `picturesFromForeignDocument` reads the
 *   `data:` URI pictures apart, for upload through the assets port (FE-054 criterion 6).
 *
 * Universal logic over the DOM types only: the parser is the platform's `DOMParser`. The view parses
 * through view/paste-policy.ts, which handles Trusted Types and never throws; `fragmentFromHtmlString`
 * parses a plain string and is kept for tests on pages without Trusted Types.
 */
import { LINK_HREF_PATTERN } from '@docedit/model/definition';
import type { CdmFragment, CdmJsonNode } from './cdm-fragment.ts';
import type { PastedImage } from './image-paste.ts';

type Mark = NonNullable<CdmJsonNode['marks']>[number];

/** The `data:` URIs of pictures the editor takes in from pasted HTML (FE-054 criterion 6). */
const PICTURE_SOURCE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

const PICTURE_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Whether an element sits inside one the whitelist drops with its content. */
function inDroppedElement(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (DROPPED.has(p.localName.toLowerCase())) return true;
  }
  return false;
}

/** Decodes base64 text, or null when it is not valid base64. */
function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/\s/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The pictures a parsed HTML document holds as `data:` URIs of a picture type, in document order
 * (FE-054 criterion 6). Only inline data is read: a remote `src` is never fetched here (whether remote
 * images are fetched is open, see the story notes), and an image the whitelist drops is not taken.
 * Bytes are decoded, not parsed; the asset service validates them (10 §3.1).
 */
export function picturesFromForeignDocument(doc: Document): PastedImage[] {
  const out: PastedImage[] = [];
  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    if (inDroppedElement(img)) continue;
    const match = PICTURE_SOURCE.exec(img.getAttribute('src') ?? '');
    if (!match) continue;
    const mime = (match[1] ?? '').toLowerCase();
    const bytes = decodeBase64(match[2] ?? '');
    if (bytes === null || bytes.length === 0) continue;
    const ext = PICTURE_EXTENSION[mime] ?? 'bin';
    out.push({ name: `pasted-${out.length + 1}.${ext}`, mime, bytes });
  }
  return out;
}

/** Elements dropped with everything inside them. */
const DROPPED = new Set([
  'applet',
  'audio',
  'base',
  'button',
  'canvas',
  'embed',
  'form',
  'frame',
  'frameset',
  'head',
  'iframe',
  'img',
  'input',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'option',
  'picture',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'video',
]);

/** Elements that start a new paragraph and whose children are read in turn. */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Nesting deeper than this is not read: a guard against hostile input. */
const MAX_DEPTH = 256;

const LINK = new RegExp(LINK_HREF_PATTERN);

/** The order the schema ranks marks in (cdm1: link, then bold, then italic). */
const MARK_RANK: Record<string, number> = { link: 0, bold: 1, italic: 2 };

interface Sink {
  readonly blocks: CdmJsonNode[];
  inline: CdmJsonNode[];
}

/** The href of a link when it is allowed (I9), else null. */
export function allowedHref(raw: string | null): string | null {
  const href = (raw ?? '').trim();
  return LINK.test(href) ? href : null;
}

function textNode(text: string, marks: readonly Mark[]): CdmJsonNode {
  const ordered = [...marks].sort((a, b) => (MARK_RANK[a.type] ?? 9) - (MARK_RANK[b.type] ?? 9));
  const node: CdmJsonNode = { type: 'text', text };
  if (ordered.length > 0) node.marks = ordered;
  return node;
}

/** Ends the running inline content as one paragraph, without its outer spaces, if it holds text. */
function flush(sink: Sink): void {
  const kept = sink.inline.filter((n) => (n.text ?? '') !== '');
  sink.inline = [];
  for (const n of kept) {
    if (n.text === undefined) continue;
    n.text = n.text.replace(/^ +/, '');
    if (n.text !== '') break;
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    const n = kept[i];
    if (!n || n.text === undefined) continue;
    n.text = n.text.replace(/ +$/, '');
    if (n.text !== '') break;
  }
  const content = kept.filter((n) => (n.text ?? '') !== '');
  if (content.length > 0) sink.blocks.push({ type: 'paragraph', content });
}

function walk(node: Node, marks: readonly Mark[], sink: Sink, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (node.nodeType === 3) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ');
    if (text !== '') sink.inline.push(textNode(text, marks));
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = (node as Element).localName.toLowerCase();
  if (DROPPED.has(tag)) return;
  if (BLOCKS.has(tag)) {
    flush(sink);
    for (const child of Array.from(node.childNodes)) walk(child, marks, sink, depth + 1);
    flush(sink);
    return;
  }
  if (tag === 'br') {
    sink.inline.push(textNode(' ', marks));
    return;
  }
  let next: Mark[] = [...marks];
  if (tag === 'strong' || tag === 'b') next = addMark(next, { type: 'bold' });
  else if (tag === 'em' || tag === 'i') next = addMark(next, { type: 'italic' });
  else if (tag === 'a') {
    const href = allowedHref((node as Element).getAttribute('href'));
    if (href !== null) next = addMark(next, { type: 'link', attrs: { href } });
  }
  for (const child of Array.from(node.childNodes)) walk(child, next, sink, depth + 1);
}

/** Adds a mark unless one of its type is already there (a link inside a link keeps the outer one). */
function addMark(marks: Mark[], mark: Mark): Mark[] {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

/**
 * The fragment a parsed HTML document holds, as the whitelist reads it, or null when it holds no text.
 * Two open depths let the first and last paragraphs join the text around the caret, as a paste does.
 */
export function fragmentFromForeignDocument(doc: Document, cdm: number): CdmFragment | null {
  const sink: Sink = { blocks: [], inline: [] };
  walk(doc.body, [], sink, 0);
  flush(sink);
  if (sink.blocks.length === 0) return null;
  return {
    cdm,
    requires: [],
    defs: [],
    content: sink.blocks,
    openStart: 1,
    openEnd: 1,
  };
}

/** Parses clipboard HTML into an inert document and reads it through the whitelist (FE-054). */
export function fragmentFromHtmlString(html: string, cdm: number): CdmFragment | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return fragmentFromForeignDocument(doc, cdm);
}
