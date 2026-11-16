/**
 * Inline content (03 §4.4, §5; 09 §3.1): text runs with their formatting, and the atoms. Offsets
 * count UTF-16 code units of the block's text, each atom one, anchors none (09 §7.1); every run
 * restarts the class's counter with `\DEr{offset}`, so offsets stay exact.
 */
import {
  dateFieldText,
  referenceText,
  valueText,
  type ResolvedParagraph,
  type RunProperties,
} from '@docedit/model';
import { assetRef } from './assets.ts';
import { heightForWidth, imagePixelSize } from './signature-picture.ts';
import {
  attr,
  colourOf,
  diag,
  enumOf,
  idOf,
  num,
  register,
  str,
  warnOnce,
  within,
  type Ctx,
  type J,
  type Mark,
} from './context.ts';
import {
  dimen,
  EMPTY,
  enumLookup,
  gatedMath,
  generatedId,
  int,
  join,
  kvValue,
  lit,
  pdfHexString,
  pdfString,
  tex,
  text,
  textChunks,
  url,
  type Tex,
} from './emit.ts';
import { checkGlyphs } from './fonts/check.ts';
import { languageRef } from './languages.ts';
import { mathGate } from './math/gate.ts';
import { familyOf, naturalHeight, paragraphFormat, runProps, shapeOf } from './props.ts';
import { explicitSpaces, endsWithSpace } from './spaces.ts';
import { markupRun, suggestionHides } from './suggestions.ts';

const t = lit;

/** Highlight names to the colours the class defines (docedit.cls, `DEhl...`). */
const HIGHLIGHT: Readonly<Record<string, Tex>> = {
  yellow: t('DEhlyellow'),
  green: t('DEhlgreen'),
  cyan: t('DEhlcyan'),
  magenta: t('DEhlmagenta'),
  blue: t('DEhlblue'),
  red: t('DEhlred'),
  darkBlue: t('DEhldarkBlue'),
  darkCyan: t('DEhldarkCyan'),
  darkGreen: t('DEhldarkGreen'),
  darkMagenta: t('DEhldarkMagenta'),
  darkRed: t('DEhldarkRed'),
  darkYellow: t('DEhldarkYellow'),
  darkGray: t('DEhldarkGray'),
  lightGray: t('DEhllightGray'),
  black: t('DEhlblack'),
  white: t('DEhlwhite'),
};

/** Underline styles to class macros (lua-ul). */
const UNDERLINE: Readonly<Record<string, Tex>> = {
  single: t('\\DEul'),
  double: t('\\DEuld'),
  dotted: t('\\DEulo'),
};

/** Where inline content is set: it decides how footnotes and tagged spans are written. */
export type InlinePlace = 'body' | 'heading' | 'cell' | 'footnote' | 'story' | 'caption';

export interface InlineState {
  off: number;
  readonly blockId: string | null;
  readonly para: ResolvedParagraph;
  readonly explicit: ReadonlySet<number>;
  readonly place: InlinePlace;
  /** Footnote texts that must follow the block (headings: 09 §3.1, moving arguments). */
  readonly deferred: Tex[];
  /** The block whose `seq` labels this content consumes (the paragraph or the figure). */
  readonly holder: string | null;
  /**
   * Suggestion marks of the paragraph that holds this content (EXP-083 criterion 3): in markup
   * mode every text run of a marked paragraph is marked as the paragraph is.
   */
  readonly blockMarks?: readonly Mark[];
}

export function newInlineState(
  ctx: Ctx,
  content: readonly J[] | undefined,
  init: Omit<InlineState, 'off' | 'explicit' | 'deferred'>,
): InlineState {
  return {
    off: 0,
    explicit: explicitSpaces(content, (n) => skippedText(ctx, n)),
    deferred: [],
    ...init,
  };
}

/** Text that is in the document but not printed: hidden runs and rejected suggestions. */
function skippedText(ctx: Ctx, n: J): boolean {
  if (suggestionHides(ctx, n.marks)) return true;
  return (n.marks ?? []).some((m) => m.type === 'hidden' && m.attrs?.['value'] !== false);
}

