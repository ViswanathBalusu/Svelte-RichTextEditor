/**
 * SEC-017 criterion: chunk sequences with a huge `n`, missing parts, repeated indexes, interleaved
 * identifiers or no completion keep memory bounded, and a reassembly is dropped after 10 seconds
 * (05 §4; 10 §3.2, §5).
 *
 * Two layers are checked:
 *  - the protocol Reassembler (`@docedit/protocol`), which the server session uses, against an
 *    independent model of the rules in 05 §4, over generated adversarial chunk streams. The model
 *    holds at most one reassembly, so the reassembler never holds more than one message at a time;
 *  - the real document service over the wire: a reassembly with no completion is cut off once the
 *    cumulative chunk bytes pass maxReassembledBytes (close 4413), and a reassembly left open for
 *    more than 10 seconds is dropped, so the next chunk is refused (close 4400).
 *
 * Memory is bounded in the sense of the criterion: one message at a time per connection, and the
 * bytes of one chunked message are capped at maxReassembledBytes (session.ts #chunk). The wire test
 * does not measure heap use; it proves the cap by its refusal.
 */
import fc from 'fast-check';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { Reassembler, type ChunkPayload } from '@docedit/protocol';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Layer 1: the reassembler against a model of 05 §4 (in process)
// ---------------------------------------------------------------------------------------------

interface ModelState {
  of: string;
  n: number;
  next: number;
  parts: string[];
  startedAt: number;
}

type Status = 'partial' | 'complete' | 'error';

/** The rules of 05 §4, written again so that the reassembler is checked against them. */
function modelPush(
  state: ModelState | null,
  chunk: ChunkPayload,
  now: number,
): { state: ModelState | null; status: Status; text?: string } {
  let cur = state;
  // A reassembly older than the timeout is abandoned before the chunk is considered.
  if (cur && now - cur.startedAt >= TIMEOUT_MS) cur = null;
  if (!cur) {
    if (chunk.i !== 0) return { state: null, status: 'error' };
    cur = { of: chunk.of, n: chunk.n, next: 0, parts: [], startedAt: now };
  }
  if (chunk.of !== cur.of) return { state: null, status: 'error' };
  if (chunk.n !== cur.n || chunk.i !== cur.next) return { state: null, status: 'error' };
  cur.parts.push(chunk.part);
  cur.next++;
  if (cur.next < cur.n) return { state: cur, status: 'partial' };
  return { state: null, status: 'complete', text: cur.parts.join('') };
}

interface Step {
  chunk: ChunkPayload;
  gapMs: number;
}

const chunkArb: fc.Arbitrary<ChunkPayload> = fc.record({
  of: fc.constantFrom('a', 'b', 'c'),
  // Mostly small indexes, so that repeated and out-of-order indexes are common.
  i: fc.oneof(fc.integer({ min: 0, max: 4 }), fc.constant(0), fc.constant(1)),
  // Small counts that complete, and a huge count that never can within a run.
  n: fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant(2 ** 30)),
  part: fc.string({ maxLength: 4 }),
});

const stepArb: fc.Arbitrary<Step> = fc.record({
  chunk: chunkArb,
  // Gaps below and above the 10-second timeout, so that "no completion" is exercised.
  gapMs: fc.oneof(fc.integer({ min: 0, max: 9_999 }), fc.integer({ min: TIMEOUT_MS, max: 30_000 })),
});

describe('SEC-017 chunk reassembly stays bounded (05 §4), in process', () => {
  it('matches the model of 05 §4 on adversarial chunk streams, one message at a time', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const r = new Reassembler({ timeoutMs: TIMEOUT_MS });
        let model: ModelState | null = null;
        let now = 0;
        for (const s of steps) {
          now += s.gapMs;
          const expected = modelPush(model, s.chunk, now);
          const got = r.push(s.chunk, now);
          expect(got.status).toBe(expected.status);
          if (expected.status === 'complete')
            expect(got).toEqual({ status: 'complete', text: expected.text });
          model = expected.state;
          // The reassembler holds at most one message: its pending flag mirrors the model.
          expect(r.pending).toBe(model !== null);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('drops a reassembly with no completion after 10 seconds, and refuses its later chunks', () => {
    const r = new Reassembler({ timeoutMs: TIMEOUT_MS });
    expect(r.push({ of: 'big', i: 0, n: 2 ** 30, part: 'x' }, 0).status).toBe('partial');
    expect(r.push({ of: 'big', i: 1, n: 2 ** 30, part: 'x' }, 9_999).status).toBe('partial');
    // At 10 seconds the reassembly is gone: the next chunk has no start and is refused.
    expect(r.push({ of: 'big', i: 2, n: 2 ** 30, part: 'x' }, 10_000).status).toBe('error');
    expect(r.pending).toBe(false);
  });

  it('a huge declared count never holds more than one message, whatever the identifiers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('p', 'q', 'r', 's'), { minLength: 1, maxLength: 40 }),
        (ids) => {
          const r = new Reassembler({ timeoutMs: TIMEOUT_MS });
          for (const [k, of] of ids.entries()) {
            const wasPending = r.pending;
            const res = r.push({ of, i: 0, n: 2 ** 30, part: 'x' }, k);
            if (wasPending) {
              // A start while another message is pending is refused, and that message is dropped.
              expect(res.status).toBe('error');
              expect(r.pending).toBe(false);
            } else {
              expect(res.status).toBe('partial');
              expect(r.pending).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 2: the real document service over the wire (memory storage)
// ---------------------------------------------------------------------------------------------

describe('SEC-017 chunk reassembly over the wire (memory)', () => {
  let h: Harness;
  let doc: string;
  beforeAll(async () => {
    h = await startHarness('memory');
    doc = await h.createDocument(h.a, documentWithRegions());
  });
  afterAll(async () => {
    await h?.close();
  });

  const editor = async () => {
    const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    await c.hello(token);
    return c;
  };

  it('cuts off a reassembly whose cumulative bytes pass maxReassembledBytes with 4413', async () => {
    const c = await editor();
    try {
      // 12 parts of 100,000 characters: about 1.2 MB, above the 1 MiB commit limit plus 64 KiB.
      const part = 'x'.repeat(100_000);
      for (let i = 0; i < 12; i++) c.send({ t: 'chunk', d: { of: 'flood', i, n: 2 ** 30, part } });
      expect((await c.closed).code).toBe(4413);
    } finally {
      c.terminate();
    }
  }, 30_000);

  it('drops a reassembly open for more than 10 seconds, and a chunk within the window is accepted', async () => {
    const early = await editor();
    const late = await editor();
    try {
      // Within the window the reassembly is alive: the second chunk is accepted (no close).
      early.send({ t: 'chunk', d: { of: 'slow', i: 0, n: 2 ** 30, part: 'x' } });
      early.send({ t: 'chunk', d: { of: 'slow', i: 1, n: 2 ** 30, part: 'x' } });
      await new Promise((r) => setTimeout(r, 200));
      expect(early.closeInfo).toBeNull();

      // Past 10 seconds the reassembly is dropped, so a continuation has no start: refused.
      late.send({ t: 'chunk', d: { of: 'stale', i: 0, n: 2 ** 30, part: 'x' } });
      await new Promise((r) => setTimeout(r, TIMEOUT_MS + 300));
      late.send({ t: 'chunk', d: { of: 'stale', i: 1, n: 2 ** 30, part: 'x' } });
      expect((await late.closed).code).toBe(4400);
    } finally {
      early.terminate();
      late.terminate();
    }
  }, 40_000);
});
