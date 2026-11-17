/**
 * The Markdown target (09 §11; EXP-088): a direct writer from the CDM, without LaTeX. It writes
 * CommonMark with the GFM extensions that the target's readers share (pipe tables, strikethrough,
 * footnotes). Constructs that Markdown cannot express are approximated and named in the
 * diagnostics (criterion 3): colour, underline, merged cells, page and column breaks, paragraph
 * layout, generated fields and tables of contents, and display equations (written as LaTeX source
 * in a code block, not rendered). Link targets go through the same classifier as the LaTeX writer,
 * so only the schemes of invariant I9 are written (criterion 4).
 *
 * Escaping (criterion 2): every character that Markdown could read as syntax is written with a
 * backslash. A backslash before any of these characters is literal in CommonMark, so the rendered
 * text equals the typed text, apart from line breaks inside a text node, which become spaces, and
 * from leading and trailing spaces, which a renderer trims.
 *
 * Nothing here reads a file or a network resource; pictures are referenced by path under `assets/`
 * and the job writes them (criterion 6, not covered here).
 */
import {
  computeLabels,
  outlineLevelOf,
  styleTable,
  utf8,
  type CdmEnvelope,
  type TreeNode,
} from '@docedit/model';
import type { Diagnostic } from './bundle.ts';
import type { J, Mark } from './context.ts';
import { url } from './emit.ts';
import { settleSuggestions } from './suggestions.ts';
import type { DocumentWriter, WriterInput } from './writer.ts';

export interface MarkdownOptions {
  /** How suggestions are shown (09 §10). A missing value with suggestions present is an error. */
  readonly suggestions?: 'accept' | 'reject' | 'markup' | null;
}

export interface MarkdownOutput {
  readonly text: string;
  readonly bytes: Uint8Array;
  /** False when a diagnostic is an error: the job must not release the text (EXP-082). */
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** The pictures the text links to: the path written in the text and the asset identifier. */
  readonly assets: readonly { readonly path: string; readonly asset: string }[];
}

/** Characters that are syntax wherever they stand in a line; each is written with a backslash. */
const ALWAYS = new Set([...'\\`*_[]<~|']);
/** Characters that are syntax only at the start of a line (a heading, a list or a rule). */
const AT_START = new Set([...'#+->=']);

/**
 * Escapes a text so that Markdown reads it back as the same characters. The escapes are the
 * minimum that CommonMark and GFM need: a backslash before one of ALWAYS, before `&` that starts an
 * entity, before `!` that starts an image, before a full stop or a closing parenthesis that follows
 * a digit (an ordered list), and before the start-of-line characters at the start of the text.
 */
