/**
 * The direct DOCX writer (09 §11; EXP-090 to EXP-096): a complete new package written from the
 * CDM alone, for a document that was not imported from Word, and for a reader who does not see the
 * whole document (owner decision 1, default: such a requester gets a file written from their
 * projection). Nothing here reads an original package or a fragment: preserved atoms are written
 * as their fallbacks, and `preserved`, `origin` and `preserved_def` are ignored, so active content
 * never reaches such a file (owner decision 12). The patching writer (export.ts) serves lossless
 * exports of imported documents.
 *
 * What Word resolves follows the cascade of 03 §6 (ADR 0032): the base values are the document
 * defaults; a root paragraph style is based on the default style (layer 1); a numbered paragraph
 * states its resolved indents, because Word applies a level's indents after the style's; a run
 * with a character style, or in a styled table, states its toggles explicitly, because Word
 * combines toggles of styles by exclusive or. Every approximation is a warning.
 */
import {
  canonicalize,
  computeLabels,
  dateFieldText,
  referenceText,
  resolveParagraph,
  resolveRun,
  sha256Hex,
  styleTable,
  utf8,
  valueText,
  type CounterEffect,
  type DocumentLabels,
  type JsonEnvelope,
  type JsonMark,
  type JsonNode,
  type ResolvedParagraph,
  type StyleTable,
  type TreeNode as ModelTreeNode,
} from '@docedit/model';
import {
  CDM1,
  LINK_HREF_PATTERN,
  SUGGESTION_HOSTS,
  indexDefinition,
  type JsonValue,
} from '@docedit/model/definition';
import { IMAGE_EXTENSIONS, newDrawing } from './drawing.ts';
import type { AssetSource } from './export.ts';
import { SUGGESTION_MARKS, formattingKey, marksToValues } from './marks.ts';
import { REL, w } from './ooxml.ts';
import {
  type LensContext,
  type MergedItem,
  type Values,
  PPR,
  RPR,
  TBLPR,
  TCPR,
  TRPR,
  mergeContainer,
} from './props.ts';
import { NamespaceWriter } from './tree.ts';
import {
  NumberingBuilder,
  WORD_BUILT_IN_NAMES,
  fontSlots,
  itemsXml,
  marginsXml,
  paragraphExtras,
  stylesPart,
} from './writer-styles.ts';
import {
  ROOT_DECLARATIONS,
  ROOT_NAMESPACES,
  XML_DECLARATION,
  el,
  pixelSize,
  pxToTwips,
  textElement,
  xmlSafe,
} from './writer-xml.ts';
import {
  COMMENT_PARTS,
  type CommentPlan,
  type CommentThread,
  anchorEnds,
  anchorStarts,
  commentsExtendedXml,
  commentsXml,
  planComments,
} from './writer-comments.ts';
import {
  BIBLIOGRAPHY_NS,
  citationInstruction,
  fieldRuns,
  sourcesItemId,
  sourcesPart,
} from './writer-citations.ts';
import { escapeAttr, escapeText } from './xml.ts';
import { type ZipWriteEntry, writeZip } from './zip.ts';

export class WriteError extends Error {
  override name = 'WriteError';
}

export interface WriteOptions {
  /**
   * `markup` (default): suggestions become tracked changes. `accept` and `reject`: the file is as
   * if every suggestion were accepted or rejected, and holds no tracked change (EXP-093).
   */
  suggestions?: 'markup' | 'accept' | 'reject';
  /** Server time of the commit that introduced each suggestion `id`, RFC 3339 (EXP-093). Omitted dates are left out. */
  suggestionDates?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** The name Word shows as a suggestion's author; default: the `user` label without `word:`. */
  authorName?: (user: string) => string;
  /** The server's instant at job creation and the job's time zone, for date fields (03 §7). Never a client value. */
  instant?: string;
  timeZone?: string;
  /** The document's title, for title fields (control-plane metadata, 03 §2). */
  title?: string;
  /**
   * The document's classification label (EXP-089): written as a centred line in the header and in
   * the footer of every page (owner decision 51), whichever variants the sections use.
   */
  classification?: string | null;
  /** The face of the font registry's default (`fontFamily` null), stated in the document defaults. */
  defaultFont?: string;
  /**
   * Whether everyone may edit a region (07 §15). When some region is not, the file gets read-only
   * document protection with editable ranges for the regions everyone may edit (EXP-094).
   */
  regionEditableByEveryone?: (regionId: string) => boolean;
  /** Content outside regions is editable by everyone (an editable range) under that protection. */
  bodyEditableByEveryone?: boolean;
  /** Export identities who may edit a region, from the host's opt-in callback (07 §15); per-user ranges. */
  regionEditors?: (regionId: string) => readonly string[];
  /** Regions in the `approved` workflow state: their content control is locked (EXP-094). */
  approvedRegions?: ReadonlySet<string>;
  /** The region grants, kept in a custom XML part (EXP-094); plain JSON from the host. */
  grants?: JsonValue;
  /** Counter effects of a projection's hidden regions (ADR 0032; owner decision 3). */
  counterEffects?: ReadonlyMap<string, CounterEffect> | Readonly<Record<string, CounterEffect>>;
  /** Comment threads, each anchored to a paragraph, written as Word comments (EXP-093, writer-comments.ts). */
  comments?: readonly CommentThread[];
  /**
   * The math gate of EXP-049, injected by the caller as the authority's room is: the reason an
   * equation is refused, or null when it passes. A refused equation is written as a visible
   * placeholder and named in the warnings with its block identifier, and the rest of the document
   * is written as usual (EXP-096, as EXP-051 does for the PDF). Without it no equation is checked.
   */
  mathGate?: (latex: string) => string | null;
}

/** The text that stands in for an equation that fails the math gate. */
export const MATH_PLACEHOLDER = '[equation not exported]';

export interface WriteResult {
  bytes: Uint8Array;
  /** Approximations and advisories, each once, with a count when it occurred more often. */
  warnings: string[];
  /** The parts of the package, in order. */
  parts: string[];
  /** Form field keys whose values the projection redacted, so the file holds none (EXP-095, ADR 0019). */
  redacted: string[];
}

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface PartCtx {
  name: string;
}

interface BlockCtx {
  tableStyle: string | null;
  /** Suggestion marks of the enclosing block (a suggested row, table or paragraph), applied to its content. */
  blockSuggestions: JsonMark[];
  /** The block that holds `seq` fields being written (a paragraph, or the figure for its caption). */
  seqBlock: string | null;
}

const ix = indexDefinition(CDM1);
const KNOWN_FEATURES = new Set(['fields', 'extensions', 'preserve']);
const TOGGLES = ['bold', 'italic', 'strike', 'smallCaps', 'allCaps', 'hidden'] as const;
/** Run properties with a value, which a table style gives and Word would take from the paragraph style instead. */
const SHADOWED_RUN = [
  'fontFamily',
  'fontSize',
  'color',
  'highlight',
  'vertAlign',
  'underline',
  'lang',
] as const;
/** The same for paragraph properties (`lineSpacing` and `lineRule` go together). */
const SHADOWED_PARAGRAPH = [
  'align',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'contextualSpacing',
  'lineSpacing',
  'lineRule',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'widowControl',
] as const;
const FORMATTING_MARKS = new Set([
  'charStyle',
  'bold',
  'italic',
  'underline',
  'strike',
  'smallCaps',
  'allCaps',
  'vertAlign',
  'fontFamily',
  'fontSize',
  'color',
  'highlight',
  'lang',
  'hidden',
]);
const BOOKMARK_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const CT = {
  main: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  itemProps: 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml',
} as const;
const FIELDS_NS = 'urn:docedit:fields:1';
const GRANTS_NS = 'urn:docedit:grants:1';

/** Node attributes with the definition's defaults filled in, as the lenses expect. */
function withDefaults(node: JsonNode): Values {
  const def = ix.nodes.get(node.type);
  const out: Values = {};
  for (const [k, a] of Object.entries(def?.attrs ?? {}))
    out[k] = (node.attrs?.[k] ?? a.default) as JsonValue;
  return out;
}

/** The identifier of a block, the key its `seq` labels are stored under (the empty string if none). */
const blockId = (n: JsonNode): string => String(n.attrs?.['id'] ?? '');

/** Word's number format switch for a field, from the model's number format names. */
function numberSwitch(format: string | null | undefined): string {
  switch (format) {
    case 'lowerRoman':
      return ' \\* roman';
    case 'upperRoman':
      return ' \\* ROMAN';
    case 'lowerLetter':
      return ' \\* alphabetic';
    case 'upperLetter':
      return ' \\* ALPHABETIC';
    default:
      return ' \\* ARABIC';
  }
}

const FOOTNOTE_FORMATS: Readonly<Record<string, string>> = {
  decimal: 'decimal',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
  lowerLetter: 'lowerLetter',
  upperLetter: 'upperLetter',
  symbol: 'chicago',
};

// ---------------------------------------------------------------------------------------------
// Accepting or rejecting every suggestion (EXP-093, EXP-081).

let settledIds = 0;
const settledId = (): string => `settled${String(++settledIds).padStart(9, '0')}`;

/** The suggestions of a paragraph, a table row or a table: its suggest attribute (owner decision 92). */
function blockSuggest(n: JsonNode): JsonMark[] {
  const s = n.attrs?.['suggest'];
  return Array.isArray(s) ? (s as unknown as JsonMark[]) : [];
}

