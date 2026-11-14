// Architecture boundaries (FND-004; 01 §6; 02 §9.1; CDM-006). The checks CI runs are run here on
// probes, so a test shows that they fail the build when a boundary is crossed:
// - the TypeScript configuration of each universal package refuses Node.js and browser globals and
//   Node.js modules (lib ES2023, no ambient types);
// - dependency-cruiser, with the rules of .dependency-cruiser.cjs, refuses forbidden imports.
// The probes are virtual or live in a temporary directory; nothing is written into the repository.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cruise, type IViolation } from 'dependency-cruiser';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const slash = (p: string) => p.replace(/\\/g, '/');

/** Type-checks a virtual file inside a package's `src`, with the package's own tsconfig. */
function typeCheckProbe(pkg: string, text: string): { probe: string[]; elsewhere: string[] } {
  const dir = resolve(root, 'packages', pkg);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(dir, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error(`cannot read ${pkg}/tsconfig.json`);
  const probePath = slash(join(dir, 'src', '__boundary_probe__.ts'));
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    slash(name) === probePath
      ? ts.createSourceFile(name, text, lang)
      : getSourceFile(name, lang, ...rest);
  host.fileExists = (name) => slash(name) === probePath || ts.sys.fileExists(name);
  host.readFile = (name) => (slash(name) === probePath ? text : ts.sys.readFile(name));
  const program = ts.createProgram({ rootNames: [probePath], options: parsed.options, host });
  const probe: string[] = [];
  const elsewhere: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file && slash(d.file.fileName) === probePath) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      probe.push(`${line + 1}: ${message}`);
    } else elsewhere.push(`${d.file?.fileName ?? '?'}: ${message}`);
  }
  return { probe, elsewhere };
}

const PROBE = [
  "import './index.ts';", // 1: the package itself, so its whole dependency graph is loaded
  "import { readFileSync } from 'node:fs';", // 2
  'export const a = process.env;', // 3
  'export const b = document.title;', // 4
  'export const c = window.location;', // 5
  "export const d = Buffer.from('x');", // 6
  'export const e = new TextEncoder();', // 7: only through the platform helpers of the model
  'export const f = readFileSync;', // 8
  'export const ok = [1, 2, 3].at(-1);', // 9: ES2023 is allowed
].join('\n');

describe('universal packages refuse Node.js and browser APIs at type-check time (FND-004)', () => {
  for (const pkg of ['model', 'authority']) {
    it(`${pkg}: every Node.js or browser API in the probe is an error, and nothing else is`, () => {
      const { probe, elsewhere } = typeCheckProbe(pkg, PROBE);
      expect(elsewhere, 'the package itself type-checks').toEqual([]);
      const lines = new Set(probe.map((p) => Number(p.split(':')[0])));
      expect(
        [...lines].sort((x, y) => x - y),
        probe.join('\n'),
      ).toEqual([2, 3, 4, 5, 6, 7]);
    });
  }

  it('model: the type entry points import no ProseMirror module (CDM-006, 03 §1 principle 2)', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      resolve(root, 'packages/model/tsconfig.json'),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    )!;
    const program = ts.createProgram({
      rootNames: [
        resolve(root, 'packages/model/src/index.ts'),
        resolve(root, 'packages/model/src/definition/index.ts'),
      ],
      options: parsed.options,
    });
    const files = program.getSourceFiles().map((f) => slash(f.fileName));
    expect(files.some((f) => f.includes('/packages/model/src/generated/types.ts'))).toBe(true);
    expect(files.filter((f) => /\/prosemirror-[a-z]+\//.test(f))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const config = require(resolve(root, '.dependency-cruiser.cjs')) as {
  forbidden: unknown[];
  options: { enhancedResolveOptions: Record<string, unknown> };
};

const tmp = mkdtempSync(join(tmpdir(), 'docedit-boundaries-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function file(path: string, text: string): void {
  const full = join(tmp, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

describe('dependency-cruiser refuses forbidden imports (FND-004)', () => {
  // A miniature workspace with one probe per rule, and a clean file that must pass.
  file(
    'node_modules/prosemirror-view/package.json',
    '{"name":"prosemirror-view","main":"index.js"}',
  );
  file('node_modules/prosemirror-view/index.js', 'export {};\n');
  file(
    'node_modules/prosemirror-model/package.json',
    '{"name":"prosemirror-model","main":"index.js"}',
  );
  file('node_modules/prosemirror-model/index.js', 'export {};\n');
  file('packages/model/src/clean.ts', 'export const ok = 1;\n');
  file(
    'packages/model/src/probe.ts',
    "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
  );
  file('packages/authority/src/probe.ts', "import { cpus } from 'os';\nexport const x = cpus;\n");
  file(
    'packages/rules/src/probe.ts',
    "import { join } from 'node:path';\nexport const x = join;\n",
  );
  file(
    'packages/layout/src/probe.ts',
    "import 'prosemirror-view';\nimport '../../painter/src/index.ts';\n",
  );
  file('packages/painter/src/index.ts', 'export const painter = 1;\n');
  file('packages/ui/src/index.ts', "import 'prosemirror-model';\nexport const ui = 1;\n");
  file('packages/element/src/index.ts', 'export const element = 1;\n');
  file(
    'services/demo/src/probe.ts',
    "import '../../../packages/ui/src/index.ts';\nimport '../../../packages/element/src/index.ts';\n",
  );

  it('reports exactly the expected violation for every probe', async () => {
    const result = await cruise(['packages', 'services'], {
      baseDir: tmp,
      validate: true,
      ruleSet: { forbidden: config.forbidden } as never,
      doNotFollow: { path: 'node_modules' },
      tsPreCompilationDeps: true,
      enhancedResolveOptions: config.options.enhancedResolveOptions as never,
    });
    const output = result.output as { summary: { violations: IViolation[] } };
    const found = output.summary.violations
      .map((v) => `${v.rule.name} ${slash(v.from)} -> ${slash(v.to)}`)
      .sort();
    expect(found).toEqual(
      [
        // dependency-cruiser names Node.js modules without the `node:` prefix.
        'universal-no-node-builtins packages/model/src/probe.ts -> fs',
        'universal-no-node-builtins packages/authority/src/probe.ts -> os',
        'universal-no-node-builtins packages/rules/src/probe.ts -> path',
        'universal-no-dom-packages packages/layout/src/probe.ts -> node_modules/prosemirror-view/index.js',
        'universal-no-dom-packages packages/layout/src/probe.ts -> packages/painter/src/index.ts',
        'ui-no-prosemirror packages/ui/src/index.ts -> node_modules/prosemirror-model/index.js',
        'services-no-ui services/demo/src/probe.ts -> packages/ui/src/index.ts',
        'services-no-ui services/demo/src/probe.ts -> packages/element/src/index.ts',
      ].sort(),
    );
  });
});
