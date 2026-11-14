/**
 * Licence check for the Rust crates of the text kernel (ADR 0016, decision 5: crates follow the
 * same licence rules as npm packages). Reads `cargo metadata` for the wasm target and judges every
 * crate's licence with the licence gate's own policy and evaluator (licences/policy.json,
 * scripts/licence-policy.ts). Crates reached only as build scripts or procedural macros are
 * build tools; they are checked and reported, but marked as not shipped. For a dual licence the
 * option taken is recorded: MIT where it is offered, otherwise the first allowed option.
 *
 * Usage: node scripts/cargo-licences.ts   (from packages/perf; exit code 1 on any problem)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseSpdx, type Policy } from '../../../scripts/licence-policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const root = resolve(pkg, '../..');

interface MetaPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  targets: { kind: string[] }[];
}
interface MetaDep {
  pkg: string;
  dep_kinds: { kind: string | null }[];
}
interface MetaNode {
  id: string;
  deps: MetaDep[];
}
interface Metadata {
  packages: MetaPackage[];
  resolve: { root: string | null; nodes: MetaNode[] };
}

export interface CrateLicence {
  name: string;
  version: string;
  licence: string;
  option: string;
  ships: boolean;
}

export interface CargoLicenceReport {
  checked: number;
  crates: CrateLicence[];
  problems: string[];
}

type Expr = NonNullable<ReturnType<typeof parseSpdx>>;

/** The licence taken: in every `OR`, MIT when offered, otherwise the first allowed option. */
function chooseOption(licence: string, policy: Policy): string {
  const expr = parseSpdx(licence);
  if (!expr) return licence;
  const show = (e: Expr): string => {
    if (e.t === 'id') return e.id;
    if (e.t === 'and') return `${show(e.a)} AND ${show(e.b)}`;
    const options: Expr[] = [];
    const collect = (x: Expr): void => {
      if (x.t === 'or') {
        collect(x.a);
        collect(x.b);
      } else options.push(x);
    };
    collect(e);
    const mit = options.find((o) => o.t === 'id' && o.id === 'MIT');
    const pick = mit ?? options.find((o) => evaluate(show(o), policy).ok) ?? options[0]!;
    return show(pick);
  };
  return show(expr);
}

export function checkCargoLicences(crateDir: string, env: NodeJS.ProcessEnv): CargoLicenceReport {
  const policy = JSON.parse(readFileSync(join(root, 'licences/policy.json'), 'utf8')) as Policy;
  const meta = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--filter-platform',
        'wasm32-unknown-unknown',
      ],
      { cwd: crateDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as Metadata;
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  // Crates linked into the module: reachable from the root through normal dependencies only.
  const ships = new Set<string>();
  const stack = meta.resolve.root ? [meta.resolve.root] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (ships.has(id)) continue;
    ships.add(id);
    for (const d of nodes.get(id)?.deps ?? [])
      if (d.dep_kinds.some((k) => k.kind === null)) {
        const p = byId.get(d.pkg);
        // A procedural macro runs at build time even when reached as a normal dependency.
        if (p && !p.targets.some((t) => t.kind.includes('proc-macro'))) stack.push(d.pkg);
      }
  }
  const problems: string[] = [];
  const crates: CrateLicence[] = [];
  for (const n of meta.resolve.nodes) {
    const p = byId.get(n.id);
    if (!p || n.id === meta.resolve.root) continue;
    const licence = p.license ?? '';
    const v = evaluate(licence, policy);
    if (!v.ok) problems.push(`${p.name}@${p.version}: ${v.reason}`);
    if (licence && !parseSpdx(licence))
      problems.push(`${p.name}@${p.version}: unreadable licence ${licence}`);
    crates.push({
      name: p.name,
      version: p.version,
      licence,
      option: chooseOption(licence, policy),
      ships: ships.has(n.id),
    });
  }
  crates.sort((a, b) => a.name.localeCompare(b.name));
  return { checked: crates.length, crates, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkCargoLicences(join(pkg, 'wasm/text-kernel'), process.env);
  for (const c of report.crates)
    console.log(
      `${c.ships ? 'ships' : 'build'}  ${c.name}@${c.version}  ${c.licence}  -> ${c.option}`,
    );
  console.log(
    `cargo licences: ${report.checked} crates checked, ${report.problems.length} problem(s)`,
  );
  for (const p of report.problems) console.error(`  - ${p}`);
  if (report.problems.length) process.exit(1);
}
