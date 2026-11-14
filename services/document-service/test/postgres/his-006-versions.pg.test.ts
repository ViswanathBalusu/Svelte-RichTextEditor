// V-HIS-001-016 lane. HIS-006 criterion 1 (a named version is stored pointing at the head or at the
// seq given, with the creator and the time) against PostgreSQL, through PgVersionStore. The
// `versions` table of migration 0050 is the one read back. Each run creates its own database
// through the test support and drops it afterwards.
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(unavailable !== null)('V-HIS-001-016: named versions in PostgreSQL', () => {
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
    return { ref, head: (await logs.head(ref)).seq };
  }

  it('HIS-006 criterion 1: names the head by default, with the name, note, creator and time', async () => {
    const { ref, head } = await twoCommits();
    expect(head).toBe(2);
    const versions = new PgVersionStore(db.service);

    const made = await versions.create(ref, {
      kind: 'named',
      name: 'Sent to legal',
      note: 'after the second review',
      createdBy: 'surrogate-alice',
      createdAt: T0,
    });
    expect(made).toEqual({
      ok: true,
      created: true,
      version: {
        seq: 2,
        kind: 'named',
        name: 'Sent to legal',
        note: 'after the second review',
        createdBy: 'surrogate-alice',
        createdAt: T0,
      },
    });

    // The stored row is what the list reads back, with the creator and time as written.
    expect(await versions.list(ref)).toEqual([
      {
        seq: 2,
        kind: 'named',
        name: 'Sent to legal',
        note: 'after the second review',
        createdBy: 'surrogate-alice',
        createdAt: T0,
      },
    ]);
  });

  it('HIS-006 criterion 1: names the seq given, not the head', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const made = await versions.create(ref, {
      seq: 1,
      kind: 'named',
      name: 'First draft',
      createdBy: 'surrogate-bob',
      createdAt: T0 + 1000,
    });
    expect(made).toMatchObject({
      ok: true,
      created: true,
      version: { seq: 1, name: 'First draft' },
    });
    expect(made.ok && made.version.note).toBeUndefined();
    const listed = await versions.list(ref);
    expect(listed.map((v) => [v.seq, v.createdBy])).toEqual([[1, 'surrogate-bob']]);
  });

  it('HIS-007 criterion 5 (as applied to named): the same seq and kind returns the stored version', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const first = await versions.create(ref, {
      seq: 2,
      kind: 'named',
      name: 'Kept',
      createdBy: 'surrogate-alice',
      createdAt: T0,
    });
    const second = await versions.create(ref, {
      seq: 2,
      kind: 'named',
      name: 'Second name',
      createdBy: 'surrogate-carol',
      createdAt: T0 + 5000,
    });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false, version: { name: 'Kept' } });
    expect(await versions.list(ref)).toHaveLength(1);
  });

  it('refuses a seq above the head, a seq below the gate, a kind outside the seven and a missing document', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    expect(
      await versions.create(ref, {
        seq: 3,
        kind: 'named',
        createdBy: 'surrogate-alice',
        createdAt: T0,
      }),
    ).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(
      await versions.create(
        ref,
        { seq: 1, kind: 'named', createdBy: 'surrogate-alice', createdAt: T0 },
        { minSeq: 2 },
      ),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      await versions.create(ref, {
        kind: 'automatic',
        createdBy: 'surrogate-alice',
        createdAt: T0,
      }),
    ).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(
      await versions.create(
        { tenant: h.tenant, doc: uuid7() },
        { kind: 'named', createdBy: 'surrogate-alice', createdAt: T0 },
      ),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(await versions.list(ref)).toEqual([]);
  });

  it('stores a name with markup as plain text, and another tenant never sees the version', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const markup = '<img src=x onerror=alert(1)> & "quotes"';
    const made = await versions.create(ref, {
      kind: 'named',
      name: markup,
      createdBy: 'surrogate-alice',
      createdAt: T0,
    });
    expect(made).toMatchObject({ ok: true, version: { name: markup } });
    expect(await versions.list({ tenant: h.otherTenant, doc: ref.doc })).toEqual([]);
  });

  // Moved here from the U-HIS-001-016 lane's duplicate store (HIS-007 against the same table).

  it('HIS-007 criterion 5: an export requested twice at one seq returns the stored version and keeps one row', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    const first = await versions.create(ref, {
      seq: 2,
      kind: 'export',
      createdBy: 'system',
      createdAt: T0,
    });
    const second = await versions.create(ref, {
      seq: 2,
      kind: 'export',
      name: 'a later name',
      createdBy: 'surrogate-bob',
      createdAt: T0 + 1000,
    });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toEqual({
      ok: true,
      created: false,
      version: first.ok ? first.version : undefined,
    });
    expect(await versions.list(ref)).toEqual([
      { seq: 2, kind: 'export', createdBy: 'system', createdAt: T0 },
    ]);
  });

  it('HIS-007 criterion 6: accepts each of the seven kinds and refuses any other before storage', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    for (const kind of ['draft', 'Named', 'automatic', 'group', '']) {
      expect(
        await versions.create(ref, { seq: 1, kind, createdBy: 'surrogate-alice', createdAt: T0 }),
      ).toMatchObject({ ok: false, code: 'validation_failed' });
    }
    expect(await versions.list(ref)).toEqual([]);
    const seven = ['named', 'export', 'pre-restore', 'restore', 'import', 'sent', 'completed'];
    for (const kind of seven) {
      expect(
        await versions.create(ref, { seq: 1, kind, createdBy: 'surrogate-alice', createdAt: T0 }),
      ).toMatchObject({ ok: true, created: true, version: { seq: 1, kind } });
    }
    expect((await versions.list(ref)).map((v) => v.kind)).toEqual([...seven].sort());
  });

  it('keeps one version per kind at a seq, lists by kind oldest seq first, and leaves out versions below the gate', async () => {
    const { ref } = await twoCommits();
    const versions = new PgVersionStore(db.service);
    for (const [seq, kind] of [
      [2, 'sent'],
      [1, 'named'],
      [2, 'named'],
      [1, 'sent'],
    ] as const) {
      expect(
        await versions.create(ref, { seq, kind, createdBy: 'surrogate-alice', createdAt: T0 }),
      ).toMatchObject({ ok: true, created: true });
    }
    expect((await versions.list(ref)).map((v) => [v.seq, v.kind])).toEqual([
      [1, 'named'],
      [1, 'sent'],
      [2, 'named'],
      [2, 'sent'],
    ]);
    expect((await versions.list(ref, { kind: 'sent' })).map((v) => v.seq)).toEqual([1, 2]);
    expect(await versions.list(ref, { kind: 'export' })).toEqual([]);
    expect((await versions.list(ref, { minSeq: 2, kind: 'named' })).map((v) => v.seq)).toEqual([2]);
  });
});
