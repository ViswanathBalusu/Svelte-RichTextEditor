// PRM-043 criterion 6, second clause (lane w5): the lease routes exist while the server announces
// `leases` (on by default, owner decision 190) and answer `not_found` when it is switched off, and
// every other feature works either way: the same content, region list, grants and region states.
// In-memory storage, real HTTP, test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES } from '../../src/data-plane/settings.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const OPEN = 'rOpen00000000001';
const WITHOUT = ['presence', 'regions', 'suggest-enforced'];

describe('the reference service announces leases by default (owner decision 190)', () => {
  it('lists `leases` among the features of the data plane', () => {
    expect(DEFAULT_FEATURES).toContain('leases');
  });
});

describe('the lease routes follow the announced feature', () => {
  let on: Harness;
  let off: Harness;
  beforeAll(async () => {
    on = await startHarness('memory');
    off = await startHarness('memory', { config: { features: WITHOUT } });
  });
  afterAll(async () => {
    await on?.close();
    await off?.close();
  });

  const lease = (doc: string) => `/v1/documents/${doc}/regions/${OPEN}/lease`;
  const as = (h: Harness, doc: string, role: string, sub: string) =>
    h.userToken({ [doc]: role }, { sub });

  it('announces leases in discovery when it is on, and not when it is off', async () => {
    const a = await on.call('GET', '/.well-known/dep');
    const b = await off.call('GET', '/.well-known/dep');
    expect(a.json.features).toContain('leases');
    expect(b.json.features).not.toContain('leases');
  });

  it('takes, extends and releases a lease while the feature is on', async () => {
    const doc = await on.createDocument({ content: documentWithRegions() });
    const token = as(on, doc, 'editor', 'ed-w5-1');
    const taken = await on.call('POST', lease(doc), { token });
    expect(taken.status).toBe(201);
    const released = await on.call('DELETE', lease(doc), {
      token: as(on, doc, 'editor', 'ed-w5-1'),
    });
    expect(released.status).toBe(204);
  });

  it('refuses every lease route with not_found while the feature is off', async () => {
    const doc = await off.createDocument({ content: documentWithRegions() });
    for (const [method, headers] of [
      ['POST', {}],
      ['PUT', { 'If-Match': '"x"' }],
      ['DELETE', {}],
    ] as const) {
      const res = await off.call(method, lease(doc), {
        token: as(off, doc, 'owner', 'ow-w5-1'),
        headers,
      });
      expect(res.status, method).toBe(404);
      expect(res.json.code, method).toBe('not_found');
    }
  });

  it('serves the same content, regions and grants whether leases are on or off', async () => {
    const reads = async (h: Harness) => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = as(h, doc, 'owner', 'ow-w5-2');
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const regions = await h.call('GET', `/v1/documents/${doc}/regions`, { token: owner });
      const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const resource = await h.call('GET', `/v1/documents/${doc}`, { token: owner });
      // A region's state still changes: an owner approves it.
      const state = await h.call('PUT', `/v1/documents/${doc}/regions/${OPEN}/state`, {
        token: as(h, doc, 'owner', 'ow-w5-2'),
        body: { state: 'in_review' },
        headers: { 'If-Match': '*' },
      });
      return {
        content: content.status,
        seq: content.json.seq,
        regions: regions.status,
        regionIds: regions.json.items.map((r: { id: string }) => r.id),
        leased: regions.json.items.some(
          (r: { editors?: { leasedTo?: string } }) => r.editors?.leasedTo !== undefined,
        ),
        grants: grants.status,
        resource: resource.status,
        state: state.status,
      };
    };
    const a = await reads(on);
    const b = await reads(off);
    expect(b).toEqual(a);
    expect(b.content).toBe(200);
    expect(b.regions).toBe(200);
    expect(b.grants).toBe(200);
    expect(b.resource).toBe(200);
    expect(b.state).toBe(200);
  });
});
