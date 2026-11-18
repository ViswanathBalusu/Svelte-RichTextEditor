// Suggestions (07 §5.2 P4; 03 §5; PRM-013, PRM-014, PRM-015, PRM-062; ADR 0050 items 2 to 4):
// the baseline, P4 as the rejection of the submitter's own suggestions, the identity of every
// suggestion mark in every commit, `trackChanges: everyone`, block suggestions on paragraphs, rows
// and tables, and the import labels of spike S11 (change 6; SR-M14).
import { sha256Hex } from '@docedit/model';
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceStep,
  type Step,
  Transform,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { outcomeCheck } from '../src/permissions/outcome.ts';
import {
  type Counter,
  baselineText,
  isImportLabel,
  sameBaseline,
} from '../src/permissions/suggestions.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, basePermissions, posInside, posOf, schema } from './fixtures.ts';
import { oracleViolations } from './harness/oracle.ts';
import { commitId, messages, rejection, roomWith, verdictBetween } from './permission-fixtures.ts';
import { BASE_JSON } from './fixtures.ts';

type J = Record<string, unknown>;

const ins = (id: string, user: string) => schema.marks['ins']!.create({ id, user });
const del = (id: string, user: string) => schema.marks['del']!.create({ id, user });
const fmt = (id: string, user: string, before: unknown) =>
  schema.marks['fmt']!.create({ id, user, before });
const text = (s: string, marks: ReturnType<typeof ins>[] = []) => schema.text(s, marks);

/** The base document with a table of two rows after the middle paragraph. */
function tableJson(): J {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const cell = (id: string, t: string) => ({
    type: 'table_cell',
    attrs: { id },
    content: [
      { type: 'paragraph', attrs: { id: `p${id.slice(1)}` }, content: [{ type: 'text', text: t }] },
    ],
  });
  const body = json.content[1]!.content;
  const at = body.findIndex((b) => (b['attrs'] as J | undefined)?.['id'] === 'pMiddle000000001');
  body.splice(at + 1, 0, {
    type: 'table',
    attrs: { id: 'tTable0000000001', grid: [2000, 2000] },
    content: [
      {
        type: 'table_row',
        attrs: { id: 'trRow00000000001' },
        content: [cell('cA00000000000001', 'Rent'), cell('cB00000000000001', 'Monthly')],
      },
      {
        type: 'table_row',
        attrs: { id: 'trRow00000000002' },
        content: [cell('cA00000000000002', 'Deposit'), cell('cB00000000000002', 'One month')],
      },
    ],
  });
  return json as unknown as J;
}
const tableDoc = (): Node => {
  const d = schema.nodeFromJSON(tableJson());
  d.check();
  return d;
};

const typed = (
  doc: Node,
  at: string,
  s: string,
  marks: ReturnType<typeof ins>[] = [],
  offset = 0,
) => {
  const pos = posInside(doc, at, offset);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(text(s, marks)), 0, 0));
};
const scopeOf = (doc: Node, id: string): Node[] => [doc.nodeAt(posOf(doc, id))!];

function check(
  user: Connection,
  before: Node,
  steps: Step[],
  opts: {
    perms?: PermissionState;
    owners?: Map<string, string>;
    origin?: string;
    server?: boolean;
  } = {},
) {
  const r = applySteps(before, steps);
  if (!r.ok) throw new Error(r.reason);
  const perms = opts.perms ?? basePermissions();
  return outcomeCheck({
    before,
    after: r.value.doc,
    user: user.sub,
    access: computeAccess(user, regionInfos(before), perms, 0),
    perms,
    suggestionOwners: opts.owners ?? new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: opts.server ?? false,
    origin: opts.origin ?? 'input',
  });
}

