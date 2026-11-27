/**
 * The CDM, version 1 (draft): the one declarative definition from which the TypeScript types, the
 * JSON Schema, the ProseMirror schema and the attribute tables are generated (CDM-006).
 *
 * Sources: 03 §3 to §5 and §4.6, 12 §3, ADR 0017, ADR 0019. The values that 03 left open (CDM-002,
 * CDM-003) are those of docs/adr/0018-cdm-attribute-grammars.md, which the owner accepted (decision 7
 * of docs/owner-decisions-2026-11-15.md); 03 §4.8 states the rules and src/schema/prose-grammar.test.ts
 * compares it with this file. docs/adr/0031-cdm-1-model-completion.md records the later ones, and the
 * generated table is spec/cdm/cdm-1.attributes.md.
 *
 * The nodes of fields come from FRW's module (fields.ts, 12 §3; CDM-022), the citation nodes from
 * citations.ts (CDM-052), and the projection placeholder from projection.ts (ADR 0019; CDM-053).
 */
import { BIBLIOGRAPHY, CITATION, CITATION_STYLES, SOURCE_DEF } from './citations.ts';
import { FORM_FIELD, ROLE_DEF, RULE_DEF } from './fields.ts';
import {
  type AttrDef,
  type CdmDefinition,
  type Grammar,
  type MarkDef,
  type NodeDef,
  arr,
  attr,
  bool,
  int,
  nullable,
  obj,
  oneOf,
  ref,
  str,
} from './grammar.ts';
import { HIDDEN_REGION } from './projection.ts';
import {
  COLOUR,
  DEF_ID,
  FONT_SIZE,
  LANG,
  LENGTH,
  NAME,
  NODE_ID,
  TEXT,
  ULENGTH,
  USER,
  ext,
  PRESERVED_BYTES,
  PRESERVED_DEPTH,
  PRESERVED_STYLE_BYTES,
  id,
  origin,
  preserved,
} from './shared.ts';

export { DEFINITION_ID_PATTERN, EXT_KEY_PATTERN, FIELD_KEY_PATTERN } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// Patterns (ASCII, shared with the JSON Schema).

export const FONT_FAMILY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$';
/**
 * Numbering level text (03 §4.1): the placeholders `%1` to `%9` and literal text, which is any
 * character but `%`, the control characters, the TeX specials `\` `{` `}` and the bidirectional
 * overrides (CDM-015). Widened by owner decision 240 (2026-11-26), so that "Article %1" and
 * "NEW-%1-FORMAT" of Word files can be stored. A `%` that is not a placeholder is not stored.
 * Written with escapes, so that the source stays ASCII.
 */
export const LEVEL_TEXT_PATTERN =
  '^(?:%[1-9]|[^%\\\\{}\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069])*$';
export const BOOKMARK_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]{0,39}$';
export const EQUATION_LABEL_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]{0,63}$';
export const SEQUENCE_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,31}$';
/** `field.target` addressing forms, one per target kind (CDM-002). */
export const FIELD_TARGET_PATTERN =
  '^(?:bookmark:[A-Za-z_][A-Za-z0-9_]{0,39}|node:[A-Za-z0-9_-]{16}|eq:[A-Za-z][A-Za-z0-9:_-]{0,63}|style:[A-Za-z0-9_-]{1,64}|field:[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*)$';
export const FIELD_FORMAT_PATTERN = "^[A-Za-z0-9 .,:;/()'-]{1,64}$";
/** `link.href`: http, https, mailto, or an in-document target (invariant I9). */
export const LINK_HREF_PATTERN =
  '^(?:https?://[^\\s<>"{}|\\\\^`]+|mailto:[^\\s<>"]+|#[A-Za-z0-9_:.-]{1,128})$';
export const EXTENSION_NAME_PATTERN = '^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$';
export const TOC_OF_PATTERN = '^(?:headings|[A-Za-z][A-Za-z0-9_-]{0,31})$';

// ---------------------------------------------------------------------------------------------
// Value sets that 03 names without values (CDM-002).

export const HIGHLIGHT_VALUES = [
  'yellow',
  'green',
  'cyan',
  'magenta',
  'blue',
  'red',
  'darkBlue',
  'darkCyan',
  'darkGreen',
  'darkMagenta',
  'darkRed',
  'darkYellow',
  'darkGray',
  'lightGray',
  'black',
  'white',
] as const;
export const NUMBER_FORMATS = [
  'decimal',
  'lowerLetter',
  'upperLetter',
  'lowerRoman',
  'upperRoman',
  'lowerGreek',
  'bullet',
  'none',
] as const;
export const PAGE_NUMBER_FORMATS = [
  'decimal',
  'lowerRoman',
  'upperRoman',
  'lowerLetter',
  'upperLetter',
] as const;
export const FOOTNOTE_FORMATS = [
  'decimal',
  'lowerRoman',
  'upperRoman',
  'lowerLetter',
  'upperLetter',
  'symbol',
] as const;
/** The published bullet list (03 §4.1: "one character from a published list"). */
export const BULLET_CHARS = [
  '•',
  '◦',
  '▪',
  '■',
  '□',
  '●',
  '○',
  '–',
  '—',
  '➢',
  '✓',
  '♦',
  '◆',
  '*',
  '-',
] as const;
export const BORDER_STYLES = ['none', 'single', 'double', 'dotted', 'dashed', 'thick'] as const;
export const TAB_LEADERS = ['none', 'dot', 'hyphen', 'underscore', 'middleDot', 'heavy'] as const;
/** The kinds of the `field` node (03 §4.4); `formValue` belongs to the feature `fields`. */
export const FIELD_NODE_KINDS = [
  'page',
  'pageCount',
  'date',
  'title',
  'ref',
  'styleRef',
  'seq',
  'formValue',
] as const;
/** The region policies: 03 §4.2, and `confidential` from ADR 0019 (proposed). */
export const REGION_POLICIES = ['inherit', 'restricted', 'confidential'] as const;

