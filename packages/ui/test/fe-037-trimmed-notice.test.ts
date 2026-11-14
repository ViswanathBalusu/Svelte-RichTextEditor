/**
 * FE-037 criterion 2 (lane V-FE-033-048): a deletion the core trimmed to the parts the user may change
 * gives the shell a notice that says parts were kept, with the count of scopes kept and no scope name.
 * The live region that announces it is the shell's (App.svelte); this file tests the tracker it uses.
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { NoticeTracker } from '../src/shell/notices.ts';

describe('trimmed deletions (FE-037 criterion 2)', () => {
  it('reports each new trimmed deletion once, with the number of scopes kept', () => {
    const tracker = new NoticeTracker(null, undefined, null);
    const first = tracker.trimmed({ n: 1, skipped: ['region:r1'] });
    expect(first).toMatchObject({ kind: 'trimmed', key: 'notice.trimmed.kept', count: 1 });
    expect(tracker.trimmed({ n: 1, skipped: ['region:r1'] })).toBeNull();
    const second = tracker.trimmed({ n: 2, skipped: ['region:r1', 'region:r2'] });
    expect(second).toMatchObject({ kind: 'trimmed', count: 2 });
    expect(second!.serial).toBeGreaterThan(first!.serial);
  });

  it('does not report a trimmed deletion that was there before the shell started', () => {
    const tracker = new NoticeTracker(null, undefined, { n: 3, skipped: ['region:r1'] });
    expect(tracker.trimmed({ n: 3, skipped: ['region:r1'] })).toBeNull();
    expect(tracker.trimmed(null)).toBeNull();
    expect(tracker.trimmed(undefined)).toBeNull();
  });

  it('keeps the refusal and recovered trackers independent of the trimmed one', () => {
    const tracker = new NoticeTracker(null, undefined, null);
    expect(tracker.trimmed({ n: 1, skipped: [] })).not.toBeNull();
    expect(tracker.refusal({ n: 1, reason: 'scope', scopes: [] })).toMatchObject({
      kind: 'refusal',
      key: 'notice.refused.scope',
    });
  });

  it('names the kept parts in plain words and no scope identifier', () => {
    const text = EN_GB['notice.trimmed.kept'];
    expect(typeof text).toBe('string');
    expect(text).toMatch(/Part of that deletion was kept/);
    expect(text).not.toMatch(/region|scope|:r\d/);
  });
});
