/**
 * PRO-020 criterion 1 (no binary frame on `pm-steps/1`), checked on the wire of the real data
 * plane. Two clients open a document channel on `pm-steps/1`, exchange commits and presence, and
 * every frame either side receives is inspected for its binary flag. The `ws` library reports that
 * flag on each message; the test client only keeps the text, so this test listens on the socket too.
 * In-memory stores (test/data-plane/support.ts), Node.js.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** Counts binary frames received on a client's socket, after the client's own listener. */
function countBinary(c: DepClient): { count: () => number; frames: () => number } {
  let binary = 0;
  let all = 0;
  c.ws.on('message', (_data: unknown, isBinary: boolean) => {
    all++;
    if (isBinary) binary++;
  });
  return { count: () => binary, frames: () => all };
}

describe('pm-steps/1 sends no binary frame (PRO-020 criterion 1)', () => {
  it('exchanges commits and presence over text frames only, in both directions', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    const aliceSockets = countBinary(alice);
    const bobSockets = countBinary(bob);

    const a = await alice.open(1, doc, { engine: 'pm-steps/1' });
    expect(a.t).toBe('ch.opened');
    const b = await bob.open(1, doc, { engine: 'pm-steps/1' });
    expect(b.t).toBe('ch.opened');

    let base = 0;
    for (let i = 0; i < 3; i++) {
      const ack = await alice.submit(1, {
        id: uuid7(),
        base,
        steps: [insertText(intro(), `a${i} `)],
      });
      expect(ack.t).toBe('sync.ack');
      base = ack.d!['seq'] as number;
    }
    // Bob receives the commits as live messages.
    await bob.take(
      (m) =>
        m.t === 'sync.commit' &&
        (m.d!['commits'] as Array<{ seq: number }>).some((c) => c.seq === base),
    );

    // Presence travels on the same channel.
    alice.send({
      t: 'presence.state',
      ch: 1,
      d: { session: 's-alice', seq: base, state: { caret: 1 } },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(aliceSockets.frames()).toBeGreaterThan(0);
    expect(bobSockets.frames()).toBeGreaterThan(0);
    expect(aliceSockets.count()).toBe(0);
    expect(bobSockets.count()).toBe(0);
    expect(bob.frames.every((f) => f.startsWith('{'))).toBe(true);
  });
});
