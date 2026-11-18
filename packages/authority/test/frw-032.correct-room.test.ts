// FRW-032 in the authority (lane w4): what the room does while a workflow is `correcting`.
// Criterion 2 (the room's half): a participant of the workflow is paused, so everything they send is
// refused as `read_only` and nothing is stored. Criterion 3: the owner may change the body and the
// fields, because the lock of `correcting` leaves the document active (`lockFor`). The participant
// is told by the connection's `participant`, which the token binding of FRW-038 will set in the
// service; here the connection names it. The client's half (the unsent values go to the recovered
// edits) is in packages/engine/test/frw-032.paused-recovered.test.ts.
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { correctWorkflow } from '../src/workflow/correction.ts';
import {
  openWorkflow,
  type WorkflowParticipant,
  type WorkflowRecord,
} from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { fillActive } from '../src/workflow/order.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  baseDoc,
  basePermissions,
  posInside,
  posOf,
  schema,
} from './fixtures.ts';

const FIELD = 'fTenantName00001';
const CH = 'ch-correct';
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const person = (pid: string, order: number): WorkflowParticipant => ({
  id: pid,
  roles: ['role_tenant'],
  kind: 'filler',
  order,
  completed: false,
});

function inProgress(): WorkflowRecord {
  const sent = sendWorkflow(
    {
      state: 'draft',
      participants: [person('p1', 1), person('p2', 2)],
      sentSeq: null,
      sentHash: null,
      end: null,
    },
    { manage: true },
    BASE_JSON,
    { seq: 1, hash: 'c'.repeat(64) },
  );
  if (!sent.ok) throw new Error('the fixture document must send');
  const opened = openWorkflow(sent.record);
  if (!opened.ok) throw new Error('a sent workflow must open');
  return opened.record;
}

function correcting(): WorkflowRecord {
  const out = correctWorkflow(inProgress(), { manage: true });
  if (!out.ok) throw new Error('an in-progress workflow must correct');
  return out.record;
}

function roomFor(record: WorkflowRecord): Room {
  const lock = lockFor(record.state);
  if (lock === null) throw new Error(`no lock is decided for ${record.state}`);
  return new Room({
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
    incarnation: 'inc-correct',
    now: () => 1_800_000_000_000,
    workflow: record,
  });
}

/** Opens the channel as participant `pid` of the workflow, who holds the tenant role. */
function openParticipant(room: Room, record: WorkflowRecord, pid: string): void {
  room.open(CH, {
    ...USERS.erin,
    sub: `user-${pid}`,
    session: `s-${pid}`,
    participant: pid,
    participantRoles: ['role_tenant'],
    participantActive: fillActive(record, pid),
  });
}

const fillSteps = (): Step[] => [new AttrStep(posOf(baseDoc(), FIELD), 'value', 'Ada')];
const textSteps = (): Step[] => {
  const pos = posInside(baseDoc(), 'pIntro0000000001');
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))];
};
const attrSteps = (): Step[] => [new AttrStep(posOf(baseDoc(), FIELD), 'key', 'tenant.renamed')];

const submit = (room: Room, steps: Step[]): Effects =>
  room.submit(CH, { id: id(), base: 0, steps: stepsToJson(steps) });

function rejection(fx: Effects): Extract<ToClient, { t: 'sync.reject' }> | undefined {
  const m = fx.send.find((o) => o.channel === CH && o.msg.t === 'sync.reject')?.msg;
  return m?.t === 'sync.reject' ? m : undefined;
}

describe('a paused participant is refused with read_only (FRW-032 criterion 2, the room)', () => {
  it('is paused for every participant of a workflow that is correcting, whatever their order', () => {
    const record = correcting();
    expect(record.state).toBe('correcting');
    for (const pid of ['p1', 'p2']) expect(fillActive(record, pid)).toBe(false);
  });

  for (const [what, steps] of [
    ['a fill of their own field', fillSteps],
    ['a change of the text', textSteps],
    ['a change of a field attribute', attrSteps],
  ] as const) {
    it(`refuses ${what} with read_only and stores nothing`, () => {
      const record = correcting();
      for (const pid of ['p1', 'p2']) {
        const room = roomFor(record);
        openParticipant(room, record, pid);
        const fx = submit(room, steps());
        expect(rejection(fx), `${pid} ${what}`).toMatchObject({
          code: 'read_only',
          action: 'drop',
        });
        expect(fx.write).toBeNull();
        expect(room.document.eq(baseDoc())).toBe(true);
      }
    });
  }

  it('lets the same participant fill while the workflow is in progress, and again after it resumes', () => {
    const record = inProgress();
    const room = roomFor(record);
    openParticipant(room, record, 'p1');
    const fx = submit(room, fillSteps());
    expect(rejection(fx)).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });

  it('does not call a viewer paused: the document is active, so their refusal is the permission one', () => {
    const record = correcting();
    const room = roomFor(record);
    room.open(CH, USERS.frank);
    const fx = submit(room, fillSteps());
    expect(rejection(fx)).toMatchObject({ code: 'permission_denied' });
    expect(fx.write).toBeNull();
  });
});

describe('the owner may correct the body and the fields (FRW-032 criterion 3)', () => {
  it('leaves the document active with no workflow running while it is correcting', () => {
    expect(lockFor('correcting')).toEqual({ documentState: 'active', workflowActive: false });
  });

  for (const [what, steps] of [
    ['the text of the body', textSteps],
    ['an attribute of a field', attrSteps],
    ['the value of a field', fillSteps],
  ] as const) {
    it(`accepts a change of ${what} by an owner with edit`, () => {
      const record = correcting();
      const room = roomFor(record);
      room.open(CH, USERS.alice);
      const fx = submit(room, steps());
      expect(rejection(fx), what).toBeUndefined();
      expect(fx.write, what).not.toBeNull();
    });
  }

  it('refuses the owner again once the workflow is back in progress (read_only)', () => {
    const record = inProgress();
    const room = roomFor(record);
    room.open(CH, USERS.alice);
    const fx = submit(room, textSteps());
    expect(rejection(fx)).toMatchObject({ code: 'read_only' });
  });
});
