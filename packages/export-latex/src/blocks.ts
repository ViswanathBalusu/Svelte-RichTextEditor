/**
 * Blocks (03 §4.2, §4.3; 09 §3.1): paragraphs, headings, list items, figures, display equations,
 * tables of contents, the bibliography, placeholders, hidden regions and section breaks. Gaps
 * between blocks are the model's `paragraphGap` (03 §7; ADR 0032 §3): regions and section breaks
 * are transparent, blocks that are not paragraphs have no spacing of their own, and the edges of a
 * container keep the first `spaceBefore` and the last `spaceAfter`.
 */
import { resolveLabelRun, resolveParagraph, type GapSide } from '@docedit/model';
import { assetRef } from './assets.ts';
import { NOCITE_ALL, styleRow } from './bibtex.ts';
import {
  attr,
  diag,
  enumOf,
  idOf,
  num,
  register,
  str,
  warnOnce,
  within,
  line,
  type Ctx,
  type J,
} from './context.ts';
import {
  dimen,
  EMPTY,
  gatedMath,
  generatedId,
  int,
  join,
  lit,
  pdfString,
  placeholderLabel,
  tex,
  text,
  url,
  type Tex,
} from './emit.ts';
import { checkGlyphs } from './fonts/check.ts';
import {
  formatRun,
  inlineTex,
  newInlineState,
  paragraphBody,
  imageBox,
  type InlinePlace,
} from './inline.ts';
import { mathGate } from './math/gate.ts';
import { familyOf, paragraphFormat } from './props.ts';
import { closeLists, endGap, gap, newFlow, type Flow } from './flow.ts';
import { sectionBreak } from './page.ts';
import { marginNote } from './comments.ts';
import { suggestionHides } from './suggestions.ts';
import { table } from './tables.ts';

const t = lit;

/** The published bullet list (cdm1 grammar), through `enumLookup` (EXP-024). */
const BULLETS: Readonly<Record<string, Tex>> = {
  '•': t('•'),
  '◦': t('◦'),
  '▪': t('▪'),
  '■': t('■'),
  '□': t('□'),
  '●': t('●'),
  '○': t('○'),
  '–': t('–'),
  '—': t('—'),
  '➢': t('➢'),
  '✓': t('✓'),
  '♦': t('♦'),
  '◆': t('◆'),
  '*': t('*'),
  '-': t('-'),
};

/** Label alignment codes of the class: 0 start, 1 centre, 2 end. */
const LABEL_ALIGN: Readonly<Record<string, Tex>> = { start: t('0'), center: t('1'), end: t('2') };

function plainText(nodes: readonly J[] | undefined): string {
  let s = '';
  for (const n of nodes ?? []) {
    if (n.type === 'text') {
      if (!(n.marks ?? []).some((m) => m.type === 'hidden' && m.attrs?.['value'] !== false))
        s += n.text ?? '';
    } else if (n.type === 'tab' || n.type === 'break') s += ' ';
  }
  return s;
}

/** An anchor at the start of a block that a `ref` field with a page format points at. */
function blockAnchor(ctx: Ctx, target: string): Tex {
  const a = ctx.anchors.get(`ref:${target}`);
  return a === undefined ? EMPTY : tex`\DEanchor{${generatedId(a)}}`;
}

/** The formatted label of a numbered paragraph (literal text from the model, EXP-024). */
function labelTex(
  ctx: Ctx,
  resolved: ReturnType<typeof paragraphFormat>['resolved'],
  label: { text: string; kind: string },
  st: { blockId: string | null },
): Tex {
  if (label.kind === 'none' || label.text === '') return EMPTY;
  const lr = resolveLabelRun(resolved);
  const fam = familyOf(ctx, lr.fontFamily, st.blockId);
  checkGlyphs(ctx, label.text, fam, lr.bold, lr.italic, st.blockId);
  const body =
    label.kind === 'bullet'
      ? enumOf(ctx, BULLETS, label.text, t('•'), st.blockId, 'a bullet character')
      : text(label.text);
  const fake = {
    off: 0,
    blockId: st.blockId,
    para: resolved,
    explicit: new Set<number>(),
    place: 'body' as InlinePlace,
    deferred: [],
    holder: null,
  };
  return formatRun(ctx, lr, resolved.run, fake, body);
}

