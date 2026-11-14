/**
 * The accessibility checker's view of the document (UX-066), built from the document the core
 * holds: the CDM envelope of `CoreApi.getContent()` (03), which never holds hidden content
 * (ADR 0019). The checker itself (`accessibility-check.ts`) sees only the plain blocks this module
 * returns, and this module only reads: it never writes to the envelope.
 *
 * What it reads (03 sections 4 to 6):
 * - headings: a paragraph's style, or `settings.defaultParagraphStyle`, and its `outlineLevel`
 *   through the `basedOn` chain;
 * - text colour: the `color` mark, else the character style chain, else the paragraph style chain;
 *   no colour anywhere is the default text colour (black, as Word's `auto` on a white page);
 * - highlight: the `highlight` mark or the run property of the styles, a Word highlight name turned
 *   into its colour (`HIGHLIGHT_RGB`);
 * - shading: the paragraph's `shading.fill`, else its style chain's, else that of the table cell it
 *   is in;
 * - pictures: `figure.alt` and inline `image.alt`; tables: `headerRows`; links: the text under one
 *   `link` mark with the same `href`, run after run.
 *
 * Every block carries the DEP scope it is in (`body` or `region:<id>`, 05 §5.3), so the caller can
 * tell whether this user may fix it. Footnote text and the stories (headers and footers) are read
 * too, so that the checker and the export job's alternative-text report (EXP-113) list the same
 * pictures (UX-066 criterion 3; decision 6 of docs/adr/0329-lane-U-UX-061-075.md, proposed). The
 * table style cascade (step 2 of 03 section 6) is not applied.
 */
import type { CheckBlock, CheckOptions, CheckRun } from './accessibility-check.ts';

/**
 * The colours of Word's highlight names (the `highlight` values of 03 section 4.5), as ECMA-376
 * part 1, 17.18.40 `ST_HighlightColor` defines them.
 */
export const HIGHLIGHT_RGB: Readonly<Record<string, string>> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  yellow: '#ffff00',
  white: '#ffffff',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
};

export interface ContentView {
  /** The blocks in document order, as the checker reads them. */
  readonly blocks: readonly CheckBlock[];
  /** The DEP scope of each block identifier: `body` or `region:<id>`. */
  readonly scopes: ReadonlyMap<string, string>;
  /** The page background and default text colour of the output (white and black). */
  readonly options: Required<CheckOptions>;
}

type Node = Readonly<Record<string, unknown>>;

/** The page of the output: the model has no page colour, so it is white, whatever the editor theme. */
const PAGE = '#ffffff';
const DEFAULT_TEXT = '#000000';
/** `basedOn` chains are at most ten styles deep (03, invariant I5). */
const CHAIN_LIMIT = 10;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attrsOf(node: Node): Node {
  return isNode(node['attrs']) ? node['attrs'] : {};
}

