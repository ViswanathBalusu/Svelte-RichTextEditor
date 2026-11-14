// The lock file reader (SEC-051): versions and integrity of every resolved package.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { integrityOf, integrityToHex, parseLockfile, splitKey } from './lockfile.ts';

const LOCK = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.18.0
        version: 12.18.0

packages:

  '@pnpm/exe@12.18.0':
    resolution: {integrity: sha512-AAAA}
    cpu: [x64]

---
lockfileVersion: '9.0'

importers:

  packages/model:
    dependencies:
      prosemirror-model:
        specifier: 1.25.12
        version: 1.25.12

packages:

  '@jridgewell/gen-mapping@0.3.13':
    resolution: {integrity: sha512-${Buffer.alloc(64, 1).toString('base64')}}

  acorn@8.19.0:
    resolution: {integrity: sha512-${Buffer.alloc(64, 2).toString('base64')}}
    engines: {node: '>=0.4.0'}
    hasBin: true

  local-thing@1.0.0:
    resolution: {directory: ../x, type: directory}

snapshots:

  acorn@8.19.0: {}
`;

describe('pnpm-lock.yaml', () => {
  const lock = parseLockfile(LOCK);

  it('reads the packages of both YAML documents, and nothing from importers or snapshots', () => {
    expect([...lock.keys()].sort()).toEqual([
      '@jridgewell/gen-mapping@0.3.13',
      '@pnpm/exe@12.18.0',
      'acorn@8.19.0',
      'local-thing@1.0.0',
    ]);
    expect(lock.get('acorn@8.19.0')).toEqual({
      name: 'acorn',
      version: '8.19.0',
      integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
    });
    expect(lock.get('local-thing@1.0.0')?.integrity).toBeNull();
  });

  it('splits scoped keys and drops peer suffixes', () => {
    expect(splitKey('@scope/name@1.2.3')).toEqual({ name: '@scope/name', version: '1.2.3' });
    expect(splitKey('svelte@5.57.3(@typescript-eslint/types@8.72.1)')).toEqual({
      name: 'svelte',
      version: '5.57.3',
    });
    expect(splitKey('noversion')).toBeNull();
  });

  it('turns integrity strings into hexadecimal digests and back', () => {
    const data = Buffer.from('hello');
    const sri = integrityOf(data);
    expect(integrityToHex(sri)).toEqual({
      algorithm: 'SHA512',
      hex: '9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043',
    });
    expect(integrityToHex('sha512-AAAA')).toBeNull();
    expect(integrityToHex('md5-AAAA')).toBeNull();
  });

  it('reads the workspace lock file', () => {
    const real = parseLockfile(
      readFileSync(resolve(import.meta.dirname, '../../pnpm-lock.yaml'), 'utf8'),
    );
    expect(real.size).toBeGreaterThan(100);
    for (const p of real.values())
      if (p.integrity) expect(integrityToHex(p.integrity), `${p.name}@${p.version}`).not.toBeNull();
  });
});
