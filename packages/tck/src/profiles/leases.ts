/**
 * The `leases` profile, as far as PRM-058 needs it (05 §6.2; 07 §10, §12 rows 10 and 11): who may
 * take a lease and who may break one. A server that announces `leases` is asked for each refusal
 * and for the same call made by a caller who holds the capability, so that a server which refuses
 * everyone fails too. The scenarios of PRO-122 (exclusivity against a commit, expiry without
 * heartbeats, `perm.changed`) are not here: they wait for the test-mode expiry and for the kit to
 * read `perm.changed`, and are that story's.
 */
import { check, equal, isObject } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { Http, expectStatus } from '../rest.ts';
import { acked, join, problemOf, rejected } from './support.ts';

const ls = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('leases', def);
const http = new Http();

/** The scope a lease is listed under in ccess.leases (05 §5.5). */
const SCOPE = `region:${IDS.open}`;

/** The lease of a region as perm.changed lists it, or undefined. */
function leaseIn(access: { leases: Record<string, { holder: string }> }) {
  return access.leases[SCOPE];
}

/** The region lease of test mode (GET /_test/timers, PRO-109), in ms. */
async function leaseDuration(ctx: ScenarioContext): Promise<number> {
  if (!ctx.config.testMode)
    ctx.skip('needs the server test-mode switch, which shortens the lease (PRO-109)');
  const url = new URL('/_test/timers', ctx.target.discovery.rest).toString();
  const res = await http.request('GET', url, { token: ctx.config.credential });
  if (res.status === 404)
    ctx.skip('the server publishes no test-mode timers (GET /_test/timers is 404)');
  expectStatus(res, 200, 'the test-mode timers');
  const ms = (res.json as { regionLeaseMs?: unknown } | undefined)?.regionLeaseMs;
  check(
    typeof ms === 'number' && ms > 0,
    'the timers name regionLeaseMs',
    'a number of ms',
    res.json,
  );
  return ms as number;
}

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
    ls({
      id: 'exclusive',
      title:
        'while one user holds a lease, another user cannot edit the region: permission_denied, and perm.changed lists the lease',
      spec: '07 §10; 05 §5.5',
      covers: {
        messages: ['perm.changed', 'sync.submit'],
        operations: ['POST /documents/{id}/regions/{rid}/lease'],
        errors: ['permission_denied'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const path = `/documents/${d}/regions/${IDS.open}/lease`;
        const holder = await join(ctx, 'holder', d, 'editor');
        const other = await join(ctx, 'other', d, 'editor');
        const at = posIn(other.content.doc, IDS.openPara);
        // Before the lease both may edit the region.
        const before = await acked(other.wire, other.ch, {
          base: other.content.seq,
          steps: [insertText(at, 'a')],
        });
        const from = other.wire.mark();
        const taken = await ctx.service.as(holder.token, 'POST', path);
        equal(taken.status, 201, 'the lease is taken');
        const perm = await other.wire.nextOf('perm.changed', { from });
        const listed = leaseIn(perm.d);
        check(
          listed !== undefined,
          'perm.changed lists the lease',
          `a lease at ${SCOPE}`,
          perm.d.leases,
        );
        equal(listed!.holder, holder.sub, 'the holder of the listed lease');
        const r = await rejected(other.wire, other.ch, {
          base: Math.max(perm.d.asOfSeq, before.seq),
          steps: [insertText(at, 'b')],
        });
        equal(r.code, 'permission_denied', 'another user is refused while the lease is held');
        // The holder still edits.
        const ok = await acked(holder.wire, holder.ch, {
          base: Math.max(perm.d.asOfSeq, before.seq),
          steps: [insertText(posIn(holder.content.doc, IDS.openPara), 'h')],
        });
        check(ok.seq > before.seq, 'the holder edits the region', `a seq above ${before.seq}`, ok);
        await ctx.service.as(holder.token, 'DELETE', path);
      },
    }),
    ls({
      id: 'expiry',
      title:
        'a holder that sends no heartbeat loses the lease when the test-mode expiry passes, and perm.changed is sent',
      spec: '07 §10; 05 §5.5; PRO-109',
      timeoutMs: 60_000,
      covers: {
        messages: ['perm.changed'],
        operations: ['POST /documents/{id}/regions/{rid}/lease'],
      },
      async run(ctx) {
        const duration = await leaseDuration(ctx);
        const d = await ctx.document();
        const path = `/documents/${d}/regions/${IDS.open}/lease`;
        const holder = await join(ctx, 'holder', d, 'editor');
        const other = await join(ctx, 'other', d, 'editor');
        const from = other.wire.mark();
        const taken = await ctx.service.as(holder.token, 'POST', path);
        equal(taken.status, 201, 'the lease is taken');
        const started = Date.now();
        const held = await other.wire.nextOf('perm.changed', { from });
        check(
          leaseIn(held.d) !== undefined,
          'perm.changed lists the lease',
          `a lease at ${SCOPE}`,
          held.d.leases,
        );
        // No heartbeat is sent. The lease ends by itself, and the room says so.
        const gone = await other.wire.next(
          (m) => m.t === 'perm.changed' && m.ch === other.ch && leaseIn(m.d) === undefined,
          'perm.changed without the lease',
          { from: other.wire.messages.indexOf(held) + 1, timeoutMs: duration + 15_000 },
        );
        const waited = Date.now() - started;
        ctx.note(`the lease of ${duration} ms was announced as ended after ${waited} ms`);
        check(
          gone.t === 'perm.changed' && gone.d.rev > held.d.rev,
          'the revision rises when the lease ends',
          `> ${held.d.rev}`,
          gone.t === 'perm.changed' ? gone.d.rev : gone,
        );
        const base = gone.t === 'perm.changed' ? gone.d.asOfSeq : 0;
        await acked(other.wire, other.ch, {
          base,
          steps: [insertText(posIn(other.content.doc, IDS.openPara), 'e')],
        });
      },
    }),
    ls({
      id: 'break-ends',
      title:
        'a user with manage who breaks a lease ends it at once: perm.changed, and the region is open again',
      spec: '07 §10, §12 row 10; 05 §5.5',
      covers: {
        messages: ['perm.changed'],
        operations: ['DELETE /documents/{id}/regions/{rid}/lease'],
      },
      async run(ctx) {
        const d = await ctx.document();
        const path = `/documents/${d}/regions/${IDS.open}/lease`;
        const holder = await join(ctx, 'holder', d, 'editor');
        const other = await join(ctx, 'other', d, 'editor');
        const { token: owner } = await ctx.token('owner', { [d]: 'owner' });
        const mark = other.wire.mark();
        equal((await ctx.service.as(holder.token, 'POST', path)).status, 201, 'the lease is taken');
        const held = await other.wire.nextOf('perm.changed', { from: mark });
        check(
          leaseIn(held.d) !== undefined,
          'perm.changed lists the lease',
          `a lease at ${SCOPE}`,
          held.d.leases,
        );
        const r = await rejected(other.wire, other.ch, {
          base: held.d.asOfSeq,
          steps: [insertText(posIn(other.content.doc, IDS.openPara), 'x')],
        });
        equal(r.code, 'permission_denied', 'refused while the lease is held');
        const from = other.wire.mark();
        const broken = await ctx.service.as(owner, 'DELETE', path);
        check(broken.status < 300, 'the owner breaks the lease', '2xx', broken.status);
        const after = await other.wire.next(
          (m) => m.t === 'perm.changed' && m.ch === other.ch && leaseIn(m.d) === undefined,
          'perm.changed without the lease',
          { from },
        );
        const base = after.t === 'perm.changed' ? after.d.asOfSeq : 0;
        await acked(other.wire, other.ch, {
          base,
          steps: [insertText(posIn(other.content.doc, IDS.openPara), 'y')],
        });
      },
    }),
  ],
};
