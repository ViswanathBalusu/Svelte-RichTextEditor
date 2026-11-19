/**
 * Hyphenation data on demand (WASM-009; 02 §9.3). The kernel holds no pattern of its own: a
 * language is two text files (the TeX patterns and the exceptions) that the page fetches when a
 * document needs them, and hands to the kernel. This module decides when that is, and checks each
 * file against the manifest's SHA-256 (computed by the kernel) before the kernel reads it.
 *
 * - `settings.hyphenation` false (the default): nothing is read, nothing is loaded.
 * - true: the languages the document uses (the `lang` marks and `settings.lang`) are looked up in
 *   the manifest; each one found is read and loaded once. A language the manifest does not list is
 *   not hyphenated and nothing fails (`missing` reports it).
 *
 * Universal: no DOM and no Node.js API (FND-004). The caller supplies `read`, which fetches a
 * file's text (the worker uses `fetch`, Node.js tests read the file).
 */
/**
 * What the loader needs of a started kernel (`LayoutKernel` has it): the SHA-256 of bytes and the
 * hyphenation store. Declared here, not imported, so that this file and `index.ts` do not import
 * each other.
 */
export interface HyphenationHost {
  sha256(data: Uint8Array): string;
  readonly hyphenation: {
    tags(): string[];
    load(tag: string, patterns: string, exceptions: string, left: number, right: number): number;
    alias(alias: string, tag: string): boolean;
  };
}

