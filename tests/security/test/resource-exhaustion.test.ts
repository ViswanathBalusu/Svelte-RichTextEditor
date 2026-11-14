/**
 * SEC-018 criterion 4 (10 §3.2; 04 §11, §12; BE-027): a reader that never reads is closed with
 * `slow_consumer` once its send queue fills, and the room keeps serving the other channels.
 *
 * The reader's socket is paused, so the kernel buffers fill, the server holds its frames in the
 * channel's send queue, and the queue passes its bound. The bound is set low by the harness; the
 * rate limits are raised so that only the queue, not the limiter, is what the test exercises.
 */
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { inside, loadDoc } from './support/cdm.ts';
import { documentWithRegions, insertText, startHarness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';

/** Generous limits: the flood is meant to fill the queue, not to hit the rate limiter. */
const bucket = { capacity: 1_000_000, refillPerSecond: 1_000_000 };
const RATES = {
  addressConnections: bucket,
  addressFrames: bucket,
  connection: bucket,
  user: bucket,
  tenant: bucket,
  closeAfterRefusals: 1_000_000,
};

describe('SEC-018 a reader that never reads cannot hold up the room', () => {
  it('is closed with slow_consumer once its queue fills, and the editor keeps being acknowledged', async () => {
    const h = await startHarness('memory', {
      node: 'node-A',
      dataPlane: {
        sendQueueBytes: 64 * 1024,
        socketHighWater: 16 * 1024,
        rates: RATES,
      },
    });
    try {
      const doc = await h.createDocument(h.a, documentWithRegions());
      const reader = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      const editor = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        const rToken = await h.mintToken(h.a, 'rita', { [doc]: 'viewer' });
        const eToken = await h.mintToken(h.a, 'ed', { [doc]: 'editor' });
        await reader.hello(rToken);
        expect((await reader.open(1, doc)).t).toBe('ch.opened');
        await editor.hello(eToken);
        expect((await editor.open(1, doc)).t).toBe('ch.opened');

        // The reader stops reading its socket. Nothing it is sent is consumed from now on.
        const socket = (reader.ws as unknown as { _socket: { pause(): void; resume(): void } })
          ._socket;
        socket.pause();

        const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
          .json;
        const pos = inside(loadDoc(content.doc), 'pIntro0000000001');
        // Each commit is 32 KiB of text, so a few hundred of them outrun the kernel's buffers.
        const big = 'x'.repeat(32 * 1024);
        let acks = 0;
        for (let i = 0; i < 240; i++) {
          const r = await editor.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(pos, big)],
          });
          if (r.t === 'sync.ack') acks++;
        }
        expect(acks).toBeGreaterThan(0);

        // The reader resumes and is told that its channel was closed for falling behind.
        socket.resume();
        const closed = await reader.take(
          (m) => m.t === 'ch.closed' && m.ch === 1,
          15_000,
          "the reader's slow_consumer close",
        );
        expect(closed.d?.['code']).toBe('slow_consumer');

        // The room is unaffected: the editor's next commit is still acknowledged.
        const after = await editor.submit(1, {
          id: uuid7(),
          base: 0,
          steps: [insertText(pos, 'after')],
        });
        expect(after.t).toBe('sync.ack');
      } finally {
        reader.terminate();
        editor.terminate();
      }
    } finally {
      await h.close();
    }
  }, 60_000);
});
