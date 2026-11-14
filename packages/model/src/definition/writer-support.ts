/**
 * Writer support as data (03 §1 principle 4, §10; CDM-046): for every node type, mark, `field`
 * kind and page-setup feature of the definition, what the LaTeX (PDF) writer and the DOCX writer
 * do with it. A construct enters the model only when LaTeX can typeset it and DOCX can approximate
 * it, so no entry says "no". The published table spec/cdm/cdm-1.writer-support.md is generated
 * from this data; the converters' preflight reads it (EXP-002, EXP-042).
 *
 * Rows that 03 §10 does not give (marked `proposed`) are a maintainer's proposal recorded in
 * docs/adr/0031-cdm-1-model-completion.md, for the owners of the writers (EXP) to confirm.
 */
import { CDM1, FIELD_NODE_KINDS } from './cdm1.ts';
import type { CdmDefinition } from './grammar.ts';

/** What a writer does with a construct. "No" is not a value: principle 4 forbids it. */
export type SupportLevel = 'supported' | 'partial' | 'fallback' | 'notApplicable';
export const SUPPORT_LEVELS: readonly SupportLevel[] = [
  'supported',
  'partial',
  'fallback',
  'notApplicable',
];

export interface WriterSupport {
  latex: SupportLevel;
  docx: SupportLevel;
  /** Limits and behaviour, as 03 §10 states them. */
  notes?: readonly string[];
  /** The 03 §10 row the entry comes from, or `proposed` when 03 §10 has none. */
  source: string;
}

/** Page-setup features: groups of `page_setup` attributes that a writer supports together. */
export const PAGE_SETUP_FEATURES: Readonly<Record<string, readonly string[]>> = {
  size: ['width', 'height'],
  orientation: ['orientation'],
  margins: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  gutter: ['gutter'],
  headerFooterDistance: ['headerDistance', 'footerDistance'],
  columns: ['columns', 'columnGap'],
  differentFirstPage: ['differentFirstPage'],
  differentOddEven: ['differentOddEven'],
  headerFooterStories: [
    'headerDefault',
    'headerFirst',
    'headerEven',
    'footerDefault',
    'footerFirst',
    'footerEven',
  ],
  pageNumbering: ['pageNumberStart', 'pageNumberFormat'],
  watermark: ['watermark'],
};

const S = 'supported' as const;
const P = 'partial' as const;
const F = 'fallback' as const;
const NA = 'notApplicable' as const;

const STYLES = 'Named styles, direct formatting, fonts, colours';
const TABLES = 'Tables with spans, borders, shading, repeated header rows';
const TABLE_NOTES = [
  'Three table writers in LaTeX (09 §3.2).',
  'A row taller than a page is split by the converter at paragraph boundaries.',
  'Tables inside multi-column sections, headers and footnotes cannot span pages.',
];
const SECTIONS = 'Page sections with their own size, orientation and columns';
const HEADERS = 'Headers and footers, first and even pages, page fields';
const REFERENCES = 'Table of contents, lists of figures and tables, bookmarks, cross-references';
const MATH = 'Math';
const MATH_NOTES = [
  'DOCX export converts LaTeX to Office math on the server; unsupported macros fall back to an image.',
];
const SUGGESTIONS = 'Comments and suggestions';
const PRESERVED = 'Preserved content (03 §4.6)';
const PRESERVED_NOTES = [
  'The LaTeX writer typesets the fallback; the DOCX writer writes the original back unchanged (A2).',
];
const CITATIONS = 'proposed (CDM-052)';
const CITATION_NOTES = [
  'LaTeX: biblatex in the house class style chosen by `settings.citationStyle`.',
  'DOCX: Word citations and the sources part; Word renders them in its own styles.',
];

