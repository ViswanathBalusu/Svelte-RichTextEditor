/**
 * BE-086 criterion 2 on a running node (lane V-BE-085-098): after a cold open, a commit and a
 * rejection over a real WebSocket, every scraped series that carries a tenant label carries the
 * node label too, in the data plane's families and in the control plane's `docedit_tenant_*` ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cdmSchema } from '@docedit/model/prosemirror';
import { DepClient, insertText } from '../data-plane/client.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const METRICS_TOKEN = 'be-086-tenant-node-token';
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

describe('per-tenant series of a running node carry the node label (BE-086 criterion 2)', () => {
  it('labels every series that has a tenant label with the node as well', async () => {
    const h = await startHarness('memory', {
      config: { testMode: true, environment: 'test', metricsToken: METRICS_TOKEN },
      realDataPlane: true,
    });
    harnesses.push(h);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const intro = insideAt(documentWithRegions()['doc'], INTRO);
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    expect((await c.hello(h.userToken({ [doc]: 'owner' }))).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    expect((await c.submit(1, { base: 0, steps: [insertText(intro, 'metrics')] })).t).toBe(
      'sync.ack',
    );
    expect((await c.submit(1, { base: 1, steps: [insertText(999_999, 'bad')] })).t).toBe(
      'sync.reject',
    );

    const r = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
    expect(r.status).toBe(200);
    const text = String((r as unknown as { text?: string }).text ?? '');
    const lines = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    const tenanted = lines.filter((l) => /[{,]tenant="/.test(l));
    expect(tenanted.length).toBeGreaterThan(0);
    for (const l of tenanted) expect(l).toMatch(/[{,]node="[^"]+"/);
    // The control plane's own per-tenant commit counter is among them, with the node label.
    expect(tenanted.some((l) => l.startsWith('docedit_tenant_commits_total{'))).toBe(true);
  });
});
