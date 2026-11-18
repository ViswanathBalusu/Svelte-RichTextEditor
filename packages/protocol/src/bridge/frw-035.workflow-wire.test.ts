// FRW-035 on the wire (12 §10; 05 §5.2, §5.5): the room bridge puts the workflow object into
// `ch.opened`, and turns the room's `wf.changed` into a DEP `wf.changed` that follows the
// `perm.changed` of the same transition (which is held until its control commit is delivered, D12).
// The payloads are checked against the generated schema. Node.js only.
import {
  Room,
  completeParticipant,
  lockFor,
  openWorkflow,
  sendWorkflow,
  type PermissionState,
  type WorkflowRecord,
} from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  baseDoc,
  basePermissions,
  schema,
} from '../../../authority/test/fixtures.ts';
import { ShapeValidator } from '../codec/validate.ts';
import { DEP1_WIRE } from '../definition/wire.ts';
import { RoomBridge, type DepOutbound, type RoomOpened } from './room-bridge.ts';

const validator = new ShapeValidator(DEP1_WIRE);
const NOW = 1_800_000_000_000;
const HEAD = { seq: 1, hash: 'a'.repeat(64) };

const participant = (id: string, order: number) => ({
  id,
  roles: ['role_tenant'],
  kind: 'filler' as const,
  order,
  completed: false,
});

function sentRecord(): WorkflowRecord {
  const draft: WorkflowRecord = {
    state: 'draft',
    participants: [participant('first', 1), participant('second', 2)],
    sentSeq: null,
    sentHash: null,
    end: null,
  };
  const r = sendWorkflow(draft, { manage: true }, BASE_JSON, HEAD);
  if (!r.ok) throw new Error('the fixture must send');
  return r.record;
}

function permsFor(record: WorkflowRecord, revision: number): PermissionState {
  const lock = lockFor(record.state);
  if (lock === null) throw new Error('no lock');
  return { ...basePermissions(), revision, ...lock };
}

const conn = (pid: string) => ({
  ...USERS.erin,
  sub: pid,
  session: `s-${pid}`,
  participant: pid,
  participantRoles: ['role_tenant'],
  participantActive: false,
});

function setup() {
  const record = sentRecord();
  const room = new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: permsFor(record, 1),
    workflow: record,
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => NOW,
  });
  const bridge = new RoomBridge({ source: () => room, now: () => NOW });
  const opened: Record<string, ReturnType<RoomBridge['opened']>> = {};
  for (const pid of ['first', 'second']) {
    const fx = room.open(`ch-${pid}`, conn(pid));
    const msg = fx.send.find((o) => o.msg.t === 'ch.opened')!.msg as RoomOpened;
    opened[pid] = bridge.opened(`ch-${pid}`, conn(pid), msg);
  }
  return { record, room, bridge, opened };
}

const events = (out: DepOutbound[], channel: string) =>
  out.filter((o) => o.channel === channel).map((o) => o.event);

describe('ch.opened.workflow on the wire (criterion 1)', () => {
  it('carries the state and the participant’s own status, and is a valid ChannelOpened', () => {
    const { opened } = setup();
    expect(opened['first']!.workflow).toEqual({
      state: 'sent',
      participant: { id: 'first', state: 'active' },
    });
    expect(opened['second']!.workflow).toEqual({
      state: 'sent',
      participant: { id: 'second', state: 'waiting' },
    });
    expect(validator.checkNamed('ChannelOpened', opened['first']!)).toEqual([]);
  });
});

describe('wf.changed on the wire (criteria 2 and 3)', () => {
  it('follows the perm.changed of the transition, both after the control commit', () => {
    const { record, room, bridge } = setup();
    const o = openWorkflow(record);
    if (!o.ok) throw new Error('must open');
    const done = completeParticipant(o.record, 'first');
    if (!done.ok) throw new Error('must complete');

    const fx = room.workflowChanged(done.record, permsFor(done.record, 2));
    // Nothing leaves before the control commit of revision 2 is stored: the access is held (D12)
    // and the workflow object waits behind it.
    expect(bridge.translate(fx.send)).toEqual([]);

    const stored = room.writeCompleted({ status: 'ok' });
    const out = bridge.translate(stored.send);
    const second = events(out, 'ch-second').map((e) => e.t);
    expect(second.filter((t) => t !== 'sync.commit')).toEqual(['perm.changed', 'wf.changed']);
    expect(second.indexOf('perm.changed')).toBeLessThan(second.indexOf('wf.changed'));
    const wf = events(out, 'ch-second').find((e) => e.t === 'wf.changed');
    expect(wf).toEqual({
      t: 'wf.changed',
      d: { state: 'in_progress', participant: { id: 'second', state: 'active' } },
    });
    const perm = events(out, 'ch-second').find((e) => e.t === 'perm.changed');
    expect(perm?.t === 'perm.changed' && perm.d.rev).toBe(2);
    expect(perm?.t === 'perm.changed' && perm.d.fill?.active).toBe(true);
    expect(validator.checkNamed('WorkflowStatus', (wf as { d: unknown }).d)).toEqual([]);
  });

  it('sends wf.changed at once when no perm.changed is held', () => {
    const { record, room, bridge } = setup();
    // The first connection views the document: no lock moves, so no new permission state.
    const o = openWorkflow(record);
    if (!o.ok) throw new Error('must open');
    const fx = room.workflowChanged(o.record);
    const out = bridge.translate(fx.send);
    expect(events(out, 'ch-first').map((e) => e.t)).toEqual(['wf.changed']);
    expect(events(out, 'ch-first')[0]).toMatchObject({
      d: { state: 'in_progress', participant: { id: 'first', state: 'active' } },
    });
  });
});
