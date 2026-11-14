/**
 * The layout authoring commands through the core (FE-070, FE-134, FE-135, FE-136): `insertBreak`,
 * `insertSectionBreak`, `insertField`, `insertToc`, `insertSymbol`, `insertCaption`,
 * `insertReference` and `setEquationLatex` run through `DocumentCore.exec` and `queryCommand`, with
 * the region guard's real `canWrite` (guard.ts) deciding where the user may change the document.
 */
import { dateFieldText } from '@docedit/model';
import type { Access } from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { LAYOUT_IDS, layoutEnvelope } from './layout-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;
const REGION = `region:${LAYOUT_IDS.region}`;
const LONDON_DATE = { instant: '2026-11-06T10:00:00.000Z', timeZone: 'Europe/London' };
/** The figure without a caption. */
const FIGURE = 'figNewLayout0001';

/** The layout document with an inline equation in the second paragraph and one in the region. */
function envelope(): CdmEnvelope {
  const doc = layoutEnvelope() as unknown as CdmJsonNode;
  const body = doc.content!.find((n) => n.type === 'body')!;
  const withEquation = (id: string): void => {
    const p = body.content!.flatMap((n) => (n.type === 'region' ? n.content! : [n]));
    const paragraph = p.find((n) => n.attrs?.['id'] === id)!;
    paragraph.content = [...paragraph.content!, { type: 'equation', attrs: { latex: 'x' } }];
  };
  withEquation(LAYOUT_IDS.pB);
  withEquation(LAYOUT_IDS.inRegion);
  // A reference target names a node by an identifier of 16 characters (CDM `FIELD_TARGET_PATTERN`).
  body.content!.find((n) => n.attrs?.['id'] === LAYOUT_IDS.figure2)!.attrs!['id'] = FIGURE;
  return { cdm: 1, requires: [], doc };
}

/** An editor: the body, not the restricted region, the definitions or the stories (07 §4, §5.3). */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], [REGION]: [...READ] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** An owner: everything, with `structure` (P2) and the stories (07 §4). */
function ownerAccess(): Access {
  return {
    ...editorAccess(),
    docRole: 'owner',
    caps: [...EDIT, 'structure', 'manage'],
    scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT], [REGION]: [...EDIT] },
  };
}

let counter = 0;
const generateId = (): string => `gen${String(++counter).padStart(13, '0')}`;

function core(access: Access | null): DocumentCore {
  return new DocumentCore({ doc: envelope(), access, schedule: microtask, generateId });
}

/** Runs `act` and reports whether the document changed and how many steps were queued. */
function attempt(c: DocumentCore, act: () => boolean) {
  const doc = internals(c).state.doc;
  const queued = unconfirmed(internals(c).sync).length;
  const done = act();
  return {
    done,
    changed: internals(c).state.doc !== doc,
    queued: unconfirmed(internals(c).sync).length - queued,
  };
}

/** The nodes of `type` in the core's document, with their positions. */
function nodes(c: DocumentCore, type: string): Array<{ node: PMNode; pos: number }> {
  const out: Array<{ node: PMNode; pos: number }> = [];
  internals(c).state.doc.descendants((node, pos) => {
    if (node.type.name === type) out.push({ node, pos });
    return true;
  });
  return out;
}

/** The identifier of the paragraph or story around each node of `type`. */
function holders(c: DocumentCore, type: string): string[] {
  const doc = internals(c).state.doc;
  return nodes(c, type).map(({ pos }) => {
    const $pos = doc.resolve(pos);
    for (let d = $pos.depth; d > 0; d--) {
      const id = $pos.node(d).attrs['id'];
      if (typeof id === 'string') return id;
    }
    return '';
  });
}

const DISABLED = { enabled: false, active: false } as const;
const ENABLED = { enabled: true, active: false } as const;

