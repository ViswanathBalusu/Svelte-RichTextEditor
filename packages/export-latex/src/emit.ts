/**
 * Typed emitters (09 §4). This module is the only place that turns a value into TeX: every other
 * module builds output from `Tex` values, and the only ways to get a `Tex` value are an emitter of
 * this module, the `tex` template and `lit`, whose literal parts are constants written in this
 * package. A plain `string` cannot be passed where `Tex` is expected, so a user string written to
 * the bundle without an emitter is a type error (EXP-045). `emit.guard.test.ts` checks that no
 * other module creates `Tex` by a cast.
 *
 * The eight emitters of 09 §4, the two of the `.bib` file (EXP-121, SR-M20) and their rules:
 * - `text`: body text. Escapes `\ { } $ & # _ % ^ ~`, guards `[` and `]`, maps no-break space and
 *   soft hyphen, removes control and bidirectional control characters, normalises to NFC, and
 *   writes the spaces TeX would lose as explicit spaces (09 §3.2, Spaces; `spaceRuns` of the
 *   model says which).
 * - `pdfString`, `kvValue`: bookmarks, metadata, alternative text, option values. The string is
 *   written as hexadecimal digits and decoded by the class's Lua code into catcode-12 characters,
 *   so no TeX command can survive and no brace, comma, equals sign or bracket can end an argument.
 * - `url`: link targets. Scheme allow-list of invariant I9; characters outside RFC 3986 are
 *   percent-encoded; the result is hex-encoded like `pdfString` (ADR 0046 on 09 §4's rule).
 * - `dimen`: lengths from the CDM's integer twentieths of a point, clamped.
 * - `color`: exactly six hexadecimal digits.
 * - `enumLookup`: a value selects an entry of a fixed table; the value itself is never written.
 * - `generatedId`: numbers and names derived from counters or hashes, never from input; `int`,
 *   `letters` and `assetFile` are its forms.
 *
 * - `bibField`: a field value of the generated `.bib` file, which biber reads and biblatex typesets,
 *   so it is TeX text in the BibTeX syntax: the `text` escapes, except that a brace is written as
 *   `\textbraceleft{}` or `\textbraceright{}`, because BibTeX counts braces whatever precedes them,
 *   and every run of white space (a line end included) is one space.
 * - `bibKey`: an entry key, from the source's identifier when that is a plain word of at most 64
 *   letters, digits, dots, hyphens and underscores, otherwise `src<n>` from a counter.
 *
 * Two more constructors carry checked values: `fontFile` (a content-hash file name from the font
 * manifest) and `gatedMath` (math that passed the gate, 09 §6.3).
 */
import { twipsToBp, utf8 } from '@docedit/model';

declare const texBrand: unique symbol;
/** A fragment of TeX produced by an emitter or by converter-authored constants. */
export type Tex = string & { readonly [texBrand]: true };

const asTex = (s: string): Tex => s as Tex;

/** The names of the emitters of 09 §4, for the attribute table (EXP-045). */
export const EMITTERS = [
  'text',
  'pdfString',
  'kvValue',
  'url',
  'dimen',
  'color',
  'enumLookup',
  'generatedId',
  'bibField',
  'bibKey',
] as const;
export type EmitterName = (typeof EMITTERS)[number];

/**
 * Converter-authored TeX: the literal parts are constants of this package, taken raw (so `\DEp`
 * means a backslash followed by `DEp`); every interpolation must already be `Tex`.
 */
export function tex(strings: TemplateStringsArray, ...parts: readonly Tex[]): Tex {
  let out = strings.raw[0] ?? '';
  for (let i = 0; i < parts.length; i++) out += String(parts[i]) + (strings.raw[i + 1] ?? '');
  return asTex(out);
}

/**
 * A converter constant. Only a string literal type is accepted: passing a value of type `string`,
 * which is what any user value is, does not compile.
 */
