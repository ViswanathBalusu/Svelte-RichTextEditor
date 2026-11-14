// The production side of FE-061 (02 §3, §6; review F8): the backend's font manifest is read through
// its `fonts` port and every file is registered on the page's `document.fonts` with the FontFace
// API, under the hash alias of `registerFontFiles`, never under the family name. The session calls
// `registerManifestFonts` once the backend is connected (`session.ts`). A face is only registered:
// the browser fetches the file when text first uses the alias, or when FE-063 asks it to load.
import type { FontsPort } from '@docedit/protocol';
import { manifestFontFiles } from './font-manifest.ts';
import { familyAlias } from './font-family-lookup.ts';
import {
  registerFontFiles,
  type FontFaceFactory,
  type FontFaceLike,
  type FontFaceSetLike,
} from './font-registration.ts';

/** Where faces are registered: the page's font set and the FontFace constructor of that page. */
export interface PageFonts {
  readonly set: FontFaceSetLike;
  readonly make: FontFaceFactory;
}

/** A URL as a CSS `url("…")` source: quotes, backslashes and line breaks escaped. */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r\f]/g, (c) => (c === '"' || c === '\\' ? `\\${c}` : `\\${c.charCodeAt(0).toString(16)} `))}")`;
}

/**
 * The page's fonts: `document.fonts` and `new FontFace`. Null where there is no page (Node.js, a
 * worker), so the session runs unchanged in tests without a DOM.
 */
export function pageFonts(): PageFonts | null {
  const g = globalThis as { document?: { fonts?: FontFaceSet }; FontFace?: typeof FontFace };
  const set = g.document?.fonts;
  const Face = g.FontFace;
  if (!set || typeof Face !== 'function') return null;
  return {
    set: {
      add: (face: FontFaceLike) => set.add(face as FontFace),
      [Symbol.iterator]: () => set[Symbol.iterator](),
    },
    make: (alias, url, style, weight) => new Face(alias, cssUrl(url), { style, weight }),
  };
}

/**
 * Reads the manifest through the port and registers its files. Two editor instances on one page,
 * or two versions of the editor, share the page's font set, so the second finds each alias there
 * and adds nothing (FE-061 criterion 3).
 *
 * @returns the alias of each file, in manifest order; empty when there is no page.
 */
export async function registerManifestFonts(
  port: FontsPort,
  target: PageFonts | null = pageFonts(),
): Promise<string[]> {
  if (!target) return [];
  const manifest = await port.manifest();
  return registerFontFiles(manifestFontFiles(manifest), target.set, target.make);
}

/**
 * The family lookup the engine draws with (FE-062 criterion 1): a family the manifest serves gives
 * its hash alias, any other family gives `undefined` and keeps its name. A manifest that cannot be
 * read gives a lookup that knows no family, so the editor keeps its fallback fonts.
 */
export async function manifestFamilyLookup(
  port: FontsPort,
): Promise<(family: string) => string | undefined> {
  try {
    const manifest = await port.manifest();
    return (family) => familyAlias(manifest, family);
  } catch {
    return () => undefined;
  }
}
