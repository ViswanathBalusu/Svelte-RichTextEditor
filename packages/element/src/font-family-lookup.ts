// Looks a CDM `fontFamily` value up in the font manifest (FE-062 criterion 1; 02 §6). The lookup
// returns the manifest file that serves the family, and the hash alias that file is registered
// under (FE-061). The family name the document holds is never changed here. No browser global is read.
//
// Not decided here (see docs/adr/0204-lane-FE-053-065.md, section 6): the substitute table for
// Calibri, Cambria, Arial and the other families of FE-062 criterion 2, the fallback for a family
// with no entry (criterion 3), and the choice of one file when a family has several faces. The
// rule below is only the proposal for the last point: the normal, weight 400 face when there is one,
// otherwise the first face in manifest order.
import type { FontFileEntry } from './font-registration.ts';
import { fontAlias } from './font-registration.ts';
import { manifestFontFiles } from './font-manifest.ts';

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
 * The hash alias the family renders with, or `undefined` when the manifest has no face for the
 * family. The alias is `fontAlias(hash)` of the chosen file, so it matches what `registerFontFiles`
 * registers.
 */
export function familyAlias(manifest: unknown, family: string): string | undefined {
  const face = faceForFamily(manifest, family);
  return face === undefined ? undefined : fontAlias(face.hash);
}
