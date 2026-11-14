/**
 * Character value commands (FE-128 criteria 2, 3, 5 and 6): font family, size, colour, highlight,
 * language, character style and clear formatting, run through the document API in Node.js.
 * Criterion 7 (suggestions, FE-043) is not built and is not tested here.
 */
import fc from 'fast-check';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import type { CommandArgs, CommandName } from '../src/api.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { caret, microtask, posOf, type } from './support.ts';

/** The paragraph 'Plain text' of the styled fixture; its first five characters are 'Plain'. */
const PARA = STYLE_IDS.plain;
const PLAIN_LENGTH = 'Plain text'.length;

function core(): DocumentCore {
  return new DocumentCore({
    doc: styledDocument(),
    access: styledEditorAccess(),
    schedule: microtask,
  });
}

function select(c: DocumentCore, from: number, to: number): void {
  const i = internals(c);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

/** The absolute range of the paragraph's text, from `from` to `to` characters in. */
function textRange(c: DocumentCore, from = 0, to = PLAIN_LENGTH): { from: number; to: number } {
  const start = posOf(internals(c).state.doc, PARA) + 1;
  return { from: start + from, to: start + to };
}

/** The first mark of the given type on the text of a range, or undefined when none is there. */
function markOn(doc: PMNode, from: number, to: number, name: string): Mark | undefined {
  let found: Mark | undefined;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && found === undefined) found = node.marks.find((m) => m.type.name === name);
    return true;
  });
  return found;
}

/** Whether every character of a range carries a mark of this type. */
function allHave(doc: PMNode, from: number, to: number, name: string): boolean {
  let ok = true;
  let seen = 0;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    seen += Math.min(to, pos + node.nodeSize) - Math.max(from, pos);
    if (!node.marks.some((m) => m.type.name === name)) ok = false;
    return true;
  });
  return ok && seen === to - from;
}

/** Whether no character of a range carries a mark of this type. */
function noneHave(doc: PMNode, from: number, to: number, name: string): boolean {
  let ok = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type.name === name)) ok = false;
    return ok;
  });
  return ok;
}

describe('font, size, colour, highlight and language (FE-128 criterion 2 and 3)', () => {
  it('stores a size in twentieths of a point on the selection', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('fontSize', { fontSize: 240 })).toBe(true);
    const doc = internals(c).state.doc;
    expect(markOn(doc, r.from, r.to, 'fontSize')?.attrs['value']).toBe(240);
    expect(allHave(doc, r.from, r.to, 'fontSize')).toBe(true);
    expect(noneHave(doc, r.to, r.to + 1, 'fontSize')).toBe(true);
  });

  it('refuses a size that is not an integer in twentieths of a point, and a size outside the range', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    for (const fontSize of [12.5, 19, 32761, Number.NaN]) {
      expect(c.run('fontSize', { fontSize })).toBe(false);
    }
    expect(noneHave(internals(c).state.doc, r.from, r.to, 'fontSize')).toBe(true);
  });

  it('stores a colour as #RRGGBB in upper case and refuses anything else', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('color', { color: '#1a2b3c' })).toBe(true);
    expect(markOn(internals(c).state.doc, r.from, r.to, 'color')?.attrs['value']).toBe('#1A2B3C');
    for (const color of ['red', '#12345', '#GG0000', '1A2B3C']) {
      expect(c.run('color', { color })).toBe(false);
    }
  });

  it('stores a highlight from the CDM colours only', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('highlight', { highlight: 'yellow' })).toBe(true);
    expect(markOn(internals(c).state.doc, r.from, r.to, 'highlight')?.attrs['value']).toBe(
      'yellow',
    );
    expect(c.run('highlight', { highlight: 'purple' })).toBe(false);
  });

  it('stores a font family from the allowed grammar and refuses a value with a separator', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('fontFamily', { fontFamily: 'Garamond' })).toBe(true);
    expect(markOn(internals(c).state.doc, r.from, r.to, 'fontFamily')?.attrs['value']).toBe(
      'Garamond',
    );
    expect(c.run('fontFamily', { fontFamily: 'Garamond; color: red' })).toBe(false);
    expect(c.run('fontFamily', { fontFamily: '' })).toBe(false);
  });

  it('applies a BCP 47 language tag as a lang mark and refuses a malformed tag', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('lang', { lang: 'de-CH' })).toBe(true);
    expect(markOn(internals(c).state.doc, r.from, r.to, 'lang')?.attrs['value']).toBe('de-CH');
    expect(c.run('lang', { lang: 'not a tag' })).toBe(false);
  });

  it('null removes the value and leaves the rest of the formatting', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    c.run('bold');
    c.run('color', { color: '#FF0000' });
    expect(c.run('color', { color: null })).toBe(true);
    const doc = internals(c).state.doc;
    expect(noneHave(doc, r.from, r.to, 'color')).toBe(true);
    expect(allHave(doc, r.from, r.to, 'bold')).toBe(true);
  });

  it('a value command with no value given is unavailable', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('fontSize')).toBe(false);
    expect(c.queryCommand('fontSize')).toEqual({ enabled: false, active: false });
  });
});

