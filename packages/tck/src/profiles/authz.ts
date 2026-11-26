/**
 * The `authz` profile (PRO-115 criteria 1 and 2): every row of the authorisation matrix of 07 §12,
 * read from the authority's published matrix (PRM-056), called once by a caller who lacks the
 * capability (a refusal) and once by one who has it (success). Rows whose routes belong to a feature
 * the target does not announce are skipped with that reason; the routes the matrix leaves out follow
 * decision D65.
 */
import { MATRIX } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { KitFailure, check, equal } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { join, openChannel, problemOf, readContent, submit } from './support.ts';

const a = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('authz', def);

/** A refusal: HTTP 403 with `forbidden` (D61). */
async function refused(
  ctx: ScenarioContext,
  token: string | undefined,
  method: string,
  path: string,
  what: string,
  body?: unknown,
) {
  const res = await ctx.service.as(token, method, path, body === undefined ? {} : { body });
  const p = problemOf(res, what);
  equal(p.code, 'forbidden', `${what}: refused (07 §12)`);
  equal(res.status, 403, `${what}: the HTTP status of forbidden (D61)`);
}

async function succeeds(
  ctx: ScenarioContext,
  token: string,
  method: string,
  path: string,
  what: string,
  opts: { body?: unknown; ifMatch?: string } = {},
) {
  const res = await ctx.service.as(token, method, path, {
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.ifMatch ? { headers: { 'if-match': opts.ifMatch } } : {}),
  });
  check(
    res.status >= 200 && res.status < 300,
    `${what}: allowed (07 §12)`,
    '2xx',
    `HTTP ${res.status} ${res.text.slice(0, 200)}`,
  );
  return res;
}

/** The matrix row, so that a scenario fails loudly if the published matrix loses it. */
function row(id: string) {
  const r = MATRIX.find((x) => x.id === id);
  if (!r)
    throw new KitFailure(
      `the authorisation matrix has no row ${id}`,
      `row ${id} in spec/permissions/permissions-1.json`,
      MATRIX.map((x) => x.id),
    );
  return r;
}

/** The routes of row 13 with concrete identifiers, as a user token would call them. */
function serviceRoutes(doc: string): Array<[string, string, unknown]> {
  return [
    ['GET', '/retention', undefined],
    ['PUT', '/retention', {}],
    ['GET', `/documents/${doc}/retention`, undefined],
    ['PUT', `/documents/${doc}/retention`, {}],
    ['POST', `/documents/${doc}/holds`, {}],
    ['DELETE', `/documents/${doc}/holds/${uuid7()}`, undefined],
    ['GET', '/holds', undefined],
    ['POST', '/tenant-fonts', {}],
    ['DELETE', `/tenant-fonts/${'a'.repeat(64)}`, undefined],
    ['POST', '/users/erase', {}],
    ['POST', `/documents/${doc}/commits/1/tombstone`, {}],
    ['POST', '/templates', {}],
    ['GET', '/templates', undefined],
    ['GET', `/templates/${uuid7()}`, undefined],
    ['POST', '/bulk-sends', {}],
    ['GET', `/bulk-sends/${uuid7()}`, undefined],
    ['POST', '/bundle-exports', {}],
    ['GET', `/bundle-exports/${uuid7()}`, undefined],
    ['GET', '/workflow/capture-settings', undefined],
    ['PUT', '/workflow/capture-settings', {}],
    ['GET', '/history-visibility', undefined],
    ['PUT', '/history-visibility', {}],
    ['GET', `/documents/${doc}/history-visibility`, undefined],
    ['PUT', `/documents/${doc}/history-visibility`, {}],
    ['GET', '/quotas', undefined],
    ['PUT', '/quotas', {}],
    ['GET', '/origins', undefined],
    ['GET', '/keys', undefined],
    ['POST', '/origins', {}],
    ['DELETE', '/origins/https%3A%2F%2Fa.example.test', undefined],
    ['POST', '/keys', {}],
    ['DELETE', '/keys/some-key', undefined],
    ['GET', '/usage', undefined],
    ['GET', '/sealing-keys', undefined],
    ['POST', `/documents/${doc}/imports`, { asset: uuid7(), format: 'docx' }],
    ['PUT', `/documents/${doc}/content`, { cdm: 1, requires: [], doc: {} }],
    ['POST', `/documents/${doc}/fork`, {}],
    ['POST', '/documents', {}],
    ['GET', '/documents', undefined],
    ['GET', '/search', undefined],
    ['GET', '/audit', undefined],
    ['GET', '/webhooks', undefined],
    ['POST', '/webhooks', {}],
    ['GET', `/webhooks/${uuid7()}`, undefined],
    ['PATCH', `/webhooks/${uuid7()}`, {}],
    ['DELETE', `/webhooks/${uuid7()}`, undefined],
    ['POST', `/webhooks/${uuid7()}/ping`, undefined],
    ['POST', `/webhooks/${uuid7()}/deliveries/${uuid7()}/replay`, undefined],
    ['POST', '/tokens', { sub: 'x', docs: { [doc]: 'viewer' } }],
    ['POST', '/agents', { name: 'x' }],
    ['POST', '/sessions/revoke', { sub: 'x' }],
  ];
}

