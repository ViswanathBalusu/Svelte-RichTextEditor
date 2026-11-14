// Structure, policy and definitions (07 §2, §5.2 P2 and P3, §5.3, §16; PRM-001, PRM-011, PRM-012,
// PRM-030, PRM-034, PRM-065; ADR 0033): every operation of the `structure` and `manage` lists is
// enforced and cited, regions change only as whole nodes, and shared definitions are protected.
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
  Transform,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/invariants.ts';
import { computeAccess } from '../src/permissions/access.ts';
import { regionBoundaryViolation } from '../src/permissions/boundaries.ts';
import {
  MANAGE_OPERATIONS,
  OPERATIONS,
  type OperationId,
  STRUCTURE_OPERATIONS,
} from '../src/permissions/model.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, baseDoc, posInside, posOf } from './fixtures.ts';
import {
  MORE,
  USERS,
  commitId,
  messages,
  morePermissions,
  refused,
  rejection,
  roomWith,
  schema,
  verdictBetween,
  verdictOf,
} from './permission-fixtures.ts';

type J = Record<string, unknown>;

const apply = (doc: Node, steps: Step[]): Node => {
  const r = applySteps(doc, steps);
  if (!r.ok) throw new Error(r.reason);
  return r.value.doc;
};

/** The base document with a header story and a numbering definition used inside Legal. */
function richDoc(trackChanges: 'off' | 'everyone' = 'off'): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: J[] };
  const defs = json.content[0]!['content'] as J[];
  (defs[0]!['attrs'] as J)['trackChanges'] = trackChanges;
  const pageSetup = defs.findIndex((d) => d['type'] === 'page_setup');
  defs.splice(pageSetup, 0, {
    type: 'numbering_def',
    attrs: {
      id: 'num1',
      levels: [
        {
          format: 'decimal',
          text: '%1.',
          start: 1,
          restartAfter: null,
          legal: false,
          indentLeft: 720,
          hanging: 360,
          align: 'start',
          bulletChar: null,
          runProps: null,
        },
      ],
    },
  });
  const body = json.content[1]!['content'] as J[];
  const legal = body.find((b) => (b['attrs'] as J | undefined)?.['id'] === 'rLegal000000000B')!;
  (legal['content'] as J[]).push({
    type: 'paragraph',
    attrs: {
      id: 'pLegalList00001B',
      numbering: { numberingId: 'num1', level: 0, listId: 'lList00000000001' },
    },
    content: [{ type: 'text', text: 'First item.' }],
  });
  json.content.splice(1, 0, {
    type: 'story',
    attrs: { id: 'sHeader000000001', kind: 'header' },
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'pHeader000000001' },
        content: [{ type: 'text', text: 'Head' }],
      },
    ],
  });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const regionAt = (doc: Node, id: string) => {
  const at = posOf(doc, id);
  return { at, node: doc.nodeAt(at)!, end: at + doc.nodeAt(at)!.nodeSize };
};
const deleteRegion = (id: string) => (doc: Node) => {
  const r = regionAt(doc, id);
  return [new ReplaceStep(r.at, r.end, Slice.empty)];
};
const moveRegionToTop = (id: string) => (doc: Node) => {
  const r = regionAt(doc, id);
  const top = posOf(doc, 'pTitle0000000001');
  return [
    new ReplaceStep(r.at, r.end, Slice.empty),
    new ReplaceStep(top, top, new Slice(Fragment.from(r.node), 0, 0)),
  ];
};
/** Splits a region before one of its paragraphs; the second part gets a fresh identifier. */
const splitRegion = (before: string, fresh: string) => (doc: Node) => {
  const tr = new Transform(doc);
  const pos = posOf(doc, before);
  tr.split(pos, 1);
  tr.setNodeAttribute(pos + 1, 'id', fresh);
  return tr.steps;
};
/** Merges `second` into `first` as whole-node operations: delete `second`, move its blocks. */
const mergeRegions = (first: string, second: string) => (doc: Node) => {
  const a = regionAt(doc, first);
  const b = regionAt(doc, second);
  if (b.at < a.at) throw new Error('second must follow first');
  return [
    new ReplaceStep(b.at, b.end, Slice.empty),
    new ReplaceStep(a.end - 1, a.end - 1, new Slice(b.node.content, 0, 0)),
  ];
};
const wrapInRegion =
  (paragraph: string, id: string, policy = 'inherit') =>
  (doc: Node) => {
    const at = posOf(doc, paragraph);
    const end = at + doc.nodeAt(at)!.nodeSize;
    return [
      new ReplaceAroundStep(
        at,
        end,
        at,
        end,
        new Slice(Fragment.from(schema.nodes['region']!.create({ id, policy, title: null })), 0, 0),
        1,
        true,
      ),
    ];
  };
