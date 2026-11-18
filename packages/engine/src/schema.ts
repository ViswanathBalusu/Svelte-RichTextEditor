/**
 * The editing schema (02 §5.2, §8; FE-030): the projection schema of the CDM definition in
 * `@docedit/model` (the CDM schema plus the `hidden_region` placeholder of ADR 0019), with the
 * minimum rendering the web view needs. The hooks add `toDOM`, `parseDOM` and `leafText` only, so
 * content expressions, marks and attributes are exactly the published ones and steps made here
 * apply unchanged on the authority's schema (04 §4; ADR 0003).
 *
 * One schema reads both a full document and a reader's projection. A full document never holds a
 * placeholder, and the region guard refuses every local step that touches or carries one (guard.ts),
 * so the steps this editor sends are always CDM steps.
 *
 * Rendering rules that matter for the strict-policy work (spike S2, 02 §3):
 * - no `style` attribute is ever produced here, because `setAttribute('style', …)` is an inline
 *   style under a content security policy; values that reach CSS go through the CSSOM in mark views
 *   (view-support.ts) after their grammar is checked (03 §8, I11);
 * - parse rules never read identifiers, so pasted copies get fresh ones (03 §9; 02 §5.2);
 * - there is no parse rule for definitions, stories or placeholders, so paste can never create them.
 */
import {
  CDM1,
  LINK_HREF_PATTERN,
  isRedactionMarker,
  type CdmDefinition,
  type JsonValue,
} from '@docedit/model/definition';
import { buildProjectionSchema } from '@docedit/model/prosemirror';
import type {
  DOMOutputSpec,
  MarkSpec,
  Node as PMNode,
  NodeSpec,
  Schema,
  TagParseRule,
} from 'prosemirror-model';

/**
 * The footnote content model. CDM-001 chose option B of 03 §13 (`paragraph+`, exactly one paragraph
 * in version 1), which spike S1 recommended; option A (`note_inline*`) no longer exists in the
 * definition.
 *
 * @deprecated Both values select the CDM's model. The option stays so that callers written for the
 * spike keep compiling; remove it once they no longer pass it.
 */
export type FootnoteModel = 'inline' | 'paragraph';

/** The node type that stands for a region the reader may not see (ADR 0019; CDM-053). */
export const PLACEHOLDER = 'hidden_region';

const HEADING_STYLE = /^Heading([1-9])$/;
const linkHref = new RegExp(LINK_HREF_PATTERN);

/**
 * The outline level of a built-in heading style, or null. Only for rendering, where a node view has
 * no access to the style table; the outline itself follows the style cascade (styles.ts; FE-026).
 */
export function headingLevel(style: unknown): number | null {
  if (typeof style !== 'string') return null;
  const m = HEADING_STYLE.exec(style);
  return m ? Number(m[1]) : null;
}

/**
 * The CDM definition the editor uses.
 *
 * @deprecated The argument is ignored (see {@link FootnoteModel}); use `CDM1`.
 */
export function definitionFor(_model?: FootnoteModel): CdmDefinition {
  return CDM1;
}

const hidden = (cls: string): DOMOutputSpec => ['div', { class: cls, hidden: '' }];

export function paragraphDOM(node: PMNode): DOMOutputSpec {
  const attrs: Record<string, string> = { class: 'de-p' };
  const style = node.attrs['style'];
  if (typeof style === 'string') attrs['data-style'] = style;
  const align = node.attrs['align'];
  if (typeof align === 'string') attrs['class'] += ` de-align-${align}`;
  const dir = node.attrs['dir'];
  if (typeof dir === 'string') attrs['dir'] = dir;
  const level = headingLevel(style);
  if (level === null) return ['p', attrs, 0];
  if (level <= 6) return [`h${level}`, attrs, 0];
  return ['p', { ...attrs, role: 'heading', 'aria-level': String(level) }, 0];
}

/**
 * The view of a preserved atom (FE-139 criteria 1, 3 and 5; ADR 0017). The label names its kind and
 * says where it came from, and the fallback text follows it. The fragment (the original XML) is never
 * read here: only the label and the fallback text reach the page. The atom is not editable, so the
 * content inside it is not editable either.
 */
