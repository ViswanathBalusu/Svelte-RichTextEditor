// V-HIS-001-016 lane. HIS-007 criterion 1 (an export job that completes at `seq` S leaves a version
// of kind `export` pointing at S) against PostgreSQL, through the export hooks of exports.ts and
// PgVersionStore. A preview and a failed export store no version. Each run creates its own database
// through the test support and drops it afterwards.
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportHooks } from '../../src/control-plane/exports.ts';
import type { JobRecord } from '../../src/control-plane/jobs/queue.ts';
import type { EventSink } from '../../src/control-plane/events.ts';
import type { PgLogStore } from '../../src/index.ts';
import { PgVersionStore } from '../../src/storage/versions-store.ts';
import { newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);

describe.skipIf(unavailable !== null)('V-HIS-001-016: export versions in PostgreSQL', () => {
  let db: TestDatabase;
  let h: StoreHarness;
  beforeAll(async () => {
    db = await createTestDatabase();
    const s = pgStores(db.service);
    h = {
      tenant: newTenant(),
      otherTenant: newTenant(),
      docs: s.docs,
      logs: s.logs,
      grants: s.grants,
    };
  });
  afterAll(() => db?.drop());

  /** A document with two commits, so that its head is 2. */
  async function twoCommits() {
    const { ref, epoch } = await newDocument(h);
    const logs = h.logs as PgLogStore;
    const first: StoredCommit = stepCommit(1, { id: uuid7(), user: 'surrogate-alice' });
    const second: StoredCommit = stepCommit(2, { id: uuid7(), user: 'surrogate-alice' });
    expect(await logs.append(ref, write(epoch, [first, second]))).toEqual({ status: 'ok' });
    return { ref };
  }

  /** The hooks under test, with the events and notifications discarded. */
  function hooksFor(versions: PgVersionStore, failed: string[]) {
    const events: EventSink = { emit() {} } as unknown as EventSink;
    return exportHooks({
      notify: () => undefined,
      events,
      restPath: '/v1',
      now: () => T0,
      versions,
      versionFailed: (job) => failed.push(job.id),
    });
  }

  function jobOf(ref: { tenant: string; doc: string }, kind: string, seq: number): JobRecord {
    return {
      id: uuid7(),
      tenant: ref.tenant,
      doc: ref.doc,
      kind,
      state: 'completed',
      stage: null,
      progress: null,
      payload: { seq },
      result: null,
      error: null,
      attempts: 1,
      maxAttempts: 3,
      runAfter: T0,
      createdBy: 'surrogate-alice',
    } as unknown as JobRecord;
  }

  it('HIS-007 criterion 1: a completed export stores an export version at its seq', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const failed: string[] = [];
    hooksFor(versions, failed).settled!(
      jobOf(ref, 'export', 2),
      { state: 'completed', result: {} },
      10,
    );
    // The version is stored asynchronously; poll the table briefly.
    let rows: Awaited<ReturnType<PgVersionStore['list']>> = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await versions.list(ref, { kind: 'export' });
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 2, kind: 'export', createdBy: 'surrogate-alice' });
    expect(failed).toEqual([]);
  });

  it('a preview and a failed export store no export version', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const failed: string[] = [];
    const hooks = hooksFor(versions, failed);
    hooks.settled!(jobOf(ref, 'preview', 2), { state: 'completed', result: {} }, 10);
    hooks.settled!(
      jobOf(ref, 'export', 2),
      { state: 'failed', error: { code: 'internal' } as never, retried: false },
      10,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(await versions.list(ref)).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('a version the store refuses is reported and the export stays completed', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const failed: string[] = [];
    // seq 9 is above the head (2), so the store refuses it.
    hooksFor(versions, failed).settled!(
      jobOf(ref, 'export', 9),
      { state: 'completed', result: {} },
      10,
    );
    for (let i = 0; i < 50 && failed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(failed).toHaveLength(1);
    expect(await versions.list(ref, { kind: 'export' })).toEqual([]);
  });
});