/** Reserved identifiers of built-in styles and their kinds (03 §4.1, "and the like", made explicit). */
export const BUILT_IN_STYLES: Readonly<Record<string, 'paragraph' | 'character' | 'table'>> = {
  Normal: 'paragraph',
  Heading1: 'paragraph',
  Heading2: 'paragraph',
  Heading3: 'paragraph',
  Heading4: 'paragraph',
  Heading5: 'paragraph',
  Heading6: 'paragraph',
  Heading7: 'paragraph',
  Heading8: 'paragraph',
  Heading9: 'paragraph',
  Title: 'paragraph',
  Subtitle: 'paragraph',
  Quote: 'paragraph',
  IntenseQuote: 'paragraph',
  ListParagraph: 'paragraph',
  NoSpacing: 'paragraph',
  Caption: 'paragraph',
  FootnoteText: 'paragraph',
  Header: 'paragraph',
  Footer: 'paragraph',
  TOCHeading: 'paragraph',
  TOC1: 'paragraph',
  TOC2: 'paragraph',
  TOC3: 'paragraph',
  TOC4: 'paragraph',
  TOC5: 'paragraph',
  TOC6: 'paragraph',
  TOC7: 'paragraph',
  TOC8: 'paragraph',
  TOC9: 'paragraph',
  DefaultParagraphFont: 'character',
  FootnoteReference: 'character',
  Hyperlink: 'character',
  Strong: 'character',
  Emphasis: 'character',
  TableNormal: 'table',
  TableGrid: 'table',
};

// ---------------------------------------------------------------------------------------------
// Shared grammars of this module.

const BORDER = obj(
  { style: oneOf(BORDER_STYLES), width: int(0, 240), color: nullable(COLOUR), space: int(0, 620) },
  { required: ['style'] },
);
const PARAGRAPH_BORDERS = obj({
  top: nullable(BORDER),
  bottom: nullable(BORDER),
  left: nullable(BORDER),
  right: nullable(BORDER),
  between: nullable(BORDER),
});
const TABLE_BORDERS = obj({
  top: nullable(BORDER),
  bottom: nullable(BORDER),
  left: nullable(BORDER),
  right: nullable(BORDER),
  insideH: nullable(BORDER),
  insideV: nullable(BORDER),
});
const STYLE_BORDERS = obj({
  top: nullable(BORDER),
  bottom: nullable(BORDER),
  left: nullable(BORDER),
  right: nullable(BORDER),
  between: nullable(BORDER),
  insideH: nullable(BORDER),
  insideV: nullable(BORDER),
});
const CELL_BORDERS = obj({
  top: nullable(BORDER),
  bottom: nullable(BORDER),
  left: nullable(BORDER),
  right: nullable(BORDER),
});
const SHADING = obj({ fill: COLOUR }, { required: ['fill'] });
const MARGINS = obj({ top: ULENGTH, bottom: ULENGTH, left: ULENGTH, right: ULENGTH });
const TAB = obj(
  {
    position: ULENGTH,
    align: oneOf(['left', 'center', 'right', 'decimal']),
    leader: oneOf(TAB_LEADERS),
  },
  { required: ['position', 'align', 'leader'] },
);
const NUMBERING = obj(
  { numberingId: ref('numbering'), level: int(0, 8), listId: NODE_ID },
  { required: ['numberingId', 'level', 'listId'] },
);

/** Every grammar problem of an extension node's envelope is I12 (03 §8). */
const ENVELOPE = { '*': 'I12' } as const;

// Run properties (03 §4.5), as style attributes: null means "not set here; inherit".
const RUN_PROPERTY_GRAMMARS: Record<string, Grammar> = {
  fontFamily: nullable(str(64, { pattern: FONT_FAMILY_PATTERN })),
  fontSize: nullable(FONT_SIZE),
  bold: nullable(bool()),
  italic: nullable(bool()),
  underline: nullable(oneOf(['single', 'double', 'dotted', 'none'])),
  strike: nullable(bool()),
  smallCaps: nullable(bool()),
  allCaps: nullable(bool()),
  vertAlign: nullable(oneOf(['super', 'sub', 'baseline'])),
  color: nullable(COLOUR),
  highlight: nullable(oneOf(HIGHLIGHT_VALUES)),
  lang: nullable(LANG),
  hidden: nullable(bool()),
};
const runProps = (): Record<string, AttrDef> =>
  Object.fromEntries(
    Object.entries(RUN_PROPERTY_GRAMMARS).map(([k, g]) => [
      k,
      attr(g, null, `Run property \`${k}\` (03 §4.5).`),
    ]),
  );