describe('the suggestion baseline (PRM-013)', () => {
  const para = (...content: Node[]) =>
    schema.nodes['paragraph']!.create({ id: 'pIntro0000000001' }, content);

  it('removes ins content, ignores del marks and takes fmt changes back to their before', () => {
    const plain = para(text('abc'));
    const suggested = para(
      text('a'),
      text('X', [ins('sCarol0000000001', 'carol')]),
      text('b', [del('sDave00000000001', 'dave')]),
      text('c', [schema.marks['bold']!.create(), fmt('sErin00000000001', 'erin', { marks: [] })]),
    );
    expect(baselineText([suggested])).toBe(baselineText([plain]));
    // Without its fmt mark the bold is part of the baseline.
    expect(baselineText([para(text('ab'), text('c', [schema.marks['bold']!.create()]))])).not.toBe(
      baselineText([plain]),
    );
  });

  it('takes overlapping fmt marks of two users back to the same baseline in either order (criterion 4)', () => {
    const plain = para(text('abc'));
    const bold = schema.marks['bold']!.create();
    const italic = schema.marks['italic']!.create();
    // The engine gives the second user's fmt the first user's before (owner decision 79; ADR 0378),
    // so every fmt of the run records the formatting before the first suggestion.
    const swapped = [
      ['sAlice0000000001', 'sBob0000000001'],
      ['sBob0000000001', 'sAlice0000000001'],
    ] as const;
    for (const [first, second] of swapped) {
      const both = para(
        text('a'),
        text('bc', [
          bold,
          italic,
          fmt(first, first.startsWith('sAlice') ? 'alice' : 'bob', { marks: [], attrs: {} }),
          fmt(second, second.startsWith('sAlice') ? 'alice' : 'bob', { marks: [], attrs: {} }),
        ]),
      );
      expect(baselineText([both])).toBe(baselineText([plain]));
    }
    // A suggester adds a second user's fmt over a run that already carries one: the commit keeps the
    // baseline, so P4 accepts it.
    const doc = tableDoc();
    const start = posInside(doc, 'pIntro0000000001');
    const seeded = applySteps(doc, [
      new AddMarkStep(start, start + 4, bold),
      new AddMarkStep(start, start + 4, fmt('sCarol0000000001', 'carol', { marks: [], attrs: {} })),
    ]);
    if (!seeded.ok) throw new Error(seeded.reason);
    const verdict = check(
      USERS.dave,
      seeded.value.doc,
      [
        new AddMarkStep(start, start + 4, italic),
        new AddMarkStep(
          start,
          start + 4,
          fmt('sDave00000000001', 'dave', { marks: [], attrs: {} }),
        ),
      ],
      { owners: new Map([['sCarol0000000001', 'carol']]) },
    );
    expect(verdict.ok).toBe(true);
  });

  it('includes attributes and bookmarks', () => {
    const a = para(text('abc'));
    const aligned = schema.nodes['paragraph']!.create({ id: 'pIntro0000000001', align: 'center' }, [
      text('abc'),
    ]);
    expect(baselineText([aligned])).not.toBe(baselineText([a]));
    const mark = schema.nodes['anchor']!.create({ id: 'aBookmark0000001', name: 'here' });
    expect(baselineText([para(text('a'), mark, text('bc'))])).not.toBe(baselineText([a]));
    // A bookmark suggested with an ins mark is not part of it.
    const suggested = schema.nodes['anchor']!.create(
      { id: 'aBookmark0000001', name: 'here' },
      null,
      [ins('sCarol0000000001', 'carol')],
    );
    expect(baselineText([para(text('a'), suggested, text('bc'))])).toBe(baselineText([a]));
  });

  it('handles block suggestions on paragraphs, whole table rows and whole tables', () => {
    const doc = tableDoc();
    const blocks = (d: Node) => {
      const out: Node[] = [];
      d.child(d.childCount - 1).forEach((c) => out.push(c));
      return out;
    };
    const base = baselineText(blocks(doc));
    const apply = (steps: Step[]) => {
      const r = applySteps(doc, steps);
      if (!r.ok) throw new Error(r.reason);
      return blocks(r.value.doc);
    };
    const table = posOf(doc, 'tTable0000000001');
    const row = posOf(doc, 'trRow00000000002');
    // A block marked del is kept; a block marked fmt is restored to its before.
    expect(baselineText(apply([new AddNodeMarkStep(table, del('sDave00000000001', 'dave'))]))).toBe(
      base,
    );
    expect(baselineText(apply([new AddNodeMarkStep(row, del('sDave00000000001', 'dave'))]))).toBe(
      base,
    );
    const intro = posOf(doc, 'pIntro0000000001');
    expect(
      baselineText(
        apply([
          new AttrStep(intro, 'style', 'Heading1'),
          new AddNodeMarkStep(intro, fmt('sDave00000000001', 'dave', { attrs: { style: null } })),
        ]),
      ),
    ).toBe(base);
    // A block marked ins is removed: a new row (with fresh cell and paragraph identifiers), a new
    // paragraph.
    const fresh = schema.nodeFromJSON({
      type: 'table_row',
      attrs: { id: 'trRow00000000003' },
      marks: [{ type: 'ins', attrs: { id: 'sDave00000000001', user: 'dave' } }],
      content: [
        {
          type: 'table_cell',
          attrs: { id: 'cA00000000000003' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pA00000000000003' },
              content: [{ type: 'text', text: 'Fee' }],
            },
          ],
        },
        {
          type: 'table_cell',
          attrs: { id: 'cB00000000000003' },
          content: [{ type: 'paragraph', attrs: { id: 'pB00000000000003' } }],
        },
      ],
    });
    const end = row + doc.nodeAt(row)!.nodeSize;
    expect(
      baselineText(apply([new ReplaceStep(end, end, new Slice(Fragment.from(fresh), 0, 0))])),
    ).toBe(base);
    const newPara = schema.nodes['paragraph']!.create(
      { id: 'pSuggested000001' },
      [text('New')],
      [ins('sDave00000000001', 'dave')],
    );
    const at = posOf(doc, 'pEnd00000000001Z');
    expect(
      baselineText(apply([new ReplaceStep(at, at, new Slice(Fragment.from(newPara), 0, 0))])),
    ).toBe(base);
  });

  it("treats every user's suggestions alike, and none excludes another's", () => {
    const plain = para(text('abcd'));
    const many = para(
      text('ab', [del('sCarol0000000001', 'carol'), del('sDave00000000001', 'dave')]),
      text('X', [ins('sErin00000000001', 'erin')]),
      text('cd', [del('sDave00000000002', 'dave')]),
      text('Y', [ins('sCarol0000000002', 'carol'), ins('sDave00000000003', 'dave')]),
    );
    expect(baselineText([many])).toBe(baselineText([plain]));
  });

  it('hashes equal baselines equally and different ones differently (property)', async () => {
    const base = tableDoc();
    const intro = posInside(base, 'pIntro0000000001');
    const length = base.nodeAt(posOf(base, 'pIntro0000000001'))!.content.size;
    const scope = (d: Node) => {
      const out: Node[] = [];
      d.child(d.childCount - 1).forEach((c) => c.type.name !== 'region' && out.push(c));
      return out;
    };
    const original = await sha256Hex(baselineText(scope(base)));
    const cases = fc.sample(
      fc.record({
        kind: fc.nat(4),
        at: fc.nat(length),
        len: fc.integer({ min: 1, max: 6 }),
        user: fc.constantFrom('carol', 'dave', 'erin'),
        change: fc.boolean(),
      }),
      { numRuns: 300, seed: 13 },
    );
    let equal = 0;
    let different = 0;
    for (const c of cases) {
      const from = intro + Math.min(c.at, length - 1);
      const to = Math.min(intro + length, from + c.len);
      const id = `s${c.user.padEnd(14, '0')}${c.kind}`;
      const tr = new Transform(base);
      if (c.kind === 0) tr.insert(from, text('zz', [ins(id, c.user)]));
      else if (c.kind === 1) tr.addMark(from, to, del(id, c.user));
      else if (c.kind === 2) {
        tr.addMark(from, to, schema.marks['bold']!.create());
        tr.addMark(from, to, fmt(id, c.user, { marks: [] }));
      } else if (c.kind === 3) tr.addNodeMark(posOf(base, 'pIntro0000000001'), del(id, c.user));
      else tr.addNodeMark(posOf(base, 'trRow00000000001'), del(id, c.user));
      if (c.change) tr.insert(intro, text('Q'));
      const hash = await sha256Hex(baselineText(scope(tr.doc)));
      if (c.change) {
        expect(hash).not.toBe(original);
        different++;
      } else {
        expect(hash).toBe(original);
        equal++;
      }
    }
    expect(equal).toBeGreaterThan(50);
    expect(different).toBeGreaterThan(50);
  });

  it('examines only the blocks that changed (instrumented)', () => {
    const grow = (extra: number) => {
      const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
      const terms = json.content[1]!.content.find(
        (b) => (b['attrs'] as J | undefined)?.['id'] === 'rTerms000000000A',
      )!;
      for (let i = 0; i < extra; i++)
        (terms['content'] as J[]).push({
          type: 'paragraph',
          attrs: { id: `pExtra${String(i).padStart(10, '0')}` },
          content: [{ type: 'text', text: `Extra paragraph ${i}.` }],
        });
      return schema.nodeFromJSON(json);
    };
    const visits = (doc: Node) => {
      const after = applySteps(doc, [
        typed(doc, 'pTerms000000001A', 'x', [ins('sDave00000000001', 'dave')]),
      ]);
      if (!after.ok) throw new Error(after.reason);
      const count: Counter = { visited: 0 };
      const same = sameBaseline(
        scopeOf(doc, 'rTerms000000000A'),
        scopeOf(after.value.doc, 'rTerms000000000A'),
        count,
      );
      expect(same).toBe(true);
      return count.visited;
    };
    expect(visits(grow(400))).toBe(visits(grow(0)));
    expect(visits(grow(0))).toBeLessThan(12);
  });
});