function sameFont(a: RunProperties, b: RunProperties): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.smallCaps === b.smallCaps
  );
}

/** Wraps formatted content in the macros of its run properties (EXP-025). */
export function formatRun(
  ctx: Ctx,
  rp: RunProperties,
  para: RunProperties,
  st: InlineState,
  body: Tex,
): Tex {
  let out = body;
  if (!sameFont(rp, para)) {
    const fam = familyOf(ctx, rp.fontFamily, st.blockId);
    const h = naturalHeight(fam, rp.fontSize);
    out = tex`{\DEfont{${int(fam.n)}}{${dimen(rp.fontSize, { min: 20, max: 32760 })}}{${rp.bold ? t('b') : t('m')}}{${shapeOf(rp)}}{${int(h.height)}}{${int(h.descent)}}${out}}`;
  }
  if (rp.color !== para.color) {
    const c = colourOf(ctx, rp.color, st.blockId);
    out = c ? tex`\DEc{${c}}{${out}}` : tex`\DEc{000000}{${out}}`;
  }
  if (rp.allCaps) out = tex`\DEuc{${out}}`;
  if (rp.vertAlign === 'super') out = tex`\DEsup{${out}}`;
  else if (rp.vertAlign === 'sub') out = tex`\DEsub{${out}}`;
  if (rp.highlight) {
    const h = enumOf(
      ctx,
      HIGHLIGHT,
      rp.highlight,
      t('DEhlyellow'),
      st.blockId,
      'a highlight colour',
    );
    out = tex`\DEhl{${h}}{${out}}`;
  }
  if (rp.strike) out = tex`\DEst{${out}}`;
  if (rp.underline !== 'none') {
    const u = enumOf(ctx, UNDERLINE, rp.underline, t('\\DEul'), st.blockId, 'an underline style');
    out = tex`${u}{${out}}`;
  }
  if (rp.lang !== para.lang && rp.lang !== null) {
    const k = languageRef(ctx, rp.lang, st.blockId);
    if (k !== null)
      out =
        st.place === 'story' ? tex`\DElangx{${int(k)}}{${out}}` : tex`\DElang{${int(k)}}{${out}}`;
  }
  return out;
}

function linkWrap(ctx: Ctx, marks: readonly Mark[] | undefined, st: InlineState, body: Tex): Tex {
  const link = marks?.find((m) => m.type === 'link');
  const href = str(link?.attrs?.['href']);
  if (!href) return body;
  const u = url(href);
  const title = str(link?.attrs?.['title']);
  const contents = title ? pdfHexString(title) : EMPTY;
  if (u.kind === 'external') return tex`\DEhref{${u.tex}}{${contents}}{${body}}`;
  if (u.kind === 'internal') {
    const a = ctx.anchors.get(u.name);
    if (a !== undefined) return tex`\DElink{${generatedId(a)}}{${contents}}{${body}}`;
    diag(
      ctx,
      'warning',
      'link_target_missing',
      st.blockId,
      'an in-document link has no anchor; it is printed as text',
    );
    return body;
  }
  diag(ctx, 'warning', 'link_refused', st.blockId, `a link was printed as plain text: ${u.reason}`);
  return body;
}

function runTex(ctx: Ctx, node: J, st: InlineState): Tex | null {
  const value = node.text ?? '';
  const start = st.off;
  st.off += value.length;
  if (skippedText(ctx, node)) {
    if ((node.marks ?? []).some((m) => m.type === 'hidden' && m.attrs?.['value'] !== false))
      warnOnce(ctx, 'hidden_text', 'hidden text is left out of the PDF');
    return null;
  }
  const rp = runProps(ctx, st.para, node.marks, st.blockId);
  if (rp.hidden) {
    warnOnce(ctx, 'hidden_text', 'hidden text is left out of the PDF');
    return null;
  }
  // The document's own text is checked by the preflight (preflight.ts), which the converter runs.
  const local = new Set<number>();
  for (let i = 0; i < value.length; i++) if (st.explicit.has(start + i)) local.add(i);
  const body = join(
    textChunks(value, { explicit: local }).map(
      (c) => tex`\DEr{${int(start + c.offset)}}{${c.tex}}`,
    ),
  );
  return linkWrap(
    ctx,
    node.marks,
    st,
    markupRun(ctx, runMarks(node.marks, st.blockMarks), formatRun(ctx, rp, st.para.run, st, body)),
  );
}

