/**
 * FE-135 criterion 6 through the core (lane U-FE-129-141): a continuous section break whose page
 * setup changes a margin is reported by `DocumentCore.sectionWarnings()`, and a next-page break with
 * the same change is not. The criterion stays open until the view shows the warning (03 §10).
 */
import type { Access } from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { LAYOUT_IDS, layoutEnvelope } from './layout-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

/** An owner with `structure` (P2), which a section break needs (07 §5.2). */
const OWNER: Access = {
  rev: 1,
  asOfSeq: 0,
  docRole: 'owner',
  caps: [...EDIT, 'structure', 'manage'],
  scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
  leases: {},
  fill: null,
  restrictions: [],
};

function core(): DocumentCore {
  const doc = layoutEnvelope() as unknown as CdmJsonNode;
  const envelope: CdmEnvelope = { cdm: 1, requires: [], doc };
  return new DocumentCore({ doc: envelope, access: OWNER, schedule: microtask });
}

/** The section break nodes of the body, in order. */
function sectionBreaks(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'section_break') out.push(node);
    return true;
  });
  return out;
}

describe('the continuous-break warning through the core (FE-135 criterion 6)', () => {
  it('reports a continuous break that changes a margin, and not a next-page break', () => {
    const c = core();
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.sectionWarnings()).toEqual([]);

    expect(c.run('insertSectionBreak', { section: { start: 'continuous' } })).toBe(true);
    const continuous = sectionBreaks(internals(c).state.doc).find(
      (s) => s.attrs['start'] === 'continuous',
    )!;
    expect(c.sectionWarnings()).toEqual([]);

    // A margin change on the new section's page setup is what the warning is about.
    const pageSetupId = String(continuous.attrs['pageSetup']);
    expect(
      c.run('setPageSetup', { pageSetup: { id: pageSetupId, changes: { marginTop: 2880 } } }),
    ).toBe(true);
    expect(c.sectionWarnings()).toEqual([
      { sectionId: String(continuous.attrs['id']), reason: 'continuous-margin-change' },
    ]);
  });
});
