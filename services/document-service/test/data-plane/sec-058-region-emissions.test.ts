// SEC-058 criterion 4 (lane w8): what a node of another region emits holds no content. A tenant is
// assigned the home region `eu`; a client connects to the gateway in `us` and types a canary string,
// so the channel and the commit are forwarded to the node in `eu`. Afterwards the metrics text and
// the error reports of both nodes are searched for the canary. The nodes are data planes in one process over shared in-memory stores
// (as in be-073-074-placement.test.ts), so this shows what each node writes to its log sink and its
// metrics, not a network between regions. The scan of the whole service is SEC-047.
import { afterEach, expect, it } from 'vitest';
import { MemoryBusNetwork } from '../../src/data-plane/bus.ts';
import { MemoryHomeRegions } from '../../src/storage/home-regions.ts';
import { insertText } from './client.ts';
import { cluster, intro, seeded, type Cluster } from './forwarding-support.ts';

let c: Cluster | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

const CANARY = 'canary-sec058-5f3a9c1d-do-not-log';

it('a forwarded commit leaves no content in the metrics or the error reports of either region', async () => {
  c = cluster();
  const net = new MemoryBusNetwork(seeded(31));
  const homeRegions = new MemoryHomeRegions();
  const eu = await c.start(
    'node-eu',
    net.connect('node-eu'),
    {},
    { traits: { region: 'eu' }, homeRegions },
  );
  const us = await c.start(
    'node-us',
    net.connect('node-us'),
    {},
    { traits: { region: 'us' }, homeRegions },
  );
  await homeRegions.assign(eu.tenant, 'eu', 'operator');
  const doc = await eu.createDocument();

  const alice = await us.client('alice', { [doc]: 'editor' });
  const opened = await alice.open(1, doc);
  expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
  const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), `${CANARY} `)] });
  expect(ack.d).toMatchObject({ seq: 1 });
  // The room is in the home region, so the gateway's own metrics saw the channel and nothing else.
  expect(eu.plane.host.rooms.length).toBe(1);
  expect(us.plane.host.rooms.length).toBe(0);

  for (const [name, p] of [
    ['node-eu', eu],
    ['node-us', us],
  ] as const) {
    const metrics = p.plane.metricsRegistry.text();
    expect(metrics.length, `${name} exposes metrics`).toBeGreaterThan(0);
    const emitted = `${metrics}\n${JSON.stringify(p.errors.map(String))}`;
    expect(emitted, `${name} must not carry the canary`).not.toContain(CANARY);
  }
});