function labelAlign(
  ctx: Ctx,
  resolved: ReturnType<typeof paragraphFormat>['resolved'],
  blockId: string | null,
): Tex {
  return enumOf(
    ctx,
    LABEL_ALIGN,
    str(resolved.level?.['align']) ?? 'start',
    t('0'),
    blockId,
    'a label alignment',
  );
}

/** Inserts the marks that `styleRef` fields in headers and footers read (EXP-019). */
function styleMark(ctx: Ctx, styleId: string, content: readonly J[] | undefined): Tex {
  const k = ctx.markedStyles.get(styleId);
  if (k === undefined) return EMPTY;
  return tex`\DEmark{${int(k)}}{${pdfString(plainText(content))}}`;
}

function captionEntries(
  ctx: Ctx,
  holder: string | null,
  content: readonly J[] | undefined,
  n: number,
): Tex {
  if (!holder) return EMPTY;
  const names = ctx.captionHolders.get(holder) ?? [];
  const parts: Tex[] = [];
  for (const name of names) {
    const k = ctx.captionLists.get(name);
    if (k !== undefined)
      parts.push(tex`\DEcaption{${int(k)}}{${int(n)}}{${pdfString(plainText(content))}}`);
  }
  return join(parts);
}

export function paragraph(ctx: Ctx, flow: Flow, p: J): void {
  if (suggestionHides(ctx, p.marks)) return;
  const id = idOf(p);
  const f = paragraphFormat(ctx, p.attrs, flow.tableStyle, id);
  const r = f.resolved;
  const label = id ? ctx.labels.lists.get(id) : undefined;
  const heading = r.outlineLevel !== null && flow.place === 'body';
  const isList = label !== undefined && !heading;
  const place: InlinePlace = flow.place === 'body' ? (heading ? 'heading' : 'body') : flow.place;
  const kind =
    flow.place === 'cell'
      ? 'cellParagraph'
      : flow.place === 'story'
        ? 'storyParagraph'
        : heading
          ? 'heading'
          : isList
            ? 'listItem'
            : 'paragraph';
  const n = register(ctx, id, kind, flow.owner);
  const p0 = r.properties;
  const side: GapSide = {
    styleId: r.styleId,
    spaceBefore: p0.spaceBefore,
    spaceAfter: p0.spaceAfter,
    contextualSpacing: p0.contextualSpacing,
  };

  if (!isList) closeLists(ctx, flow, () => false);
  else closeLists(ctx, flow, (fr) => fr.listId === label.listId && fr.level <= label.level);

  within(ctx, n, () => {
    if (p0.pageBreakBefore && flow.place === 'body') {
      line(ctx, t('\\DEpb'));
      flow.prev = null;
      flow.pageTop = true;
    }
    const lead = gap(ctx, flow, side, !isList && !heading);
    const st = newInlineState(ctx, p.content, {
      blockId: id,
      para: r,
      place,
      holder: id,
      blockMarks: p.marks ?? [],
    });
    const body = paragraphBody(ctx, p.content, st);
    const anchor = id ? blockAnchor(ctx, `node:${id}`) : EMPTY;
    const mark = styleMark(ctx, r.styleId, p.content);
    const caption = captionEntries(ctx, id, p.content, n);
    // A note in the margin stands beside the paragraph's first line (EXP-084); a heading's own
    // argument is moved into the table of contents and the bookmarks, so its note follows it.
    const note = heading || flow.place !== 'body' ? EMPTY : marginNote(ctx, id);
    const pre = join([anchor, mark, caption, note]);
    if (heading) {
      const lvl = Math.min(9, Math.max(1, r.outlineLevel!));
      const lab = label ? labelTex(ctx, r, label, st) : EMPTY;
      const plain = (label && label.kind !== 'none' ? `${label.text} ` : '') + plainText(p.content);
      line(
        ctx,
        tex`\DEh{${int(n)}}{${int(lvl)}}{${f.tex}}{${pdfString(plain)}}{${lab}}{${label ? labelAlign(ctx, r, id) : t('0')}}{${pre}%`,
      );
      for (const b of body) line(ctx, tex`${b}%`);
      line(ctx, t('}'));
      for (const d of st.deferred) line(ctx, d);
      const headingNote = flow.place === 'body' ? marginNote(ctx, id) : EMPTY;
      if (headingNote !== EMPTY) line(ctx, headingNote);
    } else if (isList) {
      const top = flow.lists[flow.lists.length - 1];
      const margin = p0.indentLeft;
      if (!top || top.listId !== label.listId || top.level < label.level) {
        const rel = top ? margin - top.margin : margin;
        line(ctx, tex`\begin{DElist}{${dimen(rel)}}`);
        flow.lists.push({ listId: label.listId, level: label.level, margin });
      }
      line(
        ctx,
        tex`\DEli{${int(n)}}{${f.tex}}{${labelTex(ctx, r, label, st)}}{${labelAlign(ctx, r, id)}}{${pre}%`,
      );
      for (const b of body) line(ctx, tex`${b}%`);
      line(ctx, t('}'));
    } else {
      const macro =
        flow.place === 'cell' ? t('\\DEcp') : flow.place === 'story' ? t('\\DEsp') : t('\\DEp');
      if (lead > 0)
        line(ctx, tex`\DEcpg{${int(n)}}{${dimen(lead, { min: 0, max: 31680 })}}{${f.tex}}{${pre}%`);
      else line(ctx, tex`${macro}{${int(n)}}{${f.tex}}{${pre}%`);
      for (const b of body) line(ctx, tex`${b}%`);
      line(ctx, t('}'));
    }
  });
  flow.prev = side;
  if (p0.keepNext) flow.keepNext = true;
}

