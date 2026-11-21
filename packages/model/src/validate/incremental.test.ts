// The validation of a commit from what it changed (CDM-013 criterion 7; ADR 0422). Every result is
// compared with `validateDoc()` on the whole result: the commit validator may only be cheaper,
// never different. The tests also say which results came from the changed nodes, so that a typical
// commit is known to take that path and the others are known to be validated in full.
import { Fragment, type Mark, type Node as PMNode, Slice } from 'prosemirror-model';
import { ReplaceAroundStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { ASSET, SINK_ASSETS, exampleDoc, sinkDoc } from '../../test/support.ts';
import { canonicalText, type JsonEnvelope } from '../canonical/canonical-form.ts';
import { utf8 } from '../conventions/platform.ts';
import { buildSchema, cdmSchema } from '../prosemirror/index.ts';
import { CommitValidator, quotedBytes, type CommitContext } from './incremental.ts';
import type { InvariantCheck, ValidationResult } from './types.ts';
import { LIMITS, validateDoc } from './validate.ts';

const schema = cdmSchema();
const REQUIRES = ['extensions', 'fields', 'preserve'];
/** A gate that refuses the formulas that hold `\bad`, and `x^2`, which the kitchen sink holds. */
const gate = (latex: string): string | null =>
  latex.includes('\\bad') || latex === 'x^2' ? 'refused' : null;
const CTX: CommitContext = {
  attachedAssets: SINK_ASSETS,
  retiredRegionIds: new Set(['rRetiredRegion01']),
  mathGate: gate,
};

const sink = (): PMNode => schema.nodeFromJSON(sinkDoc()['doc']);
const example = (): PMNode => schema.nodeFromJSON(exampleDoc()['doc']);

/** The position before the first node that `pick` accepts. */
function find(doc: PMNode, pick: (n: PMNode) => boolean): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && pick(n)) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error('no such node');
  return at;
}
const byId = (doc: PMNode, id: string): number => find(doc, (n) => n.attrs['id'] === id);
const mark = (name: string, attrs?: Record<string, unknown>): Mark =>
  schema.marks[name]!.create(attrs);
const node = (name: string, attrs?: Record<string, unknown>, content?: PMNode | PMNode[]): PMNode =>
  schema.nodes[name]!.create(attrs, content);
const para = (id: string, text = 'x', attrs: Record<string, unknown> = {}): PMNode =>
  node('paragraph', { id, ...attrs }, text ? schema.text(text) : undefined);

/** What `validateDoc()` says of the result, with the document before as `previous`. */
function whole(
  before: PMNode,
  after: PMNode,
  ctx: CommitContext = CTX,
  requires: readonly string[] = REQUIRES,
): ValidationResult {
  return validateDoc(
    after,
    requires,
    ctx.mathGate ? { ...ctx, previous: before.toJSON() as unknown } : ctx,
  );
}

/** Validates a commit both ways, expects the same result, and returns how it was reached. */
function commit(
  v: CommitValidator,
  before: PMNode,
  after: PMNode,
  ctx: CommitContext = CTX,
  requires: readonly string[] = REQUIRES,
) {
  const expected = whole(before, after, ctx, requires);
  const got = v.validate(before, after, requires, ctx);
  expect({ valid: got.valid, violations: got.violations, notChecked: got.notChecked }).toEqual(
    expected,
  );
  return got;
}

/** A validator that has seen `doc` pass, as a room's has after its first commit. */
function primed(doc: PMNode, ctx: CommitContext = CTX, requires: readonly string[] = REQUIRES) {
  const v = new CommitValidator();
  const first = v.validate(doc, doc, requires, ctx);
  expect(first.violations).toEqual([]);
  expect(first.how).toBe('full');
  return v;
}

/** The result of a change to `doc`. */
const change = (doc: PMNode, edit: (tr: Transform) => void): PMNode => {
  const tr = new Transform(doc);
  edit(tr);
  return tr.doc;
};

/** One commit on the kitchen sink that must be refused with exactly these codes. */
function refused(edit: (tr: Transform, doc: PMNode) => void, codes: string[], ctx = CTX): void {
  const doc = sink();
  const v = primed(doc, ctx);
  const after = change(doc, (tr) => edit(tr, doc));
  const r = commit(v, doc, after, ctx);
  expect(r.how).toBe('full');
  expect([...new Set(r.violations.map((x) => x.code))].sort()).toEqual([...codes].sort());
  // The validator is no worse for it: a good commit on the same document is still decided cheaply.
  const good = change(doc, (tr) => tr.insert(byId(doc, 'pList00000000001') + 2, schema.text('ok')));
  expect(commit(v, doc, good, ctx).how).toBe('incremental');
}

