/**
 * Reads the `packages:` sections of pnpm-lock.yaml (lockfile version 9): each resolved package's
 * name, version and integrity. pnpm 12 writes two YAML documents into the file (its own
 * installation, then the workspace); both are read. The format is regular enough for a line reader,
 * and the root workspace has no YAML parser among its dependencies.
 */
import { createHash } from 'node:crypto';

export interface LockedPackage {
  name: string;
  version: string;
  integrity: string | null;
}

/** `name@version` keys, so `@scope/name@1.2.3` is one key. */
export function lockKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/** `name@version`, with any peer-dependency suffix (`(…)`, as in snapshots) dropped. */
export function splitKey(key: string): { name: string; version: string } | null {
  const base = key.replace(/\(.*$/, '');
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  const version = base.slice(at + 1);
  return version ? { name: base.slice(0, at), version } : null;
}

export function parseLockfile(text: string): Map<string, LockedPackage> {
  const out = new Map<string, LockedPackage>();
  let inPackages = false;
  let current: LockedPackage | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '---' || /^[^\s#]/.test(raw)) {
      inPackages = raw.trimEnd() === 'packages:';
      current = null;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'"][^:]*)):\s*(\{\})?\s*$/.exec(raw);
    if (entry) {
      const parts = splitKey(entry[1] ?? entry[2] ?? entry[3] ?? '');
      current = parts ? { ...parts, integrity: null } : null;
      if (current) out.set(lockKey(current.name, current.version), current);
      continue;
    }
    const resolution = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(raw);
    if (resolution && current) {
      const integrity = /(?:^|,)\s*integrity:\s*([^,\s}]+)/.exec(resolution[1] ?? '');
      current.integrity = integrity?.[1] ?? null;
    }
  }
  return out;
}

const ALGORITHMS = { sha1: 'SHA1', sha256: 'SHA256', sha384: 'SHA384', sha512: 'SHA512' } as const;
export type ChecksumAlgorithm = (typeof ALGORITHMS)[keyof typeof ALGORITHMS];

/** A Subresource Integrity string (`sha512-<base64>`) as an algorithm and hexadecimal digest. */
export function integrityToHex(
  integrity: string,
): { algorithm: ChecksumAlgorithm; hex: string } | null {
  const m = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  if (!m) return null;
  const hex = Buffer.from(m[2]!, 'base64').toString('hex');
  const bytes = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }[m[1] as keyof typeof ALGORITHMS];
  return hex.length === bytes * 2
    ? { algorithm: ALGORITHMS[m[1] as keyof typeof ALGORITHMS], hex }
    : null;
}

/** The integrity string of a file's bytes, as npm and pnpm write it. */
export function integrityOf(data: Uint8Array): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}
