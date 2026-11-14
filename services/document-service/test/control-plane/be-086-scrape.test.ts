/**
 * BE-086 criterion 1 on a running node: one node (the full service, the real data plane, memory
 * storage) is driven over a real WebSocket with a cold open, a commit and a rejected commit, then
 * its `/metrics` is scraped with the metrics token. The scrape must declare each family the spec
 * (06 §11) lists, and the data plane's families must carry the node's own samples.
 *
 * Not covered here: the catch-up and rebase series have no traffic in this test (their call
 * sites are driven by `src/data-plane/metrics.test.ts`). The compile-time family
 * (`docedit_tenant_compile_seconds_total`) is not declared in a scrape until a compile runs, and no
 * compile is run here, so it is not in the required list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cdmSchema } from '@docedit/model/prosemirror';
import { DepClient, insertText } from '../data-plane/client.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const METRICS_TOKEN = 'be-086-scrape-token';
const INTRO = 'pIntro0000000001';

/** The position just inside the paragraph with this identifier (the way be-013 finds it). */
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

/** The families a 06 §11 scrape must declare, with the name each one has on this node. */
const REQUIRED_FAMILIES = [
  'dep_ack_latency_ms',
  'dep_persist_batch_commits',
  'dep_persist_latency_ms',
  'dep_commits_rebased_total',
  'dep_rejections_total',
  'dep_open_rooms',
  'dep_room_memory_max_bytes',
  'dep_send_queue_bytes',
  'dep_catch_up_commits',
  'dep_cold_open_ms',
  'docedit_jobs',
];

describe('a running node exposes the metrics of 06 §11 (BE-086 criterion 1)', () => {
  it('declares every listed family in a scrape after a cold open, a commit and a rejection', async () => {
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
    const ack = await c.submit(1, { base: 0, steps: [insertText(intro, 'metrics')] });
    expect(ack.t).toBe('sync.ack');
    const rejected = await c.submit(1, { base: 1, steps: [insertText(999_999, 'bad')] });
    expect(rejected.t).toBe('sync.reject');

    const r = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
    expect(r.status).toBe(200);
    const text = String((r as unknown as { text?: string }).text ?? '');
    const declared = new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]!));
    const missing = REQUIRED_FAMILIES.filter((f) => !declared.has(f));
    expect(missing).toEqual([]);

    // The data plane's own call sites have samples on this node, labelled with the node.
    const samples = (name: string) =>
      text.split('\n').filter((l) => l.startsWith(name) && l.includes('node='));
    expect(samples('dep_ack_latency_ms_count').length).toBeGreaterThan(0);
    expect(samples('dep_cold_open_ms_count').length).toBeGreaterThan(0);
    expect(samples('dep_rejections_total').length).toBeGreaterThan(0);
  });
});
