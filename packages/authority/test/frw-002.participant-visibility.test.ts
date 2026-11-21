// FRW-002 criterion 5 at the room and the projection gateway: the readers of a sensitive value are
// decided from the connection as the workflow binds it (FRW-038; ADR 0019; owner decision 156). A
// participant named by the token's `wfp` reads, and may fill, the sensitive field of the role the
// workflow gives them; a token that binds to no one reads nothing by role, whatever it claims; and a
// change of the workflow derives the classes again.
import { AttrStep } from 'prosemirror-transform';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { visibility } from '../src/permissions/visibility.ts';
import { ProjectionGateway } from '../src/projection/gateway.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, Outbound, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { connectionInWorkflow } from '../src/workflow/binding.ts';
import type { WorkflowParticipant, WorkflowRecord } from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, posOf, schema } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const SECRET = 'SENSITIVE-TENANT-NAME';
const HEAD = { seq: 1, hash: 'a'.repeat(64) };
const now = () => 1_800_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

/** The fixture document with the tenant's field marked sensitive and holding a value. */
function sensitiveJson(): typeof BASE_JSON {
  const json = structuredClone(BASE_JSON);
  const visit = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type === 'form_field' && n.attrs?.['id'] === FIELD)
      n.attrs = { ...n.attrs, sensitive: true, value: SECRET };
    for (const c of n.content ?? []) visit(c as never);
  };
  visit(json as never);
  return json;
}
const sensitiveDoc = (): Node => schema.nodeFromJSON(sensitiveJson());

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
  const result = sendWorkflow(draft, { manage: true }, sensitiveJson(), HEAD);
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

function gatewayFor(record: WorkflowRecord | null): ProjectionGateway {
  const init: RoomInit = {
    schema,
    initial: sensitiveDoc(),
    requires: REQUIRES,
    log: [],
    perms: record === null ? { ...basePermissions(), revision: 1 } : permsFor(record, 1),
    ...(record !== null ? { workflow: record } : {}),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now,
  };
  return new ProjectionGateway(new Room(init), schema, visibility(now));
}

/** A connection the way the service builds it from a token with `wfp`. */
const tokenConn = (sub: string, wfp: string, claimed: readonly string[] = []): Connection => ({
  ...USERS.erin,
  sub,
  session: `s-${sub}`,
  participantClaim: { sub, wfp },
  participantRoles: claimed,
  participantActive: claimed.length > 0,
});

const toChannel = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o: Outbound) => o.channel === channel).map((o) => o.msg);

/** The value of the sensitive field in the content a channel was opened with. */
function openedValue(fx: Effects, channel: string): unknown {
  const m = toChannel(fx, channel).find((x) => x.t === 'ch.opened');
  if (m?.t !== 'ch.opened' || !m.content) throw new Error('no content in ch.opened');
  let value: unknown;
  const visit = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type === 'form_field' && n.attrs?.['id'] === FIELD) value = n.attrs['value'];
    for (const c of n.content ?? []) visit(c as never);
  };
  visit(m.content.doc as never);
  return value;
}

const viewOf = (fx: Effects, channel: string): string | undefined => {
  const m = toChannel(fx, channel).find((x) => x.t === 'ch.opened');
  return m?.t === 'ch.opened' ? m.view : undefined;
};

const REDACTED = { redacted: true };