const paragraphProps = (): Record<string, AttrDef> => ({
  align: attr(
    nullable(oneOf(['start', 'center', 'end', 'justify', 'distribute'])),
    null,
    'Alignment, logical (CDM-002).',
  ),
  dir: attr(nullable(oneOf(['ltr', 'rtl'])), null, 'Paragraph direction.'),
  indentLeft: attr(nullable(LENGTH), null, 'Left indent in twips.'),
  indentRight: attr(nullable(LENGTH), null, 'Right indent in twips.'),
  indentFirstLine: attr(
    nullable(LENGTH),
    null,
    'First-line indent in twips; negative for a hanging indent.',
  ),
  spaceBefore: attr(nullable(ULENGTH), null, 'Space before in twips.'),
  spaceAfter: attr(nullable(ULENGTH), null, 'Space after in twips.'),
  contextualSpacing: attr(
    nullable(bool()),
    null,
    'No space between paragraphs of the same style (03 §7).',
  ),
  lineSpacing: attr(
    nullable(int(1, 31680)),
    null,
    'Thousandths of a line under `multiple`; twips under `exact` and `atLeast` (03 §2).',
  ),
  lineRule: attr(
    nullable(oneOf(['multiple', 'exact', 'atLeast'])),
    null,
    'How `lineSpacing` is read.',
  ),
  keepNext: attr(nullable(bool()), null, 'Keep with the next paragraph.'),
  keepLines: attr(nullable(bool()), null, 'Keep the lines of the paragraph together.'),
  pageBreakBefore: attr(nullable(bool()), null, 'Start on a new page.'),
  widowControl: attr(nullable(bool()), null, 'Avoid widows and orphans.'),
  tabs: attr(nullable(arr(TAB, 64)), null, 'Tab stops measured from the left margin (03 §7).'),
  borders: attr(nullable(PARAGRAPH_BORDERS), null, 'Paragraph borders.'),
  shading: attr(nullable(SHADING), null, 'Paragraph shading.'),
});

const LEVEL = obj(
  {
    format: oneOf(NUMBER_FORMATS),
    text: str(64, { pattern: LEVEL_TEXT_PATTERN }),
    start: int(0, 32767),
    restartAfter: nullable(int(0, 8)),
    legal: bool(),
    indentLeft: LENGTH,
    hanging: ULENGTH,
    align: oneOf(['start', 'center', 'end']),
    bulletChar: nullable(oneOf(BULLET_CHARS)),
    runProps: nullable(obj(RUN_PROPERTY_GRAMMARS)),
  },
  { required: ['format', 'text', 'start'] },
);

const ELEMENT_ATOM = ['footnote'];

// ---------------------------------------------------------------------------------------------
// Nodes, in schema order.

/** The kinds of block suggestion a `suggest` attribute holds (03 §5). */
export const SUGGESTION_KINDS: readonly string[] = ['ins', 'del', 'fmt'];

/**
 * The state of a block suggestion (03 §5; owner decision 92, ADR 0018 as amended). A paragraph, a
 * table row and a table keep their suggestions in this attribute and not as node marks, so the
 * editing surface can draw them as node decorations with no element around the block. Each entry
 * has the shape of a suggestion mark: `{ type, attrs: { id, user, before? } }`. `null` means none.
 */
const suggestAttr = (): AttrDef =>
  attr(
    nullable(
      arr(
        obj(
          {
            type: oneOf(SUGGESTION_KINDS),
            attrs: obj(
              {
                id: NODE_ID,
                user: USER,
                before: nullable({ kind: 'json', maxBytes: 4096, maxDepth: 6 }),
              },
              { required: ['id', 'user'] },
            ),
          },
          { required: ['type', 'attrs'] },
        ),
        8,
        { minItems: 1 },
      ),
    ),
    null,
    'Block suggestions: `ins`, `del` or `fmt` entries with the suggesting user; null when there are none. On a `fmt` entry, `before` records only `style`, `align` and `numbering` (CDM-040).',
  );
