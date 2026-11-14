// Chunking on the wire, from backend-dep's side (PRO-018; 05 §4, §5.1; D04): a submit whose
// serialised form is above the advertised maxMessageBytes leaves as `chunk` frames. The parts
// concatenate to the serialised submit, each split falls between code points (no part holds a lone
// surrogate), every frame fits the limit, and the chunks of one message are consecutive. The frames
// are read from the memory network; the mock server does not reassemble, so no ack is awaited.
// Node.js only: fast-check and the exact byte count.
//
// The code-point check can fail: measured on 2026-11-13 in Node.js 22 (six runs of this file), 21
// to 31 of the 50 generated submits had an edge where the naive chunker below divides a surrogate
// pair, and with the client's chunker replaced by that naive one (a vi.mock of
// `@docedit/protocol`'s codec/chunk.ts, not kept), the lone-surrogate assertion failed on the
// first run.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { IDS, USERS, contractDocument, insertText, posIn } from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

/** The advertised limit: small, so that a short text is chunked. Every frame must fit it. */
const LIMIT = 1_024;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bytes = (s: string) => new TextEncoder().encode(s).length;

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function rig() {
  const dep = new MockDepServer({
    welcome: (d) => ({
      ...d,
      limits: { ...(d['limits'] as Record<string, unknown>), maxMessageBytes: LIMIT },
    }),
  });
  const net = new MemoryNetwork(dep);
  const docId = dep.service.createDocument(contractDocument(), { grants: [] });
  const make = (): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
  return { net, docId, make };
}

// Random text only, with no fixed prefix, so that every chunk edge falls inside it. At least 800
// code points of one to six bytes each (escapes included) are more than LIMIT, so every submit is
// chunked into several parts. The code points take one, two, three and four UTF-8 bytes, and some
// are escaped by the JSON encoder; the four-byte ones (surrogate pairs in UTF-16) are weighted up
// so that edges often fall next to one. `size: 'max'` lets the length reach maxLength.
const ASTRAL = ['😀', '𝄞', '🀄', '𠀋'];
const body = fc
  .array(fc.constantFrom('a', 'é', '€', ...ASTRAL, '\n', '"', '\\', '\u0001'), {
    size: 'max',
    minLength: 800,
    maxLength: 1_500,
  })
  .map((parts) => parts.join(''));

const HIGH = (c: number) => c >= 0xd800 && c <= 0xdbff;

/**
 * A naive chunker that counts UTF-16 units instead of code points: the mutant the code-point check
 * must catch. Each unit is costed as its share of the UTF-8 bytes (a surrogate counts two), so it
 * cuts between the two halves of a pair when the budget runs out after the high surrogate.
 */
function naiveParts(serialised: string, budget: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let used = 0;
  for (let i = 0; i < serialised.length; i++) {
    const c = serialised.charCodeAt(i);
    const cost = c >= 0xd800 && c <= 0xdfff ? 2 : bytes(serialised[i]!);
    if (used + cost > budget) {
      parts.push(serialised.slice(start, i));
      start = i;
      used = 0;
    }
    used += cost;
  }
  parts.push(serialised.slice(start));
  return parts;
}

describe('a submit above maxMessageBytes is chunked on the wire (PRO-018)', () => {
  it('reassembles to the serialised submit, splits between code points, and keeps every frame within the limit', async () => {
    // Over all runs: edges where the next part starts with a four-byte code point, and runs where
    // the naive chunker above divides a surrogate pair on the same submit. Both must occur, or the
    // lone-surrogate assertion could not fail whatever the chunker did.
    let astralEdges = 0;
    let naiveCaught = 0;
    await fc.assert(
      fc.asyncProperty(body, async (text) => {
        const s = rig();
        const b = s.make();
        try {
          await b.connect();
          const content = await b.sync.loadContent(s.docId);
          const ch = await b.sync.open(s.docId, {
            resume: { seq: content.seq, incarnation: content.incarnation },
          });
          const states: string[] = [];
          ch.onState((st) => states.push(st.status));
          await until(() => states.includes('live'), 'live');

          const from = s.net.frames.length;
          const pending = ch
            .submit({
              id: '0192f0c4-0000-7000-8000-000000000401',
              base: content.seq,
              steps: [insertText(posIn(content.doc, IDS.intro), text)],
            })
            .catch((e: unknown) => e);
          const outgoing = () =>
            s.net.frames
              .slice(from)
              .filter((f) => f.dir === 'c2s')
              .map((f) => f.text);
          const chunks = () =>
            outgoing()
              .map((t) => JSON.parse(t) as { t: string; d: Record<string, unknown> })
              .filter((m) => m.t === 'chunk');
          await until(
            () => chunks().length > 0 && chunks().length >= (chunks()[0]!.d['n'] as number),
            'every chunk',
          );

          const frames = outgoing();
          const parsed = frames.map((t) => JSON.parse(t) as { t: string });
          // The whole submit is never sent as one frame.
          expect(parsed.map((m) => m.t)).not.toContain('sync.submit');
          // Every frame fits maxMessageBytes, envelope included.
          expect(frames.every((t) => bytes(t) <= LIMIT)).toBe(true);

          // The fields of 05 §4: `of` a fresh UUID version 7, `i` from 0, `n` the count.
          const cs = chunks();
          const n = cs[0]!.d['n'] as number;
          expect(cs).toHaveLength(n);
          const of = cs[0]!.d['of'] as string;
          expect(of).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          cs.forEach((c, i) => {
            expect(c.d['of']).toBe(of);
            expect(c.d['i']).toBe(i);
            expect(c.d['n']).toBe(n);
          });
          // The chunks are consecutive on the connection: no other frame between them.
          const first = frames.findIndex((t) => t.includes('"t":"chunk"'));
          expect(frames.slice(first, first + n).every((t) => t.includes('"t":"chunk"'))).toBe(true);

          // Each part is a whole run of code points, and the parts concatenate to the submit.
          const parts = cs.map((c) => c.d['part'] as string);
          expect(parts.some((p) => LONE_SURROGATE.test(p))).toBe(false);
          astralEdges += parts.slice(1).filter((p) => p.length > 0 && HIGH(p.charCodeAt(0))).length;
          // The same check on the naive chunker's parts, with the budget the real one used.
          const budget =
            LIMIT - bytes(JSON.stringify({ t: 'chunk', d: { of, i: n, n, part: '' } }));
          if (naiveParts(parts.join(''), budget).some((p) => LONE_SURROGATE.test(p))) naiveCaught++;
          const submit = JSON.parse(parts.join('')) as {
            t: string;
            d: { steps: Array<{ slice: { content: Array<{ text: string }> } }> };
          };
          expect(submit.t).toBe('sync.submit');
          expect(submit.d.steps[0]!.slice.content[0]!.text).toBe(text);

          await b.close();
          await pending;
        } finally {
          await b.close();
        }
      }),
      { numRuns: 50 },
    );
    expect(astralEdges).toBeGreaterThan(0);
    expect(naiveCaught).toBeGreaterThan(0);
  }, 120_000);
});
