/**
 * The RustSec advisory database for cargo-deny (WASM-013; owner decision 281).
 *
 * cargo-deny fetches the database with the `git` command, and the builder image has none (it is not
 * one of the downloads the owner approved). So `build.ts` fetches the database on the host, on each
 * run, and mounts it where cargo-deny looks: `$CARGO_HOME/advisory-dbs/<name>-<hash>`. The name and
 * the hash are cargo-deny's own scheme (`url_to_db_path` in cargo-deny 0.21.0): the last segment of
 * the lower-cased URL, and the 64-bit xxHash of the whole URL with the seed 0xca80de71.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const ADVISORY_DB_URL = 'https://github.com/rustsec/advisory-db';
const SEED = 0xca80de71n;
const MASK = 0xffffffffffffffffn;

const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK;
const round = (acc: bigint, input: bigint): bigint =>
  (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;
const mergeRound = (acc: bigint, value: bigint): bigint =>
  ((((acc ^ round(0n, value)) * P1) & MASK) + P4) & MASK;

/** XXH64 of the bytes, as the reference implementation and the `twox-hash` crate compute it. */
export function xxh64(data: Uint8Array, seed: bigint = 0n): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (i: number) => view.getBigUint64(i, true);
  const len = data.length;
  let i = 0;
  let h: bigint;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & MASK;
    let v2 = (seed + P2) & MASK;
    let v3 = seed;
    let v4 = (seed - P1) & MASK;
    for (; i <= len - 32; i += 32) {
      v1 = round(v1, u64(i));
      v2 = round(v2, u64(i + 8));
      v3 = round(v3, u64(i + 16));
      v4 = round(v4, u64(i + 24));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + P5) & MASK;
  }
  h = (h + BigInt(len)) & MASK;
  for (; i <= len - 8; i += 8) h = (((rotl(h ^ round(0n, u64(i)), 27n) * P1) & MASK) + P4) & MASK;
  if (i <= len - 4) {
    h =
      (((rotl(h ^ ((BigInt(view.getUint32(i, true)) * P1) & MASK), 23n) * P2) & MASK) + P3) & MASK;
    i += 4;
  }
  for (; i < len; i++) h = (rotl(h ^ ((BigInt(data[i]!) * P5) & MASK), 11n) * P1) & MASK;
  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  h ^= h >> 32n;
  return h;
}

/** The folder name cargo-deny gives a database URL inside its `advisory-dbs` folder. */
export function advisoryDbFolder(url: string = ADVISORY_DB_URL): string {
  const lower = new URL(url.toLowerCase());
  const name = lower.pathname.split('/').filter(Boolean).at(-1) ?? 'empty_';
  const hash = xxh64(new TextEncoder().encode(lower.href), SEED);
  return `${name}-${hash.toString(16).padStart(16, '0')}`;
}

function git(args: string[], cwd?: string): void {
  const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed with ${r.status}`);
}

/**
 * Clones the database into `<root>/<folder>` on the first call and brings it to the head of its
 * `main` branch on every later one. The fetch writes FETCH_HEAD, whose time cargo-deny reads as the
 * time of the last update. Returns `root`, the folder to mount as `advisory-dbs`.
 */
export function fetchAdvisoryDb(root: string, url: string = ADVISORY_DB_URL): string {
  const repo = join(root, advisoryDbFolder(url));
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(root, { recursive: true });
    git(['clone', '--quiet', '--depth', '1', '--branch', 'main', url, repo]);
  }
  git(['fetch', '--quiet', '--depth', '1', 'origin', 'main'], repo);
  git(['reset', '--quiet', '--hard', 'FETCH_HEAD'], repo);
  return root;
}
