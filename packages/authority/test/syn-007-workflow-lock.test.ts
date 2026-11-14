// SYN-007 criterion 2 (lane V-SYN-001-018): a document whose workflow locks it refuses a commit from
// a connection with no fill allowance with `read_only` and `drop` (04 §5 step 1). The lock is the one
// the workflow state implies (workflow/lock.ts, 12 §6.2), applied to the room's permission state.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { WorkflowStateName } from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posOf, schema } from './fixtures.ts';

let clock = 1_780_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-9000-${(++counter).toString(16).padStart(12, '0')}`;

function roomUnder(state: WorkflowStateName) {
  const lock = lockFor(state);
  if (!lock) throw new Error(`${state} is not decided by the workflow lock`);
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
    incarnation: 'inc-syn-007-workflow',
    now: () => ++clock,
  });
}

function rejectOf(fx: Effects, channel: string) {
  const m = fx.send
    .filter((o) => o.channel === channel)
    .map((o) => o.msg as ToClient)
    .find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}

describe('a workflow lock refuses an owner edit (SYN-007 criterion 2)', () => {
  // A viewer has no fill allowance, so the workflow lock alone decides (P6, step 1). An owner in
  // `sent` or `in_progress` holds fill, so the room passes them on to P7 (permission_denied); that
  // reading is left open (SYN-007 Notes), and the owner is tested only where the workflow is stopped.
  for (const state of ['sent', 'in_progress', 'declined', 'voided'] as const) {
    it(`refuses a viewer's commit with read_only while the workflow is ${state}`, () => {
      const r = roomUnder(state);
      r.open('f1', USERS.frank);
      const pos = posOf(baseDoc(), 'fTenantName00001');
      const fx = r.submit('f1', {
        id: id(),
        base: 0,
        steps: stepsToJson([new AttrStep(pos, 'value', 'Changed')]),
      });
      expect(rejectOf(fx, 'f1')).toMatchObject({ code: 'read_only', action: 'drop' });
      expect(r.head).toBe(0);
    });
  }

  for (const state of ['declined', 'voided'] as const) {
    it(`refuses an owner's commit with read_only once the workflow is ${state}`, () => {
      const r = roomUnder(state);
      r.open('a1', USERS.alice);
      const pos = posOf(baseDoc(), 'fTenantName00001');
      const fx = r.submit('a1', {
        id: id(),
        base: 0,
        steps: stepsToJson([new AttrStep(pos, 'value', 'Changed')]),
      });
      expect(rejectOf(fx, 'a1')).toMatchObject({ code: 'read_only', action: 'drop' });
    });
  }

  it('leaves a draft workflow active, so the editor may commit', () => {
    const r = roomUnder('draft');
    r.open('a1', USERS.alice);
    const pos = posOf(baseDoc(), 'fTenantName00001');
    const fx = r.submit('a1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new AttrStep(pos, 'value', 'Changed')]),
    });
    expect(rejectOf(fx, 'a1')).toBeNull();
  });
});
