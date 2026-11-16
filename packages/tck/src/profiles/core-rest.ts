/**
 * The `core` profile, part 4 (PRO-111 criterion 5): the conventions of the control plane (05 §6.1)
 * on the routes every server offers: problem details, cursor lists, `ETag` and `If-Match`,
 * idempotency keys, pinned content reads and identifiers in paths.
 */
import { canonicalNodeText, uuid7, type JsonNode } from '@docedit/model';
import { KitFailure, check, equal, includes, isObject, jsonEqual } from '../assert.ts';
import { shapeViolations } from '../context.ts';
import { IDS, contractDocument, insertText, posIn } from '../documents.ts';
import { bareRoutes, untestedBareRoutes } from '../identifiers.ts';
import { everyItemOnce, listRoutes } from '../lists.ts';
import type { ScenarioContext } from '../context.ts';
import type { HttpResponse } from '../rest.ts';
import { scenario, type ScenarioDef } from '../scenario.ts';
import { acked, join, problemOf, readContent } from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('core', def);

/**
 * A call with a token of another document must be refused, and must not say more than that: the
 * problem is `forbidden` (403) or `not_found` (404), the two refusals 05 §6.1 gives a caller whose
 * token does not cover the resource's document.
 */
function refusedToOutsider(res: HttpResponse, what: string): void {
  const p = problemOf(res, what);
  check(
    (p.code === 'forbidden' && p.status === 403) || (p.code === 'not_found' && p.status === 404),
    `${what}: refused to a caller of another document (05 §6.1)`,
    'forbidden (403) or not_found (404)',
    `${p.code} (${p.status})`,
  );
}

/** A thread with one more comment on a new document, made by a commenter of that document. */
async function threadOf(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const { token } = await ctx.token('commenter', { [doc]: 'commenter' });
  const content = await readContent(ctx, token, doc);
  const from = posIn(content.doc, IDS.intro);
  const made = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
    body: {
      target: { range: { from, to: from + 1, baseSeq: content.seq } },
      comment: { body: 'kit' },
    },
  });
  equal(made.status, 201, 'POST /documents/{id}/threads as a commenter');
  const tid = (made.json as { id?: unknown }).id;
  check(typeof tid === 'string', 'the created thread has an id', 'a string', made.json);
  const added = await ctx.service.as(token, 'POST', `/threads/${tid}/comments`, {
    body: { body: 'a second comment' },
  });
  equal(added.status, 201, 'POST /threads/{tid}/comments as a commenter');
  const cid = (added.json as { id?: unknown }).id;
  check(typeof cid === 'string', 'the created comment has an id', 'a string', added.json);
  return { doc, token, tid, cid };
}

