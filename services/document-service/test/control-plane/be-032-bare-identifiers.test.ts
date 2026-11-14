// BE-032 criterion 6 for the bare-identifier routes the control plane offers today: an export job
// (`/exports/{jid}`) and an asset (`/assets/{aid}/complete`) are resolved to their document, and a
// token that does not cover it, or a user other than the requester, is refused with `forbidden`.
// Runs over the HTTP surface of the harness, in memory and on PostgreSQL where it is available.
import { describe, expect, it } from 'vitest';
import {
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

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
          expect(read.status).toBe(403);
          expect(read.json.code).toBe('forbidden');
          const del = await h.call('DELETE', `/v1/exports/${id}`, { token: stranger });
          expect(del.status).toBe(403);
          expect(del.json.code).toBe('forbidden');
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
          expect(read.status).toBe(403);
          expect(read.json.code).toBe('forbidden');
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
          expect(done.status).toBe(403);
          expect(done.json.code).toBe('forbidden');
        } finally {
          await h.close();
        }
      },
    );
  });
}
