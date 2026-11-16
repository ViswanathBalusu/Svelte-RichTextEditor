/**
 * Paste of content that holds a redacted value (FE-141 criterion 3; ADR 0019, "What a reader may
 * not send"). A redaction marker stands for a value the reader may not see, so a fragment that
 * carries one is refused whole and the document does not change. The placeholder half is in
 * `fe-141-copy-placeholder.test.ts`.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmFragment } from '../src/api.ts';
import { clipboardPayload } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, ownerAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

function core(): DocumentCore {
  const env = spikeDocument();
  return new DocumentCore({
    doc: { ...env, requires: ['fields'] },
    access: ownerAccess(),
    schedule: microtask,
  });
}

function fragmentWith(value: unknown): CdmFragment {
  return {
    cdm: 1,
    requires: ['fields'],
    defs: [],
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'pPasted000000001' },
        content: [
          { type: 'text', text: 'Pay ' },
          {
            type: 'form_field',
            attrs: { id: 'fPasted000000001', kind: 'text', key: 'salary', value },
          },
        ],
      },
    ],
    openStart: 0,
    openEnd: 0,
  } as unknown as CdmFragment;
}

function caretAfter(c: DocumentCore): void {
  const i = internals(c);
  const after = posOf(i.state.doc, SPIKE_IDS.after);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, after + 1)));
}

describe('paste refuses content that carries a redacted value (FE-141 criterion 3)', () => {
  it('changes nothing when the clipboard holds a fragment with a redacted field value', () => {
    const c = core();
    caretAfter(c);
    const before = internals(c).state.doc;
    const html = clipboardPayload(fragmentWith({ redacted: true }))['text/html'];
    const result = c.pasteFromClipboard({ html });
    expect(result.ok).toBe(false);
    expect(internals(c).state.doc).toBe(before);
    expect(c.refusal.get()?.reason).toBe('redacted');
  });

  it('pastes the same fragment when the field holds a value the reader can see', () => {
    const c = core();
    caretAfter(c);
    const html = clipboardPayload(fragmentWith('1000'))['text/html'];
    const result = c.pasteFromClipboard({ html });
    expect(result.ok).toBe(true);
    let fields = 0;
    internals(c).state.doc.descendants((n) => {
      if (n.type.name === 'form_field') fields++;
    });
    expect(fields).toBe(1);
  });
});
