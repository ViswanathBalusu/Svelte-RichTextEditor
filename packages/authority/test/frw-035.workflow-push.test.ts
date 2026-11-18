// The workflow state is pushed to connected clients (FRW-035 criteria 1 to 5, at the room): `ch.opened`
// carries the `workflow` object, a transition sends `perm.changed` and then `wf.changed`, the room
// enforces the new access from the moment it computes it, a reconnecting client is brought to the
// current state by `ch.opened`, and a participant never receives another participant's entry.
// The record comes from the real `sendWorkflow`, `openWorkflow` and `completeParticipant`.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, Outbound, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  openWorkflow,
  type WorkflowParticipant,
  type WorkflowRecord,
} from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { completeParticipant } from '../src/workflow/order.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { workflowStatus } from '../src/workflow/state-view.ts';
import type { PermissionState } from '../src/permissions/model.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, baseDoc, posOf, schema } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const HEAD = { seq: 1, hash: 'a'.repeat(64) };
const OWNER = { manage: true };
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;
const channelOf = (pid: string) => `ch-${pid}`;

const p = (
  pid: string,
  order: number,
  kind: WorkflowParticipant['kind'] = 'filler',
): WorkflowParticipant => ({ id: pid, roles: ['role_tenant'], kind, order, completed: false });

function sent(participants: WorkflowParticipant[]): WorkflowRecord {
  const draft: WorkflowRecord = {
    state: 'draft',
    participants,
    sentSeq: null,
    sentHash: null,
    end: null,
  };
  const result = sendWorkflow(draft, OWNER, BASE_JSON, HEAD);
  if (!result.ok) throw new Error(`the fixture document must send: ${JSON.stringify(result)}`);
  return result.record;
}

/** The permission state a record's lock implies, at a grants revision. */
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

/**
 * A participant's connection. `participantActive` is deliberately left false and stale: the room must
 * derive it from the workflow record (the token's claim was issued before the transition).
 */
const participantConn = (pid: string) => ({
  ...USERS.erin,
  sub: pid,
  session: `s-${pid}`,
  participant: pid,
  participantRoles: ['role_tenant'],
  participantActive: false,
});

const toChannel = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o: Outbound) => o.channel === channel).map((o) => o.msg);

function openedOf(fx: Effects, channel: string) {
  const m = toChannel(fx, channel).find((x) => x.t === 'ch.opened');
  if (m?.t !== 'ch.opened') throw new Error('no ch.opened');
  return m;
}

function fillOf(room: Room, pid: string) {
  return room.submit(channelOf(pid), {
    id: id(),
    base: 0,
    steps: stepsToJson([new AttrStep(posOf(baseDoc(), FIELD), 'value', `by ${pid}`)]),
  });
}

const rejected = (fx: Effects, channel: string) =>
  toChannel(fx, channel).find((m) => m.t === 'sync.reject');

/** Opens a channel for each named participant, and one for an owner who is no participant. */
function openAll(room: Room, pids: string[]): Record<string, Effects> {
  const out: Record<string, Effects> = {};
  for (const pid of pids) out[pid] = room.open(channelOf(pid), participantConn(pid));
  out['owner'] = room.open('ch-owner', { ...USERS.alice });
  return out;
}

describe('ch.opened carries the workflow (FRW-035 criterion 1)', () => {
  it('sends the state and the connection’s own participant status', () => {
    const record = sent([p('first', 1), p('second', 2), p('copy', 3, 'cc')]);
    const room = roomFor(record);
    const opens = openAll(room, ['first', 'second', 'copy']);
    expect(openedOf(opens['first']!, channelOf('first')).workflow).toEqual({
      state: 'sent',
      participant: { id: 'first', state: 'active' },
    });
    expect(openedOf(opens['second']!, channelOf('second')).workflow).toEqual({
      state: 'sent',
      participant: { id: 'second', state: 'waiting' },
    });
    expect(openedOf(opens['copy']!, channelOf('copy')).workflow).toEqual({
      state: 'sent',
      participant: { id: 'copy', state: 'copy' },
    });
    // Not a participant: the state alone.
    expect(openedOf(opens['owner']!, 'ch-owner').workflow).toEqual({ state: 'sent' });
  });

  it('leaves the member out when the document has no workflow', () => {
    const init: RoomInit = {
      schema,
      initial: baseDoc(),
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now: () => 1_800_000_000_000,
    };
    const room = new Room(init);
    const fx = room.open('ch-owner', { ...USERS.alice });
    expect('workflow' in openedOf(fx, 'ch-owner')).toBe(false);
  });
});

