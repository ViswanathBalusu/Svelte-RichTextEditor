// The workspace layout and the service runtime (FND-001; 01 §6, §7). These tests read the
// repository's own files: they check what is declared, not that a fresh clone builds.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const text = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

type Manifest = {
  name?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  packageManager?: string;
};
const manifest = (...parts: string[]) => JSON.parse(text(...parts, 'package.json')) as Manifest;

/** Directories under `folder` that hold a package.json. */
const members = (folder: string) =>
  readdirSync(join(root, folder), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, folder, e.name, 'package.json')))
    .map((e) => e.name);

/** The lowest major version a `>=x.y.z` range admits; null for any other form of range. */
const minimumMajor = (range: string | undefined): number | null => {
  const m = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(range ?? '');
  return m ? Number(m[1]) : null;
};

describe('workspace layout (01 §6)', () => {
  it('has packages/, services/, apps/ and spec/', () => {
    for (const folder of ['packages', 'services', 'apps', 'spec'])
      expect(existsSync(join(root, folder)), folder).toBe(true);
  });

  it('lists packages/*, services/* and apps/* as pnpm workspace members', () => {
    const globs = [...text('pnpm-workspace.yaml').matchAll(/^\s+-\s+(\S+\/\*)\s*$/gm)].map(
      (m) => m[1],
    );
    expect(globs).toEqual(expect.arrayContaining(['packages/*', 'services/*', 'apps/*']));
  });

  it('keeps spec/ out of the workspace: it holds generated artifacts, not packages', () => {
    expect(text('pnpm-workspace.yaml')).not.toMatch(/^\s+-\s+spec\b/m);
    expect(existsSync(join(root, 'spec', 'package.json'))).toBe(false);
  });

  it('names every workspace member under the working scope @docedit/*', () => {
    for (const folder of ['packages', 'services', 'apps'])
      for (const name of members(folder))
        expect(manifest(folder, name).name, `${folder}/${name}`).toMatch(/^@docedit\/[a-z0-9-]+$/);
  });
});

describe('one command (FND-001 criterion 1)', () => {
  const scripts = manifest().scripts ?? {};

  it('pnpm check runs lint, type-check, tests and build, and stops at the first failure', () => {
    const steps = (scripts['check'] ?? '').split('&&').map((s) => s.trim());
    for (const step of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build'])
      expect(steps, step).toContain(step);
  });

  it('type-check and build cover every workspace member that defines them', () => {
    expect(scripts['typecheck']).toBe('pnpm -r --if-present typecheck');
    expect(scripts['build']).toBe('pnpm -r --if-present build');
  });

  it('every workspace member has a typecheck script', () => {
    for (const folder of ['packages', 'services', 'apps'])
      for (const name of members(folder))
        expect(manifest(folder, name).scripts?.['typecheck'], `${folder}/${name}`).toBeTruthy();
  });

  it('pins the package manager, and the README documents the setup', () => {
    expect(manifest().packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    const readme = text('README.md');
    expect(readme).toContain('## Building and testing');
    expect(readme).toContain('`pnpm install`');
    expect(readme).toContain('`pnpm check`');
  });
});

describe('services target Node.js 22 or later (01 §7; FND-001 criterion 4)', () => {
  it('there is at least one service', () => {
    expect(members('services').length).toBeGreaterThan(0);
  });

  it('every service declares engines.node with a minimum of 22 or later', () => {
    for (const name of members('services')) {
      const major = minimumMajor(manifest('services', name).engines?.node);
      expect(major, `services/${name}: engines.node`).not.toBeNull();
      expect(major, `services/${name}: engines.node`).toBeGreaterThanOrEqual(22);
    }
  });

  it('the workspace root declares the same floor, and pnpm enforces it', () => {
    expect(minimumMajor(manifest().engines?.node)).toBeGreaterThanOrEqual(22);
    expect(text('.npmrc')).toMatch(/^engine-strict=true\s*$/m);
  });

  it('.node-version, which CI installs, is 22 or later', () => {
    const version = text('.node-version').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(22);
  });

  it('a service image built on the Node.js base image uses 22 or later', () => {
    for (const name of members('services')) {
      const file = join(root, 'services', name, 'Containerfile');
      if (!existsSync(file)) continue;
      const bases = [...readFileSync(file, 'utf8').matchAll(/^FROM\s+\S*\/node:(\d+)[.\S]*/gm)];
      for (const base of bases)
        expect(Number(base[1]), `services/${name}: ${base[0]}`).toBeGreaterThanOrEqual(22);
    }
  });

  it('the runtime running these tests is itself 22 or later', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22);
  });
});

describe('minimumMajor', () => {
  it('reads >= ranges and refuses anything else', () => {
    expect(minimumMajor('>=22.18.0')).toBe(22);
    expect(minimumMajor('>= 24')).toBe(24);
    expect(minimumMajor('^22.0.0')).toBeNull();
    expect(minimumMajor('*')).toBeNull();
    expect(minimumMajor(undefined)).toBeNull();
  });
});
