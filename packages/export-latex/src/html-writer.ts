/**
 * The HTML target (09 §11; EXP-087): a direct writer from the CDM, without LaTeX. The output is one
 * HTML5 document. Its structure follows the document: headings by outline level, paragraphs, lists
 * as `ul` and `ol` with their literal labels kept in a `span`, tables with their spans, pictures
 * with their alternative text, links, footnotes as a list at the end, and display equations as
 * LaTeX source in `pre` (not rendered).
 *
 * Escaping (criterion 2): every text and attribute value passes through `escapeHtml`. The writer
 * emits no script, no `style` attribute taken from the document and no event handler: the only
 * attributes are the fixed ones below and the values this file checks first (link targets, picture
 * paths, anchor names, language tags, colours, highlight names, font family names and sizes). A
 * `style` attribute is built here from those checked values only. A link target goes through the
 * classifier of the LaTeX writer, so only the schemes of I9 are written.
 *
 * Run formatting (criterion 3) is the resolved run of 03 §6: bold, italic, underline, strike,
 * vertical alignment, colour, highlight, language, and the font family and size where they differ
 * from the default paragraph style (whose family and size are written on `body`).
 *
 * Constructs HTML cannot express, or that this writer does not write, are named in the diagnostics
 * (criterion 4): page setups, headers and footers, tab stops, form fields, host extensions, fields
 * without a result, and paragraph layout other than alignment.
 */
import {
  computeLabels,
  outlineLevelOf,
  resolveParagraph,
  resolveRun,
  styleTable,
  utf8,
  type CdmEnvelope,
  type ResolvedParagraph,
  type RunProperties,
  type TreeNode,
} from '@docedit/model';
import type { Diagnostic } from './bundle.ts';
import type { J } from './context.ts';
import { url } from './emit.ts';
import {
  destinationOf,
  note,
  visibility,
  type DirectState,
  type Visibility,
} from './markdown-writer.ts';
import type { DocumentWriter, WriterInput } from './writer.ts';

export interface HtmlOptions {
  /** How suggestions are shown (09 §10). A missing value with suggestions present is an error. */
  readonly suggestions?: 'accept' | 'reject' | 'markup' | null;
  /** The document's title, written in `title`. */
  readonly title?: string | null;
}

