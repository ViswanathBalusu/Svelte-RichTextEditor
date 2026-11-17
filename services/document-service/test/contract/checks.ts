/**
 * Contract checks for the storage ports (BE-002, BE-017, BE-010, BE-026; PRM-002). They are plain
 * async functions that throw on a violation, so the same list runs against PostgreSQL, against the
 * in-memory store, and against a deliberately wrong store to show that the suite catches it
 * (BE-002: a store without a conditional append must not pass as a LogStore).
 */
import assert from 'node:assert/strict';
import type { PermissionState, StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import {
  DocumentNotFoundError,
  RetiredRegionError,
  RevisionConflictError,
  type DocRef,
  type DocumentStore,
  type GrantStore,
  type LogStore,
  type OwnershipStore,
} from '../../src/index.ts';

export interface StoreHarness {
  tenant: string;
  otherTenant: string;
  docs: DocumentStore;
  logs: LogStore & OwnershipStore;
  grants: GrantStore;
}

export interface Check {
  name: string;
  run(h: StoreHarness): Promise<void>;
}

export const LEGAL = 'rLegal000000000B';
export const TERMS = 'rTerms000000000A';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function initialPermissions(): Omit<PermissionState, 'revision'> & { revision: number } {
  return {
    revision: 1,
    grants: [
      { region: LEGAL, principal: 'group:legal', role: 'editor', expiresAt: null },
      { region: LEGAL, principal: 'user:dave', role: 'suggester', expiresAt: null },
    ],
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
  };
}

let clock = 1_760_000_000_000;

/** A step commit as the room stores it (the store does not interpret the steps). */
export function stepCommit(seq: number, over: Partial<StoredCommit> = {}): StoredCommit {
  clock += 7;
  return {
    seq,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: 3,
        to: 3,
        slice: { content: [{ type: 'text', text: `t${seq}` }] },
      },
    ],
    user: 'alice',
    session: 's-alice',
    time: clock,
    origin: 'input',
    scopes: ['body', `region:${TERMS}`],
    revision: 1,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
    ...over,
  };
}

