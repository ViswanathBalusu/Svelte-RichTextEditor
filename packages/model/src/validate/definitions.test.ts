// Definition nodes (03 §4.1): character and table styles (CDM-017), settings (CDM-018), numbering
// (CDM-019), page setups and sections (CDM-020), headers and footers (CDM-021).
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  codes,
  ctx,
  defsOf,
  exampleDoc,
  invariants,
  para,
  report,
  style,
  table,
  row,
  cell,
  type Json,
} from '../../test/support.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { validate } from './validate.ts';

const schema = cdmSchema();

/** The position of the definition with this id in the ProseMirror document. */
function posOfDef(doc: ReturnType<typeof schema.nodeFromJSON>, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found < 0 && n.attrs['id'] === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** Rebases `second` over `first` the way the authority does (04 §4) and applies both. */
function concurrent(doc: Json, first: AttrStep, second: AttrStep): Json {
  let pm = schema.nodeFromJSON(doc['doc']);
  const a = first.apply(pm);
  pm = a.doc!;
  const rebased = second.map(first.getMap());
  if (!rebased) throw new Error('the step was lost in rebasing');
  return { ...doc, doc: rebased.apply(pm).doc!.toJSON() };
}

describe('character and table styles (CDM-017)', () => {
  it('accepts the kinds paragraph, character and table and refuses any other (I11)', () => {
    for (const kind of ['paragraph', 'character', 'table'])
      expect(invariants(addDefs(exampleDoc(), style(`s${kind}`, { kind }))), kind).toEqual([]);
    expect(invariants(addDefs(exampleDoc(), style('sList', { kind: 'list' })))).toEqual(['I11']);
  });

  it('reports a charStyle mark or a table style that names nothing (I4)', () => {
    const marked = exampleDoc();
    bodyOf(marked)[0]!.content[0].marks = [{ type: 'charStyle', attrs: { style: 'Missing' } }];
    expect(codes(marked)).toEqual(['unresolved_reference']);
    const t = exampleDoc();
    bodyOf(t).push(
      table('tTable0000000001', [1000], [row('rRow000000000001', [cell('cCell00000000001')])], {
        style: 'Missing',
      }),
    );
    expect(codes(t)).toEqual(['unresolved_reference']);
  });

  it('refuses table properties on a style that is not a table style (I11)', () => {
    const props: Array<[string, unknown]> = [
      ['cellMargins', { top: 0, bottom: 0, left: 108, right: 108 }],
      ['headerRowShading', { fill: '#D9E2F3' }],
      ['bandedRows', true],
      ['borders', { insideH: { style: 'single' } }],
    ];
    for (const [name, value] of props) {
      for (const kind of ['paragraph', 'character'])
        expect(
          codes(addDefs(exampleDoc(), style('sStyle', { kind, [name]: value }))),
          `${kind} ${name}`,
        ).toEqual(['table_property']);
      expect(
        invariants(addDefs(exampleDoc(), style('sTable', { kind: 'table', [name]: value }))),
        `table ${name}`,
      ).toEqual([]);
    }
    // Paragraph borders stay a paragraph property.
    expect(
      invariants(addDefs(exampleDoc(), style('sBox', { borders: { top: { style: 'single' } } }))),
    ).toEqual([]);
  });

  it('keeps both of two concurrent changes to different properties, and the later of two to one', () => {
    const doc = exampleDoc();
    const pm = schema.nodeFromJSON(doc['doc']);
    const pos = posOfDef(pm, 'Normal');
    const both = concurrent(
      doc,
      new AttrStep(pos, 'color', '#C00000'),
      new AttrStep(pos, 'fontSize', 240),
    );
    const normal = (d: Json) => defsOf(d)[1]!.attrs;
    expect(normal(both)).toMatchObject({ color: '#C00000', fontSize: 240 });
    const same = concurrent(
      doc,
      new AttrStep(pos, 'color', '#C00000'),
      new AttrStep(pos, 'color', '#00B050'),
    );
    expect(normal(same).color).toBe('#00B050');
    expect(validate(both, ctx).valid && validate(same, ctx).valid).toBe(true);
  });

  it('reports a cycle or a chain of eleven among character and table styles (I5)', () => {
    for (const kind of ['character', 'table']) {
      const cycle = addDefs(
        exampleDoc(),
        style('sA', { kind, basedOn: 'sB' }),
        style('sB', { kind, basedOn: 'sA' }),
      );
      expect(codes(cycle), kind).toEqual(['style_chain_cycle']);
      const chain = (n: number) =>
        addDefs(
          exampleDoc(),
          ...Array.from({ length: n }, (_, i) =>
            style(`s${i}`, { kind, ...(i ? { basedOn: `s${i - 1}` } : {}) }),
          ),
        );
      expect(invariants(chain(10)), `${kind} 10`).toEqual([]);
      expect(codes(chain(11)), `${kind} 11`).toEqual(['style_chain_too_deep']);
    }
  });

  it('reports the deletion of a style that a mark or a table still uses (I4)', () => {
    const d = addDefs(
      exampleDoc(),
      style('cEmphasis', { kind: 'character', italic: true }),
      style('tPlain', { kind: 'table' }),
    );
    bodyOf(d)[0]!.content[0].marks = [{ type: 'charStyle', attrs: { style: 'cEmphasis' } }];
    bodyOf(d).push(
      table('tTable0000000001', [1000], [row('rRow000000000001', [cell('cCell00000000001')])], {
        style: 'tPlain',
      }),
    );
    expect(invariants(d)).toEqual([]);
    for (const id of ['cEmphasis', 'tPlain']) {
      const deleted = structuredClone(d);
      const list = defsOf(deleted);
      list.splice(
        list.findIndex((n) => n.attrs?.id === id),
        1,
      );
      expect(codes(deleted), id).toEqual(['unresolved_reference']);
    }
  });
});

describe('settings (CDM-018)', () => {
  it('holds exactly one settings node first, then the definitions in the order of 03 §4.1 (I1)', () => {
    const none = exampleDoc();
    defsOf(none).shift();
    expect(invariants(none)).toContain('I1');
    const two = exampleDoc();
    defsOf(two).unshift({ type: 'settings' });
    expect(invariants(two)).toContain('I1');
    const order = exampleDoc();
    const list = defsOf(order);
    list.push(list.splice(1, 1)[0]!); // a style after the page setup
    expect(invariants(order)).toContain('I1');
    // Roles and rules come after the page setups, sources last.
    const late = addDefs(exampleDoc(), {
      type: 'source_def',
      attrs: { id: 'srcBook', title: 'A book' },
    });
    expect(invariants(late)).toEqual([]);
  });

  it('accepts the values of dir, footnoteRestart and trackChanges and refuses others (I11)', () => {
    const cases: Array<[string, string[], string]> = [
      ['dir', ['ltr', 'rtl'], 'ttb'],
      ['footnoteRestart', ['continuous', 'perPageSection'], 'perPage'],
      ['trackChanges', ['off', 'everyone'], 'authors'],
    ];
    for (const [name, good, bad] of cases) {
      for (const value of good) {
        const d = exampleDoc();
        defsOf(d)[0]!.attrs[name] = value;
        expect(invariants(d), `${name} ${value}`).toEqual([]);
      }
      const d = exampleDoc();
      defsOf(d)[0]!.attrs[name] = bad;
      expect(codes(d), `${name} ${bad}`).toEqual(['attribute_invalid']);
    }
  });

  it('resolves defaultParagraphStyle to a paragraph style and types defaultTabStop and hyphenation', () => {
    const missing = exampleDoc();
    defsOf(missing)[0]!.attrs.defaultParagraphStyle = 'Missing';
    expect(codes(missing)).toEqual(['unresolved_reference']);
    const wrongKind = addDefs(exampleDoc(), style('cStrong', { kind: 'character' }));
    defsOf(wrongKind)[0]!.attrs.defaultParagraphStyle = 'cStrong';
    expect(codes(wrongKind)).toEqual(['wrong_reference_kind']);
    for (const bad of [0, -720, 720.5, '720']) {
      const d = exampleDoc();
      defsOf(d)[0]!.attrs.defaultTabStop = bad;
      expect(invariants(d), String(bad)).toContain('I11');
    }
    const hyphen = exampleDoc();
    defsOf(hyphen)[0]!.attrs.hyphenation = 'yes';
    expect(invariants(hyphen)).toContain('I11');
  });

  it('checks lang as BCP 47 and footnoteFormat against its values (CDM-002)', () => {
    for (const [name, good, bad] of [
      ['lang', 'de-CH', 'de_CH'],
      ['lang', 'zh-Hant-TW', 'en-'],
      ['footnoteFormat', 'symbol', 'roman'],
    ] as const) {
      const ok = exampleDoc();
      defsOf(ok)[0]!.attrs[name] = good;
      expect(invariants(ok), good).toEqual([]);
      const no = exampleDoc();
      defsOf(no)[0]!.attrs[name] = bad;
      expect(codes(no), bad).toEqual(['attribute_invalid']);
    }
  });
});

const level = (extra: Json = {}): Json => ({ format: 'decimal', text: '%1.', start: 1, ...extra });
const numbering = (id: string, levels: Json[]): Json => ({
  type: 'numbering_def',
  attrs: { id, levels },
});

describe('numbering definitions (CDM-019)', () => {
  it('holds one to nine levels (I11)', () => {
    for (const n of [1, 9])
      expect(
        invariants(
          addDefs(
            exampleDoc(),
            numbering(
              'num1',
              Array.from({ length: n }, () => level()),
            ),
          ),
        ),
        String(n),
      ).toEqual([]);
    for (const n of [0, 10])
      expect(
        codes(
          addDefs(
            exampleDoc(),
            numbering(
              'num1',
              Array.from({ length: n }, () => level()),
            ),
          ),
        ),
        String(n),
      ).toEqual(['attribute_invalid']);
    const absent = addDefs(exampleDoc(), { type: 'numbering_def', attrs: { id: 'num1' } });
    expect(codes(absent)).toEqual(['attribute_missing']);
  });

  it('accepts the seven level formats and refuses any other', () => {
    for (const format of [
      'decimal',
      'lowerLetter',
      'upperLetter',
      'lowerRoman',
      'upperRoman',
      'bullet',
      'none',
    ])
      expect(
        invariants(addDefs(exampleDoc(), numbering('num1', [level({ format })]))),
        format,
      ).toEqual([]);
    expect(codes(addDefs(exampleDoc(), numbering('num1', [level({ format: 'ordinal' })])))).toEqual(
      ['attribute_invalid'],
    );
  });

  it('accepts templates of %1 to %9 and literal text, and refuses a stray percent sign, controls and TeX specials (owner decision 240)', () => {
    for (const text of [
      '%1.',
      '(%1)',
      '%1.%2.%3',
      '§ %1',
      '%1-%2',
      '',
      'Article %1',
      'NEW-%1-FORMAT',
      '第%1条',
      '%1:',
    ])
      expect(invariants(addDefs(exampleDoc(), numbering('num1', [level({ text })]))), text).toEqual(
        [],
      );
    for (const text of [
      '%0',
      '%a',
      '%',
      '%1\\',
      '{%1}',
      '%%1',
      '100%',
      '%1‮',
      '%1\u0007',
      'a'.repeat(65),
    ])
      expect(codes(addDefs(exampleDoc(), numbering('num1', [level({ text })]))), text).toEqual([
        'attribute_invalid',
      ]);
  });

  it('accepts a bullet character from the published list only', () => {
    for (const bulletChar of ['•', '◦', '–', '✓'])
      expect(
        invariants(
          addDefs(exampleDoc(), numbering('num1', [level({ format: 'bullet', bulletChar })])),
        ),
        bulletChar,
      ).toEqual([]);
    for (const bulletChar of ['☃', 'ab', '>'])
      expect(
        codes(addDefs(exampleDoc(), numbering('num1', [level({ format: 'bullet', bulletChar })]))),
        bulletChar,
      ).toEqual(['attribute_invalid']);
  });

  it('types start, restartAfter, legal, indents, align and runProps, with lengths in twips', () => {
    const good = level({
      start: 0,
      restartAfter: 0,
      legal: true,
      indentLeft: -360,
      hanging: 360,
      align: 'end',
      runProps: { bold: true, fontSize: 220 },
    });
    expect(invariants(addDefs(exampleDoc(), numbering('num1', [good])))).toEqual([]);
    const bad: Json[] = [
      level({ start: -1 }),
      level({ restartAfter: 9 }),
      level({ legal: 'yes' }),
      level({ indentLeft: 720.5 }),
      level({ hanging: -1 }),
      level({ align: 'left' }),
      level({ runProps: { fontSize: 10.5 } }),
      level({ runProps: { colour: '#000000' } }),
    ];
    for (const l of bad)
      expect(codes(addDefs(exampleDoc(), numbering('num1', [l]))), JSON.stringify(l)).toEqual([
        'attribute_invalid',
      ]);
  });

  it('resolves numberingId from a paragraph or a style, and refuses deleting a definition in use (I4)', () => {
    const d = addDefs(exampleDoc(), numbering('num1', [level()]));
    bodyOf(d)[2]!.attrs.numbering = { numberingId: 'num1', level: 0, listId: 'lList00000000001' };
    defsOf(d)[2]!.attrs.numbering = { numberingId: 'num1', level: 0, listId: 'lHeads0000000001' };
    expect(invariants(d)).toEqual([]);
    const deleted = structuredClone(d);
    defsOf(deleted).splice(
      defsOf(deleted).findIndex((n) => n.type === 'numbering_def'),
      1,
    );
    expect(codes(deleted)).toEqual(['unresolved_reference']);
    expect(report(deleted).violations).toHaveLength(2);
  });

  it('resolves two concurrent edits of one definition to the later as a whole, and keeps different ones apart', () => {
    const doc = addDefs(exampleDoc(), numbering('num1', [level()]), numbering('num2', [level()]));
    const pm = schema.nodeFromJSON(doc['doc']);
    const one = posOfDef(pm, 'num1');
    const two = posOfDef(pm, 'num2');
    const a = [level({ format: 'upperRoman' }), level({ text: '%1.%2' })];
    const b = [level({ format: 'lowerLetter' })];
    const same = concurrent(doc, new AttrStep(one, 'levels', a), new AttrStep(one, 'levels', b));
    const def = (d: Json, id: string) => defsOf(d).find((n) => n.attrs?.id === id)!.attrs.levels;
    expect(def(same, 'num1')).toEqual(b);
    const apart = concurrent(doc, new AttrStep(one, 'levels', a), new AttrStep(two, 'levels', b));
    expect(def(apart, 'num1')).toEqual(a);
    expect(def(apart, 'num2')).toEqual(b);
  });
});

describe('page setups and sections (CDM-020)', () => {
  it('needs a page setup in defs, and the body names one (I1, I4)', () => {
    const none = exampleDoc();
    defsOf(none).splice(
      defsOf(none).findIndex((n) => n.type === 'page_setup'),
      1,
    );
    expect(invariants(none)).toEqual(expect.arrayContaining(['I1']));
    const body = exampleDoc();
    body['doc'].content[1].attrs.pageSetup = 'psMissing';
    expect(codes(body)).toEqual(['unresolved_reference']);
  });

  it('types the lengths as twips and columns as a positive integer (I11)', () => {
    const a4 = exampleDoc();
    Object.assign(defsOf(a4)[3]!.attrs, {
      width: 11906,
      height: 16838,
      gutter: 0,
      headerDistance: 708,
      footerDistance: 708,
      columnGap: 720,
      columns: 2,
    });
    expect(invariants(a4)).toEqual([]);
    for (const [name, bad] of [
      ['width', 11906.5],
      ['height', 0],
      ['marginTop', -1],
      ['gutter', '0'],
      ['headerDistance', 40000],
      ['columnGap', 1.5],
      ['columns', 0],
      ['columns', 17],
    ] as const) {
      const d = exampleDoc();
      defsOf(d)[3]!.attrs[name] = bad;
      expect(invariants(d), `${name} ${bad}`).toContain('I11');
    }
  });

  it('resolves header and footer slots to stories of the right kind (I4)', () => {
    const d = exampleDoc();
    d['doc'].content.splice(1, 0, {
      type: 'story',
      attrs: { id: 'sHeader000000001', kind: 'header' },
      content: [para('pHeader000000001')],
    });
    defsOf(d)[3]!.attrs.headerDefault = 'sHeader000000001';
    expect(invariants(d)).toEqual([]);
    const missing = structuredClone(d);
    defsOf(missing)[3]!.attrs.headerFirst = 'sMissing00000001';
    expect(codes(missing)).toEqual(['unresolved_reference']);
    const wrong = structuredClone(d);
    defsOf(wrong)[3]!.attrs.footerDefault = 'sHeader000000001';
    expect(codes(wrong)).toEqual(['wrong_reference_kind']);
  });

  it('types orientation, the first and even page flags, page numbering and the watermark', () => {
    const ok = exampleDoc();
    Object.assign(defsOf(ok)[3]!.attrs, {
      orientation: 'landscape',
      differentFirstPage: true,
      differentOddEven: true,
      pageNumberStart: 1,
      pageNumberFormat: 'upperRoman',
      watermark: 'DRAFT',
    });
    expect(invariants(ok)).toEqual([]);
    const nullMark = exampleDoc();
    defsOf(nullMark)[3]!.attrs.watermark = null;
    expect(invariants(nullMark)).toEqual([]);
    for (const [name, bad] of [
      ['orientation', 'sideways'],
      ['differentFirstPage', 1],
      ['pageNumberStart', -1],
      ['pageNumberFormat', 'arabic'],
      ['watermark', 'x'.repeat(256)],
      ['watermark', 12],
    ] as const) {
      const d = exampleDoc();
      defsOf(d)[3]!.attrs[name] = bad;
      expect(invariants(d), `${name} ${String(bad)}`).toContain('I11');
    }
  });

  it('types a section break and keeps it a direct child of the body (I3, I4, I11)', () => {
    const brk = (attrs: Json = {}): Json => ({
      type: 'section_break',
      attrs: { id: 'sbBreak000000001', pageSetup: 'ps1', ...attrs },
    });
    for (const start of ['nextPage', 'continuous', 'evenPage', 'oddPage']) {
      const d = exampleDoc();
      bodyOf(d).splice(1, 0, brk({ start }));
      expect(invariants(d), start).toEqual([]);
    }
    const start = exampleDoc();
    bodyOf(start).splice(1, 0, brk({ start: 'nextColumn' }));
    expect(codes(start)).toEqual(['attribute_invalid']);
    const unresolved = exampleDoc();
    bodyOf(unresolved).splice(1, 0, brk({ pageSetup: 'psNone' }));
    expect(codes(unresolved)).toEqual(['unresolved_reference']);
    const inRegion = exampleDoc();
    bodyOf(inRegion)[1]!.content.push(brk());
    expect(codes(inRegion)).toContain('misplaced_container');
    const inCell = exampleDoc();
    bodyOf(inCell).push(
      table(
        'tTable0000000001',
        [1000],
        [row('rRow000000000001', [cell('cCell00000000001', [para('pInCell000000001'), brk()])])],
      ),
    );
    expect(codes(inCell)).toContain('misplaced_container');
    const inStory = exampleDoc();
    inStory['doc'].content.splice(1, 0, {
      type: 'story',
      attrs: { id: 'sHeader000000001', kind: 'header' },
      content: [para('pHeader000000001'), brk()],
    });
    expect(codes(inStory)).toContain('misplaced_container');
  });

  it('refuses deleting a page setup that the body or a section still uses (I4)', () => {
    const d = addDefs(exampleDoc(), {
      type: 'page_setup',
      attrs: { id: 'psLandscape', orientation: 'landscape' },
    });
    bodyOf(d).splice(1, 0, {
      type: 'section_break',
      attrs: { id: 'sbBreak000000001', pageSetup: 'psLandscape' },
    });
    expect(invariants(d)).toEqual([]);
    for (const id of ['psLandscape', 'ps1']) {
      const deleted = structuredClone(d);
      defsOf(deleted).splice(
        defsOf(deleted).findIndex((n) => n.attrs?.id === id),
        1,
      );
      expect(codes(deleted), id).toEqual(['unresolved_reference']);
    }
  });
});

describe('headers and footers (CDM-021)', () => {
  const story = (attrs: Json, content: Json[] = [para('pStory0000000001')]): Json => ({
    type: 'story',
    attrs,
    content,
  });
  const withStory = (s: Json): Json => {
    const d = exampleDoc();
    d['doc'].content.splice(1, 0, s);
    return d;
  };

  it('has a kind of header or footer, one or more blocks, and a unique identifier (I1, I2, I11)', () => {
    expect(invariants(withStory(story({ id: 'sFooter000000001', kind: 'footer' })))).toEqual([]);
    expect(codes(withStory(story({ id: 'sStory0000000001', kind: 'sidebar' })))).toEqual([
      'attribute_invalid',
    ]);
    expect(invariants(withStory(story({ id: 'sStory0000000001', kind: 'header' }, [])))).toContain(
      'I1',
    );
    expect(codes(withStory(story({ kind: 'header' })))).toEqual(['missing_id']);
    expect(codes(withStory(story({ id: 'pZ9y8X7w6V5u4T3s', kind: 'header' })))).toEqual([
      'duplicate_id',
    ]);
  });

  it('refuses a table in a story (I10)', () => {
    const d = withStory(
      story({ id: 'sStory0000000001', kind: 'header' }, [
        table('tTable0000000001', [1000], [row('rRow000000000001', [cell('cCell00000000001')])]),
      ]),
    );
    expect(codes(d)).toContain('table_in_story_or_footnote');
    expect(invariants(d)).toContain('I10');
  });

  it('refuses deleting a story a page setup still names (I4)', () => {
    const d = withStory(story({ id: 'sFooter000000001', kind: 'footer' }));
    defsOf(d)[3]!.attrs.footerDefault = 'sFooter000000001';
    expect(invariants(d)).toEqual([]);
    d['doc'].content.splice(1, 1);
    expect(codes(d)).toEqual(['unresolved_reference']);
  });

  it('accepts page and page count fields in a story', () => {
    const fields = [
      para('pStory0000000001', [
        { type: 'field', attrs: { kind: 'page' } },
        { type: 'text', text: ' of ' },
        { type: 'field', attrs: { kind: 'pageCount' } },
      ]),
    ];
    expect(
      invariants(withStory(story({ id: 'sFooter000000001', kind: 'footer' }, fields))),
    ).toEqual([]);
  });
});