describe('P4: suggesters propose without altering the baseline (PRM-014)', () => {
  it('accepts ins, del and fmt marks that name the suggester and use their own identifiers', () => {
    const doc = tableDoc();
    expect(
      check(USERS.dave, doc, [
        typed(doc, 'pIntro0000000001', 'new ', [ins('sDave00000000001', 'dave')]),
      ]).ok,
    ).toBe(true);
    const start = posInside(doc, 'pIntro0000000001');
    expect(
      check(USERS.dave, doc, [new AddMarkStep(start, start + 4, del('sDave00000000002', 'dave'))])
        .ok,
    ).toBe(true);
    expect(
      check(USERS.dave, doc, [
        new AddMarkStep(start, start + 4, schema.marks['bold']!.create()),
        new AddMarkStep(start, start + 4, fmt('sDave00000000003', 'dave', { marks: [] })),
      ]).ok,
    ).toBe(true);
  });

  it('refuses a change of the baseline: text, deletion, formatting, an attribute or a bookmark', () => {
    const doc = tableDoc();
    const start = posInside(doc, 'pIntro0000000001');
    const intro = posOf(doc, 'pIntro0000000001');
    const bookmark = schema.nodes['anchor']!.create({ id: 'aBookmark0000001', name: 'here' });
    for (const steps of [
      [typed(doc, 'pIntro0000000001', 'plain ')],
      [new ReplaceStep(start, start + 4, Slice.empty)],
      [new AddMarkStep(start, start + 4, schema.marks['bold']!.create())],
      [new AttrStep(intro, 'align', 'center')],
      [new ReplaceStep(start, start, new Slice(Fragment.from(bookmark), 0, 0))],
    ]) {
      const v = check(USERS.dave, doc, steps);
      expect(v).toMatchObject({ ok: false, code: 'permission_denied', scopes: ['body'] });
    }
  });

  it("refuses changing or removing another user's suggestion", () => {
    const base = tableDoc();
    const withCarol = applySteps(base, [
      typed(base, 'pIntro0000000001', 'carol ', [ins('sCarol0000000001', 'carol')]),
    ]);
    if (!withCarol.ok) throw new Error(withCarol.reason);
    const doc = withCarol.value.doc;
    const owners = new Map([['sCarol0000000001', 'carol']]);
    const start = posInside(doc, 'pIntro0000000001');
    for (const steps of [
      [new RemoveMarkStep(start, start + 6, ins('sCarol0000000001', 'carol'))],
      [new ReplaceStep(start, start + 6, Slice.empty)],
      [
        new ReplaceStep(
          start + 2,
          start + 2,
          new Slice(Fragment.from(text('q', [ins('sCarol0000000001', 'carol')])), 0, 0),
        ),
      ],
    ])
      expect(check(USERS.dave, doc, steps, { owners }).ok).toBe(false);
    // Suggesting to delete it is a suggestion of one's own.
    expect(
      check(USERS.dave, doc, [new AddMarkStep(start, start + 6, del('sDave00000000001', 'dave'))], {
        owners,
      }).ok,
    ).toBe(true);
  });

  it('refuses a mark that names someone else, and an identifier first used by another user', () => {
    const doc = tableDoc();
    const forged = check(USERS.dave, doc, [
      typed(doc, 'pIntro0000000001', 'x', [ins('sForged000000001', 'carol')]),
    ]);
    expect(forged).toMatchObject({ ok: false, code: 'permission_denied' });
    const taken = check(
      USERS.dave,
      doc,
      [typed(doc, 'pIntro0000000001', 'x', [ins('sCarol0000000001', 'dave')])],
      {
        owners: new Map([['sCarol0000000001', 'carol']]),
      },
    );
    expect(taken).toMatchObject({ ok: false, code: 'permission_denied' });
    if (!taken.ok) expect(taken.reason).toMatch(/belongs to another user/);
  });

  it('refuses accepting one’s own suggestion and accepts deleting text one suggested oneself', () => {
    const base = tableDoc();
    const mine = applySteps(base, [
      typed(base, 'pIntro0000000001', 'mine ', [ins('sDave00000000001', 'dave')]),
    ]);
    if (!mine.ok) throw new Error(mine.reason);
    const doc = mine.value.doc;
    const owners = new Map([['sDave00000000001', 'dave']]);
    const start = posInside(doc, 'pIntro0000000001');
    expect(
      check(
        USERS.dave,
        doc,
        [new RemoveMarkStep(start, start + 5, ins('sDave00000000001', 'dave'))],
        { owners },
      ),
    ).toMatchObject({ ok: false, scopes: ['body'] });
    expect(
      check(USERS.dave, doc, [new ReplaceStep(start, start + 5, Slice.empty)], { owners }).ok,
    ).toBe(true);
  });

  it('refuses a suggested deletion of a whole restricted region without suggest there, and accepts it with suggest', () => {
    const doc = tableDoc();
    const legal = doc.nodeAt(posOf(doc, 'rLegal000000000B'))!;
    const from = posOf(doc, 'rLegal000000000B') + 1;
    const marks = (user: string, id: string): Step[] => {
      const steps: Step[] = [];
      legal.forEach((p, o) => steps.push(new AddNodeMarkStep(from + o, del(id, user))));
      return steps;
    };
    // Carol is an editor without a grant: the restricted region gives her view and comment only.
    expect(check(USERS.carol, doc, marks('carol', 'sCarol0000000001'))).toMatchObject({
      ok: false,
      scopes: ['region:rLegal000000000B'],
    });
    // Dave holds a suggester grant on it.
    expect(check(USERS.dave, doc, marks('dave', 'sDave00000000001')).ok).toBe(true);
  });
});

