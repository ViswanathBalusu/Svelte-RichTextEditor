/**
 * The negative tests of the authorisation matrix that PRM-057 asks for, packaged as scenarios of the
 * `perm-doc` and `perm-region` profiles (07 §12 rows 1, 3, 6, 10, 12 and 13). Each scenario calls
 * one row as a caller who lacks the capability (a refusal) and as one who has it (success). They
 * run against every target; a scenario whose feature the target does not announce is skipped with
 * that reason (the mock backend has no assets or exports). `profiles/perm.ts` lists them.
 *
 * Row 7 (`asset-read`) needs a service whose uploads are checked: an object store and an asset
 * worker. A run against a service without them selects the other scenarios with `scenarios` (the
 * run of `packages/tck/test/prm-057-matrix.test.ts` on in-memory storage does); the run on the
 * S3-compatible store of the test environment includes it
 * (`prm-057-asset-read.pg.test.ts` in the document service's tests).
 *
 * Row 13 in the kit refuses a user token whose header and claims were rewritten to name a service
 * identity (the kit holds no signing key, so the original signature stays and no longer matches).
 * A token that the service itself signed with service claims is tested only in
 * `tests/security/test/permission-matrix.test.ts`, which holds the service's key.
 */
import { DOC_ROLES } from '@docedit/authority';
import { check, equal, isObject } from '../assert.ts';
import {
  IDS,
  nodeById,
  nodeSize,
  posBefore,
  posIn,
  setAttr,
  textOf,
  type JsonNode,
} from '../documents.ts';
import { scenario, type ScenarioDef } from '../scenario.ts';
import { ASSET_EVENT_WAIT_MS, PNG, awaitAssetEvent, upload } from './jobs.ts';
import { acked, claimsOf, join, openChannel, problemOf, rejected } from './support.ts';

type Def = Omit<ScenarioDef, 'id'> & { id: string };
const doc = (def: Def) => scenario('perm-doc', def);
const reg = (def: Def) => scenario('perm-region', def);

const WRAPPED = 'rWrapped00000001';

/** A step that wraps the block with `id` in a new, empty `inherit` region (PRM-011). */
function wrapStep(content: unknown, id: string): Record<string, unknown> {
  const from = posBefore(content, id);
  const node = nodeById(content, id) as JsonNode;
  const size = nodeSize(node);
  return {
    stepType: 'replaceAround',
    from,
    to: from + size,
    gapFrom: from,
    gapTo: from + size,
    insert: 1,
    structure: true,
    slice: {
      content: [{ type: 'region', attrs: { id: WRAPPED, title: 'Wrapped', policy: 'inherit' } }],
    },
  };
}