function preservedDOM(tag: 'div' | 'span', node: PMNode): DOMOutputSpec {
  const raw =
    typeof node.attrs['label'] === 'string' && node.attrs['label'] !== ''
      ? node.attrs['label']
      : 'content';
  const kind = raw.charAt(0).toUpperCase() + raw.slice(1);
  const caption = `${kind}, from Word, not editable here`;
  const fallback = String(node.attrs['fallbackText'] ?? '');
  return [
    tag,
    {
      class: 'de-preserved',
      contenteditable: 'false',
      role: 'group',
      'aria-label': fallback === '' ? caption : `${caption}: ${fallback}`,
      'data-kind': kind,
    },
    ['span', { class: 'de-preserved-label' }, caption],
    ['span', { class: 'de-preserved-fallback' }, fallback],
  ];
}

/** What the reader is told when a custom block's extension is not available to them (UX-058). */
export const EXTENSION_NOTICE = 'This content comes from an extension that is not available.';

/**
 * A custom block as a reader sees it when no extension draws it (UX-056 criterion 6; UX-058): a
 * named group with the notice, the fallback picture when there is one and the fallback text as an
 * ordinary paragraph. The picture's alternative text is the fallback text, so a block with a picture
 * and no text has none (the accessibility checker flags it). The payload is never rendered.
 */
function extensionDOM(node: PMNode): DOMOutputSpec {
  const text = typeof node.attrs['fallbackText'] === 'string' ? node.attrs['fallbackText'] : '';
  const hasAsset =
    typeof node.attrs['fallbackAsset'] === 'string' && node.attrs['fallbackAsset'] !== '';
  const children: DOMOutputSpec[] = [['p', { class: 'de-extension-notice' }, EXTENSION_NOTICE]];
  if (hasAsset)
    children.push([
      'span',
      { class: 'de-image de-extension-image', role: 'img', 'aria-label': text },
    ]);
  if (text !== '') children.push(['p', { class: 'de-extension-text' }, text]);
  return [
    'div',
    {
      class: 'de-extension',
      contenteditable: 'false',
      role: 'group',
      'aria-label': `Content from extension ${String(node.attrs['extension'])}`,
    },
    ...children,
  ];
}

const FIELD_PLACEHOLDER: Record<string, string> = {
  page: '#',
  pageCount: '##',
  date: 'date',
  title: 'title',
  ref: 'ref',
  styleRef: 'style ref',
  seq: 'seq',
  formValue: 'value',
};

function fieldText(node: PMNode): string {
  const cached = node.attrs['cached'];
  if (typeof cached === 'string' && cached !== '') return cached;
  return `{${FIELD_PLACEHOLDER[String(node.attrs['kind'])] ?? 'field'}}`;
}

/**
 * The view of a page or column break (FE-135 criterion 5). The break is marked with a label, not
 * drawn as a page: the view has no pages (02 §7), so the label says what the break does and nothing
 * more. The mark is not editable, and assistive technology reads the label.
 */
const BREAK_LABEL: Record<string, string> = { page: 'Page break', column: 'Column break' };

function breakMarkDOM(kind: string): DOMOutputSpec {
  const label = BREAK_LABEL[kind] ?? 'Break';
  return [
    'span',
    {
      class: 'de-break',
      'data-kind': kind,
      contenteditable: 'false',
      role: 'separator',
      'aria-label': label,
    },
    label,
  ];
}

/**
 * The accessible name of a citation (FE-140 criterion 3): it names the sources it cites, in order, so
 * that assistive technology announces them. The source identifiers are the only names the node holds
 * (the source titles live in the document's definitions, which the node's view cannot read).
 */
function citationLabel(node: PMNode): string {
  const items: unknown = node.attrs['items'];
  if (!Array.isArray(items)) return 'Citation';
  const sources: string[] = [];
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const source = (item as Record<string, unknown>)['source'];
    if (typeof source === 'string' && source !== '') sources.push(source);
  }
  return sources.length === 0 ? 'Citation' : `Citation: ${sources.join(', ')}`;
}

