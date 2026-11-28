// The licence manifest and the source offer of the export worker image (SEC-053 criterion 3;
// EXP-073 criteria 3 and 4). The inputs are what image.ts reads from a built image; here they are
// small fixed samples, and `services/export-worker/src/sec-053-licence-manifest.podman.test.ts` builds both from the curated
// image when one is at hand.
import { describe, expect, it } from 'vitest';
import {
  imageLicenceArtefacts,
  isCopyleft,
  licenceManifest,
  parseDpkg,
  sourceOffer,
  type LicenceManifestInput,
} from './licence-manifest.ts';
import { parseTlmgrInfo } from './texlive.ts';

const TLMGR = [
  'amsmath,Package,80868,2.17,lppl1.3c',
  'luatex,TLCore,78022,1.24.0,gpl2',
  'kpathsea,TLCore,77900,6.4.2,lgpl2.1',
  'biber,Package,78000,2.22,artistic2',
  'mystery,Package,1,,',
].join('\n');

const input = (over: Partial<LicenceManifestInput> = {}): LicenceManifestInput => ({
  image: 'ghcr.io/example/export-worker',
  imageId: 'sha256:' + 'a'.repeat(64),
  version: '0.1.0',
  base: 'docker.io/texlive/texlive:latest@sha256:' + 'b'.repeat(64),
  tex: parseTlmgrInfo(TLMGR),
  fonts: {
    families: [{ name: 'Noto Serif', licence: 'OFL-1.1' }],
    math: { name: 'STIX Two Math', licence: 'OFL-1.1' },
    fallback: [{ name: 'Noto Sans Thai', licence: 'OFL-1.1' }],
  } as unknown as LicenceManifestInput['fonts'],
  houseClass: { version: '0.2.23', licence: 'Apache-2.0' },
  baseSystem: parseDpkg(
    [
      'Package: libc6\nStatus: install ok installed\nVersion: 2.42-1\nSource: glibc (2.42-1)',
      'Package: bash\nStatus: install ok installed\nVersion: 5.3-1',
      'Package: gone\nStatus: deinstall ok config-files\nVersion: 1',
    ].join('\n\n'),
  ),
  ...over,
});

describe('licence manifest', () => {
  it('lists every TeX Live package with its catalogue licence, sorted, and the house class', () => {
    const m = licenceManifest(input());
    expect(m.tex.packages.map((p) => p.name)).toEqual([
      'amsmath',
      'biber',
      'kpathsea',
      'luatex',
      'mystery',
    ]);
    expect(m.tex.packages.find((p) => p.name === 'luatex')).toMatchObject({
      licences: ['gpl2'],
      revision: '78022',
      version: '1.24.0',
    });
    expect(m.tex.packageCount).toBe(5);
    expect(m.tex.byLicence).toEqual({
      artistic2: 1,
      gpl2: 1,
      'lgpl2.1': 1,
      'lppl1.3c': 1,
      unknown: 1,
    });
    expect(m.houseClass).toEqual({ name: 'docedit', version: '0.2.23', licence: 'Apache-2.0' });
    expect(m.fonts.map((f) => f.name)).toEqual(['Noto Serif', 'STIX Two Math', 'Noto Sans Thai']);
  });

  it('names a package without a catalogue licence instead of guessing one', () => {
    const m = licenceManifest(input());
    expect(m.tex.unknownLicence).toEqual(['mystery']);
  });

  it('lists the base system packages with their source packages', () => {
    const m = licenceManifest(input());
    expect(m.baseSystem.packages).toEqual([
      { name: 'bash', version: '5.3-1', source: 'bash' },
      { name: 'libc6', version: '2.42-1', source: 'glibc' },
    ]);
  });

  it('marks the GNU-licensed packages as copyleft', () => {
    const m = licenceManifest(input());
    expect(m.copyleft.map((c) => c.name)).toEqual(['kpathsea', 'luatex']);
    expect(isCopyleft(parseTlmgrInfo('x,Package,1,,lppl1.3c')[0]!)).toBe(false);
    expect(isCopyleft(parseTlmgrInfo('x,Package,1,,gpl3+')[0]!)).toBe(true);
  });
});

