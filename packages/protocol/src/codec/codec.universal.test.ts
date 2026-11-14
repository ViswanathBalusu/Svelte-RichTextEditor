// The text-frame codec, chunking and binary frames (05 §4; PRO-004, PRO-017, PRO-018, PRO-020
// groundwork for S6). Universal: runs in Node.js and in browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBinaryFrame, encodeBinaryFrame } from './binary.ts';
import { Reassembler, chunkMessage } from './chunk.ts';
import { depCodec, utf8Length } from './frame.ts';

const codec = depCodec();
const DOC = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const INC = '0192aa00-0000-7000-8000-000000000001';
const SESSION = '0192f4b0-0000-7000-8000-000000000002';
const REGION = 'region:rG7mK2pQ9xYt4HcD';
const T = '2026-09-18T10:42:00.000Z';
const LIMITS = {
  maxMessageBytes: 131072,
  maxCommitBytes: 1048576,
  maxStepsPerCommit: 500,
  maxRebaseSteps: 5000,
  maxChannels: 16,
  heartbeatMs: 25000,
  ackTimeoutMs: 15000,
  presenceHz: 10,
  presenceBytes: 1024,
  catchUpCommits: 5000,
  catchUpBytes: 5242880,
};
const access = (rev: number, asOfSeq: number, region: string[]) => ({
  rev,
  asOfSeq,
  docRole: 'viewer',
  caps: ['view'],
  scopes: { body: ['view'], defs: ['view'], [REGION]: region },
  leases: {},
  fill: null,
  restrictions: [],
});
const commit = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq,
  kind: 'steps',
  id: `0192f0c4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
  steps: [
    { stepType: 'replace', from: 10, to: 10, slice: { content: [{ type: 'text', text: 'x' }] } },
  ],
  control: null,
  author: { user: 'u_112', session: SESSION, agent: null },
  serverTime: T,
  origin: 'input',
  ...extra,
});

/** The conversation of 05 §5.9, completed with the members the example leaves out (G53). */
const CONVERSATION: Array<['C' | 'S', Record<string, unknown>]> = [
  [
    'C',
    {
      t: 'hello',
      id: '1',
      d: {
        versions: ['1.0'],
        token: 'eyJhbGciOiJFUzI1NiJ9.e30.sig',
        client: { name: 'doc-editor', version: '0.1.0' },
        engines: ['pm-steps/1'],
        cdm: { min: 1, max: 1 },
        features: ['presence', 'fields'],
      },
    },
  ],
  [
    'S',
    {
      t: 'welcome',
      re: '1',
      d: {
        version: '1.0',
        session: SESSION,
        user: { id: 'u_481', name: 'Ada' },
        features: ['presence'],
        limits: LIMITS,
        tokenExp: T,
      },
    },
  ],
  [
    'C',
    {
      t: 'ch.open',
      id: '2',
      ch: 1,
      d: {
        kind: 'doc',
        doc: DOC,
        engine: 'pm-steps/1',
        cdm: 1,
        features: [],
        resume: { seq: 412, incarnation: INC },
      },
    },
  ],
  [
    'S',
    {
      t: 'ch.opened',
      re: '2',
      ch: 1,
      d: {
        head: 415,
        incarnation: INC,
        catchUp: 'stream',
        access: access(30, 415, ['view', 'comment', 'suggest', 'edit']),
      },
    },
  ],
  ['S', { t: 'sync.commit', ch: 1, d: { commits: [commit(413), commit(414), commit(415)] } }],
  ['S', { t: 'sync.caughtUp', ch: 1, d: { seq: 415 } }],
  [
    'C',
    {
      t: 'sync.submit',
      id: '3',
      ch: 1,
      d: {
        id: '0192f0c4-0000-7000-8000-0000000000aa',
        base: 415,
        steps: [
          {
            stepType: 'replace',
            from: 20,
            to: 20,
            slice: { content: [{ type: 'text', text: 'y' }] },
          },
        ],
        origin: 'input',
      },
    },
  ],
  [
    'S',
    {
      t: 'sync.ack',
      re: '3',
      ch: 1,
      d: { id: '0192f0c4-0000-7000-8000-0000000000aa', seq: 416, serverTime: T, rebased: false },
    },
  ],
  [
    'S',
    {
      t: 'sync.commit',
      ch: 1,
      d: {
        commits: [
          commit(417, {
            kind: 'control',
            steps: [],
            control: { type: 'grants', rev: 9 },
            author: { user: 'system', session: null, agent: null },
            origin: 'control',
          }),
        ],
      },
    },
  ],
  ['S', { t: 'perm.changed', ch: 1, d: access(31, 417, ['view']) }],
  [
    'C',
    {
      t: 'sync.submit',
      id: '4',
      ch: 1,
      d: {
        id: '0192f0c5-0000-7000-8000-0000000000bb',
        base: 416,
        steps: [
          {
            stepType: 'replace',
            from: 30,
            to: 30,
            slice: { content: [{ type: 'text', text: 'z' }] },
          },
        ],
      },
    },
  ],
  [
    'S',
    {
      t: 'sync.reject',
      re: '4',
      ch: 1,
      d: {
        id: '0192f0c5-0000-7000-8000-0000000000bb',
        code: 'permission_denied',
        action: 'drop',
        head: 417,
        scopes: [REGION],
        message: 'No edit permission',
      },
    },
  ],
  [
    'S',
    {
      t: 'event',
      ch: 1,
      d: { type: 'export.completed', resource: '/exports/0192f1aa-0000-7000-8000-000000000003' },
    },
  ],
];

describe('decoding and encoding frames', () => {
  it('decodes the conversation of 05 §5.9 in order, each frame by its receiver', () => {
    for (const [from, frame] of CONVERSATION) {
      const r = codec.decode(JSON.stringify(frame), {
        receiver: from === 'C' ? 'server' : 'client',
      });
      expect(r.kind, `${frame['t']}: ${JSON.stringify(r)}`).toBe('message');
    }
  });

  it('round-trips every frame of the conversation: decode(encode(x)) equals x', () => {
    for (const [from, frame] of CONVERSATION) {
      const text = codec.encode(frame);
      const r = codec.decode(text, { receiver: from === 'C' ? 'server' : 'client' });
      expect(r.kind === 'message' && r.message).toEqual(frame);
      expect(Object.keys(JSON.parse(text) as object)[0]).toBe('t');
    }
  });

  it('shows G53: the example frames as printed omit members the tables require', () => {
    const printedWelcome = {
      t: 'welcome',
      re: '1',
      d: {
        version: '1.0',
        session: SESSION,
        limits: { maxMessageBytes: 131072, heartbeatMs: 25000, ackTimeoutMs: 15000 },
        tokenExp: T,
      },
    };
    const r1 = codec.decode(JSON.stringify(printedWelcome), { receiver: 'client' });
    expect(r1.kind).toBe('invalid');
    if (r1.kind === 'invalid')
      expect(r1.violations.map((v) => v.path)).toEqual(
        expect.arrayContaining(['/d/user', '/d/features', '/d/limits/maxCommitBytes']),
      );
    const printedOpen = {
      t: 'ch.open',
      id: '2',
      ch: 1,
      d: {
        kind: 'doc',
        doc: DOC,
        engine: 'pm-steps/1',
        cdm: 1,
        resume: { seq: 412, incarnation: INC },
      },
    };
    const r2 = codec.decode(JSON.stringify(printedOpen), { receiver: 'server' });
    expect(r2.kind === 'invalid' && r2.violations.map((v) => v.path)).toEqual(['/d/features']);
  });

  it('closes with 4400 on a frame that is not JSON, not an object, lacks t, or has mistyped envelope members', () => {
    for (const text of [
      '{not json',
      '[1,2]',
      '"text"',
      '{}',
      '{"t":""}',
      '{"t":1}',
      '{"t":"ping","ch":-1}',
      '{"t":"ping","ch":1.5}',
      '{"t":"ping","id":7}',
      '{"t":"ping","d":[]}',
    ]) {
      const r = codec.decode(text, { receiver: 'server' });
      expect(r.kind, text).toBe('invalid');
      if (r.kind === 'invalid') {
        expect(r.fatal, text).toBe(true);
        expect(r.close, text).toBe(4400);
        expect(r.code).toBe('bad_message');
      }
    }
  });

  it('ignores an unknown type, and answers unknown_type, fatal false, when it carries an id (05 §1 rule 3)', () => {
    const silent = codec.decode('{"t":"x-future","d":{"a":1}}', { receiver: 'server' });
    expect(silent).toEqual({ kind: 'unknown', t: 'x-future' });
    const answered = codec.decode('{"t":"x-future","id":"9"}', { receiver: 'server' });
    expect(answered).toEqual({
      kind: 'unknown',
      t: 'x-future',
      reply: {
        t: 'error',
        re: '9',
        d: {
          code: 'unknown_type',
          message: 'unknown message type x-future',
          retryable: false,
          fatal: false,
        },
      },
    });
  });

  it('answers a known type with an invalid payload or the wrong direction with a non-fatal bad_message (D03)', () => {
    const bad = codec.decode(
      '{"t":"sync.submit","id":"5","ch":1,"d":{"id":"x","base":0,"steps":[]}}',
      { receiver: 'server' },
    );
    expect(bad.kind).toBe('invalid');
    if (bad.kind === 'invalid') {
      expect(bad.fatal).toBe(false);
      expect(bad.reply).toMatchObject({
        t: 'error',
        re: '5',
        d: { code: 'bad_message', fatal: false },
      });
      expect(bad.violations.map((v) => v.path)).toEqual(
        expect.arrayContaining(['/d/id', '/d/steps']),
      );
    }
    const wrong = codec.decode(JSON.stringify(CONVERSATION[1]![1]), { receiver: 'server' });
    expect(wrong.kind === 'invalid' && wrong.fatal).toBe(false);
  });

  it('ignores unknown members (05 §1 rule 3)', () => {
    const frame = {
      ...CONVERSATION[7]![1],
      x_new: true,
      d: { ...(CONVERSATION[7]![1]['d'] as object), futureMember: [1] },
    };
    expect(codec.decode(JSON.stringify(frame), { receiver: 'client' }).kind).toBe('message');
  });

  it('refuses a frame above maxMessageBytes with 4413', () => {
    const text = JSON.stringify({ t: 'ping', d: { pad: 'x'.repeat(200) } });
    const r = codec.decode(text, { receiver: 'server', maxMessageBytes: 100 });
    expect(r.kind === 'invalid' && [r.code, r.close]).toEqual(['too_large', 4413]);
  });

  it('never throws, whatever the input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.jsonValue().map((v) => JSON.stringify({ t: 'sync.submit', id: 'q', ch: 1, d: v })),
        ),
        (text) => {
          const r = codec.decode(text, { receiver: 'server' });
          expect(['message', 'unknown', 'invalid']).toContain(r.kind);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses to encode an invalid message unless asked to', () => {
    expect(() => codec.encode({ t: 'sync.ack', ch: 1, d: {} })).toThrow(/invalid sync.ack/);
    expect(codec.encode({ t: 'sync.ack', ch: 1, d: {} }, { validate: false })).toBe(
      '{"t":"sync.ack","ch":1,"d":{}}',
    );
  });
});

describe('chunking (05 §4; D04)', () => {
  const text = fc.string({ unit: 'binary', minLength: 1, maxLength: 3000 });

  it('cuts only between code points, keeps every frame within the limit, and reassembles exactly', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 120, max: 2000 }), (s, max) => {
        const serialised = JSON.stringify({ t: 'sync.submit', id: '1', ch: 1, d: { note: s } });
        const frames = chunkMessage(serialised, max, '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10');
        const r = new Reassembler();
        let out: string | null = null;
        frames.forEach((f, i) => {
          expect(utf8Length(f)).toBeLessThanOrEqual(max);
          const decoded = codec.decode(f, { receiver: 'server', maxMessageBytes: max });
          expect(decoded.kind, f).toBe('message');
          const d = JSON.parse(f).d as { of: string; i: number; n: number; part: string };
          expect(d.i).toBe(i);
          // No part ends with a high surrogate that the next part's low surrogate completes.
          const last = d.part.charCodeAt(d.part.length - 1);
          const next = frames[i + 1]
            ? (JSON.parse(frames[i + 1]!).d.part as string).charCodeAt(0)
            : NaN;
          expect(last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff).toBe(false);
          const step = r.push(d, 0);
          if (step.status === 'complete') out = step.text;
          else expect(step.status).toBe('partial');
        });
        expect(out).toBe(serialised);
      }),
      { numRuns: 200 },
    );
  });

  it('abandons a reassembly after 10 seconds and refuses chunks out of order or interleaved', () => {
    const frames = chunkMessage(
      JSON.stringify({ t: 'ping', d: { pad: 'y'.repeat(400) } }),
      150,
      'a',
    ).map((f) => JSON.parse(f).d);
    const r = new Reassembler();
    expect(r.push(frames[0], 0).status).toBe('partial');
    expect(r.expire(10_000)).toBe('a');
    expect(r.push(frames[1], 10_001).status).toBe('error');
    expect(r.push(frames[0], 20_000).status).toBe('partial');
    expect(r.push({ ...frames[1], of: 'b' }, 20_001).status).toBe('error');
    expect(r.push(frames[0], 30_000).status).toBe('partial');
    expect(r.push(frames[2], 30_001).status).toBe('error');
  });
});

describe('binary frames (05 §4; PRO-020)', () => {
  it('encodes ch, kind and id as unsigned LEB128 before the payload', () => {
    expect([
      ...encodeBinaryFrame({ ch: 127, kind: 128, id: 16384, payload: new Uint8Array([9]) }),
    ]).toEqual([0x7f, 0x80, 0x01, 0x80, 0x80, 0x01, 9]);
  });

  it('round-trips empty and large payloads, and refuses truncated headers', () => {
    for (const size of [0, 131072]) {
      const payload = new Uint8Array(size).map((_, i) => i % 251);
      const back = decodeBinaryFrame(encodeBinaryFrame({ ch: 3, kind: 1, id: 2 ** 40, payload }));
      expect(back?.ch).toBe(3);
      expect(back?.id).toBe(2 ** 40);
      expect(back?.payload).toEqual(payload);
    }
    expect(decodeBinaryFrame(new Uint8Array([0x80]))).toBeNull();
    expect(decodeBinaryFrame(new Uint8Array([1, 2]))).toBeNull();
  });
});
