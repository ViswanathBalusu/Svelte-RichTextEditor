/**
 * Moving between landmarks by keyboard (UX-023). The ordering and the stepping are pure functions
 * over any node type, so they run here in Node.js with string nodes. The browser's visibility
 * reading (`getClientRects`) and focus are not run in this file (see ADR 0113 and the story notes).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalKey } from '../src/commands/keys.ts';
import { shortcutRow } from '../src/shortcuts/table.ts';
import {
  LANDMARK_ORDER,
  landmarkKeys,
  orderLandmarks,
  stepLandmark,
  type LandmarkEntry,
} from '../src/shell/landmarks.ts';

const shown = (node: string, landmark: string | null): LandmarkEntry<string> => ({
  node,
  landmark,
  visible: true,
});

describe('the order of the landmarks (UX-023, criterion 1)', () => {
  it('lists header, toolbar, page, panes and status bar in that order, whatever the document order', () => {
    const entries = [
      shown('status', 'status'),
      shown('pane-b', 'pane'),
      shown('page', 'page'),
      shown('toolbar', 'toolbar'),
      shown('pane-a', 'pane'),
      shown('header', 'header'),
    ];
    expect(orderLandmarks(entries)).toEqual([
      'header',
      'toolbar',
      'page',
      'pane-b',
      'pane-a',
      'status',
    ]);
  });

  it('keeps the document order inside one kind of landmark (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            landmark: fc.constantFrom(...LANDMARK_ORDER, null),
            visible: fc.boolean(),
            n: fc.nat(99),
          }),
          { maxLength: 30 },
        ),
        (items) => {
          const entries = items.map((it, i) => ({
            node: `${it.landmark ?? 'none'}:${i}`,
            landmark: it.landmark,
            visible: it.visible,
          }));
          const out = orderLandmarks(entries);
          const ranks = out.map((node) => LANDMARK_ORDER.indexOf(node.split(':')[0] as never));
          for (let i = 1; i < ranks.length; i++)
            expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
          // Within a kind, the input order is kept.
          for (const kind of LANDMARK_ORDER) {
            const inKind = out
              .filter((node) => node.startsWith(`${kind}:`))
              .map((n) => Number(n.split(':')[1]));
            const sorted = [...inKind].sort((a, b) => a - b);
            expect(inKind).toEqual(sorted);
          }
        },
      ),
    );
  });
});

describe('absent or hidden landmarks are skipped (UX-023, criterion 2, the ordering part)', () => {
  it('leaves out a hidden entry and a name the shell does not know, and keeps the rest', () => {
    const entries = [
      shown('header', 'header'),
      { node: 'toolbar', landmark: 'toolbar', visible: false },
      shown('page', 'page'),
      shown('other', 'sidebar'),
      shown('none', null),
      shown('status', 'status'),
    ];
    expect(orderLandmarks(entries)).toEqual(['header', 'page', 'status']);
  });

  it('steps from the page straight to the status bar when the panes are closed', () => {
    const list = orderLandmarks([shown('status', 'status'), shown('page', 'page')]);
    expect(stepLandmark(list, list.indexOf('page'), 1)).toBe('status');
  });
});

describe('stepping between landmarks (UX-023, criterion 1)', () => {
  const list = ['header', 'toolbar', 'page', 'status'];

  it('moves forward to the next landmark and wraps to the first after the last', () => {
    expect(stepLandmark(list, 0, 1)).toBe('toolbar');
    expect(stepLandmark(list, 2, 1)).toBe('status');
    expect(stepLandmark(list, 3, 1)).toBe('header');
  });

  it('moves backward to the previous landmark and wraps to the last before the first', () => {
    expect(stepLandmark(list, 2, -1)).toBe('toolbar');
    expect(stepLandmark(list, 0, -1)).toBe('status');
  });

  it('starts at the first landmark going forward, and at the last going backward, from no landmark', () => {
    expect(stepLandmark(list, -1, 1)).toBe('header');
    expect(stepLandmark(list, -1, -1)).toBe('status');
  });

  it('returns nothing when there are no landmarks', () => {
    expect(stepLandmark([], -1, 1)).toBeUndefined();
    expect(stepLandmark([], 0, -1)).toBeUndefined();
  });

  it('a full cycle forward returns to the start, and a step back undoes a step forward (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 7 }), (n, start0) => {
        const items = Array.from({ length: n }, (_, i) => `l${i}`);
        const start = start0 % n;
        let at = start;
        for (let i = 0; i < n; i++) at = items.indexOf(stepLandmark(items, at, 1)!);
        expect(at).toBe(start);
        const forward = stepLandmark(items, start, 1)!;
        expect(stepLandmark(items, items.indexOf(forward), -1)).toBe(items[start]);
      }),
    );
  });
});

describe('the keys that move between landmarks (UX-023, criterion 3)', () => {
  it('names Alt+F6 as the alternative of Ctrl+F6, and Shift+Alt+F6 of Shift+Ctrl+F6', () => {
    expect(shortcutRow('shell.nextLandmark')?.alternative).toEqual(['Alt-F6']);
    expect(shortcutRow('shell.previousLandmark')?.alternative).toEqual(['Shift-Alt-F6']);
  });

  it('answers the primary keys and the alternatives on Windows and Linux and on Apple platforms', () => {
    for (const apple of [false, true]) {
      const keys = landmarkKeys(apple);
      for (const k of ['Ctrl-F6', 'Alt-F6'])
        expect(keys.next.has(canonicalKey(k, apple)!)).toBe(true);
      for (const k of ['Shift-Ctrl-F6', 'Shift-Alt-F6'])
        expect(keys.previous.has(canonicalKey(k, apple)!)).toBe(true);
      for (const k of keys.next) expect(keys.previous.has(k)).toBe(false);
    }
  });
});
