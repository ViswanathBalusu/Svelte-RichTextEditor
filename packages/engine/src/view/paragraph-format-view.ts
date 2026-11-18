/**
 * Paragraph formatting in the web view (FE-129 criteria 1, 3 and 5; 03 §4.5, §7; 02 §7).
 *
 * The values a paragraph carries itself (`setParagraphFormat`) are drawn: the indents, the spacing
 * before and after, the line spacing and its rule, the borders and the shading. Nothing is written
 * into the document, and the values of a paragraph style are not drawn here (the web view keeps its
 * own spacing for those; a style's look is the style story's).
 *
 * - `paragraphCss` is the pure part: the CSS values of one paragraph's own attributes.
 * - `paragraphView` is the node view: the same element the schema writes (`paragraphDOM`), with the
 *   values applied through the CSSOM, never as a `style` attribute, which is an inline style under a
 *   content security policy. Every value is checked first (I11): an integer in the CDM's range, a
 *   known border style, a colour of the grammar. A value that fails draws nothing.
 * - Keep rules and the page break are drawn nowhere in a continuous sheet. The node says so: a
 *   `title` that names the rules and states that they take effect in the PDF and the read view.
 *
 * Readings taken here and recorded as proposed in docs/adr/0381-w1-FE-129-paragraph-format-view.md:
 * a length in twips is drawn as points (twips divided by 20); `lineSpacing` under `multiple` is
 * thousandths of a line; the rule `atLeast` is drawn as `max(1.2em, value)`, since CSS has no
 * minimum line height; a border `space` is in twentieths of a point and is drawn as padding on that
 * side; `left` and `right` borders are physical sides; the `between` border is not drawn.
 */
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { paragraphDOM } from '../schema.ts';
import { colourValue } from '../view-support.ts';
import { borderCss } from './table-style-view.ts';

/** The CSS values of one paragraph; a property is absent when the paragraph does not set it. */
export interface ParagraphCss {
  readonly marginInlineStart?: string;
  readonly marginInlineEnd?: string;
  readonly textIndent?: string;
  readonly marginBlockStart?: string;
  readonly marginBlockEnd?: string;
  readonly lineHeight?: string;
  readonly borderTop?: string;
  readonly borderBottom?: string;
  readonly borderLeft?: string;
  readonly borderRight?: string;
  readonly paddingTop?: string;
  readonly paddingBottom?: string;
  readonly paddingLeft?: string;
  readonly paddingRight?: string;
  readonly backgroundColor?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The members of `ParagraphCss` with their CSS property names. */
const PROPS: readonly (readonly [keyof ParagraphCss, string])[] = [
  ['marginInlineStart', 'margin-inline-start'],
  ['marginInlineEnd', 'margin-inline-end'],
  ['textIndent', 'text-indent'],
  ['marginBlockStart', 'margin-block-start'],
  ['marginBlockEnd', 'margin-block-end'],
  ['lineHeight', 'line-height'],
  ['borderTop', 'border-top'],
  ['borderBottom', 'border-bottom'],
  ['borderLeft', 'border-left'],
  ['borderRight', 'border-right'],
  ['paddingTop', 'padding-top'],
  ['paddingBottom', 'padding-bottom'],
  ['paddingLeft', 'padding-left'],
  ['paddingRight', 'padding-right'],
  ['backgroundColor', 'background-color'],
];

type Attrs = Readonly<Record<string, unknown>>;

const LENGTH_LIMIT = 31680;

function twips(v: unknown, min: number): string | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > LENGTH_LIMIT)
    return undefined;
  return `${v / 20}pt`;
}

function lineHeight(spacing: unknown, rule: unknown): string | undefined {
  if (
    typeof spacing !== 'number' ||
    !Number.isInteger(spacing) ||
    spacing < 1 ||
    spacing > LENGTH_LIMIT
  )
    return undefined;
  if (rule === 'exact') return `${spacing / 20}pt`;
  if (rule === 'atLeast') return `max(1.2em, ${spacing / 20}pt)`;
  // `multiple`, the CDM's default: thousandths of a line.
  return rule === 'multiple' || rule === null || rule === undefined
    ? `${spacing / 1000}`
    : undefined;
}

const SIDES = [
  ['top', 'borderTop', 'paddingTop'],
  ['bottom', 'borderBottom', 'paddingBottom'],
  ['left', 'borderLeft', 'paddingLeft'],
  ['right', 'borderRight', 'paddingRight'],
] as const;

