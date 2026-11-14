/**
 * Builds the export worker image with Podman (spike S4):
 *
 *   node services/export-worker/scripts/build-image.ts
 *
 * The build context is services/export-worker/image; the image definition is
 * services/export-worker/Containerfile. The tag is DOCEDIT_EXPORT_IMAGE or the default of
 * src/sandbox.ts. Prints the image identifier and size.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerCli } from '../src/container.ts';
import { IMAGE } from '../src/sandbox.ts';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cli = containerCli();
const build = spawnSync(
  cli,
  ['build', '-f', join(root, 'Containerfile'), '-t', IMAGE, join(root, 'image')],
  {
    stdio: 'inherit',
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const inspect = spawnSync(cli, ['image', 'inspect', IMAGE, '--format', '{{.Id}} {{.Size}}'], {
  encoding: 'utf8',
});
console.log(`${IMAGE}: ${inspect.stdout.trim()}`);
