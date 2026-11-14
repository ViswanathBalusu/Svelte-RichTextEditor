// Permission scopes and the outcome check beyond the spike's cases (07 §5.1; PRM-008, PRM-009,
// PRM-010; CDM-051): the identity-pruned diff equals a serialised comparison for every step type,
// the verdict never depends on step shapes, and refusals for view-only connections do no work.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { outcomeCheck, type OutcomeVerdict } from '../src/permissions/outcome.ts';
import { diffScopes } from '../src/permissions/scopes.ts';
import { applySteps } from '../src/rebase.ts';
import { regionsOf } from '../src/room/room.ts';
import { USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';
import { changedScopes } from './harness/oracle.ts';

const apply = (doc: Node, steps: Step[]): Node => {
  const r = applySteps(doc, steps);
  if (!r.ok) throw new Error(r.reason);
  return r.value.doc;
};

function verdict(
  user: Connection,
  before: Node,
  after: Node,
  perms: PermissionState = basePermissions(),
): OutcomeVerdict {
  return outcomeCheck({
    before,
    after,
    user: user.sub,
    access: computeAccess(user, regionsOf(before), perms, 0),
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
  });
}

const del = (user: string) =>
  schema.marks['del']!.create({ id: `s${user.padEnd(15, 'x')}`.slice(0, 16), user });

/** The base document with a bold run and a suggested deletion in the restricted region. */
function marked(): Node {
  const doc = baseDoc();
  const start = posInside(doc, 'pLegal000000001B');
  return apply(doc, [
    new AddMarkStep(start, start + 9, schema.marks['bold']!.create()),
    new AddNodeMarkStep(posOf(doc, 'pLegal000000001B'), del('dave')),
  ]);
}

/** One step of each kind, all inside the restricted region, made on `marked()`. */
function stepsOfEveryKind(doc: Node): Array<[string, Step]> {
  const p = posOf(doc, 'pLegal000000001B');
  const start = posInside(doc, 'pLegal000000001B');
  const node = doc.nodeAt(p)!;
  const restyled = schema.nodes['paragraph']!.create(
    { ...node.attrs, style: 'Heading1' },
    null,
    node.marks,
  );
  return [
    ['replace', new ReplaceStep(start, start, new Slice(Fragment.from(schema.text('New ')), 0, 0))],
    ['attr', new AttrStep(p, 'style', 'Heading1')],
    ['addMark', new AddMarkStep(start + 10, start + 15, schema.marks['italic']!.create())],
    ['removeMark', new RemoveMarkStep(start, start + 9, schema.marks['bold']!.create())],
    [
      'addNodeMark',
      new AddNodeMarkStep(
        p,
        schema.marks['ins']!.create({ id: 'sCarol0000000001', user: 'carol' }),
      ),
    ],
    ['removeNodeMark', new RemoveNodeMarkStep(p, del('dave'))],
    [
      'replaceAround',
      new ReplaceAroundStep(
        p,
        p + node.nodeSize,
        p + 1,
        p + node.nodeSize - 1,
        new Slice(Fragment.from(restyled), 0, 0),
        1,
        true,
      ),
    ],
  ];
}

describe('scope partition and diff (PRM-008)', () => {
  it('finds, for every step type, exactly the scopes a serialised comparison finds', () => {
    const before = marked();
    for (const [kind, step] of stepsOfEveryKind(before)) {
      const after = apply(before, [step]);
      expect(diffScopes(before, after).changed, kind).toEqual(changedScopes(before, after));
      expect(diffScopes(before, after).changed, kind).toEqual(['region:rLegal000000000B']);
    }
  });

  it('visits the changed path only, whatever the size of the document', () => {
    const edit = (doc: Node) =>
      apply(doc, [
        new ReplaceStep(
          posInside(doc, 'pTerms000000001A'),
          posInside(doc, 'pTerms000000001A'),
          new Slice(Fragment.from(schema.text('x')), 0, 0),
        ),
      ]);
    const small = baseDoc();
    const at = posOf(small, 'pEnd00000000001Z');
    const regions = Array.from({ length: 400 }, (_, i) =>
      schema.nodeFromJSON({
        type: 'region',
        attrs: { id: `r${String(i).padStart(15, '0')}` },
        content: [
          {
            type: 'paragraph',
            attrs: { id: `p${String(i).padStart(15, '0')}` },
            content: [{ type: 'text', text: 'filler' }],
          },
        ],
      }),
    );
    const large = apply(small, [new ReplaceStep(at, at, new Slice(Fragment.from(regions), 0, 0))]);
    const a = diffScopes(small, edit(small));
    const b = diffScopes(large, edit(large));
    expect(b.changed).toEqual(['region:rTerms000000000A']);
    expect(b.visited).toBe(a.visited);
  });

  it('puts the body and every added, removed or moved region in the result', () => {
    const doc = baseDoc();
    const notesAt = posOf(doc, 'rNotes000000000C');
    const notes = doc.nodeAt(notesAt)!;
    const removed = apply(doc, [new ReplaceStep(notesAt, notesAt + notes.nodeSize, Slice.empty)]);
    expect(diffScopes(doc, removed).changed).toEqual(['body', 'region:rNotes000000000C']);

    const fresh = schema.nodeFromJSON({
      type: 'region',
      attrs: { id: 'rFresh0000000001' },
      content: [{ type: 'paragraph', attrs: { id: 'pFresh0000000001' } }],
    });
    const end = posOf(doc, 'pEnd00000000001Z');
    const added = apply(doc, [new ReplaceStep(end, end, new Slice(Fragment.from(fresh), 0, 0))]);
    expect(diffScopes(doc, added).changed).toEqual(['body', 'region:rFresh0000000001']);

    // Move the Notes region to the top of the body: deleted and inserted again unchanged.
    const top = posOf(doc, 'pTitle0000000001');
    const moved = apply(doc, [
      new ReplaceStep(notesAt, notesAt + notes.nodeSize, Slice.empty),
      new ReplaceStep(top, top, new Slice(Fragment.from(notes), 0, 0)),
    ]);
    const m = diffScopes(doc, moved);
    expect(m.changed).toEqual(['body', 'region:rNotes000000000C']);
    expect(m.regionsMoved).toEqual(['rNotes000000000C']);

    const section = schema.nodeFromJSON({
      type: 'section_break',
      attrs: { id: 'sbBreak000000001', pageSetup: 'ps1' },
    });
    const broken = apply(doc, [new ReplaceStep(end, end, new Slice(Fragment.from(section), 0, 0))]);
    const s = diffScopes(doc, broken);
    expect(s.changed).toEqual(['body']);
    expect(s.sectionBreaksChanged).toBe(true);
  });

  it('names the definition node a commit changed', () => {
    const doc = baseDoc();
    const after = apply(doc, [new AttrStep(posOf(doc, 'LegalBody'), 'color', '#FF0000')]);
    const d = diffScopes(doc, after);
    expect(d.changed).toEqual(['defs:style_def/LegalBody']);
    expect(d.definitionsChanged).toEqual([
      { scope: 'defs:style_def/LegalBody', type: 'style_def', id: 'LegalBody' },
    ]);
  });
});

describe('the outcome check never looks at step shapes (PRM-009)', () => {
  it('gives every step type the verdict of an equivalent plain replacement', () => {
    const before = marked();
    const legalAt = posOf(before, 'rLegal000000000B');
    for (const [kind, step] of stepsOfEveryKind(before)) {
      const after = apply(before, [step]);
      // The same result, built as a replacement of the whole region with a fresh copy (no shared
      // subtrees, so the identity pruning sees every node as new).
      const region = after.nodeAt(posOf(after, 'rLegal000000000B'))!;
      const copy = schema.nodeFromJSON(region.toJSON());
      const old = before.nodeAt(legalAt)!;
      const plain = apply(before, [
        new ReplaceStep(legalAt, legalAt + old.nodeSize, new Slice(Fragment.from(copy), 0, 0)),
      ]);
      expect(plain.eq(after), kind).toBe(true);
      for (const user of [USERS.carol, USERS.bob, USERS.dave, USERS.alice, USERS.mallory]) {
        const a = verdict(user, before, after);
        const b = verdict(user, before, plain);
        expect({ ok: a.ok, scopes: a.scopes }, `${kind} by ${user.sub}`).toEqual({
          ok: b.ok,
          scopes: b.scopes,
        });
      }
    }
  });
});

describe('P6: refusing view-only connections without analysis (PRM-010)', () => {
  it('does not touch either document for a viewer or a commenter', () => {
    const touched: string[] = [];
    const spy = (doc: Node, name: string): Node =>
      new Proxy(doc, {
        get(target, prop, receiver) {
          touched.push(`${name}.${String(prop)}`);
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    const before = baseDoc();
    const after = apply(before, [
      new ReplaceStep(
        posInside(before, 'pIntro0000000001'),
        posInside(before, 'pIntro0000000001'),
        new Slice(Fragment.from(schema.text('x')), 0, 0),
      ),
    ]);
    for (const user of [USERS.frank, { ...USERS.frank, sub: 'cora', role: 'commenter' as const }]) {
      const v = outcomeCheck({
        before: spy(before, 'before'),
        after: spy(after, 'after'),
        user: user.sub,
        access: computeAccess(user, regionsOf(before), basePermissions(), 0),
        perms: basePermissions(),
        suggestionOwners: new Map(),
        fieldsChangedSinceBase: new Set(),
        serverAuthored: false,
        origin: 'input',
      });
      expect(v).toMatchObject({ ok: false, code: 'permission_denied' });
    }
    expect(touched).toEqual([]);
  });
});

describe('preserved content is protected like any other content (CDM-051)', () => {
  const W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';
  /** The base document with a preserved atom and a preserved attribute in the restricted region. */
  function preserved(): Node {
    const doc = baseDoc();
    const atom = schema.nodes['preserved_block']!.create({
      id: 'pbChart000000001',
      label: 'chart',
      fragment: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
    });
    const end =
      posInside(doc, 'pLegal000000001B') +
      doc.nodeAt(posOf(doc, 'pLegal000000001B'))!.content.size +
      1;
    return apply(doc, [
      new ReplaceStep(end, end, new Slice(Fragment.from(atom), 0, 0)),
      new AttrStep(posOf(doc, 'pLegal000000001B'), 'preserved', {
        children: [{ name: `${W}textAlignment` }],
      }),
    ]);
  }

  it('needs edit in its scope to change, whatever the step type', () => {
    const before = preserved();
    const atomAt = posOf(before, 'pbChart000000001');
    const atom = before.nodeAt(atomAt)!;
    const changes: Array<[string, Step[]]> = [
      ['attribute of the atom', [new AttrStep(atomAt, 'label', 'diagram')]],
      ['the atom deleted', [new ReplaceStep(atomAt, atomAt + atom.nodeSize, Slice.empty)]],
      [
        'the preserved attribute',
        [new AttrStep(posOf(before, 'pLegal000000001B'), 'preserved', { children: [] })],
      ],
      [
        'the atom replaced',
        [
          new ReplaceStep(
            atomAt,
            atomAt + atom.nodeSize,
            new Slice(
              Fragment.from(
                schema.nodes['preserved_block']!.create({ ...atom.attrs, fallbackText: 'x' }),
              ),
              0,
              0,
            ),
          ),
        ],
      ],
    ];
    for (const [name, steps] of changes) {
      const after = apply(before, steps);
      expect(verdict(USERS.carol, before, after), name).toMatchObject({
        ok: false,
        scopes: ['region:rLegal000000000B'],
      });
      expect(verdict(USERS.bob, before, after).ok, name).toBe(true);
    }
  });
});

describe('fuzzing the outcome check (PRM-017)', () => {
  it('never throws on random edits by random users and permissions', () => {
    const users = Object.values(USERS);
    const edit = fc.record({
      at: fc.nat(10_000),
      len: fc.nat(8),
      kind: fc.nat(7),
      user: fc.nat(users.length - 1),
      perms: fc.nat(5),
    });
    let checked = 0;
    fc.assert(
      fc.property(fc.array(edit, { minLength: 1, maxLength: 6 }), (edits) => {
        let doc = marked();
        for (const e of edits) {
          const before = doc;
          const size = before.content.size;
          const from = 1 + (e.at % (size - 1));
          const to = Math.min(size - 1, from + e.len);
          const steps: Step[] = [
            new ReplaceStep(from, to, Slice.empty),
            new AddMarkStep(from, to, schema.marks['bold']!.create()),
            new AttrStep(from, 'style', 'Heading1'),
            new AddNodeMarkStep(from, del('mallory')),
            new RemoveMarkStep(from, to, schema.marks['bold']!.create()),
            new ReplaceStep(from, from, new Slice(Fragment.from(schema.text('z')), 0, 0)),
            new ReplaceStep(from, to, new Slice(Fragment.from(schema.text('y')), 0, 0)),
            new AttrStep(from, 'policy', 'restricted'),
          ];
          const r = applySteps(before, [steps[e.kind]!]);
          if (!r.ok) continue;
          doc = r.value.doc;
          const perms = [
            basePermissions(),
            { ...basePermissions(), documentState: 'locked' as const },
            { ...basePermissions(), grants: [] },
            {
              ...basePermissions(),
              regionStates: new Map([['rLegal000000000B', 'approved' as const]]),
            },
            {
              ...basePermissions(),
              leases: [{ region: 'rTerms000000000A', holder: 'alice', expiresAt: 10 }],
            },
            { ...basePermissions(), workflowActive: true },
          ][e.perms % 6]!;
          const v = verdict(users[e.user]!, before, doc, perms);
          expect(typeof v.ok).toBe('boolean');
          checked++;
        }
      }),
      { numRuns: 500 },
    );
    expect(checked).toBeGreaterThan(500);
  });
});
