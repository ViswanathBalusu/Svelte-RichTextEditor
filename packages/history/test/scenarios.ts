/**
 * The edit scenarios of spike HIS-043 (08 §15, first bullet): moved content, table structure and
 * styles, plus splits, joins, interleaved typing and a filled field. Each scenario builds a log on
 * a fixture document and lists, by hand, the changes a reader would expect, as `kind:identifier`.
 * Both comparison methods run on every scenario; `fixtures/comparison/*.json` records their output
 * next to the expectation and is the regression fixture of HIS-011 and HIS-012.
 */
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { AttributionMap, applyCommit } from '../src/attribution.ts';
import { type Change, type Comparison, compareStates, compareSteps } from '../src/compare.ts';
import type { Author } from '../src/types.ts';
import { LogBuilder, baseDoc, posInside, posOf, schema, typeAt } from './fixtures.ts';

export interface Scenario {
  name: string;
  description: string;
  /** What a reader would expect to be told, as `kind:identifier`, in document order. */
  expected: string[];
  build: () => LogBuilder;
}

const para = (id: string, text: string, style: string | null = null) =>
  schema.nodes['paragraph']!.create(
    { id, ...(style ? { style } : {}) },
    text ? schema.text(text) : null,
  );

/** The fixture document with a section (a heading and two paragraphs) before the last paragraph. */
function withSection(): Node {
  const doc = baseDoc();
  return new Transform(doc).insert(posOf(doc, 'pEnd00000000001Z'), [
    para('pSecHead00000001', 'Termination', 'Heading1'),
    para('pSecBody00000001', 'Either party may end the lease.'),
    para('pSecBody00000002', 'Notice is one month.'),
  ]).doc;
}

function move(doc: Node, ids: readonly string[], beforeId: string): Transform {
  const from = posOf(doc, ids[0]!);
  const last = posOf(doc, ids[ids.length - 1]!);
  const to = last + doc.nodeAt(last)!.nodeSize;
  const slice = doc.slice(from, to);
  const tr = new Transform(doc).delete(from, to);
  const at = tr.mapping.map(posOf(doc, beforeId));
  return tr.step(new ReplaceStep(at, at, new Slice(slice.content, 0, 0)));
}

