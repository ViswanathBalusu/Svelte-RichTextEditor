// BE-039 criterion 1 (lane w5): the commit identifier of a replacement or a restore is derived from
// the request, so that a retry is one item and one commit (SYN-030 criterion 3; ADR 0377, proposed).
// Without a request identifier the head the caller authorised the change against, with the hash of
// the content, names the request: the same replacement of the same head is the same commit, and a
// replacement made after the head moved is another. The real data plane over the memory stores.
import { isUuid7, type JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON, REQUIRES, startPlane, type Plane } from './support.ts';
import { MemoryOutbox } from '../../src/data-plane/memory-ports.ts';
import type { NewOutboxItem } from '../../src/storage/types.ts';

class RecordingOutbox extends MemoryOutbox {
  readonly written: NewOutboxItem[] = [];
  override async enqueue(item: NewOutboxItem) {
    this.written.push(item);
    return super.enqueue(item);
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const content = (marker = 0): JsonEnvelope => {
  // Another content: the title of the fixture document with a marker added.
  const text = JSON.stringify(BASE_JSON).replace('Lease agreement', `Lease agreement ${marker}`);
  return { cdm: 1, requires: [...REQUIRES], doc: JSON.parse(text) } as unknown as JsonEnvelope;
};

describe('a replacement is the same commit when it is the same request (BE-039 criterion 1)', () => {
  it('stores one commit for the same replacement of the same head, and another for another head or content', async () => {
    const outbox = new RecordingOutbox(() => Date.now());
    const p = await startPlane({ deps: { outbox } });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);

    const first = await p.plane.replaceContent(ref, content(), 'alice', { head: '"inc-1:0"' });
    const again = await p.plane.replaceContent(ref, content(), 'alice', { head: '"inc-1:0"' });
    expect(again.seq).toBe(first.seq);
    expect((await p.stores.logs.head(ref)).seq).toBe(first.seq);
    expect(outbox.written.map((w) => w.commitId)).toEqual([
      outbox.written[0]!.commitId,
      outbox.written[0]!.commitId,
    ]);
    expect(isUuid7(outbox.written[0]!.commitId)).toBe(true);
    expect(outbox.all).toHaveLength(1);

    // Another head, another actor, or other content is another request.
    await p.plane.replaceContent(ref, content(), 'alice', { head: '"inc-1:1"' });
    await p.plane.replaceContent(ref, content(), 'bob', { head: '"inc-1:1"' });
    await p.plane.replaceContent(ref, content(1), 'bob', { head: '"inc-1:1"' });
    const ids = outbox.written.map((w) => w.commitId);
    expect(new Set(ids).size).toBe(4);
    expect(p.errors).toEqual([]);
  });

  it('keeps a random identifier for a caller that names neither a request nor a head', async () => {
    const outbox = new RecordingOutbox(() => Date.now());
    const p = await startPlane({ deps: { outbox } });
    planes.push(p);
    const doc = await p.createDocument();
    await p.plane.replaceContent(p.ref(doc), content(), 'alice');
    await p.plane.replaceContent(p.ref(doc), content(), 'alice');
    expect(new Set(outbox.written.map((w) => w.commitId)).size).toBe(2);
  });
});
