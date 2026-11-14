/**
 * SEC-017 criterion 3 (lane V-SEC-017-032): malformed JSON, wrong types, deeply nested values,
 * duplicate keys and lone surrogates in the envelope each get an answer of 4400 or an `error`, and
 * the process keeps serving (10 §3.2, §5; 05 §4). The adversarial client sends each frame raw over
 * the wire, on a fresh connection, and a bystander connection proves the service is unharmed.
 *
 * Runs over memory and PostgreSQL through the security harness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

/** The outcome of one hostile frame: the connection closed with a code, or an `error` came back. */
type Answer = { kind: 'close'; code: number } | { kind: 'error'; code: unknown } | { kind: 'none' };

async function answerOf(c: WireClient): Promise<Answer> {
  const err: Promise<Answer> = c
    .take((m) => m.t === 'error', 2500, 'an error')
    .then(
      (m) => ({ kind: 'error' as const, code: m.d?.['code'] }),
      () => ({ kind: 'none' as const }),
    );
  const closed: Promise<Answer> = c.closed.then((info) => ({
    kind: 'close' as const,
    code: info.code,
  }));
  return Promise.race([err, closed]);
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection (SEC harness)
  describe(`SEC-017 hostile envelopes get 4400 or an error (${storage})`, () => {
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** A welcomed editor on the document, used as the bystander that must keep working. */
    const bystander = async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      return c;
    };

    const deepArray = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);

    const hostile: Array<{ what: string; raw: string }> = [
      { what: 'malformed JSON (truncated)', raw: '{"t":"hello","d":{"token":"abc"' },
      { what: 'malformed JSON (bare word)', raw: 'not json at all' },
      { what: 'wrong type for t', raw: '{"t":123,"d":{}}' },
      {
        what: 'wrong types inside a known commit',
        raw: JSON.stringify({
          t: 'sync.submit',
          id: 'w1',
          ch: 1,
          d: { id: 5, base: 'zero', steps: 'not-an-array' },
        }),
      },
      {
        what: 'a deeply nested but valid value',
        raw: `{"t":"hello","id":"deep1","d":{"token":"x","pad":${deepArray(5000)}}}`,
      },
      {
        what: 'duplicate keys in the envelope',
        raw: '{"t":"sync.submit","t":"hello","id":"dup1","id":"dup2","ch":1,"d":{}}',
      },
      {
        what: 'a lone high surrogate escape',
        raw: '{"t":"hello","id":"ls1","d":{"token":"\\ud800"}}',
      },
      {
        what: 'a lone low surrogate escape in a commit',
        raw: '{"t":"sync.submit","id":"ls2","ch":1,"d":{"id":"\\udc00","base":0}}',
      },
    ];

    for (const { what, raw } of hostile) {
      t()(`answers ${what} with 4400 or an error, and keeps serving`, async () => {
        const keep = await bystander();
        try {
          const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          try {
            c.sendRaw(raw);
            const answer = await answerOf(c);
            const ok = (answer.kind === 'close' && answer.code === 4400) || answer.kind === 'error';
            expect(ok, `${what}: got ${JSON.stringify(answer)}`).toBe(true);
          } finally {
            c.terminate();
          }
          // The bystander is still welcomed and can open the document.
          expect((await keep.open(1, doc)).t).toBe('ch.opened');
        } finally {
          keep.terminate();
        }
      });
    }
  });
}
