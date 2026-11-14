// Negotiation, reconnection policy and the codec's guarantees as the client relies on them (05 §1,
// §2, §4, §5.7; PRO-004, PRO-005, PRO-006; D82, D83). Universal: Node.js and browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { supportedFeatures } from '@docedit/model/definition';
import { contractDocument } from '../contract/fixtures.ts';
import { depCodec } from '../codec/frame.ts';
import { DEP1, defineDep } from '../definition/index.ts';
import type { DepExtension } from '../definition/extension.ts';
import { ExampleBuilder } from '../generate/examples.ts';
import type { Discovery } from '../generated/types.ts';
import { BACKOFF, backoffDelay, classifyClose } from './backoff.ts';
import {
  checkDiscovery,
  chooseCdm,
  clientCapabilities,
  chooseVersion,
  featureNamespaceProblems,
  isExperimental,
  negotiateFeatures,
  relayForbiddenAnnounced,
  subprotocolFor,
} from './negotiate.ts';
import { ClientSession } from './session.ts';

const DISCOVERY: Discovery = {
  versions: ['1.0'],
  ws: 'wss://docs.example.com/dep',
  rest: 'https://docs.example.com/v1',
  engines: ['pm-steps/1'],
  cdm: { min: 1, max: 1 },
  features: ['presence', 'regions'],
  mode: 'authority',
  jwks_uri: 'https://docs.example.com/.well-known/jwks.json',
};

describe('versions (05 §1 rule 1; PRO-006; D82)', () => {
  it('expects the highest common version, and names the major in the subprotocol', () => {
    expect(chooseVersion(['1.0', '1.2', '2.0'], ['1.2', '1.10', '2.0', '3.1'])).toBe('2.0');
    expect(chooseVersion(['1.0'], ['1.2'])).toBeNull();
    expect(chooseVersion(['1.10', '1.9'], ['1.9', '1.10'])).toBe('1.10');
    expect(subprotocolFor('1.0')).toBe('dep.v1');
    expect(subprotocolFor('2.7')).toBe('dep.v2');
    expect(subprotocolFor()).toBe(DEP1.subprotocol);
  });

  it('checks discovery for a common version, engine and CDM range before connecting', () => {
    expect(checkDiscovery(DISCOVERY)).toBeNull();
    expect(checkDiscovery({ ...DISCOVERY, versions: ['2.0'] })?.code).toBe('unsupported_version');
    expect(checkDiscovery({ ...DISCOVERY, engines: ['crdt/1'] })?.code).toBe('unsupported_engine');
    expect(checkDiscovery({ ...DISCOVERY, cdm: { min: 2, max: 3 } })?.code).toBe('unsupported_cdm');
    expect(chooseCdm({ min: 1, max: 3 }, { min: 1, max: 2 })).toBe(2);
    expect(chooseCdm({ min: 3, max: 4 }, { min: 1, max: 2 })).toBeNull();
  });

  it('refuses a relay that announces regions, suggest-enforced or fields (05 §2, §9; PRO-101)', () => {
    const forbidden = DEP1.features
      .filter((f) => f.relayForbidden)
      .map((f) => f.name)
      .sort();
    expect(forbidden).toEqual(['fields', 'regions', 'suggest-enforced']);
    const relay: Discovery = { ...DISCOVERY, mode: 'relay', features: ['presence', 'comments'] };
    expect(relayForbiddenAnnounced(relay)).toEqual([]);
    expect(checkDiscovery(relay)).toBeNull();
    // An authority may announce all three.
    const authority: Discovery = {
      ...DISCOVERY,
      features: ['regions', 'suggest-enforced', 'fields'],
    };
    expect(relayForbiddenAnnounced(authority)).toEqual([]);
    expect(checkDiscovery(authority)).toBeNull();
    for (const name of forbidden) {
      const d: Discovery = { ...DISCOVERY, mode: 'relay', features: ['presence', name, name] };
      expect(relayForbiddenAnnounced(d)).toEqual([name]);
      const problem = checkDiscovery(d);
      expect(problem?.code).toBe('unsupported_feature');
      expect(problem?.message).toContain(name);
    }
    // Every subset of announced names: a relay is refused exactly when one forbidden name is in it.
    const names = DEP1.features.map((f) => f.name);
    fc.assert(
      fc.property(
        fc.subarray(names),
        fc.constantFrom('relay' as const, 'authority' as const),
        (fs, mode) => {
          const d: Discovery = { ...DISCOVERY, mode, features: fs };
          const bad = mode === 'relay' && fs.some((f) => forbidden.includes(f));
          expect(checkDiscovery(d) !== null).toBe(bad);
          expect(relayForbiddenAnnounced(d).length > 0).toBe(bad);
        },
      ),
    );
  });
});

