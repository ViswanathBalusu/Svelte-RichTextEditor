/**
 * The layout of the published site (FND-013 criterion 3): one folder for each release, a list of
 * the releases, and a front page that sends the reader to the latest one.
 *
 *   site/
 *     index.html         redirects to the latest release
 *     versions.json      every release, newest first, and which one is the latest
 *     1.2.0/             the site of that release (a VitePress build with base /1.2.0/)
 *     1.1.0/
 *
 * The latest release is the highest Semantic Versioning version that is not a pre-release. While
 * only pre-releases exist, it is the highest of them. Build metadata does not count in the order,
 * as Semantic Versioning 2.0.0 says.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareSemVer, parseSemVer } from '../../../scripts/release/version.ts';

export interface VersionList {
  /** Newest first. */
  versions: string[];
  /** The release the front page opens. Null when there is none. */
  latest: string | null;
}

/** Highest first. A text that is not a version is left out. */
export function sortVersions(versions: Iterable<string>): string[] {
  const parsed = [...new Set(versions)]
    .map((text) => ({ text, v: parseSemVer(text) }))
    .filter((e): e is { text: string; v: NonNullable<typeof e.v> } => e.v !== null);
  parsed.sort((a, b) => compareSemVer(b.v, a.v) || a.text.localeCompare(b.text));
  return parsed.map((e) => e.text);
}

export function listOf(versions: Iterable<string>): VersionList {
  const sorted = sortVersions(versions);
  const stable = sorted.find((text) => parseSemVer(text)?.prerelease.length === 0);
  return { versions: sorted, latest: stable ?? sorted[0] ?? null };
}

/** The list that is already in the site folder, or an empty one. */
export function readList(siteDir: string): VersionList {
  const path = join(siteDir, 'versions.json');
  if (!existsSync(path)) return { versions: [], latest: null };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<VersionList>;
  return listOf(raw.versions ?? []);
}

/** The page at the root of the site. It needs no script: a reader without one follows the link. */
export function redirectPage(latest: string | null, versions: readonly string[]): string {
  const target = latest === null ? null : `./${latest}/`;
  const items = versions
    .map((v) => `<li><a href="./${v}/">${v}</a>${v === latest ? ' (latest)' : ''}</li>`)
    .join('');
  return [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Documentation</title>',
    target === null ? '' : `<meta http-equiv="refresh" content="0; url=${target}">`,
    target === null ? '' : `<link rel="canonical" href="${target}">`,
    '</head>',
    '<body>',
    '<h1>Documentation</h1>',
    target === null
      ? '<p>No release has been published yet.</p>'
      : `<p>The latest release is <a href="${target}">${latest}</a>.</p>`,
    items === '' ? '' : `<p>All releases:</p><ul>${items}</ul>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Adds a release to the site folder that holds the earlier ones, and rewrites the list and the
 * front page. The folder of the release itself is the caller's: it builds into `join(siteDir, version)`.
 */
export function registerVersion(siteDir: string, version: string): VersionList {
  if (parseSemVer(version) === null) throw new Error(`"${version}" is not a Semantic Version`);
  mkdirSync(siteDir, { recursive: true });
  const list = listOf([...readList(siteDir).versions, version]);
  writeFileSync(join(siteDir, 'versions.json'), `${JSON.stringify(list, null, 2)}\n`);
  writeFileSync(join(siteDir, 'index.html'), redirectPage(list.latest, list.versions));
  return list;
}