describe('a typical commit (CDM-013)', () => {
  it('is validated from the changed nodes: text typed into a paragraph of the body', () => {
    let doc = sink();
    const v = primed(doc);
    for (let i = 0; i < 5; i++) {
      const next = change(doc, (tr) =>
        tr.insert(byId(doc, 'pList00000000001') + 3, schema.text('typed ')),
      );
      const r = commit(v, doc, next);
      expect(r).toMatchObject({ how: 'incremental', valid: true });
      expect(r.why).toBeUndefined();
      doc = next;
    }
    expect(v.stats).toEqual({ incremental: 5, full: 1 });
  });

  it('is validated from the changed nodes wherever the paragraph is', () => {
    const places = [
      'pCellRent0000001', // a table cell
      'pFnUtilities0001', // a footnote
      'pHeader000000001', // a header story
      'pLegal0000000001', // a region
      'pSuggested000001', // text with suggestion marks
    ];
    let doc = sink();
    const v = primed(doc);
    for (const id of places) {
      const next = change(doc, (tr) => tr.insert(byId(doc, id) + 2, schema.text('+')));
      expect(commit(v, doc, next).how, id).toBe('incremental');
      doc = next;
    }
    // In the caption of the figure, which has no identifier of its own.
    const caption = find(doc, (n) => n.type.name === 'caption');
    const next = change(doc, (tr) => tr.insert(caption + 2, schema.text('+')));
    expect(commit(v, doc, next).how).toBe('incremental');
  });

  it('covers the other everyday steps: marks, deletions, a new paragraph, a split with a new id', () => {
    let doc = sink();
    const v = primed(doc);
    const steps: Array<(tr: Transform, d: PMNode) => void> = [
      (tr, d) => {
        const p = byId(d, 'pFootnote0000001');
        tr.addMark(p + 1, p + 8, mark('bold'));
      },
      (tr, d) => {
        const p = byId(d, 'pFootnote0000001');
        tr.removeMark(p + 1, p + 4, schema.marks['bold']!);
      },
      (tr, d) => {
        const p = byId(d, 'pFootnote0000001');
        tr.delete(p + 2, p + 6);
      },
      (tr, d) => tr.insert(byId(d, 'tocMain000000001'), para('pNew000000000001', 'new')),
      (tr, d) => {
        // The split leaves the second half at p + 3, with a copy of the identifier until it is set.
        const p = byId(d, 'pNew000000000001');
        tr.split(p + 2).setNodeAttribute(p + 3, 'id', 'pNew000000000002');
      },
      (tr, d) => tr.join(byId(d, 'pNew000000000002')),
      (tr, d) => {
        const p = byId(d, 'pNew000000000001');
        tr.addMark(p + 1, p + 3, mark('ins', { id: 'sAliceInsert0001', user: 'alice' }));
      },
      (tr, d) => tr.setNodeAttribute(byId(d, 'pNew000000000001'), 'style', 'Heading1'),
      (tr, d) => tr.setNodeAttribute(byId(d, 'rLegal0000000001'), 'title', 'Legal terms'),
      (tr, d) => tr.delete(byId(d, 'pNew000000000001'), byId(d, 'tocMain000000001')),
    ];
    for (const [i, step] of steps.entries()) {
      const next = change(doc, (tr) => step(tr, doc));
      expect(commit(v, doc, next), `step ${i}`).toMatchObject({ how: 'incremental', valid: true });
      doc = next;
    }
  });

  it('accepts a commit that changes nothing', () => {
    const doc = sink();
    const v = primed(doc);
    expect(commit(v, doc, doc).how).toBe('incremental');
  });

  it('moves structure: a paragraph into a new region and out again', () => {
    let doc = sink();
    const v = primed(doc);
    const wrap = (d: PMNode, id: string, region: string): PMNode =>
      change(d, (tr) => {
        const range = tr.doc.resolve(byId(d, id) + 1).blockRange()!;
        tr.wrap(range, [{ type: schema.nodes['region']!, attrs: { id: region } }]);
      });
    const wrapped = wrap(doc, 'pList00000000001', 'rNewRegion000001');
    expect(commit(v, doc, wrapped).how).toBe('incremental');
    doc = wrapped;
    const lifted = change(doc, (tr) => {
      const r = byId(doc, 'rNewRegion000001');
      const size = doc.nodeAt(r)!.nodeSize;
      tr.step(new ReplaceAroundStep(r, r + size, r + 1, r + size - 1, Slice.empty, 0, true));
    });
    expect(commit(v, doc, lifted).how).toBe('incremental');
    expect(v.describe(lifted)).toEqual(new CommitValidator().describe(lifted));
    // A paragraph that holds a field moves with it, and the field invariants read fields: in full.
    const withField = wrap(lifted, 'pFootnote0000001', 'rNewRegion000002');
    expect(commit(v, lifted, withField)).toMatchObject({
      how: 'full',
      valid: true,
      why: 'the check "fields" reads a changed field',
    });
    expect(v.describe(withField)).toEqual(new CommitValidator().describe(withField));
  });
});

/**
 * A copy of `doc` in which the node at `path` (child indexes from the root) is replaced by
 * `edit(node)`. Nothing is checked, so the result can be a document no step would build; every
 * node off the path is shared with `doc`, as after a step.
 */
function rebuilt(doc: PMNode, path: number[], edit: (n: PMNode) => PMNode): PMNode {
  if (path.length === 0) return edit(doc);
  const [i, ...rest] = path as [number, ...number[]];
  return doc.copy(doc.content.replaceChild(i, rebuilt(doc.child(i), rest, edit)));
}

