// PRM-002 criterion 4: a user with `edit` in a scope cannot change grants, region states or leases
// by submitting commits. Grants change only through the control plane (`Room.permissionsChanged`),
// so no commit shape a client can send moves the permission state the room holds.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { PermissionState } from '../src/permissions/model.ts';
import type { Room } from '../src/room/room.ts';
import { stepsToJson } from '../src/steps.ts';
import { posInside, posOf } from './fixtures.ts';
import {
  FIELDS,
  USERS,
  commitId,
  fieldsDoc,
  morePermissions,
  roomWith,
  schema,
} from './permission-fixtures.ts';

const TERMS = 'rTerms000000000A';

/** The permission state as plain data, with the region-state map made comparable. */
const snapshotOf = (p: PermissionState): unknown => ({
  revision: p.revision,
  grants: p.grants.map((g) => ({ ...g })),
  regionStates: [...p.regionStates.entries()],
  leases: p.leases.map((l) => ({ ...l })),
  documentState: p.documentState,
  workflowActive: p.workflowActive,
});

const submit = (room: Room, channel: string, base: number, steps: Step[]) =>
  room.submit(channel, { id: commitId(), base, steps: stepsToJson(steps) });

const textIn = (doc: Node, paragraph: string, text = 'x'): Step[] => {
  const pos = posInside(doc, paragraph);
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
};

/** Commit shapes an editor can send, each reaching the room as steps. */
function shapes(doc: Node): Array<{ name: string; steps: Step[] }> {
  const intro = posInside(doc, 'pIntro0000000001');
  const bold = schema.marks['bold']!.create();
  return [
    { name: 'text insert in an inherit region', steps: textIn(doc, 'pTerms000000001A') },
    {
      name: 'attr step on a field value',
      steps: [new AttrStep(posOf(doc, FIELDS.landlord), 'value', 'Alice')],
    },
    {
      name: 'attr step carrying grant-shaped data in a field value',
      steps: [
        new AttrStep(posOf(doc, FIELDS.landlord), 'value', {
          grants: [{ region: 'rLegal000000000B', principal: 'user:carol', role: 'editor' }],
          state: 'approved',
          lease: { holder: 'carol' },
        }),
      ],
    },
    { name: 'bold added to text', steps: [new AddMarkStep(intro, intro + 4, bold)] },
    { name: 'bold removed from text', steps: [new RemoveMarkStep(intro, intro + 4, bold)] },
    {
      name: 'attr step on the region title',
      steps: [new AttrStep(posOf(doc, TERMS), 'title', 'Terms of tenancy')],
    },
  ];
}

describe('a commit cannot change grants, region states or leases (PRM-002 criterion 4)', () => {
  it('leaves the permission state unchanged for every commit shape of an editor', () => {
    const room = roomWith(fieldsDoc(), morePermissions());
    room.open('c1', USERS.carol);
    const before = snapshotOf(room.permissions);
    const stored: string[] = [];
    for (const shape of shapes(room.document)) {
      const fx = submit(room, 'c1', room.head, shape.steps);
      if (fx.write !== null) {
        room.writeCompleted({ status: 'ok' });
        stored.push(shape.name);
      }
      // Stored or refused, the permission state the room holds has not moved.
      expect(snapshotOf(room.permissions), shape.name).toEqual(before);
    }
    // Some of the shapes were stored, so the check ran over real commits.
    expect(stored.length).toBeGreaterThan(0);
    expect(room.head).toBe(stored.length);
    expect(room.permissions.revision).toBe(1);
  });

  it('keeps grants unchanged when a commit on a restricted region is refused', () => {
    const room = roomWith(fieldsDoc(), morePermissions());
    room.open('m1', USERS.mallory);
    const before = snapshotOf(room.permissions);
    // Mallory is an editor with no grant on the restricted Legal region: the commit is refused.
    const fx = submit(room, 'm1', 0, textIn(room.document, 'pLegal000000001B'));
    expect(fx.write).toBeNull();
    expect(snapshotOf(room.permissions)).toEqual(before);
  });
});
