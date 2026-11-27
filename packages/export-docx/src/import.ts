/**
 * DOCX to CDM with the preservation layer (ADR 0017; EXP-099, EXP-116, EXP-117, EXP-107, EXP-109).
 *
 * What the importer models (R2): paragraphs with their style and paragraph properties, text with
 * run formatting marks, tabs and breaks, inline pictures, tracked insertions and deletions of runs
 * (text and inline atoms alike, CDM-051) and of whole rows, tables with a regular grid and header
 * rows, sections and their page setups, headers and footers, and styles. Everything else is
 * preserved: as residue in `preserved` (properties), as preserved atoms (content), or as gaps in the
 * source map (markers between blocks). Residues that repeat are shared through `preserved_def`.
 *
 * Owner decisions followed (docs/owner-decisions-pending.md, defaults until decided):
 * - 1: the original package, the source map and the fragments are server-only assets.
 * - 2: every preserved payload comes from here; their digests go into the source map.
 * - 12: active content is preserved and never run; nothing here parses or runs it.
 * - 13: a paragraph holding a revision the model cannot express (a move, a property change, a
 *   paragraph-mark revision) is preserved whole, and so is a table whose own properties hold one.
 */
import {
  BCP47_PATTERN,
  CANONICAL_FORM_VERSION,
  canonicalize,
  nodeId,
  sha256HexBytes,
  utf8,
  type JsonEnvelope,
  type JsonMark,
  type JsonNode,
} from '@docedit/model';
import {
  BUILT_IN_STYLES,
  CDM1,
  LINK_HREF_PATTERN,
  PRESERVED_STYLE_BYTES,
  indexDefinition,
  type JsonValue,
} from '@docedit/model/definition';
import { validate } from '@docedit/model/validate';
import {
  AssetStore,
  FRAGMENT_CONTENT_TYPE,
  SOURCE_MAP_CONTENT_TYPE,
  type FragmentMeta,
  buildFragment,
} from './assets.ts';
import { NodeHasher } from './hash.ts';
import { NumberingImport } from './import-numbering.ts';
import { importSources } from './import-sources.ts';
import { parseCitationInstruction, residualTree } from './writer-citations.ts';
import { payloadDigests } from './integrity.ts';
import { valuesToMarks } from './marks.ts';
import { pname } from './names.ts';
import {
  DOCX_CONTENT_TYPE,
  EMU_PER_TWIP,
  IDENTITY_ATTRS,
  IDENTITY_ELEMENTS,
  INEXPRESSIBLE_REVISIONS,
  MACRO_MAIN_CONTENT_TYPE,
  MARKERS,
  NS,
  REGENERATED,
  REL,
  RUN_CONTENT,
  SMALL_ATOMS,
  w,
} from './ooxml.ts';
import {
  type ContentTypes,
  type Relationship,
  type Relationships,
  contentTypeOf,
  parseContentTypes,
  parseRelationships,
  referencedRelIds,
  relsPartName,
  resolveTarget,
} from './opc.ts';
import { modelledHash } from './origin.ts';
import {
  type FontManifestEntry,
  type FontSubstitution,
  familiesOf,
  substituteFonts,
} from './font-substitution.ts';
import {
  type LensContext,
  type ReadStats,
  type Values,
  PPR,
  RPR,
  SECTPR,
  SECTPR_FIRST,
  TBLPR,
  TCPR,
  TRPR,
  TRPR_HEADER,
  readContainer,
  styleSpec,
} from './props.ts';
import { type RegionPlan, planRegions } from './regions.ts';
import { shareTrees, treeHolders } from './share.ts';
import type {
  ContainerSource,
  DefSource,
  DerivedSource,
  NodeSource,
  SourceMap,
} from './source-map.ts';
import {
  NotRepresentable,
  PRESERVED_GRAMMAR,
  type TreeBody,
  type TreeElement,
  type TreeGrammar,
  canonicalTree,
  checkPreserved,
  splitIdentity,
  toTree,
  treeDepth,
} from './tree.ts';
import { rFontsFamilies, themeFonts } from './theme-fonts.ts';
import { Utf8Error } from './utf8.ts';
import {
  type XmlElement,
  type XmlNode,
  XmlError,
  attr,
  canonical,
  child,
  elements,
  isWhitespaceText,
  nameOf,
  parseXml,
  textContent,
} from './xml.ts';
import {
  DEFAULT_ZIP_LIMITS,
  type ZipArchive,
  type ZipLimits,
  ZipError,
  entryData,
  readZip,
} from './zip.ts';

export class ImportError extends Error {
  override name = 'ImportError';
}

const PIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const ix = indexDefinition(CDM1);

export interface ImportOptions {
  /** Keep what the model does not represent (default true). False gives the baseline for measuring the overhead. */
  preserve?: boolean;
  limits?: ZipLimits;
  /** Element-tree limits used to decide what fits in `preserved` (default: the model's, 16 KiB and depth 12). */
  grammar?: { maxBytes: number; maxDepth: number };
  /** Share repeated trees through `preserved_def` (default true). */
  share?: boolean;
  /** Run `validate()` on the result and fail the import on any violation (default true; EXP-109). */
  validate?: boolean;
  /** Font substitution (EXP-106): the ordered manifest (tenant entries first) and the default family. */
  fonts?: { manifest?: readonly FontManifestEntry[]; defaultFamily?: string };
}

export interface TreeStat {
  where: string;
  depth: number;
  bytes: number;
}

export interface ImportStats extends ReadStats {
  nodes: Record<string, number>;
  nodesWithPreserved: Record<string, number>;
  textNodes: number;
  textWithPreservedMark: number;
  preservedInline: Record<string, number>;
  preservedBlock: Record<string, number>;
  /** Pictures imported as `image` nodes with an `origin`. */
  images: number;
  /** Preserved inline atoms that keep their element as a tree instead of a fragment asset. */
  smallAtoms: number;
  fallbacks: {
    paragraphToBlock: number;
    runToAtom: number;
    tableToBlock: number;
    /** Owner decision 13: paragraphs and tables preserved whole for a revision the model cannot express. */
    trackedParagraphs: number;
    trackedTables: number;
  };
  /** Inline atoms that carry marks (CDM-051): run formatting or suggestions. */
  markedAtoms: Record<string, number>;
  /** Suggestion marks made from Word revisions: on text, on inline atoms, on rows. */
  suggestions: { text: number; atoms: number; rows: number };
  dropped: Record<string, number>;
  /** Every element tree stored in the document, before sharing. */
  trees: TreeStat[];
  /** Trees that did not fit the grammar, and what happened instead. */
  oversize: TreeStat[];
  /** Id-less inline content measured as a whole tree, for the inline-atom question (ADR 0017). */
  atomTrees: TreeStat[];
  shared: { defs: number; occurrences: number };
}

/**
 * One line of the import report (EXP-107, EXP-117): a kind of content, what happened to it, how
 * often, and the blocks it is in.
 */
export interface ImportReportItem {
  kind: string;
  action: 'preserved' | 'dropped' | 'approximated';
  message: string;
  count: number;
  /** Identifiers of the blocks (paragraphs, tables, preserved blocks) that hold it, at most 100. */
  blocks: string[];
}

export interface ImportResult {
  envelope: JsonEnvelope;
  sourceMap: SourceMap;
  assets: AssetStore;
  /** The original package and the source map, as server-only assets of `assets` (EXP-108, EXP-116). */
  originalAsset: string;
  sourceMapAsset: string;
  stats: ImportStats;
  report: ImportReportItem[];
  warnings: string[];
  /** The families the file names and the substitutes the editor uses for them (EXP-106). The document keeps the file's names. */
  fonts: FontSubstitution[];
}

interface PartCtx {
  part: string;
  bytes: Uint8Array;
  rels: Relationships;
  kind: 'body' | 'cell' | 'story';
}

interface Pending {
  node: JsonNode;
  target: NodeSource | DefSource | DerivedSource;
}

interface Section {
  el: XmlElement;
  holder: NodeSource | null;
  breakNode: JsonNode | null;
}

const W_P = w('p');
const W_R = w('r');
const W_T = w('t');
const W_DELTEXT = w('delText');
const W_TBL = w('tbl');
const W_TR = w('tr');
const W_TC = w('tc');

/** Row spans taken from `w:vMerge`, and the continuation cells that a row span absorbs. */
interface VMergePlan {
  spans: Map<XmlElement, number>;
  absorbed: Set<XmlElement>;
}

/** Children of `w:tcPr` that a continuation cell may not carry: a tracked change of the cell. */
const CELL_REVISIONS = new Set([w('cellIns'), w('cellDel'), w('cellMerge')]);

/** The merge of a cell: `restart` starts a vertical merge, `continue` extends the one above. */
function vMergeOf(tc: XmlElement): 'restart' | 'continue' | null {
  const tcPr = child(tc, NS.w, 'tcPr');
  const vm = tcPr ? child(tcPr, NS.w, 'vMerge') : undefined;
  if (!vm) return null;
  return attr(vm, NS.w, 'val') === 'restart' ? 'restart' : 'continue';
}

/**
 * Whether a continuation cell holds nothing that a row span would lose from the model: no tracked
 * change of the cell and one or more paragraphs with no content. Its properties and its element
 * stay in the row's source-map gap (A2); a continuation cell with content is not merged.
 */
function isEmptyContinuation(tc: XmlElement): boolean {
  const tcPr = child(tc, NS.w, 'tcPr');
  if (tcPr && elements(tcPr).some((e) => CELL_REVISIONS.has(nameOf(e)))) return false;
  const rest = elements(tc).filter((e) => e !== tcPr);
  return (
    rest.length > 0 &&
    rest.every((p) => nameOf(p) === w('p') && elements(p).every((e) => nameOf(e) === w('pPr')))
  );
}

/** Row spans of the vertical merges in the rows of one table (EXP-101, criterion 1). */
function planVMerges(rows: readonly XmlElement[]): VMergePlan {
  const plan: VMergePlan = { spans: new Map(), absorbed: new Set() };
  const grid = rows.map((r) => {
    const cells = new Map<number, { tc: XmlElement; span: number }>();
    let col = 0;
    for (const tc of elements(r)) {
      if (nameOf(tc) !== W_TC) continue;
      const tcPr = child(tc, NS.w, 'tcPr');
      const gs = tcPr ? child(tcPr, NS.w, 'gridSpan') : undefined;
      const span = gs ? Number(attr(gs, NS.w, 'val') ?? '1') : 1;
      cells.set(col, { tc, span });
      col += span;
    }
    return cells;
  });
  for (const [i, cells] of grid.entries()) {
    for (const [col, { tc, span }] of cells) {
      if (vMergeOf(tc) !== 'restart') continue;
      let n = 1;
      for (let j = i + 1; j < grid.length; j++) {
        const below = grid[j]!.get(col);
        if (
          !below ||
          below.span !== span ||
          vMergeOf(below.tc) !== 'continue' ||
          !isEmptyContinuation(below.tc)
        )
          break;
        plan.absorbed.add(below.tc);
        n++;
      }
      if (n > 1) plan.spans.set(tc, n);
    }
  }
  // A row must keep one cell of its own; a table where a row would have none is imported without spans.
  const bare = grid.some((cells) => [...cells.values()].every((c) => plan.absorbed.has(c.tc)));
  return bare ? { spans: new Map(), absorbed: new Set() } : plan;
}
const W_PPR = w('pPr');
const W_RPR = w('rPr');
const W_SECTPR = w('sectPr');

/** Whether the bytes hold the given byte sequence (a cheap test before a part is parsed again). */
function hasBytes(bytes: Uint8Array, needle: readonly number[]): boolean {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (bytes[i] !== needle[0]) continue;
    let k = 1;
    while (k < needle.length && bytes[i + k] === needle[k]) k++;
    if (k === needle.length) return true;
  }
  return false;
}

