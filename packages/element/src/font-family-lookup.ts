// Looks a CDM `fontFamily` value up in the font manifest (FE-062; 02 §6). The lookup returns the
// manifest file that serves the family, and the hash alias that file is registered under (FE-061).
// The family name the document holds is never changed here.
//
// The order of the lookup (FE-062 criteria 1 to 3):
//   1. a face the manifest holds under the family's own name;
//   2. the manifest's `substitutes` list, an ordered list of `{ family, replacement }` lines (the
//      same lines EXP-106 reads, `packages/export-docx/src/font-substitution.ts`): Calibri to
//      Carlito and so on; the first line that names the family decides, so a tenant line placed
//      first wins;
//   3. the manifest's `defaultFamily`, for a family with no open substitute (Aptos). The text then
//      reflows, which is expected and not an error (`reflows` is true so a caller can say so).
//
// Proposed, not decided by the owner (docs/adr/0204-lane-FE-053-065.md, section 6, and the story's
// Notes): the `substitutes` field of the body of `GET /fonts` (the service does not serve it yet,
// BE-047), the use of `defaultFamily` as the fallback, and the choice of one file when a family has
// several faces (the normal, weight 400 face when there is one, otherwise the first in manifest
// order).
import type { FontFileEntry } from './font-registration.ts';
import { fontAlias } from './font-registration.ts';
import { manifestFontFiles } from './font-manifest.ts';

export interface FontSubstituteLine {
  family: string;
  replacement: string;
}

/** How a family was resolved: its own face, a manifest substitute, or the default family. */
export type FamilyVia = 'face' | 'substitute' | 'default';

export interface FamilyResolution {
  face: FontFileEntry;
  via: FamilyVia;
  /** True when the file is not metric-compatible with the family, so the text reflows. */
  reflows: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Families compare without case and surrounding spaces, as Word compares them. */
const key = (family: string): string => family.trim().replace(/\s+/g, ' ').toLowerCase();

/** The `substitutes` lines of a manifest body, in order; a malformed line is left out. */
export function manifestSubstitutes(manifest: unknown): FontSubstituteLine[] {
  if (!isObject(manifest) || !Array.isArray(manifest['substitutes'])) return [];
  const out: FontSubstituteLine[] = [];
  for (const line of manifest['substitutes']) {
    if (!isObject(line)) continue;
    const { family, replacement } = line;
    if (typeof family === 'string' && typeof replacement === 'string' && family !== '')
      out.push({ family, replacement });
  }
  return out;
}

/**
 * The manifest file that serves a family, by exact family name, or `undefined` when the manifest
 * has no face for it. The document's family name is compared as it is, without case folding.
 */
export function faceForFamily(manifest: unknown, family: string): FontFileEntry | undefined {
  const faces = manifestFontFiles(manifest).filter((entry) => entry.family === family);
  if (faces.length === 0) return undefined;
  return faces.find((entry) => entry.style === 'normal' && entry.weight === '400') ?? faces[0];
}

/**
 * The file a family renders with and how it was found, or `undefined` when the manifest names no
 * face for the family, no substitute that has a face, and no default family with a face.
 */
export function resolveFamily(manifest: unknown, family: string): FamilyResolution | undefined {
  const own = faceForFamily(manifest, family);
  if (own !== undefined) return { face: own, via: 'face', reflows: false };
  const wanted = key(family);
  const line = manifestSubstitutes(manifest).find((s) => key(s.family) === wanted);
  if (line !== undefined) {
    const face = faceForFamily(manifest, line.replacement);
    if (face !== undefined) return { face, via: 'substitute', reflows: false };
  }
  const fallback =
    isObject(manifest) && typeof manifest['defaultFamily'] === 'string'
      ? faceForFamily(manifest, manifest['defaultFamily'])
      : undefined;
  return fallback === undefined ? undefined : { face: fallback, via: 'default', reflows: true };
}

/**
 * The hash alias the family renders with, or `undefined` when the lookup finds no file. The alias
 * is `fontAlias(hash)` of the chosen file, so it matches what `registerFontFiles` registers.
 */
export function familyAlias(manifest: unknown, family: string): string | undefined {
  const found = resolveFamily(manifest, family);
  return found === undefined ? undefined : fontAlias(found.face.hash);
}