export function escapeMarkdown(s: string): string {
  const chars = [...s];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const prev = i > 0 ? chars[i - 1]! : '';
    const next = chars[i + 1] ?? '';
    const escape =
      ALWAYS.has(ch) ||
      (i === 0 && AT_START.has(ch)) ||
      (ch === '&' && /[#A-Za-z0-9]/.test(next)) ||
      (ch === '!' && next === '[') ||
      ((ch === '.' || ch === ')') && /[0-9]/.test(prev));
    out += escape ? `\\${ch}` : ch;
  }
  return out;
}

/** A link destination with the characters that would end it percent-encoded. */
export function destinationOf(href: string): string {
  const encode = (c: string): string =>
    `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  return [...href]
    .map((c) =>
      c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f || '()<>\\"'.includes(c) ? encode(c) : c,
    )
    .join('');
}

type Ctx = {
  readonly table: ReturnType<typeof styleTable>;
  readonly labels: ReturnType<typeof computeLabels>;
  readonly mode: 'accept' | 'reject' | 'markup' | null;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly diagnostics: Diagnostic[];
  readonly warned: Set<string>;
  readonly footnotes: string[];
  readonly pictures: Map<string, string>;
};

/** The state every direct writer shares: the diagnostics, the suggestion mode (EXP-081). */
export type DirectState = Pick<Ctx, 'diagnostics' | 'warned' | 'mode'>;

/** Adds a diagnostic once per code and message (criterion 3 of EXP-088 and EXP-087). */
export function note(
  ctx: DirectState,
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  blockId: string | null,
): void {
  const key = `${code}\u0000${message}`;
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.diagnostics.push({ severity, code, blockId, message });
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type Visibility = 'show' | 'hide' | 'ins' | 'del';

/** How a node with these marks is shown under the suggestion mode (09 §10; EXP-081, EXP-082). */
export function visibility(
  ctx: DirectState,
  marks: readonly Mark[] | undefined,
  blockId: string | null,
): Visibility {
  const list = marks ?? [];
  const hasIns = list.some((m) => m.type === 'ins');
  const hasDel = list.some((m) => m.type === 'del');
  if (list.some((m) => m.type === 'fmt'))
    note(
      ctx,
      'info',
      'formatting_suggestion_plain',
      'formatting suggestions are written with their current formatting',
      blockId,
    );
  if (!hasIns && !hasDel) return 'show';
  let mode = ctx.mode;
  if (mode === null) {
    note(
      ctx,
      'error',
      'pending_suggestions',
      'the document has unresolved suggestions and no suggestions option; they are written as rejected',
      blockId,
    );
    mode = 'reject';
  }
  if (mode === 'accept') return hasDel ? 'hide' : 'show';
  if (mode === 'reject') return hasIns ? 'hide' : 'show';
  return hasDel ? 'del' : 'ins';
}

function wrap(s: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m || m[2] === '') return s;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function pictureMd(ctx: Ctx, asset: string | null, alt: string, blockId: string | null): string {
  const altText = escapeMarkdown(alt.replace(/[\r\n]+/g, ' '));
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
  return `![${altText}](${destinationOf(path)})`;
}

function codeSpan(s: string): string {
  const runs = s.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

function textNode(ctx: Ctx, node: J, blockId: string | null): string {
  const marks = node.marks ?? [];
  const vis = visibility(ctx, marks, blockId);
  if (vis === 'hide') return '';
  if (marks.some((m) => m.type === 'hidden' && m.attrs?.['value'] !== false)) return '';
  let body = escapeMarkdown((node.text ?? '').replace(/[\r\n]+/g, ' '));
  if (/[\r\n]/.test(node.text ?? ''))
    note(
      ctx,
      'info',
      'line_break_in_text',
      'a line break inside a text is written as a space',
      blockId,
    );
  let href: string | null = null;
  let title: string | null = null;
  let sup = false;
  let sub = false;
  let bold = false;
  let italic = false;
  let strike = false;
  for (const m of marks) {
    const on = m.attrs?.['value'] !== false;
    switch (m.type) {
      case 'bold':
        bold = on;
        break;
      case 'italic':
        italic = on;
        break;
      case 'strike':
        strike = on;
        break;
      case 'vertAlign':
        sup = m.attrs?.['value'] === 'super';
        sub = m.attrs?.['value'] === 'sub';
        break;
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
        else href = k.kind === 'internal' ? `#${k.name}` : h.trim();
        title = str(m.attrs?.['title']);
        break;
      }
      case 'underline':
        if (on)
          note(
            ctx,
            'warning',
            'underline_plain',
            'underline is not written in Markdown; the text is written without it',
            blockId,
          );
        break;
      case 'ins':
      case 'del':
      case 'fmt':
      case 'hidden':
        break;
      case 'preserved':
        note(
          ctx,
          'warning',
          'preserved_formatting_omitted',
          'Word formatting the model does not represent is not written in Markdown',
          blockId,
        );
        break;
      default:
        note(
          ctx,
          'warning',
          `${m.type}_plain`,
          `${m.type} formatting is not written in Markdown; the text is written without it`,
          blockId,
        );
    }
  }
  if (bold && italic) body = wrap(body, '***');
  else if (bold) body = wrap(body, '**');
  else if (italic) body = wrap(body, '*');
  if (strike) body = wrap(body, '~~');
  if (sup) body = `<sup>${body}</sup>`;
  if (sub) body = `<sub>${body}</sub>`;
  if (href !== null) {
    const t =
      title !== null && title !== '' ? ` "${title.replace(/[\\"]/g, (c) => `\\${c}`)}"` : '';
    body = `[${body}](${destinationOf(href)}${t})`;
  }
  if (vis === 'del') body = `<del>${body}</del>`;
  if (vis === 'ins') body = `<ins>${body}</ins>`;
  return body;
}

