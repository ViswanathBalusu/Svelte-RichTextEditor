// Role placeholders are defined by the `defs` scope (12 §3.1; FRW-001 criteria 3 and 4). A commit
// that adds, renames, recolours or deletes a `role_def` needs `structure` at document level; a user
// with an edit grant in one region only is refused with `permission_denied` naming the `defs` scope.
// Criterion 4 (the definition appears in the next GET of the content) is the content API's (PRO) and
// is not ticked; this file checks only what the room stores.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { stepsToJson } from '../src/steps.ts';
import { baseDoc, posOf } from './fixtures.ts';
import {
  MORE,
  USERS,
  commitId,
  morePermissions,
  rejection,
  roomWith,
  schema,
  verdictOf,
} from './permission-fixtures.ts';

const ROLE = 'role_tenant';

/** The end of the `defs` content, where a new `role_def` is inserted. */
function defsEnd(doc: Node): number {
  return 1 + doc.child(0).content.size;
}

const addRoleDef = (doc: Node): Step[] => [
  new ReplaceStep(
    defsEnd(doc),
    defsEnd(doc),
    new Slice(
      Fragment.from(
        schema.nodes['role_def']!.create({ id: 'role_auditor', name: 'Auditor', color: '#2CA02C' }),
      ),
      0,
      0,
    ),
  ),
];
const renameRole = (doc: Node): Step[] => [new AttrStep(posOf(doc, ROLE), 'name', 'Renter')];
const recolourRole = (doc: Node): Step[] => [new AttrStep(posOf(doc, ROLE), 'color', '#000000')];
const deleteRole = (doc: Node): Step[] => {
  const pos = posOf(doc, ROLE);
  return [new ReplaceStep(pos, pos + doc.nodeAt(pos)!.nodeSize, Slice.empty)];
};

describe('FRW-001 a user with edit but not structure changes no role definition (criterion 3)', () => {
  // Rita holds an edit grant on the region Terms only; at document level she has no `structure`.
  const cases = [
    ['adds a role_def', addRoleDef],
    ['renames a role_def', renameRole],
    ['recolours a role_def', recolourRole],
    ['deletes a role_def', deleteRole],
  ] as const;

  for (const [name, make] of cases) {
    it(`refuses a commit that ${name}, naming the defs scope`, () => {
      const doc = baseDoc();
      const verdict = verdictOf(MORE.rita, doc, make);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.scopes.some((s) => s.startsWith('defs'))).toBe(true);
    });
  }

  it('refuses the same commit in the room with permission_denied and stores nothing', () => {
    const doc = baseDoc();
    const room = roomWith(doc, morePermissions());
    room.open('r1', MORE.rita);
    const fx = room.submit('r1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(renameRole(doc)),
    });
    expect(rejection(fx, 'r1')).toMatchObject({ code: 'permission_denied' });
    expect(room.head).toBe(0);
  });
});

describe('FRW-001 a user with structure adds a role placeholder (criterion 4, room side)', () => {
  it('accepts a role_def added by the owner, which the room then holds in its document', () => {
    const doc = baseDoc();
    expect(verdictOf(USERS.alice, doc, addRoleDef).ok).toBe(true);
    const room = roomWith(doc, morePermissions());
    room.open('a1', USERS.alice);
    const fx = room.submit('a1', { id: commitId(), base: 0, steps: stepsToJson(addRoleDef(doc)) });
    expect(rejection(fx, 'a1')).toBeNull();
    room.writeCompleted({ status: 'ok' });
    expect(room.head).toBe(1);
    let found = false;
    room.document.descendants((n) => {
      if (n.type.name === 'role_def' && n.attrs['id'] === 'role_auditor') found = true;
    });
    expect(found).toBe(true);
  });
});
