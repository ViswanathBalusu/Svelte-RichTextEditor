/**
 * The `leases` profile, as far as PRM-058 needs it (05 §6.2; 07 §10, §12 rows 10 and 11): who may
 * take a lease and who may break one. A server that announces `leases` is asked for each refusal
 * and for the same call made by a caller who holds the capability, so that a server which refuses
 * everyone fails too. The scenarios of PRO-122 (exclusivity against a commit, expiry without
 * heartbeats, `perm.changed`) are not here: they wait for the test-mode expiry and for the kit to
 * read `perm.changed`, and are that story's.
 */
import { check, equal, isObject } from '../assert.ts';
import { IDS } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { problemOf } from './support.ts';

const ls = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('leases', def);

export const LEASES: ProfileDef = {
  id: 'leases',
  title: 'Exclusive-edit leases',
  spec: '07 §10',
  stories: ['PRO-122', 'PRM-058'],
  requires: { kind: 'features', features: ['leases'] },
  scenarios: [
    ls({
      id: 'acquire-needs-edit',
      title:
        'row 11: a user without edit in the region cannot take a lease on it; an editor can, and is the holder',
      spec: '07 §12 row 11; PRM-058',
      covers: {
        operations: ['POST /documents/{id}/regions/{rid}/lease'],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const path = `/documents/${d}/regions/${IDS.open}/lease`;
        const { token: viewer } = await ctx.token('viewer', { [d]: 'viewer' });
        const refused = await ctx.service.as(viewer, 'POST', path);
        equal(problemOf(refused, 'a lease taken by a viewer').code, 'forbidden', 'a viewer');
        equal(refused.status, 403, 'a viewer: the status');

        const { token: editor } = await ctx.token('editor', { [d]: 'editor' });
        const taken = await ctx.service.as(editor, 'POST', path);
        equal(taken.status, 201, 'a lease taken by an editor');
        check(
          isObject(taken.json) && typeof taken.json['id'] === 'string',
          'the lease has an identifier',
          'a string',
          taken.text,
        );
        // Clean up for the next scenario, which shares nothing: the holder releases it.
        const released = await ctx.service.as(editor, 'DELETE', path);
        check(released.status < 300, 'the holder releases the lease', '2xx', released.status);
      },
    }),
    ls({
      id: 'break-needs-manage',
      title:
        'row 10: a lease held by another user is broken only with manage; an editor is refused and the lease stays',
      spec: '07 §12 row 10; PRM-058',
      covers: {
        operations: [
          'POST /documents/{id}/regions/{rid}/lease',
          'DELETE /documents/{id}/regions/{rid}/lease',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const path = `/documents/${d}/regions/${IDS.open}/lease`;
        const { token: holder } = await ctx.token('holder', { [d]: 'editor' });
        const { token: other } = await ctx.token('other', { [d]: 'editor' });
        const { token: owner } = await ctx.token('owner', { [d]: 'owner' });
        const taken = await ctx.service.as(holder, 'POST', path);
        equal(taken.status, 201, 'the lease is taken by the holder');
        const id = isObject(taken.json) ? taken.json['id'] : undefined;

        const refused = await ctx.service.as(other, 'DELETE', path);
        equal(problemOf(refused, 'a lease broken by an editor').code, 'forbidden', 'an editor');
        equal(refused.status, 403, 'an editor: the status');
        // The refusal changed nothing: the holder still holds the same lease.
        const again = await ctx.service.as(holder, 'POST', path);
        equal(again.status, 201, 'the holder still holds the lease');
        check(
          isObject(again.json) && again.json['id'] === id,
          'the lease is the same one',
          String(id),
          again.text,
        );

        // With manage the same call is served.
        const broken = await ctx.service.as(owner, 'DELETE', path);
        check(broken.status < 300, 'an owner breaks the lease', '2xx', broken.status);
      },
    }),
  ],
};
