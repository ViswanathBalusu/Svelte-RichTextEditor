/**
 * Paragraph format command (lane V-FE-129-141, FE-129 criterion 1, the storage half): the values are
 * written as integer and enumerated properties of the paragraphs the caret is in, and out-of-range,
 * unknown or non-integer values change nothing.
 */
import { describe, expect, it } from 'vitest';
import { TextSelection, type Command } from 'prosemirror-state';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { setParagraphFormat, validParagraphFormat } from '../src/paragraph-format.ts';

const microtask = (run: () => void) => queueMicrotask(run);

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument() as never, schedule: microtask });
}

/** Puts the caret in the first body paragraph and returns the paragraph's attributes after `cmd`. */
function runOn(c: DocumentCore, cmd: (pos: number) => Command): Record<string, unknown> {
  const i = internals(c);
  const start = bodyRange(i.state.doc).start + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, start)));
  const state = internals(c).state;
  const ran = cmd(start)(state, (tr) => internals(c).dispatch(tr));
  expect(typeof ran).toBe('boolean');
  const now = internals(c).state;
  const para = now.doc.resolve(now.selection.from).parent;
  return { ...para.attrs, __ran: ran };
}

describe('setParagraphFormat (V-FE-129-141)', () => {
  it('writes an integer indent and enumerated line rule onto the caret paragraph', () => {
    const c = core();
    const attrs = runOn(c, () =>
      setParagraphFormat({ indentLeft: 720, lineRule: 'exact', lineSpacing: 360 }, () => true),
    );
    expect(attrs['__ran']).toBe(true);
    expect(attrs['indentLeft']).toBe(720);
    expect(attrs['lineRule']).toBe('exact');
    expect(attrs['lineSpacing']).toBe(360);
  });

  it('stores booleans for keep and widow properties', () => {
    const c = core();
    const attrs = runOn(c, () =>
      setParagraphFormat(
        { keepNext: true, keepLines: true, pageBreakBefore: false, widowControl: true },
        () => true,
      ),
    );
    expect(attrs['keepNext']).toBe(true);
    expect(attrs['keepLines']).toBe(true);
    expect(attrs['pageBreakBefore']).toBe(false);
    expect(attrs['widowControl']).toBe(true);
  });

  it('refuses a fractional twip value and changes nothing', () => {
    const c = core();
    const before = runOn(c, () => setParagraphFormat({ spaceAfter: 0 }, () => true));
    const attrs = runOn(c, () => setParagraphFormat({ spaceAfter: 1.5 }, () => true));
    expect(attrs['__ran']).toBe(false);
    expect(attrs['spaceAfter']).toBe(before['spaceAfter']);
  });

  it('refuses a space before below zero and a left indent past the CDM range', () => {
    expect(validParagraphFormat({ spaceBefore: -1 })).toBe(false);
    expect(validParagraphFormat({ indentLeft: 31681 })).toBe(false);
    expect(validParagraphFormat({ indentLeft: -31680 })).toBe(true);
  });

  it('refuses an enumeration it does not know and an unknown property', () => {
    expect(validParagraphFormat({ align: 'left' })).toBe(false);
    expect(validParagraphFormat({ lineRule: 'double' })).toBe(false);
    // A patch from outside can carry a key the type does not list; a valid key beside it does not
    // make it acceptable. The variable (not a literal) is how such a value reaches the function.
    // (`numbering` is a property of styles only, 03 §4.5; `tabs` is a key since UX-102.)
    const withUnknownKey = { align: 'center', numbering: null };
    expect(validParagraphFormat(withUnknownKey)).toBe(false);
    expect(validParagraphFormat({})).toBe(false);
  });

  it('is unavailable when no selected paragraph may be changed', () => {
    const c = core();
    const attrs = runOn(c, () => setParagraphFormat({ align: 'center' }, () => false));
    expect(attrs['__ran']).toBe(false);
    expect(attrs['align']).toBeNull();
  });

  it('reports availability without dispatching when there is no dispatch function', () => {
    const c = core();
    const i = internals(c);
    const start = bodyRange(i.state.doc).start + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, start)));
    const ran = setParagraphFormat({ align: 'center' }, () => true)(internals(c).state);
    expect(ran).toBe(true);
    expect(internals(c).state.doc.resolve(start).parent.attrs['align']).toBeNull();
  });
});