describe('a transition pushes perm.changed and wf.changed (FRW-035 criteria 2 and 3)', () => {
  function transition() {
    const record = sent([p('first', 1), p('second', 2), p('third', 3)]);
    const room = roomFor(record);
    openAll(room, ['first', 'second', 'third']);
    const opened = openWorkflow(record);
    if (!opened.ok) throw new Error('a sent workflow must open');
    const completed = completeParticipant(opened.record, 'first');
    if (!completed.ok) throw new Error('the active participant must complete');
    const fx = room.workflowChanged(completed.record, permsFor(completed.record, 2));
    return { room, fx, record: completed.record };
  }

  it('sends the complete new object, after perm.changed, to each connection', () => {
    const { fx } = transition();
    const first = toChannel(fx, channelOf('first'));
    expect(first.map((m) => m.t)).toEqual(['perm.changed', 'wf.changed']);
    expect(first[1]).toEqual({
      t: 'wf.changed',
      workflow: { state: 'in_progress', participant: { id: 'first', state: 'completed' } },
    });
    const second = toChannel(fx, channelOf('second'));
    expect(second.map((m) => m.t)).toEqual(['perm.changed', 'wf.changed']);
    expect(second[1]).toEqual({
      t: 'wf.changed',
      workflow: { state: 'in_progress', participant: { id: 'second', state: 'active' } },
    });
  });

  it('raises the access revision and recomputes the fill flag from the record (criterion 3)', () => {
    const { fx } = transition();
    const perm = (pid: string) => {
      const m = toChannel(fx, channelOf(pid)).find((x) => x.t === 'perm.changed');
      if (m?.t !== 'perm.changed') throw new Error('no perm.changed');
      return m;
    };
    expect(perm('first').revision).toBe(2);
    expect(perm('first').access.revision).toBe(2);
    expect(perm('first').access.fill.active).toBe(false);
    expect(perm('second').access.fill.active).toBe(true);
    expect(perm('third').access.fill.active).toBe(false);
    // The revision is recorded as a control commit, as for any change of permissions.
    expect(fx.write?.commits.map((c) => [c.kind, c.revision])).toEqual([['control', 2]]);
  });

  it('enforces the new permissions from the moment the room computes them', () => {
    const record = sent([p('first', 1), p('second', 2)]);
    const room = roomFor(record);
    openAll(room, ['first', 'second']);
    expect(rejected(fillOf(room, 'second'), channelOf('second'))).toMatchObject({
      code: 'permission_denied',
    });
    const opened = openWorkflow(record);
    if (!opened.ok) throw new Error('a sent workflow must open');
    const done = completeParticipant(opened.record, 'first');
    if (!done.ok) throw new Error('the active participant must complete');
    room.workflowChanged(done.record, permsFor(done.record, 2));
    // The stale token claim (`participantActive: false`) no longer decides.
    expect(rejected(fillOf(room, 'second'), channelOf('second'))).toBeUndefined();
    expect(rejected(fillOf(room, 'first'), channelOf('first'))).toMatchObject({
      code: 'permission_denied',
    });
  });

  it('tells a connection nothing when its own object did not change', () => {
    const record = sent([p('first', 1), p('second', 2), p('third', 3)]);
    const room = roomFor(record);
    openAll(room, ['first', 'second', 'third']);
    const opened = openWorkflow(record);
    if (!opened.ok) throw new Error('a sent workflow must open');
    room.workflowChanged(opened.record, permsFor(opened.record, 2));
    const done = completeParticipant(opened.record, 'first');
    if (!done.ok) throw new Error('the active participant must complete');
    const fx = room.workflowChanged(done.record, permsFor(done.record, 3));
    // The third participant is still waiting in `in_progress`: no wf.changed for it.
    expect(toChannel(fx, channelOf('third')).map((m) => m.t)).toEqual(['perm.changed']);
    expect(toChannel(fx, channelOf('second')).map((m) => m.t)).toEqual([
      'perm.changed',
      'wf.changed',
    ]);
  });

  it('sends wf.changed with perm.changed for a lock change (void)', () => {
    const record = sent([p('first', 1)]);
    const room = roomFor(record);
    openAll(room, ['first']);
    const voided: WorkflowRecord = {
      ...record,
      state: 'voided',
      end: { state: 'voided', by: null, reason: 'withdrawn' },
    };
    const fx = room.workflowChanged(voided, permsFor(voided, 2));
    expect(toChannel(fx, channelOf('first')).map((m) => m.t)).toEqual([
      'perm.changed',
      'wf.changed',
    ]);
    expect(toChannel(fx, 'ch-owner')[1]).toEqual({
      t: 'wf.changed',
      workflow: { state: 'voided' },
    });
  });
});

