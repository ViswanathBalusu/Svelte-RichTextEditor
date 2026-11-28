/**
 * The Home tab's two list buttons (ADR 0490): `applyList` with a `listKind` instead of a numbering
 * definition's identifier. The paragraphs join the document's first definition of that kind, or the
 * document gets one, in the same transaction; paragraphs already in a list of that kind leave it.
 * Also the font size the selection summary now carries. Run in Node.js on the styled fixture.
 */
import { computeLabels } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };

function core(definitions: readonly Json[] = [], structure = true): DocumentCore {
  const env = structuredClone(styledDocument()) as unknown as { doc: Json };
  const defs = env.doc.content!.find((c) => c.type === 'defs')!;
  const at = defs.content!.findIndex((c) => c.type === 'page_setup');
  defs.content!.splice(at, 0, ...definitions);
  return new DocumentCore({
    doc: env as unknown as ReturnType<typeof styledDocument>,
    access: structure ? withStructure() : styledEditorAccess(),
    schedule: microtask,
  });
}

/** The editor of the fixture, who may also change the definitions (07 §7: `structure`). */
function withStructure(): ReturnType<typeof styledEditorAccess> {
  const access = styledEditorAccess();
  return {
    ...access,
    scopes: {
      ...access.scopes,
      doc: ['view', 'edit'],
      defs: ['view', 'comment', 'suggest', 'edit'],
    },
  };
}