describe('the readers of a sensitive value follow the workflow binding (FRW-002 criterion 5)', () => {
  it('gives the value to the participant the token binds to, and the marker to every other token', () => {
    const record = sent([person('first', 1), person('second', 1, { roles: ['role_landlord'] })]);
    const g = gatewayFor(record);
    // The participant who holds the assignee role reads the value.
    expect(openedValue(g.open('c1', tokenConn('sub-first', 'first')), 'c1')).toBe(SECRET);
    // A participant of another role does not, and neither does a token that binds to no one: the
    // wrong `sub`, a participant the workflow does not have, or roles the token claims for itself.
    expect(openedValue(g.open('c2', tokenConn('sub-second', 'second')), 'c2')).toEqual(REDACTED);
    expect(openedValue(g.open('c3', tokenConn('sub-other', 'first')), 'c3')).toEqual(REDACTED);
    expect(openedValue(g.open('c4', tokenConn('sub-x', 'nobody', ['role_tenant'])), 'c4')).toEqual(
      REDACTED,
    );
    expect(
      openedValue(g.open('c5', tokenConn('sub-second', 'second', ['role_tenant'])), 'c5'),
    ).toEqual(REDACTED);
    // The owner reads it; a viewer does not.
    expect(openedValue(g.open('c6', USERS.alice), 'c6')).toBe(SECRET);
    expect(openedValue(g.open('c7', USERS.frank), 'c7')).toEqual(REDACTED);
  });

  it('puts the bound participant and a reader of the same values in one class', () => {
    const record = sent([person('first', 1)]);
    const g = gatewayFor(record);
    const bound = viewOf(g.open('c1', tokenConn('sub-first', 'first')), 'c1');
    const owner = viewOf(g.open('c2', USERS.alice), 'c2');
    const unbound = viewOf(g.open('c3', tokenConn('sub-other', 'first')), 'c3');
    const viewer = viewOf(g.open('c4', USERS.frank), 'c4');
    expect(bound).toBe(owner);
    expect(unbound).toBe(viewer);
    expect(bound).not.toBe(unbound);
  });

  it('lets the bound participant fill the sensitive field of their role, and sends no value to the others', () => {
    const record = sent([person('first', 1), person('second', 1, { roles: ['role_landlord'] })]);
    const g = gatewayFor(record);
    g.open('c1', tokenConn('sub-first', 'first'));
    g.open('c2', tokenConn('sub-second', 'second'));
    g.open('c3', USERS.alice);
    const step = new AttrStep(posOf(sensitiveDoc(), FIELD), 'value', 'A-NEW-VALUE');
    // The other participant may not set a value they cannot read.
    const refused = g.submit('c2', { id: id(), base: 0, steps: stepsToJson([step]) });
    const reject = toChannel(refused, 'c2').find((m) => m.t === 'sync.reject');
    expect(reject?.t === 'sync.reject' && reject.code).toBe('permission_denied');
    expect(refused.write).toBeNull();
    // The participant of the role fills it.
    const fx = g.submit('c1', { id: id(), base: 0, steps: stepsToJson([step]) });
    expect(toChannel(fx, 'c1').find((m) => m.t === 'sync.reject')).toBeUndefined();
    expect(fx.write).not.toBeNull();
    const done = g.writeCompleted({ status: 'ok' });
    expect(toChannel(done, 'c1').some((m) => m.t === 'sync.ack')).toBe(true);
    const toOwner = toChannel(done, 'c3').find((m) => m.t === 'sync.commit');
    const toOther = toChannel(done, 'c2').find((m) => m.t === 'sync.commit');
    expect(toOwner?.t === 'sync.commit' && JSON.stringify(toOwner.commit.steps)).toContain(
      'A-NEW-VALUE',
    );
    expect(toOther?.t === 'sync.commit' && toOther.commit.steps).toEqual([]);
    expect(JSON.stringify(done.send.filter((o) => o.channel === 'c2'))).not.toContain(
      'A-NEW-VALUE',
    );
    expect(g.audit()).toEqual([]);
  });

  it('derives the classes again when the workflow is sent: the participant who gains the role reloads', () => {
    // No workflow yet (a draft is not given to the room): the token binds to no one.
    const g = gatewayFor(null);
    expect(openedValue(g.open('c1', tokenConn('sub-first', 'first')), 'c1')).toEqual(REDACTED);
    g.open('c2', tokenConn('sub-second', 'second'));
    g.open('c3', USERS.frank);
    const record = sent([person('first', 1), person('second', 1, { roles: ['role_landlord'] })]);
    const fx = g.workflowChanged(record, permsFor(record, 2));
    // The participant of the tenant role now reads the value: their class changed, so the channel
    // is closed and the client reloads. The others keep their channels.
    const closed = toChannel(fx, 'c1').find((m) => m.t === 'ch.closed');
    expect(closed?.t === 'ch.closed' && closed.reason).toBe('access_changed');
    expect(toChannel(fx, 'c2').some((m) => m.t === 'ch.closed')).toBe(false);
    expect(toChannel(fx, 'c3').some((m) => m.t === 'ch.closed')).toBe(false);
    expect(JSON.stringify(fx.send)).not.toContain(SECRET);
    // The reload is of the new class.
    expect(openedValue(g.open('c1', tokenConn('sub-first', 'first')), 'c1')).toBe(SECRET);
  });

  it('derives the classes again when only the record changes: a participant who is replaced stops reading', () => {
    const record = sent([person('first', 1)]);
    const g = gatewayFor(record);
    expect(openedValue(g.open('c1', tokenConn('sub-first', 'first')), 'c1')).toBe(SECRET);
    expect(openedValue(g.open('c2', tokenConn('sub-new', 'first')), 'c2')).toEqual(REDACTED);
    g.open('c3', USERS.alice);
    // The owner names another person for the participant. The permission state does not move.
    const replaced: WorkflowRecord = {
      ...record,
      participants: record.participants.map((p) => ({ ...p, sub: 'sub-new' })),
    };
    const fx = g.workflowChanged(replaced);
    for (const channel of ['c1', 'c2']) {
      const closed = toChannel(fx, channel).find((m) => m.t === 'ch.closed');
      expect(closed?.t === 'ch.closed' && closed.reason, channel).toBe('access_changed');
    }
    expect(toChannel(fx, 'c3').some((m) => m.t === 'ch.closed')).toBe(false);
    // The person who was replaced reads the marker from now on; a later value never reaches them.
    expect(openedValue(g.open('c1', tokenConn('sub-first', 'first')), 'c1')).toEqual(REDACTED);
    expect(openedValue(g.open('c2', tokenConn('sub-new', 'first')), 'c2')).toBe(SECRET);
    const step = new AttrStep(posOf(sensitiveDoc(), FIELD), 'value', 'AFTER-THE-CHANGE');
    const filled = g.submit('c2', { id: id(), base: 0, steps: stepsToJson([step]) });
    expect(filled.write).not.toBeNull();
    const done = g.writeCompleted({ status: 'ok' });
    expect(JSON.stringify(done.send.filter((o) => o.channel === 'c1'))).not.toContain(
      'AFTER-THE-CHANGE',
    );
  });

  it('keeps the form mode as it was: roles of a token with no wfp are the token’s', () => {
    const g = gatewayFor(null);
    expect(openedValue(g.open('c1', USERS.erin), 'c1')).toBe(SECRET);
    expect(
      openedValue(g.open('c2', { ...USERS.erin, sub: 'other', participantRoles: [] }), 'c2'),
    ).toEqual(REDACTED);
  });
});