const NODE_RENDERING: Record<string, Partial<NodeSpec>> = {
  // Definitions and stories are not part of the body view (03 §3): no content hole, so the view
  // never renders their children, and `hidden` keeps the empty wrapper out of layout and caret
  // movement. They have no parse rule, so paste can never create them.
  defs: { toDOM: () => hidden('de-defs') },
  settings: { toDOM: () => hidden('de-def') },
  style_def: { toDOM: () => hidden('de-def') },
  numbering_def: { toDOM: () => hidden('de-def') },
  page_setup: { toDOM: () => hidden('de-def') },
  role_def: { toDOM: () => hidden('de-def') },
  rule_def: { toDOM: () => hidden('de-def') },
  source_def: { toDOM: () => hidden('de-def') },
  story: { toDOM: () => hidden('de-story') },
  body: { toDOM: () => ['div', { class: 'de-body' }, 0] },
  region: {
    toDOM: (node) => {
      const title = typeof node.attrs['title'] === 'string' ? node.attrs['title'] : '';
      return [
        'div',
        {
          class: 'de-region',
          role: 'group',
          'aria-label': title || 'Region',
          'data-policy': String(node.attrs['policy']),
          'data-title': title,
        },
        ['div', { class: 'de-region-title', contenteditable: 'false' }, title || 'Region'],
        ['div', { class: 'de-region-content' }, 0],
      ];
    },
    parseDOM: [
      {
        tag: 'div.de-region',
        contentElement: '.de-region-content',
        getAttrs: (dom) => ({ title: dom.getAttribute('data-title') || null }),
      },
    ],
  },
  // A region the reader may not see (ADR 0019): an atom with no position inside it. FE-141 owns how
  // it looks; this is the minimum, with the title only when the projection carries one.
  [PLACEHOLDER]: {
    toDOM: (node) => {
      const title = typeof node.attrs['title'] === 'string' ? node.attrs['title'] : '';
      return [
        'div',
        {
          class: 'de-hidden-region',
          contenteditable: 'false',
          role: 'note',
          'aria-label': title ? `Hidden region: ${title}` : 'Hidden region',
          'data-id': String(node.attrs['id']),
        },
        title || 'Hidden region',
      ];
    },
  },
  section_break: {
    toDOM: (node) => [
      'hr',
      { class: 'de-section-break', 'data-start': String(node.attrs['start']) },
    ],
  },
  paragraph: {
    toDOM: paragraphDOM,
    parseDOM: [
      { tag: 'p' },
      ...[1, 2, 3, 4, 5, 6].map((n): TagParseRule => ({
        tag: `h${n}`,
        attrs: { style: `Heading${n}` },
      })),
    ],
  },
  table: {
    toDOM: () => ['table', { class: 'de-table' }, ['tbody', 0]],
    parseDOM: [{ tag: 'table' }],
  },
  table_row: { toDOM: () => ['tr', 0], parseDOM: [{ tag: 'tr' }] },
  table_cell: {
    toDOM: (node) => [
      'td',
      { colspan: String(node.attrs['colspan']), rowspan: String(node.attrs['rowspan']) },
      0,
    ],
    parseDOM: [{ tag: 'td' }, { tag: 'th' }],
  },
  figure: {
    toDOM: (node) => [
      'figure',
      { class: 'de-figure' },
      [
        'div',
        { class: 'de-figure-image', contenteditable: 'false' },
        String(node.attrs['alt'] ?? ''),
      ],
      ['div', 0],
    ],
  },
  caption: { toDOM: () => ['figcaption', 0] },
  equation_block: {
    toDOM: (node) => [
      'div',
      { class: 'de-equation-block', 'data-latex': String(node.attrs['latex']) },
      String(node.attrs['latex']),
    ],
  },
  toc: { toDOM: () => ['div', { class: 'de-toc' }, 'Table of contents'] },
  bibliography: { toDOM: () => ['div', { class: 'de-bibliography' }, 'Bibliography'] },
  extension_block: {
    toDOM: (node) => extensionDOM(node),
  },
  preserved_block: {
    toDOM: (node) => preservedDOM('div', node),
  },
  image: {
    toDOM: (node) => [
      'span',
      { class: 'de-image', role: 'img', 'aria-label': String(node.attrs['alt'] ?? '') },
    ],
  },
  break: {
    toDOM: (node) =>
      node.attrs['kind'] === 'line' ? ['br'] : breakMarkDOM(String(node.attrs['kind'])),
    // The page and column marks read back as the same break, so a copied break pastes as a break
    // and not as its label text. Any other `data-kind` is not a break this schema knows.
    parseDOM: [
      { tag: 'br' },
      {
        tag: 'span.de-break[data-kind]',
        getAttrs: (dom) => {
          const kind = dom.getAttribute('data-kind');
          return kind === 'page' || kind === 'column' ? { kind } : false;
        },
      },
    ],
    leafText: () => '\n',
  },
  tab: { toDOM: () => ['span', { class: 'de-tab' }, '\t'], leafText: () => '\t' },
  equation: {
    toDOM: (node) => [
      'span',
      { class: 'de-equation', 'data-latex': String(node.attrs['latex']) },
      String(node.attrs['latex']),
    ],
    parseDOM: [
      {
        tag: 'span.de-equation[data-latex]',
        getAttrs: (dom) => ({ latex: dom.getAttribute('data-latex') ?? '' }),
      },
    ],
    leafText: (node) => String(node.attrs['latex']),
  },
  // The footnote serialises with its content (for the clipboard); the body view shows only the
  // reference mark, through the node view in footnote.ts.
  footnote: {
    toDOM: () => ['span', { class: 'de-footnote', 'data-footnote': '' }, 0],
    parseDOM: [{ tag: 'span[data-footnote]' }],
  },
  field: {
    toDOM: (node) => [
      'span',
      { class: 'de-field', 'data-kind': String(node.attrs['kind']) },
      fieldText(node),
    ],
    parseDOM: [
      {
        tag: 'span.de-field[data-kind]',
        getAttrs: (dom) => ({ kind: dom.getAttribute('data-kind') }),
      },
    ],
    leafText: fieldText,
  },
  citation: {
    toDOM: (node) => [
      'span',
      { class: 'de-citation', role: 'note', 'aria-label': citationLabel(node) },
      typeof node.attrs['cached'] === 'string' && node.attrs['cached'] !== ''
        ? node.attrs['cached']
        : '[citation]',
    ],
  },
  anchor: {
    toDOM: (node) => ['span', { class: 'de-anchor', 'data-name': String(node.attrs['name']) }],
  },
  // A form field whose value the reader may not read (ADR 0019, FRW-088) is shown as redacted, never
  // as an empty field: the text says so and the screen reader announces it.
  form_field: {
    toDOM: (node) =>
      isRedactionMarker(node.attrs['value'] as JsonValue | undefined)
        ? [
            'span',
            {
              class: 'de-form-field de-redacted',
              'data-redacted': 'true',
              role: 'img',
              'aria-label': 'Redacted value',
            },
            '[redacted]',
          ]
        : ['span', { class: 'de-form-field' }, '[field]'],
  },
  extension_inline: {
    toDOM: (node) => ['span', { class: 'de-extension' }, String(node.attrs['fallbackText'] ?? '')],
  },
  preserved_inline: {
    toDOM: (node) => preservedDOM('span', node),
  },
};

