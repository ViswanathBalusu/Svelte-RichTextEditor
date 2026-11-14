/**
 * Paragraph styles (FE-127) and the outline (FE-026 criterion 5): applied through the command of the
 * document API, with the region guard's rules, and read back through the read views.
 */
import { TextSelection } from 'prosemirror-state';
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals, press } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { caret, microtask, posOf } from './support.ts';

const core = (access: ReturnType<typeof styledEditorAccess> | null = styledEditorAccess()) =>
  new DocumentCore({ doc: styledDocument(), access, schedule: microtask });

const styleOf = (c: DocumentCore, id: string) =>
  internals(c).state.doc.nodeAt(posOf(internals(c).state.doc, id))!.attrs['style'];

function selectBetween(c: DocumentCore, fromId: string, toId: string): void {
  const i = internals(c);
  const from = posOf(i.state.doc, fromId) + 1;
  const to = posOf(i.state.doc, toId) + 2;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

describe('applying paragraph styles (FE-127)', () => {
  it('gives every selected paragraph the style identifier, with attribute steps only', () => {
    const c = core();
    const i = internals(c);
    const marks = JSON.stringify(i.state.doc.toJSON()).match(/"marks"/g)?.length ?? 0;
    const steps: unknown[] = [];
    const stop = i.onTransaction((tr) => steps.push(...tr.steps));
    selectBetween(c, STYLE_IDS.heading, STYLE_IDS.plain);
    expect(c.run('paragraphStyle', { style: 'Heading2' })).toBe(true);
    stop();
    for (const id of [STYLE_IDS.heading, STYLE_IDS.quote, STYLE_IDS.plain])
      expect(styleOf(c, id)).toBe('Heading2');
    // No direct formatting: no mark added, nothing but the style attribute changed, ids kept.
    expect(JSON.stringify(i.state.doc.toJSON()).match(/"marks"/g)?.length ?? 0).toBe(marks);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(s).toBeInstanceOf(AttrStep);
      expect((s as AttrStep).attr).toBe('style');
    }
  });

  it('works at a caret, with the three styles of the minimum demo and every style the document defines', () => {
    const c = core();
    for (const style of ['Normal', 'Heading1', 'Heading2', 'Quote', 'Chapter']) {
      caret(c, STYLE_IDS.plain, 2);
      expect(c.run('paragraphStyle', { style })).toBe(true);
      expect(styleOf(c, STYLE_IDS.plain)).toBe(style);
    }
    // A character style or an unknown identifier is not a paragraph style.
    expect(c.run('paragraphStyle', { style: 'Emphasis' })).toBe(false);
    expect(c.run('paragraphStyle', { style: 'NoSuchStyle' })).toBe(false);
    expect(c.paragraphStyles().map((s) => s.id)).toEqual([
      'Normal',
      'Heading1',
      'Heading2',
      'Quote',
      'Chapter',
    ]);
  });

  it('Enter at the end of a paragraph gives the new one the style’s next, or the same style without next', () => {
    const c = core();
    const key = (name: string) => {
      const i = internals(c);
      return press(i.schema, name, i.state, i.dispatch);
    };
    caret(c, STYLE_IDS.heading, 'end');
    key('Enter');
    let $from = internals(c).state.selection.$from;
    expect($from.parent.attrs['style']).toBe('Normal');
    expect(typeof $from.parent.attrs['id']).toBe('string');
    caret(c, STYLE_IDS.quote, 'end');
    key('Enter');
    $from = internals(c).state.selection.$from;
    expect($from.parent.attrs['style']).toBe('Quote');
    // In the middle, both halves keep the style.
    caret(c, STYLE_IDS.heading, 3);
    key('Enter');
    expect(internals(c).state.selection.$from.parent.attrs['style']).toBe('Heading1');
  });

  it('changes only the paragraphs the user may edit when the selection reaches a protected region', () => {
    const c = core();
    selectBetween(c, STYLE_IDS.plain, STYLE_IDS.after);
    expect(c.run('paragraphStyle', { style: 'Quote' })).toBe(true);
    expect(styleOf(c, STYLE_IDS.plain)).toBe('Quote');
    expect(styleOf(c, STYLE_IDS.after)).toBe('Quote');
    expect(styleOf(c, STYLE_IDS.inRegion)).toBe(null);
    expect(c.refusal.get()).toBeNull();
    // Entirely inside the protected region: not enabled, nothing changes.
    caret(c, STYLE_IDS.inRegion, 2);
    expect(c.queryCommand('paragraphStyle', { style: 'Quote' }).enabled).toBe(false);
    expect(c.run('paragraphStyle', { style: 'Quote' })).toBe(false);
  });

  it('a heading style shows in the outline at once', () => {
    const c = core();
    caret(c, STYLE_IDS.plain, 0);
    c.run('paragraphStyle', { style: 'Chapter' }); // a heading through basedOn Heading1
    expect(c.outline.get()).toEqual([
      { id: STYLE_IDS.heading, level: 1, text: 'Introduction' },
      { id: STYLE_IDS.plain, level: 1, text: 'Plain text' },
    ]);
  });

  it('queryCommand and the selection view report the current style and whether the command applies', () => {
    const c = core();
    caret(c, STYLE_IDS.quote, 1);
    expect(c.selection.get().style).toBe('Quote');
    expect(c.queryCommand('paragraphStyle', { style: 'Quote' })).toEqual({
      enabled: true,
      active: true,
    });
    expect(c.queryCommand('paragraphStyle', { style: 'Normal' })).toEqual({
      enabled: true,
      active: false,
    });
    // A paragraph without a style has the default paragraph style (03 §4.3).
    caret(c, STYLE_IDS.plain, 1);
    expect(c.selection.get().style).toBe('Normal');
    // Mixed selection: no single style.
    selectBetween(c, STYLE_IDS.heading, STYLE_IDS.quote);
    expect(c.selection.get().style).toBeNull();
  });
});

describe('the outline (FE-026 criterion 5)', () => {
  it('lists headings by the style cascade, in document order, with level, text and identifier', () => {
    const c = core(null);
    expect(c.outline.get()).toEqual([{ id: STYLE_IDS.heading, level: 1, text: 'Introduction' }]);
    caret(c, STYLE_IDS.after, 0);
    c.run('paragraphStyle', { style: 'Heading2' });
    caret(c, STYLE_IDS.inRegion, 0);
    c.run('paragraphStyle', { style: 'Heading1' });
    expect(c.outline.get()).toEqual([
      { id: STYLE_IDS.heading, level: 1, text: 'Introduction' },
      { id: STYLE_IDS.inRegion, level: 1, text: 'Protected text' },
      { id: STYLE_IDS.after, level: 2, text: 'After the region' },
    ]);
  });
});