function select(c: DocumentCore, fromId: string, toId: string): void {
  const i = internals(c);
  const from = posOf(i.state.doc, fromId) + 1;
  const to = posOf(i.state.doc, toId) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

type Numbering = { numberingId: string; listId: string; level: number } | null;

function numbering(c: DocumentCore, id: string): Numbering {
  const doc = internals(c).state.doc;
  return doc.nodeAt(posOf(doc, id))!.attrs['numbering'] as Numbering;
}

function definitions(c: DocumentCore): Array<{ id: string; format: unknown }> {
  const out: Array<{ id: string; format: unknown }> = [];
  internals(c).state.doc.firstChild!.forEach((def) => {
    if (def.type.name !== 'numbering_def') return;
    const levels = def.attrs['levels'] as Array<{ format: unknown }>;
    out.push({ id: def.attrs['id'] as string, format: levels[0]!.format });
  });
  return out;
}

const decimal = { format: 'decimal', text: '%1.', start: 1 };
const bullet = { format: 'bullet', text: '', start: 1, bulletChar: '•' };

describe('a bulleted list, by kind', () => {
  it('gives a document with no numbering definition one, and puts the paragraphs in it', () => {
    const c = core();
    // The fixture has violations of its own; the list adds none.
    const before = validate(c.getContent()).violations;
    expect(definitions(c)).toEqual([]);
    select(c, STYLE_IDS.heading, STYLE_IDS.plain);
    expect(c.run('applyList', { listKind: 'bullet' })).toBe(true);
    const made = definitions(c);
    expect(made).toHaveLength(1);
    expect(made[0]!.format).toBe('bullet');
    const lists = [STYLE_IDS.heading, STYLE_IDS.quote, STYLE_IDS.plain].map((id) =>
      numbering(c, id),
    );
    expect(lists.every((l) => l?.numberingId === made[0]!.id && l.level === 0)).toBe(true);
    expect(new Set(lists.map((l) => l?.listId)).size).toBe(1);
    expect(validate(c.getContent()).violations).toEqual(before);
  });

  it('is one step in the history: undo takes the list and the definition away together', () => {
    const c = core();
    select(c, STYLE_IDS.heading, STYLE_IDS.heading);
    c.run('applyList', { listKind: 'bullet' });
    expect(definitions(c)).toHaveLength(1);
    expect(c.run('undo')).toBe(true);
    expect(definitions(c)).toEqual([]);
    expect(numbering(c, STYLE_IDS.heading)).toBeNull();
  });

  it('uses the definition of the kind that the document already has, and adds none', () => {
    const c = core([{ type: 'numbering_def', attrs: { id: 'Dots', levels: [bullet] } }]);
    select(c, STYLE_IDS.heading, STYLE_IDS.quote);
    expect(c.run('applyList', { listKind: 'bullet' })).toBe(true);
    expect(definitions(c).map((d) => d.id)).toEqual(['Dots']);
    expect(numbering(c, STYLE_IDS.quote)?.numberingId).toBe('Dots');
  });

  it('turns the list off for paragraphs that are already in a list of the kind', () => {
    const c = core();
    select(c, STYLE_IDS.heading, STYLE_IDS.quote);
    c.run('applyList', { listKind: 'bullet' });
    expect(c.run('applyList', { listKind: 'bullet' })).toBe(true);
    expect(numbering(c, STYLE_IDS.heading)).toBeNull();
    expect(numbering(c, STYLE_IDS.quote)).toBeNull();
    // The definition stays: it is the document's, and the next list uses it.
    expect(definitions(c)).toHaveLength(1);
  });
});

describe('a numbered list, by kind', () => {
  it('numbers the paragraphs in order, with a definition of nine decimal levels', () => {
    const c = core();
    const before = validate(c.getContent()).violations;
    select(c, STYLE_IDS.heading, STYLE_IDS.plain);
    expect(c.run('applyList', { listKind: 'number' })).toBe(true);
    const made = definitions(c);
    expect(made.map((d) => d.format)).toEqual(['decimal']);
    const ids = [STYLE_IDS.heading, STYLE_IDS.quote, STYLE_IDS.plain];
    const labels = computeLabels(internals(c).state.doc);
    expect(ids.map((id) => labels.lists.get(id)?.text)).toEqual(['1.', '2.', '3.']);
    expect(validate(c.getContent()).violations).toEqual(before);
  });

  it('does not take a bulleted paragraph for a numbered one: it changes it to the other kind', () => {
    const c = core([{ type: 'numbering_def', attrs: { id: 'Dots', levels: [bullet] } }]);
    select(c, STYLE_IDS.heading, STYLE_IDS.heading);
    c.run('applyList', { listKind: 'bullet' });
    expect(c.run('applyList', { listKind: 'number' })).toBe(true);
    const now = numbering(c, STYLE_IDS.heading);
    expect(now?.numberingId).not.toBe('Dots');
    expect(
      definitions(c)
        .map((d) => d.format)
        .sort(),
    ).toEqual(['bullet', 'decimal']);
  });

  it('prefers the first decimal definition of the document', () => {
    const c = core([
      { type: 'numbering_def', attrs: { id: 'Num1', levels: [decimal] } },
      { type: 'numbering_def', attrs: { id: 'Num2', levels: [decimal] } },
    ]);
    select(c, STYLE_IDS.heading, STYLE_IDS.heading);
    expect(c.run('applyList', { listKind: 'number' })).toBe(true);
    expect(numbering(c, STYLE_IDS.heading)?.numberingId).toBe('Num1');
  });
});

describe('where a list may not be made', () => {
  it('refuses the first list to an editor who may not change the definitions, and changes nothing', () => {
    const c = core([], false);
    select(c, STYLE_IDS.heading, STYLE_IDS.heading);
    const before = JSON.stringify(c.getContent());
    expect(c.queryCommand('applyList', { listKind: 'bullet' }).enabled).toBe(false);
    expect(c.run('applyList', { listKind: 'bullet' })).toBe(false);
    expect(JSON.stringify(c.getContent())).toBe(before);
  });

  it('lets that editor use a definition the document already has', () => {
    const c = core([{ type: 'numbering_def', attrs: { id: 'Dots', levels: [bullet] } }], false);
    select(c, STYLE_IDS.heading, STYLE_IDS.heading);
    expect(c.run('applyList', { listKind: 'bullet' })).toBe(true);
    expect(numbering(c, STYLE_IDS.heading)?.numberingId).toBe('Dots');
  });
});

describe('the font size in the selection summary', () => {
  it('is the size mark at the caret, in twentieths of a point, and null where there is none', () => {
    const c = core();
    select(c, STYLE_IDS.heading, STYLE_IDS.heading);
    expect(c.selection.get().fontSize).toBeNull();
    expect(c.run('fontSize', { fontSize: 280 })).toBe(true);
    expect(c.selection.get().fontSize).toBe(280);
    expect(c.run('fontSize', { fontSize: null })).toBe(true);
    expect(c.selection.get().fontSize).toBeNull();
  });
});