function equationBlock(ctx: Ctx, flow: Flow, eq: J): void {
  closeLists(ctx, flow, () => false);
  const id = idOf(eq);
  const n = register(ctx, id, 'equation', flow.owner);
  within(ctx, n, () => {
    gap(ctx, flow, null);
    const latex = str(attr(eq, 'latex')) ?? '';
    const gate = mathGate(latex, true);
    const label = str(attr(eq, 'label'));
    const anchor = label ? blockAnchor(ctx, `eq:${label}`) : EMPTY;
    const number = id ? ctx.labels.equations.get(id) : undefined;
    const tag = number !== undefined ? text(number) : EMPTY;
    if (gate.ok) line(ctx, tex`\DEeq{${int(n)}}{${anchor}}{${tag}}{${gatedMath(latex, true)}}`);
    else {
      diag(
        ctx,
        'warning',
        'math_refused',
        id,
        `an equation was replaced by a placeholder: ${gate.reason}`,
      );
      line(ctx, tex`\DEplaceholder{${int(n)}}{${pdfString('[equation]')}}`);
    }
  });
  flow.prev = null;
}

function placeholder(ctx: Ctx, flow: Flow, id: string | null, kind: string, label: string): void {
  closeLists(ctx, flow, () => false);
  const n = register(ctx, id, kind, flow.owner);
  within(ctx, n, () => {
    gap(ctx, flow, null);
    line(ctx, tex`\DEplaceholder{${int(n)}}{${pdfString(label)}}`);
  });
  flow.prev = null;
}

function figure(ctx: Ctx, flow: Flow, node: J): void {
  closeLists(ctx, flow, () => false);
  const id = idOf(node);
  const n = register(ctx, id, 'figure', flow.owner);
  const alt = str(attr(node, 'alt'));
  const file = assetRef(ctx, attr(node, 'asset'), id);
  const w = num(attr(node, 'width'));
  const h = num(attr(node, 'height'));
  const align = enumOf(
    ctx,
    LABEL_ALIGN,
    str(attr(node, 'align')) ?? 'start',
    t('0'),
    id,
    'a figure alignment',
  );
  const float = str(attr(node, 'placement')) === 'float' && flow.place === 'body';
  const caption = (node.content ?? []).find((c) => c.type === 'caption');
  within(ctx, n, () => {
    gap(ctx, flow, null);
    const picture =
      file && w !== null && h !== null
        ? imageBox(ctx, file, w, h, alt ?? '')
        : tex`\DEph{${pdfString(placeholderLabel(alt ? `[figure: ${alt}]` : '[figure]'))}}`;
    let captionTex: Tex = EMPTY;
    if (caption) {
      const styleId = ctx.table.styles.has('Caption') ? 'Caption' : null;
      const f = paragraphFormat(ctx, { style: styleId }, null, id);
      const st = newInlineState(ctx, caption.content, {
        blockId: id,
        para: f.resolved,
        place: 'caption',
        holder: id,
      });
      const body = paragraphBody(ctx, caption.content, st);
      captionTex = tex`\DEcap{${f.tex}}{${captionEntries(ctx, id, caption.content, n)}${join(body, t('%\n'))}}`;
    }
    const anchor = id ? blockAnchor(ctx, `node:${id}`) : EMPTY;
    line(ctx, tex`\DEfig{${int(n)}}{${float ? t('1') : t('0')}}{${align}}{${anchor}${picture}}{%`);
    line(ctx, tex`${captionTex}}`);
  });
  flow.prev = null;
}

