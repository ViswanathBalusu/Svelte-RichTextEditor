/**
 * The harness's font manifest (`fonts/manifest.json`, written by scripts/fonts.ts) and the choice
 * of face for a run of text. The editor, the shapers and the painter all use these same files,
 * which 02 §6 makes a precondition for matching layout.
 */
import manifestJson from '../fonts/manifest.json' with { type: 'json' };

/** What a face is used for: Latin text, Chinese and Japanese, Korean, Arabic or Tamil. */
export type FontRole = 'latin' | 'cjk' | 'hangul' | 'arabic' | 'tamil';

export interface FontManifestEntry {
  /** Path inside `fonts/`. */
  readonly file: string;
  /** The family name the harness uses in CSS and in `FontKey.family`. */
  readonly alias: string;
  readonly family: string;
  readonly subfamily: string;
  readonly weight: 400 | 700;
  readonly style: 'normal' | 'italic';
  readonly role: FontRole;
  /** Name ID 5 of the font's `name` table. */
  readonly version: string;
  readonly copyright: string;
  /** SPDX identifier, from name ID 13. */
  readonly licence: string;
  readonly licenceFile: string;
  /** Where the file was copied from. */
  readonly origin: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FontManifest {
  readonly $comment: string;
  readonly fonts: readonly FontManifestEntry[];
}

export const fontManifest: FontManifest = manifestJson as unknown as FontManifest;

/** Hangul syllables and jamo. */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
/** Ideographs, kana, CJK punctuation and full-width forms. */
const CJK =
  /[\u2e80-\u2fff\u3000-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** The script class a piece of text needs a face for. */
export function roleOf(text: string): FontRole {
  if (HANGUL.test(text)) return 'hangul';
  if (CJK.test(text)) return 'cjk';
  return 'latin';
}

/**
 * The manifest face for a run: the corpus families (Noto Serif, Noto Sans, Noto Sans Mono) map to
 * themselves; any other family falls back to Noto Serif; text that needs a CJK or Hangul face gets
 * that face whatever its family (the CJK faces have one weight).
 */
export function faceFor(
  family: string,
  bold: boolean,
  italic: boolean,
  role: FontRole = 'latin',
): FontManifestEntry {
  const fonts = fontManifest.fonts;
  if (role !== 'latin') {
    const f = fonts.find((e) => e.role === role);
    if (f) return f;
  }
  const latin = fonts.filter((e) => e.role === 'latin');
  const alias = latin.some((e) => e.alias === family) ? family : 'Noto Serif';
  const weight = bold ? 700 : 400;
  const style = italic ? 'italic' : 'normal';
  return (
    latin.find((e) => e.alias === alias && e.weight === weight && e.style === style) ??
    latin.find((e) => e.alias === alias && e.weight === weight) ??
    latin.find((e) => e.alias === alias)!
  );
}

/** A stable key for a face: its file. */
export const faceKey = (e: FontManifestEntry): string => e.file;

/**
 * The face a kernel uses for a font key whose family is a manifest alias (any role), with the
 * nearest weight and style; other families go through `faceFor`.
 */
export function resolveFace(font: {
  family: string;
  bold: boolean;
  italic: boolean;
}): FontManifestEntry {
  const same = fontManifest.fonts.filter((e) => e.alias === font.family);
  if (same.length === 0) return faceFor(font.family, font.bold, font.italic);
  const weight = font.bold ? 700 : 400;
  const style = font.italic ? 'italic' : 'normal';
  return (
    same.find((e) => e.weight === weight && e.style === style) ??
    same.find((e) => e.weight === weight) ??
    same[0]!
  );
}
