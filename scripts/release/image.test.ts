// Release images (FND-012 criterion 3, SEC-052): reproducible Podman builds, pushed by digest.
import { describe, expect, it } from 'vitest';
import { buildArgs, imageSbomName, normaliseId, pushArgs, TLMGR_FIELDS } from './image.ts';

describe('release images', () => {
  it('build with every timestamp set to SOURCE_DATE_EPOCH, the second time without the cache', () => {
    expect(
      buildArgs(
        'services/x/Containerfile',
        'services/x/image',
        'localhost/x:1.0.0',
        1_762_387_200,
        false,
      ),
    ).toEqual([
      'build',
      '--timestamp',
      '1762387200',
      '-f',
      'services/x/Containerfile',
      '-t',
      'localhost/x:1.0.0',
      'services/x/image',
    ]);
    expect(buildArgs('C', '.', 't', 0, true)).toContain('--no-cache');
    expect(() => buildArgs('C', '.', 't', Number.NaN, false)).toThrow(/SOURCE_DATE_EPOCH/);
  });

  it('squashes the layers of an image that is curated after the base is built (SEC-053)', () => {
    expect(buildArgs('C', '.', 't', 0, false)).not.toContain('--squash-all');
    expect(buildArgs('C', '.', 't', 0, false, true)).toContain('--squash-all');
  });

  it('push by digest and read the digest back', () => {
    expect(pushArgs('localhost/x:1.0.0', 'ghcr.io/o/x:1.0.0', 'out/x.digest')).toEqual([
      'push',
      '--digestfile',
      'out/x.digest',
      'localhost/x:1.0.0',
      'docker://ghcr.io/o/x:1.0.0',
    ]);
    expect(normaliseId(`${'a'.repeat(64)}\n`)).toBe(`sha256:${'a'.repeat(64)}`);
    expect(normaliseId(`sha256:${'b'.repeat(64)}`)).toBe(`sha256:${'b'.repeat(64)}`);
    expect(() => normaliseId('abc')).toThrow(/not an image identifier/);
  });

  it('name the bill after the image and read the TeX Live fields the bill needs', () => {
    expect(imageSbomName('docedit-export-worker', '0.2.0')).toBe(
      'docedit-export-worker-0.2.0.image.spdx.json',
    );
    expect(TLMGR_FIELDS).toBe('name,category,localrev,cat-version,cat-license');
  });
});
