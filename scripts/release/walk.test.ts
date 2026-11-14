// The licence gate's walk per distributable (SEC-051): the closure, the records, the verdicts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exception, Policy } from '../licence-policy.ts';
import { conclude, flattenLicenceList, workspaceClosure } from './walk.ts';

const policy: Policy = {
  allow: ['MIT', 'Apache-2.0', 'ISC'],
  fontsOnly: ['OFL-1.1'],
  dataOnly: ['CC0-1.0'],
  deny: ['GPL', 'AGPL'],
};
const exception = (over: Partial<Exception>): Exception => ({
  package: 'x',
  licence: 'MIT',
  reason: 'r',
  decision: 'ADR 1',
  expires: '2027-01-01',
  ...over,
});

describe('the walk', () => {
  it('flattens pnpm’s licence list into one record per package and version, without our own packages', () => {
    const deps = flattenLicenceList({
      MIT: [
        {
          name: 'b',
          versions: ['1.0.0', '2.0.0'],
          paths: ['/b1', '/b2'],
          license: 'MIT',
          homepage: 'https://b.example',
        },
        { name: '@docedit/model', versions: ['0.0.0'], paths: ['/m'], license: 'Apache-2.0' },
      ],
      ISC: [{ name: 'a', versions: ['3.0.0'], paths: ['/a'], license: 'ISC' }],
    });
    expect(deps).toEqual([
      { name: 'a', version: '3.0.0', path: '/a', licence: 'ISC' },
      { name: 'b', version: '1.0.0', path: '/b1', licence: 'MIT', homepage: 'https://b.example' },
      { name: 'b', version: '2.0.0', path: '/b2', licence: 'MIT', homepage: 'https://b.example' },
    ]);
  });

  it('follows workspace links in production dependencies only', () => {
    const root = mkdtempSync(join(tmpdir(), 'docedit-walk-'));
    try {
      const put = (dir: string, manifest: object) => {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
      };
      put('packages/element', {
        name: '@docedit/element',
        version: '0.0.0',
        dependencies: { '@docedit/engine': 'workspace:*', svelte: '5.57.3' },
        devDependencies: { '@docedit/backend-mock': 'workspace:*' },
      });
      put('packages/engine', {
        name: '@docedit/engine',
        version: '0.0.0',
        dependencies: { '@docedit/model': 'workspace:*' },
      });
      put('packages/model', { name: '@docedit/model', version: '0.0.0' });
      put('packages/backend-mock', { name: '@docedit/backend-mock', version: '0.0.0' });
      expect(workspaceClosure(root, '@docedit/element').map((p) => p.name)).toEqual([
        '@docedit/element',
        '@docedit/engine',
        '@docedit/model',
      ]);
      expect(() => workspaceClosure(root, '@docedit/none')).toThrow(
        /not a package of this workspace/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('licences concluded as the licence gate decides', () => {
  const today = '2026-11-06';
  it('concludes an allowed licence as declared', () => {
    expect(conclude({ name: 'a', version: '1.0.0', licence: 'MIT' }, policy, [], today)).toEqual({
      concluded: 'MIT',
      ok: true,
    });
  });

  it('concludes a dual licence as the option a recorded decision took, and refuses it without one', () => {
    expect(
      conclude(
        { name: 'x', version: '1.0.0', licence: '(MIT OR GPL-3.0-or-later)' },
        policy,
        [exception({ option: 'MIT' })],
        today,
      ),
    ).toMatchObject({ concluded: 'MIT', ok: true });
    expect(
      conclude(
        { name: 'x', version: '1.0.0', licence: '(MIT OR GPL-3.0-or-later)' },
        policy,
        [],
        today,
      ),
    ).toMatchObject({ concluded: 'NOASSERTION', ok: false });
  });

  it('refuses a denied licence, and honours an exception until it expires', () => {
    expect(
      conclude({ name: 'x', version: '1.0.0', licence: 'GPL-3.0-only' }, policy, [], today),
    ).toMatchObject({ ok: false, note: 'licence GPL-3.0-only is not on the allow-list' });
    expect(
      conclude(
        { name: 'x', version: '1.0.0', licence: 'MPL-2.0' },
        policy,
        [exception({ licence: 'MPL-2.0' })],
        today,
      ),
    ).toMatchObject({ concluded: 'MPL-2.0', ok: true });
    expect(
      conclude(
        { name: 'x', version: '1.0.0', licence: 'MPL-2.0' },
        policy,
        [exception({ expires: '2026-01-01' })],
        today,
      ).ok,
    ).toBe(false);
  });

  it('notes an exception that applies to an allowed licence, such as a missing licence file', () => {
    expect(
      conclude(
        { name: 'x', version: '1.0.0', licence: 'MIT' },
        policy,
        [exception({ reason: 'no licence file' })],
        today,
      ).note,
    ).toBe('licence exception ADR 1, until 2027-01-01: no licence file');
  });
});