/** One file of a language, as `patterns/manifest.json` lists it. */
export interface HyphenationFile {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** One language of the manifest. */
export interface HyphenationLanguage {
  /** BCP 47, lowercase. */
  readonly tag: string;
  /** Other tags that stand for it (`en` for `en-us`). */
  readonly aliases: readonly string[];
  readonly patterns: HyphenationFile;
  /** The exception list, where the language has one. */
  readonly exceptions: HyphenationFile | null;
  /** The file header that the licence asks to be kept next to the patterns. */
  readonly notice: string;
  /** SPDX identifier of the licence the file is taken under, or a `LicenseRef-`. */
  readonly licence: string;
  /** The minimum characters before and after a hyphen that the house class gets (babel's, under its ini loading). */
  readonly left: number;
  readonly right: number;
  /** The same as the pattern file's own header gives them (they differ for French). */
  readonly fileMinimums: { readonly left: number; readonly right: number };
}

/** `patterns/manifest.json`. */
export interface HyphenationManifest {
  readonly languages: readonly HyphenationLanguage[];
  /** Languages that are not bundled, with the reason (copyleft patterns). */
  readonly refused: Readonly<Record<string, string>>;
}

/** Why a file was not loaded. */
export type HyphenationLoadCode = 'read_failed' | 'hash_mismatch' | 'refused';

/** A language that was in the manifest and was not loaded. */
export interface HyphenationLoadFailure {
  readonly tag: string;
  readonly code: HyphenationLoadCode;
  readonly detail: string;
}

/** What `ensureHyphenation` did. */
export interface HyphenationResult {
  /** Tags the kernel holds after the call that the call loaded. */
  readonly loaded: string[];
  /** Tags that were held already. */
  readonly held: string[];
  /** Requested tags the manifest has no language for: their text is not hyphenated. */
  readonly missing: string[];
  readonly failed: HyphenationLoadFailure[];
}

/** The document settings that matter here (03 §4.1). */
export interface HyphenationSettings {
  readonly hyphenation?: boolean;
  readonly lang?: string;
}

/** The language of a run of text: its `lang` mark, else `settings.lang`, else none (the empty tag). */
export function runLanguage(mark: string | undefined, settings: HyphenationSettings): string {
  return mark !== undefined && mark !== '' ? mark : (settings.lang ?? '');
}

const key = (tag: string): string => tag.trim().toLowerCase().replace(/_/g, '-');

/** The manifest's language for a tag: the tag, an alias, or the tag cut short, in that order. */
export function findLanguage(
  manifest: HyphenationManifest,
  tag: string,
): HyphenationLanguage | undefined {
  let t = key(tag);
  while (t !== '') {
    const found = manifest.languages.find((l) => l.tag === t || l.aliases.includes(t));
    if (found) return found;
    const cut = t.lastIndexOf('-');
    if (cut === -1) break;
    t = t.slice(0, cut);
  }
  return undefined;
}

/** UTF-8 to a string (the package has no `TextDecoder`: FND-004). A malformed sequence becomes U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i++]!;
    let cp = 0xfffd;
    if (b0 < 0x80) cp = b0;
    else if (b0 >= 0xc2 && b0 < 0xe0 && i < bytes.length && (bytes[i]! & 0xc0) === 0x80)
      cp = ((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    else if (
      b0 >= 0xe0 &&
      b0 < 0xf0 &&
      i + 1 < bytes.length &&
      (bytes[i]! & 0xc0) === 0x80 &&
      (bytes[i + 1]! & 0xc0) === 0x80
    ) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[i]! & 0x3f) << 6) | (bytes[i + 1]! & 0x3f);
      i += 2;
    } else if (
      b0 >= 0xf0 &&
      b0 < 0xf5 &&
      i + 2 < bytes.length &&
      (bytes[i]! & 0xc0) === 0x80 &&
      (bytes[i + 1]! & 0xc0) === 0x80 &&
      (bytes[i + 2]! & 0xc0) === 0x80
    ) {
      cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i]! & 0x3f) << 12) |
        ((bytes[i + 1]! & 0x3f) << 6) |
        (bytes[i + 2]! & 0x3f);
      i += 3;
      if (cp > 0x10ffff) cp = 0xfffd;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * Loads what a document needs. `languages` are the tags the document uses (`lang` marks and
 * `settings.lang`). With `settings.hyphenation` false the call reads nothing and returns at once.
 * `read(file)` gives a file's bytes; each is checked against the manifest's hash. Tags that map to
 * one manifest language load it once, and a language the kernel holds already is not read again.
 */
export async function ensureHyphenation(
  kernel: HyphenationHost,
  manifest: HyphenationManifest,
  settings: HyphenationSettings,
  languages: Iterable<string>,
  read: (file: string) => Promise<Uint8Array>,
): Promise<HyphenationResult> {
  const result: HyphenationResult = { loaded: [], held: [], missing: [], failed: [] };
  if (settings.hyphenation !== true) return result;
  const wanted = new Map<string, HyphenationLanguage>();
  for (const tag of new Set([...languages, settings.lang ?? ''])) {
    if (key(tag) === '') continue;
    const language = findLanguage(manifest, tag);
    if (language) wanted.set(language.tag, language);
    else result.missing.push(tag);
  }
  for (const language of wanted.values()) {
    if (kernel.hyphenation.tags().includes(language.tag)) {
      result.held.push(language.tag);
      continue;
    }
    try {
      const patterns = await readChecked(kernel, language.patterns, read);
      const exceptions = language.exceptions
        ? await readChecked(kernel, language.exceptions, read)
        : '';
      kernel.hyphenation.load(language.tag, patterns, exceptions, language.left, language.right);
      for (const alias of language.aliases) kernel.hyphenation.alias(alias, language.tag);
      result.loaded.push(language.tag);
    } catch (error) {
      const code =
        error instanceof HashMismatch
          ? 'hash_mismatch'
          : error instanceof ReadFailed
            ? 'read_failed'
            : 'refused';
      result.failed.push({
        tag: language.tag,
        code,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

class HashMismatch extends Error {}
class ReadFailed extends Error {}

async function readChecked(
  kernel: HyphenationHost,
  file: HyphenationFile,
  read: (file: string) => Promise<Uint8Array>,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await read(file.file);
  } catch (error) {
    throw new ReadFailed(`${file.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actual = kernel.sha256(bytes);
  if (actual !== file.sha256)
    throw new HashMismatch(`${file.file} hashes to ${actual}, the manifest says ${file.sha256}`);
  return decodeUtf8(bytes);
}
