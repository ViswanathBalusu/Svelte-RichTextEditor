// Notices inside a release image (FND-011 criterion 3; ADR 0044 §4).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DISTRIBUTABLES } from './distributables.ts';
import { addNoticesLayer, buildArgs, releaseFile } from './image.ts';
import {
  overlayContainerfile,
  readServiceNotices,
  stageOverlayContext,
  texliveNotices,
} from './image-notices.ts';
import type { FontManifest, TexPackage } from './texlive.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnd-011-w5-layer-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const face = (file: string) => ({ file, sha256: 'a'.repeat(64) });
const fonts: FontManifest = {
  version: 1,
  families: [
    {
      name: 'Example Serif',
      licence: 'OFL-1.1',
      regular: face('r.ttf'),
      bold: face('b.ttf'),
      italic: face('i.ttf'),
      boldItalic: face('bi.ttf'),
    },
  ],
  math: { name: 'Example Math', file: 'm.otf', sha256: 'b'.repeat(64), licence: 'OFL-1.1' },
};
const tex: TexPackage[] = [
  {
    name: 'unicode-math',
    category: 'Package',
    revision: '71',
    catalogueVersion: '0.8q',
    licences: ['lppl1.3c'],
  },
  { name: 'amsmath', category: 'Package', revision: '12', catalogueVersion: '', licences: [] },
];

describe('the notices layer of a release image', () => {
  it('copies NOTICE and the third-party notices to /opt/docedit on top of the built image', () => {
    expect(overlayContainerfile('localhost/docedit-x:1.0.0-base')).toBe(
      'FROM localhost/docedit-x:1.0.0-base\nCOPY NOTICE THIRD-PARTY-NOTICES.md /opt/docedit/\n',
    );
    expect(() => overlayContainerfile('x\nRUN evil')).toThrow(/not an image reference/);
  });

  it('stages the layer context from the repository NOTICE and the given notices', () => {
    const dir = scratch();
    const file = stageOverlayContext(dir, { base: 'localhost/x:1', root: ROOT, thirdParty: 'T\n' });
    expect(file).toBe(join(dir, 'Containerfile'));
    expect(readFileSync(join(dir, 'NOTICE'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'NOTICE'), 'utf8'),
    );
    expect(readFileSync(join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toBe('T\n');
    expect(readFileSync(file, 'utf8')).toContain('FROM localhost/x:1\n');
  });

  it('is built with the same fixed timestamp as the image', () => {
    const args = buildArgs('C/Containerfile', 'C', 'localhost/x:1', 1_762_387_200, false);
    expect(args.slice(0, 3)).toEqual(['build', '--timestamp', '1762387200']);
  });

  it('names the service notices file as the release does and refuses a missing one', () => {
    const dir = scratch();
    const name = releaseFile({ packageName: '@docedit/document-service' }, '1.2.3', '.notices.md');
    expect(name).toBe('docedit-document-service-1.2.3.notices.md');
    expect(() => readServiceNotices(join(dir, name))).toThrow(/does not exist/);
    writeFileSync(join(dir, name), '# notices\n');
    expect(readServiceNotices(join(dir, name))).toBe('# notices\n');
  });

  it('lists the TeX Live packages and the fonts that were read inside the export image', () => {
    const text = texliveNotices('@docedit/export-worker 1.2.3', tex, fonts);
    expect(text).toContain('# Third-party notices for @docedit/export-worker 1.2.3');
    expect(text).toContain('| amsmath | r12 | not stated in the catalogue |');
    expect(text).toContain('| unicode-math | 0.8q | lppl1.3c |');
    // Sorted by name.
    expect(text.indexOf('| amsmath')).toBeLessThan(text.indexOf('| unicode-math'));
    expect(text).toContain('| Example Serif | OFL-1.1 | r.ttf, b.ttf, i.ttf, bi.ttf |');
    expect(text).toContain('| Example Math | OFL-1.1 | m.otf |');
    expect(texliveNotices('t', [], null)).toContain('The image lists no fonts.');
  });

  it('covers every image of the release: the asset worker writes its own, the others get the layer', () => {
    const withFile = DISTRIBUTABLES.filter((d) => d.kind === 'service' && d.image);
    expect(withFile.map((d) => d.id).sort()).toEqual([
      'asset-worker',
      'document-service',
      'export-worker',
    ]);
    for (const d of withFile) {
      if (d.noticesInContext) {
        // Its context writes both files, which a test of the service checks in the built image.
        expect(d.id).toBe('asset-worker');
        expect(readFileSync(join(ROOT, d.containerfile!), 'utf8')).toMatch(
          /^COPY NOTICE THIRD-PARTY-NOTICES\.md \/opt\/docedit\/$/m,
        );
      }
    }
  });
});

const cli = process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
const probe = spawnSync(cli, ['info', '--format', '{{.Host.Arch}}'], { encoding: 'utf8' });
const reason = probe.status === 0 ? null : `${cli} is not available`;

describe('the notices layer in a real image', () => {
  it.skipIf(reason !== null)(
    `holds both files at /opt/docedit/${reason ? ` (skipped: ${reason})` : ''}`,
    () => {
      const tag = 'localhost/docedit-notices-layer-fnd-011-w5';
      const name = 'docedit-notices-layer-fnd-011-w5';
      const run = (...a: string[]) => spawnSync(cli, a, { encoding: 'utf8' });
      try {
        // A base with nothing in it but one file, so that no registry is needed.
        const baseDir = scratch();
        writeFileSync(join(baseDir, 'marker'), 'base\n');
        writeFileSync(join(baseDir, 'Containerfile'), 'FROM scratch\nCOPY marker /marker\n');
        const base = run(
          'build',
          '--timestamp',
          '1762387200',
          '-f',
          join(baseDir, 'Containerfile'),
          '-t',
          `${tag}:base`,
          baseDir,
        );
        expect(base.status, base.stderr).toBe(0);
        const id = addNoticesLayer({
          cli,
          base: `${tag}:base`,
          tag: `${tag}:layer`,
          root: ROOT,
          thirdParty: '# Third-party notices for the probe\n',
          epoch: 1_762_387_200,
          once: false,
        });
        expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
        run('rm', '--force', name);
        const created = run('create', '--name', name, '--network=none', `${tag}:layer`, '/marker');
        expect(created.status, created.stderr).toBe(0);
        const out = scratch();
        for (const [src, dst] of [
          ['/opt/docedit/NOTICE', 'NOTICE'],
          ['/opt/docedit/THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
          ['/marker', 'marker'],
        ] as const) {
          const r = run('cp', `${name}:${src}`, join(out, dst));
          expect(r.status, r.stderr).toBe(0);
        }
        expect(readFileSync(join(out, 'NOTICE'), 'utf8')).toBe(
          readFileSync(join(ROOT, 'NOTICE'), 'utf8'),
        );
        expect(readFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toBe(
          '# Third-party notices for the probe\n',
        );
        // The layer keeps what the service's own image had.
        expect(readFileSync(join(out, 'marker'), 'utf8')).toBe('base\n');
      } finally {
        run('rm', '--force', name);
        run('rmi', '--force', `${tag}:layer`, `${tag}:base`);
      }
    },
    900_000,
  );
});
