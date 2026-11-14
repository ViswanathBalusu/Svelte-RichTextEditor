/**
 * A minimal POSIX ustar writer and a bounded reader (spike S4). Bundles go into the sandbox as a
 * tar on standard input and results come out as a tar on standard output, so the sandbox needs no
 * host path mounted at all. The reader treats its input as hostile (09 §9.3 item 7): it accepts
 * only regular files with plain names from an allow-list, and stops at a size limit.
 */

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const put = (offset: number, text: string): void => {
    h.set(enc.encode(text), offset);
  };
  if (enc.encode(name).length > 100) throw new RangeError(`tar: name too long: ${name}`);
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(mtime, 12));
  put(148, '        ');
  put(156, '0');
  put(257, 'ustar\u000000');
  let sum = 0;
  for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

/** Names a bundle may hold: plain names, and assets named by hash in `assets/` (09 §2). */
const NAME = /^(assets\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** A tar archive of the given files, in the given order, with a fixed modification time. */
export function writeTar(
  files: ReadonlyArray<readonly [string, Uint8Array]>,
  mtime = 0,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const [name, data] of files) {
    if (!NAME.test(name) || name.includes('..')) throw new RangeError(`tar: refused name ${name}`);
    const h = header(name, data.length, mtime);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    parts.push(h, data, new Uint8Array(pad));
    total += BLOCK + data.length + pad;
  }
  parts.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ReadLimits {
  /** Names that may appear; anything else is skipped. */
  allow: ReadonlySet<string>;
  /** Largest size of one file. */
  maxFileBytes: number;
}

function field(h: Uint8Array, offset: number, length: number): string {
  const slice = h.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
}

/** Reads regular files from a ustar archive. Unknown, oversized or odd entries are dropped. */
export function readTar(data: Uint8Array, limits: ReadLimits): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let o = 0;
  while (o + BLOCK <= data.length) {
    const h = data.subarray(o, o + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = field(h, 0, 100);
    const sizeText = field(h, 124, 12).trim();
    const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : -1;
    const type = String.fromCharCode(h[156] ?? 0);
    if (size < 0) break;
    const start = o + BLOCK;
    const end = start + size;
    if (end > data.length) break;
    const regular = type === '0' || type === '\0';
    if (regular && limits.allow.has(name) && size <= limits.maxFileBytes)
      files.set(name, data.slice(start, end));
    o = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
