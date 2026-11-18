// Relay mode (04 §14; 05 §3 and §10; SYN-044).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/permissions/model.ts';
import {
  RELAY_EXCLUDED_FEATURES,
  Relay,
  relayCapabilities,
  relayFeatureAvailable,
  type RelayOut,
  type RelayStore,
} from '../src/index.ts';
import type { StoredCommit } from '../src/room/types.ts';

function uuid(n: number): string {
  return `0192f0c4-7b1e-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

function conn(sub: string, agent?: string): Connection {
  return {
    sub,
    session: `session-${sub}`,
    role: 'editor',
    groups: [],
    participantRoles: [],
    participantActive: false,
    ...(agent !== undefined ? { agent } : {}),
  } as unknown as Connection;
}

function memoryStore(): RelayStore & { log: StoredCommit[] } {
  const log: StoredCommit[] = [];
  return {
    log,
    append(c) {
      log.push(c);
      return true;
    },
  };
}

function newRelay(store: RelayStore = memoryStore(), now = () => 1_000) {
  const relay = new Relay({ now, store });
  relay.open('a', conn('alice', 'assistant-1'));
  relay.open('b', conn('bob'));
  return relay;
}

describe('relay mode: the commit path (SYN-044 criterion 1)', () => {
  it('skips steps 4 to 7: a step that no authority would accept is stored and relayed', () => {
    const store = memoryStore();
    const relay = newRelay(store);
    const junk = [{ stepType: 'notAStep', anything: [1, 2, 3] }];
    const out = relay.submit('a', { id: uuid(1), base: 0, steps: junk });
    expect(store.log).toHaveLength(1);
    expect(store.log[0]!.steps).toEqual(junk);
    expect(out.find((o) => o.msg.t === 'sync.ack')).toMatchObject({
      channel: 'a',
      msg: { t: 'sync.ack', id: uuid(1), seq: 1, rebased: false },
    });
  });

  it('rejects a commit whose base is not the head with stale_base and action rebase', () => {
    const store = memoryStore();
    const relay = newRelay(store);
    relay.submit('a', { id: uuid(1), base: 0, steps: [] });
    const out = relay.submit('b', { id: uuid(2), base: 0, steps: [] });
    expect(store.log).toHaveLength(1);
    expect(out).toEqual([
      {
        channel: 'b',
        msg: expect.objectContaining({
          t: 'sync.reject',
          code: 'stale_base',
          action: 'rebase',
          head: 1,
        }),
      },
    ]);
  });

  it('rejects a base ahead of the head as stale_base too', () => {
    const relay = newRelay();
    const out = relay.submit('a', { id: uuid(1), base: 5, steps: [] });
    expect(out[0]?.msg).toMatchObject({ t: 'sync.reject', code: 'stale_base' });
    expect(relay.headSeq).toBe(0);
  });

  it('stores with server attribution and sends the commit to the other channels only', () => {
    const store = memoryStore();
    const relay = newRelay(store, () => 4_242);
    const out = relay.submit('a', {
      id: uuid(1),
      base: 0,
      steps: [],
      origin: 'input',
      user: 'mallory',
    });
    const c = store.log[0]!;
    expect(c.user).toBe('alice');
    expect(c.agent).toBe('assistant-1');
    expect(c.time).toBe(4_242);
    expect(c.seq).toBe(1);
    expect(out.map((o: RelayOut) => o.channel)).toEqual(['a', 'b']);
    expect(out[1]!.msg).toEqual({ t: 'sync.commit', commit: c });
  });

  it('stores before it acknowledges: a failed store leaves the head and the log unchanged', () => {
    const store = { append: () => false };
    const relay = newRelay(store);
    const out = relay.submit('a', { id: uuid(1), base: 0, steps: [] });
    expect(relay.headSeq).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]!.msg).toMatchObject({ t: 'sync.reject', code: 'unavailable', action: 'retry' });
  });

  it('turns a throwing store into a refusal and does not throw', () => {
    const relay = newRelay({
      append: () => {
        throw new Error('disk gone');
      },
    });
    const out = relay.submit('a', { id: uuid(1), base: 0, steps: [] });
    expect(out[0]!.msg).toMatchObject({ t: 'sync.reject', code: 'unavailable' });
    expect(relay.headSeq).toBe(0);
  });

  it('acknowledges a repeated id from the same user without storing it twice', () => {
    const store = memoryStore();
    const relay = newRelay(store);
    relay.submit('a', { id: uuid(1), base: 0, steps: [] });
    const out = relay.submit('a', { id: uuid(1), base: 0, steps: [] });
    expect(store.log).toHaveLength(1);
    expect(out[0]!.msg).toMatchObject({ t: 'sync.ack', seq: 1 });
  });

  it('refuses a repeated id from another user with invalid_op', () => {
    const relay = newRelay();
    relay.submit('a', { id: uuid(1), base: 0, steps: [] });
    const out = relay.submit('b', { id: uuid(1), base: 0, steps: [] });
    expect(out[0]!.msg).toMatchObject({ t: 'sync.reject', code: 'invalid_op' });
  });

  it('refuses malformed input with invalid_op and nothing throws', () => {
    const relay = newRelay();
    const bad: unknown[] = [
      null,
      42,
      'x',
      { id: 'not-a-uuid', base: 0, steps: [] },
      { id: uuid(1), base: -1, steps: [] },
      { id: uuid(1), base: 0.5, steps: [] },
      { id: uuid(1), base: 0, steps: 'nope' },
      { id: uuid(1), base: 0, steps: [], origin: 'restore' },
    ];
    for (const input of bad) {
      expect(relay.submit('a', input)[0]?.msg).toMatchObject({
        t: 'sync.reject',
        code: 'invalid_op',
      });
    }
    expect(relay.headSeq).toBe(0);
  });

  it('starts from a restored log and continues its sequence', () => {
    const store = memoryStore();
    const first = newRelay(store);
    first.submit('a', { id: uuid(1), base: 0, steps: [] });
    const relay = new Relay({ now: () => 1, store, log: store.log });
    relay.open('a', conn('alice'));
    expect(relay.headSeq).toBe(1);
    expect(relay.submit('a', { id: uuid(1), base: 1, steps: [] })[0]?.msg).toMatchObject({
      t: 'sync.ack',
      seq: 1,
    });
    expect(relay.submit('a', { id: uuid(2), base: 1, steps: [] })[0]?.msg).toMatchObject({
      t: 'sync.ack',
      seq: 2,
    });
  });

  it('refuses a restored log with a gap', () => {
    const log = [{ seq: 2 }] as unknown as StoredCommit[];
    expect(() => new Relay({ now: () => 0, store: memoryStore(), log })).toThrow(RangeError);
  });

  it('ignores submissions from channels that are not open', () => {
    const store = memoryStore();
    const relay = newRelay(store);
    relay.close('a');
    expect(relay.submit('a', { id: uuid(1), base: 0, steps: [] })).toEqual([]);
    expect(store.log).toHaveLength(0);
  });

  it('property: accepted commits are gap-free, each stored once, and each based on the head it followed', () => {
    const submission = fc.record({
      channel: fc.constantFrom('a', 'b'),
      id: fc.integer({ min: 1, max: 12 }),
      base: fc.integer({ min: 0, max: 14 }),
      steps: fc.array(fc.dictionary(fc.string({ maxLength: 4 }), fc.integer()), { maxLength: 3 }),
    });
    fc.assert(
      fc.property(fc.array(submission, { maxLength: 60 }), (subs) => {
        const store = memoryStore();
        const relay = newRelay(store);
        for (const s of subs) {
          const before = relay.headSeq;
          const out = relay.submit(s.channel, { id: uuid(s.id), base: s.base, steps: s.steps });
          const reply = out.find((o) => o.channel === s.channel)?.msg;
          if (reply?.t === 'sync.ack') {
            if (reply.seq === before + 1) {
              // A new commit: it was based on the head it followed.
              expect(s.base).toBe(before);
            } else {
              // A repeated id: acknowledged with its first sequence number, nothing stored.
              expect(reply.seq).toBeLessThanOrEqual(before);
              expect(relay.headSeq).toBe(before);
            }
          } else {
            // Refused: it stored nothing new.
            expect(relay.headSeq).toBe(before);
          }
        }
        expect(store.log.map((c) => c.seq)).toEqual(store.log.map((_, i) => i + 1));
        expect(new Set(store.log.map((c) => c.id)).size).toBe(store.log.length);
      }),
      { numRuns: 300 },
    );
  });

  it('property: arbitrary JSON input never throws', () => {
    const relay = newRelay();
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => relay.submit('a', input)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe('relay mode: capabilities (SYN-044 criterion 2)', () => {
  const full = [
    'presence',
    'regions',
    'suggest-enforced',
    'history',
    'comments',
    'assets',
    'exports',
    'leases',
    'fields',
  ];

  it('announces mode relay and none of regions, suggest-enforced or fields', () => {
    const caps = relayCapabilities(full);
    expect(caps.mode).toBe('relay');
    for (const f of RELAY_EXCLUDED_FEATURES) expect(caps.features).not.toContain(f);
    expect(caps.features).toEqual([
      'presence',
      'history',
      'comments',
      'assets',
      'exports',
      'leases',
    ]);
  });

  it('lists the three features a relay cannot enforce and the workflow of FRW-025 as excluded', () => {
    // 05 §2 names regions, suggest-enforced and fields; workflow is the proposal of ADR 0371.
    expect([...RELAY_EXCLUDED_FEATURES].sort()).toEqual([
      'fields',
      'regions',
      'suggest-enforced',
      'workflow',
    ]);
  });
});

describe('relay mode: what needs the authority service (SYN-044 criterion 3)', () => {
  const features = ['content', 'catchUpBeyondWindow', 'restore', 'comparison', 'export'] as const;

  it('makes each of them unavailable to a relay without an authority service', () => {
    for (const f of features) {
      expect(relayFeatureAvailable('relay', f, false)).toBe(false);
      expect(relayFeatureAvailable('relay', f, true)).toBe(true);
      expect(relayFeatureAvailable('authority', f, false)).toBe(true);
    }
  });
});

describe('relay mode: the module is universal (FND-004)', () => {
  it('imports no Node.js module and no ProseMirror type', () => {
    const src = readFileSync(new URL('../src/room/relay.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"]node:/);
    expect(src).not.toMatch(/prosemirror/);
  });
});
