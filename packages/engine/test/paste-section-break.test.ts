/**
 * A foreign fragment pasted inside a region keeps its paragraphs and loses its section breaks, which
 * may not sit in a region (FE-051 criterion 5; 03 §4.2, I1 to I12).
 */
import { validate } from '@docedit/model/validate';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmFragment } from '../src/api.ts';
import { clipboardPayload } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, regionOnlyAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

/** A hand-built fragment: the given content, no definitions, no page setup of its own. */
function fragmentWith(content: unknown[]): CdmFragment {
  return {
    cdm: 1,
    requires: [],
    defs: [],
    content,
    openStart: 0,
    openEnd: 0,
  } as unknown as CdmFragment;
}

const paragraph = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id, style: null },
  content: [{ type: 'text', text }],
});

describe('a section break in a pasted fragment is dropped inside a region (FE-051 criterion 5)', () => {
  it('keeps the paragraphs, adds no section break to the region, and leaves the document valid', () => {
    const fragment = fragmentWith([
      paragraph('foreignParaA00001', 'Before the break'),
      {
        type: 'section_break',
        attrs: { id: 'foreignSbk000001', pageSetup: 'ps1', start: 'nextPage' },
      },
      paragraph('foreignParaB00001', 'After the break'),
    ]);
    const html = clipboardPayload(fragment)['text/html'];
    const target = new DocumentCore({
      doc: spikeDocument(),
      access: regionOnlyAccess(),
      schedule: microtask,
    });
    const doc0 = internals(target).state.doc;
    const breaksBefore = countSectionBreaks(doc0);
    const at = posOf(doc0, SPIKE_IDS.legal) + 1;
    internals(target).dispatch(
      internals(target).state.tr.setSelection(TextSelection.create(doc0, at)),
    );
    const result = target.pasteFromClipboard({ html });
    expect(result.ok).toBe(true);
    const doc = internals(target).state.doc;
    expect(countSectionBreaks(doc)).toBe(breaksBefore);
    expect(doc.textContent).toContain('Before the break');
    expect(doc.textContent).toContain('After the break');
    expect(validate(target.getContent()).violations).toEqual([]);
  });
});

/** The section breaks anywhere in the document. */
function countSectionBreaks(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === 'section_break') n += 1;
    return true;
  });
  return n;
}