export interface HtmlOutput {
  readonly text: string;
  readonly bytes: Uint8Array;
  /** False when a diagnostic is an error (EXP-082). */
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** The pictures the HTML refers to: the path written in `src` and the asset identifier. */
  readonly assets: readonly { readonly path: string; readonly asset: string }[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text and attribute values for HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const NAME = /^[A-Za-z0-9_:.-]{1,128}$/;
/** The font family names of 03 §4.5 (`FONT_FAMILY_PATTERN` of the model): safe inside a quoted CSS string. */
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;
/**
 * The highlight colours of 03 §4.5 as CSS colours. The values are the RGB values Word gives the
 * named highlights of ECMA-376 (`ST_HighlightColor`).
 */
const HIGHLIGHT: Readonly<Record<string, string>> = {
  yellow: '#FFFF00',
  green: '#00FF00',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  blue: '#0000FF',
  red: '#FF0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#C0C0C0',
  black: '#000000',
  white: '#FFFFFF',
};

/** A font size of the model (twips, 03 §4.5) in CSS points, or null when it is not a valid size. */
function points(twips: number): string | null {
  return Number.isInteger(twips) && twips >= 20 && twips <= 32760 ? `${twips / 20}pt` : null;
}

/**
 * The CSS for the document's default run, written on `body` (EXP-087 criterion 3): the family and
 * size of the default paragraph style, so runs that keep them need no style of their own.
 */
function bodyCss(base: RunProperties): string {
  const css: string[] = [];
  if (base.fontFamily !== null && FONT_FAMILY.test(base.fontFamily))
    css.push(`font-family:'${base.fontFamily}'`);
  const size = points(base.fontSize);
  if (size !== null) css.push(`font-size:${size}`);
  return css.length > 0 ? `body{${css.join(';')}}` : '';
}

/**
 * The font family and size of a resolved run where they differ from the document's default run
 * (03 §6). A value that cannot be written safely is named in the diagnostics.
 */
function fontStyle(
  ctx: Ctx,
  run: RunProperties,
  base: RunProperties,
  blockId: string | null,
): string[] {
  const css: string[] = [];
  if (run.fontFamily !== null && run.fontFamily !== base.fontFamily) {
    if (FONT_FAMILY.test(run.fontFamily)) css.push(`font-family:'${run.fontFamily}'`);
    else
      note(
        ctx,
        'warning',
        'font_family_not_written',
        'a font family name outside the pattern of 03 §4.5 is not written',
        blockId,
      );
  }
  if (run.fontSize !== base.fontSize) {
    const size = points(run.fontSize);
    if (size !== null) css.push(`font-size:${size}`);
    else
      note(
        ctx,
        'warning',
        'font_size_not_written',
        'a font size outside 20 to 32760 twips is not written',
        blockId,
      );
  }
  return css;
}

type Ctx = DirectState & {
  readonly table: ReturnType<typeof styleTable>;
  readonly labels: ReturnType<typeof computeLabels>;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly footnotes: Array<{ readonly n: number; readonly html: string }>;
  readonly pictures: Map<string, string>;
  readonly anchors: Set<string>;
  /** The paragraph whose runs are being written, and the defaults for text outside one (03 §6). */
  readonly paragraph: { current: ResolvedParagraph; readonly base: ResolvedParagraph };
};

/**
 * The resolved properties of a text node (03 §6, EXP-087 criterion 3): the paragraph's run
 * properties, the character style, then the direct marks, through the model's `resolveRun`.
 */
function runOf(ctx: Ctx, marks: readonly J[], blockId: string | null) {
  const para = ctx.paragraph.current;
  const r = resolveRun(ctx.table, para, marks as never);
  if (r.ok) return r.value;
  note(ctx, 'warning', r.error.code, `${r.error.message}; the character style is ignored`, blockId);
  const again = resolveRun(ctx.table, para, marks.filter((m) => m.type !== 'charStyle') as never);
  return again.ok ? again.value : para.run;
}

/** A picture: the `img` element with its alternative text, or the alternative text alone. */
function pictureHtml(ctx: Ctx, asset: string | null, alt: string, blockId: string | null): string {
  const altText = escapeHtml(alt.replace(/[\r\n]+/g, ' '));
  if (asset === null) return altText;
  if (!Object.prototype.hasOwnProperty.call(ctx.assets, asset)) {
    note(
      ctx,
      'warning',
      'image_asset_missing',
      'a picture is not in the document assets; its alternative text is written instead',
      blockId,
    );
    return altText;
  }
  let path = ctx.pictures.get(asset);
  if (path === undefined) {
    path = `assets/${asset.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    ctx.pictures.set(asset, path);
  }
  return `<img src="${escapeHtml(destinationOf(path))}" alt="${altText}">`;
}

function textHtml(ctx: Ctx, node: J, blockId: string | null): string {
  const marks = node.marks ?? [];
  const vis: Visibility = visibility(ctx, marks, blockId);
  if (vis === 'hide') return '';
  const run = runOf(ctx, marks, blockId);
  if (run.hidden) return '';
  let body = escapeHtml((node.text ?? '').replace(/[\r\n]+/g, ' '));
  let href: string | null = null;
  let title: string | null = null;
  for (const m of marks) {
    switch (m.type) {
      case 'link': {
        const h = str(m.attrs?.['href']);
        if (h === null) break;
        const k = url(h.trim());
        if (k.kind === 'refused')
          note(
            ctx,
            'warning',
            'link_scheme_dropped',
            'a link to a scheme other than http, https, mailto or an in-document target is written as plain text (I9)',
            blockId,
          );
        else href = k.kind === 'internal' ? `#${k.name}` : destinationOf(h.trim());
        title = str(m.attrs?.['title']);
        break;
      }
      // Formatting marks are read through the resolved run below (03 §6), not one by one here.
      case 'charStyle':
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
      case 'smallCaps':
      case 'allCaps':
      case 'vertAlign':
      case 'fontFamily':
      case 'fontSize':
      case 'color':
      case 'highlight':
      case 'lang':
      case 'ins':
      case 'del':
      case 'fmt':
      case 'hidden':
        break;
      default:
        note(
          ctx,
          'warning',
          `${m.type}_plain`,
          `${m.type} formatting is not written in HTML; the text is written without it`,
          blockId,
        );
    }
  }
  const base = ctx.paragraph.base.run;
  const style = [...fontStyle(ctx, run, base, blockId)];
  if (run.color !== null) {
    if (COLOUR.test(run.color)) style.push(`color:${run.color}`);
    else
      note(
        ctx,
        'warning',
        'colour_not_written',
        'a colour that is not a six-digit hex value is not written',
        blockId,
      );
  }
  if (run.highlight !== null) {
    const h = HIGHLIGHT[run.highlight];
    if (h !== undefined) style.push(`background-color:${h}`);
    else
      note(
        ctx,
        'warning',
        'highlight_not_written',
        `the highlight "${run.highlight}" is not one of 03 §4.5 and is not written`,
        blockId,
      );
  }
  // The document's default language is the `lang` of the html element, so only a different one is written.
  const lang = run.lang !== null && run.lang !== base.lang && LANG.test(run.lang) ? run.lang : null;
  if (run.smallCaps || run.allCaps)
    note(
      ctx,
      'warning',
      'caps_plain',
      'small capitals and all capitals are not written in HTML; the text is written as typed',
      blockId,
    );
  if (style.length > 0) body = `<span style="${escapeHtml(style.join(';'))}">${body}</span>`;
  if (lang !== null) body = `<span lang="${lang}">${body}</span>`;
  if (run.strike) body = `<s>${body}</s>`;
  if (run.underline !== 'none') body = `<u>${body}</u>`;
  if (run.italic) body = `<em>${body}</em>`;
  if (run.bold) body = `<strong>${body}</strong>`;
  if (run.vertAlign === 'super') body = `<sup>${body}</sup>`;
  if (run.vertAlign === 'sub') body = `<sub>${body}</sub>`;
  if (href !== null)
    body = `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${body}</a>`;
  if (vis === 'del') body = `<del>${body}</del>`;
  if (vis === 'ins') body = `<ins>${body}</ins>`;
  return body;
}

