/**
 * The data plane's metrics (BE-086 criterion 2): every metric that is per tenant carries the tenant
 * label as well as the node. The tests drive a real data plane (rooms, sessions, the outbox) over
 * in-memory ports with WebSocket clients, scrape `metrics()` and read the labels of every series.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import {
  GatedLogStore,
  MemoryCheckpoints,
  memoryStores,
  startPlane,
  until,
  type Plane,
} from '../../test/data-plane/support.ts';
import type { DocRef } from '../storage/types.ts';
import { MemoryOutbox } from './memory-ports.ts';
import { Metrics } from './metrics.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** Checkpoints whose writes fail while `fail` is set: object storage is down. */
class FlakyCheckpoints extends MemoryCheckpoints {
  fail = false;
  override async put(...args: Parameters<MemoryCheckpoints['put']>): Promise<void> {
    if (this.fail) throw new Error('object storage is unavailable');
    return super.put(...args);
  }
}

/** The series lines of a scrape (no HELP or TYPE lines). */
function series(text: string): string[] {
  return text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
}

/** The metric a series line belongs to: a histogram's `_bucket`, `_sum` and `_count` are one. */
function metricOf(line: string, declared: ReadonlySet<string>): string {
  const name = /^[a-z_][a-z0-9_]*/.exec(line)![0];
  if (declared.has(name)) return name;
  return name.replace(/_(bucket|sum|count)$/, '');
}

function declaredIn(text: string): Set<string> {
  return new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]!));
}

/** Every series carries the node and this tenant, and no tenant label is empty. */
function expectTenantAndNode(text: string, node: string, tenant: string): void {
  for (const line of series(text)) {
    expect(line, line).toContain(`node="${node}"`);
    expect(line, line).toContain(`tenant="${tenant}"`);
  }
  expect(text).not.toContain('tenant=""');
}

