// Fields in the outcome check (12 §4; FRW-007 to FRW-010; ADR 0019 change 5; FRW-088): fill-only
// participants change only the values of their own fields, server-set kinds only by the server,
// `sensitive` only with `manage`, and nobody changes a value they cannot read.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import { ROLE_CAPABILITIES } from '../src/permissions/model.ts';
import { diffScopes } from '../src/permissions/scopes.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import { addSuggestion } from './block-suggest.ts';
import { posInside, posOf } from './fixtures.ts';
import {
  FIELDS,
  MORE,
  USERS,
  fieldsDoc,
  morePermissions,
  refused,
  schema,
  verdictOf,
} from './permission-fixtures.ts';

const setAttr =
  (id: string, attr: string, value: unknown) =>
  (doc: Node): Step[] => [new AttrStep(posOf(doc, id), attr, value)];
const fill = (id: string, value: unknown) => setAttr(id, 'value', value);
const SIGNATURE = { asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10', mode: 'typed' };

describe('the fill capability, the filler role and field scopes (FRW-007)', () => {
  it('gives a filler exactly view and fill, document-wide', () => {
    expect(ROLE_CAPABILITIES.filler).toEqual(['view', 'fill']);
    const doc = fieldsDoc();
    const a = computeAccess(USERS.erin, regionInfos(doc), morePermissions(), 0);
    expect([...a.docRole].sort()).toEqual(['fill', 'view']);
    expect([...a.body].sort()).toEqual(['fill', 'view']);
    for (const caps of a.regions.values()) expect([...caps]).toEqual(['view']);
    expect(a.fill).toMatchObject({ roles: ['role_tenant'], active: true, allowed: true });
  });

  it('puts each changed value in its own scope, and no scope for fields it did not change', () => {
    const doc = fieldsDoc();
    const r = applySteps(doc, [
      ...fill(FIELDS.number, '12.50')(doc),
      ...fill(FIELDS.date, '2026-11-30')(doc),
    ]);
    if (!r.ok) throw new Error(r.reason);
    expect(diffScopes(doc, r.value.doc).changed).toEqual([
      `field:${FIELDS.date}`,
      `field:${FIELDS.number}`,
    ]);
  });
});

describe('a fill-only participant changes only the values of their own fields (FRW-008, P7)', () => {
  it('accepts a value of a field assigned to one of their roles', () => {
    const doc = fieldsDoc();
    expect(verdictOf(USERS.erin, doc, fill(FIELDS.number, '12.50')).ok).toBe(true);
    expect(verdictOf(USERS.erin, doc, fill(FIELDS.tenantName, 'Ada')).ok).toBe(true);
    expect(verdictOf(MORE.lena, doc, fill(FIELDS.landlord, 'Lena')).ok).toBe(true);
  });

  it('refuses anything else, however the steps are shaped', () => {
    const doc = fieldsDoc();
    const at = posInside(doc, 'pFields00000001X');
    const p = posOf(doc, 'pFields00000001X');
    const para = doc.nodeAt(p)!;
    const fieldAt = posOf(doc, FIELDS.number);
    const attempts: Array<[string, (d: Node) => Step[], string]> = [
      [
        'body text',
        () => [new ReplaceStep(at, at, new Slice(Fragment.from(schema.text('x')), 0, 0))],
        'body',
      ],
      ['the required flag', setAttr(FIELDS.number, 'required', true), 'body'],
      ['the assignee', setAttr(FIELDS.number, 'assignee', 'role_landlord'), 'body'],
      ['a definition', setAttr('Normal', 'color', '#FF0000'), 'defs:style_def/Normal'],
      ['a region', setAttr('pTerms000000001A', 'style', 'Heading1'), 'region:rTerms000000000A'],
      [
        'a mark over the field',
        () => [new AddMarkStep(fieldAt, fieldAt + 1, schema.marks['bold']!.create())],
        'body',
      ],
      [
        'a block suggestion',
        (d) => [
          addSuggestion(
            d,
            p,
            schema.marks['ins']!.create({ id: 'sErin00000000001', user: 'erin' }),
          ),
        ],
        'body',
      ],
      [
        'a crafted replaceAround',
        () => [
          new ReplaceAroundStep(
            p,
            p + para.nodeSize,
            p + 1,
            p + para.nodeSize - 1,
            new Slice(
              Fragment.from(
                schema.nodes['paragraph']!.create({ ...para.attrs, style: 'Heading1' }),
              ),
              0,
              0,
            ),
            1,
            true,
          ),
        ],
        'body',
      ],
    ];
    for (const [name, make, scope] of attempts) {
      const v = verdictOf(USERS.erin, doc, (d) => [...fill(FIELDS.number, '1')(d), ...make(d)]);
      expect(v.ok, name).toBe(false);
      if (!v.ok) {
        expect(v.code, name).toBe('permission_denied');
        expect(v.scopes, name).toContain(scope);
        // The value itself was hers to fill, unless the commit also reassigned the field.
        if (name !== 'the assignee') expect(v.scopes, name).not.toContain(`field:${FIELDS.number}`);
      }
    }
  });

  it("refuses another role's field, a field only authors set, a read-only field and server-set kinds", () => {
    const doc = fieldsDoc();
    for (const [id, value] of [
      [FIELDS.landlord, 'x'],
      [FIELDS.authorOnly, 'x'],
      [FIELDS.readOnly, 'x'],
      [FIELDS.signature, SIGNATURE],
      [FIELDS.initials, SIGNATURE],
      [FIELDS.dateSigned, '2026-11-06'],
      [FIELDS.formula, '42'],
    ] as const) {
      const v = verdictOf(USERS.erin, doc, fill(id, value));
      expect(v, id).toMatchObject({
        ok: false,
        code: 'permission_denied',
        scopes: [`field:${id}`],
      });
    }
  });

  it('refuses a participant who is not active, or whose roles do not include the assignee', () => {
    const doc = fieldsDoc();
    expect(
      refused(
        verdictOf({ ...USERS.erin, participantActive: false }, doc, fill(FIELDS.number, '1')),
      ),
    ).toEqual([`field:${FIELDS.number}`]);
    expect(
      refused(verdictOf({ ...USERS.erin, participantRoles: [] }, doc, fill(FIELDS.number, '1'))),
    ).toEqual([`field:${FIELDS.number}`]);
  });

  it('gives the origin label no effect: the outcome alone decides', () => {
    const doc = fieldsDoc();
    for (const user of [USERS.erin, USERS.carol, MORE.rita, USERS.dave]) {
      for (const make of [fill(FIELDS.landlord, 'x'), fill(FIELDS.number, '2')]) {
        const asFill = verdictOf(user, doc, make, { extra: { origin: 'fill' } });
        const asInput = verdictOf(user, doc, make, { extra: { origin: 'input' } });
        expect(asFill, user.sub).toEqual(asInput);
      }
    }
  });

  it('costs the same whatever the size of the document: only the changed path is compared', () => {
    const small = fieldsDoc();
    const at = posOf(small, 'pEnd00000000001Z');
    const filler = Array.from({ length: 300 }, (_, i) =>
      schema.nodeFromJSON({
        type: 'paragraph',
        attrs: { id: `pBulk${String(i).padStart(11, '0')}` },
        content: [{ type: 'text', text: 'unchanged' }],
      }),
    );
    const r = applySteps(small, [new ReplaceStep(at, at, new Slice(Fragment.from(filler), 0, 0))]);
    if (!r.ok) throw new Error(r.reason);
    const large = r.value.doc;
    const visited = (doc: Node) => {
      const after = applySteps(doc, fill(FIELDS.number, '7')(doc));
      if (!after.ok) throw new Error(after.reason);
      return diffScopes(doc, after.value.doc).visited;
    };
    expect(visited(large)).toBe(visited(small));
    expect(verdictOf(USERS.erin, large, fill(FIELDS.number, '7')).ok).toBe(true);
  });
});

describe('server-set values (FRW-009, P8)', () => {
  it('refuses every client change of a signature, initials, date-signed or formula value, the owner included', () => {
    const doc = fieldsDoc();
    for (const user of [USERS.alice, USERS.carol, USERS.erin]) {
      for (const [id, value] of [
        [FIELDS.signature, SIGNATURE],
        [FIELDS.initials, SIGNATURE],
        [FIELDS.dateSigned, '2020-01-01'],
        [FIELDS.formula, '1000'],
      ] as const) {
        const v = verdictOf(user, doc, fill(id, value));
        expect(v, `${user.sub} ${id}`).toMatchObject({ ok: false, code: 'permission_denied' });
        if (!v.ok) expect(v.reason, id).toMatch(/server-authored commits \(P8\)/);
      }
    }
  });

  it('accepts such a value only in a server-authored commit with origin sign or rules', () => {
    const doc = fieldsDoc();
    const sign = { serverAuthored: true, origin: 'sign' };
    expect(verdictOf(USERS.alice, doc, fill(FIELDS.signature, SIGNATURE), { extra: sign }).ok).toBe(
      true,
    );
    expect(
      verdictOf(USERS.alice, doc, fill(FIELDS.formula, '1'), {
        extra: { serverAuthored: true, origin: 'rules' },
      }).ok,
    ).toBe(true);
    // A client cannot claim to be the server: the flag comes from the room, and a reserved origin
    // without it is no more than a label.
    expect(
      verdictOf(USERS.alice, doc, fill(FIELDS.signature, SIGNATURE), { extra: { origin: 'sign' } })
        .ok,
    ).toBe(false);
    expect(
      verdictOf(USERS.alice, doc, fill(FIELDS.signature, SIGNATURE), {
        extra: { serverAuthored: true, origin: 'prefill' },
      }).ok,
    ).toBe(false);
  });

  it('refuses a pasted copy of a signed field, and accepts the same field inserted without a value', () => {
    const doc = fieldsDoc();
    const at = posInside(doc, 'pIntro0000000001');
    const insert =
      (value: unknown, kind = 'signature') =>
      () => [
        new ReplaceStep(
          at,
          at,
          new Slice(
            Fragment.from(
              schema.nodes['form_field']!.create({
                id: 'fPasted000000001',
                key: 'tenant.signature2',
                kind,
                label: 'Signature',
                assignee: 'role_tenant',
                value,
              }),
            ),
            0,
            0,
          ),
        ),
      ];
    expect(verdictOf(USERS.carol, doc, insert(SIGNATURE))).toMatchObject({
      ok: false,
      scopes: ['field:fPasted000000001'],
    });
    expect(verdictOf(USERS.carol, doc, insert('2020-01-01', 'dateSigned')).ok).toBe(false);
    expect(verdictOf(USERS.carol, doc, insert(null)).ok).toBe(true);
  });

  it('refuses turning a filled field into a server-set kind that keeps its value', () => {
    const doc = fieldsDoc();
    // A text field holding "1000" turned into a formula would carry a client-set formula result.
    const filled = applySteps(doc, fill(FIELDS.authorOnly, '1000')(doc));
    if (!filled.ok) throw new Error(filled.reason);
    const v = verdictOf(
      USERS.carol,
      filled.value.doc,
      setAttr(FIELDS.authorOnly, 'kind', 'formula'),
    );
    expect(v).toMatchObject({ ok: false, scopes: [`field:${FIELDS.authorOnly}`] });
    // Without a value the kind may change: there is nothing to forge.
    expect(verdictOf(USERS.carol, doc, setAttr(FIELDS.authorOnly, 'kind', 'formula')).ok).toBe(
      true,
    );
  });
});

describe('concurrent fills (FRW-010, P9)', () => {
  it('rejects a fill of a field changed after its base, and the whole commit with it', () => {
    const doc = fieldsDoc();
    const both = (d: Node) => [
      ...fill(FIELDS.number, '1')(d),
      ...fill(FIELDS.date, '2026-12-01')(d),
    ];
    const v = verdictOf(USERS.erin, doc, both, {
      extra: { fieldsChangedSinceBase: new Set([FIELDS.date]) },
    });
    expect(v).toMatchObject({ ok: false, code: 'conflict', scopes: [`field:${FIELDS.date}`] });
    // Unrelated changes since the base never cause a conflict.
    expect(
      verdictOf(USERS.erin, doc, fill(FIELDS.number, '1'), {
        extra: { fieldsChangedSinceBase: new Set([FIELDS.choice]) },
      }).ok,
    ).toBe(true);
  });
});

describe('who may change `sensitive` (ADR 0019 change 5; FRW-088)', () => {
  it('needs manage to set or clear it, including by inserting a sensitive field', () => {
    const doc = fieldsDoc();
    for (const user of [USERS.carol, USERS.bob, MORE.rita]) {
      expect(
        refused(verdictOf(user, doc, setAttr(FIELDS.authorOnly, 'sensitive', true))),
        user.sub,
      ).toContain(`field:${FIELDS.authorOnly}`);
    }
    expect(verdictOf(USERS.alice, doc, setAttr(FIELDS.authorOnly, 'sensitive', true)).ok).toBe(
      true,
    );
    expect(verdictOf(USERS.alice, doc, setAttr(FIELDS.secret, 'sensitive', false)).ok).toBe(true);
    // A new field that arrives sensitive changes the attribute from its default.
    const at = posInside(doc, 'pIntro0000000001');
    const sensitiveField = () => [
      new ReplaceStep(
        at,
        at,
        new Slice(
          Fragment.from(
            schema.nodes['form_field']!.create({
              id: 'fNewSecret000001',
              key: 'new.secret',
              kind: 'text',
              label: 'New secret',
              sensitive: true,
              value: 'hidden from others',
            }),
          ),
          0,
          0,
        ),
      ),
    ];
    const v = verdictOf(USERS.carol, doc, sensitiveField);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/`field.sensitive` needs `manage`/);
    expect(verdictOf(USERS.alice, doc, sensitiveField).ok).toBe(true);
  });
});

