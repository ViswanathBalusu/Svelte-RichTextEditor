// Marks (03 §5): character formatting (CDM-037), link schemes (CDM-038), suggestion marks
// (CDM-039) and block-level suggestions (CDM-040), including the steps that make them (04 §4).
import { AddMarkStep, AddNodeMarkStep, RemoveNodeMarkStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  codes,
  ctx,
  exampleDoc,
  invariants,
  row,
  cell,
  sinkDoc,
  style,
  table,
  text,
  type Json,
} from '../../test/support.ts';
import { canonicalEnvelope, type JsonEnvelope } from '../canonical/canonical-form.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { generateProseMirrorSpec } from '../schema/prosemirror-spec.ts';
import { suggestionsOf } from '../structure/suggestions.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { validate, validateDoc } from './validate.ts';

const schema = cdmSchema();
const marked = (...marks: Json[]): Json => {
  const d = exampleDoc();
  bodyOf(d)[2]!.content = [text('styled', marks)];
  return d;
};
const mark = (type: string, attrs?: Json): Json => (attrs ? { type, attrs } : { type });

describe('character formatting with marks (CDM-037)', () => {
  it('gives the toggles a boolean value, underline a style and vertAlign a position', () => {
    for (const t of ['bold', 'italic', 'strike', 'smallCaps', 'allCaps', 'hidden']) {
      expect(invariants(marked(mark(t, { value: false }))), t).toEqual([]);
      expect(codes(marked(mark(t, { value: 'on' }))), t).toContain('attribute_invalid');
    }
    for (const s of ['single', 'double', 'dotted', 'none'])
      expect(invariants(marked(mark('underline', { style: s }))), s).toEqual([]);
    expect(codes(marked(mark('underline', { style: 'wave' })))).toEqual(['attribute_invalid']);
    for (const v of ['super', 'sub', 'baseline'])
      expect(invariants(marked(mark('vertAlign', { value: v }))), v).toEqual([]);
    expect(codes(marked(mark('vertAlign', { value: 'raised' })))).toEqual(['attribute_invalid']);
  });

  it('checks colour, highlight, font family, font size and language against their grammars (I11)', () => {
    const good = [
      mark('color', { value: '#C00000' }),
      mark('highlight', { value: 'darkYellow' }),
      mark('fontFamily', { value: 'Noto Serif' }),
      mark('fontSize', { value: 240 }),
      mark('lang', { value: 'fr-CA' }),
    ];
    expect(invariants(marked(...good))).toEqual([]);
    const bad = [
      mark('color', { value: '#c00000' }),
      mark('highlight', { value: 'orange' }),
      mark('fontFamily', { value: 'Serif; color: red' }),
      mark('fontFamily', { value: 'Font{x}' }),
      mark('fontFamily', { value: 'url(evil)' }),
      mark('fontSize', { value: 10.5 }),
      mark('lang', { value: 'english!' }),
    ];
    for (const m of bad) expect(codes(marked(m)), JSON.stringify(m)).toContain('attribute_invalid');
  });

  it('reports a charStyle mark that names no character style (I4)', () => {
    expect(codes(marked(mark('charStyle', { style: 'Missing' })))).toEqual([
      'unresolved_reference',
    ]);
    expect(codes(marked(mark('charStyle', { style: 'Normal' })))).toEqual(['wrong_reference_kind']);
    const ok = addDefs(
      marked(mark('charStyle', { style: 'Strong' })),
      style('Strong', { kind: 'character', builtIn: true, bold: true }),
    );
    expect(invariants(ok)).toEqual([]);
  });

  it('lets a second mark of the same type replace the first, except suggestion marks', () => {
    const b1 = schema.marks['bold']!.create({ value: true });
    const b2 = schema.marks['bold']!.create({ value: false });
    expect(b2.addToSet(b1.addToSet([]))).toEqual([b2]);
    const c1 = schema.marks['color']!.create({ value: '#000000' });
    const c2 = schema.marks['color']!.create({ value: '#FFFFFF' });
    expect(c2.addToSet(c1.addToSet([]))).toEqual([c2]);
    for (const s of ['ins', 'del', 'fmt']) expect(schema.marks[s]!.spec.excludes, s).toBe('');
  });

  it('publishes the mark order of the definition, which the canonical form uses', () => {
    const order = CDM1.marks.map((m) => m.name);
    expect(generateProseMirrorSpec(CDM1).marks.map(([name]) => name)).toEqual(order);
    expect(Object.keys(schema.marks)).toEqual(order);
    const c = canonicalEnvelope(
      marked(
        mark('italic'),
        mark('link', { href: 'https://example.org' }),
        mark('bold'),
      ) as JsonEnvelope,
    );
    expect(c.doc.content![1]!.content![2]!.content![0]!.marks!.map((m) => m.type)).toEqual([
      'link',
      'bold',
      'italic',
    ]);
  });
});

