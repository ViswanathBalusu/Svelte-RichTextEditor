// BE-002 criterion 1: the adapter interfaces of 06 §14 are TypeScript interfaces, and the rooms
// (src/data-plane, without its PostgreSQL adapters and command-line tools) and the handlers of the
// control API (handlers.ts, the *-routes.ts modules, their kit and the request pipeline) reach no
// concrete driver: following their imports that exist at run time (not `import type`), none
// arrives at the PostgreSQL client, the S3 or Azure Blob adapters or a PostgreSQL adapter module.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTER_INTERFACES } from '../../src/adapters.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const rel = (file: string) => relative(SRC, file).replaceAll('\\', '/');

/** Modules that are a concrete driver, or an adapter written over one. */
const isDriver = (spec: string, file: string | null): string | null => {
  if (/^(pg|pg-.*|ioredis|redis|iovalkey|@aws-sdk\/.*|@azure\/.*)$/.test(spec)) return spec;
  if (!file) return null;
  const r = rel(file);
  if (r === 'storage/db.ts' || r === 'objects/s3.ts' || r === 'objects/azure.ts') return r;
  if (/(^|\/)pg\//.test(r) || /-pg\.ts$/.test(r) || /(^|\/)pg\.ts$/.test(r)) return r;
  return null;
};

/** The module specifiers a file imports at run time: `import type` and `export type` are erased. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?from\s+)?['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[2]) continue;
    // `import { type A, type B } from` imports nothing at run time either.
    const names = /\{([^}]*)\}/.exec(m[3] ?? '');
    if (names && names[1]!.split(',').every((n) => n.trim() === '' || /^type\s/.test(n.trim())))
      continue;
    out.push(m[4]!);
  }
  return out;
}

/** Every driver reachable from `entry`, with the chain of files that leads to it. */
function driversReachedFrom(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      const target = spec.startsWith('.') ? resolve(dirname(file), spec) : null;
      const driver = isDriver(spec, target);
      if (driver) found.push([...chain, rel(file), driver].join(' -> '));
      else if (target && target.startsWith(SRC)) walk(target, [...chain, rel(file)]);
    }
  };
  walk(entry, []);
  return found;
}

const files = (dir: string): string[] =>
  readdirSync(join(SRC, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(SRC, dir, e.name));

describe('the adapter interfaces of 06 §14 (BE-002 criterion 1)', () => {
  it('declares each named interface as a TypeScript interface', () => {
    for (const [name, at] of Object.entries(ADAPTER_INTERFACES)) {
      if (at === null) continue;
      const text = readFileSync(join(SRC, at.file), 'utf8');
      expect(text, `${name} in ${at.file}`).toMatch(
        new RegExp(`export interface ${at.declaredAs}\\b`),
      );
    }
    // The bus is not an interface yet: its shape waits for the choice of BE-059.
    expect(
      Object.entries(ADAPTER_INTERFACES)
        .filter(([, at]) => at === null)
        .map(([name]) => name),
    ).toEqual(['Bus']);
  });

  it('keeps the rooms free of concrete drivers', () => {
    // The command-line tools compose a deployment, and recovery.ts is the operator's tool over
    // PostgreSQL; neither is a room. The pg/ folder holds the adapters themselves.
    // index.ts is the package's list of exports, adapters included.
    const rooms = files('data-plane').filter(
      (f) => !f.endsWith('-cli.ts') && !f.endsWith('recovery.ts') && !f.endsWith('index.ts'),
    );
    expect(rooms.length).toBeGreaterThan(10);
    expect(rooms.flatMap(driversReachedFrom)).toEqual([]);
  });

  it('keeps the handlers of the control API free of direct driver imports', () => {
    const handlers = files('control-plane').filter((f) =>
      /(handlers|-routes|kit|pipeline|router)\.ts$/.test(f),
    );
    expect(handlers.length).toBeGreaterThan(5);
    const direct = handlers.flatMap((file) =>
      runtimeImports(file)
        .map((spec) => isDriver(spec, spec.startsWith('.') ? resolve(dirname(file), spec) : null))
        .filter((d) => d !== null)
        .map((d) => `${rel(file)} -> ${d}`),
    );
    expect(direct).toEqual([]);

    // Through other modules the handlers still load the PostgreSQL helpers, by three modules that
    // hold an interface, its in-memory implementation and its PostgreSQL implementation in one
    // file. The list is pinned so that it can only shrink; splitting those files empties it.
    const lastEdges = new Set(
      handlers
        .flatMap(driversReachedFrom)
        .map((chain) => chain.split(' -> ').slice(-2).join(' -> ')),
    );
    expect([...lastEdges].sort()).toEqual([
      'control-plane/assets.ts -> storage/db.ts',
      'control-plane/idempotency.ts -> storage/db.ts',
      'control-plane/tenants.ts -> storage/db.ts',
    ]);
  });
});