describe('insertBreak through the core (FE-135 criterion 1)', () => {
  it('inserts a page, column and line break in body text, one change each', () => {
    const c = core(editorAccess());
    for (const breakKind of ['page', 'column', 'line'] as const) {
      caret(c, LAYOUT_IDS.pB, 2);
      expect(c.queryCommand('insertBreak', { breakKind })).toEqual(ENABLED);
      const r = attempt(c, () => c.exec('insertBreak', { breakKind }));
      expect(r).toMatchObject({ done: true, changed: true });
      expect(r.queued).toBeGreaterThan(0);
    }
    expect(nodes(c, 'break').map((b) => b.node.attrs['kind'])).toEqual(['line', 'column', 'page']);
    expect(holders(c, 'break')).toEqual([LAYOUT_IDS.pB, LAYOUT_IDS.pB, LAYOUT_IDS.pB]);
  });

  it('refuses a page or column break in a table cell and a footnote (I10), and allows a line break', () => {
    const c = core(editorAccess());
    for (const place of [LAYOUT_IDS.cell, LAYOUT_IDS.pNote]) {
      for (const breakKind of ['page', 'column'] as const) {
        caret(c, place, 1);
        expect(c.queryCommand('insertBreak', { breakKind })).toEqual(DISABLED);
        expect(attempt(c, () => c.exec('insertBreak', { breakKind }))).toEqual({
          done: false,
          changed: false,
          queued: 0,
        });
      }
      caret(c, place, 1);
      expect(attempt(c, () => c.exec('insertBreak', { breakKind: 'line' }))).toMatchObject({
        done: true,
        changed: true,
      });
    }
  });

  it('is unavailable where the real guard protects the scope, and changes nothing', () => {
    const c = core(editorAccess());
    expect(c.canEdit(REGION)).toBe(false);
    caret(c, LAYOUT_IDS.inRegion, 2);
    expect(c.queryCommand('insertBreak', { breakKind: 'page' })).toEqual({
      ...DISABLED,
      reason: 'no-access',
    });
    expect(attempt(c, () => c.exec('insertBreak', { breakKind: 'page' }))).toEqual({
      done: false,
      changed: false,
      queued: 0,
    });
  });

  it('is unavailable without the argument, and in view mode', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.queryCommand('insertBreak')).toEqual(DISABLED);
    c.setMode('view');
    expect(c.queryCommand('insertBreak', { breakKind: 'page' })).toEqual({
      ...DISABLED,
      reason: 'read-only',
    });
    expect(c.exec('insertBreak', { breakKind: 'page' })).toBe(false);
  });
});

describe('insertSectionBreak through the core (FE-135 criterion 2)', () => {
  it('adds a section break as a child of the body and its own page setup, for the owner', () => {
    const c = core(ownerAccess());
    caret(c, LAYOUT_IDS.pB, 2);
    const args = { section: { start: 'oddPage' } } as const;
    expect(c.queryCommand('insertSectionBreak', args)).toEqual(ENABLED);
    expect(attempt(c, () => c.exec('insertSectionBreak', args))).toMatchObject({
      done: true,
      changed: true,
    });
    const [section] = nodes(c, 'section_break');
    expect(section!.node.attrs['start']).toBe('oddPage');
    expect(internals(c).state.doc.resolve(section!.pos).parent.type.name).toBe('body');
    const setups = nodes(c, 'page_setup').map((s) => s.node.attrs['id']);
    expect(setups).toContain(section!.node.attrs['pageSetup']);
  });

  it('is unavailable to an editor, who may not change the definitions', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 2);
    const args = { section: { start: 'nextPage' } } as const;
    expect(c.queryCommand('insertSectionBreak', args)).toEqual({
      ...DISABLED,
      reason: 'no-access',
    });
    expect(attempt(c, () => c.exec('insertSectionBreak', args)).changed).toBe(false);
  });

  it('is refused by the guard without `structure` (P2), even where the scopes are writable', () => {
    const c = core({ ...ownerAccess(), caps: [...EDIT] });
    caret(c, LAYOUT_IDS.pB, 2);
    const r = attempt(c, () => c.exec('insertSectionBreak', { section: { start: 'continuous' } }));
    expect(r.changed).toBe(false);
    expect(r.queued).toBe(0);
    expect(c.refusal.get()?.reason).toBe('structure');
    expect(nodes(c, 'section_break')).toHaveLength(0);
  });
});

describe('insertField through the core (FE-136 criteria 1 and 2)', () => {
  /** The caret three characters into the header's paragraph, as the header's sub-editor counts it. */
  const inHeader = { id: LAYOUT_IDS.header, pos: 1 + 3 };

  it('inserts a page number in the chosen format and the page count in a header story', () => {
    const c = core(ownerAccess());
    caret(c, LAYOUT_IDS.pB, 0);
    const page = { field: { kind: 'page', format: 'lowerRoman', story: inHeader } } as const;
    expect(c.queryCommand('insertField', page)).toEqual(ENABLED);
    expect(attempt(c, () => c.exec('insertField', page))).toMatchObject({
      done: true,
      changed: true,
    });
    const count = { field: { kind: 'pageCount', story: inHeader } } as const;
    expect(c.exec('insertField', count)).toBe(true);
    const fields = nodes(c, 'field').map((f) => [f.node.attrs['kind'], f.node.attrs['format']]);
    expect(fields).toEqual([
      ['pageCount', null],
      ['page', 'lowerRoman'],
    ]);
    expect(holders(c, 'field')).toEqual([LAYOUT_IDS.pHeader, LAYOUT_IDS.pHeader]);
    // The core's own selection stayed in the body.
    expect(c.selectionScope().scope).toBe('body');
  });

  it('refuses a page number in body text, and in a header the user may not change', () => {
    const owner = core(ownerAccess());
    caret(owner, LAYOUT_IDS.pB, 2);
    expect(owner.queryCommand('insertField', { field: { kind: 'page' } })).toEqual(DISABLED);
    expect(
      owner.queryCommand('insertField', {
        field: { kind: 'page', story: { id: 'nostory000000001', pos: 1 } },
      }),
    ).toEqual(DISABLED);

    const editor = core(editorAccess());
    expect(editor.canEdit(`story:${LAYOUT_IDS.header}`)).toBe(false);
    const page = { field: { kind: 'page', story: inHeader } } as const;
    expect(editor.queryCommand('insertField', page)).toEqual({ ...DISABLED, reason: 'no-access' });
    expect(attempt(editor, () => editor.exec('insertField', page))).toEqual({
      done: false,
      changed: false,
      queued: 0,
    });
  });

  it('inserts a date field in the body with the shared computation as `cached`', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.exec('insertField', { field: { kind: 'date', date: LONDON_DATE } })).toBe(true);
    const [date] = nodes(c, 'field');
    expect(date!.node.attrs['cached']).toBe(dateFieldText({ ...LONDON_DATE, format: null }));
  });
});