const toggleMark = (tag: string, offClass: string, parseTags: string[]): Partial<MarkSpec> => ({
  toDOM: (mark) => (mark.attrs['value'] === false ? ['span', { class: offClass }, 0] : [tag, 0]),
  parseDOM: [
    ...parseTags.map((t): TagParseRule => ({ tag: t, attrs: { value: true } })),
    { tag: `span.${offClass}`, attrs: { value: false } },
  ],
});

const classToggle = (onClass: string, offClass: string): Partial<MarkSpec> => ({
  toDOM: (mark) => ['span', { class: mark.attrs['value'] === false ? offClass : onClass }, 0],
  parseDOM: [
    { tag: `span.${onClass}`, attrs: { value: true } },
    { tag: `span.${offClass}`, attrs: { value: false } },
  ],
});

const dataMark = (name: string): Partial<MarkSpec> => ({
  toDOM: (mark) => ['span', { [`data-${name}`]: String(mark.attrs['value']) }, 0],
});

/**
 * The attributes of the element a suggestion mark is drawn with. `prosemirror-view` wraps every child
 * that carries a mark in the mark's element, a block (a paragraph, a row, a table) included, and a
 * mark cannot draw no element. A block suggestion (`inline` false) gets the class `de-suggest-wrap`,
 * which the stylesheet gives `display: contents`, so the element has no box of its own and the block
 * keeps its place in its parent's layout (FE-045 criterion 6). The cue itself is a node decoration on
 * the block. See docs/adr/0385-w1-FE-044-block-suggestion-rendering.md.
 */
