import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
import { CDM1 } from '../definition/cdm1.ts';
import { validate, type InvariantId, type ValidationContext } from './validate.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const clone = (): Json => structuredClone(example) as Json;
const ASSET = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const ctx: ValidationContext = {
  attachedAssets: new Set([ASSET]),
  retiredRegionIds: new Set(['rRetiredRegion01']),
  mathGate: () => null,
};

function body(doc: Json): Json[] {
  return doc['doc'].content[1].content;
}
function defs(doc: Json): Json[] {
  return doc['doc'].content[0].content;
}
function invariants(doc: unknown, c: ValidationContext = ctx): InvariantId[] {
  return [...new Set(validate(doc, c).violations.map((v) => v.invariant))];
}

const para = (id: string, text = 'x', attrs: Json = {}): Json => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content: [{ type: 'text', text }],
});
const cell = (id: string, attrs: Json = {}): Json => ({
  type: 'table_cell',
  attrs: { id, ...attrs },
  content: [para(`${id.slice(0, 15)}P`)],
});

describe('model.validate()', () => {
  it('accepts the example of 03 §12', () => {
    const r = validate(example, ctx);
    expect(r.violations).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('reports what the context did not let it check', () => {
    const r = validate(example);
    expect(r.valid).toBe(true);
    expect(r.notChecked.join(' ')).toMatch(/I4.*I8.*I3/s);
  });

  it('I1: refuses extra envelope members, unknown types and missing features', () => {
    const a = clone();
    a['title'] = 'My document';
    expect(invariants(a)).toContain('I1');

    const b = clone();
    body(b).push({ type: 'comment', attrs: { id: 'cCommentNode0001' } });
    expect(invariants(b)).toContain('I1');

    const c = clone();
    body(c)[0]!.content.push({
      type: 'form_field',
      attrs: { id: 'fFieldNode000001', key: 'a', label: 'A' },
    });
    expect(
      validate(c, ctx).violations.some(
        (v) => v.invariant === 'I1' && /feature "fields"/.test(v.message),
      ),
    ).toBe(true);
    c['requires'] = ['fields'];
    expect(validate(c, ctx).valid).toBe(true);
  });

  it('I1: checks content expressions through the ProseMirror schema', () => {
    const d = clone();
    d['doc'].content[1].content = [];
    expect(invariants(d)).toContain('I1');
    const e = clone();
    body(e).unshift({
      type: 'region',
      attrs: { id: 'rOuterRegion0001' },
      content: [
        { type: 'region', attrs: { id: 'rInnerRegion0001' }, content: [para('pInsideNested001')] },
      ],
    });
    expect(invariants(e)).toContain('I1');
  });

  it('I1: preserved content needs the `preserve` feature', () => {
    const d = clone();
    body(d).push({
      type: 'preserved_block',
      attrs: { id: 'bPreserved000001', label: 'chart', fragment: ASSET },
    });
    expect(invariants(d)).toContain('I1');
    d['requires'] = ['preserve'];
    expect(validate(d, ctx).valid).toBe(true);

    const e = clone();
    body(e)[0]!.attrs.preserved = {
      children: [
        {
          name: 'w:cnfStyle',
          attrs: {
            'w:val': '100000000000',
          },
        },
      ],
    };
    expect(invariants(e)).toEqual(['I1']);
    e['requires'] = ['preserve'];
    expect(validate(e, ctx).valid).toBe(true);
  });

  it('I1: node marks only on paragraphs, rows and tables', () => {
    const d = clone();
    body(d)[1]!.marks = [{ type: 'ins', attrs: { id: 'sSuggestion00001', user: 'u1' } }];
    expect(invariants(d)).toContain('I1');
    const e = clone();
    body(e)[0]!.marks = [{ type: 'ins', attrs: { id: 'sSuggestion00001', user: 'u1' } }];
    expect(validate(e, ctx).valid).toBe(true);
  });

  it('I2: identifiers present and unique', () => {
    const d = clone();
    body(d)[2]!.attrs.id = 'p3Jq8sLw0aZx1VbN';
    expect(invariants(d)).toEqual(['I2']);
    const e = clone();
    delete body(e)[2]!.attrs.id;
    expect(invariants(e)).toEqual(['I2']);
  });

  it('I3: a removed region identifier is not reused', () => {
    const d = clone();
    body(d)[1]!.attrs.id = 'rRetiredRegion01';
    expect(invariants(d)).toEqual(['I3']);
  });

  it('I4: references resolve to definitions of the right kind, assets are attached', () => {
    const a = clone();
    body(a)[0]!.attrs.style = 'Missing';
    expect(invariants(a)).toEqual(['I4']);
    const b = clone();
    defs(b).splice(3, 0, {
      type: 'style_def',
      attrs: { id: 'cStrongish', kind: 'character', name: 'Strongish' },
    });
    body(b)[0]!.attrs.style = 'cStrongish';
    expect(invariants(b)).toEqual(['I4']);
    const c = clone();
    body(c).push({
      type: 'figure',
      attrs: {
        id: 'fFigureNode00001',
        asset: '0192f0c4-7b1e-7c3a-9a54-000000000000',
        width: 100,
        height: 100,
      },
    });
    expect(invariants(c)).toEqual(['I4']);
    const d = clone();
    body(d)[0]!.content.push({ type: 'field', attrs: { kind: 'ref', target: 'bookmark:Nowhere' } });
    expect(invariants(d)).toEqual(['I4']);
    body(d)[0]!.content.push({
      type: 'anchor',
      attrs: { id: 'aAnchorNode00001', name: 'Nowhere' },
    });
    expect(validate(d, ctx).valid).toBe(true);
  });

  it('I5: basedOn chains have no cycle and at most ten styles', () => {
    const d = clone();
    defs(d)[1]!.attrs.basedOn = 'Heading1';
    expect(invariants(d)).toEqual(['I5']);
    const e = clone();
    for (let i = 0; i < 11; i++)
      defs(e).splice(3, 0, {
        type: 'style_def',
        attrs: { id: `s${i}`, name: `S${i}`, basedOn: i ? `s${i - 1}` : 'Normal' },
      });
    expect(invariants(e)).toEqual(['I5']);
  });

  it('I6: column spans add up to the grid, row spans included', () => {
    const table = (rows: Json[][], grid: number[]): Json => ({
      type: 'table',
      attrs: { id: 'tTableNode000001', grid },
      content: rows.map((cells, r) => ({
        type: 'table_row',
        attrs: { id: `rRowNode0000000${r}` },
        content: cells,
      })),
    });
    const ok = clone();
    body(ok).push(
      table(
        [
          [cell('cCellA000000000A', { rowspan: 2 }), cell('cCellB000000000B')],
          [cell('cCellC000000000C')],
        ],
        [1000, 1000],
      ),
    );
    expect(validate(ok, ctx).violations).toEqual([]);
    const bad = clone();
    body(bad).push(
      table(
        [[cell('cCellA000000000A'), cell('cCellB000000000B')], [cell('cCellC000000000C')]],
        [1000, 1000],
      ),
    );
    expect(invariants(bad)).toEqual(['I6']);
    const past = clone();
    body(past).push(
      table(
        [
          [cell('cCellA000000000A', { rowspan: 3 }), cell('cCellB000000000B')],
          [cell('cCellC000000000C')],
        ],
        [1000, 1000],
      ),
    );
    expect(invariants(past)).toEqual(['I6']);
  });

  it('I7: regions are limited', () => {
    const d = clone();
    for (let i = 0; i < 501; i++)
      body(d).push({
        type: 'region',
        attrs: { id: `r${String(i).padStart(15, '0')}` },
        content: [para(`p${String(i).padStart(15, '0')}`)],
      });
    expect(invariants(d)).toContain('I7');
  });

  it('I8: LaTeX passes the math gate', () => {
    const d = clone();
    body(d).push({
      type: 'equation_block',
      attrs: { id: 'eEquation0000001', latex: '\\input{/etc/passwd}' },
    });
    expect(
      invariants(d, {
        ...ctx,
        mathGate: (l: string) => (l.includes('\\input') ? 'command \\input is not allowed' : null),
      }),
    ).toEqual(['I8']);
  });

  it('I9 and I11: attribute grammars, link schemes included', () => {
    const a = clone();
    body(a)[0]!.content[0].marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }];
    expect(invariants(a)).toEqual(['I9']);
    const b = clone();
    defs(b)[1]!.attrs.fontSize = 220.5;
    expect(invariants(b)).toEqual(['I11']);
    const c = clone();
    defs(c)[1]!.attrs.color = '#ff0000';
    expect(invariants(c)).toEqual(['I11']);
    const d = clone();
    defs(d)[1]!.attrs.fontFamily = 'Noto}\\input{x';
    expect(invariants(d)).toEqual(['I11']);
    const e = clone();
    body(e)[1]!.attrs.title = 'x'.repeat(256);
    expect(invariants(e)).toEqual(['I11']);
  });

  it('I10: forbidden combinations', () => {
    const d = clone();
    body(d).push({
      type: 'table',
      attrs: { id: 'tTableNode000001', grid: [1000] },
      content: [
        {
          type: 'table_row',
          attrs: { id: 'rRowNode00000001' },
          content: [
            {
              type: 'table_cell',
              attrs: { id: 'cCellNode0000001' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'pInCell000000001' },
                  content: [{ type: 'break', attrs: { kind: 'page' } }],
                },
                {
                  type: 'figure',
                  attrs: {
                    id: 'fFigureNode00001',
                    asset: ASSET,
                    width: 10,
                    height: 10,
                    placement: 'float',
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const found = validate(d, ctx).violations.filter((v) => v.invariant === 'I10');
    expect(found).toHaveLength(2);
  });

  it('I13 and I15: field keys are unique and values typed by kind', () => {
    const d = clone();
    d['requires'] = ['fields'];
    defs(d).push({
      type: 'role_def',
      attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' },
    });
    body(d)[2]!.content = [
      {
        type: 'form_field',
        attrs: {
          id: 'fField0000000001',
          key: 'tenant.income',
          kind: 'number',
          label: 'Income',
          assignee: 'role_tenant',
          value: '1200.50',
        },
      },
      {
        type: 'form_field',
        attrs: {
          id: 'fField0000000002',
          key: 'tenant.income',
          kind: 'number',
          label: 'Income again',
          value: 1200.5,
        },
      },
    ];
    const r = validate(d, ctx).violations.map((v) => v.invariant);
    expect(r).toContain('I13');
    // A JSON number in a number field is a value of the wrong type (I15), not a grammar problem.
    expect(r).toContain('I15');
    expect(r).not.toContain('I11');
  });
});

/** Assets attached to the kitchen-sink fixture. */
const SINK_ASSETS = new Set([
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
]);
const sinkCtx: ValidationContext = { ...ctx, attachedAssets: SINK_ASSETS };
const sink = (): Json => structuredClone(kitchenSink) as Json;
const region = (id: string, content: Json[] = [para(`p${id.slice(1)}`)]): Json => ({
  type: 'region',
  attrs: { id },
  content,
});

describe('model.validate(): document structure and regions (CDM-024)', () => {
  it('accepts the kitchen-sink fixture, which uses every feature', () => {
    expect(validate(kitchenSink, sinkCtx).violations).toEqual([]);
  });

  it('I1: doc holds defs, then stories, then exactly one body; the body is not empty', () => {
    const swapped = clone();
    swapped['doc'].content.reverse();
    expect(invariants(swapped)).toContain('I1');
    const twoBodies = clone();
    twoBodies['doc'].content.push(structuredClone(twoBodies['doc'].content[1]));
    expect(invariants(twoBodies)).toContain('I1');
    const storyAfterBody = clone();
    storyAfterBody['doc'].content.push({
      type: 'story',
      attrs: { id: 'sLateStory000001', kind: 'header' },
      content: [para('pInStory00000001')],
    });
    expect(invariants(storyAfterBody)).toContain('I1');
    const noBody = clone();
    noBody['doc'].content.pop();
    expect(invariants(noBody)).toContain('I1');
  });

  it('a region has id, title and policy, holds blocks, and carries no grants, states or leases', () => {
    const def = CDM1.nodes.find((n) => n.name === 'region')!;
    // `ext` is on every node (03 §4, §11.2) and `preserved` on block-level nodes (03 §4.6).
    expect(Object.keys(def.attrs)).toEqual(['id', 'title', 'policy', 'preserved', 'ext']);
    expect(def.content).toBe('block+');
    for (const extra of ['grants', 'state', 'lease']) {
      const d = clone();
      body(d)[1]!.attrs[extra] = 'x';
      expect(invariants(d), extra).toContain('I1');
    }
    const policy = clone();
    body(policy)[1]!.attrs.policy = 'secret';
    expect(invariants(policy)).toEqual(['I11']);
    const empty = clone();
    body(empty)[1]!.content = [];
    expect(invariants(empty)).toContain('I1');
  });

  it('I3: a region is only a direct child of the body, and regions do not nest', () => {
    const nested = clone();
    body(nested)[1]!.content.push(region('rNestedRegion001'));
    const v = validate(nested, ctx).violations.filter((x) => x.invariant === 'I3');
    expect(v).toEqual([
      {
        invariant: 'I3',
        code: 'nested_region',
        path: '/doc/content/1/content/1/content/1',
        nodeId: 'rNestedRegion001',
        message: 'regions do not nest',
      },
    ]);

    const inCell = sink();
    const table = inCell['doc'].content[3].content[3].content[1];
    table.content[1].content[0].content.push(region('rRegionInCell001'));
    expect(invariants(inCell, sinkCtx)).toContain('I3');

    const inStory = sink();
    inStory['doc'].content[1].content.push(region('rRegionInStory01'));
    expect(invariants(inStory, sinkCtx)).toContain('I3');
  });

  it('I3: a section break inside a region is refused', () => {
    const d = clone();
    body(d)[1]!.content.push({
      type: 'section_break',
      attrs: { id: 'sbInRegion000001', pageSetup: 'ps1' },
    });
    expect(invariants(d)).toContain('I3');
  });

  it('I7: 500 regions pass and 501 do not', () => {
    const at = (n: number): Json => {
      const d = clone();
      for (let i = 0; i < n; i++) body(d).push(region(`r${String(i).padStart(15, '0')}`));
      return d;
    };
    expect(validate(at(499), ctx).violations).toEqual([]); // the example already has one
    expect(invariants(at(500))).toEqual(['I7']);
  });

  it('I2: two regions with one identifier are refused; I3: a retired identifier is refused', () => {
    const d = clone();
    body(d).push(region('rG7mK2pQ9xYt4HcD'));
    expect(invariants(d)).toEqual(['I2']);
    const retired = clone();
    body(retired).push(region('rRetiredRegion01'));
    expect(invariants(retired)).toEqual(['I3']);
  });
});

describe('model.validate(): references, limits and hostile input (CDM-013, CDM-016)', () => {
  it('I4: basedOn, next and pageSetup must resolve, and a referenced definition cannot go', () => {
    const basedOn = clone();
    defs(basedOn)[2]!.attrs.basedOn = 'Missing';
    expect(invariants(basedOn)).toEqual(['I4']);
    const next = clone();
    defs(next)[2]!.attrs.next = 'Missing';
    expect(invariants(next)).toEqual(['I4']);
    const pageSetup = clone();
    pageSetup['doc'].content[1].attrs.pageSetup = 'psMissing';
    expect(invariants(pageSetup)).toEqual(['I4']);
    const section = clone();
    body(section).push({
      type: 'section_break',
      attrs: { id: 'sbBreak000000001', pageSetup: 'x' },
    });
    expect(invariants(section)).toEqual(['I4']);
    // Deleting Heading1 while the first paragraph uses it leaves a dangling reference.
    const deleted = clone();
    defs(deleted).splice(2, 1);
    expect(invariants(deleted)).toEqual(['I4']);
  });

  it('I5: a basedOn chain of ten styles passes and one of eleven does not', () => {
    const chain = (n: number): Json => {
      const d = clone();
      // Normal is the root; s1 to s(n-1) each build on the one before.
      for (let i = 1; i < n; i++)
        defs(d).splice(3, 0, {
          type: 'style_def',
          attrs: { id: `s${i}`, name: `S${i}`, basedOn: i === 1 ? 'Normal' : `s${i - 1}` },
        });
      return d;
    };
    expect(validate(chain(10), ctx).violations).toEqual([]);
    expect(invariants(chain(11))).toEqual(['I5']);
  });

  it('I11: outlineLevel is 1 to 9 or null', () => {
    for (const ok of [1, 9, null]) {
      const d = clone();
      defs(d)[2]!.attrs.outlineLevel = ok;
      expect(validate(d, ctx).violations, String(ok)).toEqual([]);
    }
    for (const bad of [0, 10, 1.5]) {
      const d = clone();
      defs(d)[2]!.attrs.outlineLevel = bad;
      expect(invariants(d), String(bad)).toEqual(['I11']);
    }
    // A value of the wrong JSON type also fails the schema's own type check (I1).
    const text = clone();
    defs(text)[2]!.attrs.outlineLevel = '1';
    expect(invariants(text)).toEqual(['I1', 'I11']);
  });

  it('I11: reports the path of the attribute that breaks its grammar', () => {
    const d = clone();
    defs(d)[1]!.attrs.color = '#ff0000';
    expect(validate(d, ctx).violations).toEqual([
      expect.objectContaining({ invariant: 'I11', path: '/doc/content/0/content/1/attrs/color' }),
    ]);
  });

  it('I7: refuses a document larger than 16 MiB in canonical form', () => {
    const d = clone();
    body(d)[2]!.content = [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024) }];
    expect(invariants(d)).toEqual(['I7']);
  });

  it('I7: returns promptly for hostile nesting, without unbounded recursion', () => {
    let inner: Json = para('pDeepest00000001');
    for (let i = 0; i < 100_000; i++)
      inner = { type: 'region', attrs: { id: 'rDeep00000000001' }, content: [inner] };
    const d = clone();
    body(d).push(inner);
    const r = validate(d, ctx);
    expect(r.valid).toBe(false);
    expect(r.violations.map((v) => v.invariant)).toContain('I7');
  });

  // Hostile inputs (CDM-013, criterion 8): each returns I7 within a bound far below what walking
  // the input item by item costs, and says what it did not check.
  const PROMPT_MS = 2000;
  const timed = (d: unknown) => {
    const start = performance.now();
    const r = validate(d, ctx);
    return { r, ms: performance.now() - start };
  };

  it('I7: a 16 MiB array in `ext` is refused promptly, at the attribute, without walking it', () => {
    const d = clone();
    defs(d)[0]!.attrs.ext = { 'vendor.example:data': new Array<number>(8 * 1024 * 1024).fill(1) };
    const { r, ms } = timed(d);
    expect(r.violations.map((v) => v.invariant)).toEqual(['I7']);
    expect(r.violations[0]!.code).toBe('canonical_too_large');
    expect(r.violations[0]!.path).toMatch(/\/attrs\/ext$/);
    expect(r.notChecked.some((n) => n.includes('16 MiB'))).toBe(true);
    expect(ms).toBeLessThan(PROMPT_MS);
  });

  it('I7: 16 MiB of nested arrays and of long keys in an attribute are refused promptly', () => {
    const nested = clone();
    defs(nested)[0]!.attrs.ext = {
      'vendor.example:data': new Array<unknown>(6 * 1024 * 1024).fill([]),
    };
    const keys = clone();
    const big: Record<string, number> = {};
    for (let i = 0; i < 20; i++) big[`${i}`.padEnd(1024 * 1024, 'k')] = 1;
    defs(keys)[0]!.attrs.ext = { 'vendor.example:data': big };
    for (const d of [nested, keys]) {
      const { r, ms } = timed(d);
      expect(r.violations.map((v) => v.invariant)).toEqual(['I7']);
      expect(ms).toBeLessThan(PROMPT_MS);
    }
  });

  it('I7: two million empty paragraphs are refused where the size passes the limit', () => {
    const d = clone();
    const content = body(d);
    for (let i = 0; i < 2_000_000; i++) content.push({ type: 'paragraph' });
    const { r, ms } = timed(d);
    // Refused before the walk: none of the two million missing identifiers is reported.
    expect(r.violations.map((v) => v.invariant)).toEqual(['I7']);
    expect(r.notChecked.some((n) => n.includes('16 MiB'))).toBe(true);
    expect(ms).toBeLessThan(PROMPT_MS);
  });

  it('I1: a 16 MiB array that is not content or not features is reported a bounded number of times', () => {
    const d = clone();
    (d['doc'] as Json)['content'] = new Array<number>(8 * 1024 * 1024).fill(1);
    const a = timed(d);
    expect(a.r.valid).toBe(false);
    expect(a.r.violations.filter((v) => v.code === 'malformed').length).toBe(16);
    expect(a.ms).toBeLessThan(PROMPT_MS);

    const e = clone();
    e['requires'] = new Array<string>(8 * 1024 * 1024).fill('tables');
    const b = timed(e);
    expect(b.r.violations.filter((v) => v.code === 'requires_invalid').length).toBe(1);
    expect(b.ms).toBeLessThan(PROMPT_MS);
  });

  it('the size bound never refuses a document below the limit', () => {
    // 16 MiB less the rest of the example is under the limit by the exact measure too.
    const d = clone();
    body(d)[2]!.content = [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024 - 64 * 1024) }];
    expect(invariants(d)).toEqual([]);
  });
});

describe('model.validate(): preserved content (CDM-051)', () => {
  const tree = (children: unknown): Json => ({ children });
  const withPreserved = (value: unknown): Json => {
    const d = clone();
    d['requires'] = ['preserve'];
    body(d)[0]!.attrs.preserved = value;
    return d;
  };
  const W = 'w:';
  const CLARK_W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';

  it('I11: a preserved value is an element tree of registered-prefix or Clark names and strings, at most 12 deep and 16 KiB', () => {
    expect(validate(withPreserved(tree([{ name: `${W}b` }, { text: 'x' }])), ctx).valid).toBe(true);
    // Clark notation stays for namespaces without a registered prefix (spike S11).
    expect(validate(withPreserved(tree([{ name: '{urn:example:x}b' }])), ctx).valid).toBe(true);
    let deep: Json = { name: `${W}leaf` };
    for (let i = 0; i < 12; i++) deep = { name: `${W}n${i}`, children: [deep] };
    let deepest: Json = { name: `${W}leaf` };
    for (let i = 0; i < 10; i++) deepest = { name: `${W}n${i}`, children: [deepest] };
    expect(validate(withPreserved(tree([deepest])), ctx).valid).toBe(true);
    // XML text is a string, not an object, so the schema's type check refuses it as well (I1).
    expect(invariants(withPreserved('<w:b/>'))).toEqual(['I1', 'I11']);
    const cases: Array<[string, unknown]> = [
      ['unregistered prefix', tree([{ name: 'foo:b' }])],
      ['Clark name of a registered namespace', tree([{ name: `${CLARK_W}b` }])],
      ['number attribute', tree([{ name: `${W}sz`, attrs: { [`${W}val`]: 24 } }])],
      ['text child with extra members', tree([{ text: 'x', name: `${W}t` }])],
      ['deeper than 12', tree([deep])],
      ['larger than 16 KiB', tree([{ name: `${W}t`, children: [{ text: 'x'.repeat(17000) }] }])],
      ['unknown member', { attrs: {}, comment: 'x' }],
      ['reference with more', { ref: 'pdShared', attrs: {} }],
    ];
    for (const [name, value] of cases)
      expect(invariants(withPreserved(value)), name).toEqual(['I11']);
  });
  it('I11: the depth limit is exact: 12 levels pass and 13 fail, for the attribute and for props', () => {
    // The value itself is level 1, so a chain of n elements reaches level n + 1.
    const chain = (elements: number): Json => {
      let e: Json = { name: `${W}leaf` };
      for (let i = 1; i < elements; i++) e = { name: `${W}n${i}`, children: [e] };
      return tree([e]);
    };
    expect(invariants(withPreserved(chain(11)))).toEqual([]);
    expect(invariants(withPreserved(chain(12)))).toEqual(['I11']);
    const withProps = (props: Json): Json => {
      const d = clone();
      d['requires'] = ['preserve'];
      body(d)[0]!.content[0].marks = [{ type: 'preserved', attrs: { props } }];
      return d;
    };
    expect(invariants(withProps(chain(11)))).toEqual([]);
    expect(invariants(withProps(chain(12)))).toEqual(['I11']);
    const big = tree([{ name: `${W}t`, children: [{ text: 'x'.repeat(17000) }] }]);
    expect(invariants(withProps(big))).toEqual(['I11']);
  });
  it('I11: the props of a preserved mark follow the same grammar', () => {
    const d = clone();
    d['requires'] = ['preserve'];
    body(d)[0]!.content[0].marks = [{ type: 'preserved', attrs: { props: '<w:shadow/>' } }];
    expect(invariants(d)).toEqual(['I1', 'I11']);
    const deep = clone();
    deep['requires'] = ['preserve'];
    deep['doc'].content[1].content[0].content[0].marks = [
      { type: 'preserved', attrs: { props: { children: [{ name: 'shadow:x' }] } } },
    ];
    expect(invariants(deep)).toEqual(['I11']);
  });

  it('I1: preserved nodes, marks and attributes need `preserve` in requires', () => {
    const atom = sink();
    atom['requires'] = ['extensions', 'fields'];
    const found = validate(atom, sinkCtx).violations.filter((v) => v.invariant === 'I1');
    const paths = found.map((v) => v.path);
    // The block atom, the inline atom, the mark and the attribute are each reported.
    expect(paths.some((p) => p.endsWith('/content/9'))).toBe(true);
    expect(paths.some((p) => p.includes('/marks/'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/attrs/preserved'))).toBe(true);
    expect(found.some((v) => /"preserved_inline"/.test(v.message))).toBe(true);
  });

  it('I4: `fragment` and `fallbackAsset` must be attached to the document', () => {
    const fragment = sink();
    fragment['doc'].content[3].content[9].attrs.fragment = '0192f0c4-7b1e-7c3a-9a54-00000000dead';
    expect(invariants(fragment, sinkCtx)).toEqual(['I4']);
    const fallback = sink();
    fallback['doc'].content[3].content[9].attrs.fallbackAsset =
      '0192f0c4-7b1e-7c3a-9a54-00000000beef';
    expect(invariants(fallback, sinkCtx)).toEqual(['I4']);
  });
});