export const PERM_DOC_MATRIX: ScenarioDef[] = [
  doc({
    id: 'view-required',
    title:
      'row 1: without view a connection cannot open a channel, read the head or send presence; with view it sees every region',
    spec: '07 §12 row 1; PRM-057',
    covers: {
      operations: ['GET /documents/{id}/content'],
      messages: ['ch.open', 'ch.rejected', 'presence.update'],
      errors: ['forbidden'],
    },
    async run(ctx) {
      const d = await ctx.document();
      const other = await ctx.document();
      const outsider = await ctx.session('outsider', { [other]: 'owner' });
      const r = await openChannel(ctx, outsider.wire, 1, d, {});
      check(
        r.t === 'ch.rejected' && r.d.code === 'forbidden',
        'a channel without view',
        'ch.rejected forbidden',
        r,
      );
      // Presence on a channel it never opened must not reach anyone who can see the document.
      const viewer = await join(ctx, 'viewer', d, 'viewer');
      const mark = viewer.wire.mark();
      outsider.wire.send({
        t: 'presence.update',
        ch: 1,
        d: {
          seq: 0,
          state: { selection: { anchor: 1, head: 1 }, scope: 'body', status: 'active' },
        },
      });
      await ctx.sleep(300);
      const heard = JSON.stringify(viewer.wire.messages.slice(mark));
      check(
        !heard.includes(outsider.sub),
        'presence from a connection without view reaches nobody',
        'no message that names the outsider',
        heard.slice(0, 200),
      );
      const head = await ctx.service.as(outsider.token, 'GET', `/documents/${d}/content`);
      equal(problemOf(head, 'content without view').code, 'forbidden', 'content without view');
      // With view the same document opens, and a restricted region's text is part of the content.
      for (const [id, what] of [
        [IDS.lockedPara, 'a restricted region'],
        [IDS.openPara, 'an inherit region'],
      ] as const)
        check(
          textOf(viewer.content.doc, id).length > 0,
          `a viewer reads the text of ${what}`,
          'text',
          textOf(viewer.content.doc, id),
        );
    },
  }),
  doc({
    id: 'export-view',
    title: 'row 12: an export without view is refused, with view it is accepted',
    spec: '07 §12 row 12; PRM-057',
    needs: { features: ['exports'] },
    covers: { operations: ['POST /documents/{id}/exports'], errors: ['forbidden'] },
    async run(ctx) {
      const d = await ctx.document();
      const other = await ctx.document();
      const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
      const refused = await ctx.service.as(outsider, 'POST', `/documents/${d}/exports`, {
        body: { target: 'pdf' },
      });
      equal(
        problemOf(refused, 'an export without view').code,
        'forbidden',
        'an export without view',
      );
      const { token: viewer } = await ctx.token('viewer', { [d]: 'viewer' });
      const ok = await ctx.service.as(viewer, 'POST', `/documents/${d}/exports`, {
        body: { target: 'pdf' },
      });
      equal(ok.status, 202, 'an export by a viewer');
    },
  }),
  doc({
    id: 'service-routes',
    title: 'row 13: no document role, not even owner, opens a route of the service credential',
    spec: '07 §12 row 13; 05 §3.2; PRM-057',
    covers: {
      operations: ['GET /documents', 'GET /audit', 'POST /tokens', 'POST /sessions/revoke'],
      errors: ['forbidden'],
    },
    async run(ctx) {
      const d = await ctx.document();
      for (const role of DOC_ROLES) {
        const { token } = await ctx.token(role, { [d]: role });
        for (const [method, path, body] of [
          ['GET', '/documents', undefined],
          ['GET', '/audit', undefined],
          ['POST', '/tokens', { sub: 'x', docs: { [d]: 'owner' } }],
          ['POST', '/sessions/revoke', { sub: 'x' }],
        ] as const) {
          const res = await ctx.service.as(token, method, path, body === undefined ? {} : { body });
          equal(
            problemOf(res, `${method} ${path} as ${role}`).code,
            'forbidden',
            `${method} ${path} with the user token of a ${role}`,
          );
        }
      }
      // A user token whose header and claims were rewritten to name a service identity, with the
      // signature it had: the signature no longer covers it, so the token is refused.
      const { token: owner } = await ctx.token('owner', { [d]: 'owner' });
      const { header, payload } = claimsOf(owner);
      const part = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
      const rewritten = [
        part({ ...header, typ: 'dep-svc+jwt' }),
        part({ ...payload, scope: 'service', svc: true, iss: 'host-backend' }),
        owner.split('.')[2],
      ].join('.');
      for (const [method, path] of [
        ['GET', '/documents'],
        ['GET', '/audit'],
      ] as const) {
        const res = await ctx.service.as(rewritten, method, path);
        check(
          res.status === 401 || res.status === 403,
          `${method} ${path} with a user token rewritten to claim a service identity`,
          '401 or 403',
          `HTTP ${res.status} ${res.text.slice(0, 120)}`,
        );
      }
      const ok = await ctx.service.as(ctx.target.config.credential, 'GET', '/documents');
      check(ok.status === 200, 'the service credential lists documents', 200, `HTTP ${ok.status}`);
    },
  }),
  doc({
    id: 'asset-upload',
    title:
      'row 6: a viewer or a commenter cannot upload an asset; a suggester, a filler or an editor can',
    spec: '07 §12 row 6; PRM-057',
    needs: { features: ['assets'] },
    covers: { operations: ['POST /documents/{id}/assets'], errors: ['forbidden'] },
    async run(ctx) {
      const d = await ctx.document();
      const body = { filename: 'tck.png', mime: 'image/png', size: PNG.length };
      for (const role of ['viewer', 'commenter'] as const) {
        const { token } = await ctx.token(role, { [d]: role });
        const res = await ctx.service.as(token, 'POST', `/documents/${d}/assets`, { body });
        equal(problemOf(res, `an upload by a ${role}`).code, 'forbidden', `an upload by a ${role}`);
        check(
          !(isObject(res.json) && 'asset' in res.json),
          `a ${role} gets no asset identifier`,
          'no asset',
          res.json,
        );
      }
      for (const role of ['suggester', 'filler', 'editor'] as const) {
        const { token } = await ctx.token(role, { [d]: role });
        const res = await ctx.service.as(token, 'POST', `/documents/${d}/assets`, { body });
        check(
          res.status === 200 || res.status === 201,
          `an upload by a ${role} (a capability somewhere)`,
          '200 or 201',
          `HTTP ${res.status} ${res.text.slice(0, 160)}`,
        );
      }
    },
  }),
  doc({
    id: 'asset-read',
    title:
      'row 7: a viewer of the document an asset is attached to resolves it to a signed URL; a caller with no view on that document is refused',
    spec: '07 §12 row 7; 05 §6.2; PRM-057',
    needs: { features: ['assets'] },
    timeoutMs: ASSET_EVENT_WAIT_MS + 60_000,
    covers: {
      operations: ['POST /documents/{id}/assets/resolve'],
      events: ['asset.ready'],
      errors: ['forbidden'],
    },
    async run(ctx) {
      const d = await ctx.document();
      const other = await ctx.document();
      // An editor uploads an image, waits until the check has passed and attaches it to the body.
      const e = await join(ctx, 'uploader', d, 'editor');
      const from = e.wire.mark();
      const aid = await upload(ctx, e.token, d, PNG, 'image/png');
      await awaitAssetEvent(ctx, e, d, 'asset.ready', aid, from);
      await acked(e.wire, e.ch, {
        base: e.content.seq,
        steps: [
          {
            stepType: 'replace',
            from: posIn(e.content.doc, IDS.intro),
            to: posIn(e.content.doc, IDS.intro),
            slice: {
              content: [{ type: 'image', attrs: { asset: aid, width: 100, height: 100 } }],
            },
          },
        ] as never,
      });
      const urlOf = (json: unknown): string | undefined =>
        (json as { assets?: Array<{ asset: string; url: string }> }).assets?.find(
          (u) => u.asset === aid,
        )?.url;
      // A viewer of the attached document reads it.
      const { token: viewer } = await ctx.token('viewer', { [d]: 'viewer' });
      const ok = await ctx.service.as(viewer, 'POST', `/documents/${d}/assets/resolve`, {
        body: { assets: [aid] },
      });
      equal(ok.status, 200, 'a viewer resolves the asset of the document');
      check(
        /^https?:\/\//.test(urlOf(ok.json) ?? ''),
        'the viewer gets a signed URL for the asset',
        'an http or https URL',
        ok.json,
      );
      // A caller with a role on another document only has no view on this one.
      const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
      const refused = await ctx.service.as(outsider, 'POST', `/documents/${d}/assets/resolve`, {
        body: { assets: [aid] },
      });
      equal(
        problemOf(refused, 'a resolve without view').code,
        'forbidden',
        'a resolve without view on the document',
      );
      check(
        !JSON.stringify(refused.json).includes('http'),
        'a refused resolve carries no URL',
        'no URL',
        refused.json,
      );
      // The same asset asked for through the other document is not resolved for its owner.
      const through = await ctx.service.as(outsider, 'POST', `/documents/${other}/assets/resolve`, {
        body: { assets: [aid] },
      });
      check(
        through.status >= 400 || urlOf(through.json) === undefined,
        'an asset is not resolved through a document it is not attached to',
        'a refusal or no URL',
        through.json,
      );
    },
  }),
];