const nodes: NodeDef[] = [
  {
    name: 'doc',
    content: 'defs story* body',
    attrs: { ext: ext() },
    spec: '03 §3',
    doc: 'The root: definitions, header and footer stories, and the body.',
  },
  {
    name: 'defs',
    content:
      'settings style_def* numbering_def* page_setup+ role_def* rule_def* source_def* preserved_def*',
    isolating: true,
    selectable: false,
    allowGapCursor: false,
    attrs: { ext: ext() },
    spec: '03 §4.1',
    doc: 'Definitions: settings, styles, numbering, page setups, roles, rules, sources and shared preserved trees. Edited through dialogs, never selected.',
  },
  {
    name: 'settings',
    atom: true,
    selectable: false,
    spec: '03 §4.1',
    doc: 'Document-wide settings; exactly one.',
    attrs: {
      lang: attr(nullable(LANG), null, 'Document language (BCP 47).'),
      dir: attr(oneOf(['ltr', 'rtl']), 'ltr', 'Default direction.'),
      defaultTabStop: attr(int(1, 31680), 720, 'Default tab interval in twips.'),
      hyphenation: attr(bool(), false, 'Automatic hyphenation.'),
      defaultParagraphStyle: attr(
        ref('paragraphStyle'),
        'Normal',
        'Style of paragraphs whose `style` is null.',
      ),
      footnoteFormat: attr(oneOf(FOOTNOTE_FORMATS), 'decimal', 'Footnote mark format.'),
      footnoteRestart: attr(
        oneOf(['continuous', 'perPageSection']),
        'continuous',
        'Footnote numbering restart (values as written in 03 §4.1; see ADR 0018).',
      ),
      trackChanges: attr(
        oneOf(['off', 'everyone']),
        'off',
        'With `everyone`, rule P4 applies to every user (07 §5.2).',
      ),
      citationStyle: attr(
        oneOf(CITATION_STYLES),
        'authorYear',
        'Citation style of the house class (A3): author and year, or numeric (CDM-052; ADR 0031, proposed).',
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'style_def',
    atom: true,
    selectable: false,
    spec: '03 §4.1',
    doc: 'A paragraph, character or table style. One attribute per formatting property, so concurrent edits to different properties do not collide.',
    attrs: {
      id: attr(DEF_ID, null, 'Style identifier: a reserved built-in name or a random identifier.', {
        presence: 'required',
      }),
      kind: attr(oneOf(['paragraph', 'character', 'table']), 'paragraph', 'Style kind.'),
      name: attr(NAME, null, 'Human-readable label.', { presence: 'required' }),
      basedOn: attr(nullable(ref('anyStyle')), null, 'Parent style of the same kind (I4, I5).'),
      next: attr(nullable(ref('paragraphStyle')), null, 'Style of the paragraph after Enter.'),
      outlineLevel: attr(
        nullable(int(1, 9)),
        null,
        'Heading level; headings are paragraphs whose style has one.',
      ),
      builtIn: attr(bool(), false, 'True for the built-in styles with reserved identifiers.'),
      ...runProps(),
      ...paragraphProps(),
      borders: attr(
        nullable(STYLE_BORDERS),
        null,
        'Paragraph borders, or table borders for table styles; `insideH` and `insideV` only on table styles.',
      ),
      numbering: attr(
        nullable(NUMBERING),
        null,
        'Numbering carried by a paragraph style, which is how headings are numbered.',
      ),
      cellMargins: attr(nullable(MARGINS), null, 'Table styles only: default cell margins.'),
      headerRowShading: attr(nullable(SHADING), null, 'Table styles only: header row shading.'),
      bandedRows: attr(nullable(bool()), null, 'Table styles only: banded rows.'),
      preserved: preserved(PRESERVED_STYLE_BYTES),
      ext: ext(),
    },
  },
  {
    name: 'numbering_def',
    atom: true,
    selectable: false,
    spec: '03 §4.1',
    doc: 'A numbering definition with one to nine levels.',
    attrs: {
      id: attr(DEF_ID, null, 'Definition identifier.', { presence: 'required' }),
      name: attr(nullable(str(255)), null, 'Human-readable label.'),
      levels: attr(
        arr(LEVEL, 9, { minItems: 1 }),
        [],
        'Levels 0 to 8, at least one; one attribute, so concurrent edits resolve to the later commit (03 §4.1).',
        { presence: 'required' },
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'page_setup',
    atom: true,
    selectable: false,
    spec: '03 §4.1',
    doc: 'Page size, margins, columns and header and footer slots of a page section.',
    attrs: {
      id: attr(DEF_ID, null, 'Definition identifier.', { presence: 'required' }),
      width: attr(int(144, 31680), 11906, 'Page width in twips (default A4).'),
      height: attr(int(144, 31680), 16838, 'Page height in twips (default A4).'),
      orientation: attr(oneOf(['portrait', 'landscape']), 'portrait', 'Orientation.'),
      marginTop: attr(ULENGTH, 1440, 'Top margin.'),
      marginRight: attr(ULENGTH, 1440, 'Right margin.'),
      marginBottom: attr(ULENGTH, 1440, 'Bottom margin.'),
      marginLeft: attr(ULENGTH, 1440, 'Left margin.'),
      gutter: attr(ULENGTH, 0, 'Gutter.'),
      headerDistance: attr(ULENGTH, 708, 'Distance from the top edge to the header.'),
      footerDistance: attr(ULENGTH, 708, 'Distance from the bottom edge to the footer.'),
      columns: attr(int(1, 16), 1, 'Number of text columns.'),
      columnGap: attr(ULENGTH, 720, 'Gap between columns.'),
      differentFirstPage: attr(bool(), false, 'Use the first-page header and footer.'),
      differentOddEven: attr(bool(), false, 'Use the even-page header and footer.'),
      headerDefault: attr(nullable(ref('headerStory')), null, 'Header story.'),
      headerFirst: attr(nullable(ref('headerStory')), null, 'First-page header story.'),
      headerEven: attr(nullable(ref('headerStory')), null, 'Even-page header story.'),
      footerDefault: attr(nullable(ref('footerStory')), null, 'Footer story.'),
      footerFirst: attr(nullable(ref('footerStory')), null, 'First-page footer story.'),
      footerEven: attr(nullable(ref('footerStory')), null, 'Even-page footer story.'),
      pageNumberStart: attr(nullable(int(0, 32767)), null, 'First page number, or continue.'),
      pageNumberFormat: attr(oneOf(PAGE_NUMBER_FORMATS), 'decimal', 'Page number format.'),
      watermark: attr(nullable(str(255)), null, 'Watermark text.'),
      preserved: preserved(),
      ext: ext(),
    },
  },
  ROLE_DEF,
  RULE_DEF,
  SOURCE_DEF,
  {
    name: 'preserved_def',
    atom: true,
    selectable: false,
    feature: 'preserve',
    spec: '03 §4.6; ADR 0017; spike S11',
    doc: 'A preserved element tree shared by every node and mark that refers to it, kept once (spike S11: without it a large Word document exceeds the canonical size of I7).',
    attrs: {
      id: attr(DEF_ID, null, 'Identifier that `{ "ref": id }` trees refer to.', {
        presence: 'required',
      }),
      tree: attr(
        {
          kind: 'elementTree',
          maxBytes: PRESERVED_STYLE_BYTES,
          maxDepth: PRESERVED_DEPTH,
          noRef: true,
        },
        null,
        'The shared tree; it never refers to another.',
        { presence: 'required' },
      ),
      ext: ext(),
    },
  },
  {
    name: 'story',
    content: 'story_block+',
    isolating: true,
    selectable: false,
    allowGapCursor: false,
    spec: '03 §4.1',
    doc: 'A header or footer, edited in a sub-editor. Its content expression already forbids tables (I10).',
    attrs: {
      id: id(),
      kind: attr(oneOf(['header', 'footer']), 'header', 'Header or footer.'),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'body',
    content: '(block | region | section_break)+',
    spec: '03 §4.2',
    doc: 'The body.',
    attrs: {
      pageSetup: attr(ref('pageSetup'), null, 'Page setup of the first page section.', {
        presence: 'required',
      }),
      ext: ext(),
    },
  },
  {
    name: 'region',
    content: 'block+',
    isolating: true,
    spec: '03 §4.2',
    doc: 'A permission scope: a direct child of the body, never nested (I3).',
    attrs: {
      id: id('Region identifier; never reused once removed (I3).'),
      title: attr(nullable(str(255)), null, 'Region title.'),
      policy: attr(
        oneOf(REGION_POLICIES),
        'inherit',
        'Permission policy (07 §4); `confidential` also hides the content from readers without a grant (ADR 0019, proposed).',
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'section_break',
    atom: true,
    spec: '03 §4.2',
    doc: 'Starts a new page section; a direct child of the body only.',
    attrs: {
      id: id(),
      pageSetup: attr(ref('pageSetup'), null, 'Page setup of the section that follows.', {
        presence: 'required',
      }),
      start: attr(
        oneOf(['nextPage', 'continuous', 'evenPage', 'oddPage']),
        'nextPage',
        'Where the new section starts.',
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'paragraph',
    group: 'block story_block cell_block',
    content: 'inline*',
    spec: '03 §4.3',
    doc: 'A paragraph; headings and list items are paragraphs.',
    attrs: {
      id: id(),
      style: attr(
        nullable(ref('paragraphStyle')),
        null,
        'Paragraph style; null means the default paragraph style.',
      ),
      numbering: attr(
        nullable(NUMBERING),
        null,
        'List membership: definition, level and list instance.',
      ),
      numberingRestart: attr(nullable(int(0, 32767)), null, 'Restart the list at this number.'),
      ...paragraphProps(),
      suggest: suggestAttr(),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'table',
    group: 'block',
    content: 'table_row+',
    spec: '03 §4.3',
    doc: 'A table; tables do not nest in version 1.',
    attrs: {
      id: id(),
      style: attr(nullable(ref('tableStyle')), null, 'Table style.'),
      width: attr(
        nullable(
          obj(
            { type: oneOf(['auto', 'pct', 'fixed']), value: int(0, 31680) },
            { required: ['type', 'value'] },
          ),
        ),
        null,
        'Width: `pct` in hundredths of a percent, `fixed` in twips.',
      ),
      align: attr(nullable(oneOf(['start', 'center', 'end'])), null, 'Alignment.'),
      grid: attr(
        arr(ULENGTH, 63, { minItems: 1 }),
        null,
        'Column widths in twips (I6); at most 63 columns (I7).',
        { presence: 'required', reportAs: { count: 'I7' } },
      ),
      headerRows: attr(
        int(0, 32767),
        0,
        'Rows repeated at the top of each page; at most the number of rows (I6).',
      ),
      borders: attr(nullable(TABLE_BORDERS), null, 'Table borders.'),
      cellMargins: attr(nullable(MARGINS), null, 'Default cell margins.'),
      suggest: suggestAttr(),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'table_row',
    content: 'table_cell+',
    spec: '03 §4.3',
    doc: 'A table row.',
    attrs: {
      id: id(),
      height: attr(nullable(ULENGTH), null, 'Row height in twips.'),
      heightRule: attr(oneOf(['auto', 'atLeast', 'exact']), 'auto', 'How `height` applies.'),
      cantSplit: attr(bool(), false, 'Keep the row on one page.'),
      suggest: suggestAttr(),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'table_cell',
    content: 'cell_block+',
    isolating: true,
    spec: '03 §4.3',
    doc: 'A table cell.',
    attrs: {
      id: id(),
      colspan: attr(int(1, 63), 1, 'Columns spanned.'),
      rowspan: attr(int(1, 32767), 1, 'Rows spanned.'),
      vAlign: attr(nullable(oneOf(['top', 'center', 'bottom'])), null, 'Vertical alignment.'),
      shading: attr(nullable(SHADING), null, 'Cell shading.'),
      borders: attr(nullable(CELL_BORDERS), null, 'Cell borders.'),
      margins: attr(nullable(MARGINS), null, 'Cell margins.'),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'figure',
    group: 'block story_block cell_block',
    content: 'caption?',
    spec: '03 §4.3',
    doc: 'A block picture with an optional caption.',
    attrs: {
      id: id(),
      asset: attr(ref('asset'), null, 'Asset identifier; never embedded data.', {
        presence: 'required',
      }),
      width: attr(int(1, 31680), null, 'Display width in twips.', { presence: 'required' }),
      height: attr(int(1, 31680), null, 'Display height in twips.', { presence: 'required' }),
      alt: attr(nullable(TEXT), null, 'Alternative text.'),
      align: attr(nullable(oneOf(['start', 'center', 'end'])), null, 'Alignment.'),
      placement: attr(
        oneOf(['here', 'float']),
        'here',
        '`float` is not allowed in table cells (I10).',
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'caption',
    content: 'caption_inline*',
    spec: '03 §4.3',
    doc: 'A figure caption; footnotes are not allowed in it (I10).',
    attrs: { ext: ext() },
  },
  {
    name: 'equation_block',
    group: 'block story_block cell_block',
    atom: true,
    spec: '03 §4.3',
    doc: 'Display math, stored as LaTeX.',
    attrs: {
      id: id(),
      latex: attr(
        str(4000),
        '',
        'LaTeX source of at most 4,000 characters (I7); passes the math gate (I8).',
        {
          reportAs: { length: 'I7' },
        },
      ),
      numbered: attr(bool(), false, 'Numbered equation.'),
      label: attr(
        nullable(str(64, { pattern: EQUATION_LABEL_PATTERN })),
        null,
        'Label for cross-references; unique in the document.',
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  {
    name: 'toc',
    group: 'block story_block',
    atom: true,
    spec: '03 §4.3',
    doc: 'A table of contents or a list of figures or tables; entries are generated.',
    attrs: {
      id: id(),
      minLevel: attr(int(1, 9), 1, 'Lowest outline level included; at most `maxLevel`.'),
      maxLevel: attr(int(1, 9), 3, 'Highest outline level included.'),
      of: attr(
        str(32, { pattern: TOC_OF_PATTERN }),
        'headings',
        '`headings`, or a caption sequence name.',
      ),
      preserved: preserved(),
      ext: ext(),
    },
  },
  BIBLIOGRAPHY,
  {
    name: 'extension_block',
    group: 'block story_block',
    atom: true,
    feature: 'extensions',
    spec: '03 §4.3; 13 §7.3',
    doc: 'A host-registered custom block; it has a fallback picture or text, or both (I12).',
    attrs: {
      id: id(),
      extension: attr(str(128, { pattern: EXTENSION_NAME_PATTERN }), null, 'Extension name.', {
        presence: 'required',
        reportAs: ENVELOPE,
      }),
      payload: attr(
        { kind: 'json', maxBytes: 16384, maxDepth: 32, nullable: true },
        null,
        'Extension data, at most 16 KiB (I12); never interpreted by the model.',
        { reportAs: ENVELOPE },
      ),
      fallbackAsset: attr(nullable(ref('asset')), null, 'Fallback picture.', {
        reportAs: ENVELOPE,
      }),
      fallbackText: attr(nullable(TEXT), null, 'Fallback text.', { reportAs: ENVELOPE }),
      ext: ext(),
    },
  },
  {
    name: 'preserved_block',
    group: 'block story_block cell_block',
    atom: true,
    feature: 'preserve',
    spec: '03 §4.6; ADR 0017',
    doc: 'Content from an imported file that the model cannot represent; changed only as a whole.',
    attrs: {
      id: id(),
      label: attr(str(64, { minLength: 1 }), null, 'Kind of content, for example "chart".', {
        presence: 'required',
      }),
      fragment: attr(ref('asset'), null, 'Asset holding the original XML and its parts.', {
        presence: 'required',
      }),
      fallbackAsset: attr(nullable(ref('asset')), null, 'Fallback picture.'),
      fallbackText: attr(nullable(TEXT), null, 'Fallback text.'),
      width: attr(nullable(ULENGTH), null, 'Display width in twips.'),
      height: attr(nullable(ULENGTH), null, 'Display height in twips.'),
      ext: ext(),
    },
  },
  {
    name: 'text',
    group: 'inline caption_inline',
    inline: true,
    attrs: {},
    spec: '03 §4.4',
    doc: 'Text; carries marks.',
  },
  {
    name: 'image',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    spec: '03 §4.4',
    doc: 'An inline picture.',
    attrs: {
      asset: attr(ref('asset'), null, 'Asset identifier; never embedded data.', {
        presence: 'required',
      }),
      width: attr(int(1, 31680), null, 'Display width in twips.', { presence: 'required' }),
      height: attr(int(1, 31680), null, 'Display height in twips.', { presence: 'required' }),
      alt: attr(nullable(TEXT), null, 'Alternative text.'),
      preserved: preserved(),
      origin: origin(),
      ext: ext(),
    },
  },
  {
    name: 'break',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    spec: '03 §4.4',
    doc: 'A line, page or column break; page and column breaks are not allowed in cells, captions or footnotes (I10).',
    attrs: { kind: attr(oneOf(['line', 'page', 'column']), 'line', 'Break kind.'), ext: ext() },
  },
  {
    name: 'tab',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    attrs: { ext: ext() },
    spec: '03 §4.4',
    doc: 'A tab character.',
  },
  {
    name: 'equation',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    spec: '03 §4.4',
    doc: 'Inline math, stored as LaTeX.',
    attrs: {
      latex: attr(
        str(4000),
        '',
        'LaTeX source of at most 4,000 characters (I7); passes the math gate (I8).',
        {
          reportAs: { length: 'I7' },
        },
      ),
      preserved: preserved(),
      origin: origin(),
      ext: ext(),
    },
  },
  {
    name: 'footnote',
    group: 'inline',
    inline: true,
    atom: true,
    content: 'paragraph+',
    spec: '03 §4.4; CDM-001',
    doc: 'A footnote: an atom in the flow whose content is paragraphs, exactly one in version 1 (CDM-001). Footnotes, form fields, tables, and page and column breaks are not allowed in it (I10).',
    attrs: { id: id(), preserved: preserved(), origin: origin(), ext: ext() },
  },
  {
    name: 'field',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    spec: '03 §4.4; 12 §3.4',
    doc: 'A computed field.',
    attrs: {
      kind: attr(oneOf(FIELD_NODE_KINDS), 'page', 'Field kind; `formValue` belongs to `fields`.', {
        valueFeatures: { formValue: 'fields' },
      }),
      format: attr(nullable(str(64, { pattern: FIELD_FORMAT_PATTERN })), null, 'Display format.'),
      target: attr(
        nullable(str(160, { pattern: FIELD_TARGET_PATTERN })),
        null,
        'What `ref`, `styleRef` and `formValue` point at, in the form of their kind (CDM-002); null for the other kinds.',
      ),
      name: attr(
        nullable(str(32, { pattern: SEQUENCE_NAME_PATTERN })),
        null,
        'Sequence name of a `seq` field (without one it counts in no sequence); null for the other kinds.',
      ),
      cached: attr(
        nullable(str(1024)),
        null,
        'Last computed text for consumers that cannot compute it.',
      ),
      preserved: preserved(),
      origin: origin(),
      ext: ext(),
    },
  },
  CITATION,
  {
    name: 'anchor',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    spec: '03 §4.4',
    doc: 'A zero-width bookmark.',
    attrs: {
      id: id(),
      name: attr(
        str(40, { pattern: BOOKMARK_NAME_PATTERN }),
        null,
        'Bookmark name; unique in the document.',
        { presence: 'required' },
      ),
      origin: origin(),
      ext: ext(),
    },
  },
  FORM_FIELD,
  {
    name: 'extension_inline',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    feature: 'extensions',
    spec: '03 §4.4',
    doc: 'A host-registered inline atom with a fallback text (I12).',
    attrs: {
      extension: attr(str(128, { pattern: EXTENSION_NAME_PATTERN }), null, 'Extension name.', {
        presence: 'required',
        reportAs: ENVELOPE,
      }),
      payload: attr(
        { kind: 'json', maxBytes: 4096, maxDepth: 16, nullable: true },
        null,
        'Extension data, at most 4 KiB (CDM-002); never interpreted by the model.',
        { reportAs: ENVELOPE },
      ),
      fallbackText: attr(nullable(TEXT), null, 'Fallback text; required in a stored document.', {
        reportAs: ENVELOPE,
      }),
      ext: ext(),
    },
  },
  {
    name: 'preserved_inline',
    group: 'inline caption_inline',
    inline: true,
    atom: true,
    feature: 'preserve',
    spec: '03 §4.6; ADR 0017',
    doc: 'Inline content from an imported file that the model cannot represent; changed only as a whole. It holds a fragment asset, or for a small marker without relationships an element tree (spike S11).',
    attrs: {
      label: attr(str(64, { minLength: 1 }), null, 'Kind of content, for example "text box".', {
        presence: 'required',
      }),
      fragment: attr(
        nullable(ref('asset')),
        null,
        'Asset holding the original XML and its parts; or null when `tree` holds a small marker.',
      ),
      tree: attr(
        {
          kind: 'elementTree',
          maxBytes: PRESERVED_BYTES,
          maxDepth: PRESERVED_DEPTH,
          nullable: true,
        },
        null,
        'The original element of a small marker without relationships, such as a bookmark Word alone uses (spike S11).',
      ),
      fallbackAsset: attr(nullable(ref('asset')), null, 'Fallback picture.'),
      fallbackText: attr(nullable(TEXT), null, 'Fallback text.'),
      width: attr(nullable(ULENGTH), null, 'Display width in twips.'),
      height: attr(nullable(ULENGTH), null, 'Display height in twips.'),
      ext: ext(),
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Marks, in schema order. The order is part of the canonical form (03 §2).

const toggle = (name: string, doc: string): MarkDef => ({
  name,
  spec: '03 §5',
  doc,
  attrs: {
    value: attr(bool(), true, '`false` switches the property off where the style switches it on.'),
    ext: ext(),
  },
});
const valued = (name: string, grammar: Grammar, doc: string): MarkDef => ({
  name,
  spec: '03 §5',
  doc,
  attrs: { value: attr(grammar, null, doc, { presence: 'required' }), ext: ext() },
});
const suggestion = (name: string, doc: string, extra: Record<string, AttrDef> = {}): MarkDef => ({
  name,
  spec: '03 §5',
  doc,
  excludes: '',
  inclusive: false,
  attrs: {
    id: attr(NODE_ID, null, 'Suggestion identifier; belongs to the user who first used it (P4).', {
      presence: 'required',
    }),
    user: attr(USER, null, 'The suggesting user; must equal the submitting user (P4).', {
      presence: 'required',
    }),
    ...extra,
    ext: ext(),
  },
});

const marks: MarkDef[] = [
  {
    name: 'link',
    spec: '03 §5',
    doc: 'A hyperlink; schemes are restricted (I9).',
    inclusive: false,
    attrs: {
      href: attr(
        str(2048, { pattern: LINK_HREF_PATTERN }),
        null,
        'http, https, mailto or an in-document target (I9).',
        { presence: 'required', reportAs: { pattern: 'I9' } },
      ),
      title: attr(nullable(str(255)), null, 'Title.'),
      ext: ext(),
    },
  },
  {
    name: 'charStyle',
    spec: '03 §5',
    doc: 'Reference to a character style.',
    attrs: {
      style: attr(ref('characterStyle'), null, 'Character style identifier.', {
        presence: 'required',
      }),
      ext: ext(),
    },
  },
  toggle('bold', 'Bold.'),
  toggle('italic', 'Italic.'),
  {
    name: 'underline',
    spec: '03 §5',
    doc: 'Underline.',
    attrs: {
      style: attr(oneOf(['single', 'double', 'dotted', 'none']), 'single', 'Underline style.'),
      ext: ext(),
    },
  },
  toggle('strike', 'Strikethrough.'),
  toggle('smallCaps', 'Small capitals.'),
  toggle('allCaps', 'All capitals.'),
  valued('vertAlign', oneOf(['super', 'sub', 'baseline']), 'Superscript or subscript.'),
  valued('fontFamily', str(64, { pattern: FONT_FAMILY_PATTERN }), 'Font family from the manifest.'),
  valued('fontSize', FONT_SIZE, 'Font size in twips.'),
  valued('color', COLOUR, 'Text colour.'),
  valued('highlight', oneOf(HIGHLIGHT_VALUES), 'Highlight colour.'),
  valued('lang', LANG, 'Language of the text.'),
  toggle('hidden', 'Hidden text.'),
  {
    name: 'preserved',
    feature: 'preserve',
    spec: '03 §4.6; ADR 0017',
    doc: 'Run properties of the original file that the model does not represent.',
    attrs: {
      props: attr(
        { kind: 'elementTree', maxBytes: PRESERVED_BYTES, maxDepth: PRESERVED_DEPTH },
        null,
        'Element tree (ADR 0017).',
        { presence: 'required' },
      ),
      ext: ext(),
    },
  },
  suggestion('ins', 'Suggested insertion.'),
  suggestion('del', 'Suggested deletion; the text stays until accepted.'),
  suggestion('fmt', 'Suggested formatting change.', {
    before: attr(
      { kind: 'json', maxBytes: 4096, maxDepth: 6 },
      null,
      'Previous state: `{ "marks": [mark JSON], "attrs": { name: value } }` (CDM-002); on a block, `attrs` names only `style`, `align` and `numbering` (CDM-040).',
      { presence: 'required' },
    ),
  }),
];

/** Node types that may carry block suggestions in their suggest attribute (03 §5). */
export const SUGGESTION_HOSTS: readonly string[] = ['paragraph', 'table_row', 'table'];
/** The attributes a block-level `fmt` suggestion may record in `before` (03 §5; CDM-040). */
export const BLOCK_FORMAT_ATTRIBUTES: readonly string[] = ['style', 'align', 'numbering'];
/** Node types whose content is checked by I10 for page and column breaks. */
export const NO_PAGE_BREAK_CONTAINERS: readonly string[] = [
  'table_cell',
  'caption',
  ...ELEMENT_ATOM,
];

export const CDM1: CdmDefinition = {
  cdm: 1,
  status: 'draft',
  topNode: 'doc',
  features: [
    { name: 'fields', doc: 'Fillable fields, role placeholders and rules (12 §3).' },
    { name: 'extensions', doc: 'Host-registered extension nodes (13 §7.3).' },
    {
      name: 'preserve',
      doc: 'Content and properties preserved from an imported Word file (ADR 0017).',
    },
  ],
  nodes,
  marks,
  projection: [HIDDEN_REGION],
};
