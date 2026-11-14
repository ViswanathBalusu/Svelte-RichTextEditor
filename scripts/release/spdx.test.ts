// SPDX 2.3 documents (SEC-051): identifiers, package URLs, determinism and structural validation.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  licenceExpression,
  NOASSERTION,
  npmPurl,
  npmTarballUrl,
  spdxId,
  stringify,
  validateDocument,
  verificationCode,
  type DocumentInput,
  type SpdxPackage,
} from './spdx.ts';

const pkg = (name: string, version: string, over: Partial<SpdxPackage> = {}): SpdxPackage => ({
  SPDXID: spdxId('npm', name, version),
  name,
  versionInfo: version,
  downloadLocation: NOASSERTION,
  filesAnalyzed: false,
  licenseConcluded: 'MIT',
  licenseDeclared: 'MIT',
  copyrightText: NOASSERTION,
  ...over,
});

const input = (): DocumentInput => {
  const root = pkg('@docedit/element', '0.1.0', {
    licenseConcluded: 'Apache-2.0',
    licenseDeclared: 'Apache-2.0',
  });
  const a = pkg('svelte', '5.57.3');
  const b = pkg('prosemirror-model', '1.25.12');
  return {
    name: '@docedit/element-0.1.0',
    namespaceBase: 'https://docedit.invalid/spdx/',
    created: '2026-11-06T10:00:00Z',
    creators: ['Tool: test'],
    describes: [root],
    packages: [a, b],
    relationships: [
      { spdxElementId: root.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: a.SPDXID },
      { spdxElementId: root.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: b.SPDXID },
      { spdxElementId: root.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: a.SPDXID },
    ],
  };
};

describe('identifiers and locators', () => {
  it('derives readable, unique SPDX identifiers', () => {
    const x = spdxId('npm', '@a/b-c', '1.0.0');
    const y = spdxId('npm', '@a-b/c', '1.0.0');
    expect(x).toMatch(/^SPDXRef-npm-a-b-c-1\.0\.0-[0-9a-f]{8}$/);
    expect(x).not.toBe(y);
    expect(spdxId('npm', '@a/b-c', '1.0.0')).toBe(x);
  });

  it('writes package URLs and registry addresses as purl-spec and npm do', () => {
    expect(npmPurl('@docedit/element', '0.1.0')).toBe('pkg:npm/%40docedit/element@0.1.0');
    expect(npmPurl('svelte', '5.57.3')).toBe('pkg:npm/svelte@5.57.3');
    expect(npmPurl('x', '1.0.0+build')).toBe('pkg:npm/x@1.0.0%2Bbuild');
    expect(npmTarballUrl('@jridgewell/gen-mapping', '0.3.13')).toBe(
      'https://registry.npmjs.org/@jridgewell/gen-mapping/-/gen-mapping-0.3.13.tgz',
    );
    expect(npmTarballUrl('acorn', '8.19.0')).toBe(
      'https://registry.npmjs.org/acorn/-/acorn-8.19.0.tgz',
    );
  });

  it('computes the package verification code of SPDX 2.3 §7.9, independent of file order', () => {
    const sha = (s: string) => createHash('sha1').update(s).digest('hex');
    const files = [sha('b'), sha('a'), sha('c')];
    const expected = createHash('sha1')
      .update([...files].sort().join(''))
      .digest('hex');
    expect(verificationCode(files)).toBe(expected);
    expect(verificationCode([...files].reverse())).toBe(expected);
  });

  it('keeps declared licences that are SPDX expressions, NOASSERTION otherwise', () => {
    expect(licenceExpression('MIT')).toBe('MIT');
    expect(licenceExpression('(MIT OR Apache-2.0)')).toBe('MIT OR Apache-2.0');
    expect(licenceExpression('Apache-2.0 WITH LLVM-exception')).toBe(
      'Apache-2.0 WITH LLVM-exception',
    );
    for (const l of ['SEE LICENSE IN LICENSE.md', 'UNKNOWN', 'UNLICENSED', '', undefined])
      expect(licenceExpression(l), String(l)).toBe(NOASSERTION);
  });
});

describe('documents', () => {
  it('are deterministic, describe their artefact first and drop duplicate relationships', () => {
    const one = buildDocument(input());
    expect(stringify(buildDocument(input()))).toBe(stringify(one));
    expect(one.packages[0]!.name).toBe('@docedit/element');
    expect(
      one.packages
        .map((p) => p.name)
        .slice(1)
        .sort(),
    ).toEqual(['prosemirror-model', 'svelte']);
    expect(one.relationships).toHaveLength(3);
    expect(one.relationships.filter((r) => r.relationshipType === 'DESCRIBES')).toHaveLength(1);
    expect(one.documentNamespace).toMatch(
      /^https:\/\/docedit\.invalid\/spdx\/%40docedit%2Felement-0\.1\.0-[0-9a-f]{32}$/,
    );
    expect(validateDocument(one)).toEqual([]);
  });

  it('take their namespace from their content', () => {
    const changed = input();
    changed.packages[0] = pkg('svelte', '5.57.4');
    changed.relationships = [];
    expect(buildDocument(changed).documentNamespace).not.toBe(
      buildDocument(input()).documentNamespace,
    );
  });

  it('are refused when the structure is wrong', () => {
    const doc = buildDocument(input());
    const broken = structuredClone(doc);
    broken.creationInfo.created = '2026-11-06';
    broken.packages.push({ ...broken.packages[1]! });
    broken.packages.push(
      pkg('bad id', '1', {
        SPDXID: 'SPDXRef-bad id',
        licenseDeclared: 'LicenseRef-missing',
        checksums: [{ algorithm: 'SHA256', checksumValue: 'abc' }],
      }),
    );
    broken.packages.push(pkg('analysed', '1', { filesAnalyzed: true }));
    broken.files = [
      {
        SPDXID: 'SPDXRef-file-a',
        fileName: 'a.js',
        checksums: [{ algorithm: 'SHA256', checksumValue: 'f'.repeat(64) }],
      },
    ];
    broken.relationships.push({
      spdxElementId: 'SPDXRef-nowhere',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: doc.packages[0]!.SPDXID,
    });
    const problems = validateDocument(broken);
    for (const want of [
      /created "2026-11-06" is not/,
      /SPDXID .* is not unique/,
      /SPDXID "SPDXRef-bad id" is malformed/,
      /LicenseRef-missing is used but not defined/,
      /SHA256 checksum "abc" is malformed/,
      /filesAnalyzed is true but there is no packageVerificationCode/,
      /fileName must start with \.\//,
      /no SHA1 checksum/,
      /SPDXRef-nowhere is not in the document/,
    ])
      expect(
        problems.some((p) => want.test(p)),
        String(want),
      ).toBe(true);
  });
});
