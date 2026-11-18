/**
 * Cargo crates for the licence gate (FND-011 criterion 2; ADR 0016, decision 27 of the owner's
 * answers: the Rust WebAssembly module is built). A crate is production when the module reaches it
 * through normal dependencies only. Build-script and development dependencies do not ship in the
 * module and are not checked. Proc-macro crates that a normal dependency pulls in are checked, which
 * is the cautious side. The data comes from `cargo metadata`, which `--locked` ties to Cargo.lock.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Policy, parseSpdx } from './licence-policy.ts';

export interface CargoMetadata {
  packages: Array<{
    id: string;
    name: string;
    version: string;
    license: string | null;
    license_file?: string | null;
    manifest_path: string;
    source: string | null;
  }>;
  workspace_members: string[];
  resolve: {
    nodes: Array<{
      id: string;
      deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>;
    }>;
  } | null;
}

export interface CargoCrate {
  name: string;
  version: string;
  /** The SPDX expression of the manifest, with the old `A/B` form written as `A OR B`. */
  licence: string | null;
  dir: string;
}

/** Old manifests write `MIT/Apache-2.0`; SPDX writes `MIT OR Apache-2.0`. */
export function normaliseCargoLicence(licence: string | null): string | null {
  if (!licence) return null;
  return licence.includes('/') ? licence.replace(/\s*\/\s*/g, ' OR ') : licence;
}

/**
 * The crates that the workspace members reach through normal dependencies, not the members
 * themselves (they carry the project's licence, as the `@docedit/*` packages do).
 */
export function productionCrates(meta: CargoMetadata): CargoCrate[] {
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map((meta.resolve?.nodes ?? []).map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);
  const seen = new Set<string>();
  const queue = [...members];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? [])
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
  }
  const out: CargoCrate[] = [];
  for (const id of seen) {
    const p = byId.get(id);
    if (!p || members.has(id)) continue;
    out.push({
      name: p.name,
      version: p.version,
      licence: normaliseCargoLicence(p.license),
      dir: dirname(p.manifest_path),
    });
  }
  return out.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

/**
 * Whether every option of a dual licence is on the allow-list. For a crate, a choice between
 * two allowed licences does not change what the project owes, so it needs no recorded decision;
 * a choice that includes a licence that is not allowed does (proposed in FND-011's Notes).
 */
export function everyOptionAllowed(licence: string, policy: Policy): boolean {
  const expr = parseSpdx(licence);
  if (!expr) return false;
  const allowed = new Set(policy.allow);
  const ok = (e: NonNullable<typeof expr>): boolean =>
    e.t === 'id' ? allowed.has(e.id) : ok(e.a) && ok(e.b);
  return ok(expr);
}

const SKIP = new Set(['node_modules', '.git', '.worktrees', 'target', 'dist', 'coverage']);

/** The manifests of crates and workspaces that have a Cargo.lock beside them. */
export function findCargoManifests(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (
      entries.some((e) => e.isFile() && e.name === 'Cargo.toml') &&
      entries.some((e) => e.isFile() && e.name === 'Cargo.lock')
    )
      found.push(join(dir, 'Cargo.toml'));
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) walk(join(dir, e.name));
  };
  walk(root);
  return found.sort();
}

export function readCargoMetadata(manifest: string): CargoMetadata {
  if (!existsSync(manifest)) throw new Error(`${manifest} does not exist`);
  const r = spawnSync(
    process.env['CARGO'] || 'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.error) throw new Error(`cargo could not be run (${r.error.message})`);
  if (r.status !== 0)
    throw new Error(`cargo metadata for ${manifest} failed: ${r.stderr.trim().split('\n')[0]}`);
  return JSON.parse(r.stdout) as CargoMetadata;
}