describe('the identity of suggestion marks in every commit (03 §5; PRM-060)', () => {
  it('refuses an editor who attributes a new suggestion to someone else', () => {
    const doc = tableDoc();
    const v = check(USERS.carol, doc, [
      typed(doc, 'pIntro0000000001', 'x', [ins('sForged000000001', 'dave')]),
    ]);
    expect(v).toMatchObject({ ok: false, code: 'permission_denied', scopes: ['body'] });
    if (!v.ok) expect(v.reason).toMatch(/name the submitting user/);
    // In the editor's own name it is accepted, and the identifier is claimed for her.
    const mine = check(USERS.carol, doc, [
      typed(doc, 'pIntro0000000001', 'x', [ins('sCarol0000000001', 'carol')]),
    ]);
    expect(mine).toMatchObject({ ok: true, claimedSuggestionIds: ['sCarol0000000001'] });
  });

  it('refuses reusing the identifier of a settled suggestion of someone else, even for an editor', () => {
    const doc = tableDoc();
    const v = check(
      USERS.carol,
      doc,
      [typed(doc, 'pIntro0000000001', 'x', [ins('sDave00000000009', 'carol')])],
      {
        owners: new Map([['sDave00000000009', 'dave']]),
      },
    );
    expect(v).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('lets an editor copy or keep an existing suggestion', () => {
    const base = tableDoc();
    const withDave = applySteps(base, [
      typed(base, 'pIntro0000000001', 'dave ', [ins('sDave00000000001', 'dave')]),
    ]);
    if (!withDave.ok) throw new Error(withDave.reason);
    const doc = withDave.value.doc;
    const owners = new Map([['sDave00000000001', 'dave']]);
    const copy = typed(doc, 'pMiddle000000001', 'dave ', [ins('sDave00000000001', 'dave')]);
    expect(check(USERS.carol, doc, [copy], { owners }).ok).toBe(true);
  });

  it('reads the identifiers of the content a room starts from, so that none can be taken over', () => {
    const base = tableDoc();
    const seeded = applySteps(base, [
      typed(base, 'pIntro0000000001', 'old ', [ins('sOld000000000001', 'carol')]),
    ]);
    if (!seeded.ok) throw new Error(seeded.reason);
    // Carol's suggestion is accepted (its mark removed) in the content the room is given.
    const start = posInside(seeded.value.doc, 'pIntro0000000001');
    const accepted = applySteps(seeded.value.doc, [
      new RemoveMarkStep(start, start + 4, ins('sOld000000000001', 'carol')),
    ]);
    if (!accepted.ok) throw new Error(accepted.reason);
    const room = roomWith(seeded.value.doc);
    room.open('d1', USERS.dave);
    const doc = room.document;
    const fx = room.submit('d1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([typed(doc, 'pIntro0000000001', 'x', [ins('sOld000000000001', 'dave')])]),
    });
    // The model's I2 refuses one identifier with two users in one document (03 §5).
    expect(rejection(fx, 'd1')?.code).toMatch(/invalid_op|permission_denied/);
    // A room given content where the identifier no longer appears learns it from the host.
    const fresh = new Room({
      schema,
      initial: accepted.value.doc,
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now: () => 1_770_000_000_000,
      suggestionOwners: [['sOld000000000001', 'carol']],
    });
    fresh.open('d1', USERS.dave);
    const r = fresh.submit('d1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([
        typed(accepted.value.doc, 'pIntro0000000001', 'x', [ins('sOld000000000001', 'dave')]),
      ]),
    });
    expect(rejection(r, 'd1')).toMatchObject({ code: 'permission_denied' });
  });
});

