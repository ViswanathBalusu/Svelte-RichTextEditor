// Notifications the control plane hands to the data plane for an export that is cancelled and for a
// stored metadata change (05 §5.6; PRO-035 criteria 2 and 4), in memory and with PostgreSQL. The
// data plane is the stub that records what it is told (`h.stub.notices`); the channel side is
// `services/document-service/src/data-plane/notifications.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`notifications for exports and metadata (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const documentNotices = () => h.stub.notices.filter((n) => n.kind === 'document').length;

    it.skipIf(skip)(
      'tells the requester that a cancelled export ended, with the job as resource (PRO-035 criterion 2)',
      async () => {
        const doc = await h.createDocument();
        const ann = h.userToken({ [doc]: 'editor' }, { sub: 'ann' });
        const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: ann,
          body: { target: 'pdf' },
        });
        expect(created.status).toBe(202);
        const jid = created.json.id as string;
        const before = h.stub.notices.length;
        const cancelled = await h.call('DELETE', `/v1/exports/${jid}`, { token: ann });
        expect(cancelled.status).toBe(204);
        const notes = h.stub.notices.slice(before).filter((n) => n.kind === 'notify');
        expect(notes).toHaveLength(1);
        expect(notes[0]!.notification).toEqual({
          type: 'export.cancelled',
          resource: `/exports/${jid}`,
          data: { state: 'cancelled' },
        });
        // The notice is addressed to the job's requester (its `createdBy`, the principal the
        // control plane stores; it is not the token's `sub`). The data plane matches it to channels.
        expect(notes[0]!.user).toEqual(expect.any(String));
      },
    );

    it.skipIf(skip)(
      'raises document.updated when a metadata change is stored, and nothing when it is refused (PRO-035 criterion 4)',
      async () => {
        const doc = await h.createDocument({ title: 'before' });
        const got = await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
        const etag = got.headers.get('etag')!;

        const start = documentNotices();
        const patched = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: h.apiKey,
          body: { title: 'after' },
          headers: { 'If-Match': etag },
        });
        expect(patched.status).toBe(200);
        expect(documentNotices() - start).toBe(1);
        const notice = h.stub.notices.filter((n) => n.kind === 'document').at(-1)!;
        expect(JSON.stringify(notice.ref)).toContain(doc);

        // A stale If-Match is refused before anything is stored, so nothing is raised.
        const stale = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: h.apiKey,
          body: { title: 'refused' },
          headers: { 'If-Match': etag },
        });
        expect(stale.status).toBe(412);
        expect(documentNotices() - start).toBe(1);
      },
    );

    it.skipIf(skip)(
      'raises document.updated for a changed field only, not for a PATCH that leaves every field as it was (PRO-035 criterion 4)',
      async () => {
        const doc = await h.createDocument({ title: 'same', properties: { a: 1 } });
        const etagOf = async () =>
          (await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })).headers.get('etag')!;
        const patch = async (body: Record<string, unknown>) =>
          h.call('PATCH', `/v1/documents/${doc}`, {
            token: h.apiKey,
            body,
            headers: { 'If-Match': await etagOf() },
          });

        const start = documentNotices();
        // The same title, the same properties and the same state: stored, but nothing changed.
        expect((await patch({ title: 'same', properties: { a: 1 }, state: 'active' })).status).toBe(
          200,
        );
        expect(documentNotices() - start).toBe(0);
        // A changed property alone is a change.
        expect((await patch({ properties: { a: 2 } })).status).toBe(200);
        expect(documentNotices() - start).toBe(1);
      },
    );
  });
}
