/**
 * Clipboard HTML without an embedded CDM fragment, turned into a fragment through a whitelist (FE-054;
 * 02 §5.2; SEC-005 to SEC-009). The HTML is parsed into an inert document by `DOMParser`: no script
 * runs, and no image, frame or style sheet loads. Only the elements below reach the fragment, and
 * everything else is dropped, or its text is kept when the element is only a wrapper.
 *
 * - Scripted and embedded elements (`script`, `iframe`, `object`, `embed`, `svg`, `math`, forms and
 *   so on) are dropped with their content. No attribute is copied into the fragment. Four are read:
 *   a link's `href`, and on other elements `style` (only its `font-weight` and `font-style`, which
 *   decide bold and italic, as Google Docs writes them), `aria-level`, `colspan` and `rowspan`.
 * - A link keeps its target only when it matches the link pattern of the model (I9: http, https,
 *   mailto or an in-document target). Any other scheme drops the link and keeps the text.
 * - Structure maps to CDM equivalents (FE-054 criterion 4): `h1` to `h6` to paragraphs of the
 *   built-in styles `Heading1` to `Heading6`; `ul`, `ol` and Word's `mso-list` paragraphs to
 *   paragraphs with a `numbering` value over two definitions the fragment brings (`PastedBullets`
 *   and `PastedNumbered`, nine levels each); `table` to `table`, `table_row` and `table_cell`, with
 *   column and row spans; other block elements to paragraphs. A table inside a table cell is
 *   flattened to paragraphs (tables do not nest in version 1, 03 §4.3).
 * - `strong` and `b` become bold, `em` and `i` italic, unless the element's own style says normal
 *   (Google Docs wraps a whole paste in `<b style="font-weight:normal">`). A line break becomes a space.
 * - Pictures are not part of the fragment (`img` is dropped). `picturesFromForeignDocument` reads the
 *   `data:` URI pictures apart, for upload through the assets port (FE-054 criterion 6).
 *
 * Universal logic over the DOM types only: the parser is the platform's `DOMParser`. The view parses
 * through view/paste-policy.ts, which handles Trusted Types and never throws; `fragmentFromHtmlString`
 * parses a plain string and is kept for tests on pages without Trusted Types.
 */
import { nodeId } from '@docedit/model';
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

/** The numbering definitions a pasted list refers to (the fragment brings the ones it uses). */
const BULLETS_ID = 'PastedBullets';
const NUMBERED_ID = 'PastedNumbered';
const BULLET_CHARS = ['•', '◦', '▪'] as const;
const NUMBER_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'] as const;

/** The deepest list level of the model (03 §4.1: levels 0 to 8). */
const MAX_LEVEL = 8;
/** The most columns a table has (I7). */
const MAX_COLUMNS = 63;
/**
 * The width the grid of a pasted table is spread over, in twips: the text width of a default page,
 * an A4 sheet (11906) less the default left and right margins (1440 each). The widths of the source
 * table are not read; the columns are equal.
 */
const TABLE_WIDTH = 9026;

interface Sink {
  readonly blocks: CdmJsonNode[];
  inline: CdmJsonNode[];
}

/** A list item whose first paragraph takes the list membership. */
interface ListItem {
  readonly numberingId: string;
  readonly level: number;
  readonly listId: string;
  readonly restart: number | null;
  used: boolean;
}

interface ListContext {
  readonly numberingId: string;
  readonly listId: string;
  /** The `start` of an ordered list, until its first item takes it. */
  start: number | null;
}

/** What the paragraphs being read belong to. */
interface Context {
  readonly style: string | null;
  readonly item: ListItem | null;
  readonly list: ListContext | null;
  readonly listDepth: number;
  readonly inCell: boolean;
}