const setAttr = (id: string, attr: string, value: unknown) => (doc: Node) => [
  new AttrStep(posOf(doc, id), attr, value),
];
const typeIn =
  (paragraph: string, text = 'x') =>
  (doc: Node) => {
    const pos = posInside(doc, paragraph);
    return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
  };

describe('the operations of `structure` and `manage`, listed once (PRM-001, criterion 5)', () => {
  it('lists each operation exactly once, under one capability, covering every item of 07 §2', () => {
    const ids = OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...STRUCTURE_OPERATIONS, ...MANAGE_OPERATIONS].sort()).toEqual([...ids].sort());
    expect(STRUCTURE_OPERATIONS.filter((o) => MANAGE_OPERATIONS.includes(o))).toEqual([]);
    // 07 §2, item by item.
    const structure: Record<string, OperationId> = {
      'creating regions': 'region.create',
      'deleting regions': 'region.delete',
      'splitting regions': 'region.split',
      'merging regions': 'region.merge',
      'moving regions': 'region.move',
      "changing a region's title": 'region.retitle',
      'inserting section breaks': 'section_break.change',
      'changing anything in doc': 'doc.change',
      'changing anything in defs': 'defs.change',
      'changing a header or footer story': 'story.change',
    };
    const manage: Record<string, OperationId> = {
      'region grants': 'grants.change',
      'region states': 'region_state.change',
      "a region's policy": 'region.policy',
      'breaking leases': 'lease.break',
      workflows: 'workflow.action',
      restoring: 'document.restore',
      'deleting the document': 'document.delete',
    };
    for (const op of Object.values(structure)) expect(STRUCTURE_OPERATIONS, op).toContain(op);
    for (const op of Object.values(manage)) expect(MANAGE_OPERATIONS, op).toContain(op);
    // Beyond 07 §2: switching track changes off (07 §5.2) and `sensitive` (ADR 0019).
    expect(MANAGE_OPERATIONS).toContain('settings.track_changes_off');
    expect(MANAGE_OPERATIONS).toContain('field.sensitive');
  });

  it('enforces every commit operation and cites it when refusing', () => {
    const doc = richDoc();
    const everyone = richDoc('everyone');
    const bodyAt = doc.content.size - doc.child(doc.childCount - 1).nodeSize;
    const section = (d: Node) => {
      const end = posOf(d, 'pEnd00000000001Z');
      const sb = schema.nodeFromJSON({
        type: 'section_break',
        attrs: { id: 'sbNew00000000001', pageSetup: 'ps1' },
      });
      return [new ReplaceStep(end, end, new Slice(Fragment.from(sb), 0, 0))];
    };
    const sensitive = setAttr('fTenantName00001', 'sensitive', true);
    // Rita: a viewer with an editor grant on Terms only (no structure). Carol: an editor (no manage).
    const cases: Array<
      [OperationId, typeof MORE.rita | typeof USERS.carol, (d: Node) => Step[], Node]
    > = [
      ['region.create', MORE.rita, wrapInRegion('pIntro0000000001', 'rNew000000000001'), doc],
      ['region.delete', MORE.rita, deleteRegion('rTerms000000000A'), doc],
      ['region.create', MORE.rita, splitRegion('pTerms000000002A', 'rSplit0000000001'), doc],
      ['region.delete', MORE.rita, mergeRegions('rTerms000000000A', 'rNotes000000000C'), doc],
      ['region.move', MORE.rita, moveRegionToTop('rTerms000000000A'), doc],
      ['region.retitle', MORE.rita, setAttr('rTerms000000000A', 'title', 'Renamed'), doc],
      ['section_break.change', MORE.rita, section, doc],
      ['doc.change', MORE.rita, () => [new AttrStep(bodyAt, 'ext', { x: 1 })], doc],
      ['defs.change', MORE.rita, setAttr('Heading1', 'color', '#00AA00'), doc],
      ['story.change', MORE.rita, typeIn('pHeader000000001'), doc],
      ['region.policy', USERS.carol, setAttr('rTerms000000000A', 'policy', 'restricted'), doc],
      [
        'region.policy',
        USERS.carol,
        wrapInRegion('pIntro0000000001', 'rNew000000000002', 'restricted'),
        doc,
      ],
      [
        'settings.track_changes_off',
        USERS.carol,
        setAttr('sHeader000000001', 'kind', 'header'),
        everyone,
      ],
      ['field.sensitive', USERS.carol, sensitive, doc],
    ];
    // Switching track changes off: an attribute step on the settings node (position 1).
    cases[12] = [
      'settings.track_changes_off',
      USERS.carol,
      () => [new AttrStep(1, 'trackChanges', 'off')],
      everyone,
    ];
    const enforced = new Set<string>();
    for (const [op, user, make, base] of cases) {
      const v = verdictOf(user, base, make);
      expect(v.ok, `${op} by ${user.sub}`).toBe(false);
      if (!v.ok) expect(v.reason, op).toContain(`\`${op}\` needs`);
      expect(verdictOf(USERS.alice, base, make).ok, `${op} by the owner`).toBe(true);
      enforced.add(op);
    }
    // Every operation enforced on commits is exercised; the others are the control plane's (07 §12).
    for (const o of OPERATIONS) {
      if (o.where === 'commit' && !['region.split', 'region.merge'].includes(o.id))
        expect(enforced, o.id).toContain(o.id);
    }
  });
});

