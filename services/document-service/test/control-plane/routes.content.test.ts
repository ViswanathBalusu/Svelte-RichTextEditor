// Content reads, the region list, region grants and revocation, over real HTTP against an
// in-process service, with in-memory storage and with PostgreSQL (BE-036, PRO-049, PRO-051,
// PRO-052, PRM-018; BE-001 criterion 3; ADR 0019 through one function per visibility class).
import { threadId } from 'node:worker_threads';
import { NOTHING_HIDDEN, type StoredCommit, type Visibility } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { readDocument } from '@docedit/model/validate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const OPEN = 'rOpen00000000001';
const INTRO = 'pIntro0000000001';

/** A test policy: the legal region is hidden from everyone but owners and its grantees. */
const visibility: Visibility = (conn, _doc, perms) =>
  conn.role === 'owner' ||
  perms.grants.some((g) => g.region === LEGAL && g.principal === `user:${conn.sub}`)
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

/** Position inside the start of the node with `id`, in the content of `doc`. */
function posIn(doc: unknown, id: string): { inside: number; before: number; after: number } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { inside: number; before: number; after: number } | null = null;
  root.descendants((n, pos) => {
    if (n.attrs['id'] === id) found = { inside: pos + 1, before: pos, after: pos + n.nodeSize };
    return !found;
  });
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

/** Appends commits as a room would, conditional on epoch, head and grants revision. */
async function append(
  h: Harness,
  doc: string,
  steps: unknown[][],
  extra: Partial<StoredCommit> = {},
): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const commits = steps.map((s, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: s as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
    ...extra,
  }));
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits,
  });
  expect(r.status).toBe('ok');
  return head.seq + steps.length;
}