/**
 * The marks of a text run plus those of its paragraph (EXP-083 criterion 3). A paragraph mark is
 * added only when the run has no mark of that type, so a run's own insertion is not underlined twice.
 */
function runMarks(
  own: readonly Mark[] | undefined,
  block: readonly Mark[] | undefined,
): readonly Mark[] | undefined {
  if (!block || block.length === 0) return own;
  const kept = (own ?? []).map((m) => m.type);
  const extra = block.filter(
    (m) => (m.type === 'ins' || m.type === 'del') && !kept.includes(m.type),
  );
  return extra.length === 0 ? own : [...(own ?? []), ...extra];
}

function atom(st: InlineState, body: Tex): Tex {
  const out = tex`\DEa{${int(st.off)}}{${body}}`;
  st.off += 1;
  return out;
}

/** A visible placeholder for content the converter cannot set, one offset unit. */
function placeholderAtom(st: InlineState, label: string): Tex {
  return atom(st, tex`\DEph{${pdfString(label)}}`);
}

export function inlineTex(ctx: Ctx, nodes: readonly J[] | undefined, st: InlineState): Tex[] {
  const out: Tex[] = [];
  for (const n of nodes ?? []) {
    if (n.type !== 'text' && n.type !== 'anchor' && suggestionHides(ctx, n.marks)) {
      st.off += 1;
      continue;
    }
    switch (n.type) {
      case 'text': {
        const r = runTex(ctx, n, st);
        if (r) out.push(r);
        break;
      }
      case 'break': {
        const kind = str(attr(n, 'kind')) ?? 'line';
        if (kind === 'page') out.push(atom(st, t('\\DEbrpage')));
        else if (kind === 'column') out.push(atom(st, t('\\DEbrcol')));
        else out.push(atom(st, t('\\DEbr')));
        break;
      }
      case 'tab':
        out.push(atom(st, t('\\DEtab')));
        break;
      case 'equation': {
        const latex = str(attr(n, 'latex')) ?? '';
        const gate = mathGate(latex, false);
        if (gate.ok) out.push(atom(st, tex`\DEmath{${gatedMath(latex, true)}}`));
        else {
          diag(
            ctx,
            'warning',
            'math_refused',
            st.blockId,
            `an equation was replaced by a placeholder: ${gate.reason}`,
          );
          out.push(placeholderAtom(st, '[equation]'));
        }
        break;
      }
      case 'footnote':
        out.push(footnote(ctx, n, st));
        break;
      case 'field':
        out.push(atom(st, fieldTex(ctx, n, st)));
        break;
      case 'citation': {
        const value = ctx.citations.byNode.get(n) ?? '[?]';
        const fam = familyOf(ctx, st.para.run.fontFamily, st.blockId);
        checkGlyphs(ctx, value, fam, st.para.run.bold, st.para.run.italic, st.blockId);
        out.push(atom(st, text(value)));
        break;
      }
      case 'anchor': {
        const name = str(attr(n, 'name'));
        const a = name ? ctx.anchors.get(name) : undefined;
        if (a !== undefined) out.push(tex`\DEanchor{${generatedId(a)}}`);
        break;
      }
      case 'image':
        out.push(atom(st, imageTex(ctx, n, st)));
        break;
      case 'form_field':
        out.push(atom(st, formFieldTex(ctx, n, st)));
        break;
      case 'extension_inline':
      case 'preserved_inline': {
        const fb = str(attr(n, 'fallbackText'));
        const asset = attr(n, 'fallbackAsset');
        if (asset && num(attr(n, 'width')) && num(attr(n, 'height'))) {
          const file = assetRef(ctx, asset, st.blockId);
          if (file) {
            out.push(
              atom(
                st,
                imageBox(ctx, file, num(attr(n, 'width'))!, num(attr(n, 'height'))!, fb ?? ''),
              ),
            );
            break;
          }
        }
        out.push(
          atom(
            st,
            fb !== null
              ? text(fb)
              : tex`\DEph{${pdfString(`[${str(attr(n, 'label')) ?? n.type}]`)}}`,
          ),
        );
        break;
      }
      default:
        diag(
          ctx,
          'warning',
          'inline_unsupported',
          st.blockId,
          `a ${n.type} node prints a placeholder`,
        );
        out.push(placeholderAtom(st, `[${n.type}]`));
    }
  }
  return out;
}

