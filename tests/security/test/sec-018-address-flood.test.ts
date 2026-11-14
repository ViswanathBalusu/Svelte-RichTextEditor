/**
 * SEC-018 criterion 1 (10 §3.2; BE-030): a flood of frames from one address before `hello` is cut
 * off at the address limit, and an address that is not flooding connects normally.
 *
 * The flood and the bystander come from different loopback source addresses (127.0.0.2 and
 * 127.0.0.1). The listener binds 0.0.0.0 for this file only (the harness `host` option), since a
 * socket bound to 127.0.0.1 does not accept connections from 127.0.0.2. Memory storage only: the
 * limit is in the gateway, not in storage. Windows and Linux both route 127.0.0.2 to loopback.
 *
 * "No token verification work beyond the limit" is shown by the answers: a frame refused by the
 * limit is answered `rate_limited` before any frame is dispatched, so the flood gets at most
 * `capacity` answers and no more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';
import { DEFAULT_RATES } from '../../../services/document-service/src/data-plane/settings.ts';
import { RateLimits } from '../../../services/document-service/src/data-plane/limits.ts';

const CAPACITY = 5;
const generous = { capacity: 1_000_000, refillPerSecond: 1_000_000 };

describe('SEC-018 criterion 1: an address flooding before hello is limited, others connect', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', {
      node: 'node-A',
      host: '0.0.0.0',
      rateLimits: new RateLimits({
        ...DEFAULT_RATES,
        addressConnections: generous,
        // Frames before hello: a small burst, and almost no refill during the test.
        addressFrames: { capacity: CAPACITY, refillPerSecond: 0.001 },
        connection: generous,
        user: generous,
        tenant: generous,
        closeAfterRefusals: 1_000_000,
      }),
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('refuses the flooding address with rate_limited once its frame burst is spent', async () => {
    // Each connection from the flooding address sends one frame before hello. A frame that is
    // not hello closes its connection (4400), so every frame costs one token of the address bucket.
    const codes: Array<string | undefined> = [];
    for (let i = 0; i < CAPACITY + 5; i++) {
      const flood = await WireClient.connect(h.wsUrl, {
        origin: h.a.origin,
        localAddress: '127.0.0.2',
      });
      try {
        flood.send({ t: 'ping', id: `flood-${i}` });
        const closed = await flood.closed;
        expect(closed.code).toBeGreaterThanOrEqual(4000);
        const err = flood.log.find((m) => m.t === 'error');
        codes.push((err?.d as { code?: string } | undefined)?.code);
      } finally {
        flood.terminate();
      }
    }
    // Only the burst reaches the message check; the rest are refused by the address limit.
    expect(codes.filter((c) => c === 'rate_limited').length).toBeGreaterThanOrEqual(1);
    expect(codes.filter((c) => c !== 'rate_limited').length).toBeLessThanOrEqual(CAPACITY);
  });

  it('a new connection from the flooding address is refused at its first frame', async () => {
    const again = await WireClient.connect(h.wsUrl, {
      origin: h.a.origin,
      localAddress: '127.0.0.2',
    });
    try {
      again.send({ t: 'ping', id: 'again-0' });
      const closed = await again.closed;
      expect(closed.code).toBeGreaterThanOrEqual(4000);
      // The address bucket is empty, so the first frame is refused by the limit: rate_limited.
      const codes = again.log
        .filter((m) => m.t === 'error')
        .map((m) => (m.d as { code?: string } | undefined)?.code);
      expect(codes).toEqual(['rate_limited']);
    } finally {
      again.terminate();
    }
  });

  it('another address connects, authenticates and edits normally while the flood is refused', async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const bystander = await WireClient.connect(h.wsUrl, {
      origin: h.a.origin,
      localAddress: '127.0.0.1',
    });
    try {
      const hello = await bystander.hello(token);
      expect(hello.t).not.toBe('error');
      await bystander.open(1, doc);
    } finally {
      bystander.terminate();
    }
  });
});
