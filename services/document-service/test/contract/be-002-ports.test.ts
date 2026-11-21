// BE-002 criterion 1: the nine adapter interfaces of 06 §14 are TypeScript interfaces, and the rooms
// (src/data-plane, without its adapters and command-line tools) and the handlers of the control API
// (handlers.ts, the route modules, their kit, the router and the request pipeline) reach no concrete
// driver. Following the imports that exist at run time (not `import type`), none arrives at the
// PostgreSQL client or an adapter over it, the S3 or Azure Blob adapters, the Valkey adapters, or
// the asset worker's package with its S3 client and its sandbox.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTER_INTERFACES } from '../../src/adapters.ts';
import type {
  AssetStore,
  Bus,
  CheckpointStore,
  EventSink,
  GrantStore,
  KeyService,
  LogStore,
  Queue,
  TokenVerifier,
} from '../../src/adapters.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const rel = (file: string) => relative(SRC, file).replaceAll('\\', '/');

/** The names 06 §14 gives, in its order. */
const NAMED_IN_SPEC = [
  'LogStore',
  'CheckpointStore',
  'AssetStore',
  'GrantStore',
  'TokenVerifier',
  'Queue',
  'Bus',
  'EventSink',
  'KeyService',
];

/** The nine names resolve as types through `adapters.ts`: this fails the type check if one is lost. */
export interface NinePorts {
  log: LogStore;
  checkpoints: CheckpointStore;
  assets: AssetStore;
  grants: GrantStore;
  tokens: TokenVerifier;
  queue: Queue;
  bus: Bus;
  events: EventSink;
  keys: KeyService;
}

/** The adapters of this service that are written over a driver, apart from the PostgreSQL ones. */
const DRIVER_MODULES = [
  'storage/db.ts',
  'objects/s3.ts',
  'objects/azure.ts',
  // The RESP client with the shared token buckets, and the bus over Valkey streams (BE-063).
  'data-plane/valkey-buckets.ts',
  'data-plane/valkey-bus.ts',
];

/** Modules that are a concrete driver, or an adapter written over one. */
const isDriver = (spec: string, file: string | null): string | null => {
  if (/^(pg|pg-.*|ioredis|redis|iovalkey|nats|@aws-sdk\/.*|@azure\/.*)$/.test(spec)) return spec;
  // The asset worker's package holds an S3 client and the Podman sandbox. Its job kind alone is
  // offered as `@docedit/asset-worker/kind`, which loads neither.
  if (spec === '@docedit/asset-worker') return spec;
  if (!file) return null;
  const r = rel(file);
  if (DRIVER_MODULES.includes(r)) return r;
  if (/(^|\/)pg\//.test(r) || /-pg\.ts$/.test(r) || /(^|\/)pg\.ts$/.test(r)) return r;
  return null;
};

/**
 * The module specifiers a file needs at run time. `import type` and `export type` are erased, and
 * so is an import whose names are all `type` names and that binds no default and no namespace. A
 * dynamic `import()` and a module started by URL (a worker thread's script) count.
 */
function runtimeImports(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?from\s+)?['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[2]) continue;
    const clause = m[3] ?? '';
    const names = /\{([^}]*)\}/.exec(clause);
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/\bfrom\b/, '');
    const bindsMore = /[A-Za-z_$*]/.test(outside);
    if (
      names &&
      !bindsMore &&
      names[1]!.split(',').every((n) => n.trim() === '' || /^type\s/.test(n.trim()))
    )
      continue;
    out.push(m[4]!);
  }
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g))
    if (m[1]!.endsWith('.ts')) out.push(m[1]!);
  return out;
}