describe('link schemes (CDM-038)', () => {
  it('carries href and title within their bounds', () => {
    expect(
      invariants(marked(mark('link', { href: 'https://example.org/a?b=c#d', title: 'Example' }))),
    ).toEqual([]);
    expect(
      codes(marked(mark('link', { href: `https://example.org/${'a'.repeat(2048)}` }))),
    ).toEqual(['attribute_invalid']);
    expect(
      codes(marked(mark('link', { href: 'https://example.org', title: 'x'.repeat(256) }))),
    ).toEqual(['attribute_invalid']);
  });

  it('passes http, https, mailto and in-document targets', () => {
    for (const href of [
      'http://example.org',
      'https://example.org/x',
      'mailto:someone@example.org',
      '#clause_4',
    ])
      expect(invariants(marked(mark('link', { href }))), href).toEqual([]);
  });

  it('reports any other scheme as I9', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'run:calc',
      'ftp://example.org',
      '//example.org',
    ])
      expect(invariants(marked(mark('link', { href }))), href).toEqual(['I9']);
  });

  it('refuses obfuscated forms of a disallowed scheme as the plain form', () => {
    for (const href of [
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav&#x09;ascript:alert(1)',
      'HTTPS://example.org',
    ])
      expect(invariants(marked(mark('link', { href }))), JSON.stringify(href)).toContain('I9');
  });

  it('reports an addMark step that adds a link with a disallowed scheme (I9)', () => {
    const doc = schema.nodeFromJSON(exampleDoc()['doc']);
    let from = -1;
    doc.descendants((n, pos) => {
      if (from < 0 && n.isText) from = pos;
      return from < 0;
    });
    const step = new AddMarkStep(
      from,
      from + 3,
      schema.marks['link']!.create({ href: 'javascript:alert(1)' }),
    );
    const r = step.apply(doc);
    expect(r.failed).toBeNull();
    expect(validateDoc(r.doc!, [], ctx).violations.map((v) => v.invariant)).toEqual(['I9']);
  });
});

const ins = (id: string, user: string): Json => mark('ins', { id, user });
const del = (id: string, user: string): Json => mark('del', { id, user });
const fmt = (id: string, user: string, before: Json): Json => mark('fmt', { id, user, before });

