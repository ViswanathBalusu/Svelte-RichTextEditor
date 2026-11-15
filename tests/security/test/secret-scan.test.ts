/**
 * SEC-048 criterion 1 (10 §3.7): the repository holds no secret. This is the scan the story asks
 * for, run as a test over the working tree. It is not the CI scan: the story is not ticked for
 * criterion 1 until a secret scanner runs in `.github` (a root configuration this lane does not
 * edit). The patterns are high-confidence token formats only, so a match is a finding to read,
 * not a guess.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.pnpm-store',
  '.turbo',
  // Worktrees of the parallel story lanes: each is a second copy of this tree, scanned on its own.
  '.worktrees',
]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|wasm|bin|sqlite|db)$/i;
const MAX_BYTES = 1_000_000;

/** High-confidence secret formats. Each entry names what it finds. */
export const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe live key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

/** Files whose matches are test data, each with the reason. Empty unless a finding is reviewed. */
export const ALLOWED: Readonly<Record<string, string>> = {};

/** Every text file under the root, as paths relative to it. */
export function textFiles(dir = ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) textFiles(full, out);
    else if (st.isFile() && !BINARY.test(entry) && st.size <= MAX_BYTES)
      out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

/** The lines of one file that match a pattern, as `file:line name`. */
export function scanText(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { name, re } of PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1} ${name}`);
  });
  return hits;
}

describe('SEC-048 the repository holds no secret (criterion 1, working-tree scan)', () => {
  it('the patterns find a planted secret and ignore an ordinary line (control)', () => {
    expect(scanText('x.ts', 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP";')).toHaveLength(1);
    expect(scanText('x.ts', 'const note = "the key is in the vault";')).toEqual([]);
  });

  it('reads more than 100 text files, so an empty result means something', () => {
    expect(textFiles().length).toBeGreaterThan(100);
  });

  it('finds no secret in the working tree outside the reviewed allowlist', () => {
    const findings: string[] = [];
    for (const file of textFiles()) {
      if (file === 'tests/security/test/secret-scan.test.ts') continue;
      if (ALLOWED[file]) continue;
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue;
      }
      findings.push(...scanText(file, text));
    }
    expect(findings).toEqual([]);
  });
});