describe('a result no step would build (CDM-013)', () => {
  // ProseMirror refuses a step whose result does not fit the content expressions, so these
  // documents are made by hand. The validator must judge any pair of documents it is given.
  const BODY = 3;
  const cases: Array<[string, (doc: PMNode) => PMNode, string[]]> = [
    [
      'a node of a type the parent does not take',
      (doc) =>
        rebuilt(doc, [BODY], (body) =>
          body.copy(
            body.content.addToEnd(
              node('table_cell', { id: 'tcStray000000001' }, para('pStray0000000001')),
            ),
          ),
        ),
      ['schema_content'],
    ],
    [
      'a region inside a region',
      (doc) =>
        rebuilt(doc, [BODY, 3], (region) =>
          region.copy(
            region.content.addToEnd(
              node('region', { id: 'rNested000000001' }, para('pNested000000001')),
            ),
          ),
        ),
      ['nested_region', 'schema_content'],
    ],
    [
      'a region without content',
      (doc) => rebuilt(doc, [BODY, 3], (region) => region.copy(Fragment.empty)),
      ['schema_content'],
    ],
    [
      'a block that carries a mark',
      (doc) => rebuilt(doc, [BODY, 4], (p) => p.mark([mark('bold')])),
      ['node_mark_host'],
    ],
    [
      'text with one mark twice',
      (doc) => rebuilt(doc, [BODY, 4, 0], (t) => t.mark([mark('bold'), mark('bold')])),
      ['schema_content'],
    ],
    [
      'definitions in another order',
      (doc) =>
        rebuilt(doc, [0], (defs) =>
          defs.copy(
            Fragment.from([defs.child(1), defs.child(0), ...defs.content.content.slice(2)]),
          ),
        ),
      ['schema_content'],
    ],
    [
      'a figure with two captions',
      (doc) =>
        rebuilt(doc, [BODY, 3, 2], (figure) =>
          figure.copy(figure.content.addToEnd(node('caption', undefined, schema.text('again')))),
        ),
      ['schema_content'],
    ],
    [
      'a table without rows',
      (doc) => rebuilt(doc, [BODY, 3, 1], (table) => table.copy(Fragment.empty)),
      ['schema_content'],
    ],
  ];

  it.each(cases)('%s', (_name, build, codes) => {
    const doc = sink();
    const v = primed(doc);
    const after = build(doc);
    const r = commit(v, doc, after);
    expect(r.how).toBe('full');
    expect([...new Set(r.violations.map((x) => x.code))].sort()).toEqual([...codes].sort());
  });

  it('judges a document whose nodes are equal but not shared as unchanged', () => {
    const doc = sink();
    const v = primed(doc);
    const copy = schema.nodeFromJSON(doc.toJSON());
    expect(commit(v, doc, copy)).toMatchObject({ how: 'incremental', valid: true });
    expect(v.describe(copy)).toEqual(new CommitValidator().describe(copy));
  });

  it('handles the same node object twice among the children, and children in another order', () => {
    const doc = sink();
    const v = primed(doc);
    const twice = rebuilt(doc, [BODY], (body) => body.copy(body.content.addToEnd(body.child(1))));
    expect(commit(v, doc, twice).violations.map((x) => x.code)).toEqual(['duplicate_id']);
    const reordered: Array<[string, (kids: PMNode[]) => PMNode[]]> = [
      // The list paragraph and the suggested paragraph change places: nothing is gained or lost.
      ['two neighbours swapped', (k) => [k[0]!, k[2]!, k[1]!, ...k.slice(3)]],
      // Another order and another number of children at once.
      [
        'a block moved to the end, another inserted at the start',
        (k) => [para('pInserted0000001'), k[0]!, ...k.slice(2), k[1]!],
      ],
      ['a block moved to the start', (k) => [k[2]!, k[0]!, k[1]!, ...k.slice(3)]],
      ['the plain blocks in reverse order', (k) => [k[2]!, k[1]!, k[0]!, ...k.slice(3)]],
      ['a block moved and its neighbour deleted', (k) => [k[0]!, k[2]!, ...k.slice(3, 10), k[1]!]],
    ];
    for (const [name, order] of reordered) {
      const after = rebuilt(doc, [BODY], (body) =>
        body.copy(Fragment.from(order([...body.content.content]))),
      );
      // None of the blocks that move holds a field, so no registered check reads them.
      const w = primed(doc);
      expect(commit(w, doc, after), name).toMatchObject({ how: 'incremental', valid: true });
      expect(w.describe(after), name).toEqual(new CommitValidator().describe(after));
    }
  });
});