describe('nobody changes a value they cannot read (ADR 0019 change 5; FRW-088)', () => {
  it('refuses a change to the value, default, assignee or container of a field whose value is hidden', () => {
    const doc = fieldsDoc();
    // Carol is an editor with edit in the body, but not a reader of the landlord's income.
    for (const [attr, value] of [
      ['value', 'guess'],
      ['default', 'x'],
      ['assignee', 'role_tenant'],
      ['label', 'renamed'],
    ] as const) {
      const v = verdictOf(USERS.carol, doc, setAttr(FIELDS.secret, attr, value));
      expect(v, attr).toMatchObject({ ok: false, code: 'permission_denied' });
      if (!v.ok) expect(v.scopes, attr).toContain(`field:${FIELDS.secret}`);
    }
    // Moving it into the region Notes (cut and paste with the field's own value).
    const at = posOf(doc, FIELDS.secret);
    const node = doc.nodeAt(at)!;
    const move = (d: Node): Step[] => {
      const notes = posInside(d, 'pNotes000000001C');
      return [
        new ReplaceStep(notes, notes, new Slice(Fragment.from(node), 0, 0)),
        new ReplaceStep(at, at + 1, Slice.empty),
      ];
    };
    expect(verdictOf(USERS.carol, doc, move).ok).toBe(false);
    // Deleting it reveals nothing and needs only edit in its container (ADR 0019 open question;
    // S12 allows it).
    expect(verdictOf(USERS.carol, doc, () => [new ReplaceStep(at, at + 1, Slice.empty)]).ok).toBe(
      true,
    );
  });

  it('lets the readers of a value change it: manage, the assignee role, a grant on its region', () => {
    const doc = fieldsDoc();
    expect(verdictOf(USERS.alice, doc, fill(FIELDS.secret, 'new')).ok).toBe(true);
    expect(verdictOf(MORE.lena, doc, fill(FIELDS.secret, 'new')).ok).toBe(true);
    // Rita holds an editor grant on Terms, so she reads, and may change, the rent there; Carol,
    // with edit in Terms through her document role but no grant, may not.
    expect(verdictOf(MORE.rita, doc, fill(FIELDS.termsSecret, '900')).ok).toBe(true);
    expect(verdictOf(USERS.carol, doc, fill(FIELDS.termsSecret, '900')).ok).toBe(false);
  });
});