function inline(
  ctx: Ctx,
  nodes: readonly J[] | undefined,
  blockId: string | null,
  inCell: boolean,
): string {
  let out = '';
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'text':
        out += textNode(ctx, n, blockId);
        break;
      case 'tab':
        out += '\t';
        break;
      case 'break': {
        const kind = str(n.attrs?.['kind']) ?? 'line';
        if (kind !== 'line')
          note(
            ctx,
            'warning',
            'page_break_omitted',
            'page and column breaks are not written in Markdown',
            blockId,
          );
        else out += inCell ? '<br>' : '\\\n';
        break;
      }
      case 'image':
        out += pictureMd(ctx, str(n.attrs?.['asset']), str(n.attrs?.['alt']) ?? '', blockId);
        break;
      case 'equation':
        note(
          ctx,
          'warning',
          'equation_as_code',
          'equations are written as LaTeX source in code, not rendered',
          blockId,
        );
        out += codeSpan((str(n.attrs?.['latex']) ?? '').replace(/[\r\n]+/g, ' '));
        break;
      case 'footnote': {
        const idx = ctx.footnotes.length + 1;
        const text = (n.content ?? []).map((p) => inline(ctx, p.content, blockId, false)).join(' ');
        ctx.footnotes.push(`[^${idx}]: ${text}`);
        out += `[^${idx}]`;
        break;
      }
      case 'field': {
        const cached = str(n.attrs?.['cached']);
        if (cached === null)
          note(
            ctx,
            'warning',
            'field_not_computed',
            'a field without a cached result is not written in Markdown',
            blockId,
          );
        else out += escapeMarkdown(cached);
        break;
      }
      case 'citation': {
        const cached = str(n.attrs?.['cached']);
        if (cached === null)
          note(
            ctx,
            'warning',
            'citation_not_generated',
            'a citation without a generated text is not written in Markdown',
            blockId,
          );
        else out += escapeMarkdown(cached);
        break;
      }
      case 'anchor':
        break;
      case 'form_field':
        note(
          ctx,
          'warning',
          'form_field_omitted',
          'form fields are not written in Markdown',
          blockId,
        );
        break;
      case 'extension_inline':
        note(
          ctx,
          'warning',
          'extension_omitted',
          'host extensions are not written in Markdown',
          blockId,
        );
        break;
      case 'preserved_inline':
        note(
          ctx,
          'warning',
          'preserved_omitted',
          'Word content the model does not represent is not written in Markdown',
          blockId,
        );
        break;
      default:
        note(
          ctx,
          'warning',
          'unknown_inline_omitted',
          `an inline node of type "${n.type}" is not written in Markdown`,
          blockId,
        );
    }
  }
  return out;
}

function layoutNote(
  ctx: Ctx,
  attrs: Record<string, unknown> | undefined,
  blockId: string | null,
): void {
  const align = str(attrs?.['align']);
  if (align !== null && align !== 'start')
    note(
      ctx,
      'warning',
      'alignment_omitted',
      'paragraph alignment is not written in Markdown; the text is left-aligned',
      blockId,
    );
  const layout = [
    'indentLeft',
    'indentRight',
    'indentFirstLine',
    'spaceBefore',
    'spaceAfter',
    'lineSpacing',
  ].some((k) => {
    const v = attrs?.[k];
    return typeof v === 'number' && v !== 0;
  });
  if (
    layout ||
    attrs?.['borders'] ||
    attrs?.['shading'] ||
    attrs?.['pageBreakBefore'] ||
    attrs?.['tabs']
  )
    note(
      ctx,
      'warning',
      'paragraph_layout_omitted',
      'spacing, indents, borders, shading, tab stops and page breaks of paragraphs are not written in Markdown',
      blockId,
    );
}

function paragraphText(ctx: Ctx, p: J, blockId: string | null, inCell: boolean): string {
  let s = inline(ctx, p.content, blockId, inCell);
  while (s.endsWith('\\\n')) s = s.slice(0, -2);
  return s;
}

