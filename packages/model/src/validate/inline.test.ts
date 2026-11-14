// Inline nodes (03 §4.4): breaks and tabs (CDM-033), footnotes and their content model (CDM-001,
// CDM-034), fields (CDM-035) and cross-references, sequences and bookmarks (CDM-036).
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  cell,
  codes,
  exampleDoc,
  footnote,
  invariants,
  para,
  row,
  style,
  table,
  text,
  type Json,
} from '../../test/support.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { generateJsonSchema } from '../schema/json-schema.ts';
import { generateProseMirrorSpec } from '../schema/prosemirror-spec.ts';
import { fieldText } from '../structure/field-text.ts';
import { cdmSchema } from '../prosemirror/index.ts';

const node = (name: string) => CDM1.nodes.find((n) => n.name === name)!;
const field = (attrs: Json): Json => ({ type: 'field', attrs });
const inBody = (...content: Json[]): Json => {
  const d = exampleDoc();
  bodyOf(d)[2]!.content = content;
  return d;
};

describe('line, page and column breaks and tabs (CDM-033)', () => {
  it('accepts the kinds line, page and column and refuses any other', () => {
    for (const kind of ['line', 'page', 'column'])
      expect(invariants(inBody(text('a'), { type: 'break', attrs: { kind } })), kind).toEqual([]);
    expect(codes(inBody({ type: 'break', attrs: { kind: 'section' } }))).toEqual([
      'attribute_invalid',
    ]);
  });

  it('reports a page or column break in a cell, a caption or a footnote, and accepts a line break there (I10)', () => {
    const places = (b: Json): Record<string, Json> => ({
      cell: (() => {
        const d = exampleDoc();
        bodyOf(d).push(
          table(
            'tTable0000000001',
            [1000],
            [
              row('rRow000000000001', [
                cell('cCell0000000000A', [para('pCell00000000001', [text('x'), b])]),
              ]),
            ],
          ),
        );
        return d;
      })(),
      caption: (() => {
        const d = exampleDoc();
        bodyOf(d).push({
          type: 'figure',
          attrs: {
            id: 'fgFigure00000001',
            asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
            width: 10,
            height: 10,
          },
          content: [{ type: 'caption', content: [text('x'), b] }],
        });
        return d;
      })(),
      footnote: inBody(
        text('x'),
        footnote('fnNote0000000001', [para('pNote00000000001', [text('x'), b])]),
      ),
    });
    for (const kind of ['page', 'column'])
      for (const [where, d] of Object.entries(places({ type: 'break', attrs: { kind } })))
        expect(codes(d), `${kind} in ${where}`).toEqual(['break_in_container']);
    for (const [where, d] of Object.entries(places({ type: 'break', attrs: { kind: 'line' } })))
      expect(invariants(d), `line in ${where}`).toEqual([]);
  });

  it('gives a tab no attribute other than ext', () => {
    expect(Object.keys(node('tab').attrs)).toEqual(['ext']);
    expect(invariants(inBody(text('a'), { type: 'tab' }, text('b')))).toEqual([]);
    expect(codes(inBody({ type: 'tab', attrs: { width: 720 } }))).toEqual(['unknown_attribute']);
  });
});

describe('the footnote content model (CDM-001)', () => {
  it('is paragraph+ in the definition and both generated schemas', () => {
    expect(node('footnote').content).toBe('paragraph+');
    expect(Object.fromEntries(generateProseMirrorSpec(CDM1).nodes)['footnote']!.content).toBe(
      'paragraph+',
    );
    const json = generateJsonSchema(CDM1)['$defs'] as Record<
      string,
      { properties: Record<string, Json> }
    >;
    expect(json['node.footnote']!.properties['content']).toMatchObject({
      minItems: 1,
      items: { anyOf: [{ $ref: '#/$defs/node.paragraph' }] },
    });
    expect(cdmSchema().nodes['footnote']!.spec.content).toBe('paragraph+');
  });
});