describe('per-tenant metrics from the call sites (BE-086 criterion 2)', () => {
  it('labels every series that rooms, sessions and the outbox write with the tenant and the node', async () => {
    const mem = memoryStores().memory;
    const gated = new GatedLogStore(mem);
    const checkpoints = new FlakyCheckpoints();
    const outbox = new MemoryOutbox();
    const node = `node-${uuid7()}`;
    const p = await plane({
      node,
      stores: { logs: gated, ownership: mem, grants: mem, documents: mem },
      checkpoints,
      deps: { outbox },
      settings: {
        rates: { connection: { capacity: 30, refillPerSecond: 0.001 }, closeAfterRefusals: 1000 },
      },
    });
    const m = p.plane.metricsRegistry;
    const tenant = p.tenant;
    const doc = await p.createDocument();
    const other = await p.createDocument();
    const ref: DocRef = p.ref(doc);

    // A cold open, commits, an acknowledgement and log writes.
    const alice = await p.client('alice', { [doc]: 'owner', [other]: 'owner' });
    const opened = await alice.open(1, doc);
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    expect((await alice.submit(1, { base: 1, steps: [insertText(intro(), 'b')] })).t).toBe(
      'sync.ack',
    );
    // A commit on an old base is rebased.
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'c')] })).t).toBe(
      'sync.ack',
    );
    expect(m.rebased.get({ tenant })).toBeGreaterThan(0);

    // A rejection, by registry code.
    const dave = await p.client('dave', { [doc]: 'viewer' });
    await dave.open(1, doc);
    expect((await dave.submit(1, { base: 3, steps: [insertText(intro(), 'd')] })).d).toMatchObject({
      code: 'permission_denied',
    });

    // A log write that does not store.
    gated.hold = true;
    const env = alice.submitNoWait(1, { base: 3, steps: [insertText(intro(), 'e')] });
    await until(() => gated.pending === 1);
    await gated.release({ status: 'failed' });
    expect((await alice.take((x) => x.re === env)).d).toMatchObject({ code: 'unavailable' });
    gated.hold = false;

    // A resume, on another connection, that streams the commits it missed.
    const again = await p.client('alice', { [doc]: 'owner' });
    const resumed = await again.open(1, doc, {
      resume: { seq: 1, incarnation: opened.d!['incarnation'], view: opened.d!['view'] },
    });
    expect(resumed.d).toMatchObject({ catchUp: 'stream' });

    // Messages over the connection's rate limit.
    const mallory = await p.client('mallory', { [doc]: 'viewer' });
    for (let i = 0; i < 40; i++) mallory.submitNoWait(9, { base: 0, steps: [insertText(1, 'x')] });
    await until(() => m.rateLimited.get({ tenant, scope: 'connection' }) > 0, 3000, 'a refusal');

    // A checkpoint that fails while object storage is down.
    const room = p.plane.host.get(ref)!;
    checkpoints.fail = true;
    expect(await room.checkpointIfDirty('test')).toBe(false);
    checkpoints.fail = false;

    // An outbox item settled (a malformed one fails at once).
    await outbox.enqueue({ tenant, doc, commitId: uuid7(), kind: 'author', request: {} });
    await p.plane.outbox!.poll();
    expect(m.outbox.get({ tenant, state: 'failed' })).toBe(1);

    // A second room, open while the gauges are read.
    await alice.open(3, other);
    const open = p.plane.metrics();
    expectTenantAndNode(open, node, tenant);
    expect(open).toContain(`dep_open_rooms{node="${node}",tenant="${tenant}"} 2`);
    expect(open).toContain(`dep_connections{node="${node}",tenant="${tenant}"} 4`);

    // A room fenced, and a room closed when idle after a checkpoint.
    p.plane.host.kill(p.ref(other));
    for (const c of [alice, again, dave]) c.send({ t: 'ch.close', ch: 1 });
    await until(() => room.idle, 3000, 'the last channel to close');
    expect(await room.closeIdle()).toBe(true);
    // An identified connection that ends counts its seconds under its tenant (BE-085).
    dave.terminate();
    await until(() => m.connectionSeconds.get({ tenant }) > 0, 3000, 'a connection to be counted');
    const closed = p.plane.metrics();
    expectTenantAndNode(closed, node, tenant);
    expect(closed).toContain(
      `dep_rooms_closed_total{node="${node}",reason="fenced",tenant="${tenant}"} 1`,
    );
    expect(closed).toContain(
      `dep_rooms_closed_total{node="${node}",reason="idle",tenant="${tenant}"} 1`,
    );
    expect(closed).toContain(
      `dep_rejections_total{code="permission_denied",node="${node}",tenant="${tenant}"} 1`,
    );

    // Every metric the node declares was written by a call site above, except the slow-consumer
    // counter (the next test): the check covers the whole registry, not a list kept by hand.
    const declared = declaredIn(open);
    const written = new Set([...series(open), ...series(closed)].map((l) => metricOf(l, declared)));
    const missing = [...declared].filter(
      (n) => !written.has(n) && n !== 'dep_slow_consumers_total',
    );
    expect(missing).toEqual([]);
  }, 30_000);

  it('labels the slow-consumer counter with the tenant of the channel that fell behind', async () => {
    const node = `node-${uuid7()}`;
    const p = await plane({
      node,
      settings: { sendQueueBytes: 256 * 1024, socketHighWater: 32 * 1024 },
    });
    const m = p.plane.metricsRegistry;
    const doc = await p.createDocument();
    const writer = await p.client('alice', { [doc]: 'owner' });
    const slow = await p.client('carol', { [doc]: 'editor' });
    await writer.open(1, doc);
    await slow.open(1, doc);
    slow.ws.pause();
    const text = 'x'.repeat(60_000);
    let head = 0;
    for (let i = 0; i < 160; i++) {
      const r = await writer.submit(1, { base: head, steps: [insertText(intro(), text)] });
      expect(r.t).toBe('sync.ack');
      head = r.d!['seq'];
      if (m.slowConsumers.get({ tenant: p.tenant }) > 0) break;
    }
    const scraped = p.plane.metrics();
    slow.ws.resume();
    expect(scraped).toContain(`dep_slow_consumers_total{node="${node}",tenant="${p.tenant}"} 1`);
    expectTenantAndNode(scraped, node, p.tenant);
  }, 60_000);

  it('reports the bytes waiting in send queues per tenant while a reader lags, and zero once it is closed (BE-027 criterion 4)', async () => {
    const node = `node-${uuid7()}`;
    const p = await plane({
      node,
      settings: { sendQueueBytes: 256 * 1024, socketHighWater: 32 * 1024 },
    });
    const m = p.plane.metricsRegistry;
    const doc = await p.createDocument();
    const writer = await p.client('alice', { [doc]: 'owner' });
    const slow = await p.client('carol', { [doc]: 'editor' });
    await writer.open(1, doc);
    await slow.open(1, doc);
    slow.ws.pause();
    const text = 'x'.repeat(60_000);
    let head = 0;
    let waitingWhileLagging = 0;
    for (let i = 0; i < 160; i++) {
      const r = await writer.submit(1, { base: head, steps: [insertText(intro(), text)] });
      expect(r.t).toBe('sync.ack');
      head = r.d!['seq'];
      waitingWhileLagging = Math.max(
        waitingWhileLagging,
        queueBytesOf(p.plane.metrics(), node, p.tenant),
      );
      if (m.slowConsumers.get({ tenant: p.tenant }) > 0) break;
    }
    expect(m.slowConsumers.get({ tenant: p.tenant })).toBe(1);
    const afterClose = p.plane.metrics();
    slow.ws.resume();
    // The lagging channel's queue held commits while it was open, and the close dropped them: what
    // remains is the writer's own short acknowledgements, far below the peak.
    expect(waitingWhileLagging).toBeGreaterThan(60_000);
    expect(queueBytesOf(afterClose, node, p.tenant)).toBeGreaterThanOrEqual(0);
    expect(queueBytesOf(afterClose, node, p.tenant)).toBeLessThan(waitingWhileLagging / 10);
    expectTenantAndNode(afterClose, node, p.tenant);
  }, 60_000);
});

/** The value of `dep_send_queue_bytes` for a node and tenant in a scrape; -1 when absent. */
function queueBytesOf(scrape: string, node: string, tenant: string): number {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^dep_send_queue_bytes\\{node="${esc(node)}",tenant="${esc(tenant)}"\\} (\\d+)$`,
    'm',
  );
  const hit = re.exec(scrape);
  return hit ? Number(hit[1]) : -1;
}

describe('the registry (BE-086)', () => {
  it('keeps the tenants apart and puts the node on every series', () => {
    const m = new Metrics('node-1');
    m.commits.inc({ tenant: 'acme' }, 2);
    m.commits.inc({ tenant: 'globex' }, 5);
    expect(m.commits.get({ tenant: 'acme' })).toBe(2);
    expect(m.commits.get({ tenant: 'globex' })).toBe(5);
    expect(m.text()).toContain('dep_commits_total{node="node-1",tenant="globex"} 5');
  });

  it('refuses an empty tenant label rather than writing a series no tenant owns', () => {
    const m = new Metrics('node-1');
    expect(() => m.slowConsumers.inc({ tenant: '' })).toThrow(/empty tenant/);
  });
});
