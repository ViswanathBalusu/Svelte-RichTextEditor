// Locking the document while a workflow runs (FRW-029 criteria 1, 2, 3 and 5). The room receives the
// lock as its permission state (documentState, workflowActive); these tests drive that state through
// the room and through the mapping of workflow states in workflow/lock.ts. Threads on a locked
// document are tested in threads.test.ts (criterion 3); the restore refusal (criterion 4) is not built.
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { Fragment, Slice } from 'prosemirror-model';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_STATE_NAMES } from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { posInside, posOf } from './fixtures.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  FIELDS,
  USERS,
  commitId,
  fieldsDoc,
  messages,
  morePermissions,
  rejection,
  roomWith,
  schema,
} from './permission-fixtures.ts';
import type { ToClient } from '../src/room/types.ts';
import type { Node } from 'prosemirror-model';
import type { Room } from '../src/room/room.ts';

const typeIn = (doc: Node): Step[] => {
  const pos = posInside(doc, 'pIntro0000000001');
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))];
};
const attrChange = (doc: Node): Step[] => [
  new AttrStep(posOf(doc, FIELDS.number), 'key', 'tenant.changed'),
];
const submit = (room: Room, channel: string, base: number, steps: Step[]) =>
  room.submit(channel, { id: commitId(), base, steps: stepsToJson(steps) });

describe('the lock a workflow state implies (FRW-029 criteria 2, 3 and 5)', () => {
  it('locks a sent or running document with fill kept, and a stopped one without fill', () => {
    expect(lockFor('sent')).toEqual({ documentState: 'locked', workflowActive: true });
    expect(lockFor('in_progress')).toEqual({ documentState: 'locked', workflowActive: true });
    // FRW-029 criterion 5: a declined or voided workflow keeps the document locked.
    expect(lockFor('declined')).toEqual({ documentState: 'locked', workflowActive: false });
    expect(lockFor('voided')).toEqual({ documentState: 'locked', workflowActive: false });
    expect(lockFor('draft')).toEqual({ documentState: 'active', workflowActive: false });
  });

  it('decides no lock for the states 12 leaves open, and never a lock that is not a state of 12', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORKFLOW_STATE_NAMES), (state) => {
        const lock = lockFor(state);
        if (lock === null) {
          expect(['correcting', 'completed', 'finalised', 'expired']).toContain(state);
        } else {
          expect(['active', 'locked']).toContain(lock.documentState);
          // A workflow that is not running never lets anyone fill.
          if (state !== 'sent' && state !== 'in_progress') expect(lock.workflowActive).toBe(false);
        }
      }),
    );
  });
});

describe('a locked document under a running workflow (FRW-029 criteria 1 and 2)', () => {
  const locked = () =>
    morePermissions({ revision: 2, documentState: 'locked', workflowActive: true });

  it('refuses a viewer who changes text with read_only, and drops the commit', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, locked());
    room.open('f1', USERS.frank);
    const fx = submit(room, 'f1', 0, typeIn(doc));
    expect(rejection(fx, 'f1')).toMatchObject({ code: 'read_only', action: 'drop' });
    expect(fx.write).toBeNull();
    expect(room.head).toBe(0);
  });

  // An owner or an editor keeps `fill` under the lock, so room step 1 admits the commit and the
  // outcome check refuses it. Since SYN-007 (ADR 0363, proposed) the room answers `read_only` when
  // the same connection could make the change on an active document with no workflow.
  it('refuses an owner who changes text under the lock, and stores nothing', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, locked());
    room.open('a1', USERS.alice);
    const fx = submit(room, 'a1', 0, typeIn(doc));
    expect(rejection(fx, 'a1')).toMatchObject({ code: 'read_only', action: 'drop' });
    expect(fx.write).toBeNull();
    expect(room.head).toBe(0);
  });

  it('refuses an editor who changes a field attribute under the lock, and the attribute stays', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, locked());
    room.open('b1', USERS.bob);
    const fx = submit(room, 'b1', 0, attrChange(doc));
    expect(rejection(fx, 'b1')).toMatchObject({ code: 'read_only', action: 'drop' });
    expect(fx.write).toBeNull();
    expect(room.document.nodeAt(posOf(doc, FIELDS.number))!.attrs['key']).toBe('tenant.amount');
  });

  it('removes the edit right of an owner and an editor, leaving view and comment on the body', () => {
    const room = roomWith(fieldsDoc(), morePermissions());
    room.open('a1', USERS.alice);
    room.open('b1', USERS.bob);
    const fx = room.permissionsChanged(locked());
    for (const ch of ['a1', 'b1']) {
      const m = messages(fx, ch).find((x) => x.t === 'perm.changed') as Extract<
        ToClient,
        { t: 'perm.changed' }
      >;
      expect(m, ch).toBeDefined();
      expect([...m.access.body].sort(), ch).toEqual(['comment', 'view']);
      expect(m.access.body.has('edit'), ch).toBe(false);
      expect(m.access.body.has('structure'), ch).toBe(false);
    }
  });

  it('keeps the fill of an active participant on the same locked document', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, locked());
    room.open('e1', USERS.erin);
    const fx = submit(room, 'e1', 0, [new AttrStep(posOf(doc, FIELDS.number), 'value', '12.50')]);
    expect(rejection(fx, 'e1')).toBeNull();
    expect(fx.write?.commits[0]?.scopes).toEqual([`field:${FIELDS.number}`]);
  });
});

describe('a stopped workflow keeps the document locked (FRW-029 criterion 5)', () => {
  it('refuses fill by the former participant once the workflow is declined or voided', () => {
    const doc = fieldsDoc();
    const room = roomWith(
      doc,
      morePermissions({ revision: 2, documentState: 'locked', workflowActive: false }),
    );
    room.open('e1', USERS.erin);
    const fx = submit(room, 'e1', 0, [new AttrStep(posOf(doc, FIELDS.number), 'value', '1')]);
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'read_only', action: 'drop' });
    expect(fx.write).toBeNull();
  });
});
