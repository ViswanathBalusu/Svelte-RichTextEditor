/**
 * The audit trail of refused commits, end to end (07 §14; PRM-051 criteria 1, 2 and 4; BE-014).
 * The real data plane runs over the in-memory stores with an in-memory audit store; clients connect
 * over WebSocket. A commit refused with `permission_denied` or `invalid_op` is read back from the
 * audit store by document, actor and time, with the scopes the client was told and the server time.
 * The host is the one place entries are made (`room-host.ts`, `#auditRejection`), so each refusal
 * leaves exactly one entry.
 *
 * Not covered here: the throttled `dep.commit.rejected` webhook of PRM-053. No delivery of that
 * event exists in the document service yet (BE-055, PRM-053 criterion 3), so the burst test below
 * shows only that the store keeps an entry for every refusal, also through a store outage.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, until, type Plane } from '../../test/data-plane/support.ts';
import { MemoryAudit } from './memory-ports.ts';
import { RequestRefused } from './wire.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const T0 = 1_800_000_000_000;

let planes: Plane[] = [];
async function plane(audit: MemoryAudit, clock: { t: number }): Promise<Plane> {
  const p = await startPlane({ deps: { audit }, now: () => clock.t });
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const rejected = (audit: MemoryAudit, tenant: string, doc: string, actor?: string) =>
  audit.query(tenant, {
    doc,
    kind: 'commit.rejected',
    ...(actor !== undefined ? { actor } : {}),
    limit: 1000,
  });

describe('refused commits reach the audit store (PRM-051)', () => {
  it('records a viewer refused with permission_denied: actor, document, scopes and server time (criterion 1)', async () => {
    const audit = new MemoryAudit();
    const clock = { t: T0 };
    const p = await plane(audit, clock);
    const doc = await p.createDocument();
    const frank = await p.client('frank', { [doc]: 'viewer' });
    expect((await frank.open(1, doc)).t).toBe('ch.opened');

    clock.t = T0 + 5_000;
    const id = uuid7();
    const r = await frank.submit(1, { id, base: 0, steps: [insertText(intro(), 'not mine')] });
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({ id, code: 'permission_denied' });
    await p.plane.audit.flush();

    // Queried the way criterion 5 asks: by document, actor and a time range.
    const found = await audit.query(p.tenant, {
      doc,
      actor: 'frank',
      from: T0 + 5_000,
      to: T0 + 5_001,
      limit: 10,
    });
    expect(found).toHaveLength(1);
    const scopes = (r.d as { scopes?: string[] }).scopes ?? [];
    expect(found[0]).toMatchObject({
      tenant: p.tenant,
      doc,
      actor: 'frank',
      kind: 'commit.rejected',
      at: T0 + 5_000,
      data: { code: 'permission_denied', commit: id, scopes, head: 0, action: 'drop' },
    });
    // Identifiers only: neither the reason string nor the steps are kept.
    const text = JSON.stringify(found[0]);
    expect(text).not.toContain('not mine');
    expect(found[0]!.data).not.toHaveProperty('reason');
    expect(found[0]!.data).not.toHaveProperty('message');
    // One refusal, one entry: nothing else audits it a second time.
    expect(await rejected(audit, p.tenant, doc)).toHaveLength(1);
  });

  it('records an invalid_op refusal with the same shape (criterion 2)', async () => {
    const audit = new MemoryAudit();
    const clock = { t: T0 };
    const p = await plane(audit, clock);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);

    clock.t = T0 + 7_000;
    // A base ahead of the head is refused with invalid_op.
    const id = uuid7();
    const r = await alice.submit(1, { id, base: 9, steps: [insertText(intro(), 'ahead')] });
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({ id, code: 'invalid_op' });
    await p.plane.audit.flush();

    const found = await rejected(audit, p.tenant, doc, 'alice');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      doc,
      actor: 'alice',
      kind: 'commit.rejected',
      at: T0 + 7_000,
      data: { code: 'invalid_op', commit: id, scopes: [], head: 0 },
    });
    expect(Object.keys(found[0]!.data).sort()).toEqual(
      ['action', 'code', 'commit', 'head', 'scopes', 'session'].sort(),
    );
  });

  it('records a commit identifier taken by another user, which the room refuses after storage answers', async () => {
    const audit = new MemoryAudit();
    const clock = { t: T0 };
    const p = await plane(audit, clock);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    const id = uuid7();
    expect((await alice.submit(1, { id, base: 0, steps: [insertText(intro(), 'A')] })).t).toBe(
      'sync.ack',
    );
    const r = await bob.submit(1, { id, base: 1, steps: [insertText(intro(), 'B')] });
    expect(r.d).toMatchObject({ id, code: 'invalid_op' });
    await p.plane.audit.flush();
    const found = await rejected(audit, p.tenant, doc);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ actor: 'bob', data: { code: 'invalid_op', commit: id } });
  });

  it('records a server-authored commit refused with invalid_op under the actor it was made for', async () => {
    const audit = new MemoryAudit();
    const clock = { t: T0 };
    const p = await plane(audit, clock);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);

    clock.t = T0 + 9_000;
    const id = uuid7();
    const refused = await p.plane.host
      .apply(ref, { kind: 'author', id, origin: 'prefill', actor: 'bob', base: 9, steps: [] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(RequestRefused);
    expect((refused as RequestRefused).rejection.code).toBe('invalid_op');
    await p.plane.audit.flush();

    const found = await rejected(audit, p.tenant, doc, 'bob');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      actor: 'bob',
      at: T0 + 9_000,
      data: { code: 'invalid_op', commit: id },
    });
    // A requester is not a session.
    expect(found[0]!.data).not.toHaveProperty('session');
  });

  it('does not audit refusals outside the two codes', async () => {
    const audit = new MemoryAudit();
    const clock = { t: T0 };
    const p = await startPlane({
      deps: { audit },
      now: () => clock.t,
      settings: { testMode: true },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    p.plane.hooks!.dropDatabase(true);
    const r = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'later')] });
    expect(r.d).toMatchObject({ code: 'unavailable' });
    p.plane.hooks!.dropDatabase(false);
    await p.plane.audit.flush();
    expect(await rejected(audit, p.tenant, doc)).toHaveLength(0);
  });

  it('keeps an entry for every refusal in a burst, also while the audit store is failing (criterion 4, store half)', async () => {
    const audit = new MemoryAudit();
    const clock = { t: T0 };
    const p = await plane(audit, clock);
    const doc = await p.createDocument();
    const frank = await p.client('frank', { [doc]: 'viewer' });
    await frank.open(1, doc);

    audit.failing = true;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      clock.t = T0 + i;
      const id = uuid7();
      ids.push(id);
      const r = await frank.submit(1, { id, base: 0, steps: [insertText(intro(), `try ${i}`)] });
      expect(r.d).toMatchObject({ code: 'permission_denied' });
    }
    // The store refused every write; the entries wait in the queue.
    await p.plane.audit.flush();
    expect(audit.events).toHaveLength(0);
    expect(p.plane.audit.queued).toBe(30);
    expect(p.plane.audit.stats.failures).toBeGreaterThan(0);

    audit.failing = false;
    await p.plane.audit.flush();
    await until(() => p.plane.audit.queued === 0, 3000, 'the audit queue to empty');
    const found = await rejected(audit, p.tenant, doc, 'frank');
    expect(found.map((e) => e.data['commit'])).toEqual(ids);
    expect(found.map((e) => e.at)).toEqual(ids.map((_, i) => T0 + i));
    expect(p.plane.audit.stats.dropped).toBe(0);
    expect(p.errors.length).toBeGreaterThan(0);
  });
});
