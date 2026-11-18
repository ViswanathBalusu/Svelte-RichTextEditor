/**
 * FE-060 criterion 3, the shell's part: the report of Replace and Replace all says how many matches
 * were replaced and how many skipped, with the core's numbers, and says nothing about skipping when
 * nothing was skipped. The core's numbers are tested in `packages/engine/test/fe-060-replace-report.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { Strings } from '../src/i18n/strings.ts';
import { NoticeTracker } from '../src/shell/notices.ts';

const tracker = () => new NoticeTracker(null, undefined, null, null);
const words = new Strings().current;

function text(notice: ReturnType<NoticeTracker['replaced']>): string {
  if (!notice) throw new Error('no notice');
  return words.t(notice.key, { count: notice.count, ...notice.params });
}

describe('the replace report (FE-060 criterion 3)', () => {
  it('names the replaced and the skipped counts when matches were skipped', () => {
    const notice = tracker().replaced({ n: 1, all: true, replaced: 4, skipped: 3 });
    expect(notice).toMatchObject({ kind: 'replaced', key: 'notice.replaced.skipped', count: 4 });
    expect(notice?.params).toEqual({ skipped: 3 });
    expect(text(notice)).toBe(
      'Replaced 4 matches. Skipped 3: you cannot change those parts of the document.',
    );
  });

  it('shows no skipped-matches message when every match was replaced', () => {
    const notice = tracker().replaced({ n: 1, all: true, replaced: 5, skipped: 0 });
    expect(notice?.key).toBe('notice.replaced.done');
    expect(text(notice)).toBe('Replaced 5 matches.');
    expect(text(notice)).not.toMatch(/skipped/i);
  });

  it('says zero replaced and the number skipped when every match is locked', () => {
    const notice = tracker().replaced({ n: 1, all: true, replaced: 0, skipped: 2 });
    expect(text(notice)).toBe(
      'Replaced 0 matches. Skipped 2: you cannot change those parts of the document.',
    );
  });

  it('uses the singular for one match', () => {
    expect(text(tracker().replaced({ n: 1, all: false, replaced: 1, skipped: 0 }))).toBe(
      'Replaced 1 match.',
    );
  });

  it('reports each report once, and not one that was there before the shell started', () => {
    const t = tracker();
    const first = t.replaced({ n: 1, all: true, replaced: 1, skipped: 0 });
    expect(t.replaced({ n: 1, all: true, replaced: 1, skipped: 0 })).toBeNull();
    const second = t.replaced({ n: 2, all: true, replaced: 1, skipped: 0 });
    expect(second!.serial).toBeGreaterThan(first!.serial);
    expect(t.replaced(null)).toBeNull();
    const started = new NoticeTracker(null, undefined, null, {
      n: 7,
      all: true,
      replaced: 1,
      skipped: 0,
    });
    expect(started.replaced({ n: 7, all: true, replaced: 1, skipped: 0 })).toBeNull();
  });

  it('names no scope and no text', () => {
    for (const key of ['notice.replaced.done', 'notice.replaced.skipped'] as const) {
      expect(JSON.stringify(words.t(key, { count: 2, skipped: 1 }))).not.toMatch(
        /region|scope|:r\d/,
      );
    }
  });
});
