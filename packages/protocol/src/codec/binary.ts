/**
 * Binary frames (05 §4; PRO-020 groundwork): three unsigned LEB128 integers (`ch`, `kind`, `id`)
 * followed by the payload. Reserved for engines with opaque payloads; `pm-steps/1` does not use
 * them. The meaning of `kind` and `id` is not defined (G15).
 */

export interface BinaryFrame {
  ch: number;
  kind: number;
  id: number;
  payload: Uint8Array;
}

function leb128(value: number, out: number[]): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`not an unsigned safe integer: ${value}`);
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
}

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const head: number[] = [];
  leb128(frame.ch, head);
  leb128(frame.kind, head);
  leb128(frame.id, head);
  const out = new Uint8Array(head.length + frame.payload.length);
  out.set(head, 0);
  out.set(frame.payload, head.length);
  return out;
}

/** Decodes a binary frame; null when the header is truncated or overlong. */
export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  let pos = 0;
  const read = (): number | null => {
    let value = 0;
    let scale = 1;
    for (let k = 0; k < 8; k++) {
      if (pos >= bytes.length) return null;
      const b = bytes[pos++]!;
      value += (b & 0x7f) * scale;
      if (!Number.isSafeInteger(value)) return null;
      if ((b & 0x80) === 0) return value;
      scale *= 128;
    }
    return null;
  };
  const ch = read();
  const kind = ch === null ? null : read();
  const id = kind === null ? null : read();
  if (ch === null || kind === null || id === null) return null;
  return { ch, kind, id, payload: bytes.slice(pos) };
}
