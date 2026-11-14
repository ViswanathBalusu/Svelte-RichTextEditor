/**
 * SEC-047 — the operator's logs, metrics and traces never hold document content or tokens
 * (10 §3.7; 06 §11; BE-088). The harness captures every structured log line the service writes; a
 * scenario seeds canary strings into every surface that exists in phase 1a, and none appears.
 *
 * The structural dump (BE-089) and stored compile logs (SEC-047 criteria 4–5) arrive in phase 2
 * and are noted in the story.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
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

const CANARY = {
  title: 'CANARY_TITLE_5f3a9c',
  body: 'CANARY_BODY_7b1e40',
  commit: 'CANARY_COMMIT_9d22af',
  query: 'CANARY_QUERY_1c0ffee',
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-047 logs and metrics hold no content or tokens (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()('no canary in content, titles, tokens or query values reaches any log line', async () => {
      // A document whose title and body carry canary strings.
      const content = documentWithRegions() as {
        doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
      };
      content.doc.content[1]!.content[0]!.content = [{ type: 'text', text: CANARY.body }];
      const created = await h.call('POST', '/v1/documents', {
        token: h.a.apiKey,
        body: { title: CANARY.title, content, externalId: CANARY.query },
      });
      expect(created.status).toBe(201);
      const doc = created.json.id as string;

      // A list request whose query value is a canary (it must be redacted in the access log).
      await h.call('GET', `/v1/documents?externalId=${CANARY.query}`, { token: h.a.apiKey });

      // A token (a secret) and a commit carrying a canary.
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      const pos = posInside(
        (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json.doc,
        'pIntro0000000001',
      );
      expect(
        (await c.submit(1, { id: uuid7(), base: 0, steps: [insertText(pos, CANARY.commit)] })).t,
      ).toBe('sync.ack');
      c.terminate();

      const blob = h.logs.join('\n');
      expect(blob.length, 'the service did log something').toBeGreaterThan(0);
      for (const [name, value] of Object.entries(CANARY))
        expect(blob, `canary ${name} must not appear in logs`).not.toContain(value);
      expect(blob, 'the token must not appear in logs').not.toContain(token);
    });

    t()(
      'a validation error is logged by code and position, never by the offending text',
      async () => {
        const before = h.logs.length;
        // Invalid CDM that embeds a canary string; the content is rejected.
        const bad = {
          cdm: 1,
          requires: [],
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'x' },
                content: [{ type: 'text', text: CANARY.body }],
              },
            ],
          },
        };
        const r = await h.call('POST', '/v1/documents', {
          token: h.a.apiKey,
          body: { content: bad },
        });
        expect([400, 422]).toContain(r.status);
        const added = h.logs.slice(before).join('\n');
        // The request was logged with its code, but the offending text is not in the log.
        expect(added).toContain('validation_failed');
        expect(added).not.toContain(CANARY.body);
      },
    );

    t()('an Authorization header and query values are redacted in the access log', async () => {
      const before = h.logs.length;
      await h.call('GET', `/v1/documents?externalId=${CANARY.query}`, { token: h.a.apiKey });
      const added = h.logs.slice(before).join('\n');
      // The path was logged, but the query value is redacted and the bearer token never logged.
      expect(added).toContain('/v1/documents');
      expect(added).toContain('[redacted]');
      expect(added).not.toContain(CANARY.query);
      expect(added).not.toContain(h.a.apiKey);
    });
  });
}
