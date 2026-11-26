/**
 * SEC-045 criterion 1 — every REST route and every WebSocket message that takes an identifier,
 * called with tenant A's credentials and tenant B's identifiers, is refused and returns no data
 * (10 §3.7, §1; 06 §4.1).
 *
 * The routes are not listed by hand. The suite reads the generated OpenAPI document
 * (`spec/dep/dep-1.openapi.json`), takes every operation whose path has a parameter, fills the
 * parameters with identifiers of objects that tenant B really created (a document with a region, a
 * thread and a comment, a version, an export job, an import job, an asset, a webhook, a hold), and
 * calls it twice as tenant A: with A's API key, and with a user token signed by A's host key that
 * names B's document as owner. A path parameter the suite has no identifier for fails the test, so
 * a new route cannot join the API without joining this sweep. Each call must be refused with 401,
 * 403 or 404, carry none of B's canary texts or identifiers, and leave B's objects as they were.
 *
 * A refusal proves nothing if the route would refuse anyone, so there is a control: afterwards
 * tenant B makes the same calls with its own API key, and each must get past the tenant check
 * (any status but 401, 403 and 404). The operations in `NOT_FOUND_FOR_OWNER` are the exceptions:
 * the service has no handler for them in this build, so B gets 404 as well.
 *
 * The tenant-wide list and query routes take no path identifier; called as A they must show
 * nothing of B (documents, webhooks, holds, audit, search, fonts).
 *
 * The WebSocket messages a client sends are read from the generated AsyncAPI document
 * (`spec/dep/dep-1.asyncapi.json`). Those that take an identifier are `ch.open` (a document),
 * `ch.close`, `sync.submit` and `presence.update` (a channel, which stands for the document it
 * opened), `auth.refresh` (a token that names documents) and `chunk` (a transfer). A connects with
 * its own token naming B's document; the open is refused, a submit, a presence update and a close
 * on that channel number reach nothing, a refresh with such a token grants nothing, and B's
 * document and B's own session see no change.
 *
 * Runs on memory and on PostgreSQL (skipped when PostgreSQL is not available).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { chunkMessage } from '@docedit/protocol';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  posInside,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { keyPair } from './support/jws.ts';
import { WireClient } from './support/wire.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SPEC = fileURLToPath(new URL('../../../spec/dep/', import.meta.url));
const openapi = JSON.parse(readFileSync(SPEC + 'dep-1.openapi.json', 'utf8')) as Json;
const asyncapi = JSON.parse(readFileSync(SPEC + 'dep-1.asyncapi.json', 'utf8')) as Json;

const CANARY_TITLE = 'SEC-045-SWEEP-TENANT-B-TITLE';
const CANARY_THREAD = 'SEC-045-SWEEP-TENANT-B-THREAD';
const CANARY_TEXT = 'Liability'; // the text of B's restricted region
const B_HOOK = 'https://hooks.example.test/sec-045-sweep-tenant-b';
const REGION = 'rLegal0000000001';

interface Operation {
  operationId: string;
  method: string;
  /** The path template of the OpenAPI document, without the `/v1` prefix. */
  template: string;
  params: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations: Operation[] = Object.entries(openapi['paths'] as Json).flatMap(
  ([template, item]) =>
    METHODS.filter((m) => (item as Json)[m]).map((m) => ({
      operationId: (item as Json)[m]['operationId'] as string,
      method: m.toUpperCase(),
      template,
      params: [...template.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!),
    })),
);
const withIdentifier = operations.filter((o) => o.params.length > 0);

/** The path parameters the suite has an identifier of tenant B for. */
const KNOWN_PARAMS = [
  'sha256',
  'id',
  'rid',
  'tid',
  'bid',
  'cid',
  'aid',
  'jid',
  'pid',
  'fid',
  'sid',
  'kid',
  'origin',
  'seq',
  'deliveryId',
  'holdId',
  // A name from a fixed set, not an identifier of tenant B (UX-033; ADR 0424).
  'reaction',
];