describe('a commit that breaks an invariant (CDM-013)', () => {
  it('I2: a split that leaves two paragraphs with one identifier', () => {
    refused((tr, d) => tr.split(byId(d, 'pFootnote0000001') + 3), ['duplicate_id']);
  });

  it('I2: a pasted copy of a node that keeps its identifier', () => {
    refused(
      (tr, d) => {
        const p = byId(d, 'pLegal0000000001');
        tr.insert(byId(d, 'tocMain000000001'), d.nodeAt(p)!);
      },
      ['duplicate_id'],
    );
  });

  it('I2: a suggestion identifier under another user', () => {
    refused(
      (tr, d) => {
        const p = byId(d, 'pFootnote0000001');
        tr.addMark(p + 1, p + 4, mark('ins', { id: 'sAliceInsert0001', user: 'mallory' }));
      },
      ['suggestion_user'],
    );
  });

  it('I2: the identifier changes the caller names', () => {
    const doc = sink();
    const ctx = {
      ...CTX,
      identifierChanges: [{ from: 'pList00000000001', to: 'pOther0000000001' }],
    };
    const v = primed(doc, { ...ctx, identifierChanges: [] });
    const after = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'pList00000000001'), 'id', 'pOther0000000001'),
    );
    const r = commit(v, doc, after, ctx);
    expect(r.violations.map((x) => x.code)).toEqual(['id_changed']);
  });

  it('I3: a region with a retired identifier', () => {
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'tocMain000000001'),
          node('region', { id: 'rRetiredRegion01' }, para('pInRetired000001')),
        ),
      ['region_id_reused'],
    );
  });

  it('I4: a style, a character style, a numbering level and an asset that do not resolve', () => {
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'pFootnote0000001'), 'style', 'Missing'),
      ['unresolved_reference'],
    );
    refused(
      (tr, d) => {
        const p = byId(d, 'pFootnote0000001');
        tr.addMark(p + 1, p + 4, mark('charStyle', { style: 'Heading1' }));
      },
      ['wrong_reference_kind'],
    );
    refused(
      (tr, d) =>
        tr.setNodeAttribute(byId(d, 'pFootnote0000001'), 'numbering', {
          numberingId: 'numBullets000001',
          level: 7,
          listId: 'lBullets00000001',
        }),
      ['numbering_level_missing'],
    );
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'pFootnote0000001') + 1,
          node('image', {
            asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8aff',
            width: 10,
            height: 10,
          }),
        ),
      ['asset_not_attached'],
    );
  });

  it('I4: a bookmark that a field elsewhere names is deleted, or named twice', () => {
    refused(
      (tr, d) => {
        const a = byId(d, 'aTerms0000000001');
        tr.delete(a, a + 1);
      },
      ['field_target_unresolved'],
    );
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'pFootnote0000001') + 1,
          node('anchor', { id: 'aTerms0000000002', name: 'Terms' }),
        ),
      ['duplicate_target_name'],
    );
  });

  it('I4: a field that names nothing, and a paragraph that stops being what a field names', () => {
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'pFootnote0000001') + 1,
          node('field', { kind: 'ref', target: 'bookmark:Nowhere' }),
        ),
      ['field_target_unresolved'],
    );
    // With a field that names the heading and one that names the list item, in place first.
    const base = change(sink(), (tr) =>
      tr.insert(byId(tr.doc, 'pFootnote0000001') + 1, [
        node('field', { kind: 'ref', target: 'node:pHeading00000001' }),
        node('field', { kind: 'ref', target: 'node:pList00000000001' }),
      ]),
    );
    const cases: Array<[string, (tr: Transform) => void]> = [
      [
        'no longer a heading',
        (tr) => tr.setNodeAttribute(byId(base, 'pHeading00000001'), 'style', null),
      ],
      [
        'no longer numbered',
        (tr) => tr.setNodeAttribute(byId(base, 'pList00000000001'), 'numbering', null),
      ],
      [
        'deleted',
        (tr) => {
          const p = byId(base, 'pList00000000001');
          tr.delete(p, p + base.nodeAt(p)!.nodeSize);
        },
      ],
    ];
    for (const [name, edit] of cases) {
      const v = primed(base);
      const r = commit(v, base, change(base, edit));
      expect(r.how, name).toBe('full');
      expect(
        r.violations.map((x) => x.code),
        name,
      ).toEqual(['field_target_unresolved']);
    }
    // Text typed into the named heading leaves it a heading: decided from the changed nodes.
    const v = primed(base);
    const typed = change(base, (tr) =>
      tr.insert(byId(base, 'pHeading00000001') + 3, schema.text('!')),
    );
    expect(commit(v, base, typed).how).toBe('incremental');
  });

  it('I4: a caption that loses its sequence field while a field names it', () => {
    const base = change(sink(), (tr) => {
      tr.insert(
        byId(tr.doc, 'tocMain000000001'),
        node('paragraph', { id: 'pCaption00000001' }, [
          schema.text('Table '),
          node('field', { kind: 'seq', name: 'Table' }),
        ]),
      );
      tr.insert(
        byId(tr.doc, 'pFootnote0000001') + 1,
        node('field', { kind: 'ref', target: 'node:pCaption00000001' }),
      );
    });
    const v = primed(base);
    const typed = change(base, (tr) =>
      tr.insert(byId(base, 'pCaption00000001') + 2, schema.text('.')),
    );
    expect(commit(v, base, typed).how).toBe('incremental');
    const seq = find(typed, (n) => n.type.name === 'field' && n.attrs['name'] === 'Table');
    const lost = change(typed, (tr) => tr.delete(seq, seq + 1));
    const r = commit(v, typed, lost);
    expect(r.violations.map((x) => x.code)).toEqual(['field_target_unresolved']);
  });

  it('I4: an equation label that a field names is removed, or used twice', () => {
    const base = change(sink(), (tr) => {
      tr.insert(
        byId(tr.doc, 'tocMain000000001'),
        node('equation_block', { id: 'eqLabelled000001', latex: 'a', label: 'eq:one' }),
      );
      tr.insert(
        byId(tr.doc, 'pFootnote0000001') + 1,
        node('field', { kind: 'ref', target: 'eq:eq:one' }),
      );
    });
    const v = primed(base);
    const eq = byId(base, 'eqLabelled000001');
    const removed = change(base, (tr) => tr.delete(eq, eq + 1));
    expect(commit(v, base, removed).violations.map((x) => x.code)).toEqual([
      'field_target_unresolved',
    ]);
    const twice = change(base, (tr) =>
      tr.insert(
        eq,
        node('equation_block', { id: 'eqLabelled000002', latex: 'b', label: 'eq:one' }),
      ),
    );
    expect(commit(v, base, twice).violations.map((x) => x.code)).toEqual(['duplicate_target_name']);
    // The same label on a block that replaces the old one in the same commit is one label.
    const replaced = change(base, (tr) =>
      tr.replaceWith(
        eq,
        eq + 1,
        node('equation_block', { id: 'eqLabelled000003', latex: 'c', label: 'eq:one' }),
      ),
    );
    expect(commit(v, base, replaced)).toMatchObject({ how: 'incremental', valid: true });
  });

  it('I6: a grid, a span and a header row count that no longer fit the table', () => {
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'tTerms0000000001'), 'grid', [1000, 1000, 1000]),
      ['row_columns'],
    );
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'tcRent0000000001'), 'colspan', 2),
      ['row_columns'],
    );
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'tcRent0000000001'), 'rowspan', 2),
      ['row_span_past_end'],
    );
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'tTerms0000000001'), 'headerRows', 3),
      ['header_rows'],
    );
    refused(
      (tr, d) => {
        const row = byId(d, 'trBody0000000001');
        tr.delete(row, row + d.nodeAt(row)!.nodeSize);
        tr.setNodeAttribute(byId(tr.doc, 'tTerms0000000001'), 'headerRows', 2);
      },
      ['header_rows'],
    );
  });

  it('I7: more than 500 regions, and a canonical size past 16 MiB', () => {
    const regions = Array.from({ length: LIMITS.regions - 1 }, (_, i) => {
      const n = String(i).padStart(4, '0');
      return node('region', { id: `rMany0000000${n}` }, para(`pMany0000000${n}`, ''));
    });
    const full = change(sink(), (tr) => tr.insert(byId(tr.doc, 'tocMain000000001'), regions));
    const v = primed(full);
    const typed = change(full, (tr) =>
      tr.insert(byId(full, 'pList00000000001') + 2, schema.text('.')),
    );
    expect(commit(v, full, typed).how).toBe('incremental');
    const over = change(full, (tr) =>
      tr.insert(
        byId(full, 'tocMain000000001'),
        node('region', { id: 'rOneTooMany00001' }, para('pOneTooMany00001')),
      ),
    );
    const r = commit(v, full, over);
    expect(r.violations.map((x) => x.code)).toEqual(['too_many_regions']);
  });

  it('I7 and I8: formulas that are too long or that the gate refuses', () => {
    refused(
      (tr, d) =>
        tr.insert(byId(d, 'pFootnote0000001') + 1, node('equation', { latex: 'x'.repeat(4001) })),
      ['limit_exceeded'],
    );
    refused(
      (tr, d) => tr.insert(byId(d, 'pFootnote0000001') + 1, node('equation', { latex: '\\bad' })),
      ['math_refused'],
    );
  });

  it('I9 and I11: a link scheme and an attribute outside its grammar', () => {
    refused(
      (tr, d) => {
        const p = byId(d, 'pFootnote0000001');
        tr.addMark(p + 1, p + 4, mark('link', { href: 'javascript:alert(1)' }));
      },
      ['link_scheme'],
    );
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'pFootnote0000001'), 'align', 'sideways'),
      ['attribute_invalid'],
    );
    refused(
      (tr, d) => tr.setNodeAttribute(byId(d, 'pFootnote0000001'), 'indentLeft', 1.5),
      ['attribute_invalid'],
    );
  });

  it('I10 and I1: forbidden places and a second paragraph in a footnote', () => {
    refused(
      (tr, d) => tr.insert(byId(d, 'pCellRent0000001') + 1, node('break', { kind: 'page' })),
      ['break_in_container'],
    );
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'pFnUtilities0001') + 1,
          node('footnote', { id: 'fnNested00000001' }, para('pFnNested0000001')),
        ),
      ['footnote_in_footnote'],
    );
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'pFnUtilities0001') + d.nodeAt(byId(d, 'pFnUtilities0001'))!.nodeSize,
          para('pFnSecond0000001'),
        ),
      ['footnote_paragraphs'],
    );
    refused(
      (tr, d) =>
        tr.insert(
          byId(d, 'pHeader000000001') + 1,
          node('form_field', {
            id: 'ffInHeader000001',
            key: 'in.header',
            kind: 'text',
            label: 'In the header',
          }),
        ),
      ['form_field_placement'],
    );
  });

  it('never throws on a commit that nests far too deep', () => {
    const doc = sink();
    const v = primed(doc);
    let deep = para('pDeepest00000001');
    for (let i = 0; i < 40; i++) {
      const n = String(i).padStart(2, '0');
      deep = node('paragraph', { id: `pDeep0000000${n}0p` }, [
        node('footnote', { id: `fnDeep00000${n}0fn` }, deep),
      ]);
    }
    const after = change(doc, (tr) => tr.insert(byId(doc, 'tocMain000000001'), deep));
    const r = commit(v, doc, after);
    expect(r.how).toBe('full');
    expect(r.violations.map((x) => x.code)).toContain('nesting_too_deep');
  });

  it('refuses text that cannot be written in the canonical form', () => {
    refused(
      (tr, d) => tr.insert(byId(d, 'pFootnote0000001') + 1, schema.text('lone \uD800 surrogate')),
      ['not_canonicalisable'],
    );
  });
});

