// Participants are activated in order at the room (FRW-031 criteria 1 and 3, and the fill part of
// FRW-022 criterion 4; lane V-FRW-019-036). The workflow record is sent with the real `sendWorkflow`,
// its document lock comes from `lockFor`, and each participant's `participantActive` is derived with
// `fillActive`, the same derivation the workflow service will use. Nothing here stores a completion,
// raises `participant_activated` or pushes `wf.changed`: those are FRW-035 and FRW-036.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  openWorkflow,
  type WorkflowParticipant,
  type WorkflowRecord,
} from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { completeParticipant, fillActive } from '../src/workflow/order.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, baseDoc, posOf, schema } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const HEAD = { seq: 1, hash: 'a'.repeat(64) };
const OWNER = { manage: true };
const CHANNEL_FOR = (sub: string) => `ch-${sub}`;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const p = (
  pid: string,
  order: number,
  kind: WorkflowParticipant['kind'] = 'filler',
): WorkflowParticipant => ({
  id: pid,
  // Both participants hold the role of the field, so only the order separates them.
  roles: ['role_tenant'],
  kind,
  order,
  completed: false,
});

/** A draft sent with the real send; the document is the fixture whose field both hold the role of. */
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

/** A room whose permission state is the one the record's state implies (FRW-029 `lockFor`). */
function roomFor(record: WorkflowRecord): Room {
  const lock = lockFor(record.state);
  if (lock === null) throw new Error(`no lock is decided for ${record.state}`);
  const perms = {
    ...basePermissions(),
    documentState: lock.documentState,
    workflowActive: lock.workflowActive,
  };
  const init: RoomInit = {
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms,
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
  };
  return new Room(init);
}

/** The user for a participant: the filler of the role, active exactly when the workflow says so. */
function userFor(record: WorkflowRecord, pid: string) {
  return {
    ...USERS.erin,
    sub: pid,
    session: `s-${pid}`,
    participantRoles: ['role_tenant'],
    participantActive: fillActive(record, pid),
  };
}

function fillOf(room: Room, pid: string, base = 0) {
  const doc = baseDoc();
  return room.submit(CHANNEL_FOR(pid), {
    id: id(),
    base,
    steps: stepsToJson([new AttrStep(posOf(doc, FIELD), 'value', `by ${pid}`)]),
  });
}

type Reject = Extract<ToClient, { t: 'sync.reject' }>;
function rejection(fx: Effects, channel: string): Reject | undefined {
  const m = fx.send.find((o) => o.channel === channel && o.msg.t === 'sync.reject')?.msg;
  return m?.t === 'sync.reject' ? m : undefined;
}
function opened(fx: Effects, channel: string) {
  return fx.send.find((o) => o.channel === channel && o.msg.t === 'ch.opened')?.msg;
}

describe('only the lowest order may fill once the workflow is sent (FRW-031 criterion 1)', () => {
  it('lets the order 1 participant fill and lets the order 2 participant open but not fill', () => {
    const record = sent([p('first', 1), p('second', 2)]);
    expect(record.state).toBe('sent');
    expect(fillActive(record, 'first')).toBe(true);
    expect(fillActive(record, 'second')).toBe(false);

    const room = roomFor(record);
    const a = room.open(CHANNEL_FOR('first'), userFor(record, 'first'));
    expect(opened(a, CHANNEL_FOR('first'))).toMatchObject({
      t: 'ch.opened',
      access: { fill: { active: true } },
    });
    const b = room.open(CHANNEL_FOR('second'), userFor(record, 'second'));
    // The order 2 participant can open the document (read) but its fill is not active.
    expect(opened(b, CHANNEL_FOR('second'))).toMatchObject({
      t: 'ch.opened',
      access: { fill: { active: false } },
    });

    const refused = fillOf(room, 'second');
    expect(rejection(refused, CHANNEL_FOR('second'))).toMatchObject({
      code: 'permission_denied',
      reason: expect.stringMatching(/not active/),
    });
    expect(refused.write).toBeNull();

    const accepted = fillOf(room, 'first');
    expect(rejection(accepted, CHANNEL_FOR('first'))).toBeUndefined();
    expect(accepted.write).not.toBeNull();
  });
});

describe('the next order is activated when the lowest order completes (FRW-031 criterion 2, state part)', () => {
  it('moves the fill to the order 2 participant only after the order 1 participant completes', () => {
    const sentRecord = sent([p('first', 1), p('second', 2)]);
    const inProgress = openWorkflow(sentRecord);
    if (!inProgress.ok) throw new Error('a sent workflow must open');
    const completion = completeParticipant(inProgress.record, 'first');
    if (!completion.ok) throw new Error('the active participant must complete');
    expect(completion.completion.activated).toEqual(['second']);
    expect(completion.completion.completedWorkflow).toBe(false);
    expect(completion.record.state).toBe('in_progress');

    const room = roomFor(completion.record);
    room.open(CHANNEL_FOR('second'), userFor(completion.record, 'second'));
    const fx = fillOf(room, 'second');
    expect(rejection(fx, CHANNEL_FOR('second'))).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });

  it('moves the workflow to completed when the last must-act participant completes (criterion 6)', () => {
    const sentRecord = sent([p('first', 1), p('second', 2)]);
    const inProgress = openWorkflow(sentRecord);
    if (!inProgress.ok) throw new Error('a sent workflow must open');
    const first = completeParticipant(inProgress.record, 'first');
    if (!first.ok) throw new Error('the first participant must complete');
    const last = completeParticipant(first.record, 'second');
    if (!last.ok) throw new Error('the second participant must complete');
    expect(last.completion.completedWorkflow).toBe(true);
    expect(last.record.state).toBe('completed');
  });
});

describe('participants of the same order are active together (FRW-031 criterion 3, fill part)', () => {
  it('lets both same-order participants fill at once', () => {
    const record = sent([p('left', 1), p('right', 1)]);
    expect(fillActive(record, 'left')).toBe(true);
    expect(fillActive(record, 'right')).toBe(true);

    const room = roomFor(record);
    room.open(CHANNEL_FOR('left'), userFor(record, 'left'));
    room.open(CHANNEL_FOR('right'), userFor(record, 'right'));
    expect(rejection(fillOf(room, 'right'), CHANNEL_FOR('right'))).toBeUndefined();
    // The second fill is based on the first one's commit (base 1), so it is not a conflict.
    expect(rejection(fillOf(room, 'left', 1), CHANNEL_FOR('left'))).toBeUndefined();
  });
});