/** State of one parse: the definitions used and the list instances of Word's `mso-list`. */
interface State {
  readonly used: Set<string>;
  readonly wordLists: Map<string, string>;
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

/**
 * Ends the running inline content as one paragraph, without its outer spaces, if it holds text. The
 * paragraph takes the heading style of `ctx` and, once per list item, the item's list membership.
 */
function flush(sink: Sink, ctx: Context, state: State): void {
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
  if (content.length === 0) return;
  const paragraph: CdmJsonNode = { type: 'paragraph', content };
  const attrs: Record<string, unknown> = {};
  if (ctx.style !== null) attrs['style'] = ctx.style;
  const item = ctx.item;
  if (item !== null && !item.used) {
    item.used = true;
    state.used.add(item.numberingId);
    attrs['numbering'] = { numberingId: item.numberingId, level: item.level, listId: item.listId };
    if (item.restart !== null) attrs['numberingRestart'] = item.restart;
  }
  if (Object.keys(attrs).length > 0) paragraph.attrs = attrs;
  sink.blocks.push(paragraph);
}

/** The value of a CSS property in an inline `style` attribute (lower case), or null. */
function cssValue(css: string, property: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!]+)`, 'i').exec(css);
  return m === null ? null : (m[1] ?? '').trim().toLowerCase();
}

/** Whether a `font-weight` value is bold, not bold, or says nothing (null). */
function boldWeight(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === 'bold' || value === 'bolder') return true;
  if (value === 'normal' || value === 'lighter') return false;
  const n = Number(value);
  return Number.isFinite(n) ? n >= 600 : null;
}

/** Whether a `font-style` value is italic, not italic, or says nothing (null). */
function italicStyle(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === 'italic' || value === 'oblique') return true;
  if (value === 'normal') return false;
  return null;
}

/** Adds a mark unless one of its type is already there (a link inside a link keeps the outer one). */
function addMark(marks: Mark[], mark: Mark): Mark[] {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

/** The marks inside an inline element: its tag first, then its own style, which has the last word. */
function marksOf(el: Element, tag: string, css: string, marks: readonly Mark[]): Mark[] {
  let next: Mark[] = [...marks];
  let bold: boolean | null = tag === 'strong' || tag === 'b' ? true : null;
  let italic: boolean | null = tag === 'em' || tag === 'i' ? true : null;
  bold = boldWeight(cssValue(css, 'font-weight')) ?? bold;
  italic = italicStyle(cssValue(css, 'font-style')) ?? italic;
  if (bold === true) next = addMark(next, { type: 'bold' });
  else if (bold === false) next = next.filter((m) => m.type !== 'bold');
  if (italic === true) next = addMark(next, { type: 'italic' });
  else if (italic === false) next = next.filter((m) => m.type !== 'italic');
  if (tag === 'a') {
    const href = allowedHref(el.getAttribute('href'));
    if (href !== null) next = addMark(next, { type: 'link', attrs: { href } });
  }
  return next;
}

const WORD_LIST = /mso-list\s*:\s*(l\d+)\s+level(\d+)\s+(lfo\d+)/i;
const WORD_LIST_IGNORE = /mso-list\s*:\s*ignore/i;

/** Whether the marker text Word writes in front of a list paragraph is a number or letter. */
function isOrderedMarker(marker: string): boolean {
  return /^\(?[0-9A-Za-z]+[.)]$/.test(marker.replace(/[\s\u00a0]+/g, ''));
}

/** The marker text of a Word list paragraph: the text of its `mso-list:Ignore` element. */
function wordMarker(el: Element): string {
  for (const child of Array.from(el.querySelectorAll('[style]'))) {
    if (WORD_LIST_IGNORE.test(child.getAttribute('style') ?? ''))
      return (child.textContent ?? '').trim();
  }
  return '';
}

/** A positive whole number from an attribute, or `fallback`. */
function wholeNumber(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function walk(
  node: Node,
  marks: readonly Mark[],
  sink: Sink,
  depth: number,
  ctx: Context,
  state: State,
): void {
  if (depth > MAX_DEPTH) return;
  if (node.nodeType === 3) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ');
    if (text !== '') sink.inline.push(textNode(text, marks));
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.localName.toLowerCase();
  if (DROPPED.has(tag)) return;
  const css = el.getAttribute('style') ?? '';
  // The bullet or number Word writes in front of a list paragraph is not content.
  if (WORD_LIST_IGNORE.test(css)) return;
  const children = (inner: Context): void => {
    for (const child of Array.from(node.childNodes))
      walk(child, marks, sink, depth + 1, inner, state);
  };
  if (tag === 'table' && !ctx.inCell) {
    flush(sink, ctx, state);
    const table = tableOf(el, depth, state);
    if (table !== null) {
      sink.blocks.push(table);
      return;
    }
  }
  if (tag === 'ul' || tag === 'ol') {
    flush(sink, ctx, state);
    const ordered = tag === 'ol';
    const start = ordered ? wholeNumber(el.getAttribute('start'), 1) : 1;
    const numberingId = ordered ? NUMBERED_ID : BULLETS_ID;
    // A list inside a list of the same kind is a deeper level of that list, not a new list.
    const list: ListContext = {
      numberingId,
      listId: ctx.list?.numberingId === numberingId ? ctx.list.listId : nodeId(),
      start: start > 1 ? start : null,
    };
    children({ ...ctx, list, listDepth: ctx.listDepth + 1 });
    flush(sink, ctx, state);
    return;
  }
  if (tag === 'li') {
    flush(sink, ctx, state);
    const list = ctx.list;
    const given = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
    const level = Math.min(
      MAX_LEVEL,
      Math.max(0, Number.isFinite(given) ? given - 1 : ctx.listDepth - 1),
    );
    const item: ListItem = {
      numberingId: list?.numberingId ?? BULLETS_ID,
      level,
      listId: list?.listId ?? nodeId(),
      restart: list?.start ?? null,
      used: false,
    };
    if (list) list.start = null;
    const inner = { ...ctx, item };
    children(inner);
    flush(sink, inner, state);
    return;
  }
  const heading = /^h([1-6])$/.exec(tag);
  if (heading || BLOCKS.has(tag)) {
    flush(sink, ctx, state);
    let inner: Context = ctx;
    if (heading) inner = { ...ctx, style: `Heading${heading[1]}` };
    else if (tag === 'p') {
      const cls = el.getAttribute('class') ?? '';
      const word = WORD_LIST.exec(css);
      if (word) {
        const key = `${word[1]} ${word[3]}`;
        let listId = state.wordLists.get(key);
        if (listId === undefined) {
          listId = nodeId();
          state.wordLists.set(key, listId);
        }
        const level = Math.min(MAX_LEVEL, Math.max(0, wholeNumber(word[2] ?? null, 1) - 1));
        inner = {
          ...ctx,
          item: {
            numberingId: isOrderedMarker(wordMarker(el)) ? NUMBERED_ID : BULLETS_ID,
            level,
            listId,
            restart: null,
            used: false,
          },
        };
      } else if (/\bMsoTitle\b/.test(cls)) inner = { ...ctx, style: 'Title' };
      else if (/\bMsoSubtitle\b/.test(cls)) inner = { ...ctx, style: 'Subtitle' };
    }
    children(inner);
    flush(sink, inner, state);
    return;
  }
  if (tag === 'br') {
    sink.inline.push(textNode(' ', marks));
    return;
  }
  const next = marksOf(el, tag, css, marks);
  for (const child of Array.from(node.childNodes)) walk(child, next, sink, depth + 1, ctx, state);
}

/** The rows of a table element: its own `tr` elements that hold at least one cell. */
function rowsOf(table: Element): Element[][] {
  const rows: Element[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    if (tr.closest('table') !== table) continue;
    const cells = Array.from(tr.children).filter((c) => {
      const t = c.localName.toLowerCase();
      return t === 'td' || t === 'th';
    });
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/**
 * A table element as a CDM `table` (03 §4.3), or null when it cannot be one (no cell, or more than 63
 * columns): the caller then reads it as plain blocks. Spans are laid out as a table grid: a cell takes
 * the next column no earlier row span covers, spans are cut to the table, and columns a row leaves
 * uncovered get empty cells, so that the spans cover the grid (I6).
 */
function tableOf(table: Element, depth: number, state: State): CdmJsonNode | null {
  const source = rowsOf(table);
  if (source.length === 0) return null;
  const rowCount = source.length;
  const busy = new Set<string>();
  let columns = 0;
  const placed: Array<Array<{ col: number; node: CdmJsonNode }>> = [];
  const cellContext: Context = { style: null, item: null, list: null, listDepth: 0, inCell: true };
  for (const [r, cells] of source.entries()) {
    const row: Array<{ col: number; node: CdmJsonNode }> = [];
    let col = 0;
    for (const cell of cells) {
      while (busy.has(`${r},${col}`)) col++;
      if (col >= MAX_COLUMNS) return null;
      const colspan = Math.min(wholeNumber(cell.getAttribute('colspan'), 1), MAX_COLUMNS - col);
      const rowspan = Math.min(wholeNumber(cell.getAttribute('rowspan'), 1), rowCount - r);
      for (let rr = r; rr < r + rowspan; rr++)
        for (let cc = col; cc < col + colspan; cc++) busy.add(`${rr},${cc}`);
      const sink: Sink = { blocks: [], inline: [] };
      for (const child of Array.from(cell.childNodes))
        walk(child, [], sink, depth + 1, cellContext, state);
      flush(sink, cellContext, state);
      const node: CdmJsonNode = {
        type: 'table_cell',
        content: sink.blocks.length > 0 ? sink.blocks : [{ type: 'paragraph' }],
      };
      const attrs: Record<string, unknown> = {};
      if (colspan > 1) attrs['colspan'] = colspan;
      if (rowspan > 1) attrs['rowspan'] = rowspan;
      if (Object.keys(attrs).length > 0) node.attrs = attrs;
      row.push({ col, node });
      columns = Math.max(columns, col + colspan);
      col += colspan;
    }
    placed.push(row);
  }
  const rows: CdmJsonNode[] = placed.map((row, r) => {
    for (let c = 0; c < columns; c++) {
      if (!busy.has(`${r},${c}`))
        row.push({ col: c, node: { type: 'table_cell', content: [{ type: 'paragraph' }] } });
    }
    row.sort((a, b) => a.col - b.col);
    return { type: 'table_row', content: row.map((cell) => cell.node) };
  });
  let headerRows = 0;
  while (headerRows < rowCount && (source[headerRows] ?? []).every((c) => c.localName === 'th'))
    headerRows++;
  const attrs: Record<string, unknown> = {
    grid: Array.from({ length: columns }, () => Math.floor(TABLE_WIDTH / columns)),
  };
  if (headerRows > 0) attrs['headerRows'] = headerRows;
  return { type: 'table', attrs, content: rows };
}

/** The numbering definition the fragment brings for pasted lists: nine levels (03 §4.1). */
function numberingDefinition(id: string): CdmJsonNode {
  const bullets = id === BULLETS_ID;
  const levels = Array.from({ length: MAX_LEVEL + 1 }, (_, level) => ({
    format: bullets ? 'bullet' : (NUMBER_FORMATS[level % NUMBER_FORMATS.length] ?? 'decimal'),
    text: bullets ? '' : `%${level + 1}.`,
    start: 1,
    indentLeft: 720 + level * 360,
    hanging: 360,
    ...(bullets ? { bulletChar: BULLET_CHARS[level % BULLET_CHARS.length] ?? '•' } : {}),
  }));
  return {
    type: 'numbering_def',
    attrs: { id, name: bullets ? 'Pasted bullets' : 'Pasted numbered list', levels },
  };
}

/**
 * The fragment a parsed HTML document holds, as the whitelist reads it, or null when it holds no text.
 * Two open depths let the first and last paragraphs join the text around the caret, as a paste does;
 * a table at either end is closed.
 */
export function fragmentFromForeignDocument(doc: Document, cdm: number): CdmFragment | null {
  const sink: Sink = { blocks: [], inline: [] };
  const state: State = { used: new Set(), wordLists: new Map() };
  const root: Context = { style: null, item: null, list: null, listDepth: 0, inCell: false };
  walk(doc.body, [], sink, 0, root, state);
  flush(sink, root, state);
  if (sink.blocks.length === 0) return null;
  const first = sink.blocks[0];
  const last = sink.blocks[sink.blocks.length - 1];
  const defs = [BULLETS_ID, NUMBERED_ID]
    .filter((id) => state.used.has(id))
    .map(numberingDefinition);
  return {
    cdm,
    requires: [],
    defs,
    content: sink.blocks,
    openStart: first?.type === 'paragraph' ? 1 : 0,
    openEnd: last?.type === 'paragraph' ? 1 : 0,
  };
}

/** Parses clipboard HTML into an inert document and reads it through the whitelist (FE-054). */
export function fragmentFromHtmlString(html: string, cdm: number): CdmFragment | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return fragmentFromForeignDocument(doc, cdm);
}
