/**
 * The icon set (UX-063; 13 §8): host drawings keyed by the command's icon name, the fall back to
 * the built-in drawing, and the rule that a drawing is path data and never markup.
 */
import { describe, expect, it, vi } from 'vitest';
import { coreCommands } from '../src/commands/builtin.ts';
import {
  BUILT_IN_ICONS,
  DEFAULT_VIEW_BOX,
  Icons,
  MAX_ICON_PATH_LENGTH,
  MAX_ICON_PATHS,
  builtInIcons,
  parseIcon,
} from '../src/icons/icons.ts';

const SQUARE = 'M4 4h16v16H4z';

describe('parseIcon (UX-063, criterion 1)', () => {
  it('takes path data and a drawing with path data', () => {
    expect(parseIcon(SQUARE)).toEqual({ paths: [SQUARE] });
    expect(parseIcon({ paths: [SQUARE, 'M0 0l1 1'], viewBox: '0 0 16 16', fill: true })).toEqual({
      paths: [SQUARE, 'M0 0l1 1'],
      viewBox: '0 0 16 16',
      fill: true,
    });
  });

  it('refuses markup, scripts, styles and anything that is not path data', () => {
    for (const bad of [
      '<svg onload="alert(1)"></svg>',
      '<path d="M0 0"/>',
      'M0 0 <script>',
      'javascript:alert(1)',
      'url(#x)',
      'M0 0"/><circle',
      '',
      '   ',
    ]) {
      expect(parseIcon(bad), bad).toBeNull();
      expect(parseIcon({ paths: [bad] }), bad).toBeNull();
    }
  });

  it('refuses values of the wrong shape and limits', () => {
    for (const bad of [
      null,
      undefined,
      42,
      true,
      [],
      [SQUARE],
      {},
      { paths: [] },
      { paths: [42] },
      { paths: SQUARE },
      { paths: [SQUARE], viewBox: '0 0 0 24' },
      { paths: [SQUARE], viewBox: '0 0 24' },
      { paths: [SQUARE], viewBox: 'a b c d' },
      { paths: [SQUARE], viewBox: 24 },
      { paths: [SQUARE], fill: 'yes' },
      { paths: ['M0 0'.padEnd(MAX_ICON_PATH_LENGTH + 1, '0')] },
      { paths: Array.from({ length: MAX_ICON_PATHS + 1 }, () => SQUARE) },
    ]) {
      expect(parseIcon(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the icon set (UX-063, criterion 1)', () => {
  it('shows the host drawing for a name, and the built-in one for a name the host leaves out', () => {
    const icons = new Icons({ overrides: { bold: SQUARE } });
    expect(icons.current.resolve('bold')).toEqual({ paths: [SQUARE] });
    expect(icons.current.resolve('italic')).toBe(BUILT_IN_ICONS['italic']);
  });

  it('falls back to the built-in drawing for a drawing that is not usable, and reports it', () => {
    const onInvalid = vi.fn();
    const icons = new Icons({
      overrides: { bold: '<svg/>', italic: { paths: 'x' }, undo: SQUARE },
      onInvalid,
    });
    expect(icons.current.resolve('bold')).toBe(BUILT_IN_ICONS['bold']);
    expect(icons.current.resolve('italic')).toBe(BUILT_IN_ICONS['italic']);
    expect(icons.current.resolve('undo')).toEqual({ paths: [SQUARE] });
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(onInvalid).toHaveBeenCalledWith(['bold', 'italic']);
  });

  it('gives no drawing, not a broken one, for a name nobody draws', () => {
    const icons = new Icons({ overrides: {} });
    expect(icons.current.resolve('no-such-icon')).toBeNull();
    expect(icons.current.resolve('constructor')).toBeNull();
    expect(icons.current.resolve('toString')).toBeNull();
    expect(icons.current.resolve(undefined)).toBeNull();
    expect(builtInIcons().resolve('bold')).toBe(BUILT_IN_ICONS['bold']);
  });

  it('draws a host icon for a name the built-in set does not have', () => {
    const icons = new Icons({ overrides: { 'field-text': SQUARE } });
    expect(icons.current.resolve('field-text')).toEqual({ paths: [SQUARE] });
  });

  it('publishes a new set when the host changes its drawings', () => {
    const icons = new Icons({ overrides: {} });
    const seen: unknown[] = [];
    const stop = icons.view.subscribe(() => seen.push(icons.view.get().resolve('bold')));
    icons.setOverrides({ bold: SQUARE });
    icons.setOverrides({});
    stop();
    icons.setOverrides({ bold: SQUARE });
    expect(seen).toEqual([{ paths: [SQUARE] }, BUILT_IN_ICONS['bold']]);
  });

  it('shows no icons until the host gives a set, and none again when it takes the set away', () => {
    const icons = new Icons();
    expect(icons.current.resolve('bold')).toBeNull();
    icons.setOverrides({});
    expect(icons.current.resolve('bold')).toBe(BUILT_IN_ICONS['bold']);
    icons.setOverrides(null);
    expect(icons.current.resolve('bold')).toBeNull();
    expect(new Icons({ overrides: [SQUARE] as never }).current.resolve('bold')).toBeNull();
    expect(new Icons({ overrides: 'bold' as never }).current.resolve('bold')).toBeNull();
  });
});

describe('the built-in set', () => {
  it('is all valid path data, outlined on the default grid', () => {
    for (const [name, drawing] of Object.entries(BUILT_IN_ICONS)) {
      expect(parseIcon(drawing), name).not.toBeNull();
      expect(drawing.viewBox ?? DEFAULT_VIEW_BOX, name).toBe('0 0 24 24');
    }
  });

  it('draws the icon of the core commands that name one', () => {
    const named = coreCommands()
      .map((entry) => entry.icon)
      .filter((name): name is string => name !== undefined);
    expect(named.length).toBeGreaterThan(3);
    for (const name of ['bold', 'italic', 'undo', 'redo', 'select-all']) {
      expect(named, name).toContain(name);
      expect(builtInIcons().resolve(name), name).not.toBeNull();
    }
  });
});

describe('direction metadata (UX-065, criterion 2)', () => {
  it('marks the direction-carrying built-in drawings and not the others', () => {
    for (const name of ['undo', 'redo', 'comment', 'comments', 'outline', 'find']) {
      expect(BUILT_IN_ICONS[name]?.mirrorInRtl, name).toBe(true);
    }
    for (const name of ['bold', 'italic', 'close', 'insert', 'select-all', 'print', 'assistant']) {
      expect(BUILT_IN_ICONS[name]?.mirrorInRtl, name).toBeUndefined();
    }
  });

  it('takes the flag from a host drawing and refuses one that is not a boolean', () => {
    expect(parseIcon({ paths: [SQUARE], mirrorInRtl: true })).toEqual({
      paths: [SQUARE],
      mirrorInRtl: true,
    });
    expect(parseIcon({ paths: [SQUARE], mirrorInRtl: false })).toEqual({ paths: [SQUARE] });
    expect(parseIcon({ paths: [SQUARE], mirrorInRtl: 'yes' })).toBeNull();
    expect(parseIcon(SQUARE)).toEqual({ paths: [SQUARE] });
  });

  it('a host drawing replaces the built-in one, flag included', () => {
    const icons = new Icons({ overrides: { undo: SQUARE } });
    expect(icons.current.resolve('undo')?.mirrorInRtl).toBeUndefined();
  });
});