function toc(ctx: Ctx, flow: Flow, node: J): void {
  closeLists(ctx, flow, () => false);
  const id = idOf(node);
  const n = register(ctx, id, 'toc', flow.owner);
  const of = str(attr(node, 'of')) ?? 'headings';
  within(ctx, n, () => {
    gap(ctx, flow, null);
    if (of === 'headings') {
      const min = Math.min(9, Math.max(1, num(attr(node, 'minLevel')) ?? 1));
      const max = Math.min(9, Math.max(min, num(attr(node, 'maxLevel')) ?? 3));
      line(ctx, tex`\DEtoc{${int(n)}}{${int(min)}}{${int(max)}}`);
    } else {
      const k = ctx.captionLists.get(of);
      if (k === undefined) line(ctx, tex`\DEplaceholder{${int(n)}}{${pdfString('[list]')}}`);
      else line(ctx, tex`\DElistof{${int(n)}}{${int(k)}}`);
    }
  });
  flow.prev = null;
}

function bibliography(ctx: Ctx, flow: Flow, node: J): void {
  closeLists(ctx, flow, () => false);
  const id = idOf(node);
  const n = register(ctx, id, 'bibliography', flow.owner);
  within(ctx, n, () => {
    gap(ctx, flow, null);
    if (ctx.citations.entries.length === 0) {
      diag(ctx, 'info', 'bibliography_empty', id, 'the bibliography has no entries');
      return;
    }
    const style = ctx.table.styles.has('Bibliography') ? 'Bibliography' : null;
    const f = paragraphFormat(ctx, { style, indentLeft: 720, indentFirstLine: -720 }, null, id);
    const bib = ctx.citations.biblatex;
    if (bib) {
      // The biblatex route (EXP-121): each entry is a paragraph of the class (`\DEbibentry`), so the
      // block keeps its number and its format; biber orders the entries and the style prints them.
      const label = styleRow(bib.style).label;
      const mark =
        label === 'number'
          ? lit('[\\printfield{labelnumber}]\\addspace ')
          : label === 'alpha'
            ? lit('[\\printfield{labelalpha}\\printfield{extraalpha}]\\addspace ')
            : EMPTY;
      // biblatex prints the entry after the item code, so the paragraph of `\DEbibentry` cannot wrap
      // it; the environment sets what `\DE@par` sets (the block, the format) once for all entries,
      // and each item starts a paragraph in the class's way.
      // \par cannot be read into the short arguments of \defbibenvironment, so a copy of it is used.
      line(ctx, lit('\\makeatletter\\let\\DEbibpar\\par'));
      line(
        ctx,
        tex`\defbibenvironment{DEbib}{\DEbibpar\begingroup\DE@attr@block=${int(n)}\relax\DE@attr@area=1\relax\DE@defaults ${f.tex}\DE@apply}{\DEbibpar\endgroup}{\DEbibpar\prevdepth=-1000pt\relax\indent ${mark}}`,
      );
      line(ctx, lit('\\makeatother'));
      if (bib.include === 'all') line(ctx, NOCITE_ALL);
      line(ctx, lit('\\printbibliography[heading=none,env=DEbib]'));
      return;
    }
    for (const e of ctx.citations.entries) {
      const parts = e.parts.map((p) => {
        let body = text(p.text);
        if (p.italic) body = tex`\DEital{${body}}`;
        if (p.url) {
          const u = url(p.url);
          if (u.kind === 'external') body = tex`\DEhref{${u.tex}}{}{${body}}`;
        }
        return body;
      });
      line(ctx, tex`\DEbibentry{${int(n)}}{${f.tex}}{${join(parts)}}`);
    }
  });
  flow.prev = null;
}

