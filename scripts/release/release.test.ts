// The release pipeline's pieces (FND-012): names, the published manifest, checksums, presence.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISTRIBUTABLES, presence } from './distributables.ts';
import { finaliseManifest, finaliseNotes } from './finalise.ts';
import { renderNotices } from './notices.ts';
import { IMAGES_MARKER, renderReleaseNotes, type NotesInput } from './notes.ts';
import { artefactName, npmManifest, sha256sums } from './release.ts';

const element = DISTRIBUTABLES.find((d) => d.id === 'element')!;

describe('release artefacts', () => {
  it('are named after the package and the version', () => {
    expect(artefactName(element, '0.2.0', '.spdx.json')).toBe('docedit-element-0.2.0.spdx.json');
  });

  it('publish the element as an ECMAScript module with nothing to install, licence and provenance stated', () => {
    expect(
      npmManifest(element, '0.2.0', { description: 'The element.' }, 'https://github.com/o/r'),
    ).toEqual({
      name: '@docedit/element',
      version: '0.2.0',
      description: 'The element.',
      type: 'module',
      license: 'Apache-2.0',
      exports: { '.': './doc-editor.js', './package.json': './package.json' },
      sideEffects: true,
      repository: {
        type: 'git',
        url: 'git+https://github.com/o/r.git',
        directory: 'packages/element',
      },
      publishConfig: { access: 'public', provenance: true },
    });
    expect(npmManifest(element, '0.2.0', {})).not.toHaveProperty('repository');
  });

  it('are listed in sha256sum format, sorted', () => {
    expect(
      sha256sums([
        { file: 'b', sha256: '2'.repeat(64) },
        { file: 'a', sha256: '1'.repeat(64) },
      ]),
    ).toBe(`${'1'.repeat(64)}  a\n${'2'.repeat(64)}  b\n`);
  });
});

describe('publishing a draft', () => {
  const draft: NotesInput = {
    version: '0.2.0',
    date: '2026-11-06',
    dryRun: false,
    previous: null,
    compatibility: { protocol: null, cdm: null, rules: null, embedding: null, kit: null },
    artefacts: [],
    images: [],
    missing: [
      'export-worker image (services/export-worker/Containerfile): built twice and compared by the release workflow',
      'asset-worker: services/asset-worker does not exist yet',
    ],
    changes: [],
    coverage: [],
  };
  const image = {
    id: 'export-worker',
    image: 'ghcr.io/o/docedit-export-worker',
    digest: `sha256:${'a'.repeat(64)}`,
    sbom: 'docedit-export-worker-0.2.0.image.spdx.json',
  };

  it('puts the pushed images where the draft left their marker, and drops them from what is missing', () => {
    const notes = renderReleaseNotes(draft);
    expect(notes).toContain(IMAGES_MARKER);
    const done = finaliseNotes(notes, [image]);
    expect(done).not.toContain(IMAGES_MARKER);
    expect(done).toContain(
      `| \`ghcr.io/o/docedit-export-worker\` (export-worker) | \`sha256:${'a'.repeat(64)}\` | \`docedit-export-worker-0.2.0.image.spdx.json\` |`,
    );
    expect(done).not.toContain('- export-worker image (');
    expect(done).toContain('- asset-worker: services/asset-worker does not exist yet');
    expect(() => finaliseNotes(done, [image])).toThrow(/no images marker/);
    const onlyImages = finaliseNotes(
      renderReleaseNotes({ ...draft, missing: [draft.missing[0]!] }),
      [image],
    );
    expect(onlyImages).not.toContain('## Not in this release');
  });

  it('records the images and their bills in the manifest', () => {
    const sbom = {
      file: image.sbom,
      kind: 'SPDX 2.3 bill of materials (export-worker image)',
      size: 1,
      sha256: 'b'.repeat(64),
    };
    const m = finaliseManifest(
      { images: [], missing: [...draft.missing], artefacts: [] },
      [image],
      [sbom],
    );
    expect(m).toEqual({
      images: [image],
      missing: ['asset-worker: services/asset-worker does not exist yet'],
      artefacts: [sbom],
    });
  });
});

describe('distributables', () => {
  it('build an image only when its Containerfile and context exist, and say what is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'docedit-dist-'));
    try {
      const put = (path: string, text: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put('packages/element/package.json', '{}');
      put('services/export-worker/package.json', '{}');
      put('services/export-worker/Containerfile', 'FROM scratch');
      put('services/document-service/package.json', '{}');
      const p = presence(root);
      expect(p.present.map((d) => d.id)).toEqual(['element', 'document-service', 'export-worker']);
      expect(p.images.map((i) => [i.id, i.context])).toEqual([
        ['export-worker', 'services/export-worker/image'],
      ]);
      expect(p.missing).toEqual([
        'document-service image: services/document-service/Containerfile does not exist yet',
        'asset-worker: services/asset-worker does not exist yet',
      ]);
      put('services/document-service/Containerfile', 'FROM scratch');
      expect(presence(root).missing[0]).toBe(
        'document-service image: services/document-service/Containerfile exists, but its build context is not set in scripts/release/distributables.ts',
      );
      // An image whose context the service's build script stages has no context of its own.
      put('services/asset-worker/package.json', '{}');
      put('services/asset-worker/Containerfile', 'FROM scratch');
      const staged = presence(root).images.find((i) => i.id === 'asset-worker');
      expect(staged).toMatchObject({ context: null, stage: { export: 'stageContext' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('third-party notices', () => {
  it('carry every licence and notice file, and say when a package has none', () => {
    const root = mkdtempSync(join(tmpdir(), 'docedit-notices-'));
    try {
      mkdirSync(join(root, 'a'));
      writeFileSync(join(root, 'a', 'LICENSE'), 'MIT text\n');
      writeFileSync(join(root, 'a', 'NOTICE.md'), 'notice text');
      writeFileSync(join(root, 'a', 'index.js'), '');
      mkdirSync(join(root, 'b'));
      const r = renderNotices('@docedit/x 0.2.0', [
        {
          name: 'b',
          version: '1.0.0',
          licence: 'MIT',
          dir: join(root, 'b'),
          exception: 'FND-011: no licence file',
        },
        { name: 'a', version: '2.0.0', licence: 'MIT', dir: join(root, 'a') },
      ]);
      expect(r.text).toContain(
        '## a 2.0.0\n\nLicence: MIT\n\n```\nMIT text\n```\n\n```\nnotice text\n```',
      );
      expect(r.text).toContain(
        '## b 1.0.0\n\nLicence: MIT\n\nThe published package has no licence or notice file. Recorded decision: FND-011: no licence file',
      );
      expect(r.text.indexOf('## a')).toBeLessThan(r.text.indexOf('## b'));
      expect(r.withoutFiles).toEqual(['b@1.0.0']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
