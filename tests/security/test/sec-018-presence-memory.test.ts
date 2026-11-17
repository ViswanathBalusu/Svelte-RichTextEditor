/**
 * SEC-018 criterion 3, the memory clause (10 §3.2; 04 §11): presence above the cap, and oversized
 * presence, leave the room holding a bounded amount, however many updates arrive.
 *
 * Presence is never stored; in a room it lives only in the `PresenceRelay`
 * (services/document-service/src/data-plane/presence.ts, one for each room, room-host.ts). This
 * file drives the real relay in process, because what a room holds cannot be seen from the wire;
 * the wire side of the criterion (the cap on relayed updates, the oversized and the invalid state)
 * is tests/security/test/presence-bounds.test.ts.
 *
 * The flood: CHANNELS channels each publish UPDATES states as fast as the loop runs, far above
 * `presenceHz`. Every state differs, most are padded close to `presenceBytes` with members a client
 * may add, and one in ten is above `presenceBytes`. At every sample the relay holds one entry for
 * each channel and at most two states of `presenceBytes` for each (the last relayed and the one
 * waiting), and when the channels leave it holds nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PresencePeers, PresenceUpdate } from '@docedit/protocol';
import { PresenceRelay } from '../../../services/document-service/src/data-plane/presence.ts';
import { DEFAULT_LIMIT_VALUES } from '../../../services/document-service/src/data-plane/settings.ts';

const CHANNELS = 20;
const UPDATES = 5_000;

describe('SEC-018 criterion 3: the presence a room holds is bounded', () => {
  const limits = {
    presenceHz: DEFAULT_LIMIT_VALUES.presenceHz,
    presenceBytes: DEFAULT_LIMIT_VALUES.presenceBytes,
  };
  let relay: PresenceRelay | null = null;
  afterEach(() => {
    relay?.close();
    relay = null;
  });

  it('holds one entry and at most two capped states for each channel under a flood', () => {
    relay = new PresenceRelay(limits);
    let delivered = 0;
    for (let c = 0; c < CHANNELS; c++)
      relay.join(`ch-${c}`, {
        session: `session-${c}`,
        user: { id: `user-${c}`, name: `User ${c}` } as never,
        view: () => 'full',
        wants: true,
        send: (p: PresencePeers) => {
          delivered += p.peers.length;
        },
      });
    const bound = CHANNELS * 2 * limits.presenceBytes;
    const update = (seq: number, pad: number): PresenceUpdate =>
      ({
        seq,
        state: {
          selection: { anchor: seq, head: seq + 1 },
          scope: 'body',
          status: 'active',
          // Members a client may add: they count against `presenceBytes` while the state waits.
          padding: 'x'.repeat(pad),
        },
      }) as unknown as PresenceUpdate;

    let worst = 0;
    let oversized = 0;
    for (let i = 0; i < UPDATES; i++) {
      for (let c = 0; c < CHANNELS; c++) {
        const tooBig = i % 10 === 9;
        if (tooBig) oversized++;
        relay.update(`ch-${c}`, update(i, tooBig ? limits.presenceBytes * 4 : 800));
      }
      if (i % 50 === 0) {
        const held = relay.held;
        worst = Math.max(worst, held.stateBytes);
        expect(held.entries).toBe(CHANNELS);
        expect(held.stateBytes).toBeLessThanOrEqual(bound);
      }
    }
    const held = relay.held;
    expect(held.entries).toBe(CHANNELS);
    expect(held.stateBytes).toBeLessThanOrEqual(bound);
    expect(worst, 'the flood did put states in the relay').toBeGreaterThan(0);

    // The oversized states were refused, and the rest were relayed at the cap or replaced.
    const sent = CHANNELS * UPDATES;
    expect(relay.stats.refused).toBe(oversized);
    expect(relay.stats.relayed + relay.stats.coalesced).toBeLessThan(sent - oversized);
    expect(relay.stats.relayed, 'far fewer relayed than sent').toBeLessThan(sent / 10);
    expect(delivered).toBe(relay.stats.relayed * (CHANNELS - 1));

    // When the channels leave, nothing is kept.
    for (let c = 0; c < CHANNELS; c++) relay.leave(`ch-${c}`);
    expect(relay.held).toEqual({ entries: 0, stateBytes: 0 });
  });

  it('keeps nothing for a channel that never joined', () => {
    relay = new PresenceRelay(limits);
    for (let i = 0; i < 1_000; i++)
      relay.update(`stranger-${i}`, {
        seq: i,
        state: { selection: { anchor: 1, head: 1 }, scope: 'body', status: 'active' },
      } as unknown as PresenceUpdate);
    expect(relay.held).toEqual({ entries: 0, stateBytes: 0 });
  });
});