function inlineHtml(ctx: Ctx, nodes: readonly J[] | undefined, blockId: string | null): string {
  let out = '';
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'text':
        out += textHtml(ctx, n, blockId);
        break;
      case 'tab':
        note(ctx, 'warning', 'tab_stop_plain', 'tab stops are written as a space', blockId);
        out += ' ';
        break;
      case 'break': {
        const kind = str(n.attrs?.['kind']) ?? 'line';
        if (kind === 'line') out += '<br>';
        else
          note(
            ctx,
            'warning',
            'page_break_omitted',
            'page and column breaks are not written in HTML',
            blockId,
          );
        break;
      }
      case 'image':
        out += pictureHtml(ctx, str(n.attrs?.['asset']), str(n.attrs?.['alt']) ?? '', blockId);
        break;
      case 'equation':
        note(
          ctx,
          'warning',
          'equation_as_source',
          'equations are written as LaTeX source in code, not rendered',
          blockId,
        );
        out += `<code class="de-math">${escapeHtml((str(n.attrs?.['latex']) ?? '').replace(/[\r\n]+/g, ' '))}</code>`;
        break;
      case 'footnote': {
        const number = ctx.footnotes.length + 1;
        const html = (n.content ?? []).map((p) => inlineHtml(ctx, p.content, blockId)).join(' ');
        ctx.footnotes.push({ n: number, html });
        out += `<sup><a id="fnref${number}" href="#fn${number}">${number}</a></sup>`;
        break;
      }
      case 'field': {
        const cached = str(n.attrs?.['cached']);
        if (cached === null)
          note(
            ctx,
            'warning',
            'field_not_computed',
            'a field without a cached result is not written in HTML',
            blockId,
          );
        else out += escapeHtml(cached);
        break;
      }
      case 'citation': {
        const cached = str(n.attrs?.['cached']);
        if (cached === null)
          note(
            ctx,
            'warning',
            'citation_not_generated',
            'a citation without a generated text is not written in HTML',
            blockId,
          );
        else out += escapeHtml(cached);
        break;
      }
      case 'anchor': {
        const name = str(n.attrs?.['name']);
        if (name !== null && NAME.test(name) && !ctx.anchors.has(name)) {
          ctx.anchors.add(name);
          out += `<span id="${name}"></span>`;
        }
        break;
      }
      case 'form_field':
        note(ctx, 'warning', 'form_field_omitted', 'form fields are not written in HTML', blockId);
        break;
      case 'extension_inline':
        note(
          ctx,
          'warning',
          'extension_omitted',
          'host extensions are not written in HTML',
          blockId,
        );
        break;
      case 'preserved_inline':
        note(
          ctx,
          'warning',
          'preserved_omitted',
          'Word content the model does not represent is not written in HTML',
          blockId,
        );
        break;
      default:
        note(
          ctx,
          'warning',
          'unknown_inline_omitted',
          `an inline node of type "${n.type}" is not written in HTML`,
          blockId,
        );
    }
  }
  return out;
}

