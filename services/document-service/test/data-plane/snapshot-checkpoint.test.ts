// A checkpoint is written when a snapshot commit is stored (06 §2.2 (3); BE-020 criterion 2). The
// room is the real one, over the in-memory stores; checkpoints are written inline (workers: 0).
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { insertText } from './client.ts';
import {
  BASE_JSON,
  MemoryCheckpoints,
  REQUIRES,
  startPlane,
  until,
  type Plane,
} from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** Checkpoints that record the `seq` of every write. */
class SpyCheckpoints extends MemoryCheckpoints {
  readonly seqs: number[] = [];
  override async put(ref: DocRef, seq: number, content: Parameters<MemoryCheckpoints['put']>[2]) {
    this.seqs.push(seq);
    return super.put(ref, seq, content);
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a checkpoint follows a snapshot commit (BE-020 criterion 2)', () => {
  it('writes a checkpoint at the snapshot seq once a snapshot commit is stored after changes', async () => {
    const checkpoints = new SpyCheckpoints();
    const p = await startPlane({ checkpoints });
    planes.push(p);
    const doc = await p.createDocument();
    const ref: DocRef = { tenant: p.tenant, doc };
    checkpoints.seqs.length = 0;

    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    await alice.submit(1, { base: 0, steps: [insertText(intro(), 'before the snapshot')] });
    // A step commit alone does not reach the policy's thresholds, so no checkpoint is due yet.
    expect(checkpoints.seqs).toEqual([]);

    const content: JsonEnvelope = {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    } as JsonEnvelope;
    const snap = await p.plane.replaceContent(ref, content, 'alice');
    expect(snap.seq).toBe(2);
    await until(() => checkpoints.seqs.includes(2), 3000, 'a checkpoint at the snapshot');
    // The room also writes a checkpoint at seq 1 after the snapshot; that order is not asserted here
    // (see the story notes), only that the snapshot itself is checkpointed and nothing fails.
    expect(checkpoints.seqs).toContain(2);
    expect(p.errors).toEqual([]);
  });
});