function cell(id: string, pid: string, text: string): Node {
  return schema.nodes['table_cell']!.create({ id }, para(pid, text));
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'paragraph-moved',
    description: 'The third paragraph of a region is moved to its start.',
    expected: ['moved:pTerms000000003A'],
    build: () => {
      const b = new LogBuilder();
      b.add((d) => move(d, ['pTerms000000003A'], 'pTerms000000001A'), { user: 'bob' });
      return b;
    },
  },
  {
    name: 'section-moved',
    description: 'A heading and its two paragraphs are moved before the introduction.',
    expected: ['moved:pSecHead00000001', 'moved:pSecBody00000001', 'moved:pSecBody00000002'],
    build: () => {
      const b = new LogBuilder(withSection());
      b.add(
        (d) =>
          move(d, ['pSecHead00000001', 'pSecBody00000001', 'pSecBody00000002'], 'pIntro0000000001'),
        {
          user: 'bob',
        },
      );
      return b;
    },
  },
  {
    name: 'moved-and-edited',
    description: 'A paragraph is moved, then a word in it is changed by someone else.',
    expected: ['moved:pTerms000000003A', 'modified:pTerms000000003A'],
    build: () => {
      const b = new LogBuilder();
      b.add((d) => move(d, ['pTerms000000003A'], 'pTerms000000001A'), { user: 'bob' });
      b.add((d) => typeAt(d, 'pTerms000000003A', 5, 'always '), { user: 'carol' });
      return b;
    },
  },
  {
    name: 'rows-inserted',
    description: 'A row is inserted between the two rows of a table.',
    expected: ['added:trFees0000000003'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const row = schema.nodes['table_row']!.create({ id: 'trFees0000000003' }, [
            cell('tcFees000000031A', 'pCell00000000031', 'Keys'),
            cell('tcFees000000032A', 'pCell00000000032', '10'),
          ]);
          return new Transform(d).insert(posOf(d, 'trFees0000000002'), row);
        },
        { user: 'bob' },
      );
      return b;
    },
  },
  {
    name: 'rows-deleted',
    description: 'The second row of a table is deleted.',
    expected: ['removed:trFees0000000002'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const at = posOf(d, 'trFees0000000002');
          return new Transform(d).delete(at, at + d.nodeAt(at)!.nodeSize);
        },
        { user: 'carol' },
      );
      return b;
    },
  },
  {
    name: 'rows-reordered',
    description: 'The two rows of a table change places.',
    expected: ['moved:trFees0000000002'],
    build: () => {
      const b = new LogBuilder();
      b.add((d) => move(d, ['trFees0000000002'], 'trFees0000000001'), { user: 'bob' });
      return b;
    },
  },
  {
    name: 'column-added',
    description: 'A column is added: the grid gains a width and each row gains a cell.',
    expected: ['formatted:tFees00000000001', 'added:tcFees000000013A', 'added:tcFees000000023A'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const tr = new Transform(d).setNodeAttribute(
            posOf(d, 'tFees00000000001'),
            'grid',
            [3000, 3000, 3000],
          );
          for (const [row, cid, pid, text] of [
            ['trFees0000000001', 'tcFees000000013A', 'pCell00000000013', 'Due'],
            ['trFees0000000002', 'tcFees000000023A', 'pCell00000000023', 'At the end'],
          ] as const) {
            const at = posOf(tr.doc, row);
            tr.insert(at + tr.doc.nodeAt(at)!.nodeSize - 1, cell(cid, pid, text));
          }
          return tr;
        },
        { user: 'bob' },
      );
      return b;
    },
  },
  {
    name: 'cells-merged',
    description:
      'The two cells of the second row are merged: the first spans both columns and holds both paragraphs.',
    expected: ['formatted:tcFees000000021A', 'moved:pCell00000000022', 'removed:tcFees000000022A'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const c1 = posOf(d, 'tcFees000000021A');
          const c2 = posOf(d, 'tcFees000000022A');
          const second = d.nodeAt(c2)!;
          const tr = new Transform(d).delete(c2, c2 + second.nodeSize);
          tr.setNodeAttribute(c1, 'colspan', 2);
          const end = c1 + tr.doc.nodeAt(c1)!.nodeSize - 1;
          tr.insert(end, second.content);
          return tr;
        },
        { user: 'dave' },
      );
      return b;
    },
  },
  {
    name: 'style-applied',
    description: 'One paragraph style is applied to five paragraphs.',
    expected: [
      'formatted:pIntro0000000001',
      'formatted:pTerms000000001A',
      'formatted:pTerms000000002A',
      'formatted:pTerms000000003A',
      'formatted:pEnd00000000001Z',
    ],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const tr = new Transform(d);
          for (const id of [
            'pIntro0000000001',
            'pTerms000000001A',
            'pTerms000000002A',
            'pTerms000000003A',
            'pEnd00000000001Z',
          ])
            tr.setNodeAttribute(posOf(tr.doc, id), 'style', 'LegalQuote');
          return tr;
        },
        { user: 'carol', origin: 'format' },
      );
      return b;
    },
  },
  {
    name: 'style-definition-changed',
    description: 'A style definition changes: italic and more space after.',
    expected: ['definition:style_def/LegalQuote'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const at = posOf(d, 'LegalQuote');
          return new Transform(d)
            .setNodeAttribute(at, 'italic', true)
            .setNodeAttribute(at, 'spaceAfter', 240);
        },
        { user: 'alice', scopes: ['defs:style_def/LegalQuote'] },
      );
      return b;
    },
  },
  {
    name: 'paragraph-split',
    description: 'A paragraph is split in two; the second part gets a new identifier.',
    expected: ['modified:pIntro0000000001', 'added:pSplit0000000001'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) =>
          new Transform(d).split(posInside(d, 'pIntro0000000001', 14), 1, [
            { type: schema.nodes['paragraph']!, attrs: { id: 'pSplit0000000001' } },
          ]),
        { user: 'bob' },
      );
      return b;
    },
  },
  {
    name: 'paragraphs-joined',
    description: 'Two paragraphs of a region are joined into the first.',
    expected: ['modified:pTerms000000001A', 'removed:pTerms000000002A'],
    build: () => {
      const b = new LogBuilder();
      b.add((d) => new Transform(d).join(posOf(d, 'pTerms000000002A')), { user: 'bob' });
      return b;
    },
  },
  {
    name: 'interleaved-typing',
    description:
      'Two people type into the same paragraph in turns, and one deletes a word of the other.',
    expected: ['modified:pEnd00000000001Z'],
    build: () => {
      const b = new LogBuilder();
      b.add((d) => typeAt(d, 'pEnd00000000001Z', 4, 'very '), { user: 'bob' });
      b.add((d) => typeAt(d, 'pEnd00000000001Z', 13, ' indeed'), { user: 'carol' });
      b.add(
        (d) => {
          const at = posInside(d, 'pEnd00000000001Z', 4);
          return new Transform(d).delete(at, at + 5);
        },
        { user: 'carol' },
      );
      b.add((d) => typeAt(d, 'pEnd00000000001Z', 0, 'So '), { user: 'bob' });
      return b;
    },
  },
  {
    name: 'field-filled',
    description: 'A form field is filled in.',
    expected: ['field:fTenantName00001'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          let at = -1;
          d.descendants((n, pos) => {
            if (n.attrs['id'] === 'fTenantName00001') at = pos;
            return at < 0;
          });
          return new Transform(d).setNodeAttribute(at, 'value', 'Erin Example');
        },
        { user: 'erin', origin: 'fill', scopes: ['field:fTenantName00001'] },
      );
      return b;
    },
  },
  {
    name: 'paragraph-pasted',
    description: 'A copy of a paragraph is pasted after the introduction with a new identifier.',
    expected: ['added:pPasted000000001'],
    build: () => {
      const b = new LogBuilder();
      b.add(
        (d) => {
          const src = d.nodeAt(posOf(d, 'pTerms000000001A'))!;
          const copy = src.type.create({ ...src.attrs, id: 'pPasted000000001' }, src.content);
          const at =
            posOf(d, 'pIntro0000000001') + d.nodeAt(posOf(d, 'pIntro0000000001'))!.nodeSize;
          return new Transform(d).step(
            new ReplaceStep(at, at, new Slice(Fragment.from(copy), 0, 0)),
          );
        },
        { user: 'dave', origin: 'paste' },
      );
      return b;
    },
  },
];

