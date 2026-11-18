/**
 * FE-136 criterion 5 through the core: the equation command inserts an empty inline or block
 * equation at the caret and asks the shell to open the math editor on it (FE-070). The editor
 * itself is the element's (packages/element/test/fe-070-math-editor-service.test.ts); here the
 * request that opens it is checked.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { LAYOUT_IDS, layoutEnvelope } from './layout-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

const OWNER: Access = {
  rev: 1,
  asOfSeq: 0,
  docRole: 'owner',
  caps: [...EDIT, 'structure', 'manage'],
  scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
  leases: {},
  fill: null,
  restrictions: [],
};

function core(access: Access = OWNER): DocumentCore {
  const doc = layoutEnvelope() as unknown as CdmJsonNode;
  const envelope: CdmEnvelope = { cdm: 1, requires: [], doc };
  return new DocumentCore({ doc: envelope, access, schedule: microtask });
}

/** The equations of the document in order, as `[type, latex]`. */
function equations(c: DocumentCore): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  internals(c).state.doc.descendants((node) => {
    if (node.type.name === 'equation' || node.type.name === 'equation_block')
      out.push([node.type.name, node.attrs['latex']]);
    return true;
  });
  return out;
}

describe('the equation command opens the math editor (FE-136 criterion 5)', () => {
  it('inserts an empty inline equation at the caret and asks for the editor on it', () => {
    const c = core();
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.equationRequest.get()).toBeNull();
    expect(c.exec('insertEquation', { newEquation: { display: false } })).toBe(true);
    expect(equations(c)).toEqual([['equation', '']]);
    const request = c.equationRequest.get();
    expect(request).toMatchObject({ latex: '', display: false });
    // The request names the new node.
    expect(internals(c).state.doc.nodeAt(request!.pos)?.type.name).toBe('equation');
    internals(c).state.doc.check();
  });

  it('inserts an empty block equation after the caret block and asks for the editor on it', () => {
    const c = core();
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.exec('insertEquation', { newEquation: { display: true } })).toBe(true);
    expect(equations(c)).toEqual([['equation_block', '']]);
    const request = c.equationRequest.get();
    expect(request).toMatchObject({ latex: '', display: true });
    const doc = internals(c).state.doc;
    expect(doc.nodeAt(request!.pos)?.type.name).toBe('equation_block');
    // It stands right after the paragraph the caret was in.
    const before = doc.resolve(request!.pos).nodeBefore;
    expect(before?.attrs['id']).toBe(LAYOUT_IDS.pB);
    doc.check();
  });

  it('counts each request, so a second equation opens the editor again', () => {
    const c = core();
    caret(c, LAYOUT_IDS.pB, 2);
    c.exec('insertEquation', { newEquation: { display: false } });
    const first = c.equationRequest.get()!.n;
    c.exec('insertEquation', { newEquation: { display: false } });
    expect(c.equationRequest.get()!.n).toBe(first + 1);
  });

  it('is refused without a change or a request in a document the person may not change', () => {
    const c = core({ ...OWNER, caps: ['view'], scopes: { doc: ['view'], body: ['view'] } });
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.queryCommand('insertEquation', { newEquation: { display: false } }).enabled).toBe(
      false,
    );
    expect(c.exec('insertEquation', { newEquation: { display: false } })).toBe(false);
    expect(equations(c)).toEqual([]);
    expect(c.equationRequest.get()).toBeNull();
  });

  it('needs its argument', () => {
    const c = core();
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.exec('insertEquation')).toBe(false);
    expect(equations(c)).toEqual([]);
  });
});
