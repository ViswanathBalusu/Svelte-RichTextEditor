/**
 * OOXML names the importer and the writer need: namespaces, relationship types, the schema order
 * of the property containers the writer regenerates (ECMA-376 Part 1, transitional schema), and the
 * element classes the preservation layer treats specially (ADR 0017).
 */
import { pname } from './names.ts';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  pr: 'http://schemas.openxmlformats.org/package/2006/relationships',
  xml: 'http://www.w3.org/XML/1998/namespace',
} as const;

const R_TYPES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

export const REL = {
  officeDocument: `${R_TYPES}officeDocument`,
  styles: `${R_TYPES}styles`,
  theme: `${R_TYPES}theme`,
  settings: `${R_TYPES}settings`,
  numbering: `${R_TYPES}numbering`,
  fontTable: `${R_TYPES}fontTable`,
  footnotes: `${R_TYPES}footnotes`,
  endnotes: `${R_TYPES}endnotes`,
  comments: `${R_TYPES}comments`,
  header: `${R_TYPES}header`,
  footer: `${R_TYPES}footer`,
  image: `${R_TYPES}image`,
  hyperlink: `${R_TYPES}hyperlink`,
  customXml: `${R_TYPES}customXml`,
  customXmlProps: `${R_TYPES}customXmlProps`,
  coreProperties:
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties: `${R_TYPES}extended-properties`,
  bibliography: `${R_TYPES}bibliography`,
} as const;

/**
 * Relationship types whose target belongs to one reference: a copy of the content that refers to
 * it needs its own copy of the part (EXP-119). Pictures and hyperlinks may be shared.
 */
export const UNIQUE_TARGET_TYPES: ReadonlySet<string> = new Set([
  `${R_TYPES}chart`,
  'http://schemas.microsoft.com/office/2014/relationships/chartEx',
  `${R_TYPES}diagramData`,
  `${R_TYPES}diagramLayout`,
  `${R_TYPES}diagramQuickStyle`,
  `${R_TYPES}diagramColors`,
  'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing',
  `${R_TYPES}oleObject`,
  `${R_TYPES}package`,
  `${R_TYPES}control`,
  `${R_TYPES}customXml`,
  'http://schemas.microsoft.com/office/2011/relationships/chartStyle',
  'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle',
  `${R_TYPES}chartUserShapes`,
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps',
  `${R_TYPES}themeOverride`,
  'http://schemas.microsoft.com/office/2007/relationships/hdphoto',
  `${R_TYPES}video`,
  `${R_TYPES}audio`,
  'http://schemas.microsoft.com/office/2007/relationships/media',
  'http://schemas.microsoft.com/office/2011/relationships/inkAction',
  `${R_TYPES}customXmlData`,
]);

export const MACRO_MAIN_CONTENT_TYPE = 'application/vnd.ms-word.document.macroEnabled.main+xml';
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const w = (local: string): string => pname(NS.w, local);

/** Attributes whose values identify an element or an editing session. They are kept only through the source map (ADR 0017, part 1), so copies never duplicate them. */
export const IDENTITY_ATTRS: ReadonlySet<string> = new Set([
  w('rsidR'),
  w('rsidRDefault'),
  w('rsidP'),
  w('rsidRPr'),
  w('rsidDel'),
  w('rsidSect'),
  w('rsidTr'),
  pname(NS.w14, 'paraId'),
  pname(NS.w14, 'textId'),
]);

/** Identity-bound child elements of definitions (the revision session of a style), kept in the source map too. */
export const IDENTITY_ELEMENTS: ReadonlySet<string> = new Set([w('rsid')]);

/**
 * Run content (ECMA-376 Part 1 §17.3.3, EG_RunInnerContent, plus `mc:AlternateContent`): an atom
 * made from one of these is written inside a `w:r` whose properties come from the atom's marks.
 */
