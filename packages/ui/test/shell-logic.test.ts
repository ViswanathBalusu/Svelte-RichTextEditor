/**
 * Pure parts of the shell: who is shown in the header (UX-026), how many avatars and toolbar
 * controls fit (UX-026, UX-006), shortcut names for assistive technology, and the settings the
 * element reflects from its attributes.
 */
import { describe, expect, it } from 'vitest';
import { ariaShortcut, ariaShortcuts } from '../src/commands/keys.ts';
import { headerMode, SettingsStore, toolbarMode } from '../src/shell/settings.ts';
import { colourSlot, initials, peopleOf, visibleAvatars } from '../src/shell/presence.ts';
import { fittingItems, nextIndex } from '../src/shell/toolbar-layout.ts';

describe('people in the header (UX-026)', () => {
  it('shows each person once, active when any of their sessions is', () => {
    const people = peopleOf([
      { session: 's1', user: 'u1', name: 'Ada', status: 'idle' },
      { session: 's2', user: 'u2', status: 'idle' },
      { session: 's3', user: 'u1', name: 'Ada L.', status: 'active' },
    ]);
    expect(people).toEqual([
      { user: 'u1', serviceName: 'Ada', status: 'active', sessions: 2 },
      { user: 'u2', serviceName: null, status: 'idle', sessions: 1 },
    ]);
  });

  it('shows nobody the view leaves out (ADR 0019)', () => {
    expect(peopleOf([])).toEqual([]);
    expect(peopleOf([{ session: 's1', user: '', status: 'active' }])).toEqual([]);
  });

  it('keeps room for the overflow button when not everyone fits', () => {
    expect(visibleAvatars(3, 200, 32, 4, 40)).toBe(3);
    // 10 avatars of 32 with gaps of 4 need 356; in 200 with a 40 button: 4 avatars.
    expect(visibleAvatars(10, 200, 32, 4, 40)).toBe(4);
    expect(visibleAvatars(10, 0, 32, 4, 40)).toBe(10);
    expect(visibleAvatars(5, 20, 32, 4, 40)).toBe(0);
  });

  it('makes initials and stable colour slots', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace')).toBe('G');
    expect(initials('Jean-Luc de la Fontaine')).toBe('JF');
    expect(initials('  ')).toBe('');
    expect(colourSlot('u1')).toBe(colourSlot('u1'));
    for (const id of ['a', 'b', 'c', 'user-42']) expect(colourSlot(id)).toBeGreaterThanOrEqual(1);
  });
});

describe('the toolbar row (UX-006, criterion 5)', () => {
  it('keeps every control when the row is wide enough', () => {
    expect(fittingItems([50, 60, 70], 200, 4, 40)).toBe(3);
  });

  it('keeps room for "More" when it is not', () => {
    // 50 + 4 + 60 = 114; with 4 + 40 for "More" that is 158 <= 160; a third would not fit.
    expect(fittingItems([50, 60, 70], 160, 4, 40)).toBe(2);
    expect(fittingItems([50, 60, 70], 30, 4, 40)).toBe(0);
  });

  it('hides nothing on unknown sizes', () => {
    expect(fittingItems([50, 0, 70], 10, 4, 40)).toBe(3);
    expect(fittingItems([50, 60], 0, 4, 40)).toBe(2);
    expect(fittingItems([], 100, 4, 40)).toBe(0);
  });

  it('moves the roving focus with wrapping', () => {
    expect(nextIndex(0, 3, 1)).toBe(1);
    expect(nextIndex(2, 3, 1)).toBe(0);
    expect(nextIndex(0, 3, -1)).toBe(2);
    expect(nextIndex(0, 0, 1)).toBe(-1);
  });
});

describe('shortcuts for assistive technology', () => {
  it('names Mod after the platform', () => {
    expect(ariaShortcut('Mod-b', false)).toBe('Control+B');
    expect(ariaShortcut('Mod-b', true)).toBe('Meta+B');
    expect(ariaShortcut('Shift-Mod-z', false)).toBe('Control+Shift+Z');
    expect(ariaShortcuts(['Mod-y', 'Shift-Mod-z'], false)).toBe('Control+Y Control+Shift+Z');
    expect(ariaShortcuts(undefined, false)).toBeUndefined();
  });
});

describe('settings from attributes', () => {
  it('read the documented values and keep the default for anything else', () => {
    expect(toolbarMode('none')).toBe('none');
    expect(toolbarMode('full')).toBe('full');
    expect(toolbarMode('sideways')).toBe('compact');
    expect(toolbarMode(null)).toBe('compact');
    expect(headerMode('none')).toBe('none');
    expect(headerMode('')).toBe('default');
  });

  it('notify only on a change', () => {
    const store = new SettingsStore();
    let n = 0;
    store.subscribe(() => n++);
    store.set({ toolbar: 'compact' });
    expect(n).toBe(0);
    store.set({ locale: 'en-XA' });
    expect(n).toBe(1);
    expect(store.get()).toEqual({
      toolbar: 'compact',
      header: 'default',
      locale: 'en-XA',
      theme: 'light',
      pageTheme: 'light',
    });
    store.set({ theme: 'dark' });
    expect(n).toBe(2);
  });
});