export function controlCommit(seq: number, revision: number): StoredCommit {
  clock += 7;
  return {
    seq,
    id: uuid7(),
    kind: 'control',
    steps: [],
    user: 'system',
    session: 'system',
    time: clock,
    origin: 'control',
    scopes: [],
    revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
}

export function write(epoch: number, commits: StoredCommit[], revision = 1): WriteRequest {
  return { epoch, revision, fromSeq: commits[0]!.seq, commits };
}

/** A document with the initial permissions, owned by `node-a` at epoch 1. */
export async function newDocument(h: StoreHarness): Promise<{ ref: DocRef; epoch: number }> {
  const rec = await h.docs.create(h.tenant, {
    cdmVersion: 1,
    requires: ['fields'],
    createdBy: 'u-creator',
    permissions: initialPermissions(),
  });
  const ref = { tenant: h.tenant, doc: rec.id };
  return { ref, epoch: await h.logs.claim(ref, 'node-a') };
}

const sorted = (c: StoredCommit): StoredCommit => ({ ...c, scopes: [...c.scopes].sort() });

async function assertLog(h: StoreHarness, ref: DocRef, expected: StoredCommit[]): Promise<void> {
  assert.deepStrictEqual(await h.logs.read(ref), expected.map(sorted));
  assert.equal((await h.logs.head(ref)).seq, expected.length);
}

export const LOG_STORE_CHECKS: Check[] = [
  {
    name: 'a new document starts at head 0 and epoch 0 with an incarnation of its own',
    async run(h) {
      const a = await h.docs.create(h.tenant, { cdmVersion: 1, createdBy: 'u-creator' });
      const b = await h.docs.create(h.tenant, { cdmVersion: 1, createdBy: 'u-creator' });
      const head = await h.logs.head({ tenant: h.tenant, doc: a.id });
      assert.deepStrictEqual(
        { seq: head.seq, epoch: head.epoch, owner: head.owner },
        { seq: 0, epoch: 0, owner: null },
      );
      assert.match(
        head.incarnation,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      assert.notEqual(head.incarnation, b.incarnation);
      assert.equal(a.historyVisibility, 'editors');
      assert.equal(a.state, 'active');
    },
  },
  {
    name: 'a claim makes the node the owner and raises the epoch by one; only the holder releases',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      assert.equal(epoch, 1);
      assert.equal((await h.logs.head(ref)).owner, 'node-a');
      assert.equal(await h.logs.claim(ref, 'node-b'), 2);
      assert.equal(await h.logs.release(ref, 'node-a', 2), false);
      assert.equal(await h.logs.release(ref, 'node-b', 1), false);
      assert.equal(await h.logs.release(ref, 'node-b', 2), true);
      assert.equal((await h.logs.head(ref)).owner, null);
    },
  },
  {
    name: 'an append with the right epoch and head stores the batch and advances the head',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      const c2 = stepCommit(2, { user: 'bob', session: 's-bob', scopes: [`region:${LEGAL}`] });
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [c1, c2])), { status: 'ok' });
      await assertLog(h, ref, [c1, c2]);
      const c3 = stepCommit(3, { claimed: ['sdavexxxxxxxxxxx'], origin: 'paste' });
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [c3])), { status: 'ok' });
      await assertLog(h, ref, [c1, c2, c3]);
      assert.deepStrictEqual(await h.logs.read(ref, 2, 2), [sorted(c2)]);
      assert.deepStrictEqual(await h.logs.read(ref, 3), [sorted(c3)]);
    },
  },
  {
    name: 'an append with a stale ownership epoch is fenced and stores nothing',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      await h.logs.claim(ref, 'node-b');
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [stepCommit(1)])), {
        status: 'fenced',
      });
      await assertLog(h, ref, []);
    },
  },
  {
    name: 'an append that leaves a gap after the head is fenced and stores nothing',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      await h.logs.append(ref, write(epoch, [c1]));
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [stepCommit(3)])), {
        status: 'fenced',
      });
      await assertLog(h, ref, [c1]);
    },
  },
  {
    name: 'an append for an existing (document, seq) is fenced and stores nothing',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      await h.logs.append(ref, write(epoch, [c1]));
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [stepCommit(1)])), {
        status: 'fenced',
      });
      await assertLog(h, ref, [c1]);
    },
  },
  {
    name: 'an append checked against a replaced grants revision stores nothing and returns the permissions in force',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const next = await h.grants.change(
        ref,
        { removeGrants: [{ region: LEGAL, principal: 'group:legal' }] },
        { actor: 'u-owner' },
      );
      assert.equal(next.revision, 2);
      const r = await h.logs.append(ref, write(epoch, [stepCommit(1)], 1));
      assert.equal(r.status, 'revision_moved');
      assert.deepStrictEqual(r.status === 'revision_moved' ? r.perms : null, next);
      await assertLog(h, ref, []);
      const c1 = stepCommit(1, { revision: 2 });
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [c1], 2)), { status: 'ok' });
      await assertLog(h, ref, [c1]);
    },
  },
  {
    name: 'a batch is stored entirely or not at all',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      await h.logs.append(ref, write(epoch, [c1]));
      const batch = [stepCommit(2), stepCommit(3), stepCommit(4, { id: c1.id })];
      const r = await h.logs.append(ref, write(epoch, batch));
      // Its last commit is stored already: a duplicate (BE-025), and nothing of the batch is written.
      assert.equal(r.status, 'duplicate');
      await assertLog(h, ref, [c1]);
    },
  },
  {
    name: 'a conflict on the commit identifier alone is not another writer',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      await h.logs.append(ref, write(epoch, [c1]));
      const dup = await h.logs.append(ref, write(epoch, [stepCommit(2, { id: c1.id })]));
      assert.notEqual(dup.status, 'fenced');
      // Handled as a duplicate submission, with the stored commit to answer it from (BE-025).
      assert.equal(dup.status, 'duplicate');
      assert.equal(dup.status === 'duplicate' && dup.stored.id, c1.id);
      assert.equal(dup.status === 'duplicate' && dup.stored.seq, 1);
      const c2 = stepCommit(2);
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [c2])), { status: 'ok' });
      await assertLog(h, ref, [c1, c2]);
    },
  },
  {
    name: 'control commits are stored and read back like step commits',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      const c2 = controlCommit(2, 1);
      const c3 = stepCommit(3, { origin: 'format' });
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [c1, c2, c3])), {
        status: 'ok',
      });
      await assertLog(h, ref, [c1, c2, c3]);
    },
  },
  {
    name: "another tenant's log is invisible and cannot be appended to",
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const c1 = stepCommit(1);
      await h.logs.append(ref, write(epoch, [c1]));
      const foreign = { tenant: h.otherTenant, doc: ref.doc };
      assert.deepStrictEqual(await h.logs.read(foreign), []);
      await assert.rejects(h.logs.head(foreign), DocumentNotFoundError);
      assert.deepStrictEqual(await h.logs.append(foreign, write(epoch, [stepCommit(2)])), {
        status: 'fenced',
      });
      await assertLog(h, ref, [c1]);
    },
  },
  {
    name: 'removing a region retires it: its grants, state and lease go, and none attaches again',
    async run(h) {
      const { ref, epoch } = await newDocument(h);
      const rev2 = await h.grants.change(
        ref,
        {
          setRegionStates: [{ region: LEGAL, state: 'in_review' }],
          putLeases: [{ region: LEGAL, holder: 'bob', expiresAt: 1_760_000_900_000 }],
        },
        { actor: 'u-owner' },
      );
      const c1 = stepCommit(1, {
        revision: 2,
        retired: [LEGAL],
        scopes: ['body', `region:${LEGAL}`],
      });
      assert.deepStrictEqual(await h.logs.append(ref, write(epoch, [c1], 2)), { status: 'ok' });
      assert.deepStrictEqual(await h.grants.retired(ref), [LEGAL]);
      const now = await h.grants.current(ref);
      assert.equal(
        now.revision,
        2,
        'retiring is not a change of grants: nothing can match it again',
      );
      assert.deepStrictEqual(
        now.grants.filter((g) => g.region === LEGAL),
        [],
      );
      assert.equal(now.regionStates.has(LEGAL), false);
      assert.deepStrictEqual(now.leases, []);
      await assert.rejects(
        h.grants.change(
          ref,
          {
            putGrants: [
              { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: null },
            ],
          },
          { actor: 'u-owner' },
        ),
        RetiredRegionError,
      );
      await assert.rejects(
        h.grants.change(
          ref,
          { setRegionStates: [{ region: LEGAL, state: 'approved' }] },
          {
            actor: 'u-owner',
          },
        ),
        RetiredRegionError,
      );
      assert.equal((await h.grants.current(ref)).revision, 2);
      // The history still says what was in force at revision 2.
      assert.deepStrictEqual(await h.grants.at(ref, 2), rev2);
      // PRM-002 criterion 1: a change that fails part-way writes none of its rows and no
      // revision. This one changes the document state and puts a valid grant, then reaches the
      // retired region; the store must show neither of the first two (07 §9).
      const before = await h.grants.current(ref);
      const historyBefore = await h.grants.history(ref);
      await assert.rejects(
        h.grants.change(
          ref,
          {
            documentState: 'locked',
            putGrants: [
              { region: TERMS, principal: 'user:dave', role: 'editor', expiresAt: null },
              { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: null },
            ],
          },
          { actor: 'u-owner' },
        ),
        RetiredRegionError,
      );
      assert.deepStrictEqual(await h.grants.current(ref), before);
      assert.deepStrictEqual(await h.grants.history(ref), historyBefore);
      assert.equal((await h.docs.get(ref))?.state, before.documentState);
    },
  },
];

