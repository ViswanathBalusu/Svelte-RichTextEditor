// The export worker image's TeX Live packages and fonts in its bill (SEC-051 criterion 3).
import { describe, expect, it } from 'vitest';
import {
  fontFiles,
  parseTlmgrInfo,
  texLicenceExpression,
  texLicenceRef,
  texliveEntries,
  type FontManifest,
} from './texlive.ts';

// Lines as `tlmgr info --only-installed --data name,category,localrev,cat-version,cat-license` prints them.
const TLMGR = [
  'luatex,TLCore,77000,1.24.0,gpl2+',
  'luatex.x86_64-linux,TLCore,77001,,',
  'fontspec,Package,76000,2.9e,lppl1.3c',
  'noto,Package,64351,,ofl lppl',
  'collection-basic,Collection,75000,,collection',
  'oddity,Package,1,"1,2",pd',
].join('\n');

const FONTS: FontManifest = {
  version: 1,
  families: [
    {
      name: 'Noto Sans Mono',
      licence: 'OFL-1.1',
      regular: { file: 'aa.ttf', sha256: 'a'.repeat(64) },
      bold: { file: 'bb.ttf', sha256: 'b'.repeat(64) },
      italic: { file: 'aa.ttf', sha256: 'a'.repeat(64) },
      boldItalic: { file: 'bb.ttf', sha256: 'b'.repeat(64) },
    },
  ],
  math: { name: 'STIX Two Math', file: 'cc.otf', sha256: 'c'.repeat(64), licence: 'OFL-1.1' },
};

describe('TeX Live packages', () => {
  const tex = parseTlmgrInfo(TLMGR);

  it('reads tlmgr’s listing, quoted fields included', () => {
    expect(tex.map((p) => p.name)).toEqual([
      'collection-basic',
      'fontspec',
      'luatex',
      'luatex.x86_64-linux',
      'noto',
      'oddity',
    ]);
    expect(tex.find((p) => p.name === 'oddity')).toEqual({
      name: 'oddity',
      category: 'Package',
      revision: '1',
      catalogueVersion: '1,2',
      licences: ['pd'],
    });
  });

  it('gives platform binaries the licences of their package', () => {
    expect(tex.find((p) => p.name === 'luatex.x86_64-linux')?.licences).toEqual(['gpl2+']);
  });

  it('maps catalogue keys to SPDX identifiers only where they are exact', () => {
    expect(texLicenceExpression(['gpl2+']).expression).toBe('GPL-2.0-or-later');
    expect(texLicenceExpression(['lppl1.3c']).expression).toBe('LPPL-1.3c');
    const both = texLicenceExpression(['ofl', 'lppl']);
    expect(both.expression).toBe('LicenseRef-TeXCatalogue-ofl AND LicenseRef-TeXCatalogue-lppl');
    expect([...both.refs.values()]).toEqual(['ofl', 'lppl']);
    expect(texLicenceExpression(['collection']).expression).toBe('NOASSERTION');
    expect(texLicenceRef('gpl3+fe')).toBe('LicenseRef-TeXCatalogue-gpl3-plus-fe');
  });

  it('lists each distinct font file once, with the faces it serves', () => {
    expect(fontFiles(FONTS).map((f) => [f.file, f.faces])).toEqual([
      ['aa.ttf', ['Noto Sans Mono regular', 'Noto Sans Mono italic']],
      ['bb.ttf', ['Noto Sans Mono bold', 'Noto Sans Mono bold italic']],
      ['cc.otf', ['STIX Two Math (math)']],
    ]);
  });

  it('writes entries contained by the image, with licence references defined', () => {
    const e = texliveEntries(tex, FONTS, 'SPDXRef-image');
    expect(e.packages).toHaveLength(tex.length + 3);
    expect(
      e.relationships.every(
        (r) => r.spdxElementId === 'SPDXRef-image' && r.relationshipType === 'CONTAINS',
      ),
    ).toBe(true);
    const luatex = e.packages.find((p) => p.name === 'luatex')!;
    expect(luatex).toMatchObject({
      versionInfo: '1.24.0',
      licenseDeclared: 'GPL-2.0-or-later',
      primaryPackagePurpose: 'APPLICATION',
    });
    expect(e.packages.find((p) => p.name === 'luatex.x86_64-linux')?.versionInfo).toBe('r77001');
    const font = e.packages.find((p) => p.name === 'STIX Two Math (math)')!;
    expect(font).toMatchObject({
      licenseDeclared: 'OFL-1.1',
      checksums: [{ algorithm: 'SHA256', checksumValue: 'c'.repeat(64) }],
    });
    expect(e.licenceRefs.map((r) => r.licenseId).sort()).toEqual([
      'LicenseRef-TeXCatalogue-lppl',
      'LicenseRef-TeXCatalogue-ofl',
      'LicenseRef-TeXCatalogue-pd',
    ]);
    expect(e.licenceRefs[0]!.seeAlsos![0]).toMatch(/^https:\/\/ctan\.org\/license\//);
  });

  it('refuses output it cannot read', () => {
    expect(() => parseTlmgrInfo('justaname')).toThrow(/unreadable line/);
  });
});
