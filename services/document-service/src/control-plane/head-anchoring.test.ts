// The hourly anchoring of chain heads (HIS-036; ADR 0409) over a store in memory, write-once files
// in memory and a signing client that is a stand-in: which heads a record covers, how the records
// of a tenant follow one another, what a run that stops leaves behind, and that the next run covers
// what it missed. The real signing service, PostgreSQL and the write-once bucket are in
// test/postgres/his-036-head-anchoring.pg.test.ts.
import { createHash } from 'node:crypto';
import {
  anchorPath,
  headAnchorRecordText,
  headCovered,
  parseHeadAnchorRecord,
  parseLeafList,
  type AnchoredHead,
} from '@docedit/history';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { objectKeys } from '../objects/store.ts';
import type { AnchorAttempt, BatchAnchorJob } from '../workflow/signing-client.ts';
import {
  ANCHOR_PERIOD_MS,
  HeadAnchoring,
  HeadAnchoringError,
  headAnchoringTask,
  MemoryHeadAnchorFiles,
  type AnchorFailure,
  type HeadAnchorFile,
  type HeadAnchorFiles,
  type HeadAnchorStore,
  type StoredHeadAnchor,
} from './head-anchoring.ts';

const T = '11111111-1111-4111-8111-111111111111';
const INCARNATION = '33333333-3333-4333-8333-333333333333';
const NOW = Date.UTC(2026, 10, 21, 1, 0, 0);
const HOUR = ANCHOR_PERIOD_MS;
const DAY = 24 * HOUR;
const doc = (n: number) => `22222222-2222-4222-8222-${n.toString(16).padStart(12, '0')}`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const chain = (n: number, seq: number) => sha(`head ${n} at ${seq}`);

/** The rows in memory: the heads as the log has them, and what the records cover. */
class FakeStore implements HeadAnchorStore {
  readonly heads = new Map<string, AnchoredHead>();
  readonly covered = new Map<string, AnchoredHead>();
  readonly anchors: StoredHeadAnchor[] = [];
  failRecord = false;
  supersede = false;

  commit(n: number, seq: number, incarnation = INCARNATION): void {
    this.heads.set(doc(n), { doc: doc(n), incarnation, seq, chainHead: chain(n, seq) });
  }

  async changedHeads(): Promise<AnchoredHead[]> {
    return [...this.heads.values()]
      .filter((h) => {
        const c = this.covered.get(h.doc);
        return (
          !c || c.seq !== h.seq || c.incarnation !== h.incarnation || c.chainHead !== h.chainHead
        );
      })
      .sort((a, b) => (a.doc < b.doc ? -1 : 1));
  }

  async latest(): Promise<StoredHeadAnchor | null> {
    return this.anchors[this.anchors.length - 1] ?? null;
  }

  async unstored(): Promise<StoredHeadAnchor[]> {
    return this.anchors.filter((a) => a.state === 'signed');
  }

  async record(
    _t: string,
    anchor: StoredHeadAnchor,
    heads: readonly AnchoredHead[],
  ): Promise<boolean> {
    if (this.failRecord) throw new Error('the database is down');
    if (this.supersede) return false;
    const newest = this.anchors[this.anchors.length - 1];
    if ((newest?.to ?? null) !== anchor.from) return false;
    this.anchors.push({ ...anchor });
    for (const h of heads) this.covered.set(h.doc, { ...h });
    return true;
  }

  async markStored(_t: string, to: string): Promise<void> {
    const a = this.anchors.find((x) => x.to === to);
    if (a) a.state = 'stored';
  }
}

/** A signing client that composes the record as the service does and "signs" it with a marker. */
class FakeSigning {
  readonly jobs: BatchAnchorJob[] = [];
  fail: { code: string; retryable: boolean } | null = null;
  wrongRecord = false;
  unreachable = false;