export const PERM_REGION_MATRIX: ScenarioDef[] = [
  reg({
    id: 'wrap-structure',
    title:
      'row 3 (PRM-011): wrapping body content in a new region needs structure: a filler is refused, an editor is accepted',
    spec: '07 §5, §12 row 3; PRM-011; PRM-057',
    covers: {
      messages: ['sync.submit', 'sync.ack', 'sync.reject'],
      errors: ['permission_denied'],
    },
    async run(ctx) {
      const d = await ctx.document();
      const f = await join(ctx, 'filler', d, 'filler');
      const refused = await rejected(f.wire, f.ch, {
        base: f.content.seq,
        steps: [wrapStep(f.content.doc, IDS.intro)] as never,
      });
      equal(refused.code, 'permission_denied', 'a filler wrapping body content in a region');
      const e = await join(ctx, 'editor', d, 'editor');
      await acked(e.wire, e.ch, {
        base: e.content.seq,
        steps: [wrapStep(e.content.doc, IDS.intro)] as never,
      });
    },
  }),
  reg({
    id: 'manage-only',
    title:
      'row 10: grants, a region policy and the deletion of the document need manage; an editor is refused, an owner is not',
    spec: '07 §12 row 10; PRM-057',
    covers: {
      operations: ['PATCH /documents/{id}/grants', 'DELETE /documents/{id}'],
      messages: ['sync.submit', 'sync.reject'],
      errors: ['forbidden', 'permission_denied'],
    },
    async run(ctx) {
      const d = await ctx.document();
      const { token: editor } = await ctx.token('editor', { [d]: 'editor' });
      const grants = await ctx.service.as(editor, 'PATCH', `/documents/${d}/grants`, {
        body: { grants: [] },
        headers: { 'if-match': '*' },
      });
      equal(problemOf(grants, 'grants by an editor').code, 'forbidden', 'grants by an editor');
      const m = await join(ctx, 'policy', d, 'editor');
      const policy = await rejected(m.wire, m.ch, {
        base: m.content.seq,
        steps: [setAttr(posBefore(m.content.doc, IDS.locked), 'policy', 'inherit')],
      });
      equal(policy.code, 'permission_denied', 'a policy change by an editor');
      const removed = await ctx.service.as(editor, 'DELETE', `/documents/${d}`);
      equal(problemOf(removed, 'deletion by an editor').code, 'forbidden', 'deletion by an editor');
      // The refusals changed nothing: the document is still there for its owner.
      const { token: owner } = await ctx.token('owner', { [d]: 'owner' });
      const still = await ctx.service.as(owner, 'GET', `/documents/${d}/content`);
      equal(still.status, 200, 'the document survives the refused deletion');
    },
  }),
];