export const CORE_REST: ScenarioDef[] = [
  s({
    id: 'rest.problem',
    title: 'errors are RFC 9457 problem documents with a registry code and the request identifier',
    spec: '05 §6.1, §5.8; D61, D71',
    covers: {
      operations: ['GET /documents/{id}'],
      errors: ['not_found', 'unauthenticated', 'forbidden'],
    },
    async run(ctx) {
      const missing = await ctx.service.call('GET', `/documents/${uuid7()}`);
      const p = problemOf(missing, 'an unknown document');
      equal(p.code, 'not_found', 'code');
      equal(p.status, 404, 'the HTTP status of not_found (D61)');
      const rid = missing.headers.get('dep-request-id');
      if (rid) {
        if (p.requestId !== undefined)
          equal(p.requestId, rid, 'the problem repeats DEP-Request-Id (D71)');
      } else ctx.note('no DEP-Request-Id header (D71)');
      const doc = await ctx.document();
      const anonymous = await ctx.service.as(undefined, 'GET', `/documents/${doc}`);
      equal(
        problemOf(anonymous, 'no credential').code,
        'unauthenticated',
        'a request without a credential',
      );
      equal(anonymous.status, 401, 'the HTTP status of unauthenticated (D61)');
      const other = await ctx.document();
      const { token } = await ctx.token('outsider', { [other]: 'editor' });
      const outside = await ctx.service.as(token, 'GET', `/documents/${doc}`);
      equal(
        problemOf(outside, 'a document outside the token').code,
        'forbidden',
        'the token must cover the document (05 §6.1)',
      );
      equal(outside.status, 403, 'the HTTP status of forbidden (D61)');
    },
  }),
  s({
    id: 'rest.document',
    title: 'the document resource has the members of D62 and an ETag',
    spec: '05 §6.2; D62',
    covers: { operations: ['POST /documents', 'GET /documents/{id}'] },
    async run(ctx) {
      const created = await ctx.service.call('POST', '/documents', {
        body: {
          content: contractDocument(),
          title: 'Kit',
          properties: { kit: true },
          externalId: `tck-${uuid7()}`,
        },
      });
      equal(created.status, 201, 'POST /documents creates (D61)');
      const v = shapeViolations('DocumentResource', created.json);
      check(
        v.length === 0,
        'the document resource matches the published schema',
        'no violations',
        v,
      );
      const id = (created.json as { id: string }).id;
      const { token } = await ctx.token('reader', { [id]: 'viewer' });
      const got = await ctx.service.as(token, 'GET', `/documents/${id}`);
      equal(got.status, 200, 'GET /documents/{id} as a viewer');
      check(!!got.headers.get('etag'), 'a mutable resource has an ETag (05 §6.1)', 'an ETag', null);
      equal((got.json as { title: string }).title, 'Kit', 'title');
      jsonEqual((got.json as { properties: unknown }).properties, { kit: true }, 'properties');
    },
  }),
  s({
    id: 'rest.if-match',
    title:
      'an update needs If-Match: missing is 428, stale is 412, current succeeds with a new ETag',
    spec: '05 §6.1; D15, D61',
    covers: {
      operations: ['GET /documents/{id}', 'PATCH /documents/{id}'],
      errors: ['precondition_failed'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const first = await ctx.service.call('GET', `/documents/${doc}`);
      const etag = first.headers.get('etag');
      check(etag, 'an ETag', 'an ETag', null);
      const none = await ctx.service.call('PATCH', `/documents/${doc}`, { body: { title: 'one' } });
      equal(problemOf(none, 'PATCH without If-Match').code, 'precondition_failed', 'code');
      equal(none.status, 428, 'a missing If-Match is 428 (D61)');
      const ok = await ctx.service.call('PATCH', `/documents/${doc}`, {
        body: { title: 'two' },
        headers: { 'if-match': etag },
      });
      equal(ok.status, 200, 'PATCH with the current ETag');
      const next = ok.headers.get('etag');
      check(next && next !== etag, 'a new ETag after the update', `not ${etag}`, next);
      const stale = await ctx.service.call('PATCH', `/documents/${doc}`, {
        body: { title: 'three' },
        headers: { 'if-match': etag },
      });
      equal(problemOf(stale, 'a stale If-Match').code, 'precondition_failed', 'code');
      equal(stale.status, 412, 'a stale If-Match is 412 (D61)');
    },
  }),
  s({
    id: 'rest.list',
    title: 'lists are { items, nextCursor } pages with a limit of at most 200',
    spec: '05 §6.1; D14, D72',
    covers: { operations: ['GET /documents'], errors: ['validation_failed'] },
    async run(ctx) {
      const tag = `tck-${ctx.config.run}-${uuid7()}`;
      for (const n of [1, 2, 3])
        await ctx.service.createDocument({
          content: contractDocument(),
          externalId: `${tag}-${n}`,
        });
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await ctx.service.call('GET', '/documents', {
          query: { limit: 1, ...(cursor ? { cursor } : {}) },
        });
        equal(res.status, 200, 'GET /documents');
        const j = res.json;
        check(
          isObject(j) && Array.isArray(j['items']) && 'nextCursor' in j,
          'a cursor list (05 §6.1)',
          '{ items, nextCursor }',
          j,
        );
        check(
          (j['items'] as unknown[]).length <= 1,
          'the page respects limit',
          '≤ 1 item',
          (j['items'] as unknown[]).length,
        );
        for (const it of j['items'] as Array<{ id: string }>) seen.push(it.id);
        cursor = j['nextCursor'] as string | null;
        if (cursor === null) break;
        check(
          typeof cursor === 'string',
          'nextCursor is a string or null (D14)',
          'string or null',
          cursor,
        );
      }
      check(seen.length >= 1, 'the pages list documents', '≥ 1', seen.length);
      const filtered = await ctx.service.call('GET', '/documents', {
        query: { externalId: `${tag}-2` },
      });
      equal(filtered.status, 200, 'GET /documents?externalId=');
      const items = (filtered.json as { items: Array<{ externalId: string }> }).items;
      check(
        items.length === 1 && items[0]!.externalId === `${tag}-2`,
        'the list filters by externalId (05 §6.2)',
        `${tag}-2`,
        items,
      );
      const big = await ctx.service.call('GET', '/documents', { query: { limit: 201 } });
      equal(problemOf(big, 'limit 201').code, 'validation_failed', 'a limit above 200 (D72)');
      const forged = await ctx.service.call('GET', '/documents', {
        query: { cursor: 'not-a-cursor-the-server-issued' },
      });
      equal(
        problemOf(forged, 'a forged cursor').code,
        'validation_failed',
        'a cursor the server did not issue (D72)',
      );
    },
  }),
  s({
    id: 'rest.cursors',
    title: 'following nextCursor to the end shows every item once, on every list route',
    spec: '05 §6.1; D14, D72',
    timeoutMs: 180_000,
    covers: { operations: ['GET /documents'] },
    async run(ctx) {
      // A document with three commits after its first content, and three documents to list.
      const tag = `tck-${ctx.config.run}-${uuid7()}`;
      const made: string[] = [];
      for (const n of [1, 2, 3])
        made.push(
          (
            await ctx.service.createDocument({
              content: contractDocument(),
              externalId: `${tag}-${n}`,
            })
          ).id,
        );
      const doc = made[0]!;
      const m = await join(ctx, 'lister', doc, 'editor');
      let head = m.content.seq;
      for (const t of ['1', '2', '3'])
        head = (
          await acked(m.wire, 1, {
            base: head,
            steps: [insertText(posIn(m.content.doc, IDS.end), t)],
          })
        ).seq;
      const params: Record<string, string | number> = { after: m.content.seq };
      let walked = 0;
      for (const route of listRoutes()) {
        const unknown = route.required.filter((q) => !(q in params));
        if (unknown.length) {
          ctx.note(
            `GET ${route.path} is not walked: the kit has no value for ${unknown.join(', ')}`,
          );
          continue;
        }
        const path = route.path.replace('{id}', doc);
        const fixed = Object.fromEntries(route.required.map((q) => [q, params[q]!]));
        const result = await everyItemOnce(
          (query) => ctx.service.call('GET', path, { query: { ...fixed, ...query } }),
          `GET ${route.path}`,
        );
        if (result === null) {
          ctx.note(`GET ${route.path} is not offered by this server`);
          continue;
        }
        walked += 1;
        ctx.note(
          `GET ${route.path}: ${result.items.length} items, each once, in pages of ${result.limit}`,
        );
        if (route.operationId === 'listDocuments') {
          const ids = (result.items as Array<{ id?: unknown }>).map((d) => d.id);
          for (const id of made)
            equal(ids.filter((x) => x === id).length, 1, `the document ${id} is listed once`);
        }
        if (route.operationId === 'listCommits')
          jsonEqual(
            (result.items as Array<{ seq?: unknown }>).map((c) => c.seq),
            [head - 2, head - 1, head],
            'the three commits, each once and in order',
          );
      }
      check(walked >= 1, 'the document list is offered (05 §6.2)', '≥ 1 list route', walked);
    },
  }),
  s({
    id: 'rest.content',
    title:
      'content reads: the envelope with seq and incarnation; pinned reads are stable and the ETag follows seq',
    spec: '05 §6.2; 03 §2; D70',
    covers: { operations: ['GET /documents/{id}/content'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'writer', doc, 'editor');
      const v = shapeViolations('Content', m.content);
      check(v.length === 0, 'the content matches the published schema', 'no violations', v);
      equal(m.content.cdm, 1, 'cdm');
      jsonEqual(m.content.requires, [], 'requires');
      equal(
        canonicalNodeText(m.content.doc as unknown as JsonNode),
        canonicalNodeText(contractDocument().doc as unknown as JsonNode),
        'the created content',
      );
      const a1 = await acked(m.wire, 1, {
        base: m.content.seq,
        steps: [insertText(posIn(m.content.doc, IDS.intro), 'A')],
      });
      const pinned1 = await ctx.service.as(m.token, 'GET', `/documents/${doc}/content`, {
        query: { seq: a1.seq },
      });
      const a2 = await acked(m.wire, 1, {
        base: a1.seq,
        steps: [insertText(posIn(m.content.doc, IDS.intro), 'B')],
      });
      const pinned2 = await ctx.service.as(m.token, 'GET', `/documents/${doc}/content`, {
        query: { seq: a1.seq },
      });
      equal(pinned1.status, 200, 'a pinned read');
      equal(pinned2.text, pinned1.text, 'a pinned read never changes (05 §6.2)');
      const head = await readContent(ctx, m.token, doc);
      equal(head.seq, a2.seq, 'the head');
      const e1 = pinned1.headers.get('etag');
      const eh = (await ctx.service.as(m.token, 'GET', `/documents/${doc}/content`)).headers.get(
        'etag',
      );
      check(
        e1 && eh && e1 !== eh,
        'the ETag combines incarnation and seq (05 §6.2)',
        'distinct ETags for two seqs',
        [e1, eh],
      );
    },
  }),
  s({
    id: 'rest.idempotency',
    title:
      'an Idempotency-Key repeats the creation; the same key with another body is idempotency_mismatch',
    spec: '05 §6.1',
    covers: { operations: ['POST /documents'], errors: ['idempotency_mismatch'] },
    async run(ctx) {
      const key = `tck-${uuid7()}`;
      const body = { content: contractDocument(), title: 'once' };
      const a = await ctx.service.call('POST', '/documents', {
        body,
        headers: { 'idempotency-key': key },
      });
      const b = await ctx.service.call('POST', '/documents', {
        body,
        headers: { 'idempotency-key': key },
      });
      check(a.status === 201 || a.status === 200, 'the first request creates', 201, a.status);
      equal(
        (b.json as { id?: string } | undefined)?.id,
        (a.json as { id: string }).id,
        'the same key and body give the same document',
      );
      const c = await ctx.service.call('POST', '/documents', {
        body: { ...body, title: 'twice' },
        headers: { 'idempotency-key': key },
      });
      equal(
        problemOf(c, 'the same key with another body').code,
        'idempotency_mismatch',
        'code (05 §6.1)',
      );
      equal(c.status, 422, 'the HTTP status of idempotency_mismatch (D61)');
    },
  }),
  s({
    id: 'rest.validation',
    title: 'a body that breaks the schema is validation_failed with JSON Pointers, never the value',
    spec: '05 §6.1; D71',
    covers: { operations: ['POST /documents'], errors: ['validation_failed'] },
    async run(ctx) {
      const secret = `tck-secret-${uuid7()}`;
      const res = await ctx.service.call('POST', '/documents', {
        body: { content: 5, title: { secret } },
      });
      const p = problemOf(res, 'an invalid body');
      equal(p.code, 'validation_failed', 'code');
      equal(res.status, 400, 'the HTTP status of validation_failed (D61)');
      const violations = (res.json as { violations?: unknown }).violations;
      check(
        Array.isArray(violations) && violations.length > 0,
        'violations are listed (D71)',
        'a non-empty list',
        res.json,
      );
      for (const x of violations as unknown[])
        check(
          isObject(x) && typeof x['path'] === 'string' && typeof x['rule'] === 'string',
          'a violation is { path, rule }',
          '{ path, rule }',
          x,
        );
      check(
        !res.text.includes(secret),
        'the problem never repeats the offending value (D71; BE-088)',
        'no value',
        res.text,
      );
      const malformed = await ctx.service.call('POST', '/documents', { rawBody: '{"content":' });
      check(malformed.status === 400, 'a body that is not JSON', 400, malformed.status);
    },
  }),
  s({
    id: 'rest.commits',
    title: 'GET /documents/{id}/commits pages the log after a seq',
    spec: '05 §5.2, §6.2; G55, G63',
    covers: { operations: ['GET /documents/{id}/commits'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'logger', doc, 'editor');
      let base = m.content.seq;
      for (const t of ['1', '2', '3'])
        base = (
          await acked(m.wire, 1, { base, steps: [insertText(posIn(m.content.doc, IDS.end), t)] })
        ).seq;
      const res = await ctx.service.as(m.token, 'GET', `/documents/${doc}/commits`, {
        query: { after: m.content.seq, limit: 2 },
      });
      equal(res.status, 200, 'GET /documents/{id}/commits as an editor');
      const j = res.json;
      check(
        isObject(j) && Array.isArray(j['items']),
        'a list of commits',
        '{ items, nextCursor }',
        j,
      );
      const seqs = (j['items'] as Array<{ seq: number }>).map((c) => c.seq);
      jsonEqual(
        seqs,
        [m.content.seq + 1, m.content.seq + 2],
        'commits after the seq, in order, at most limit',
      );
      for (const c of j['items'] as unknown[]) {
        const v = shapeViolations('RemoteCommit', c);
        check(
          v.length === 0,
          'an item is a commit as sync.commit carries it (G63)',
          'no violations',
          v,
        );
      }
    },
  }),
  s({
    id: 'rest.regions',
    title: 'GET /documents/{id}/regions lists the regions in document order',
    spec: '05 §6.2; D64',
    needs: { features: ['regions'] },
    covers: { operations: ['GET /documents/{id}/regions'] },
    async run(ctx) {
      const doc = await ctx.document();
      const { token } = await ctx.token('viewer', { [doc]: 'viewer' });
      const res = await ctx.service.as(token, 'GET', `/documents/${doc}/regions`);
      equal(res.status, 200, 'GET regions as a viewer (D65)');
      const items = (res.json as { items?: Array<Record<string, unknown>> }).items;
      check(Array.isArray(items), 'a list', '{ items }', res.json);
      jsonEqual(
        items.map((r) => [r['id'], r['title'], r['policy'], r['state']]),
        [
          [IDS.open, 'Open', 'inherit', 'draft'],
          [IDS.locked, 'Locked', 'restricted', 'draft'],
        ],
        'the regions with title, policy and state (D64)',
      );
      check(
        (items[0]!['order'] as number) < (items[1]!['order'] as number),
        'order follows the document',
        'ascending',
        items,
      );
      for (const r of items) {
        const v = shapeViolations('RegionInfo', r);
        check(v.length === 0, 'a region item matches the published schema', 'no violations', v);
      }
    },
  }),
  s({
    id: 'identifiers.table',
    title:
      'every route addressed by a bare identifier that the server announces has a cross-document scenario',
    spec: '05 §6.1; 10 §3.2',
    covers: {},
    async run(ctx) {
      const untested = untestedBareRoutes(ctx.target.features);
      check(
        untested.length === 0,
        'the kit has a cross-document scenario for every announced route addressed by a bare identifier',
        'a scenario for each',
        untested.map((r) => `${r.operation} (${r.feature}): ${r.pending ?? 'no scenario'}`),
      );
      for (const r of bareRoutes())
        ctx.note(
          r.feature === null
            ? `${r.operation}: not announceable (${r.pending ?? 'no feature'})`
            : ctx.has(r.feature)
              ? `${r.operation}: tested by ${r.scenario}`
              : `${r.operation}: \`${r.feature}\` is not announced`,
        );
    },
  }),
  s({
    id: 'identifiers.threads',
    title: 'a thread and a comment are refused to a caller whose token covers another document',
    spec: '05 §6.1; 10 §3.2',
    needs: { features: ['comments'] },
    covers: {
      operations: [
        'GET /threads/{tid}',
        'PATCH /threads/{tid}',
        'DELETE /threads/{tid}',
        'POST /threads/{tid}/comments',
        'PATCH /comments/{cid}',
        'DELETE /comments/{cid}',
      ],
    },
    async run(ctx) {
      const t = await threadOf(ctx);
      const before = await ctx.service.as(t.token, 'GET', `/threads/${t.tid}`);
      equal(before.status, 200, 'GET /threads/{tid} as a commenter of its document');
      // The outsider owns another document, so only the document check can refuse them.
      const other = await ctx.document();
      const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
      const any = { 'if-match': '*' };
      const calls: Array<[string, string, { body?: unknown; headers?: Record<string, string> }]> = [
        ['GET', `/threads/${t.tid}`, {}],
        ['PATCH', `/threads/${t.tid}`, { body: { state: 'resolved' }, headers: any }],
        ['POST', `/threads/${t.tid}/comments`, { body: { body: 'from another document' } }],
        ['PATCH', `/comments/${t.cid}`, { body: { body: 'changed' }, headers: any }],
        ['DELETE', `/comments/${t.cid}`, {}],
        ['DELETE', `/threads/${t.tid}`, {}],
      ];
      for (const [method, path, opts] of calls)
        refusedToOutsider(
          await ctx.service.as(outsider, method, path, opts),
          `${method} ${path.replace(t.tid, '{tid}').replace(t.cid, '{cid}')}`,
        );
      // Nothing the outsider tried took effect.
      const after = await ctx.service.as(t.token, 'GET', `/threads/${t.tid}`);
      equal(after.status, 200, 'the thread is still there for its own document');
      jsonEqual(after.json, before.json, 'the thread is unchanged');
    },
  }),
  s({
    id: 'rest.delete',
    title: 'DELETE /documents/{id} needs manage; a deleted document is not found',
    spec: '05 §6.2; 07 §12 row 10',
    covers: { operations: ['DELETE /documents/{id}'], errors: ['forbidden', 'not_found'] },
    async run(ctx) {
      const doc = await ctx.document();
      const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
      const refused = await ctx.service.as(editor, 'DELETE', `/documents/${doc}`);
      equal(
        problemOf(refused, 'DELETE by an editor').code,
        'forbidden',
        'manage is needed (07 §12 row 10)',
      );
      const etag = (await ctx.service.call('GET', `/documents/${doc}`)).headers.get('etag') ?? '*';
      const { token: owner } = await ctx.token('owner', { [doc]: 'owner' });
      const del = await ctx.service.as(owner, 'DELETE', `/documents/${doc}`, {
        headers: { 'if-match': etag },
      });
      check(del.status === 204 || del.status === 200, 'DELETE by an owner', 204, del.status);
      const gone = await ctx.service.call('GET', `/documents/${doc}`);
      if (gone.status !== 404)
        throw new KitFailure(
          'a deleted document is not found',
          'HTTP 404 not_found',
          `HTTP ${gone.status}`,
        );
      includes(['not_found'], problemOf(gone, 'a deleted document').code, 'code');
    },
  }),
];
