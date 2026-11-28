/**
 * The inputs of the worker image, and whether a local image was built from them.
 *
 * `scripts/build-image.ts` labels the image with a hash of the Containerfile and of every file of
 * the build context (`services/export-worker/image`). A tag such as `docedit-export-worker:s4`
 * stays on a developer's machine after the Containerfile changes, so an image can exist and still
 * be older than the sources. The tests that read the image (fonts, curated TeX Live, licence
 * manifest) then fail with a message about the image's content, not about its age. `staleImage`
 * names the cause and the command that fixes it. Line endings are normalised, so a checkout with
 * CRLF and one with LF give the same hash.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerCli } from './container.ts';

/** The label that carries the hash of the inputs. */
export const INPUTS_LABEL = 'docedit.build-inputs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The hash of the Containerfile and the build context, or null when the sources are not here. */
export function buildInputsHash(workerRoot: string = root): string | null {
  const containerfile = join(workerRoot, 'Containerfile');
  const context = join(workerRoot, 'image');
  if (!existsSync(containerfile) || !existsSync(context)) return null;
  const h = createHash('sha256');
  const add = (name: string, file: string): void => {
    const text = readFileSync(file).toString('latin1').replace(/\r\n/g, '\n');
    h.update(`${name}\0${text.length}\0${text}\0`, 'latin1');
  };
  add('Containerfile', containerfile);
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else add(`image/${prefix}${name}`, path);
    }
  };
  walk(context, '');
  return h.digest('hex');
}

/**
 * Why the local image is older than the sources, or null when it is current, when the sources are
 * not here (as inside a container) or when the image has no label. An image with no label was built
 * by another route (infra/test-env.ps1 builds the CI image without it) or before the label existed;
 * it cannot be judged, so it is not refused.
 */
export function staleImage(image: string): string | null {
  const want = buildInputsHash();
  if (want === null) return null;
  const r = spawnSync(
    containerCli(),
    ['image', 'inspect', image, '--format', `{{index .Labels "${INPUTS_LABEL}"}}`],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true },
  );
  if (r.status !== 0) return null;
  const have = r.stdout.trim();
  if (have === '' || have === '<no value>' || have === want) return null;
  return `image ${image} was built from older sources than services/export-worker/Containerfile and image/; rebuild it with: node services/export-worker/scripts/build-image.ts`;
}