/** The paragraph's content, with the space `\par` would remove protected (09 §3.2). */
export function paragraphBody(ctx: Ctx, content: readonly J[] | undefined, st: InlineState): Tex[] {
  const body = inlineTex(ctx, content, st);
  if (endsWithSpace(content, (n) => skippedText(ctx, n))) body.push(t('\\kern0pt'));
  return body;
}

// ---------------------------------------------------------------------------------------------
// Pictures (EXP-028)

function imageBox(ctx: Ctx, file: Tex, width: number, height: number, alt: string): Tex {
  void ctx;
  const w = dimen(width, { min: 1, max: 31680 });
  const h = dimen(height, { min: 1, max: 31680 });
  return tex`\DEimg{${file}}{${w}}{${h}}{${int(Math.max(1, Math.min(31680, height)))}}{${kvValue(alt)}}`;
}

function imageTex(ctx: Ctx, n: J, st: InlineState): Tex {
  const alt = str(attr(n, 'alt'));
  const file = assetRef(ctx, attr(n, 'asset'), st.blockId);
  const width = num(attr(n, 'width'));
  const height = num(attr(n, 'height'));
  if (!file || width === null || height === null)
    return tex`\DEph{${pdfString(alt ? `[image: ${alt}]` : '[image]')}}`;
  return imageBox(ctx, file, width, height, alt ?? '');
}

export { imageBox };

// ---------------------------------------------------------------------------------------------
// Footnotes (EXP-029)

/** The footnote's paragraph and the setters it is set with (FootnoteText unless it names a style). */
function footnoteParts(ctx: Ctx, n: J): { para: J | null; inlines: J[]; blockId: string | null } {
  const content = n.content ?? [];
  const paragraphs = content.filter((c) => c.type === 'paragraph');
  if (paragraphs.length > 1)
    diag(
      ctx,
      'warning',
      'footnote_paragraphs',
      idOf(n),
      'only the first paragraph of a footnote is set (CDM-001)',
    );
  const para = paragraphs[0] ?? null;
  const inlines = para ? (para.content ?? []) : content;
  return { para, inlines, blockId: idOf(para ?? undefined) ?? idOf(n) };
}

function footnoteText(ctx: Ctx, n: J): { fn: number; props: Tex; body: Tex } {
  const { para, inlines, blockId } = footnoteParts(ctx, n);
  const fn = register(ctx, blockId, para ? 'footnoteParagraph' : 'footnote', idOf(n));
  const attrs = { ...(para?.attrs ?? {}) };
  if (attrs['style'] === undefined || attrs['style'] === null)
    if (ctx.table.styles.has('FootnoteText')) attrs['style'] = 'FootnoteText';
  const f = paragraphFormat(ctx, attrs, null, blockId);
  const inner = newInlineState(ctx, inlines, {
    blockId,
    para: f.resolved,
    place: 'footnote',
    holder: blockId,
  });
  const body = within(ctx, fn, () => join(paragraphBody(ctx, inlines, inner), t('%\n')));
  return { fn, props: f.tex, body };
}