/** Whether the part's bytes hold the text `permStart` (an editable range may start in it). */
function hasPermStart(bytes: Uint8Array): boolean {
  const needle = [112, 101, 114, 109, 83, 116, 97, 114, 116];
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (bytes[i] !== 112) continue;
    let k = 1;
    while (k < needle.length && bytes[i + k] === needle[k]) k++;
    if (k === needle.length) return true;
  }
  return false;
}
const W_INS = w('ins');
const W_DEL = w('del');
const W_TAB = w('tab');
const W_BR = w('br');
const W_DRAWING = w('drawing');
const MC_ALTERNATE = pname(NS.mc, 'AlternateContent');
const M_OMATH = pname(NS.m, 'oMath');
const M_OMATHPARA = pname(NS.m, 'oMathPara');

/** Small trees are those of at most this many bytes of canonical JSON (markers are tens of bytes). */
const SMALL_TREE_BYTES = 2048;
const REPORT_BLOCKS = 100;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function cleanText(s: string, max = 2048): string | null {
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const cps = [...t];
  return cps.length > max ? cps.slice(0, max).join('') : t;
}

const clampLength = (n: number): number => Math.max(0, Math.min(31680, n));

function emuToTwips(s: string | undefined): number | null {
  if (s === undefined || !/^[0-9]+$/.test(s)) return null;
  return Math.round(Number(s) / EMU_PER_TWIP);
}

function attrsOf(el: XmlElement, skip?: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of el.attrs) {
    const name = nameOf(a);
    if (!skip?.(name)) out[name] = a.value;
  }
  return out;
}

/** Sorts marks into schema order, as the canonical form and ProseMirror keep them (03 §2, §5). */
function sortMarks(marks: JsonMark[]): JsonMark[] {
  return [...marks].sort((a, b) => (ix.markRank.get(a.type) ?? 0) - (ix.markRank.get(b.type) ?? 0));
}

const withMarks = (node: JsonNode, marks: JsonMark[]): JsonNode => {
  if (marks.length) node.marks = sortMarks(marks);
  return node;
};

const BUILT_IN_BY_NAME: Record<string, string> = {
  normal: 'Normal',
  title: 'Title',
  subtitle: 'Subtitle',
  quote: 'Quote',
  'intense quote': 'IntenseQuote',
  'list paragraph': 'ListParagraph',
  'no spacing': 'NoSpacing',
  caption: 'Caption',
  'footnote text': 'FootnoteText',
  header: 'Header',
  footer: 'Footer',
  'toc heading': 'TOCHeading',
  'default paragraph font': 'DefaultParagraphFont',
  'footnote reference': 'FootnoteReference',
  hyperlink: 'Hyperlink',
  strong: 'Strong',
  emphasis: 'Emphasis',
  'normal table': 'TableNormal',
  'table grid': 'TableGrid',
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`heading ${i + 1}`, `Heading${i + 1}`]),
  ),
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`toc ${i + 1}`, `TOC${i + 1}`])),
};

/** A short label for preserved content (03 §4.6: "for example chart"). */
export function labelFor(el: XmlElement): string {
  const name = nameOf(el);
  const has = (pred: (e: XmlElement) => boolean): boolean => {
    const stack = [el];
    while (stack.length) {
      const e = stack.pop()!;
      if (pred(e)) return true;
      for (const c of e.children) if (c.kind === 'element') stack.push(c);
    }
    return false;
  };
  const gd = (uri: string): boolean =>
    has((e) => e.local === 'graphicData' && attr(e, '', 'uri') === uri);
  switch (name) {
    case W_DRAWING:
    case MC_ALTERNATE:
    case w('pict'):
      if (
        gd('http://schemas.openxmlformats.org/drawingml/2006/chart') ||
        has((e) => e.local === 'chart' && e.ns.includes('chartex'))
      )
        return 'chart';
      if (gd('http://schemas.openxmlformats.org/drawingml/2006/diagram')) return 'SmartArt';
      if (has((e) => e.local === 'txbxContent')) return 'text box';
      if (gd('http://schemas.microsoft.com/office/word/2010/wordprocessingGroup')) return 'group';
      if (gd('http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas')) return 'canvas';
      if (
        gd('http://schemas.microsoft.com/office/word/2010/wordprocessingShape') ||
        has((e) => e.ns === NS.v && e.local !== 'imagedata' && e.local !== 'shapetype')
      )
        return has((e) => e.local === 'OLEObject') ? 'embedded object' : 'shape';
      if (gd(PIC_URI) || has((e) => e.local === 'imagedata')) return 'picture';
      return name === MC_ALTERNATE ? 'alternate content' : 'drawing';
    case w('object'):
      // A linked object names its source in `o:OLEObject` with `Type="Link"` (EXP-117, criterion 1).
      return has((e) => e.local === 'OLEObject' && attr(e, '', 'Type') === 'Link')
        ? 'linked object'
        : 'embedded object';
    case pname(NS.w14, 'contentPart'):
      return 'ink';
    case w('fldChar'):
    case w('fldSimple'):
      return 'field';
    case w('instrText'):
    case w('delInstrText'):
      return 'field code';
    case w('sdt'):
      return 'content control';
    case w('customXml'):
      return 'custom XML';
    case w('smartTag'):
      return 'smart tag';
    case w('hyperlink'):
      return 'hyperlink';
    case M_OMATH:
    case M_OMATHPARA:
      return 'equation';
    case w('bookmarkStart'):
    case w('bookmarkEnd'):
      return 'bookmark';
    case w('commentRangeStart'):
    case w('commentRangeEnd'):
    case w('commentReference'):
      return 'comment anchor';
    case w('permStart'):
    case w('permEnd'):
      return 'permission range';
    case w('footnoteReference'):
      return 'footnote';
    case w('endnoteReference'):
      return 'endnote';
    case W_INS:
    case W_DEL:
    case w('moveFrom'):
    case w('moveTo'):
    case w('moveFromRangeStart'):
    case w('moveFromRangeEnd'):
    case w('moveToRangeStart'):
    case w('moveToRangeEnd'):
      return 'tracked change';
    case W_TBL:
      return 'table';
    case W_P:
      return 'paragraph';
    case W_R:
      return 'run';
    case W_BR:
      return 'break';
    case W_TAB:
      return 'tab';
    default:
      return el.local.slice(0, 64) || 'element';
  }
}

/** What the report says for each kind of preserved content (EXP-107, EXP-117). */
const PRESERVED_MESSAGE = 'preserved, not editable';

/** Labels of zero-width markers: they are kept without a fallback text. */
const MARKER_LABELS: ReadonlySet<string> = new Set([
  'bookmark',
  'comment anchor',
  'permission range',
  'field',
  'field code',
]);

const hasPropertyChange = (r: XmlElement): boolean => {
  const rPr = child(r, NS.w, 'rPr');
  return !!rPr && elements(rPr).some((k) => INEXPRESSIBLE_REVISIONS.has(nameOf(k)));
};

/**
 * Whether a paragraph holds a revision the model cannot express (owner decision 13): a move, a
 * property change of the paragraph or of a run, a revision of the paragraph mark or of its
 * numbering, or revisions nested other than an insertion holding a deletion. Content inside
 * preserved atoms (hyperlinks, content controls, text boxes) is kept whole anyway and not looked at.
 */
export function inexpressibleRevision(p: XmlElement): boolean {
  for (const c of elements(p)) {
    const n = nameOf(c);
    if (INEXPRESSIBLE_REVISIONS.has(n)) return true;
    if (n === W_PPR) {
      for (const k of elements(c)) {
        const kn = nameOf(k);
        if (INEXPRESSIBLE_REVISIONS.has(kn)) return true;
        if (kn === W_RPR || kn === w('numPr'))
          for (const r of elements(k)) {
            const rn = nameOf(r);
            if (rn === W_INS || rn === W_DEL || INEXPRESSIBLE_REVISIONS.has(rn)) return true;
          }
      }
      continue;
    }
    if (n === W_R) {
      if (hasPropertyChange(c)) return true;
      continue;
    }
    if (n !== W_INS && n !== W_DEL) continue;
    for (const k of elements(c)) {
      const kn = nameOf(k);
      if (INEXPRESSIBLE_REVISIONS.has(kn) || kn === W_INS) return true;
      if (kn === W_R && hasPropertyChange(k)) return true;
      if (kn !== W_DEL) continue;
      if (n === W_DEL) return true;
      for (const m of elements(k)) {
        const mn = nameOf(m);
        if (mn === W_INS || mn === W_DEL || INEXPRESSIBLE_REVISIONS.has(mn)) return true;
        if (mn === W_R && hasPropertyChange(m)) return true;
      }
    }
  }
  return false;
}

/** Whether a table's own properties (not its cells' paragraphs) hold a revision the model cannot express. */
function inexpressibleTableRevision(tbl: XmlElement): boolean {
  const scan = (el: XmlElement | undefined): boolean =>
    !!el && elements(el).some((k) => INEXPRESSIBLE_REVISIONS.has(nameOf(k)));
  if (scan(child(tbl, NS.w, 'tblPr')) || scan(child(tbl, NS.w, 'tblGrid'))) return true;
  for (const r of elements(tbl)) {
    if (nameOf(r) !== W_TR) continue;
    if (scan(child(r, NS.w, 'trPr')) || scan(child(r, NS.w, 'tblPrEx'))) return true;
    for (const c of elements(r))
      if (nameOf(c) === W_TC && scan(child(c, NS.w, 'tcPr'))) return true;
  }
  return false;
}

/** Whether an element or its descendants refer to a relationship. */
function refersToRelationships(el: XmlElement): boolean {
  return referencedRelIds(el).size > 0;
}

/** The report kind of a drawing anchored to the page or a paragraph (EXP-107, criterion 1). */
export const FLOATING_KIND = 'floating object';

/** The report kind of a hyperlink whose address the link allow-list (I9) does not accept (EXP-102). */
export const REFUSED_LINK_KIND = 'hyperlink with a refused address';

/** Elements that hold a drawing as a run child: a floating one among them is reported as such. */
const DRAWING_HOSTS: ReadonlySet<string> = new Set([W_DRAWING, MC_ALTERNATE]);

/** Whether an element or its descendants hold an anchored (floating) drawing, `wp:anchor` (EXP-107). */
function isAnchored(el: XmlElement): boolean {
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.ns === NS.wp && e.local === 'anchor') return true;
    for (const c of e.children) if (c.kind === 'element') stack.push(c);
  }
  return false;
}

class Importer {
  readonly assets = new AssetStore();
  readonly warnings: string[] = [];
  readonly stats: ImportStats = {
    fullContainers: {},
    nodes: {},
    nodesWithPreserved: {},
    textNodes: 0,
    textWithPreservedMark: 0,
    preservedInline: {},
    preservedBlock: {},
    images: 0,
    smallAtoms: 0,
    fallbacks: {
      paragraphToBlock: 0,
      runToAtom: 0,
      tableToBlock: 0,
      trackedParagraphs: 0,
      trackedTables: 0,
    },
    markedAtoms: {},
    suggestions: { text: 0, atoms: 0, rows: 0 },
    dropped: {},
    trees: [],
    oversize: [],
    atomTrees: [],
    shared: { defs: 0, occurrences: 0 },
  };
  readonly preserve: boolean;
  readonly grammar: TreeGrammar;
  readonly zip: ZipArchive;
  readonly ct: ContentTypes;
  sm!: SourceMap;
  private readonly pending: Pending[] = [];
  private readonly styleToCdmMap = new Map<string, { id: string; kind: string }>();
  private readonly styleToWordMap = new Map<string, string>();
  private readonly storyByRel = new Map<string, string>();
  private readonly relByStory = new Map<string, string>();
  private readonly imageAssets = new Map<string, string>();
  private readonly relsCache = new Map<string, Relationships>();
  private readonly fragmentIds = new Set<string>();
  private readonly notes = new Map<string, ImportReportItem & { blockSet: Set<string> }>();
  /** The ids of the footnotes that have more than one paragraph (EXP-107, criterion 1). */
  private readonly multiParagraphNotes = new Set<string>();
  /** The block whose content is being imported, for the report. */
  private block_: string | null = null;
  /** The vertical merges of the table being read: row spans, and the cells they absorb (EXP-101). */
  private vMerges: VMergePlan = { spans: new Map(), absorbed: new Set() };
  private preserveUsed = false;
  /** The source definitions read from the bibliography sources part, and their tags (EXP-122). */
  private readonly sourceDefs: JsonNode[] = [];
  private readonly sourceByTag = new Map<string, string>();
  readonly ctx: LensContext;

