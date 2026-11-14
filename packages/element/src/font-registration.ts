// The editor's font files on the page (FE-061; 02 §3, §6; review F8). Each file the manifest lists
// is registered on the page's font set under an alias derived from the file's hash, never under its
// family name, so that a family the host page defines (Noto Serif, say) keeps its own faces. Two
// editor instances, or two versions of the editor, that register the same file find the alias
// already in the set and add nothing.
//
// The font set and the FontFace constructor are passed in, so this module runs in Node.js tests and
// in the browser alike. It reads no browser global.

/** One file of the font manifest (02 §6): the family and style it serves, its URL, its hash and its licence. */
export interface FontFileEntry {
  /** The family the manifest names. It is never used as the alias. */
  readonly family: string;
  /** The FontFace style descriptor, for example `normal` or `italic`. */
  readonly style: string;
  /** The FontFace weight descriptor, for example `400`. */
  readonly weight: string;
  /** Where the file is served from. */
  readonly url: string;
  /** Lowercase hexadecimal SHA-256 digest of the file. */
  readonly hash: string;
  /** The licence the manifest records for the file (BE's rules; carried, not checked here). */
  readonly licence: string;
}

/** The part of a FontFace this module reads and calls. */
export interface FontFaceLike {
  readonly family: string;
}

/** The part of a FontFaceSet this module uses: its faces can be listed and one can be added. */
export interface FontFaceSetLike extends Iterable<FontFaceLike> {
  add(face: FontFaceLike): unknown;
}

/** Builds a face for a file under an alias. In the browser: `new FontFace(alias, url(...), descriptors)`. */
export type FontFaceFactory = (
  alias: string,
  url: string,
  style: string,
  weight: string,
) => FontFaceLike;

/** The prefix of every alias the editor registers. It cannot collide with a CSS generic family. */
export const FONT_ALIAS_PREFIX = 'de-font-';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The alias of a font file: the prefix and the file's hash. The hash names the file, so the alias
 * names the same bytes for every instance and every version of the editor.
 *
 * @throws {TypeError} when the hash is not a lowercase SHA-256 hexadecimal digest.
 */
export function fontAlias(hash: string): string {
  if (!SHA256_HEX.test(hash))
    throw new TypeError('a font hash must be a lowercase SHA-256 hex digest');
  return FONT_ALIAS_PREFIX + hash;
}

/** A family name as a font set reports it, without the quotes some browsers add. */
const unquoted = (family: string): string => family.replace(/^["']|["']$/g, '');

/** True when the font set already holds a face under this alias. */
function holds(set: FontFaceSetLike, alias: string): boolean {
  for (const face of set) if (unquoted(face.family) === alias) return true;
  return false;
}

/**
 * Registers each file of the manifest on the font set under its hash alias. A file whose alias is
 * already in the set is not added again. The host's faces are never read for a match by family name
 * and never removed.
 *
 * @returns the alias of each entry, in the order given.
 */
export function registerFontFiles(
  entries: readonly FontFileEntry[],
  set: FontFaceSetLike,
  makeFace: FontFaceFactory,
): string[] {
  const aliases: string[] = [];
  for (const entry of entries) {
    const alias = fontAlias(entry.hash);
    aliases.push(alias);
    if (holds(set, alias)) continue;
    set.add(makeFace(alias, entry.url, entry.style, entry.weight));
  }
  return aliases;
}
