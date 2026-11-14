/**
 * Increase and decrease indent (FE-129 criterion 4): each step moves the left indent of the selected
 * paragraphs by the document's default tab stop, a decrease stops at zero, and the same commands
 * run through the document API. The document is the spike document; its first body paragraph is the
 * one the caret is in.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { defaultTabStopOf, MAX_INDENT_TWIPS, steppedIndent } from '../src/paragraph-indent.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

const microtask = (run: () => void) => queueMicrotask(run);

/** The spike document with its default tab stop changed. */
function documentWithTabStop(twips: number): unknown {
  const doc = JSON.parse(JSON.stringify(spikeDocument())) as unknown;
  const find = (node: unknown): Record<string, unknown> | null => {
    if (node === null || typeof node !== 'object') return null;
    const record = node as { type?: unknown; attrs?: Record<string, unknown> };
    if (record.type === 'settings' && record.attrs) return record.attrs;
    for (const child of Object.values(node as Record<string, unknown>)) {
      const items = Array.isArray(child) ? child : [child];
      for (const item of items) {
        const found = find(item);
        if (found) return found;
      }
    }
    return null;
  };
  const attrs = find(doc);
  if (!attrs) throw new Error('no settings');
  attrs['defaultTabStop'] = twips;
  return doc;
}

function core(tab?: number): DocumentCore {
  const doc = tab === undefined ? spikeDocument() : documentWithTabStop(tab);
  return new DocumentCore({ doc: doc as never, schedule: microtask });
}

/** The caret in the first body paragraph, which the indent commands change. */
function caretInFirstParagraph(c: DocumentCore): void {
  const i = internals(c);
  const pos = bodyRange(i.state.doc).start + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

function firstParagraph(doc: PMNode): PMNode {
  const para = doc.lastChild!.firstChild!;
  expect(para.type.name).toBe('paragraph');
  return para;
}

/** The left indent in twips; a paragraph with none counts as zero. */
function indentOf(c: DocumentCore): unknown {
  return firstParagraph(internals(c).state.doc).attrs['indentLeft'] ?? 0;
}

describe('increase and decrease indent (FE-129 criterion 4)', () => {
  it('moves the left indent by the default tab stop of the document', () => {
    const c = core();
    expect(defaultTabStopOf(internals(c).state.doc)).toBe(720);
    caretInFirstParagraph(c);
    expect(c.exec('increaseIndent')).toBe(true);
    expect(indentOf(c)).toBe(720);
    expect(c.exec('increaseIndent')).toBe(true);
    expect(indentOf(c)).toBe(1440);
    expect(c.exec('decreaseIndent')).toBe(true);
    expect(indentOf(c)).toBe(720);
  });

  it('uses the tab stop the document sets, not a fixed one', () => {
    const c = core(360);
    caretInFirstParagraph(c);
    c.exec('increaseIndent');
    expect(indentOf(c)).toBe(360);
  });

  it('stops a decrease at zero and leaves the indent at zero', () => {
    const c = core();
    caretInFirstParagraph(c);
    expect(c.exec('decreaseIndent')).toBe(true);
    expect(indentOf(c)).toBe(0);
    expect(c.queryCommand('decreaseIndent')).toEqual({ enabled: true, active: false });
  });

  it('refuses a step that would pass the CDM length range, and changes nothing', () => {
    expect(steppedIndent(MAX_INDENT_TWIPS, 720, 'increase')).toBeNull();
    expect(steppedIndent(null, 720, 'increase')).toBe(720);
    expect(steppedIndent(200, 720, 'decrease')).toBe(0);
  });

  it('any sequence of steps leaves the indent at the clamped sum of the steps (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 12 }), (steps) => {
        const c = core();
        caretInFirstParagraph(c);
        let expected = 0;
        for (const up of steps) {
          c.exec(up ? 'increaseIndent' : 'decreaseIndent');
          expected = up ? expected + 720 : Math.max(0, expected - 720);
        }
        expect(indentOf(c)).toBe(expected);
      }),
      { numRuns: 40 },
    );
  });
});