describe('footnotes of one paragraph (CDM-034)', () => {
  it('is an inline atom with a unique identifier holding exactly one paragraph', () => {
    expect(node('footnote')).toMatchObject({ inline: true, atom: true });
    expect(invariants(inBody(text('Text'), footnote('fnNote0000000001')))).toEqual([]);
    expect(
      codes(inBody(text('Text'), { type: 'footnote', content: [para('pNote00000000001')] })),
    ).toEqual(['missing_id']);
    expect(codes(inBody(footnote('pZ9y8X7w6V5u4T3s')))).toContain('duplicate_id');
    // Inline content directly in the footnote is the old draft and is refused (I1).
    expect(
      invariants(
        inBody({ type: 'footnote', attrs: { id: 'fnNote0000000001' }, content: [text('note')] }),
      ),
    ).toEqual(['I1']);
  });

  it('refuses a footnote with more than one paragraph (I1)', () => {
    const two = inBody(
      text('x'),
      footnote('fnNote0000000001', [para('pNote00000000001'), para('pNote00000000002')]),
    );
    expect(codes(two)).toEqual(['footnote_paragraphs']);
  });

  it('reports a footnote inside a footnote or inside a caption (I10)', () => {
    const nested = inBody(
      text('x'),
      footnote('fnOuter000000001', [
        para('pOuter0000000001', [text('y'), footnote('fnInner000000001')]),
      ]),
    );
    expect(codes(nested)).toEqual(['footnote_in_footnote']);
    expect(invariants(nested)).toEqual(['I10']);
    const d = exampleDoc();
    bodyOf(d).push({
      type: 'figure',
      attrs: {
        id: 'fgFigure00000001',
        asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
        width: 10,
        height: 10,
      },
      content: [{ type: 'caption', content: [text('x'), footnote('fnCaption0000001')] }],
    });
    expect(codes(d)).toContain('footnote_in_caption');
  });

  it('reports a page or column break or a table inside a footnote (I10)', () => {
    for (const kind of ['page', 'column'])
      expect(
        codes(
          inBody(
            footnote('fnNote0000000001', [
              para('pNote00000000001', [{ type: 'break', attrs: { kind } }]),
            ]),
          ),
        ),
        kind,
      ).toEqual(['break_in_container']);
    const t = inBody(
      footnote('fnNote0000000001', [
        para('pNote00000000001'),
        table('tTable0000000001', [1000], [row('rRow000000000001', [cell('cCell0000000000A')])]),
      ]),
    );
    expect(codes(t)).toContain('table_in_story_or_footnote');
  });

  it('refuses a form field in a footnote (I10; 12 §3.2)', () => {
    const d = inBody(
      footnote('fnNote0000000001', [
        para('pNote00000000001', [
          { type: 'form_field', attrs: { id: 'ffNote0000000001', key: 'a', label: 'A' } },
        ]),
      ]),
    );
    d['requires'] = ['fields'];
    expect(codes(d)).toEqual(['form_field_placement']);
  });
});