describe('P2: regions and section breaks (PRM-011)', () => {
  it('lets a user with structure and edit in the body wrap blocks in a new inherit region', () => {
    const doc = baseDoc();
    const v = verdictOf(USERS.carol, doc, wrapInRegion('pIntro0000000001', 'rNew000000000001'));
    expect(v.ok).toBe(true);
    const after = apply(doc, wrapInRegion('pIntro0000000001', 'rNew000000000001')(doc));
    expect(after.nodeAt(posOf(after, 'rNew000000000001'))!.attrs['policy']).toBe('inherit');
    expect(
      verdictOf(USERS.dave, doc, wrapInRegion('pIntro0000000001', 'rNew000000000001')).ok,
    ).toBe(false);
  });

  it("refuses deleting or moving a restricted region to an editor without a grant, and accepts an owner's", () => {
    const doc = baseDoc();
    for (const make of [deleteRegion('rLegal000000000B'), moveRegionToTop('rLegal000000000B')]) {
      expect(refused(verdictOf(USERS.carol, doc, make))).toContain('region:rLegal000000000B');
      expect(verdictOf(USERS.alice, doc, make).ok).toBe(true);
      expect(verdictOf(USERS.bob, doc, make).ok, 'Bob holds an editor grant on Legal').toBe(true);
    }
  });

  it('needs structure and edit in the region to retitle it', () => {
    const doc = baseDoc();
    const retitle = setAttr('rLegal000000000B', 'title', 'Liability');
    expect(refused(verdictOf(USERS.carol, doc, retitle))).toContain('region:rLegal000000000B');
    expect(verdictOf(USERS.bob, doc, retitle).ok).toBe(true);
    expect(refused(verdictOf(MORE.rita, doc, setAttr('rTerms000000000A', 'title', 'T')))).toContain(
      'body',
    );
  });

  it('needs structure and edit in the body and every region affected for section breaks', () => {
    const doc = baseDoc();
    const end = posOf(doc, 'pEnd00000000001Z');
    const sb = schema.nodeFromJSON({
      type: 'section_break',
      attrs: { id: 'sbNew00000000001', pageSetup: 'ps1' },
    });
    const add = () => [new ReplaceStep(end, end, new Slice(Fragment.from(sb), 0, 0))];
    expect(verdictOf(USERS.carol, doc, add).ok).toBe(true);
    expect(verdictOf(USERS.dave, doc, add).ok).toBe(false);
    const withBreak = apply(doc, add());
    const at = posOf(withBreak, 'sbNew00000000001');
    const remove = () => [new ReplaceStep(at, at + 1, Slice.empty)];
    expect(verdictOf(USERS.carol, withBreak, remove).ok).toBe(true);
    expect(verdictOf(MORE.rita, withBreak, remove).ok).toBe(false);
    // Moving it next to the restricted region and into place between regions needs edit in the
    // body only: a section break is a body block. Moving it into a region is impossible: a region
    // holds blocks, and section breaks are children of the body only.
    const top = posOf(withBreak, 'pTitle0000000001');
    const move = () => [
      new ReplaceStep(at, at + 1, Slice.empty),
      new ReplaceStep(top, top, new Slice(Fragment.from(sb), 0, 0)),
    ];
    expect(verdictOf(USERS.carol, withBreak, move).ok).toBe(true);
    expect(verdictOf(USERS.dave, withBreak, move).ok).toBe(false);
  });

  it('needs manage to flip a policy between inherit and restricted', () => {
    const doc = baseDoc();
    for (const [id, policy] of [
      ['rTerms000000000A', 'restricted'],
      ['rLegal000000000B', 'inherit'],
    ] as const) {
      expect(refused(verdictOf(USERS.bob, doc, setAttr(id, 'policy', policy)))).toContain(
        `region:${id}`,
      );
      expect(verdictOf(USERS.alice, doc, setAttr(id, 'policy', policy)).ok).toBe(true);
    }
  });
});

