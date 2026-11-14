// PRO-012 criterion 1 (lane V-PRO-001-017): a valid API key of a tenant is accepted on every resource
// the protocol marks "service credential only" (05 §6.2): tokens, documents (list and create), content
// replacement, session revocation, fork and webhooks. Over HTTP, in memory and on PostgreSQL. The
// webhook subscriptions use the memory store in both runs (the PostgreSQL store is not in this harness).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const ACCEPTED = [200, 201, 202, 204];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`API key on service-credential routes (${storage}, PRO-012 criterion 1)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        parts: {
          webhooks: new WebhookSubscriptions({
            store: new MemorySubscriptionStore(),
            now: () => Date.now(),
          }),
        },
      });
      // The data plane is a stand-in here: the content is accepted, not stored in a room (BE-037).
      h.stub.replaceContent = async () => ({ seq: 1 });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'accepts a tenant API key on tokens, documents, content, revocation, fork and webhooks',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const seen: Array<[string, number]> = [];
        const check = async (
          method: 'GET' | 'POST' | 'PUT',
          path: string,
          body?: unknown,
          headers?: Record<string, string>,
        ) => {
          const r = await h.call(method, path, {
            token: h.apiKey,
            ...(body === undefined ? {} : { body }),
            ...(headers ? { headers } : {}),
          });
          seen.push([`${method} ${path}`, r.status]);
          expect(ACCEPTED, `${method} ${path} answered ${r.status}`).toContain(r.status);
          return r;
        };

        await check('POST', '/v1/tokens', {
          sub: `user-${randomUUID()}`,
          docs: { [doc]: 'editor' },
        });
        await check('GET', '/v1/documents');
        await check('POST', '/v1/documents', {});
        const etag = (
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
        ).headers.get('etag');
        await check('PUT', `/v1/documents/${doc}/content`, documentWithRegions(), {
          'If-Match': etag ?? '*',
        });
        await check('POST', '/v1/sessions/revoke', { sub: `user-${randomUUID()}` });
        await check('POST', `/v1/documents/${doc}/fork`, { atSeq: 0 });
        await check('POST', '/v1/webhooks', {
          url: 'https://hooks.example.test/pro-012',
          events: ['dep.document.changed.v1'],
        });
        await check('GET', '/v1/webhooks');
        expect(seen).toHaveLength(8);
      },
    );
  });
}
