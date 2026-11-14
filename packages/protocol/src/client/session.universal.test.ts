// The client session machine (05 §1, §4, §5.1; PRO-004, PRO-005, PRO-006): handshake and
// negotiation, unknown and invalid frames, heartbeat, chunks. Universal: Node.js and browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunkMessage } from '../codec/chunk.ts';
import { depCodec } from '../codec/frame.ts';
import { ClientSession, DEFAULT_HEARTBEAT_MS, type SessionInput } from './session.ts';

const codec = depCodec();
const SESSION = '0192f4b0-0000-7000-8000-000000000002';
const T = '2026-09-18T10:42:00.000Z';
const LIMITS = {
  maxMessageBytes: 131072,
  maxCommitBytes: 1048576,
  maxStepsPerCommit: 500,
  maxRebaseSteps: 5000,
  maxChannels: 16,
  heartbeatMs: 1000,
  ackTimeoutMs: 15000,
  presenceHz: 10,
  presenceBytes: 1024,
  catchUpCommits: 5000,
  catchUpBytes: 5242880,
};

function session(features: string[] = ['presence', 'regions', 'x-trial']) {
  let n = 0;
  const s = new ClientSession({
    token: 'tok.secret',
    client: { name: 'test', version: '1' },
    features,
    ids: () => String(++n),
    now: 0,
  });
  const hello = JSON.parse(s.take()[0]!) as { t: string; id: string; d: Record<string, unknown> };
  return { s, hello };
}

const welcome = (re: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    t: 'welcome',
    re,
    d: {
      version: '1.0',
      session: SESSION,
      user: { id: 'u1' },
      features: ['presence', 'history', 'x-other'],
      limits: LIMITS,
      tokenExp: T,
      ...extra,
    },
  });

const kinds = (inputs: SessionInput[]) => inputs.map((i) => i.kind);

describe('the handshake (05 §5.1)', () => {
  it('sends hello first, with every member of the table', () => {
    const { hello } = session();
    expect(hello.t).toBe('hello');
    expect(hello.d).toEqual({
      versions: ['1.0'],
      token: 'tok.secret',
      client: { name: 'test', version: '1' },
      engines: ['pm-steps/1'],
      cdm: { min: 1, max: 1 },
      features: ['presence', 'regions', 'x-trial'],
    });
    expect(codec.check(hello, 'server')).toEqual([]);
  });

  it('opens on the welcome that answers hello, with the features both sides name (05 §1 rule 4)', () => {
    const { s, hello } = session();
    expect(s.receive(welcome('other'), 1)).toEqual([]);
    const r = s.receive(welcome(hello.id), 2);
    expect(kinds(r)).toEqual(['welcome']);
    // `history` was not asked for; `x-trial` and `x-other` were each named by one side only.
    expect(s.features).toEqual(['presence']);
    expect(s.phase).toBe('ready');
    expect(s.heartbeatMs).toBe(1000);
  });

  it('refuses a welcome with a version the client did not offer', () => {
    const { s, hello } = session();
    const r = s.receive(welcome(hello.id, { version: '1.1' }), 1);
    expect(r).toMatchObject([{ kind: 'refused', error: { code: 'unsupported_version' } }]);
    expect(s.phase).toBe('ended');
  });

  it('reports an error before welcome as the refusal, with the versions of D06', () => {
    const { s, hello } = session();
    const frame = {
      t: 'error',
      re: hello.id,
      d: {
        code: 'unsupported_version',
        message: 'no',
        retryable: false,
        fatal: true,
        versions: ['2.0'],
      },
    };
    const r = s.receive(JSON.stringify(frame), 1);
    expect(r).toEqual([{ kind: 'refused', error: frame.d }]);
    expect(s.lastFatal).toEqual(frame.d);
  });

  it('ignores channel messages before welcome', () => {
    const { s } = session();
    const r = s.receive(JSON.stringify({ t: 'sync.caughtUp', ch: 1, d: { seq: 1 } }), 1);
    expect(r).toEqual([]);
  });
});

