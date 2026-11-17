/**
 * What the math editor (FE-070) needs of the core: the equation the person selected, a request to
 * open the editor (double click or Enter), the answer to "may I change this equation", and the
 * confirmation that waits for the document service. The mock service runs a stand-in math gate
 * (09 §6.3) so that a rejection arrives as the real protocol delivers it: the commit is rejected
 * with `invalid_op`, the sync client takes the change back and reports the service's message.
 */
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmJsonNode } from '../src/api.ts';
import { type DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { join, newService } from './support.ts';

/** The contract document with an inline equation in an open paragraph and one in the restricted region. */
function envelope(): ReturnType<typeof contractDocument> {
  const env = contractDocument();
  const add = (node: CdmJsonNode, id: string, latex: string): boolean => {
    if (node.attrs?.['id'] === id) {
      node.content = [...(node.content ?? []), { type: 'equation', attrs: { latex } }];
      return true;
    }
    return (node.content ?? []).some((c) => add(c, id, latex));
  };
  const doc = env.doc as unknown as CdmJsonNode;
  if (!add(doc, IDS.intro, 'x') || !add(doc, IDS.lockedPara, 'y'))
    throw new Error('the contract document changed');
  return env;
}

/** A stand-in for the converter's gate: it refuses the definition of a macro. */
const gate = (latex: string): string | null =>
  latex.includes('\\def') ? '\\def is not allowed in an equation' : null;

function equations(core: DocumentCore): number[] {
  const out: number[] = [];
  internals(core).state.doc.descendants((n, pos) => {
    if (n.type.name === 'equation' || n.type.name === 'equation_block') out.push(pos);
    return true;
  });
  return out;
}

function select(core: DocumentCore, pos: number): void {
  const i = internals(core);
  i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, pos)));
}

describe('the equation the person selected (FE-070)', () => {
  it('reports a selected equation with its source and display kind, and nothing else', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const m = await join(service, docId, 'ada', 'editor');
    const [first] = equations(m.core);
    expect(m.core.selectedEquation()).toBeNull();
    select(m.core, first!);
    expect(m.core.selectedEquation()).toEqual({ pos: first, latex: 'x', display: false });
    expect(m.core.equationAt(first! - 1)).toBeNull();
    m.detach();
    await service.dispose();
  });

  it('answers a request to edit with the equation, counted, and refuses a position with none', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const m = await join(service, docId, 'ada', 'editor');
    const [first] = equations(m.core);
    expect(m.core.requestEquationEdit(first! - 1)).toBe(false);
    expect(m.core.equationRequest.get()).toBeNull();
    expect(m.core.requestEquationEdit(first)).toBe(true);
    expect(m.core.equationRequest.get()).toEqual({ n: 1, pos: first, latex: 'x', display: false });
    select(m.core, first!);
    expect(m.core.requestEquationEdit()).toBe(true);
    expect(m.core.equationRequest.get()?.n).toBe(2);
    m.detach();
    await service.dispose();
  });
});

describe('who may change an equation (FE-070 criterion 7)', () => {
  it('says an editor may, and a reader and a scope without edit may not', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const editor = await join(service, docId, 'ada', 'editor');
    const [body, inRegion] = equations(editor.core);
    expect(editor.core.equationAccess(body!)).toEqual({ canEdit: true });
    expect(editor.core.equationAccess(body! - 1)).toEqual({
      canEdit: false,
      reason: 'not-equation',
    });
    // The region has no grant for this person: the guard refuses it.
    expect(editor.core.equationAccess(inRegion!).canEdit).toBe(false);
    const reader = await join(service, docId, 'bo', 'viewer');
    const answer = reader.core.equationAccess(equations(reader.core)[0]!);
    expect(answer.canEdit).toBe(false);
    expect(answer.reason).toEqual(expect.any(String));
    editor.detach();
    reader.detach();
    await service.dispose();
  });
});

describe('confirming an equation (FE-070 criteria 2 to 4)', () => {
  it('stores a source in one commit once the service has accepted it', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const m = await join(service, docId, 'ada', 'editor');
    const [pos] = equations(m.core);
    const seq = m.core.confirmedSeq.get();
    expect(await m.core.confirmEquation(pos!, '\\frac{a}{b}')).toEqual({
      ok: true,
      confirmed: true,
    });
    expect(m.core.equationAt(pos!)!.latex).toBe('\\frac{a}{b}');
    expect(m.core.confirmedSeq.get()).toBe(seq + 1);
    m.detach();
    await service.dispose();
  });

  it('refuses a source over the limits with its reason and changes nothing', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const m = await join(service, docId, 'ada', 'editor');
    const [pos] = equations(m.core);
    const long = await m.core.confirmEquation(pos!, 'x'.repeat(4001));
    const deep = await m.core.confirmEquation(pos!, '{'.repeat(51) + '}'.repeat(51));
    expect(long.ok).toBe(false);
    expect(deep.ok).toBe(false);
    expect(m.core.equationAt(pos!)!.latex).toBe('x');
    expect(m.core.confirmedSeq.get()).toBe(0);
    m.detach();
    await service.dispose();
  });

  it('takes back a source the math gate rejects and tells why, keeping the old source', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const m = await join(service, docId, 'ada', 'editor');
    const [pos] = equations(m.core);
    const outcome = await m.core.confirmEquation(pos!, '\\def\\a{b}');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('rejected');
      expect(outcome.message).toContain('\\def is not allowed');
    }
    // The change was taken back: the equation is as it was, and the person's work is in recovered.
    expect(m.core.equationAt(pos!)!.latex).toBe('x');
    // A source the gate accepts goes through afterwards.
    expect(await m.core.confirmEquation(pos!, 'z')).toEqual({ ok: true, confirmed: true });
    expect(m.core.equationAt(pos!)!.latex).toBe('z');
    m.detach();
    await service.dispose();
  });
});

describe('returning to the equation (FE-070 criterion 6)', () => {
  it('selects the equation again after a reload took the selection', async () => {
    const service = newService({ mathGate: gate });
    const docId = service.createDocument(envelope());
    const m = await join(service, docId, 'ada', 'editor');
    const [pos] = equations(m.core);
    expect(m.core.selectedEquation()).toBeNull();
    expect(m.core.selectEquation(pos!)).toBe(true);
    expect(m.core.selectedEquation()?.pos).toBe(pos);
    expect(m.core.selectEquation(pos! - 1)).toBe(false);
    m.detach();
    await service.dispose();
  });
});