export const GRANT_STORE_CHECKS: Check[] = [
  {
    name: 'a change raises the revision by one and the history keeps every revision',
    async run(h) {
      const { ref } = await newDocument(h);
      const r1 = await h.grants.current(ref);
      assert.equal(r1.revision, 1);
      assert.deepStrictEqual(await h.grants.at(ref, 1), r1);
      const r2 = await h.grants.change(
        ref,
        {
          putGrants: [{ region: TERMS, principal: 'everyone', role: 'commenter', expiresAt: null }],
        },
        { actor: 'u-owner' },
      );
      const r3 = await h.grants.change(ref, { documentState: 'locked' }, { actor: 'u-owner' });
      assert.deepStrictEqual([r2.revision, r3.revision], [2, 3]);
      assert.deepStrictEqual(await h.grants.history(ref), [r1, r2, r3]);
      assert.deepStrictEqual(await h.grants.at(ref, 2), r2);
      assert.equal(await h.grants.at(ref, 4), null);
      assert.deepStrictEqual(await h.grants.current(ref), r3);
      assert.equal((await h.docs.get(ref))?.state, 'locked');
    },
  },
  {
    name: 'a change made against a replaced revision is refused and changes nothing',
    async run(h) {
      const { ref } = await newDocument(h);
      await h.grants.change(ref, { documentState: 'locked' }, { actor: 'u-owner' });
      await assert.rejects(
        h.grants.change(ref, { documentState: 'archived' }, { actor: 'u-owner', ifRevision: 1 }),
        (e: unknown) => e instanceof RevisionConflictError && e.current === 2,
      );
      const now = await h.grants.current(ref);
      assert.deepStrictEqual([now.revision, now.documentState], [2, 'locked']);
      const r3 = await h.grants.change(
        ref,
        { documentState: 'active' },
        { actor: 'u-owner', ifRevision: 2 },
      );
      assert.equal(r3.revision, 3);
    },
  },
  {
    name: 'grants, region states, leases, the document state and the workflow flag round-trip',
    async run(h) {
      const { ref } = await newDocument(h);
      const expiry = 1_760_000_123_456;
      const r = await h.grants.change(
        ref,
        {
          putGrants: [
            { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: expiry },
            { region: LEGAL, principal: 'user:dave', role: 'commenter', expiresAt: null },
          ],
          setRegionStates: [{ region: TERMS, state: 'approved' }],
          putLeases: [{ region: 'rNotes000000000C', holder: 'alice', expiresAt: expiry + 1 }],
          documentState: 'locked',
          workflowActive: true,
        },
        { actor: 'u-owner' },
      );
      // A lease put without an id or acquisition time gets both from the store (06 §4.1:
      // lease_id and acquired_at are not null; the Lease type of @docedit/authority).
      const assigned = r.leases[0];
      assert.match(assigned?.id ?? '', UUID);
      assert.ok(Number.isSafeInteger(assigned?.acquiredAt), 'the acquisition time is kept');
      assert.deepStrictEqual(r, {
        revision: 2,
        grants: [
          { region: LEGAL, principal: 'group:legal', role: 'editor', expiresAt: null },
          { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: expiry },
          { region: LEGAL, principal: 'user:dave', role: 'commenter', expiresAt: null },
        ],
        regionStates: new Map([[TERMS, 'approved']]),
        leases: [
          {
            region: 'rNotes000000000C',
            holder: 'alice',
            expiresAt: expiry + 1,
            id: assigned!.id!,
            acquiredAt: assigned!.acquiredAt!,
          },
        ],
        documentState: 'locked',
        workflowActive: true,
      } satisfies PermissionState);
      const back = await h.grants.change(
        ref,
        {
          removeGrants: [{ region: LEGAL, principal: 'user:carol' }],
          clearRegionStates: [TERMS],
          removeLeases: ['rNotes000000000C'],
          documentState: 'active',
          workflowActive: false,
        },
        { actor: 'u-owner' },
      );
      assert.deepStrictEqual(back, {
        revision: 3,
        grants: [
          { region: LEGAL, principal: 'group:legal', role: 'editor', expiresAt: null },
          { region: LEGAL, principal: 'user:dave', role: 'commenter', expiresAt: null },
        ],
        regionStates: new Map(),
        leases: [],
        documentState: 'active',
        workflowActive: false,
      } satisfies PermissionState);
      assert.deepStrictEqual(await h.grants.at(ref, 2), r, 'history keeps the lease id and time');
      // A lease put with its id and acquisition time keeps both (PRM-044: a heartbeat must not
      // restart the eight-hour maximum).
      const lease = {
        region: 'rNotes000000000C',
        holder: 'alice',
        expiresAt: expiry + 2,
        id: uuid7(),
        acquiredAt: expiry - 1_000,
      };
      const kept = await h.grants.change(ref, { putLeases: [lease] }, { actor: 'u-owner' });
      assert.deepStrictEqual(kept.leases, [lease]);
      assert.deepStrictEqual((await h.grants.current(ref)).leases, [lease]);
    },
  },
  {
    name: "another tenant's permission data is invisible",
    async run(h) {
      const { ref } = await newDocument(h);
      const foreign = { tenant: h.otherTenant, doc: ref.doc };
      await assert.rejects(h.grants.current(foreign), DocumentNotFoundError);
      await assert.rejects(
        h.grants.change(foreign, { documentState: 'locked' }, { actor: 'u-intruder' }),
        DocumentNotFoundError,
      );
      assert.equal((await h.grants.current(ref)).documentState, 'active');
    },
  },
];

/** Runs every check and returns the names of those that failed, with the reason. */
export async function failingChecks(
  checks: readonly Check[],
  harness: () => StoreHarness,
): Promise<string[]> {
  const failed: string[] = [];
  for (const c of checks) {
    try {
      await c.run(harness());
    } catch (e) {
      failed.push(`${c.name}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  return failed;
}