export function lit<const S extends string>(value: string extends S ? never : S): Tex {
  return asTex(value);
}

export const EMPTY: Tex = asTex('');

export function join(parts: readonly Tex[], separator: Tex = EMPTY): Tex {
  return asTex(parts.join(separator));
}

/**
 * `value` on lines of its own, each line starting with `mark`. The line ends added before and
 * after end in `%`, and TeX skips the spaces that start a line, so the tokens TeX reads are those
 * of `value` alone. The converter's `line` reads the marks and removes them (EXP-012).
 */
export function markedLines(mark: Tex, value: Tex): Tex {
  const marked = value
    .split('\n')
    .map((l) => mark + l)
    .join('\n');
  return asTex(`%\n${marked}%\n`);
}

// ---------------------------------------------------------------------------------------------
// Cleaning shared by the string emitters

/**
 * C0 and C1 controls, DEL, bidirectional embeddings, overrides and isolates, the byte order mark,
 * and lone surrogates (with the `u` flag a surrogate range matches only unpaired code units).
 */
const REMOVED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xd800, 0xdfff],
];
const codePointEscape = (n: number): string => `\\u{${n.toString(16)}}`;
const REMOVED = new RegExp(
  `[${REMOVED_RANGES.map(([a, b]) => `${codePointEscape(a)}-${codePointEscape(b)}`).join('')}]`,
  'gu',
);
const NBSP = String.fromCharCode(0xa0);
const SOFT_HYPHEN = String.fromCharCode(0xad);

/** NFC with the characters the PDF must not carry removed. */
export function clean(value: string): string {
  return value.normalize('NFC').replace(REMOVED, '');
}

// ---------------------------------------------------------------------------------------------
// text

const TEXT_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  _: '\\_',
  '%': '\\%',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  // A bracket after a line break or an item would start an optional argument; always guard it.
  '[': '{[}',
  ']': '{]}',
  [NBSP]: '~',
  [SOFT_HYPHEN]: '\\-',
};

function escapeSegment(segment: string): string {
  let out = '';
  for (const ch of clean(segment)) out += TEXT_ESCAPES[ch] ?? ch;
  return out;
}

export interface TextContext {
  /** The character before this string in the block was a space, or this is the block's start. */
  afterSpace?: boolean;
  /**
   * UTF-16 offsets, within this string, of the spaces to write explicitly. When given, it replaces
   * the `afterSpace` rule; the converter computes it with the model's `spaceRuns` over the whole
   * paragraph, because a run of spaces can cross text nodes (ADR 0032 §7).
   */
  explicit?: ReadonlySet<number>;
}

/** One piece of a text run whose glyph count matches its UTF-16 length in the source (09 §7.1). */
export interface TextChunk {
  /** Offset of the chunk in the source string. */
  offset: number;
  tex: Tex;
}

/**
 * Body text, split into chunks. A chunk ends after a word whose cleaned form has another length
 * than the source (a removed control character, an NFC composition), so that the next chunk can
 * restart the class's offset counter at its exact source offset. Spaces are never cleaned.
 */
export function textChunks(value: string, context: TextContext = {}): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current = '';
  let start = 0;
  let prevSpace = context.afterSpace ?? false;
  let i = 0;
  while (i < value.length) {
    if (value.charCodeAt(i) === 0x20) {
      const explicit = context.explicit ? context.explicit.has(i) : prevSpace;
      current += explicit ? '\\ ' : ' ';
      prevSpace = true;
      i++;
      continue;
    }
    let j = i;
    while (j < value.length && value.charCodeAt(j) !== 0x20) j++;
    const raw = value.slice(i, j);
    const cleaned = clean(raw);
    current += escapeSegment(raw);
    prevSpace = false;
    i = j;
    if (cleaned.length !== raw.length) {
      chunks.push({ offset: start, tex: asTex(current) });
      current = '';
      start = i;
    }
  }
  if (current !== '' || chunks.length === 0) chunks.push({ offset: start, tex: asTex(current) });
  return chunks;
}