describe('P3: regions change only as whole nodes (PRM-011, criterion 6)', () => {
  /** Positions in the body of every region of `doc`. */
  const spans = (doc: Node) => {
    const body = doc.child(doc.childCount - 1);
    const out: Array<{ id: string; start: number; end: number }> = [];
    let pos = doc.content.size - body.nodeSize + 1;
    body.forEach((c) => {
      if (c.type.name === 'region')
        out.push({ id: String(c.attrs['id']), start: pos, end: pos + c.nodeSize });
      pos += c.nodeSize;
    });
    return { out, bodyStart: doc.content.size - body.nodeSize + 1, bodyEnd: doc.content.size - 1 };
  };

  it('refuses crafted replace and replaceAround steps that remove exactly one boundary (property test)', () => {
    const doc = baseDoc();
    const { out, bodyStart, bodyEnd } = spans(doc);
    let applied = 0;
    fc.assert(
      fc.property(
        fc.record({
          region: fc.nat(out.length - 1),
          open: fc.boolean(),
          a: fc.nat(400),
          b: fc.nat(400),
          around: fc.boolean(),
          slice: fc.nat(3),
          c: fc.nat(400),
          d: fc.nat(400),
        }),
        (e) => {
          const r = out[e.region]!;
          // The removed range covers exactly one of the region's tokens.
          let from: number;
          let to: number;
          if (e.open) {
            from = r.start - (e.a % (r.start - bodyStart + 1));
            to = r.start + 1 + (e.b % (r.end - 1 - (r.start + 1) + 1));
          } else {
            from = r.start + 1 + (e.a % (r.end - 1 - (r.start + 1) + 1));
            to = r.end + (e.b % (bodyEnd - r.end + 1));
          }
          const slices = [
            doc.slice(from, to), // the same content again: removes and re-inserts the token
            Slice.empty,
            doc.slice(
              (Math.min(e.c, e.d) % (bodyEnd - 1)) + 1,
              (Math.max(e.c, e.d) % (bodyEnd - 1)) + 1,
            ),
            new Slice(Fragment.from(schema.text('x')), 0, 0),
          ];
          const slice = slices[e.slice % slices.length]!;
          let step: Step;
          if (!e.around) step = new ReplaceStep(from, to, slice);
          else if (e.open) {
            // Keep the closing token inside the gap, remove the opening one.
            const gapFrom = r.start + 1 + (e.c % (r.end - 1 - (r.start + 1) + 1));
            const gapTo = Math.max(gapFrom, r.end);
            step = new ReplaceAroundStep(
              from,
              Math.max(to, gapTo),
              gapFrom,
              gapTo,
              slice,
              slice.openStart,
              true,
            );
          } else {
            const gapTo = r.end - 1 - (e.c % (r.end - 1 - (r.start + 1) + 1));
            const gapFrom = Math.min(gapTo, r.start + 1);
            step = new ReplaceAroundStep(
              Math.min(from, gapFrom),
              to,
              gapFrom,
              gapTo,
              slice,
              slice.openStart,
              true,
            );
          }
          const result = applySteps(doc, [step]);
          if (!result.ok) return; // ProseMirror refused it: nothing to check
          applied++;
          const removedOne = regionBoundaryViolation([step], [doc]);
          expect(removedOne, JSON.stringify(step.toJSON())).not.toBeNull();
          const inv = checkInvariants(doc, result.value.doc, [step], result.value.docs, {
            requires: REQUIRES,
            retiredRegionIds: new Set(),
          });
          expect(inv.ok).toBe(false);
          if (!inv.ok) {
            expect(inv.code).toBe('invalid_op');
            expect(inv.reason).toMatch(/\(P3\)/);
          }
        },
      ),
      { numRuns: 1200 },
    );
    expect(applied).toBeGreaterThan(120);
  });

  it('accepts whole-node operations: delete, unwrap, wrap, insert, move, split and merge', () => {
    const doc = baseDoc();
    const terms = regionAt(doc, 'rTerms000000000A');
    const ops: Array<[string, Step[]]> = [
      ['delete', deleteRegion('rNotes000000000C')(doc)],
      [
        'unwrap',
        [
          new ReplaceAroundStep(
            terms.at,
            terms.end,
            terms.at + 1,
            terms.end - 1,
            Slice.empty,
            0,
            true,
          ),
        ],
      ],
      ['wrap', wrapInRegion('pIntro0000000001', 'rNew000000000001')(doc)],
      ['move', moveRegionToTop('rNotes000000000C')(doc)],
      ['split', splitRegion('pTerms000000002A', 'rSplit0000000001')(doc)],
      ['merge', mergeRegions('rTerms000000000A', 'rNotes000000000C')(doc)],
    ];
    for (const [name, steps] of ops) {
      const r = applySteps(doc, steps);
      if (!r.ok) throw new Error(`${name}: ${r.reason}`);
      expect(regionBoundaryViolation(steps, r.value.docs), name).toBeNull();
      const inv = checkInvariants(doc, r.value.doc, steps, r.value.docs, {
        requires: REQUIRES,
        retiredRegionIds: new Set(),
      });
      expect(inv.ok, `${name}: ${inv.ok ? '' : inv.reason}`).toBe(true);
    }
  });

  it('refuses a join of two adjacent regions in the room, and stores nothing', () => {
    // Remove the paragraph between Terms and Legal, so that the two regions touch.
    const base = baseDoc();
    const mid = posOf(base, 'pMiddle000000001');
    const doc = apply(base, [new ReplaceStep(mid, mid + base.nodeAt(mid)!.nodeSize, Slice.empty)]);
    const room = roomWith(doc);
    room.open('a1', USERS.alice);
    const legal = posOf(doc, 'rLegal000000000B');
    const join = new Transform(doc).join(legal).steps;
    const fx = room.submit('a1', { id: commitId(), base: 0, steps: stepsToJson(join) });
    expect(rejection(fx, 'a1')).toMatchObject({ code: 'invalid_op', action: 'drop' });
    expect(rejection(fx, 'a1')?.reason).toMatch(/region rTerms000000000A .*\(P3\)/);
    expect(fx.write).toBeNull();
    // The same content as whole-node operations is accepted.
    const merged = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(mergeRegions('rTerms000000000A', 'rLegal000000000B')(doc)),
    });
    expect(merged.write?.commits).toHaveLength(1);
    expect(merged.write?.commits[0]?.retired).toEqual(['rLegal000000000B']);
    expect(messages(merged, 'a1')).toEqual([]);
  });
});

