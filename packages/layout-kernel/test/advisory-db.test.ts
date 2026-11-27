/** WASM-013: the folder name that cargo-deny gives the RustSec database, and the hash behind it. */
import { describe, expect, it } from 'vitest';
import { ADVISORY_DB_URL, advisoryDbFolder, xxh64 } from '../scripts/advisory-db.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const hex = (n: bigint) => n.toString(16).padStart(16, '0');

describe('xxh64', () => {
  it('matches the reference values of XXH64 (seed 0)', () => {
    expect(hex(xxh64(bytes('')))).toBe('ef46db3751d8e999');
    expect(hex(xxh64(bytes('a')))).toBe('d24ec4f1a98c6e5b');
    expect(hex(xxh64(bytes('abc')))).toBe('44bc2cf5ad770999');
  });

  it('is deterministic, depends on the seed, and covers inputs of every length class', () => {
    for (const n of [0, 1, 3, 4, 7, 8, 9, 31, 32, 33, 64, 100]) {
      const input = bytes('x'.repeat(n));
      expect(xxh64(input, 5n)).toBe(xxh64(input.slice(), 5n));
      expect(xxh64(input, 5n)).not.toBe(xxh64(input, 6n));
    }
  });
});

describe('advisoryDbFolder', () => {
  it('names the folder as cargo-deny does: last path segment, then the hash of the URL', () => {
    const name = advisoryDbFolder(ADVISORY_DB_URL);
    expect(name).toMatch(/^advisory-db-[0-9a-f]{16}$/);
    // Letter case in the URL does not change the folder.
    expect(advisoryDbFolder('https://GitHub.com/RustSec/Advisory-DB')).toBe(name);
    expect(advisoryDbFolder('https://github.com/other/advisory-db')).not.toBe(name);
  });
});