  readonly bytes: Uint8Array;
  readonly opts: ImportOptions;

  constructor(bytes: Uint8Array, opts: ImportOptions) {
    this.bytes = bytes;
    this.opts = opts;
    this.preserve = opts.preserve !== false;
    this.grammar = { kind: 'elementTree', ...(opts.grammar ?? PRESERVED_GRAMMAR) };
    this.zip = readZip(bytes, opts.limits ?? DEFAULT_ZIP_LIMITS);
    const ctBytes = this.read('[Content_Types].xml');
    if (!ctBytes) throw new ImportError('the package has no [Content_Types].xml');
    this.ct = parseContentTypes(ctBytes);
    this.ctx = {
      styleToCdm: (wordId, kind) => {
        const s = this.styleToCdmMap.get(wordId);
        return s && s.kind === kind ? s.id : null;
      },
      styleToWord: (id) => this.styleToWordMap.get(id) ?? null,
      storyForRel: (relId) => this.storyByRel.get(relId) ?? null,
      relForStory: (id) => this.relByStory.get(id) ?? null,
    };
  }

  read(name: string): Uint8Array | undefined {
    const e = this.zip.byName.get(name);
    return e ? entryData(this.zip, e) : undefined;
  }

  rels(part: string): Relationships {
    let r = this.relsCache.get(part);
    if (!r) {
      r = parseRelationships(part, this.read(relsPartName(part)));
      this.relsCache.set(part, r);
    }
    return r;
  }

  count(table: Record<string, number>, key: string): void {
    table[key] = (table[key] ?? 0) + 1;
  }

  /** Adds one occurrence to the report (EXP-107). */
  note(
    kind: string,
    action: ImportReportItem['action'],
    message: string,
    block = this.block_,
  ): void {
    const key = `${action}\u0000${kind}`;
    let n = this.notes.get(key);
    if (!n) {
      n = { kind, action, message, count: 0, blocks: [], blockSet: new Set() };
      this.notes.set(key, n);
    }
    n.count++;
    if (block && !n.blockSet.has(block) && n.blockSet.size < REPORT_BLOCKS) {
      n.blockSet.add(block);
      n.blocks.push(block);
    }
  }

  /** Records a tree and says whether it fits the grammar. */
  fits(body: TreeBody, where: string, maxBytes = this.grammar.maxBytes): boolean {
    const depth = treeDepth(body);
    const bytes = utf8(canonicalize(body)).length;
    const problems = checkPreserved(body, { ...this.grammar, maxBytes });
    if (problems.length) {
      this.stats.oversize.push({ where, depth, bytes });
      return false;
    }
    this.stats.trees.push({ where, depth, bytes });
    this.preserveUsed = true;
    return true;
  }

  async run(): Promise<ImportResult> {
    const pkgRels = this.rels('');
    const main = pkgRels.list.find((r) => r.type === REL.officeDocument && !r.external);
    if (!main) throw new ImportError('the package has no main document part');
    const mainPart = resolveTarget('', main.target);
    const mainType = contentTypeOf(this.ct, mainPart);
    if (
      mainType === MACRO_MAIN_CONTENT_TYPE ||
      this.zip.entries.some((e) => /vbaProject\.bin$/i.test(e.name))
    )
      throw new ImportError('macro-enabled files are refused (EXP-099)');
    const mainBytes = this.read(mainPart);
    if (!mainBytes) throw new ImportError(`the main document part ${mainPart} is missing`);
    const mainRels = this.rels(mainPart);

    this.sm = {
      v: 3,
      canonicalForm: CANONICAL_FORM_VERSION,
      cdm: 1,
      package: { sha256: await sha256HexBytes(this.bytes), size: this.bytes.length },
      mainPart,
      stylesPart: null,
      nodes: {},
      defs: {},
      breaks: {},
      derived: {},
      containers: {},
      suggestions: {},
      styles: {},
      stories: {},
      synthetic: [],
      fragments: [],
      payloads: [],
    };

    // Footnotes of several paragraphs: the report names each reference to one (EXP-107, criterion 1).
    const notesRel = mainRels.list.find((r) => r.type === REL.footnotes && !r.external);
    const notesBytes = notesRel ? this.read(resolveTarget(mainPart, notesRel.target)) : undefined;
    if (notesBytes) {
      const notesDoc = this.parse(resolveTarget(mainPart, notesRel!.target), notesBytes);
      for (const note of elements(notesDoc.root)) {
        if (nameOf(note) !== w('footnote')) continue;
        const id = attr(note, NS.w, 'id');
        if (id !== undefined && elements(note).filter((p) => nameOf(p) === W_P).length > 1)
          this.multiParagraphNotes.add(id);
      }
    }

    // Sources before the body: a citation refers to one by its tag (EXP-122).
    this.readSources(mainRels, mainPart);

    // Numbering before the styles: a style may be numbered (headings).
    const numberingRel = mainRels.list.find((r) => r.type === REL.numbering && !r.external);
    const numberingPart = numberingRel ? resolveTarget(mainPart, numberingRel.target) : null;
    const numberingBytes = numberingPart ? this.read(numberingPart) : undefined;
    this.numberingImport = new NumberingImport(
      numberingBytes ? this.parse(numberingPart!, numberingBytes).root : null,
      () => nodeId(),
      (message) => this.warnings.push(message),
    );
    for (const d of this.numberingImport.sources) {
      this.count(this.stats.nodes, 'numbering_def');
      const target: DefSource = {
        part: numberingPart!,
        start: d.start,
        end: d.end,
        hash: '',
        wordId: d.abstractId,
      };
      this.sm.defs[String(d.node.attrs!['id'])] = target;
      this.pending.push({ node: d.node, target });
    }

    // Styles next: paragraphs refer to them.
    const stylesRel = mainRels.list.find((r) => r.type === REL.styles && !r.external);
    const styleDefs = stylesRel ? this.styles(resolveTarget(mainPart, stylesRel.target)) : [];
    this.ensureDefaultStyle(styleDefs);
    const settings = this.settings(mainRels, mainPart);

    // Story identifiers before the body, so that section properties can refer to them.
    const storyRels = mainRels.list.filter(
      (r) => (r.type === REL.header || r.type === REL.footer) && !r.external,
    );
    const storyParts = new Map<string, { id: string; kind: 'header' | 'footer'; relId: string }>();
    for (const r of storyRels) {
      const part = resolveTarget(mainPart, r.target);
      let s = storyParts.get(part);
      if (!s) {
        s = { id: nodeId(), kind: r.type === REL.header ? 'header' : 'footer', relId: r.id };
        storyParts.set(part, s);
      }
      this.storyByRel.set(r.id, s.id);
      if (!this.relByStory.has(s.id)) this.relByStory.set(s.id, r.id);
      this.sm.stories[s.id] = { part, relId: this.relByStory.get(s.id)! };
    }

    // Body.
    const doc = this.parse(mainPart, mainBytes);
    const body = child(doc.root, NS.w, 'body');
    if (!body) throw new ImportError('the main document part has no w:body');
    const pc: PartCtx = { part: mainPart, bytes: mainBytes, rels: mainRels, kind: 'body' };
    const sections: Section[] = [];
    const bodyContent = await this.blocks(body, pc, 'body', sections);

    // Page setups: one per section. A section break carries the page setup of the section after it.
    const pageSetups: JsonNode[] = [];
    const psIds: string[] = [];
    const starts: Array<string | null> = [];
    for (let k = 0; k < sections.length; k++) {
      const s = sections[k]!;
      const final = s.holder === null;
      const ps = this.pageSetup(s.el, k === 0, final, mainPart);
      pageSetups.push(ps.node);
      psIds.push(ps.id);
      starts.push(k === 0 ? null : ps.start);
      if (s.holder) s.holder.sectPr = { pageSetup: ps.id, start: k === 0 ? null : ps.start };
    }
    const last = sections[sections.length - 1];
    if (!last || last.holder !== null) {
      // No final sectPr: the last section has no properties of its own.
      const id = nodeId();
      const node: JsonNode = { type: 'page_setup', attrs: { id } };
      pageSetups.push(node);
      psIds.push(id);
      starts.push('nextPage');
      this.synthetic(node);
    }
    sections.forEach((s, k) => {
      if (!s.breakNode) return;
      s.breakNode.attrs!['pageSetup'] = psIds[k + 1]!;
      const start = starts[k + 1];
      if (start && start !== 'nextPage') s.breakNode.attrs!['start'] = start;
    });

    // Stories.
    const stories: JsonNode[] = [];
    for (const [part, s] of storyParts) {
      const bytes = this.read(part);
      if (!bytes) continue;
      const sdoc = this.parse(part, bytes);
      const spc: PartCtx = { part, bytes, rels: this.rels(part), kind: 'story' };
      const content = await this.blocks(sdoc.root, spc, s.id, []);
      const node: JsonNode = { type: 'story', attrs: { id: s.id, kind: s.kind }, content };
      this.source(node, { part, start: sdoc.root.start, end: sdoc.root.end, hash: '' });
      stories.push(node);
      this.count(this.stats.nodes, 'story');
    }

    // Definitions: settings, styles, page setups (shared trees are appended by shareTrees).
    const defsContent: JsonNode[] = [
      settings,
      ...styleDefs,
      ...this.numberingImport.defs,
      ...pageSetups,
      ...this.sourceDefs,
    ];
    const envelope: JsonEnvelope = {
      cdm: 1,
      requires: [],
      doc: {
        type: 'doc',
        content: [
          { type: 'defs', content: defsContent },
          ...stories,
          { type: 'body', attrs: { pageSetup: psIds[0]! }, content: bodyContent },
        ],
      },
    };
    if (this.preserve && this.opts.share !== false) {
      this.stats.shared = shareTrees(envelope, () => nodeId());
      // A shared tree has no single original element; its holders' entries locate it.
      const holders = treeHolders(envelope);
      for (const d of envelope.doc.content?.find((n) => n.type === 'defs')?.content ?? []) {
        if (d.type !== 'preserved_def') continue;
        const id = String(d.attrs!['id']);
        const target: DerivedSource = { hash: '', holders: holders.get(id) ?? [] };
        this.sm.derived[id] = target;
        this.pending.push({ node: d, target });
      }
    }
    if (this.preserveUsed) envelope.requires.push('preserve');

    // Hashes after sharing: the document is now as it will be stored.
    const hasher = new NodeHasher();
    for (const p of this.pending) p.target.hash = await hasher.hash(p.node);
    this.sm.fragments = [...this.fragmentIds].sort();
    this.sm.payloads = this.preserve ? await payloadDigests(envelope) : [];

    const originalAsset = await this.assets.add(this.bytes, DOCX_CONTENT_TYPE, 'original');
    const sourceMapAsset = await this.assets.add(
      utf8(JSON.stringify(this.sm)),
      SOURCE_MAP_CONTENT_TYPE,
      'source-map',
    );

    if (this.opts.validate !== false) {
      const result = validate(envelope, { attachedAssets: this.assets.ids() });
      if (!result.valid) {
        const first = result.violations
          .slice(0, 5)
          .map((v) => `${v.invariant} ${v.code} at ${v.path}: ${v.message}`);
        throw new ImportError(
          `the imported document fails validate() with ${result.violations.length} violation(s): ${first.join('; ')}`,
        );
      }
    }

    return {
      envelope,
      sourceMap: this.sm,
      assets: this.assets,
      originalAsset,
      sourceMapAsset,
      stats: this.stats,
      report: this.report(),
      warnings: this.warnings,
      fonts: substituteFonts(
        [...familiesOf(envelope.doc), ...this.packageFamilies(mainPart, mainRels)],
        this.opts.fonts ?? {},
      ),
    };
  }

