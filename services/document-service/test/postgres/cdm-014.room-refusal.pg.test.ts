// CDM-014 criterion 4, closed against PostgreSQL (lane V-CDM-001-027, round 2). The Room refuses
// every failing invariant fixture with `invalid_op`, returns no write, and PostgreSQL stores
// nothing: the document's commit log stays empty after all refusals. A valid control commit goes
// through the same path and is stored, which shows the empty log is not vacuous.
//
// The fixtures are packages/model/fixtures/invariants/cases; the Room is the one of
// packages/authority; the storage is the real PgLogStore, PgGrantStore and PgDocumentStore over a
// database of its own (infra/containers). Skips with the reason when PostgreSQL is not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Room, type PermissionState, type RoomInit, type WriteRequest } from '@docedit/authority';
import { isUuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../../../packages/authority/src/codes.ts';
import {
  REQUIRES,
  USERS,
  baseDoc,
  basePermissions,
  posInside,
} from '../../../../packages/authority/test/fixtures.ts';
import { createPool } from '../../src/storage/db.ts';
import { appendWithFault } from '../../src/storage/faults.ts';
import { PgDocumentStore } from '../../src/storage/document-store.ts';
import { PgGrantStore } from '../../src/storage/grant-store.ts';
import { PgLogStore } from '../../src/storage/log-store.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixtures = resolve(import.meta.dirname, '../../../../packages/model/fixtures');
const casesDir = resolve(fixtures, 'invariants/cases');
const BASES: Record<string, string> = {
  example: 'example-03-12.json',
  'kitchen-sink': 'kitchen-sink.json',
};
const cases = readdirSync(casesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(casesDir, f), 'utf8')) as Json);

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const o = value as Json;
    if (typeof o['$repeat'] === 'string' && typeof o['count'] === 'number')
      return o['$repeat'].repeat(o['count']);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

function baseOf(f: Json): Json {
  if (typeof f['base'] !== 'string') return structuredClone(f['base']) as Json;
  const name = BASES[f['base']] ?? `${f['base']}.json`;
  return JSON.parse(readFileSync(resolve(fixtures, name), 'utf8')) as Json;
}

const schema = cdmSchema();
let clock = 1_790_000_000_000;
let counter = 0;
/** A UUID version 7 per submission (08 §2), so the Room's id check passes and step 6 decides. */
const commitId = () => `0192f0c4-7b1e-7000-9014-${(++counter).toString(16).padStart(12, '0')}`;

const LIMITS = {
  ...DEFAULT_LIMITS,
  maxStepsPerCommit: 1_000_000,
  maxCommitBytes: 256 * 1024 * 1024,
};

const unavailable = await postgresUnavailable();

