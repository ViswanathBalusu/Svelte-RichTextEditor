/**
 * PRM-027 criterion 4 at the engine (lane PRM-015-028, round 4): the caret moves to the start of the
 * next region, in document order, where the user has `edit`. A region the user may only read is
 * skipped, and the command is not enabled when no later region may be edited.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { Access, CdmEnvelope } from '@docedit/protocol';
import { DocumentCore } from '../src/headless.ts';
import { nextEditableRegionStart } from '../src/region-navigation.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

const IDS = {
  before: 'pNavBefore000001',
  inA: 'pNavInA00000001',
  middle: 'pNavMiddle00001',
  inB: 'pNavInB00000001',
  inC: 'pNavInC00000001',
  after: 'pNavAfter000001',
  regionA: 'rNavA00000000001',
  regionB: 'rNavB00000000001',
  regionC: 'rNavC00000000001',
} as const;

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

function paragraph(id: string, text: string) {
  return { type: 'paragraph', attrs: { id, style: null }, content: [{ type: 'text', text }] };
}

function region(id: string, title: string, text: string, paraId: string) {
  return {
    type: 'region',
    attrs: { id, title, policy: 'restricted' },
    content: [paragraph(paraId, text)],
  };
}

/** Body: Before, region A (editable), Middle, region B (read only), region C (editable), After. */
function navigationDocument(): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            paragraph(IDS.before, 'Before'),
            region(IDS.regionA, 'Alpha', 'Alpha text', IDS.inA),
            paragraph(IDS.middle, 'Middle'),
            region(IDS.regionB, 'Beta', 'Beta text', IDS.inB),
            region(IDS.regionC, 'Gamma', 'Gamma text', IDS.inC),
            paragraph(IDS.after, 'After'),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

/** An editor who may edit regions A and C and only read region B. */
function access(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: {
      doc: ['view'],
      body: [...EDIT],
      defs: ['view'],
      [`region:${IDS.regionA}`]: [...EDIT],
      [`region:${IDS.regionB}`]: [...READ],
      [`region:${IDS.regionC}`]: [...EDIT],
    },
    leases: {},
    fill: null,
    restrictions: [],
  } as unknown as Access;
}

function core(): DocumentCore {
  return new DocumentCore({ doc: navigationDocument(), access: access(), schedule: microtask });
}

function caretAt(c: DocumentCore, pos: number): void {
  const i = internals(c);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

function caret(c: DocumentCore): number {
  return internals(c).state.selection.from;
}

/** The text position at the start of a paragraph or region's paragraph with this id. */
function textStart(c: DocumentCore, id: string): number {
  return posOf(internals(c).state.doc, id) + 1;
}

describe('the next part I can edit moves the caret (PRM-027 criterion 4)', () => {
  it('from the body, moves to the start of the first editable region, skipping none', () => {
    const c = core();
    caretAt(c, textStart(c, IDS.before));
    expect(c.queryCommand('nextEditableRegion')).toEqual({ enabled: true, active: false });
    expect(c.run('nextEditableRegion')).toBe(true);
    expect(caret(c)).toBe(textStart(c, IDS.inA));
  });

  it('skips a region the user may only read and moves to the next one I may edit', () => {
    const c = core();
    caretAt(c, textStart(c, IDS.inA));
    expect(c.run('nextEditableRegion')).toBe(true);
    expect(caret(c)).toBe(textStart(c, IDS.inC));
  });

  it('is not enabled when no later region may be edited, and the caret stays where it was', () => {
    const c = core();
    caretAt(c, textStart(c, IDS.inC));
    expect(c.queryCommand('nextEditableRegion')).toMatchObject({ enabled: false });
    const before = caret(c);
    expect(c.run('nextEditableRegion')).toBe(false);
    expect(caret(c)).toBe(before);
  });

  it('is not enabled in view mode, where no region is editable (the lock applies to every region)', () => {
    const c = core();
    caretAt(c, textStart(c, IDS.before));
    c.setMode('view');
    expect(c.readOnly).toBe(true);
    expect(c.queryCommand('nextEditableRegion')).toMatchObject({ enabled: false });
    expect(c.run('nextEditableRegion')).toBe(false);
    expect(caret(c)).toBe(textStart(c, IDS.before));
  });
});

describe('nextEditableRegionStart', () => {
  it('finds nothing when no region may be edited', () => {
    const c = core();
    const doc = internals(c).state.doc;
    expect(nextEditableRegionStart(doc, 0, () => false)).toBeNull();
  });

  it('finds the first region after the caret, in document order, that the guard accepts', () => {
    const c = core();
    const doc = internals(c).state.doc;
    const onlyB = (scope: string) => scope === `region:${IDS.regionB}`;
    expect(nextEditableRegionStart(doc, 0, onlyB)).toBe(textStart(c, IDS.inB));
    expect(nextEditableRegionStart(doc, textStart(c, IDS.inB), onlyB)).toBeNull();
  });
});

describe('the named query behind the command (PRM-027 criterion 1, lane w4)', () => {
  it('lists hasNextEditableRegion among the queries the core answers', () => {
    const c = core();
    expect(c.queryNames).toContain('hasNextEditableRegion');
  });

  it('answers true while a later region may be edited, and false after the last one', () => {
    const c = core();
    caretAt(c, textStart(c, IDS.before));
    expect(c.query('hasNextEditableRegion')).toBe(true);
    caretAt(c, textStart(c, IDS.inC));
    expect(c.query('hasNextEditableRegion')).toBe(false);
  });
});
