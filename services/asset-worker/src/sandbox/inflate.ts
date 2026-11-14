/**
 * Bounded inflation (SEC-038): decompresses a zlib or raw deflate stream without keeping its
 * output, counting bytes and computing a CRC-32, and stops as soon as the output passes `cap`. A
 * decompression bomb therefore costs at most `cap` bytes of work and a few chunks of memory.
 */
import { crc32, createInflate, createInflateRaw } from 'node:zlib';

export interface InflateScan {
  /** Bytes the stream inflates to (at most `cap + 1`: one more than the cap means "over"). */
  length: number;
  /** Whether the output went past `cap`; inflation stopped there. */
  over: boolean;
  /** CRC-32 of the output, when the whole stream was read and `crc` was asked for. */
  crc: number;
  /** The first `head` bytes of the output. */
  head: Uint8Array;
  /** The stream ended properly (not cut short). */
  complete: boolean;
}

export interface InflateOptions {
  /** Raw deflate (ZIP entries) instead of zlib (PNG). */
  raw: boolean;
  /** Most output bytes to accept. */
  cap: number;
  /** Compute the CRC-32 of the output. */
  crc?: boolean;
  /** Keep this many leading output bytes. */
  head?: number;
}

const CHUNK = 64 * 1024;

export function scanInflate(data: Uint8Array, opts: InflateOptions): Promise<InflateScan> {
  return new Promise((resolve) => {
    const z = (opts.raw ? createInflateRaw : createInflate)({ chunkSize: CHUNK });
    const headWanted = opts.head ?? 0;
    const head = new Uint8Array(headWanted);
    let headFill = 0;
    let length = 0;
    let crc = 0;
    let settled = false;
    const finish = (r: Omit<InflateScan, 'head' | 'crc'>): void => {
      if (settled) return;
      settled = true;
      z.removeAllListeners('data');
      z.destroy();
      resolve({ ...r, crc, head: head.subarray(0, headFill) });
    };
    z.on('data', (chunk: Buffer) => {
      if (headFill < headWanted) {
        const n = Math.min(headWanted - headFill, chunk.length);
        head.set(chunk.subarray(0, n), headFill);
        headFill += n;
      }
      length += chunk.length;
      if (length > opts.cap) {
        finish({ length: opts.cap + 1, over: true, complete: false });
        return;
      }
      if (opts.crc) crc = crc32(chunk, crc);
    });
    z.on('end', () => finish({ length, over: false, complete: true }));
    // A stream cut short (Z_BUF_ERROR) and a corrupt one are both reported as incomplete.
    z.on('error', () => finish({ length, over: false, complete: false }));
    // Feed in slices so that a stop at the cap does not first queue the whole input.
    let o = 0;
    const pump = (): void => {
      while (!settled && o < data.length) {
        const end = Math.min(data.length, o + CHUNK);
        const ok = z.write(data.subarray(o, end));
        o = end;
        if (!ok) {
          z.once('drain', pump);
          return;
        }
      }
      if (!settled && o >= data.length) z.end();
    };
    pump();
  });
}
