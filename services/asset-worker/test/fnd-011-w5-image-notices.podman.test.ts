/**
 * FND-011 criterion 3, for the asset worker's sandbox image: the staged build context holds the
 * project's NOTICE and third-party notices written from the decoders that go into the image, and
 * the Containerfile copies both in. With Podman, the image is built under a tag of its own and
 * the files are copied back out of it; without Podman that part is skipped, with the reason.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DECODERS, stageContext, thirdPartyNotices } from '../scripts/build-image.ts';
import { containerCli } from '../src/container.ts';

const SERVICE = resolve(import.meta.dirname, '..');
const REPO = resolve(SERVICE, '..', '..');
const TAG = 'localhost/docedit-asset-worker:fnd-011-w5';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('notices in the asset worker image (FND-011 criterion 3)', () => {
  it('stages the NOTICE file and the notices of every decoder', () => {
    const dir = stageContext();
    dirs.push(dir);
    expect(readFileSync(join(dir, 'NOTICE'), 'utf8')).toBe(
      readFileSync(join(REPO, 'NOTICE'), 'utf8'),
    );
    const notices = readFileSync(join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    for (const name of DECODERS) {
      const manifest = JSON.parse(
        readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { version: string; license: string };
      expect(notices).toContain(`## ${name} ${manifest.version}\n\nLicence: ${manifest.license}\n`);
    }
    // Every licence file a decoder publishes is carried in full.
    const pngjs = join(dir, 'node_modules', 'pngjs');
    const licence = ['LICENSE', 'LICENSE.md', 'LICENCE'].find((f) => existsSync(join(pngjs, f)));
    expect(licence).toBeDefined();
    expect(notices).toContain(readFileSync(join(pngjs, licence!), 'utf8').trim());
    expect(notices).toBe(thirdPartyNotices(join(dir, 'node_modules'), DECODERS));
    // Only the decoders are in the image, so only they are named.
    expect(notices.match(/^## /gm)).toHaveLength(DECODERS.length);
  });

  it('the Containerfile copies both files into the image', () => {
    const text = readFileSync(join(SERVICE, 'Containerfile'), 'utf8');
    expect(text).toMatch(/^COPY NOTICE THIRD-PARTY-NOTICES\.md \/opt\/docedit\/$/m);
  });

  const cli = containerCli();
  const podman = spawnSync(cli, ['info', '--format', '{{.Host.Arch}}'], { encoding: 'utf8' });
  const reason = podman.status === 0 ? null : `${cli} is not available`;

  it.skipIf(reason !== null)(
    `the built image holds both files${reason ? ` (skipped: ${reason})` : ''}`,
    () => {
      const dir = stageContext();
      dirs.push(dir);
      try {
        const build = spawnSync(
          cli,
          ['build', '--pull=missing', '-f', join(dir, 'Containerfile'), '-t', TAG, dir],
          { encoding: 'utf8' },
        );
        expect(build.status, build.stderr).toBe(0);
        // The files are copied out of a container that is created and never started.
        const name = 'docedit-asset-notices-fnd-011-w5';
        spawnSync(cli, ['rm', '--force', name], { encoding: 'utf8' });
        const created = spawnSync(cli, ['create', '--name', name, '--network=none', TAG], {
          encoding: 'utf8',
        });
        expect(created.status, created.stderr).toBe(0);
        const out = mkdtempSync(join(tmpdir(), 'fnd-011-w5-'));
        dirs.push(out);
        const read = (file: string) => {
          const r = spawnSync(cli, ['cp', `${name}:/opt/docedit/${file}`, join(out, file)], {
            encoding: 'utf8',
          });
          expect(r.status, r.stderr).toBe(0);
          return readFileSync(join(out, file), 'utf8');
        };
        expect(read('NOTICE')).toBe(readFileSync(join(dir, 'NOTICE'), 'utf8'));
        expect(read('THIRD-PARTY-NOTICES.md')).toBe(
          readFileSync(join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8'),
        );
      } finally {
        spawnSync(cli, ['rm', '--force', 'docedit-asset-notices-fnd-011-w5'], { encoding: 'utf8' });
        spawnSync(cli, ['rmi', '--force', TAG], { encoding: 'utf8' });
      }
    },
    300_000,
  );
});
