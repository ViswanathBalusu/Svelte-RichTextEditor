/**
 * The types the worker accepts, how a declared MIME type is normalised, and how the real type is
 * detected from the bytes (06 §4.4: "checks the real type against the declared one"; 10 §3.5).
 * The accepted set is a proposal of ADR 0043: the spec names no formats.
 */

export const PNG = 'image/png';
export const JPEG = 'image/jpeg';
export const GIF = 'image/gif';
export const SVG = 'image/svg+xml';
export const PDF = 'application/pdf';
export const ZIP = 'application/zip';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What an upload may be. */
export const ACCEPTED_TYPES = [PNG, JPEG, GIF, SVG, DOCX] as const;
export type AcceptedType = (typeof ACCEPTED_TYPES)[number];

/** What an output of the sandbox may be. */
export const OUTPUT_TYPES = [PNG, JPEG, GIF, SVG, PDF] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

export function isAcceptedType(t: string): t is AcceptedType {
  return (ACCEPTED_TYPES as readonly string[]).includes(t);
}

export function isOutputType(t: string): t is OutputType {
  return (OUTPUT_TYPES as readonly string[]).includes(t);
}

/** Aliases some clients send; anything else must be written exactly. */
const ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': JPEG,
  'image/pjpeg': JPEG,
  'image/x-png': PNG,
};

/** The canonical form of a declared MIME type: lower case, without parameters, aliases resolved. */
export function normaliseMime(declared: string): string {
  const base = declared.split(';', 1)[0]!.trim().toLowerCase();
  return ALIASES[base] ?? base;
}

/** The kind of an accepted type, which picks the byte limit and the processing. */
export function kindOf(t: AcceptedType): 'raster' | 'svg' | 'docx' {
  return t === SVG ? 'svg' : t === DOCX ? 'docx' : 'raster';
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * The type of `bytes` from their leading bytes. ZIP archives are reported as `application/zip`;
 * whether one is a Word file is decided by reading its directory (zip.ts). Text is reported as SVG
 * only when its first element is `<svg`. Formats the worker refuses are still named, so that the
 * failure says what the file was.
 */
export function detectType(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return GIF;
  if (
    startsWith(bytes, ascii('PK')) &&
    (bytes[2] === 3 || bytes[2] === 5) &&
    bytes[3] === bytes[2]! + 1
  )
    return ZIP;
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return PDF;
  if (startsWith(bytes, ascii('BM'))) return 'image/bmp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/vnd.microsoft.icon';
  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(heic|heix|mif1|msf1|hevc)$/.test(brand)) return 'image/heic';
    return 'video/mp4';
  }
  if (looksLikeSvg(bytes)) return SVG;
  return 'application/octet-stream';
}

/** Whether the first element of the text is `svg` (after a BOM, the XML declaration, comments). */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 64 * 1024));
  } catch {
    // A cut through a multi-byte character at the 64 KiB boundary is not an error here; svg.ts
    // decodes the whole file strictly.
    if (bytes.length <= 64 * 1024) return false;
    text = new TextDecoder('utf-8').decode(bytes.subarray(0, 64 * 1024));
  }
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let guard = 0; guard < 10_000; guard++) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (text.startsWith('<!DOCTYPE', i)) {
      // Skipped only to find the root; svg.ts refuses any document type declaration.
      let depth = 0;
      let j = i + 9;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= text.length) return false;
      i = j + 1;
    } else break;
  }
  return /^<svg[\s>/]/.test(text.slice(i, i + 5));
}
