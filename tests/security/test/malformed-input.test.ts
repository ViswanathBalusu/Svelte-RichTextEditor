/**
 * SEC-017 — no frame, chunk or body can crash or exhaust the gateway (10 §3.2, §5; 05 §4). The
 * adversarial client sends oversized frames, malformed chunk sequences, broken JSON and oversized
 * commits and bodies; each is refused with a close code or an error, and the service keeps serving.
 *
 * The 10-second reassembly timeout (05 §4) and the envelope-parser fuzz target (SEC-059) prove the
 * bounded-memory and no-hang claims; this file proves the per-message refusals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';
import { chunkMessage } from '@docedit/protocol';
import { uuid7 } from '@docedit/model';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-017 malformed and oversized input is refused (${storage})`, () => {
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

    /** A welcomed editor client on the document. */
    const editor = async () => {
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      return c;
    };

    t()('closes a frame above maxMessageBytes that is not chunked with 4413', async () => {
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        // Above maxMessageBytes (131072) and below maxFrameBytes, so the session, not ws, refuses it.
        c.sendRaw(JSON.stringify({ t: 'hello', d: { pad: 'x'.repeat(200_000) } }));
        expect((await c.closed).code).toBe(4413);
      } finally {
        c.terminate();
      }
    });

    t()('refuses malformed chunk sequences without crashing', async () => {
      // Each case is fatal to its own connection (4400/4413); a bystander stays up throughout.
      const bystander = await editor();
      try {
        const cases: Array<{ what: string; chunk: Record<string, unknown>; close: number }> = [
          {
            what: 'a chunk that is not the start',
            chunk: { of: 'a', i: 5, n: 9, part: 'x' },
            close: 4400,
          },
          {
            what: 'a repeated index',
            chunk: { of: 'a', i: 0, n: 1_000_000, part: 'x' },
            close: 4400,
          },
        ];
        // First: a non-zero first index.
        {
          const c = await editor();
          c.send({ t: 'chunk', d: cases[0]!.chunk });
          expect((await c.closed).code, cases[0]!.what).toBe(4400);
          c.terminate();
        }
        // A huge declared count with a valid first chunk stays pending (bounded), no crash.
        {
          const c = await editor();
          c.send({ t: 'chunk', d: { of: 'big', i: 0, n: 2 ** 30, part: 'x' } });
          // No completion arrives; the connection is still open and the server is unharmed.
          await new Promise((r) => setTimeout(r, 50));
          expect(c.closeInfo).toBeNull();
          c.terminate();
        }
        // Interleaved identifiers: a second chunk with a different `of`.
        {
          const c = await editor();
          c.send({ t: 'chunk', d: { of: 'one', i: 0, n: 3, part: 'x' } });
          c.send({ t: 'chunk', d: { of: 'two', i: 1, n: 3, part: 'y' } });
          expect((await c.closed).code).toBe(4400);
          c.terminate();
        }
        // The bystander still works.
        expect((await bystander.open(1, doc)).t).toBe('ch.opened');
      } finally {
        bystander.terminate();
      }
    });

    t()(
      'answers malformed JSON, broken envelopes and deep nesting with 4400, and keeps serving',
      async () => {
        const frames: Array<string> = [
          'not json at all',
          '{"t":123}', // t is not a string
          '[]', // not an object
          `{"t":"hello","d":${'['.repeat(20_000)}`, // deeply nested / unterminated
          '{"t":"","d":{}}', // empty type
        ];
        for (const raw of frames) {
          const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          try {
            c.sendRaw(raw);
            expect((await c.closed).code, raw.slice(0, 20)).toBe(4400);
          } finally {
            c.terminate();
          }
        }
        // Invalid UTF-8 bytes in a binary frame: pm-steps/1 uses no binary frames.
        const bin = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          bin.sendRaw(Buffer.from([0xff, 0xfe, 0x00]), true);
          expect((await bin.closed).code).toBe(4400);
        } finally {
          bin.terminate();
        }
        // The service is unharmed: a fresh client connects and is welcomed.
        const ok = await editor();
        expect((await ok.open(1, doc)).t).toBe('ch.opened');
        ok.terminate();
      },
    );

    t()(
      'answers an unknown message type carrying an id with error unknown_type, fatal false',
      async () => {
        const c = await editor();
        try {
          c.send({ t: 'x-made-up', id: 'q1', d: {} });
          const err = await c.take(
            (m) => m.t === 'error' && m.re === 'q1',
            3000,
            'the unknown_type error',
          );
          expect(err.d?.['code']).toBe('unknown_type');
          expect(err.d?.['fatal']).toBe(false);
          // The connection is still open.
          expect(c.closeInfo).toBeNull();
        } finally {
          c.terminate();
        }
      },
    );

    t()('rejects a commit above maxStepsPerCommit or maxCommitBytes with too_large', async () => {
      const c = await editor();
      try {
        await c.open(1, doc);
        const tooMany = await c.submit(1, {
          id: uuid7(),
          base: 0,
          steps: Array.from({ length: 501 }, () => ({ stepType: 'replace', from: 1, to: 1 })),
        });
        expect(tooMany.t).toBe('sync.reject');
        expect(tooMany.d?.['code']).toBe('too_large');

        // A commit above maxCommitBytes (1 MiB) does not fit one frame (maxMessageBytes), so it is
        // sent as chunks; the room rejects the reassembled commit with too_large.
        const id = c.nextId();
        const envelope = {
          t: 'sync.submit',
          id,
          ch: 1,
          d: { id: uuid7(), base: 0, steps: [insertText(1, 'x'.repeat(1_055_000))] },
        };
        for (const frame of chunkMessage(JSON.stringify(envelope), 131_072, uuid7()))
          c.sendRaw(frame);
        const huge = await c.take(
          (m) => m.re === id,
          5000,
          'answer to the chunked oversized commit',
        );
        expect(huge.t).toBe('sync.reject');
        expect(huge.d?.['code']).toBe('too_large');

        // A normal edit afterwards still succeeds: the room was not harmed.
        const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
          .json;
        const ok = await c.submit(1, {
          id: uuid7(),
          base: 0,
          steps: [insertText(posInside(content.doc, 'pIntro0000000001'), 'Z')],
        });
        expect(ok.t).toBe('sync.ack');
      } finally {
        c.terminate();
      }
    });

    t()('answers a REST body above its limit with too_large (413)', async () => {
      const r = await h.call('POST', '/v1/tokens', {
        token: h.a.apiKey,
        raw: JSON.stringify({ sub: 'x', docs: {}, pad: 'y'.repeat(1_200_000) }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(r.status).toBe(413);
      expect(r.json?.code).toBe('too_large');
    });
  });
}
