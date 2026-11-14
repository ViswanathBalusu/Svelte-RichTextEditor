// Grants and leases expire on time (07 §1, §4 last paragraph; PRM-007): at an expiry the room
// recomputes access and sends `perm.changed`, the schedule moves to the next expiry, a commit made
// after the instant never counts the expired grant, and a restarted room has the same schedule.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { nextExpiry } from '../src/permissions/access.ts';
import type { PermissionState } from '../src/permissions/model.ts';
import type { ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';
import { commitId, messages, rejection, roomWith } from './permission-fixtures.ts';

const T = 1_760_000_000_000;
const LEGAL = 'rLegal000000000B';
const typing = (doc: Node) => {
  const pos = posInside(doc, 'pLegal000000001B');
  return stepsToJson([new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))]);
};

function expiring(): PermissionState {
  const p = basePermissions();
  return {
    ...p,
    grants: [
      ...p.grants,
      { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: T + 100 },
      {
        region: 'rTerms000000000A',
        principal: 'user:frank',
        role: 'commenter',
        expiresAt: T + 300,
      },
    ],
    leases: [{ region: 'rNotes000000000C', holder: 'alice', expiresAt: T + 200 }],
  };
}

describe('expiry of grants and leases (PRM-007)', () => {
  it('recomputes the grantee at the instant of expiry and sends perm.changed, with no other event', () => {
    let now = T;
    const room = roomWith(baseDoc(), expiring(), () => now);
    room.open('c1', USERS.carol);
    room.open('b1', USERS.bob);
    expect(room.nextExpiry).toBe(T + 100);
    now = T + 99;
    expect(room.expire().send).toEqual([]);
    now = T + 100;
    const fx = room.expire();
    const changed = messages(fx, 'c1').find((m) => m.t === 'perm.changed') as Extract<
      ToClient,
      { t: 'perm.changed' }
    >;
    expect(changed).toBeDefined();
    expect(changed.access.regions.get(LEGAL)?.has('edit')).toBe(false);
    // Bob's access did not change: he gets nothing.
    expect(messages(fx, 'b1')).toEqual([]);
  });

  it('schedules the next recomputation at the next earliest remaining expiry', () => {
    let now = T;
    const room = roomWith(baseDoc(), expiring(), () => now);
    room.open('a1', USERS.alice);
    room.open('c1', USERS.carol);
    room.open('f1', USERS.frank);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const next = room.nextExpiry;
      if (next === null) break;
      seen.push(next);
      now = next;
      room.expire();
    }
    expect(seen).toEqual([T + 100, T + 200, T + 300]);
    expect(room.nextExpiry).toBeNull();
    // The lease ends for Carol at T + 200: Notes becomes editable for her again.
    expect(nextExpiry(expiring(), T + 150)).toBe(T + 200);
  });

  it('never counts an expired grant, even before the scheduled recomputation has run', () => {
    let now = T;
    const room = roomWith(baseDoc(), expiring(), () => now);
    room.open('c1', USERS.carol);
    const doc = room.document;
    expect(room.submit('c1', { id: commitId(), base: 0, steps: typing(doc) }).write).not.toBeNull();
    room.writeCompleted({ status: 'ok' });
    now = T + 100; // expired; expire() has not been called
    const fx = room.submit('c1', { id: commitId(), base: 1, steps: typing(room.document) });
    expect(rejection(fx, 'c1')).toMatchObject({
      code: 'permission_denied',
      scopes: [`region:${LEGAL}`],
    });
  });

  it('rebuilds the schedule from the stored grants and leases when the room restarts', () => {
    const now = T + 150;
    const before = roomWith(baseDoc(), expiring(), () => now);
    const after = roomWith(baseDoc(), expiring(), () => now);
    expect(after.nextExpiry).toBe(before.nextExpiry);
    expect(after.nextExpiry).toBe(T + 200);
  });
});
