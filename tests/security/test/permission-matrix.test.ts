/**
 * PRM-057 — negative tests for the matrix rows that exist in the first usable release (07 §12; 11 §4).
 * Each case calls the real document service over the wire as a caller who lacks the right, and
 * checks that the refusal happens and that nothing changes. The rows are:
 *
 *   row 1  a connection without `view` cannot open a channel, read content at the head or send
 *          presence; with `view` it opens and reads every region, including the restricted one;
 *   row 10 for grants, a region's `policy` and deleting the document, a user without `manage` is
 *          refused;
 *   row 12 a user without `view` cannot export (the compile-log half is not served yet, see PRM-057);
 *   row 13 a user token cannot call the service-only routes, and a claim cannot turn it into a
 *          service credential.
 *
 *   row 6  a viewer or commenter cannot upload an asset; a suggester or an editor can.
 *
 * Rows 3 and 7 and the profile packaging (criterion 8) stay open in the story: row 7 needs an asset
 * in the ready state, which this suite does not run through the asset worker (the service's own
 * routes.assets.test.ts does), and the conformance profiles do not exist yet.
 */
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { at, loadDoc, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const LEGAL = 'rLegal0000000001';

/** A refusal: a 4xx status and no success. */
const refused = (r: CallResult) => {
  expect(r.status, `${r.status} ${r.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`PRM-057 matrix negative tests (${storage})`, () => {
    let h: Harness;
    let doc: string; // tenant A's document with a restricted region
    let other: string; // tenant A's second document, so a token can hold a role on it and not on `doc`
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
        other = await h.createDocument(h.a, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** A token with a role on `other` only: it has no `view` on `doc`. */
    const outsiderToken = () => h.mintToken(h.a, 'outsider', { [other]: 'owner' });

    t()(
      'row 1: without view a connection cannot open, read the head or send presence; with view it reads every region',
      async () => {
        const outsider = await outsiderToken();
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await c.hello(outsider)).t).toBe('welcome');
          const opened = await c.open(1, doc);
          expect(opened.t).toBe('ch.rejected');
          expect(opened.d?.['code']).toBe('forbidden');

          // Presence on a channel it never opened must not reach anyone who can see the document.
          const viewerToken = await h.mintToken(h.a, 'viewer-row1', { [doc]: 'viewer' });
          const viewer = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          try {
            await viewer.hello(viewerToken);
            await viewer.open(1, doc);
            c.send({
              t: 'presence.update',
              ch: 1,
              d: {
                seq: 0,
                state: {
                  selection: { anchor: 1, head: 1 },
                  scope: 'body',
                  status: 'active',
                  user: 'outsider',
                },
              },
            });
            await new Promise((r) => setTimeout(r, 300));
            expect(JSON.stringify(viewer.log)).not.toContain('outsider');
          } finally {
            viewer.terminate();
          }

          // REST content at the head is refused without view.
          refused(await h.call('GET', `/v1/documents/${doc}/content`, { token: outsider }));
        } finally {
          c.terminate();
        }

        // With view the same document opens and the restricted region's text is visible.
        const viewerToken = await h.mintToken(h.a, 'viewer-row1b', { [doc]: 'viewer' });
        const v = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await v.hello(viewerToken);
          expect((await v.open(1, doc)).t).toBe('ch.opened');
        } finally {
          v.terminate();
        }
        const read = await h.call('GET', `/v1/documents/${doc}/content`, { token: viewerToken });
        expect(read.status).toBe(200);
        expect(JSON.stringify(read.json.doc)).toContain('Liability');
        expect(JSON.stringify(read.json.doc)).toContain(LEGAL);
      },
    );

    t()(
      'row 10: a user without manage cannot change grants, change a region policy or delete the document',
      async () => {
        const editor = await h.mintToken(h.a, 'editor-row10', { [doc]: 'editor' });

        expect(
          (await h.call('PATCH', `/v1/documents/${doc}/grants`, { token: editor, body: {} }))
            .status,
        ).toBe(403);

        // A region policy change is a structure step on the region; an editor has no manage.
        const d = loadDoc(
          (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json
            .doc as unknown,
        );
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(editor);
          await c.open(1, doc);
          const r = await c.submit(1, {
            id: uuid7(),
            base: 0,
            steps: stepsJson([new AttrStep(at(d, LEGAL), 'policy', 'inherit')]),
          });
          expect(r.t).toBe('sync.reject');
          expect(r.d?.['code']).toBe('permission_denied');
        } finally {
          c.terminate();
        }

        expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: editor })).status).toBe(
          403,
        );
        // The document is still there for its owner.
        const owner = await h.mintToken(h.a, 'owner-row10', { [doc]: 'owner' });
        expect((await h.call('GET', `/v1/documents/${doc}`, { token: owner })).status).toBe(200);
      },
    );

    t()('row 12: a user without view cannot start an export of the document', async () => {
      const outsider = await outsiderToken();
      refused(
        await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: outsider,
          body: { format: 'pdf' },
        }),
      );
    });

    t()(
      'row 13: a user token cannot call the service-only routes, and a claim cannot make it a service credential',
      async () => {
        const user = await h.mintToken(h.a, 'owner-row13', { [doc]: 'owner' });
        const serviceOnly: Array<{ method: string; path: string; body?: unknown }> = [
          { method: 'POST', path: '/v1/documents', body: {} }, // create
          { method: 'GET', path: '/v1/documents' }, // list
          { method: 'POST', path: `/v1/documents/${doc}/fork`, body: {} }, // fork
          { method: 'POST', path: `/v1/documents/${doc}/imports`, body: {} }, // import
          { method: 'GET', path: '/v1/search?q=x' }, // search
          { method: 'GET', path: '/v1/audit' }, // audit
          { method: 'GET', path: '/v1/webhooks' }, // webhooks
          { method: 'POST', path: '/v1/webhooks', body: { url: 'https://hook.example.test/x' } },
          { method: 'POST', path: '/v1/tokens', body: { sub: 'x', docs: { [doc]: 'owner' } } }, // tokens
          { method: 'POST', path: '/v1/sessions/revoke', body: { sub: 'x' } }, // revoke
        ];
        for (const { method, path, body } of serviceOnly) {
          const r = await h.call(method, path, {
            token: user,
            ...(body !== undefined ? { body } : {}),
          });
          // A route that exists and refuses the caller answers 401 or 403; a 404 would prove nothing.
          expect([401, 403], `${method} ${path} ${r.text.slice(0, 120)}`).toContain(r.status);
        }

        // A claim that names a service identity does not turn the user token into one.
        const escalated = h.userToken(
          h.a,
          'owner-row13',
          { [doc]: 'owner' },
          {
            header: { typ: 'dep-svc+jwt' },
            claims: { scope: 'service', svc: true, iss: 'host-backend' },
          },
        );
        refused(await h.call('GET', '/v1/audit', { token: escalated }));
        refused(
          await h.call('POST', '/v1/tokens', {
            token: escalated,
            body: { sub: 'x', docs: { [doc]: 'owner' } },
          }),
        );

        // The control: the tenant's service credential does reach the same listing.
        expect((await h.call('GET', '/v1/documents', { token: h.a.apiKey })).status).toBe(200);
      },
    );

    t()(
      'row 6: a viewer or a commenter cannot upload an asset; a suggester or an editor can',
      async () => {
        const body = { filename: 'a.png', mime: 'image/png', size: 10 };
        for (const role of ['viewer', 'commenter']) {
          const token = await h.mintToken(h.a, `${role}-row6`, { [doc]: role });
          const r = await h.call('POST', `/v1/documents/${doc}/assets`, { token, body });
          expect(r.status, `${role}: ${r.text.slice(0, 160)}`).toBe(403);
          expect(r.json?.asset, `${role} got an asset identifier`).toBeUndefined();
        }
        for (const role of ['suggester', 'filler', 'editor']) {
          const token = await h.mintToken(h.a, `${role}-row6`, { [doc]: role });
          const r = await h.call('POST', `/v1/documents/${doc}/assets`, { token, body });
          expect(r.status, `${role}: ${r.text.slice(0, 160)}`).toBe(201);
        }
      },
    );
  });
}