function footnote(ctx: Ctx, n: J, st: InlineState): Tex {
  const id = idOf(n);
  const markText = (id ? ctx.labels.footnotes.get(id) : undefined) ?? '';
  const mark = text(markText);
  if (st.place === 'story') {
    // Footnotes in headers and footers get no mark (ADR 0032 §2); their text is not set.
    warnOnce(ctx, 'footnote_in_story', 'a footnote in a header or footer is not set (ADR 0032)');
    st.off += 1;
    return EMPTY;
  }
  const { fn, props, body } = footnoteText(ctx, n);
  const off = st.off;
  st.off += 1;
  // `\footnote` where LaTeX allows it: a paragraph of the body flow (EXP-029 criterion 1).
  if (st.place === 'body') return tex`\DEfn{${int(off)}}{${int(fn)}}{${mark}}{${props}}{${body}}`;
  // Elsewhere the mark and the text are apart: a table cell and a caption set the text right after
  // the mark, and a heading (a moving argument) sets it after the heading.
  const out = tex`\DEfnmark{${int(off)}}{${int(fn)}}{${mark}}`;
  const note = tex`\DEfntext{${int(fn)}}{${mark}}{${props}}{${body}}`;
  if (st.place === 'heading') {
    st.deferred.push(note);
    return out;
  }
  return tex`${out}${note}`;
}

// ---------------------------------------------------------------------------------------------
// Fields (EXP-019)

function nextSeq(ctx: Ctx, holder: string | null): string | null {
  if (!holder) return null;
  const list = ctx.labels.sequences.get(holder);
  if (!list) return null;
  const i = ctx.seqCursor.get(holder) ?? 0;
  ctx.seqCursor.set(holder, i + 1);
  return list[i]?.text ?? null;
}

function fieldTex(ctx: Ctx, n: J, st: InlineState): Tex {
  const kind = str(attr(n, 'kind')) ?? 'page';
  const format = str(attr(n, 'format'));
  const target = str(attr(n, 'target'));
  switch (kind) {
    case 'page':
      return t('\\DEpage');
    case 'pageCount':
      return t('\\DEpages');
    case 'date': {
      const { instant, timeZone } = ctx.options;
      if (instant !== undefined && timeZone !== undefined) {
        try {
          return text(dateFieldText({ instant, timeZone, format }));
        } catch (e) {
          diag(
            ctx,
            'error',
            'date_field_invalid',
            st.blockId,
            `a date field cannot be printed: ${(e as Error).message}`,
          );
          return EMPTY;
        }
      }
      if (ctx.options.date !== undefined) return text(ctx.options.date);
      diag(
        ctx,
        'error',
        'date_without_job_time',
        st.blockId,
        'a date field needs the job instant and time zone (03 §7); it prints nothing',
      );
      return EMPTY;
    }
    case 'title':
      if (ctx.options.title !== undefined) return text(ctx.options.title);
      diag(
        ctx,
        'warning',
        'title_unknown',
        st.blockId,
        'a title field has no document title from the job; it prints nothing',
      );
      return EMPTY;
    case 'seq': {
      const label = nextSeq(ctx, st.holder);
      return label === null ? EMPTY : text(label);
    }
    case 'ref': {
      if (!target) return EMPTY;
      if (format !== null && /page/i.test(format)) {
        const a = ctx.anchors.get(`ref:${target}`);
        if (a !== undefined) return tex`\DEpref{${generatedId(a)}}`;
      }
      const label = referenceText(ctx.labels, target);
      if (label !== null) return text(label);
      if (ctx.projection)
        return tex`\DEph{${pdfString(ctx.options.notices?.redactedValue ?? '[hidden]')}}`;
      diag(
        ctx,
        'warning',
        'ref_unresolved',
        st.blockId,
        'a reference field has a target without a label; it prints nothing',
      );
      return EMPTY;
    }
    case 'styleRef': {
      const style = target?.startsWith('style:') ? target.slice('style:'.length) : null;
      const k = style ? ctx.markedStyles.get(style) : undefined;
      if (k !== undefined && st.place === 'story') return tex`\DEsref{${int(k)}}`;
      diag(
        ctx,
        'warning',
        'field_not_computed',
        st.blockId,
        'a styleRef field outside a header or footer prints its cached text',
      );
      return text(str(attr(n, 'cached')) ?? '');
    }
    case 'formValue': {
      const key = target?.startsWith('field:') ? target.slice('field:'.length) : null;
      const f = key ? ctx.formFields.get(key) : undefined;
      if (!f) return EMPTY;
      if (ctx.options.fields === 'blank') return EMPTY;
      const v = f.attrs?.['value'];
      if (isRedacted(v)) return EMPTY;
      if (str(f.attrs?.['kind']) === 'checkbox')
        return v === null || v === undefined || v === '' ? EMPTY : text(checkboxGlyph(v));
      const r = valueText({
        kind: str(f.attrs?.['kind']) ?? 'text',
        value: (v ?? null) as never,
        options: f.attrs?.['options'] as never,
      });
      return r.computed ? text(r.text) : EMPTY;
    }
    default:
      diag(
        ctx,
        'warning',
        'field_not_computed',
        st.blockId,
        `a ${kind} field prints its cached text`,
      );
      return text(str(attr(n, 'cached')) ?? '');
  }
}