describe('suggestion marks that coexist (CDM-039)', () => {
  it('carries id and user, and fmt also before', () => {
    expect(
      invariants(
        marked(
          ins('sAliceInsert0001', 'alice'),
          del('sBobDelete000001', 'bob'),
          fmt('sCarolFormat0001', 'carol', { marks: [] }),
        ),
      ),
    ).toEqual([]);
    expect(codes(marked(mark('ins', { id: 'sAliceInsert0001' })))).toEqual(['attribute_missing']);
    expect(codes(marked(mark('fmt', { id: 'sCarolFormat0001', user: 'carol' })))).toEqual([
      'attribute_missing',
    ]);
  });

  it("keeps one user's insertion when another user adds one to the same text", () => {
    const a = schema.marks['ins']!.create({ id: 'sAliceInsert0001', user: 'alice' });
    const b = schema.marks['ins']!.create({ id: 'sBobInsert000001', user: 'bob' });
    const both = b.addToSet(a.addToSet([]));
    expect(both).toHaveLength(2);
    const doc = schema.nodeFromJSON(marked(ins('sAliceInsert0001', 'alice'))['doc']);
    let from = -1;
    doc.descendants((n, pos) => {
      if (n.isText && n.text === 'styled') from = pos;
      return true;
    });
    const r = new AddMarkStep(from, from + 6, b).apply(doc);
    const marks = r.doc!.nodeAt(from)!.marks.map((m) => m.attrs['user']);
    expect(marks.sort()).toEqual(['alice', 'bob']);
    expect(validateDoc(r.doc!, [], ctx).valid).toBe(true);
  });

  it('keeps the text of a suggested deletion in the document until it is accepted', () => {
    const d = marked(del('sBobDelete000001', 'bob'));
    expect(validate(d, ctx).valid).toBe(true);
    const c = canonicalEnvelope(d as JsonEnvelope);
    expect(c.doc.content![1]!.content![2]!.content![0]!.text).toBe('styled');
    expect(suggestionsOf(d['doc'])).toEqual([
      {
        id: 'sBobDelete000001',
        user: 'bob',
        kind: 'delete',
        before: null,
        parts: [{ on: 'text', blockId: 'pZ9y8X7w6V5u4T3s', text: 'styled' }],
      },
    ]);
  });

  it('refuses a time attribute on a suggestion mark: marks carry no time', () => {
    for (const t of ['time', 'date', 'createdAt'])
      expect(
        codes(
          marked(
            mark('ins', { id: 'sAliceInsert0001', user: 'alice', [t]: '2026-11-06T10:00:00.000Z' }),
          ),
        ),
        t,
      ).toEqual(['unknown_attribute']);
  });

  it('reports one suggestion identifier used by two users (I2)', () => {
    const d = exampleDoc();
    bodyOf(d)[2]!.content = [
      text('one', [ins('sSuggestion00001', 'alice')]),
      text(' two', [ins('sSuggestion00001', 'mallory')]),
    ];
    expect(codes(d)).toEqual(['suggestion_user']);
    expect(invariants(d)).toEqual(['I2']);
    // The same user may spread one suggestion over several runs.
    bodyOf(d)[2]!.content[1].marks[0].attrs.user = 'alice';
    expect(invariants(d)).toEqual([]);
  });

  it('checks user against its grammar and before against the shape and grammars of CDM-002', () => {
    for (const user of ['', 'a\u0000b', 'x'.repeat(256)])
      expect(
        codes(marked(ins('sAliceInsert0001', user))),
        JSON.stringify(user).slice(0, 20),
      ).toEqual(['attribute_invalid']);
    expect(
      invariants(
        marked(
          fmt('sFmt000000000001', 'carol', {
            marks: [{ type: 'bold' }, { type: 'color', attrs: { value: '#000000' } }],
          }),
        ),
      ),
    ).toEqual([]);
    const bad: Json[] = [
      [],
      { marks: {} },
      { marks: [{ type: 'comment' }] },
      { marks: [{ type: 'ins', attrs: { id: 'x', user: 'y' } }] },
      { marks: [{ type: 'color', attrs: { value: 'red' } }] },
      { attrs: { style: 'Normal' } },
      { other: 1 },
    ];
    for (const before of bad)
      expect(
        invariants(marked(fmt('sFmt000000000001', 'carol', before))),
        JSON.stringify(before),
      ).toEqual(['I11']);
    const big = { marks: [{ type: 'lang', attrs: { value: 'en' } }], pad: 'x'.repeat(5000) };
    expect(invariants(marked(fmt('sFmt000000000001', 'carol', big)))).toEqual(['I11']);
  });
});

