/**
 * SEC-027 criterion 2 — for each invariant (I1 to I15; 03 §8, 12 §3.6) and each allowed step type
 * that can break it (04 §4), a commit that does so is refused with `invalid_op` and the document is
 * unchanged.
 *
 * The cases are the single-step-type failing fixtures of CDM-014
 * (`packages/model/fixtures/invariants/cases`) plus the commits built in `extraCases()` for the
 * cells of the matrix the corpus does not hold. Each case is one commit to a Room (the authority the
 * service hosts) whose initial content is the case's base document and whose context (retired
 * regions, attached assets, math gate) is the corpus's. The test checks that the Room answers
 * `sync.reject` `invalid_op`, that the reason names the invariant of the cell (so step 6 refused it
 * and not an earlier check), that nothing is returned for storage, and that the document is the same.
 * Two `replaceAround` cases are refused one step earlier, by the content rules of the ProseMirror
 * schema when the step is applied (a region inside a footnote or a region is not valid content).
 * They are marked `bySchema` and must be refused as invalid content; that is I1 and I3 by structure.
 *
 * Which step types can break an invariant is a judgement this suite writes down in `CAN` and the
 * story's Notes record as proposed. The reasons for the cells left out:
 *
 * - `removeMark` and `removeNodeMark` break nothing alone. No invariant requires a mark to be
 *   present, so removing one from a valid document leaves it valid. The last test supports this on
 *   the corpus bases: every removal of every mark in them is accepted. (The corpus's two
 *   "then remove" fixtures are commits another step breaks; they are replayed by CDM-014's suites.)
 * - Marks carry no node identifier, structure, table geometry, LaTeX, extension envelope or field
 *   definition, so `addMark` and `addNodeMark` cannot break I3, I5, I6, I7, I8, I10, I12, I13, I14
 *   or I15. A link is an inline mark only, so I9 is reachable by `addMark` and by a `replace` that
 *   inserts linked text, and by nothing else.
 * - `attr` changes one attribute of one node. It cannot change structure (I1 content rules aside
 *   from features, I10 placement by position). It reaches I3 only by changing a region's
 *   identifier, which the I2 transition refuses first (the corpus's `i3-region-id-to-retired`,
 *   counted under I2 here).
 * - `replaceAround` wraps or unwraps existing content. The wrappers of the schema are the region
 *   and the table parts, so it reaches the invariants a region or a table can break (I1 to I4, I6,
 *   I7, I10, I11) and not the ones about styles (I5), LaTeX (I8), links (I9), extensions (I12) or
 *   fields (I13 to I15), whose nodes are leaves or definitions.
 *
 * Not covered here: the asset arm of I4 over the wire. The data plane does not yet give the Room
 * the document's attached assets (SEC-037 Notes), so only a Room built with that set refuses it.
 * Node.js only (vitest). No network.
 */
import { Fragment, type Mark, type Node, Slice } from 'prosemirror-model';
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
import { describe, expect, it } from 'vitest';
import { ALLOWED_STEP_TYPES, DEFAULT_LIMITS } from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Room } from '../../../packages/authority/src/room/room.ts';
import type { Effects, ToClient } from '../../../packages/authority/src/room/types.ts';
import { USERS, basePermissions } from '../../../packages/authority/test/fixtures.ts';
import { allCases, baseOf, expand, readCase, type Json } from './support/invariant-corpus.ts';

const schema = cdmSchema();
const INVARIANTS = Array.from({ length: 15 }, (_, i) => `I${i + 1}`);

/** The step types that can break each invariant (see the header for the cells left out). */
const CAN: Record<string, readonly string[]> = {
  I1: ['replace', 'replaceAround', 'addMark', 'addNodeMark', 'attr'],
  I2: ['replace', 'replaceAround', 'addMark', 'addNodeMark', 'attr'],
  I3: ['replace', 'replaceAround'],
  I4: ['replace', 'replaceAround', 'addMark', 'attr'],
  I5: ['replace', 'attr'],
  I6: ['replace', 'replaceAround', 'attr'],
  I7: ['replace', 'replaceAround', 'attr'],
  I8: ['replace', 'attr'],
  I9: ['replace', 'addMark'],
  I10: ['replace', 'replaceAround', 'attr'],
  I11: ['replace', 'replaceAround', 'addMark', 'addNodeMark', 'attr'],
  I12: ['replace', 'attr'],
  I13: ['replace', 'attr'],
  I14: ['replace', 'attr'],
  I15: ['replace', 'attr'],
};