describe('page, date and title fields (CDM-035)', () => {
  it('is an atom with kind, format, target, name and cached, and kind takes eight values', () => {
    expect(node('field')).toMatchObject({ inline: true, atom: true });
    expect(Object.keys(node('field').attrs)).toEqual([
      'kind',
      'format',
      'target',
      'name',
      'cached',
      'preserved',
      'origin',
      'ext',
    ]);
    for (const kind of ['page', 'pageCount', 'date', 'title'])
      expect(invariants(inBody(field({ kind }))), kind).toEqual([]);
    expect(codes(inBody(field({ kind: 'time' })))).toEqual(['attribute_invalid']);
  });

  it('bounds format and cached by their grammars (I11)', () => {
    expect(
      invariants(inBody(field({ kind: 'date', format: 'dd/MM/yyyy', cached: '06/11/2026' }))),
    ).toEqual([]);
    for (const attrs of [
      { format: 'x'.repeat(65) },
      { format: 'yyyy{}' },
      { cached: 'x'.repeat(1025) },
      { cached: 'a\u0000' },
    ])
      expect(
        codes(inBody(field({ kind: 'date', ...attrs }))),
        JSON.stringify(attrs).slice(0, 30),
      ).toEqual(['attribute_invalid']);
  });

  it('ignores a stale cached text when it computes a field', () => {
    const f = { kind: 'title', cached: 'An old title' };
    expect(fieldText(f, { title: 'The contract' })).toEqual({
      computed: true,
      text: 'The contract',
    });
    const fv = { kind: 'formValue', target: 'field:tenant.name', cached: 'Old value' };
    expect(
      fieldText(fv, {
        fields: new Map([['tenant.name', { kind: 'text', value: 'Ada Lovelace' }]]),
      }),
    ).toEqual({ computed: true, text: 'Ada Lovelace' });
    const d = { kind: 'date', format: 'yyyy-MM-dd', cached: '1999-01-01' };
    expect(
      fieldText(d, { instant: '2026-11-06T23:30:00.000Z', timeZone: 'Europe/Berlin' }),
    ).toEqual({ computed: true, text: '2026-11-07' });
  });

  it('needs the time zone of the workflow or export job for a date, and has no default', () => {
    const d = { kind: 'date' };
    expect(fieldText(d, { instant: '2026-11-06T23:30:00.000Z' })).toMatchObject({
      computed: false,
    });
    expect(fieldText(d, { timeZone: 'Europe/Berlin' })).toMatchObject({ computed: false });
    // The same instant reads as two different dates in two zones, never in the client's.
    expect(
      fieldText(d, { instant: '2026-11-06T23:30:00.000Z', timeZone: 'America/New_York' }),
    ).toEqual({ computed: true, text: '2026-11-06' });
    expect(fieldText(d, { instant: '2026-11-06T23:30:00.000Z', timeZone: 'Asia/Tokyo' })).toEqual({
      computed: true,
      text: '2026-11-07',
    });
    expect(
      fieldText(d, { instant: '2026-11-06T23:30:00.000Z', timeZone: 'Not/AZone' }),
    ).toMatchObject({ computed: false });
  });

  it('does not compute page or pageCount: only the typesetter and the layout know them', () => {
    for (const kind of ['page', 'pageCount'])
      expect(fieldText({ kind, cached: '3' }), kind).toMatchObject({ computed: false });
  });

  it('accepts a field in the body, a region, a table cell, a caption and a story', () => {
    const d = exampleDoc();
    bodyOf(d)[1]!.content[0].content.push(field({ kind: 'page' }));
    bodyOf(d).push(
      table(
        'tTable0000000001',
        [1000],
        [
          row('rRow000000000001', [
            cell('cCell0000000000A', [para('pCell00000000001', [field({ kind: 'date' })])]),
          ]),
        ],
      ),
    );
    bodyOf(d).push({
      type: 'figure',
      attrs: {
        id: 'fgFigure00000001',
        asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
        width: 10,
        height: 10,
      },
      content: [{ type: 'caption', content: [field({ kind: 'seq', name: 'Figure' })] }],
    });
    d['doc'].content.splice(1, 0, {
      type: 'story',
      attrs: { id: 'sFooter000000001', kind: 'footer' },
      content: [para('pFooter000000001', [field({ kind: 'pageCount' })])],
    });
    bodyOf(d)[2]!.content = [field({ kind: 'title' })];
    expect(invariants(d)).toEqual([]);
  });
});