export const RUN_CONTENT: ReadonlySet<string> = new Set([
  ...[
    'br',
    't',
    'contentPart',
    'delText',
    'instrText',
    'delInstrText',
    'noBreakHyphen',
    'softHyphen',
    'dayShort',
    'monthShort',
    'yearShort',
    'dayLong',
    'monthLong',
    'yearLong',
    'annotationRef',
    'footnoteRef',
    'endnoteRef',
    'separator',
    'continuationSeparator',
    'sym',
    'pgNum',
    'cr',
    'tab',
    'object',
    'pict',
    'fldChar',
    'ruby',
    'footnoteReference',
    'endnoteReference',
    'commentReference',
    'drawing',
    'ptab',
    'lastRenderedPageBreak',
  ].map(w),
  pname(NS.mc, 'AlternateContent'),
]);

/**
 * Small content that refers to no relationship and is kept as the element tree of a
 * `preserved_inline` instead of a fragment asset (spike S11, model change 7): markers, field
 * characters and codes, and references to notes and comments.
 */
export const SMALL_ATOMS: ReadonlySet<string> = new Set([
  ...[
    'bookmarkStart',
    'bookmarkEnd',
    'commentRangeStart',
    'commentRangeEnd',
    'permStart',
    'permEnd',
    'fldChar',
    'instrText',
    'delInstrText',
    'commentReference',
    'footnoteReference',
    'endnoteReference',
    'annotationRef',
    'footnoteRef',
    'endnoteRef',
    'separator',
    'continuationSeparator',
    'sym',
    'ptab',
    'noBreakHyphen',
    'softHyphen',
    'cr',
    'pgNum',
    'dayShort',
    'monthShort',
    'yearShort',
    'dayLong',
    'monthLong',
    'yearLong',
    'br',
    'tab',
  ].map(w),
]);

/**
 * Revisions the model cannot express (owner decision 13, default: preserve the paragraph). A
 * paragraph holding one becomes a `preserved_block`; a table whose own properties hold one, a
 * `preserved_block` too. Insertions and deletions of runs and of whole rows are expressed as
 * suggestion marks instead.
 */
export const INEXPRESSIBLE_REVISIONS: ReadonlySet<string> = new Set(
  [
    'moveFrom',
    'moveTo',
    'moveFromRangeStart',
    'moveFromRangeEnd',
    'moveToRangeStart',
    'moveToRangeEnd',
    'customXmlInsRangeStart',
    'customXmlInsRangeEnd',
    'customXmlDelRangeStart',
    'customXmlDelRangeEnd',
    'customXmlMoveFromRangeStart',
    'customXmlMoveFromRangeEnd',
    'customXmlMoveToRangeStart',
    'customXmlMoveToRangeEnd',
    'pPrChange',
    'rPrChange',
    'sectPrChange',
    'tblPrChange',
    'tblPrExChange',
    'trPrChange',
    'tcPrChange',
    'tblGridChange',
    'numberingChange',
    'cellIns',
    'cellDel',
    'cellMerge',
  ].map(w),
);

/** Zero-width markers. Between blocks they are kept as gaps of the container (source map); inside a paragraph they become preserved inline atoms. */
export const MARKERS: ReadonlySet<string> = new Set(
  [
    'bookmarkStart',
    'bookmarkEnd',
    'commentRangeStart',
    'commentRangeEnd',
    'permStart',
    'permEnd',
    'moveFromRangeStart',
    'moveFromRangeEnd',
    'moveToRangeStart',
    'moveToRangeEnd',
    'customXmlInsRangeStart',
    'customXmlInsRangeEnd',
    'customXmlDelRangeStart',
    'customXmlDelRangeEnd',
    'customXmlMoveFromRangeStart',
    'customXmlMoveFromRangeEnd',
    'customXmlMoveToRangeStart',
    'customXmlMoveToRangeEnd',
    'proofErr',
  ].map(w),
);

/**
 * Elements dropped on purpose when the element that holds them is regenerated, because Word
 * regenerates them itself (ADR 0017, open question "Regenerated elements"; S11 report §6). They
 * survive in every element that is copied verbatim.
 */
export const REGENERATED: ReadonlySet<string> = new Set([
  w('proofErr'),
  w('lastRenderedPageBreak'),
]);

// Schema order of the containers the writer regenerates (ECMA-376 Part 1 §17, transitional).

