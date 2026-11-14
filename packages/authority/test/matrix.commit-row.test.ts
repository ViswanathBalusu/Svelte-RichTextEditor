// Row 3 of 07 §12 (commits) across every role (PRM-057 criterion 2): a direct text edit of the body
// is accepted for the roles that may edit and refused, with `permission_denied`, for the rest. The
// verdicts come from the room's submission path, so this runs PRM-009 (the connection's rights)
// through the outcome check of PRM-010 to PRM-012 and the rebase of the room.
import { describe, expect, it } from 'vitest';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import type { Connection, DocRole } from '../src/permissions/model.ts';
import { stepsToJson } from '../src/steps.ts';
import { USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';
import { commitId, rejection, roomWith } from './permission-fixtures.ts';

const NOW = 1_770_700_000_000;
const BODY_PARAGRAPH = 'pIntro0000000001';

const conn = (sub: string, role: DocRole): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
});

/** One connection per document role, the filler being a participant with no active field. */
const CAST: Array<[DocRole, Connection, boolean]> = [
  ['owner', USERS.alice, true],
  ['editor', USERS.carol, true],
  ['suggester', USERS.dave, false],
  ['filler', USERS.erin, false],
  ['commenter', conn('cora', 'commenter'), false],
  ['viewer', USERS.frank, false],
];

describe('row 3 of 07 §12: a direct edit is accepted only with edit (PRM-057 criterion 2)', () => {
  for (const [role, user, mayEdit] of CAST) {
    it(`${mayEdit ? 'accepts' : 'refuses'} a direct body edit from a ${role}`, () => {
      const doc = baseDoc();
      const pos = posInside(doc, BODY_PARAGRAPH);
      const room = roomWith(doc, basePermissions(), () => NOW);
      room.open('c1', user);
      const fx = room.submit('c1', {
        id: commitId(),
        base: 0,
        steps: stepsToJson([
          new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0)),
        ]),
      });
      const verdict = rejection(fx, 'c1');
      if (mayEdit) expect(verdict).toBeNull();
      else expect(verdict).toMatchObject({ code: 'permission_denied' });
    });
  }

  it('a refused commit stores nothing, so the head does not move', () => {
    const doc = baseDoc();
    const pos = posInside(doc, BODY_PARAGRAPH);
    const room = roomWith(doc, basePermissions(), () => NOW);
    room.open('c1', USERS.frank);
    const before = room.head;
    room.submit('c1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([
        new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0)),
      ]),
    });
    expect(room.head).toBe(before);
  });
});