describe('confidential regions in the outcome check (ADR 0019; PRM-066)', () => {
  const confidential = (doc: Node) => setAttr('rTerms000000000A', 'policy', 'confidential')(doc);

  it('lets only manage make a region confidential or ordinary again, or create one', () => {
    const doc = fieldsDoc();
    expect(verdictOf(USERS.carol, doc, confidential)).toMatchObject({
      ok: false,
      scopes: ['region:rTerms000000000A'],
    });
    expect(verdictOf(USERS.alice, doc, confidential).ok).toBe(true);
    const made = applySteps(doc, confidential(doc));
    if (!made.ok) throw new Error(made.reason);
    const back = setAttr('rTerms000000000A', 'policy', 'inherit');
    expect(verdictOf(MORE.rita, made.value.doc, back).ok).toBe(false);
    expect(verdictOf(USERS.alice, made.value.doc, back).ok).toBe(true);
    const end = posOf(doc, 'pEnd00000000001Z');
    const create = () => [
      new ReplaceStep(
        end,
        end,
        new Slice(
          Fragment.from(
            schema.nodeFromJSON({
              type: 'region',
              attrs: { id: 'rSecret000000001', policy: 'confidential' },
              content: [{ type: 'paragraph', attrs: { id: 'pSecret000000001' } }],
            }),
          ),
          0,
          0,
        ),
      ),
    ];
    expect(verdictOf(USERS.carol, doc, create).ok).toBe(false);
    expect(verdictOf(USERS.alice, doc, create).ok).toBe(true);
  });

  it('refuses every change to a confidential region from someone who cannot read it', () => {
    const made = applySteps(fieldsDoc(), confidential(fieldsDoc()));
    if (!made.ok) throw new Error(made.reason);
    const doc = made.value.doc;
    const pos = posInside(doc, 'pTerms000000001A');
    const typing = () => [
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0)),
    ];
    const removing = (d: Node) => {
      const at = posOf(d, 'rTerms000000000A');
      return [new ReplaceStep(at, at + d.nodeAt(at)!.nodeSize, Slice.empty)];
    };
    // Carol, an editor without a grant, cannot type in it or remove it; Rita, with an editor grant,
    // may type in it; removing it is structure, which only Alice, the owner, holds as well.
    expect(verdictOf(USERS.carol, doc, typing).ok).toBe(false);
    expect(verdictOf(MORE.rita, doc, typing).ok).toBe(true);
    expect(verdictOf(USERS.carol, doc, removing)).toMatchObject({
      ok: false,
      scopes: ['region:rTerms000000000A'],
    });
    expect(verdictOf(MORE.rita, doc, removing).ok).toBe(false);
    expect(verdictOf(USERS.alice, doc, removing).ok).toBe(true);
  });
});
