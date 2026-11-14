// Bills of materials of the release artefacts (SEC-051): built from what ships, compared with the
// lock file, the bundle and the image, and refused on any mismatch.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Policy } from '../licence-policy.ts';
import { analyseBundle } from '../supply-chain/bundle.ts';
import type { LockedPackage } from './lockfile.ts';
import {
  bundleSbom,
  compareTexWithImage,
  compareWithContents,
  compareWithImage,
  compareWithLock,
  createdAt,
  imageSbom,
  npmPackagesOf,
  serviceSbom,
  type SbomContext,
} from './sbom.ts';
import { NOASSERTION, spdxId, validateDocument, type SpdxDocument } from './spdx.ts';
import { parseTlmgrInfo } from './texlive.ts';

const root = mkdtempSync(join(tmpdir(), 'docedit-sbom-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (path: string, content: string | object) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
};
put('node_modules/lib-a/package.json', { name: 'lib-a', version: '1.2.3', license: 'MIT' });
put('node_modules/lib-a/index.js', 'export const a = 1;');
put('node_modules/lib-b/package.json', {
  name: 'lib-b',
  version: '2.0.0',
  license: 'GPL-3.0-only',
});
put('node_modules/lib-b/data.bin', 'DATA-B');
put('packages/model/package.json', { name: '@docedit/model', version: '0.0.0' });
put('packages/model/src/m.ts', '');
put('pkg/package.json', {
  name: '@docedit/fixture',
  version: '0.0.0',
  devDependencies: { 'lib-b': '2.0.0' },
});
put('pkg/src/main.ts', '');
put('pkg/dist/app.js', 'const a=1;\n//# sourceMappingURL=app.js.map\n');
put('pkg/dist/app.js.map', {
  version: 3,
  sources: ['../src/main.ts', '../../node_modules/lib-a/index.js', '../../packages/model/src/m.ts'],
  mappings: 'AAAA,ECAA,EAAA,ECAA',
});
put('pkg/dist/data.bin', 'DATA-B');

const contents = analyseBundle(join(root, 'pkg/dist'), { ownPackageDir: join(root, 'pkg') });
const integrity = (n: number) => `sha512-${Buffer.alloc(64, n).toString('base64')}`;
const lock = new Map<string, LockedPackage>([
  ['lib-a@1.2.3', { name: 'lib-a', version: '1.2.3', integrity: integrity(1) }],
  ['lib-b@2.0.0', { name: 'lib-b', version: '2.0.0', integrity: integrity(2) }],
  ['lib-c@3.0.0', { name: 'lib-c', version: '3.0.0', integrity: integrity(3) }],
]);
const policy: Policy = { allow: ['MIT', 'Apache-2.0'], fontsOnly: [], dataOnly: [], deny: ['GPL'] };
const ctx = (over: Partial<SbomContext> = {}): SbomContext => ({
  version: '0.1.0',
  created: '2026-11-06T00:00:00Z',
  namespaceBase: 'https://docedit.invalid/spdx',
  projectLicence: 'Apache-2.0',
  sourceLocation: NOASSERTION,
  lock,
  policy,
  exceptions: [
    {
      package: 'lib-b',
      licence: 'GPL-3.0-only',
      reason: 'test only',
      decision: 'ADR 9999',
      expires: '2027-01-01',
    },
  ],
  today: '2026-11-06',
  ...over,
});
const walk = [
  { name: 'lib-a', version: '1.2.3', path: join(root, 'node_modules/lib-a'), licence: 'MIT' },
  { name: 'lib-c', version: '3.0.0', path: null, licence: 'MIT' },
];

describe('the bundle’s bill', () => {
  const r = bundleSbom({
    id: 'fixture',
    packageName: '@docedit/fixture',
    contents,
    walk,
    tarball: {
      sha256: 'd'.repeat(64),
      sha512: 'e'.repeat(128),
      fileName: 'docedit-fixture-0.1.0.tgz',
    },
    ctx: ctx(),
  });

  it('describes the artefact with every file, its verification code and the tarball’s checksums', () => {
    expect(r.problems).toEqual([]);
    expect(validateDocument(r.doc)).toEqual([]);
    const described = r.doc.packages[0]!;
    expect(described).toMatchObject({
      name: '@docedit/fixture',
      versionInfo: '0.1.0',
      filesAnalyzed: true,
      licenseDeclared: 'Apache-2.0',
      packageFileName: 'docedit-fixture-0.1.0.tgz',
    });
    expect(described.packageVerificationCode?.packageVerificationCodeValue).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(r.doc.files?.map((f) => f.fileName)).toEqual(['./app.js', './app.js.map', './data.bin']);
  });

  it('lists every bundled package, licence as declared and as concluded, checksum from the lock file', () => {
    const a = r.doc.packages.find((p) => p.name === 'lib-a')!;
    expect(a).toMatchObject({
      versionInfo: '1.2.3',
      licenseDeclared: 'MIT',
      licenseConcluded: 'MIT',
      downloadLocation: 'https://registry.npmjs.org/lib-a/-/lib-a-1.2.3.tgz',
      checksums: [{ algorithm: 'SHA512', checksumValue: '01'.repeat(64) }],
      externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/lib-a@1.2.3' }],
    });
    expect(r.doc.packages.find((p) => p.name === 'lib-b')?.comment).toMatch(
      /licence exception ADR 9999/,
    );
    expect(r.doc.packages.find((p) => p.name === '@docedit/model')).toMatchObject({
      versionInfo: '0.1.0',
      licenseConcluded: 'Apache-2.0',
    });
    expect([...npmPackagesOf(r.doc)].sort()).toEqual([
      '@docedit/fixture@0.1.0',
      '@docedit/model@0.1.0',
      'lib-a@1.2.3',
      'lib-b@2.0.0',
    ]);
  });

  it('notes what the licence gate’s walk does not see, and what the bundle leaves out', () => {
    expect(r.notes[0]).toMatch(
      /^lib-b@2\.0\.0 is in the bundle but is not a production dependency/,
    );
    expect(r.notes[1]).toBe(
      '1 production dependencies are not in the bundle (build-time or tree-shaken): lib-c@3.0.0',
    );
  });

  it('matches the lock file and the bundle', () => {
    expect(compareWithLock(r.doc, lock, '0.1.0')).toEqual([]);
    expect(compareWithContents(r.doc, contents, '@docedit/fixture')).toEqual([]);
  });

  it('refuses a package missing from the lock file or a licence the gate refuses', () => {
    const noLock = bundleSbom({
      id: 'fixture',
      packageName: '@docedit/fixture',
      contents,
      walk,
      ctx: ctx({ lock: new Map() }),
    });
    expect(noLock.problems).toContain('lib-a@1.2.3 is not in pnpm-lock.yaml');
    const noException = bundleSbom({
      id: 'fixture',
      packageName: '@docedit/fixture',
      contents,
      walk,
      ctx: ctx({ exceptions: [] }),
    });
    expect(noException.problems).toContain(
      'lib-b@2.0.0: licence GPL-3.0-only is not on the allow-list',
    );
    expect(noException.doc.packages.find((p) => p.name === 'lib-b')?.licenseConcluded).toBe(
      NOASSERTION,
    );
  });

  it('fails the comparison on any difference', () => {
    const tampered = structuredClone(r.doc);
    tampered.packages.find((p) => p.name === 'lib-a')!.checksums![0]!.checksumValue = 'f'.repeat(
      128,
    );
    tampered.packages = tampered.packages.filter((p) => p.name !== 'lib-b');
    tampered.packages.push({
      ...tampered.packages[1]!,
      SPDXID: spdxId('npm', 'ghost', '1.0.0'),
      name: 'ghost',
      versionInfo: '1.0.0',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: 'pkg:npm/ghost@1.0.0',
        },
      ],
    });
    tampered.files = tampered.files!.filter((f) => f.fileName !== './data.bin');
    tampered.files[0]!.checksums[1]!.checksumValue = '0'.repeat(64);
    expect(compareWithLock(tampered, lock, '0.1.0')).toEqual([
      "lib-a@1.2.3: the bill's SHA512 checksum differs from pnpm-lock.yaml",
      'ghost@1.0.0 is in the bill but not in pnpm-lock.yaml',
    ]);
    expect(compareWithContents(tampered, contents, '@docedit/fixture').sort()).toEqual(
      [
        'app.js: SHA-256 in the bill differs from the file',
        'data.bin is in the bundle but not in its bill',
        'ghost@1.0.0 is in the bill but not in the bundle',
        'lib-b@2.0.0 is in the bundle but not in its bill',
      ].sort(),
    );
    expect(compareWithLock(r.doc, lock, '0.2.0')).toContain(
      '@docedit/fixture: version 0.1.0 in the bill, 0.2.0 in the release',
    );
  });

  it('reports bundle files no package explains', () => {
    put('pkg/dist/stray.bin', 'stray');
    const c = analyseBundle(join(root, 'pkg/dist'), { ownPackageDir: join(root, 'pkg') });
    expect(
      bundleSbom({ id: 'fixture', packageName: '@docedit/fixture', contents: c, walk, ctx: ctx() })
        .problems,
    ).toEqual(['stray.bin: no package explains this file of the bundle']);
    rmSync(join(root, 'pkg/dist/stray.bin'));
  });
});

