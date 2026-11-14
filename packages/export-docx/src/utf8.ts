/**
 * Strict UTF-8 decoding (RFC 3629). The universal packages may use TextEncoder but not
 * TextDecoder (FND-004), and a strict decoder also lets the importer refuse malformed parts
 * instead of silently replacing bytes.
 */
export class Utf8Error extends Error {
  override name = 'Utf8Error';
}

export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  let chunk: number[] = [];
  let i = start;
  while (i < end) {
    const b = bytes[i]!;
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if (b >= 0xc2 && b <= 0xdf) {
      const b1 = bytes[i + 1]!;
      if (i + 1 >= end || (b1 & 0xc0) !== 0x80) throw new Utf8Error(`invalid UTF-8 at byte ${i}`);
      cp = ((b & 0x1f) << 6) | (b1 & 0x3f);
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      if (i + 2 >= end || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80)
        throw new Utf8Error(`invalid UTF-8 at byte ${i}`);
      cp = ((b & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))
        throw new Utf8Error(`invalid UTF-8 at byte ${i}`);
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      if (i + 3 >= end || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80)
        throw new Utf8Error(`invalid UTF-8 at byte ${i}`);
      cp = ((b & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) throw new Utf8Error(`invalid UTF-8 at byte ${i}`);
      i += 4;
    } else throw new Utf8Error(`invalid UTF-8 at byte ${i}`);
    if (cp > 0xffff) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length > 4096) {
      out += String.fromCharCode(...chunk);
      chunk = [];
    }
  }
  return chunk.length ? out + String.fromCharCode(...chunk) : out;
}