describe('splits and merges (PRM-011 criterion 7; PRM-034; PRM-065 as proposed in ADR 0033)', () => {
  it('treats a split as a new region beside the one that keeps its identifier', () => {
    const doc = baseDoc();
    const split = splitRegion('pTerms000000002A', 'rSplit0000000001');
    // Carol holds structure and edit in Terms and the body.
    expect(verdictOf(USERS.carol, doc, split)).toMatchObject({ ok: true });
    // Rita can edit Terms but holds no structure; Dave can only suggest.
    expect(verdictOf(MORE.rita, doc, split).ok).toBe(false);
    expect(verdictOf(USERS.dave, doc, split).ok).toBe(false);
    // The part that keeps the identifier keeps the grants: Rita's grant follows rTerms only.
    const after = apply(doc, split(doc));
    const access = computeAccess(MORE.rita, regionInfos(after), morePermissions(), 0);
    expect(access.regions.get('rTerms000000000A')?.has('edit')).toBe(true);
    expect(access.regions.get('rSplit0000000001')?.has('edit')).toBe(false);
  });

  it('needs manage to split a restricted region, because the new part is a restricted region', () => {
    // In richDoc the restricted region Legal holds two paragraphs.
    const doc = richDoc();
    const split = splitRegion('pLegalList00001B', 'rLegalTail00001B');
    const after = apply(doc, split(doc));
    expect(after.nodeAt(posOf(after, 'rLegalTail00001B'))!.attrs['policy']).toBe('restricted');
    const bob = verdictBetween(USERS.bob, doc, after);
    expect(bob.ok).toBe(false);
    if (!bob.ok) expect(bob.reason).toMatch(/`region.policy` needs `manage`/);
    expect(verdictBetween(USERS.alice, doc, after).ok).toBe(true);
    // Given policy inherit instead, the new part needs no `manage`: its blocks leave the
    // protection, which Bob, who may edit them, could also do by moving them out.
    const loose = apply(doc, [
      ...split(doc),
      new AttrStep(posOf(after, 'rLegalTail00001B'), 'policy', 'inherit'),
    ]);
    expect(verdictBetween(USERS.bob, doc, loose).ok).toBe(true);
    expect(verdictBetween(USERS.carol, doc, loose).ok).toBe(false);
  });

  it('treats a merge as deleting one region and moving its blocks into the other', () => {
    const doc = baseDoc();
    const merge = mergeRegions('rTerms000000000A', 'rNotes000000000C');
    expect(verdictOf(USERS.carol, doc, merge).ok).toBe(true);
    expect(refused(verdictOf(MORE.rita, doc, merge))).toEqual(
      expect.arrayContaining(['body', 'region:rNotes000000000C']),
    );
    // Into the restricted region: Bob holds edit in Legal; Carol does not.
    const intoLegal = mergeRegions('rLegal000000000B', 'rNotes000000000C');
    expect(verdictOf(USERS.bob, doc, intoLegal).ok).toBe(true);
    expect(refused(verdictOf(USERS.carol, doc, intoLegal))).toContain('region:rLegal000000000B');
  });

  it('moves a region with structure and edit in the body and the region (PRM-034, criterion 3)', () => {
    const doc = baseDoc();
    expect(verdictOf(USERS.carol, doc, moveRegionToTop('rNotes000000000C')).ok).toBe(true);
    expect(verdictOf(MORE.rita, doc, moveRegionToTop('rTerms000000000A')).ok).toBe(false);
    expect(verdictOf(USERS.carol, doc, moveRegionToTop('rLegal000000000B')).ok).toBe(false);
  });
});

