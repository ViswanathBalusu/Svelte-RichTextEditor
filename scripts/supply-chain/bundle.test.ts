// What a built bundle contains (SEC-051, SEC-054): every file attributed to its packages.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyseBundle, packageAt } from './bundle.ts';

const root = mkdtempSync(join(tmpdir(), 'docedit-bundle-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, content: string | object): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

// A workspace with two installed packages and a distributable that bundles one of them.
put('node_modules/lib-a/package.json', { name: 'lib-a', version: '1.2.3', license: 'MIT' });
put('node_modules/lib-a/index.js', 'export const a = 1;');
put('node_modules/lib-a/fonts/face.woff2', 'FONT-A');
put('node_modules/lib-b/package.json', {
  name: 'lib-b',
  version: '2.0.0',
  license: { type: 'Apache-2.0' },
});
put('node_modules/lib-b/data.bin', 'DATA-B');
put('pkg/package.json', {
  name: '@docedit/fixture',
  version: '0.0.0',
  devDependencies: { 'lib-b': '2.0.0' },
});
put('pkg/src/main.ts', 'import { a } from "lib-a";');
put('pkg/src/page.html', '<!doctype html><script src="./main.ts"></script>');
// Generated line 0: columns 0-9 from src/main.ts (source 0), from column 10 from lib-a (source 1).
put('pkg/dist/app.js', 'const a=1;export{a};\n//# sourceMappingURL=app.js.map\n');
put('pkg/dist/app.js.map', {
  version: 3,
  sources: ['../src/main.ts', '../../node_modules/lib-a/index.js'],
  mappings: 'AAAA,UCAA',
});
put('pkg/dist/assets/face-AbCdEf12.woff2', 'FONT-A');
put('pkg/dist/data.bin', 'DATA-B');
put('pkg/dist/page.html', '<!doctype html><script type="module" src="./app.js"></script>');
put('pkg/dist/mystery.txt', 'from nowhere');
put('pkg/dist/report.json', '{}');

const contents = analyseBundle(join(root, 'pkg/dist'), {
  ownPackageDir: join(root, 'pkg'),
  exclude: (p) => p === 'report.json',
});

describe('bundle contents', () => {
  it('attributes generated code through its source map, map included', () => {
    const app = contents.attributions.filter((a) => a.file.startsWith('app.js'));
    expect(app.map((a) => [a.file, a.method, a.packages])).toEqual([
      ['app.js', 'source-map', ['@docedit/fixture@0.0.0', 'lib-a@1.2.3']],
      ['app.js.map', 'source-map', ['@docedit/fixture@0.0.0', 'lib-a@1.2.3']],
    ]);
  });

  it('attributes other files by identity, preferring packages the code already uses', () => {
    const font = contents.attributions.find((a) => a.file === 'assets/face-AbCdEf12.woff2');
    expect(font).toMatchObject({
      method: 'identical-file',
      packages: ['lib-a@1.2.3'],
      equals: 'fonts/face.woff2',
    });
    // lib-b is not in any map; it is found as one of the distributable's own dependencies.
    expect(contents.attributions.find((a) => a.file === 'data.bin')).toMatchObject({
      method: 'identical-file',
      packages: ['lib-b@2.0.0'],
    });
  });

  it("attributes the bundler's own pages to the distributable by name", () => {
    expect(contents.attributions.find((a) => a.file === 'page.html')).toMatchObject({
      method: 'own-name',
      packages: ['@docedit/fixture@0.0.0'],
    });
  });

  it('reports what nothing explains, and leaves excluded output out', () => {
    expect(contents.unattributed).toEqual(['mystery.txt']);
    expect(contents.files.map((f) => f.path)).not.toContain('report.json');
    expect(contents.problems).toEqual([]);
  });

  it('knows each package: workspace or installed, licence as its manifest states it', () => {
    expect(
      [...contents.packages.values()].map((p) => [p.key, p.workspace, p.licence]).sort(),
    ).toEqual([
      ['@docedit/fixture@0.0.0', true, undefined],
      ['lib-a@1.2.3', false, 'MIT'],
      ['lib-b@2.0.0', false, 'Apache-2.0'],
    ]);
  });

  it('records checksums of every file', () => {
    const font = contents.files.find((f) => f.path === 'assets/face-AbCdEf12.woff2')!;
    expect(font).toMatchObject({
      size: 6,
      sha1: expect.stringMatching(/^[0-9a-f]{40}$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('names the package behind a position of generated code', () => {
    expect(packageAt(contents, 'app.js', 0, 3)).toBe('@docedit/fixture@0.0.0');
    expect(packageAt(contents, 'app.js', 0, 12)).toBe('lib-a@1.2.3');
    expect(packageAt(contents, 'data.bin', 0, 0)).toBe('lib-b@2.0.0');
    expect(packageAt(contents, 'mystery.txt', 0, 0)).toBeNull();
  });

  it('reports a source that belongs to no package and a bundler module', () => {
    put('lonely/dist/x.js', 'x;\n//# sourceMappingURL=x.js.map\n');
    put('lonely/dist/x.js.map', {
      version: 3,
      sources: ['\u0000virtual:helper'],
      mappings: 'AAAA',
    });
    put('lonely/package.json', { name: 'lonely', version: '1.0.0' });
    const c = analyseBundle(join(root, 'lonely/dist'), { ownPackageDir: join(root, 'lonely') });
    expect(c.problems).toEqual([
      'x.js: source "virtual:helper" is a bundler module that belongs to no package',
    ]);
  });
});