describe('insertToc and insertSymbol through the core (FE-136 criteria 3 and 4, insertion only)', () => {
  it('inserts a table of contents after the caret block, with its level limits', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 2);
    const args = { toc: { minLevel: 2, maxLevel: 4 } };
    expect(c.queryCommand('insertToc', args)).toEqual(ENABLED);
    expect(c.exec('insertToc', args)).toBe(true);
    const [toc] = nodes(c, 'toc');
    expect(toc!.node.attrs).toMatchObject({ minLevel: 2, maxLevel: 4, of: 'headings' });
    expect(c.queryCommand('insertToc', { toc: { minLevel: 5, maxLevel: 2 } })).toEqual(DISABLED);
  });

  it('inserts a symbol as text at the caret, and refuses more than one character', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 0);
    expect(c.exec('insertSymbol', { symbol: '§' })).toBe(true);
    expect(internals(c).state.doc.textBetween(0, internals(c).state.doc.content.size)).toContain(
      '§Gamma',
    );
    expect(c.queryCommand('insertSymbol', { symbol: 'ab' })).toEqual(DISABLED);
  });
});

describe('insertCaption and insertReference through the core (FE-134)', () => {
  it('numbers a new figure caption and refers to it', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 0);
    expect(c.queryCommand('insertCaption', { figure: LAYOUT_IDS.figure })).toEqual(DISABLED);
    expect(c.exec('insertCaption', { figure: FIGURE })).toBe(true);
    const seq = nodes(c, 'field').find((f) => f.node.attrs['kind'] === 'seq');
    expect(seq!.node.attrs['name']).toBe('Figure');
    const reference = { reference: { target: `node:${FIGURE}` } };
    expect(c.queryCommand('insertReference', reference)).toEqual(ENABLED);
    expect(c.exec('insertReference', reference)).toBe(true);
    const ref = nodes(c, 'field').find((f) => f.node.attrs['kind'] === 'ref');
    expect(ref!.node.attrs['cached']).toEqual(
      expect.stringContaining(String(seq!.node.attrs['cached'])),
    );
  });
});

describe('setEquationLatex through the core (FE-070 criterion 2)', () => {
  const equationAt = (c: DocumentCore, holder: string): number => {
    const all = nodes(c, 'equation');
    const index = holders(c, 'equation').indexOf(holder);
    return all[index]!.pos;
  };

  it('sets the LaTeX of a confirmed equation in one change, which one undo takes back', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 0);
    const pos = equationAt(c, LAYOUT_IDS.pB);
    const args = { equation: { pos, latex: '\\frac{a}{b}' } };
    expect(c.queryCommand('setEquationLatex', args)).toEqual(ENABLED);
    const r = attempt(c, () => c.exec('setEquationLatex', args));
    expect(r).toEqual({ done: true, changed: true, queued: 1 });
    expect(internals(c).state.doc.nodeAt(pos)!.attrs['latex']).toBe('\\frac{a}{b}');
    expect(c.exec('undo')).toBe(true);
    expect(internals(c).state.doc.nodeAt(pos)!.attrs['latex']).toBe('x');
  });

  it('refuses a source over the limits, a node that is not an equation and a protected scope', () => {
    const c = core(editorAccess());
    const pos = equationAt(c, LAYOUT_IDS.pB);
    for (const latex of ['x'.repeat(4001), '{'.repeat(51) + '}'.repeat(51)]) {
      expect(
        attempt(c, () => c.exec('setEquationLatex', { equation: { pos, latex } })).changed,
      ).toBe(false);
    }
    expect(c.queryCommand('setEquationLatex', { equation: { pos: pos - 1, latex: 'y' } })).toEqual(
      DISABLED,
    );
    expect(c.queryCommand('setEquationLatex', { equation: { pos: 1e9, latex: 'y' } })).toEqual(
      DISABLED,
    );
    const guarded = equationAt(c, LAYOUT_IDS.inRegion);
    expect(c.queryCommand('setEquationLatex', { equation: { pos: guarded, latex: 'y' } })).toEqual({
      ...DISABLED,
      reason: 'no-access',
    });
    expect(
      attempt(c, () => c.exec('setEquationLatex', { equation: { pos: guarded, latex: 'y' } })),
    ).toEqual({
      done: false,
      changed: false,
      queued: 0,
    });
  });
});
