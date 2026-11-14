/**
 * FE-139 criterion 2, the copy and cut halves (lane U-FE-129-141, round 8): a preserved atom
 * selected whole is copied as one unit, and cut as one unit, through the headless core. Move is a
 * drag, which is the view's, so criterion 2 stays unticked in the story; this file gives its copy
 * and cut evidence only.
 */
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const ATOM = 'bFe139Copy0000001';
const ASSET = '0190f0a0-0000-7000-8000-000000000003';

/** The spike document with a preserved chart after a text paragraph, as the find tests build it. */
function withAtom(): CdmEnvelope {
  const env = spikeDocument();
  const doc = structuredClone(env.doc) as {
    content: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  const body = doc.content[doc.content.length - 1]!;
  body.content!.push(
    {
      type: 'paragraph',
      attrs: { id: 'pFe139Copy0000001' },
      content: [{ type: 'text', text: 'Text before the chart' }],
    },
    {
      type: 'preserved_block',
      attrs: { id: ATOM, label: 'chart', fragment: ASSET, fallbackText: 'Sales by quarter' },
    },
  );
  return { ...env, requires: [...env.requires, 'preserve'], doc: doc as CdmEnvelope['doc'] };
}

function holdsAtom(c: DocumentCore): boolean {
  let kept = false;
  internals(c).state.doc.descendants((node) => {
    if (node.type.name === 'preserved_block') kept = true;
    return !kept;
  });
  return kept;
}

describe('a preserved atom is copied and cut as one unit (FE-139 criterion 2, copy and cut)', () => {
  it('copies a whole-atom selection and the copy holds the atom with its fallback', () => {
    const c = new DocumentCore({ doc: withAtom(), schedule: microtask });
    const i = internals(c);
    const at = posOf(i.state.doc, ATOM);
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
    const payload = c.copySelection();
    expect(payload).not.toBeNull();
    expect(payload!['text/html']).toContain('preserved_block');
    expect(payload!['text/html']).toContain('Sales by quarter');
    expect(holdsAtom(c)).toBe(true);
  });

  it('cuts a whole-atom selection in one step: the atom is removed and the copy keeps it', () => {
    const c = new DocumentCore({ doc: withAtom(), schedule: microtask });
    const i = internals(c);
    const at = posOf(i.state.doc, ATOM);
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
    const cut = c.cutSelection();
    expect(cut).not.toBeNull();
    expect(cut!.deleted).toBe(true);
    expect(cut!.payload).not.toBeNull();
    expect(cut!.payload!['text/html']).toContain('Sales by quarter');
    expect(holdsAtom(c)).toBe(false);
    expect(internals(c).state.doc.textContent).toContain('Text before the chart');
  });
});