/** Client messages that take an identifier, and those that do not (05 §5). */
const WITH_IDENTIFIER = [
  'ch.open',
  'ch.close',
  'sync.submit',
  'presence.update',
  'auth.refresh',
  'chunk',
];
const WITHOUT_IDENTIFIER = ['hello', 'ping', 'pong', 'error'];

/**
 * Operations of the OpenAPI document for which tenant B has no object in this scenario, so that
 * tenant B itself gets 404 and the detail below. The refusal of tenant A on them shows only that
 * nothing answers. The control test fails as soon as one of them gets an object of B, or a handler
 * with another answer, and the operation then joins the sweep as a real target.
 *
 * - NOT_OFFERED: the document service has no handler for the operation in this build;
 * - the other details: the handler exists, but this scenario composes no importer (EXP-098), so B
 *   has no import job. The tenant scope of the job lookup is proven in EXP-098's own tests.
 */
const NOT_OFFERED = 'this server does not offer the route';
const NOT_FOUND_FOR_OWNER: Record<string, string> = {
  createImport: 'this server does not import Word files',
  getImport: 'no import job',
  // HIS-042: the handler exists; no commit of B's document introduced the suggestion that the
  // sweep names, and the route answers that with not_found for the owner as well.
  getSuggestionIntroduction: 'no commit introduced this suggestion',
  // ADR 0330 §2 (decision 177): this composition has no webhook dispatcher to send with.
  pingWebhook: 'this server does not send webhook deliveries',
  replayWebhookDelivery: 'this server does not send webhook deliveries',
  // FRW-054, FRW-055: the handlers exist; B's workflow is not sealed in this scenario.
  getWorkflowEvidence: 'has no evidence bundle yet',
  getWorkflowFinal: 'no sealed PDF', // memory: "has no sealed PDF yet"; PostgreSQL: "keeps no sealed PDFs"
  // B's workflow has no participant in this scenario (FRW-039).
  participantVerify: 'has no such participant',
  registerAccessCode: 'has no such participant',
  // FRW-044: the handler exists, but this scenario composes no consent texts.
  participantConsent: 'this server keeps no consent texts',
  getParticipantConsent: 'this server keeps no consent texts',
  // FRW-047: the handler exists; B's workflow has no participant in this scenario.
  participantComplete: 'has no such participant',
  signField: 'this server does not offer signing',
  // HIS-040: the route needs a purge pool, which only an operator supplies.
  tombstoneCommit: 'this server does not remove payloads',
  // FRW-062, FRW-063: the handlers exist; this scenario composes no template store and B has no
  // template or bulk send. The tenant scope of both lookups is proven in their own tests.
  getTemplate: 'no template',
  getBulkSend: 'no bulk send',
};
/** A body the route would accept from the object's own tenant, where the route takes one. */
function bodyFor(operationId: string): unknown {
  const bodies: Record<string, unknown> = {
    updateDocument: { title: 'renamed' },
    replaceContent: { content: documentWithRegions() },
    setRegionState: { state: 'approved' },
    updateGrants: { grants: [] },
    createVersion: { name: 'sweep' },
    restore: { toSeq: 0 },
    forkDocument: { atSeq: 0 },
    setReadMarker: { seq: 0 },
    tombstoneCommit: { reason: 'sweep' },
    createThread: {
      target: { block: 'pIntro0000000001' },
      comment: { body: [{ type: 'text', text: 'from the sweep' }] },
    },
    updateThread: { state: 'resolved' },
    createComment: { body: [{ type: 'text', text: 'from the sweep' }] },
    updateComment: { body: [{ type: 'text', text: 'from the sweep' }] },
    createAsset: { filename: 'plan.png', mime: 'image/png', size: 68 },
    resolveAssets: { assets: ['0190a000-0000-7000-8000-000000000001'] },
    createExport: { target: 'pdf' },
    createImport: { asset: '0190a000-0000-7000-8000-000000000001', format: 'docx' },
    updateWebhook: { url: 'https://evil.example.test/steal' },
    setDocumentRetention: { mode: 'inherit' },
    placeHold: { reason: 'sweep' },
    prefillFieldValues: { values: {} },
    // The published schema's required members; doc is not the path's, which the route refuses.
    putWorkflow: {
      id: '0190a000-0000-7000-8000-000000000002',
      doc: '0190a000-0000-7000-8000-000000000003',
      state: 'draft',
      rev: 1,
      participants: [],
    },
    participantConsent: {},
    participantVerify: { code: 'sweep' },
    registerAccessCode: { code: 'sweep' },
    participantComplete: {},
    participantDecline: { reason: 'sweep' },
    remindWorkflow: {},
    voidWorkflow: { reason: 'sweep' },
    signField: {},
  };
  return bodies[operationId];
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-045 criterion 1: the sweep of every identifier route and message (${storage})`, () => {
    let h: Harness;
    let docA: string;
    const ids: Record<string, string> = {};
    const t = () => (skip ? it.skip : it);

    /** B's identifier for a path parameter of an operation. */
    const identifier = (op: Operation, param: string): string => {
      const key =
        param === 'id'
          ? op.template.startsWith('/webhooks/')
            ? 'webhook'
            : 'doc'
          : param === 'kid' || param === 'origin'
            ? param
            : param === 'jid'
              ? op.template.startsWith('/imports/')
                ? 'import'
                : 'export'
              : param;
      const value = ids[key];
      if (!value) throw new Error(`no identifier of tenant B for {${param}} of ${op.operationId}`);
      return value;
    };
    const pathOf = (op: Operation): string =>
      '/v1' +
      op.template.replace(/\{(\w+)\}/g, (_m, p: string) => encodeURIComponent(identifier(op, p)));
    const query = (op: Operation): string =>
      op.operationId === 'getAttribution'
        ? '?seq=0'
        : op.operationId === 'getDiff'
          ? '?fromSeq=0&toSeq=0'
          : '';
    const call = (op: Operation, token: string): Promise<CallResult> => {
      const body = bodyFor(op.operationId);
      return h.call(op.method, pathOf(op) + query(op), {
        token,
        headers: { 'Idempotency-Key': uuid7() },
        ...(body !== undefined ? { body } : {}),
      });
    };

    const asB = (method: string, path: string, body?: unknown, token = h.b.apiKey) =>
      h.call(method, path, { token, ...(body !== undefined ? { body } : {}) });
    let ownerB: string;

    /** What B can read of its own objects, to compare before and after the attack. */
    const snapshotOfB = async (): Promise<Json> => {
      const doc = await asB('GET', `/v1/documents/${ids['doc']}`);
      const content = await asB('GET', `/v1/documents/${ids['doc']}/content`);
      const grants = await asB('GET', `/v1/documents/${ids['doc']}/grants`);
      const thread = await asB('GET', `/v1/threads/${ids['tid']}`, undefined, ownerB);
      const versions = await asB('GET', `/v1/documents/${ids['doc']}/versions`);
      const webhook = await asB('GET', `/v1/webhooks/${ids['webhook']}`);
      const holds = await asB('GET', '/v1/holds');
      const job = await asB('GET', `/v1/exports/${ids['export']}`);
      const keys = await asB('GET', '/v1/keys');
      const origins = await asB('GET', '/v1/origins');
      for (const r of [doc, content, grants, thread, versions, webhook, holds, job, keys, origins])
        expect(r.status, r.text.slice(0, 200)).toBe(200);
      return {
        keys: keys.json,
        origins: origins.json,
        doc: doc.json,
        content: content.json,
        grants: grants.json,
        thread: thread.json,
        versions: versions.json,
        webhook: webhook.json,
        holds: holds.json,
        job: { id: job.json.id, doc: job.json.doc, target: job.json.target },
      };
    };

    /** Nothing of tenant B may be in a response to tenant A. */
    const expectNothingOfB = (r: Pick<CallResult, 'text'>, what: string, sent = '') => {
      for (const secret of [CANARY_TITLE, CANARY_THREAD, CANARY_TEXT, B_HOOK, h.b.id])
        expect(r.text, `${what} must not carry "${secret}"`).not.toContain(secret);
      for (const key of ['tid', 'cid', 'webhook', 'export', 'aid', 'kid'])
        // An identifier the caller sent may come back in the refusal; one it did not send may not.
        if (ids[key] && !sent.includes(ids[key]))
          expect(r.text, `${what} must not carry B's ${key}`).not.toContain(ids[key]);
    };

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
      docA = await h.createDocument(h.a, documentWithRegions());
      const made = (what: string, r: CallResult, value: unknown): string => {
        expect(r.status, `tenant B creates its ${what}: ${r.text.slice(0, 200)}`).toBeLessThan(300);
        expect(typeof value, `the identifier of B's ${what}`).toBe('string');
        return value as string;
      };
      const doc = await asB('POST', '/v1/documents', {
        title: CANARY_TITLE,
        content: documentWithRegions(),
      });
      ids['doc'] = made('document', doc, doc.json?.id);
      ids['rid'] = REGION;
      // A commit sequence number in the path (HIS-040); B's document has its first commit.
      ids['seq'] = '1';
      ownerB = await h.mintToken(h.b, 'bella', { [ids['doc']]: 'owner' });
      const thread = await asB(
        'POST',
        `/v1/documents/${ids['doc']}/threads`,
        {
          target: { block: 'pIntro0000000001' },
          comment: { body: [{ type: 'text', text: CANARY_THREAD }] },
        },
        ownerB,
      );
      ids['tid'] = made('thread', thread, thread.json?.id);
      const reply = await asB(
        'POST',
        `/v1/threads/${ids['tid']}/comments`,
        { body: [{ type: 'text', text: CANARY_THREAD }] },
        ownerB,
      );
      ids['cid'] = made('comment', reply, reply.json?.id);
      ids['reaction'] = 'thumbsUp';
      const version = await asB('POST', `/v1/documents/${ids['doc']}/versions`, { name: 'v1' });
      made('version', version, version.json?.name);
      const job = await asB('POST', `/v1/documents/${ids['doc']}/exports`, { target: 'pdf' });
      ids['export'] = made('export job', job, job.json?.id);
      const asset = await asB('POST', `/v1/documents/${ids['doc']}/assets`, bodyFor('createAsset'));
      ids['aid'] = made('asset', asset, asset.json?.asset);
      const hook = await asB('POST', '/v1/webhooks', {
        url: B_HOOK,
        events: ['dep.grants.changed.v1'],
      });
      ids['webhook'] = made('webhook', hook, hook.json?.id);
      const hold = await asB('POST', `/v1/documents/${ids['doc']}/holds`, { reason: 'sweep' });
      ids['holdId'] = made('hold', hold, hold.json?.id);
      // B's workflow, so that the control reads and replaces an object of its own (FRW-025).
      const workflow = await h.call('PUT', `/v1/documents/${ids['doc']}/workflow`, {
        token: ownerB,
        headers: { 'If-Match': '"0"' },
        body: { ...(bodyFor('putWorkflow') as object), doc: ids['doc'] },
      });
      made('workflow', workflow, workflow.json?.id);
      // B registers a key and an origin of its own (UX-077), so that the sweep has them to attack.
      const key = keyPair('EdDSA');
      const registered = await asB('POST', '/v1/keys', {
        kid: `b-extra-${uuid7()}`,
        use: 'user',
        alg: key.alg,
        jwk: key.jwk,
      });
      ids['kid'] = made('key', registered, registered.json?.kid);
      const origin = await asB('POST', '/v1/origins', { origin: 'https://b-extra.example.test' });
      ids['origin'] = made('origin', origin, origin.json?.origin);
      // B has no import job, workflow participant or form field in this scenario; the identifiers
      // are well-formed ones that name nothing (see NOT_FOUND_FOR_OWNER).
      // B's own key and origin for the registry routes (UX-077). The key identifier carries no part
      // of B's tenant identifier, which a refusal must never show.
      ids['kid'] = `sweep-key-${uuid7()}`;
      await h.parts.registry.addKey(h.b.id, {
        kid: ids['kid'],
        use: 'user',
        alg: 'EdDSA',
        jwk: keyPair('EdDSA').jwk,
      });
      ids['origin'] = 'https://sweep-b.example.test';
      await h.parts.registry.addOrigin(h.b.id, ids['origin']);
      ids['import'] = uuid7();
      // B's font (BE-048): the file in B's prefix and its row, named by the hash of its bytes.
      const fontBytes = new TextEncoder().encode(`sweep font ${uuid7()}`);
      ids['sha256'] = createHash('sha256').update(fontBytes).digest('hex');
      await h.parts.objects.put(`tenants/${h.b.id}/fonts/${ids['sha256']}`, fontBytes);
      await h.parts.tenantFonts!.add({
        tenant: h.b.id,
        sha256: ids['sha256'],
        family: 'Sweep Sans',
        style: 'regular',
        weight: 400,
        italic: false,
        format: 'truetype',
        bytes: fontBytes.length,
        licence: 'Sweep licence',
        serverUse: true,
        addedBy: 'sweep',
        addedAt: 1,
      });
      ids['pid'] = 'participant-1';
      ids['fid'] = 'ffField000000001';
      ids['sid'] = 'ssSuggest0000001';
      ids['deliveryId'] = uuid7();
      ids['bid'] = uuid7();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('reads operations with identifiers from the OpenAPI document', () => {
      expect(operations.length).toBeGreaterThanOrEqual(73);
      expect(withIdentifier.length).toBeGreaterThanOrEqual(56);
      for (const op of withIdentifier)
        for (const p of op.params) expect(KNOWN_PARAMS, `${op.operationId} {${p}}`).toContain(p);
    });

    t()(
      "tenant A is refused on every identifier route with tenant B's identifiers, gets no data, and changes nothing",
      async () => {
        // The control for the credentials: both work on A's own document.
        const userA = h.userToken(h.a, 'mallory', { [ids['doc']!]: 'owner', [docA]: 'owner' });
        for (const token of [h.a.apiKey, userA])
          expect((await h.call('GET', `/v1/documents/${docA}`, { token })).status).toBe(200);

        const before = await snapshotOfB();
        for (const op of withIdentifier)
          for (const [who, token] of [
            ['API key', h.a.apiKey],
            ['user token', userA],
          ] as const) {
            const r = await call(op, token);
            const what = `${op.method} ${op.template} (${op.operationId}) with A's ${who}`;
            expect([401, 403, 404], `${what} -> ${r.status} ${r.text.slice(0, 200)}`).toContain(
              r.status,
            );
            expectNothingOfB(r, what, pathOf(op));
          }
        expect(await snapshotOfB()).toEqual(before);
      },
      120_000,
    );

    t()('the tenant-wide list and query routes show tenant A nothing of tenant B', async () => {
      const lists = [
        '/v1/documents',
        '/v1/webhooks',
        '/v1/holds',
        '/v1/audit',
        `/v1/audit?document=${ids['doc']}`,
        `/v1/search?q=${CANARY_TITLE}`,
        '/v1/fonts',
        '/v1/retention',
        '/v1/origins',
        '/v1/keys',
        '/v1/quotas',
        '/v1/templates',
        '/v1/history-visibility',
        '/v1/workflow/capture-settings',
      ];
      // Every operation without a path parameter that reads is in the list above.
      const reads = operations.filter((o) => o.params.length === 0 && o.method === 'GET');
      for (const op of reads)
        if (op.template !== '/.well-known/dep')
          expect(
            lists.some((l) => l.split('?')[0] === '/v1' + op.template),
            op.template,
          ).toBe(true);
      const userA = h.userToken(h.a, 'mallory', { [ids['doc']!]: 'owner' });
      let answered = 0;
      for (const path of lists)
        for (const token of [h.a.apiKey, userA]) {
          const r = await h.call('GET', path, { token });
          if (r.status === 200) answered += 1;
          expectNothingOfB(r, `GET ${path}`);
          expect(r.text, `GET ${path} must not carry B's document`).not.toContain(ids['doc']);
        }
      expect(answered, 'some list routes answer A').toBeGreaterThan(0);
      // The control: B's own list does show B's document.
      const own = await asB('GET', '/v1/documents');
      expect(own.text).toContain(ids['doc']);
    });

    it('classifies every message a client can send (AsyncAPI)', () => {
      const messages = asyncapi['components']['messages'] as Record<string, Json>;
      const fromClient = Object.entries(messages)
        .filter(([, m]) => m['x-dep-direction'] === 'c2s' || m['x-dep-direction'] === 'both')
        .map(([name]) => name)
        .sort();
      expect(fromClient).toEqual([...WITH_IDENTIFIER, ...WITHOUT_IDENTIFIER].sort());
    });

    t()(
      "tenant A's WebSocket messages that take an identifier reach nothing of tenant B",
      async () => {
        const docB = ids['doc']!;
        const seqOfB = async () =>
          (await asB('GET', `/v1/documents/${docB}/content`)).json.seq as number;
        const before = await seqOfB();
        const pos = posInside(documentWithRegions()['doc'], 'pIntro0000000001');

        // B's own session watches its document while A attacks.
        const watcher = await WireClient.connect(h.wsUrl, { origin: h.b.origin });
        const sessions: WireClient[] = [watcher];
        try {
          expect((await watcher.hello(ownerB)).t).toBe('welcome');
          expect((await watcher.open(1, docB)).t).toBe('ch.opened');
          const seen = watcher.log.length;

          const tokenA = () => h.userToken(h.a, 'mallory', { [docB]: 'owner', [docA]: 'owner' });
          /** A's session with the refused open of B's document on channel 1. */
          const attacker = async (): Promise<WireClient> => {
            const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
            sessions.push(c);
            expect((await c.hello(tokenA())).t).toBe('welcome');
            const opened = await c.open(1, docB); // ch.open
            expect(opened.t).toBe('ch.rejected');
            expect(opened.d?.['code']).toBe('not_found');
            expectNothingOfB({ text: JSON.stringify(opened) }, 'the answer to ch.open');
            return c;
          };
          /** Whatever the service sent after `from`, or the close, within a short wait. */
          const settle = async (c: WireClient, from: number): Promise<string> => {
            await new Promise((r) => setTimeout(r, 300));
            return JSON.stringify(c.log.slice(from));
          };

          // sync.submit on the channel of the refused open.
          let c = await attacker();
          let from = c.log.length;
          c.send({
            t: 'sync.submit',
            id: c.nextId(),
            ch: 1,
            d: { id: uuid7(), base: before, steps: [insertText(pos, 'from tenant A')] },
          });
          let got = await settle(c, from);
          expect(got).not.toContain('sync.ack');
          expectNothingOfB({ text: got }, 'the answer to sync.submit');

          // presence.update on that channel.
          c = await attacker();
          from = c.log.length;
          c.send({
            t: 'presence.update',
            ch: 1,
            d: { seq: before, selection: { anchor: pos, head: pos } },
          });
          got = await settle(c, from);
          expectNothingOfB({ text: got }, 'the answer to presence.update');

          // ch.close on that channel, then the session still serves A's own document.
          c = await attacker();
          from = c.log.length;
          c.send({ t: 'ch.close', id: c.nextId(), ch: 1 });
          got = await settle(c, from);
          expectNothingOfB({ text: got }, 'the answer to ch.close');

          // auth.refresh with a token that names B's document, then the open again.
          c = await attacker();
          const refreshId = c.nextId();
          c.send({ t: 'auth.refresh', id: refreshId, d: { token: tokenA() } });
          const refreshed = await c.take((m) => m.re === refreshId, 5000, 'answer to auth.refresh');
          expect(['auth.ok', 'error']).toContain(refreshed.t);
          if (!c.closeInfo) {
            const again = await c.open(2, docB);
            expect(again.t).toBe('ch.rejected');
            expect(again.d?.['code']).toBe('not_found');
          }

          // chunk: the same open of B's document sent as a chunked transfer.
          c = await attacker();
          const openId = c.nextId();
          const text = JSON.stringify({
            t: 'ch.open',
            id: openId,
            ch: 3,
            d: {
              kind: 'doc',
              doc: docB,
              engine: 'pm-steps/1',
              cdm: 1,
              features: ['regions', 'presence'],
              pad: 'x'.repeat(2000),
            },
          });
          from = c.log.length;
          for (const frame of chunkMessage(text, 1024, uuid7())) c.sendRaw(frame);
          got = await settle(c, from);
          expect(got).not.toContain('ch.opened');
          expectNothingOfB({ text: got }, 'the answer to a chunked ch.open');

          // The control: the same kind of session opens A's own document.
          c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          sessions.push(c);
          expect((await c.hello(tokenA())).t).toBe('welcome');
          expect((await c.open(1, docA)).t).toBe('ch.opened');

          // B's document did not move and B's session saw nothing from A.
          expect(await seqOfB()).toBe(before);
          const since = JSON.stringify(watcher.log.slice(seen));
          expect(since).not.toContain('mallory');
          expect(since).not.toContain('from tenant A');
          expect(watcher.log.slice(seen).filter((m) => m.t === 'sync.commit')).toEqual([]);
        } finally {
          for (const s of sessions) s.terminate();
        }
      },
      60_000,
    );

    // Last, because it changes and then deletes B's objects.
    t()(
      'the control: tenant B passes the tenant check on the same routes with its own credentials',
      async () => {
        const order = [
          ...withIdentifier.filter((o) => o.method === 'GET'),
          ...withIdentifier.filter((o) => o.method !== 'GET' && o.method !== 'DELETE'),
          ...withIdentifier.filter((o) => o.method === 'DELETE').reverse(),
        ];
        const notFound: string[] = [];
        for (const op of order) {
          // Some routes are for services and some for users (07 §12): B tries both of its own.
          const results = [await call(op, h.b.apiKey), await call(op, ownerB)];
          const passed = results.find((r) => ![401, 403, 404].includes(r.status));
          const what = `${op.method} ${op.template} (${op.operationId}) as B -> ${results
            .map((r) => `${r.status} ${r.text.slice(0, 120)}`)
            .join(' | ')}`;
          if (passed) continue;
          expect(
            results.some((r) => r.status === 404),
            what,
          ).toBe(true);
          // Not a missing object of B: the service has no handler for the operation at all.
          expect(
            results.some((r) =>
              String(r.json?.detail ?? '').includes(
                NOT_FOUND_FOR_OWNER[op.operationId] ?? NOT_OFFERED,
              ),
            ),
            what,
          ).toBe(true);
          notFound.push(op.operationId);
        }
        expect(notFound.sort()).toEqual(Object.keys(NOT_FOUND_FOR_OWNER).sort());
      },
      120_000,
    );
  });
}