describe('what needs the whole document (CDM-013)', () => {
  it('a changed definition is validated in full, and the indexes follow it', () => {
    let doc = sink();
    const v = primed(doc);
    const restyled = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'Caption'), 'italic', false),
    );
    expect(commit(v, doc, restyled)).toMatchObject({
      how: 'full',
      valid: true,
      why: 'a definition changed',
    });
    doc = restyled;
    // A new style, then a paragraph that uses it: the second commit is decided from the changed
    // nodes, which needs the new style in the indexes.
    const defs = doc.child(0);
    const afterStyles = find(doc, (n) => n.type.name === 'numbering_def');
    const added = change(doc, (tr) =>
      tr.insert(afterStyles, node('style_def', { id: 'Quote', name: 'Quote', builtIn: true })),
    );
    expect(defs.childCount + 1).toBe(added.child(0).childCount);
    expect(commit(v, doc, added).how).toBe('full');
    doc = added;
    const used = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'pFootnote0000001'), 'style', 'Quote'),
    );
    expect(commit(v, doc, used)).toMatchObject({ how: 'incremental', valid: true });
    doc = used;
    // Deleting the style while the paragraph uses it is refused (I4), by the full validation.
    const quote = byId(doc, 'Quote');
    const deleted = change(doc, (tr) => tr.delete(quote, quote + 1));
    const r = commit(v, doc, deleted);
    expect(r.how).toBe('full');
    expect(r.violations.map((x) => x.code)).toEqual(['unresolved_reference']);
    // A style chain with a cycle (I5).
    const cyclic = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'Normal'), 'basedOn', 'Heading1'),
    );
    expect(commit(v, doc, cyclic).violations.map((x) => x.code)).toContain('style_chain_cycle');
    expect(v.describe(doc)).toEqual(new CommitValidator().describe(doc));
  });

  it('a commit that touches what a registered check reads runs that check', () => {
    let doc = sink();
    const v = primed(doc);
    const field = byId(doc, 'ffTenantName0001');
    const filled = change(doc, (tr) => tr.setNodeAttribute(field, 'value', 'Grace Hopper'));
    expect(commit(v, doc, filled)).toMatchObject({
      how: 'full',
      valid: true,
      why: 'the check "fields" reads a changed form_field',
    });
    doc = filled;
    const typed = change(doc, (tr) =>
      tr.insert(byId(doc, 'pList00000000001') + 2, schema.text('.')),
    );
    expect(commit(v, doc, typed).how).toBe('incremental');
    doc = typed;
    // A value of the wrong type (I15), a key used twice (I13) and a mirror of no field (I14).
    const wrong = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'ffTenantIncome01'), 'value', 'lots'),
    );
    expect(commit(v, doc, wrong).violations.map((x) => x.code)).toEqual(['value_type']);
    const twice = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'ffTenantIncome01'), 'key', 'tenant.name'),
    );
    expect(commit(v, doc, twice).violations.map((x) => x.invariant)).toContain('I13');
    const mirror = change(doc, (tr) =>
      tr.insert(
        byId(doc, 'pList00000000001') + 1,
        node('field', { kind: 'formValue', target: 'field:no.such.key' }),
      ),
    );
    expect(commit(v, doc, mirror).violations.map((x) => x.code)).toEqual(['unresolved_field_key']);
  });

  it('a check that does not say what it reads makes every commit a full validation', () => {
    const silent: InvariantCheck = { name: 'silent', codes: {}, check: () => undefined };
    const reading: InvariantCheck = {
      name: 'titles',
      codes: { region_without_title: { invariant: 'I11', doc: 'A region must have a title.' } },
      reads: { nodes: ['region'] },
      check(view, report) {
        for (const r of view.ofType('region'))
          if (r.attrs['title'] === null)
            report({
              code: 'region_without_title',
              path: `${r.path}/attrs/title`,
              message: 'no title',
            });
      },
    };
    const doc = sink();
    const typed = change(doc, (tr) =>
      tr.insert(byId(doc, 'pList00000000001') + 2, schema.text('.')),
    );
    const withSilent = { ...CTX, invariants: [silent] };
    const v1 = primed(doc, withSilent);
    expect(commit(v1, doc, typed, withSilent)).toMatchObject({
      how: 'full',
      why: 'the check "silent" does not say what it reads',
    });
    const withReading = { ...CTX, invariants: [reading] };
    const v2 = primed(doc, withReading);
    expect(commit(v2, doc, typed, withReading).how).toBe('incremental');
    const untitled = change(doc, (tr) =>
      tr.setNodeAttribute(byId(doc, 'rLegal0000000001'), 'title', null),
    );
    const r = commit(v2, doc, untitled, withReading);
    expect(r).toMatchObject({ how: 'full', why: 'the check "titles" reads a changed region' });
    expect(r.violations.map((x) => x.code)).toEqual(['region_without_title']);
    // Text typed inside the region changes the region's content, not the region: no check.
    const inside = change(doc, (tr) =>
      tr.insert(byId(doc, 'pLegal0000000001') + 2, schema.text('.')),
    );
    expect(commit(v2, doc, inside, withReading).how).toBe('incremental');
  });

  it('a document it has not seen pass, and a document of another schema', () => {
    const doc = sink();
    const typed = change(doc, (tr) =>
      tr.insert(byId(doc, 'pList00000000001') + 2, schema.text('.')),
    );
    const v = new CommitValidator();
    expect(commit(v, doc, typed)).toMatchObject({
      how: 'full',
      why: 'the document before the commit is not known to be valid',
    });
    const other = buildSchema();
    const theirs = other.nodeFromJSON(sinkDoc()['doc']);
    const v2 = new CommitValidator();
    v2.validate(theirs, theirs, REQUIRES, CTX);
    const r = v2.validate(theirs, theirs, REQUIRES, CTX);
    expect(r).toMatchObject({
      how: 'full',
      valid: true,
      why: 'the documents are not of the schema of the validation',
    });
    // With that schema named in the context, the same documents are decided from the changes.
    const v3 = new CommitValidator();
    v3.validate(theirs, theirs, REQUIRES, { ...CTX, schema: other });
    expect(v3.validate(theirs, theirs, REQUIRES, { ...CTX, schema: other }).how).toBe(
      'incremental',
    );
  });
});

