// A host-minted token fills as the participant it binds to (FRW-038 criteria 1, 2, 5 and 6, at the
// room). The connection carries the token's raw `sub` and `wfp` (`participantClaim`) and nothing it
// claims about roles: the room binds them to a participant of the workflow it holds, takes that
// participant's roles, and gives no fill capability to a token that binds to no one, or whose
// workflow has ended, however long the token still lives.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { fillSummary } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, Outbound, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { bindParticipant } from '../src/workflow/binding.ts';
import {
  declineWorkflow,
  openWorkflow,
  voidWorkflow,
  type WorkflowParticipant,
  type WorkflowRecord,
} from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { expireIfDue } from '../src/workflow/schedule.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, baseDoc, posOf, schema } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const HEAD = { seq: 1, hash: 'a'.repeat(64) };
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

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
  return {
    ...basePermissions(),
    revision,
    documentState: lock.documentState,
    workflowActive: lock.workflowActive,
  };
}

function roomFor(record: WorkflowRecord | null): Room {
  const init: RoomInit = {
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: record === null ? { ...basePermissions(), revision: 1 } : permsFor(record, 1),
    ...(record !== null ? { workflow: record } : {}),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
  };
  return new Room(init);
}

/**
 * A connection the way the service builds it from a token with `wfp`: the claim, and fill roles and
 * a flag that the token's own claims could set and that the room must not trust.
 */
const tokenConn = (sub: string, wfp: string, forged = true): Connection => ({
  ...USERS.erin,
  sub,
  session: `s-${sub}`,
  participantClaim: { sub, wfp },
  participantRoles: forged ? ['role_forged'] : [],
  participantActive: forged,
});

const toChannel = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o: Outbound) => o.channel === channel).map((o) => o.msg);

function openedOf(fx: Effects, channel: string) {
  const m = toChannel(fx, channel).find((x) => x.t === 'ch.opened');
  if (m?.t !== 'ch.opened') throw new Error('no ch.opened');
  return m;
}

function permOf(fx: Effects, channel: string) {
  const m = toChannel(fx, channel).find((x) => x.t === 'perm.changed');
  return m?.t === 'perm.changed' ? m : null;
}

function fill(room: Room, channel: string, value: string, base = 0): Effects {
  return room.submit(channel, {
    id: id(),
    base,
    steps: stepsToJson([new AttrStep(posOf(baseDoc(), FIELD), 'value', value)]),
  });
}

const rejected = (fx: Effects, channel: string) =>
  toChannel(fx, channel).find((m) => m.t === 'sync.reject');

describe('a token with wfp fills as the participant it binds to (FRW-038 criterion 1)', () => {
  it('gives the participant, and the roles of that participant in the workflow, not the token’s', () => {
    const record = sent([person('first', 1), person('second', 2, { roles: ['role_landlord'] })]);
    const room = roomFor(record);
    const opened = openedOf(room.open('c1', tokenConn('sub-first', 'first')), 'c1');
    expect(opened.access.fill.participant).toBe('first');
    expect(opened.access.fill.roles).toEqual(['role_tenant']);
    expect(opened.access.fill.active).toBe(true);
    expect(opened.access.fill.allowed).toBe(true);
    // On the wire: the participant identifier, the roles and whether it is active.
    expect(fillSummary(opened.access)).toEqual({
      participant: 'first',
      roles: ['role_tenant'],
      active: true,
    });
    // The second participant is bound too, but is not active yet: its roles are its own.
    const waiting = openedOf(room.open('c2', tokenConn('sub-second', 'second')), 'c2');
    expect(waiting.access.fill.roles).toEqual(['role_landlord']);
    expect(waiting.access.fill.active).toBe(false);
    expect(waiting.access.fill.participant).toBe('second');
  });

  it('lets the bound, active participant fill, and refuses the one who is waiting', () => {
    const record = sent([person('first', 1), person('second', 2)]);
    const room = roomFor(record);
    room.open('c1', tokenConn('sub-first', 'first'));
    room.open('c2', tokenConn('sub-second', 'second'));
    expect(rejected(fill(room, 'c1', 'Ada'), 'c1')).toBeUndefined();
    expect(rejected(fill(room, 'c2', 'Bea'), 'c2')).toBeDefined();
  });
});

