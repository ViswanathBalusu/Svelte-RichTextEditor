/**
 * The picture a signature or initials field prints (EXP-034 criterion 1). The field's width is
 * fixed; the height follows the image's own proportions, so the converter needs the pixel size of
 * the asset. The size is read from the bytes of a PNG (its IHDR chunk). An asset whose bytes the job
 * did not supply has no size here, and the caller keeps the blank field with its diagnostic.
 *
 * Universal code: no Node.js or browser API (FND-004).
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export interface PixelSize {
  readonly w: number;
  readonly h: number;
}

/** The width and height in pixels of a PNG, or null when the bytes are not a PNG with an IHDR chunk. */
export function pngPixelSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  // The first chunk must be IHDR: its length (4 bytes), its type, then width and height (4 bytes each).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
    return null;
  const u32 = (at: number): number =>
    ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
  const w = u32(16);
  const h = u32(20);
  if (w < 1 || h < 1) return null;
  return { w, h };
}

/**
 * The height, in twips, of a picture drawn at `widthTwips` with the proportions of `size`. At least
 * one twip, and rounded to the nearest twip.
 */
export function heightForWidth(widthTwips: number, size: PixelSize): number {
  return Math.max(1, Math.round((widthTwips * size.h) / size.w));
}

/**
 * The width and height in pixels of a JPEG, read from its start-of-frame segment (SOF0 to SOF15, except
 * DHT, JPG and DAC), or null when the bytes are not a JPEG with such a segment.
 */
export function jpegPixelSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = (bytes[at + 2]! << 8) + bytes[at + 3]!;
    if (length < 2) return null;
    if (isSof) {
      if (at + 9 > bytes.length) return null;
      const h = (bytes[at + 5]! << 8) + bytes[at + 6]!;
      const w = (bytes[at + 7]! << 8) + bytes[at + 8]!;
      return w < 1 || h < 1 ? null : { w, h };
    }
    at += 2 + length;
  }
  return null;
}

/** The pixel size of an image by its media type (PNG or JPEG), or null when it is neither or unreadable. */
export function imagePixelSize(bytes: Uint8Array, mediaType: string): PixelSize | null {
  if (mediaType === 'image/png') return pngPixelSize(bytes);
  if (mediaType === 'image/jpeg') return jpegPixelSize(bytes);
  return null;
}