function suggestionAttrs(
  id: unknown,
  inline: boolean,
  inlineClass?: string,
): Record<string, string> {
  const attrs: Record<string, string> = { 'data-suggestion': String(id) };
  if (!inline) attrs['class'] = 'de-suggest-wrap';
  else if (inlineClass !== undefined) attrs['class'] = inlineClass;
  return attrs;
}

const MARK_RENDERING: Record<string, Partial<MarkSpec>> = {
  link: {
    toDOM: (mark) => {
      const href = String(mark.attrs['href']);
      const attrs: Record<string, string> = { rel: 'noopener noreferrer' };
      // Only an allowed scheme becomes a live link (03 §8, I9; FE-067).
      if (linkHref.test(href)) {
        attrs['href'] = href;
        // An external link opens in a new browsing context (FE-067, FE-133); an in-document target does not.
        if (!href.startsWith('#')) attrs['target'] = '_blank';
      }
      if (typeof mark.attrs['title'] === 'string') attrs['title'] = mark.attrs['title'];
      return ['a', attrs, 0];
    },
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => {
          const href = dom.getAttribute('href') ?? '';
          return linkHref.test(href) ? { href, title: dom.getAttribute('title') } : false;
        },
      },
    ],
  },
  charStyle: { toDOM: (mark) => ['span', { 'data-char-style': String(mark.attrs['style']) }, 0] },
  bold: toggleMark('strong', 'de-not-bold', ['strong', 'b']),
  italic: toggleMark('em', 'de-not-italic', ['em', 'i']),
  underline: {
    toDOM: (mark) =>
      mark.attrs['style'] === 'none'
        ? ['span', { class: 'de-no-underline' }, 0]
        : ['u', { 'data-underline': String(mark.attrs['style']) }, 0],
    parseDOM: [{ tag: 'u' }],
  },
  strike: toggleMark('s', 'de-not-strike', ['s', 'del:not([data-suggestion])', 'strike']),
  smallCaps: classToggle('de-small-caps', 'de-not-small-caps'),
  allCaps: classToggle('de-all-caps', 'de-not-all-caps'),
  vertAlign: {
    toDOM: (mark) =>
      mark.attrs['value'] === 'super'
        ? ['sup', 0]
        : mark.attrs['value'] === 'sub'
          ? ['sub', 0]
          : ['span', { class: 'de-baseline' }, 0],
    parseDOM: [
      { tag: 'sup', attrs: { value: 'super' } },
      { tag: 'sub', attrs: { value: 'sub' } },
    ],
  },
  fontFamily: dataMark('font-family'),
  fontSize: dataMark('font-size'),
  color: dataMark('color'),
  highlight: {
    toDOM: (mark) => ['span', { class: `de-hl de-hl-${String(mark.attrs['value'])}` }, 0],
  },
  lang: { toDOM: (mark) => ['span', { lang: String(mark.attrs['value']) }, 0] },
  hidden: classToggle('de-hidden', 'de-not-hidden'),
  preserved: { toDOM: () => ['span', { class: 'de-preserved-run' }, 0] },
  ins: {
    toDOM: (mark, inline) => ['ins', suggestionAttrs(mark.attrs['id'], inline), 0],
  },
  del: {
    toDOM: (mark, inline) => ['del', suggestionAttrs(mark.attrs['id'], inline), 0],
  },
  fmt: {
    toDOM: (mark, inline) => ['span', suggestionAttrs(mark.attrs['id'], inline, 'de-fmt'), 0],
  },
};

/** The members of a spec that rendering adds; everything else must equal the published schema. */
export const RENDERING_MEMBERS: readonly string[] = ['toDOM', 'parseDOM', 'leafText'];

let cached: Schema | undefined;

/**
 * The editing schema, shared by every editor on the page. The argument is ignored (see
 * {@link FootnoteModel}).
 */
export function editingSchema(_model?: FootnoteModel): Schema {
  cached ??= buildProjectionSchema(CDM1, {
    node: (name, spec) => ({ ...spec, ...NODE_RENDERING[name] }),
    mark: (name, spec) => ({ ...spec, ...MARK_RENDERING[name] }),
  });
  return cached;
}

/** Whether a node, or anything inside it, is a placeholder of a projection. */
export function holdsPlaceholder(node: PMNode): boolean {
  if (node.type.name === PLACEHOLDER) return true;
  let found = false;
  node.descendants((child) => {
    if (child.type.name === PLACEHOLDER) found = true;
    return !found && !child.isLeaf;
  });
  return found;
}