describe('a value at a collapsed caret (FE-128 criterion 4 applied to values)', () => {
  it('the next typed text carries the value', () => {
    const c = core();
    caret(c, PARA, 3);
    expect(c.run('highlight', { highlight: 'green' })).toBe(true);
    type(c, 'Z');
    const doc = internals(c).state.doc;
    const at = posOf(doc, PARA) + 1 + 3;
    expect(markOn(doc, at, at + 1, 'highlight')?.attrs['value']).toBe('green');
    expect(noneHave(doc, posOf(doc, PARA) + 1, at, 'highlight')).toBe(true);
  });
});

describe('character styles (FE-128 criterion 5)', () => {
  it('sets the charStyle mark on the selection and leaves direct formatting alone', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    c.run('bold');
    expect(c.run('charStyle', { charStyle: 'Emphasis' })).toBe(true);
    const doc = internals(c).state.doc;
    expect(markOn(doc, r.from, r.to, 'charStyle')?.attrs['style']).toBe('Emphasis');
    expect(allHave(doc, r.from, r.to, 'bold')).toBe(true);
  });

  it('refuses an identifier that is not a character style of the document', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    // 'Quote' is a paragraph style, and 'Missing' is not defined at all.
    expect(c.run('charStyle', { charStyle: 'Quote' })).toBe(false);
    expect(c.run('charStyle', { charStyle: 'Missing' })).toBe(false);
    expect(noneHave(internals(c).state.doc, r.from, r.to, 'charStyle')).toBe(true);
  });

  it('null removes the character style', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    c.run('charStyle', { charStyle: 'Emphasis' });
    expect(c.run('charStyle', { charStyle: null })).toBe(true);
    expect(noneHave(internals(c).state.doc, r.from, r.to, 'charStyle')).toBe(true);
  });
});

describe('clear formatting (FE-128 criterion 6)', () => {
  it('removes the direct formatting and keeps the paragraph style and the character style', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    c.run('bold');
    c.run('italic');
    c.run('fontSize', { fontSize: 300 });
    c.run('color', { color: '#00FF00' });
    c.run('lang', { lang: 'fr' });
    c.run('charStyle', { charStyle: 'Emphasis' });
    const styleBefore = internals(c).state.doc.nodeAt(posOf(internals(c).state.doc, PARA))!.attrs[
      'style'
    ];
    expect(c.run('clearFormatting')).toBe(true);
    const doc = internals(c).state.doc;
    for (const name of ['bold', 'italic', 'fontSize', 'color', 'lang'])
      expect(noneHave(doc, r.from, r.to, name)).toBe(true);
    expect(allHave(doc, r.from, r.to, 'charStyle')).toBe(true);
    expect(internals(c).state.doc.nodeAt(posOf(doc, PARA))!.attrs['style']).toBe(styleBefore);
  });

  it('is unavailable when there is no direct formatting to clear', () => {
    const c = core();
    const r = textRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('clearFormatting')).toBe(false);
  });
});

describe('value commands keep the document valid (FE-128)', () => {
  const VALUE_COMMANDS: readonly CommandName[] = [
    'fontFamily',
    'fontSize',
    'color',
    'highlight',
    'lang',
    'charStyle',
    'clearFormatting',
    'bold',
    'italic',
  ];

  const argsFor = (name: CommandName, pick: number): CommandArgs => {
    const colours = ['#000000', '#FFFFFF', '#1F4E79'];
    switch (name) {
      case 'fontFamily':
        return { fontFamily: ['Arial', 'Garamond', null][pick % 3]! };
      case 'fontSize':
        return { fontSize: [240, 320, null][pick % 3]! };
      case 'color':
        return { color: [colours[pick % 3]!, null][pick % 2]! };
      case 'highlight':
        return { highlight: ['yellow', 'darkBlue', null][pick % 3]! };
      case 'lang':
        return { lang: ['en-GB', 'fr-FR', null][pick % 3]! };
      case 'charStyle':
        return { charStyle: ['Emphasis', null][pick % 2]! };
      default:
        return {};
    }
  };

  it('property: any sequence of value commands and toggles keeps the document valid', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom(...VALUE_COMMANDS),
            fc.integer({ min: 0, max: 5 }),
            fc.integer({ min: 0, max: 3 }),
            fc.integer({ min: 1, max: PLAIN_LENGTH }),
          ),
          { minLength: 1, maxLength: 10 },
        ),
        (steps) => {
          const c = core();
          // The styled fixture already reports two reserved identifiers (I11) that no command makes;
          // the property is that the commands add no violation to those.
          const before = validate(c.getContent()).violations;
          for (const [name, pick, from, len] of steps) {
            const r = textRange(c, from, Math.min(PLAIN_LENGTH, from + len));
            if (r.from === r.to) continue;
            select(c, r.from, r.to);
            c.run(name, argsFor(name, pick));
            expect(validate(c.getContent()).violations).toEqual(before);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