describe('the service’s bill', () => {
  it('lists the workspace packages and the walk as dependencies of the service', () => {
    const r = serviceSbom({
      id: 'svc',
      packageName: '@docedit/svc',
      workspace: ['@docedit/svc', '@docedit/model'],
      walk,
      ctx: ctx(),
    });
    expect(r.problems).toEqual([]);
    expect(r.doc.packages[0]).toMatchObject({
      name: '@docedit/svc',
      primaryPackagePurpose: 'APPLICATION',
    });
    expect(r.doc.relationships.filter((x) => x.relationshipType === 'DEPENDS_ON')).toHaveLength(3);
    expect(compareWithLock(r.doc, lock, '0.1.0')).toEqual([]);
  });
});

describe('the image’s bill', () => {
  const syft: SpdxDocument = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'image',
    documentNamespace: 'https://anchore.com/syft/image/x',
    creationInfo: { created: '2026-11-06T00:00:00Z', creators: ['Tool: syft'] },
    packages: [
      {
        SPDXID: 'SPDXRef-DocumentRoot-Image-x',
        name: 'x',
        downloadLocation: NOASSERTION,
        filesAnalyzed: false,
        licenseConcluded: NOASSERTION,
        licenseDeclared: NOASSERTION,
        copyrightText: NOASSERTION,
      },
      {
        SPDXID: 'SPDXRef-Package-deb-libc6',
        name: 'libc6',
        versionInfo: '2.41',
        downloadLocation: NOASSERTION,
        filesAnalyzed: false,
        licenseConcluded: NOASSERTION,
        licenseDeclared: 'LicenseRef-glibc',
        copyrightText: NOASSERTION,
      },
      {
        SPDXID: 'SPDXRef-Package-npm-lib-a',
        name: 'lib-a',
        versionInfo: '1.2.3',
        downloadLocation: NOASSERTION,
        filesAnalyzed: false,
        licenseConcluded: NOASSERTION,
        licenseDeclared: 'MIT',
        copyrightText: NOASSERTION,
        externalRefs: [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: 'pkg:npm/lib-a@1.2.3',
          },
        ],
      },
      {
        SPDXID: 'SPDXRef-Package-npm-extra',
        name: 'extra',
        versionInfo: '9.0.0',
        downloadLocation: NOASSERTION,
        filesAnalyzed: false,
        licenseConcluded: NOASSERTION,
        licenseDeclared: 'MIT',
        copyrightText: NOASSERTION,
        externalRefs: [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: 'pkg:npm/extra@9.0.0',
          },
        ],
      },
    ],
    relationships: [
      {
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: 'SPDXRef-DocumentRoot-Image-x',
      },
    ],
    hasExtractedLicensingInfos: [{ licenseId: 'LicenseRef-glibc', extractedText: 'glibc' }],
  };
  const tex = parseTlmgrInfo(
    'luatex,TLCore,77000,1.24.0,gpl2+\nfontspec,Package,76000,2.9e,lppl1.3c',
  );
  const r = imageSbom({
    id: 'export-worker',
    image: 'ghcr.io/owner/docedit-export-worker',
    digest: `sha256:${'a'.repeat(64)}`,
    syft,
    tex,
    fonts: null,
    ctx: ctx(),
  });

  it('puts Syft’s packages, TeX Live and fonts under one image package', () => {
    expect(r.problems).toEqual([]);
    expect(r.doc.packages[0]).toMatchObject({
      name: 'ghcr.io/owner/docedit-export-worker',
      primaryPackagePurpose: 'CONTAINER',
      checksums: [{ algorithm: 'SHA256', checksumValue: 'a'.repeat(64) }],
    });
    expect(r.doc.packages.map((p) => p.name).sort()).toEqual([
      'extra',
      'fontspec',
      'ghcr.io/owner/docedit-export-worker',
      'lib-a',
      'libc6',
      'luatex',
    ]);
    expect(r.doc.hasExtractedLicensingInfos?.map((x) => x.licenseId)).toEqual(['LicenseRef-glibc']);
  });

  it('compares the service’s npm packages and TeX Live with what the image holds', () => {
    const declared = serviceSbom({
      id: 'svc',
      packageName: '@docedit/svc',
      workspace: ['@docedit/svc'],
      walk,
      ctx: ctx(),
    }).doc;
    expect(compareWithImage(declared, syft).sort()).toEqual([
      'extra@9.0.0 is in the image but not among the declared dependencies',
      'lib-c@3.0.0 is a declared dependency but is not in the image',
    ]);
    expect(compareTexWithImage(r.doc, tex)).toEqual([]);
    expect(compareTexWithImage(r.doc, parseTlmgrInfo('luatex,TLCore,77000,1.24.0,gpl2+'))).toEqual([
      'TeX Live package fontspec 2.9e is in the bill but not in the image',
    ]);
  });

  it('refuses a malformed digest', () => {
    expect(
      imageSbom({ id: 'x', image: 'ghcr.io/o/x', digest: 'sha256:abc', ctx: ctx() }).problems[0],
    ).toMatch(/is not sha256:<64 hex>/);
  });

  it('dates documents from SOURCE_DATE_EPOCH seconds', () => {
    expect(createdAt(0)).toBe('1970-01-01T00:00:00Z');
    expect(createdAt(1_762_387_200)).toBe('2025-11-06T00:00:00Z');
  });
});
