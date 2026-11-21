/**
 * The export preflight in the editor (EXP-003 criteria 2 and 3; 09 §1): before an export job is
 * created, the editor runs the same check as the converter, on the document it holds, and the
 * export dialog lists what it found. One implementation: `preflight()` of `@docedit/export-latex`,
 * the function the converter itself calls (`convert.ts`), loaded on first use so that it is not
 * part of the first download.
 *
 * Inputs, so that the two runs agree:
 *
 * - The document is the core's `getContent()`: the reader's projection (ADR 0019), which is also
 *   what an export of this reader is made from (EXP-123).
 * - The fonts are the font set the compile worker uses, as the service publishes it at `GET /fonts`
 *   (02 §6; 05 §6.2). `converterFonts` puts that body back into the converter's manifest shape:
 *   families of four faces, the math face, the fallback faces and the default family. A face's
 *   character coverage is taken when the service publishes it, which it does when the font set's
 *   own manifest records it. Without coverage the preflight makes no character check, in the editor
 *   as in the converter.
 *
 * Limits. A font set whose manifest has an empty fallback list reads here as one without a list,
 * for which the math face is the fallback; the published body does not tell the two apart. A body
 * without a math face gives no fonts at all, so that a character is never flagged for want of a
 * fallback the converter has.
 *
 * Only the targets the LaTeX converter writes are checked (`pdf` and `tex`). No DOM: this runs in
 * Node.js tests.
 */
// A type only: the check itself is loaded by `loadShared` below, on first use.
import type { preflight as sharedPreflight } from '@docedit/export-latex/preflight';
import type { ExportDiagnostic } from '@docedit/ui';

type Preflight = typeof sharedPreflight;

/** The converter's font manifest (09 §5), as the shared preflight takes it. */
export type ConverterFonts = NonNullable<Parameters<Preflight>[1]>;
type ConverterFace = ConverterFonts['families'][number]['regular'];

/** The targets whose job runs the converter, and so this check (09 §1). */
export const PREFLIGHT_TARGETS: readonly string[] = ['pdf', 'tex'];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const STYLES = ['regular', 'bold', 'italic', 'boldItalic'] as const;
type Style = (typeof STYLES)[number];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sorted inclusive ranges of code points, or nothing when the value is anything else. */
function coverageOf(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<[number, number]> = [];
  for (const r of value) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const lo: unknown = r[0];
    const hi: unknown = r[1];
    if (typeof lo !== 'number' || typeof hi !== 'number') return null;
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || lo > hi) return null;
    out.push([lo, hi]);
  }
  return out;
}

/** Which of the four faces a published face is: its `style`, else its weight and slant. */
function styleOf(face: Record<string, unknown>): Style | null {
  const style = face['style'];
  if (typeof style === 'string' && (STYLES as readonly string[]).includes(style))
    return style as Style;
  const weight = Number(face['weight']);
  if (weight !== 400 && weight !== 700) return null;
  const italic = face['italic'] === true;
  return weight === 700 ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';
}

function faceOf(face: Record<string, unknown>): ConverterFace | null {
  const sha256 = face['sha256'];
  const url = face['url'];
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256) || typeof url !== 'string')
    return null;
  // The converter names a face by its file, `<sha256>.<ext>`: the last segment of the published URL.
  const file = url.slice(url.lastIndexOf('/') + 1).replace(/[?#].*$/, '');
  const coverage = coverageOf(face['coverage']);
  return { file, sha256, ...(coverage ? { coverage } : {}) };
}

/**
 * The converter's manifest of the font set a `GET /fonts` body publishes; null when the body is
 * not one, or names no text family or no math face.
 */
export function converterFonts(manifest: unknown): ConverterFonts | null {
  if (!isObject(manifest) || !Array.isArray(manifest['families'])) return null;
  const families: ConverterFonts['families'] = [];
  const fallback: NonNullable<ConverterFonts['fallback']> = [];
  let math: ConverterFonts['math'] | null = null;
  for (const family of manifest['families']) {
    if (!isObject(family) || !Array.isArray(family['faces'])) continue;
    const name = family['family'];
    if (typeof name !== 'string' || name === '') continue;
    const licence = typeof family['licence'] === 'string' ? family['licence'] : '';
    const faces = new Map<Style, ConverterFace>();
    for (const published of family['faces']) {
      if (!isObject(published)) continue;
      const style = styleOf(published);
      const face = faceOf(published);
      if (style && face && !faces.has(style)) faces.set(style, face);
    }
    const regular = faces.get('regular');
    const role = family['role'];
    if (role === 'math') {
      if (regular && math === null) math = { ...regular, name, licence };
    } else if (role === 'fallback') {
      if (regular) fallback.push({ ...regular, name, licence });
    } else {
      const bold = faces.get('bold');
      const italic = faces.get('italic');
      const boldItalic = faces.get('boldItalic');
      if (!regular || !bold || !italic || !boldItalic) continue;
      families.push({
        name,
        lineHeight: typeof family['lineHeight'] === 'number' ? family['lineHeight'] : 0,
        regular,
        bold,
        italic,
        boldItalic,
        licence,
      });
    }
  }
  if (families.length === 0 || math === null) return null;
  const named = manifest['defaultFamily'];
  return {
    version: 1,
    families,
    math,
    // A default the set does not hold names no family, here as in the converter's own manifest.
    defaultFamily: typeof named === 'string' ? named : '',
    ...(fallback.length > 0 ? { fallback } : {}),
  };
}

export interface PreflightInput {
  /** The document as the core holds it now (a CDM envelope); null when none is loaded. */
  content(): unknown;
  /** The body of `GET /fonts`; absent when the backend has no fonts port. */
  fonts?(): Promise<unknown>;
  /** The shared check; the default loads `@docedit/export-latex/preflight` on first use. */
  load?(): Promise<Preflight>;
}

const loadShared = async (): Promise<Preflight> =>
  (await import('@docedit/export-latex/preflight')).preflight;

/**
 * The warnings of the shared preflight for an export of `target`, as the dialog lists them. The
 * severity is the one the job gives the same finding: a character no font covers is an error of a
 * final export and a warning of a preview (09 §3.2); everything else is a warning. A document or a
 * font manifest that cannot be read gives no warning rather than a wrong one.
 */
export async function exportPreflight(
  target: string,
  options: { readonly profile?: string } | undefined,
  input: PreflightInput,
): Promise<ExportDiagnostic[]> {
  if (!PREFLIGHT_TARGETS.includes(target)) return [];
  const content = input.content();
  if (!isObject(content) || !isObject(content['doc'])) return [];
  let fonts: ConverterFonts | null = null;
  if (input.fonts) {
    try {
      fonts = converterFonts(await input.fonts());
    } catch {
      fonts = null;
    }
  }
  const preflight = await (input.load ?? loadShared)();
  // A job is a final export unless its request says `preview` (09 §9.1).
  const final = options?.profile !== 'preview';
  return preflight(content as unknown as Parameters<Preflight>[0], fonts ?? undefined).map((w) => ({
    severity: w.code === 'glyph_missing' && final ? 'error' : 'warning',
    code: w.code,
    blockId: w.blockId,
    message: w.message,
  }));
}