describe('import labels in suggestion marks (spike S11 change 6; SR-M14)', () => {
  const label = 'word:Ann Author';
  it('recognises a label and never takes it for a user', () => {
    expect(isImportLabel(label)).toBe(true);
    expect(isImportLabel('word:')).toBe(false);
    expect(isImportLabel('dave')).toBe(false);
  });

  it('accepts labelled suggestions in a server-authored commit with origin import, and nowhere else', () => {
    const doc = tableDoc();
    const step = typed(doc, 'pIntro0000000001', 'imported ', [ins('sImport000000001', label)]);
    expect(check(USERS.alice, doc, [step], { origin: 'import', server: true }).ok).toBe(true);
    // A client commit, or a server commit of another origin, may not name a label.
    expect(check(USERS.alice, doc, [step]).ok).toBe(false);
    expect(check(USERS.alice, doc, [step], { origin: 'restore', server: true }).ok).toBe(false);
  });

  it('lets an import add only suggestions while trackChanges is everyone (P4 with the exception)', () => {
    const json = tableJson() as { content: Array<{ content: J[] }> };
    (json.content[0]!.content[0]!['attrs'] as J)['trackChanges'] = 'everyone';
    const doc = schema.nodeFromJSON(json);
    const step = typed(doc, 'pIntro0000000001', 'imported ', [ins('sImport000000001', label)]);
    const room = roomWith(doc, basePermissions());
    const fx = room.author('control', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([step]),
      origin: 'import',
      as: 'system',
    });
    expect(messages(fx, 'control').find((m) => m.t === 'sync.reject')).toBeUndefined();
    expect(fx.write?.commits[0]).toMatchObject({ claimed: ['sImport000000001'], origin: 'import' });
    room.writeCompleted({ status: 'ok' });
    // The identifier now belongs to the label: no user may claim it, and a suggester may not
    // remove the labelled suggestion; plain text typed by an import is still refused under P4.
    room.open('d1', USERS.dave);
    const start = posInside(room.document, 'pIntro0000000001');
    const take = room.submit('d1', {
      id: commitId(),
      base: 1,
      steps: stepsToJson([new RemoveMarkStep(start, start + 9, ins('sImport000000001', label))]),
    });
    expect(rejection(take, 'd1')).toMatchObject({ code: 'permission_denied' });
    const plain = room.author('control', {
      id: commitId(),
      base: 1,
      steps: stepsToJson([typed(room.document, 'pIntro0000000001', 'plain ')]),
      origin: 'import',
      as: 'system',
    });
    expect(messages(plain, 'control').find((m) => m.t === 'sync.reject')).toMatchObject({
      code: 'permission_denied',
    });
  });

  it('stores an import snapshot whose suggestions name labels, and the labels own their identifiers', () => {
    const base = tableDoc();
    const imported = applySteps(base, [
      typed(base, 'pIntro0000000001', 'imported ', [ins('sImport000000002', label)]),
    ]);
    if (!imported.ok) throw new Error(imported.reason);
    const room = roomWith(base, basePermissions());
    const fx = room.snapshot('control', {
      id: commitId(),
      reason: 'import',
      content: imported.value.doc,
      checkpoint: 'ckpt-1',
      as: 'system',
    });
    expect(fx.write?.snapshot).toMatchObject({ claimed: ['sImport000000002'] });
    room.writeCompleted({ status: 'ok' });
    room.open('c1', USERS.carol);
    const reuse = room.submit('c1', {
      id: commitId(),
      base: 1,
      steps: stepsToJson([
        typed(room.document, 'pMiddle000000001', 'x', [ins('sImport000000002', 'carol')]),
      ]),
    });
    expect(rejection(reuse, 'c1')?.code).toMatch(/permission_denied|invalid_op/);
  });
});

