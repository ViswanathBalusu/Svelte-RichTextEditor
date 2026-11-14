/**
 * SEC-030 — an approved region cannot be changed by any origin (07 §4, §11; 07 §5.3; PRM-046, PRM-047).
 *
 * An approved region keeps only `view` and `comment` for every user, owners included (access.ts,
 * the limits of 07 §4), so the outcome check refuses any change of its text, its title or its
 * existence. The proofs run that check with the standard rules, for an owner and for an editor with
 * an `editor` grant on the region, and for every origin the room can give a commit: the user's own
 * input, and the server origins that stand in for restore, import, migration, repair, prefill, rules
 * and snapshot commits. The server origins are passed to the check as server-authored, which is
 * what the room does. Each change is first accepted with the region in draft (the control), so the
 * refusal once it is approved comes from the approval and nothing else.
 *
 * Not covered here, stated in the story's Notes: the state change itself and its control comment
 * (criterion 2), the approval record's hash (criterion 3), and a whole-document restore run through
 * the room (criterion 5, which needs the restore operation).
 */
import {
  type Connection,
  computeAccess,
  outcomeCheck,
  type PermissionState,
  STANDARD_RULES,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import { AttrStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { fieldsDoc, permissions, regionsOf, schema } from './support/authority-fixtures.ts';

/** The restricted region of the fixture, whose text names the tenant's liability. */
const REGION = 'rLegal000000000B';

/** Every origin a commit can carry into the check (the room's client and server origins). */
const ORIGINS = [
  'input',
  'restore',
  'import',
  'migration',
  'repair',
  'prefill',
  'rules',
  'snapshot',
] as const;

const OWNER: Connection = {
  sub: 'olga',
  session: 's-olga',
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const EDITOR: Connection = {
  sub: 'edna',
  session: 's-edna',
  role: 'editor',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

/**
 * The permission state with the region approved, or in draft. The editor holds an `editor` grant
 * on the region, so in draft the editor may change it: a refusal once it is approved comes from
 * the approval, not from a missing grant (the region's policy is `restricted`).
 */
function stateOf(approved: boolean): PermissionState {
  const regionStates = new Map<string, string>();
  if (approved) regionStates.set(REGION, 'approved');
  return {
    ...permissions(),
    grants: [{ region: REGION, principal: `user:${EDITOR.sub}`, role: 'editor', expiresAt: null }],
    regionStates,
  } as PermissionState;
}

/** The verdict of the outcome check for `user`'s commit from `before` to `after`, from `origin`. */
function verdictFor(
  before: Node,
  after: Node,
  user: Connection,
  origin: string,
  approved: boolean,
) {
  const perms = stateOf(approved);
  return outcomeCheck({
    before,
    after,
    user: user.sub,
    access: computeAccess(user, regionsOf(before), perms, 0),
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: origin !== 'input',
    origin,
    rules: STANDARD_RULES,
  });
}

/** The position of the first occurrence of `s` in the document's text. */
function at(doc: Node, s: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText && n.text?.includes(s)) {
      found = pos + n.text.indexOf(s);
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no text ${s}`);
  return found;
}

/** The position and size of the region with the given identifier. */
function regionSpan(doc: Node, id: string): { from: number; to: number } {
  let from = -1;
  let to = -1;
  doc.descendants((n, pos) => {
    if (from >= 0) return false;
    if (n.type.name === 'region' && n.attrs['id'] === id) {
      from = pos;
      to = pos + n.nodeSize;
      return false;
    }
    return true;
  });
  if (from < 0) throw new Error(`no region ${id}`);
  return { from, to };
}

/** The changes a single user or server commit can make to the approved region. */
const CHANGES: Record<string, (doc: Node) => Transform> = {
  'inserts text': (doc) => new Transform(doc).insert(at(doc, 'Liability'), schema.text('very ')),
  'deletes text': (doc) => {
    const p = at(doc, 'Liability is limited.');
    return new Transform(doc).delete(p, p + 'Liability'.length);
  },
  'retitles the region': (doc) => {
    const r = regionSpan(doc, REGION);
    return new Transform(doc).step(new AttrStep(r.from, 'title', 'Changed'));
  },
  'deletes the region': (doc) => {
    const r = regionSpan(doc, REGION);
    return new Transform(doc).delete(r.from, r.to);
  },
};

describe('SEC-030: an approved region cannot be changed by any origin', () => {
  const before = fieldsDoc();

  for (const [who, user] of [
    ['an owner', OWNER],
    ['a granted editor', EDITOR],
  ] as const) {
    for (const [name, change] of Object.entries(CHANGES)) {
      it(`accepts ${who} who ${name}, from every origin, while the region is in draft (control)`, () => {
        for (const origin of ORIGINS) {
          const tr = change(before);
          const verdict = verdictFor(before, tr.doc, user, origin, false);
          expect(verdict.ok ? 'accepted' : verdict.reason, origin).toBe('accepted');
        }
      });

      it(`refuses ${who} who ${name}, from every origin, once the region is approved`, () => {
        for (const origin of ORIGINS) {
          const tr = change(before);
          expect(verdictFor(before, tr.doc, user, origin, true).ok, origin).toBe(false);
        }
      });
    }
  }

  it('refuses the deletion of the approved region by its own owner (criterion 4)', () => {
    const tr = CHANGES['deletes the region']!(before);
    const verdict = verdictFor(before, tr.doc, OWNER, 'input', true);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(new RegExp(REGION));
  });

  it('refuses the approved region’s identifier being carried to a moved copy (criterion 4)', () => {
    // A move is a delete and a create: the copy keeps the approved region's text under a new
    // identifier, which the check refuses as a deletion of the approved region.
    const r = regionSpan(before, REGION);
    const region = before.nodeAt(r.from)!;
    const tr = new Transform(before).delete(r.from, r.to);
    const other = tr.doc.resolve(tr.doc.content.size - 1);
    tr.insert(
      other.pos,
      region.type.create({ ...region.attrs, id: 'rMoved00000000C' }, region.content),
    );
    expect(verdictFor(before, tr.doc, OWNER, 'input', true).ok).toBe(false);
  });
});
