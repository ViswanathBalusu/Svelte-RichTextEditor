// The origin check (SEC-054): no remote or computed imports, no third-party addresses, no eval.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyseBundle } from './bundle.ts';
import {
  checkOrigins,
  isLoadable,
  remoteUrls,
  scanHtml,
  scanScript,
  scanStyle,
  type OriginException,
} from './origin-check.ts';

const rules = (code: string) => scanScript(code, 'x.js').findings.map((f) => f.rule);

describe('scripts', () => {
  it('finds remote and computed imports, and ignores imports of its own files', () => {
    expect(rules('import("https://cdn.example.com/x.js")')).toEqual(['remote-import']);
    expect(rules('import(url)')).toEqual(['computed-import']);
    expect(rules('import(`./chunks/${name}.js`)')).toEqual(['computed-import']);
    expect(rules('import("./chunks/editor-abc.js"); import(`./x.js`)')).toEqual([]);
    expect(
      rules('import x from "https://esm.sh/x"; export * from "//cdn.jsdelivr.net/npm/y";'),
    ).toEqual(['remote-import', 'remote-import']);
    expect(rules('import x from "./x.js"; export { y } from "../y.js";')).toEqual([]);
    expect(
      rules('importScripts(u); importScripts("https://x.example/y.js"); importScripts("./w.js")'),
    ).toEqual(['computed-import', 'remote-import']);
  });

  it('finds eval-like code: eval, the Function constructor, string timers, imports of generated code', () => {
    expect(rules('eval("1")')).toEqual(['eval']);
    expect(rules('window.eval(s); globalThis.eval(s); (0, eval)(s)')).toEqual([
      'eval',
      'eval',
      'eval',
    ]);
    expect(rules('new Function("a", "return a"); Function("return this")()')).toEqual([
      'eval',
      'eval',
    ]);
    expect(rules('setTimeout("alert(1)", 10); setInterval(`tick()`, 5)')).toEqual(['eval', 'eval']);
    expect(
      rules('import("data:text/javascript,export default 1"); import("blob:https://x/y")'),
    ).toEqual(['eval', 'eval']);
    expect(
      rules('setTimeout(() => go(), 10); obj.eval(x); math.Function; typeof f === "function"'),
    ).toEqual([]);
  });

  it('finds script, style and font addresses of other origins in strings, not in comments', () => {
    expect(rules('const s = "https://fonts.googleapis.com/css2?family=Inter";')).toEqual([
      'remote-address',
    ]);
    expect(
      rules('const c = "https://cdn.example.com/lib.css", f = "//static.example.org/f.woff2";'),
    ).toEqual(['remote-address', 'remote-address']);
    expect(rules('const css = `@font-face{src:url(https://use.typekit.net/x)}`;')).toEqual([
      'remote-address',
    ]);
    expect(
      rules(
        '// https://cdn.example.com/x.js\n/* https://unpkg.com/y */ const ns = "http://www.w3.org/2000/svg";',
      ),
    ).toEqual([]);
  });

  it('observes WebAssembly and other remote addresses without failing', () => {
    const r = scanScript(
      'WebAssembly.instantiateStreaming(fetch("./a.wasm")); const e = "https://svelte.dev/e/x";',
      'x.js',
    );
    expect(r.findings).toEqual([]);
    expect(r.observations.map((o) => o.kind)).toEqual(['wasm', 'remote-url']);
  });

  it('walks code nested deeper than the call stack allows', () => {
    const deep = `const s = ${Array.from({ length: 50_000 }, (_, i) => `"a${i}"`).join('+')}; eval(s);`;
    expect(scanScript(deep, 'deep.js').findings.map((f) => f.rule)).toEqual(['eval']);
  });

  it('reports positions as source maps count them (0-based line and column)', () => {
    const [f] = scanScript('let a;\n  eval(a)', 'x.js').findings;
    expect(f).toMatchObject({ rule: 'eval', line: 1, column: 2, detail: 'eval(a)' });
  });

  it('classifies addresses', () => {
    expect(remoteUrls('see https://a.example/x.js and //b.example.org/y and ./c.js')).toEqual([
      'https://a.example/x.js',
      '//b.example.org/y',
    ]);
    expect(isLoadable('https://a.example/x.mjs?v=1')).toBe(true);
    expect(isLoadable('https://a.example/docs/page')).toBe(false);
    expect(isLoadable('https://cdn.jsdelivr.net/npm/x')).toBe(true);
  });
});

