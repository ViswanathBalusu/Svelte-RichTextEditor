/**
 * Multilevel lists (FE-130 criteria 1 to 5): applying a list, changing levels, restarting and
 * continuing numbering with the labels of the model's shared computation, Enter in an empty item,
 * and the list attributes that the commands write. Run in Node.js on the styled fixture.
 */
import fc from 'fast-check';
import { computeLabels } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import type { CommandArgs, CommandName } from '../src/api.ts';
import { exitEmptyListItem, listIndentAtStart } from '../src/list-commands.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };

const level = { format: 'decimal', text: '%1.', start: 1 };

/** The styled fixture with two numbering definitions: `Num1` with nine levels, `Short` with two. */
function numberedDoc() {
  const env = structuredClone(styledDocument()) as unknown as { doc: Json };
  const defs = env.doc.content!.find((c) => c.type === 'defs')!;
  const at = defs.content!.findIndex((c) => c.type === 'page_setup');
  const nine = Array.from({ length: 9 }, () => ({ ...level }));
  defs.content!.splice(
    at,
    0,
    { type: 'numbering_def', attrs: { id: 'Num1', levels: nine } },
    { type: 'numbering_def', attrs: { id: 'Short', levels: [level, level] } },
  );
  return env;
}

function core(): DocumentCore {
  return new DocumentCore({
    doc: numberedDoc() as unknown as ReturnType<typeof styledDocument>,
    access: styledEditorAccess(),
    schedule: microtask,
  });
}

/** Selects from the start of the first block to the end of the last, both by identifier. */
function selectBlocks(c: DocumentCore, fromId: string, toId: string): void {
  const i = internals(c);
  const from = posOf(i.state.doc, fromId) + 1;
  const to = posOf(i.state.doc, toId) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

function caretIn(c: DocumentCore, id: string): void {
  const i = internals(c);
  const pos = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

type Attrs = { numberingId: string; listId: string; level: number } | null;

function listAttr(c: DocumentCore, id: string): Attrs {
  const doc = internals(c).state.doc;
  return doc.nodeAt(posOf(doc, id))!.attrs['numbering'] as Attrs;
}

/** The label text of each block, in the order given. */
function labelsOf(c: DocumentCore, ids: readonly string[]): (string | undefined)[] {
  const labels = computeLabels(internals(c).state.doc);
  return ids.map((id) => labels.lists.get(id)?.text);
}

const BODY = [STYLE_IDS.heading, STYLE_IDS.quote, STYLE_IDS.plain] as const;

describe('applying and removing a list (FE-130 criterion 1)', () => {
  it('puts the selected paragraphs in one list instance of the definition, and labels them in order', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    expect(c.run('applyList', { numberingId: 'Num1' })).toBe(true);
    const lists = BODY.map((id) => listAttr(c, id));
    expect(lists.every((l) => l?.numberingId === 'Num1' && l.level === 0)).toBe(true);
    expect(new Set(lists.map((l) => l?.listId)).size).toBe(1);
    expect(labelsOf(c, BODY)).toEqual(['1.', '2.', '3.']);
  });

  it('is unavailable for a numbering definition the document does not define', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    expect(c.run('applyList', { numberingId: 'Missing' })).toBe(false);
    expect(c.run('applyList')).toBe(false);
    expect(listAttr(c, STYLE_IDS.heading)).toBeNull();
  });

  it('removes the list from the selected paragraphs', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    c.run('applyList', { numberingId: 'Num1' });
    expect(c.run('removeList')).toBe(true);
    for (const id of BODY) expect(listAttr(c, id)).toBeNull();
  });

  it('choosing another definition keeps the list instance and re-labels it', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    c.run('applyList', { numberingId: 'Num1' });
    const listId = listAttr(c, STYLE_IDS.heading)!.listId;
    expect(c.run('applyList', { numberingId: 'Short' })).toBe(true);
    for (const id of BODY) {
      expect(listAttr(c, id)).toEqual({ numberingId: 'Short', listId, level: 0 });
    }
    expect(labelsOf(c, BODY)).toEqual(['1.', '2.', '3.']);
  });
});