/** Body text as one piece (see `textChunks` for the exact rules). */
export function text(value: string, context: TextContext = {}): Tex {
  return join(textChunks(value, context).map((c) => c.tex));
}

/** The UTF-16 length of what `text` keeps of a string. */
export function cleanLength(value: string): number {
  return clean(value).length;
}

// ---------------------------------------------------------------------------------------------
// pdfString, kvValue

function hexBytes(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

function hex(value: string): string {
  return hexBytes(utf8(value));
}

/** The most characters of a label that a visible placeholder shows (an unbreakable box must stay under TeX's size limit). */
export const PLACEHOLDER_LABEL_MAX = 80;

/**
 * A label for a visible placeholder (`\DEph`, a framed box that does not break): the value cut to
 * PLACEHOLDER_LABEL_MAX characters, with an ellipsis, so that very long alternative text cannot make
 * the box wider than TeX allows ("Dimension too large"; SEC-033). The full text stays in the PDF's own
 * alternative text where it is used; only the placeholder is shortened.
 */
export function placeholderLabel(value: string): string {
  const chars = [...value];
  return chars.length <= PLACEHOLDER_LABEL_MAX
    ? value
    : `${chars.slice(0, PLACEHOLDER_LABEL_MAX - 1).join('')}…`;
}

/** Bookmarks, metadata, alternative text: `\DEstr{<hex>}`, decoded by docedit.lua. */
export function pdfString(value: string): Tex {
  return asTex(`\\DEstr{${hex(clean(value))}}`);
}

/** A key-value option value: braced, and inert because the content is hex digits only. */
export function kvValue(value: string): Tex {
  return asTex(`{${pdfString(value)}}`);
}

/**
 * A PDF text string in UTF-16BE hexadecimal form with the byte order mark (`<FEFF...>`), for
 * dictionary entries the class writes directly, such as a link's `/Contents` (EXP-030). Hex
 * digits only, so nothing in it is TeX or PDF syntax.
 */
export function pdfHexString(value: string): Tex {
  let out = 'FEFF';
  const s = clean(value);
  for (let i = 0; i < s.length; i++)
    out += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return asTex(`<${out}>`);
}

// ---------------------------------------------------------------------------------------------
// bibField, bibKey (EXP-121)

const BIB_ESCAPES: Readonly<Record<string, string>> = {
  ...TEXT_ESCAPES,
  '{': '\\textbraceleft{}',
  '}': '\\textbraceright{}',
  // Brackets are safe in a field value; the guard of `text` is for optional arguments.
  '[': '[',
  ']': ']',
};

/** A field value of the `.bib` file (see the module comment). The braces around it are the caller's. */
export function bibField(value: string): Tex {
  let out = '';
  for (const ch of clean(value)
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    .trim())
    out += BIB_ESCAPES[ch] ?? ch;
  return asTex(out);
}

/**
 * A verbatim field of the `.bib` file (a DOI, a URL), part of the `bibField` emitter: a character
 * outside RFC 3986 is percent-encoded, so no brace, backslash or quotation mark can end the value
 * or start a TeX command. The braces around it are the caller's.
 */
export function bibVerbatim(value: string): Tex {
  let out = '';
  for (const ch of clean(value).trim()) {
    if (URI_ALLOWED.test(ch)) out += ch;
    else out += hexBytes(utf8(ch)).replace(/(..)/g, '%$1');
  }
  return asTex(out);
}

/**
 * The entry key of a source. `used` holds the keys already given, so two sources never share one;
 * `counter` makes the key of a source whose identifier is not a plain word.
 */
export function bibKey(id: string, counter: number, used: ReadonlySet<string>): Tex {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !used.has(id)) return asTex(id);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError('not a counter');
  let n = counter;
  while (used.has(`src${n}`)) n++;
  return asTex(`src${n}`);
}

