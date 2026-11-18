/**
 * SEC-064 criterion 1, the surfaces the earlier runs left out (lane w8). Canary strings sit in a
 * confidential region (title and text), in a sensitive field value, in a commit made into the
 * region, in a comment on it and in the name of a user who is working inside it. A reader without
 * access then uses:
 *
 * - history: content at every earlier sequence number, the commits, the history, the diff, the
 *   attribution, the field values and the thread list, each with the query its route needs (the
 *   earlier sweep called these without their required parameters);
 * - presence and comment notices on an open channel, and an asset that sits only in the region;
 * - an export of the CDM, built by the real export worker handler in the same process, and its
 *   output (as the requester's projection; EXP-123);
 * - search.
 *
 * A reader with access sees the same things, so each check can fail. Runs in memory and on
 * PostgreSQL in the shared container when it answers.
 *
 * Not covered, and why: the export is built as the canonical JSON (`cdm`), because no TeX Live
 * image is on this machine, so the PDF and LaTeX outputs are not scanned; the search index is fed
 * by the test, because the checkpoint hook of BE-054 that feeds it is not built.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../../services/document-service/src/control-plane/visibility.ts';
import { createExportHandler } from '../../../services/export-worker/src/job.ts';
import { TEST_FONTS } from '../../../services/export-worker/test/fonts.ts';
import { unsandboxed } from '../../../services/asset-worker/src/index.ts';
import { SearchIndex } from '../../../services/document-service/src/control-plane/search-index.ts';
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
  title: 'CANARY_CONF_TITLE_4e1d',
  text: 'CANARY_CONF_TEXT_8a2c',
  value: 'CANARY_SENSITIVE_6f0b',
  typed: 'CANARY_W8_TYPED_91d3',
  comment: 'CANARY_W8_COMMENT_3c7a',
  presence: 'CANARY_W8_PRESENCE_5e20',
};
const CANARIES = Object.values(CANARY);

const CONF = 'rConf00000000001';
const CONF_PARA = 'pConf00000000001';
const SENS = 'fSens00000000001';
const SENS_PARA = 'pSens00000000001';

function confidentialDocument(): Record<string, unknown> {
  const content = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  content.requires = ['fields'];
  const body = content.doc.content[1]!;
  const end = body.content.pop()!;
  body.content.push(
    {
      type: 'region',
      attrs: { id: CONF, title: CANARY.title, policy: 'confidential' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: CONF_PARA, style: 'Normal' },
          content: [{ type: 'text', text: CANARY.text }],
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: { id: SENS_PARA, style: 'Normal' },
      content: [
        { type: 'text', text: 'Deposit: ' },
        {
          type: 'form_field',
          attrs: {
            id: SENS,
            key: 'deposit',
            kind: 'text',
            label: 'deposit',
            assignee: null,
            sensitive: true,
            value: CANARY.value,
          },
        },
      ],
    },
    end,
  );
  return content;
}

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const OPEN = { features: ['regions', 'presence', 'fields'] };

async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'a condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`${what} did not hold within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-064 more surfaces never reach a reader without access (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let frank: string; // viewer, no grant on the confidential region
    let gina: string; // viewer with a grant on the confidential region
    let ann: string; // owner
    let head = 0;
    let thread = '';
    const searchIndex = new SearchIndex();
    const t = () => (skip ? it.skip : it);
    const service = () => ({ token: h.a.apiKey });

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        views: { ...FULL_VIEWS, visibility: visibility(() => Date.now()) },
        jobHandlers: {
          export: createExportHandler({
            stores: {
              get logs() {
                return h.parts.logs;
              },
              get checkpoints() {
                return h.service.checkpoints;
              },
              get documents() {
                return h.parts.documents;
              },
            },
            outputs: { putExport: (a, b, c, d, e) => h.service.assets.putExport(a, b, c, d, e) },
            fonts: async () => TEST_FONTS,
          }),
        },
        env: {
          DOCEDIT_EXPORT_TARGETS: 'pdf,cdm,tex,html',
          DOCEDIT_ASSET_ORIGIN: 'https://assets.tests.example',
          DOCEDIT_ASSET_URL_KEY: `k1:${randomBytes(32).toString('base64')}`,
        },
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        parts: { search: { search: async (t, q, o) => searchIndex.search(t, q, o) } },
      });
      doc = await h.createDocument(h.a, confidentialDocument());
      frank = h.userToken(h.a, 'frank', { [doc]: 'viewer' });
      gina = h.userToken(h.a, 'gina', { [doc]: 'viewer' });
      ann = h.userToken(h.a, 'ann', { [doc]: 'owner' });
      const etag = (await h.call('GET', `/v1/documents/${doc}/grants`, service())).headers.get(
        'etag',
      )!;
      const granted = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        ...service(),
        headers: { 'If-Match': etag },
        body: {
          grants: [
            { region: CONF, principal: 'user:gina', role: 'viewer' },
            { region: CONF, principal: `user:${CANARY.presence}`, role: 'viewer' },
          ],
        },
      });
      expect(granted.status, 'the grant is recorded').toBe(200);
    });
    afterAll(async () => {
      await h?.close();
    });

    t()(
      'seeds a commit, a comment and presence inside the region, and a granted reader sees them while a reader without access sees none',
      async () => {
        const hello = { features: OPEN.features };
        const writer = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        const worker = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        const outsider = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        const granted = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        // The user who works inside the region has a canary for an identifier (the wire shows the
        // sender's host `sub`; identity-spoofing.test.ts), and is granted the region, so it is in the class of the granted reader (presence is relayed within a view class).
        const workerToken = h.userToken(h.a, CANARY.presence, { [doc]: 'viewer' });
        try {
          expect((await writer.hello(ann, hello)).t).toBe('welcome');
          expect((await worker.hello(workerToken, hello)).t).toBe('welcome');
          expect((await outsider.hello(frank, hello)).t).toBe('welcome');
          expect((await granted.hello(gina, hello)).t).toBe('welcome');
          for (const c of [writer, worker, outsider, granted])
            expect((await c.open(1, doc, OPEN)).t).toBe('ch.opened');

          const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: ann })).json
            .doc;
          const inside = posInside(content, CONF_PARA);

          // A commit into the hidden region.
          const ack = await writer.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(inside, ` ${CANARY.typed}`)],
          });
          expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
          head = (ack.d?.['seq'] as number | undefined) ?? 1;

          // Presence of a user who is inside the region.
          worker.send({
            t: 'presence.update',
            ch: 1,
            d: {
              seq: 0,
              state: {
                selection: { anchor: inside, head: inside },
                scope: 'body',
                status: 'active',
                user: 'worker',
              },
            },
          });

          // A comment on the region.
          const created = await h.call('POST', `/v1/documents/${doc}/threads`, {
            token: ann,
            headers: { 'Idempotency-Key': randomUUID() },
            body: { target: { block: CONF_PARA }, comment: { text: CANARY.comment } },
          });
          expect(created.status, created.text).toBe(201);
          thread = created.json.id as string;

          const seen = (c: WireClient, s: string) => c.frames.some((f) => f.includes(s));
          await waitFor(
            () => seen(granted, CANARY.typed),
            3000,
            'the granted reader to get the commit',
          );
          await waitFor(() => seen(granted, thread), 3000, 'the granted reader to get the thread');
          await waitFor(
            () => seen(granted, CANARY.presence),
            3000,
            'the granted reader to see the user',
          );
          await sleep(500);

          // The controls: the reader with access sees the commit, the thread and the user.
          expect(seen(granted, CANARY.typed), 'granted reader: commit text').toBe(true);
          expect(seen(granted, thread), 'granted reader: thread notice').toBe(true);
          expect(seen(granted, CANARY.presence), 'granted reader: presence').toBe(true);
          expect(
            granted.all('presence.state').length,
            'granted reader: presence.state frames',
          ).toBeGreaterThan(0);
          expect(granted.all('event').length, 'granted reader: event frames').toBeGreaterThan(0);

          // The reader without access gets none of it, and no comment text.
          const frames = outsider.frames.join('\n');
          for (const c of CANARIES)
            expect(frames, `outsider frames must not carry ${c}`).not.toContain(c);
          expect(frames, 'the thread on hidden content is not announced').not.toContain(thread);
        } finally {
          writer.terminate();
          worker.terminate();
          outsider.terminate();
          granted.terminate();
        }
      },
    );

    t()(
      'a reader without access gets no canary from history, commits, diff, attribution, field values or threads at any sequence number',
      async () => {
        expect(head, 'the seed commit was made').toBeGreaterThan(0);
        const urls: string[] = [];
        for (let seq = 0; seq <= head; seq++) {
          urls.push(
            `/documents/${doc}/content?seq=${seq}`,
            `/documents/${doc}/field-values?seq=${seq}`,
            `/documents/${doc}/threads?seq=${seq}`,
            `/documents/${doc}/attribution?atSeq=${seq}`,
            `/documents/${doc}/attribution?region=${CONF}&atSeq=${seq}`,
            `/documents/${doc}/diff?fromSeq=0&toSeq=${seq}`,
          );
        }
        urls.push(
          `/documents/${doc}/commits?after=0`,
          `/documents/${doc}/history`,
          `/documents/${doc}/history?region=${CONF}`,
          `/documents/${doc}/history?field=${SENS}`,
          `/documents/${doc}/activity`,
          `/documents/${doc}/connect`,
          `/documents/${doc}/versions`,
          `/documents/${doc}/regions`,
          `/documents/${doc}/fields`,
          `/documents/${doc}/field-values`,
          `/documents/${doc}/grants`,
          `/threads/${thread}`,
        );
        let answered = 0;
        for (const u of urls) {
          const r = await h.call('GET', `/v1${u}`, { token: frank });
          const reloadAnswer =
            r.status === 503 &&
            (r.json as Record<string, unknown> | undefined)?.['code'] === 'unavailable';
          expect(r.status < 500 || reloadAnswer, `${u} must not fail inside the service`).toBe(
            true,
          );
          if (r.status === 200) answered++;
          for (const c of CANARIES) expect(r.text, `${u} must not carry ${c}`).not.toContain(c);
        }
        expect(
          answered,
          'some of these routes answer the reader, so the scan is not empty',
        ).toBeGreaterThan(0);

        // Controls: a reader with access sees the canaries on the same kind of read.
        const asGina = await h.call('GET', `/v1/documents/${doc}/content?seq=${head}`, {
          token: gina,
        });
        expect(asGina.text).toContain(CANARY.typed);
        const asAnn = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: ann });
        expect(asAnn.text).toContain(CANARY.value);
      },
    );

    t()(
      'an export of the requester projection holds no canary for a reader without access, and the owner export does',
      async () => {
        const run = async (
          token: string,
          target: string,
        ): Promise<{ status: number; text: string }> => {
          const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token,
            headers: { 'Idempotency-Key': randomUUID() },
            body: { target },
          });
          expect(created.status, created.text).toBe(202);
          const id = created.json.id as string;
          let last = created;
          for (let i = 0; i < 200; i++) {
            last = await h.call('GET', `/v1/exports/${id}`, { token });
            const state = (last.json as Record<string, unknown>)['state'];
            if (state === 'done' || state === 'failed' || state === 'completed') break;
            await sleep(50);
          }
          const body = last.json as Record<string, unknown>;
          expect(['done', 'completed'], last.text).toContain(body['state']);
          // The output is delivered by a signed URL of the asset origin (SEC-036 criterion 6); the
          // test reads the object the URL names, from the store itself (that origin is not running).
          const url = (body['result'] as { url: string }).url;
          const named =
            /^https:\/\/assets\.tests\.example\/e\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([^/?]+)\?/.exec(
              url,
            );
          expect(named, `a result URL on the asset origin: ${url}`).not.toBeNull();
          const key = `tenants/${named![1]}/exports/${named![2]}/${named![3]}`;
          const bytes = await h.parts.objects.get(key);
          expect(bytes, `the output object ${key} exists`).not.toBeNull();
          return { status: last.status, text: `${last.text}\n${new TextDecoder().decode(bytes!)}` };
        };
        for (const target of ['cdm', 'html', 'tex']) {
          const reader = await run(frank, target);
          // LaTeX escapes the underscore, so the source holds each canary in both spellings.
          const spellings = (c: string) => [c, c.replaceAll('_', '\\_')];
          for (const c of CANARIES)
            for (const s of spellings(c))
              expect(reader.text, `${target}: reader export must not carry ${s}`).not.toContain(s);
          expect(reader.text.length, `${target}: the reader export has output`).toBeGreaterThan(
            100,
          );

          const owner = await run(ann, target);
          expect(
            owner.text,
            `${target}: the owner export carries the hidden text, so the check can fail`,
          ).toSatisfy((x: string) => spellings(CANARY.text).some((s) => x.includes(s)));
        }
      },
      120_000,
    );

    t()(
      'an asset that sits only inside the hidden region is not resolved for a reader without access, and is for a granted one',
      async () => {
        // A second document of the same shape, so that the log can be written directly.
        const doc2 = await h.createDocument(h.a, confidentialDocument());
        const frank2 = h.userToken(h.a, 'frank', { [doc2]: 'viewer' });
        const gina2 = h.userToken(h.a, 'gina', { [doc2]: 'viewer' });
        const ann2 = h.userToken(h.a, 'ann', { [doc2]: 'owner' });
        const etag = (await h.call('GET', `/v1/documents/${doc2}/grants`, service())).headers.get(
          'etag',
        )!;
        const granted = await h.call('PATCH', `/v1/documents/${doc2}/grants`, {
          ...service(),
          headers: { 'If-Match': etag },
          body: { grants: [{ region: CONF, principal: 'user:gina', role: 'viewer' }] },
        });
        expect(granted.status).toBe(200);

        // Upload, scan and make the asset ready, as the asset worker does.
        const up = await h.call('POST', `/v1/documents/${doc2}/assets`, {
          token: ann2,
          body: { filename: 'dot.png', mime: 'image/png', size: PNG.length },
        });
        expect(up.status, up.text).toBe(201);
        const asset = up.json.asset as string;
        await h.service.assets.putQuarantined(h.a.id, asset, PNG);
        expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: ann2 })).status).toBe(
          202,
        );
        for (let i = 0; ; i++) {
          const row = await h.parts.assetRegistry.get(h.a.id, asset);
          if (row?.state === 'ready') break;
          if (row?.state === 'failed' || i > 250)
            throw new Error(`the asset did not become ready: ${JSON.stringify(row)}`);
          await sleep(20);
        }

        // The image is placed inside the confidential paragraph.
        const ref = { tenant: h.a.id, doc: doc2 };
        const epoch = await h.parts.ownership.claim(ref, 'sec-064-w8');
        const head0 = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const content = await h.service.content.rebuild(ref, head0.incarnation, head0.seq);
        const pos = posInside(content.doc, CONF_PARA);
        const appended = await h.parts.logs.append(ref, {
          epoch,
          revision: perms.revision,
          fromSeq: head0.seq + 1,
          commits: [
            {
              seq: head0.seq + 1,
              id: uuid7(),
              kind: 'steps',
              steps: [
                {
                  stepType: 'replace',
                  from: pos,
                  to: pos,
                  slice: {
                    content: [{ type: 'image', attrs: { asset, width: 100, height: 100 } }],
                  },
                },
              ],
              user: 'u-test',
              session: 's',
              time: h.now(),
              origin: 'input',
              scopes: ['body'],
              revision: perms.revision,
              cdm: 1,
              engine: 'pm-steps/1',
              retired: [],
              claimed: [],
            },
          ] as never,
        });
        expect(appended.status).toBe('ok');

        const resolve = (token: string) =>
          h.call('POST', `/v1/documents/${doc2}/assets/resolve`, {
            token,
            body: { assets: [asset] },
          });
        const asGina = await resolve(gina2);
        expect(asGina.status, asGina.text).toBe(200);
        expect(asGina.text, 'the granted reader gets a URL, so the check can fail').toMatch(
          /https?:/,
        );
        const asAnn = await resolve(ann2);
        expect(asAnn.text).toMatch(/https?:/);
        const asFrank = await resolve(frank2);
        expect(asFrank.text, 'no URL for a reader who cannot see the image').not.toMatch(/https?:/);
        expect(asFrank.text).not.toContain(asset);
      },
    );

    t()(
      'search answers a reader without access nothing, and the host search holds no text of the hidden region',
      async () => {
        // The checkpoint hook that feeds the index is not built (BE-054), so the index is fed here
        // with the document's text, as the hook would.
        const full = (await h.call('GET', `/v1/documents/${doc}/content`, { token: ann })).json.doc;
        searchIndex.indexCheckpoint({
          tenant: h.a.id,
          doc,
          seq: head,
          visibility: 'full',
          content: full,
        });
        const asFrank = await h.call('GET', '/v1/search?q=CANARY_CONF_TEXT_8a2c&limit=10', {
          token: frank,
        });
        expect([401, 403], asFrank.text).toContain(asFrank.status);
        for (const c of CANARIES) expect(asFrank.text).not.toContain(c);

        // The host's own search finds the document (so the index is not empty) and returns
        // identifiers and scores only, no text.
        const asHost = await h.call('GET', '/v1/search?q=CANARY_CONF_TEXT_8a2c&limit=10', {
          token: h.a.apiKey,
        });
        expect(asHost.status, asHost.text).toBe(200);
        expect(asHost.text, 'the index holds the document').toContain(doc);
        for (const c of CANARIES) expect(asHost.text).not.toContain(c);
      },
    );

    t()('the service log holds no canary after these runs', () => {
      const blob = h.logs.join('\n');
      for (const c of CANARIES)
        expect(blob, `canary ${c} must not appear in logs`).not.toContain(c);
    });
  });
}