export const PPR_ORDER = [
  'pStyle',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'framePr',
  'widowControl',
  'numPr',
  'suppressLineNumbers',
  'pBdr',
  'shd',
  'tabs',
  'suppressAutoHyphens',
  'kinsoku',
  'wordWrap',
  'overflowPunct',
  'topLinePunct',
  'autoSpaceDE',
  'autoSpaceDN',
  'bidi',
  'adjustRightInd',
  'snapToGrid',
  'spacing',
  'ind',
  'contextualSpacing',
  'mirrorIndents',
  'suppressOverlap',
  'jc',
  'textDirection',
  'textAlignment',
  'textboxTightWrap',
  'outlineLvl',
  'divId',
  'cnfStyle',
  'rPr',
  'sectPr',
  'pPrChange',
].map(w);

export const RPR_ORDER = [
  ...[
    'ins',
    'del',
    'moveFrom',
    'moveTo',
    'rStyle',
    'rFonts',
    'b',
    'bCs',
    'i',
    'iCs',
    'caps',
    'smallCaps',
    'strike',
    'dstrike',
    'outline',
    'shadow',
    'emboss',
    'imprint',
    'noProof',
    'snapToGrid',
    'vanish',
    'webHidden',
    'color',
    'spacing',
    'w',
    'kern',
    'position',
    'sz',
    'szCs',
    'highlight',
    'u',
    'effect',
    'bdr',
    'shd',
    'fitText',
    'vertAlign',
    'rtl',
    'cs',
    'em',
    'lang',
    'eastAsianLayout',
    'specVanish',
    'oMath',
  ].map(w),
  ...[
    'glow',
    'shadow',
    'reflection',
    'textOutline',
    'textFill',
    'scene3d',
    'props3d',
    'ligatures',
    'numForm',
    'numSpacing',
    'stylisticSets',
    'cntxtAlts',
  ].map((l) => pname(NS.w14, l)),
  w('rPrChange'),
];

export const SECTPR_ORDER = [
  'headerReference',
  'footerReference',
  'footnotePr',
  'endnotePr',
  'type',
  'pgSz',
  'pgMar',
  'paperSrc',
  'pgBorders',
  'lnNumType',
  'pgNumType',
  'cols',
  'formProt',
  'vAlign',
  'noEndnote',
  'titlePg',
  'textDirection',
  'bidi',
  'rtlGutter',
  'docGrid',
  'printerSettings',
  'sectPrChange',
].map(w);

export const TBLPR_ORDER = [
  'tblStyle',
  'tblpPr',
  'tblOverlap',
  'bidiVisual',
  'tblStyleRowBandSize',
  'tblStyleColBandSize',
  'tblW',
  'jc',
  'tblCellSpacing',
  'tblInd',
  'tblBorders',
  'shd',
  'tblLayout',
  'tblCellMar',
  'tblLook',
  'tblCaption',
  'tblDescription',
  'tblPrChange',
].map(w);

/** CT_TrPr is a choice, so any order is valid; Word's own order is used for new elements. */
export const TRPR_ORDER = [
  'cnfStyle',
  'divId',
  'gridBefore',
  'gridAfter',
  'wBefore',
  'wAfter',
  'cantSplit',
  'trHeight',
  'tblHeader',
  'tblCellSpacing',
  'jc',
  'hidden',
  'ins',
  'del',
  'trPrChange',
].map(w);

export const TCPR_ORDER = [
  'cnfStyle',
  'tcW',
  'gridSpan',
  'hMerge',
  'vMerge',
  'tcBorders',
  'shd',
  'noWrap',
  'tcMar',
  'textDirection',
  'tcFitText',
  'vAlign',
  'hideMark',
  'headers',
  'cellIns',
  'cellDel',
  'cellMerge',
  'tcPrChange',
].map(w);

export const STYLE_ORDER = [
  'name',
  'aliases',
  'basedOn',
  'next',
  'link',
  'autoRedefine',
  'hidden',
  'uiPriority',
  'semiHidden',
  'unhideWhenUsed',
  'qFormat',
  'locked',
  'personal',
  'personalCompose',
  'personalReply',
  'rsid',
  'pPr',
  'rPr',
  'tblPr',
  'trPr',
  'tcPr',
  'tblStylePr',
].map(w);

/** 1 twip = 635 EMU. */
export const EMU_PER_TWIP = 635;
