/**
 * SEC-028 criterion 5 (authority fuzz targets). A fuzz input that runs longer than its time limit
 * fails the property and is stored as JSON under `storeDir`, so that it can be replayed as a
 * regression case. The limit is a budget for one input, not a measured target (no value is given
 * by the spec; ADR 0121, item 39). Test helper only: it is outside the universal source.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** JSON that keeps non-finite numbers, which JSON.stringify would turn into null. */
const replacer = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && !Number.isFinite(v) ? `${v}` : v;

/**
 * Throws, after storing the input, when `elapsedMs` exceeds `limitMs`. Returns normally otherwise.
 */
export function storeIfSlow(
  target: string,
  input: unknown,
  elapsedMs: number,
  opts: { limitMs: number; storeDir: string },
): void {
  if (elapsedMs <= opts.limitMs) return;
  const body = JSON.stringify({ target, limitMs: opts.limitMs, elapsedMs, input }, replacer, 2);
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  mkdirSync(opts.storeDir, { recursive: true });
  const file = join(opts.storeDir, `${target}-${digest}.json`);
  writeFileSync(file, body);
  throw new Error(
    `${target} took ${elapsedMs.toFixed(1)} ms on one input (limit ${opts.limitMs} ms); input stored at ${file}`,
  );
}
