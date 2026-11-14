// Once a workflow is sent, the rules and roles in `defs` are frozen (FRW-021 criterion 3, the lock
// part; 12 §5.4; lane V-FRW-019-036). The record is sent with `sendWorkflow`, the lock comes from
// `lockFor`, and an owner's change to a `role_def` is refused while the document is locked and
// accepted in the same document while it is active. The chain-hash part of criterion 3 (the commit
// at `sentSeq` and the hash at `sentHash`) is the service's and is not tested here.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import type { WorkflowRecord } from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { sendWorkflow } from '../src/workflow/send.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, baseDoc, posOf, schema } from './fixtures.ts';

const CH = 'ch-owner';
const HEAD = { seq: 4, hash: 'd'.repeat(64) };
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function sentRecord(): WorkflowRecord {
  const draft: WorkflowRecord = {
    state: 'draft',
    participants: [
      { id: 'tenant', roles: ['role_tenant'], kind: 'filler', order: 1, completed: false },
    ],
    sentSeq: null,
    sentHash: null,
    end: null,
  };
  const result = sendWorkflow(draft, { manage: true }, BASE_JSON, HEAD);
  if (!result.ok) throw new Error('the fixture document must send');
  return result.record;
}

function roomWith(documentState: 'active' | 'locked', workflowActive: boolean): Room {
  const init: RoomInit = {
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: { ...basePermissions(), documentState, workflowActive },
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
  };
  return new Room(init);
}

/** The owner renames the role: a change to `defs`, which needs `structure`. */
function renameRole(room: Room): Effects {
  const doc = baseDoc();
  return room.submit(CH, {
    id: id(),
    base: 0,
    steps: stepsToJson([new AttrStep(posOf(doc, 'role_tenant'), 'name', 'Renter')]),
  });
}

type Reject = Extract<ToClient, { t: 'sync.reject' }>;
function rejection(fx: Effects): Reject | undefined {
  const m = fx.send.find((o) => o.channel === CH && o.msg.t === 'sync.reject')?.msg;
  return m?.t === 'sync.reject' ? m : undefined;
}

describe('the definitions are frozen once the workflow is sent (FRW-021 criterion 3, lock part)', () => {
  it('records the send with its sentSeq and sentHash, and locks the document', () => {
    const record = sentRecord();
    expect(record.state).toBe('sent');
    expect(record.sentSeq).toBe(HEAD.seq);
    expect(record.sentHash).toBe(HEAD.hash);
    expect(lockFor(record.state)).toEqual({ documentState: 'locked', workflowActive: true });
  });

  it('refuses an owner change to a role_def while the document is locked', () => {
    const room = roomWith('locked', true);
    room.open(CH, USERS.alice);
    const fx = renameRole(room);
    expect(rejection(fx)).toBeDefined();
    expect(fx.write).toBeNull();
    expect(room.document.eq(baseDoc())).toBe(true);
  });

  it('accepts the same owner change while the document is active (control)', () => {
    const room = roomWith('active', false);
    room.open(CH, USERS.alice);
    const fx = renameRole(room);
    expect(rejection(fx)).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });
});