describe('suggestions from everyone when the document says so (PRM-015)', () => {
  const everyoneDoc = () => {
    const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
    (json.content[0]!.content[0]!['attrs'] as J)['trackChanges'] = 'everyone';
    return schema.nodeFromJSON(json);
  };

  it('refuses an editor’s direct change and accepts the same change as a suggestion', () => {
    const doc = everyoneDoc();
    const room = roomWith(doc, basePermissions());
    room.open('c1', USERS.carol);
    const direct = room.submit('c1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([typed(doc, 'pIntro0000000001', 'x')]),
    });
    expect(rejection(direct, 'c1')).toMatchObject({ code: 'permission_denied', scopes: ['body'] });
    const suggested = room.submit('c1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([typed(doc, 'pIntro0000000001', 'x', [ins('sCarol0000000001', 'carol')])]),
    });
    expect(rejection(suggested, 'c1')).toBeNull();
    expect(suggested.write?.commits).toHaveLength(1);
  });

  it('lets a holder of manage switch it off, after which direct changes are accepted; nobody else may', () => {
    const doc = everyoneDoc();
    const room = roomWith(doc, basePermissions());
    room.open('a1', USERS.alice);
    room.open('c1', USERS.carol);
    const off = (channel: string, base: number) =>
      room.submit(channel, {
        id: commitId(),
        base,
        steps: stepsToJson([new AttrStep(1, 'trackChanges', 'off')]),
      });
    expect(rejection(off('c1', 0), 'c1')).toMatchObject({
      code: 'permission_denied',
      scopes: ['defs:settings'],
    });
    const fx = off('a1', 0);
    expect(rejection(fx, 'a1')).toBeNull();
    room.writeCompleted({ status: 'ok' });
    const direct = room.submit('c1', {
      id: commitId(),
      base: 1,
      steps: stepsToJson([typed(room.document, 'pIntro0000000001', 'x')]),
    });
    expect(rejection(direct, 'c1')).toBeNull();
  });
});

