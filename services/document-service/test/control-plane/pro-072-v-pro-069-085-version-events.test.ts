// PRO-072 criterion 3 over HTTP (lane V-PRO-069-085): a named version, a restore, a change of a
// region's state and the change of grants each raise their event through the running routes
// (`dep.version.created`, `dep.version.restored`, `dep.region.state_changed`, `dep.grants.changed`),
// and every body builds with `toCloudEvent` and passes the JSON Schema of its type (ajv from
// packages/protocol). The real data plane stands behind the routes. Memory and PostgreSQL storage.
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
const LEGAL = 'rLegal0000000001'; // in the fixture, hidden from non-owners

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

/** The fixture with its first text run replaced, so that the replacement is a different content. */
function edited(text: string): Record<string, unknown> {
  const env = structuredClone(documentWithRegions()) as Record<string, unknown>;
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (typeof o['text'] === 'string') {
      o['text'] = text;
      return true;
    }
    return Object.values(o).some(walk);
  };
  walk(env['doc']);
  return env;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`version, restore, region and grant events of the running routes (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'raises dep.version.created, dep.version.restored, dep.region.state_changed and dep.grants.changed, each a valid body (PRO-072 criterion 3)',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'V-PRO-069-085 versions',
        });
        const owner = h.userToken({ [doc]: 'owner' });
        const etag = async () =>
          (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).headers.get(
            'etag',
          );
        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: edited('V-PRO-069-085 version'),
          headers: { 'If-Match': (await etag())! },
        });
        expect(put.status).toBe(204);

        const version = await h.call('POST', `/v1/documents/${doc}/versions`, {
          token: h.apiKey,
          body: { seq: 1, name: 'V-PRO-069-085 named' },
        });
        expect(version.status, version.text).toBe(201);

        const restore = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: owner,
          body: { toSeq: 0 },
        });
        expect(restore.status, restore.text).toBe(200);

        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        expect(grants.status).toBe(200);
        const region = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
          token: owner,
          body: { state: 'in_review' },
          headers: { 'If-Match': grants.headers.get('etag')! },
        });
        expect(region.status, region.text).toBe(200);

        const grantsNow = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        const granted = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: owner,
          body: {
            grants: [{ region: LEGAL, principal: 'user:bob', role: 'editor', expiresAt: null }],
          },
          headers: { 'If-Match': grantsNow.headers.get('etag')! },
        });
        expect(granted.status, granted.text).toBe(200);

        const mine = h.events.events.filter((e) => e.subject === doc);
        expect(mine.map((e) => e.type)).toEqual(
          expect.arrayContaining([
            'dep.version.created.v1',
            'dep.version.restored.v1',
            'dep.region.state_changed.v1',
            'dep.grants.changed.v1',
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
