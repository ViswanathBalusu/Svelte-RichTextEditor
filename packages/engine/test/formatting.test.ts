/**
 * Character formatting in the editing core (FE-128 criteria 1 and 4; 03 §5). Each toggle is a named
 * command of the core; the tests run them on the spike document in Node.js, without a browser.
 * Criteria 2, 3, 5, 6 and 7 are not built: font, size, colour and highlight values, the language
 * mark, character styles, clear formatting and suggestions (FE-043) have no command yet.
 */
import fc from 'fast-check';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import type { CommandName } from '../src/api.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { caret, microtask, posOf, type } from './support.ts';

const TOGGLES: CommandName[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'smallCaps',
  'allCaps',
  'superscript',
  'subscript',
];

/** The text of the intro paragraph's first run, 'Alpha bravo charlie'. */
const RUN_START = 1;
const RUN_LENGTH = 'Alpha bravo charlie'.length;

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: microtask });
}

function select(c: DocumentCore, from: number, to: number): void {
  const i = internals(c);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

/** The absolute positions of the first run of the intro paragraph. */
function runRange(c: DocumentCore, from = 0, to = RUN_LENGTH): { from: number; to: number } {
  const start = posOf(internals(c).state.doc, SPIKE_IDS.intro) + RUN_START;
  return { from: start + from, to: start + to };
}

/** The marks on the text in a range, as `type:json` strings, one set per text node. */
function marksIn(doc: PMNode, from: number, to: number): string[] {
  const out: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isText)
      out.push(
        node.marks
          .map((m: Mark) => m.type.name)
          .sort()
          .join(','),
      );
    return true;
  });
  return out;
}

/** Whether every character of the range carries a mark of this type (with the given attributes). */
function allHave(
  doc: PMNode,
  from: number,
  to: number,
  name: string,
  attrs?: Record<string, unknown>,
): boolean {
  let ok = true;
  let seen = 0;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    seen += end - start;
    const hit = node.marks.some(
      (m) =>
        m.type.name === name &&
        (attrs === undefined || Object.entries(attrs).every(([k, v]) => m.attrs[k] === v)),
    );
    if (!hit) ok = false;
    return true;
  });
  return ok && seen === to - from;
}

/** Whether no character of the range carries a mark of this type. */
function noneHave(doc: PMNode, from: number, to: number, name: string): boolean {
  let ok = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type.name === name)) ok = false;
    return ok;
  });
  return ok;
}

/** Adjacent text nodes with the same marks: ProseMirror must have merged them. */
function unmergedRuns(doc: PMNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    const children: PMNode[] = [];
    node.forEach((child) => children.push(child));
    for (let k = 1; k < children.length; k++) {
      const prev = children[k - 1]!;
      const child = children[k]!;
      if (!prev.isText || !child.isText) continue;
      const a = JSON.stringify(prev.marks.map((m) => m.toJSON()));
      const b = JSON.stringify(child.marks.map((m) => m.toJSON()));
      if (a === b) count++;
    }
    return false;
  });
  return count;
}