function fenced(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}latex\n${s}\n${fence}`;
}

function paragraphBlocks(ctx: Ctx, p: J, inCell: boolean): string[] {
  const vis = visibility(ctx, p.marks, str(p.attrs?.['id']));
  if (vis === 'hide') return [];
  const id = str(p.attrs?.['id']);
  if (vis === 'ins' || vis === 'del')
    note(
      ctx,
      'info',
      'block_suggestion_plain',
      'a suggested paragraph is written without a mark (no Markdown mark exists for it)',
      id,
    );
  layoutNote(ctx, p.attrs, id);
  const body = paragraphText(ctx, p, id, inCell);
  const label = id !== null && !inCell ? ctx.labels.lists.get(id) : undefined;
  const level = inCell ? null : outlineLevelOf(ctx.table, p.attrs);
  if (body === '' && label === undefined) return [];
  const numbered = label !== undefined && label.kind !== 'none';
  const prefix = numbered && label.kind === 'number' ? `${escapeMarkdown(label.text)} ` : '';
  if (level !== null && level !== undefined) {
    const depth = level + 1;
    if (depth > 6)
      note(
        ctx,
        'warning',
        'heading_level_clamped',
        'headings below level 6 are written as level 6',
        id,
      );
    return [`${'#'.repeat(Math.min(6, depth))} ${prefix}${body}`];
  }
  if (numbered && label.kind === 'bullet') {
    note(ctx, 'info', 'bullet_replaced', 'bullet characters are written as "-"', id);
    return [`${'  '.repeat(label.level)}- ${body}`];
  }
  return [`${prefix}${body}`];
}

function cellText(ctx: Ctx, cell: J): string {
  const parts: string[] = [];
  for (const c of cell.content ?? []) {
    if (c.type === 'paragraph') {
      const s = paragraphText(ctx, c, str(c.attrs?.['id']), true);
      if (s !== '') parts.push(s);
    } else if (c.type === 'figure') {
      parts.push(
        pictureMd(ctx, str(c.attrs?.['asset']), str(c.attrs?.['alt']) ?? '', str(c.attrs?.['id'])),
      );
    } else if (c.type === 'equation_block') {
      note(
        ctx,
        'warning',
        'equation_as_code',
        'equations are written as LaTeX source in code, not rendered',
        str(c.attrs?.['id']),
      );
      parts.push(codeSpan((str(c.attrs?.['latex']) ?? '').replace(/[\r\n]+/g, ' ')));
    } else
      note(
        ctx,
        'warning',
        'cell_content_omitted',
        `a "${c.type}" in a table cell is not written in Markdown`,
        str(c.attrs?.['id']),
      );
  }
  return parts.join('<br>');
}

function tableBlocks(ctx: Ctx, t: J): string[] {
  const tid = str(t.attrs?.['id']);
  const rows = (t.content ?? []).filter(
    (r) => visibility(ctx, r.marks, str(r.attrs?.['id'])) !== 'hide',
  );
  if (visibility(ctx, t.marks, tid) === 'hide' || rows.length === 0) return [];
  const grid: string[][] = [];
  for (const r of rows) {
    const line: string[] = [];
    for (const cell of r.content ?? []) {
      const colspan = Math.max(1, Number(cell.attrs?.['colspan'] ?? 1));
      if (colspan > 1 || Number(cell.attrs?.['rowspan'] ?? 1) > 1)
        note(
          ctx,
          'warning',
          'merged_cells_flattened',
          'merged cells are written as separate cells in Markdown',
          tid,
        );
      line.push(cellText(ctx, cell));
      for (let k = 1; k < colspan; k++) line.push('');
    }
    grid.push(line);
  }
  const width = Math.max(1, ...grid.map((r) => r.length));
  const pad = (r: string[]): string[] => [
    ...r,
    ...Array.from({ length: width - r.length }, () => ''),
  ];
  const rowText = (r: string[]): string => `| ${pad(r).join(' | ')} |`;
  const header = grid[0] ?? [];
  const out = [rowText(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const r of grid.slice(1)) out.push(rowText(r));
  return [out.join('\n')];
}

function blocksOf(ctx: Ctx, nodes: readonly J[] | undefined): string[] {
  const out: string[] = [];
  for (const n of nodes ?? []) out.push(...block(ctx, n));
  return out;
}

function block(ctx: Ctx, n: J): string[] {
  const id = str(n.attrs?.['id']);
  switch (n.type) {
    case 'region':
      return blocksOf(ctx, n.content);
    case 'section_break':
      return [];
    case 'paragraph':
      return paragraphBlocks(ctx, n, false);
    case 'table':
      return tableBlocks(ctx, n);
    case 'figure': {
      layoutNote(ctx, n.attrs, id);
      const picture = pictureMd(ctx, str(n.attrs?.['asset']), str(n.attrs?.['alt']) ?? '', id);
      const caption = (n.content ?? []).find((c) => c.type === 'caption');
      const captionText = caption ? inline(ctx, caption.content, id, false) : '';
      return [picture, captionText === '' ? '' : wrap(captionText, '*')].filter((s) => s !== '');
    }
    case 'equation_block':
      note(
        ctx,
        'warning',
        'equation_as_code',
        'display equations are written as LaTeX source in a code block, not rendered',
        id,
      );
      return [fenced((str(n.attrs?.['latex']) ?? '').replace(/\n+$/, ''))];
    case 'toc':
      note(
        ctx,
        'warning',
        'toc_omitted',
        'tables of contents and lists of figures are generated; they are not written in Markdown',
        id,
      );
      return [];
    case 'bibliography':
      note(
        ctx,
        'warning',
        'bibliography_omitted',
        'the bibliography is generated; it is not written in Markdown',
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
      return fallback === null || fallback === '' ? [] : [escapeMarkdown(fallback)];
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
        'Word content the model does not represent is not written in Markdown',
        id,
      );
      return [];
    default:
      note(
        ctx,
        'warning',
        'unknown_block_omitted',
        `a block of type "${n.type}" is not written in Markdown`,
        id,
      );
      return [];
  }
}

/** The Markdown text of an envelope (EXP-088). Reads the document and does not change it. */
export function markdownText(
  envelope: CdmEnvelope,
  options: MarkdownOptions = {},
  assets: Readonly<Record<string, unknown>> = {},
): MarkdownOutput {
  const settled: Diagnostic[] = [];
  const doc = settleSuggestions(envelope.doc as unknown as J, options.suggestions ?? null, settled);
  const table = styleTable(doc as unknown as TreeNode);
  const labels = computeLabels(doc as unknown as TreeNode, { table });
  const ctx: Ctx = {
    table,
    labels,
    mode: options.suggestions ?? null,
    assets,
    diagnostics: settled,
    warned: new Set(),
    footnotes: [],
    pictures: new Map(),
  };
  if ((doc.content ?? []).some((c) => c.type === 'story'))
    note(
      ctx,
      'info',
      'stories_omitted',
      'headers, footers and other stories are not written in Markdown',
      null,
    );
  // Page size, margins, columns and orientation have no Markdown form (criterion 3 of EXP-088).
  if (
    (doc.content ?? []).some(
      (c) => c.type === 'defs' && (c.content ?? []).some((d) => d.type === 'page_setup'),
    )
  )
    note(
      ctx,
      'warning',
      'page_setup_omitted',
      'page setups (page size, margins, columns, orientation) are not written in Markdown',
      null,
    );
  const body = (doc.content ?? []).find((c) => c.type === 'body');
  const blocks = blocksOf(ctx, body?.content);
  for (const fn of ctx.footnotes) blocks.push(fn);
  const text = blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
  const bytes = utf8(text);
  return {
    text,
    bytes,
    ok: !ctx.diagnostics.some((d) => d.severity === 'error'),
    diagnostics: ctx.diagnostics,
    assets: [...ctx.pictures].map(([asset, path]) => ({ path, asset })),
  };
}

/** The Markdown target as a writer (09 §11), read the same way as the LaTeX and canonical writers. */
export const markdownWriter: DocumentWriter<MarkdownOptions, MarkdownOutput> = {
  target: 'md',
  async write(input: WriterInput, options: MarkdownOptions) {
    return markdownText(input.document, options, input.assets as Readonly<Record<string, unknown>>);
  },
};