describe('cross-references, sequences and bookmarks (CDM-036)', () => {
  it('makes an anchor a zero-width atom with id and a unique name of its grammar', () => {
    expect(node('anchor')).toMatchObject({ inline: true, atom: true });
    expect(node('anchor').content).toBeUndefined();
    const anchor = (id: string, name: string): Json => ({ type: 'anchor', attrs: { id, name } });
    expect(invariants(inBody(anchor('aMark00000000001', 'clause_4'), text('x')))).toEqual([]);
    expect(codes(inBody(anchor('aMark00000000001', '4clause')))).toEqual(['attribute_invalid']);
    expect(
      codes(inBody(anchor('aMark00000000001', 'dup'), anchor('aMark00000000002', 'dup'))),
    ).toEqual(['duplicate_target_name']);
  });

  it('resolves a ref to a bookmark, a heading, a numbered paragraph, a caption or an equation label (I4)', () => {
    const d = addDefs(exampleDoc(), style('Caption', { builtIn: true, basedOn: 'Normal' }), {
      type: 'numbering_def',
      attrs: { id: 'numList', levels: [{ format: 'decimal', text: '%1.', start: 1 }] },
    });
    bodyOf(d).push(
      para('pNumbered0000001', 'item', {
        numbering: { numberingId: 'numList', level: 0, listId: 'lList00000000001' },
      }),
      para('pCaption00000001', [text('Table '), field({ kind: 'seq', name: 'Table' })], {
        style: 'Caption',
      }),
      {
        type: 'equation_block',
        attrs: { id: 'eqBlock000000001', latex: 'x', numbered: true, label: 'sum' },
      },
      para('pAnchor000000001', [
        { type: 'anchor', attrs: { id: 'aMark00000000001', name: 'here' } },
        text('here'),
      ]),
    );
    for (const target of [
      'bookmark:here',
      'node:p3Jq8sLw0aZx1VbN',
      'node:pNumbered0000001',
      'node:pCaption00000001',
      'eq:sum',
    ]) {
      const r = structuredClone(d);
      bodyOf(r)[2]!.content = [field({ kind: 'ref', target })];
      expect(invariants(r), target).toEqual([]);
    }
    for (const target of [
      'bookmark:nowhere',
      'node:pZ9y8X7w6V5u4T3s',
      'node:pNoSuchNode00001',
      'eq:none',
    ]) {
      const r = structuredClone(d);
      bodyOf(r)[2]!.content = [field({ kind: 'ref', target })];
      expect(codes(r), target).toEqual(['field_target_unresolved']);
    }
    // A plain paragraph is not a target, even when it exists (node:pZ9y… above).
  });

  it('refuses a target in a form its kind does not take, and a target where the kind takes none (I11)', () => {
    for (const attrs of [
      { kind: 'ref', target: 'style:Normal' },
      { kind: 'ref', target: 'field:a' },
      { kind: 'ref' },
      { kind: 'page', target: 'bookmark:x' },
      { kind: 'seq', name: 'Figure', target: 'eq:x' },
      { kind: 'date', name: 'Figure' },
    ])
      expect(codes(inBody(field(attrs))), JSON.stringify(attrs)).toEqual(['field_target_form']);
  });

  it('checks a styleRef target as a style in the form style:<id> (CDM-002)', () => {
    expect(invariants(inBody(field({ kind: 'styleRef', target: 'style:Heading1' })))).toEqual([]);
    expect(codes(inBody(field({ kind: 'styleRef', target: 'style:Missing' })))).toEqual([
      'field_target_unresolved',
    ]);
    expect(codes(inBody(field({ kind: 'styleRef', target: 'node:p3Jq8sLw0aZx1VbN' })))).toEqual([
      'field_target_form',
    ]);
    expect(codes(inBody(field({ kind: 'styleRef', target: 'style:bad name' })))).toEqual([
      'attribute_invalid',
    ]);
  });

  it('counts a seq field per name; one without a name counts in no sequence', () => {
    expect(
      invariants(
        inBody(
          field({ kind: 'seq', name: 'Figure' }),
          field({ kind: 'seq', name: 'Table' }),
          field({ kind: 'seq' }),
        ),
      ),
    ).toEqual([]);
    expect(codes(inBody(field({ kind: 'seq', name: '1st' })))).toEqual(['attribute_invalid']);
  });
});
