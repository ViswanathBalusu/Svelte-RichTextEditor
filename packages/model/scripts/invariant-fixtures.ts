/**
 * The invariant fixtures (CDM-014; 03 §8, 12 §3.6): for every invariant I1 to I15 at least one
 * commit that breaks it, and for every numeric limit a commit at the limit and one past it. Each
 * fixture is a base document, the commit's steps in step JSON (`pm-steps/1`, 04 §4), the context
 * the context-dependent invariants need, and the exact list of invariants `model.validate()` and
 * the authority must report for the result. Written by `pnpm generate` to
 * packages/model/fixtures/invariants; fuzzing saves its regressions there in the same format.
 *
 * The expected invariants here are written by hand; the test checks that validate() agrees.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import example from '../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../fixtures/kitchen-sink.json' with { type: 'json' };
import { canonicalText, type JsonEnvelope } from '../src/canonical/canonical-form.ts';
import { cdmSchema } from '../src/prosemirror/index.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SINK_ASSETS = [
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
];

export interface FixtureContext {
  attachedAssets?: string[];
  retiredRegionIds?: string[];
  /** The math gate refuses LaTeX containing this text. */
  mathGateRefuses?: string;
  identifierChanges?: Array<{ from: string | null; to: string | null; copy?: boolean }>;
}

export interface InvariantFixture {
  name: string;
  /** What the commit does, in one sentence. */
  doc: string;
  /** A base file name under `bases/` or a document inline. */
  base: string | Json;
  /** `requires` of the result, when it differs from the base's. */
  requires?: string[];
  steps: Json[];
  context: FixtureContext;
  /** The invariants the result breaks, sorted; empty for a passing boundary. */
  expected: string[];
  /** A numeric limit this fixture sits at (`at`) or just past (`past`). */
  limit?: { name: string; side: 'at' | 'past' };
}

const schema = cdmSchema();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const ex = (): Json => clone(example) as Json;
const sink = (): Json => clone(kitchenSink) as Json;
const ctxAll = (extra: FixtureContext = {}): FixtureContext => ({
  attachedAssets: SINK_ASSETS,
  retiredRegionIds: ['rRetiredRegion01'],
  mathGateRefuses: '\\input',
  identifierChanges: [],
  ...extra,
});

function pm(env: Json): Node {
  return schema.nodeFromJSON(env['doc']);
}
/** Position before the node with this `id` (attribute steps address it). */
function at(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found < 0 && n.attrs['id'] === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}
/** Position at the end of the body's content. */
function bodyEnd(doc: Node): number {
  return doc.content.size - 1;
}
const n = (json: Json): Node => schema.nodeFromJSON(json);
const insert = (pos: number, ...nodes: Json[]): Step =>
  new ReplaceStep(pos, pos, new Slice(Fragment.from(nodes.map(n)), 0, 0));
const json = (steps: Step[]): Json[] => steps.map((s) => s.toJSON() as Json);
const para = (id: string, text = 'x', attrs: Json = {}): Json => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content: [{ type: 'text', text }],
});
const region = (id: string, attrs: Json = {}): Json => ({
  type: 'region',
  attrs: { id, ...attrs },
  content: [para(`p${id.slice(1)}`)],
});
const cellOf = (
  id: string,
  content: Json[] = [para(`p${id.slice(1)}`)],
  attrs: Json = {},
): Json => ({
  type: 'table_cell',
  attrs: { id, ...attrs },
  content,
});
const tableOf = (cols: number, attrs: Json = {}): Json => ({
  type: 'table',
  attrs: { id: 'tFixture00000001', grid: Array.from({ length: cols }, () => 100), ...attrs },
  content: [
    {
      type: 'table_row',
      attrs: { id: 'trFixture0000001' },
      content: [cellOf('tcFixture0000001', undefined, { colspan: cols })],
    },
  ],
});
const pad = (i: number, prefix: string) =>
  `${prefix}${String(i).padStart(16 - prefix.length, '0')}`;