describe('stylesheets and pages', () => {
  it('finds remote @import and url() in stylesheets, outside comments', () => {
    const css =
      '/* url(https://x.example/a.css) */\n@import url("https://fonts.googleapis.com/css2?family=X");\n@font-face{src:url(https://cdn.example.com/f.woff2)}\n.a{background:url(./i.png)}\n.b{src:url(data:font/woff2;base64,AAAA)}';
    const f = scanStyle(css, 'a.css');
    expect(f.map((x) => [x.line, x.detail])).toEqual([
      [1, 'https://fonts.googleapis.com/css2?family=X'],
      [2, 'https://cdn.example.com/f.woff2'],
    ]);
  });

  it('finds remote scripts, styles, frames and base addresses in pages, and scans inline code', () => {
    const html = [
      '<!doctype html>',
      '<script src="https://cdn.example.com/x.js"></script>',
      '<link rel="stylesheet" href="//cdn.example.com/x.css">',
      '<script type="module" crossorigin src="./assets/a.js"></script>',
      '<base href="https://other.example/">',
      '<script>',
      '  eval("x")',
      '</script>',
      '<style>@import url(https://x.example/y.css);</style>',
    ].join('\n');
    const { findings } = scanHtml(html, 'p.html');
    expect(findings.map((f) => [f.rule, f.line])).toEqual([
      ['remote-address', 1],
      ['remote-address', 2],
      ['remote-address', 4],
      ['eval', 6],
      ['remote-address', 8],
    ]);
  });
});

describe('the check over a bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'docedit-origin-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, content: string | object) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };
  put('node_modules/viewer-lib/package.json', { name: 'viewer-lib', version: '6.0.0' });
  put('node_modules/viewer-lib/lib.js', 'export const load = (u) => import(u);');
  put('pkg/package.json', { name: '@docedit/fixture', version: '0.0.0' });
  put('pkg/src/main.ts', '');
  // Column 0 comes from our source, column 12 onwards from viewer-lib.
  put(
    'pkg/dist/app.js',
    'const own=1;const load=(u)=>import(u);\n//# sourceMappingURL=app.js.map\n',
  );
  put('pkg/dist/app.js.map', {
    version: 3,
    sources: ['../src/main.ts', '../../node_modules/viewer-lib/lib.js'],
    mappings: 'AAAA,YCAA',
  });
  const contents = analyseBundle(join(root, 'pkg/dist'), { ownPackageDir: join(root, 'pkg') });
  const exception = (over: Partial<OriginException> = {}): OriginException => ({
    package: 'viewer-lib',
    rule: 'computed-import',
    reason: 'the address is the viewer’s own file',
    decision: 'ADR 9999',
    expires: '2027-01-01',
    ...over,
  });

  it('fails on a finding and names the package that wrote it', () => {
    const r = checkOrigins(contents, [], '2026-11-06');
    expect(r.ok).toBe(false);
    expect(r.findings).toMatchObject([
      { rule: 'computed-import', file: 'app.js', package: 'viewer-lib@6.0.0' },
    ]);
  });

  it('passes a finding only with a recorded exception for that package and rule', () => {
    const r = checkOrigins(contents, [exception()], '2026-11-06');
    expect(r.ok).toBe(true);
    expect(r.excused).toHaveLength(1);
    expect(checkOrigins(contents, [exception({ package: 'other' })], '2026-11-06').ok).toBe(false);
    expect(checkOrigins(contents, [exception({ file: 'viewer/' })], '2026-11-06').ok).toBe(false);
    expect(checkOrigins(contents, [exception({ file: 'app' })], '2026-11-06').ok).toBe(true);
  });

  it('refuses exceptions without a reason, a decision or a live expiry, and lists unused ones', () => {
    const expired = checkOrigins(contents, [exception({ expires: '2026-01-01' })], '2026-11-06');
    expect(expired.ok).toBe(false);
    expect(expired.problems).toContain(
      'exception for viewer-lib (computed-import) expired on 2026-01-01',
    );
    expect(checkOrigins(contents, [exception({ decision: '' })], '2026-11-06').problems[0]).toMatch(
      /needs a reason, a decision record and an expiry date/,
    );
    const unused = checkOrigins(contents, [exception(), exception({ rule: 'eval' })], '2026-11-06');
    expect(unused.unusedExceptions.map((e) => e.rule)).toEqual(['eval']);
  });
});
