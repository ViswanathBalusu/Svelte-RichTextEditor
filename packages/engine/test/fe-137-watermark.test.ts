/**
 * The watermark of a page setup, stored through the core (FE-137 criterion 5, the storing half; 03
 * §4.1; 07 §5.3). The PDF that prints the watermark is EXP-036's and is not tested here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { editorAccess, ownerAccess, spikeDocument } from './fixtures.ts';
import { microtask } from './support.ts';

function core(access = ownerAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

/** The page setup 'ps1' as it stands in the core's document. */
function pageSetup(c: DocumentCore): PMNode {
  let found: PMNode | null = null;
  internals(c).state.doc.descendants((n) => {
    if (n.type.name === 'page_setup' && n.attrs['id'] === 'ps1') found = n;
    return found === null;
  });
  return found!;
}

describe('the watermark of a page setup (FE-137 criterion 5, storing)', () => {
  it('stores the watermark text on the page setup, and clears it with null', () => {
    const c = core();
    expect(
      c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { watermark: 'DRAFT' } } }),
    ).toBe(true);
    expect(pageSetup(c).attrs['watermark']).toBe('DRAFT');
    expect(c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { watermark: null } } })).toBe(
      true,
    );
    expect(pageSetup(c).attrs['watermark']).toBeNull();
  });

  it('refuses a watermark outside 1 to 255 characters and changes nothing', () => {
    const c = core();
    const before = pageSetup(c).attrs['watermark'];
    const tooLong = 'x'.repeat(256);
    expect(
      c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { watermark: tooLong } } }),
    ).toBe(false);
    expect(c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { watermark: '' } } })).toBe(
      false,
    );
    expect(pageSetup(c).attrs['watermark']).toBe(before);
  });

  it('is unavailable to an editor without edit on the definitions, and stores nothing', () => {
    const c = core(editorAccess());
    const args = { pageSetup: { id: 'ps1', changes: { watermark: 'DRAFT' } } };
    expect(c.queryCommand('setPageSetup', args)).toMatchObject({
      enabled: false,
      reason: 'no-access',
    });
    expect(c.run('setPageSetup', args)).toBe(false);
    expect(pageSetup(c).attrs['watermark']).toBeNull();
  });
});
