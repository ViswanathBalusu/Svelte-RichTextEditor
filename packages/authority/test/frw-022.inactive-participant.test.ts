// The authority refuses a fill from a participant who is not active (FRW-022 criterion 4; 12 §4.2 P7;
// lane V-FRW-019-036). The participant's `participantActive` is derived from the workflow record with
// `fillActive`, and the room's permission state with `lockFor`, for each way a participant can be
// inactive: waiting for an earlier order, completed, and in a declined or voided workflow. The
// `paused` case is not in the workflow's states (12 §6), so it is not tested here.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  declineWorkflow,
  openWorkflow,
  voidWorkflow,
  type WorkflowParticipant,
  type WorkflowRecord,
} from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { completeParticipant, fillActive } from '../src/workflow/order.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, baseDoc, posOf, schema } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const HEAD = { seq: 1, hash: 'c'.repeat(64) };
const OWNER = { manage: true };
const CH = 'ch-inactive';
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const p = (pid: string, order: number): WorkflowParticipant => ({
  id: pid,
  roles: ['role_tenant'],
  kind: 'filler',
  order,
  completed: false,
});

function sent(participants: WorkflowParticipant[]): WorkflowRecord {
  const draft: WorkflowRecord = {
    state: 'draft',
    participants,
    sentSeq: null,
    sentHash: null,
    end: null,
  };
  const result = sendWorkflow(draft, OWNER, BASE_JSON, HEAD);
  if (!result.ok) throw new Error('the fixture document must send');
  return result.record;
}

function roomFor(record: WorkflowRecord): Room {
  const lock = lockFor(record.state);
  if (lock === null) throw new Error(`no lock is decided for ${record.state}`);
  const init: RoomInit = {
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: {
      ...basePermissions(),
      documentState: lock.documentState,
      workflowActive: lock.workflowActive,
    },
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
  };
  return new Room(init);
}

/** Opens the channel as the participant, with `participantActive` taken from the workflow. */
function openAs(room: Room, record: WorkflowRecord, pid: string): Effects {
  return room.open(CH, {
    ...USERS.erin,
    sub: pid,
    session: `s-${pid}`,
    participantRoles: ['role_tenant'],
    participantActive: fillActive(record, pid),
  });
}

function fill(room: Room): Effects {
  const doc = baseDoc();
  return room.submit(CH, {
    id: id(),
    base: 0,
    steps: stepsToJson([new AttrStep(posOf(doc, FIELD), 'value', 'Ada')]),
  });
}

type Reject = Extract<ToClient, { t: 'sync.reject' }>;
function rejection(fx: Effects): Reject | undefined {
  const m = fx.send.find((o) => o.channel === CH && o.msg.t === 'sync.reject')?.msg;
  return m?.t === 'sync.reject' ? m : undefined;
}

/**
 * Refuses the fill with the code the room gives. The criterion says `permission_denied`; in a locked
 * document (`declined`, `voided`) the room refuses first on the document state, as `read_only`
 * (room/room.ts, the state check before the fill check). That is recorded in the story Notes.
 */
function expectRefused(
  record: WorkflowRecord,
  pid: string,
  code: string = 'permission_denied',
): void {
  const room = roomFor(record);
  openAs(room, record, pid);
  const fx = fill(room);
  expect(rejection(fx)).toMatchObject({ code });
  expect(fx.write).toBeNull();
  expect(room.document.eq(baseDoc())).toBe(true);
}

describe('a participant who is not active is refused a fill (FRW-022 criterion 4)', () => {
  it('refuses the order 2 participant while the order 1 participant has not completed', () => {
    const record = sent([p('first', 1), p('second', 2)]);
    expect(fillActive(record, 'second')).toBe(false);
    expectRefused(record, 'second');
  });

  it('refuses a participant who has completed, once the next order is active', () => {
    const inProgress = openWorkflow(sent([p('first', 1), p('second', 2)]));
    if (!inProgress.ok) throw new Error('a sent workflow must open');
    const done = completeParticipant(inProgress.record, 'first');
    if (!done.ok) throw new Error('the first participant must complete');
    expect(fillActive(done.record, 'first')).toBe(false);
    expect(fillActive(done.record, 'second')).toBe(true);
    expectRefused(done.record, 'first');
  });

  it('refuses every participant of a declined workflow (refused as read_only, see expectRefused)', () => {
    const inProgress = openWorkflow(sent([p('first', 1), p('second', 2)]));
    if (!inProgress.ok) throw new Error('a sent workflow must open');
    const declined = declineWorkflow(inProgress.record, 'first', 'Not agreed');
    if (!declined.ok) throw new Error('the active participant must be able to decline');
    expect(declined.record.state).toBe('declined');
    expect(lockFor('declined')).toEqual({ documentState: 'locked', workflowActive: false });
    expectRefused(declined.record, 'first', 'read_only');
    expectRefused(declined.record, 'second', 'read_only');
  });

  it('refuses every participant of a voided workflow (refused as read_only, see expectRefused)', () => {
    const voided = voidWorkflow(sent([p('first', 1), p('second', 2)]), OWNER, 'Withdrawn');
    if (!voided.ok) throw new Error('an owner may void a sent workflow');
    expect(voided.record.state).toBe('voided');
    expect(lockFor('voided')).toEqual({ documentState: 'locked', workflowActive: false });
    expectRefused(voided.record, 'first', 'read_only');
    expectRefused(voided.record, 'second', 'read_only');
  });
});
