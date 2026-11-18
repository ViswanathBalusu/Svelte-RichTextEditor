/**
 * Turning on a first-page or odd and even variant through the core's `setPageSetup` creates its
 * header and footer stories in the same step (FE-137 criterion 2, engine part; lane U-FE-129-141).
 * The core also opens the header of a variant just turned on in the panel (criterion 2, round w1).
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

  it('opens the new variant header in the header panel (criterion 2, FE-057)', () => {
    const c = core();
    expect(c.panel.get()).toBeNull();
    c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { differentFirstPage: true } } });
    const doc = internals(c).state.doc;
    const header = storyOfVariant(doc, 'ps1', 'header', 'first');
    expect(c.panel.get()).toMatchObject({
      kind: 'story',
      id: header,
      label: 'Header',
      part: 'header',
      variant: 'first',
    });
    // The footer of the variant exists too, and the panel offers it as its own button.
    expect(c.storyVariants().find((v) => v.part === 'footer' && v.variant === 'first')?.story).toBe(
      storyOfVariant(doc, 'ps1', 'footer', 'first'),
    );
  });

  it('opens the odd and even variant header when only that flag is turned on', () => {
    const c = core();
    c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { differentOddEven: true } } });
    expect(c.panel.get()).toMatchObject({ part: 'header', variant: 'even' });
  });

  it('opens no panel when no variant is turned on, or when it was already on', () => {
    const c = core();
    c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { marginLeft: 1440 } } });
    expect(c.panel.get()).toBeNull();
    c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { differentFirstPage: true } } });
    c.closePanel();
    c.run('setPageSetup', { pageSetup: { id: 'ps1', changes: { differentFirstPage: true } } });
    expect(c.panel.get()).toBeNull();
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
