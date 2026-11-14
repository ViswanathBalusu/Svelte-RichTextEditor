/**
 * Copy, cut and paste of content that holds a placeholder or a redacted value (FE-141 criterion 3;
 * ADR 0019, "What a reader may not send"). Drag is the view's and is not tested here.
 */
import type { CdmFragment } from '../src/api.ts';
import { clipboardPayload } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { SPIKE_IDS, ownerAccess, projectedDocument, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

function projected(): DocumentCore {
  return new DocumentCore({
    doc: projectedDocument('Clause'),
    access: ownerAccess(),
    schedule: microtask,
  });
}

/** The position of the placeholder in a projection (the hidden region's identifier). */
function placeholderAt(c: DocumentCore): number {
  return posOf(internals(c).state.doc, SPIKE_IDS.region);
}

describe('copy and cut refuse content that carries a placeholder (FE-141 criterion 3)', () => {
  it('copies nothing when the placeholder is selected whole, and records the refusal', () => {
    const c = projected();
    const i = internals(c);
    const at = placeholderAt(c);
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
    expect(c.copySelection()).toBeNull();
    expect(c.refusal.get()?.reason).toBe('placeholder');
  });

  it('copies nothing from a text selection that spans a placeholder, and a cut deletes nothing', () => {
    const c = projected();
    const i = internals(c);
    const at = placeholderAt(c);
    const before = internals(c).state.doc;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at - 2, at + 3)));
    expect(c.copySelection()).toBeNull();
    expect(c.refusal.get()?.reason).toBe('placeholder');
    const cut = c.cutSelection();
    expect(cut).toEqual({ payload: null, deleted: false });
    expect(internals(c).state.doc).toBe(before);
    expect(internals(c).state.doc.nodeAt(placeholderAt(c))?.type.name).toBe('hidden_region');
  });

  it('still copies a selection that holds no placeholder', () => {
    const c = projected();
    const i = internals(c);
    const after = posOf(i.state.doc, SPIKE_IDS.after);
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, after + 1, after + 3)));
    const payload = c.copySelection();
    expect(payload).not.toBeNull();
    expect(payload!['text/html']).not.toContain('hidden_region');
    expect(c.refusal.get()).toBeNull();
  });

  it('refuses to copy a redacted value and writes nothing', () => {
    const env = spikeDocument();
    const doc = structuredClone(env.doc) as {
      content: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    const body = doc.content[doc.content.length - 1]!;
    body.content!.push({
      type: 'paragraph',
      attrs: { id: 'pField0000000002' },
      content: [
        {
          type: 'form_field',
          attrs: { id: 'fSecret000000002', kind: 'text', key: 'salary', value: { redacted: true } },
        },
      ],
    });
    const c = new DocumentCore({
      doc: { ...env, requires: ['fields'], doc },
      access: ownerAccess(),
      schedule: microtask,
    });
    const i = internals(c);
    let field = -1;
    i.state.doc.descendants((n, pos) => {
      if (n.type.name === 'form_field') field = pos;
      return field < 0;
    });
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, field)));
    expect(c.copySelection()).toBeNull();
    expect(c.refusal.get()?.reason).toBe('redacted');
  });
});

describe('paste refuses content that carries a placeholder (FE-141 criterion 3; ADR 0019)', () => {
  it('changes nothing when the clipboard holds a fragment with a placeholder', () => {
    const c = projected();
    const i = internals(c);
    const after = posOf(i.state.doc, SPIKE_IDS.after);
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, after + 1)));
    const before = internals(c).state.doc;
    const fragment = {
      cdm: 1,
      requires: [],
      defs: [],
      content: [{ type: 'hidden_region', attrs: { id: 'rHidden0000000001', title: 'Clause' } }],
      openStart: 0,
      openEnd: 0,
    } as unknown as CdmFragment;
    const result = c.pasteFromClipboard({ html: clipboardPayload(fragment)['text/html'] });
    expect(result.ok).toBe(false);
    expect(internals(c).state.doc).toBe(before);
  });
});