describe('levels (FE-130 criterion 2)', () => {
  it('moves a list item one level in and out, within the definition', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    c.run('applyList', { numberingId: 'Short' });
    caretIn(c, STYLE_IDS.quote);
    expect(c.run('listLevelUp')).toBe(true);
    expect(listAttr(c, STYLE_IDS.quote)?.level).toBe(1);
    // The definition has two levels: a third is refused.
    expect(c.run('listLevelUp')).toBe(false);
    expect(listAttr(c, STYLE_IDS.quote)?.level).toBe(1);
    expect(c.run('listLevelDown')).toBe(true);
    expect(c.run('listLevelDown')).toBe(false);
    expect(listAttr(c, STYLE_IDS.quote)?.level).toBe(0);
  });

  it('a list with nine levels goes to level 8 and no further', () => {
    const c = core();
    caretIn(c, STYLE_IDS.quote);
    c.run('applyList', { numberingId: 'Num1' });
    for (let k = 0; k < 12; k++) c.run('listLevelUp');
    expect(listAttr(c, STYLE_IDS.quote)?.level).toBe(8);
  });

  it('Tab at the start of a list item changes its level; not in the middle of the text', () => {
    const c = core();
    caretIn(c, STYLE_IDS.quote);
    c.run('applyList', { numberingId: 'Num1' });
    const i = internals(c);
    const at = posOf(i.state.doc, STYLE_IDS.quote) + 1;
    // The caret at the start: Tab works.
    expect(listIndentAtStart(1)(i.state, i.dispatch)).toBe(true);
    expect(listAttr(c, STYLE_IDS.quote)?.level).toBe(1);
    // The caret after the first character: it does not.
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 1)));
    expect(listIndentAtStart(1)(internals(c).state)).toBe(false);
  });
});

describe('restarting and continuing numbering (FE-130 criterion 3)', () => {
  it('restarting at a paragraph starts a new count from it', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    c.run('applyList', { numberingId: 'Num1' });
    caretIn(c, STYLE_IDS.quote);
    expect(c.run('restartNumbering')).toBe(true);
    expect(labelsOf(c, BODY)).toEqual(['1.', '1.', '2.']);
  });

  it('continuing the previous list gives the paragraph and its run the number after it', () => {
    const c = core();
    selectBlocks(c, STYLE_IDS.heading, STYLE_IDS.plain);
    c.run('applyList', { numberingId: 'Num1' });
    caretIn(c, STYLE_IDS.quote);
    c.run('restartNumbering');
    caretIn(c, STYLE_IDS.quote);
    expect(c.run('continueNumbering')).toBe(true);
    expect(labelsOf(c, BODY)).toEqual(['1.', '2.', '3.']);
    // Nothing before it to continue: refused.
    caretIn(c, STYLE_IDS.heading);
    expect(c.run('continueNumbering')).toBe(false);
  });
});

describe('Enter in an empty item (FE-130 criterion 4)', () => {
  it('takes an empty list item out of its list, and does nothing for a filled one', () => {
    const c = core();
    caretIn(c, STYLE_IDS.after);
    c.run('applyList', { numberingId: 'Num1' });
    // Empty the paragraph's text.
    const i = internals(c);
    const node = i.state.doc.nodeAt(posOf(i.state.doc, STYLE_IDS.after))!;
    const start = posOf(i.state.doc, STYLE_IDS.after) + 1;
    i.dispatch(i.state.tr.delete(start, start + node.textContent.length));
    caretIn(c, STYLE_IDS.after);
    expect(exitEmptyListItem(internals(c).state, internals(c).dispatch)).toBe(true);
    expect(listAttr(c, STYLE_IDS.after)).toBeNull();
    // A filled item is not changed by this command.
    caretIn(c, STYLE_IDS.quote);
    c.run('applyList', { numberingId: 'Num1' });
    caretIn(c, STYLE_IDS.quote);
    expect(exitEmptyListItem(internals(c).state, internals(c).dispatch)).toBe(false);
  });
});

describe('list commands keep the document valid (FE-130)', () => {
  const COMMANDS: readonly CommandName[] = [
    'applyList',
    'removeList',
    'listLevelUp',
    'listLevelDown',
    'restartNumbering',
    'continueNumbering',
  ];
  const DEFS = ['Num1', 'Short'];

  it('property: any sequence of list commands keeps the document valid', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom(...COMMANDS),
            fc.integer({ min: 0, max: 2 }),
            fc.integer({ min: 0, max: 1 }),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        (steps) => {
          const c = core();
          const before = validate(c.getContent()).violations;
          for (const [name, pick, def] of steps) {
            const id = BODY[pick]!;
            const args: CommandArgs = name === 'applyList' ? { numberingId: DEFS[def]! } : {};
            caretIn(c, id);
            if (name === 'applyList') selectBlocks(c, STYLE_IDS.heading, id);
            c.run(name, args);
            expect(validate(c.getContent()).violations).toEqual(before);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