/** A thread on a one-character range of the intro block, as a commenter would start it (05 §6.2). */
function threadRequest(seq: number, doc: unknown) {
  const from = posIn(doc, IDS.intro);
  return {
    target: { range: { from, to: from + 1, baseSeq: seq } },
    comment: { body: [{ type: 'text', text: 'authz' }] },
  };
}

export const AUTHZ: ProfileDef = {
  id: 'authz',
  title: 'Every row of the authorisation matrix, refused and allowed',
  spec: '07 §12; 05 §6.1; D65',
  stories: ['PRO-115'],
  requires: { kind: 'mode', mode: 'authority' },
  scenarios: [
    a({
      id: 'read.head',
      title: 'row 1: content at the head and a channel need view on the document',
      spec: '07 §12 row 1',
      covers: {
        operations: ['GET /documents/{id}/content'],
        messages: ['ch.open', 'ch.rejected'],
        errors: ['forbidden'],
      },
      async run(ctx) {
        row('read.head');
        const doc = await ctx.document();
        const other = await ctx.document();
        const outsider = await ctx.session('outsider', { [other]: 'owner' });
        await refused(
          ctx,
          outsider.token,
          'GET',
          `/documents/${doc}/content`,
          'content without view',
        );
        const r = await openChannel(ctx, outsider.wire, 1, doc, {});
        check(
          r.t === 'ch.rejected' && r.d.code === 'forbidden',
          'a channel without view',
          'ch.rejected forbidden',
          r,
        );
        const viewer = await ctx.session('viewer', { [doc]: 'viewer' });
        await succeeds(ctx, viewer.token, 'GET', `/documents/${doc}/content`, 'content with view');
        const ok = await openChannel(ctx, viewer.wire, 1, doc, {});
        equal(ok.t, 'ch.opened', 'a channel with view');
      },
    }),
    a({
      id: 'read.history',
      title: 'row 2: content at an earlier seq needs view and the history gate',
      spec: '07 §12 row 2, §8; ADR 0034 (proposed)',
      covers: { operations: ['GET /documents/{id}/content'] },
      async run(ctx) {
        row('read.history');
        const doc = await ctx.document();
        const m = await join(ctx, 'writer', doc, 'editor');
        const r = await submit(m.wire, 1, {
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'h')],
        });
        check(r.t === 'sync.ack', 'a commit to make history', 'sync.ack', r);
        await succeeds(
          ctx,
          m.token,
          'GET',
          `/documents/${doc}/content?seq=${m.content.seq}`,
          'an editor reads an earlier seq',
        );
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        await refused(
          ctx,
          outsider,
          'GET',
          `/documents/${doc}/content?seq=${m.content.seq}`,
          'an earlier seq without view',
        );
        if (ctx.config.historyVisibility !== 'editors')
          return ctx.note('the viewer half depends on ADR 0034 `editors`');
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const res = await ctx.service.as(viewer, 'GET', `/documents/${doc}/content`, {
          query: { seq: m.content.seq },
        });
        check(
          res.status >= 400,
          'a viewer may not read below the history gate (07 §8; ADR 0034 default `editors`)',
          'a refusal',
          `HTTP ${res.status}`,
        );
      },
    }),
    a({
      id: 'commit',
      title: 'row 3: a commit needs the capabilities of the outcome check',
      spec: '07 §12 row 3, §5',
      covers: {
        messages: ['sync.submit', 'sync.reject', 'sync.ack'],
        errors: ['permission_denied'],
      },
      async run(ctx) {
        row('commit');
        const doc = await ctx.document();
        const v = await join(ctx, 'viewer', doc, 'viewer');
        const r = await submit(v.wire, 1, {
          base: v.content.seq,
          steps: [insertText(posIn(v.content.doc, IDS.intro), 'v')],
        });
        check(
          r.t === 'sync.reject' && r.d.code === 'permission_denied',
          'a viewer commit',
          'sync.reject permission_denied',
          r,
        );
        const e = await join(ctx, 'editor', doc, 'editor');
        const ok = await submit(e.wire, 1, {
          base: e.content.seq,
          steps: [insertText(posIn(e.content.doc, IDS.intro), 'e')],
        });
        equal(ok.t, 'sync.ack', 'an editor commit');
      },
    }),
    a({
      id: 'manage',
      title: 'row 10: grants, region states and deletion need manage',
      spec: '07 §12 row 10',
      needs: { features: ['regions'] },
      covers: {
        operations: [
          'PATCH /documents/{id}/grants',
          'PUT /documents/{id}/regions/{rid}/state',
          'DELETE /documents/{id}',
          'GET /documents/{id}/grants',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        row('manage');
        const doc = await ctx.document();
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        const { token: owner } = await ctx.token('owner', { [doc]: 'owner' });
        const etag =
          (await ctx.service.call('GET', `/documents/${doc}/grants`)).headers.get('etag') ?? '*';
        await refused(ctx, editor, 'PATCH', `/documents/${doc}/grants`, 'grants by an editor', {
          grants: [],
        });
        await succeeds(ctx, owner, 'PATCH', `/documents/${doc}/grants`, 'grants by an owner', {
          body: { grants: [] },
          ifMatch: etag,
        });
        const state = await ctx.service.as(
          editor,
          'PUT',
          `/documents/${doc}/regions/${IDS.locked}/state`,
          { body: { state: 'in_review' }, headers: { 'if-match': '*' } },
        );
        equal(
          problemOf(state, 'a region state by an editor').code,
          'forbidden',
          'a region state by an editor (07 §12 row 10)',
        );
        await succeeds(
          ctx,
          owner,
          'PUT',
          `/documents/${doc}/regions/${IDS.locked}/state`,
          'a region state by an owner',
          { body: { state: 'in_review' }, ifMatch: '*' },
        );
        await refused(ctx, editor, 'DELETE', `/documents/${doc}`, 'deletion by an editor');
        const metaTag =
          (await ctx.service.call('GET', `/documents/${doc}`)).headers.get('etag') ?? '*';
        await succeeds(ctx, owner, 'DELETE', `/documents/${doc}`, 'deletion by an owner', {
          ifMatch: metaTag,
        });
      },
    }),
    a({
      id: 'export',
      title: 'row 12: an export needs view and no no-export restriction',
      spec: '07 §12 row 12',
      needs: { features: ['exports'] },
      covers: { operations: ['POST /documents/{id}/exports'], errors: ['forbidden'] },
      async run(ctx) {
        row('export');
        const doc = await ctx.document();
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        await refused(
          ctx,
          outsider,
          'POST',
          `/documents/${doc}/exports`,
          'an export without view',
          { target: 'pdf' },
        );
        const { token: restricted } = await ctx.token(
          'restricted',
          { [doc]: 'owner' },
          { restrict: ['no-export'] },
        );
        await refused(
          ctx,
          restricted,
          'POST',
          `/documents/${doc}/exports`,
          'an export restricted with no-export',
          { target: 'pdf' },
        );
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const res = await ctx.service.as(viewer, 'POST', `/documents/${doc}/exports`, {
          body: { target: 'pdf' },
        });
        equal(res.status, 202, 'an export by a viewer');
      },
    }),
    a({
      id: 'service',
      title: 'row 13: the routes of the service credential refuse every user token',
      spec: '07 §12 row 13; 05 §3.2, §6.2',
      covers: {
        operations: [
          'GET /retention',
          'PUT /retention',
          'GET /documents/{id}/retention',
          'PUT /documents/{id}/retention',
          'POST /documents/{id}/holds',
          'DELETE /documents/{id}/holds/{holdId}',
          'GET /holds',
          'POST /tenant-fonts',
          'DELETE /tenant-fonts/{sha256}',
          'POST /users/erase',
          'POST /documents/{id}/commits/{seq}/tombstone',
          'POST /templates',
          'GET /templates',
          'GET /templates/{tid}',
          'POST /bulk-sends',
          'GET /bulk-sends/{bid}',
          'POST /bundle-exports',
          'GET /bundle-exports/{bid}',
          'GET /workflow/capture-settings',
          'PUT /workflow/capture-settings',
          'GET /history-visibility',
          'PUT /history-visibility',
          'GET /documents/{id}/history-visibility',
          'PUT /documents/{id}/history-visibility',
          'GET /quotas',
          'PUT /quotas',
          'GET /origins',
          'GET /keys',
          'POST /origins',
          'DELETE /origins/{origin}',
          'POST /keys',
          'DELETE /keys/{kid}',
          'GET /usage',
          'GET /sealing-keys',
          'POST /documents/{id}/imports',
          'PUT /documents/{id}/content',
          'POST /documents/{id}/fork',
          'POST /documents',
          'GET /documents',
          'GET /search',
          'GET /audit',
          'GET /webhooks',
          'POST /webhooks',
          'GET /webhooks/{id}',
          'PATCH /webhooks/{id}',
          'DELETE /webhooks/{id}',
          'POST /webhooks/{id}/ping',
          'POST /webhooks/{id}/deliveries/{deliveryId}/replay',
          'POST /tokens',
          'POST /agents',
          'POST /sessions/revoke',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const r = row('service');
        const doc = await ctx.document();
        const { token } = await ctx.token('owner', { [doc]: 'owner' });
        const routes = serviceRoutes(doc);
        check(
          routes.length === r.routes.length,
          'the kit calls every route of row 13',
          r.routes,
          routes.map(([m, p]) => `${m} ${p}`),
        );
        for (const [method, path, body] of routes)
          await refused(ctx, token, method, path, `${method} ${path} with a user token`, body);
        await succeeds(
          ctx,
          ctx.target.config.credential,
          'GET',
          '/documents',
          'GET /documents with the service credential',
        );
        await succeeds(
          ctx,
          ctx.target.config.credential,
          'POST',
          '/tokens',
          'POST /tokens with the service credential',
          { body: { sub: ctx.sub('minted'), docs: { [doc]: 'viewer' } } },
        );
      },
    }),
    a({
      id: 'operator',
      title: 'row 14: the tenant routes refuse a user token and a service credential',
      spec: '07 §12 row 14; 05 §3.2, §6.2; decision 68',
      covers: {
        operations: [
          'GET /tenants',
          'POST /tenants',
          'GET /tenants/{tenantId}',
          'PATCH /tenants/{tenantId}',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const r = row('operator');
        const doc = await ctx.document();
        const { token } = await ctx.token('owner', { [doc]: 'owner' });
        const tenant = uuid7();
        const routes: Array<[string, string, unknown]> = [
          ['GET', '/tenants', undefined],
          ['POST', '/tenants', { name: 'kit' }],
          ['GET', `/tenants/${tenant}`, undefined],
          ['PATCH', `/tenants/${tenant}`, { state: 'suspended' }],
        ];
        check(
          routes.length === r.routes.length,
          'the kit calls every route of row 14',
          r.routes,
          routes.map(([m, p]) => `${m} ${p}`),
        );
        for (const [method, path, body] of routes) {
          await refused(ctx, token, method, path, `${method} ${path} with a user token`, body);
          // The tenant's own administrator credential is not an operator credential either.
          await refused(
            ctx,
            ctx.target.config.credential,
            method,
            path,
            `${method} ${path} with the service credential`,
            body,
          );
        }
      },
    }),
    a({
      id: 'unmatrixed',
      title: 'routes without a row: regions need view, grants and metadata need manage (D65)',
      spec: '07 §12; D65; G80',
      needs: { features: ['regions'] },
      covers: {
        operations: [
          'GET /documents/{id}/regions',
          'GET /documents/{id}/grants',
          'PATCH /documents/{id}',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        const { token: owner } = await ctx.token('owner', { [doc]: 'owner' });
        await refused(ctx, outsider, 'GET', `/documents/${doc}/regions`, 'regions without view');
        await succeeds(ctx, viewer, 'GET', `/documents/${doc}/regions`, 'regions with view');
        await refused(ctx, editor, 'GET', `/documents/${doc}/grants`, 'grants without manage');
        await succeeds(ctx, owner, 'GET', `/documents/${doc}/grants`, 'grants with manage');
        await refused(ctx, editor, 'PATCH', `/documents/${doc}`, 'metadata without manage', {
          title: 'x',
        });
        const etag =
          (await ctx.service.call('GET', `/documents/${doc}`)).headers.get('etag') ?? '*';
        await succeeds(ctx, owner, 'PATCH', `/documents/${doc}`, 'metadata with manage', {
          body: { title: 'y' },
          ifMatch: etag,
        });
        const content = await readContent(ctx, viewer, doc);
        check(content.seq >= 0, 'the viewer still reads the content', '≥ 0', content.seq);
      },
    }),
    a({
      id: 'thread.create',
      title: 'row 4: a thread needs comment in the scopes of its target',
      spec: '07 §12 row 4',
      needs: { features: ['comments'] },
      covers: { operations: ['POST /documents/{id}/threads'], errors: ['forbidden'] },
      async run(ctx) {
        row('thread.create');
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: commenter } = await ctx.token('commenter', { [doc]: 'commenter' });
        const content = await readContent(ctx, commenter, doc);
        await refused(
          ctx,
          viewer,
          'POST',
          `/documents/${doc}/threads`,
          'a thread by a viewer',
          threadRequest(content.seq, content.doc),
        );
        await succeeds(
          ctx,
          commenter,
          'POST',
          `/documents/${doc}/threads`,
          'a thread by a commenter',
          {
            body: threadRequest(content.seq, content.doc),
          },
        );
      },
    }),
    a({
      id: 'thread.update',
      title: 'row 5: resolving a thread needs comment in its scope',
      spec: '07 §12 row 5',
      needs: { features: ['comments'] },
      covers: { operations: ['PATCH /threads/{tid}'], errors: ['forbidden'] },
      async run(ctx) {
        row('thread.update');
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: commenter } = await ctx.token('commenter', { [doc]: 'commenter' });
        const content = await readContent(ctx, commenter, doc);
        const made = await succeeds(
          ctx,
          commenter,
          'POST',
          `/documents/${doc}/threads`,
          'a thread to resolve',
          { body: threadRequest(content.seq, content.doc) },
        );
        const tid = (made.json as { id?: unknown } | undefined)?.id;
        check(typeof tid === 'string', 'the created thread has an id', 'a string', made.json);
        const path = `/threads/${String(tid)}`;
        const denied = await ctx.service.as(viewer, 'PATCH', path, {
          body: { state: 'resolved' },
          headers: { 'if-match': '*' },
        });
        equal(
          problemOf(denied, 'a resolve by a viewer').code,
          'forbidden',
          'a resolve by a viewer',
        );
        equal(denied.status, 403, 'a resolve by a viewer: HTTP 403 (D61)');
        await succeeds(ctx, commenter, 'PATCH', path, 'a resolve by a commenter', {
          body: { state: 'resolved' },
          ifMatch: '*',
        });
      },
    }),
    a({
      id: 'version.create',
      title: 'row 8: a named version needs edit somewhere',
      spec: '07 §12 row 8',
      needs: { features: ['history'] },
      covers: { operations: ['POST /documents/{id}/versions'], errors: ['forbidden'] },
      async run(ctx) {
        row('version.create');
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        await refused(
          ctx,
          viewer,
          'POST',
          `/documents/${doc}/versions`,
          'a named version by a viewer',
          { name: 'authz' },
        );
        await succeeds(
          ctx,
          editor,
          'POST',
          `/documents/${doc}/versions`,
          'a named version by an editor',
          {
            body: { name: 'authz' },
          },
        );
      },
    }),
    a({
      id: 'restore.region',
      title: 'row 9: restoring a region needs edit in that region',
      spec: '07 §12 row 9',
      needs: { features: ['history'] },
      covers: { operations: ['POST /documents/{id}/restore'], errors: ['forbidden'] },
      async run(ctx) {
        row('restore.region');
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        const content = await readContent(ctx, editor, doc);
        // dryRun: the authorisation is what this scenario proves; nothing is stored.
        const body = { toSeq: content.seq, region: IDS.open, dryRun: true };
        await refused(
          ctx,
          viewer,
          'POST',
          `/documents/${doc}/restore`,
          'a region restore by a viewer',
          body,
        );
        await succeeds(
          ctx,
          editor,
          'POST',
          `/documents/${doc}/restore`,
          'a region restore by an editor',
          {
            body,
          },
        );
      },
    }),
    a({
      id: 'lease.acquire',
      title: 'row 11: a lease needs edit in the region',
      spec: '07 §12 row 11; 07 §10',
      needs: { features: ['leases'] },
      covers: { operations: ['POST /documents/{id}/regions/{rid}/lease'], errors: ['forbidden'] },
      async run(ctx) {
        row('lease.acquire');
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        const path = `/documents/${doc}/regions/${IDS.open}/lease`;
        await refused(ctx, viewer, 'POST', path, 'a lease by a viewer');
        await succeeds(ctx, editor, 'POST', path, 'a lease by an editor');
      },
    }),
    a({
      id: 'asset.upload',
      title:
        'row 6: an upload needs edit, suggest or fill somewhere, and its uploader completes it',
      spec: '07 §12 row 6; 05 §6.2',
      needs: { features: ['assets'] },
      covers: {
        operations: ['POST /documents/{id}/assets', 'POST /assets/{aid}/complete'],
        errors: ['forbidden'],
      },
      async run(ctx) {
        row('asset.upload');
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        const { token: other } = await ctx.token('other-editor', { [doc]: 'editor' });
        const request = { filename: 'authz.png', mime: 'image/png', size: 64 };
        await refused(
          ctx,
          viewer,
          'POST',
          `/documents/${doc}/assets`,
          'an upload by a viewer',
          request,
        );
        const created = await succeeds(
          ctx,
          editor,
          'POST',
          `/documents/${doc}/assets`,
          'an upload by an editor',
          { body: request },
        );
        const id = (JSON.parse(created.text) as { asset?: unknown }).asset;
        check(typeof id === 'string', 'the identifier of the upload', 'a string', created.text);
        const path = `/assets/${String(id)}/complete`;
        await refused(ctx, other, 'POST', path, 'completion by an editor who is not the uploader');
        await succeeds(ctx, editor, 'POST', path, 'completion by the uploader');
      },
    }),
    a({
      id: 'asset.read',
      title: 'row 7: resolving asset URLs needs view on the document',
      spec: '07 §12 row 7; 05 §6.2',
      needs: { features: ['assets'] },
      covers: { operations: ['POST /documents/{id}/assets/resolve'], errors: ['forbidden'] },
      async run(ctx) {
        row('asset.read');
        const doc = await ctx.document();
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const body = { assets: [uuid7()] };
        const path = `/documents/${doc}/assets/resolve`;
        await refused(ctx, outsider, 'POST', path, 'resolving without view', body);
        await succeeds(ctx, viewer, 'POST', path, 'resolving with view', { body });
      },
    }),
    a({
      id: 'actor.user-token',
      title: 'DEP-Actor on a user token has no effect: the caller stays the token holder',
      spec: '05 §3.2; 07 §12; UX-096',
      needs: { features: ['regions'] },
      covers: { operations: ['GET /documents/{id}/grants'], errors: ['forbidden'] },
      async run(ctx) {
        const doc = await ctx.document();
        const { token: editor } = await ctx.token('editor', { [doc]: 'editor' });
        await ctx.token('owner', { [doc]: 'owner' });
        const path = `/documents/${doc}/grants`;
        // An editor may not read the grants (row 10). Naming the owner changes nothing.
        for (const actor of ['owner', 'tck-no-such-user']) {
          const res = await ctx.service.as(editor, 'GET', path, {
            headers: { 'dep-actor': actor },
          });
          const p = problemOf(res, `a user token naming ${actor} in DEP-Actor`);
          equal(p.code, 'forbidden', 'a user token never becomes another person (UX-096)');
          equal(res.status, 403, 'the HTTP status of forbidden (D61)');
        }
      },
    }),
    a({
      id: 'actor.opaque',
      title: 'a service credential names the actor by an opaque identifier, and no other value',
      spec: '05 §3.2; UX-096',
      covers: { operations: ['GET /documents'], errors: ['validation_failed'] },
      async run(ctx) {
        // 1 to 255 characters, no whitespace and no control characters (05 §3.2).
        for (const actor of ['not an identifier', 'two\twords', 'x'.repeat(256)]) {
          const res = await ctx.service.call('GET', '/documents', {
            headers: { 'dep-actor': actor },
          });
          const p = problemOf(res, `DEP-Actor ${JSON.stringify(actor.slice(0, 20))}`);
          equal(p.code, 'validation_failed', 'a malformed DEP-Actor is refused (UX-096)');
          equal(res.status, 400, 'the HTTP status of validation_failed');
        }
      },
    }),
    ...MATRIX.filter(
      (r) =>
        ![
          'read.head',
          'read.history',
          'commit',
          'manage',
          'export',
          'service',
          'operator',
          'thread.create',
          'thread.update',
          'version.create',
          'restore.region',
          'lease.acquire',
          'asset.upload',
          'asset.read',
        ].includes(r.id),
    ).map((r) =>
      a({
        id: r.id,
        title: `row ${r.row}: ${r.operation}`,
        spec: `07 §12 row ${r.row}`,
        covers: {},
        async run(ctx) {
          // Every row of the matrix of 2026-11 has a scenario above; a row added later without one
          // is reported as skipped, so that the gap shows in the report.
          ctx.skip(
            `row ${r.row} (${r.routes.join(', ') || 'no route'}) has no scenario yet: add one in this profile`,
          );
        },
      }),
    ),
  ],
};