// ---------------------------------------------------------------------------------------------
// Form fields (EXP-033; 12 §12)

export function isRedacted(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)['redacted'] === true
  );
}

/** A number value with the field's format: decimals, prefix and suffix (12 §3.2). */
function formatNumber(value: string, format: Record<string, unknown> | null): string {
  const decimals = num(format?.['decimals']);
  let s = value;
  if (decimals !== null && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    const neg = value.startsWith('-');
    const [whole = '0', frac = ''] = (neg ? value.slice(1) : value).split('.');
    // Round half up in decimal, without floating point.
    let digits = (whole + frac.padEnd(decimals + 1, '0')).slice(0, whole.length + decimals + 1);
    const roundUp = Number(digits[digits.length - 1]) >= 5;
    digits = digits.slice(0, -1);
    if (roundUp) {
      const arr = digits.split('').map(Number);
      let k = arr.length - 1;
      while (k >= 0) {
        if (arr[k]! < 9) {
          arr[k]! += 1;
          break;
        }
        arr[k] = 0;
        k--;
      }
      digits = (k < 0 ? '1' : '') + arr.join('');
    }
    const w = digits.slice(0, digits.length - decimals) || '0';
    const f = digits.slice(digits.length - decimals);
    s = `${neg ? '-' : ''}${w}${decimals > 0 ? `.${f}` : ''}`;
  }
  return `${str(format?.['prefix']) ?? ''}${s}${str(format?.['suffix']) ?? ''}`;
}

/**
 * The glyph a checkbox prints (EXP-033 criterion 2). The value selects an entry of this fixed table;
 * the value itself is never written.
 */
const CHECKBOX_GLYPHS: Readonly<Record<string, Tex>> = { true: t('☒'), false: t('☐') };

/** The glyph of a checkbox value, selected through `enumLookup` (EXP-033 criterion 2). */
function checkboxGlyph(v: unknown): string {
  return enumLookup(CHECKBOX_GLYPHS, v === true ? 'true' : 'false', CHECKBOX_GLYPHS['false']!).tex;
}

