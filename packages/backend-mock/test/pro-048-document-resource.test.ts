// The metadata read of the mock (PRO-048; UX-085): `sync.document` returns the label, a change of
// the label raises `document.updated` to the open channels, and the ETag moves with it.
import { contractDocument } from '@docedit/protocol/contract';
import type { Notification } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { MockService } from '../src/index.ts';

describe('the mock document resource (PRO-048)', () => {
  it('reads the label, raises document.updated on a change and clears the label', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const b = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await b.connect();
    const first = await b.sync.document!(docId);
    expect(first.value.classification).toBeNull();
    expect(first.value.id).toBe(docId);

    const content = await b.sync.loadContent(docId);
    const ch = await b.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const events: Notification[] = [];
    ch.onEvent((e) => events.push(e));

    service.setClassification(docId, 'Internal use only');
    await new Promise((r) => setTimeout(r, 0));
    expect(events.map((e) => [e.type, e.resource])).toEqual([
      ['document.updated', `/documents/${docId}`],
    ]);
    const set = await b.sync.document!(docId);
    expect(set.value.classification).toBe('Internal use only');
    expect(set.etag).not.toBe(first.etag);

    service.setClassification(docId, null);
    expect((await b.sync.document!(docId)).value.classification).toBeNull();
    await service.dispose();
  });

  it('refuses a document the caller has no role in', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const b = service.backend({ sub: 'nobody' }, {});
    await b.connect();
    await expect(b.sync.document!(docId)).rejects.toMatchObject({ code: expect.any(String) });
    await service.dispose();
  });
});
