// `document.updated` reaches the open channels when a document state change or a deletion is stored
// (PRO-035 criterion 4; 05 §5.6). The control plane tells the data plane through `notifier`
// (control-plane/handlers.ts); the stub data plane records those calls. In-memory storage only.
// Metadata-only changes (title, properties, classification) call it too
// (pro-035-notifications.test.ts); a PATCH that leaves every field as it was calls nothing.
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { startHarness, type Harness } from './support.ts';

describe('document.updated after a stored state change or deletion (PRO-035 criterion 4)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory');
  });
  afterAll(async () => {
    await h?.close();
  });

  it('tells the data plane after a state change is stored, after the permissions', async () => {
    const doc = await h.createDocument({});
    const owner = h.userToken({ [doc]: 'owner' });
    const r = await h.call('PATCH', `/v1/documents/${doc}`, {
      token: owner,
      body: { state: 'locked' },
      headers: { 'If-Match': '"m1"' },
    });
    expect(r.status).toBe(200);
    const kinds = h.stub.notices.filter((n) => n.ref?.doc === doc).map((n) => n.kind);
    expect(kinds).toEqual(['permissions', 'document']);
  });

  it('tells the data plane after a document is deleted', async () => {
    const doc = await h.createDocument({});
    const owner = h.userToken({ [doc]: 'owner' });
    const r = await h.call('DELETE', `/v1/documents/${doc}`, { token: owner });
    expect(r.status).toBe(204);
    const kinds = h.stub.notices.filter((n) => n.ref?.doc === doc).map((n) => n.kind);
    expect(kinds).toContain('document');
  });

  it('sends nothing for a document that a state change did not touch', async () => {
    const doc = await h.createDocument({});
    const owner = h.userToken({ [doc]: 'owner' });
    // The state is already `active`: no permission change, so no notice to the data plane.
    const r = await h.call('PATCH', `/v1/documents/${doc}`, {
      token: owner,
      body: { state: 'active' },
      headers: { 'If-Match': '"m1"' },
    });
    expect(r.status).toBe(200);
    expect(h.stub.notices.filter((n) => n.ref?.doc === doc)).toEqual([]);
  });
});
