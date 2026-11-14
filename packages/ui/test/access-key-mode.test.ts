/**
 * The access-key gesture (UX-012; 13 §4): Alt pressed and released alone starts the mode, a letter
 * or digit then names a shown key, Escape leaves, and Alt used with another key is not the gesture.
 * A key shown for commands in two groups is ambiguous and runs nothing. The browser run is in
 * packages/ui/e2e/ux-012-access-keys.spec.ts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AccessKeyGesture,
  isModifierKey,
  resolveShownKey,
  type ShownAccessKey,
} from '../src/shell/access-key-mode.ts';

describe('access-key gesture (UX-012)', () => {
  it('starts the mode when Alt is pressed and released with no other key', () => {
    const g = new AccessKeyGesture();
    expect(g.keyDown('Alt')).toEqual({ kind: 'none' });
    expect(g.keyUp('Alt')).toEqual({ kind: 'enter' });
    expect(g.active).toBe(true);
  });

  it('does not start the mode for a shortcut such as Alt+Q', () => {
    const g = new AccessKeyGesture();
    g.keyDown('Alt');
    expect(g.keyDown('q')).toEqual({ kind: 'none' });
    expect(g.keyUp('q')).toEqual({ kind: 'none' });
    expect(g.keyUp('Alt')).toEqual({ kind: 'none' });
    expect(g.active).toBe(false);
  });

  it('does not start the mode when a modifier is pressed with Alt', () => {
    const g = new AccessKeyGesture();
    g.keyDown('Alt');
    g.keyDown('Control');
    expect(g.keyUp('Alt')).toEqual({ kind: 'none' });
    expect(g.active).toBe(false);
  });

  it('returns a letter or digit in the mode as a press, lower case, and keeps other keys out', () => {
    const g = new AccessKeyGesture();
    g.keyDown('Alt');
    g.keyUp('Alt');
    expect(g.keyDown('B')).toEqual({ kind: 'press', key: 'b' });
    expect(g.keyDown('7')).toEqual({ kind: 'press', key: '7' });
    expect(g.keyDown('ArrowLeft')).toEqual({ kind: 'consume' });
    expect(g.keyDown('Shift')).toEqual({ kind: 'none' });
    expect(g.active).toBe(true);
  });

  it('leaves the mode on Escape and does not restart it on the Alt release', () => {
    const g = new AccessKeyGesture();
    g.keyDown('Alt');
    g.keyUp('Alt');
    expect(g.keyDown('Escape')).toEqual({ kind: 'leave' });
    expect(g.active).toBe(false);
    expect(g.keyUp('Alt')).toEqual({ kind: 'none' });
  });

  it('does not enter the mode again while it is on', () => {
    const g = new AccessKeyGesture();
    g.keyDown('Alt');
    g.keyUp('Alt');
    g.keyDown('Alt');
    expect(g.keyUp('Alt')).toEqual({ kind: 'none' });
    expect(g.active).toBe(true);
  });

  it('ends on exit without a key', () => {
    const g = new AccessKeyGesture();
    g.keyDown('Alt');
    g.keyUp('Alt');
    g.exit();
    expect(g.active).toBe(false);
  });

  it('recognises the modifier keys', () => {
    for (const key of ['Alt', 'Shift', 'Control', 'Meta', 'AltGraph', 'CapsLock'])
      expect(isModifierKey(key)).toBe(true);
    expect(isModifierKey('b')).toBe(false);
  });
});

describe('resolveShownKey', () => {
  const shown: ShownAccessKey[] = [
    { id: 'format.bold', key: 'b', group: 'format' },
    { id: 'insert.table', key: 't', group: 'insert' },
    { id: 'format.italic', key: 'i', group: 'format' },
    { id: 'edit.title', key: 't', group: 'edit' },
  ];

  it('resolves a shown key to its command and group', () => {
    expect(resolveShownKey(shown, 'B')).toEqual({
      kind: 'one',
      id: 'format.bold',
      group: 'format',
    });
  });

  it('runs nothing for a key no shown command has', () => {
    expect(resolveShownKey(shown, 'z')).toEqual({ kind: 'none' });
    expect(resolveShownKey([], 'b')).toEqual({ kind: 'none' });
  });

  it('does not guess when a key is shown in two groups', () => {
    expect(resolveShownKey(shown, 't')).toEqual({ kind: 'ambiguous' });
  });

  it('resolves any key that one group shows, whatever the key (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), (k) => {
        const one: ShownAccessKey[] = [{ id: 'x.y', key: k, group: 'g' }];
        expect(resolveShownKey(one, k.toUpperCase())).toEqual({
          kind: 'one',
          id: 'x.y',
          group: 'g',
        });
      }),
    );
  });
});