  /**
   * The families the package's `w:rFonts` elements name, theme references resolved (EXP-106). The
   * model keeps only `w:ascii`, so a family named through the theme (Aptos, in recent Word files)
   * is found here. It only reads; a part that does not parse is skipped, as the import itself
   * reports such parts.
   */
  packageFamilies(mainPart: string, mainRels: Relationships): string[] {
    const themeRel = mainRels.list.find((r) => r.type === REL.theme && !r.external);
    const themeName = themeRel ? resolveTarget(mainPart, themeRel.target) : 'word/theme/theme1.xml';
    const load = (name: string): ReturnType<typeof parseXml> | undefined => {
      const bytes = this.read(name);
      if (!bytes) return undefined;
      try {
        return parseXml(bytes);
      } catch (e) {
        if (e instanceof XmlError || e instanceof Utf8Error) return undefined;
        throw e;
      }
    };
    const theme = load(themeName);
    const fonts = theme ? themeFonts(theme.root) : {};
    const wanted = new Set<string>([
      REL.styles,
      REL.numbering,
      REL.footnotes,
      REL.endnotes,
      REL.comments,
      REL.header,
      REL.footer,
    ]);
    const names: string[] = [mainPart];
    for (const r of mainRels.list) {
      if (r.external || !wanted.has(r.type)) continue;
      const name = resolveTarget(mainPart, r.target);
      if (!names.includes(name)) names.push(name);
    }
    const out: string[] = [];
    const needle = [...'rFonts'].map((c) => c.charCodeAt(0));
    for (const name of names) {
      const bytes = this.read(name);
      if (!bytes || !hasBytes(bytes, needle)) continue;
      const part = load(name);
      if (part) out.push(...rFontsFamilies(part.root, fonts));
    }
    return out;
  }
  report(): ImportReportItem[] {
    const order = { preserved: 0, approximated: 1, dropped: 2 };
    return [...this.notes.values()]
      .map(({ kind, action, message, count, blocks }) => ({ kind, action, message, count, blocks }))
      .sort(
        (a, b) =>
          order[a.action] - order[b.action] || b.count - a.count || (a.kind < b.kind ? -1 : 1),
      );
  }

  parse(part: string, bytes: Uint8Array): ReturnType<typeof parseXml> {
    try {
      return parseXml(bytes);
    } catch (e) {
      if (e instanceof XmlError || e instanceof Utf8Error)
        throw new ImportError(`${part}: ${e.message}`);
      throw e;
    }
  }

  source(node: JsonNode, target: NodeSource): NodeSource {
    this.sm.nodes[String(node.attrs!['id'])] = target;
    this.pending.push({ node, target });
    return target;
  }

  /**
   * The bibliography sources part (a custom XML item with a `b:Sources` root) as source definitions.
   * Each keeps its place in the part, so the writer can copy an unchanged source and rebuild a
   * changed one (EXP-122, criteria 2 and 3).
   */
  readSources(mainRels: Relationships, mainPart: string): void {
    for (const r of mainRels.list) {
      if (r.type !== REL.customXml || r.external) continue;
      const part = resolveTarget(mainPart, r.target);
      const bytes = this.read(part);
      if (!bytes) continue;
      let read: ReturnType<typeof importSources>;
      try {
        read = importSources(this.parse(part, bytes).root, this.preserve);
      } catch (e) {
        if (!(e instanceof ImportError)) throw e;
        continue;
      }
      if (!read) continue;
      for (const s of read.sources) {
        const id = String(s.node.attrs!['id']);
        // The tag is Word's name for the source; the identifier is a fresh one (nothing is taken
        // from the file), and the source map says which tag it stands for.
        const target: DefSource = { part, start: s.start, end: s.end, hash: '', wordId: s.tag };
        this.sm.defs[id] = target;
        this.pending.push({ node: s.node, target });
        this.sourceDefs.push(s.node);
        this.sourceByTag.set(s.tag, id);
        this.count(this.stats.nodes, 'source_def');
        if (s.node.attrs!['preserved']) {
          this.count(this.stats.nodesWithPreserved, 'source_def');
          this.preserveUsed = true;
        }
      }
      for (const why of read.skipped)
        this.warnings.push(`a source was not imported: ${why}; its citations stay as they were`);
      if (read.sources.length)
        this.sm.sources = { part, prefixEnd: read.prefixEnd, suffixStart: read.suffixStart };
      return;
    }
  }

  /**
   * A citation: a content control holding a `CITATION` field of sources the document defines
   * (EXP-122, criterion 2). The node keeps the original control as its origin while unedited, and
   * the switches the model has no place for as preserved text (criterion 3). Anything else stays
   * a preserved content control.
   */
  async citation(sdt: XmlElement, pc: PartCtx, marks: JsonMark[]): Promise<JsonNode | null> {
    if (!this.sourceByTag.size) return null;
    const pr = child(sdt, NS.w, 'sdtPr');
    const content = child(sdt, NS.w, 'sdtContent');
    if (!pr || !content || !child(pr, NS.w, 'citation')) return null;
    if (elements(pr).some((k) => k.ns !== NS.w || (k.local !== 'id' && k.local !== 'citation')))
      return null;
    let state: 'before' | 'code' | 'result' | 'done' = 'before';
    let instr = '';
    let cached = '';
    for (const run of elements(content)) {
      if (nameOf(run) !== W_R) return null;
      for (const c of elements(run)) {
        const n = nameOf(c);
        if (n === W_RPR) continue;
        if (n === w('fldChar')) {
          const type = attr(c, NS.w, 'fldCharType');
          if (type === 'begin' && state === 'before') state = 'code';
          else if (type === 'separate' && state === 'code') state = 'result';
          else if (type === 'end' && (state === 'code' || state === 'result')) state = 'done';
          else return null;
        } else if (n === w('instrText') && state === 'code') instr += textContent(c);
        else if (n === W_T && state === 'result') cached += textContent(c);
        else return null;
      }
    }
    if (state !== 'done') return null;
    const parsed = parseCitationInstruction(instr);
    if (!parsed || !parsed.tags.every((t) => this.sourceByTag.has(t))) return null;
    const items = parsed.tags.map((tag) => {
      const item: Record<string, JsonValue> = { source: this.sourceByTag.get(tag)! };
      if (parsed.locator !== null) {
        item['locator'] = parsed.locator;
        item['label'] = 'page';
      }
      return item;
    });
    const attrs: Record<string, JsonValue> = { items, mode: parsed.mode };
    if (cached && cached.length <= 1024) attrs['cached'] = cached;
    const node: JsonNode = { type: 'citation', attrs };
    if (this.preserve) {
      const tree = residualTree(parsed.residual);
      if (tree) attrs['preserved'] = tree as unknown as JsonValue;
      const fragment = await this.fragment(
        { xml: pc.bytes.slice(sdt.start, sdt.end), el: sdt },
        'citation',
        pc,
        'none',
      );
      attrs['origin'] = { fragment, hash: await modelledHash(node) };
      this.preserveUsed = true;
    } else if (parsed.residual) return null;
    this.count(this.stats.nodes, 'citation');
    if (marks.length) this.count(this.stats.markedAtoms, 'citation');
    if (marks.some((m) => m.type === 'ins' || m.type === 'del')) this.stats.suggestions.atoms++;
    return withMarks(node, marks);
  }

  /** Records a node the importer added without a source element: listed in `synthetic`, hashed in `derived`. */
  synthetic(node: JsonNode): void {
    const id = String(node.attrs!['id']);
    const target: DerivedSource = { hash: '' };
    this.sm.synthetic.push(id);
    this.sm.derived[id] = target;
    this.pending.push({ node, target });
  }

  // -------------------------------------------------------------------------------------------
  // Definitions.

  settings(mainRels: Relationships, mainPart: string): JsonNode {
    const attrs: Record<string, JsonValue> = {};
    const rel = mainRels.list.find((r) => r.type === REL.settings && !r.external);
    const bytes = rel ? this.read(resolveTarget(mainPart, rel.target)) : undefined;
    if (bytes) {
      const doc = this.parse('settings', bytes);
      const tab = child(doc.root, NS.w, 'defaultTabStop');
      const v = tab ? attr(tab, NS.w, 'val') : undefined;
      if (v && /^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= 31680)
        attrs['defaultTabStop'] = Number(v);
      // EXP-102: w:evenAndOddHeaders is a document setting; it turns on the even-page variants of every section.
      const eo = child(doc.root, NS.w, 'evenAndOddHeaders');
      const eoVal = eo ? attr(eo, NS.w, 'val') : undefined;
      this.evenAndOddHeaders = eo !== undefined && !['0', 'false', 'off'].includes(eoVal ?? '1');
    }
    if (this.docLang) attrs['lang'] = this.docLang;
    if (this.defaultStyle) attrs['defaultParagraphStyle'] = this.defaultStyle;
    return { type: 'settings', attrs };
  }

  private defaultStyle: string | null = null;
  /** Set by `settings()` when the file has w:evenAndOddHeaders on; read by `pageSetup()`. */
  private evenAndOddHeaders = false;
  /** The document language of w:docDefaults (EXP-100 criterion 5), read by `styles()`. */
  private docLang: string | null = null;
  /** The numbering part, read before the styles and the paragraphs that refer to it (EXP-100 criterion 3). */
  private numberingImport: NumberingImport | null = null;
  /**
   * The paragraph and run values of w:docDefaults (EXP-100 criterion 5). They sit below every style
   * in Word, so they are merged into the default paragraph style (proposed in ADR 0372).
   */
  private docDefaultValues: Record<string, JsonValue> = {};