/** Support by node type. */
export const NODE_SUPPORT: Readonly<Record<string, WriterSupport>> = {
  doc: { latex: S, docx: S, source: 'structure' },
  defs: { latex: S, docx: S, source: 'structure' },
  settings: { latex: S, docx: S, source: STYLES },
  style_def: {
    latex: S,
    docx: S,
    notes: ['LaTeX uses macros generated from the styles.'],
    source: STYLES,
  },
  numbering_def: {
    latex: S,
    docx: S,
    notes: ['Literal labels from the shared algorithm.'],
    source: 'Multi-level numbering',
  },
  page_setup: { latex: P, docx: S, source: SECTIONS },
  role_def: {
    latex: NA,
    docx: S,
    notes: ['Roles do not print; DOCX keeps assignees in a custom part (12 §12).'],
    source: 'Form fields',
  },
  rule_def: {
    latex: NA,
    docx: S,
    notes: ['Rules do not print; DOCX keeps them in a custom part (12 §12).'],
    source: 'Form fields',
  },
  source_def: { latex: S, docx: P, notes: CITATION_NOTES, source: CITATIONS },
  preserved_def: {
    latex: NA,
    docx: S,
    notes: [
      'A shared preserved tree prints nothing; the DOCX writer writes it back where it is referred to.',
    ],
    source: PRESERVED,
  },
  story: { latex: S, docx: S, source: HEADERS },
  body: { latex: S, docx: S, source: 'structure' },
  region: {
    latex: NA,
    docx: S,
    notes: ['Not visible in the PDF; content controls plus editable ranges in DOCX (07).'],
    source: 'Regions',
  },
  section_break: {
    latex: P,
    docx: S,
    notes: [
      'Orientation and margin changes force a page break in LaTeX.',
      'A `continuous` break that changes margins is reported as unsupported.',
    ],
    source: SECTIONS,
  },
  paragraph: { latex: S, docx: S, source: STYLES },
  table: { latex: P, docx: S, notes: TABLE_NOTES, source: TABLES },
  table_row: { latex: P, docx: S, notes: TABLE_NOTES, source: TABLES },
  table_cell: { latex: P, docx: S, notes: TABLE_NOTES, source: TABLES },
  figure: { latex: S, docx: S, source: 'Inline images and block figures with captions' },
  caption: { latex: S, docx: S, source: 'Inline images and block figures with captions' },
  equation_block: { latex: S, docx: P, notes: MATH_NOTES, source: MATH },
  toc: { latex: S, docx: S, source: REFERENCES },
  bibliography: { latex: S, docx: P, notes: CITATION_NOTES, source: CITATIONS },
  extension_block: { latex: F, docx: F, source: 'Extension nodes' },
  preserved_block: { latex: F, docx: S, notes: PRESERVED_NOTES, source: PRESERVED },
  text: { latex: S, docx: S, source: 'structure' },
  image: { latex: S, docx: S, source: 'Inline images and block figures with captions' },
  break: { latex: S, docx: S, source: 'proposed' },
  tab: {
    latex: P,
    docx: S,
    notes: [
      'The house class implements tab stops itself; decimal tabs inside justified text are approximate.',
    ],
    source: 'Tab stops',
  },
  equation: { latex: S, docx: P, notes: MATH_NOTES, source: MATH },
  footnote: { latex: S, docx: S, notes: ['One paragraph each in version 1.'], source: 'Footnotes' },
  field: { latex: S, docx: S, notes: ['See the support by field kind.'], source: HEADERS },
  citation: { latex: S, docx: P, notes: CITATION_NOTES, source: CITATIONS },
  anchor: { latex: S, docx: S, source: REFERENCES },
  form_field: {
    latex: P,
    docx: S,
    notes: [
      'PDF: values are flattened into the text and tagged with their labels; no live form fields (12 §12).',
      'DOCX: content controls with data binding (12 §12).',
    ],
    source: 'Form fields',
  },
  extension_inline: { latex: F, docx: F, source: 'Extension nodes' },
  preserved_inline: { latex: F, docx: S, notes: PRESERVED_NOTES, source: PRESERVED },
};

/** Support by mark. */
export const MARK_SUPPORT: Readonly<Record<string, WriterSupport>> = {
  link: {
    latex: S,
    docx: S,
    notes: ['The URL emitter applies the scheme allow-list again (09 §4).'],
    source: 'proposed',
  },
  charStyle: { latex: S, docx: S, source: STYLES },
  bold: { latex: S, docx: S, source: STYLES },
  italic: { latex: S, docx: S, source: STYLES },
  underline: { latex: S, docx: S, source: STYLES },
  strike: { latex: S, docx: S, source: STYLES },
  smallCaps: { latex: S, docx: S, source: 'proposed' },
  allCaps: { latex: S, docx: S, source: 'proposed' },
  vertAlign: { latex: S, docx: S, source: STYLES },
  fontFamily: { latex: S, docx: S, source: STYLES },
  fontSize: { latex: S, docx: S, source: STYLES },
  color: { latex: S, docx: S, source: STYLES },
  highlight: { latex: S, docx: S, source: STYLES },
  lang: { latex: S, docx: S, source: STYLES },
  hidden: {
    latex: S,
    docx: S,
    notes: ['Hidden text is left out of the PDF.'],
    source: 'proposed',
  },
  preserved: { latex: F, docx: S, notes: PRESERVED_NOTES, source: PRESERVED },
  ins: {
    latex: S,
    docx: S,
    notes: ['The PDF writer renders markup or a clean view (09).'],
    source: SUGGESTIONS,
  },
  del: {
    latex: S,
    docx: S,
    notes: ['The PDF writer renders markup or a clean view (09).'],
    source: SUGGESTIONS,
  },
  fmt: {
    latex: S,
    docx: S,
    notes: ['The PDF writer renders markup or a clean view (09).'],
    source: SUGGESTIONS,
  },
};

