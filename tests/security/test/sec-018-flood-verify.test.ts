/**
 * SEC-018 criterion 1, the part sec-018-address-flood.test.ts left open (10 §3.2; BE-030): a flood
 * of connections and of `hello` frames from one address costs no token verification beyond the
 * address limits, and users from another address connect normally meanwhile.
 *
 * The data plane's token verifier is wrapped by the harness (`onVerify`) so that every call is
 * counted; the real verifier still runs. Each `hello` of the flood carries a token signed with a
 * key the tenant does not have, so every one that reaches the verifier is real verification work
 * and is refused.
 *
 * Two floods, each from 127.0.0.2 against a listener on 0.0.0.0 (as in the address-flood file):
 * 1. frames: the address may send FRAMES frames before `hello` completes. Thirty connections send
 *    one `hello` each: at most FRAMES are verified, the others are answered `rate_limited`.
 * 2. connections: the address may open CONNECTIONS connections. Thirty upgrades are tried: the ones
 *    beyond the limit are refused with HTTP 429 before a socket exists, and nothing is verified.
 * After each flood a client from 127.0.0.1 says `hello` with a good token and opens a document,
 * and that costs exactly one verification. Memory storage: the limits are in the gateway.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RATES } from '../../../services/document-service/src/data-plane/settings.ts';
import { RateLimits } from '../../../services/document-service/src/data-plane/limits.ts';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';
import { keyPair } from './support/jws.ts';
import { WireClient } from './support/wire.ts';

const FRAMES = 5;
const CONNECTIONS = 8;
const FLOOD = 30;
const generous = { capacity: 1_000_000, refillPerSecond: 1_000_000 };
const FLOODER = '127.0.0.2';

describe('SEC-018 criterion 1: a flood before authentication costs no verification beyond the limit', () => {
  let verified = 0;

  const start = (rates: Partial<typeof DEFAULT_RATES>): Promise<Harness> =>
    startHarness('memory', {
      host: '0.0.0.0',
      onVerify: () => {
        verified++;
      },
      rateLimits: new RateLimits({
        ...DEFAULT_RATES,
        addressConnections: generous,
        addressFrames: generous,
        connection: generous,
        user: generous,
        tenant: generous,
        closeAfterRefusals: 1_000_000,
        ...rates,
      }),
    });

  /** A user from another address connects, is verified once, and opens a document. */
  async function bystander(h: Harness): Promise<void> {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const before = verified;
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin, localAddress: '127.0.0.1' });
    try {
      const welcome = await c.hello(token);
      expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
      await c.open(1, doc);
      expect(verified - before, 'the bystander cost one verification').toBe(1);
    } finally {
      c.terminate();
    }
  }

  describe('frames', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await start({ addressFrames: { capacity: FRAMES, refillPerSecond: 0.001 } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('verifies at most the frame burst of a flood of hellos, and refuses the rest unverified', async () => {
      // A well-formed token of the tenant, signed with a key the tenant never registered.
      const forged = h.userToken(h.a, 'mallory', {}, { sign: keyPair('EdDSA') });
      const before = verified;
      const codes: Array<string | undefined> = [];
      for (let i = 0; i < FLOOD; i++) {
        const flood = await WireClient.connect(h.wsUrl, {
          origin: h.a.origin,
          localAddress: FLOODER,
        });
        try {
          flood.send({
            t: 'hello',
            id: `flood-${i}`,
            d: {
              versions: ['1.0'],
              token: forged,
              client: { name: 'flood', version: '0' },
              engines: ['pm-steps/1'],
              cdm: { min: 1, max: 1 },
              features: [],
            },
          });
          await flood.closed;
          const err = flood.log.find((m) => m.t === 'error');
          codes.push((err?.d as { code?: string } | undefined)?.code);
        } finally {
          flood.terminate();
        }
      }
      const spent = verified - before;
      const limited = codes.filter((c) => c === 'rate_limited').length;
      // The verifier ran for the burst and for nothing after it.
      expect(spent, 'verifications spent on the flood').toBeGreaterThan(0);
      expect(spent, 'verifications spent on the flood').toBeLessThanOrEqual(FRAMES);
      expect(limited, 'hellos refused by the address limit').toBe(FLOOD - spent);
      expect(codes.filter((c) => c !== 'rate_limited').length).toBe(spent);

      // More of the same flood costs nothing at all.
      const again = verified;
      for (let i = 0; i < 10; i++) {
        const flood = await WireClient.connect(h.wsUrl, {
          origin: h.a.origin,
          localAddress: FLOODER,
        });
        try {
          flood.send({ t: 'hello', id: `more-${i}`, d: { versions: ['1.0'], token: forged } });
          await flood.closed;
        } finally {
          flood.terminate();
        }
      }
      expect(verified - again, 'verifications after the burst was spent').toBe(0);
    });

    it('serves a user from another address while the flooding address is refused', async () => {
      await bystander(h);
    });
  });

  describe('connections', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await start({ addressConnections: { capacity: CONNECTIONS, refillPerSecond: 0.001 } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('refuses upgrades beyond the address limit before a socket exists, with no verification', async () => {
      const before = verified;
      const open: WireClient[] = [];
      let refused = 0;
      const reasons = new Set<string>();
      for (let i = 0; i < FLOOD; i++) {
        try {
          open.push(
            await WireClient.connect(h.wsUrl, { origin: h.a.origin, localAddress: FLOODER }),
          );
        } catch (e) {
          refused++;
          reasons.add(String((e as Error).message));
        }
      }
      try {
        expect(open.length, 'connections the limit let through').toBeLessThanOrEqual(CONNECTIONS);
        expect(refused).toBe(FLOOD - open.length);
        expect(refused).toBeGreaterThanOrEqual(FLOOD - CONNECTIONS);
        expect([...reasons].join(' | ')).toContain('429');
        expect(verified - before, 'a flood of connections verifies nothing').toBe(0);
      } finally {
        for (const c of open) c.terminate();
      }
    });

    it('serves a user from another address while the flooding address is refused', async () => {
      await bystander(h);
    });
  });
});