// ---------------------------------------------------------------------------------------------
// url

export type UrlResult =
  | { kind: 'external'; tex: Tex }
  | { kind: 'internal'; name: string }
  | { kind: 'refused'; reason: string };

const URI_ALLOWED = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/** Link targets: http, https, mailto or an in-document target (invariant I9). */
export function url(href: string): UrlResult {
  if (/^#[A-Za-z0-9_:.-]{1,128}$/.test(href)) return { kind: 'internal', name: href.slice(1) };
  if (!/^(?:https?:\/\/|mailto:)/i.test(href))
    return { kind: 'refused', reason: 'the scheme is not http, https or mailto' };
  let encoded = '';
  for (const ch of clean(href)) {
    if (URI_ALLOWED.test(ch)) encoded += ch;
    else encoded += hexBytes(utf8(ch)).replace(/(..)/g, '%$1');
  }
  return { kind: 'external', tex: asTex(hex(encoded)) };
}

// ---------------------------------------------------------------------------------------------
// dimen, color, enumLookup, identifiers

export interface DimenRange {
  min: number;
  max: number;
}
/** 22 inches either way, the CDM's own range for lengths (cdm1 LENGTH). */
export const LENGTH_RANGE: DimenRange = { min: -31680, max: 31680 };
/** Lengths that cannot be negative. */
export const ULENGTH_RANGE: DimenRange = { min: 0, max: 31680 };

/** A length in twentieths of a point, clamped, written exactly in TeX big points. */
export function dimen(twips: number, range: DimenRange = LENGTH_RANGE): Tex {
  const n = Number.isSafeInteger(twips) ? twips : 0;
  return asTex(twipsToBp(Math.min(range.max, Math.max(range.min, n))));
}

/** `#RRGGBB` to six hexadecimal digits, or null when the value is not a colour. */
export function color(value: string | null | undefined): Tex | null {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) return null;
  return asTex(value.slice(1).toUpperCase());
}

/** Selects an entry of a fixed table; the value itself never reaches the output. */
export function enumLookup<T extends Tex>(
  table: Readonly<Record<string, T>>,
  value: string | null | undefined,
  fallback: T,
): { tex: T; known: boolean } {
  if (typeof value === 'string' && Object.hasOwn(table, value))
    return { tex: table[value]!, known: true };
  return { tex: fallback, known: false };
}

/** A converter-computed integer: offsets, counters, block numbers. */
export function int(n: number): Tex {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not an integer: ${n}`);
  return asTex(String(n));
}

/** Identifiers for labels and anchors: derived from a counter. */
export function generatedId(n: number): Tex {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a counter: ${n}`);
  return int(n);
}

/** Letters only, for macro names and file extensions: 0 → a, 25 → z, 26 → ba (base 26). */
export function letters(n: number): Tex {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a counter: ${n}`);
  let out = '';
  let v = n;
  do {
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  } while (v > 0);
  return asTex(out);
}

/** File extensions by media type (EXP-014); anything else is not placed. */
const ASSET_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
};

/** The bundle path of an asset: `assets/<sha256>.<extension>`, a name derived from a hash. */
export function assetFile(sha256: string, mediaType: string): Tex | null {
  const ext = Object.hasOwn(ASSET_EXTENSIONS, mediaType) ? ASSET_EXTENSIONS[mediaType] : undefined;
  if (!ext || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return asTex(`assets/${sha256}.${ext}`);
}

/** A font file name from the font manifest: the content hash and a fixed extension. */
export function fontFile(name: string): Tex {
  if (!/^[0-9a-f]{64}\.(?:ttf|otf|ttc|otc)$/.test(name))
    throw new RangeError('font file names are content hashes');
  return asTex(name);
}

/** Math that passed the gate (09 §6.3); the only user-authored TeX that reaches the engine. */
export function gatedMath(latex: string, passed: true): Tex {
  void passed;
  return asTex(latex);
}