function childrenOf(node: Node): readonly Node[] {
  const content = node['content'];
  return Array.isArray(content) ? content.filter(isNode) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function fillOf(shading: unknown): string | null {
  return isNode(shading) ? str(shading['fill']) : null;
}

function highlightColour(value: unknown): string | null {
  const name = str(value);
  if (name === null) return null;
  return HIGHLIGHT_RGB[name] ?? name;
}

class Styles {
  readonly #defs = new Map<string, Node>();
  readonly defaultParagraph: string | null;

  constructor(defs: Node | undefined) {
    let defaultParagraph: string | null = null;
    for (const child of defs ? childrenOf(defs) : []) {
      const attrs = attrsOf(child);
      if (child['type'] === 'settings') defaultParagraph = str(attrs['defaultParagraphStyle']);
      if (child['type'] === 'style_def') {
        const id = str(attrs['id']);
        if (id !== null) this.#defs.set(id, attrs);
      }
    }
    this.defaultParagraph = defaultParagraph;
  }

  /** The first value of a property up the `basedOn` chain from a style, or null. */
  resolve(styleId: string | null, property: string): unknown {
    let id = styleId;
    for (let depth = 0; id !== null && depth <= CHAIN_LIMIT; depth++) {
      const attrs = this.#defs.get(id);
      if (!attrs) return null;
      const value = attrs[property];
      if (value !== null && value !== undefined) return value;
      id = str(attrs['basedOn']);
    }
    return null;
  }
}

interface Inherited {
  readonly scope: string;
  /** Shading of the table cell the block is in. */
  readonly cellShading: string | null;
}

/** Builds the checker's view from a CDM envelope (`{ cdm, requires, doc }`) or its `doc`. */
export function checkViewOfContent(content: unknown): ContentView {
  const blocks: CheckBlock[] = [];
  const scopes = new Map<string, string>();
  const options = { pageBackground: PAGE, defaultTextColor: DEFAULT_TEXT };
  const doc = isNode(content) && isNode(content['doc']) ? content['doc'] : content;
  if (!isNode(doc)) return { blocks, scopes, options };
  const top = childrenOf(doc);
  const styles = new Styles(top.find((n) => n['type'] === 'defs'));
  const body = top.find((n) => n['type'] === 'body');

  const add = (block: CheckBlock, scope: string): void => {
    blocks.push(block);
    if (!scopes.has(block.id)) scopes.set(block.id, scope);
  };

  const paragraph = (
    id: string,
    styleId: string | null,
    attrs: Node,
    inlines: readonly Node[],
    at: Inherited,
  ): void => {
    const style = styleId ?? styles.defaultParagraph;
    const level = styles.resolve(style, 'outlineLevel');
    const shading =
      fillOf(attrs['shading']) ?? fillOf(styles.resolve(style, 'shading')) ?? at.cellShading;
    const styleColour = str(styles.resolve(style, 'color'));
    const styleHighlight = highlightColour(styles.resolve(style, 'highlight'));
    const runs: CheckRun[] = [];
    const extra: CheckBlock[] = [];
    const notes: Node[] = [];
    // One link per stretch of inline nodes under the same `href`.
    const links: { text: string }[] = [];
    let lastHref: string | null = null;
    for (const inline of inlines) {
      const marks = Array.isArray(inline['marks']) ? inline['marks'].filter(isNode) : [];
      const mark = (type: string): Node | null => marks.find((m) => m['type'] === type) ?? null;
      const href = str(attrsOf(mark('link') ?? {})['href']);
      if (href !== null && href !== lastHref) links.push({ text: '' });
      lastHref = href;
      const link = href !== null ? links[links.length - 1] : undefined;
      if (inline['type'] === 'text') {
        const text = str(inline['text']) ?? '';
        const charStyle = str(attrsOf(mark('charStyle') ?? {})['style']);
        const color =
          str(attrsOf(mark('color') ?? {})['value']) ??
          str(styles.resolve(charStyle, 'color')) ??
          styleColour;
        const highlight =
          highlightColour(attrsOf(mark('highlight') ?? {})['value']) ??
          highlightColour(styles.resolve(charStyle, 'highlight')) ??
          styleHighlight;
        runs.push({ text, color, highlight });
        if (link) link.text += text;
      } else if (inline['type'] === 'image') {
        const alt = str(attrsOf(inline)['alt']);
        extra.push({ kind: 'image', id, altText: alt });
        if (link) link.text += alt ?? '';
      } else if (inline['type'] === 'footnote') {
        notes.push(inline);
      }
    }
    for (const link of links) extra.push({ kind: 'link', id, text: link.text });
    add(
      {
        kind: 'paragraph',
        id,
        outlineLevel: typeof level === 'number' ? level : null,
        shading,
        runs,
      },
      at.scope,
    );
    for (const block of extra) add(block, at.scope);
    // A footnote's blocks come after the paragraph that holds its reference, in its scope.
    for (const note of notes) for (const child of childrenOf(note)) block(child, at);
  };

  const block = (node: Node, at: Inherited): void => {
    const attrs = attrsOf(node);
    const id = str(attrs['id']);
    switch (node['type']) {
      case 'paragraph':
        if (id !== null) paragraph(id, str(attrs['style']), attrs, childrenOf(node), at);
        return;
      case 'figure': {
        if (id === null) return;
        add({ kind: 'figure', id, altText: str(attrs['alt']) }, at.scope);
        const caption = childrenOf(node).find((n) => n['type'] === 'caption');
        if (caption) paragraph(id, 'Caption', {}, childrenOf(caption), at);
        return;
      }
      case 'table': {
        if (id === null) return;
        const headerRows = typeof attrs['headerRows'] === 'number' ? attrs['headerRows'] : 0;
        add({ kind: 'table', id, headerRows }, at.scope);
        for (const row of childrenOf(node))
          for (const cell of childrenOf(row)) {
            const cellShading = fillOf(attrsOf(cell)['shading']);
            for (const child of childrenOf(cell)) block(child, { scope: at.scope, cellShading });
          }
        return;
      }
      case 'region': {
        if (id === null) return;
        for (const child of childrenOf(node))
          block(child, { scope: `region:${id}`, cellShading: null });
        return;
      }
      default:
        // Section breaks, equations, tables of contents, bibliographies, extension and preserved
        // blocks carry nothing the five rules read.
        return;
    }
  };

  for (const child of body ? childrenOf(body) : [])
    block(child, { scope: 'body', cellShading: null });
  // Stories (headers and footers) come after the body, so the body's heading order is kept.
  for (const story of top.filter((n) => n['type'] === 'story'))
    for (const child of childrenOf(story)) block(child, { scope: 'body', cellShading: null });
  return { blocks, scopes, options };
}