describe('the life of a room (CDM-013)', () => {
  it('keeps the base when a valid commit is refused for another reason', () => {
    const doc = sink();
    const v = primed(doc);
    // The room validates A, refuses it at the permission check, and validates B on the same base.
    const a = change(doc, (tr) => tr.insert(byId(doc, 'pList00000000001') + 2, schema.text('A')));
    const b = change(doc, (tr) => tr.insert(byId(doc, 'pFootnote0000001') + 2, schema.text('B')));
    expect(commit(v, doc, a).how).toBe('incremental');
    expect(commit(v, doc, b).how).toBe('incremental');
    const c = change(b, (tr) => tr.insert(byId(b, 'pFootnote0000001') + 2, schema.text('C')));
    expect(commit(v, b, c).how).toBe('incremental');
    expect(v.describe(c)).toEqual(new CommitValidator().describe(c));
  });

  it('keeps the base when a commit is refused as invalid', () => {
    const doc = sink();
    const v = primed(doc);
    const bad = change(doc, (tr) => tr.split(byId(doc, 'pFootnote0000001') + 3));
    expect(commit(v, doc, bad).valid).toBe(false);
    const good = change(doc, (tr) =>
      tr.insert(byId(doc, 'pFootnote0000001') + 2, schema.text('B')),
    );
    expect(commit(v, doc, good).how).toBe('incremental');
  });

  it('pays one full validation when the room goes back to an older document', () => {
    const d0 = sink();
    const v = primed(d0);
    const d1 = change(d0, (tr) => tr.insert(byId(d0, 'pList00000000001') + 2, schema.text('1')));
    const d2 = change(d1, (tr) => tr.insert(byId(d1, 'pList00000000001') + 2, schema.text('2')));
    const d3 = change(d2, (tr) => tr.insert(byId(d2, 'pList00000000001') + 2, schema.text('3')));
    expect(commit(v, d0, d1).how).toBe('incremental');
    expect(commit(v, d1, d2).how).toBe('incremental');
    expect(commit(v, d2, d3).how).toBe('incremental');
    // The write of d2 and d3 failed: the room continues from d1.
    const e2 = change(d1, (tr) => tr.insert(byId(d1, 'pFootnote0000001') + 2, schema.text('x')));
    expect(commit(v, d1, e2)).toMatchObject({ how: 'full', valid: true });
    const e3 = change(e2, (tr) => tr.insert(byId(e2, 'pFootnote0000001') + 2, schema.text('y')));
    expect(commit(v, e2, e3).how).toBe('incremental');
    expect(v.describe(e3)).toEqual(new CommitValidator().describe(e3));
  });

  it('replaces the whole document (a snapshot commit) and carries on', () => {
    const doc = sink();
    const v = primed(doc);
    const other = example();
    expect(commit(v, doc, other)).toMatchObject({
      how: 'full',
      valid: true,
      why: 'a definition changed',
    });
    const p = byId(other, 'pZ9y8X7w6V5u4T3s');
    const typed = change(other, (tr) => tr.insert(p + 1, schema.text('.')));
    expect(commit(v, other, typed).how).toBe('incremental');
    expect(v.describe(typed)).toEqual(new CommitValidator().describe(typed));
  });
});

