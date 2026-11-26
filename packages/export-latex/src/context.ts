/**
 * The converter's state for one document: the shared semantics computed once (the model's style
 * table and labels, ADR 0032), the output lines with the block that owns each one (map.json), and
 * the diagnostics. Nothing here reads a clock, a random source or the environment (EXP-002).
 */
import type { DiagnosticCode } from './diagnostic-codes.ts';
import type { DocumentLabels, StyleTable } from '@docedit/model';
import type {
  AssetInput,
  ConvertOptions,
  CommentThread,
  Diagnostic,
  FontFamily,
  Redaction,
  Suggestions,
} from './bundle.ts';
import type { CodeRange } from './fonts/coverage.ts';
import {
  color as colorEmitter,
  enumLookup,
  int,
  join,
  lit,
  markedLines,
  type Tex,
} from './emit.ts';

/** A node of the document as plain JSON; projections may hold nodes the CDM types lack. */
export interface J {
  type: string;
  attrs?: Record<string, unknown>;
  content?: J[];
  marks?: Mark[];
  text?: string;
}

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
export const attr = (n: J | undefined, k: string): unknown => n?.attrs?.[k];
export const idOf = (n: J | undefined): string | null => str(attr(n, 'id'));

export interface Resolved {
  readonly tagging: NonNullable<ConvertOptions['tagging']>;
  readonly pdfStandard: NonNullable<ConvertOptions['pdfStandard']>;
  readonly renderer: NonNullable<ConvertOptions['renderer']>;
  readonly layout: NonNullable<ConvertOptions['layout']>;
  readonly profile: 'final' | 'preview';
  readonly fields: 'flatten' | 'blank';
  readonly suggestions: Suggestions | null;
  readonly comments: 'none' | 'margin';
}

export interface FamilyInfo {
  readonly n: number;
  readonly family: FontFamily;
  /** Union of the coverage of the family's four faces, when the manifest gives all four. */
  readonly coverage: readonly CodeRange[] | null;
}

export interface Out {
  lines: string[];
  owners: Array<number | null>;
  current: number | null;
}

/** The labels of `seq` fields are consumed in document order per holder. */
export interface Ctx {
  readonly options: ConvertOptions;
  readonly o: Resolved;
  readonly doc: J;
  readonly table: StyleTable;
  readonly labels: DocumentLabels;
  readonly families: ReadonlyMap<string, FamilyInfo>;
  readonly defaultFamily: FamilyInfo;
  /** Families of the manifest that a job may not load (EXP-048): reported once, not per block. */
  readonly screenOnlyFamilies: ReadonlySet<string>;
  readonly fallbackCoverage: readonly (readonly CodeRange[])[] | null;
  readonly assets: Readonly<Record<string, AssetInput>>;
  readonly diagnostics: Diagnostic[];
  readonly warned: Set<string>;
  readonly blocks: Array<string | null>;
  readonly kinds: string[];
  readonly owners: Array<string | null>;
  /** Block ranges of the rows of each table, by table identifier (map.json `tables`; EXP-057). */
  readonly tableRows: Map<string, Array<[number, number]>>;
  out: Out;
  /** Generated identifiers of hyperref targets, by anchor name or by `node:`/`eq:` target. */
  readonly anchors: Map<string, number>;
  /** Targets that a `ref` field points at, so that their blocks get an anchor. */
  readonly refTargets: Set<string>;
  readonly styleMacros: Map<string, Tex>;
  readonly styleLines: Tex[];
  readonly tabLists: Map<string, number>;
  /** Paragraph border lists written to styles.tex (`\DEdefborders`), by their spec (EXP-020). */
  readonly borderLists: Map<string, number>;
  readonly styleRefs: Map<string, number>;
  readonly seqCursor: Map<string, number>;
  readonly assetFiles: Map<string, Uint8Array | null>;
  readonly redactions: Redaction[];
  readonly languages: Map<string, number>;
  readonly captionLists: Map<string, number>;
  readonly formFields: Map<string, J>;
  /** Form field identifiers by the number of their field box (EXP-058); index 0 is unused. */
  readonly fieldIds: Array<string | null>;
  readonly setups: string[];
  /** True when the document is a projection (it holds `hidden_region` placeholders). */
  readonly projection: boolean;
  /** Caption paragraphs and figures, by block id: the caption lists they belong to. */
  readonly captionHolders: Map<string, string[]>;
  /** The citation texts and bibliography, computed once (EXP-121). */
  readonly citations: CitationTexts;
  /** Paragraph styles whose paragraphs set a `styleRef` mark (`\InsertMark`). */
  readonly markedStyles: Map<string, number>;
  /** Mutable state of the flow: the setup number and column count of the current page section. */
  readonly state: { columns: number; setup: number };
  /** The comment threads to place by paragraph, and the ones placed (EXP-084). */
  readonly comments: { byBlock: Map<string, CommentThread[]>; placed: Set<string> };
}