/**
 * The class that gives a paragraph its alignment; other layout is named in the diagnostics. Both
 * read the resolved paragraph (03 §6), so a style's alignment and spacing count as the paragraph's
 * own. A paragraph that does not resolve has been named by `paragraphBody` and uses the default.
 */
function alignClass(
  ctx: Ctx,
  attrs: Record<string, unknown> | undefined,
  blockId: string | null,
): string {
  const r = resolveParagraph(ctx.table, (attrs ?? {}) as never, {});
  const p = (r.ok ? r.value : ctx.paragraph.base).properties;
  const layout =
    p.indentLeft !== 0 ||
    p.indentRight !== 0 ||
    p.indentFirstLine !== 0 ||
    p.spaceBefore !== 0 ||
    p.spaceAfter !== 0 ||
    p.lineSpacing !== 1000 ||
    p.lineRule !== 'multiple' ||
    p.borders !== null ||
    p.shading !== null ||
    p.pageBreakBefore ||
    p.tabs.length > 0;
  if (layout)
    note(
      ctx,
      'warning',
      'paragraph_layout_omitted',
      'spacing, indents, borders, shading, tab stops and page breaks of paragraphs are not written in HTML',
      blockId,
    );
  if (p.align === 'center' || p.align === 'end' || p.align === 'justify')
    return ` class="de-align-${p.align}"`;
  if (p.align === 'distribute')
    note(
      ctx,
      'warning',
      'alignment_omitted',
      'distributed alignment is written as the start alignment',
      blockId,
    );
  return '';
}

function paragraphBody(ctx: Ctx, p: J, blockId: string | null): string {
  const previous = ctx.paragraph.current;
  const r = resolveParagraph(ctx.table, p.attrs as never, {});
  if (r.ok) ctx.paragraph.current = r.value;
  else note(ctx, 'warning', r.error.code, `${r.error.message}; the default style is used`, blockId);
  let s = inlineHtml(ctx, p.content, blockId);
  ctx.paragraph.current = previous;
  while (s.endsWith('<br>')) s = s.slice(0, -4);
  return s;
}

function equationHtml(ctx: Ctx, n: J): string {
  note(
    ctx,
    'warning',
    'equation_as_source',
    'display equations are written as LaTeX source in a pre element, not rendered',
    str(n.attrs?.['id']),
  );
  return `<pre class="de-math"><code>${escapeHtml(str(n.attrs?.['latex']) ?? '')}</code></pre>`;
}

function figureHtml(ctx: Ctx, f: J): string {
  const id = str(f.attrs?.['id']);
  const picture = pictureHtml(ctx, str(f.attrs?.['asset']), str(f.attrs?.['alt']) ?? '', id);
  const caption = (f.content ?? []).find((c) => c.type === 'caption');
  const captionHtml = caption ? inlineHtml(ctx, caption.content, id) : '';
  const align = str(f.attrs?.['align']);
  if (align !== null && align !== 'start' && align !== 'center' && align !== 'end')
    note(ctx, 'warning', 'alignment_omitted', 'this alignment is not written in HTML', id);
  return `<figure>${picture}${captionHtml === '' ? '' : `<figcaption>${captionHtml}</figcaption>`}</figure>`;
}

function cellHtml(ctx: Ctx, cell: J): string {
  const parts: string[] = [];
  for (const c of cell.content ?? []) {
    const id = str(c.attrs?.['id']);
    if (c.type === 'paragraph') {
      if (visibility(ctx, c.marks, id) === 'hide') continue;
      const body = paragraphBody(ctx, c, id);
      // A numbered paragraph in a cell keeps its label (CDM-042): the label of `computeLabels`.
      const label = id !== null ? ctx.labels.lists.get(id) : undefined;
      const prefix =
        label !== undefined && label.kind !== 'none'
          ? `<span class="de-label">${escapeHtml(label.text)}</span> `
          : '';
      if (body !== '' || prefix !== '')
        parts.push(`<p${alignClass(ctx, c.attrs, id)}>${prefix}${body}</p>`);
    } else if (c.type === 'figure') parts.push(figureHtml(ctx, c));
    else if (c.type === 'equation_block') parts.push(equationHtml(ctx, c));
    else
      note(
        ctx,
        'warning',
        'cell_content_omitted',
        `a "${c.type}" in a table cell is not written in HTML`,
        id,
      );
  }
  return parts.join('');
}

