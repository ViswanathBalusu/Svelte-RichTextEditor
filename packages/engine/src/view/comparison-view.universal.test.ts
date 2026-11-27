/**
 * A comparison drawn over a version in a real browser (HIS-013 criteria 1 and 4): insertions carry the
 * classes of suggestion marks and the author tone, every changed block has a change bar, deletions
 * appear only when asked for, the text does not move when the comparison is drawn without
 * deletions, and a change can be reached by its position.
 *
 * Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import type { ComparisonChange } from '../comparison-markup.ts';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { authorTone } from '../suggestion-markup.ts';
import { VersionView } from './version-web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const changes: ComparisonChange[] = [
  {
    kind: 'modified',
    blockId: SPIKE_IDS.intro,
    spans: [
      { op: 'insert', at: 0, text: 'Alp', user: 'ada', seq: 3 },
      { op: 'delete', at: 3, text: 'old ', user: 'bob', seq: 4 },
    ],
  },
  { kind: 'formatted', blockId: SPIKE_IDS.after, user: 'bob', seq: 5 },
  { kind: 'removed', blockId: 'pGone000000000001', user: 'cy', seq: 6 },
];

describe.skipIf(!isBrowser)('a comparison over a version in the web view (HIS-013)', () => {
  it('draws insertions, change bars and deletions on demand, without moving the text', async () => {
    const view = VersionView.open(
      { seq: 5, content: spikeDocument(), time: '2026-11-01T10:00:00Z' },
      { schedule: (run) => queueMicrotask(run) },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const unmount = view.mount(host);
    try {
      // The last paragraph is below every change: if the bars moved the text, it would move.
      // It is looked up each time: drawing the comparison may draw the paragraph again.
      const last = (): HTMLElement | null =>
        [...host.querySelectorAll<HTMLElement>('p')].at(-1) ?? null;
      expect(last()).not.toBeNull();
      const top = (): number => last()!.getBoundingClientRect().top;
      const before = top();

      view.showComparison(changes);
      await tick();
      const ins = host.querySelector<HTMLElement>('.de-suggest-ins');
      expect(ins?.textContent).toBe('Alp');
      expect(ins?.getAttribute('data-suggestion-user')).toBe('ada');
      expect(ins?.getAttribute('data-suggestion-tone')).toBe(String(authorTone('ada')));
      expect(host.querySelectorAll('.de-change-bar').length).toBe(2);
      // Deletions are off: nothing was added, so the text below has not moved.
      expect(host.querySelector('.de-compare-deleted')).toBeNull();
      expect(Math.abs(top() - before)).toBeLessThan(1);

      view.showDeletions(true);
      await tick();
      const del = host.querySelector<HTMLElement>('del.de-compare-deleted');
      expect(del?.textContent).toBe('old ');
      expect(del?.classList.contains('de-suggest-del')).toBe(true);
      expect(del?.getAttribute('data-suggestion-user')).toBe('bob');

      view.showDeletions(false);
      await tick();
      expect(host.querySelector('.de-compare-deleted')).toBeNull();

      // Navigation: a change in the document can be reached; a removed block has no place here.
      expect(view.focusChange(0)).toBe(true);
      // Focus is now on the first changed block, which holds the insertion.
      expect(host.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.textContent).toContain('Alp');
      expect(view.focusChange(1)).toBe(true);
      expect(view.focusChange(2)).toBe(false);

      view.clearComparison();
      await tick();
      expect(host.querySelector('.de-change-bar')).toBeNull();
      expect(host.querySelector('.de-suggest-ins')).toBeNull();
    } finally {
      unmount();
      view.destroy();
      host.remove();
    }
  });
});
