/**
 * FND-013 criterion 3: each release has its own version of the site, and the latest is the default.
 * These tests cover the layout of the site folder; `fnd-013-site.test.ts` builds a site.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listOf,
  readList,
  redirectPage,
  registerVersion,
  sortVersions,
} from '../scripts/layout.ts';

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fnd-013-layout-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('FND-013 criterion 3: a site folder with one folder for each release', () => {
  it('orders releases by Semantic Versioning, highest first, and drops what is not a version', () => {
    expect(
      sortVersions(['1.2.0', '1.10.0', '1.9.3', '2.0.0-rc.1', '2.0.0', 'main', '1.2.0']),
    ).toEqual(['2.0.0', '2.0.0-rc.1', '1.10.0', '1.9.3', '1.2.0']);
  });

  it('makes the highest release that is not a pre-release the latest', () => {
    expect(listOf(['1.0.0', '1.1.0-rc.1']).latest).toBe('1.0.0');
    expect(listOf(['1.0.0', '1.1.0', '1.2.0-beta.2']).latest).toBe('1.1.0');
  });

  it('makes the highest pre-release the latest while there is no other', () => {
    expect(listOf(['0.1.0-rc.1', '0.1.0-rc.2', '0.1.0-beta.1']).latest).toBe('0.1.0-rc.2');
    expect(listOf([]).latest).toBeNull();
  });

  it('gives a front page that redirects to the latest release and lists the others', () => {
    const page = redirectPage('1.1.0', ['1.1.0', '1.0.0']);
    expect(page).toContain('<meta http-equiv="refresh" content="0; url=./1.1.0/">');
    expect(page).toContain('<a href="./1.1.0/">1.1.0</a> (latest)');
    expect(page).toContain('<a href="./1.0.0/">1.0.0</a>');
    expect(redirectPage(null, [])).toContain('No release has been published yet.');
    expect(redirectPage(null, [])).not.toContain('http-equiv');
  });

  it('adds a release to a folder that holds earlier ones and keeps them', () => {
    const site = temp();
    mkdirSync(join(site, '1.0.0'));
    writeFileSync(join(site, '1.0.0', 'index.html'), 'earlier');
    registerVersion(site, '1.0.0');
    expect(readList(site)).toEqual({ versions: ['1.0.0'], latest: '1.0.0' });

    registerVersion(site, '1.1.0');
    registerVersion(site, '1.0.1');
    const list = readList(site);
    expect(list).toEqual({ versions: ['1.1.0', '1.0.1', '1.0.0'], latest: '1.1.0' });
    expect(JSON.parse(readFileSync(join(site, 'versions.json'), 'utf8'))).toEqual(list);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('url=./1.1.0/');
    expect(readFileSync(join(site, '1.0.0', 'index.html'), 'utf8')).toBe('earlier');
  });

  it('keeps the latest when an older release is rebuilt', () => {
    const site = temp();
    registerVersion(site, '2.0.0');
    registerVersion(site, '1.5.0');
    expect(readList(site).latest).toBe('2.0.0');
  });

  it('refuses a name that is not a version', () => {
    expect(() => registerVersion(temp(), 'latest')).toThrow(/not a Semantic Version/);
  });

  it('ignores build metadata when it orders releases', () => {
    expect(sortVersions(['1.0.0+b', '1.0.1'])[0]).toBe('1.0.1');
  });
});
