// PRO-069 criteria 1 and 3, PRO-072 criterion 1, over HTTP (lane V-PRO-069-085): every event that the
// running handlers raise for a document's creation, content replacement, state change and deletion
// builds a CloudEvents body that the published schemas accept (`toCloudEvent`, webhook-envelope.ts,
// and the JSON Schema of spec/dep/webhooks validated with the ajv that packages/protocol depends on).
// A content change carries the hash-chain head. Memory storage and PostgreSQL storage
// (docedit-test-postgres, a database of its own that the harness drops afterwards).
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

// ajv and ajv-formats are dependencies of packages/protocol, not of this service: resolve them there.
const fromProtocol = createRequire(
  new URL('../../../../packages/protocol/package.json', import.meta.url),
);
const Ajv2020 = fromProtocol('ajv/dist/2020') as { default?: new (o: object) => AjvLike } & (new (
  o: object,
) => AjvLike);
const addFormats =
  (fromProtocol('ajv-formats') as { default?: (a: AjvLike) => void }).default ??
  (fromProtocol('ajv-formats') as (a: AjvLike) => void);
interface AjvLike {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
}

/** The validator of one event type, from its published schema (spec/dep/webhooks/<type>.schema.json). */
function validatorFor(type: string): (data: unknown) => boolean {
  const Ctor = (Ajv2020 as unknown as { default?: new (o: object) => AjvLike }).default ?? Ajv2020;
  const ajv = new (Ctor as new (o: object) => AjvLike)({ strict: false, allErrors: true });
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
  describe(`webhook bodies of the running handlers (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'every event of a document lifecycle builds a valid body, and a content change carries the chain head (PRO-069 criteria 1 and 3, PRO-072 criterion 1)',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'V-PRO-069-085',
        });
        const contentEtag = async () =>
          (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).headers.get(
            'etag',
          );
        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: edited('V-PRO-069-085 replacement'),
          headers: { 'If-Match': (await contentEtag())! },
        });
        expect(put.status).toBe(204);

        const owner = h.userToken({ [doc]: 'owner' });
        const patch = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: owner,
          body: { title: 'V-PRO-069-085 renamed', state: 'locked' },
          headers: { 'If-Match': '"m1"' },
        });
        expect(patch.status).toBe(200);

        const del = await h.call('DELETE', `/v1/documents/${doc}`, { token: owner });
        expect(del.status).toBe(204);

        const mine = h.events.events.filter((e) => e.subject === doc);
        const types = mine.map((e) => e.type);
        expect(types).toEqual(
          expect.arrayContaining([
            'dep.document.created.v1',
            'dep.document.changed.v1',
            'dep.document.state_changed.v1',
            'dep.document.deleted.v1',
          ]),
        );
        for (const e of mine) {
          expect(() => toCloudEvent(e, { source: SOURCE }), e.type).not.toThrow();
        }

        const changed = mine.find((e) => e.type === 'dep.document.changed.v1')!;
        expect(changed.data['seq']).toBeTypeOf('number');
        expect(changed.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
      },
    );

    it.skipIf(skip)(
      'every body of the lifecycle passes the JSON Schema of its event type (PRO-069 criterion 4 for these four types)',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'V-PRO-069-085 schema',
        });
        const owner = h.userToken({ [doc]: 'owner' });
        const patch = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: owner,
          body: { title: 'schema', state: 'locked' },
          headers: { 'If-Match': '"m1"' },
        });
        expect(patch.status).toBe(200);
        expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: owner })).status).toBe(204);

        const mine = h.events.events.filter((e) => e.subject === doc);
        expect(mine.length).toBeGreaterThanOrEqual(3);
        for (const e of mine) {
          const body = JSON.parse(JSON.stringify(toCloudEvent(e, { source: SOURCE }))) as unknown;
          const valid = validatorFor(e.type);
          expect(
            valid(body),
            `${e.type}: ${JSON.stringify((valid as { errors?: unknown }).errors ?? null)}`,
          ).toBe(true);
        }
        // The validator is not vacuous: a body without seq is refused.
        const bad = { ...toCloudEvent(mine[0]!, { source: SOURCE }), data: {} };
        expect(validatorFor(mine[0]!.type)(bad)).toBe(false);
      },
    );
  });
}