describe('the context of a commit (CDM-013)', () => {
  const typedIn = (doc: PMNode): PMNode =>
    change(doc, (tr) => tr.insert(byId(doc, 'pList00000000001') + 2, schema.text('.')));

  it('lists what could not be checked exactly as the full validation does', () => {
    const doc = sink();
    for (const ctx of [{}, { attachedAssets: SINK_ASSETS }, { mathGate: gate }, CTX]) {
      const v = primed(doc, ctx);
      const r = commit(v, doc, typedIn(doc), ctx);
      expect(r.how).toBe('incremental');
      expect(r.notChecked).toEqual(validateDoc(doc, REQUIRES, ctx).notChecked);
    }
  });

  it('does not gate again a formula the document before already held (09 §6.3)', () => {
    // The gate refuses `x^2`, which the kitchen sink holds: a commit elsewhere is still valid.
    const doc = sink();
    const v = primed(doc);
    expect(whole(doc, doc).valid).toBe(true);
    expect(validateDoc(doc, REQUIRES, CTX).valid).toBe(false);
    const typed = typedIn(doc);
    expect(commit(v, doc, typed)).toMatchObject({ how: 'incremental', valid: true });
    // The same formula once more is not new either; another refused one is.
    const again = change(typed, (tr) =>
      tr.insert(byId(typed, 'pList00000000001') + 1, node('equation', { latex: 'x^2' })),
    );
    expect(commit(v, typed, again)).toMatchObject({ how: 'incremental', valid: true });
    const calls: string[] = [];
    const counting = { ...CTX, mathGate: (l: string) => (calls.push(l), gate(l)) };
    const v2 = primed(doc, counting);
    commit(v2, doc, typed, counting);
    expect(calls).toEqual([]);
  });

  it('follows the assets that are attached now', () => {
    const doc = sink();
    const assets = new Set(SINK_ASSETS);
    const ctx = { ...CTX, attachedAssets: assets };
    const v = primed(doc, ctx);
    const typed = typedIn(doc);
    expect(commit(v, doc, typed, ctx).how).toBe('incremental');
    // An asset the figure uses is detached, in place: every later commit is refused, as in full.
    assets.delete(ASSET);
    const next = typedIn(typed);
    const r = commit(v, typed, next, ctx);
    expect(r.violations.map((x) => x.code)).toEqual(['asset_not_attached']);
    // A new set that holds it again.
    const ctx2 = { ...CTX, attachedAssets: new Set(SINK_ASSETS) };
    expect(commit(v, typed, next, ctx2).valid).toBe(true);
    expect(commit(v, next, typedIn(next), ctx2).how).toBe('incremental');
  });

  it('follows the region identifiers that are retired now', () => {
    const doc = sink();
    const v = primed(doc);
    const withRegion = change(doc, (tr) =>
      tr.insert(
        byId(doc, 'tocMain000000001'),
        node('region', { id: 'rPlain0000000001' }, para('pPlain0000000001')),
      ),
    );
    expect(commit(v, doc, withRegion).how).toBe('incremental');
    // The identifier of a region that is still there is retired (no room does this; a caller may).
    const ctx = { ...CTX, retiredRegionIds: new Set(['rRetiredRegion01', 'rPlain0000000001']) };
    const r = commit(v, withRegion, typedIn(withRegion), ctx);
    expect(r.violations.map((x) => x.code)).toEqual(['region_id_reused']);
    // Removing that region in the commit leaves nothing retired in the result.
    const gone = change(withRegion, (tr) => {
      const at = byId(withRegion, 'rPlain0000000001');
      tr.delete(at, at + withRegion.nodeAt(at)!.nodeSize);
    });
    expect(commit(v, withRegion, gone, ctx)).toMatchObject({ how: 'incremental', valid: true });
  });

  it('validates in full when `requires` or the checks change, and then carries on', () => {
    const doc = example();
    const v = primed(doc, {}, []);
    const p = byId(doc, 'pZ9y8X7w6V5u4T3s');
    const typed = change(doc, (tr) => tr.insert(p + 1, schema.text('.')));
    expect(commit(v, doc, typed, {}, []).how).toBe('incremental');
    // A node of a feature that `requires` does not list (I1).
    const badge = node('extension_inline', { extension: 'com.example.badge', fallbackText: 'b' });
    const featured = change(typed, (tr) => tr.insert(p + 1, badge));
    expect(commit(v, typed, featured, {}, []).violations.map((x) => x.code)).toEqual([
      'feature_missing',
    ]);
    // With the feature listed the commit is valid: a new key, so a full validation, once.
    expect(commit(v, typed, featured, {}, ['extensions'])).toMatchObject({
      how: 'full',
      valid: true,
    });
    const more = change(featured, (tr) => tr.insert(p + 1, schema.text('.')));
    expect(commit(v, featured, more, {}, ['extensions']).how).toBe('incremental');
  });
});

