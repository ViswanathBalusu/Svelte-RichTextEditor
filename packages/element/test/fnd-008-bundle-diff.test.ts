/**
 * FND-008 criterion 4: the comparison of two bundle reports that CI attaches to a pull request.
 * The reports here are small and synthetic; the last test runs the command on the report of a
 * real build when one is present.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  diffReports,
  renderMarkdown,
  stableName,
  type ReportLike,
} from '../scripts/bundle-diff.ts';

const size = (gzip: number) => ({ raw: gzip * 3, gzip, brotli: gzip - 10 });

function report(engine: number, extra: Partial<ReportLike> = {}): ReportLike {
  return {
    budgetGzipBytes: 320_000,
    firstInteractive: { size: size(engine + 40_000) },
    firstInteractiveWithDep: { size: size(engine + 60_000) },
    chunks: [
      { file: 'doc-editor.js', kind: 'entry', size: size(15_000) },
      { file: 'chunks/engine-BL-BrZ41.js', kind: 'first interactive', size: size(engine) },
      { file: 'chunks/math-Ab12Cd34.js', kind: 'lazy', size: size(9_000) },
    ],
    lazy: [],
    lazyByFeature: [{ feature: 'math editor', files: 1, size: size(9_000) }],
    ...extra,
  };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('FND-008 criterion 4: the bundle report of a pull request', () => {
  it('names a chunk without its content hash', () => {
    expect(stableName('chunks/engine-BL-BrZ41.js')).toBe('chunks/engine.js');
    expect(stableName('chunks/engine-5TShfQYX.js')).toBe('chunks/engine.js');
    expect(stableName('doc-editor.js')).toBe('doc-editor.js');
    expect(stableName('viewer/pdfjs/wasm/openjpeg.wasm')).toBe('viewer/pdfjs/wasm/openjpeg.wasm');
  });

  it('reports no change for equal sizes, even when the hashes differ', () => {
    const head = report(100_000);
    head.chunks![1]!.file = 'chunks/engine-ZZZZZZZZ.js';
    const diff = diffReports(report(100_000), head);
    expect(diff.changed).toBe(false);
    expect(diff.chunks).toEqual([]);
    expect(renderMarkdown(diff)).toContain('No chunk changes size.');
  });

  it('lists a chunk that grew, with its base and new size, and the totals', () => {
    const diff = diffReports(report(100_000), report(112_500));
    expect(diff.changed).toBe(true);
    expect(diff.chunks).toEqual([
      { name: 'chunks/engine.js', base: 100_000, head: 112_500, delta: 12_500 },
    ]);
    expect(diff.totals[0]?.delta).toBe(12_500);
    const text = renderMarkdown(diff);
    expect(text).toContain('This change alters the size of at least one chunk.');
    expect(text).toContain('| chunks/engine.js | 100.0 kB | 112.5 kB | +12.5 kB |');
    expect(text).toContain('Budget: 320.0 kB');
  });

  it('lists a new chunk and a removed chunk, and a lazy feature that changed', () => {
    const head = report(100_000, {
      chunks: [
        { file: 'doc-editor.js', kind: 'entry', size: size(15_000) },
        { file: 'chunks/engine-BL-BrZ41.js', kind: 'first interactive', size: size(100_000) },
        { file: 'chunks/proofing-Qw12Er34.js', kind: 'lazy', size: size(4_000) },
      ],
      lazyByFeature: [
        { feature: 'math editor', files: 0, size: size(0) },
        { feature: 'proofing', files: 1, size: size(4_000) },
      ],
    });
    const diff = diffReports(report(100_000), head);
    const byName = Object.fromEntries(diff.chunks.map((r) => [r.name, r]));
    expect(byName['chunks/math.js']).toMatchObject({ base: 9_000, head: null, delta: -9_000 });
    expect(byName['chunks/proofing.js']).toMatchObject({ base: null, head: 4_000, delta: 4_000 });
    expect(diff.features.map((f) => f.name).sort()).toEqual(['math editor', 'proofing']);
    expect(renderMarkdown(diff)).toContain('| chunks/proofing.js | none | 4.0 kB | +4.0 kB |');
  });

  it('sums chunks that share a name', () => {
    const base = report(100_000);
    base.chunks!.push({ file: 'chunks/engine-Zz99Yy88.js', kind: 'lazy', size: size(1_000) });
    const diff = diffReports(base, report(100_000));
    expect(diff.chunks).toEqual([
      { name: 'chunks/engine.js', base: 101_000, head: 100_000, delta: -1_000 },
    ]);
  });

  it('says so when the base has no report', () => {
    const diff = diffReports(null, report(100_000));
    expect(diff.changed).toBe(true);
    expect(renderMarkdown(diff, true)).toContain('The base branch has no bundle report');
  });

  it('runs as a command and writes the summary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnd-008-diff-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'base.json'), JSON.stringify(report(100_000)));
    writeFileSync(join(dir, 'head.json'), JSON.stringify(report(101_000)));
    const script = new URL('../scripts/bundle-diff.ts', import.meta.url);
    const run = spawnSync(
      process.execPath,
      [
        script.pathname.replace(/^\/(\w:)/, '$1'),
        join(dir, 'base.json'),
        join(dir, 'head.json'),
        join(dir, 'out.md'),
      ],
      { encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(join(dir, 'out.md'), 'utf8')).toContain('+1.0 kB');
  });

  it('reads the report of a real build against itself, when one exists', () => {
    const path = new URL('../dist/lib/bundle-report.json', import.meta.url);
    if (!existsSync(path)) return;
    const real = JSON.parse(readFileSync(path, 'utf8')) as ReportLike;
    const diff = diffReports(real, real);
    expect(diff.changed).toBe(false);
    expect(diff.totals[0]?.head).toBeGreaterThan(0);
  });
});