describe('P4 for block suggestions (PRM-062)', () => {
  it('accepts block suggestions on paragraphs, rows and tables and agrees with the oracle (property)', () => {
    const doc = tableDoc();
    const targets = [
      'pIntro0000000001',
      'pMiddle000000001',
      'trRow00000000001',
      'trRow00000000002',
      'tTable0000000001',
      'cA00000000000001',
      'rTerms000000000A',
    ];
    const accepted = new Map<string, number>();
    const perms = basePermissions();
    let refused = 0;
    fc.assert(
      fc.property(
        fc.record({
          target: fc.nat(targets.length - 1),
          kind: fc.nat(5),
          user: fc.constantFrom('dave', 'carol', 'erin'),
          named: fc.boolean(),
        }),
        (e) => {
          const id = targets[e.target]!;
          const pos = posOf(doc, id);
          const who = e.named ? e.user : 'mallory';
          const sid = `s${e.user.padEnd(14, '0')}${e.kind}`;
          const steps: Step[] = [];
          if (e.kind === 0) steps.push(new AddNodeMarkStep(pos, del(sid, who)));
          else if (e.kind === 1) steps.push(new AddNodeMarkStep(pos, ins(sid, who)));
          else if (e.kind === 2) {
            steps.push(new AttrStep(pos, 'style', 'Heading1'));
            steps.push(new AddNodeMarkStep(pos, fmt(sid, who, { attrs: { style: null } })));
          } else if (e.kind === 3) steps.push(new RemoveNodeMarkStep(pos, del(sid, who)));
          else steps.push(new AddNodeMarkStep(pos, schema.marks['bold']!.create()));
          const user = Object.values(USERS).find((u) => u.sub === e.user)!;
          const r = applySteps(doc, steps);
          if (!r.ok) return;
          const v = verdictBetween(user, doc, r.value.doc, { perms });
          const node = doc.nodeAt(pos)!;
          if (v.ok) {
            accepted.set(node.type.name, (accepted.get(node.type.name) ?? 0) + 1);
            // Whatever the outcome check accepts, the independent oracle finds nothing wrong with.
            expect(
              oracleViolations({
                user,
                perms,
                time: 0,
                before: doc,
                after: r.value.doc,
                owners: new Map(),
              }),
            ).toEqual([]);
          } else refused++;
        },
      ),
      { numRuns: 1500, seed: 62 },
    );
    expect(accepted.get('paragraph') ?? 0).toBeGreaterThan(0);
    expect(accepted.get('table_row') ?? 0).toBeGreaterThan(0);
    expect(accepted.get('table') ?? 0).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(100);
  });

  it('refuses block suggestions the model does not allow: on a cell or a region', () => {
    const doc = tableDoc();
    const room = roomWith(doc, basePermissions());
    room.open('d1', USERS.dave);
    for (const id of ['cA00000000000001', 'rTerms000000000A']) {
      const fx = room.submit('d1', {
        id: commitId(),
        base: 0,
        steps: stepsToJson([new AddNodeMarkStep(posOf(doc, id), del('sDave00000000001', 'dave'))]),
      });
      expect(rejection(fx, 'd1')?.code, id).toBe('invalid_op');
    }
  });
});
