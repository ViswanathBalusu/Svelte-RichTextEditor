// The choice of view for the `view` attribute (FE-065 criteria 1, 2, 4 and 5, in their decision part).
// The mounting of each view is not built, so these tests cover only which view the element chooses.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, VIEW_STRINGS, selectView } from '../src/view-select.ts';

const desktop = { touch: false, pageViewAvailable: true };
const desktopNoPage = { touch: false, pageViewAvailable: false };
const touch = { touch: true, pageViewAvailable: true };

describe('the web view (FE-065 criterion 1, decision and label)', () => {
  it('chooses the web view for view="web", with no fallback', () => {
    expect(selectView('web', desktop)).toEqual({ view: 'web', fallback: false });
  });

  it('labels the web view through the interface string', () => {
    expect(VIEW_STRINGS.web).toBe('Web layout');
  });
});

describe('the read and print views (FE-065 criterion 2, decision part)', () => {
  it('chooses the read view for view="read"', () => {
    expect(selectView('read', desktop)).toEqual({ view: 'read', fallback: false });
  });

  it('chooses the print view for view="print" when the page view exists', () => {
    expect(selectView('print', desktop)).toEqual({ view: 'print', fallback: false });
  });
});

describe('view="print" without the page view (FE-065 criterion 4)', () => {
  it('shows the web view as a fallback and does not throw', () => {
    expect(() => selectView('print', desktopNoPage)).not.toThrow();
    expect(selectView('print', desktopNoPage)).toEqual({ view: 'web', fallback: true });
  });
});

describe('a touch device (FE-065 criterion 5, decision part)', () => {
  it('uses the web view whatever view is requested', () => {
    fc.assert(
      fc.property(fc.constantFrom('web', 'read', 'print', null, 'other'), (attribute) => {
        expect(selectView(attribute, touch).view).toBe('web');
      }),
    );
  });

  it('reports a fallback when a view other than the web view was asked for', () => {
    expect(selectView('read', touch)).toEqual({ view: 'web', fallback: true });
    expect(selectView('web', touch)).toEqual({ view: 'web', fallback: false });
  });
});

describe('the default (open question in 05 §8.1)', () => {
  it('chooses the web view when the attribute is absent or unknown', () => {
    expect(DEFAULT_VIEW).toBe('web');
    expect(selectView(null, desktop)).toEqual({ view: 'web', fallback: false });
    expect(selectView('unknown', desktop)).toEqual({ view: 'web', fallback: false });
  });
});
