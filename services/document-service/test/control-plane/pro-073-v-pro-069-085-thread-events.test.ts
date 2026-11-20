// PRO-073 criterion 1 over HTTP (lane V-PRO-069-085): a thread that is created, resolved, reopened
// and deleted, and a comment that is created, each raise its event through the running thread routes,
// and every body builds with `toCloudEvent` and passes the JSON Schema of spec/dep/webhooks (ajv from
// packages/protocol). Memory storage and PostgreSQL storage (docedit-test-postgres).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCloudEvent } from '../../src/control-plane/webhook-envelope.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const SOURCE = 'https://dep.example.test';
const BODY_BLOCK = 'pEnd000000000001'; // in the body, outside every region

interface AjvLike {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
}
// ajv is a dependency of packages/protocol, not of this service: resolve it there.
const fromProtocol = createRequire(
  new URL('../../../../packages/protocol/package.json', import.meta.url),
);
const AjvCtor = ((fromProtocol('ajv/dist/2020') as { default?: unknown }).default ??
  fromProtocol('ajv/dist/2020')) as new (o: object) => AjvLike;
const addFormatsModule = fromProtocol('ajv-formats') as { default?: unknown };
const addFormats = (addFormatsModule.default ?? addFormatsModule) as (a: AjvLike) => void;

/** The validator of one event type, from its published schema (spec/dep/webhooks/<type>.schema.json). */
function validatorFor(type: string): (data: unknown) => boolean {
  const ajv = new AjvCtor({ strict: false, allErrors: true });
  addFormats(ajv);
  const schemaPath = new URL(`../../../../spec/dep/webhooks/${type}.schema.json`, import.meta.url);
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`thread events of the running routes (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A user token for `sub` with `role` on `doc`; a fresh one each call, as tokens expire. */
    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });

    it.skipIf(skip)(
      'raises thread.created, resolved, reopened, deleted and comment.created, each a valid webhook body (PRO-073 criterion 1)',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'V-PRO-069-085 threads',
        });
        const created = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: as(doc, 'editor', 'ed-1'),
          body: {
            target: { block: BODY_BLOCK },
            comment: { body: [{ type: 'text', text: 'Lane V-PRO-069-085' }] },
          },
        });
        expect(created.status, created.text).toBe(201);
        const url = `/v1/threads/${created.json.id as string}`;

        const resolved = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-2'),
          headers: { 'If-Match': created.headers.get('etag')! },
          body: { state: 'resolved' },
        });
        expect(resolved.status, resolved.text).toBe(200);

        const reopened = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-2'),
          headers: { 'If-Match': resolved.headers.get('etag')! },
          body: { state: 'open' },
        });
        expect(reopened.status, reopened.text).toBe(200);

        const comment = await h.call('POST', `${url}/comments`, {
          token: as(doc, 'editor', 'ed-4'),
          body: { body: [{ type: 'text', text: 'A reply' }] },
        });
        expect(comment.status, comment.text).toBe(201);

        const removed = await h.call('DELETE', url, { token: as(doc, 'owner', 'ow-1') });
        expect(removed.status, removed.text).toBe(204);

        const mine = h.events.events.filter((e) => e.subject === doc);
        expect(mine.map((e) => e.type)).toEqual(
          expect.arrayContaining([
            'dep.thread.created.v1',
            'dep.thread.resolved.v1',
            'dep.thread.reopened.v1',
            'dep.comment.created.v1',
            'dep.thread.deleted.v1',
          ]),
        );
        for (const e of mine) {
          expect(() => toCloudEvent(e, { source: SOURCE }), e.type).not.toThrow();
          const body = JSON.parse(JSON.stringify(toCloudEvent(e, { source: SOURCE }))) as unknown;
          const valid = validatorFor(e.type);
          expect(valid(body), e.type).toBe(true);
        }
      },
    );
  });
}
