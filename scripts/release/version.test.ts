// Release versions (FND-012): Semantic Versioning, one version for the train, tags that name it.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkReleaseVersion,
  compareSemVer,
  formatSemVer,
  isPrerelease,
  parseSemVer,
  trainVersion,
  versionOfTag,
  type WorkspacePackage,
} from './version.ts';

const pkg = (name: string, version: string): WorkspacePackage => ({
  name,
  dir: `packages/${name.split('/')[1]}`,
  version,
  private: true,
});

describe('semantic versions', () => {
  it('parses exactly the forms of semver.org and formats them back', () => {
    for (const v of [
      '0.0.0',
      '1.2.3',
      '10.20.30',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-0.3.7',
      '1.0.0-x.7.z.92',
      '1.0.0+20130313144700',
      '1.0.0-beta+exp.sha.5114f85',
    ])
      expect(formatSemVer(parseSemVer(v)!), v).toBe(v);
    for (const v of [
      '1',
      '1.2',
      'v1.2.3',
      '01.2.3',
      '1.2.3-',
      '1.2.3-01',
      '1.2.3+',
      '1.2.3.4',
      ' 1.2.3',
    ])
      expect(parseSemVer(v), v).toBeNull();
  });

  it('orders by the precedence rules, pre-releases below their release', () => {
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 1; i < order.length; i++)
      expect(
        compareSemVer(parseSemVer(order[i - 1]!)!, parseSemVer(order[i]!)!),
        `${order[i - 1]} < ${order[i]}`,
      ).toBe(-1);
    expect(compareSemVer(parseSemVer('1.0.0+a')!, parseSemVer('1.0.0+b')!)).toBe(0);
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });

  it('is a total order that agrees with itself (property)', () => {
    const id = fc.oneof(
      fc.nat({ max: 20 }).map(String),
      fc.constantFrom('alpha', 'beta', 'rc', 'x-y'),
    );
    const version = fc
      .record({
        major: fc.nat({ max: 3 }),
        minor: fc.nat({ max: 3 }),
        patch: fc.nat({ max: 3 }),
        pre: fc.array(id, { maxLength: 3 }),
      })
      .map((r) =>
        parseSemVer(
          `${r.major}.${r.minor}.${r.patch}${r.pre.length ? `-${r.pre.join('.')}` : ''}`,
        )!,
      );
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(compareSemVer(a, b)).toBe(-compareSemVer(b, a) || 0);
        if (compareSemVer(a, b) <= 0 && compareSemVer(b, c) <= 0)
          expect(compareSemVer(a, c)).toBeLessThanOrEqual(0);
      }),
    );
  });
});

describe('the release train', () => {
  it('takes the one version every @docedit/* package carries', () => {
    expect(
      trainVersion([
        pkg('@docedit/model', '0.2.0'),
        pkg('@docedit/element', '0.2.0'),
        pkg('other', '9.9.9'),
      ]),
    ).toEqual({ version: '0.2.0', problems: [] });
  });

  it('refuses two versions or one that is not semantic, naming the packages', () => {
    const two = trainVersion([pkg('@docedit/model', '0.2.0'), pkg('@docedit/element', '0.3.0')]);
    expect(two.version).toBeNull();
    expect(two.problems[0]).toContain('@docedit/model@0.2.0, @docedit/element@0.3.0');
    expect(trainVersion([pkg('@docedit/model', 'latest')]).problems[0]).toContain(
      '"latest" is not semantic versioning',
    );
  });

  it('checks the tag and the earlier releases', () => {
    expect(
      checkReleaseVersion({ version: '0.2.0', tag: 'v0.2.0', released: ['0.1.0', '0.2.0-rc.1'] }),
    ).toEqual([]);
    expect(checkReleaseVersion({ version: '0.2.0', tag: 'refs/tags/v0.2.0' })).toEqual([]);
    expect(checkReleaseVersion({ version: '0.2.0', tag: 'v0.3.0' })).toEqual([
      'tag v0.3.0 names 0.3.0, but the packages carry 0.2.0',
    ]);
    expect(checkReleaseVersion({ version: '0.2.0', tag: 'release-1' })).toEqual([
      'tag "release-1" is not of the form v<semantic version>',
    ]);
    expect(checkReleaseVersion({ version: '0.2.0', released: ['0.2.0'] })).toEqual([
      '0.2.0 is already released',
    ]);
    expect(checkReleaseVersion({ version: '0.2.1', released: ['0.2.3'] })).toEqual([
      '0.2.1 is not above the earlier release 0.2.3 of the 0.2 line',
    ]);
    // A fix to an older line is allowed after a newer line exists.
    expect(checkReleaseVersion({ version: '1.0.1', released: ['1.0.0', '1.1.0'] })).toEqual([]);
    expect(checkReleaseVersion({ version: '0.2.0+build.1' })).toEqual([
      '0.2.0+build.1: build metadata is not used in release versions',
    ]);
    expect(versionOfTag('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(versionOfTag('1.2.3')).toBeNull();
  });
});