  async anchorBatch(job: BatchAnchorJob): Promise<AnchorAttempt> {
    if (this.unreachable) throw new Error('connect ECONNREFUSED');
    this.jobs.push(job);
    if (this.fail)
      return {
        ok: false,
        reason: this.fail.code === 'tsa_unreachable' ? 'tsa_unreachable' : 'signing_unavailable',
        code: this.fail.code,
        retryable: this.fail.retryable,
      };
    const text = headAnchorRecordText(this.wrongRecord ? { ...job, leaves: job.leaves + 1 } : job);
    if (!text.ok) throw new Error(text.reason);
    return {
      ok: true,
      record: text.text,
      recordSha256: sha(text.text),
      cms: new TextEncoder().encode(`signature over ${sha(text.text)}`),
      timestampTime: new Date(Date.parse(job.to) + 1000),
      keyId: 'operator-key',
    };
  }
}

function setup(files: HeadAnchorFiles = new MemoryHeadAnchorFiles()) {
  const store = new FakeStore();
  const signing = new FakeSigning();
  const audit = new MemoryAudit();
  const anchoring = new HeadAnchoring({
    store,
    signing,
    files,
    audit,
    retainMs: 365 * DAY,
    now: () => NOW,
  });
  return { store, signing, audit, anchoring, files };
}

const fileOf = async (files: HeadAnchorFiles, key: string): Promise<HeadAnchorFile> =>
  JSON.parse(new TextDecoder().decode((await files.get(key))!)) as HeadAnchorFile;

