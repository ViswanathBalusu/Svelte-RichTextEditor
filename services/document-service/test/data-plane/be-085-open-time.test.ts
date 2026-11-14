// The open-room time and the connection time per tenant (BE-085 criterion 1; the data plane's own
// registry, dep_room_open_seconds_total and dep_connection_seconds_total). The plane runs in process
// over the in-memory stores with a short idle delay, as in be-021-idle-release.test.ts. The counters
// are checked against the wall clock: each one is at least the time it must cover and at most the
// time the test measured around it.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const IDLE_MS = 100;

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

function memoryStores(mem: MemoryStore) {
  return { logs: mem, ownership: mem, grants: mem, documents: mem };
}

describe('open-room and connection time per tenant (BE-085 criterion 1)', () => {
  it('counts the seconds a room stayed open under its tenant, from its opening to its idle close', async () => {
    const mem = new MemoryStore();
    const p = await startPlane({
      stores: memoryStores(mem),
      settings: { roomIdleMs: IDLE_MS },
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const started = performance.now();
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'open time')] });
    expect(ack.t).toBe('sync.ack');

    alice.terminate();
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the idle room to close');
    const elapsed = (performance.now() - started) / 1000;

    const open = p.plane.metricsRegistry.roomOpenSeconds.get({ tenant: p.tenant });
    // The room stayed open at least until its idle delay ran out after the last channel left.
    expect(open).toBeGreaterThanOrEqual(IDLE_MS / 1000);
    // It cannot have been open longer than the test ran.
    expect(open).toBeLessThanOrEqual(elapsed + 0.001);
    expect(p.plane.metrics()).toContain(
      `dep_room_open_seconds_total{node="node-a",tenant="${p.tenant}"}`,
    );
    expect(p.errors).toEqual([]);
  });

  it('counts the seconds an identified connection stayed open under its tenant', async () => {
    const mem = new MemoryStore();
    const p = await startPlane({ stores: memoryStores(mem), node: 'node-a' });
    planes.push(p);
    const started = performance.now();
    const alice = await p.client('alice', {});
    await new Promise((r) => setTimeout(r, 120));

    alice.terminate();
    await until(
      () => p.plane.metricsRegistry.connectionSeconds.get({ tenant: p.tenant }) > 0,
      3000,
      'the connection to be counted',
    );
    const elapsed = (performance.now() - started) / 1000;

    const conn = p.plane.metricsRegistry.connectionSeconds.get({ tenant: p.tenant });
    expect(conn).toBeGreaterThanOrEqual(0.1);
    expect(conn).toBeLessThanOrEqual(elapsed + 0.001);
    expect(p.plane.metrics()).toContain(
      `dep_connection_seconds_total{node="node-a",tenant="${p.tenant}"}`,
    );
    expect(p.errors).toEqual([]);
  });
});
