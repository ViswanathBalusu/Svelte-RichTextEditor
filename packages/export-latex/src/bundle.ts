/**
 * Bundle types (09 §2): what the converter writes and the worker compiles, and the inputs it reads.
 * Nothing here is specific to LaTeX except `Bundle`, `SourceMap` and the class options; the writer
 * interface in `writer.ts` uses the generic parts only (EXP-002).
 */
import type { CounterEffect } from '@docedit/model';
import type { CodeRange } from './fonts/coverage.ts';

/** A font file on the worker's read-only font path, named by its SHA-256 (09 §5). */
export interface FontFace {
  /** `<sha256>.ttf`, `.otf`, `.ttc` or `.otc`. */
  file: string;
  sha256: string;
  /**
   * The code points the face covers, as sorted inclusive ranges (`fontCoverage`). Optional: when
   * the manifest has it for every face a run can use, the converter checks every character before
   * typesetting (EXP-026); otherwise only the class's `\tracinglostchars` catches a missing glyph.
   */
  coverage?: CodeRange[];
}

export interface FontFamily {
  /** The family name as documents use it in `fontFamily` (03 §4.5). */
  name: string;
  /** Word's single line height, (win ascent + win descent) / units per em, in thousandths. */
  lineHeight: number;
  /**
   * The descent part of `lineHeight` (win descent / units per em), in thousandths. Absent: 215,
   * the ratio of the Noto faces (293 of 1362). The class puts a line's extra height above the text
   * (ADR 0046).
   */
  descent?: number;
  regular: FontFace;
  bold: FontFace;
  italic: FontFace;
  boldItalic: FontFace;
  licence: string;
}

/** A face of the fallback chain (09 §3.2, Missing glyphs; EXP-026, EXP-047). */
export interface FallbackFace extends FontFace {
  name: string;
  licence: string;
}

/** The font manifest of a job (09 §1: an input of the converter). */
export interface FontManifest {
  version: 1;
  families: FontFamily[];
  math: FontFace & { name: string; licence: string };
  /** The family used when a document names one the manifest lacks. */
  defaultFamily: string;
  /**
   * The fallback chain, in order: a character a family lacks is taken from the first face here
   * that has it. Absent: the math face is the only fallback, because it is always on the font path.
   */
  fallback?: FallbackFace[];
}

/** An asset of the document (06 §4.4), as the job gives it to the converter (EXP-014). */
export interface AssetInput {
  /** SHA-256 of the bytes, lower-case hexadecimal. */
  sha256: string;
  /** `image/png`, `image/jpeg` or `application/pdf` (SVG is converted to PDF on upload). */
  mediaType: string;
  /** Only `ready` assets are used (06 §4.4). */
  status?: 'ready' | 'pending' | 'failed' | 'quarantined';
  /** The bytes; absent when the worker supplies the file by hash. */
  bytes?: Uint8Array;
}

export type Tagging = 'on' | 'draft' | 'off' | 'none';
export type PdfStandard = 'ua-2+a-4f' | 'ua-2' | 'a-4f' | 'none';
export type Renderer = 'node' | 'harf';
export type LayoutLevel = 'off' | 'block' | 'line';
export type Suggestions = 'accept' | 'reject' | 'markup';

