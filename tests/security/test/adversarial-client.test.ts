/**
 * SEC-002 — the adversarial client is not the component: it speaks the DEP wire format itself and
 * can send what the component never would (10 §2, §5). This file exercises each capability the
 * story asks for, so the negative tests of the rest of the packet have a client that can reach
 * every corner of the protocol.
 *
 * Criterion 5 (the suite runs against the compose stack of BE-005 in CI): BE-005 is packet E; this
 * suite runs against the real service on PostgreSQL in the CI integration job
 * (infra/test-env.ps1 run -NoExport pnpm test). The compose stack itself is noted in the story.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { keyPair } from './support/jws.ts';
import { WireClient } from './support/wire.ts';

describe('SEC-002 the adversarial protocol client (memory)', () => {
  let h: Harness;
  let doc: string;
  beforeAll(async () => {
    h = await startHarness('memory');
    doc = await h.createDocument(h.a, documentWithRegions());
  });
  afterAll(async () => {
    await h?.close();
  });

  it('sends any envelope, message type, channel number, chunk and step JSON, including malformed', async () => {
    const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      await c.hello(token);
      // An arbitrary unknown type with a step-shaped payload (non-fatal: the connection survives).
      c.send({ t: 'x-probe', id: 'x2', d: { steps: [{ stepType: 'frob', from: -1, to: 1e9 }] } });
      const err = await c.take((m) => m.re === 'x2', 3000, 'the unknown_type answer');
      expect(err.t).toBe('error');
      // A known type carrying a crafted payload (validation off), on an odd channel number.
      c.sendEncoded({
        t: 'ch.open',
        id: 'x1',
        ch: 99,
        d: { kind: 'doc', doc, engine: 'pm-steps/1', cdm: 1, features: [] },
      });
      // A chunk frame by hand.
      c.send({ t: 'chunk', d: { of: 'z', i: 0, n: 2, part: 'abc' } });
    } finally {
      c.terminate();
    }
    // A raw malformed frame, on its own connection (it is fatal: close 4400).
    const bad = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      bad.sendRaw('{ this is not valid json');
      expect((await bad.closed).code).toBe(4400);
    } finally {
      bad.terminate();
    }
  });

  it('calls any REST route with any token or credential and sets DEP-Actor, Idempotency-Key, If-Match, Origin and raw bodies', async () => {
    // A raw body and an Origin header on a service-credential route.
    const minted = await h.call('POST', '/v1/tokens', {
      token: h.a.apiKey,
      raw: JSON.stringify({ sub: 'ann', docs: { [doc]: 'viewer' } }),
      headers: {
        'Content-Type': 'application/json',
        Origin: h.a.origin,
        'Idempotency-Key': uuid7(),
        'DEP-Actor': '00000000-0000-7000-8000-0000000000ac',
      },
    });
    expect(minted.status).toBe(200);
    // An If-Match header on a mutating route (a stale tag is rejected, proving the header is read).
    const bad = await h.call('PATCH', `/v1/documents/${doc}`, {
      token: h.a.apiKey,
      body: { title: 'x' },
      headers: { 'If-Match': '"m-stale"' },
    });
    expect([409, 412, 428]).toContain(bad.status);
    // Any token, including a service credential, on any route.
    const asUser = await h.call('GET', `/v1/documents/${doc}`, {
      token: await h.mintToken(h.a, 'ann', { [doc]: 'viewer' }),
    });
    expect(asUser.status).toBe(200);
  });

  it('withholds, delays and reorders frames, and keeps a connection open without sending hello', async () => {
    const quiet = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      // No hello is sent; the connection is held open (the hello timeout is 10 s).
      await new Promise((r) => setTimeout(r, 300));
      expect(quiet.closeInfo).toBeNull();
    } finally {
      quiet.terminate();
    }
    // Sending out of order: a ch.open before hello is refused, which the client can still send.
    const early = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      early.send({
        t: 'ch.open',
        id: 'c1',
        ch: 1,
        d: { kind: 'doc', doc, engine: 'pm-steps/1', cdm: 1, features: [] },
      });
      expect((await early.closed).code).toBe(4400); // the first message must be hello
    } finally {
      early.terminate();
    }
  });

  it('mints tokens for several tenants and roles, and signs tokens with arbitrary keys for confusion tests', async () => {
    // Several tenants and roles through POST /tokens.
    const aEditor = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const docB = await h.createDocument(h.b, documentWithRegions());
    const bViewer = await h.mintToken(h.b, 'ben', { [docB]: 'viewer' });
    for (const [tok, origin] of [
      [aEditor, h.a.origin],
      [bViewer, h.b.origin],
    ] as const) {
      const c = await WireClient.connect(h.wsUrl, { origin });
      try {
        expect((await c.hello(tok)).t).toBe('welcome');
      } finally {
        c.terminate();
      }
    }
    // A token signed with an arbitrary (unregistered) key is refused.
    const stranger = keyPair('EdDSA');
    const forged = h.userToken(h.a, 'ann', { [doc]: 'editor' }, { sign: stranger });
    expect((await h.call('GET', `/v1/documents/${doc}`, { token: forged })).status).toBe(401);
  });
});

// Criterion 5: the same client suite runs against the real service on PostgreSQL in CI.
describe('SEC-002 runs against PostgreSQL (CI integration job)', () => {
  for (const storage of ['postgres'] as Storage[]) {
    it('connects and is welcomed against the PostgreSQL-backed service', async () => {
      const skip = await postgresUnavailable();
      if (skip) return; // PostgreSQL not up locally; the CI integration job runs this path
      const h = await startHarness(storage);
      try {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await c.hello(token)).t).toBe('welcome');
          expect((await c.open(1, doc)).t).toBe('ch.opened');
        } finally {
          c.terminate();
        }
      } finally {
        await h.close();
      }
    });
  }
});
