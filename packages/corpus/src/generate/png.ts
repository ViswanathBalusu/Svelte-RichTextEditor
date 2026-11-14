/**
 * A minimal PNG encoder for the corpus images (FND-006). The image data is stored in uncompressed
 * deflate blocks, so the bytes depend on nothing but the pixels: no compression library, no
 * library version, the same output on every platform. The images are tiny, so size does not matter.
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

class ByteWriter {
  readonly #parts: Uint8Array[] = [];
  #length = 0;

  bytes(data: Uint8Array | readonly number[]): void {
    const part = data instanceof Uint8Array ? data : Uint8Array.from(data);
    this.#parts.push(part);
    this.#length += part.length;
  }

  uint32(value: number): void {
    this.bytes([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }

  ascii(text: string): void {
    this.bytes(Array.from(text, (ch) => ch.charCodeAt(0)));
  }

  result(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const part of this.#parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function chunk(w: ByteWriter, type: string, data: Uint8Array): void {
  const body = new ByteWriter();
  body.ascii(type);
  body.bytes(data);
  const typed = body.result();
  w.uint32(data.length);
  w.bytes(typed);
  w.uint32(crc32(typed, 0, typed.length));
}

/** A zlib stream (RFC 1950) holding the data in stored deflate blocks (RFC 1951 §3.2.4). */
function zlibStored(data: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.bytes([0x78, 0x01]);
  const max = 65535;
  let offset = 0;
  do {
    const len = Math.min(max, data.length - offset);
    const final = offset + len >= data.length ? 1 : 0;
    w.bytes([final, len & 0xff, (len >>> 8) & 0xff, ~len & 0xff, (~len >>> 8) & 0xff]);
    w.bytes(data.subarray(offset, offset + len));
    offset += len;
  } while (offset < data.length);
  w.uint32(adler32(data));
  return w.result();
}

export interface Raster {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: 3 | 4;
  /** Row-major samples, `width * height * channels` bytes. */
  pixels: Uint8Array;
}

/** Encodes 8-bit RGB or RGBA pixels as a PNG file. */
export function encodePng(r: Raster): Uint8Array {
  const { width, height, channels, pixels } = r;
  if (pixels.length !== width * height * channels)
    throw new RangeError(`encodePng: expected ${width * height * channels} samples`);
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const w = new ByteWriter();
  w.bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new ByteWriter();
  ihdr.uint32(width);
  ihdr.uint32(height);
  ihdr.bytes([8, channels === 4 ? 6 : 2, 0, 0, 0]);
  chunk(w, 'IHDR', ihdr.result());
  chunk(w, 'IDAT', zlibStored(raw));
  chunk(w, 'IEND', new Uint8Array(0));
  return w.result();
}
