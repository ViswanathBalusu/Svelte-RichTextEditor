// SEC-054 criterion 4 (lane w8): the sandboxed extension runtime is the one listed exception.
// The runtime that runs inside the extension's frame (packages/ui/src/extensions/sandbox-runtime.ts)
// is built here as the end-to-end test of UX-060 builds it (Vite, library mode, one script, source
// map), and the real origin check runs over it with the real exceptions file. The element's own
// build does not carry the runtime yet (docs/review/2026-11-18-ux-060-sandbox-review.md, finding 4).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { build as ViteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyseBundle, type BundleContents } from './bundle.ts';
import { checkOrigins, type OriginException } from './origin-check.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const ui = join(here, '..', '..', 'packages', 'ui');
const exceptions = (
  JSON.parse(readFileSync(join(here, 'origin-exceptions.json'), 'utf8')) as {
    exceptions: OriginException[];
  }
).exceptions;
const TODAY = '2026-11-18';

// Vite is a dependency of the ui package, not of the root, so it is resolved from there.
const { build } = (await import(
  pathToFileURL(createRequire(join(ui, 'package.json')).resolve('vite')).href
)) as { build: typeof ViteBuild };

let out = '';
let contents: BundleContents;
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'origin-sandbox-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      sourcemap: true,
      lib: {
        entry: join(ui, 'src', 'extensions', 'sandbox-runtime.ts'),
        formats: ['iife'],
        name: 'sandboxRuntime',
        fileName: () => 'sandbox-runtime.js',
      },
    },
  });
  contents = analyseBundle(out, { ownPackageDir: ui });
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the sandboxed extension runtime and the origin check (SEC-054 criterion 4)', () => {
  it('is attributed to the editor and loads its entry from a computed address, once', () => {
    expect(contents.unattributed).toEqual([]);
    const r = checkOrigins(contents, [], TODAY);
    expect(r.findings.map((f) => [f.rule, f.package])).toEqual([
      ['computed-script', expect.stringMatching(/^@docedit\/ui@/)],
    ]);
  });

  it('passes with the recorded exception, which is the one for sandboxed extensions', () => {
    const r = checkOrigins(contents, exceptions, TODAY);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.excused).toHaveLength(1);
    expect(r.excused[0]!.exception).toMatchObject({
      package: '@docedit/ui',
      rule: 'computed-script',
    });
    expect(r.excused[0]!.exception.decision).toContain('Owner decision 120');
    // The one exception of its rule: no other entry excuses a computed script address.
    expect(exceptions.filter((e) => e.rule === 'computed-script')).toHaveLength(1);
  });

  it('fails when the exception is gone or has run out', () => {
    expect(checkOrigins(contents, [], TODAY).ok).toBe(false);
    const expired = exceptions.map((e) =>
      e.rule === 'computed-script' ? { ...e, expires: '2026-01-01' } : e,
    );
    expect(checkOrigins(contents, expired, TODAY).ok).toBe(false);
  });
});