/** A field-ready base: the example with a tenant role and one assigned number field. */
function fieldsBase(): Json {
  const d = ex();
  d['requires'] = ['fields'];
  d['doc'].content[0].content.push({
    type: 'role_def',
    attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d['doc'].content[1].content[2].content = [
    { type: 'text', text: 'Income: ' },
    {
      type: 'form_field',
      attrs: {
        id: 'ffIncome00000001',
        key: 'tenant.income',
        kind: 'number',
        label: 'Income',
        assignee: 'role_tenant',
      },
    },
  ];
  return d;
}

/**
 * A document whose deepest node, a text node, is at `depth` (doc 1, body 2, then regions inside
 * regions, a paragraph and its text). No step can make it: nested regions are refused (I3).
 */
function nested(depth: number): Json {
  const d = ex();
  let inner: Json = para('pDeepest00000001');
  for (let i = 0; i < depth - 4; i++)
    inner = { type: 'region', attrs: { id: pad(i, 'rDeep') }, content: [inner] };
  d['doc'].content[1].content.push(inner);
  return d;
}

/** The text length that brings the example, with text in its last paragraph, to `bytes`. */
function textForCanonicalSize(bytes: number): number {
  const d = ex();
  d['doc'].content[1].content[2].content = [{ type: 'text', text: 'x' }];
  const one = utf8Length(canonicalText(d as JsonEnvelope));
  return bytes - one + 1;
}
const utf8Length = (s: string) => Buffer.byteLength(s, 'utf8');

export function invariantFixtures(): InvariantFixture[] {
  const out: InvariantFixture[] = [];
  const add = (f: InvariantFixture) => out.push(f);
  const e = pm(ex());
  const s = pm(sink());
  const end = bodyEnd(e);

  // I1 ----------------------------------------------------------------------------------------
  add({
    name: 'i1-node-mark-on-region',
    doc: 'addNodeMark: a suggestion as a node mark on a region, which ProseMirror allows and the CDM does not.',
    base: 'example',
    steps: json([
      new AddNodeMarkStep(
        at(e, 'rG7mK2pQ9xYt4HcD'),
        schema.marks['ins']!.create({ id: 'sInsRegion000001', user: 'bob' }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I1'],
  });
  add({
    name: 'i1-feature-not-required',
    doc: 'replace: a form field in a document whose requires lacks `fields`.',
    base: 'example',
    steps: json([
      insert(at(e, 'pZ9y8X7w6V5u4T3s') + 1, {
        type: 'form_field',
        attrs: { id: 'ffField000000001', key: 'a', label: 'A' },
      }),
    ]),
    context: ctxAll(),
    expected: ['I1'],
  });
  add({
    name: 'i1-two-footnote-paragraphs',
    doc: 'replace: a second paragraph in a footnote, which version 1 limits to one (CDM-001).',
    base: 'kitchen-sink',
    steps: json([insert(at(s, 'pFnUtilities0001'), para('pFnSecond0000001'))]),
    context: ctxAll(),
    expected: ['I1'],
  });
  // I2 ----------------------------------------------------------------------------------------
  add({
    name: 'i2-duplicate-id',
    doc: 'replace: a paragraph with the identifier of another.',
    base: 'example',
    steps: json([insert(end, para('p3Jq8sLw0aZx1VbN'))]),
    context: ctxAll(),
    expected: ['I2'],
  });
  add({
    name: 'i2-id-changed',
    doc: 'attr: the identifier of the only paragraph that holds it changes.',
    base: 'example',
    steps: json([new AttrStep(at(e, 'pZ9y8X7w6V5u4T3s'), 'id', 'pChanged00000001')]),
    context: ctxAll({ identifierChanges: [{ from: 'pZ9y8X7w6V5u4T3s', to: 'pChanged00000001' }] }),
    expected: ['I2'],
  });
  add({
    name: 'i2-suggestion-two-users',
    doc: 'addMark: an insertion that reuses the identifier of another user’s suggestion.',
    base: 'kitchen-sink',
    steps: json([
      new AddMarkStep(
        at(s, 'pHeading00000001') + 2,
        at(s, 'pHeading00000001') + 4,
        schema.marks['ins']!.create({ id: 'sAliceInsert0001', user: 'mallory' }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I2'],
  });
  add({
    name: 'i2-wrap-with-duplicate-region-id',
    doc: 'replaceAround: wraps the last paragraph in a region whose identifier the first region has.',
    base: 'example',
    steps: json([
      new ReplaceAroundStep(
        at(e, 'pZ9y8X7w6V5u4T3s'),
        end,
        at(e, 'pZ9y8X7w6V5u4T3s'),
        end,
        new Slice(Fragment.from(schema.nodes['region']!.create({ id: 'rG7mK2pQ9xYt4HcD' })), 0, 0),
        1,
        true,
      ),
    ]),
    context: ctxAll(),
    expected: ['I2'],
  });
  // I3 ----------------------------------------------------------------------------------------
  add({
    name: 'i3-retired-region-id',
    doc: 'replace: a region whose identifier was removed from the document before.',
    base: 'example',
    steps: json([insert(end, region('rRetiredRegion01'))]),
    context: ctxAll(),
    expected: ['I3'],
  });
  add({
    name: 'i3-region-id-to-retired',
    doc: 'attr: the identifier of a region changes to a retired one (also an I2 change).',
    base: 'example',
    steps: json([new AttrStep(at(e, 'rG7mK2pQ9xYt4HcD'), 'id', 'rRetiredRegion01')]),
    context: ctxAll({ identifierChanges: [{ from: 'rG7mK2pQ9xYt4HcD', to: 'rRetiredRegion01' }] }),
    expected: ['I2', 'I3'],
  });
  // I4 ----------------------------------------------------------------------------------------
  add({
    name: 'i4-missing-style',
    doc: 'attr: a paragraph names a style that does not exist.',
    base: 'example',
    steps: json([new AttrStep(at(e, 'pZ9y8X7w6V5u4T3s'), 'style', 'Missing')]),
    context: ctxAll(),
    expected: ['I4'],
  });
  add({
    name: 'i4-delete-used-style',
    doc: 'replace: deletes the style the first heading uses.',
    base: 'example',
    steps: json([new ReplaceStep(at(e, 'Heading1'), at(e, 'Heading1') + 1, Slice.empty)]),
    context: ctxAll(),
    expected: ['I4'],
  });
  add({
    name: 'i4-missing-char-style',
    doc: 'addMark: a character style mark that names nothing.',
    base: 'example',
    steps: json([
      new AddMarkStep(
        at(e, 'p3Jq8sLw0aZx1VbN') + 1,
        at(e, 'p3Jq8sLw0aZx1VbN') + 3,
        schema.marks['charStyle']!.create({ style: 'Missing' }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I4'],
  });
  add({
    name: 'i4-unattached-asset',
    doc: 'replace: a figure whose asset is not attached to the document.',
    base: 'example',
    steps: json([
      insert(end, {
        type: 'figure',
        attrs: {
          id: 'fgFigure00000001',
          asset: '0192f0c4-7b1e-7c3a-9a54-0000000000ff',
          width: 100,
          height: 100,
        },
      }),
    ]),
    context: ctxAll(),
    expected: ['I4'],
  });
  // I5 ----------------------------------------------------------------------------------------
  add({
    name: 'i5-cycle',
    doc: 'attr: Normal becomes based on Heading1, which is based on Normal.',
    base: 'example',
    steps: json([new AttrStep(at(e, 'Normal'), 'basedOn', 'Heading1')]),
    context: ctxAll(),
    expected: ['I5'],
  });
  for (const [count, side, expected] of [
    [10, 'at', []],
    [11, 'past', ['I5']],
  ] as const)
    add({
      name: `i5-chain-${count}`,
      doc: `replace: a basedOn chain of ${count} styles.`,
      base: 'example',
      steps: json([
        insert(
          at(e, 'ps1'),
          ...Array.from({ length: count - 1 }, (_, i) => ({
            type: 'style_def',
            attrs: { id: `s${i + 1}`, name: `S${i + 1}`, basedOn: i === 0 ? 'Normal' : `s${i}` },
          })),
        ),
      ]),
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'basedOnDepth', side },
    });
  // I6 ----------------------------------------------------------------------------------------
  add({
    name: 'i6-header-rows',
    doc: 'attr: headerRows larger than the rows of the table.',
    base: 'kitchen-sink',
    steps: json([new AttrStep(at(s, 'tTerms0000000001'), 'headerRows', 3)]),
    context: ctxAll(),
    expected: ['I6'],
  });
  add({
    name: 'i6-colspan',
    doc: 'attr: a cell spans more columns than the grid has room for.',
    base: 'kitchen-sink',
    steps: json([new AttrStep(at(s, 'tcRent0000000001'), 'colspan', 2)]),
    context: ctxAll(),
    expected: ['I6'],
  });
  // I7 ----------------------------------------------------------------------------------------
  for (const [count, side, expected] of [
    [499, 'at', []],
    [500, 'past', ['I7']],
  ] as const)
    add({
      name: `i7-regions-${count + 1}`,
      doc: `replace: ${count + 1} regions in all.`,
      base: 'example',
      steps: json([
        insert(end, ...Array.from({ length: count }, (_, i) => region(pad(i, 'rRegion')))),
      ]),
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'regions', side },
    });
  for (const [cols, side, expected] of [
    [63, 'at', []],
    [64, 'past', ['I7']],
  ] as const)
    add({
      name: `i7-columns-${cols}`,
      doc: `replace: a table of ${cols} columns (a span is at most 63, so the wider table's geometry is not checked).`,
      base: 'example',
      steps: json([insert(end, tableOf(63, { grid: Array.from({ length: cols }, () => 100) }))]),
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'tableColumns', side },
    });
  for (const [len, side, expected] of [
    [4000, 'at', []],
    [4001, 'past', ['I7']],
  ] as const)
    add({
      name: `i7-latex-${len}`,
      doc: `replace: an equation of ${len} characters of LaTeX.`,
      base: 'example',
      steps: json([
        insert(end, {
          type: 'equation_block',
          attrs: { id: 'eqLong0000000001', latex: 'x'.repeat(len) },
        }),
      ]),
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'latex', side },
    });
  for (const [depth, side, expected] of [
    [12, 'at', ['I1', 'I3']],
    [13, 'past', ['I3', 'I7']],
  ] as const)
    add({
      name: `i7-depth-${depth}`,
      doc: `no steps: a stored document nested ${depth} deep through regions in regions, which no step can make (hostile input).`,
      base: nested(depth),
      steps: [],
      context: ctxAll(),
      // Nested regions are I3 (and the schema's I1) at any depth; past 12 the walk stops with I7
      // and the recursive schema check is not run.
      expected: [...expected],
      limit: { name: 'depth', side },
    });
  for (const [extra, side, expected] of [
    [0, 'at', []],
    [1, 'past', ['I7']],
  ] as const)
    add({
      name: `i7-canonical-size-${side}`,
      doc: `replace: text that brings the canonical size ${side === 'at' ? 'to' : 'one byte past'} 16 MiB.`,
      base: 'example',
      // `$repeat` keeps the file small: the loader expands it into the repeated string.
      steps: [
        {
          stepType: 'replace',
          from: at(e, 'pZ9y8X7w6V5u4T3s') + 1,
          to: at(e, 'pZ9y8X7w6V5u4T3s') + 1,
          slice: {
            content: [
              {
                type: 'text',
                text: { $repeat: 'x', count: textForCanonicalSize(16 * 1024 * 1024) + extra },
              },
            ],
          },
        },
      ],
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'canonicalBytes', side },
    });
  // I8 ----------------------------------------------------------------------------------------
  add({
    name: 'i8-math-gate',
    doc: 'replace: an equation the math gate refuses.',
    base: 'example',
    steps: json([
      insert(end, {
        type: 'equation_block',
        attrs: { id: 'eqGate0000000001', latex: '\\input{/etc/passwd}' },
      }),
    ]),
    context: ctxAll(),
    expected: ['I8'],
  });
  // I9 ----------------------------------------------------------------------------------------
  add({
    name: 'i9-javascript-link',
    doc: 'addMark: a link with the javascript scheme.',
    base: 'example',
    steps: json([
      new AddMarkStep(
        at(e, 'p3Jq8sLw0aZx1VbN') + 1,
        at(e, 'p3Jq8sLw0aZx1VbN') + 3,
        schema.marks['link']!.create({ href: 'javascript:alert(1)' }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I9'],
  });
  add({
    name: 'i9-then-remove-mark',
    doc: 'addMark then removeMark: a commit that ends in a removal is checked in full.',
    base: 'example',
    steps: json([
      new AddMarkStep(
        at(e, 'p3Jq8sLw0aZx1VbN') + 1,
        at(e, 'p3Jq8sLw0aZx1VbN') + 3,
        schema.marks['link']!.create({ href: 'file:///etc/passwd' }),
      ),
      new RemoveMarkStep(
        at(e, 'p3Jq8sLw0aZx1VbN') + 1,
        at(e, 'p3Jq8sLw0aZx1VbN') + 3,
        schema.marks['bold']!.create(),
      ),
    ]),
    context: ctxAll(),
    expected: ['I9'],
  });
  // I10 ---------------------------------------------------------------------------------------
  add({
    name: 'i10-footnote-in-footnote',
    doc: 'replace: a footnote inside the paragraph of a footnote (CDM-001: the content expression no longer forbids it).',
    base: 'kitchen-sink',
    steps: json([
      insert(at(s, 'pFnUtilities0001') + 1, {
        type: 'footnote',
        attrs: { id: 'fnNested00000001' },
        content: [para('pFnNested0000001')],
      }),
    ]),
    context: ctxAll(),
    expected: ['I10'],
  });
  add({
    name: 'i10-page-break-in-cell',
    doc: 'replace: a page break in a table cell.',
    base: 'kitchen-sink',
    steps: json([
      insert(at(s, 'pCellRent0000001') + 1, { type: 'break', attrs: { kind: 'page' } }),
    ]),
    context: ctxAll(),
    expected: ['I10'],
  });
  add({
    name: 'i10-break-kind-in-footnote',
    doc: 'attr: a line break in a footnote becomes a column break.',
    base: {
      ...sink(),
      doc: (() => {
        const d = sink();
        d['doc'].content[3].content[4].content[1].content[0].content.push({
          type: 'break',
          attrs: { kind: 'line' },
        });
        return d['doc'];
      })(),
    },
    steps: (() => {
      const d = sink();
      d['doc'].content[3].content[4].content[1].content[0].content.push({
        type: 'break',
        attrs: { kind: 'line' },
      });
      const doc = pm(d);
      const fn = at(doc, 'fnUtilities00001');
      let pos = -1;
      doc.nodesBetween(fn, fn + doc.nodeAt(fn)!.nodeSize, (node, p) => {
        if (node.type.name === 'break') pos = p;
        return true;
      });
      return json([new AttrStep(pos, 'kind', 'column')]);
    })(),
    context: ctxAll(),
    expected: ['I10'],
  });
  add({
    name: 'i10-float-in-cell',
    doc: 'replace: a floating figure in a table cell.',
    base: 'kitchen-sink',
    steps: json([
      insert(at(s, 'pCellRent0000001') + 6, {
        type: 'figure',
        attrs: {
          id: 'fgFloat000000001',
          asset: SINK_ASSETS[0],
          width: 10,
          height: 10,
          placement: 'float',
        },
      }),
    ]),
    context: ctxAll(),
    expected: ['I10'],
  });
  // I11 ---------------------------------------------------------------------------------------
  add({
    name: 'i11-policy',
    doc: 'attr: a region policy outside its values.',
    base: 'example',
    steps: json([new AttrStep(at(e, 'rG7mK2pQ9xYt4HcD'), 'policy', 'secret')]),
    context: ctxAll(),
    expected: ['I11'],
  });
  add({
    name: 'i11-colour-mark',
    doc: 'addMark: a colour in lower case.',
    base: 'example',
    steps: json([
      new AddMarkStep(
        at(e, 'p3Jq8sLw0aZx1VbN') + 1,
        at(e, 'p3Jq8sLw0aZx1VbN') + 3,
        schema.marks['color']!.create({ value: '#ff0000' }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I11'],
  });
  add({
    name: 'i11-fmt-before-on-block',
    doc: 'addNodeMark: a block format suggestion that records an indent.',
    base: 'example',
    steps: json([
      new AddNodeMarkStep(
        at(e, 'pZ9y8X7w6V5u4T3s'),
        schema.marks['fmt']!.create({
          id: 'sFmtBlock0000001',
          user: 'carol',
          before: { attrs: { indentLeft: 720 } },
        }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I11'],
  });
  // I12 ---------------------------------------------------------------------------------------
  for (const [bytes, side, expected] of [
    [16384, 'at', []],
    [16385, 'past', ['I12']],
  ] as const)
    add({
      name: `i12-payload-${bytes}`,
      doc: `replace: an extension block with a payload of ${bytes} bytes.`,
      base: 'example',
      requires: ['extensions'],
      steps: json([
        insert(end, {
          type: 'extension_block',
          attrs: {
            id: 'xBlock0000000001',
            extension: 'com.example.chart',
            payload: { d: 'x'.repeat(bytes - 8) },
            fallbackText: 'Chart',
          },
        }),
      ]),
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'payload', side },
    });
  add({
    name: 'i12-no-fallback',
    doc: 'attr: the only fallback of an extension block is removed.',
    base: 'kitchen-sink',
    steps: json([new AttrStep(at(s, 'xChart0000000001'), 'fallbackText', null)]),
    context: ctxAll(),
    expected: ['I12'],
  });
  // I13 to I15 (12 §3.6) ----------------------------------------------------------------------
  const f = pm(fieldsBase());
  const fieldPos = at(f, 'ffIncome00000001');
  add({
    name: 'i13-duplicate-key',
    doc: 'replace: a second field with the key of the first.',
    base: fieldsBase(),
    steps: json([
      insert(fieldPos + 1, {
        type: 'form_field',
        attrs: { id: 'ffIncome00000002', key: 'tenant.income', kind: 'number', label: 'Again' },
      }),
    ]),
    context: ctxAll(),
    expected: ['I13'],
  });
  add({
    name: 'i13-delete-used-role',
    doc: 'replace: deletes the role a field is assigned to.',
    base: fieldsBase(),
    steps: json([new ReplaceStep(at(f, 'role_tenant'), at(f, 'role_tenant') + 1, Slice.empty)]),
    context: ctxAll(),
    expected: ['I13'],
  });
  add({
    name: 'i14-mirror-without-field',
    doc: 'replace: a formValue field that mirrors a key no field has.',
    base: fieldsBase(),
    steps: json([
      insert(fieldPos + 1, {
        type: 'field',
        attrs: { kind: 'formValue', target: 'field:tenant.name' },
      }),
    ]),
    context: ctxAll(),
    expected: ['I14'],
  });
  add({
    name: 'i15-value-type',
    doc: 'attr: a number field gets a JSON number instead of a decimal string.',
    base: fieldsBase(),
    steps: json([new AttrStep(fieldPos, 'value', 1200.5)]),
    context: ctxAll(),
    expected: ['I15'],
  });
  for (const [count, side, expected] of [
    [1999, 'at', []],
    [2000, 'past', ['I15']],
  ] as const)
    add({
      name: `i15-fields-${count + 1}`,
      doc: `replace: ${count + 1} form fields in all.`,
      base: fieldsBase(),
      steps: json([
        insert(
          fieldPos + 1,
          ...Array.from({ length: count }, (_, i) => ({
            type: 'form_field',
            attrs: { id: pad(i, 'ff'), key: `k${i}`, label: 'K' },
          })),
        ),
      ]),
      context: ctxAll(),
      expected: [...expected],
      limit: { name: 'fields', side },
    });
  // A removeNodeMark cannot break an invariant alone; with an attribute step it is checked in full.
  add({
    name: 'i4-then-remove-node-mark',
    doc: 'attr then removeNodeMark: the result is checked whatever the last step was.',
    base: 'kitchen-sink',
    steps: json([
      new AttrStep(at(s, 'pList00000000001'), 'style', 'Missing'),
      new RemoveNodeMarkStep(
        at(s, 'pSuggested000001'),
        schema.marks['del']!.create({ id: 'sBobDelete000002', user: 'bob' }),
      ),
    ]),
    context: ctxAll(),
    expected: ['I4'],
  });
  return out;
}

/**
 * Writes every fixture as its own file. A string `base` names a file of packages/model/fixtures
 * (`example` is the 03 §12 example, `kitchen-sink` the kitchen sink). Fuzzing writes its
 * regressions to `regressions/` in the same format; this leaves them alone.
 */
export async function writeInvariantFixtures(dir: string): Promise<number> {
  await mkdir(resolve(dir, 'cases'), { recursive: true });
  const fixtures = invariantFixtures();
  const keep = new Set(fixtures.map((f) => `${f.name}.json`));
  if (existsSync(resolve(dir, 'cases')))
    for (const file of readdirSync(resolve(dir, 'cases')))
      if (!keep.has(file)) await rm(resolve(dir, 'cases', file));
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(resolve(dir, 'x.json'))) ?? {};
  for (const f of fixtures)
    await writeFile(
      resolve(dir, 'cases', `${f.name}.json`),
      await prettier.format(JSON.stringify(f), { ...config, parser: 'json' }),
      'utf8',
    );
  return fixtures.length;
}
