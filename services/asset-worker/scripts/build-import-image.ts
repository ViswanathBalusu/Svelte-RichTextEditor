/**
 * Builds the Word import sandbox image with Podman (EXP-099 criterion 1; ADR 0043):
 *
 *   node services/asset-worker/scripts/build-import-image.ts
 *
 * The build context is staged in a temporary directory and holds only what the sandbox runs: the
 * Containerfile, the source of `packages/model` and `packages/export-docx` (tests left out) at their
 * repository paths, the entry script, and the npm packages they import at run time (fflate,
 * prosemirror-model, orderedmap), copied out of the workspace's node_modules. No supervisor code,
 * configuration or credentials go in. The project's NOTICE and the third-party notices of the npm
 * packages are generated into the context (FND-011 criterion 3). The tag is DOCEDIT_IMPORT_IMAGE or
 * the default of src/docx-import.ts. Prints the image identifier and size.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerCli } from '../src/container.ts';
import { IMPORT_IMAGE } from '../src/docx-import.ts';
import { thirdPartyNotices } from './build-image.ts';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const repo = resolve(root, '..', '..');

/** The npm packages of the importer's run time, and the workspace package that resolves each. */
export const IMPORT_PACKAGES = [
  { name: 'fflate', from: 'packages/export-docx', into: 'packages/export-docx' },
  { name: 'prosemirror-model', from: 'packages/model', into: 'packages/model' },
  // orderedmap is a dependency of prosemirror-model, so it is found from there.
  {
    name: 'orderedmap',
    from: 'packages/model/node_modules/prosemirror-model',
    into: 'packages/model',
  },
] as const;

const isSource = (f: string): boolean => f.endsWith('.ts') && !/\.test\.ts$/.test(f);

function copySource(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop()!;
      if (name === 'node_modules') return false;
      return readdirSafe(src) ? true : isSource(name);
    },
  });
}

const readdirSafe = (p: string): boolean => {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Stages the build context; returns its directory. */
export function stageImportContext(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-import-image-'));
  cpSync(join(root, 'Containerfile.import'), join(dir, 'Containerfile.import'));
  writeFileSync(join(dir, 'package.json'), '{ "private": true, "type": "module" }\n');
  for (const pkg of ['model', 'export-docx']) {
    mkdirSync(join(dir, 'packages', pkg), { recursive: true });
    cpSync(join(repo, 'packages', pkg, 'package.json'), join(dir, 'packages', pkg, 'package.json'));
    copySource(join(repo, 'packages', pkg, 'src'), join(dir, 'packages', pkg, 'src'));
  }
  mkdirSync(join(dir, 'services', 'asset-worker', 'scripts'), { recursive: true });
  cpSync(
    join(root, 'scripts', 'docx-import-main.ts'),
    join(dir, 'services', 'asset-worker', 'scripts', 'docx-import-main.ts'),
  );
  const names: string[] = [];
  for (const p of IMPORT_PACKAGES) {
    const req = createRequire(join(realpathSync(join(repo, p.from)), 'package.json'));
    // The package's own folder, found through its main entry (some packages hide package.json).
    let pkgDir = dirname(req.resolve(p.name));
    while (!readdirSync(pkgDir).includes('package.json') || !pkgDir.endsWith(p.name))
      pkgDir = dirname(pkgDir);
    cpSync(realpathSync(pkgDir), join(dir, p.into, 'node_modules', p.name), {
      recursive: true,
      dereference: true,
    });
    names.push(p.name);
  }
  cpSync(join(repo, 'NOTICE'), join(dir, 'NOTICE'));
  // The notices are written from the packages just copied, so they name what the image holds.
  const flat = join(dir, 'notice-src');
  for (const p of IMPORT_PACKAGES)
    cpSync(join(dir, p.into, 'node_modules', p.name), join(flat, p.name), { recursive: true });
  writeFileSync(join(dir, 'THIRD-PARTY-NOTICES.md'), thirdPartyNotices(flat, names));
  rmSync(flat, { recursive: true, force: true });
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = containerCli();
  const dir = stageImportContext();
  try {
    const build = spawnSync(
      cli,
      ['build', '--pull=missing', '-f', join(dir, 'Containerfile.import'), '-t', IMPORT_IMAGE, dir],
      { stdio: 'inherit' },
    );
    if (build.status !== 0) process.exit(build.status ?? 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const inspect = spawnSync(
    cli,
    ['image', 'inspect', IMPORT_IMAGE, '--format', '{{.Id}} {{.Size}}'],
    {
      encoding: 'utf8',
    },
  );
  console.log(`${IMPORT_IMAGE}: ${inspect.stdout.trim()}`);
}