describe('the hourly anchoring of chain heads (HIS-036)', () => {
  it('signs one record over the heads of the documents that have commits, and writes it and its leaf list once', async () => {
    const s = setup();
    s.store.commit(1, 4);
    s.store.commit(2, 9);
    s.store.commit(3, 1);
    const r = await s.anchoring.run(T, NOW);
    if (!r.anchored) throw new Error('no record');
    const to = '2026-11-21T01:00:00.000Z';
    expect(r).toMatchObject({ to, leaves: 3, finished: 0 });

    // What the signing service was sent: the root and the count, and no head.
    expect(s.signing.jobs).toEqual([
      { tenant: T, from: null, to, root: r.root, leaves: 3, previous: null },
    ]);

    // The record names the tenant, the time, the root and the count.
    const key = objectKeys.headAnchor(T, to);
    expect(key).toBe(`tenants/${T}/anchors/heads/20261121T010000.000Z.json`);
    const file = await fileOf(s.files, key);
    expect(file).toMatchObject({ format: 'docedit-anchor-file/1', keyId: 'operator-key' });
    expect(file.recordSha256).toBe(sha(file.record));
    const parsed = parseHeadAnchorRecord(file.record);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.record).toEqual({
      format: 'docedit-anchor/1',
      tenant: T,
      from: null,
      to,
      root: r.root,
      leaves: 3,
      previous: null,
    });

    // The leaf list records the document, the incarnation, the seq and the head hash of each, and
    // every head leads to the root of the record.
    const leavesText = new TextDecoder().decode(
      (await s.files.get(objectKeys.headAnchorLeaves(T, to)))!,
    );
    const list = await parseLeafList(leavesText);
    if (!list.ok) throw new Error(list.reason);
    expect(list.tree.root).toBe(r.root);
    expect(list.tree.leaves.map((l) => [l.doc, l.incarnation, l.seq, l.chainHead])).toEqual(
      [1, 2, 3].map((n) => [doc(n), INCARNATION, [4, 9, 1][n - 1], chain(n, [4, 9, 1][n - 1]!)]),
    );
    for (const n of [1, 2, 3]) {
      const p = await anchorPath(list.tree, doc(n));
      if (!p.ok) throw new Error(p.reason);
      expect(await headCovered(parsed.record, { head: p.head, path: p.path })).toMatchObject({
        covered: true,
      });
    }

    expect(s.store.anchors).toMatchObject([{ to, state: 'stored', leaves: 3 }]);
    const events = await s.audit.query(T, { kind: 'heads.anchored', limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      doc: null,
      actor: 'system',
      data: { to, from: null, leaves: 3, root: r.root, keyId: 'operator-key' },
    });
  });

  it('writes no record for a tenant with no change, and signs nothing', async () => {
    const s = setup();
    expect(await s.anchoring.run(T, NOW)).toEqual({
      anchored: false,
      reason: 'no-change',
      finished: 0,
    });
    s.store.commit(1, 2);
    await s.anchoring.run(T, NOW);
    expect(await s.anchoring.run(T, NOW + HOUR)).toMatchObject({ anchored: false });
    expect(s.signing.jobs).toHaveLength(1);
    expect((s.files as MemoryHeadAnchorFiles).keys()).toHaveLength(2);
  });

  it('covers only the heads that changed since, and names the record before it', async () => {
    const s = setup();
    s.store.commit(1, 4);
    s.store.commit(2, 9);
    const first = await s.anchoring.run(T, NOW);
    if (!first.anchored) throw new Error('no record');
    // Document 2 gets commits, document 3 is new, and document 1 gets a new incarnation.
    s.store.commit(2, 12);
    s.store.commit(3, 1);
    const second = await s.anchoring.run(T, NOW + HOUR);
    if (!second.anchored) throw new Error('no record');
    expect(second.leaves).toBe(2);
    expect(s.signing.jobs[1]).toMatchObject({
      from: first.to,
      to: '2026-11-21T02:00:00.000Z',
      previous: first.recordSha256,
      leaves: 2,
    });
    s.store.commit(1, 4, '44444444-4444-4444-8444-444444444444');
    const third = await s.anchoring.run(T, NOW + 2 * HOUR);
    if (!third.anchored) throw new Error('no record');
    expect(third.leaves).toBe(1);
    expect(s.signing.jobs[2]).toMatchObject({ from: second.to, previous: second.recordSha256 });
    // The records of the tenant form one line.
    expect(s.store.anchors.map((a) => [a.from, a.to])).toEqual([
      [null, first.to],
      [first.to, second.to],
      [second.to, third.to],
    ]);
  });

  it('records nothing when the signature or the time-stamp cannot be had, and the next run covers what was missed (criterion 5)', async () => {
    const s = setup();
    s.store.commit(1, 4);
    const first = await s.anchoring.run(T, NOW);
    if (!first.anchored) throw new Error('no record');

    // Two hours in which the authority does not answer; the documents go on changing.
    s.signing.fail = { code: 'tsa_unreachable', retryable: true };
    s.store.commit(1, 6);
    await expect(s.anchoring.run(T, NOW + HOUR)).rejects.toMatchObject({
      name: 'HeadAnchoringError',
      stage: 'sign',
      code: 'tsa_unreachable',
      retryable: true,
    });
    s.store.commit(2, 3);
    s.signing.unreachable = true;
    await expect(s.anchoring.run(T, NOW + 2 * HOUR)).rejects.toMatchObject({
      stage: 'sign',
      code: 'unreachable',
    });
    // Nothing says "anchored" for those hours.
    expect(s.store.anchors).toHaveLength(1);
    expect(s.store.covered.get(doc(1))!.seq).toBe(4);
    expect(await s.audit.query(T, { kind: 'heads.anchored', limit: 5 })).toHaveLength(1);

    // The service answers again: one record covers both documents, from the last record that worked.
    s.signing.fail = null;
    s.signing.unreachable = false;
    const next = await s.anchoring.run(T, NOW + 3 * HOUR);
    if (!next.anchored) throw new Error('no record');
    expect(next.leaves).toBe(2);
    const job = s.signing.jobs[s.signing.jobs.length - 1]!;
    expect(job).toMatchObject({ from: first.to, previous: first.recordSha256 });
    expect(s.store.covered.get(doc(1))!.seq).toBe(6);
    expect(s.store.covered.get(doc(2))!.seq).toBe(3);
    expect(await s.store.changedHeads()).toEqual([]);
  });

  it('refuses a record that does not say what was asked', async () => {
    const s = setup();
    s.store.commit(1, 4);
    s.signing.wrongRecord = true;
    await expect(s.anchoring.run(T, NOW)).rejects.toMatchObject({
      stage: 'sign',
      code: 'record_differs',
      retryable: false,
    });
    expect(s.store.anchors).toEqual([]);
  });

  it('counts nothing as anchored when the record cannot be stored, and signs again at the next run', async () => {
    const s = setup();
    s.store.commit(1, 4);
    s.store.failRecord = true;
    await expect(s.anchoring.run(T, NOW)).rejects.toMatchObject({ stage: 'record' });
    expect(s.store.covered.size).toBe(0);
    s.store.failRecord = false;
    const next = await s.anchoring.run(T, NOW + HOUR);
    expect(next).toMatchObject({ anchored: true, leaves: 1 });
    expect(s.signing.jobs[1]).toMatchObject({ from: null, previous: null });
    // Another run was first: this one's signature is not used, and it says so.
    s.store.commit(1, 5);
    s.store.supersede = true;
    await expect(s.anchoring.run(T, NOW + 2 * HOUR)).rejects.toMatchObject({
      stage: 'record',
      code: 'superseded',
    });
  });

  it('finishes a record that was signed and not written before it signs anything new', async () => {
    const inner = new MemoryHeadAnchorFiles();
    let failRecords = true;
    const files: HeadAnchorFiles = {
      put: async (key, bytes, until) => {
        // The leaf list is written; the record itself cannot be, for now.
        if (failRecords && !key.endsWith('.leaves.json')) throw new Error('the bucket is down');
        return inner.put(key, bytes, until);
      },
      get: (key) => inner.get(key),
    };
    const s = setup(files);
    s.store.commit(1, 4);
    await expect(s.anchoring.run(T, NOW)).rejects.toMatchObject({
      stage: 'store',
      retryable: true,
    });
    // It is signed and recorded, so its heads count as covered; the object is still to be written.
    expect(s.store.anchors).toMatchObject([{ state: 'signed' }]);
    expect(inner.keys()).toEqual([objectKeys.headAnchorLeaves(T, '2026-11-21T01:00:00.000Z')]);

    // Still down an hour later: the run stops before it signs a new record.
    s.store.commit(2, 1);
    await expect(s.anchoring.run(T, NOW + HOUR)).rejects.toMatchObject({ stage: 'store-earlier' });
    expect(s.signing.jobs).toHaveLength(1);

    failRecords = false;
    const next = await s.anchoring.run(T, NOW + 2 * HOUR);
    expect(next).toMatchObject({ anchored: true, leaves: 1, finished: 1 });
    expect(s.store.anchors.map((a) => a.state)).toEqual(['stored', 'stored']);
    // The first record went to write-once storage as it was signed, with its own retention.
    const first = await fileOf(inner, objectKeys.headAnchor(T, '2026-11-21T01:00:00.000Z'));
    expect(first.record).toBe(s.store.anchors[0]!.record);
    expect(s.signing.jobs[1]).toMatchObject({
      from: '2026-11-21T01:00:00.000Z',
      previous: s.store.anchors[0]!.recordSha256,
    });
  });

  it('never overwrites a stored object: the same bytes are accepted, other bytes are refused', async () => {
    const files = new MemoryHeadAnchorFiles();
    const a = new TextEncoder().encode('one');
    expect(await files.put('k', a, NOW)).toBe('stored');
    expect(await files.put('k', a, NOW)).toBe('existing');
    await expect(files.put('k', new TextEncoder().encode('two'), NOW)).rejects.toThrow(
      /another object/,
    );
    expect(new TextDecoder().decode((await files.get('k'))!)).toBe('one');
  });

  it('is an hourly task that deletes nothing, counts a tenant that got a record, and tells the operator when a run stops', async () => {
    const s = setup();
    const failures: AnchorFailure[] = [];
    const task = headAnchoringTask(s.anchoring, (f) => void failures.push(f));
    expect(task.name).toBe('heads.anchor');
    expect(task.everyMs).toBe(60 * 60 * 1000);
    expect(task.deletes).toBeUndefined();
    expect(await task.forTenant!(T, NOW, { held: new Set() })).toBe(0);
    s.store.commit(1, 4);
    expect(await task.forTenant!(T, NOW, { held: new Set() })).toBe(1);
    s.store.commit(1, 5);
    s.signing.fail = { code: 'signing_unavailable', retryable: true };
    await expect(task.forTenant!(T, NOW + HOUR, { held: new Set() })).rejects.toBeInstanceOf(
      HeadAnchoringError,
    );
    expect(failures).toEqual([
      { tenant: T, stage: 'sign', code: 'signing_unavailable', retryable: true },
    ]);
  });

  it('refuses a retention that is not a positive whole number', () => {
    const s = setup();
    expect(
      () =>
        new HeadAnchoring({
          store: s.store,
          signing: s.signing,
          files: s.files,
          audit: s.audit,
          retainMs: 0,
          now: () => NOW,
        }),
    ).toThrow(RangeError);
  });
});