/** The CSS values of the properties a paragraph's own attributes set. */
export function paragraphCss(attrs: Attrs): ParagraphCss {
  const css: Mutable<ParagraphCss> = {};
  const set = (key: keyof ParagraphCss, value: string | undefined): void => {
    if (value !== undefined) css[key] = value;
  };
  set('marginInlineStart', twips(attrs['indentLeft'], -LENGTH_LIMIT));
  set('marginInlineEnd', twips(attrs['indentRight'], -LENGTH_LIMIT));
  set('textIndent', twips(attrs['indentFirstLine'], -LENGTH_LIMIT));
  set('marginBlockStart', twips(attrs['spaceBefore'], 0));
  set('marginBlockEnd', twips(attrs['spaceAfter'], 0));
  set('lineHeight', lineHeight(attrs['lineSpacing'], attrs['lineRule']));
  const borders = attrs['borders'];
  if (borders !== null && typeof borders === 'object') {
    for (const [name, border, padding] of SIDES) {
      const side = (borders as Record<string, unknown>)[name];
      const value = borderCss(side);
      if (value === undefined) continue;
      set(border, value);
      const space = (side as Record<string, unknown>)['space'];
      if (typeof space === 'number' && Number.isInteger(space) && space >= 0 && space <= 620)
        set(padding, `${space / 20}pt`);
    }
  }
  const shading = attrs['shading'];
  if (shading !== null && typeof shading === 'object')
    set('backgroundColor', colourValue((shading as Record<string, unknown>)['fill']));
  return css;
}

/** What the web view tells the author about the layout rules a paragraph carries. */
export const KEEP_NOTE_SUFFIX =
  'take effect in the PDF and the read view, not in the web view, which has no pages.';

const KEEP_RULES = [
  ['keepNext', 'keep with next'],
  ['keepLines', 'keep lines together'],
  ['pageBreakBefore', 'page break before'],
] as const;

/**
 * The note of a paragraph with keep rules, or null. Widow control is on by default (03 §4.5), so only
 * its switching off is reported: with it off, the first or last line of a paragraph may stand alone.
 */
export function paragraphLayoutNote(attrs: Attrs): string | null {
  const rules: string[] = KEEP_RULES.filter(([key]) => attrs[key] === true).map(([, name]) => name);
  if (attrs['widowControl'] === false) rules.push('widow control off');
  return rules.length === 0 ? null : `${rules.join(', ')}: ${KEEP_NOTE_SUFFIX}`;
}

/**
 * What decides the shape of the paragraph's element (`paragraphDOM` reads these three attributes):
 * when it changes, ProseMirror draws the paragraph again.
 */
function shapeOf(node: PMNode): string {
  const { style, align, dir } = node.attrs;
  return `${String(style)}|${String(align)}|${String(dir)}`;
}

interface Drawn {
  readonly css: ParagraphCss;
  readonly note: string | null;
}

/** Brings the element to the paragraph's values, touching only what differs from `before`. */
function paint(dom: HTMLElement, node: PMNode, before: Drawn): Drawn {
  const css = paragraphCss(node.attrs);
  for (const [key, property] of PROPS) {
    const value = css[key];
    if (value === before.css[key]) continue;
    if (value === undefined) dom.style.removeProperty(property);
    else dom.style.setProperty(property, value);
  }
  const note = paragraphLayoutNote(node.attrs);
  if (note !== before.note) {
    if (note === null) {
      dom.removeAttribute('title');
      dom.removeAttribute('data-de-layout');
    } else {
      dom.setAttribute('title', note);
      dom.setAttribute('data-de-layout', '');
    }
  }
  return { css, note };
}

const NOTHING: Drawn = { css: {}, note: null };

/**
 * The node view of a paragraph: the element the schema writes, with the paragraph's own formatting
 * applied through the CSSOM. A change of the element's shape (its heading level, alignment class,
 * style or direction) makes ProseMirror draw the paragraph again.
 */
export const paragraphView: NodeViewConstructor = (node): NodeView => {
  const { dom, contentDOM } = DOMSerializer.renderSpec(document, paragraphDOM(node));
  const element = dom as HTMLElement;
  const shape = shapeOf(node);
  let drawn = paint(element, node, NOTHING);
  return {
    dom: element,
    ...(contentDOM ? { contentDOM } : {}),
    update(next) {
      if (next.type !== node.type) return false;
      if (shapeOf(next) !== shape) return false;
      drawn = paint(element, next, drawn);
      return true;
    },
  };
};
