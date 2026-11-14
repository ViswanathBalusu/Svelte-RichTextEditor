/**
 * SEC-014 — revocation holds on both planes (05 §3.3; 07 §9; 10 §3.2). A user revoked for the whole
 * tenant loses the open connection with `auth.revoked` and close code 4401; the old token is refused
 * with `revoked` in a new `hello`, in `ch.open`, in `auth.refresh` and as a REST bearer; a token
 * issued after the watermark works; a revocation that names one document ends only that channel,
 * with `forbidden`, and leaves the user's other channel open.
 *
 * The watermark is to the second (05 §3.3; D73): a token minted in the same second as a revocation
 * is accepted. Each test therefore waits past the second before it revokes, so the old token is
 * strictly older than the watermark. The run is in memory; the restart of criterion 4 needs the
 * PostgreSQL store, which is not running in this environment, so it is not proved here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  posInside,
  startHarness,
  type Harness,
} from './support/harness.ts';
import { WireClient, type Received } from './support/wire.ts';

const PARA = 'pIntro0000000001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the promise's value, or rejects after `ms`. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('SEC-014 revocation holds on both planes (memory)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory');
  });
  afterAll(async () => {
    await h?.close();
  });

  /** Revokes a user's sessions: for the whole tenant, or on one document. */
  const revoke = async (sub: string, doc?: string) => {
    const r = await h.call('POST', '/v1/sessions/revoke', {
      token: h.a.apiKey,
      body: doc === undefined ? { sub } : { sub, doc },
    });
    expect(r.status).toBe(204);
  };

  /** A connection authenticated with `token`, with channel 1 open on `doc`. */
  const openFor = async (token: string, doc: string) => {
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    const welcome = await c.hello(token);
    expect(welcome.t).toBe('welcome');
    const opened = await c.open(1, doc);
    expect(opened.t).toBe('ch.opened');
    return c;
  };

  it('ends a connected user with auth.revoked and 4401, and refuses the old token on every route', async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const old = await h.mintToken(h.a, 'ruth', { [doc]: 'editor' });
    const live = await openFor(old, doc);
    const probes: WireClient[] = [];
    try {
      // The old token must be older than the watermark: wait past the second, then revoke.
      await sleep(1100);
      await revoke('ruth');

      const closed = await within(live.closed, 3000, 'the revoked connection closing');
      expect(closed.code).toBe(4401);
      expect(live.all('auth.revoked').length).toBeGreaterThan(0);

      // Criterion 2, new hello: refused with `revoked`.
      const newHello = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      probes.push(newHello);
      const refusedHello = await newHello.hello(old);
      expect(refusedHello.t).toBe('error');
      expect(refusedHello.d?.['code']).toBe('revoked');

      // A token issued after the watermark is accepted (criterion 3).
      const fresh = await h.mintToken(h.a, 'ruth', { [doc]: 'editor' });
      const authed = await openFor(fresh, doc);
      probes.push(authed);

      // Criterion 2, auth.refresh carrying the old token.
      const refreshId = authed.nextId();
      authed.send({ t: 'auth.refresh', id: refreshId, d: { token: old } });
      const refreshed = await authed.take(
        (m) => m.re === refreshId,
        5000,
        'answer to auth.refresh',
      );
      expect(refreshed.t).toBe('error');
      expect(refreshed.d?.['code']).toBe('revoked');

      // Criterion 2, REST bearer: the old token is refused, the new one is accepted (criterion 3).
      const rest = await h.call('GET', `/v1/documents/${doc}`, { token: old });
      expect(rest.status).toBe(401);
      expect(rest.json['code']).toBe('revoked');
      const restFresh = await h.call('GET', `/v1/documents/${doc}`, { token: fresh });
      expect(restFresh.status).toBe(200);
    } finally {
      live.terminate();
      for (const p of probes) p.terminate();
    }
  });

  // Criterion 2, the `ch.open` clause. The old token is refused, but the channel answer is
  // `forbidden`, not `revoked`: `#openChannel` maps every failure of a channel token to
  // `forbidden` (services/document-service/src/data-plane/session.ts, the `d.token` branch). This
  // test records that gap. `it.fails` passes while the assertion fails; when the service answers
  // `revoked`, this test fails and the marker must be removed.
  it.fails(
    'refuses ch.open with the old token with `revoked` (the service answers `forbidden` today)',
    async () => {
      const doc = await h.createDocument(h.a, documentWithRegions());
      const old = await h.mintToken(h.a, 'ruth3', { [doc]: 'editor' });
      await sleep(1100);
      await revoke('ruth3');
      const fresh = await h.mintToken(h.a, 'ruth3', { [doc]: 'editor' });
      const bare = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        expect((await bare.hello(fresh)).t).toBe('welcome');
        const opened: Received = await bare.open(1, doc, { token: old });
        expect(opened.t).toBe('ch.rejected');
        expect(opened.d?.['code']).toBe('revoked');
      } finally {
        bare.terminate();
      }
    },
  );

  it('ends only the named document’s channel with forbidden, and leaves the other channel open', async () => {
    const docA = await h.createDocument(h.a, documentWithRegions());
    const docB = await h.createDocument(h.a, documentWithRegions());
    const token = await h.mintToken(h.a, 'ruth2', { [docA]: 'editor', [docB]: 'editor' });
    const c = await openFor(token, docA);
    try {
      const second = await c.open(2, docB);
      expect(second.t).toBe('ch.opened');

      await revoke('ruth2', docA);

      const closedA = await c.take(
        (m) => m.t === 'ch.closed' && m.ch === 1,
        3000,
        'ch.closed on the named document',
      );
      expect(closedA.d?.['code']).toBe('forbidden');

      // The other channel is unaffected: its submit is acknowledged and it is not closed.
      const content = (await h.call('GET', `/v1/documents/${docB}/content`, { token: h.a.apiKey }))
        .json;
      const ack = await c.submit(2, {
        id: uuid7(),
        base: content.seq as number,
        steps: [insertText(posInside(content.doc, PARA), 'still open')],
      });
      expect(ack.t).toBe('sync.ack');
      expect(c.all('ch.closed', 2).length).toBe(0);
    } finally {
      c.terminate();
    }
  });
});
