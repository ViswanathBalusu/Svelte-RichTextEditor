/**
 * The Rust crates compiled into the layout kernel's WebAssembly module, for the element's bill of
 * materials and third-party notices (WASM-013; ADR 0016, decision 5; SEC-051). They are the crates
 * `cargo tree --edges normal,no-proc-macro` lists for `wasm32-unknown-unknown` (proc-macro crates
 * run at build time and are not in the module), with their licence from `cargo metadata`, their
 * source checksum from Cargo.lock (the SHA-256 of the crate archive as the registry published it)
 * and their directory in the Cargo registry for the licence files.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { evaluate, type Exception, type Policy } from '../licence-policy.ts';
import { everyOptionAllowed, normaliseCargoLicence, readCargoMetadata } from '../cargo-licences.ts';
import { parseCargoLock, parseCargoTree } from '../kernel-supply-chain.ts';
import { activeException } from '../licence-policy.ts';
import {
  NOASSERTION,
  licenceExpression,
  spdxId,
  type SpdxDocument,
  type SpdxPackage,
} from './spdx.ts';

export interface ModuleCrate {
  name: string;
  version: string;
  /** The SPDX expression of the manifest. */
  licence: string | null;
  /** The crate's directory in the Cargo registry (its licence files are there). */
  dir: string;
  /** SHA-256 of the crate archive, from Cargo.lock; null for a crate with no registry source. */
  checksum: string | null;
}

/** The crates in the module, from the tree, the metadata and the lock text (pure). */
export function composeModuleCrates(
  tree: ReadonlyArray<{ name: string; version: string }>,
  metadata: {
    packages: Array<{
      name: string;
      version: string;
      license: string | null;
      manifest_path: string;
    }>;
  },
  lockText: string,
): ModuleCrate[] {
  const lock = new Map(parseCargoLock(lockText).map((p) => [`${p.name}@${p.version}`, p]));
  const meta = new Map(metadata.packages.map((p) => [`${p.name}@${p.version}`, p]));
  return tree.map((t) => {
    const key = `${t.name}@${t.version}`;
    const m = meta.get(key);
    return {
      name: t.name,
      version: t.version,
      licence: normaliseCargoLicence(m?.license ?? null),
      dir: m ? dirname(m.manifest_path) : '',
      checksum: lock.get(key)?.checksum ?? null,
    };
  });
}

/** Runs cargo for the workspace at `workspaceDir` (the folder with Cargo.toml and Cargo.lock). */
export function moduleCrates(workspaceDir: string): ModuleCrate[] {
  const manifest = join(workspaceDir, 'Cargo.toml');
  const run = spawnSync(
    process.env['CARGO'] || 'cargo',
    [
      'tree',
      '--locked',
      '--manifest-path',
      manifest,
      '--target',
      'wasm32-unknown-unknown',
      '--edges',
      'normal,no-proc-macro',
      '--prefix',
      'none',
      '--format',
      '{p}|{l}',
    ],
    { encoding: 'utf8' },
  );
  if (run.error) throw new Error(`cargo could not be run (${run.error.message})`);
  if (run.status !== 0)
    throw new Error(`cargo tree for ${manifest} failed: ${run.stderr.trim().split('\n').at(-1)}`);
  return composeModuleCrates(
    parseCargoTree(run.stdout),
    readCargoMetadata(manifest),
    readFileSync(join(workspaceDir, 'Cargo.lock'), 'utf8'),
  );
}

/** A package URL for a crate (purl-spec: type `cargo`). */
export const cargoPurl = (name: string, version: string): string =>
  `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;

export const cratesIoUrl = (name: string, version: string): string =>
  `https://crates.io/api/v1/crates/${name}/${version}/download`;

/** One crate as an SPDX package, with the licence the gate concludes and its source checksum. */
export function cargoEntry(
  crate: ModuleCrate,
  policy: Policy,
  exceptions: readonly Exception[],
  today: string,
): { pkg: SpdxPackage; problems: string[] } {
  const problems: string[] = [];
  const id = `${crate.name}@${crate.version}`;
  if (!crate.checksum) problems.push(`${id} has no checksum in Cargo.lock`);
  const declared = licenceExpression(crate.licence);
  const verdict = evaluate(crate.licence ?? undefined, policy);
  const ex = activeException(exceptions, crate.name, crate.version, today);
  let concluded = NOASSERTION;
  if (verdict.ok && (!verdict.dual || everyOptionAllowed(crate.licence!, policy)))
    concluded = declared;
  else if (ex) concluded = ex.option ?? declared;
  else problems.push(`${id}: the licence ${crate.licence ?? 'UNKNOWN'} is not allowed`);
  return {
    pkg: {
      SPDXID: spdxId('cargo', crate.name, crate.version),
      name: crate.name,
      versionInfo: crate.version,
      downloadLocation: cratesIoUrl(crate.name, crate.version),
      filesAnalyzed: false,
      ...(crate.checksum
        ? { checksums: [{ algorithm: 'SHA256' as const, checksumValue: crate.checksum }] }
        : {}),
      licenseConcluded: concluded,
      licenseDeclared: declared,
      copyrightText: NOASSERTION,
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: cargoPurl(crate.name, crate.version),
        },
      ],
      primaryPackagePurpose: 'LIBRARY',
      comment: 'A Rust crate compiled into the layout kernel module (WebAssembly).',
    },
    problems,
  };
}

/** The crates a bill lists, as `name@version`. */
export function cratesOf(doc: SpdxDocument): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const p of doc.packages)
    for (const r of p.externalRefs ?? []) {
      const m = /^pkg:cargo\/([^@]+)@([^@?#]+)$/.exec(r.referenceLocator);
      if (r.referenceType === 'purl' && m)
        out.set(
          `${decodeURIComponent(m[1]!)}@${decodeURIComponent(m[2]!)}`,
          p.checksums?.find((c) => c.algorithm === 'SHA256')?.checksumValue ?? null,
        );
    }
  return out;
}

/** Every crate of a bill against Cargo.lock: present, with the locked checksum, and the reverse. */
export function compareCratesWithLock(
  doc: SpdxDocument,
  lockText: string,
  expected: number,
): string[] {
  const problems: string[] = [];
  const lock = new Map(parseCargoLock(lockText).map((p) => [`${p.name}@${p.version}`, p]));
  const listed = cratesOf(doc);
  for (const [key, checksum] of listed) {
    const locked = lock.get(key);
    if (!locked) problems.push(`${key} is in the bill but not in Cargo.lock`);
    else if (checksum !== locked.checksum)
      problems.push(`${key}: the bill's checksum differs from Cargo.lock`);
  }
  if (listed.size !== expected)
    problems.push(`the bill lists ${listed.size} crates, the module has ${expected}`);
  return problems;
}