function hiddenRegion(ctx: Ctx, flow: Flow, node: J): void {
  closeLists(ctx, flow, () => false);
  const id = idOf(node);
  if (id) ctx.redactions.push({ kind: 'region', id });
  const n = register(ctx, id, 'hiddenRegion', flow.owner);
  const title = str(attr(node, 'title'));
  const notice = ctx.options.notices?.hiddenRegion ?? '[This part of the document is not shown]';
  within(ctx, n, () => {
    gap(ctx, flow, null);
    line(ctx, tex`\DEhidden{${int(n)}}{${pdfString(title ? `${notice} ${title}` : notice)}}`);
  });
  flow.prev = null;
}

/** One block of a body, a cell or a story. */
export function block(ctx: Ctx, flow: Flow, node: J): void {
  switch (node.type) {
    case 'paragraph':
      paragraph(ctx, flow, node);
      return;
    case 'table':
      if (suggestionHides(ctx, node.marks)) return;
      closeLists(ctx, flow, () => false);
      table(ctx, flow, node, (f, nodes) => flowBlocks(ctx, f, nodes));
      return;
    case 'equation_block':
      equationBlock(ctx, flow, node);
      return;
    case 'region':
      // Regions are not visible in output (09 §3.1); their blocks flow on.
      for (const child of node.content ?? []) block(ctx, flow, child);
      return;
    case 'hidden_region':
      hiddenRegion(ctx, flow, node);
      return;
    case 'section_break':
      closeLists(ctx, flow, () => false);
      sectionBreak(ctx, flow, node);
      return;
    case 'toc':
      toc(ctx, flow, node);
      return;
    case 'figure':
      figure(ctx, flow, node);
      return;
    case 'bibliography':
      bibliography(ctx, flow, node);
      return;
    case 'extension_block':
    case 'preserved_block': {
      const fb = str(attr(node, 'fallbackText'));
      const asset = attr(node, 'fallbackAsset');
      const w = num(attr(node, 'width'));
      const h = num(attr(node, 'height'));
      if (
        asset &&
        w !== null &&
        h !== null &&
        ctx.assets &&
        typeof asset === 'string' &&
        Object.hasOwn(ctx.assets, asset)
      ) {
        closeLists(ctx, flow, () => false);
        const id = idOf(node);
        const n = register(
          ctx,
          id,
          node.type === 'extension_block' ? 'extension' : 'preserved',
          flow.owner,
        );
        const file = assetRef(ctx, asset, id);
        within(ctx, n, () => {
          gap(ctx, flow, null);
          const picture = file
            ? imageBox(ctx, file, w, h, fb ?? '')
            : tex`\DEph{${pdfString(placeholderLabel(fb ?? '[content]'))}}`;
          line(ctx, tex`\DEfig{${int(n)}}{0}{0}{${picture}}{}`);
        });
        flow.prev = null;
        return;
      }
      // A fallback asset the job does not list is reported with the block (EXP-035 criterion 4).
      if (asset && (typeof asset !== 'string' || !ctx.assets || !Object.hasOwn(ctx.assets, asset)))
        diag(
          ctx,
          'warning',
          'fallback_asset_missing',
          idOf(node),
          'an extension or preserved block names a fallback asset this job does not list; its fallback text is printed',
        );
      const label =
        fb ??
        `[${str(attr(node, 'label')) ?? (node.type === 'extension_block' ? 'extension' : 'preserved content')}]`;
      placeholder(
        ctx,
        flow,
        idOf(node),
        node.type === 'extension_block' ? 'extension' : 'preserved',
        label,
      );
      return;
    }
    default:
      warnOnce(ctx, 'block_unsupported', `a ${node.type} block prints a placeholder`, idOf(node));
      placeholder(ctx, flow, idOf(node), 'unsupported', `[${node.type}]`);
  }
}

/** The content of a cell or a story: its blocks, then the trailing gap. */
export function flowBlocks(ctx: Ctx, flow: Flow, nodes: readonly J[] | undefined): void {
  for (const b of nodes ?? []) block(ctx, flow, b);
  endGap(ctx, flow);
}

export { inlineTex, resolveParagraph, newFlow, closeLists };
