/**
 * PRO-072 criteria 4 and 5 (05 §7), end to end over the real data plane with an in-memory event
 * sink: a channel that opens raises `dep.session.joined`, one that closes raises `dep.session.left`
 * (also when the node stops the room); a commit refused with `permission_denied` or `invalid_op`
 * raises `dep.commit.rejected` and a refusal with another code raises none. The throttle of
 * `dep.commit.rejected` is the dispatcher's (tests/security/test/prm-053-webhook-events.test.ts,
 * PRM-053 criterion 5); this sink does not throttle.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryEventSink } from '../control-plane/events.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, until, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(events: MemoryEventSink, testMode = false): Promise<Plane> {
  const p = await startPlane({ deps: { events }, ...(testMode ? { settings: { testMode } } : {}) });
  planes.push(p);
  return p;
}

describe('PRO-072 criterion 4: sessions joining and leaving', () => {
  it('raises dep.session.joined when a channel opens and dep.session.left when it closes', async () => {
    const events = new MemoryEventSink();
    const p = await plane(events);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    expect(events.of('dep.session.joined.v1')).toEqual([]);

    await alice.open(1, doc);
    await bob.open(1, doc);
    const joined = events.of('dep.session.joined.v1');
    expect(joined).toHaveLength(2);
    for (const e of joined) {
      expect(e).toMatchObject({ tenant: p.tenant, subject: doc, data: { seq: 0 } });
      expect(typeof e.data['session']).toBe('string');
    }
    expect(new Set(joined.map((e) => e.data['session'])).size).toBe(2);

    alice.close();
    await until(() => events.of('dep.session.left.v1').length === 1, 3000, 'the left event');
    const left = events.of('dep.session.left.v1')[0]!;
    expect(left).toMatchObject({ subject: doc });
    expect(joined.map((e) => e.data['session'])).toContain(left.data['session']);
    // The other session is still in: only one left event.
    expect(events.of('dep.session.left.v1')).toHaveLength(1);
  });

  it('raises dep.session.left for each channel when the room stops', async () => {
    const events = new MemoryEventSink();
    const p = await plane(events);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    expect(events.of('dep.session.joined.v1')).toHaveLength(1);
    await p.close();
    expect(events.of('dep.session.left.v1')).toHaveLength(1);
  });
});

describe('PRO-072 criterion 5: rejected commits', () => {
  it('raises dep.commit.rejected for permission_denied and invalid_op, and none for another code', async () => {
    const events = new MemoryEventSink();
    const p = await plane(events, true);
    const doc = await p.createDocument();
    const frank = await p.client('frank', { [doc]: 'viewer' });
    const alice = await p.client('alice', { [doc]: 'owner' });
    await frank.open(1, doc);
    await alice.open(1, doc);

    const denied = await frank.submit(1, {
      id: uuid7(),
      base: 0,
      steps: [insertText(intro(), 'not mine')],
    });
    expect(denied.d).toMatchObject({ code: 'permission_denied' });
    const invalid = await alice.submit(1, {
      id: uuid7(),
      base: 9,
      steps: [insertText(intro(), 'ahead')],
    });
    expect(invalid.d).toMatchObject({ code: 'invalid_op' });
    const rejected = events.of('dep.commit.rejected.v1');
    expect(rejected.map((e) => e.data['code'])).toEqual(['permission_denied', 'invalid_op']);
    for (const e of rejected) expect(e).toMatchObject({ subject: doc, data: { seq: 0 } });
    // No content in the event.
    expect(JSON.stringify(rejected)).not.toContain('not mine');

    // A refusal with another code (the store is unavailable) raises nothing.
    p.plane.hooks!.dropDatabase(true);
    const other = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'later')] });
    expect(other.d).toMatchObject({ code: 'unavailable' });
    p.plane.hooks!.dropDatabase(false);
    expect(events.of('dep.commit.rejected.v1')).toHaveLength(2);
  });
});
