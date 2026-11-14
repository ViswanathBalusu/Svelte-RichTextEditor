// The files of the font manifest (`GET /fonts`, 05 §6.2; 02 §6; FE-061). The protocol types the
// body as an open object (gap G75), so it is read here defensively: each family's faces become
// entries for `registerFontFiles`. The shape is the one the document service serves
// (`services/document-service/src/control-plane/fonts.ts`, `FontManifestBody`): `families[]` with
// `family`, `licence` and `faces[]` of `url`, `sha256`, `weight` and `italic`. A face that lacks
// any of these, or whose hash is not a lowercase SHA-256 digest, is left out, never guessed.
// No browser global is read.
import type { FontFileEntry } from './font-registration.ts';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The font files a manifest lists, in its order. */
export function manifestFontFiles(manifest: unknown): FontFileEntry[] {
  const out: FontFileEntry[] = [];
  if (!isObject(manifest) || !Array.isArray(manifest['families'])) return out;
  for (const family of manifest['families']) {
    if (!isObject(family) || !Array.isArray(family['faces'])) continue;
    const name = family['family'];
    const licence = family['licence'];
    if (typeof name !== 'string' || typeof licence !== 'string') continue;
    for (const face of family['faces']) {
      if (!isObject(face)) continue;
      const { url, sha256, weight, italic } = face;
      if (typeof url !== 'string' || url === '') continue;
      if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) continue;
      if (typeof weight !== 'number' && typeof weight !== 'string') continue;
      out.push({
        family: name,
        style: italic === true ? 'italic' : 'normal',
        weight: String(weight),
        url,
        hash: sha256,
        licence,
      });
    }
  }
  return out;
}