function tableHtml(ctx: Ctx, t: J): string[] {
  const tid = str(t.attrs?.['id']);
  if (visibility(ctx, t.marks, tid) === 'hide') return [];
  const rows = (t.content ?? []).filter(
    (r) => visibility(ctx, r.marks, str(r.attrs?.['id'])) !== 'hide',
  );
  if (rows.length === 0) return [];
  if (t.attrs?.['style'] !== undefined && t.attrs?.['style'] !== null)
    note(
      ctx,
      'info',
      'table_style_plain',
      'table styles are not written in HTML; the cells keep their own formatting',
      tid,
    );
  const rowHtml = (r: J, header: boolean): string => {
    const cells = (r.content ?? []).map((cell) => {
      const attrs: string[] = [];
      const colspan = Number(cell.attrs?.['colspan'] ?? 1);
      const rowspan = Number(cell.attrs?.['rowspan'] ?? 1);
      if (colspan > 1) attrs.push(` colspan="${colspan}"`);
      if (rowspan > 1) attrs.push(` rowspan="${rowspan}"`);
      const tag = header ? 'th' : 'td';
      return `<${tag}${attrs.join('')}>${cellHtml(ctx, cell)}</${tag}>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  };
  const [first, ...rest] = rows;
  const head = `<thead>${rowHtml(first!, true)}</thead>`;
  const bodyRows =
    rest.length > 0 ? `<tbody>${rest.map((r) => rowHtml(r, false)).join('')}</tbody>` : '';
  return [`<table>${head}${bodyRows}</table>`];
}

function block(ctx: Ctx, n: J): string[] {
  const id = str(n.attrs?.['id']);
  switch (n.type) {
    case 'region':
      return blocksHtml(ctx, n.content);
    case 'section_break':
      return [];
    case 'paragraph': {
      if (visibility(ctx, n.marks, id) === 'hide') return [];
      const body = paragraphBody(ctx, n, id);
      const label = id !== null ? ctx.labels.lists.get(id) : undefined;
      const prefix =
        label !== undefined && label.kind !== 'none'
          ? `<span class="de-label">${escapeHtml(label.text)}</span> `
          : '';
      const level = outlineLevelOf(ctx.table, n.attrs);
      if (level !== null) {
        if (level + 1 > 6)
          note(
            ctx,
            'warning',
            'heading_level_clamped',
            'headings below level 6 are written as level 6',
            id,
          );
        const depth = Math.min(6, level + 1);
        return [`<h${depth}${alignClass(ctx, n.attrs, id)}>${prefix}${body}</h${depth}>`];
      }
      if (body === '') return [];
      return [`<p${alignClass(ctx, n.attrs, id)}>${prefix}${body}</p>`];
    }
    case 'table':
      return tableHtml(ctx, n);
    case 'figure':
      return [figureHtml(ctx, n)];
    case 'equation_block':
      return [equationHtml(ctx, n)];
    case 'toc':
      note(
        ctx,
        'warning',
        'toc_omitted',
        'tables of contents and lists of figures are generated; they are not written in HTML',
        id,
      );
      return [];
    case 'bibliography':
      note(
        ctx,
        'warning',
        'bibliography_omitted',
        'the bibliography is generated; it is not written in HTML',
        id,
      );
      return [];
    case 'extension_block': {
      const fallback = str(n.attrs?.['fallbackText']);
      note(
        ctx,
        'warning',
        'extension_omitted',
        'host extension blocks are written as their fallback text, or not at all',
        id,
      );
      return fallback === null || fallback === '' ? [] : [`<p>${escapeHtml(fallback)}</p>`];
    }
    case 'hidden_region':
      note(
        ctx,
        'info',
        'hidden_region_omitted',
        'a region the reader may not see is not written',
        id,
      );
      return [];
    case 'preserved_block':
      note(
        ctx,
        'warning',
        'preserved_omitted',
        'Word content the model does not represent is not written in HTML',
        id,
      );
      return [];
    default:
      note(
        ctx,
        'warning',
        'unknown_block_omitted',
        `a block of type "${n.type}" is not written in HTML`,
        id,
      );
      return [];
  }
}

/**
 * The blocks of a container with their lists. Consecutive items of one list form one `ul` or `ol`;
 * an item one level deeper opens a list inside the open item; any other block closes the open lists.
 */
function blocksHtml(ctx: Ctx, nodes: readonly J[] | undefined): string[] {
  const out: string[] = [];
  const stack: Array<{
    readonly listId: string;
    readonly level: number;
    readonly tag: 'ul' | 'ol';
  }> = [];
  for (const n of nodes ?? []) {
    const id = str(n.attrs?.['id']);
    const label = n.type === 'paragraph' && id !== null ? ctx.labels.lists.get(id) : undefined;
    const isItem =
      label !== undefined && label.kind !== 'none' && outlineLevelOf(ctx.table, n.attrs) === null;
    if (!isItem) {
      while (stack.length > 0) out.push(`</li></${stack.pop()!.tag}>`);
      out.push(...block(ctx, n));
      continue;
    }
    if (visibility(ctx, n.marks, id) === 'hide') continue;
    const level = label.level;
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.level > level || (top.level === level && top.listId !== label.listId))
        out.push(`</li></${stack.pop()!.tag}>`);
      else break;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined && top.level === level) out.push('</li>');
    else {
      const tag = label.kind === 'bullet' ? 'ul' : 'ol';
      out.push(`<${tag} class="de-list">`);
      stack.push({ listId: label.listId, level, tag });
    }
    out.push(
      `<li><span class="de-label">${escapeHtml(label.text)}</span> ${paragraphBody(ctx, n, id)}`,
    );
  }
  while (stack.length > 0) out.push(`</li></${stack.pop()!.tag}>`);
  return out;
}

/** The HTML of an envelope (EXP-087). Reads the document and does not change it. */
export function htmlText(
  envelope: CdmEnvelope,
  options: HtmlOptions = {},
  assets: Readonly<Record<string, unknown>> = {},
): HtmlOutput {
  const doc = envelope.doc as unknown as J;
  const table = styleTable(doc as unknown as TreeNode);
  const labels = computeLabels(doc as unknown as TreeNode, { table });
  const base = resolveParagraph(table, {}, {});
  if (!base.ok) throw new Error('the default paragraph style cannot be resolved');
  const ctx: Ctx = {
    table,
    labels,
    paragraph: { current: base.value, base: base.value },
    mode: options.suggestions ?? null,
    assets,
    diagnostics: [],
    warned: new Set(),
    footnotes: [],
    pictures: new Map(),
    anchors: new Set(),
  };
  const content = doc.content ?? [];
  const settings = content
    .find((c) => c.type === 'defs')
    ?.content?.find((c) => c.type === 'settings');
  const lang = str(settings?.attrs?.['lang']);
  if (content.some((c) => c.type === 'story'))
    note(
      ctx,
      'warning',
      'headers_footers_omitted',
      'headers, footers and other stories are not written in HTML',
      null,
    );
  if (
    content.some((c) => c.type === 'defs' && (c.content ?? []).some((d) => d.type === 'page_setup'))
  )
    note(ctx, 'info', 'page_setup_omitted', 'page setups are not written in HTML', null);
  const body = content.find((c) => c.type === 'body');
  const blocks = blocksHtml(ctx, body?.content);
  if (ctx.footnotes.length > 0) {
    const items = ctx.footnotes.map(
      (f) => `<li id="fn${f.n}">${f.html} <a href="#fnref${f.n}">&#8617;</a></li>`,
    );
    blocks.push(`<section class="de-footnotes"><ol>${items.join('')}</ol></section>`);
  }
  const head = [
    '<!doctype html>',
    `<html lang="${lang !== null && LANG.test(lang) ? lang : 'en'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title ?? '')}</title>`,
    '<style>',
    '.de-list{list-style:none;padding-left:1.5em}',
    '.de-align-center{text-align:center}',
    '.de-align-end{text-align:end}',
    '.de-align-justify{text-align:justify}',
    ...[bodyCss(base.value.run)].filter((css) => css !== ''),
    '</style>',
    '</head>',
    '<body>',
    '<main>',
  ];
  const text = `${[...head, ...blocks, '</main>', '</body>', '</html>'].join('\n')}\n`;
  return {
    text,
    bytes: utf8(text),
    ok: !ctx.diagnostics.some((d) => d.severity === 'error'),
    diagnostics: ctx.diagnostics,
    assets: [...ctx.pictures].map(([asset, path]) => ({ path, asset })),
  };
}

/** The HTML target as a writer (09 §11), read the same way as the other direct writers. */
export const htmlWriter: DocumentWriter<HtmlOptions, HtmlOutput> = {
  target: 'html',
  async write(input: WriterInput, options: HtmlOptions) {
    return htmlText(
      input.document,
      { title: input.title ?? null, ...options },
      input.assets as Readonly<Record<string, unknown>>,
    );
  },
};
