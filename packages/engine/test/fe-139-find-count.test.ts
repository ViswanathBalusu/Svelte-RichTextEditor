/**
 * FE-139 criterion 4, the count half: the core's find state reports how many preserved atoms the
 * search skipped, and it follows the query and the document. The find panel that shows the count is
 * the view's (not built); this tests the state the panel reads, in the headless core.
 */
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { ownerAccess, spikeDocument } from './fixtures.ts';
import { microtask } from './support.ts';

const ASSET = '0190f0a0-0000-7000-8000-000000000002';

/** The spike document with a text paragraph and a preserved chart whose fallback text is `fallback`. */
function withPreserved(fallback: string): CdmEnvelope {
  const env = spikeDocument();
  const doc = structuredClone(env.doc) as {
    content: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  const body = doc.content[doc.content.length - 1]!;
  body.content!.push(
    {
      type: 'paragraph',
      attrs: { id: 'pFind000000000002' },
      content: [{ type: 'text', text: 'Sales Chart below' }],
    },
    {
      type: 'preserved_block',
      attrs: { id: 'bFind000000000002', label: 'chart', fragment: ASSET, fallbackText: fallback },
    },
  );
  return { ...env, requires: [...env.requires, 'preserve'], doc: doc as CdmEnvelope['doc'] };
}

describe('the core reports the preserved atoms the find skipped (FE-139 criterion 4)', () => {
  it('counts the skipped atom for a query that its fallback holds, and none otherwise', () => {
    const core = new DocumentCore({ doc: withPreserved('Chart from Word'), schedule: microtask });
    core.findText('Chart');
    expect(core.findState.get().count).toBe(1);
    expect(core.skippedPreservedFind()).toBe(1);
    core.findText('from Word');
    expect(core.findState.get().count).toBe(0);
    expect(core.skippedPreservedFind()).toBe(1);
    core.findText('Sales');
    expect(core.skippedPreservedFind()).toBe(0);
  });

  it('is zero for an empty query and after the find is cleared', () => {
    const core = new DocumentCore({ doc: withPreserved('Chart from Word'), schedule: microtask });
    core.findText('');
    expect(core.skippedPreservedFind()).toBe(0);
    core.findText('Chart');
    core.clearFind();
    expect(core.skippedPreservedFind()).toBe(0);
  });

  it('a document without preserved content reports nothing skipped', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    core.findText('Introduction');
    expect(core.skippedPreservedFind()).toBe(0);
  });
});

describe('find and replace leave preserved content alone and report the skip (FE-139 criterion 4)', () => {
  it('carries the skipped count in the find state, and leaves it out when nothing was skipped', () => {
    const core = new DocumentCore({ doc: withPreserved('Chart from Word'), schedule: microtask });
    core.findText('Chart');
    expect(core.findState.get().skippedPreserved).toBe(1);
    core.findText('Sales');
    expect(core.findState.get()).not.toHaveProperty('skippedPreserved');
    core.findText('');
    expect(core.findState.get()).not.toHaveProperty('skippedPreserved');
  });

  it('does not report an atom whose fallback text lacks the query', () => {
    const core = new DocumentCore({ doc: withPreserved('Quarterly'), schedule: microtask });
    core.findText('Chart');
    expect(core.findState.get().count).toBe(1);
    expect(core.findState.get()).not.toHaveProperty('skippedPreserved');
  });

  it('replace all changes the text matches and leaves the atom and its fallback text as they were', () => {
    const core = new DocumentCore({
      doc: withPreserved('Chart from Word'),
      access: ownerAccess(),
      schedule: microtask,
    });
    core.findText('Chart');
    const report = core.replaceAll('Graph');
    expect(report.replaced).toBe(1);
    const atoms: Array<{ label: unknown; fallbackText: unknown }> = [];
    internals(core).state.doc.descendants((node) => {
      if (node.type.name === 'preserved_block')
        atoms.push({ label: node.attrs['label'], fallbackText: node.attrs['fallbackText'] });
      return true;
    });
    expect(atoms).toEqual([{ label: 'chart', fallbackText: 'Chart from Word' }]);
    expect(internals(core).state.doc.textContent).toContain('Sales Graph below');
    // The query is gone from the text, but the atom still holds it: the skip is still reported.
    expect(core.findState.get().count).toBe(0);
    expect(core.findState.get().skippedPreserved).toBe(1);
  });
});
