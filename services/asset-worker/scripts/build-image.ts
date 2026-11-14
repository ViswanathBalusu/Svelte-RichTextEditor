/**
 * Builds the asset worker's sandbox image with Podman (BE-043; ADR 0043):
 *
 *   node services/asset-worker/scripts/build-image.ts
 *
 * The build context is staged in a temporary directory and holds only what the sandbox runs: the
 * Containerfile, `src/sandbox/` (which imports nothing outside itself but Node.js built-ins and the
 * decoders; test/boundaries.test.ts checks this), and the decoders pngjs, jpeg-js and omggif copied
 * out of the workspace's node_modules. No supervisor code, configuration or credentials go in.
 * The tag is DOCEDIT_ASSET_IMAGE or the default of src/sandbox-podman.ts. Prints the image
 * identifier and size.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerCli } from '../src/container.ts';
import { IMAGE } from '../src/sandbox-podman.ts';

export const DECODERS = ['pngjs', 'jpeg-js', 'omggif'] as const;

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Stages the build context; returns its directory. */
export function stageContext(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-asset-image-'));
  cpSync(join(root, 'Containerfile'), join(dir, 'Containerfile'));
  const src = join(root, 'src', 'sandbox');
  for (const f of readdirSync(src))
    if (f.endsWith('.ts') && !f.endsWith('.test.ts')) cpSync(join(src, f), join(dir, 'sandbox', f));
  writeFileSync(join(dir, 'package.json'), '{ "private": true, "type": "module" }\n');
  const req = createRequire(join(root, 'package.json'));
  for (const name of DECODERS) {
    const pkg = realpathSync(dirname(req.resolve(`${name}/package.json`)));
    cpSync(pkg, join(dir, 'node_modules', name), { recursive: true, dereference: true });
  }
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = containerCli();
  const dir = stageContext();
  try {
    const build = spawnSync(
      cli,
      ['build', '--pull=missing', '-f', join(dir, 'Containerfile'), '-t', IMAGE, dir],
      {
        stdio: 'inherit',
      },
    );
    if (build.status !== 0) process.exit(build.status ?? 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const inspect = spawnSync(cli, ['image', 'inspect', IMAGE, '--format', '{{.Id}} {{.Size}}'], {
    encoding: 'utf8',
  });
  console.log(`${IMAGE}: ${inspect.stdout.trim()}`);
}