describe('definitions that affect protected regions (07 §5.3; PRM-012)', () => {
  it('names the definition and the region when a user without edit there changes it', () => {
    const doc = richDoc();
    expect(refused(verdictOf(USERS.carol, doc, setAttr('LegalBody', 'color', '#FF0000')))).toEqual([
      'defs:style_def/LegalBody',
      'region:rLegal000000000B',
    ]);
  });

  it('follows the basedOn chain, numbering definitions and page setups', () => {
    const doc = richDoc();
    for (const [scope, make] of [
      ['defs:style_def/Normal', setAttr('Normal', 'fontSize', 400)],
      ['defs:numbering_def/num1', setAttr('num1', 'name', 'Clauses')],
      ['defs:page_setup/ps1', setAttr('ps1', 'orientation', 'landscape')],
    ] as const) {
      const v = refused(verdictOf(USERS.carol, doc, make));
      expect(v, scope).toEqual(expect.arrayContaining([scope, 'region:rLegal000000000B']));
      expect(verdictOf(USERS.bob, doc, make).ok, `${scope} by Bob, who may edit Legal`).toBe(true);
      expect(verdictOf(USERS.alice, doc, make).ok, `${scope} by the owner`).toBe(true);
    }
  });

  it('lets structure alone change a definition no region uses', () => {
    const doc = richDoc();
    expect(verdictOf(USERS.carol, doc, setAttr('Heading1', 'color', '#00AA00')).ok).toBe(true);
  });

  it("includes a style applied inside a region in the next commit's check", () => {
    const room = roomWith(richDoc());
    room.open('b1', USERS.bob);
    room.open('c1', USERS.carol);
    const doc = room.document;
    // Bob, who may edit Legal, gives one of its paragraphs the style Heading1.
    room.submit('b1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(setAttr('pLegal000000001B', 'style', 'Heading1')(doc)),
    });
    room.writeCompleted({ status: 'ok' });
    // Carol's change to Heading1, made on the old base, is checked against the new use.
    const fx = room.submit('c1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(setAttr('Heading1', 'color', '#00AA00')(doc)),
    });
    expect(rejection(fx, 'c1')).toMatchObject({
      code: 'permission_denied',
      scopes: ['defs:style_def/Heading1', 'region:rLegal000000000B'],
    });
  });
});

describe('region-only editors stay out of definitions (PRM-030)', () => {
  it('lets them apply existing styles in their region, and refuses definitions, headers and footers', () => {
    const doc = richDoc();
    expect(verdictOf(MORE.rita, doc, setAttr('pTerms000000001A', 'style', 'Heading1')).ok).toBe(
      true,
    );
    for (const [name, make] of [
      ['a style', setAttr('Heading1', 'color', '#00AA00')],
      ['a numbering definition', setAttr('num1', 'name', 'x')],
      ['a page setup', setAttr('ps1', 'orientation', 'landscape')],
      ['a header', typeIn('pHeader000000001')],
    ] as const) {
      expect(verdictOf(MORE.rita, doc, make), name).toMatchObject({
        ok: false,
        code: 'permission_denied',
      });
    }
  });
});
