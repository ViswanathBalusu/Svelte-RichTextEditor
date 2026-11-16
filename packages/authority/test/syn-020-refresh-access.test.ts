// SYN-020 criterion 2 (04 §8: on `permission_denied` the client "refreshes permissions"; ADR 0364):
// the room sends the access a refused commit was judged under, ahead of the rejection, whenever it
// is not the access the channel was last sent. DEP has no request for the access object.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess, sameAccess } from '../src/permissions/access.ts';
import type { PermissionState } from '../src/permissions/model.ts';
import { regionsOf } from '../src/room/room.ts';
import type { ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';
import { commitId, messages, roomWith } from './permission-fixtures.ts';

const T = 1_760_000_000_000;
const LEGAL = 'rLegal000000000B';
const typing = (doc: Node, para = 'pLegal000000001B') => {
  const pos = posInside(doc, para);
  return stepsToJson([new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))]);
};

/** Carol edits the restricted region through a grant that runs out at T + 100. */
function expiring(): PermissionState {
  const p = basePermissions();
  return {
    ...p,
    grants: [
      ...p.grants,
      { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: T + 100 },
    ],
  };
}

type PermChanged = Extract<ToClient, { t: 'perm.changed' }>;

describe('a permission_denied rejection brings the access it was judged under (SYN-020)', () => {
  it('sends perm.changed before the rejection when the channel holds an older access', () => {
    let now = T;
    const room = roomWith(baseDoc(), expiring(), () => now);
    room.open('c1', USERS.carol);
    now = T + 100; // the grant has run out; nobody has called expire()
    const fx = room.submit('c1', { id: commitId(), base: 0, steps: typing(room.document) });
    const sent = messages(fx, 'c1');
    expect(sent.map((m) => m.t)).toEqual(['perm.changed', 'sync.reject']);
    expect(sent[1]).toMatchObject({ code: 'permission_denied', action: 'drop' });
    const changed = sent[0] as PermChanged;
    expect(changed.access.regions.get(LEGAL)?.has('edit')).toBe(false);
    // It is the server's access for Carol at that instant, complete.
    const server = computeAccess(USERS.carol, regionsOf(room.document), expiring(), now);
    expect(sameAccess(changed.access, server)).toBe(true);
    expect(fx.write).toBeNull();
  });

  it('does not send it twice: the later expiry run finds the channel up to date', () => {
    let now = T;
    const room = roomWith(baseDoc(), expiring(), () => now);
    room.open('c1', USERS.carol);
    now = T + 100;
    room.submit('c1', { id: commitId(), base: 0, steps: typing(room.document) });
    expect(messages(room.expire(), 'c1')).toEqual([]);
    // A second refused commit is judged under the access the channel now holds.
    const again = room.submit('c1', { id: commitId(), base: 0, steps: typing(room.document) });
    expect(messages(again, 'c1').map((m) => m.t)).toEqual(['sync.reject']);
  });

  it('an accepted commit after the expiry does not hide the change from the expiry run', () => {
    // Carol still edits the body. Her commit is judged under the new access and accepted; the
    // channel has not been told, so the expiry run must still send perm.changed.
    let now = T;
    const room = roomWith(baseDoc(), expiring(), () => now);
    room.open('c1', USERS.carol);
    now = T + 100;
    const fx = room.submit('c1', {
      id: commitId(),
      base: 0,
      steps: typing(room.document, 'pIntro0000000001'),
    });
    expect(fx.write).not.toBeNull();
    expect(messages(fx, 'c1').some((m) => m.t === 'perm.changed')).toBe(false);
    room.writeCompleted({ status: 'ok' });
    const changed = messages(room.expire(), 'c1').find((m) => m.t === 'perm.changed') as
      PermChanged | undefined;
    expect(changed?.access.regions.get(LEGAL)?.has('edit')).toBe(false);
  });

  it('sends nothing extra when perm.changed already reached the channel', () => {
    const room = roomWith(baseDoc(), expiring(), () => T);
    room.open('c1', USERS.carol);
    const before = room.permissionsChanged({ ...basePermissions(), revision: 2 });
    expect(messages(before, 'c1').map((m) => m.t)).toContain('perm.changed');
    const fx = room.submit('c1', { id: commitId(), base: 0, steps: typing(room.document) });
    expect(messages(fx, 'c1').map((m) => m.t)).toEqual(['sync.reject']);
  });

  it('a connection that can only view gets the rejection alone (P6), its access unchanged', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => T);
    room.open('f1', USERS.frank);
    const fx = room.submit('f1', {
      id: commitId(),
      base: 0,
      steps: typing(room.document, 'pIntro0000000001'),
    });
    expect(messages(fx, 'f1').map((m) => m.t)).toEqual(['sync.reject']);
  });
});
