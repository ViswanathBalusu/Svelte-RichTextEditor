/**
 * BE-091 on a running node (lane V-BE-085-098): the full service with the real data plane and
 * memory storage gates the connections and the commit rate of a tenant with its live-use quotas.
 * A refused hello is answered `quota_exceeded` with `retryAfterMs` and a released connection
 * admits the next one; a refused commit is answered `sync.reject` `quota_exceeded` with
 * `retryAfterMs` and is not submitted; a changed quota applies to the next request; and the
 * refusals appear in the node's `/metrics` scrape with the tenant and the quota.
 *
 * Not covered here: the open-documents and CPU quotas (not wired), the REST answers
 * (`Retry-After`), the administration API that writes the values (UX-076), and the latency of
 * another tenant's acknowledgements (BE-091 criterion 2 is a measurement, not a test of values).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient, insertText } from '../data-plane/client.ts';
import { MemoryQuotaStore } from '../../src/control-plane/quotas.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';
import { cdmSchema } from '@docedit/model/prosemirror';

const METRICS_TOKEN = 'be-091-node-quota-token';
const INTRO = 'pIntro0000000001';

function insideAt(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

async function node(): Promise<{ h: Harness; quotas: MemoryQuotaStore }> {
  const quotas = new MemoryQuotaStore(() => true);
  const h = await startHarness('memory', {
    parts: { quotas },
    config: { testMode: true, environment: 'test', metricsToken: METRICS_TOKEN },
    realDataPlane: true,
  });
  harnesses.push(h);
  return { h, quotas };
}

async function connect(h: Harness, _doc: string): Promise<DepClient> {
  const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
  clients.push(c);
  return c;
}

describe('BE-091 live-use quotas on a running node', () => {
  it('refuses a hello over the connection quota with quota_exceeded and retryAfterMs, and admits again once a session ends', async () => {
    const { h, quotas } = await node();
    quotas.set(h.tenant, 'connections', 1);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const token = h.userToken({ [doc]: 'owner' });

    const first = await connect(h, doc);
    expect((await first.hello(token)).t).toBe('welcome');

    const second = await connect(h, doc);
    const refused = await second.hello(token);
    expect(refused.t).toBe('error');
    expect(refused.d?.code).toBe('quota_exceeded');
    expect(refused.d?.retryAfterMs).toBeGreaterThan(0);

    first.terminate();
    // The released connection is not counted any more: a new session is admitted.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await connect(h, doc);
    expect((await third.hello(token)).t).toBe('welcome');
  });

  it('answers a commit over the commit-rate quota with sync.reject quota_exceeded, applies a raised quota at once, and counts the refusals in the scrape', async () => {
    const { h, quotas } = await node();
    quotas.set(h.tenant, 'commitRate', 1);
    const content = documentWithRegions();
    const doc = await h.createDocument({ content });
    const token = h.userToken({ [doc]: 'owner' });
    const intro = insideAt(content['doc'], INTRO);

    const c = await connect(h, doc);
    expect((await c.hello(token)).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');

    const first = await c.submit(1, { base: 0, steps: [insertText(intro, 'a')] });
    expect(first.t).toBe('sync.ack');

    const refused = await c.submit(1, { base: 1, steps: [insertText(intro, 'b')] });
    expect(refused.t).toBe('sync.reject');
    expect(refused.d?.code).toBe('quota_exceeded');
    expect(refused.d?.retryAfterMs).toBeGreaterThan(0);

    // A quota changed in the store applies to the next commit (BE-091 criterion 3, in-process).
    quotas.set(h.tenant, 'commitRate', 5);
    const accepted = await c.submit(1, { base: 1, steps: [insertText(intro, 'c')] });
    expect(accepted.t).toBe('sync.ack');

    const r = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
    expect(r.status).toBe(200);
    const text = String((r as unknown as { text?: string }).text ?? '');
    const line = text
      .split('\n')
      .find(
        (l) =>
          l.startsWith('docedit_tenant_quota_refusals_total{') && l.includes('quota="commitRate"'),
      );
    expect(line).toBeDefined();
    expect(line).toContain(`tenant="${h.tenant}"`);
    expect(line).toContain('code="quota_exceeded"');
  });
});