describe('features (05 §1 rules 4 and 5; PRO-005, PRO-006)', () => {
  it('ignores an unknown feature name in discovery and offers pm-steps/1 (PRO-008 criterion 4)', () => {
    const withUnknown: Discovery = {
      ...DISCOVERY,
      features: [...DISCOVERY.features, 'x-unheard-of', 'unheard-of'],
    };
    // Discovery with names this client does not know is still usable: only a relay's forbidden
    // features refuse the connection.
    expect(checkDiscovery(withUnknown)).toBeNull();
    // The client uses only what it asked for and the server announced.
    // The client did not ask for 'unheard-of' and is left with what it asked for and was announced.
    expect(negotiateFeatures(['presence', 'x-not-announced'], withUnknown.features)).toEqual([
      'presence',
    ]);
    // The server's engines include pm-steps/1, the engine of 04 that the client implements.
    expect(withUnknown.engines).toContain('pm-steps/1');
    expect(clientCapabilities().engines).toContain('pm-steps/1');
  });

  it('keeps what both sides name, in the order asked, without repeats; x- names likewise', () => {
    expect(
      negotiateFeatures(['presence', 'x-a', 'regions', 'presence'], ['regions', 'x-b', 'presence']),
    ).toEqual(['presence', 'regions']);
    expect(negotiateFeatures(['x-a'], ['x-a'])).toEqual(['x-a']);
    expect(isExperimental('x-a')).toBe(true);
    expect(isExperimental('presence')).toBe(false);
  });

  it('holds protocol and CDM features in one namespace, each registered once, none stable with x-', () => {
    expect(featureNamespaceProblems(DEP1, supportedFeatures())).toEqual([]);
    const again: DepExtension = {
      owner: 'TEST',
      shapes: [],
      messages: [],
      operations: [],
      notifications: [],
      webhooks: [],
      features: [
        { name: 'presence', doc: 'twice', spec: '-', relayForbidden: false, owner: 'TEST' },
        {
          name: 'x-stable',
          doc: 'experimental name',
          spec: '-',
          relayForbidden: false,
          owner: 'TEST',
        },
      ],
    };
    expect(
      featureNamespaceProblems(defineDep([again]), [...supportedFeatures(), 'unregistered']),
    ).toEqual([
      'feature presence is registered 2 times',
      'stable feature x-stable uses the x- prefix',
      'CDM feature unregistered is not registered in the namespace',
    ]);
  });
});

describe('reconnection (05 §4, §5.7; D83)', () => {
  it('backs off from 0.5 s, doubling to 30 s, with full jitter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (n, r) => {
          const cap = Math.min(BACKOFF.maxMs, BACKOFF.initialMs * 2 ** n);
          const d = backoffDelay(n, () => r);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThan(cap);
        },
      ),
    );
    expect(backoffDelay(0, () => 0.999)).toBeLessThan(500);
    expect(backoffDelay(10, () => 0.999)).toBeLessThan(30_000);
    expect(backoffDelay(10, () => 0.999)).toBeGreaterThan(29_000);
  });

  it('classifies close codes, refining 4401 by the error before it', () => {
    expect(classifyClose(1006)).toEqual({ code: 'unavailable', reconnect: 'backoff' });
    expect(classifyClose(4401)).toEqual({ code: 'unauthenticated', reconnect: 'new-token' });
    expect(
      classifyClose(4401, { code: 'token_expired', message: 'old', retryable: true, fatal: true }),
    ).toEqual({ code: 'token_expired', reconnect: 'new-token' });
    expect(classifyClose(4403).reconnect).toBe('no');
    expect(classifyClose(4406)).toEqual({ code: 'unsupported_version', reconnect: 'no' });
    expect(
      classifyClose(4429, {
        code: 'rate_limited',
        message: 'slow down',
        retryable: true,
        retryAfterMs: 900,
        fatal: true,
      }),
    ).toEqual({ code: 'rate_limited', reconnect: 'backoff', retryAfterMs: 900 });
  });
});

describe('the codec as the client uses it (PRO-004)', () => {
  const codec = depCodec();
  const examples = new ExampleBuilder(DEP1, contractDocument());

  it('round-trips the minimal and maximal example of every message type: decode(encode(x)) equals x', () => {
    for (const m of DEP1.messages)
      for (const mode of ['min', 'max'] as const) {
        const x = examples.message(m, mode);
        const text = codec.encode(x);
        const receiver = m.dir === 'c2s' ? 'server' : 'client';
        const r = codec.decode(text, { receiver });
        expect(r.kind, `${m.t} ${mode}`).toBe('message');
        expect(r.kind === 'message' && r.message, `${m.t} ${mode}`).toEqual(x);
        expect(text.startsWith('{"t":'), m.t).toBe(true);
      }
  });

  it('never executes payload content: no prototype is reached through a received frame', () => {
    let n = 0;
    const s = new ClientSession({
      token: 't',
      client: { name: 'c', version: '1' },
      features: [],
      ids: () => `${++n}`,
      now: 0,
    });
    const hello = JSON.parse(s.take()[0]!) as { id: string };
    s.receive(
      JSON.stringify({
        t: 'welcome',
        re: hello.id,
        d: {
          version: '1.0',
          session: '0192f4b0-0000-7000-8000-000000000002',
          user: { id: 'u' },
          features: [],
          limits: {
            maxMessageBytes: 131072,
            maxCommitBytes: 1,
            maxStepsPerCommit: 1,
            maxRebaseSteps: 1,
            maxChannels: 1,
            heartbeatMs: 1000,
            ackTimeoutMs: 1000,
            presenceHz: 1,
            presenceBytes: 1,
            catchUpCommits: 1,
            catchUpBytes: 1,
          },
          tokenExp: '2026-09-18T10:42:00.000Z',
        },
      }),
      1,
    );
    const hostile =
      '{"t":"event","ch":1,"__proto__":{"polluted":1},"d":{"type":"document.updated","resource":"/x","__proto__":{"polluted":2},"constructor":{"prototype":{"polluted":3}},"toJSON":"x"}}';
    const out = s.receive(hostile, 2);
    expect(out).toHaveLength(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    const first = out[0]!;
    expect(first.kind).toBe('message');
    expect(Object.getPrototypeOf(first.kind === 'message' ? first.message : null)).toBe(
      Object.prototype,
    );
  });
});