const typing = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`content, regions and grants over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          views: { ...FULL_VIEWS, visibility },
        });
    });
    afterAll(async () => {
      await h?.close();
    });
    const create = () => h.createDocument({ content: documentWithRegions() });

    it.skipIf(skip)(
      'reads content at the head and at a pinned seq, byte for byte, without a room (BE-036; PRO-049)',
      async () => {
        const doc = await create();
        const owner = h.userToken({ [doc]: 'owner' });
        const first = await h.call('GET', `/v1/documents/${doc}/content`, { token: owner });
        expect(first.status).toBe(200);
        expect(Object.keys(first.json).sort()).toEqual([
          'cdm',
          'doc',
          'incarnation',
          'requires',
          'seq',
          'view',
        ]);
        expect(first.json).toMatchObject({ seq: 0, cdm: 1, requires: [] });
        expect(readDocument({ cdm: 1, requires: [], doc: first.json.doc }).ok).toBe(true);
        expect(first.headers.get('cache-control')).toBe('private, no-cache');
        const inc = first.json.incarnation as string;
        expect(first.headers.get('etag')).toBe(`"${inc}.0.${first.json.view}"`);
        const at = posIn(first.json.doc, INTRO).inside;
        const head = await append(h, doc, [[typing(at, 'X')], [typing(at, 'Y')]]);
        expect(head).toBe(2);
        // The head includes every stored commit; no room was opened (the stub has none).
        const now = await h.call('GET', `/v1/documents/${doc}/content`, { token: owner });
        expect(now.json.seq).toBe(2);
        expect(JSON.stringify(now.json.doc)).toContain('YXHello');
        expect(h.stub.notices.filter((n) => n.ref?.doc === doc)).toEqual([]);
        // A pinned read is immutable and byte-identical, with an ETag of incarnation, seq and view.
        const a = await h.call('GET', `/v1/documents/${doc}/content?seq=1`, { token: owner });
        const b = await h.call('GET', `/v1/documents/${doc}/content?seq=1`, { token: owner });
        expect(a.text).toBe(b.text);
        expect(JSON.stringify(a.json.doc)).toContain('XHello');
        expect(a.headers.get('etag')).toBe(`"${inc}.1.${a.json.view}"`);
        expect(a.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        const again = await h.call('GET', `/v1/documents/${doc}/content?seq=1`, {
          token: owner,
          headers: { 'If-None-Match': a.headers.get('etag')! },
        });
        expect(again.status).toBe(304);
        const zero = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: owner });
        expect(zero.text).toBe(first.text);
        // The replay ran in a worker thread (BE-001 criterion 3).
        expect(h.service.content.replays).toBeGreaterThan(0);
        expect(await h.service.pool.run<number>('thread', null)).not.toBe(threadId);
        // Above the head: not_found; a seq that is not a number: validation_failed.
        expect(
          (await h.call('GET', `/v1/documents/${doc}/content?seq=3`, { token: owner })).json.code,
        ).toBe('not_found');
        expect(
          (await h.call('GET', `/v1/documents/${doc}/content?seq=x`, { token: owner })).json.code,
        ).toBe('validation_failed');
        // A caller without view on the document is refused (criterion 7).
        expect(
          (
            await h.call('GET', `/v1/documents/${doc}/content`, {
              token: h.userToken({ [uuid7()]: 'owner' }),
            })
          ).status,
        ).toBe(403);
      },
    );

    it.skipIf(skip || storage !== 'postgres')(
      'changes the ETag of a seq when the log gets a new incarnation (BE-036 criterion 6; PRO-049 criterion 3)',
      async () => {
        const doc = await create();
        const before = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, {
          token: h.apiKey,
        });
        await h.db!.admin.query(
          'UPDATE doc_heads SET incarnation = gen_random_uuid() WHERE doc_id = $1',
          [doc],
        );
        const after = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, {
          token: h.apiKey,
        });
        expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
        expect(after.json.incarnation).not.toBe(before.json.incarnation);
      },
    );

    it.skipIf(skip)(
      'serves each reader the content of their class, derived from the grants in storage at the read (S12 change 3; SR-C4)',
      async () => {
        const doc = await create();
        const alice = h.userToken({ [doc]: 'editor' });
        const hidden = await h.call('GET', `/v1/documents/${doc}/content`, { token: alice });
        expect(JSON.stringify(hidden.json.doc)).toContain('hidden_region');
        expect(hidden.text).not.toContain('Liability');
        const full = await h.call('GET', `/v1/documents/${doc}/content`, {
          token: h.userToken({ [doc]: 'owner' }),
        });
        expect(full.text).toContain('Liability');
        expect(full.json.view).not.toBe(hidden.json.view);
        // The grant is stored; the stub data plane does nothing with the notice, yet the next read
        // follows the revision in storage, and the cached projection of the old class is not served.
        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
        await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': grants.headers.get('etag')! },
          body: { grants: [{ region: LEGAL, principal: 'user:alice', role: 'viewer' }] },
        });
        const now = await h.call('GET', `/v1/documents/${doc}/content`, { token: alice });
        expect(now.text).toContain('Liability');
        expect(now.json.view).toBe(full.json.view);
        expect(now.headers.get('etag')).not.toBe(hidden.headers.get('etag'));
      },
    );

    it.skipIf(skip)(
      'lists the regions derived from the head with title, policy, order, state and who can edit (PRO-051; D64)',
      async () => {
        const doc = await create();
        const viewer = h.userToken({ [doc]: 'owner' });
        const r = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
        expect(r.status).toBe(200);
        expect(r.json).toEqual({
          items: [
            {
              id: LEGAL,
              title: 'Legal review',
              policy: 'restricted',
              order: 0,
              state: 'draft',
              editors: { roles: ['owner'], principals: [] },
            },
            {
              id: OPEN,
              title: 'Open part',
              policy: 'inherit',
              order: 1,
              state: 'draft',
              editors: { roles: ['editor', 'owner'], principals: [] },
            },
          ],
          nextCursor: null,
        });
        const page = await h.call('GET', `/v1/documents/${doc}/regions?limit=1`, { token: viewer });
        expect(page.json.items.map((x: { id: string }) => x.id)).toEqual([LEGAL]);
        const rest = await h.call(
          'GET',
          `/v1/documents/${doc}/regions?limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`,
          { token: viewer },
        );
        expect(rest.json).toMatchObject({ items: [{ id: OPEN }], nextCursor: null });
        // A grant, a lease and an approval show in "who can edit".
        const ref = { tenant: h.tenant, doc };
        const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
        await h.parts.grants.change(
          ref,
          {
            putGrants: [
              { region: LEGAL, principal: `user:${bob}`, role: 'editor', expiresAt: null },
            ],
            putLeases: [{ region: OPEN, holder: bob, expiresAt: h.now() + 60_000 }],
          },
          { actor: 'system' },
        );
        const after = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
        expect(after.json.items[0].editors).toEqual({ roles: ['owner'], principals: ['user:bob'] });
        expect(after.json.items[1].editors).toEqual({
          roles: ['editor', 'owner'],
          principals: [],
          leasedTo: 'bob',
        });
        await h.parts.grants.change(
          ref,
          { setRegionStates: [{ region: LEGAL, state: 'approved' }] },
          { actor: 'system' },
        );
        const approved = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
        expect(approved.json.items[0]).toMatchObject({
          state: 'approved',
          editors: { roles: [], principals: [] },
        });
        // A commit that removes a region changes the list: it is derived, not stored.
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const span = posIn(content.json.doc, OPEN);
        await append(h, doc, [[{ stepType: 'replace', from: span.before, to: span.after }]], {
          retired: [OPEN],
        });
        const removed = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
        expect(removed.json.items.map((x: { id: string }) => x.id)).toEqual([LEGAL]);
        // Without view: refused.
        expect(
          (
            await h.call('GET', `/v1/documents/${doc}/regions`, {
              token: h.userToken({ [uuid7()]: 'owner' }),
            })
          ).status,
        ).toBe(403);
        // A reader from whom the region is hidden does not get its title.
        const hiddenTitle = await h.call('GET', `/v1/documents/${doc}/regions`, {
          token: h.userToken({ [doc]: 'viewer' }, { sub: 'nobody' }),
        });
        expect(hiddenTitle.json.items[0].title).toBe('');
      },
    );

    it.skipIf(skip)(
      'reads and changes region grants with manage under If-Match, and tells the room (PRM-018; PRO-052)',
      async () => {
        const doc = await create();
        const ref = { tenant: h.tenant, doc };
        const owner = h.userToken({ [doc]: 'owner' });
        const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        expect(g.status).toBe(200);
        expect(g.json).toEqual({ rev: 1, grants: [] });
        expect(g.headers.get('etag')).toBe('"g1"');
        expect(
          (
            await h.call('GET', `/v1/documents/${doc}/grants`, {
              token: h.userToken({ [doc]: 'editor' }),
            })
          ).json.code,
        ).toBe('forbidden');
        const patch = (body: unknown, token = owner, etag?: string) =>
          h.call('PATCH', `/v1/documents/${doc}/grants`, {
            token,
            body,
            ...(etag ? { headers: { 'If-Match': etag } } : {}),
          });
        const wanted = [
          { region: LEGAL, principal: 'user:bob', role: 'editor' },
          {
            region: OPEN,
            principal: 'group:legal',
            role: 'viewer',
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        ];
        expect((await patch({ grants: wanted })).status).toBe(428);
        expect((await patch({ grants: wanted }, owner, '"g0"')).json.code).toBe(
          'precondition_failed',
        );
        expect(
          (await patch({ grants: wanted }, h.userToken({ [doc]: 'editor' }), '"g1"')).json.code,
        ).toBe('forbidden');
        const ok = await patch({ grants: wanted }, owner, '"g1"');
        expect(ok.status).toBe(200);
        expect(ok.headers.get('etag')).toBe('"g2"');
        expect(ok.json).toEqual({
          rev: 2,
          grants: [
            { region: LEGAL, principal: 'user:bob', role: 'editor', expiresAt: null },
            {
              region: OPEN,
              principal: 'group:legal',
              role: 'viewer',
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
          ],
        });
        const notice = h.stub.notices
          .filter((n) => n.kind === 'permissions' && n.ref?.doc === doc)
          .at(-1);
        expect(notice?.perms?.revision).toBe(2);
        expect(h.events.of('dep.grants.changed.v1').find((e) => e.subject === doc)?.data).toEqual({
          rev: 2,
          seq: expect.any(Number),
        });
        // Storage holds the surrogate, never the sub (BE-013; D63).
        const stored = await h.parts.grants.current(ref);
        const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
        expect(stored.grants.map((x) => x.principal)).toContain(`user:${bob}`);
        expect(JSON.stringify(stored)).not.toContain('user:bob');
        // Once the response is back, a commit checked against the old revision is not stored (04 G7).
        const epoch = await h.parts.ownership.claim(ref, 'test-node');
        const late = await h.parts.logs.append(ref, {
          epoch,
          revision: 1,
          fromSeq: 1,
          commits: [
            {
              seq: 1,
              id: uuid7(),
              kind: 'steps',
              steps: [
                typing(
                  posIn(
                    (await h.call('GET', `/v1/documents/${doc}/content`, { token: owner })).json
                      .doc,
                    INTRO,
                  ).inside,
                  'z',
                ) as never,
              ],
              user: 'u',
              session: 's',
              time: h.now(),
              origin: 'input',
              scopes: ['body'],
              revision: 1,
              cdm: 1,
              engine: 'pm-steps/1',
              retired: [],
              claimed: [],
            },
          ],
        });
        expect(late.status).toBe('revision_moved');
        // Setting a new role replaces the grant: one per region and principal.
        const replaced = await patch(
          { grants: [{ region: LEGAL, principal: 'user:bob', role: 'viewer' }] },
          owner,
          '"g2"',
        );
        expect(replaced.json.grants).toEqual([
          { region: LEGAL, principal: 'user:bob', role: 'viewer', expiresAt: null },
        ]);
        // Refusals store nothing.
        for (const bad of [
          [{ region: LEGAL, principal: 'bob', role: 'viewer' }],
          [{ region: LEGAL, principal: 'user:bob', role: 'owner' }],
          [{ region: 'rNone00000000001', principal: 'user:bob', role: 'viewer' }],
          [
            { region: LEGAL, principal: 'everyone', role: 'viewer' },
            { region: LEGAL, principal: 'everyone', role: 'editor' },
          ],
        ]) {
          const r = await patch({ grants: bad }, owner, '"g3"');
          expect(r.status, JSON.stringify(bad)).toBe(400);
          expect(r.json.code).toBe('validation_failed');
        }
        expect((await h.parts.grants.current(ref)).revision).toBe(3);
      },
    );

    it.skipIf(skip)(
      'sets a region state with manage; an approval names the seq and the hash of the region (05 §6.2; 07 §11)',
      async () => {
        const doc = await create();
        const ref = { tenant: h.tenant, doc };
        const put = (body: unknown, token: string, etag?: string) =>
          h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
            token,
            body,
            ...(etag ? { headers: { 'If-Match': etag } } : {}),
          });
        const owner = h.userToken({ [doc]: 'owner' });
        expect((await put({ state: 'in_review' }, owner)).status).toBe(428);
        expect(
          (await put({ state: 'in_review' }, h.userToken({ [doc]: 'editor' }), '*')).json.code,
        ).toBe('forbidden');
        expect((await put({ state: 'done' }, owner, '*')).json.code).toBe('validation_failed');
        const review = await put({ state: 'in_review' }, owner, '"g1"');
        expect(review.status).toBe(200);
        expect(review.json).toEqual({ state: 'in_review' });
        expect(review.headers.get('etag')).toBe('"g2"');
        expect((await put({ state: 'approved' }, owner, '"g1"')).json.code).toBe(
          'precondition_failed',
        );
        const approved = await put({ state: 'approved' }, h.apiKey, '*');
        expect(approved.json).toMatchObject({ state: 'approved', seq: 0 });
        expect(approved.json.hash).toMatch(/^[0-9a-f]{64}$/);
        expect((await h.parts.grants.current(ref)).regionStates.get(LEGAL)).toBe('approved');
        expect(
          h.stub.notices.filter((n) => n.kind === 'permissions' && n.ref?.doc === doc).at(-1)?.perms
            ?.revision,
        ).toBe(3);
        expect(
          h.events
            .of('dep.region.state_changed.v1')
            .filter((e) => e.subject === doc)
            .map((e) => e.data['state']),
        ).toEqual(['in_review', 'approved']);
        const missing = await h.call('PUT', `/v1/documents/${doc}/regions/rNone00000000001/state`, {
          token: owner,
          body: { state: 'draft' },
          headers: { 'If-Match': '*' },
        });
        expect(missing.json.code).toBe('not_found');
      },
    );

    it.skipIf(skip)(
      'replaces content through the data plane, after the credential, If-Match and the content are checked (05 §6.2; BE-037)',
      async () => {
        const doc = await create();
        const calls: Array<{ doc: string; actor: string; content: unknown }> = [];
        delete h.stub.replaceContent;
        const replacement = documentWithRegions();
        expect(
          (
            await h.call('PUT', `/v1/documents/${doc}/content`, {
              token: h.apiKey,
              body: replacement,
              headers: { 'If-Match': '*' },
            })
          ).json.code,
        ).toBe('not_found');
        h.stub.replaceContent = async (ref, content, actor) => {
          calls.push({ doc: ref.doc, actor, content });
          return { seq: 1 };
        };
        try {
          const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
          expect(
            (
              await h.call('PUT', `/v1/documents/${doc}/content`, {
                token: h.apiKey,
                body: replacement,
              })
            ).status,
          ).toBe(428);
          expect(
            (
              await h.call('PUT', `/v1/documents/${doc}/content`, {
                token: h.apiKey,
                body: replacement,
                headers: { 'If-Match': '"x"' },
              })
            ).json.code,
          ).toBe('precondition_failed');
          expect(
            (
              await h.call('PUT', `/v1/documents/${doc}/content`, {
                token: h.apiKey,
                body: { cdm: 1, requires: [], doc: { type: 'doc' } },
                headers: { 'If-Match': '*' },
              })
            ).json.code,
          ).toBe('validation_failed');
          const ok = await h.call('PUT', `/v1/documents/${doc}/content`, {
            token: h.apiKey,
            body: replacement,
            headers: { 'If-Match': head.headers.get('etag')!, 'DEP-Actor': 'ivy' },
          });
          expect(ok.status).toBe(204);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.actor).toBe((await h.parts.users.resolve(h.tenant, 'ivy')).surrogate);
          expect(calls[0]!.content).toMatchObject({ cdm: 1, requires: [] });
        } finally {
          delete h.stub.replaceContent;
        }
      },
    );

    it.skipIf(skip)(
      'refuses a grant on a retired region (PRM-018 criterion 4; 07 §3)',
      async () => {
        const doc = await create();
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const span = posIn(content.json.doc, OPEN);
        await append(h, doc, [[{ stepType: 'replace', from: span.before, to: span.after }]], {
          retired: [OPEN],
        });
        const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': '"g1"' },
          body: { grants: [{ region: OPEN, principal: 'everyone', role: 'editor' }] },
        });
        expect(r.json.code).toBe('validation_failed');
        expect(await h.parts.grants.retired({ tenant: h.tenant, doc })).toEqual([OPEN]);
      },
    );

    it.skipIf(skip || storage !== 'postgres')(
      'attributes grant changes to the DEP-Actor or the user, as surrogates (PRM-018 criterion 7; BE-033 criteria 6, 7; BE-010 criterion 4)',
      async () => {
        const doc = await create();
        const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': '"g1"', 'DEP-Actor': 'erin' },
          body: { grants: [{ region: LEGAL, principal: 'user:frank', role: 'editor' }] },
        });
        expect(r.status).toBe(200);
        const erin = (await h.parts.users.resolve(h.tenant, 'erin')).surrogate;
        const rows = await h.db!.admin.query<{ created_by: string; principal: string }>(
          'SELECT created_by, principal FROM region_grants WHERE doc_id = $1',
          [doc],
        );
        expect(rows.rows).toEqual([
          {
            created_by: erin,
            principal: `user:${(await h.parts.users.resolve(h.tenant, 'frank')).surrogate}`,
          },
        ]);
        const user = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.userToken({ [doc]: 'owner' }, { sub: 'gina' }),
          headers: { 'If-Match': '"g2"', 'DEP-Actor': 'mallory' },
          body: { grants: [] },
        });
        expect(user.status).toBe(200);
        const gina = (await h.parts.users.resolve(h.tenant, 'gina')).surrogate;
        const history = await h.db!.admin.query<{ rev: string; changed_by: string }>(
          'SELECT rev, changed_by FROM grant_history WHERE doc_id = $1 ORDER BY rev',
          [doc],
        );
        expect(history.rows.map((x) => x.changed_by)).toEqual(['system', erin, gina]);
        const system = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': '"g3"' },
          body: { grants: [] },
        });
        expect(system.status).toBe(200);
        const last = await h.db!.admin.query<{ changed_by: string }>(
          'SELECT changed_by FROM grant_history WHERE doc_id = $1 ORDER BY rev DESC LIMIT 1',
          [doc],
        );
        expect(last.rows[0]!.changed_by).toBe('system');
      },
    );

    it.skipIf(skip)(
      "revokes a user's sessions for every document or for one (05 §3.3; D73)",
      async () => {
        const a = await create();
        const b = await create();
        const old = h.userToken(
          { [a]: 'editor', [b]: 'viewer' },
          { sub: 'zoe', iat: Math.floor(h.now() / 1000) - 5 },
        );
        expect((await h.call('GET', `/v1/documents/${a}`, { token: old })).status).toBe(200);
        const one = await h.call('POST', '/v1/sessions/revoke', {
          token: h.apiKey,
          body: { sub: 'zoe', doc: a },
        });
        expect(one.status).toBe(204);
        expect((await h.call('GET', `/v1/documents/${a}`, { token: old })).json.code).toBe(
          'forbidden',
        );
        expect((await h.call('GET', `/v1/documents/${b}`, { token: old })).status).toBe(200);
        const zoe = (await h.parts.users.resolve(h.tenant, 'zoe')).surrogate;
        expect(h.stub.notices.at(-1)).toEqual({ kind: 'revoked', user: zoe, doc: a });
        const onlyA = h.userToken(
          { [a]: 'editor' },
          { sub: 'zoe', iat: Math.floor(h.now() / 1000) - 5 },
        );
        expect((await h.call('GET', `/v1/documents/${a}`, { token: onlyA })).json.code).toBe(
          'revoked',
        );
        await h.call('POST', '/v1/sessions/revoke', { token: h.apiKey, body: { sub: 'zoe' } });
        expect((await h.call('GET', `/v1/documents/${b}`, { token: old })).json.code).toBe(
          'revoked',
        );
        await expect(h.service.tokens.verifyUser(old)).rejects.toMatchObject({ code: 'revoked' });
        // A token issued after the watermark works again.
        h.advance(1500);
        expect(
          (
            await h.call('GET', `/v1/documents/${b}`, {
              token: h.userToken({ [b]: 'viewer' }, { sub: 'zoe' }),
            })
          ).status,
        ).toBe(200);
      },
    );
  });
}
