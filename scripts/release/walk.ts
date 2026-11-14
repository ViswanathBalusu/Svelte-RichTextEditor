/**
 * The licence gate's walk, per distributable (FND-011, SEC-051; ADR 0044 §3). The gate runs
 * `pnpm licenses list --json --prod -r` over the whole workspace; a bill of materials needs the
 * same data for one distributable: the production dependencies of the package and of every
 * workspace package it depends on in production. Each dependency's licence is concluded with the
 * gate's own policy and exceptions (scripts/licence-policy.ts, licences/*.json).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Exception, type Policy, activeException, evaluate } from '../licence-policy.ts';
import { workspacePackages, type WorkspacePackage } from './version.ts';

export interface PnpmLicenceEntry {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  author?: string;
  homepage?: string;
  description?: string;
}

export interface Dependency {
  name: string;
  version: string;
  /** The installed directory, when pnpm reports it. */
  path: string | null;
  /** The licence the package's manifest declares, as pnpm reports it. */
  licence: string;
  homepage?: string;
}

/** The workspace packages a package needs in production (itself included), by `workspace:` links. */
export function workspaceClosure(
  root: string,
  name: string,
  all: readonly WorkspacePackage[] = workspacePackages(root),
): WorkspacePackage[] {
  const byName = new Map(all.map((p) => [p.name, p]));
  const seen = new Map<string, WorkspacePackage>();
  const visit = (n: string) => {
    const p = byName.get(n);
    if (!p || seen.has(n)) return;
    seen.set(n, p);
    const manifest = JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {}))
      if (spec.startsWith('workspace:')) visit(dep);
  };
  visit(name);
  if (!seen.size) throw new Error(`${name} is not a package of this workspace`);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs the gate's pnpm command for the given workspace packages. */
export function runLicenceList(
  root: string,
  packages: readonly string[],
): Record<string, PnpmLicenceEntry[]> {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const filters = packages.flatMap((p) => ['--filter', p]);
  const raw = execFileSync(pnpm, [...filters, 'licenses', 'list', '--json', '--prod'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = raw.trim();
  return text ? (JSON.parse(text) as Record<string, PnpmLicenceEntry[]>) : {};
}

/** One record per package and version; the workspace's own packages are left out. */
export function flattenLicenceList(byLicence: Record<string, PnpmLicenceEntry[]>): Dependency[] {
  const out = new Map<string, Dependency>();
  for (const entries of Object.values(byLicence))
    for (const e of entries) {
      if (e.name.startsWith('@docedit/')) continue;
      e.versions.forEach((version, i) => {
        let path = e.paths.length === e.versions.length ? (e.paths[i] ?? null) : null;
        if (path === null)
          path =
            e.paths.find((p) => {
              const file = join(p, 'package.json');
              return (
                existsSync(file) &&
                (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version === version
              );
            }) ?? null;
        out.set(`${e.name}@${version}`, {
          name: e.name,
          version,
          path,
          licence: e.license,
          ...(e.homepage ? { homepage: e.homepage } : {}),
        });
      });
    }
  return [...out.values()].sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

export interface Conclusion {
  /** The licence concluded for the bill: the declared one, or the option a recorded decision took. */
  concluded: string;
  ok: boolean;
  note?: string;
}

/** The gate's verdict on one dependency, expressed as the licence concluded for the bill. */
export function conclude(
  dep: { name: string; version: string; licence: string },
  policy: Policy,
  exceptions: readonly Exception[],
  today: string,
): Conclusion {
  const ex = activeException(exceptions, dep.name, dep.version, today);
  const exNote = ex
    ? `licence exception ${ex.decision}, until ${ex.expires}: ${ex.reason}`
    : undefined;
  const v = evaluate(dep.licence, policy);
  if (v.ok && !v.dual)
    return { concluded: dep.licence, ok: true, ...(exNote ? { note: exNote } : {}) };
  if (v.ok && v.dual) {
    if (!ex)
      return {
        concluded: 'NOASSERTION',
        ok: false,
        note: `dual licence ${dep.licence} needs a recorded decision naming the option taken`,
      };
    return { concluded: ex.option ?? dep.licence, ok: true, note: exNote! };
  }
  if (ex) return { concluded: dep.licence, ok: true, note: exNote! };
  return { concluded: 'NOASSERTION', ok: false, note: v.ok ? '' : v.reason };
}

export function loadPolicy(root: string): { policy: Policy; exceptions: Exception[] } {
  const policy = JSON.parse(readFileSync(join(root, 'licences/policy.json'), 'utf8')) as Policy;
  const { exceptions } = JSON.parse(
    readFileSync(join(root, 'licences/exceptions.json'), 'utf8'),
  ) as { exceptions: Exception[] };
  return { policy, exceptions };
}
