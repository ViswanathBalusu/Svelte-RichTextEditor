// Fork over the control plane (HIS-022; 08 §8; 05 §6.2 `forkDocument`). Runs over the HTTP surface
// of the test harness with memory storage. The PostgreSQL run is not made here (it needs a running
// PostgreSQL; the storage is the same interface). Forks at a `seq` above 0 need a commit through the
// room, which the harness does not run here, so the copies below are made at seq 0.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

const LEGAL = 'rLegal0000000001';

describe('fork a version into a new document (memory storage)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  /** A source document with one grant on the legal region, read by the service credential. */
  async function source(): Promise<string> {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Source' });
    const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    const p = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
      token: h.apiKey,
      headers: { 'If-Match': g.headers.get('etag')! },
      body: { grants: [{ region: LEGAL, principal: 'user:alice', role: 'viewer' }] },
    });
    expect(p.status).toBe(200);
    return doc;
  }

  const fork = (doc: string, body: Record<string, unknown>, token = h.apiKey) =>
    h.call('POST', `/v1/documents/${doc}/fork`, {
      token,
      headers: { 'Idempotency-Key': randomUUID() },
      body,
    });

  it('creates a new document with the content at atSeq and its own log (HIS-022 criterion 2, part)', async () => {
    const doc = await source();
    const before = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const r = await fork(doc, { atSeq: 0 });
    expect(r.status).toBe(201);
    const copy = r.json.id as string;
    expect(copy).not.toBe(doc);
    expect(r.headers.get('location')).toContain(`/documents/${copy}`);
    // The copy starts its own log at seq 0 with the content as it was at atSeq.
    const content = await h.call('GET', `/v1/documents/${copy}/content`, { token: h.apiKey });
    expect(content.status).toBe(200);
    expect(content.json.doc).toEqual(before.json.doc);
    expect(content.json.seq).toBe(0);
    expect(content.json.incarnation).not.toBe(before.json.incarnation);
  });

  it('copies grants only when the request says so (HIS-022 criterion 3)', async () => {
    const doc = await source();
    const plain = (await fork(doc, { atSeq: 0 })).json.id as string;
    const withGrants = (await fork(doc, { atSeq: 0, copyGrants: true })).json.id as string;
    const grantsOf = async (id: string) =>
      (await h.call('GET', `/v1/documents/${id}/grants`, { token: h.apiKey })).json
        .grants as Array<{
        region: string;
        role: string;
      }>;
    expect(await grantsOf(plain)).toEqual([]);
    const copied = await grantsOf(withGrants);
    expect(copied.map((g) => [g.region, g.role])).toEqual([[LEGAL, 'viewer']]);
  });

  it('leaves the original unchanged (HIS-022 criterion 6)', async () => {
    const doc = await source();
    const beforeMeta = await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
    const beforeContent = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const beforeGrants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    expect((await fork(doc, { atSeq: 0, copyGrants: true })).status).toBe(201);
    const afterMeta = await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
    const afterContent = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const afterGrants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    expect(afterMeta.headers.get('etag')).toBe(beforeMeta.headers.get('etag'));
    expect(afterContent.json).toEqual(beforeContent.json);
    expect(afterGrants.json).toEqual(beforeGrants.json);
  });

  it('is a service-credential operation: a user credential is refused as forbidden', async () => {
    const doc = await source();
    const user = h.userToken({ [doc]: 'owner' });
    const r = await fork(doc, { atSeq: 0 }, user);
    expect(r.status).toBe(403);
  });

  it('refuses a seq above the head as not_found', async () => {
    const doc = await source();
    const r = await fork(doc, { atSeq: 1 });
    expect(r.status).toBe(404);
  });
});
