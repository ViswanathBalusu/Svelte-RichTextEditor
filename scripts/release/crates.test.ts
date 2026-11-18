/**
 * WASM-013 criterion 3: the element's bill of materials lists the crates compiled into the kernel's
 * WebAssembly module, each with its licence and the checksum Cargo.lock gives, and is compared with
 * Cargo.lock. The bundle is a small fixture; the last tests read the real `crates/` workspace when
 * `cargo` is installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Policy } from '../licence-policy.ts';
import { analyseBundle } from '../supply-chain/bundle.ts';
import {
  cargoEntry,
  composeModuleCrates,
  compareCratesWithLock,
  cratesOf,
  moduleCrates,
  type ModuleCrate,
} from './crates.ts';
import { bundleSbom, compareWithContents, type SbomContext } from './sbom.ts';
import { NOASSERTION, validateDocument } from './spdx.ts';

const repo = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'docedit-crates-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (path: string, content: string | object) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
};
put('pkg/package.json', { name: '@docedit/fixture', version: '0.0.0' });
put('pkg/src/main.ts', '');
put('pkg/dist/app.js', 'const a=1;\n//# sourceMappingURL=app.js.map\n');
put('pkg/dist/app.js.map', { version: 3, sources: ['../src/main.ts'], mappings: 'AAAA' });
const contents = analyseBundle(join(dir, 'pkg/dist'), { ownPackageDir: join(dir, 'pkg') });

const policy: Policy = {
  allow: ['MIT', 'Apache-2.0', 'Unicode-3.0'],
  fontsOnly: [],
  dataOnly: [],
  deny: ['GPL'],
};
const ctx: SbomContext = {
  version: '0.1.0',
  created: '2026-11-18T00:00:00Z',
  namespaceBase: 'https://docedit.invalid/spdx',
  projectLicence: 'Apache-2.0',
  sourceLocation: NOASSERTION,
  lock: new Map(),
  policy,
  exceptions: [],
  today: '2026-11-18',
};

const lockText = [
  'version = 4',
  '[[package]]',
  'name = "cfg-if"',
  'version = "1.0.5"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  'checksum = "' + 'a'.repeat(64) + '"',
  '[[package]]',
  'name = "unicode-ident"',
  'version = "1.0.27"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  'checksum = "' + 'b'.repeat(64) + '"',
].join('\n');
const crates: ModuleCrate[] = composeModuleCrates(
  [
    { name: 'cfg-if', version: '1.0.5' },
    { name: 'unicode-ident', version: '1.0.27' },
  ],
  {
    packages: [
      {
        name: 'cfg-if',
        version: '1.0.5',
        license: 'MIT/Apache-2.0',
        manifest_path: '/r/cfg-if/Cargo.toml',
      },
      {
        name: 'unicode-ident',
        version: '1.0.27',
        license: '(MIT OR Apache-2.0) AND Unicode-3.0',
        manifest_path: '/r/unicode-ident/Cargo.toml',
      },
    ],
  },
  lockText,
);

describe('the bill lists the crates of the module', () => {
  const result = bundleSbom({
    id: 'fixture',
    packageName: '@docedit/fixture',
    contents,
    walk: [],
    crates,
    ctx,
  });

  it('adds one package for each crate, with its purl, licence and the locked checksum', () => {
    expect(result.problems).toEqual([]);
    expect(validateDocument(result.doc)).toEqual([]);
    const listed = cratesOf(result.doc);
    expect([...listed]).toEqual([
      ['cfg-if@1.0.5', 'a'.repeat(64)],
      ['unicode-ident@1.0.27', 'b'.repeat(64)],
    ]);
    const unicode = result.doc.packages.find((p) => p.name === 'unicode-ident');
    expect(unicode).toMatchObject({
      versionInfo: '1.0.27',
      licenseDeclared: '(MIT OR Apache-2.0) AND Unicode-3.0',
      licenseConcluded: '(MIT OR Apache-2.0) AND Unicode-3.0',
    });
    expect(unicode?.externalRefs?.[0]?.referenceLocator).toBe('pkg:cargo/unicode-ident@1.0.27');
    // The old `A/B` form of a manifest is written as an SPDX expression.
    expect(result.doc.packages.find((p) => p.name === 'cfg-if')?.licenseDeclared).toBe(
      'MIT OR Apache-2.0',
    );
    expect(
      result.doc.relationships.filter((r) => r.relationshipType === 'CONTAINS').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('matches Cargo.lock, and leaves the crates out of the comparison with the bundle', () => {
    expect(compareCratesWithLock(result.doc, lockText, 2)).toEqual([]);
    expect(compareWithContents(result.doc, contents, '@docedit/fixture')).toEqual([]);
  });

  it('names a crate that is not in the lock, a changed checksum and a missing crate', () => {
    const changed = lockText.replace('b'.repeat(64), 'c'.repeat(64));
    expect(compareCratesWithLock(result.doc, changed, 2)).toEqual([
      "unicode-ident@1.0.27: the bill's checksum differs from Cargo.lock",
    ]);
    const without = lockText.split('[[package]]').slice(0, 2).join('[[package]]');
    expect(compareCratesWithLock(result.doc, without, 2)[0]).toContain(
      'unicode-ident@1.0.27 is in the bill but not in Cargo.lock',
    );
    expect(compareCratesWithLock(result.doc, lockText, 3)).toEqual([
      'the bill lists 2 crates, the module has 3',
    ]);
  });
});

describe('a crate that the policy refuses or the lock does not know is a problem', () => {
  it('refuses a licence that is not allowed and a crate without a checksum', () => {
    const bad: ModuleCrate = {
      name: 'gpl-thing',
      version: '1.0.0',
      licence: 'GPL-3.0-only',
      dir: '',
      checksum: null,
    };
    const { problems } = cargoEntry(bad, policy, [], '2026-11-18');
    expect(problems.some((p) => p.includes('no checksum in Cargo.lock'))).toBe(true);
    expect(problems.some((p) => p.includes('GPL-3.0-only'))).toBe(true);
  });

  it('takes a dual licence whose options are all allowed as it is', () => {
    const ok: ModuleCrate = {
      name: 'x',
      version: '1.0.0',
      licence: 'MIT OR Apache-2.0',
      dir: '',
      checksum: 'd'.repeat(64),
    };
    const { pkg, problems } = cargoEntry(ok, policy, [], '2026-11-18');
    expect(problems).toEqual([]);
    expect(pkg.licenseConcluded).toBe('MIT OR Apache-2.0');
  });
});

const cargoOk = spawnSync(process.env['CARGO'] || 'cargo', ['--version']).status === 0;

describe.skipIf(!cargoOk || !existsSync(join(repo, 'crates/Cargo.lock')))(
  'the real module in crates/',
  () => {
    it('lists the crates cargo links into wasm32-unknown-unknown, without proc-macro crates', () => {
      const real = moduleCrates(join(repo, 'crates'));
      const names = real.map((c) => c.name);
      expect(names).toContain('wasm-bindgen');
      expect(names).toContain('unicode-ident');
      for (const buildTime of ['syn', 'quote', 'proc-macro2', 'wasm-bindgen-macro'])
        expect(names, buildTime).not.toContain(buildTime);
      expect(names).not.toContain('docedit-layout-kernel');
      for (const c of real) {
        expect(c.checksum, c.name).toMatch(/^[0-9a-f]{64}$/);
        expect(c.licence, c.name).not.toBeNull();
      }
      const lock = readFileSync(join(repo, 'crates/Cargo.lock'), 'utf8');
      const doc = bundleSbom({
        id: 'fixture',
        packageName: '@docedit/fixture',
        contents,
        walk: [],
        crates: real,
        ctx: {
          ...ctx,
          policy: JSON.parse(readFileSync(join(repo, 'licences/policy.json'), 'utf8')) as Policy,
        },
      });
      expect(doc.problems).toEqual([]);
      expect(compareCratesWithLock(doc.doc, lock, real.length)).toEqual([]);
    });
  },
);