describe('character formatting commands (FE-128 criterion 1)', () => {
  it.each([
    ['bold', 'bold'],
    ['italic', 'italic'],
    ['underline', 'underline'],
    ['strike', 'strike'],
    ['smallCaps', 'smallCaps'],
    ['allCaps', 'allCaps'],
  ] as const)(
    '%s adds the %s mark to a selection and removes it on the next toggle',
    (cmd, mark) => {
      const c = core();
      const r = runRange(c, 0, 5);
      select(c, r.from, r.to);
      expect(c.run(cmd)).toBe(true);
      expect(allHave(internals(c).state.doc, r.from, r.to, mark)).toBe(true);
      expect(c.queryCommand(cmd)).toEqual({ enabled: true, active: true });
      expect(c.run(cmd)).toBe(true);
      expect(noneHave(internals(c).state.doc, r.from, r.to, mark)).toBe(true);
      expect(c.queryCommand(cmd)).toEqual({ enabled: true, active: false });
    },
  );

  it('superscript and subscript each set the vertAlign position, and a subscript replaces a superscript', () => {
    const c = core();
    const r = runRange(c, 0, 5);
    select(c, r.from, r.to);
    expect(c.run('superscript')).toBe(true);
    expect(allHave(internals(c).state.doc, r.from, r.to, 'vertAlign', { value: 'super' })).toBe(
      true,
    );
    expect(c.queryCommand('superscript').active).toBe(true);
    expect(c.run('subscript')).toBe(true);
    const doc = internals(c).state.doc;
    expect(allHave(doc, r.from, r.to, 'vertAlign', { value: 'sub' })).toBe(true);
    expect(c.queryCommand('superscript').active).toBe(false);
    expect(c.queryCommand('subscript').active).toBe(true);
    // The same position again clears it.
    expect(c.run('subscript')).toBe(true);
    expect(noneHave(internals(c).state.doc, r.from, r.to, 'vertAlign')).toBe(true);
  });

  it('a toggle over a partly formatted selection follows ProseMirror: any mark in it is removed, then the next toggle adds to all', () => {
    const c = core();
    const first = runRange(c, 0, 5);
    const second = runRange(c, 5, 10);
    select(c, first.from, first.to);
    c.run('underline');
    select(c, first.from, second.to);
    c.run('underline');
    const doc = internals(c).state.doc;
    expect(noneHave(doc, first.from, second.to, 'underline')).toBe(true);
    c.run('underline');
    const after = internals(c).state.doc;
    expect(allHave(after, first.from, second.to, 'underline')).toBe(true);
    expect(unmergedRuns(after)).toBe(0);
  });

  it('the spaces at the edges of a selection take the mark too', () => {
    const c = core();
    const r = runRange(c, 5, 10); // ' brav': a leading space
    select(c, r.from, r.to);
    c.run('underline');
    expect(allHave(internals(c).state.doc, r.from, r.to, 'underline')).toBe(true);
  });

  it('adjacent runs with the same marks are merged into one text node', () => {
    const c = core();
    const a = runRange(c, 0, 5);
    const b = runRange(c, 5, 10);
    select(c, a.from, a.to);
    c.run('smallCaps');
    select(c, b.from, b.to);
    c.run('smallCaps');
    const doc = internals(c).state.doc;
    expect(marksIn(doc, a.from, b.to)).toEqual(['smallCaps']);
    expect(unmergedRuns(doc)).toBe(0);
  });

  it('property: any sequence of toggles keeps the document valid and never leaves unmerged runs', () => {
    const toggle = fc.constantFrom(...TOGGLES);
    const range = fc
      .tuple(fc.integer({ min: 0, max: RUN_LENGTH - 1 }), fc.integer({ min: 1, max: RUN_LENGTH }))
      .map(([from, len]) => [from, Math.min(RUN_LENGTH, from + len)] as const);
    fc.assert(
      fc.property(fc.array(fc.tuple(toggle, range), { minLength: 1, maxLength: 12 }), (steps) => {
        const c = core();
        for (const [cmd, [from, to]] of steps) {
          const r = runRange(c, from, to);
          if (r.from === r.to) continue;
          select(c, r.from, r.to);
          c.run(cmd);
          expect(validate(c.getContent()).violations).toEqual([]);
          expect(unmergedRuns(internals(c).state.doc)).toBe(0);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('a toggle at a collapsed caret (FE-128 criterion 4)', () => {
  it('the next typed text carries the mark, and the caret keeps it until it moves', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    expect(c.run('underline')).toBe(true);
    expect(c.queryCommand('underline').active).toBe(true);
    type(c, 'Z');
    const doc = internals(c).state.doc;
    const at = posOf(doc, SPIKE_IDS.intro) + 1 + 3;
    expect(allHave(doc, at, at + 1, 'underline')).toBe(true);
    // The text before the caret keeps its own marks.
    expect(noneHave(doc, posOf(doc, SPIKE_IDS.intro) + 1, at, 'underline')).toBe(true);
  });

  it('toggling a mark on at the caret and off again types plain text', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    c.run('smallCaps');
    c.run('smallCaps');
    type(c, 'Q');
    const doc = internals(c).state.doc;
    const at = posOf(doc, SPIKE_IDS.intro) + 1 + 3;
    expect(noneHave(doc, at, at + 1, 'smallCaps')).toBe(true);
    expect(validate(c.getContent()).violations).toEqual([]);
  });
});