interface MatrixCase {
  name: string;
  invariant: string;
  stepType: string;
  base: Json;
  steps: Json[];
  context: Json;
  /** ProseMirror's own content rules refuse the step, before the model's checks run. */
  bySchema?: true;
}

const CONTEXT = readCase('i2-duplicate-id')['context'] as Json; // the corpus's shared context

const pm = (env: Json): Node => schema.nodeFromJSON(env['doc']);
const json = (...steps: Step[]): Json[] => steps.map((s) => s.toJSON() as Json);
const n = (j: Json): Node => schema.nodeFromJSON(j);
const insert = (pos: number, ...nodes: Json[]): Step =>
  new ReplaceStep(pos, pos, new Slice(Fragment.from(nodes.map(n)), 0, 0));
const para = (id: string, attrs: Json = {}, content: Json[] = [{ type: 'text', text: 'x' }]) => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content,
});

function at(doc: Node, pred: string | ((node: Node) => boolean)): number {
  let found = -1;
  const test = typeof pred === 'string' ? (x: Node) => x.attrs['id'] === pred : pred;
  doc.descendants((x, pos) => {
    if (found < 0 && test(x)) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${String(pred)}`);
  return found;
}

/** Wraps the block at `pos` in `wrapper` nodes (outermost first), as `Transform.wrap` does. */
function wrap(doc: Node, pos: number, ...wrappers: Node[]): Step {
  const end = pos + doc.nodeAt(pos)!.nodeSize;
  let content = Fragment.empty;
  for (const w of [...wrappers].reverse()) content = Fragment.from(w.copy(content));
  return new ReplaceAroundStep(pos, end, pos, end, new Slice(content, 0, 0), wrappers.length, true);
}

const tableParts = (cols: number, tableAttrs: Json = {}, cellAttrs: Json = {}): Node[] => [
  schema.nodes['table']!.create({
    id: 'tWrap00000000001',
    grid: Array.from({ length: cols }, () => 100),
    ...tableAttrs,
  }),
  schema.nodes['table_row']!.create({ id: 'trWrap0000000001' }),
  schema.nodes['table_cell']!.create({ id: 'tcWrap0000000001', ...cellAttrs }),
];

/** The commits for the cells of the matrix that the corpus does not hold. */
function extraCases(): MatrixCase[] {
  const out: MatrixCase[] = [];
  const example = baseOf('example');
  const sink = baseOf('kitchen-sink');
  // The example with a page break in its last paragraph, which is valid outside a table cell.
  const withBreak = structuredClone(example);
  withBreak['doc']['content'][1]['content'][2]['content'] = [
    { type: 'break', attrs: { kind: 'page' } },
  ];
  const e = pm(example);
  const s = pm(sink);
  const add = (invariant: string, name: string, base: Json, steps: Json[], bySchema = false) => {
    const types = [...new Set(steps.map((x) => x['stepType'] as string))];
    if (types.length !== 1) throw new Error(`${name}: one step type per case`);
    out.push({
      name,
      invariant,
      stepType: types[0]!,
      base,
      steps,
      context: CONTEXT,
      ...(bySchema ? { bySchema: true as const } : {}),
    });
  };
  const lastE = at(e, 'pZ9y8X7w6V5u4T3s');
  const region = (attrs: Json) => schema.nodes['region']!.create(attrs);

  // I1: the example's `requires` is empty, so anything of the `preserve` feature is not valid in it.
  const preservedProps = { children: [{ name: 'w:shadow' }] };
  add(
    'I1',
    'attr: preserved properties on a paragraph without the feature',
    example,
    json(new AttrStep(lastE, 'preserved', preservedProps)),
  );
  add(
    'I1',
    'addMark: a preserved mark without the feature',
    example,
    json(
      new AddMarkStep(
        at(e, 'p3Jq8sLw0aZx1VbN') + 1,
        at(e, 'p3Jq8sLw0aZx1VbN') + 3,
        schema.marks['preserved']!.create({ props: preservedProps }),
      ),
    ),
  );
  add(
    'I1',
    'replaceAround: a region around the paragraph of a footnote',
    sink,
    json(wrap(s, at(s, 'pFnUtilities0001'), region({ id: 'rInFootnote00001' }))),
    true,
  );
  // I2
  add(
    'I2',
    'addNodeMark: an insertion on a paragraph that reuses another user’s suggestion identifier',
    sink,
    json(
      new AddNodeMarkStep(
        at(s, 'pHeading00000001'),
        schema.marks['ins']!.create({ id: 'sAliceInsert0001', user: 'mallory' }),
      ),
    ),
  );
  // I3
  add(
    'I3',
    'replaceAround: a region around a paragraph that is already in a region',
    example,
    json(wrap(e, at(e, 'pA1b2C3d4E5f6G7h'), region({ id: 'rNested000000001' }))),
    true,
  );
  add(
    'I3',
    'replaceAround: a region with a retired identifier around the last paragraph',
    example,
    json(wrap(e, lastE, region({ id: 'rRetiredRegion01' }))),
  );
  // I4
  add(
    'I4',
    'replaceAround: a table with a style that does not exist around the last paragraph',
    example,
    json(wrap(e, lastE, ...tableParts(1, { style: 'Missing' }))),
  );
  // I6
  add(
    'I6',
    'replace: deletes one of the two cells of a row',
    sink,
    json(
      new ReplaceStep(
        at(s, 'tcFormula0000001'),
        at(s, 'tcFormula0000001') + s.nodeAt(at(s, 'tcFormula0000001'))!.nodeSize,
        Slice.empty,
      ),
    ),
  );
  add(
    'I6',
    'replaceAround: a two-column table with one single-span cell around the last paragraph',
    example,
    json(wrap(e, lastE, ...tableParts(2))),
  );
  // I7
  add(
    'I7',
    'attr: 4,001 characters of LaTeX in an equation',
    sink,
    json(new AttrStep(at(s, 'eqRent0000000001'), 'latex', 'x'.repeat(4001))),
  );
  add(
    'I7',
    'replaceAround: a table of 64 columns around the last paragraph',
    example,
    json(wrap(e, lastE, ...tableParts(64, {}, { colspan: 64 }))),
  );
  // I8
  add(
    'I8',
    'attr: LaTeX the math gate refuses',
    sink,
    json(new AttrStep(at(s, 'eqRent0000000001'), 'latex', '\\input{secret}')),
  );
  // I9
  add(
    'I9',
    'replace: inserts text that carries a javascript link',
    example,
    json(
      insert(lastE + 1, {
        type: 'text',
        text: 'click',
        marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
      }),
    ),
  );
  // I10
  add(
    'I10',
    'replaceAround: a table around a paragraph that holds a page break',
    withBreak,
    json(wrap(pm(withBreak), lastE, ...tableParts(1))),
  );
  // I11
  add(
    'I11',
    'replace: a paragraph whose alignment is not in the grammar',
    example,
    json(insert(e.content.size - 1, para('pSideways0000001', { align: 'sideways' }))),
  );
  add(
    'I11',
    'replaceAround: a region whose policy is not in the grammar',
    example,
    json(wrap(e, lastE, region({ id: 'rBadPolicy000001', policy: 'secret' }))),
  );
  // I13 to I15
  add(
    'I13',
    'attr: a form field takes the key of another',
    sink,
    json(new AttrStep(at(s, 'ffTenantIncome01'), 'key', 'tenant.name')),
  );
  add(
    'I14',
    'attr: a mirror points at a key no form field has',
    sink,
    json(
      new AttrStep(
        at(s, (x) => x.type.name === 'field' && x.attrs['kind'] === 'formValue'),
        'target',
        'field:tenant.nothing',
      ),
    ),
  );
  return out;
}

/** The failing corpus fixtures made of one step type, one case per expected invariant. */
function corpusCases(): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const c of allCases()) {
    const types = [...new Set(c.steps.map((x) => x['stepType'] as string))];
    if (c.expected.length === 0 || types.length !== 1) continue;
    // Several expected invariants: the Room names the first check that fails. `CORPUS_NAMED`
    // says which one that is, so the case counts for that cell only.
    const invariant = c.expected.length === 1 ? c.expected[0]! : CORPUS_NAMED[c.name];
    if (!invariant) throw new Error(`${c.name}: say which invariant the Room names`);
    out.push({
      name: `corpus ${c.name}`,
      invariant,
      stepType: types[0]!,
      base: typeof c.base === 'string' ? baseOf(c.base) : structuredClone(c.base),
      steps: expand(c.steps) as Json[],
      context: c.context,
    });
  }
  return out;
}
const CORPUS_NAMED: Record<string, string> = { 'i3-region-id-to-retired': 'I2' };

const LIMITS = { ...DEFAULT_LIMITS, maxStepsPerCommit: 1_000_000, maxCommitBytes: 256 * 2 ** 20 };
let clock = 1_790_000_000_000;
let counter = 0;
const commitId = () => `0192f0c4-7b1e-7000-9027-${(++counter).toString(16).padStart(12, '0')}`;

function roomFor(base: Json, context: Json): { room: Room; initial: Node } {
  const initial = pm(base);
  const gate = context['mathGateRefuses'] as string | undefined;
  const room = new Room({
    schema,
    initial,
    requires: (base['requires'] ?? []) as string[],
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-sec-027',
    now: () => ++clock,
    limits: LIMITS,
    retiredRegionIds: (context['retiredRegionIds'] ?? []) as string[],
    ...(context['attachedAssets']
      ? { attachedAssets: new Set<string>(context['attachedAssets'] as string[]) }
      : {}),
    ...(gate !== undefined
      ? { mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null) }
      : {}),
  });
  room.open('c1', USERS.alice);
  return { room, initial };
}

function answer(fx: Effects): ToClient | undefined {
  return fx.send
    .filter((o) => o.channel === 'c1')
    .map((o) => o.msg as ToClient)
    .find((m) => m.t === 'sync.reject' || m.t === 'sync.ack');
}

const cases = [...corpusCases(), ...extraCases()];

describe('SEC-027 each invariant, with each step type that can break it', () => {
  it('the matrix names only step types on the allow-list and every invariant', () => {
    expect(Object.keys(CAN)).toEqual(INVARIANTS);
    for (const types of Object.values(CAN))
      for (const t of types) expect(ALLOWED_STEP_TYPES).toContain(t);
  });

  it('has a case for every cell of the matrix, and no case outside it', () => {
    const have = new Set(cases.map((c) => `${c.invariant} ${c.stepType}`));
    const want = INVARIANTS.flatMap((i) => CAN[i]!.map((t) => `${i} ${t}`));
    expect([...have].sort()).toEqual([...want].sort());
  });

  it.each(cases.map((c) => [`${c.invariant} by ${c.stepType}: ${c.name}`, c] as const))(
    '%s is refused with invalid_op and the document is unchanged',
    (_name, c) => {
      const { room, initial } = roomFor(c.base, c.context);
      const fx = room.submit('c1', { id: commitId(), base: 0, steps: c.steps });
      const msg = answer(fx) as Extract<ToClient, { t: 'sync.reject' }> | undefined;
      expect(msg?.t, JSON.stringify(msg)).toBe('sync.reject');
      expect(msg?.code, msg?.reason).toBe('invalid_op');
      if (c.bySchema) expect(String(msg?.reason)).toMatch(/^step 0 failed: Invalid content/);
      else expect(String(msg?.reason)).toMatch(new RegExp(`\\b${c.invariant}\\b`));
      expect(fx.write, 'a refused commit must not reach storage').toBeNull();
      expect(room.document.eq(initial)).toBe(true);
    },
  );

  // Support for leaving `removeMark` and `removeNodeMark` out of the matrix.
  it.each(['example', 'kitchen-sink'])(
    'accepts the removal of every mark in the %s document, one commit each',
    (name) => {
      const base = baseOf(name);
      const doc = pm(base);
      const removals: Step[] = [];
      doc.descendants((node, pos) => {
        const marks: readonly Mark[] = node.marks;
        for (const mark of marks)
          removals.push(
            node.isInline
              ? new RemoveMarkStep(pos, pos + node.nodeSize, mark)
              : new RemoveNodeMarkStep(pos, mark),
          );
      });
      if (name === 'kitchen-sink') expect(removals.length).toBeGreaterThan(10);
      for (const step of removals) {
        const { room } = roomFor(base, CONTEXT);
        const fx = room.submit('c1', { id: commitId(), base: 0, steps: json(step) });
        const what = JSON.stringify(step.toJSON());
        expect(answer(fx)?.t, what).not.toBe('sync.reject');
        expect(fx.write, `${what} is accepted and written`).not.toBeNull();
      }
    },
  );
});