/** Every driver reachable from `entry`, with the chain of files that leads to it. */
function driversReachedFrom(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
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
  it('declares each of the nine named interfaces as a TypeScript interface', () => {
    expect(Object.keys(ADAPTER_INTERFACES)).toEqual(NAMED_IN_SPEC);
    for (const [name, at] of Object.entries(ADAPTER_INTERFACES)) {
      const text = readFileSync(join(SRC, at.file), 'utf8');
      expect(text, `${name} in ${at.file}`).toMatch(
        new RegExp(`^export interface ${at.declaredAs}\\b`, 'm'),
      );
      // An interface only: no class of that name stands in for it.
      expect(text, `${name} in ${at.file}`).not.toMatch(new RegExp(`\\bclass ${at.declaredAs}\\b`));
    }
    // The list names what 06 §14 names: the sentence of the specification holds the same nine.
    const spec = readFileSync(resolve(SRC, '../../../docs/spec/06-backend.md'), 'utf8');
    const sentence = /## 14\. Self-hosting adapters\s+([^\n]+)/.exec(spec)?.[1] ?? '';
    expect([...sentence.matchAll(/`([A-Z][A-Za-z]+)`/g)].map((m) => m[1])).toEqual(NAMED_IN_SPEC);
  });

  it('lets an implementer import each interface without loading a driver', () => {
    const modules = [...new Set(Object.values(ADAPTER_INTERFACES).map((at) => at.file))];
    expect(modules.flatMap((file) => driversReachedFrom(join(SRC, file)))).toEqual([]);
  });

  it('keeps the rooms free of concrete drivers', () => {
    // The command-line tools compose a deployment, and recovery.ts is the operator's tool over
    // PostgreSQL; neither is a room. The pg/ folder and the Valkey modules are the adapters
    // themselves. index.ts is the package's list of exports, adapters included.
    const rooms = files('data-plane').filter(
      (f) =>
        !f.endsWith('-cli.ts') &&
        !f.endsWith('recovery.ts') &&
        !f.endsWith('index.ts') &&
        !DRIVER_MODULES.includes(rel(f)),
    );
    expect(rooms.length).toBeGreaterThan(30);
    for (const room of ['room-host.ts', 'session.ts', 'forwarding.ts', 'announcements.ts'])
      expect(rooms.map(rel)).toContain(`data-plane/${room}`);
    expect(rooms.flatMap(driversReachedFrom)).toEqual([]);
  });

  it('keeps the handlers of the control API free of concrete drivers', () => {
    const handlers = files('control-plane').filter((f) =>
      /(handlers|-routes?|kit|pipeline|router)\.ts$/.test(f),
    );
    expect(handlers.length).toBeGreaterThan(25);
    for (const handler of ['handlers.ts', 'pipeline.ts', 'asset-routes.ts', 'connect-route.ts'])
      expect(handlers.map(rel)).toContain(`control-plane/${handler}`);
    // Not directly, and not through any module they load: the three modules that once held an
    // interface, its in-memory implementation and its PostgreSQL implementation in one file
    // (assets.ts, idempotency.ts, tenants.ts) now leave the last to a `-pg.ts` module.
    expect(handlers.flatMap(driversReachedFrom)).toEqual([]);
  });

  it('finds the drivers where the composition does load them', () => {
    // The walk is not blind: the composition root reaches every kind of driver it names, and each
    // adapter module reaches its own.
    const fromServer = driversReachedFrom(join(SRC, 'server.ts')).map((chain) =>
      chain.split(' -> ').at(-1),
    );
    for (const driver of [
      ...DRIVER_MODULES,
      '@docedit/asset-worker',
      'control-plane/assets-pg.ts',
      'control-plane/idempotency-pg.ts',
      'control-plane/tenants-pg.ts',
      'control-plane/jobs/pg.ts',
      'data-plane/pg/outbox.ts',
    ])
      expect(fromServer, driver).toContain(driver);
    for (const driver of DRIVER_MODULES) expect(existsSync(join(SRC, driver)), driver).toBe(true);
    for (const adapter of ['assets-pg.ts', 'idempotency-pg.ts', 'tenants-pg.ts'])
      expect(driversReachedFrom(join(SRC, 'control-plane', adapter))).toEqual([
        `control-plane/${adapter} -> storage/db.ts`,
      ]);
    expect(driversReachedFrom(join(SRC, 'storage/db.ts'))).toEqual(['storage/db.ts -> pg']);
    expect(driversReachedFrom(join(SRC, 'objects/asset-pipeline.ts'))).toEqual([
      'objects/asset-pipeline.ts -> @docedit/asset-worker',
    ]);
  });

  it('reads run-time imports and leaves erased ones out', () => {
    const text = [
      "import type { A } from './a.ts';",
      "import { type B, type C } from './b.ts';",
      "import d, { type D } from './d.ts';",
      "import * as e from './e.ts';",
      "import { f, type F } from './f.ts';",
      "import './g.ts';",
      "export type { H } from './h.ts';",
      "export { i } from './i.ts';",
      "export * from './j.ts';",
      'import {',
      '  type K,',
      '  type L,',
      "} from './k.ts';",
      'import {',
      '  m,',
      '  type M,',
      "} from './m.ts';",
      "const n = await import('./n.ts');",
      "const SCRIPT = new URL('./o.ts', import.meta.url);",
      "const page = new URL('/p', 'http://service.invalid');",
    ].join('\n');
    expect(runtimeImports(text)).toEqual([
      './d.ts',
      './e.ts',
      './f.ts',
      './g.ts',
      './i.ts',
      './j.ts',
      './m.ts',
      './n.ts',
      './o.ts',
    ]);
  });
});