describe('suggested changes to whole paragraphs, rows and tables (CDM-040)', () => {
  it('accepts ins, del and fmt as node marks on a paragraph, a table row and a table, and nowhere else', () => {
    const d = sinkDoc();
    expect(
      validate(d, {
        ...ctx,
        attachedAssets: new Set([
          '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
          '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
          '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
          '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
        ]),
      }).valid,
    ).toBe(true);
    const onTable = exampleDoc();
    bodyOf(onTable).push({
      ...table(
        'tTable0000000001',
        [1000],
        [
          {
            ...row('rRow000000000001', [cell('cCell0000000000A')]),
            marks: [ins('sRowInsert000001', 'alice')],
          },
        ],
      ),
      marks: [del('sTableDelete0001', 'bob')],
    });
    expect(invariants(onTable)).toEqual([]);
    for (const [what, host] of [
      [
        'cell',
        (d: Json) =>
          bodyOf(d).push(
            table(
              'tTable0000000001',
              [1000],
              [
                row('rRow000000000001', [
                  { ...cell('cCell0000000000A'), marks: [ins('sCell00000000001', 'bob')] },
                ]),
              ],
            ),
          ),
      ],
      ['region', (d: Json) => (bodyOf(d)[1]!.marks = [ins('sRegion000000001', 'bob')])],
      [
        'figure',
        (d: Json) =>
          bodyOf(d).push({
            type: 'figure',
            attrs: {
              id: 'fgFigure00000001',
              asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
              width: 10,
              height: 10,
            },
            marks: [ins('sFigure000000001', 'bob')],
          }),
      ],
      [
        'equation',
        (d: Json) =>
          bodyOf(d).push({
            type: 'equation_block',
            attrs: { id: 'eqBlock000000001', latex: 'x' },
            marks: [del('sEq0000000000001', 'bob')],
          }),
      ],
      [
        'toc',
        (d: Json) =>
          bodyOf(d).push({
            type: 'toc',
            attrs: { id: 'tocMain000000001' },
            marks: [del('sToc000000000001', 'bob')],
          }),
      ],
    ] as const) {
      const d = exampleDoc();
      host(d);
      expect(codes(d), what).toContain('node_mark_host');
    }
  });

  it('reads an ins or del node mark as a new or removed block, and fmt as a change with the previous values', () => {
    const d = exampleDoc();
    bodyOf(d)[0]!.marks = [ins('sNewBlock0000001', 'alice')];
    bodyOf(d)[2]!.marks = [
      fmt('sRestyle00000001', 'carol', { attrs: { style: 'Heading1', align: null } }),
    ];
    expect(validate(d, ctx).valid).toBe(true);
    const s = suggestionsOf(d['doc']);
    expect(s.map((x) => [x.kind, x.parts[0]!.on, x.parts[0]!.blockId])).toEqual([
      ['insert', 'paragraph', 'p3Jq8sLw0aZx1VbN'],
      ['format', 'paragraph', 'pZ9y8X7w6V5u4T3s'],
    ]);
    expect(s[1]!.before).toEqual({ attrs: { style: 'Heading1', align: null } });
  });

  it('refuses a block fmt whose before names anything but the style, alignment or list level', () => {
    for (const attrs of [{ indentLeft: 720 }, { id: 'pOther0000000001' }, { style: 'Missing!' }]) {
      const d = exampleDoc();
      bodyOf(d)[2]!.marks = [fmt('sRestyle00000001', 'carol', { attrs })];
      expect(codes(d), JSON.stringify(attrs)).toEqual(['fmt_before']);
    }
    const marksOnBlock = exampleDoc();
    bodyOf(marksOnBlock)[2]!.marks = [
      fmt('sRestyle00000001', 'carol', { marks: [{ type: 'bold' }] }),
    ];
    expect(codes(marksOnBlock)).toEqual(['fmt_before']);
  });

  it('checks the result of addNodeMark and removeNodeMark steps like any other step', () => {
    const doc = schema.nodeFromJSON(exampleDoc()['doc']);
    const bodyStart = doc.child(0).nodeSize;
    const firstParagraph = bodyStart + 1;
    const regionPos = firstParagraph + doc.child(1).child(0).nodeSize;
    const good = new AddNodeMarkStep(
      firstParagraph,
      schema.marks['del']!.create({ id: 'sDelBlock0000001', user: 'bob' }),
    ).apply(doc);
    expect(validateDoc(good.doc!, [], ctx).valid).toBe(true);
    // ProseMirror applies a node mark on a region; the result is refused (I1).
    const bad = new AddNodeMarkStep(
      regionPos,
      schema.marks['ins']!.create({ id: 'sInsRegion000001', user: 'bob' }),
    ).apply(doc);
    expect(bad.failed).toBeNull();
    expect(validateDoc(bad.doc!, [], ctx).violations.map((v) => v.code)).toEqual([
      'node_mark_host',
    ]);
    const removed = new RemoveNodeMarkStep(regionPos, bad.doc!.nodeAt(regionPos)!.marks[0]!).apply(
      bad.doc!,
    );
    expect(validateDoc(removed.doc!, [], ctx).valid).toBe(true);
  });

  it('cannot attach a block suggestion to a table cell or to a column: neither is defined', () => {
    const d = exampleDoc();
    bodyOf(d).push(
      table(
        'tTable0000000001',
        [1000],
        [
          row('rRow000000000001', [
            { ...cell('cCell0000000000A'), marks: [fmt('sCellFmt00000001', 'bob', { attrs: {} })] },
          ]),
        ],
      ),
    );
    expect(codes(d)).toContain('node_mark_host');
    expect(CDM1.nodes.map((n) => n.name)).not.toContain('table_column');
  });
});