export interface ConvertOptions {
  fonts: FontManifest;
  /** The class files, read by the caller: `docedit.cls` and `docedit.lua` (09 §2). */
  classFiles: Readonly<Record<string, string>>;
  /** `on`, `draft` and `off` map to \DocumentMetadata's `tagging` key; `none` omits it. */
  tagging?: Tagging;
  pdfStandard?: PdfStandard;
  renderer?: Renderer;
  layout?: LayoutLevel;
  seq?: number | null;
  chainHead?: string | null;
  /**
   * The digest of the curated TeX Live image that will compile the bundle (EXP-073): `sha256:`
   * and 64 lowercase hex digits. The worker supplies it; it is recorded in `manifest.json`.
   */
  imageDigest?: string | null;
  /** Document title, for the PDF metadata and `title` fields (control-plane metadata, 03 §2). */
  title?: string;
  /**
   * The server's instant at job creation (RFC 3339, UTC) and the job's time zone (IANA), for
   * `date` fields (03 §7; 09 §3.1). Both or neither; a client value is never used.
   */
  instant?: string;
  timeZone?: string;
  /**
   * Deprecated (spike S4): the server's date, already formatted. Used only when `instant` and
   * `timeZone` are absent.
   */
  date?: string;
  /**
   * `final` (default): a character no font covers is an error (09 §3.2; EXP-026). `preview`: it is
   * a warning and the compile goes on.
   */
  profile?: 'final' | 'preview';
  /** Document assets by identifier (EXP-014). An asset not listed is not attached. */
  assets?: Readonly<Record<string, AssetInput>>;
  /**
   * Counter effects of the hidden regions of a projection (ADR 0019; ADR 0032 §2), by region
   * identifier, so that a projection shows the full document's numbers (owner decision 3 default).
   */
  counterEffects?: Readonly<Record<string, CounterEffect>>;
  /** `fields` of 09 §9.1: `flatten` (default) prints values, `blank` prints none. */
  fields?: 'flatten' | 'blank';
  /**
   * How suggestions print (09 §10): `accept`, `reject`, or `markup` (EXP-083: insertions and
   * deletions kept and marked in the text). Absent with suggestions in the document: an error
   * diagnostic `pending_suggestions`, and the bundle shows the text as if all were rejected.
   */
  suggestions?: Suggestions;
  /** Neutral notices, in the job's language. Defaults are in English. */
  notices?: Readonly<{ hiddenRegion?: string; redactedValue?: string }>;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  blockId: string | null;
  message: string;
}

/** `map.json` (09 §2): line ranges of main.tex mapped to blocks, and block numbers to ids. */
export interface SourceMap {
  version: 1;
  /** Index = the block number the class reports in its layout data; entry 0 is unused. */
  blocks: Array<string | null>;
  /** Kind of each numbered block, same index. */
  kinds: string[];
  /**
   * The container a block's material belongs to, same index: the footnote of a footnote paragraph,
   * the story of a header or footer paragraph, the table of a cell paragraph; null otherwise.
   */
  owners: Array<string | null>;
  /** 1-based inclusive line ranges of main.tex; `block` null means preamble or class material. */
  lines: Array<{ from: number; to: number; block: number | null }>;
  /** Page setup identifiers by the index the class reports per page (`setup` of layout.json). */
  setups: string[];
  /**
   * Form field identifiers by the number the class reports their boxes under (`fields` of the
   * class's sidecar file, joined into layout.json `fields`; EXP-058). Entry 0 is unused. Absent
   * when the document has no form field.
   */
  fields?: Array<string | null>;
}

/** One thing a projection hid from the requester (ADR 0019; EXP-123). */
export interface Redaction {
  kind: 'region' | 'fieldValue';
  /** The hidden region's identifier, or the form field's. */
  id: string;
}

export interface BundleManifest {
  bundleVersion: 1;
  seq: number | null;
  chainHead: string | null;
  /** The image digest the caller gave (EXP-073), or null when none was given. */
  imageDigest: string | null;
  cdm: number;
  classVersion: string;
  /** The math gate that checked every equation (EXP-051): allow-list version, KaTeX version and fingerprint. */
  mathGate: { version: number; katex: string; fingerprint: string };
  fonts: Array<{ family: string; files: FontFace[]; licence: string; role: string }>;
  options: Record<string, string>;
  /** What the requester's projection left out; empty for a full export. */
  redactions: Redaction[];
  /** SHA-256 of every file of the bundle except this manifest, assets included. */
  files: Record<string, string>;
  /** SHA-256 over the sorted `name sha256` lines of `files`, then a `#options` line (EXP-005). */
  bundleHash: string;
}

export interface Bundle {
  /** Text files by name: main.tex, styles.tex, the class, map.json, manifest.json. */
  files: Record<string, string>;
  /** Binary files by name (`assets/<sha256>.<ext>`), for the worker's tar (EXP-014). */
  assets: Record<string, Uint8Array>;
  map: SourceMap;
  manifest: BundleManifest;
  diagnostics: Diagnostic[];
  /** False when a diagnostic is an error: the job must not release a PDF (EXP-002, EXP-026). */
  ok: boolean;
}