describe('source offer', () => {
  it('names LuaTeX and its revision, the base image, and how to get the base system source', () => {
    const text = sourceOffer(input());
    expect(text).toContain('| luatex | 1.24.0 | gpl2 | 78022 |');
    expect(text).toContain('svn://tug.org/texlive/trunk');
    expect(text).toContain('docker.io/texlive/texlive:latest@sha256:');
    expect(text).toContain('apt-get source');
    expect(text).toContain('2 Debian packages');
    expect(text).not.toContain('| amsmath |');
  });

  it('says so when the image holds no GNU-licensed TeX Live package', () => {
    const text = sourceOffer(input({ tex: parseTlmgrInfo('amsmath,Package,1,2.17,lppl1.3c') }));
    expect(text).toContain('| none | | | |');
  });
});

describe('what a release lists for an image', () => {
  const rec = { id: 'export-worker', licenceManifest: 'm.json', sourceOffer: 'o.md' };
  it('lists the licence manifest and the source offer next to the bill of materials', () => {
    const r = imageLicenceArtefacts(rec, true);
    expect(r.problems).toEqual([]);
    expect(r.files).toEqual([
      { file: 'm.json', kind: 'licence manifest (export-worker image)' },
      { file: 'o.md', kind: 'source offer (export-worker image)' },
    ]);
  });
  it('fails an image that holds TeX Live and records neither or only one', () => {
    expect(imageLicenceArtefacts({ id: 'export-worker' }, true).problems).toHaveLength(1);
    expect(
      imageLicenceArtefacts({ id: 'export-worker', licenceManifest: 'm.json' }, true).problems,
    ).toHaveLength(1);
  });
  it('asks nothing of an image without TeX Live', () => {
    const r = imageLicenceArtefacts({ id: 'asset-worker' }, false);
    expect(r).toEqual({ files: [], problems: [] });
  });
});

describe('licences that the Catalogue does not state', () => {
  const tex = parseTlmgrInfo(
    [
      'luatex,TLCore,78022,1.24.0,gpl2',
      'luatex.x86_64-linux,TLCore,78022,,',
      'luahbtex,TLCore,78022,,',
      'luahbtex.x86_64-linux,TLCore,78022,,',
      'hyph-utf8,Package,1,,mit',
      'hyphen-german,Package,1,,',
      'texlive.infra,TLCore,1,,',
    ].join('\n'),
  );
  it('gives binaries, hyphenation patterns and the HarfBuzz build the licence of their parent, and says so', () => {
    const m = licenceManifest(input({ tex }));
    const get = (n: string) => m.tex.packages.find((p) => p.name === n)!;
    // The reader of tlmgr output already gives a binary package the licence of its package.
    expect(get('luatex.x86_64-linux')).toMatchObject({ licences: ['gpl2'] });
    expect(get('luahbtex')).toMatchObject({ licences: ['gpl2'], licenceFrom: 'luatex' });
    expect(get('luahbtex.x86_64-linux')).toMatchObject({
      licences: ['gpl2'],
      licenceFrom: 'luatex',
    });
    expect(get('hyphen-german')).toMatchObject({ licences: ['mit'], licenceFrom: 'hyph-utf8' });
    expect(get('luatex').licenceFrom).toBeUndefined();
  });
  it('lists what is still without a licence and does not guess one', () => {
    const m = licenceManifest(input({ tex }));
    expect(m.tex.unknownLicence).toEqual(['texlive.infra']);
    expect(m.copyleft.map((c) => c.name)).toEqual([
      'luahbtex',
      'luahbtex.x86_64-linux',
      'luatex',
      'luatex.x86_64-linux',
    ]);
  });
});