  /** Reads the paragraph and run defaults of `w:docDefaults` with the lenses of a style's pPr and rPr. */
  private readDocDefaults(docDefaults: XmlElement | undefined): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};
    if (!docDefaults) return out;
    const nested = styleSpec('paragraph').nested!;
    const pairs: Array<[string, string]> = [
      ['pPrDefault', 'pPr'],
      ['rPrDefault', 'rPr'],
    ];
    for (const [holder, inner] of pairs) {
      const h = child(docDefaults, NS.w, holder);
      const props = h ? child(h, NS.w, inner) : undefined;
      const spec = nested[w(inner)];
      if (!props || !spec) continue;
      try {
        const read = readContainer(spec, elements(props), this.ctx);
        for (const [k, v] of Object.entries(read.values)) if (v !== null) out[k] = v;
      } catch (e) {
        if (!(e instanceof NotRepresentable)) throw e;
        this.warnings.push(`document defaults (${inner}): ${e.message}`);
      }
    }
    return out;
  }

  /**
   * Fills the properties the default paragraph style leaves unset with the document defaults.
   * A style that is based on another keeps its parent's values, so it is left alone.
   */
  private applyDocDefaults(attrs: Record<string, JsonValue>): void {
    if (attrs['basedOn'] !== undefined) return;
    for (const [k, v] of Object.entries(this.docDefaultValues))
      if (!(k in attrs) && k !== 'name' && k !== 'basedOn' && k !== 'next') attrs[k] = v;
  }

  styles(part: string): JsonNode[] {
    this.sm.stylesPart = part;
    const bytes = this.read(part);
    if (!bytes) return [];
    const doc = this.parse(part, bytes);
    // EXP-100 criterion 5: the language of the run defaults (w:docDefaults) is the document language.
    const docDefaults = child(doc.root, NS.w, 'docDefaults');
    const rPrDefault = docDefaults ? child(docDefaults, NS.w, 'rPrDefault') : undefined;
    const rPr = rPrDefault ? child(rPrDefault, NS.w, 'rPr') : undefined;
    const lang = rPr ? child(rPr, NS.w, 'lang') : undefined;
    const langVal = lang ? attr(lang, NS.w, 'val') : undefined;
    if (langVal !== undefined && langVal.length <= 64 && new RegExp(BCP47_PATTERN).test(langVal))
      this.docLang = langVal;
    this.docDefaultValues = this.readDocDefaults(docDefaults);
    const found: Array<{
      el: XmlElement;
      id: string;
      kind: 'paragraph' | 'character' | 'table';
      wordId: string;
      builtIn: boolean;
    }> = [];
    const used = new Set<string>();
    for (const el of elements(doc.root)) {
      if (el.ns !== NS.w || el.local !== 'style') continue;
      const kind = attr(el, NS.w, 'type') ?? 'paragraph';
      if (kind !== 'paragraph' && kind !== 'character' && kind !== 'table') continue;
      const wordId = attr(el, NS.w, 'styleId') ?? '';
      if (!wordId || this.styleToCdmMap.has(wordId)) continue;
      const nameEl = child(el, NS.w, 'name');
      const name = (nameEl ? attr(nameEl, NS.w, 'val') : undefined) ?? wordId;
      const reserved = BUILT_IN_BY_NAME[name.toLowerCase()];
      const builtIn = !!reserved && BUILT_IN_STYLES[reserved] === kind && !used.has(reserved);
      const id = builtIn ? reserved! : nodeId();
      used.add(id);
      this.styleToCdmMap.set(wordId, { id, kind });
      this.styleToWordMap.set(id, wordId);
      this.sm.styles[id] = wordId;
      if (kind === 'paragraph' && onOffAttr(attr(el, NS.w, 'default'))) this.defaultStyle ??= id;
      found.push({ el, id, kind, wordId, builtIn });
    }
    const out: JsonNode[] = [];
    for (const s of found) {
      const spec = styleSpec(s.kind);
      let read;
      try {
        read = readContainer(spec, elements(s.el), this.ctx, this.stats);
      } catch (e) {
        if (!(e instanceof NotRepresentable)) throw e;
        this.warnings.push(`style ${s.wordId}: ${e.message}`);
        read = { values: {}, residue: [], full: true };
      }
      const attrs: Record<string, JsonValue> = {
        id: s.id,
        kind: s.kind,
        name:
          typeof read.values['name'] === 'string' ? read.values['name'] : s.wordId.slice(0, 255),
      };
      if (s.builtIn) attrs['builtIn'] = true;
      for (const [k, v] of Object.entries(read.values))
        if (k !== 'name' && v !== null) attrs[k] = v;
      if (s.kind === 'paragraph') {
        // A numbered style (headings): its numbering joins the list of its definition (03 §7.1).
        const numPr = child(child(s.el, NS.w, 'pPr') ?? s.el, NS.w, 'numPr');
        if (numPr) {
          const n = this.numberingImport?.forStyle(
            attr(child(numPr, NS.w, 'numId') ?? numPr, NS.w, 'val'),
            attr(child(numPr, NS.w, 'ilvl') ?? numPr, NS.w, 'val'),
            s.wordId,
          );
          if (n) attrs['numbering'] = n;
        }
      }
      if (s.kind === 'paragraph' && s.id === this.defaultStyle) this.applyDocDefaults(attrs);
      const extra = attrsOf(s.el, (n) => n === w('type') || n === w('styleId'));
      const body: TreeBody = {};
      if (Object.keys(extra).length) body.attrs = extra;
      if (read.residue.length) body.children = read.residue;
      const identityTree = splitIdentity(body, IDENTITY_ATTRS);
      if (this.preserve && (body.attrs || body.children)) {
        if (this.fits(body, 'style_def', PRESERVED_STYLE_BYTES))
          attrs['preserved'] = body as unknown as JsonValue;
        else
          this.warnings.push(
            `style ${s.wordId}: preserved properties exceed the grammar; the styles part is kept as is`,
          );
      }
      const node: JsonNode = { type: 'style_def', attrs };
      this.count(this.stats.nodes, 'style_def');
      if (attrs['preserved']) this.count(this.stats.nodesWithPreserved, 'style_def');
      const target: DefSource = {
        part,
        start: s.el.start,
        end: s.el.end,
        hash: '',
        wordId: s.wordId,
      };
      const identity = elements(s.el).filter((c) => IDENTITY_ELEMENTS.has(nameOf(c)));
      if (identity.length)
        target.identityElements = identity.map((c) => ({ name: nameOf(c), attrs: attrsOf(c) }));
      if (identityTree.length) target.identityTree = identityTree;
      this.sm.defs[s.id] = target;
      this.pending.push({ node, target });
      out.push(node);
    }
    return out;
  }

  /** The settings node refers to a default paragraph style; a document without one gets a synthetic Normal. */
  ensureDefaultStyle(styleDefs: JsonNode[]): void {
    if (this.defaultStyle) return;
    if (!styleDefs.some((n) => n.attrs?.['id'] === 'Normal')) {
      const node: JsonNode = {
        type: 'style_def',
        attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
      };
      this.applyDocDefaults(node.attrs!);
      styleDefs.unshift(node);
      this.synthetic(node);
    }
    this.defaultStyle = 'Normal';
  }

  pageSetup(
    el: XmlElement,
    first: boolean,
    final: boolean,
    part: string,
  ): { id: string; node: JsonNode; start: string } {
    const id = nodeId();
    const read = readContainer(first ? SECTPR_FIRST : SECTPR, elements(el), this.ctx, this.stats);
    const attrs: Record<string, JsonValue> = { id };
    for (const [k, v] of Object.entries(read.values)) if (k !== 'start' && v !== null) attrs[k] = v;
    if (this.evenAndOddHeaders) attrs['differentOddEven'] = true;
    const identity = attrsOf(el, (n) => !IDENTITY_ATTRS.has(n));
    const extra = attrsOf(el, (n) => IDENTITY_ATTRS.has(n));
    const body: TreeBody = {};
    if (Object.keys(extra).length) body.attrs = extra;
    if (read.residue.length) body.children = read.residue;
    const identityTree = splitIdentity(body, IDENTITY_ATTRS);
    if (this.preserve && (body.attrs || body.children)) {
      if (this.fits(body, 'page_setup')) attrs['preserved'] = body as unknown as JsonValue;
      else this.warnings.push('section properties exceed the grammar');
    }
    const node: JsonNode = { type: 'page_setup', attrs };
    const start = String(read.values['start'] ?? 'nextPage');
    const target: DefSource = {
      part,
      start: el.start,
      end: el.end,
      hash: '',
      first,
      final,
      startValue: first ? null : start,
    };
    if (Object.keys(identity).length) target.identity = identity;
    if (identityTree.length) target.identityTree = identityTree;
    this.sm.defs[id] = target;
    this.pending.push({ node, target });
    this.count(this.stats.nodes, 'page_setup');
    if (attrs['preserved']) this.count(this.stats.nodesWithPreserved, 'page_setup');
    return { id, node, start };
  }

  // -------------------------------------------------------------------------------------------
  // Blocks.

  /**
   * Maps the block children of a container (the body, a cell, a header or footer) and records the
   * container's gaps. In the body, paragraph-level section properties become section breaks.
   */
  async blocks(
    container: XmlElement,
    pc: PartCtx,
    key: string,
    sections: Section[],
    after?: XmlElement,
  ): Promise<JsonNode[]> {
    const out: JsonNode[] = [];
    const order: string[] = [];
    const gaps: Array<[number, number]> = [];
    const contentStart = after ? after.end : container.startTagEnd;
    let gapStart = contentStart;
    let finalSectPr: XmlElement | null = null;
    let started = !after;
    // Editable ranges of the body become regions (EXP-104): a run of blocks is mapped into the
    // region's own lists, and the region is one child of the body, with its own container.
    const regions =
      pc.kind === 'body' && key === 'body' && !after
        ? this.regionPlans(container, pc.part, pc.bytes)
        : new Map<XmlElement, RegionPlan>();
    let open: {
      plan: RegionPlan;
      nodes: JsonNode[];
      order: string[];
      gaps: Array<[number, number]>;
      gapStart: number;
    } | null = null;
    for (const c of container.children) {
      if (!started) {
        if (c === after) started = true;
        continue;
      }
      if (c.kind !== 'element') continue;
      const name = nameOf(c);
      if (MARKERS.has(name)) continue;
      if (pc.kind === 'body' && name === W_SECTPR) {
        finalSectPr = c;
        continue;
      }
      if (finalSectPr) this.warnings.push(`${pc.part}: content after the final sectPr`);
      const outer = this.block_;
      const mapped = await this.block(c, pc);
      this.block_ = outer;
      const id = String(mapped.node.attrs!['id']);
      const planned = regions.get(c);
      if (planned) open = { plan: planned, nodes: [], order: [], gaps: [], gapStart: c.start };
      if (open) {
        open.order.push(id);
        open.gaps.push([open.gapStart, c.start]);
        open.gapStart = c.end;
        open.nodes.push(mapped.node);
        if (c === open.plan.last) {
          const rid = nodeId();
          const node: JsonNode = {
            type: 'region',
            attrs: { id: rid, policy: open.plan.locked ? 'restricted' : 'inherit' },
            content: open.nodes,
          };
          order.push(rid);
          gaps.push([gapStart, open.plan.first.start]);
          gapStart = c.end;
          out.push(node);
          this.source(node, { part: pc.part, start: open.plan.first.start, end: c.end, hash: '' });
          this.sm.containers[`region:${rid}`] = {
            part: pc.part,
            order: open.order,
            gaps: open.gaps,
            trailing: [c.end, c.end],
            contentStart: open.plan.first.start,
            contentEnd: c.end,
          };
          this.count(this.stats.nodes, 'region');
          this.reportRegion(open.plan, open.order[0]!, pc.part);
          open = null;
        }
        continue;
      }
      order.push(id);
      gaps.push([gapStart, c.start]);
      gapStart = c.end;
      out.push(mapped.node);
      if (mapped.sectPr && pc.kind === 'body') {
        const sb: JsonNode = { type: 'section_break', attrs: { id: nodeId(), pageSetup: '' } };
        out.push(sb);
        this.count(this.stats.nodes, 'section_break');
        // Its original element is the paragraph-level w:sectPr inside the holder block.
        const target: NodeSource = {
          part: pc.part,
          start: mapped.sectPr.start,
          end: mapped.sectPr.end,
          hash: '',
        };
        this.sm.breaks[String(sb.attrs!['id'])] = target;
        this.pending.push({ node: sb, target });
        sections.push({ el: mapped.sectPr, holder: this.sm.nodes[id]!, breakNode: sb });
      }
    }
    const contentEnd = container.endTagStart;
    const cs: ContainerSource = {
      part: pc.part,
      order,
      gaps,
      trailing: [gapStart, finalSectPr ? finalSectPr.start : contentEnd],
      contentStart,
      contentEnd,
    };
    if (finalSectPr) {
      cs.sectPr = [finalSectPr.start, finalSectPr.end];
      cs.tail = [finalSectPr.end, contentEnd];
      sections.push({ el: finalSectPr, holder: null, breakNode: null });
    }
    this.sm.containers[key] = cs;
    if (!out.length) {
      // Content expressions need a block; this one is not written unless edited.
      const p: JsonNode = { type: 'paragraph', attrs: { id: nodeId() } };
      this.synthetic(p);
      out.push(p);
    }
    // A body paragraph follows every region, as Word keeps one after a table (03 section 4.2).
    // The added paragraphs are not written unless edited.
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.type !== 'region' || out[i + 1]?.type === 'paragraph') continue;
      const p: JsonNode = { type: 'paragraph', attrs: { id: nodeId() } };
      this.synthetic(p);
      out.splice(i + 1, 0, p);
    }
    return out;
  }

  /** The regions of the body, by their first block (EXP-104); what cannot be one is reported. */
  regionPlans(container: XmlElement, part: string, bytes: Uint8Array): Map<XmlElement, RegionPlan> {
    // Most files hold no editable range: the raw bytes say so without a walk of the tree.
    if (!hasPermStart(bytes)) return new Map();
    const kids = elements(container);
    const blocks = kids.filter((k) => !MARKERS.has(nameOf(k)) && nameOf(k) !== W_SECTPR);
    const plans = new Map<XmlElement, RegionPlan>();
    const found = planRegions(kids, blocks, (el) => MARKERS.has(nameOf(el)));
    for (const p of found.plans) plans.set(p.first, p);
    for (const r of found.refused) {
      this.note(
        'editable range',
        'preserved',
        'an editable range that cannot be a region is kept as preserved content',
        null,
      );
      this.warnings.push(
        `${part}: editable range ${r.ids.join(', ')} was not imported as a region: ${r.reason}`,
      );
    }
    return plans;
  }

  /** Reports a region built from editable ranges, with its location (EXP-104). */
  reportRegion(plan: RegionPlan, firstBlock: string, part: string): void {
    const where = `body block ${plan.from + 1}${plan.to > plan.from ? ` to ${plan.to + 1}` : ''}`;
    const who = plan.editors.length ? ` (editors: ${plan.editors.join(', ')})` : '';
    if (plan.locked) {
      this.note(
        'editable range',
        'approximated',
        'an editable range that does not cover whole blocks was imported as a locked region',
        firstBlock,
      );
      this.warnings.push(
        `${part}: editable range ${plan.ids.join(', ')} at ${where}${who} is imported as a locked region: ${plan.reason || 'it does not cover whole blocks'}; the owner can unlock it`,
      );
    } else if (plan.ids.length > 1) {
      this.note(
        'editable range',
        'approximated',
        'overlapping or nested editable ranges were flattened into one region',
        firstBlock,
      );
      this.warnings.push(
        `${part}: editable ranges ${plan.ids.join(', ')} at ${where}${who} overlap or nest and were flattened into one region`,
      );
    } else {
      this.note(
        'editable range',
        'approximated',
        'an editable range became a region without grants',
        firstBlock,
      );
    }
  }

  async block(el: XmlElement, pc: PartCtx): Promise<{ node: JsonNode; sectPr: XmlElement | null }> {
    const name = nameOf(el);
    let label: string | undefined;
    if (name === W_P) {
      if (this.preserve && inexpressibleRevision(el)) {
        this.stats.fallbacks.trackedParagraphs++;
        label = 'tracked change';
      } else {
        const p = await this.paragraph(el, pc);
        if (p) return p;
        this.stats.fallbacks.paragraphToBlock++;
      }
    } else if (name === W_TBL && pc.kind === 'body') {
      if (this.preserve && inexpressibleTableRevision(el)) {
        this.stats.fallbacks.trackedTables++;
        label = 'tracked change';
      } else {
        const t = await this.table(el, pc);
        if (t) return { node: t, sectPr: null };
        this.stats.fallbacks.tableToBlock++;
      }
    } else if (name === W_TBL) {
      // Tables do not nest in version 1, and stories cannot hold them (I10).
      label = pc.kind === 'cell' ? 'nested table' : 'table in a header or footer';
    }
    // A preserved paragraph that holds section properties still ends its section.
    const pPr = name === W_P ? child(el, NS.w, 'pPr') : undefined;
    const sectPr = pPr && pc.kind === 'body' ? (child(pPr, NS.w, 'sectPr') ?? null) : null;
    const node = await this.preservedBlock(el, pc, label, sectPr);
    return { node, sectPr };
  }

  async paragraph(
    p: XmlElement,
    pc: PartCtx,
  ): Promise<{ node: JsonNode; sectPr: XmlElement | null } | null> {
    const id = nodeId();
    const attrs: Record<string, JsonValue> = { id };
    const identity = attrsOf(p, (n) => !IDENTITY_ATTRS.has(n));
    const extra = attrsOf(p, (n) => IDENTITY_ATTRS.has(n));
    const pPr = child(p, NS.w, 'pPr');
    let sectPr: XmlElement | null = null;
    const body: TreeBody = {};
    try {
      if (pPr) {
        sectPr = child(pPr, NS.w, 'sectPr') ?? null;
        const read = readContainer(PPR, elements(pPr), this.ctx, this.stats);
        for (const [k, v] of Object.entries(read.values)) if (v !== null) attrs[k] = v;
        // The list the paragraph is in (EXP-100 criterion 3). The `w:numPr` stays in the residue.
        const numPr = child(pPr, NS.w, 'numPr');
        if (numPr && this.numberingImport) {
          const n = this.numberingImport.forParagraph(
            attr(child(numPr, NS.w, 'numId') ?? numPr, NS.w, 'val'),
            attr(child(numPr, NS.w, 'ilvl') ?? numPr, NS.w, 'val'),
          );
          if (n) {
            attrs['numbering'] = n.numbering;
            if (n.restart !== null) attrs['numberingRestart'] = n.restart;
          }
        }
        const pPrAttrs = attrsOf(pPr);
        if (read.residue.length || Object.keys(pPrAttrs).length) {
          const holder: TreeElement = { name: W_PPR };
          if (Object.keys(pPrAttrs).length) holder.attrs = pPrAttrs;
          if (read.residue.length) holder.children = read.residue;
          body.children = [holder];
        }
      }
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    if (Object.keys(extra).length) body.attrs = extra;
    const identityTree = splitIdentity(body, IDENTITY_ATTRS);
    if (this.preserve && (body.attrs || body.children)) {
      if (!this.fits(body, 'paragraph')) return null;
      attrs['preserved'] = body as unknown as JsonValue;
    }
    this.block_ = id;
    if (attrs['preserved'])
      this.note(
        'formatting the editor does not show',
        'preserved',
        'preserved, not editable: kept with the paragraph and written back to Word; not shown in the editor',
      );
    const content: JsonNode[] = [];
    await this.inline(p.children, pc, [], content);
    const node: JsonNode = { type: 'paragraph', attrs };
    if (content.length) node.content = content;
    const target: NodeSource = { part: pc.part, start: p.start, end: p.end, hash: '' };
    if (Object.keys(identity).length) target.identity = identity;
    if (identityTree.length) target.identityTree = identityTree;
    this.source(node, target);
    this.count(this.stats.nodes, 'paragraph');
    if (attrs['preserved']) this.count(this.stats.nodesWithPreserved, 'paragraph');
    return { node, sectPr };
  }

  async preservedBlock(
    el: XmlElement,
    pc: PartCtx,
    labelOverride?: string,
    sectPr?: XmlElement | null,
  ): Promise<JsonNode> {
    const id = nodeId();
    this.block_ = id;
    const node = await this.fragmentAtom(el, pc, 'none', [], 'preserved_block', labelOverride);
    node.attrs = { id, ...node.attrs };
    const target: NodeSource = { part: pc.part, start: el.start, end: el.end, hash: '' };
    if (sectPr) target.sectPrRange = [sectPr.start, sectPr.end];
    this.source(node, target);
    this.count(this.stats.nodes, 'preserved_block');
    this.count(this.stats.preservedBlock, String(node.attrs['label']));
    return node;
  }

  // -------------------------------------------------------------------------------------------
  // Tables.

  async table(tbl: XmlElement, pc: PartCtx): Promise<JsonNode | null> {
    // Structural checks first, so that an unmappable table creates nothing.
    const kids = elements(tbl);
    const tblPr = child(tbl, NS.w, 'tblPr');
    const tblGrid = child(tbl, NS.w, 'tblGrid');
    if (!tblGrid) return null;
    const rows: XmlElement[] = [];
    for (const k of kids) {
      const n = nameOf(k);
      if (n === W_TR) rows.push(k);
      else if (k !== tblPr && k !== tblGrid && !MARKERS.has(n)) return null;
    }
    if (!rows.length) return null;
    const grid: number[] = [];
    for (const g of elements(tblGrid)) {
      if (g.ns !== NS.w || g.local !== 'gridCol') return null;
      const v = attr(g, NS.w, 'w');
      const n = v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : NaN;
      if (!(n >= 0 && n <= 31680)) return null;
      grid.push(n);
    }
    if (grid.length < 1 || grid.length > 63) return null;
    for (const r of rows) {
      const trPr = child(r, NS.w, 'trPr');
      if (trPr && (child(trPr, NS.w, 'gridBefore') || child(trPr, NS.w, 'gridAfter'))) return null;
      let span = 0;
      for (const c of elements(r)) {
        const n = nameOf(c);
        if (n === W_TC) {
          const tcPr = child(c, NS.w, 'tcPr');
          const gs = tcPr ? child(tcPr, NS.w, 'gridSpan') : undefined;
          const v = gs ? Number(attr(gs, NS.w, 'val') ?? '1') : 1;
          if (!Number.isInteger(v) || v < 1) return null;
          span += v;
        } else if (n !== w('trPr') && n !== w('tblPrEx') && !MARKERS.has(n)) return null;
      }
      if (span !== grid.length) return null;
    }
    this.vMerges = planVMerges(rows);
    let tblPrRead;
    try {
      tblPrRead = tblPr ? readContainer(TBLPR, elements(tblPr), this.ctx, this.stats) : null;
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    // Header rows: the leading rows whose w:tblHeader is the plain empty element.
    let headerRows = 0;
    for (const r of rows) {
      const th = child(r, NS.w, 'trPr') && child(child(r, NS.w, 'trPr')!, NS.w, 'tblHeader');
      if (!th || th.attrs.length || th.children.length) break;
      headerRows++;
    }

    const id = nodeId();
    const attrs: Record<string, JsonValue> = { id, grid };
    if (tblPrRead)
      for (const [k, v] of Object.entries(tblPrRead.values)) if (v !== null) attrs[k] = v;
    if (headerRows) attrs['headerRows'] = headerRows;
    const body: TreeBody = {};
    const extra = attrsOf(tbl, (n) => IDENTITY_ATTRS.has(n));
    if (Object.keys(extra).length) body.attrs = extra;
    const head: TreeElement[] = [];
    try {
      if (tblPr && (tblPrRead!.residue.length || tblPr.attrs.length)) {
        const holder: TreeElement = { name: w('tblPr') };
        if (tblPr.attrs.length) holder.attrs = attrsOf(tblPr);
        if (tblPrRead!.residue.length) holder.children = tblPrRead!.residue;
        head.push(holder);
      }
      if (canonical(tblGrid) !== canonicalTree(gridElement(grid))) head.push(toTree(tblGrid));
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    if (head.length) body.children = head;
    // Identity-bound values (rsid) of the table and its properties go to the source map (EXP-116).
    const tableIdentityTree = splitIdentity(body, IDENTITY_ATTRS);
    if (this.preserve && (body.attrs || body.children)) {
      if (!this.fits(body, 'table')) return null;
      attrs['preserved'] = body as unknown as JsonValue;
    }
    this.block_ = id;
    const cellPc: PartCtx = { ...pc, kind: 'cell' };
    const rowNodes: JsonNode[] = [];
    const order: string[] = [];
    const gaps: Array<[number, number]> = [];
    let gapStart = tblGrid.end;
    for (const [i, r] of rows.entries()) {
      const row = await this.row(r, cellPc, i < headerRows);
      if (!row) return null;
      order.push(String(row.attrs!['id']));
      gaps.push([gapStart, r.start]);
      gapStart = r.end;
      rowNodes.push(row);
    }
    this.sm.containers[id] = {
      part: pc.part,
      order,
      gaps,
      trailing: [gapStart, tbl.endTagStart],
      contentStart: tblGrid.end,
      contentEnd: tbl.endTagStart,
    };
    const node: JsonNode = { type: 'table', attrs, content: rowNodes };
    const identity = attrsOf(tbl, (n) => !IDENTITY_ATTRS.has(n));
    const target: NodeSource = { part: pc.part, start: tbl.start, end: tbl.end, hash: '' };
    if (Object.keys(identity).length) target.identity = identity;
    if (tableIdentityTree.length) target.identityTree = tableIdentityTree;
    if (!tblPr) target.flags = ['no-tblPr'];
    this.source(node, target);
    this.count(this.stats.nodes, 'table');
    if (attrs['preserved']) this.count(this.stats.nodesWithPreserved, 'table');
    return node;
  }

  async row(tr: XmlElement, pc: PartCtx, header: boolean): Promise<JsonNode | null> {
    const id = nodeId();
    const attrs: Record<string, JsonValue> = { id };
    const trPr = child(tr, NS.w, 'trPr');
    const tblPrEx = child(tr, NS.w, 'tblPrEx');
    const body: TreeBody = {};
    const extra = attrsOf(tr, (n) => IDENTITY_ATTRS.has(n));
    if (Object.keys(extra).length) body.attrs = extra;
    const head: TreeElement[] = [];
    const marks: JsonMark[] = [];
    try {
      if (tblPrEx) head.push(toTree(tblPrEx));
      if (trPr) {
        const read = readContainer(
          header ? TRPR_HEADER : TRPR,
          elements(trPr),
          this.ctx,
          this.stats,
        );
        for (const [k, v] of Object.entries(read.values)) if (v !== null) attrs[k] = v;
        if (read.residue.length || trPr.attrs.length) {
          const holder: TreeElement = { name: w('trPr') };
          if (trPr.attrs.length) holder.attrs = attrsOf(trPr);
          if (read.residue.length) holder.children = read.residue;
          head.push(holder);
        }
        // A tracked insertion or deletion of the whole row (EXP-103).
        for (const rev of elements(trPr))
          if (nameOf(rev) === W_INS || nameOf(rev) === W_DEL) {
            if (marks.some((m) => m.type === (rev.local === 'ins' ? 'ins' : 'del'))) return null;
            marks.push(this.suggestion(rev));
            this.stats.suggestions.rows++;
          }
      }
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    if (head.length) body.children = head;
    const rowIdentityTree = splitIdentity(body, IDENTITY_ATTRS);
    if (this.preserve && (body.attrs || body.children)) {
      if (!this.fits(body, 'table_row')) return null;
      attrs['preserved'] = body as unknown as JsonValue;
    }
    const cells: JsonNode[] = [];
    const order: string[] = [];
    const gaps: Array<[number, number]> = [];
    const headEnd = Math.max(tr.startTagEnd, trPr?.end ?? 0, tblPrEx?.end ?? 0);
    let gapStart = headEnd;
    for (const c of elements(tr)) {
      if (nameOf(c) !== W_TC) continue;
      // A continuation cell absorbed by a row span stays in the gap of the source map (EXP-101).
      if (this.vMerges.absorbed.has(c)) continue;
      const cell = await this.cell(c, pc);
      if (!cell) return null;
      order.push(String(cell.attrs!['id']));
      gaps.push([gapStart, c.start]);
      gapStart = c.end;
      cells.push(cell);
    }
    this.sm.containers[id] = {
      part: pc.part,
      order,
      gaps,
      trailing: [gapStart, tr.endTagStart],
      contentStart: headEnd,
      contentEnd: tr.endTagStart,
    };
    // A suggested row keeps its suggestion in `suggest`, not in marks (owner decision 92).
    if (marks.length) attrs['suggest'] = sortMarks(marks) as unknown as JsonValue;
    const node: JsonNode = { type: 'table_row', attrs, content: cells };
    const identity = attrsOf(tr, (n) => !IDENTITY_ATTRS.has(n));
    const target: NodeSource = { part: pc.part, start: tr.start, end: tr.end, hash: '' };
    if (Object.keys(identity).length) target.identity = identity;
    if (rowIdentityTree.length) target.identityTree = rowIdentityTree;
    if (header) target.flags = ['header'];
    this.source(node, target);
    this.count(this.stats.nodes, 'table_row');
    if (attrs['preserved']) this.count(this.stats.nodesWithPreserved, 'table_row');
    return node;
  }

  async cell(tc: XmlElement, pc: PartCtx): Promise<JsonNode | null> {
    const id = nodeId();
    const attrs: Record<string, JsonValue> = { id };
    const tcPr = child(tc, NS.w, 'tcPr');
    const body: TreeBody = {};
    const extra = attrsOf(tc, (n) => IDENTITY_ATTRS.has(n));
    if (Object.keys(extra).length) body.attrs = extra;
    try {
      if (tcPr) {
        const read = readContainer(TCPR, elements(tcPr), this.ctx, this.stats);
        for (const [k, v] of Object.entries(read.values)) if (v !== null) attrs[k] = v;
        if (read.residue.length || tcPr.attrs.length) {
          const holder: TreeElement = { name: w('tcPr') };
          if (tcPr.attrs.length) holder.attrs = attrsOf(tcPr);
          if (read.residue.length) holder.children = read.residue;
          body.children = [holder];
        }
      }
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    const rowspan = this.vMerges.spans.get(tc);
    if (rowspan !== undefined) attrs['rowspan'] = rowspan;
    const cellIdentityTree = splitIdentity(body, IDENTITY_ATTRS);
    if (this.preserve && (body.attrs || body.children)) {
      if (!this.fits(body, 'table_cell')) return null;
      attrs['preserved'] = body as unknown as JsonValue;
    }
    const content = await this.blocks(tc, pc, id, [], tcPr ?? undefined);
    const node: JsonNode = { type: 'table_cell', attrs, content };
    const identity = attrsOf(tc, (n) => !IDENTITY_ATTRS.has(n));
    const target: NodeSource = { part: pc.part, start: tc.start, end: tc.end, hash: '' };
    if (Object.keys(identity).length) target.identity = identity;
    if (cellIdentityTree.length) target.identityTree = cellIdentityTree;
    this.source(node, target);
    this.count(this.stats.nodes, 'table_cell');
    if (attrs['preserved']) this.count(this.stats.nodesWithPreserved, 'table_cell');
    return node;
  }

  // -------------------------------------------------------------------------------------------
  // Inline content.

  /**
   * The inline content of a paragraph. `marks` holds the suggestion marks of the revisions around
   * it: inline atoms carry them as text does (CDM-051), so a tracked insertion of a picture, a tab
   * or a field is an `ins` mark on that atom.
   */
  async inline(
    children: XmlNode[],
    pc: PartCtx,
    marks: JsonMark[],
    out: JsonNode[],
  ): Promise<void> {
    for (const c of children) {
      if (c.kind !== 'element') {
        if (c.kind === 'text' && !isWhitespaceText(c))
          this.count(this.stats.dropped, 'text directly in a paragraph');
        else if (c.kind !== 'text') this.count(this.stats.dropped, c.kind);
        continue;
      }
      const name = nameOf(c);
      if (name === W_PPR) continue;
      if (name === W_R) {
        await this.textRun(c, pc, marks, out);
        continue;
      }
      if (name === W_INS || name === W_DEL) {
        // Nesting is limited by inexpressibleRevision(): at most an insertion holding a deletion.
        await this.inline(c.children, pc, [...marks, this.suggestion(c)], out);
        continue;
      }
      if (REGENERATED.has(name)) {
        this.count(this.stats.dropped, c.local);
        this.note(
          'proofing marks and page-break cache',
          'dropped',
          'Word regenerates them; dropped only from paragraphs that are edited',
        );
        continue;
      }
      if (name === w('sdt')) {
        const cited = await this.citation(c, pc, marks);
        if (cited) {
          out.push(cited);
          continue;
        }
      }
      if (!this.preserve) continue;
      out.push(this.smallAtom(c, marks) ?? (await this.fragmentAtom(c, pc, 'none', marks)));
    }
  }

  suggestion(el: XmlElement): JsonMark {
    const id = nodeId();
    const author = attr(el, NS.w, 'author') ?? 'Unknown';
    this.sm.suggestions[id] = { element: nameOf(el), attrs: attrsOf(el) };
    return {
      type: el.local === 'ins' ? 'ins' : 'del',
      attrs: { id, user: `word:${author}`.slice(0, 255) },
    };
  }

  async textRun(r: XmlElement, pc: PartCtx, sug: JsonMark[], out: JsonNode[]): Promise<void> {
    for (const k of elements(r))
      if (
        nameOf(k) === w('footnoteReference') &&
        this.multiParagraphNotes.has(attr(k, NS.w, 'id') ?? '')
      )
        this.note(
          'footnote of several paragraphs',
          'preserved',
          'preserved, not editable: the note has several paragraphs and is kept whole',
        );
    const rPr = child(r, NS.w, 'rPr') ?? null;
    let runMarks: JsonMark[] = [];
    if (rPr) {
      const m = this.runMarks(rPr);
      if (m === null) {
        this.stats.fallbacks.runToAtom++;
        if (this.preserve) out.push(await this.fragmentAtom(r, pc, 'none', sug, undefined, 'run'));
        return;
      }
      runMarks = m;
    }
    const marks = [...runMarks, ...sug];
    const hasPreserved = runMarks.some((m) => m.type === 'preserved');
    for (const c of elements(r)) {
      const name = nameOf(c);
      if (name === W_RPR) continue;
      if (name === W_T || name === W_DELTEXT) {
        const t = textContent(c);
        if (t) {
          out.push(withMarks({ type: 'text', text: t }, marks));
          this.stats.textNodes++;
          if (hasPreserved) this.stats.textWithPreservedMark++;
          if (sug.length) this.stats.suggestions.text++;
        }
        continue;
      }
      if (REGENERATED.has(name)) {
        this.count(this.stats.dropped, c.local);
        this.note(
          'proofing marks and page-break cache',
          'dropped',
          'Word regenerates them; dropped only from paragraphs that are edited',
        );
        continue;
      }
      const atom = this.runAtom(c, pc, marks);
      if (atom) {
        out.push(atom);
        continue;
      }
      if (name === W_DRAWING) {
        const img = await this.picture(c, pc, marks);
        if (img) {
          out.push(img);
          continue;
        }
      }
      if (this.preserve)
        out.push(this.smallAtom(c, marks) ?? (await this.fragmentAtom(c, pc, 'run', marks)));
    }
    if (hasPreserved)
      this.note(
        'formatting the editor does not show',
        'preserved',
        'preserved, not editable: kept with the paragraph and written back to Word; not shown in the editor',
      );
  }

  /** Tabs and breaks the model represents, with the marks of their run (CDM-051). */
  runAtom(c: XmlElement, pc: PartCtx, marks: JsonMark[]): JsonNode | null {
    const name = nameOf(c);
    const counted = (n: JsonNode): JsonNode => {
      if (marks.length) this.count(this.stats.markedAtoms, n.type);
      if (marks.some((m) => m.type === 'ins' || m.type === 'del')) this.stats.suggestions.atoms++;
      return withMarks(n, marks);
    };
    if (name === W_TAB && !c.attrs.length && !c.children.length) return counted({ type: 'tab' });
    if (name !== W_BR || c.children.length) return null;
    if (!c.attrs.length) return counted({ type: 'break' });
    if (c.attrs.length !== 1) return null;
    const t = attr(c, NS.w, 'type');
    // Page and column breaks are not allowed in cells (I10): they stay atoms there.
    if ((t === 'page' || t === 'column') && pc.kind !== 'cell')
      return counted({ type: 'break', attrs: { kind: t } });
    return null;
  }

  /** Marks for a run's properties, or null when the residue does not fit the grammar. */
  runMarks(rPr: XmlElement): JsonMark[] | null {
    let read;
    try {
      read = readContainer(RPR, elements(rPr), this.ctx, this.stats);
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    const marks = valuesToMarks(read.values);
    const rPrAttrs = attrsOf(rPr);
    if (this.preserve && (read.residue.length || Object.keys(rPrAttrs).length)) {
      const props: TreeBody = {};
      if (Object.keys(rPrAttrs).length) props.attrs = rPrAttrs;
      if (read.residue.length) props.children = read.residue;
      // Identity-bound values go to the source map, keyed by the canonical text of what stays in
      // the mark (EXP-116 criterion 3). Runs with equal residue share the first run's values: they
      // are editing-session identifiers, and any one of them is valid for Word.
      const identityTree = splitIdentity(props, IDENTITY_ATTRS);
      if (identityTree.length) {
        const runIdentity = (this.sm.runIdentity ??= {});
        runIdentity[canonicalize(props)] ??= identityTree;
      }
      if (!this.fits(props, 'preserved mark')) return null;
      marks.push({ type: 'preserved', attrs: { props: props as unknown as JsonValue } });
    }
    return marks;
  }

  /**
   * An inline picture as an `image` node with an `origin`: the fragment holds the original
   * `w:drawing`, and the hash of the modelled attributes tells the writer whether the picture was
   * edited (SR-M10; spike S11, model change 2). The run's formatting and suggestions are the
   * node's marks.
   */
  async picture(drawing: XmlElement, pc: PartCtx, marks: JsonMark[]): Promise<JsonNode | null> {
    const inl = child(drawing, NS.wp, 'inline');
    const graphic = inl && child(inl, NS.a, 'graphic');
    const gd = graphic && child(graphic, NS.a, 'graphicData');
    if (!inl || !gd || attr(gd, '', 'uri') !== PIC_URI) return null;
    const pic = child(gd, NS.pic, 'pic');
    const blipFill = pic && child(pic, NS.pic, 'blipFill');
    const blip = blipFill && child(blipFill, NS.a, 'blip');
    const embed = blip && attr(blip, NS.r, 'embed');
    const rel = embed ? pc.rels.byId.get(embed) : undefined;
    if (!rel || rel.external) return null;
    const asset = await this.imageAsset(resolveTarget(pc.part, rel.target));
    if (!asset) return null;
    const extent = child(inl, NS.wp, 'extent');
    const width = emuToTwips(extent && attr(extent, '', 'cx'));
    const height = emuToTwips(extent && attr(extent, '', 'cy'));
    if (!width || !height || width > 31680 || height > 31680) return null;
    const docPr = child(inl, NS.wp, 'docPr');
    const alt = docPr ? cleanText(attr(docPr, '', 'descr') ?? '') : null;
    const attrs: Record<string, JsonValue> = { asset, width, height };
    if (alt) attrs['alt'] = alt;
    try {
      this.atomTreeStat('picture', toTree(drawing));
    } catch {
      // Measured only.
    }
    const node: JsonNode = { type: 'image', attrs };
    if (this.preserve) {
      const fragment = await this.fragment(
        { xml: pc.bytes.slice(drawing.start, drawing.end), el: drawing },
        'picture',
        pc,
        'run',
      );
      attrs['origin'] = { fragment, hash: await modelledHash(node) };
      this.preserveUsed = true;
    }
    this.stats.images++;
    this.count(this.stats.nodes, 'image');
    if (marks.length) this.count(this.stats.markedAtoms, 'image');
    if (marks.some((m) => m.type === 'ins' || m.type === 'del')) this.stats.suggestions.atoms++;
    return withMarks(node, marks);
  }

  atomTreeStat(where: string, tree: TreeElement): void {
    const body: TreeBody = {};
    if (tree.attrs) body.attrs = tree.attrs;
    if (tree.children) body.children = tree.children;
    this.stats.atomTrees.push({
      where,
      depth: treeDepth(body),
      bytes: utf8(canonicalize(body)).length,
    });
  }

  async imageAsset(part: string): Promise<string | null> {
    const known = this.imageAssets.get(part);
    if (known) return known;
    const bytes = this.read(part);
    if (!bytes) return null;
    const id = await this.assets.add(
      bytes,
      contentTypeOf(this.ct, part) ?? 'application/octet-stream',
      'image',
    );
    this.imageAssets.set(part, id);
    return id;
  }

  /**
   * A small atom without relationships, kept as the element tree of a `preserved_inline` (spike
   * S11, model change 7): bookmarks, comment anchors, field characters and codes, references to
   * notes. No fragment asset is needed for them.
   */
  smallAtom(el: XmlElement, marks: JsonMark[]): JsonNode | null {
    if (!this.preserve) return null;
    const name = nameOf(el);
    if (!SMALL_ATOMS.has(name) || refersToRelationships(el)) return null;
    let tree: TreeElement;
    try {
      tree = toTree(el);
    } catch (e) {
      if (e instanceof NotRepresentable) return null;
      throw e;
    }
    const body: TreeBody = { children: [tree] };
    if (
      utf8(canonicalize(body)).length > SMALL_TREE_BYTES ||
      checkPreserved(body, this.grammar).length
    )
      return null;
    this.stats.trees.push({
      where: 'small atom',
      depth: treeDepth(body),
      bytes: utf8(canonicalize(body)).length,
    });
    const label = labelFor(el);
    const attrs: Record<string, JsonValue> = { label, tree: body as unknown as JsonValue };
    if (!MARKER_LABELS.has(label)) attrs['fallbackText'] = cleanText(textContent(el)) ?? label;
    this.preserveUsed = true;
    this.stats.smallAtoms++;
    this.countAtom(label, marks);
    if (RUN_CONTENT.has(name) && marks.length)
      this.count(this.stats.markedAtoms, 'preserved_inline');
    return withMarks({ type: 'preserved_inline', attrs }, marks);
  }

  countAtom(label: string, marks: JsonMark[]): void {
    this.count(this.stats.preservedInline, label);
    this.count(this.stats.nodes, 'preserved_inline');
    if (marks.some((m) => m.type === 'ins' || m.type === 'del')) this.stats.suggestions.atoms++;
    this.note(label, 'preserved', PRESERVED_MESSAGE);
  }

  /**
   * A preserved atom (inline or block) with its fragment and fallbacks. Run content (`wrap` run)
   * keeps only the element: its run properties are the atom's marks (CDM-051).
   */
  async fragmentAtom(
    el: XmlElement,
    pc: PartCtx,
    wrap: 'run' | 'none',
    marks: JsonMark[],
    type: 'preserved_inline' | 'preserved_block' = 'preserved_inline',
    labelOverride?: string,
  ): Promise<JsonNode> {
    const label = labelOverride ?? labelFor(el);
    // A floating drawing is reported on its own line too, beside its content kind (EXP-107).
    if (DRAWING_HOSTS.has(nameOf(el)) && isAnchored(el))
      this.note(FLOATING_KIND, 'preserved', PRESERVED_MESSAGE);
    if (nameOf(el) === w('hyperlink')) this.checkLinkAddress(el, pc);
    if (label === 'equation' || label === 'field' || label === 'field code') {
      try {
        this.atomTreeStat(label, toTree(el));
      } catch {
        // Not representable as a tree: measured only.
      }
    }
    const fragment = await this.fragment(
      { xml: pc.bytes.slice(el.start, el.end), el },
      label,
      pc,
      wrap,
    );
    const attrs: Record<string, JsonValue> = { label, fragment };
    for (const id of referencedRelIds(el)) {
      const rel = pc.rels.byId.get(id);
      if (rel && !rel.external && rel.type === REL.image) {
        const a = await this.imageAsset(resolveTarget(pc.part, rel.target));
        if (a) {
          attrs['fallbackAsset'] = a;
          break;
        }
      }
    }
    const isMarker = MARKERS.has(nameOf(el)) || MARKER_LABELS.has(label);
    // The text of a drawing is its content, not a rendering of it: without a fallback picture the
    // fallback names the kind, as "Chart" does (EXP-117, criterion 3).
    const drawn = DRAWING_HOSTS.has(nameOf(el)) || nameOf(el) === w('pict');
    const text = isMarker || drawn ? null : cleanText(textContent(el));
    if (text) attrs['fallbackText'] = text;
    else if (!isMarker && !attrs['fallbackAsset']) attrs['fallbackText'] = label;
    const size = this.atomSize(el);
    if (size) {
      attrs['width'] = size[0];
      attrs['height'] = size[1];
    }
    this.preserveUsed = true;
    if (type === 'preserved_inline') {
      this.countAtom(label, marks);
      if (wrap === 'run' && marks.length) this.count(this.stats.markedAtoms, 'preserved_inline');
      return withMarks({ type, attrs }, marks);
    }
    this.note(label, 'preserved', PRESERVED_MESSAGE);
    return { type, attrs };
  }

  /**
   * A hyperlink is kept whole as a preserved atom (A2) and never followed. An external address that
   * the link allow-list (I9) does not accept is reported, so that the author knows it stays as it
   * was in the file and will not become a link in the editor (EXP-102, criterion 4).
   */
  checkLinkAddress(el: XmlElement, pc: PartCtx): void {
    const id = attr(el, NS.r, 'id');
    const rel = id ? pc.rels.byId.get(id) : undefined;
    if (!rel || !rel.external || new RegExp(LINK_HREF_PATTERN).test(rel.target)) return;
    this.note(
      REFUSED_LINK_KIND,
      'preserved',
      'preserved, not editable: the address is not an allowed link address and is never followed',
    );
  }

  atomSize(el: XmlElement): [number, number] | null {
    const stack = [el];
    while (stack.length) {
      const e = stack.pop()!;
      if (e.ns === NS.wp && e.local === 'extent') {
        const cx = emuToTwips(attr(e, '', 'cx'));
        const cy = emuToTwips(attr(e, '', 'cy'));
        if (cx !== null && cy !== null) return [clampLength(cx), clampLength(cy)];
      }
      for (const c of e.children) if (c.kind === 'element') stack.push(c);
    }
    return null;
  }

  async fragment(
    source: { xml: Uint8Array; el: XmlElement },
    label: string,
    pc: PartCtx,
    wrap: 'run' | 'none',
  ): Promise<string> {
    const rels: Relationship[] = [];
    for (const id of referencedRelIds(source.el)) {
      const r = pc.rels.byId.get(id);
      if (r) rels.push(r);
    }
    const parts = this.relatedParts(pc.part, rels);
    const meta: FragmentMeta = {
      v: 1,
      label,
      wrap,
      part: pc.part,
      namespaces: usedNamespaces(source.el),
      rels: rels.map((r) => ({ id: r.id, type: r.type, target: r.target, external: r.external })),
      parts: parts.map((p) => ({
        name: p.name,
        contentType: contentTypeOf(this.ct, p.name) ?? null,
      })),
    };
    const bytes = buildFragment(
      meta,
      source.xml,
      this.zip,
      parts.map((p) => ({ entry: this.zip.byName.get(p.name)! })),
    );
    const id = await this.assets.add(bytes, FRAGMENT_CONTENT_TYPE, 'fragment');
    this.fragmentIds.add(id);
    return id;
  }

  /** Internal targets of the relationships, with their own relationship parts and targets, transitively. */
  relatedParts(source: string, rels: Relationship[]): Array<{ name: string }> {
    const out: Array<{ name: string }> = [];
    const seen = new Set<string>([source]);
    const queue: Array<[string, Relationship]> = rels.map((r) => [source, r]);
    while (queue.length) {
      const [from, r] = queue.shift()!;
      if (r.external) continue;
      const target = resolveTarget(from, r.target);
      if (seen.has(target) || !this.zip.byName.has(target)) continue;
      seen.add(target);
      out.push({ name: target });
      const relsName = relsPartName(target);
      if (this.zip.byName.has(relsName) && !seen.has(relsName)) {
        seen.add(relsName);
        out.push({ name: relsName });
        for (const sub of this.rels(target).list) queue.push([target, sub]);
      }
    }
    return out;
  }
}

function onOffAttr(s: string | undefined): boolean {
  return s !== undefined && !(s === '0' || s === 'false' || s === 'off');
}

export function gridElement(grid: readonly number[]): TreeElement {
  return {
    name: w('tblGrid'),
    children: grid.map((g) => ({ name: w('gridCol'), attrs: { [w('w')]: String(g) } })),
  };
}

/** Namespace bindings the fragment needs from outside itself: prefixes of names, and prefixes named in markup-compatibility attributes. */
export function usedNamespaces(el: XmlElement): Record<string, string> {
  const prefixes = new Set<string>();
  const stack = [el];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.prefix) prefixes.add(e.prefix);
    for (const a of e.attrs) {
      if (a.prefix && a.prefix !== 'xml') prefixes.add(a.prefix);
      if (
        a.ns === NS.mc ||
        (e.ns === NS.mc && (a.local === 'Requires' || a.local === 'ProcessContent'))
      )
        for (const t of a.value.split(/\s+/)) if (t) prefixes.add(t.split(':')[0]!);
    }
    for (const c of e.children) if (c.kind === 'element') stack.push(c);
  }
  const out: Record<string, string> = {};
  for (const p of [...prefixes].sort()) {
    const uri = el.scope.get(p);
    if (uri !== undefined) out[p] = uri;
  }
  return out;
}

/**
 * Imports a DOCX package. Failures of the package itself (a damaged or hostile ZIP, malformed or
 * refused XML, invalid UTF-8) are ImportError, with the cause's message.
 */
export async function importDocx(
  bytes: Uint8Array,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  try {
    return await new Importer(bytes, opts).run();
  } catch (e) {
    if (e instanceof ImportError) throw e;
    if (e instanceof ZipError || e instanceof XmlError || e instanceof Utf8Error)
      throw new ImportError(e.message, { cause: e });
    throw e;
  }
}

export type { Values };