/** Support by kind of the `field` node. */
export const FIELD_KIND_SUPPORT: Readonly<Record<string, WriterSupport>> = {
  page: {
    latex: S,
    docx: S,
    notes: ['Only the typesetter knows page numbers (03 §7).'],
    source: HEADERS,
  },
  pageCount: { latex: S, docx: S, source: HEADERS },
  date: {
    latex: S,
    docx: S,
    notes: ["In the time zone of the export job or workflow, never the client's (03 §7)."],
    source: 'proposed',
  },
  title: {
    latex: S,
    docx: S,
    notes: ['The title is control-plane metadata (03 §2); the export job supplies it.'],
    source: 'proposed',
  },
  ref: {
    latex: S,
    docx: S,
    notes: ['Prints the computed label as literal text (03 §7).'],
    source: REFERENCES,
  },
  styleRef: { latex: P, docx: S, source: 'proposed' },
  seq: {
    latex: S,
    docx: S,
    notes: ['Prints the computed label as literal text (03 §7).'],
    source: REFERENCES,
  },
  formValue: {
    latex: S,
    docx: S,
    notes: ['Prints the value of the target field; nothing when it is empty (FRW-006).'],
    source: 'Form fields',
  },
};

/** Support by page-setup feature (PAGE_SETUP_FEATURES). */
export const PAGE_SETUP_SUPPORT: Readonly<Record<string, WriterSupport>> = {
  size: {
    latex: P,
    docx: S,
    notes: ['A change of size at a section break forces a page break in LaTeX.'],
    source: SECTIONS,
  },
  orientation: {
    latex: P,
    docx: S,
    notes: ['Orientation changes force a page break in LaTeX.'],
    source: SECTIONS,
  },
  margins: {
    latex: P,
    docx: S,
    notes: [
      'Margin changes force a page break in LaTeX.',
      'A `continuous` break that changes margins is reported as unsupported.',
    ],
    source: SECTIONS,
  },
  gutter: { latex: S, docx: S, source: 'proposed' },
  headerFooterDistance: { latex: S, docx: S, source: HEADERS },
  columns: {
    latex: P,
    docx: S,
    notes: ['Tables inside multi-column sections cannot span pages.'],
    source: SECTIONS,
  },
  differentFirstPage: { latex: S, docx: S, source: HEADERS },
  differentOddEven: { latex: S, docx: S, source: HEADERS },
  headerFooterStories: { latex: S, docx: S, source: HEADERS },
  pageNumbering: { latex: S, docx: S, source: 'proposed' },
  watermark: { latex: S, docx: S, source: 'proposed' },
};

/** Every construct of a definition that lacks an entry, or whose entry is not allowed (CDM-046). */
export function writerSupportProblems(def: CdmDefinition = CDM1): string[] {
  const problems: string[] = [];
  const check = (what: string, s: WriterSupport | undefined) => {
    if (!s) return void problems.push(`${what}: no writer-support entry`);
    for (const w of ['latex', 'docx'] as const)
      if (!SUPPORT_LEVELS.includes(s[w]))
        problems.push(`${what}: ${w} support "${String(s[w])}" is not allowed (03 §1 principle 4)`);
  };
  const own = <T>(rec: Readonly<Record<string, T>>, key: string): T | undefined =>
    Object.hasOwn(rec, key) ? rec[key] : undefined;
  for (const n of def.nodes) check(`node ${n.name}`, own(NODE_SUPPORT, n.name));
  for (const m of def.marks) check(`mark ${m.name}`, own(MARK_SUPPORT, m.name));
  const fieldKinds = def.nodes.find((n) => n.name === 'field')?.attrs['kind']?.grammar;
  const kinds = fieldKinds?.kind === 'enum' ? fieldKinds.values : FIELD_NODE_KINDS;
  for (const k of kinds) check(`field kind ${k}`, own(FIELD_KIND_SUPPORT, k));
  const covered = new Set(Object.values(PAGE_SETUP_FEATURES).flat());
  const pageSetup = def.nodes.find((n) => n.name === 'page_setup');
  for (const a of Object.keys(pageSetup?.attrs ?? {}))
    if (!['id', 'preserved', 'ext'].includes(a) && !covered.has(a))
      problems.push(`page_setup.${a}: in no page-setup feature`);
  for (const f of Object.keys(PAGE_SETUP_FEATURES))
    check(`page-setup feature ${f}`, own(PAGE_SETUP_SUPPORT, f));
  for (const [table, rec] of [
    ['node', NODE_SUPPORT],
    ['mark', MARK_SUPPORT],
  ] as const)
    for (const name of Object.keys(rec))
      if (!(table === 'node' ? def.nodes : def.marks).some((x) => x.name === name))
        problems.push(`${table} ${name}: entry for a construct the definition does not have`);
  return problems;
}
