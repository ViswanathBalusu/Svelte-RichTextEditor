/**
 * Notifications on the socket (PRO-035; 05 §5.6). An `event` says that a resource changed: it
 * carries `type`, `resource`, and optionally `rev` and small `data`, exactly as the room sent it.
 * Job events reach the requester's channels only; `document.updated` reaches every open channel of
 * the document and no other document's. The real data plane runs over the in-memory stores
 * (test/data-plane/support.ts). Asset events are raised by the control plane and are tested in
 * test/control-plane/routes.assets.test.ts; the client's ignoring of unknown types is not here.
 */
import { definition, type Notification } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}

const events = (c: { all(t: string, ch?: number): Array<{ d?: Record<string, unknown> }> }) =>
  c.all('event', 1).map((m) => m.d);

describe('an event carries the type, the resource and the small data (PRO-035 criterion 1)', () => {
  it('delivers every field of a notification unchanged to an open channel', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const n: Notification = {
      type: 'comment.created',
      resource: '/comments/c123',
      rev: 4,
      data: { thread: 't1', seq: 7 },
    };
    p.plane.notify(p.ref(doc), n);
    const got = await alice.take((m) => m.t === 'event');
    expect(got.ch).toBe(1);
    expect(got.d).toEqual(n);
  });

  it('delivers a notification without rev or data with only type and resource', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    p.plane.notify(p.ref(doc), { type: 'document.updated', resource: `/documents/${doc}` });
    const got = await alice.take((m) => m.t === 'event');
    expect(Object.keys(got.d!).sort()).toEqual(['resource', 'type']);
  });
});

describe('job events reach the requester only, with the job as resource (PRO-035 criterion 2)', () => {
  it.each(['export.progress', 'export.completed', 'export.failed', 'export.cancelled'])(
    '%s goes to the requester and not to another open channel of the document',
    async (type) => {
      const p = await plane();
      const doc = await p.createDocument();
      const alice = await p.client('alice', { [doc]: 'owner' });
      const bob = await p.client('bob', { [doc]: 'editor' });
      await alice.open(1, doc);
      await bob.open(1, doc);
      const jobId = '0190b4a0-0000-7000-8000-000000000001';
      p.plane.notify(
        p.ref(doc),
        { type, resource: `/exports/${jobId}`, data: { state: 'completed' } },
        { user: 'alice' },
      );
      // A broadcast after it: once Bob has it, anything sent to him before would have arrived.
      p.plane.notify(p.ref(doc), { type: 'document.updated', resource: `/documents/${doc}` });
      const aliceGot = await alice.take((m) => m.t === 'event' && m.d?.['type'] === type);
      expect(aliceGot.d).toEqual({
        type,
        resource: `/exports/${jobId}`,
        data: { state: 'completed' },
      });
      await bob.take((m) => m.t === 'event' && m.d?.['type'] === 'document.updated');
      expect(events(bob).map((d) => d?.['type'])).toEqual(['document.updated']);
    },
  );
});

describe('document.updated reaches every open channel of the document (PRO-035 criterion 4)', () => {
  it('sends the event to each channel of the document when its state is stored', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);
    p.plane.documentChanged(p.ref(doc));
    for (const c of [alice, bob]) {
      const got = await c.take((m) => m.t === 'event' && m.d?.['type'] === 'document.updated');
      expect(got.d).toEqual({ type: 'document.updated', resource: `/documents/${doc}` });
    }
  });

  it('does not send the event to channels of another document', async () => {
    const p = await plane();
    const docA = await p.createDocument();
    const docB = await p.createDocument();
    const alice = await p.client('alice', { [docA]: 'owner', [docB]: 'owner' });
    await alice.open(1, docA);
    await alice.open(2, docB);
    p.plane.documentChanged(p.ref(docB));
    const got = await alice.take((m) => m.t === 'event' && m.ch === 2);
    expect(got.d?.['resource']).toBe(`/documents/${docB}`);
    expect(alice.all('event', 1)).toEqual([]);
  });
});

describe('the export stems agree with the webhook names (PRO-035 criterion 6, server half)', () => {
  it('has a dep. webhook of version 1 for each export event that has one', () => {
    const exportStems = definition.NOTIFICATIONS.map((n) => n.type).filter((t) =>
      t.startsWith('export.'),
    );
    expect(exportStems).toEqual(
      expect.arrayContaining([
        'export.progress',
        'export.completed',
        'export.failed',
        'export.cancelled',
      ]),
    );
    for (const stem of ['export.completed', 'export.failed']) {
      expect(definition.WEBHOOKS).toContainEqual(
        expect.objectContaining({ name: `dep.${stem}`, version: 1 }),
      );
    }
  });
});