function settle(node: JsonNode, mode: 'accept' | 'reject'): JsonNode | null {
  const marks = node.marks ?? [];
  const onBlock = SUGGESTION_HOSTS.includes(node.type);
  const sug = onBlock ? blockSuggest(node) : marks;
  if (mode === 'accept' && sug.some((m) => m.type === 'del')) return null;
  if (mode === 'reject' && sug.some((m) => m.type === 'ins')) return null;
  const out: JsonNode = { ...node };
  let kept = marks.filter((m) => !SUGGESTION_MARKS.has(m.type));
  const fmt = sug.find((m) => m.type === 'fmt');
  if (mode === 'reject' && fmt) {
    const before = (fmt.attrs?.['before'] ?? {}) as { marks?: JsonMark[]; attrs?: Values };
    if (node.type === 'text' || ix.nodes.get(node.type)?.inline) {
      kept = [...kept.filter((m) => !FORMATTING_MARKS.has(m.type)), ...(before.marks ?? [])];
    } else if (before.attrs) out.attrs = { ...(node.attrs ?? {}), ...before.attrs };
  }
  if (kept.length) out.marks = kept;
  else delete out.marks;
  if (onBlock && out.attrs && 'suggest' in out.attrs) {
    const { suggest: _settled, ...rest } = out.attrs;
    out.attrs = rest;
  }
  if (node.content) {
    const content = node.content.map((c) => settle(c, mode)).filter((c): c is JsonNode => !!c);
    if (!content.length) {
      if (node.type === 'table' || node.type === 'table_row') return null;
      if (['table_cell', 'body', 'story', 'region', 'footnote', 'caption'].includes(node.type)) {
        if (node.type !== 'caption')
          content.push({ type: 'paragraph', attrs: { id: settledId() } });
      }
    }
    out.content = content;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

class DirectWriter {
  readonly env: JsonEnvelope;
  readonly assets: AssetSource;
  readonly opts: WriteOptions;
  readonly doc: JsonNode;
  readonly table: StyleTable;
  readonly labels: DocumentLabels;
  readonly ns: NamespaceWriter;
  readonly ctx: LensContext;
  readonly numbering: NumberingBuilder;
  private readonly warningCounts = new Map<string, number>();
  private readonly rels = new Map<string, Rel[]>();
  private readonly out = new Map<string, { data: Uint8Array; contentType: string | null }>();
  private readonly defaults = new Map<string, string>([
    ['rels', CT.rels],
    ['xml', CT.xml],
  ]);
  private readonly styles = new Map<string, JsonNode>();
  private readonly stories = new Map<string, JsonNode>();
  private readonly storyRel = new Map<string, string>();
  private readonly storyPart = new Map<string, string>();
  private readonly footnotes: string[] = [];
  private readonly media = new Map<string, string>();
  private readonly refBookmarks = new Map<string, string>();
  private readonly seqIndex = new Map<string, number>();
  private readonly fieldValues: Array<{ key: string; text: string }> = [];
  private readonly redacted: string[] = [];
  private readonly suggestionDates: ReadonlyMap<string, string>;
  private readonly watermarks = new Map<string, string>();
  /** Header and footer slots that the classification marking added to a page setup, by its id (EXP-089). */
  private readonly slotOverrides = new Map<string, Record<string, string>>();
  /** Identifiers of the source definitions, so a citation of an undefined source is reported (EXP-122). */
  private readonly sourceIds = new Set<string>();
  private nextId = 1;
  private nextFootnote = 1;
  private nextDocPr = 1;
  private nextStory = 1;
  private protection: 'readOnly' | 'forms' | null = null;
  private evenAndOdd = false;
  private storeItemId = '';
  private readonly comments: CommentPlan;
  /** Indexes of the planned threads that were anchored to a paragraph of the document. */
  private readonly commentUsed = new Set<number>();

  constructor(env: JsonEnvelope, assets: AssetSource, opts: WriteOptions) {
    this.env = env;
    this.assets = assets;
    this.opts = opts;
    this.doc = env.doc;
    this.table = styleTable(this.doc as unknown as ModelTreeNode);
    this.labels = computeLabels(this.doc as unknown as ModelTreeNode, {
      table: this.table,
      ...(opts.counterEffects ? { effects: opts.counterEffects } : {}),
    });
    this.ns = new NamespaceWriter(new Map(ROOT_NAMESPACES));
    this.comments = planComments(opts.comments ?? []);
    const dates = opts.suggestionDates;
    this.suggestionDates =
      dates instanceof Map
        ? dates
        : new Map(Object.entries((dates ?? {}) as Record<string, string>));
    const defs = this.doc.content?.find((n) => n.type === 'defs');
    for (const d of defs?.content ?? [])
      if (d.type === 'style_def' && typeof d.attrs?.['id'] === 'string')
        this.styles.set(d.attrs['id'], d);
    const numberingDefs = new Map<string, JsonNode>();
    for (const d of defs?.content ?? [])
      if (d.type === 'numbering_def' && typeof d.attrs?.['id'] === 'string')
        numberingDefs.set(d.attrs['id'], d);
    this.numbering = new NumberingBuilder(numberingDefs);
    for (const s of this.doc.content ?? [])
      if (s.type === 'story' && typeof s.attrs?.['id'] === 'string')
        this.stories.set(s.attrs['id'], s);
    this.ctx = {
      styleToCdm: () => null,
      styleToWord: (id) => (this.styles.has(id) ? id : null),
      storyForRel: () => null,
      relForStory: (id) => this.storyRel.get(id) ?? null,
    };
  }

  /** Whether the injected math gate refuses the equation; if so, the warning names the block (EXP-096). */
  refusedByGate(latex: string, block: string): boolean {
    const reason = this.opts.mathGate?.(latex) ?? null;
    if (reason === null) return false;
    this.warn(
      `an equation that fails the math gate is replaced by a placeholder (block ${block}: ${reason})`,
    );
    return true;
  }

  warn(message: string): void {
    this.warningCounts.set(message, (this.warningCounts.get(message) ?? 0) + 1);
  }

  get warnings(): string[] {
    return [...this.warningCounts].map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m));
  }

  id(): number {
    return this.nextId++;
  }

  rel(part: string, type: string, target: string, external = false): string {
    const list = this.rels.get(part) ?? [];
    const known = list.find(
      (r) => r.type === type && r.target === target && r.external === external,
    );
    if (known) return known.id;
    const id = `rId${list.length + 1}`;
    list.push({ id, type, target, external });
    this.rels.set(part, list);
    return id;
  }

  put(name: string, xml: string, contentType: string | null): void {
    this.out.set(name, { data: utf8(xml), contentType });
  }

  // -------------------------------------------------------------------------------------------

  async run(): Promise<WriteResult> {
    for (const f of this.env.requires ?? [])
      if (!KNOWN_FEATURES.has(f))
        throw new WriteError(
          `the document requires "${f}", which this writer cannot write (03 §2)`,
        );
    if ((this.env.requires ?? []).includes('preserve'))
      this.warn(
        'preserved content is written as its fallback: this file is written from the model, not patched from the original (owner decision 1)',
      );
    this.storeItemId = await guid(canonicalize(this.doc as unknown as JsonValue));
    const body = this.doc.content?.find((n) => n.type === 'body');
    if (!body) throw new WriteError('the document has no body');
    for (const s of this.doc.content?.find((n) => n.type === 'defs')?.content ?? [])
      if (s.type === 'source_def') this.sourceIds.add(String(s.attrs?.['id']));
    this.planProtection(body);
    this.planStories();
    this.planReferences(body);
    const main = 'word/document.xml';
    const bodyXml = await this.bodyXml(body, { name: main });
    for (const [id, story] of this.stories) {
      const part = this.storyPart.get(id)!;
      const root = story.attrs?.['kind'] === 'footer' ? 'w:ftr' : 'w:hdr';
      const watermark = this.watermarks.get(id);
      const inner = await this.blocksXml(story.content ?? [], { name: part }, emptyCtx());
      this.put(
        part,
        `${XML_DECLARATION}<${root}${ROOT_DECLARATIONS}>${watermark ? watermarkXml(watermark, this.id()) : ''}${ensureParagraph(inner)}</${root}>`,
        story.attrs?.['kind'] === 'footer' ? CT.footer : CT.header,
      );
    }
    this.put(
      main,
      `${XML_DECLARATION}<w:document${ROOT_DECLARATIONS}><w:body>${bodyXml}</w:body></w:document>`,
      CT.main,
    );
    if (this.footnotes.length) {
      const sep = (type: string, id: number, child: string): string =>
        el(
          'w:footnote',
          { 'w:type': type, 'w:id': id },
          el(
            'w:p',
            {},
            el('w:pPr', {}, el('w:spacing', { 'w:after': 0, 'w:line': 240, 'w:lineRule': 'auto' })),
            el('w:r', {}, el(child)),
          ),
        );
      this.put(
        'word/footnotes.xml',
        `${XML_DECLARATION}<w:footnotes${ROOT_DECLARATIONS}>${sep('separator', -1, 'w:separator')}${sep('continuationSeparator', 0, 'w:continuationSeparator')}${this.footnotes.join('')}</w:footnotes>`,
        CT.footnotes,
      );
      this.rel(main, REL.footnotes, 'footnotes.xml');
    }
    const defs = this.doc.content?.find((n) => n.type === 'defs');
    const settings = defs?.content?.find((n) => n.type === 'settings');
    const sa = settings ? withDefaults(settings) : withDefaults({ type: 'settings' });
    this.put(
      'word/styles.xml',
      stylesPart({
        styles: [...this.styles.values()],
        defaultParagraphStyle: this.table.defaultParagraphStyle,
        lang: typeof sa['lang'] === 'string' ? sa['lang'] : null,
        dir: sa['dir'] === 'rtl' ? 'rtl' : 'ltr',
        defaultFont: this.opts.defaultFont ?? null,
        ctx: this.ctx,
        ns: this.ns,
        styleNumPr: (s) => this.styleNumPr(s),
      }),
      CT.styles,
    );
    this.rel(main, REL.styles, 'styles.xml');
    // After the styles, whose numbering may add list instances.
    for (const id of this.numbering.sharedLists())
      this.warn(
        `list ${id} uses two numbering definitions; Word numbers each definition on its own`,
      );
    if (!this.numbering.empty) {
      this.put('word/numbering.xml', this.numbering.part(this.ctx, this.ns), CT.numbering);
      this.rel(main, REL.numbering, 'numbering.xml');
    }
    this.put('word/settings.xml', this.settingsXml(sa), CT.settings);
    this.rel(main, REL.settings, 'settings.xml');
    this.customXml(main);
    return this.pack();
  }

  /** `w:numPr` for a style's numbering (headings numbered through their style). */
  styleNumPr(style: JsonNode): string | null {
    const n = style.attrs?.['numbering'] as
      { numberingId?: string; level?: number; listId?: string } | null | undefined;
    if (!n || typeof n.numberingId !== 'string' || typeof n.listId !== 'string') return null;
    const numId = this.numbering.numFor(n.listId, n.numberingId);
    if (numId === null) return null;
    return el(
      'w:numPr',
      {},
      el('w:ilvl', { 'w:val': n.level ?? 0 }),
      el('w:numId', { 'w:val': numId }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Planning.

  /** Read-only protection with editable ranges, when a region is not editable by everyone (EXP-094). */
  planProtection(body: JsonNode): void {
    const regions = (body.content ?? []).filter((n) => n.type === 'region');
    const editable = this.opts.regionEditableByEveryone;
    if (editable && regions.some((r) => !editable(String(r.attrs?.['id'])))) {
      this.protection = 'readOnly';
      this.warn(
        "Word's document protection is advisory: the regions' permissions are enforced only inside the document service",
      );
    }
  }

  /** Header and footer parts, their relationships, and the reconciliation of odd and even pages (ADR 0032 §6). */
  planStories(): void {
    const defs = this.doc.content?.find((n) => n.type === 'defs');
    const setups = (defs?.content ?? []).filter((n) => n.type === 'page_setup');
    this.evenAndOdd = setups.some((s) => s.attrs?.['differentOddEven'] === true);
    for (const [id, story] of this.stories) {
      const kind = story.attrs?.['kind'] === 'footer' ? 'footer' : 'header';
      const part = `word/${kind}${this.nextStory++}.xml`;
      this.storyPart.set(id, part);
      this.storyRel.set(
        id,
        this.rel('word/document.xml', kind === 'footer' ? REL.footer : REL.header, part.slice(5)),
      );
    }
    for (const s of setups) {
      const text = s.attrs?.['watermark'];
      if (typeof text !== 'string' || !text) continue;
      const slots = ['headerDefault', 'headerFirst', 'headerEven']
        .map((k) => s.attrs?.[k])
        .filter((x): x is string => typeof x === 'string' && this.stories.has(x));
      if (!slots.length) {
        // A header of its own for the watermark.
        const id = `watermark${this.nextStory}`;
        const story: JsonNode = {
          type: 'story',
          attrs: { id, kind: 'header' },
          content: [{ type: 'paragraph', attrs: { id: `${id}p`.padEnd(16, '0').slice(0, 16) } }],
        };
        this.stories.set(id, story);
        const part = `word/header${this.nextStory++}.xml`;
        this.storyPart.set(id, part);
        this.storyRel.set(id, this.rel('word/document.xml', REL.header, part.slice(5)));
        s.attrs = { ...s.attrs, headerDefault: id };
        slots.push(id);
      }
      for (const id of slots) {
        const known = this.watermarks.get(id);
        if (known && known !== text)
          this.warn(
            `header ${id} is shared by sections with different watermarks; it shows "${known}"`,
          );
        else this.watermarks.set(id, text);
      }
    }
    const label = this.opts.classification?.trim();
    if (label) this.planClassification(setups, label);
  }

  /**
   * The classification marking (EXP-089; owner decision 51): one paragraph with the label at the end
   * of every header and footer story the page setups use, and a default header and footer where a
   * setup has none, so that every page of every section carries it. A story shared by several
   * setups is marked once. The caller's document is not changed: marked stories are copies.
   */
  planClassification(setups: readonly JsonNode[], label: string): void {
    if (setups.length === 0) {
      this.warn('the classification label is not written: the document has no page setup');
      return;
    }
    const marked = new Set<string>();
    for (const s of setups) {
      const extra: Record<string, string> = {};
      for (const kind of ['header', 'footer'] as const) {
        const needed = [
          'Default',
          ...(s.attrs?.['differentFirstPage'] === true ? ['First'] : []),
          ...(s.attrs?.['differentOddEven'] === true ? ['Even'] : []),
        ];
        for (const slot of ['Default', 'First', 'Even']) {
          const key = `${kind}${slot}`;
          let id = extra[key] ?? s.attrs?.[key];
          if (typeof id !== 'string' || !this.stories.has(id)) {
            if (!needed.includes(slot)) continue;
            id = `classification${kind}${this.nextStory}`;
            this.stories.set(id, { type: 'story', attrs: { id, kind }, content: [] });
            const part = `word/${kind}${this.nextStory++}.xml`;
            this.storyPart.set(id, part);
            this.storyRel.set(
              id,
              this.rel(
                'word/document.xml',
                kind === 'footer' ? REL.footer : REL.header,
                part.slice(5),
              ),
            );
            extra[key] = id;
          }
          if (marked.has(id)) continue;
          marked.add(id);
          const story = this.stories.get(id)!;
          this.stories.set(id, {
            ...story,
            content: [
              ...(story.content ?? []),
              {
                type: 'paragraph',
                attrs: { id: `${id}p`.padEnd(16, '0').slice(-16), align: 'center' },
                content: [{ type: 'text', text: label }],
              },
            ],
          });
        }
      }
      if (Object.keys(extra).length > 0) this.slotOverrides.set(String(s.attrs?.['id']), extra);
    }
  }

  /** Bookmarks for `ref` fields that point at a node or an equation, so Word's REF fields resolve. */
  planReferences(body: JsonNode): void {
    const walk = (n: JsonNode): void => {
      if (n.type === 'field' && n.attrs?.['kind'] === 'ref') {
        const t = n.attrs?.['target'];
        if (
          typeof t === 'string' &&
          (t.startsWith('node:') || t.startsWith('eq:')) &&
          !this.refBookmarks.has(t)
        )
          this.refBookmarks.set(t, `_Ref${String(100000000 + this.refBookmarks.size)}`);
      }
      for (const c of n.content ?? []) walk(c);
      for (const m of n.marks ?? []) {
        const href = m.type === 'link' ? m.attrs?.['href'] : undefined;
        if (
          typeof href === 'string' &&
          href.startsWith('#') &&
          !BOOKMARK_NAME.test(href.slice(1))
        ) {
          const t = `node:${href.slice(1)}`;
          if (!this.refBookmarks.has(t))
            this.refBookmarks.set(t, `_Ref${String(100000000 + this.refBookmarks.size)}`);
        }
      }
    };
    walk(body);
    for (const s of this.stories.values()) walk(s);
  }

  // -------------------------------------------------------------------------------------------
  // The body and its sections.

  async bodyXml(body: JsonNode, pc: PartCtx): Promise<string> {
    const children = body.content ?? [];
    const sections: Array<{ ps: string; start: string | null; items: JsonNode[] }> = [
      { ps: String(body.attrs?.['pageSetup']), start: null, items: [] },
    ];
    for (const c of children) {
      if (c.type === 'section_break')
        sections.push({
          ps: String(c.attrs?.['pageSetup']),
          start: String(c.attrs?.['start'] ?? 'nextPage'),
          items: [],
        });
      else sections[sections.length - 1]!.items.push(c);
    }
    const parts: string[] = [];
    for (const [k, s] of sections.entries()) {
      const sectPr = this.sectPrXml(s.ps, s.start, k);
      const last = k === sections.length - 1;
      const items = s.items;
      const tail = items[items.length - 1];
      const holds = !last && tail?.type === 'paragraph';
      parts.push(await this.blocksXml(holds ? items.slice(0, -1) : items, pc, emptyCtx(), true));
      if (holds)
        parts.push(
          await this.paragraphXml(tail, pc, emptyCtx(), [{ name: w('sectPr'), raw: sectPr }]),
        );
      else if (!last) parts.push(el('w:p', {}, el('w:pPr', {}, sectPr)));
      else {
        // The body ends with a paragraph before its final section properties.
        if (!items.length || !/<\/w:p>$|<w:p\/>$/.test(parts[parts.length - 1] ?? ''))
          parts.push('<w:p/>');
        parts.push(sectPr);
      }
    }
    return parts.join('');
  }

  sectPrXml(psId: string, start: string | null, index: number): string {
    const defs = this.doc.content?.find((n) => n.type === 'defs');
    const node = defs?.content?.find(
      (n) => n.type === 'page_setup' && n.attrs?.['id'] === psId,
    ) ?? { type: 'page_setup', attrs: { id: psId } };
    const v = { ...withDefaults(node), ...(this.slotOverrides.get(psId) ?? {}) };
    if (this.evenAndOdd && v['differentOddEven'] !== true) {
      // Word sets odd and even pages for the whole document (ADR 0032 §6): a section without them
      // shows its default header on even pages too.
      v['headerEven'] = v['headerDefault'] ?? null;
      v['footerEven'] = v['footerDefault'] ?? null;
    }
    const refs: string[] = [];
    for (const [kind, slots] of [
      [
        'w:headerReference',
        [
          ['headerDefault', 'default'],
          ['headerFirst', 'first'],
          ['headerEven', 'even'],
        ],
      ],
      [
        'w:footerReference',
        [
          ['footerDefault', 'default'],
          ['footerFirst', 'first'],
          ['footerEven', 'even'],
        ],
      ],
    ] as const)
      for (const [k, type] of slots) {
        const story = v[k];
        const rel = typeof story === 'string' ? this.storyRel.get(story) : undefined;
        if (rel) refs.push(el(kind, { 'w:type': type, 'r:id': rel }));
      }
    const landscape = v['orientation'] === 'landscape';
    const pgNum =
      typeof v['pageNumberStart'] === 'number' || v['pageNumberFormat'] !== 'decimal'
        ? el('w:pgNumType', {
            'w:fmt': v['pageNumberFormat'] !== 'decimal' ? String(v['pageNumberFormat']) : null,
            'w:start': typeof v['pageNumberStart'] === 'number' ? v['pageNumberStart'] : null,
          })
        : '';
    return el(
      'w:sectPr',
      {},
      ...refs,
      index > 0 && start && start !== 'nextPage' ? el('w:type', { 'w:val': start }) : '',
      el('w:pgSz', {
        'w:w': Number(v['width']),
        'w:h': Number(v['height']),
        'w:orient': landscape ? 'landscape' : null,
      }),
      el('w:pgMar', {
        'w:top': Number(v['marginTop']),
        'w:right': Number(v['marginRight']),
        'w:bottom': Number(v['marginBottom']),
        'w:left': Number(v['marginLeft']),
        'w:header': Number(v['headerDistance']),
        'w:footer': Number(v['footerDistance']),
        'w:gutter': Number(v['gutter']),
      }),
      pgNum,
      el('w:cols', {
        'w:space': Number(v['columnGap']),
        'w:num': Number(v['columns']) > 1 ? Number(v['columns']) : null,
      }),
      v['differentFirstPage'] === true ? el('w:titlePg') : '',
    );
  }

  // -------------------------------------------------------------------------------------------
  // Blocks.

  async blocksXml(
    nodes: readonly JsonNode[],
    pc: PartCtx,
    cx: BlockCtx,
    body = false,
  ): Promise<string> {
    const out: string[] = [];
    let outside: string[] = [];
    const flushOutside = (): void => {
      if (!outside.length) return;
      if (body && this.protection === 'readOnly' && this.opts.bodyEditableByEveryone) {
        const id = this.id();
        out.push(
          el('w:permStart', { 'w:id': id, 'w:edGrp': 'everyone' }),
          ...outside,
          el('w:permEnd', { 'w:id': id }),
        );
      } else out.push(...outside);
      outside = [];
    };
    for (const n of nodes) {
      if (body && n.type === 'region') {
        flushOutside();
        out.push(await this.regionXml(n, pc));
      } else outside.push(await this.blockXml(n, pc, cx));
    }
    flushOutside();
    return out.join('');
  }

  async blockXml(n: JsonNode, pc: PartCtx, cx: BlockCtx): Promise<string> {
    switch (n.type) {
      case 'paragraph':
        return this.paragraphXml(n, pc, cx);
      case 'table':
        return this.tableXml(n, pc, cx);
      case 'figure':
        return this.figureXml(n, pc, cx);
      case 'equation_block': {
        const id = String(n.attrs?.['id']);
        if (this.refusedByGate(String(n.attrs?.['latex'] ?? ''), id))
          return el(
            'w:p',
            {},
            el('w:pPr', {}, el('w:jc', { 'w:val': 'center' })),
            el('w:r', {}, textElement('w:t', MATH_PLACEHOLDER)),
          );
        this.warn(
          'an equation is written as its LaTeX source: Office math needs the converter of EXP-054',
        );
        const label = this.labels.equations.get(id);
        const bookmark =
          typeof n.attrs?.['label'] === 'string'
            ? this.refBookmarks.get(`eq:${n.attrs['label']}`)
            : undefined;
        const number = label ? `\t(${label})` : '';
        const text = xmlSafe(String(n.attrs?.['latex'] ?? '')).text;
        const numberXml = number
          ? this.bookmarked(bookmark, el('w:r', {}, el('w:tab'), textElement('w:t', `(${label})`)))
          : '';
        return el(
          'w:p',
          {},
          el('w:pPr', {}, el('w:jc', { 'w:val': 'center' })),
          el('w:r', {}, textElement('w:t', text)),
          numberXml,
        );
      }
      case 'toc':
        return this.tocXml(n);
      case 'bibliography':
        return this.bibliographyXml(n);
      case 'extension_block':
      case 'preserved_block':
        return this.fallbackBlock(n, pc);
      case 'hidden_region': {
        this.warn(
          'a hidden region is written as a placeholder: the requester may not read it (ADR 0019)',
        );
        const title = typeof n.attrs?.['title'] === 'string' ? n.attrs['title'] : null;
        return el(
          'w:p',
          {},
          el(
            'w:r',
            {},
            textElement('w:t', xmlSafe(title ? `Hidden: ${title}` : 'Hidden content').text),
          ),
        );
      }
      case 'region':
        // Regions are direct children of the body (I3); elsewhere their content is written as is.
        return this.blocksXml(n.content ?? [], pc, cx);
      default:
        this.warn(`a ${n.type} block is not written`);
        return '';
    }
  }

  bookmarked(name: string | undefined, inner: string): string {
    if (!name) return inner;
    const id = this.id();
    return `${el('w:bookmarkStart', { 'w:id': id, 'w:name': name })}${inner}${el('w:bookmarkEnd', { 'w:id': id })}`;
  }

  async regionXml(n: JsonNode, pc: PartCtx): Promise<string> {
    const id = String(n.attrs?.['id']);
    const inner = await this.blocksXml(n.content ?? [], pc, emptyCtx());
    const title = typeof n.attrs?.['title'] === 'string' ? n.attrs['title'] : null;
    const locked = this.opts.approvedRegions?.has(id) ?? false;
    const sdt = el(
      'w:sdt',
      {},
      el(
        'w:sdtPr',
        {},
        title ? el('w:alias', { 'w:val': xmlSafe(title).text }) : '',
        el('w:tag', { 'w:val': id }),
        el('w:id', { 'w:val': this.id() }),
        locked ? el('w:lock', { 'w:val': 'sdtContentLocked' }) : '',
      ),
      el('w:sdtContent', {}, ensureParagraph(inner)),
    );
    if (this.protection !== 'readOnly') return sdt;
    // Editable ranges: the everyone group, and each export identity the host names (07 §15).
    const ranges: Array<Record<string, string | number>> = [];
    if (this.opts.regionEditableByEveryone?.(id)) ranges.push({ 'w:edGrp': 'everyone' });
    for (const who of this.opts.regionEditors?.(id) ?? []) ranges.push({ 'w:ed': who });
    let xml = sdt;
    for (const r of ranges) {
      const rid = this.id();
      xml = `${el('w:permStart', { 'w:id': rid, ...r })}${xml}${el('w:permEnd', { 'w:id': rid })}`;
    }
    return xml;
  }

  private readonly shadowCache = new Map<string, readonly string[]>();

  /**
   * The properties that the table style gives a paragraph of this style (layer 2) while a style of
   * the paragraph's own chain also sets them. The model lets the table style win; Word lets the
   * paragraph style win, `Normal` included.
   */
  private tableShadowed(styleId: string, tableStyle: string): readonly string[] {
    const key = `${styleId}\u0000${tableStyle}`;
    let known = this.shadowCache.get(key);
    if (!known) {
      const attrs = { style: styleId };
      const plain = resolveParagraph(this.table, attrs, { trace: true });
      const inTable = resolveParagraph(this.table, attrs, { tableStyle, trace: true });
      known = [];
      if (plain.ok && inTable.ok) {
        const before = plain.value.trace ?? {};
        known = Object.entries(inTable.value.trace ?? {})
          .filter(
            ([k, layer]) =>
              layer === 'table style' &&
              (before[k] === 'default style' || before[k] === 'paragraph style'),
          )
          .map(([k]) => k);
      }
      this.shadowCache.set(key, known);
    }
    return known;
  }

  async paragraphXml(
    n: JsonNode,
    pc: PartCtx,
    cx: BlockCtx,
    extra: MergedItem[] = [],
    leading = '',
  ): Promise<string> {
    const id = String(n.attrs?.['id'] ?? '');
    const values = withDefaults(n);
    const resolved = resolveParagraph(this.table, n.attrs as Record<string, unknown> | undefined, {
      tableStyle: cx.tableStyle,
    });
    const rp = resolved.ok ? resolved.value : null;
    if (!resolved.ok)
      this.warn(
        `a style chain is broken (${resolved.error.code} at ${resolved.error.styleId}); its paragraphs keep their direct formatting`,
      );
    if (rp && cx.tableStyle !== null) {
      // 03 §6: a table style overrides the default paragraph style. Word lets the paragraph style
      // chain, `Normal` included, override the table style, so the resolved value is written as a
      // direct value where the two differ (CDM-041, owner decision 2026-11-15 about the order).
      const shadowed = this.tableShadowed(rp.styleId, cx.tableStyle);
      const direct = (k: string): void => {
        if (values[k] === null || values[k] === undefined)
          values[k] = (rp.properties as unknown as Values)[k] ?? null;
      };
      for (const k of SHADOWED_PARAGRAPH) if (shadowed.includes(k)) direct(k);
      if (shadowed.includes('lineSpacing') || shadowed.includes('lineRule')) {
        direct('lineSpacing');
        direct('lineRule');
      }
    }
    // Word adds the tab stops of a paragraph to those of its styles; the model replaces them
    // (03 §4.5), so the stops of the styles that the paragraph does not keep are cleared.
    if (rp && Array.isArray(n.attrs?.['tabs'])) {
      const inherited = resolveParagraph(
        this.table,
        { ...(n.attrs as Record<string, unknown>), tabs: null },
        { tableStyle: cx.tableStyle },
      );
      const kept = rp.properties.tabs;
      const cleared = inherited.ok
        ? inherited.value.properties.tabs
            .filter((t) => !kept.some((k) => k.position === t.position))
            .map((t) => ({ position: t.position, align: 'clear', leader: 'none' }))
        : [];
      values['tabs'] = [...kept, ...cleared].sort(
        (a, b) => a.position - b.position,
      ) as unknown as JsonValue;
    }
    const extras: MergedItem[] = [...paragraphExtras(values), ...extra];
    const numbering = rp?.numbering ?? null;
    if (numbering) {
      const restart = n.attrs?.['numberingRestart'];
      const numId =
        typeof restart === 'number'
          ? this.numbering.restart(
              numbering.listId,
              numbering.numberingId,
              numbering.level,
              restart,
            )
          : this.numbering.numFor(numbering.listId, numbering.numberingId);
      if (numId !== null) {
        extras.push({
          name: w('numPr'),
          raw: el(
            'w:numPr',
            {},
            el('w:ilvl', { 'w:val': numbering.level }),
            el('w:numId', { 'w:val': numId }),
          ),
        });
        // The level's indents come after the style's in 03 §6 and in Word (owner decision 9, 2026-11-15). They are written as direct values so that a numbering given through a style gives the same indents in Word.
        if (rp && values['indentLeft'] === null) values['indentLeft'] = rp.properties.indentLeft;
        if (rp && values['indentFirstLine'] === null)
          values['indentFirstLine'] = rp.properties.indentFirstLine;
        if (rp && values['indentRight'] === null && rp.properties.indentRight)
          values['indentRight'] = rp.properties.indentRight;
      }
    }
    // Block suggestions on the paragraph: its mark is inserted or deleted, its content too.
    const own = blockSuggest(n).filter((m) => m.type === 'ins' || m.type === 'del');
    const block = [
      ...cx.blockSuggestions.filter((m) => !own.some((o) => o.type === m.type)),
      ...own,
    ];
    const markRevision = block.map((m) => this.revisionElement(m, true)).join('');
    if (markRevision) extras.push({ name: w('rPr'), raw: el('w:rPr', {}, markRevision) });
    const fmt = blockSuggest(n).find((m) => m.type === 'fmt');
    if (fmt) {
      const before = (fmt.attrs?.['before'] ?? {}) as { attrs?: Values };
      const prev = { ...values, ...(before.attrs ?? {}) };
      const prevItems = itemsXml(
        mergeContainer(PPR, prev, [], this.ctx, paragraphExtras(prev)),
        this.ns,
      );
      extras.push({
        name: w('pPrChange'),
        raw: el('w:pPrChange', this.revisionAttrs(fmt), el('w:pPr', {}, prevItems)),
      });
    }
    const pPr = itemsXml(mergeContainer(PPR, values, [], this.ctx, extras), this.ns);
    const inner = await this.inlineXml(
      n.content ?? [],
      pc,
      { ...cx, blockSuggestions: block, seqBlock: id },
      rp,
    );
    const bookmark = this.refBookmarks.get(`node:${id}`);
    const content = this.bookmarked(bookmark, `${leading}${inner}`);
    // Comment threads anchored to this paragraph in the document body (EXP-093, criterion 4).
    const threads = pc.name === 'word/document.xml' ? (this.comments.byBlock.get(id) ?? []) : [];
    if (!threads.length) return el('w:p', {}, pPr ? el('w:pPr', {}, pPr) : '', content);
    for (const t of threads) this.commentUsed.add(t);
    const starts = threads.map((t) => anchorStarts(this.comments, t)).join('');
    const ends = threads.map((t) => anchorEnds(this.comments, t)).join('');
    return el('w:p', {}, pPr ? el('w:pPr', {}, pPr) : '', `${starts}${content}${ends}`);
  }

  async figureXml(n: JsonNode, pc: PartCtx, cx: BlockCtx): Promise<string> {
    const id = String(n.attrs?.['id']);
    if (n.attrs?.['placement'] === 'float') this.warn('a floating figure is written inline');
    const align = n.attrs?.['align'];
    const jc =
      align === 'center' ? 'center' : align === 'end' ? 'right' : align === 'start' ? 'left' : null;
    const caption = (n.content ?? []).find((c) => c.type === 'caption');
    const picture = this.pictureRun(
      String(n.attrs?.['asset']),
      Number(n.attrs?.['width']),
      Number(n.attrs?.['height']),
      typeof n.attrs?.['alt'] === 'string' ? n.attrs['alt'] : null,
      '',
      pc,
    );
    const pPr = el(
      'w:pPr',
      {},
      caption ? el('w:keepNext') : '',
      jc ? el('w:jc', { 'w:val': jc }) : '',
    );
    const figure = this.bookmarked(this.refBookmarks.get(`node:${id}`), picture);
    let out = el('w:p', {}, pPr, figure);
    if (caption) {
      const style = this.styles.has('Caption') ? el('w:pStyle', { 'w:val': 'Caption' }) : '';
      const inner = await this.inlineXml(caption.content ?? [], pc, { ...cx, seqBlock: id }, null);
      out += el('w:p', {}, style ? el('w:pPr', {}, style) : '', inner);
    }
    return out;
  }

  fallbackBlock(n: JsonNode, pc: PartCtx): string {
    const asset = n.attrs?.['fallbackAsset'];
    const text = n.attrs?.['fallbackText'];
    const label = String(n.attrs?.['label'] ?? n.attrs?.['extension'] ?? n.type);
    this.warn(
      `${n.type === 'preserved_block' ? 'preserved content' : 'extension content'} ("${label}") is written as its fallback`,
    );
    if (typeof asset === 'string' && this.assets.get(asset)) {
      const width =
        typeof n.attrs?.['width'] === 'number' && n.attrs['width'] > 0 ? n.attrs['width'] : null;
      const height =
        typeof n.attrs?.['height'] === 'number' && n.attrs['height'] > 0 ? n.attrs['height'] : null;
      return el(
        'w:p',
        {},
        this.pictureRun(asset, width, height, typeof text === 'string' ? text : label, '', pc),
      );
    }
    return el(
      'w:p',
      {},
      typeof text === 'string' && text ? el('w:r', {}, textElement('w:t', xmlSafe(text).text)) : '',
    );
  }

  /**
   * The text of a node as Word shows it before an update: each `seq` field shows the label the
   * shared algorithm gives it in `block` (the paragraph or figure that holds it), in the order the
   * writer meets the fields (EXP-092 criterion 3). A field without a label keeps its cached text.
   */
  shownText(n: JsonNode, block: string): string {
    let k = 0;
    const walk = (x: JsonNode): string => {
      if (x.type === 'text') return x.text ?? '';
      if (x.type === 'field' && x.attrs?.['kind'] === 'seq') {
        const label = this.labels.sequences.get(block)?.[k];
        k += 1;
        return label?.text ?? (typeof x.attrs['cached'] === 'string' ? x.attrs['cached'] : '');
      }
      return (x.content ?? []).map(walk).join('');
    };
    return walk(n);
  }

  async tocXml(n: JsonNode): Promise<string> {
    const min = Number(n.attrs?.['minLevel'] ?? 1);
    const max = Number(n.attrs?.['maxLevel'] ?? 3);
    const of = String(n.attrs?.['of'] ?? 'headings');
    const instr =
      of === 'headings' ? `TOC \\o "${min}-${max}" \\h \\z \\u` : `TOC \\h \\z \\c "${of}"`;
    // The entries as Word would show them before an update, without page numbers.
    const entries: Array<{ level: number; text: string }> = [];
    const body = this.doc.content?.find((c) => c.type === 'body');
    const walk = (x: JsonNode): void => {
      if (x.type === 'paragraph') {
        if (of === 'headings') {
          const r = resolveParagraph(this.table, x.attrs as Record<string, unknown> | undefined);
          const level = r.ok ? r.value.outlineLevel : null;
          if (level !== null && level >= min && level <= max)
            entries.push({ level, text: this.shownText(x, blockId(x)) });
        } else if (
          (x.content ?? []).some(
            (c) => c.type === 'field' && c.attrs?.['kind'] === 'seq' && c.attrs?.['name'] === of,
          )
        )
          entries.push({ level: 1, text: this.shownText(x, blockId(x)) });
        return;
      }
      if (x.type === 'figure') {
        const cap = (x.content ?? []).find((c) => c.type === 'caption');
        if (
          of !== 'headings' &&
          cap &&
          (cap.content ?? []).some((c) => c.type === 'field' && c.attrs?.['name'] === of)
        )
          entries.push({ level: 1, text: this.shownText(cap, blockId(x)) });
        return;
      }
      for (const c of x.content ?? []) walk(c);
    };
    if (body) walk(body);
    const begin = `${el('w:r', {}, el('w:fldChar', { 'w:fldCharType': 'begin' }))}${el('w:r', {}, textElement('w:instrText', ` ${instr} `))}${el('w:r', {}, el('w:fldChar', { 'w:fldCharType': 'separate' }))}`;
    const end = el('w:r', {}, el('w:fldChar', { 'w:fldCharType': 'end' }));
    const style = (level: number): string => {
      const id = `TOC${level}`;
      return this.styles.has(id) ? el('w:pPr', {}, el('w:pStyle', { 'w:val': id })) : '';
    };
    if (!entries.length) return el('w:p', {}, begin, end);
    return entries
      .map((e, i) =>
        el(
          'w:p',
          {},
          style(e.level),
          i === 0 ? begin : '',
          el('w:r', {}, textElement('w:t', xmlSafe(e.text).text)),
          i === entries.length - 1 ? end : '',
        ),
      )
      .join('');
  }

  bibliographyXml(n: JsonNode): string {
    this.warn(
      'a bibliography is written as plain entries, not as a Word bibliography field (EXP-122)',
    );
    const defs = this.doc.content?.find((c) => c.type === 'defs');
    const sources = (defs?.content ?? []).filter((c) => c.type === 'source_def');
    const cited = new Set<string>();
    const walk = (x: JsonNode): void => {
      if (x.type === 'citation')
        for (const item of (x.attrs?.['items'] ?? []) as Array<{ source?: string }>)
          if (item.source) cited.add(item.source);
      for (const c of x.content ?? []) walk(c);
    };
    walk(this.doc);
    const list =
      n.attrs?.['include'] === 'all'
        ? sources
        : sources.filter((s) => cited.has(String(s.attrs?.['id'])));
    if (!list.length) return '<w:p/>';
    return list
      .map((s) => {
        const a = s.attrs ?? {};
        const authors = ((a['authors'] ?? []) as Array<Record<string, string>>)
          .map((p) => p['literal'] ?? [p['family'], p['given']].filter(Boolean).join(', '))
          .join('; ');
        const text = [authors, a['title'], a['containerTitle'], a['publisher'], a['issued']]
          .filter((x) => typeof x === 'string' && x)
          .join('. ');
        return el(
          'w:p',
          {},
          el('w:r', {}, textElement('w:t', xmlSafe(text || String(a['id'])).text)),
        );
      })
      .join('');
  }

  // -------------------------------------------------------------------------------------------
  // Tables.

  async tableXml(n: JsonNode, pc: PartCtx, cx: BlockCtx): Promise<string> {
    const values = withDefaults(n);
    const style =
      typeof n.attrs?.['style'] === 'string' && this.styles.has(n.attrs['style'])
        ? n.attrs['style']
        : null;
    const grid = ((n.attrs?.['grid'] ?? []) as number[]).filter((g) => typeof g === 'number');
    const headerRows = Number(n.attrs?.['headerRows'] ?? 0);
    // Borders are written by the tblBorders lens of TBLPR (props.ts), the same as on export.
    const tblExtras: MergedItem[] = [];
    const m = marginsXml('w:tblCellMar', values['cellMargins']);
    if (m) tblExtras.push({ name: w('tblCellMar'), raw: m });
    const styleAttrs = style ? (this.styles.get(style)?.attrs ?? {}) : {};
    tblExtras.push({
      name: w('tblLook'),
      raw: el('w:tblLook', {
        'w:val': '04A0',
        'w:firstRow': styleAttrs['headerRowShading'] ? 1 : 0,
        'w:lastRow': 0,
        'w:firstColumn': 0,
        'w:lastColumn': 0,
        'w:noHBand': styleAttrs['bandedRows'] === true ? 0 : 1,
        'w:noVBand': 1,
      }),
    });
    const tblPr = itemsXml(mergeContainer(TBLPR, values, [], this.ctx, tblExtras), this.ns);
    const tableSug = blockSuggest(n).filter((x) => x.type === 'ins' || x.type === 'del');
    const rows = n.content ?? [];
    const cols = grid.length;
    const width = (col: number, span: number): number =>
      grid.slice(col, col + span).reduce((s, g) => s + g, 0);
    const pending: Array<{ remaining: number; colspan: number } | undefined> = [];
    const rowXml: string[] = [];
    for (const [r, row] of rows.entries()) {
      const rowSug = [
        ...tableSug,
        ...blockSuggest(row).filter((x) => x.type === 'ins' || x.type === 'del'),
      ];
      const trExtras: MergedItem[] = [];
      if (r < headerRows) trExtras.push({ name: w('tblHeader'), raw: el('w:tblHeader') });
      for (const s of rowSug)
        trExtras.push({ name: w(s.type), raw: this.revisionElement(s, true) });
      const trPr = itemsXml(
        mergeContainer(TRPR, withDefaults(row), [], this.ctx, trExtras),
        this.ns,
      );
      const cells: string[] = [];
      const cellCx: BlockCtx = {
        ...cx,
        tableStyle: style,
        blockSuggestions: [...cx.blockSuggestions, ...rowSug],
      };
      let col = 0;
      let k = 0;
      const content = row.content ?? [];
      while (col < cols || k < content.length) {
        const cont = pending[col];
        if (col < cols && cont && cont.remaining > 0) {
          cont.remaining--;
          cells.push(
            el(
              'w:tc',
              {},
              el(
                'w:tcPr',
                {},
                el('w:tcW', { 'w:w': width(col, cont.colspan), 'w:type': 'dxa' }),
                cont.colspan > 1 ? el('w:gridSpan', { 'w:val': cont.colspan }) : '',
                el('w:vMerge'),
              ),
              '<w:p/>',
            ),
          );
          col += cont.colspan;
          continue;
        }
        const cell = content[k++];
        if (!cell) break;
        const cs = Math.max(1, Number(cell.attrs?.['colspan'] ?? 1));
        const rs = Math.max(1, Number(cell.attrs?.['rowspan'] ?? 1));
        const cv = withDefaults(cell);
        const tcExtras: MergedItem[] = [
          { name: w('tcW'), raw: el('w:tcW', { 'w:w': width(col, cs), 'w:type': 'dxa' }) },
        ];
        if (rs > 1) {
          tcExtras.push({ name: w('vMerge'), raw: el('w:vMerge', { 'w:val': 'restart' }) });
          pending[col] = { remaining: rs - 1, colspan: cs };
        }
        // Cell borders are written by the tcBorders lens of TCPR (props.ts).
        const cm = marginsXml('w:tcMar', cv['margins']);
        if (cm) tcExtras.push({ name: w('tcMar'), raw: cm });
        const tcPr = itemsXml(mergeContainer(TCPR, cv, [], this.ctx, tcExtras), this.ns);
        const inner = await this.blocksXml(cell.content ?? [], pc, cellCx);
        cells.push(el('w:tc', {}, tcPr ? el('w:tcPr', {}, tcPr) : '', ensureParagraph(inner)));
        col += cs;
      }
      rowXml.push(el('w:tr', {}, trPr ? el('w:trPr', {}, trPr) : '', ...cells));
    }
    const gridXml = el('w:tblGrid', {}, ...grid.map((g) => el('w:gridCol', { 'w:w': g })));
    const table = el('w:tbl', {}, el('w:tblPr', {}, tblPr), gridXml, ...rowXml);
    return this.bookmarked(this.refBookmarks.get(`node:${String(n.attrs?.['id'])}`), table);
  }

  // -------------------------------------------------------------------------------------------
  // Inline content.

  /**
   * Inline content: links outermost (a `w:hyperlink` may hold revisions, a revision may not hold a
   * link), revisions inside, then runs of text with one formatting, and atoms.
   */
  async inlineXml(
    content: readonly JsonNode[],
    pc: PartCtx,
    cx: BlockCtx,
    rp: ResolvedParagraph | null,
  ): Promise<string> {
    const out: string[] = [];
    let i = 0;
    while (i < content.length) {
      const href = linkOf(content[i]!);
      let j = i + 1;
      while (j < content.length && linkOf(content[j]!) === href) j++;
      const inner = await this.revisionsXml(content.slice(i, j), pc, cx, rp);
      out.push(href === null ? inner : this.hyperlink(href, inner, pc));
      i = j;
    }
    return out.join('');
  }

  hyperlink(href: string, inner: string, pc: PartCtx): string {
    if (href.startsWith('#')) {
      const name = href.slice(1);
      const anchor = BOOKMARK_NAME.test(name) ? name : this.refBookmarks.get(`node:${name}`);
      if (!anchor) {
        this.warn('a link to a place in the document that holds no bookmark is written as text');
        return inner;
      }
      return el('w:hyperlink', { 'w:anchor': anchor, 'w:history': 1 }, inner);
    }
    // SEC-006 criterion 5: an external target is written only when the CDM allow-list (I9) accepts
    // it, the same check `link.href` passes at commit. A refused target is written as plain text.
    if (!new RegExp(LINK_HREF_PATTERN).test(href)) {
      this.warn('a link whose address is not an allowed scheme is written as text (I9)');
      return inner;
    }
    const rel = this.rel(pc.name, REL.hyperlink, href, true);
    return el('w:hyperlink', { 'r:id': rel, 'w:history': 1 }, inner);
  }

  async revisionsXml(
    content: readonly JsonNode[],
    pc: PartCtx,
    cx: BlockCtx,
    rp: ResolvedParagraph | null,
  ): Promise<string> {
    const out: string[] = [];
    let ins: JsonMark | null = null;
    let del: JsonMark | null = null;
    const close = (): void => {
      if (del) out.push('</w:del>');
      if (ins) out.push('</w:ins>');
      ins = del = null;
    };
    const effective = (n: JsonNode): JsonMark[] => {
      const own = n.marks ?? [];
      return [...own, ...cx.blockSuggestions.filter((b) => !own.some((m) => m.type === b.type))];
    };
    let i = 0;
    while (i < content.length) {
      const node = content[i]!;
      const marks = effective(node);
      const rm = marksToValues(marks);
      if (
        rm.ins?.attrs?.['id'] !== (ins as JsonMark | null)?.attrs?.['id'] ||
        rm.del?.attrs?.['id'] !== (del as JsonMark | null)?.attrs?.['id']
      ) {
        close();
        if (rm.ins) out.push(this.revisionElement(rm.ins, false));
        if (rm.del) out.push(this.revisionElement(rm.del, false));
        ins = rm.ins;
        del = rm.del;
      }
      const inDel = !!rm.del;
      if (node.type === 'text' || node.type === 'tab' || node.type === 'break') {
        const key = formattingKey(marks);
        const parts: string[] = [];
        let j = i;
        while (j < content.length) {
          const x = content[j]!;
          if (x.type !== 'text' && x.type !== 'tab' && x.type !== 'break') break;
          const xm = effective(x);
          if (formattingKey(xm) !== key || !sameSuggestions(xm, marks)) break;
          parts.push(this.runContent(x, inDel, cx));
          j++;
        }
        out.push(el('w:r', {}, this.rPrXml(marks, cx, rp), ...parts));
        i = j;
        continue;
      }
      out.push(await this.atomXml(node, marks, inDel, pc, cx, rp));
      i++;
    }
    close();
    return out.join('');
  }

  runContent(n: JsonNode, inDel: boolean, cx: BlockCtx): string {
    if (n.type === 'tab') return el('w:tab');
    if (n.type === 'break') {
      const kind = n.attrs?.['kind'];
      if ((kind === 'page' || kind === 'column') && cx.tableStyle !== null) return el('w:br');
      return kind === 'page' || kind === 'column' ? el('w:br', { 'w:type': kind }) : el('w:br');
    }
    const safe = xmlSafe(n.text ?? '');
    if (safe.replaced) this.warn('characters XML cannot carry were replaced by U+FFFD');
    // A tab or line feed inside text is written as Word's own tab or break.
    const tag = inDel ? 'w:delText' : 'w:t';
    return safe.text
      .split(/(\t|\n)/)
      .map((s) =>
        s === '\t' ? el('w:tab') : s === '\n' ? el('w:br') : s ? textElement(tag, s) : '',
      )
      .join('');
  }

  /** Run properties from marks, with explicit toggles where Word would combine styles' toggles by exclusive or. */
  rPrXml(
    marks: readonly JsonMark[],
    cx: BlockCtx,
    rp: ResolvedParagraph | null,
    extras: MergedItem[] = [],
  ): string {
    const rm = marksToValues(marks);
    const values: Values = { ...rm.values };
    if (rp && (typeof values['charStyle'] === 'string' || cx.tableStyle !== null)) {
      const r = resolveRun(this.table, rp, marks);
      if (r.ok) for (const t of TOGGLES) values[t] = r.value[t];
      if (r.ok && cx.tableStyle !== null) {
        // As for paragraphs: the table style wins in the model, the paragraph style in Word.
        const shadowed = this.tableShadowed(rp.styleId, cx.tableStyle);
        for (const k of SHADOWED_RUN) {
          const v = (r.value as unknown as Values)[k] ?? null;
          if (shadowed.includes(k) && values[k] === null && v !== null) values[k] = v;
        }
      }
    }
    const fmt = marks.find((m) => m.type === 'fmt');
    const items = [...extras];
    if (fmt) {
      const before = (fmt.attrs?.['before'] ?? {}) as { marks?: JsonMark[] };
      const was = marksToValues(before.marks ?? []).values;
      const prev = itemsXml(mergeContainer(RPR, was, fontSlots(was), this.ctx, []), this.ns);
      items.push({
        name: w('rPrChange'),
        raw: el('w:rPrChange', this.revisionAttrs(fmt), el('w:rPr', {}, prev)),
      });
    }
    const xml = itemsXml(mergeContainer(RPR, values, fontSlots(values), this.ctx, items), this.ns);
    return xml ? el('w:rPr', {}, xml) : '';
  }

  revisionAttrs(m: JsonMark): Record<string, string | number | null> {
    const user = String(m.attrs?.['user'] ?? '');
    const author = this.opts.authorName ? this.opts.authorName(user) : user.replace(/^word:/, '');
    return {
      'w:id': this.id(),
      'w:author': xmlSafe(author || 'Unknown').text,
      'w:date': this.suggestionDates.get(String(m.attrs?.['id'])) ?? null,
    };
  }

  /** `<w:ins ...>` to open a run revision, or `<w:ins .../>` for a paragraph mark or a row. */
  revisionElement(m: JsonMark, empty: boolean): string {
    const name = m.type === 'del' ? 'w:del' : 'w:ins';
    const attrs = this.revisionAttrs(m);
    const a = Object.entries(attrs)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
      .join('');
    return empty ? `<${name}${a}/>` : `<${name}${a}>`;
  }

  async atomXml(
    node: JsonNode,
    marks: JsonMark[],
    inDel: boolean,
    pc: PartCtx,
    cx: BlockCtx,
    rp: ResolvedParagraph | null,
  ): Promise<string> {
    const rPr = (extras: MergedItem[] = []): string => this.rPrXml(marks, cx, rp, extras);
    const a = node.attrs ?? {};
    switch (node.type) {
      case 'image':
        return this.pictureRun(
          String(a['asset']),
          Number(a['width']),
          Number(a['height']),
          typeof a['alt'] === 'string' ? a['alt'] : null,
          rPr(),
          pc,
        );
      case 'footnote':
        return this.footnoteXml(node, rPr);
      case 'field':
        return this.fieldXml(node, rPr(), inDel, cx);
      case 'anchor': {
        const name = String(a['name'] ?? '');
        if (!BOOKMARK_NAME.test(name)) return '';
        const id = this.id();
        return `${el('w:bookmarkStart', { 'w:id': id, 'w:name': name })}${el('w:bookmarkEnd', { 'w:id': id })}`;
      }
      case 'citation': {
        const items = (a['items'] ?? []) as Array<{ source?: string }>;
        const text =
          typeof a['cached'] === 'string'
            ? a['cached']
            : `[${items.map((x) => x.source).join('; ')}]`;
        const instr = inDel
          ? null
          : citationInstruction(items, typeof a['mode'] === 'string' ? a['mode'] : 'normal');
        if (!instr) {
          if (!inDel)
            this.warn('a citation with no source Word can cite is written as its text (EXP-122)');
          return el('w:r', {}, rPr(), textElement(inDel ? 'w:delText' : 'w:t', xmlSafe(text).text));
        }
        for (const x of items)
          if (typeof x.source === 'string' && !this.sourceIds.has(x.source))
            this.warn('a citation names a source the document does not define (EXP-122)');
        return fieldRuns(instr, xmlSafe(text).text, rPr());
      }
      case 'form_field':
        return this.formFieldXml(node, rPr());
      case 'equation':
        if (this.refusedByGate(String(a['latex'] ?? ''), cx.seqBlock ?? 'unknown'))
          return el('w:r', {}, rPr(), textElement(inDel ? 'w:delText' : 'w:t', MATH_PLACEHOLDER));
        this.warn(
          'an equation is written as its LaTeX source: Office math needs the converter of EXP-054',
        );
        return el(
          'w:r',
          {},
          rPr(),
          textElement(inDel ? 'w:delText' : 'w:t', xmlSafe(String(a['latex'] ?? '')).text),
        );
      case 'extension_inline':
      case 'preserved_inline': {
        const label = String(a['label'] ?? a['extension'] ?? node.type);
        this.warn(
          `${node.type === 'preserved_inline' ? 'preserved content' : 'extension content'} ("${label}") is written as its fallback`,
        );
        const asset = a['fallbackAsset'];
        if (typeof asset === 'string' && this.assets.get(asset)) {
          const wd = typeof a['width'] === 'number' && a['width'] > 0 ? a['width'] : null;
          const ht = typeof a['height'] === 'number' && a['height'] > 0 ? a['height'] : null;
          return this.pictureRun(
            asset,
            wd,
            ht,
            typeof a['fallbackText'] === 'string' ? a['fallbackText'] : label,
            rPr(),
            pc,
          );
        }
        const text = typeof a['fallbackText'] === 'string' ? a['fallbackText'] : '';
        return text
          ? el('w:r', {}, rPr(), textElement(inDel ? 'w:delText' : 'w:t', xmlSafe(text).text))
          : '';
      }
      default:
        this.warn(`a ${node.type} inline node is not written`);
        return '';
    }
  }

  /** A picture run; without a size, the picture's own at 96 dots per inch. */
  pictureRun(
    assetId: string,
    width: number | null,
    height: number | null,
    alt: string | null,
    rPr: string,
    pc: PartCtx,
  ): string {
    const asset = this.assets.get(assetId);
    const ext = asset ? IMAGE_EXTENSIONS[asset.contentType] : undefined;
    if (!asset || !ext) {
      this.warn(
        'a picture whose asset is missing or of an unknown type is written as its alternative text',
      );
      return alt ? el('w:r', {}, rPr, textElement('w:t', xmlSafe(alt).text)) : '';
    }
    let name = this.media.get(assetId);
    if (!name) {
      name = `word/media/image${this.media.size + 1}.${ext}`;
      this.media.set(assetId, name);
      this.out.set(name, { data: asset.bytes, contentType: asset.contentType });
      this.defaults.set(ext, asset.contentType);
    }
    const relTarget = pc.name.startsWith('word/') ? name.slice(5) : name;
    const relId = this.rel(pc.name, REL.image, relTarget);
    let wd = width && Number.isFinite(width) && width > 0 ? width : null;
    let ht = height && Number.isFinite(height) && height > 0 ? height : null;
    if (wd === null || ht === null) {
      const px = pixelSize(asset.bytes);
      wd ??= px ? pxToTwips(px.width) : 1440;
      ht ??= px ? pxToTwips(px.height) : 1440;
    }
    const attrs: Record<string, JsonValue> = { width: wd, height: ht };
    if (alt) attrs['alt'] = xmlSafe(alt).text;
    const tree = newDrawing({ type: 'image', attrs }, relId, this.nextDocPr++);
    return el('w:r', {}, rPr, this.ns.element(tree, new Map()));
  }

  /** A footnote: its reference here, its paragraph in the footnotes part (EXP-092). */
  async footnoteXml(node: JsonNode, rPr: (extras?: MergedItem[]) => string): Promise<string> {
    const id = this.nextFootnote++;
    const styled = this.styles.has('FootnoteReference');
    const superscript: MergedItem = {
      name: w('vertAlign'),
      raw: el('w:vertAlign', { 'w:val': 'superscript' }),
    };
    const markProps = el(
      'w:rPr',
      {},
      styled ? el('w:rStyle', { 'w:val': 'FootnoteReference' }) : '',
      el('w:vertAlign', { 'w:val': 'superscript' }),
    );
    const xml: string[] = [];
    for (const [k, p] of (node.content ?? []).entries()) {
      const leading =
        k === 0
          ? `${el('w:r', {}, markProps, el('w:footnoteRef'))}${el('w:r', {}, textElement('w:t', ' '))}`
          : '';
      if (p.type === 'paragraph')
        xml.push(
          await this.paragraphXml(p, { name: 'word/footnotes.xml' }, emptyCtx(), [], leading),
        );
    }
    if (!xml.length) xml.push(el('w:p', {}, el('w:r', {}, markProps, el('w:footnoteRef'))));
    this.footnotes.push(el('w:footnote', { 'w:id': id }, ...xml));
    const props = rPr(
      styled
        ? [
            superscript,
            { name: w('rStyle'), raw: el('w:rStyle', { 'w:val': 'FootnoteReference' }) },
          ]
        : [superscript],
    );
    return el('w:r', {}, props, el('w:footnoteReference', { 'w:id': id }));
  }

  /** A field as Word's complex field, its result the text the model computes (03 §7; EXP-092). */
  fieldXml(node: JsonNode, rPr: string, inDel: boolean, cx: BlockCtx): string {
    const a = node.attrs ?? {};
    const kind = String(a['kind'] ?? 'page');
    const cached = typeof a['cached'] === 'string' ? a['cached'] : '';
    let instr: string | null;
    let result = cached;
    let lock = false;
    switch (kind) {
      case 'page':
        instr = `PAGE${numberSwitch(typeof a['format'] === 'string' ? a['format'] : null)}`;
        break;
      case 'pageCount':
        instr = `NUMPAGES${numberSwitch(typeof a['format'] === 'string' ? a['format'] : null)}`;
        break;
      case 'date': {
        const picture = typeof a['format'] === 'string' ? a['format'] : 'yyyy-MM-dd';
        instr = `DATE \\@ "${picture.replace(/"/g, '')}"`;
        // The server's date at job creation, locked so Word does not replace it with the reader's.
        lock = true;
        if (this.opts.instant && this.opts.timeZone) {
          try {
            result = dateFieldText({
              instant: this.opts.instant,
              timeZone: this.opts.timeZone,
              format: typeof a['format'] === 'string' ? a['format'] : null,
            });
          } catch (e) {
            result = '';
            this.warn(`a date field could not be computed: ${(e as Error).message}`);
          }
        } else {
          result = '';
          this.warn(
            'a date field has no server date: the export job gave no instant and time zone',
          );
        }
        break;
      }
      case 'title':
        instr = 'TITLE';
        result = this.opts.title ?? cached;
        break;
      case 'ref': {
        const target = typeof a['target'] === 'string' ? a['target'] : '';
        const label = referenceText(this.labels, target);
        result = label ?? cached;
        if (target.startsWith('bookmark:')) instr = `REF ${target.slice('bookmark:'.length)} \\h`;
        else {
          const bm = this.refBookmarks.get(target);
          instr = bm ? `REF ${bm} \\w \\h` : null;
        }
        break;
      }
      case 'styleRef': {
        const target =
          typeof a['target'] === 'string' && a['target'].startsWith('style:')
            ? a['target'].slice(6)
            : '';
        const s = this.styles.get(target);
        const name = s
          ? ((s.attrs?.['builtIn'] === true ? WORD_BUILT_IN_NAMES[target] : undefined) ??
            String(s.attrs?.['name'] ?? target))
          : target;
        instr = `STYLEREF "${name.replace(/"/g, '')}"`;
        break;
      }
      case 'seq': {
        const name = typeof a['name'] === 'string' ? a['name'] : null;
        const block = cx.seqBlock ?? '';
        const k = this.seqIndex.get(block) ?? 0;
        this.seqIndex.set(block, k + 1);
        const label = this.labels.sequences.get(block)?.[k];
        result = label?.text ?? cached;
        instr = name
          ? `SEQ ${name}${numberSwitch(typeof a['format'] === 'string' ? a['format'] : null)}`
          : null;
        break;
      }
      case 'formValue': {
        this.warn('a form value field is written as its text');
        instr = null;
        break;
      }
      default:
        instr = null;
    }
    const t = inDel ? 'w:delText' : 'w:t';
    const safe = xmlSafe(result).text;
    if (instr === null) return safe ? el('w:r', {}, rPr, textElement(t, safe)) : '';
    const it = inDel ? 'w:delInstrText' : 'w:instrText';
    return [
      el(
        'w:r',
        {},
        rPr,
        el('w:fldChar', { 'w:fldCharType': 'begin', 'w:fldLock': lock ? '1' : null }),
      ),
      el('w:r', {}, rPr, textElement(it, ` ${instr} `)),
      el('w:r', {}, rPr, el('w:fldChar', { 'w:fldCharType': 'separate' })),
      safe ? el('w:r', {}, rPr, textElement(t, safe)) : '',
      el('w:r', {}, rPr, el('w:fldChar', { 'w:fldCharType': 'end' })),
    ].join('');
  }

  /** A form field as an inline content control bound to the values part (12 §12; EXP-095). */
  formFieldXml(node: JsonNode, rPr: string): string {
    const a = node.attrs ?? {};
    const key = String(a['key'] ?? '');
    const kind = String(a['kind'] ?? 'text');
    const value = a['value'] as JsonValue;
    const redacted =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      value['redacted'] === true;
    if (redacted) this.redacted.push(key);
    const options = Array.isArray(a['options'])
      ? (a['options'] as Array<{ id: string; label: string }>)
      : [];
    const shown = redacted
      ? ''
      : (() => {
          const t = valueText({ kind, value: value ?? null, options });
          return t.computed ? t.text : '';
        })();
    // A choice is bound by its option identifier, the value of its list item.
    // EXP-095: a checkbox is bound as true or false, and a date as a dateTime, so that Word reads them back.
    const bound =
      redacted || value === null || value === undefined
        ? ''
        : kind === 'choice'
          ? String(value)
          : kind === 'checkbox'
            ? String(value === true)
            : kind === 'date' && typeof value === 'string'
              ? `${value}T00:00:00`
              : shown;
    this.fieldValues.push({ key, text: bound });
    if (!this.protection) this.protection = 'forms';
    this.warn(
      "Word's form protection is advisory: who may fill a field is enforced only inside the document service",
    );
    if (kind === 'signature' || kind === 'initials')
      this.warn('a signature or initials field is written as a text control');
    let type = el('w:text');
    if (kind === 'date')
      type = el(
        'w:date',
        typeof value === 'string' && !redacted ? { 'w:fullDate': `${value}T00:00:00Z` } : {},
        el('w:dateFormat', { 'w:val': 'yyyy-MM-dd' }),
        el('w:storeMappedDataAs', { 'w:val': 'dateTime' }),
        el('w:calendar', { 'w:val': 'gregorian' }),
      );
    else if (kind === 'choice')
      type = el(
        'w:dropDownList',
        {},
        ...options.map((o) =>
          el('w:listItem', {
            'w:displayText': xmlSafe(String(o.label)).text,
            'w:value': String(o.id),
          }),
        ),
      );
    else if (kind === 'checkbox')
      type = el(
        'w14:checkbox',
        {},
        el('w14:checked', { 'w14:val': value === true ? '1' : '0' }),
        el('w14:checkedState', { 'w14:val': '2612', 'w14:font': 'MS Gothic' }),
        el('w14:uncheckedState', { 'w14:val': '2610', 'w14:font': 'MS Gothic' }),
      );
    const index = this.fieldValues.length;
    const sdtPr = el(
      'w:sdtPr',
      {},
      rPr,
      el('w:alias', { 'w:val': xmlSafe(String(a['label'] ?? key)).text }),
      el('w:tag', { 'w:val': key }),
      el('w:id', { 'w:val': this.id() }),
      el('w:lock', { 'w:val': a['readOnly'] === true ? 'sdtContentLocked' : 'sdtLocked' }),
      shown ? '' : el('w:showingPlcHdr'),
      el('w:dataBinding', {
        'w:prefixMappings': `xmlns:f='${FIELDS_NS}'`,
        'w:xpath': `/f:fields[1]/f:field[${index}]`,
        'w:storeItemID': this.storeItemId,
      }),
      type,
    );
    const placeholder =
      typeof a['placeholder'] === 'string' && a['placeholder']
        ? a['placeholder']
        : String(a['label'] ?? key);
    const text = kind === 'checkbox' ? (value === true ? '☒' : '☐') : shown || placeholder;
    return el(
      'w:sdt',
      {},
      sdtPr,
      el('w:sdtContent', {}, el('w:r', {}, rPr, textElement('w:t', xmlSafe(text).text))),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Settings, custom XML and the package.

  settingsXml(sa: Values): string {
    const footnotePr = this.footnotes.length
      ? el(
          'w:footnotePr',
          {},
          el('w:numFmt', { 'w:val': FOOTNOTE_FORMATS[String(sa['footnoteFormat'])] ?? 'decimal' }),
          sa['footnoteRestart'] === 'perPageSection'
            ? el('w:numRestart', { 'w:val': 'eachSect' })
            : '',
          el('w:footnote', { 'w:id': -1 }),
          el('w:footnote', { 'w:id': 0 }),
        )
      : '';
    const lang = typeof sa['lang'] === 'string' ? sa['lang'] : null;
    return `${XML_DECLARATION}<w:settings${ROOT_DECLARATIONS}>${[
      sa['trackChanges'] === 'everyone' ? el('w:trackRevisions') : '',
      this.protection
        ? el('w:documentProtection', { 'w:edit': this.protection, 'w:enforcement': '1' })
        : '',
      el('w:defaultTabStop', { 'w:val': Number(sa['defaultTabStop'] ?? 720) }),
      sa['hyphenation'] === true ? el('w:autoHyphenation') : '',
      this.evenAndOdd ? el('w:evenAndOddHeaders') : '',
      el('w:characterSpacingControl', { 'w:val': 'doNotCompress' }),
      footnotePr,
      el(
        'w:compat',
        {},
        el('w:compatSetting', {
          'w:name': 'compatibilityMode',
          'w:uri': 'http://schemas.microsoft.com/office/word',
          'w:val': 15,
        }),
      ),
      lang ? el('w:themeFontLang', { 'w:val': lang }) : '',
      el('w:decimalSymbol', { 'w:val': '.' }),
      el('w:listSeparator', { 'w:val': ',' }),
    ].join('')}</w:settings>`;
  }

  /** The values of form fields (bound by the controls), and the definitions and grants, each a custom XML part. */
  customXml(main: string): void {
    const defs = this.doc.content?.find((n) => n.type === 'defs');
    const roles = (defs?.content ?? []).filter(
      (n) => n.type === 'role_def' || n.type === 'rule_def',
    );
    const items: Array<{ xml: string; id: string; schema?: string }> = [];
    if (this.fieldValues.length)
      items.push({
        id: this.storeItemId,
        xml: `${XML_DECLARATION}<f:fields xmlns:f="${FIELDS_NS}">${this.fieldValues.map((v) => `<f:field key="${escapeAttr(v.key)}">${escapeText(xmlSafe(v.text).text)}</f:field>`).join('')}</f:fields>`,
      });
    if (roles.length)
      items.push({
        id: `{${this.storeItemId.slice(1, 9)}-0000-4000-8000-000000000002}`,
        xml: `${XML_DECLARATION}<f:definitions xmlns:f="${FIELDS_NS}">${roles.map((r) => `<f:${r.type === 'role_def' ? 'role' : 'rule'} id="${escapeAttr(String(r.attrs?.['id']))}">${escapeText(xmlSafe(JSON.stringify(r.attrs ?? {})).text)}</f:${r.type === 'role_def' ? 'role' : 'rule'}>`).join('')}</f:definitions>`,
      });
    if (this.opts.grants !== undefined)
      items.push({
        id: `{${this.storeItemId.slice(1, 9)}-0000-4000-8000-000000000003}`,
        xml: `${XML_DECLARATION}<g:grants xmlns:g="${GRANTS_NS}">${escapeText(xmlSafe(JSON.stringify(this.opts.grants)).text)}</g:grants>`,
      });
    const sources = (defs?.content ?? []).filter((n) => n.type === 'source_def');
    if (sources.length)
      items.push({
        id: sourcesItemId(this.storeItemId),
        xml: sourcesPart(sources),
        schema: BIBLIOGRAPHY_NS,
      });
    items.forEach((it, i) => {
      const n = i + 1;
      this.put(`customXml/item${n}.xml`, it.xml, null);
      this.put(
        `customXml/itemProps${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\r\n<ds:datastoreItem ds:itemID="${it.id}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs>${it.schema ? `<ds:schemaRef ds:uri="${it.schema}"/>` : ''}</ds:schemaRefs></ds:datastoreItem>`,
        CT.itemProps,
      );
      this.rel(`customXml/item${n}.xml`, REL.customXmlProps, `itemProps${n}.xml`);
      this.rel(main, REL.customXml, `../customXml/item${n}.xml`);
    });
  }

  pack(): WriteResult {
    this.rel('', REL.officeDocument, 'word/document.xml');
    if (this.commentUsed.size) {
      const used = this.commentUsed;
      const { comments: c, extended: x } = COMMENT_PARTS;
      this.rel('word/document.xml', c.rel, c.target);
      this.rel('word/document.xml', x.rel, x.target);
      this.put(c.name, commentsXml(this.comments, used), c.contentType);
      this.put(x.name, commentsExtendedXml(this.comments, used), x.contentType);
    }
    if (this.comments.empty.length) this.warn('a comment thread with no message is not written');
    if (this.comments.threads.length > this.commentUsed.size)
      this.warn('a comment thread names no paragraph of the document, so it is not written');
    for (const [part, list] of this.rels) {
      const slash = part.lastIndexOf('/');
      const name = part
        ? `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
        : '_rels/.rels';
      this.put(
        name,
        `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
          .map((r) =>
            el('Relationship', {
              Id: r.id,
              Type: r.type,
              Target: r.target,
              TargetMode: r.external ? 'External' : null,
            }),
          )
          .join('')}</Relationships>`,
        CT.rels,
      );
    }
    const overrides: string[] = [];
    for (const [name, p] of this.out) {
      const dot = name.lastIndexOf('.');
      const ext = name.slice(dot + 1).toLowerCase();
      if (!p.contentType || ext === 'rels' || this.defaults.get(ext) === p.contentType) continue;
      overrides.push(el('Override', { PartName: `/${name}`, ContentType: p.contentType }));
    }
    const types = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[
      ...this.defaults,
    ]
      .map(([e, t]) => el('Default', { Extension: e, ContentType: t }))
      .join('')}${overrides.join('')}</Types>`;
    const order = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
    const names = [...this.out.keys()].sort((x, y) => {
      const ix1 = order.indexOf(x);
      const ix2 = order.indexOf(y);
      if (ix1 >= 0 || ix2 >= 0) return (ix1 < 0 ? 99 : ix1) - (ix2 < 0 ? 99 : ix2);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const entries: ZipWriteEntry[] = [
      { name: '[Content_Types].xml', data: utf8(types) },
      ...names.map((n) => ({ name: n, data: this.out.get(n)!.data })),
    ];
    return {
      bytes: writeZip(entries),
      warnings: this.warnings,
      parts: entries.map((e) => e.name),
      redacted: this.redacted,
    };
  }
}

function emptyCtx(): BlockCtx {
  return { tableStyle: null, blockSuggestions: [], seqBlock: null };
}

/** Content that must end with a paragraph (a cell, a content control, a story) gets an empty one. */
function ensureParagraph(xml: string): string {
  return /<\/w:p>$|<w:p\/>$/.test(xml) ? xml : `${xml}<w:p/>`;
}

function linkOf(n: JsonNode): string | null {
  const m = (n.marks ?? []).find((x) => x.type === 'link');
  const href = m?.attrs?.['href'];
  return typeof href === 'string' ? href : null;
}

function sameSuggestions(a: readonly JsonMark[], b: readonly JsonMark[]): boolean {
  const key = (m: readonly JsonMark[]): string =>
    m
      .filter((x) => SUGGESTION_MARKS.has(x.type))
      .map((x) => `${x.type}:${String(x.attrs?.['id'])}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

/** A stable GUID for the values part, from the document's canonical text. */
async function guid(text: string): Promise<string> {
  const h = await sha256Hex(text);
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}}`.toUpperCase();
}

/** A text watermark as Word writes one: WordArt behind the text, in the header (EXP-092). */
function watermarkXml(text: string, id: number): string {
  const safe = escapeAttr(xmlSafe(text).text);
  return el(
    'w:p',
    {},
    el('w:pPr', {}, el('w:spacing', { 'w:after': 0 })),
    `<w:r><w:rPr><w:noProof/></w:rPr><w:pict><v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas><v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/><v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles><o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype><v:shape id="DocEditWatermark${id}" o:spid="_x0000_s${2048 + id}" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:415pt;height:207.5pt;rotation:315;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${safe}"/><w10:wrap anchorx="margin" anchory="margin"/></v:shape></w:pict></w:r>`,
  );
}

/**
 * Writes a DOCX package from a CDM document (or a reader's projection of one) without an original
 * package (09 §11). Suggestions follow `opts.suggestions`.
 */
export async function writeDocx(
  envelope: JsonEnvelope,
  assets: AssetSource,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const mode = opts.suggestions ?? 'markup';
  const env: JsonEnvelope =
    mode === 'markup'
      ? (JSON.parse(JSON.stringify(envelope)) as JsonEnvelope)
      : {
          ...envelope,
          doc: settle(JSON.parse(JSON.stringify(envelope.doc)) as JsonNode, mode) ?? envelope.doc,
        };
  return new DirectWriter(env, assets, opts).run();
}