describe('connectionInWorkflow, the binding as a pure function', () => {
  const record = sent([person('first', 1), person('second', 2, { roles: ['role_landlord'] })]);

  it('gives a claim the roles of its participant, and whether that participant is active', () => {
    const first = connectionInWorkflow(tokenConn('sub-first', 'first', ['role_forged']), record);
    expect(first.participant).toBe('first');
    expect(first.participantRoles).toEqual(['role_tenant']);
    expect(first.participantActive).toBe(true);
    const second = connectionInWorkflow(tokenConn('sub-second', 'second'), record);
    expect(second.participantRoles).toEqual(['role_landlord']);
    expect(second.participantActive).toBe(false);
  });

  it('gives a claim that binds to no one no role, with or without a workflow', () => {
    for (const conn of [
      connectionInWorkflow(tokenConn('sub-other', 'first', ['role_tenant']), record),
      connectionInWorkflow(tokenConn('sub-first', 'missing', ['role_tenant']), record),
      connectionInWorkflow(tokenConn('sub-first', 'first', ['role_tenant']), null),
    ]) {
      expect(conn.participantRoles).toEqual([]);
      expect(conn.participantActive).toBe(false);
      expect(conn.participant).toBeUndefined();
    }
  });

  it('returns a connection with no claim and no participant as it is', () => {
    expect(connectionInWorkflow(USERS.erin, record)).toBe(USERS.erin);
    expect(connectionInWorkflow(USERS.erin, null)).toBe(USERS.erin);
    expect(connectionInWorkflow(USERS.frank, record)).toBe(USERS.frank);
  });
});
