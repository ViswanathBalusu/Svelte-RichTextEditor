// SYN-030 criterion 3, the deterministic commit identifier (lane w9; ADR 0377, proposed): the
// identifier of a server-authored commit is derived from the request, so the same request written
// to the outbox twice is one item and one commit identifier, and another request is another one.
// Memory storage; the room's handling of a redelivered identifier is syn-030.outbox.pg.test.ts and
// `test/room-commits.test.ts` of the authority.
import { isUuid7, type JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { derivedCommitId, stableJson } from '../../src/data-plane/commit-id.ts';
import { MemoryAudit, MemoryOutbox } from '../../src/data-plane/memory-ports.ts';
import { enqueueRepair, type RepairPlan } from '../../src/data-plane/repair.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { BASE_JSON, REQUIRES, startPlane, type Plane } from './support.ts';

describe('derivedCommitId', () => {
  it('is a UUID version 7 that a commit accepts, and the same for the same parts', () => {
    const a = derivedCommitId('prefill', 't1', 'd1', 'user:ada', '12', '[]');
    expect(isUuid7(a)).toBe(true);
    expect(derivedCommitId('prefill', 't1', 'd1', 'user:ada', '12', '[]')).toBe(a);
  });

  it('changes with any part, and cannot be forged by moving a boundary between parts', () => {
    const base: string[] = ['prefill', 't1', 'd1', 'user:ada', '12', '[]'];
    const ids = new Set([derivedCommitId(...base)]);
    for (let i = 0; i < base.length; i++) {
      const changed = [...base];
      changed[i] = `${base[i]}x`;
      ids.add(derivedCommitId(...changed));
    }
    expect(ids.size).toBe(base.length + 1);
    expect(derivedCommitId('ab', 'c')).not.toBe(derivedCommitId('a', 'bc'));
  });
});

describe('stableJson', () => {
  it('gives the same text for objects with the same keys in another order, at any depth', () => {
    expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(
      stableJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }),
    );
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
});

function plan(over: Partial<RepairPlan> = {}): RepairPlan {
  return {
    ref: { tenant: 't1', doc: 'doc1' },
    operator: 'op1',
    reason: 'test',
    head: 7,
    from: 5,
    currentHash: 'a'.repeat(64),
    targetHash: 'b'.repeat(64),
    changes: true,
    payload: new Uint8Array([1, 2, 3]),
    ...over,
  } as RepairPlan;
}

describe('a repair written to the outbox twice (SYN-030 criterion 3)', () => {
  it('keeps one item with one commit identifier, and another head or content is another one', async () => {
    const outbox = new MemoryOutbox();
    const audit = new MemoryAudit();
    const first = await enqueueRepair({ plan: plan(), outbox, audit });
    const again = await enqueueRepair({ plan: plan(), outbox, audit });
    expect(isUuid7(first.commitId)).toBe(true);
    expect(again.commitId).toBe(first.commitId);
    expect(again.id).toBe(first.id);
    expect(await outbox.claim('syn-030-w9', 60_000, 10)).toHaveLength(1);

    const moved = await enqueueRepair({ plan: plan({ head: 8 }), outbox, audit });
    const other = await enqueueRepair({
      plan: plan({ targetHash: 'c'.repeat(64) }),
      outbox,
      audit,
    });
    expect(new Set([first.commitId, moved.commitId, other.commitId]).size).toBe(3);
  });
});

// The data plane's own write of a snapshot: a request identifier makes the commit identifier derived.
let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a replacement of the content retried with the same request (SYN-030 criterion 3)', () => {
  it('is stored once, and a request with another identifier is stored again', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    const ref: DocRef = { tenant: p.tenant, doc };
    const content = {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    } as JsonEnvelope;

    const first = await p.plane.replaceContent(ref, content, 'alice', { requestId: 'job-1' });
    const again = await p.plane.replaceContent(ref, content, 'alice', { requestId: 'job-1' });
    expect(again.seq).toBe(first.seq);
    const other = await p.plane.replaceContent(ref, content, 'alice', { requestId: 'job-2' });
    expect(other.seq).toBe(first.seq + 1);
    expect(p.errors).toEqual([]);
  });
});