if (unavailable) {
  console.warn(`skipped: ${unavailable}`);
  describe.skip('CDM-014 the Room refuses the failing fixtures and PostgreSQL stores nothing', () => {
    it('needs PostgreSQL', () => {});
  });
} else {
  describe('CDM-014 the Room refuses the failing fixtures and PostgreSQL stores nothing', () => {
    let db: TestDatabase;
    let pool: ReturnType<typeof createPool>;
    let logs: PgLogStore;
    let grants: PgGrantStore;
    let docs: PgDocumentStore;
    const tenant = newTenant();
    let ref: { tenant: string; doc: string };
    let incarnation = '';
    let epoch = 0;
    let perms: PermissionState;

    beforeAll(async () => {
      db = await createTestDatabase();
      pool = createPool(db.serviceConfig);
      grants = new PgGrantStore(pool);
      logs = new PgLogStore(pool, { permissions: (r) => grants.current(r) });
      docs = new PgDocumentStore(pool);
      const rec = await docs.create(tenant, {
        cdmVersion: 1,
        requires: [...REQUIRES],
        createdBy: 'V-CDM-001-027',
        permissions: basePermissions(),
      });
      ref = { tenant, doc: rec.id };
      incarnation = rec.incarnation;
      epoch = await logs.claim(ref, 'cdm-014-node');
      perms = await grants.current(ref);
    });

    afterAll(async () => {
      await pool?.end().catch(() => {});
      await db?.drop();
    });

    /** A fresh Room over the PostgreSQL document: empty log, the stored revision and epoch. */
    function roomFor(
      initial: Json,
      requires: string[],
      c: Json,
      user: (typeof USERS)[keyof typeof USERS] = USERS.alice,
    ): Room {
      const gate = c['mathGateRefuses'] as string | undefined;
      const init: RoomInit = {
        schema,
        initial: schema.nodeFromJSON(initial['doc']),
        requires,
        log: [],
        perms,
        initialRevision: perms.revision,
        epoch,
        incarnation,
        now: () => ++clock,
        limits: LIMITS,
        retiredRegionIds: (c['retiredRegionIds'] ?? []) as string[],
        ...(c['attachedAssets'] ? { attachedAssets: new Set<string>(c['attachedAssets']) } : {}),
        ...(gate !== undefined
          ? {
              mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null),
            }
          : {}),
      };
      const room = new Room(init);
      room.open('c1', user);
      return room;
    }

    /** Submits one failing fixture the way the authority test does, and returns the Room's answer. */
    function submitFixture(f: Json) {
      const steps = expand(f['steps']);
      const whole = Array.isArray(steps) && steps.length === 0;
      const base = whole ? baseOf({ base: 'example' }) : baseOf(f);
      const requires = (
        whole ? base['requires'] : (f['requires'] ?? base['requires'] ?? [])
      ) as string[];
      const c = (f['context'] ?? {}) as Json;
      const room = roomFor(base, requires, c);
      const initial = room.document;
      const id = commitId();
      expect(isUuid7(id), 'the test must submit a UUID version 7 id').toBe(true);
      const fx = whole
        ? room.snapshot('control', {
            id,
            reason: 'import',
            content: schema.nodeFromJSON(baseOf(f)['doc']),
            checkpoint: 'cdm014-checkpoint',
            as: 'system',
          })
        : room.submit('c1', { id, base: 0, steps });
      const channel = whole ? 'control' : 'c1';
      const reject = fx.send
        .filter((o) => o.channel === channel)
        .map((o) => o.msg as { t: string; code?: string; reason?: string })
        .find((m) => m.t === 'sync.reject');
      return { reject, fx, room, initial };
    }

    it('reads the fixtures and finds failing ones', () => {
      expect(cases.length).toBeGreaterThanOrEqual(48);
      expect(cases.filter((c) => (c['expected'] as string[]).length > 0).length).toBeGreaterThan(0);
    });

    it('starts with an empty commit log at the revision the document was created with', async () => {
      expect(await logs.read(ref)).toEqual([]);
      expect((await logs.head(ref)).seq).toBe(0);
      expect(perms.revision).toBe(1);
    });

    it('refuses every failing fixture with invalid_op, returns no write, and PostgreSQL stores nothing', async () => {
      const failing = cases.filter((c) => (c['expected'] as string[]).length > 0);
      const writes: WriteRequest[] = [];
      for (const c of failing) {
        const { reject, fx, room, initial } = submitFixture(c);
        const name = String(c['name']);
        expect(reject, `${name}: the Room must answer sync.reject`).toBeDefined();
        expect(reject?.code, `${name}: ${reject?.reason}`).toBe('invalid_op');
        const reason = String(reject?.reason);
        expect(reason).not.toContain('UUID');
        const expected = c['expected'] as string[];
        const named = expected.filter((inv) => new RegExp(`\\b${inv}\\b`).test(reason));
        expect(
          named.length,
          `${name}: reason "${reason}" names none of ${expected.join(', ')}`,
        ).toBeGreaterThan(0);
        expect(fx.write, `${name}: a refused commit must not reach storage`).toBeNull();
        if (fx.write) writes.push(fx.write);
        expect(room.document.eq(initial), `${name}: the document must be unchanged`).toBe(true);
      }
      expect(writes).toEqual([]);
      // What PostgreSQL holds after every refusal: nothing, at the head the document was created with.
      expect(await logs.read(ref)).toEqual([]);
      expect((await logs.head(ref)).seq).toBe(0);
      expect((await logs.head(ref)).epoch).toBe(epoch);
    });

    it('stores a valid control commit through the same path, so the empty log above is not vacuous', async () => {
      // The base document of packages/authority's tests, which has the paragraph pIntro0000000001.
      const room = roomFor({ doc: baseDoc().toJSON() }, [...REQUIRES], {}, USERS.carol);
      const at = posInside(room.document, 'pIntro0000000001');
      // prosemirror-transform's ReplaceStep JSON: insert the text "x" at the start of the paragraph.
      const steps = [
        {
          stepType: 'replace',
          from: at,
          to: at,
          slice: { content: [{ type: 'text', text: 'x' }], openStart: 0, openEnd: 0 },
        },
      ];
      const fx = room.submit('c1', { id: commitId(), base: 0, steps });
      expect(fx.write, 'a valid commit must reach storage').not.toBeNull();
      const result = await appendWithFault(logs, ref, fx.write!, 'none');
      expect(result.status).toBe('ok');
      expect(await logs.read(ref)).toHaveLength(1);
      expect((await logs.head(ref)).seq).toBe(1);
    });
  });
}
