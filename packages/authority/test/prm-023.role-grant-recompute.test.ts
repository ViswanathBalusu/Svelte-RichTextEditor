// A grant to a role placeholder follows the participant's binding (PRM-023 criterion 3; 07 §1, §4).
// The room recomputes access and sends `perm.changed` when a participant is bound (activated),
// replaced (the record names another person), removed, or when the workflow ends. A refreshed token
// whose `wfp` changes does the same (FRW-038 criterion 5, `frw-038.token-binding.test.ts`).
import { describe, expect, it } from 'vitest';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, Outbound, ToClient } from '../src/room/types.ts';
import {
  openWorkflow,
  voidWorkflow,
  type WorkflowParticipant,
  type WorkflowRecord,
} from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, baseDoc, schema } from './fixtures.ts';

const REGION = 'rLegal000000000B';
const HEAD = { seq: 1, hash: 'a'.repeat(64) };
const GRANT: RegionGrant = {
  region: REGION,
  principal: 'role:role_tenant',
  role: 'editor',
  expiresAt: null,
} as unknown as RegionGrant;

const person = (
  pid: string,
  order: number,
  extra: Partial<WorkflowParticipant> = {},
): WorkflowParticipant => ({
  id: pid,
  roles: ['role_tenant'],
  kind: 'filler',
  order,
  completed: false,
  sub: `sub-${pid}`,
  ...extra,
});

function sent(participants: WorkflowParticipant[]): WorkflowRecord {
  const draft: WorkflowRecord = {
    state: 'draft',
    participants,
    sentSeq: null,
    sentHash: null,
    end: null,
  };
  const result = sendWorkflow(draft, { manage: true }, BASE_JSON, HEAD);
  if (!result.ok) throw new Error(`the fixture document must send: ${JSON.stringify(result)}`);
  return result.record;
}

function permsFor(record: WorkflowRecord, revision: number): PermissionState {
  const lock = lockFor(record.state);
  if (lock === null) throw new Error(`no lock is decided for ${record.state}`);
  const base = basePermissions();
  return {
    ...base,
    revision,
    grants: [...base.grants, GRANT],
    documentState: lock.documentState,
    workflowActive: lock.workflowActive,
  };
}

function roomFor(record: WorkflowRecord): Room {
  const init: RoomInit = {
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: permsFor(record, 1),
    workflow: record,
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
  };
  return new Room(init);
}

const tokenConn = (sub: string, wfp: string): Connection => ({
  ...USERS.erin,
  sub,
  session: `s-${sub}`,
  participantClaim: { sub, wfp },
  participantRoles: [],
  participantActive: false,
});

const messages = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o: Outbound) => o.channel === channel).map((o) => o.msg);

function permOf(fx: Effects, channel: string) {
  const m = messages(fx, channel).find((x) => x.t === 'perm.changed');
  return m?.t === 'perm.changed' ? m : null;
}

function openedOf(fx: Effects, channel: string) {
  const m = messages(fx, channel).find((x) => x.t === 'ch.opened');
  if (m?.t !== 'ch.opened') throw new Error('no ch.opened');
  return m;
}

/** Whether the region is open to the connection by a grant (here, the placeholder's). */
const canGrant = (access: { granted: ReadonlySet<string> }): boolean => access.granted.has(REGION);

describe('access follows the binding of a role placeholder (PRM-023 criterion 3)', () => {
  it('gives the grant to a bound participant, and sends perm.changed when the binding is replaced', () => {
    const record = sent([person('first', 1)]);
    const room = roomFor(record);
    const opened = openedOf(room.open('c1', tokenConn('sub-first', 'first')), 'c1');
    expect(canGrant(opened.access)).toBe(true);

    // Replaced: the record names another person for the participant, so the connection's token no
    // longer binds and the grant goes.
    const replaced: WorkflowRecord = {
      ...record,
      participants: [person('first', 1, { sub: 'sub-someone-else' })],
    };
    const fx = room.workflowChanged(replaced);
    const changed = permOf(fx, 'c1');
    expect(changed).not.toBeNull();
    expect(canGrant(changed!.access)).toBe(false);
  });

  it('sends perm.changed when a participant is removed, and again when one is bound back', () => {
    const record = sent([person('first', 1), person('second', 2)]);
    const room = roomFor(record);
    room.open('c1', tokenConn('sub-second', 'second'));
    const removed = room.workflowChanged({ ...record, participants: [person('first', 1)] });
    const lost = permOf(removed, 'c1');
    expect(lost).not.toBeNull();
    expect(canGrant(lost!.access)).toBe(false);
    const bound = room.workflowChanged(record);
    const regained = permOf(bound, 'c1');
    expect(regained).not.toBeNull();
    expect(canGrant(regained!.access)).toBe(true);
  });

  it('sends perm.changed when a participant is bound after the connection opened', () => {
    const record = sent([person('first', 1)]);
    const room = roomFor(record);
    // A token for a participant the workflow does not list yet binds to no one.
    const opened = openedOf(room.open('c1', tokenConn('sub-late', 'late')), 'c1');
    expect(canGrant(opened.access)).toBe(false);
    const fx = room.workflowChanged({
      ...record,
      participants: [...record.participants, person('late', 2)],
    });
    const changed = permOf(fx, 'c1');
    expect(changed).not.toBeNull();
    expect(canGrant(changed!.access)).toBe(true);
  });

  it('sends perm.changed when the workflow ends: the placeholder then matches nobody', () => {
    const record = sent([person('first', 1)]);
    const opening = openWorkflow(record);
    if (!opening.ok) throw new Error('open');
    const room = roomFor(opening.record);
    expect(canGrant(openedOf(room.open('c1', tokenConn('sub-first', 'first')), 'c1').access)).toBe(
      true,
    );
    const ended = voidWorkflow(opening.record, { manage: true }, 'Stop');
    if (!ended.ok) throw new Error('void');
    const fx = room.workflowChanged(ended.record, permsFor(ended.record, 2));
    const changed = permOf(fx, 'c1');
    expect(changed).not.toBeNull();
    expect(canGrant(changed!.access)).toBe(false);
  });

  it('sends nothing when the workflow moves and the connection’s access does not', () => {
    const record = sent([person('first', 1), person('second', 2)]);
    const room = roomFor(record);
    room.open('c1', tokenConn('sub-first', 'first'));
    const fx = room.workflowChanged({ ...record, participants: [...record.participants] });
    expect(permOf(fx, 'c1')).toBeNull();
  });
});
