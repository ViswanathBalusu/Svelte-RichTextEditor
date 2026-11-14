/**
 * FRW-061 criterion 5 (lane U-FRW-055-072): a prefill on a document with no room open is applied by a
 * transient authority, which stores the one commit and exits. Afterwards no room is open, no transient
 * run is left, and the run set no timer. The memory stores run always; the PostgreSQL run skips with the
 * reason when the test environment is not up (pwsh -NoProfile -File infra/test-env.ps1 up).
 * Each run uses its own tenant and document; the PostgreSQL database is dropped afterwards.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuid7 } from '@docedit/model';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** The criterion, checked on one plane: the transient authority stores the prefill and leaves nothing. */
async function transientPrefillLeavesNothing(p: Plane, timers: boolean): Promise<void> {
  const doc = await p.createDocument();
  const ref = p.ref(doc);
  expect(p.plane.host.rooms).toHaveLength(0);

  const timerSpy = timers ? vi.spyOn(globalThis, 'setTimeout') : null;
  let applied: { seq: number };
  try {
    applied = await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), 'Prefilled')],
    });
  } finally {
    timerSpy?.mockRestore();
  }

  // The commit is stored once, at seq 1, with origin `prefill`.
  expect(applied.seq).toBe(1);
  expect((await p.stores.logs.head(ref)).seq).toBe(1);
  const stored = await p.stores.logs.read(ref, 1, 1);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ origin: 'prefill' });

  // The authority has exited: no room is open, no transient run is left.
  expect(p.plane.host.rooms).toHaveLength(0);
  expect(p.plane.host.transientCount).toBe(0);

  // The run set no timer. Checked on the memory stores only (the PostgreSQL driver keeps its own
  // pool timers, which are not the run's).
  if (timers) expect(timerSpy?.mock.calls.length ?? 0).toBe(0);
}

describe('a transient prefill stores one commit and leaves no room or timer (FRW-061 criterion 5, memory)', () => {
  const planes: Plane[] = [];
  afterEach(async () => {
    for (const p of planes.splice(0)) await p.close().catch(() => {});
  });

  it('applies the prefill from a transient authority and exits with no room, no transient run and no timer', async () => {
    const p = await startPlane({ node: 'node-u-frw-061-c5' });
    planes.push(p);
    await transientPrefillLeavesNothing(p, true);
  });
});

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'a transient prefill stores one commit and leaves no room (FRW-061 criterion 5, PostgreSQL)',
  () => {
    let db: TestDatabase;
    const planes: Plane[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      for (const p of planes) await p.close().catch(() => {});
      await db?.drop();
    });

    it('applies the prefill from a transient authority and exits with no room and no transient run', async () => {
      const pg = pgStores(db.service);
      const p = await startPlane({
        stores: { logs: pg.logs, ownership: pg.logs, grants: pg.grants, documents: pg.docs },
        node: 'node-u-frw-061-c5-pg',
      });
      planes.push(p);
      await transientPrefillLeavesNothing(p, false);
    });
  },
);
