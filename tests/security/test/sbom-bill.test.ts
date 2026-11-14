/**
 * SEC-051 criterion 2, the lock-file half (10 §3.8; ADR 0044): the software bill of materials of a
 * release matches the lock file. Each third-party npm package the bill lists with a SHA-512 checksum
 * must be a `name@version` of `pnpm-lock.yaml` whose integrity is that same checksum; a third-party
 * package with no checksum is reported. Workspace (`@docedit/`) packages are not compared. Each bill
 * attached to a release must also hash to its entry in `SHA256SUMS`.
 *
 * Not covered here: the container images (criterion 1 and the image half of criterion 2). No image
 * is built in this environment, so the bill is compared with the lock files only. The tests read the
 * last dry run under `dist/release`; they skip when there is none.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface SpdxPackage {
  name: string;
  versionInfo?: string;
  checksums?: Array<{ algorithm: string; checksumValue: string }>;
}
interface Bill {
  packages: SpdxPackage[];
}

/** `name@version` to the set of integrity strings the lock file gives it. */
export function lockIntegrity(lockText: string): Map<string, Set<string>> {
  const lines = lockText.split(/\r?\n/);
  const out = new Map<string, Set<string>>();
  const key = /^ {2}'?((?:@[^/\s']+\/)?[^@\s']+@[^':\s]+)'?:\s*$/;
  const integrity = /integrity: (sha512-[A-Za-z0-9+/=]+)/;
  lines.forEach((line, i) => {
    const m = key.exec(line);
    if (!m) return;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const hit = integrity.exec(lines[j]!);
      if (hit) {
        const set = out.get(m[1]!) ?? new Set<string>();
        set.add(hit[1]!);
        out.set(m[1]!, set);
        break;
      }
      if (key.test(lines[j]!)) break;
    }
  });
  return out;
}

/** The problems of a bill against the lock file; an empty list means the bill matches. */
export function billMismatches(bill: Bill, lock: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  for (const p of bill.packages) {
    if (!p.versionInfo) continue;
    // Workspace packages (and the artefact's own entry) are not lock-file packages: pnpm lists them
    // under importers, and a packed artefact carries the checksum of its tarball, not of a lock entry.
    if (p.name.startsWith('@docedit/')) continue;
    const sha512 = p.checksums?.find((c) => c.algorithm === 'SHA512');
    if (!sha512) {
      problems.push(`${p.name}@${p.versionInfo}: no checksum and not a workspace package`);
      continue;
    }
    const want = `sha512-${Buffer.from(sha512.checksumValue, 'hex').toString('base64')}`;
    const id = `${p.name}@${p.versionInfo}`;
    const have = lock.get(id);
    if (!have) problems.push(`${id}: not in the lock file`);
    else if (!have.has(want)) problems.push(`${id}: the checksum differs from the lock file`);
  }
  return problems;
}

function findDryRun(): string | null {
  const rel = join(ROOT, 'dist', 'release');
  if (!existsSync(rel)) return null;
  for (const d of readdirSync(rel)) {
    const dir = join(rel, d, 'artefacts');
    if (existsSync(join(dir, 'SHA256SUMS'))) return dir;
  }
  return null;
}

const dir = findDryRun();
const lockText = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const lock = lockIntegrity(lockText);

describe('SEC-051 the release bill matches the lock files (criterion 2, lock half)', () => {
  it('the lock parser reads the integrity of a known package', () => {
    expect(lock.size).toBeGreaterThan(100);
    const sample = lock.get('pnpm@12.18.0');
    expect(sample?.size ?? 0).toBeGreaterThan(0);
  });

  it('a bill whose checksum or version differs from the lock file is reported', () => {
    const bill: Bill = {
      packages: [
        {
          name: 'pnpm',
          versionInfo: '12.18.0',
          checksums: [{ algorithm: 'SHA512', checksumValue: '00'.repeat(64) }],
        },
        {
          name: 'no-such-package',
          versionInfo: '9.9.9',
          checksums: [{ algorithm: 'SHA512', checksumValue: 'ab' }],
        },
        { name: 'unchecked', versionInfo: '1.0.0' },
        {
          name: '@docedit/workspace',
          versionInfo: '0.0.0',
          checksums: [{ algorithm: 'SHA512', checksumValue: 'cd' }],
        },
      ],
    };
    const problems = billMismatches(bill, lock);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/pnpm@12\.18\.0: the checksum differs/);
    expect(problems.join('\n')).toMatch(/no-such-package@9\.9\.9: not in the lock file/);
    expect(problems.join('\n')).toMatch(/unchecked@1\.0\.0: no checksum/);
  });

  (dir ? it : it.skip)('every release bill matches the lock file', () => {
    const bills = readdirSync(dir!).filter((f) => f.endsWith('.spdx.json'));
    expect(bills.length).toBeGreaterThan(0);
    for (const f of bills) {
      const bill = JSON.parse(readFileSync(join(dir!, f), 'utf8')) as Bill;
      expect(billMismatches(bill, lock), f).toEqual([]);
    }
  });

  (dir ? it : it.skip)('every release bill is listed in SHA256SUMS with its hash', () => {
    const sums = readFileSync(join(dir!, 'SHA256SUMS'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [hash, name] = l.split(/\s+/, 2);
        return { hash: hash!, name: name! };
      });
    const bills = readdirSync(dir!).filter((f) => f.endsWith('.spdx.json'));
    expect(bills.length).toBeGreaterThan(0);
    for (const f of bills) {
      const entry = sums.find((s) => s.name === f);
      expect(entry, `${f} is listed`).toBeDefined();
      const hash = createHash('sha256')
        .update(readFileSync(join(dir!, f)))
        .digest('hex');
      expect(hash, f).toBe(entry!.hash);
    }
  });
});
