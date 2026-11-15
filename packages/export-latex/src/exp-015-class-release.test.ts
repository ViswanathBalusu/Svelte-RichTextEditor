/**
 * EXP-015 criterion 4 (lane U-EXP-001-016, Node.js only): a change to the house class is released
 * with a raised class version. `class/releases.json` is an append-only ledger of released versions
 * with the SHA-256 of each class file (test/exp-015-class-ledger.ts holds the two checks):
 *
 * - the working tree: the last release is `CLASS_VERSION` and the `ProvidesClass` version, and the
 *   class files are the bytes recorded under it. Editing a class file under a released version
 *   fails, and the fix the message names is a new version with a new entry, not a new hash.
 * - against the base revision (`DOCEDIT_CLASS_BASE_REF`, else `origin/main`, else `main`): the base
 *   ledger is an unchanged prefix, and a class file that differs from the base comes with a version
 *   the base did not release. This leg needs git history; where the tree has none (no commits, or a
 *   shallow clone without the base branch) it is reported as skipped, never passed.
 *
 * The version reaches `manifest.json` (`convert.ts`, services/export-worker/src/job.test.ts), and the
 * document service's cache keys include it (EXP-006; services/document-service/src/control-plane/
 * export-jobs.test.ts).
 *
 * To release a class change: raise `CLASS_VERSION` in `src/convert.ts` and the `ProvidesClass`
 * date and version in `class/docedit.cls`, and append an entry to `class/releases.json`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLASS_FILES,
  type ClassHashes,
  type Ledger,
  checkAgainstBase,
  checkLedger,
  gitShow,
  resolveBaseRef,
} from '../test/exp-015-class-ledger.ts';
import { doc, para, run } from '../test/docs.ts';
import { CLASS_VERSION } from './convert.ts';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(pkg, '..', '..');
const read = (rel: string) => readFileSync(join(pkg, rel), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const hashesOf = (readFile: (name: string) => string): ClassHashes =>
  Object.fromEntries(CLASS_FILES.map((f) => [f, sha256(readFile(f))])) as unknown as ClassHashes;

const ledger = JSON.parse(read('class/releases.json')) as Ledger;
const files = hashesOf((f) => read(`class/${f}`));
const providesVersion = /\\ProvidesClass\{docedit\}\[\S+ v(\d+\.\d+\.\d+)\b/.exec(
  read('class/docedit.cls'),
)?.[1];

const h = (c: string) => c.repeat(64);
const L = (...rs: Array<[string, string, string]>): Ledger => ({
  releases: rs.map(([version, cls, lua]) => ({
    version,
    files: { 'docedit.cls': h(cls), 'docedit.lua': h(lua) },
  })),
});
const F = (cls: string, lua: string): ClassHashes => ({
  'docedit.cls': h(cls),
  'docedit.lua': h(lua),
});

describe('EXP-015 criterion 4: a class change is released with a raised version', () => {
  it('the working tree: the last release is the current version, with the current bytes', () => {
    expect(providesVersion, 'docedit.cls has a ProvidesClass version').toBeDefined();
    expect(
      checkLedger(ledger, {
        classVersion: CLASS_VERSION,
        providesVersion: providesVersion!,
        files,
      }),
    ).toEqual([]);
  });

  describe('the ledger check refuses what the rule forbids', () => {
    const ok = { classVersion: '0.2.0', providesVersion: '0.2.0' };
    it('a class edit under a released version, whatever hash the edit brings', () => {
      expect(checkLedger(L(['0.2.0', 'a', 'b']), { ...ok, files: F('c', 'b') })).toEqual([
        expect.stringContaining('docedit.cls changed, but version 0.2.0 was released'),
      ]);
    });
    it('a version that is not in the ledger, and one that is not the last release', () => {
      expect(
        checkLedger(L(['0.2.0', 'a', 'b']), {
          classVersion: '0.3.0',
          providesVersion: '0.3.0',
          files: F('c', 'b'),
        }),
      ).toEqual([expect.stringContaining('0.3.0 is not in the ledger')]);
      expect(
        checkLedger(L(['0.2.0', 'a', 'b'], ['0.3.0', 'c', 'b']), { ...ok, files: F('a', 'b') }),
      ).toEqual([expect.stringContaining('is not the last release (0.3.0)')]);
    });
    it('versions that do not rise, and a class that announces another version', () => {
      expect(
        checkLedger(L(['0.2.0', 'a', 'b'], ['0.2.0', 'c', 'b']), { ...ok, files: F('c', 'b') }),
      ).toContainEqual(expect.stringContaining('versions must rise'));
      expect(
        checkLedger(L(['0.2.0', 'a', 'b']), {
          classVersion: '0.2.0',
          providesVersion: '0.1.0',
          files: F('a', 'b'),
        }),
      ).toEqual([expect.stringContaining('docedit.cls announces 0.1.0')]);
    });
    it('accepts a change released as a new version with a new entry', () => {
      expect(
        checkLedger(L(['0.2.0', 'a', 'b'], ['0.3.0', 'c', 'b']), {
          classVersion: '0.3.0',
          providesVersion: '0.3.0',
          files: F('c', 'b'),
        }),
      ).toEqual([]);
    });
  });

  describe('the base check refuses a released entry rewritten in place', () => {
    const base = { ledger: L(['0.2.0', 'a', 'b']), files: F('a', 'b') };
    it('the class edited and its released hash replaced, under the same version', () => {
      expect(
        checkAgainstBase(base, {
          ledger: L(['0.2.0', 'c', 'b']),
          classVersion: '0.2.0',
          files: F('c', 'b'),
        }),
      ).toEqual([
        expect.stringContaining('released entry 0.2.0 was edited or removed'),
        expect.stringContaining('was already released there: raise it'),
      ]);
    });
    it('accepts an appended release, and an unchanged class', () => {
      expect(
        checkAgainstBase(base, {
          ledger: L(['0.2.0', 'a', 'b'], ['0.3.0', 'c', 'b']),
          classVersion: '0.3.0',
          files: F('c', 'b'),
        }),
      ).toEqual([]);
      expect(
        checkAgainstBase(base, { ledger: base.ledger, classVersion: '0.2.0', files: base.files }),
      ).toEqual([]);
    });
  });

  it('writes the released version to the manifest.json of every bundle', async () => {
    const released = ledger.releases.at(-1)?.version;
    expect(released).toBe(CLASS_VERSION);
    const bundle = await run(doc([para('A paragraph.')]));
    expect(bundle.manifest.classVersion).toBe(released);
    const written = JSON.parse(bundle.files['manifest.json']!) as { classVersion?: string };
    expect(written.classVersion).toBe(released);
  });

  // master is the base branch of a tree that has no main (as this repository's has not).
  const candidates = [
    process.env['DOCEDIT_CLASS_BASE_REF'] ?? '',
    'origin/main',
    'main',
    'master',
  ].filter((r) => r !== '');
  const baseRef = resolveBaseRef(repo, candidates);
  const rel = 'packages/export-latex/class';
  it.skipIf(baseRef === null)(
    `against the base revision (${baseRef ?? `none of ${candidates.join(', ')} is in this tree's git history`})`,
    () => {
      const baseLedgerText = gitShow(repo, baseRef!, `${rel}/releases.json`);
      const baseFiles = CLASS_FILES.map((f) => gitShow(repo, baseRef!, `${rel}/${f}`));
      // A base from before the ledger or the class: nothing released there to compare with.
      if (baseLedgerText === null || baseFiles.some((t) => t === null)) return;
      const problems = checkAgainstBase(
        {
          ledger: JSON.parse(baseLedgerText) as Ledger,
          files: Object.fromEntries(
            CLASS_FILES.map((f, i) => [f, sha256(baseFiles[i]!)]),
          ) as unknown as ClassHashes,
        },
        { ledger, classVersion: CLASS_VERSION, files },
      );
      expect(problems).toEqual([]);
    },
  );
});