describe('the size bound (CDM-013; I7)', () => {
  const exact = (doc: PMNode, requires: string[]): number =>
    utf8(canonicalText({ cdm: 1, requires, doc: doc.toJSON() } as JsonEnvelope)).length;
  const bound = (v: CommitValidator, doc: PMNode): number =>
    (v.describe(doc) as { bytes: number }).bytes;
  /** `{"cdm":1,"doc":,"requires":[…]}` around the document. */
  const envelope = (requires: string[]): number =>
    utf8(JSON.stringify({ cdm: 1, doc: 0, requires })).length - 1;

  it('is the canonical size of the fixtures, to the byte', () => {
    for (const [doc, requires] of [
      [sink(), [...REQUIRES].sort()],
      [example(), []],
    ] as const) {
      const v = new CommitValidator();
      expect(bound(v, doc) + envelope([...requires])).toBe(exact(doc, [...requires]));
    }
  });

  it('stays the canonical size over commits, with every kind of character', () => {
    let doc = sink();
    const v = primed(doc);
    const texts = [
      'plain',
      'quote " and \\ slash',
      'tab\tnew\nline',
      'é ß ж',
      '漢字',
      '😀 pair',
      '\u0001\u001f',
    ];
    for (const t of texts) {
      const next = change(doc, (tr) =>
        tr.insert(byId(doc, 'pList00000000001') + 2, schema.text(t)),
      );
      // A control character is refused by no grammar here: text is free. The size must follow.
      const r = commit(v, doc, next);
      expect(r.how, JSON.stringify(t)).toBe('incremental');
      doc = next;
      expect(bound(v, doc) + envelope([...REQUIRES].sort()), JSON.stringify(t)).toBe(
        exact(doc, [...REQUIRES].sort()),
      );
    }
  });

  it('is never below the canonical size where the canonical form merges text', () => {
    // Two neighbours with the same suggestion marks in another order: ProseMirror keeps them
    // apart, the canonical form merges them.
    const a = mark('ins', { id: 'sAliceInsert0009', user: 'alice' });
    const b = mark('ins', { id: 'sBobInsert000009', user: 'bob' });
    const doc = sink();
    const p = byId(doc, 'pFootnote0000001');
    const after = change(doc, (tr) =>
      tr.insert(p + 1, [schema.text('one', [a, b]), schema.text('two', [b, a])]),
    );
    const v = primed(doc);
    expect(commit(v, doc, after).valid).toBe(true);
    const size = exact(after, [...REQUIRES].sort());
    expect(bound(v, after) + envelope([...REQUIRES].sort())).toBeGreaterThan(size);
  });

  it('sends a document at the limit to the full validation, which measures it exactly', () => {
    // The last paragraph of the example is empty: the first text in it adds a text node.
    const p = byId(example(), 'pZ9y8X7w6V5u4T3s');
    const doc = change(example(), (tr) => tr.insert(p + 1, schema.text('a')));
    const room = LIMITS.canonicalBytes - exact(doc, []);
    // A document 40 bytes under the limit.
    const big = change(doc, (tr) => tr.insert(p + 1, schema.text('a'.repeat(room - 40))));
    expect(exact(big, [])).toBe(LIMITS.canonicalBytes - 40);
    const v = primed(big, {}, []);
    const under = change(big, (tr) => tr.insert(p + 1, schema.text('b'.repeat(40))));
    expect(exact(under, [])).toBe(LIMITS.canonicalBytes);
    expect(commit(v, big, under, {}, [])).toMatchObject({ how: 'incremental', valid: true });
    const over = change(under, (tr) => tr.insert(p + 1, schema.text('c')));
    const r = commit(v, under, over, {}, []);
    expect(r.how).toBe('full');
    expect(r.violations.map((x) => x.code)).toEqual(['canonical_too_large']);
  }, 60_000);

  it('counts the bytes of a quoted string as RFC 8785 writes it', () => {
    const samples = ['', 'a', '"', '\\', '\b\f\n\r\t', '\u0000\u001f\u007f', 'é', '€', '😀', '  '];
    let all = '';
    for (let c = 0; c < 0xd800; c += 7) all += String.fromCharCode(c);
    for (let c = 0xe000; c < 0x10000; c += 61) all += String.fromCharCode(c);
    for (let c = 0x10000; c < 0x110000; c += 4099) all += String.fromCodePoint(c);
    for (const s of [...samples, all])
      expect(quotedBytes(s), JSON.stringify(s).slice(0, 30)).toBe(utf8(JSON.stringify(s)).length);
    for (const s of ['\uD800', 'a\uDC00', '\uD800a', '\uDBFF'])
      expect(() => quotedBytes(s), JSON.stringify(s)).toThrow(/lone surrogate/);
  });
});
