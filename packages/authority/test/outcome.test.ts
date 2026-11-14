// The outcome check (07 §5; 12 §4.2): table-driven cases for P1, P2, P4, P6, P7, P8, P9 and 07 §5.3,
// with every step type, including attribute, mark, node-mark and crafted replaceAround steps.
import { Fragment, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { outcomeCheck, type OutcomeVerdict } from '../src/permissions/outcome.ts';
import { diffScopes } from '../src/permissions/scopes.ts';
import { applySteps } from '../src/rebase.ts';
import { regionsOf } from '../src/room/room.ts';
import { USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';

function check(
  user: Connection,
  make: (doc: ReturnType<typeof baseDoc>) => Step[],
  perms: PermissionState = basePermissions(),
  extra: { fieldsChangedSinceBase?: Set<string>; origin?: string; serverAuthored?: boolean } = {},
): OutcomeVerdict {
  const before = baseDoc();
  const steps = make(before);
  const r = applySteps(before, steps);
  if (!r.ok) throw new Error(`steps do not apply: ${r.reason}`);
  const access = computeAccess(user, regionsOf(before), perms, 0);
  return outcomeCheck({
    before,
    after: r.value.doc,
    user: user.sub,
    access,
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: extra.fieldsChangedSinceBase ?? new Set(),
    serverAuthored: extra.serverAuthored ?? false,
    origin: extra.origin ?? 'input',
  });
}

const insertText =
  (id: string, text: string, offset = 0) =>
  (doc: ReturnType<typeof baseDoc>) => {
    const pos = posInside(doc, id, offset);
    return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
  };
const boldRange = (id: string, from: number, to: number) => (doc: ReturnType<typeof baseDoc>) => {
  const start = posInside(doc, id);
  return [new AddMarkStep(start + from, start + to, schema.marks['bold']!.create())];
};
const setAttr = (id: string, attr: string, value: unknown) => (doc: ReturnType<typeof baseDoc>) => [
  new AttrStep(posOf(doc, id), attr, value),
];

const denied = (v: OutcomeVerdict, scope?: string) => {
  expect(v.ok, JSON.stringify(v)).toBe(false);
  if (!v.ok && scope) expect(v.scopes).toContain(scope);
};
const allowed = (v: OutcomeVerdict) => expect(v.ok, v.ok ? '' : v.reason).toBe(true);

describe('outcome check', () => {
  it('P1: an editor edits the body and inherit regions, not the restricted region', () => {
    allowed(check(USERS.carol, insertText('pIntro0000000001', 'Hello ')));
    allowed(check(USERS.carol, insertText('pTerms000000001A', 'Note: ')));
    denied(
      check(USERS.carol, insertText('pLegal000000001B', 'Sneaky ')),
      'region:rLegal000000000B',
    );
  });

  it('P1: a grant to a group opens the restricted region', () => {
    allowed(check(USERS.bob, insertText('pLegal000000001B', 'Agreed ')));
  });

  it('P1 holds for every step type: mark, attribute, node mark and crafted replaceAround', () => {
    denied(check(USERS.carol, boldRange('pLegal000000001B', 0, 9)), 'region:rLegal000000000B');
    denied(
      check(USERS.carol, setAttr('pLegal000000001B', 'style', 'Heading1')),
      'region:rLegal000000000B',
    );
    denied(
      check(USERS.carol, (doc) => [
        new AddNodeMarkStep(
          posOf(doc, 'pLegal000000001B'),
          schema.marks['del']!.create({ id: 'sSuggestCarol001', user: 'carol' }),
        ),
      ]),
      'region:rLegal000000000B',
    );
    // Unwrap the restricted region with a replaceAround: its content moves into the body.
    denied(
      check(USERS.carol, (doc) => {
        const at = posOf(doc, 'rLegal000000000B');
        const region = doc.nodeAt(at)!;
        return [
          new ReplaceAroundStep(
            at,
            at + region.nodeSize,
            at + 1,
            at + region.nodeSize - 1,
            Slice.empty,
            0,
            true,
          ),
        ];
      }),
    );
  });

  it('P2: moving, adding or removing a region needs structure and edit in it', () => {
    // Carol (editor) deletes the inherit region Notes: allowed (structure, edit in it and in body).
    allowed(
      check(USERS.carol, (doc) => {
        const at = posOf(doc, 'rNotes000000000C');
        return [new ReplaceStep(at, at + doc.nodeAt(at)!.nodeSize, Slice.empty)];
      }),
    );
    // Carol deletes the restricted region: denied.
    denied(
      check(USERS.carol, (doc) => {
        const at = posOf(doc, 'rLegal000000000B');
        return [new ReplaceStep(at, at + doc.nodeAt(at)!.nodeSize, Slice.empty)];
      }),
      'region:rLegal000000000B',
    );
    // Dave (suggester) cannot remove any region: no structure.
    denied(
      check(USERS.dave, (doc) => {
        const at = posOf(doc, 'rNotes000000000C');
        return [new ReplaceStep(at, at + doc.nodeAt(at)!.nodeSize, Slice.empty)];
      }),
    );
  });

  it('P2: changing a policy needs manage; creating a restricted region needs manage', () => {
    denied(
      check(USERS.carol, setAttr('rTerms000000000A', 'policy', 'restricted')),
      'region:rTerms000000000A',
    );
    allowed(check(USERS.alice, setAttr('rTerms000000000A', 'policy', 'restricted')));
    const newRegion = (policy: string) => (doc: ReturnType<typeof baseDoc>) => {
      const at = posOf(doc, 'pEnd00000000001Z');
      const region = schema.nodeFromJSON({
        type: 'region',
        attrs: { id: 'rNewRegion00000N', policy },
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'pInNewRegion000N' },
            content: [{ type: 'text', text: 'Mine' }],
          },
        ],
      });
      return [new ReplaceStep(at, at, new Slice(Fragment.from(region), 0, 0))];
    };
    allowed(check(USERS.carol, newRegion('inherit')));
    denied(check(USERS.carol, newRegion('restricted')), 'region:rNewRegion00000N');
  });

  it('P4: a suggester inserts with their own ins mark but cannot edit the baseline', () => {
    const ins = (user: string, id: string) => (doc: ReturnType<typeof baseDoc>) => {
      const pos = posInside(doc, 'pIntro0000000001', 5);
      return [
        new ReplaceStep(
          pos,
          pos,
          new Slice(
            Fragment.from(schema.text('really ', [schema.marks['ins']!.create({ id, user })])),
            0,
            0,
          ),
        ),
      ];
    };
    allowed(check(USERS.dave, ins('dave', 'sDaveSuggestion1')));
    denied(check(USERS.dave, ins('carol', 'sCarolSuggest001')), 'body');
    denied(check(USERS.dave, insertText('pIntro0000000001', 'plain ')), 'body');
    // A suggested deletion is a del mark; the text stays.
    allowed(
      check(USERS.dave, (doc) => {
        const start = posInside(doc, 'pIntro0000000001');
        return [
          new AddMarkStep(
            start,
            start + 4,
            schema.marks['del']!.create({ id: 'sDaveDelete00001', user: 'dave' }),
          ),
        ];
      }),
    );
    // Dave has a suggester grant in the restricted region.
    allowed(
      check(USERS.dave, (doc) => {
        const pos = posInside(doc, 'pLegal000000001B', 3);
        return [
          new ReplaceStep(
            pos,
            pos,
            new Slice(
              Fragment.from(
                schema.text('x', [
                  schema.marks['ins']!.create({ id: 'sDaveLegal000001', user: 'dave' }),
                ]),
              ),
              0,
              0,
            ),
          ),
        ];
      }),
    );
  });

  it('P6: viewers are refused without analysis', () => {
    const v = check(USERS.frank, insertText('pIntro0000000001', 'x'));
    denied(v);
    if (!v.ok) expect(v.reason).toMatch(/P6/);
  });

  it('P7: the filler fills their own field and nothing else', () => {
    const fill = (value: unknown) => (doc: ReturnType<typeof baseDoc>) => [
      new AttrStep(posOf(doc, 'fTenantName00001'), 'value', value),
    ];
    allowed(check(USERS.erin, fill('Ada Lovelace')));
    denied(check(USERS.erin, insertText('pIntro0000000001', 'x')), 'body');
    // A filler without the role cannot fill.
    denied(check({ ...USERS.erin, participantRoles: [] }, fill('x')), 'field:fTenantName00001');
    // An inactive participant cannot fill.
    denied(check({ ...USERS.erin, participantActive: false }, fill('x')), 'field:fTenantName00001');
    // An editor may set it directly while the document is a draft, but only where they may edit.
    allowed(check(USERS.bob, fill('Set by Bob')));
    denied(check(USERS.carol, fill('Set by Carol')), 'field:fTenantName00001');
  });

  it('P9: a fill that races another fill of the same field is a conflict', () => {
    const v = check(
      USERS.erin,
      (doc) => [new AttrStep(posOf(doc, 'fTenantName00001'), 'value', 'Ada')],
      basePermissions(),
      {
        fieldsChangedSinceBase: new Set(['fTenantName00001']),
      },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('conflict');
  });

  it('07 §5.3: a style used by a protected region needs edit there or manage', () => {
    denied(
      check(USERS.carol, setAttr('LegalBody', 'color', '#FF0000')),
      'defs:style_def/LegalBody',
    );
    allowed(check(USERS.bob, setAttr('LegalBody', 'color', '#FF0000')));
    allowed(check(USERS.alice, setAttr('LegalBody', 'color', '#FF0000')));
    // Normal is the root of LegalBody's chain, so it is protected too.
    denied(check(USERS.carol, setAttr('Normal', 'fontSize', 400)), 'defs:style_def/Normal');
    const approved = {
      ...basePermissions(),
      regionStates: new Map([['rLegal000000000B', 'approved' as const]]),
    };
    denied(
      check(USERS.alice, setAttr('LegalBody', 'color', '#FF0000'), approved),
      'defs:style_def/LegalBody',
    );
  });

  it('limits: an approved region freezes even for owners; a lease holds others off', () => {
    const approved = {
      ...basePermissions(),
      regionStates: new Map([['rTerms000000000A', 'approved' as const]]),
    };
    denied(
      check(USERS.alice, insertText('pTerms000000001A', 'x'), approved),
      'region:rTerms000000000A',
    );
    const leased = {
      ...basePermissions(),
      leases: [{ region: 'rTerms000000000A', holder: 'alice', expiresAt: 10_000 }],
    };
    denied(
      check(USERS.carol, insertText('pTerms000000001A', 'x'), leased),
      'region:rTerms000000000A',
    );
    allowed(check(USERS.alice, insertText('pTerms000000001A', 'x'), leased));
  });
});

describe('scope diff', () => {
  it('finds changed scopes without visiting unchanged regions', () => {
    const before = baseDoc();
    const pos = posInside(before, 'pTerms000000001A');
    const r = applySteps(before, [
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0)),
    ]);
    if (!r.ok) throw new Error(r.reason);
    const d = diffScopes(before, r.value.doc);
    expect(d.changed).toEqual(['region:rTerms000000000A']);
    // Only the changed path is compared structurally: the region, its paragraph and their text.
    expect(d.visited).toBeLessThan(10);
  });

  it('puts a field value in its own scope, not in the region', () => {
    const before = baseDoc();
    const r = applySteps(before, [new AttrStep(posOf(before, 'fTenantName00001'), 'value', 'Ada')]);
    if (!r.ok) throw new Error(r.reason);
    expect(diffScopes(before, r.value.doc).changed).toEqual(['field:fTenantName00001']);
  });
});