describe('a client that missed a transition is brought to the current state (criterion 4)', () => {
  it('shows the current object on the next ch.opened of the same room', () => {
    const record = sent([p('first', 1), p('second', 2)]);
    const room = roomFor(record);
    const opened = openWorkflow(record);
    if (!opened.ok) throw new Error('a sent workflow must open');
    const done = completeParticipant(opened.record, 'first');
    if (!done.ok) throw new Error('the active participant must complete');
    // 'second' was disconnected during the transition.
    room.workflowChanged(done.record, permsFor(done.record, 2));
    const fx = room.open(channelOf('second'), participantConn('second'));
    const o = openedOf(fx, channelOf('second'));
    expect(o.workflow).toEqual({
      state: 'in_progress',
      participant: { id: 'second', state: 'active' },
    });
    expect(o.access.fill.active).toBe(true);
    expect(o.access.revision).toBe(2);
  });

  it('shows it on a room started after the transition (a new room, a reconnect after a restart)', () => {
    const record = sent([p('first', 1), p('second', 2)]);
    const opened = openWorkflow(record);
    if (!opened.ok) throw new Error('a sent workflow must open');
    const done = completeParticipant(opened.record, 'first');
    if (!done.ok) throw new Error('the active participant must complete');
    const room = roomFor(done.record);
    const o = openedOf(room.open(channelOf('first'), participantConn('first')), channelOf('first'));
    expect(o.workflow).toEqual({
      state: 'in_progress',
      participant: { id: 'first', state: 'completed' },
    });
  });
});

describe('a message carries only the receiving participant’s status (criterion 5)', () => {
  it('never names another participant, its sub or its roles', () => {
    const record = sent([
      { ...p('first', 1), sub: 'user:first-secret' },
      { ...p('second', 2), sub: 'user:second-secret', roles: ['role_landlord'] },
    ]);
    const room = roomFor(record);
    const opens = openAll(room, ['first']);
    const opened = openWorkflow(record);
    if (!opened.ok) throw new Error('a sent workflow must open');
    const done = completeParticipant(opened.record, 'first');
    if (!done.ok) throw new Error('the active participant must complete');
    const fx = room.workflowChanged(done.record, permsFor(done.record, 2));
    const everything = JSON.stringify([
      openedOf(opens['first']!, channelOf('first')).workflow,
      toChannel(fx, channelOf('first')).filter((m) => m.t === 'wf.changed'),
    ]);
    expect(everything).not.toMatch(/second|secret|role_landlord/);
  });

  it('is the same object the pure view builds for the connection', () => {
    const record = sent([p('first', 1), p('second', 2)]);
    expect(workflowStatus(record, 'second')).toEqual({
      state: 'sent',
      participant: { id: 'second', state: 'waiting' },
    });
    expect(workflowStatus(record, 'nobody')).toEqual({ state: 'sent' });
    expect(workflowStatus(record, null)).toEqual({ state: 'sent' });
  });
});