describe('a token that binds to no one has no fill capability (FRW-038 criterion 2)', () => {
  const cases: Array<[string, WorkflowParticipant[], string, string]> = [
    [
      'a wfp that names no participant of this workflow',
      [person('first', 1)],
      'sub-first',
      'elsewhere',
    ],
    ['a sub that differs from the participant’s', [person('first', 1)], 'sub-other', 'first'],
    [
      'a participant with no recorded sub',
      [{ id: 'first', roles: ['role_tenant'], kind: 'filler', order: 1, completed: false }],
      'sub-first',
      'first',
    ],
  ];
  for (const [name, participants, sub, wfp] of cases) {
    it(`gives nothing for ${name}, whatever roles the token claims`, () => {
      const room = roomFor(sent(participants));
      const opened = openedOf(room.open('c1', tokenConn(sub, wfp)), 'c1');
      expect(opened.access.fill.allowed).toBe(true); // the document role may fill ...
      expect(opened.access.fill.roles).toEqual([]); // ... but no participant is bound
      expect(opened.access.fill.active).toBe(false);
      expect(opened.access.fill.participant).toBeNull();
      expect(fillSummary(opened.access)).toBeNull();
      expect(rejected(fill(room, 'c1', 'Ada'), 'c1')).toBeDefined();
    });
  }

  it('gives nothing on a document with no workflow, and none of the pure binding either', () => {
    const room = roomFor(null);
    const opened = openedOf(room.open('c1', tokenConn('sub-first', 'first')), 'c1');
    expect(fillSummary(opened.access)).toBeNull();
    expect(rejected(fill(room, 'c1', 'Ada'), 'c1')).toBeDefined();
    const record = sent([person('first', 1)]);
    expect(
      bindParticipant({ sub: 'sub-first', wfp: 'another-workflows-participant' }, record).ok,
    ).toBe(false);
  });

  it('leaves a connection with no wfp as it was: the form mode keeps its roles', () => {
    const room = roomFor(sent([person('first', 1)]));
    const conn: Connection = {
      ...USERS.erin,
      participantRoles: ['role_tenant'],
      participantActive: true,
    };
    const opened = openedOf(room.open('c1', conn), 'c1');
    expect(opened.access.fill.roles).toEqual(['role_tenant']);
  });
});

describe('a refreshed token recomputes access and sends perm.changed (FRW-038 criterion 5)', () => {
  it('sends perm.changed with the other participant’s roles when wfp changes, for the same person', () => {
    // One person (one `sub`) holds two participants of the workflow, with different roles.
    const record = sent([
      person('first', 1, { sub: 'sub-x' }),
      person('second', 1, { sub: 'sub-x', roles: ['role_landlord'] }),
    ]);
    const room = roomFor(record);
    room.open('c1', tokenConn('sub-x', 'first'));
    const same = room.refresh('c1', tokenConn('sub-x', 'first'));
    expect(permOf(same, 'c1')).toBeNull();
    const other = permOf(room.refresh('c1', tokenConn('sub-x', 'second')), 'c1');
    expect(other).not.toBeNull();
    expect(other!.access.fill.roles).toEqual(['role_landlord']);
    expect(other!.access.fill.participant).toBe('second');
    const lost = permOf(room.refresh('c1', tokenConn('sub-x', 'missing')), 'c1');
    expect(lost).not.toBeNull();
    expect(lost!.access.fill.roles).toEqual([]);
    expect(fillSummary(lost!.access)).toBeNull();
  });
  it('drops the roles of a refreshed token that no longer carries wfp, in the form mode’s terms', () => {
    const record = sent([person('first', 1)]);
    const room = roomFor(record);
    room.open('c1', tokenConn('sub-first', 'first'));
    const plain: Connection = {
      ...USERS.erin,
      sub: 'sub-first',
      session: 's-sub-first',
      participantRoles: [],
      participantActive: false,
    };
    const fx = room.refresh('c1', plain);
    expect(permOf(fx, 'c1')!.access.fill.roles).toEqual([]);
  });
});

describe('a workflow that has ended gives its participants no fill (FRW-038 criterion 6)', () => {
  const ended: Array<[string, (r: WorkflowRecord) => WorkflowRecord]> = [
    [
      'declined',
      (r) => {
        const opened = openWorkflow(r);
        if (!opened.ok) throw new Error('open');
        const out = declineWorkflow(opened.record, 'first', 'No');
        if (!out.ok) throw new Error('decline');
        return out.record;
      },
    ],
    [
      'voided',
      (r) => {
        const out = voidWorkflow(r, { manage: true }, 'Stop');
        if (!out.ok) throw new Error('void');
        return out.record;
      },
    ],
    [
      'expired',
      (r) => {
        const out = expireIfDue(r, 1_000, 2_000);
        if (!out.ok) throw new Error('expire');
        return out.record;
      },
    ],
  ];
  for (const [state, end] of ended) {
    it(`takes the capability away from a connected participant when the workflow is ${state}, and from a token opened after`, () => {
      const record = sent([person('first', 1)]);
      const room = roomFor(record);
      const before = openedOf(room.open('c1', tokenConn('sub-first', 'first')), 'c1');
      expect(fillSummary(before.access)).not.toBeNull();
      const next = end(record);
      expect(next.state).toBe(state);
      const fx = room.workflowChanged(next, permsFor(next, 2));
      const changed = permOf(fx, 'c1');
      expect(changed).not.toBeNull();
      expect(fillSummary(changed!.access)).toBeNull();
      expect(rejected(fill(room, 'c1', 'Ada'), 'c1')).toBeDefined();
      // A channel opened later with a token that has not expired gets none either.
      const later = openedOf(room.open('c2', tokenConn('sub-first', 'first')), 'c2');
      expect(fillSummary(later.access)).toBeNull();
      expect(rejected(fill(room, 'c2', 'Bea'), 'c2')).toBeDefined();
    });
  }
});
