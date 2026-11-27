/**
 * FND-013 criteria 1 to 3: the site is built from a small repository of the same shape as this
 * one (specification, decision records, stories, a package, protocol artifacts and the integration
 * guide), with VitePress and TypeDoc, once for each of two releases.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readList } from '../scripts/layout.ts';
import { statusOf, titleOf } from '../scripts/stage.ts';

const work = mkdtempSync(join(tmpdir(), 'fnd-013-site-'));
const repo = join(work, 'repo');
const site = join(work, 'site');
// VitePress reads its configuration from the staged folder, and that file imports `vitepress`, so
// the folder must sit below this package's node_modules. The API documentation goes beside it.
const stageDir = join(fileURLToPath(new URL('..', import.meta.url)), 'dist', '.stage-test');
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(`${stageDir}-api`, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function fixture(): void {
  put('package.json', JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  put(
    'docs/spec/00-overview.md',
    '# Overview\n\nThe element is <doc-editor> and `{{ not a template }}`. Text {{ also.not }} here.\n\nSee [the ADR](../adr/0001-first.md).\n',
  );
  put('docs/spec/01-architecture.md', '# Architecture\n\nText.\n');
  put('docs/adr/0001-first.md', '# ADR 0001: First choice\n\n**Status:** accepted, 2026-11-06.\n');
  put('docs/adr/0002-second.md', '# ADR 0002: Second choice\n\n**Status:** proposed.\n');
  put('docs/stories/README.md', '# Stories\n\nThe format.\n');
  put('docs/stories/FND-foundations.md', '# Foundations\n\n### FND-001 First\n');
  put('spec/dep/definition.json', '{"protocol":"fixture"}\n');
  put('spec/cdm/model.json', '{"model":"fixture"}\n');
  put('apps/reference-host/docs/integration-guide.md', '# Integration guide\n\nEmbed it.\n');
  // Two packages, as the repository has many: TypeDoc then writes one module for each.
  for (const [name, fn] of [
    ['widget', 'openFixtureWidget'],
    ['gadget', 'openFixtureGadget'],
  ] as const) {
    put(
      `packages/${name}/package.json`,
      JSON.stringify({
        name: `@fixture/${name}`,
        version: '0.0.0',
        type: 'module',
        exports: { '.': './src/index.ts' },
      }),
    );
    put(
      `packages/${name}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
        include: ['src'],
      }),
    );
    put(
      `packages/${name}/src/index.ts`,
      `/** Opens the ${name} named in the fixture. */\nexport function ${fn}(name: string): string {\n  return name;\n}\n`,
    );
  }
}

// A child process, as `pnpm build` runs it: VitePress resolves its own modules from the process.
function build(version: string): void {
  const script = fileURLToPath(new URL('../scripts/build.ts', import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      script,
      '--repo',
      repo,
      '--version',
      version,
      '--site',
      site,
      '--site-root',
      '/docs/',
      '--stage-dir',
      stageDir,
    ],
    { encoding: 'utf8' },
  );
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
}

const read = (path: string) => readFileSync(join(site, path), 'utf8');

describe('FND-013: the documentation site of two releases', () => {
  beforeAll(async () => {
    fixture();
    build('0.1.0');
    build('0.2.0');
  }, 300_000);

  it('reads the title and the status of a page', () => {
    expect(titleOf('text\n# The `title` #\n', 'x')).toBe('The title');
    expect(titleOf('no heading', 'fallback')).toBe('fallback');
    expect(statusOf('# T\n\n**Status:** Accepted, 2026-11-06.\n')).toBe('accepted');
    expect(statusOf('# T\n')).toBeNull();
  });

  it('criterion 1: publishes the specification, the decision records and the stories', () => {
    expect(read('0.2.0/spec/00-overview.html')).toContain('Overview');
    expect(read('0.2.0/spec/01-architecture.html')).toContain('Architecture');
    expect(read('0.2.0/adr/0001-first.html')).toContain('First choice');
    expect(read('0.2.0/adr/index.html')).toContain('ADR 0002: Second choice');
    expect(read('0.2.0/adr/index.html')).toContain('(proposed)');
    expect(read('0.2.0/stories/FND-foundations.html')).toContain('FND-001');
    expect(read('0.2.0/stories/README.html')).toContain('The format.');
  });

  it('criterion 1: shows tags and double braces in the sources as text', () => {
    const page = read('0.2.0/spec/00-overview.html');
    expect(page).toContain('&lt;doc-editor&gt;');
    expect(page).not.toContain('<doc-editor>');
    // Vue would read the braces in running text as an expression and print nothing for it.
    expect(page).toContain('Text {{ also.not }} here.');
    expect(page).toContain('<code>{{ not a template }}</code>');
  });

  it('criterion 1: generates API documentation for the packages', () => {
    const index = read('0.2.0/api/index.html');
    expect(index).toContain('Document editor API');
    for (const name of ['widget', 'gadget'])
      expect(existsSync(join(site, '0.2.0', 'api', 'modules', `_fixture_${name}.html`))).toBe(true);
    expect(read('0.2.0/api/functions/_fixture_widget.openFixtureWidget.html')).toContain(
      'Opens the widget named in the fixture',
    );
    expect(read('0.2.0/api.html')).toContain('api/index.html');
  });

  it('criterion 1: publishes the protocol artifacts of spec/', () => {
    expect(
      readFileSync(join(site, '0.2.0', 'artifacts', 'dep', 'definition.json'), 'utf8'),
    ).toContain('fixture');
    const page = read('0.2.0/artifacts.html');
    expect(page).toContain('artifacts/dep/definition.json');
    expect(page).toContain('artifacts/cdm/model.json');
  });

  it('criterion 2: includes the integration guide', () => {
    expect(read('0.2.0/guide/integration-guide.html')).toContain('Embed it.');
    expect(read('0.2.0/index.html')).toContain('Integration guide');
  });

  it('criterion 3: keeps a folder for each release, with its own base path', () => {
    expect(read('0.1.0/index.html')).toContain('/docs/0.1.0/assets/');
    expect(read('0.2.0/index.html')).toContain('/docs/0.2.0/assets/');
    expect(read('0.1.0/index.html')).toContain('Documentation for release 0.1.0');
    expect(read('0.2.0/index.html')).toContain('Documentation for release 0.2.0');
  });

  it('criterion 3: makes the latest release the default', () => {
    expect(readList(site)).toEqual({ versions: ['0.2.0', '0.1.0'], latest: '0.2.0' });
    expect(read('index.html')).toContain('url=./0.2.0/');
    const menu = read('0.2.0/index.html');
    expect(menu).toContain('Latest (0.2.0)');
    expect(menu).toContain('/../0.1.0/');
  });
});