export interface CitationTexts {
  /** The text of each citation node, by node. */
  readonly byNode: ReadonlyMap<J, string>;
  readonly entries: readonly BibEntry[];
  /**
   * The biblatex route (EXP-121): the entry key of each source in 
eferences.bib, by source
   * identifier, and the style of the job. Null on the text route.
   */
  readonly biblatex: {
    readonly keys: ReadonlyMap<string, Tex>;
    readonly style: string;
    readonly include: 'cited' | 'all';
  } | null;
}

export interface BibEntry {
  readonly sourceId: string;
  /** The entry as runs of plain and italic text. */
  readonly parts: ReadonlyArray<{ text: string; italic?: boolean; url?: string }>;
}

export function diag(
  ctx: Ctx,
  severity: Diagnostic['severity'],
  code: DiagnosticCode,
  blockId: string | null,
  message: string,
): void {
  ctx.diagnostics.push({ severity, code, blockId, message });
}

/** One warning per code for the whole document (approximations that repeat). */
export function warnOnce(
  ctx: Ctx,
  code: DiagnosticCode,
  message: string,
  blockId: string | null = null,
): void {
  if (ctx.warned.has(code)) return;
  ctx.warned.add(code);
  diag(ctx, 'warning', code, blockId, message);
}

/**
 * A colour through the `color` emitter (EXP-044 criterion 2). A value that is set but is not six
 * hexadecimal digits is not written, and a diagnostic names the block. An absent value (null or
 * undefined) is not a fault and gives null without a diagnostic.
 */
export function colourOf(
  ctx: Ctx,
  value: string | null | undefined,
  blockId: string | null,
): Tex | null {
  const c = colorEmitter(value);
  if (c === null && value !== null && value !== undefined)
    diag(
      ctx,
      'warning',
      'colour_invalid',
      blockId,
      `${what(value)} is not a colour of six hexadecimal digits; none is written`,
    );
  return c;
}

/**
 * A lookup through the `enumLookup` emitter (EXP-044 criterion 4). A value that is set but has no
 * entry gives the table's fallback, and a diagnostic names the block (`enum_unknown`).
 */
export function enumOf<T extends Tex>(
  ctx: Ctx,
  table: Readonly<Record<string, T>>,
  value: string | null | undefined,
  fallback: T,
  blockId: string | null,
  subject: string,
): T {
  const r = enumLookup(table, value, fallback);
  if (!r.known && value !== null && value !== undefined)
    diag(
      ctx,
      'warning',
      'enum_unknown',
      blockId,
      `${subject} has no entry for ${what(value)}; the default is used`,
    );
  return r.tex;
}

/** A value quoted for a diagnostic, cut to 32 characters so that a long input stays short. */
function what(value: string): string {
  return `"${value.slice(0, 32)}"`;
}

/** Registers a block number for map.json and the class's layout report. */
export function register(
  ctx: Ctx,
  id: string | null | undefined,
  kind: string,
  owner: string | null = null,
): number {
  ctx.blocks.push(id ?? null);
  ctx.kinds.push(kind);
  ctx.owners.push(owner);
  return ctx.blocks.length - 1;
}

/**
 * The owner mark of `ownLines`: U+0001, the block number, U+0002. No emitter can write these two
 * characters (every string emitter removes the C0 controls), so a mark never comes from the
 * document. `line` reads the marks and removes them; they never reach main.tex.
 */
const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';

/**
 * Text that is written inside another block's TeX but belongs to `block` (a footnote's text in its
 * host paragraph, EXP-012 criterion 2). The text is put on lines of its own, and each line carries
 * an owner mark, so that map.json gives those lines to `block` and not to the host.
 *
 * The line ends added here end in `%`, and TeX skips the spaces that start a line, so the tokens
 * TeX reads are the same as when the text stands on the host's line.
 */
export function ownLines(block: number, value: Tex): Tex {
  return markedLines(join([lit(MARK_OPEN), int(block), lit(MARK_CLOSE)]), value);
}

export function line(ctx: Ctx, value: Tex): void {
  for (const l of value.split('\n')) {
    // With nested marks (a footnote inside a footnote) the last, innermost one owns the line.
    let owner = ctx.out.current;
    let clean: string = l;
    for (;;) {
      const open = clean.indexOf(MARK_OPEN);
      const close = open < 0 ? -1 : clean.indexOf(MARK_CLOSE, open);
      if (close < 0) break;
      owner = Number(clean.slice(open + 1, close));
      clean = clean.slice(0, open) + clean.slice(close + 1);
    }
    ctx.out.lines.push(clean);
    ctx.out.owners.push(owner);
  }
}

export function within<T>(ctx: Ctx, block: number | null, f: () => T): T {
  const prev = ctx.out.current;
  ctx.out.current = block;
  try {
    return f();
  } finally {
    ctx.out.current = prev;
  }
}