describe('what is not known (05 §1 rules 3 and 5; PRO-005)', () => {
  const ready = () => {
    const x = session();
    x.s.receive(welcome(x.hello.id), 1);
    x.s.take();
    return x.s;
  };

  it('ignores an unknown type without an id and sends nothing', () => {
    const s = ready();
    expect(s.receive('{"t":"future.thing","d":{"a":1}}', 2)).toEqual([]);
    expect(s.take()).toEqual([]);
    expect(s.phase).toBe('ready');
  });

  it('answers an unknown type with an id: unknown_type, fatal false, re set', () => {
    const s = ready();
    expect(s.receive('{"t":"future.thing","id":"77"}', 2)).toEqual([]);
    expect(s.take().map((f) => JSON.parse(f))).toEqual([
      {
        t: 'error',
        re: '77',
        d: {
          code: 'unknown_type',
          message: 'unknown message type future.thing',
          retryable: false,
          fatal: false,
        },
      },
    ]);
  });

  it('treats an x- type that was not negotiated like any unknown type', () => {
    const s = ready();
    expect(s.receive('{"t":"x-trial.ping","id":"5","d":{}}', 2)).toEqual([]);
    expect(JSON.parse(s.take()[0]!)).toMatchObject({
      t: 'error',
      re: '5',
      d: { code: 'unknown_type' },
    });
  });

  it('passes on a known message with members it does not know, unchanged', () => {
    const s = ready();
    const frame = { t: 'auth.expiring', future: 1, d: { inMs: 5, later: { x: [1] } } };
    expect(s.receive(JSON.stringify(frame), 2)).toEqual([{ kind: 'message', message: frame }]);
  });

  it('answers an invalid payload with a non-fatal bad_message, and closes on an unreadable frame (D03)', () => {
    const s = ready();
    expect(s.receive('{"t":"sync.ack","id":"9","ch":1,"d":{}}', 2)).toEqual([]);
    expect(JSON.parse(s.take()[0]!)).toMatchObject({
      t: 'error',
      re: '9',
      d: { code: 'bad_message', fatal: false },
    });
    expect(s.receive('[1]', 3)).toEqual([
      { kind: 'fatal', close: 4400, reason: 'the frame is not a JSON object' },
    ]);
  });

  it('never throws and never sends an invalid frame, whatever arrives', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string(),
            fc.jsonValue().map((v) => JSON.stringify(v)),
            fc.jsonValue().map((d) => JSON.stringify({ t: 'sync.commit', ch: 1, d })),
            fc.constantFrom('{"t":"ping","id":"1"}', '{"t":"x-y","id":"2"}', '{"t":"pong"}'),
          ),
          { maxLength: 20 },
        ),
        (frames) => {
          const s = ready();
          let now = 2;
          for (const f of frames) {
            s.receive(f, now++);
            for (const out of s.take()) expect(codec.check(JSON.parse(out), 'server')).toEqual([]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('heartbeat and chunks (05 §4)', () => {
  it('answers ping with pong, carrying re when the ping had an id', () => {
    const { s, hello } = session();
    s.receive(welcome(hello.id), 1);
    s.take();
    s.receive('{"t":"ping","id":"p1"}', 2);
    s.receive('{"t":"ping"}', 3);
    expect(s.take().map((f) => JSON.parse(f))).toEqual([{ t: 'pong', re: 'p1' }, { t: 'pong' }]);
  });

  it('pings after heartbeatMs without sending and is dead after two silent intervals', () => {
    const { s, hello } = session();
    expect(s.deadline()).toBe(2 * DEFAULT_HEARTBEAT_MS);
    s.receive(welcome(hello.id), 100);
    s.take();
    expect(s.deadline()).toBe(1000);
    expect(s.tick(999)).toBe('ok');
    expect(s.take()).toEqual([]);
    expect(s.tick(1000)).toBe('ok');
    expect(s.take().map((f) => JSON.parse(f))).toEqual([{ t: 'ping' }]);
    expect(s.tick(2099)).toBe('ok');
    expect(s.tick(2100)).toBe('dead');
  });

  it('reassembles chunks and passes the message on; a broken run is counted and dropped', () => {
    const { s, hello } = session();
    s.receive(welcome(hello.id), 1);
    const message = {
      t: 'event',
      ch: 1,
      d: { type: 'document.updated', resource: `/documents/${'x'.repeat(400)}` },
    };
    const frames = chunkMessage(JSON.stringify(message), 150, 'c1');
    let out: SessionInput[] = [];
    for (const f of frames) out = [...out, ...s.receive(f, 2)];
    expect(out).toEqual([{ kind: 'message', message }]);
    s.receive(frames[1]!, 3);
    expect(s.faults.chunks).toBe(1);
  });

  it('chunks an outgoing message above maxMessageBytes', () => {
    const { s, hello } = session();
    s.receive(welcome(hello.id, { limits: { ...LIMITS, maxMessageBytes: 200 } }), 1);
    s.take();
    s.send(
      {
        t: 'sync.submit',
        id: 'x',
        ch: 1,
        d: {
          id: '0192f0c4-0000-7000-8000-0000000000aa',
          base: 0,
          steps: [
            {
              stepType: 'replace',
              from: 1,
              to: 1,
              slice: { content: [{ type: 'text', text: 'y'.repeat(500) }] },
            },
          ],
        },
      },
      2,
    );
    const frames = s.take();
    expect(frames.length).toBeGreaterThan(2);
    for (const f of frames) expect(JSON.parse(f).t).toBe('chunk');
    expect(frames.map((f) => JSON.parse(f).d.part).join('')).toContain('"t":"sync.submit"');
  });
});