export interface ScenarioResult {
  name: string;
  description: string;
  expected: string[];
  steps: Comparison;
  aligned: Comparison;
  /** Whether each method's changes, as `kind:identifier`, are exactly the expected ones. */
  matches: { steps: boolean; aligned: boolean };
}

export const keyOf = (c: Change) =>
  `${c.kind}:${c.kind === 'field' ? c.fieldId : c.kind === 'definition' ? c.defId : c.blockId}`;

/** Runs a scenario through both methods. */
export function runScenario(s: Scenario): ScenarioResult {
  const b = s.build();
  const head = b.head;
  const steps = compareSteps({ schema, from: { seq: 0, doc: b.docs[0]! }, commits: b.log });
  const creator: Author = { user: 'owner', seq: 0 };
  const map = AttributionMap.create(b.docs[0]!.content.size, creator);
  for (const c of b.log) applyCommit(map, c, schema);
  const latest = new Map<string, Author>();
  for (const c of b.log)
    for (const scope of c.scopes) latest.set(scope, { user: c.user, seq: c.seq });
  const aligned = compareStates({
    from: { seq: 0, doc: b.docs[0]! },
    to: { seq: head, doc: b.doc, attribution: map },
    scopeIndex: (scope) => latest.get(scope),
  });
  if (!steps.ok || !aligned.ok)
    throw new Error(`${s.name}: ${!steps.ok ? steps.reason : !aligned.ok ? aligned.reason : ''}`);
  // The same changes, in any order: the reader's list is about what changed, not the order shown.
  const keys = (c: Comparison) => JSON.stringify(c.changes.map(keyOf).sort());
  const expected = JSON.stringify([...s.expected].sort());
  return {
    name: s.name,
    description: s.description,
    expected: s.expected,
    steps: steps.comparison,
    aligned: aligned.comparison,
    matches: {
      steps: keys(steps.comparison) === expected,
      aligned: keys(aligned.comparison) === expected,
    },
  };
}
