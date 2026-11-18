// BE-032 criterion 6 for the bare-identifier routes: an export job (`/exports/{jid}`), an import job
// (`/imports/{jid}`) and an asset (`/assets/{aid}/complete`) are resolved to their document, and a
// token that does not cover it, or a user other than the requester, gets `not_found`, so that the
// identifier is not confirmed (owner decision 57; D69). Threads and comments answer the same
// (`pro-059-threads.test.ts`). Runs over the HTTP surface of the harness, in memory and on
// PostgreSQL where it is available.
import { describe, expect, it } from 'vitest';
import {
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import { IMPORT_KIND } from '../../src/control-plane/imports.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9Qz wAAAgEBAGFFiq0AAAAASUVORK5CYII=',
  'base64',
);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`bare identifiers resolve to their document (${storage}, BE-032 criterion 6)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    async function setup() {
      h = await startHarness(storage);
    }

    it.skipIf(skip)(
      'refuses an export job to a token that does not cover its document (GET and DELETE)',
      async () => {
        await setup();
        try {
          const doc = await h.createDocument({});
          const other = await h.createDocument({});
          const editor = h.userToken({ [doc]: 'editor' });
          const job = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: editor,
            body: { target: 'pdf' },
          });
          expect(job.status).toBe(202);
          const id = job.json.id as string;

          const stranger = h.userToken({ [other]: 'editor' }, { sub: 'mallory' });
          const read = await h.call('GET', `/v1/exports/${id}`, { token: stranger });
          expect(read.status).toBe(404);
          expect(read.json.code).toBe('not_found');
          const del = await h.call('DELETE', `/v1/exports/${id}`, { token: stranger });
          expect(del.status).toBe(404);
          expect(del.json.code).toBe('not_found');
          // The service credential of the tenant still reads it (D69).
          expect((await h.call('GET', `/v1/exports/${id}`, { token: h.apiKey })).status).toBe(200);
        } finally {
          await h.close();
        }
      },
    );

    it.skipIf(skip)(
      'refuses an export job to another user of the same document, who is not its requester',
      async () => {
        await setup();
        try {
          const doc = await h.createDocument({});
          const editor = h.userToken({ [doc]: 'editor' });
          const job = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: editor,
            body: { target: 'pdf' },
          });
          expect(job.status).toBe(202);
          const other = h.userToken({ [doc]: 'editor' }, { sub: 'eva' });
          const read = await h.call('GET', `/v1/exports/${job.json.id}`, { token: other });
          expect(read.status).toBe(404);
          expect(read.json.code).toBe('not_found');
        } finally {
          await h.close();
        }
      },
    );

    it.skipIf(skip)(
      'answers not_found for an import job to a token that does not cover its document, or to another author',
      async () => {
        await setup();
        try {
          const doc = await h.createDocument({});
          const other = await h.createDocument({});
          const job = await h.parts.queue.enqueue(h.tenant, {
            kind: IMPORT_KIND,
            doc,
            createdBy: 'someone-else',
            maxAttempts: 1,
            payload: { doc },
          });
          const stranger = h.userToken({ [other]: 'editor' }, { sub: 'mallory' });
          const away = await h.call('GET', `/v1/imports/${job.id}`, { token: stranger });
          expect(away.status).toBe(404);
          expect(away.json.code).toBe('not_found');
          const peer = h.userToken({ [doc]: 'editor' }, { sub: 'eva' });
          const same = await h.call('GET', `/v1/imports/${job.id}`, { token: peer });
          expect(same.status).toBe(404);
          expect(same.json.code).toBe('not_found');
          expect((await h.call('GET', `/v1/imports/${job.id}`, { token: h.apiKey })).status).toBe(
            200,
          );
        } finally {
          await h.close();
        }
      },
    );

    it.skipIf(skip)(
      'refuses an asset, addressed by its bare identifier, to a token that does not cover its document',
      async () => {
        await setup();
        try {
          const doc = await h.createDocument({});
          const other = await h.createDocument({});
          const up = await h.call('POST', `/v1/documents/${doc}/assets`, {
            token: h.apiKey,
            body: { filename: 'dot.png', mime: 'image/png', size: PNG.length },
          });
          expect(up.status).toBe(201);
          const asset = up.json.asset as string;

          const stranger = h.userToken({ [other]: 'editor' }, { sub: 'mallory' });
          const done = await h.call('POST', `/v1/assets/${asset}/complete`, { token: stranger });
          expect(done.status).toBe(404);
          expect(done.json.code).toBe('not_found');
        } finally {
          await h.close();
        }
      },
    );
  });
}
