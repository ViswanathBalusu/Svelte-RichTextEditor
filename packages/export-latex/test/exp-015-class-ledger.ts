/**
 * The release rule of the house class (EXP-015 criterion 4): a class change is released only with a
 * raised version. Two checks, both pure, over `class/releases.json` (an append-only ledger of
 * released versions with the SHA-256 of each class file):
 *
 * - `checkLedger` reads the working tree alone. The versions rise from entry to entry, the last entry
 *   is the version the converter and the class announce, and the class files are the bytes recorded
 *   under that version. A class edit under a version already released fails, whatever else changed.
 * - `checkAgainstBase` compares with the ledger and class files of a base revision (the branch a
 *   change is merged into). The base ledger must be an unchanged prefix of the current one, and a
 *   class file that differs from the base must come with a version the base did not release. This
 *   catches the one edit the ledger cannot see on its own: a released entry rewritten in place.
 *
 * Test helper (Node.js); the universal-package rule excepts `test/`.
 */
import { execFileSync } from 'node:child_process';
import { CLASS_FILES } from '../src/index.ts';

/** The class files a bundle carries (the converter's list). */
export { CLASS_FILES };
export type ClassFile = (typeof CLASS_FILES)[number];
export type ClassHashes = Readonly<Record<ClassFile, string>>;

export interface Release {
  readonly version: string;
  readonly files: ClassHashes;
}

export interface Ledger {
  readonly releases: readonly Release[];
}

/** `major.minor.patch`, compared numerically. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)!;
  const y = parseVersion(b)!;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

const sameHashes = (a: ClassHashes, b: ClassHashes) => CLASS_FILES.every((f) => a[f] === b[f]);

/** What is wrong with the working tree's ledger, class version and class files; empty when none. */
export function checkLedger(
  ledger: Ledger,
  current: { classVersion: string; providesVersion: string; files: ClassHashes },
): string[] {
  const problems: string[] = [];
  const rs = ledger.releases;
  if (rs.length === 0) return ['the ledger records no release'];
  rs.forEach((r, i) => {
    if (!parseVersion(r.version))
      problems.push(`release ${i}: "${r.version}" is not major.minor.patch`);
    for (const f of CLASS_FILES)
      if (!/^[0-9a-f]{64}$/.test(r.files[f] ?? ''))
        problems.push(`release ${r.version}: ${f} has no SHA-256`);
  });
  if (problems.length) return problems;
  for (let i = 1; i < rs.length; i++)
    if (compareVersions(rs[i]!.version, rs[i - 1]!.version) <= 0)
      problems.push(
        `release ${rs[i]!.version} follows ${rs[i - 1]!.version}: versions must rise, and entries are only appended`,
      );
  const last = rs[rs.length - 1]!;
  if (current.classVersion !== current.providesVersion)
    problems.push(
      `CLASS_VERSION is ${current.classVersion} but docedit.cls announces ${current.providesVersion}`,
    );
  const recorded = rs.find((r) => r.version === current.classVersion);
  if (!recorded)
    problems.push(
      `CLASS_VERSION ${current.classVersion} is not in the ledger: append a release entry for it`,
    );
  else if (!sameHashes(recorded.files, current.files)) {
    const changed = CLASS_FILES.filter((f) => recorded.files[f] !== current.files[f]).join(', ');
    problems.push(
      `${changed} changed, but version ${current.classVersion} was released with other bytes: raise CLASS_VERSION and the ProvidesClass version, and append a release; never edit a released entry`,
    );
  }
  if (recorded && recorded !== last)
    problems.push(
      `CLASS_VERSION ${current.classVersion} is not the last release (${last.version})`,
    );
  return problems;
}

/** What is wrong with the working tree compared with a base revision; empty when nothing. */
export function checkAgainstBase(
  base: { ledger: Ledger; files: ClassHashes },
  current: { ledger: Ledger; classVersion: string; files: ClassHashes },
): string[] {
  const problems: string[] = [];
  const b = base.ledger.releases;
  const c = current.ledger.releases;
  b.forEach((r, i) => {
    const now = c[i];
    if (!now || now.version !== r.version || !sameHashes(now.files, r.files))
      problems.push(`released entry ${r.version} was edited or removed: the ledger is append-only`);
  });
  const changed = CLASS_FILES.filter((f) => base.files[f] !== current.files[f]);
  if (changed.length && b.some((r) => r.version === current.classVersion))
    problems.push(
      `${changed.join(', ')} changed since the base, but CLASS_VERSION ${current.classVersion} was already released there: raise it`,
    );
  return problems;
}

/**
 * Reads a file at a git revision, or null when git, the revision or the file is not there (a tree
 * with no commits yet, a shallow clone without the base branch).
 */
export function gitShow(cwd: string, ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** The first of the candidate revisions git knows, or null. */
export function resolveBaseRef(cwd: string, candidates: readonly string[]): string | null {
  for (const ref of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd,
        stdio: 'ignore',
      });
      return ref;
    } catch {
      // not known here
    }
  }
  return null;
}
