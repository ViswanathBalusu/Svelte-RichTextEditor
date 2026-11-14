/**
 * Release versions (FND-012; ADR 0044 §2). One version for every `@docedit/*` package, the element
 * bundle and the service images: a release train, so that a host pins one number. Versions follow
 * Semantic Versioning 2.0.0 and the release tag is `v<version>`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

// The regular expression of semver.org, section "Is there a suggested regular expression".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemVer(text: string): SemVer | null {
  const m = SEMVER.exec(text);
  if (!m) return null;
  const n = (s: string | undefined) => Number(s);
  const major = n(m[1]);
  const minor = n(m[2]);
  const patch = n(m[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

export function formatSemVer(v: SemVer): string {
  const pre = v.prerelease.length ? `-${v.prerelease.join('.')}` : '';
  const build = v.build.length ? `+${v.build.join('.')}` : '';
  return `${v.major}.${v.minor}.${v.patch}${pre}${build}`;
}

/** Precedence of semver.org section 11; build metadata does not count. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const k of ['major', 'minor', 'patch'] as const)
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return (parseSemVer(version)?.prerelease.length ?? 0) > 0;
}

/** `v1.2.3` gives `1.2.3`; anything else gives null. */
export function versionOfTag(tag: string): string | null {
  const t = tag.replace(/^refs\/tags\//, '');
  return t.startsWith('v') && parseSemVer(t.slice(1)) ? t.slice(1) : null;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  version: string;
  private: boolean;
}

/** Every package of the pnpm workspace (packages/*, services/*, apps/*). */
export function workspacePackages(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const group of ['packages', 'services', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(base, entry.name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
        name?: string;
        version?: string;
        private?: boolean;
      };
      if (!pkg.name) continue;
      out.push({
        name: pkg.name,
        dir: `${group}/${entry.name}`,
        version: pkg.version ?? '',
        private: pkg.private === true,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The release train's version: every `@docedit/*` package must carry the same valid version. */
export function trainVersion(
  packages: readonly WorkspacePackage[],
): { version: string; problems: [] } | { version: null; problems: string[] } {
  const ours = packages.filter((p) => p.name.startsWith('@docedit/'));
  if (!ours.length) return { version: null, problems: ['no @docedit/* package in the workspace'] };
  const problems: string[] = [];
  for (const p of ours)
    if (!parseSemVer(p.version))
      problems.push(`${p.name} (${p.dir}): version "${p.version}" is not semantic versioning`);
  const versions = [...new Set(ours.map((p) => p.version))];
  if (versions.length > 1)
    problems.push(
      `the @docedit/* packages carry ${versions.length} versions (${versions.join(', ')}); a release needs one: ${ours
        .map((p) => `${p.name}@${p.version}`)
        .join(', ')}`,
    );
  return problems.length ? { version: null, problems } : { version: versions[0]!, problems: [] };
}

/**
 * Checks a release version against its tag and the versions already released: the tag names the
 * version, the version is new, and it is above every earlier release of its own MAJOR.MINOR line.
 * A fix to an older line (1.0.1 after 1.1.0) is allowed.
 */
export function checkReleaseVersion(input: {
  version: string;
  tag?: string | undefined;
  released?: readonly string[];
}): string[] {
  const problems: string[] = [];
  const v = parseSemVer(input.version);
  if (!v) return [`"${input.version}" is not a semantic version`];
  if (v.build.length)
    problems.push(`${input.version}: build metadata is not used in release versions`);
  if (input.tag !== undefined) {
    const fromTag = versionOfTag(input.tag);
    if (fromTag === null)
      problems.push(`tag "${input.tag}" is not of the form v<semantic version>`);
    else if (fromTag !== input.version)
      problems.push(`tag ${input.tag} names ${fromTag}, but the packages carry ${input.version}`);
  }
  for (const r of input.released ?? []) {
    const p = parseSemVer(r);
    if (!p) continue;
    const c = compareSemVer(v, p);
    if (c === 0) problems.push(`${input.version} is already released`);
    else if (c < 0 && p.major === v.major && p.minor === v.minor)
      problems.push(
        `${input.version} is not above the earlier release ${r} of the ${v.major}.${v.minor} line`,
      );
  }
  return problems;
}
