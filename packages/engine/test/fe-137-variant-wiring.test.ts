/**
 * Turning on a first-page or odd and even variant through the core's `setPageSetup` creates its
 * header and footer stories in the same step (FE-137 criterion 2, engine part; lane U-FE-129-141).
 * The header panel opening is the view's (FE-057) and is not tested here.
 */
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { storyOfVariant } from '../src/header-footer.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access: ownerAccess(), schedule: microtask });
}

function setup(c: DocumentCore) {
  let found: { attrs: Record<string, unknown> } | null = null;
  internals(c).state.doc.descendants((n) => {
    if (found === null && n.type.name === 'page_setup' && n.attrs['id'] === 'ps1') {
      found = { attrs: n.attrs };
    }
    return found === null;
  });
  return found!.attrs;
}

describe('setPageSetup turns on variants with their stories (FE-137 criterion 2)', () => {
  it('turning on the first-page variant creates its header and footer stories with the flag', () => {
    const c = core();
    expect(
      c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { differentFirstPage: true } } }),
    ).toBe(true);
    const doc = internals(c).state.doc;
    expect(storyOfVariant(doc, 'ps1', 'header', 'first')).not.toBeNull();
    expect(storyOfVariant(doc, 'ps1', 'footer', 'first')).not.toBeNull();
    expect(setup(c)['differentFirstPage']).toBe(true);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('turning on the odd and even variant in the same call as a margin stores both', () => {
    const c = core();
    expect(
      c.run('setPageSetup', {
        pageSetup: { id: 'ps1', changes: { differentOddEven: true, marginLeft: 1440 } },
      }),
    ).toBe(true);
    const doc = internals(c).state.doc;
    expect(storyOfVariant(doc, 'ps1', 'header', 'even')).not.toBeNull();
    expect(storyOfVariant(doc, 'ps1', 'footer', 'even')).not.toBeNull();
    expect(setup(c)['differentOddEven']).toBe(true);
    expect(setup(c)['marginLeft']).toBe(1440);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('turning a variant off creates no stories', () => {
    const c = core();
    expect(
      c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { differentFirstPage: false } } }),
    ).toBe(true);
    expect(storyOfVariant(internals(c).state.doc, 'ps1', 'header', 'first')).toBeNull();
    expect(setup(c)['differentFirstPage']).toBe(false);
  });

  it('a second turn-on reuses the stories it already has', () => {
    const c = core();
    const args = { pageSetup: { id: 'ps1', changes: { differentFirstPage: true } } };
    expect(c.run('setPageSetup', args)).toBe(true);
    const before = internals(c).state.doc.toJSON();
    expect(c.run('setPageSetup', args)).toBe(true);
    expect(internals(c).state.doc.toJSON()).toEqual(before);
  });
});