function formFieldValue(ctx: Ctx, n: J): string {
  const kind = str(attr(n, 'kind')) ?? 'text';
  const v = attr(n, 'value');
  if (v === null || v === undefined) return '';
  // An empty checkbox value prints nothing, as valueText does (12 §3.2).
  if (kind === 'checkbox') return v === '' ? '' : checkboxGlyph(v);
  const format = (attr(n, 'format') as Record<string, unknown> | null | undefined) ?? null;
  if (kind === 'number' && typeof v === 'string') return formatNumber(v, format);
  if (kind === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const pattern = str(format?.['datePattern']);
    if (pattern) {
      try {
        return dateFieldText({ instant: `${v}T12:00:00.000Z`, timeZone: 'UTC', format: pattern });
      } catch {
        return v;
      }
    }
    return v;
  }
  const r = valueText({ kind, value: v as never, options: attr(n, 'options') as never });
  if (!r.computed) {
    diag(
      ctx,
      'warning',
      'form_value_not_printed',
      idOf(n),
      `a ${kind} field value is not printed: ${r.reason}`,
    );
    return '';
  }
  return r.text;
}

/**
 * The picture of a signature or initials value `{ asset, mode }` (EXP-034 criterion 1): the asset drawn at
 * the field's width, its height from the image's proportions (PNG or JPEG). `mode` does not change the picture (its meaning is
 * not in the spec). Null when the value names no asset, the job gave no PNG bytes for it or the asset cannot
 * be used; the caller then prints the blank field.
 */
function signaturePicture(
  ctx: Ctx,
  v: unknown,
  width: number,
  label: string,
  blockId: string | null,
): Tex | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const asset = (v as Record<string, unknown>)['asset'];
  if (typeof asset !== 'string' || !Object.hasOwn(ctx.assets, asset)) return null;
  const a = ctx.assets[asset]!;
  if (a.bytes === undefined) return null;
  const size = imagePixelSize(a.bytes, a.mediaType);
  if (size === null) return null;
  const file = assetRef(ctx, asset, blockId);
  if (file === null) return null;
  return imageBox(ctx, file, width, heightForWidth(width, size), label);
}

function formFieldTex(ctx: Ctx, n: J, st: InlineState): Tex {
  const id = idOf(n);
  const label = str(attr(n, 'label')) ?? '';
  const width = num(attr(n, 'width'));
  const v = attr(n, 'value');
  let value = '';
  let picture: Tex | null = null;
  if (isRedacted(v) || isRedacted(attr(n, 'default'))) {
    // A hidden value prints the neutral notice (EXP-123 criterion 2), never an empty field.
    if (id) ctx.redactions.push({ kind: 'fieldValue', id });
    value = ctx.options.notices?.redactedValue ?? '[hidden]';
  } else if (ctx.o.fields === 'flatten') {
    // A signature or initials value is drawn as its picture (EXP-034 criterion 1) when the job has its bytes.
    const kind = str(attr(n, 'kind'));
    if ((kind === 'signature' || kind === 'initials') && width !== null)
      picture = signaturePicture(ctx, v, width, label, st.blockId);
    if (picture === null) value = formFieldValue(ctx, n);
  }
  const fam = familyOf(ctx, st.para.run.fontFamily, st.blockId);
  checkGlyphs(ctx, value, fam, st.para.run.bold, st.para.run.italic, id ?? st.blockId);
  const box = width !== null ? dimen(width, { min: 0, max: 31680 }) : t('0pt');
  const body = picture ?? text(value);
  if (width !== null && value.length > 0)
    // The class reports a value wider than its field in the log; the converter cannot measure it.
    void 0;
  const tagged = st.place === 'story' ? t('0') : t('1');
  const field = tex`\DEff{${tagged}}{${box}}{${kvValue(label)}}{${body}}`;
  // The class reports this box's page and rectangle under the field's number (EXP-058).
  const k = fieldNumber(ctx, id);
  return k === null ? field : tex`{\DEfieldno{${int(k)}}${field}}`;
}

/** The number of a form field's box in the class's report: the first use of an identifier numbers it. */
function fieldNumber(ctx: Ctx, id: string | null): number | null {
  if (id === null) return null;
  const known = ctx.fieldIds.indexOf(id);
  if (known > 0) return known;
  ctx.fieldIds.push(id);
  return ctx.fieldIds.length - 1;
}
