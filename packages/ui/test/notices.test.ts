/**
 * Notices for changes that did not happen (11 §3 exit check; 07 §9; FE-036; UX-017): every refusal
 * and every set-aside item is reported once, in plain words from the source table, and no notice
 * carries a scope, a title or any other content (ADR 0019).
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { Strings } from '../src/i18n/strings.ts';
import { NoticeTracker, refusalKey, rejectionKey } from '../src/shell/notices.ts';

describe('refusals of the region guard', () => {
  it('reports each new refusal once, also the same reason twice', () => {
    const tracker = new NoticeTracker(null, undefined);
    const first = tracker.refusal({ n: 1, reason: 'scope', scopes: ['region:r1'] });
    expect(first).toMatchObject({ kind: 'refusal', key: 'notice.refused.scope' });
    expect(tracker.refusal({ n: 1, reason: 'scope', scopes: ['region:r1'] })).toBeNull();
    const second = tracker.refusal({ n: 2, reason: 'scope', scopes: ['region:r1'] });
    expect(second?.serial).toBeGreaterThan(first!.serial);
  });

  it('does not report what was there before the shell started', () => {
    const tracker = new NoticeTracker({ n: 4, reason: 'scope', scopes: [] }, undefined);
    expect(tracker.refusal({ n: 4, reason: 'scope', scopes: [] })).toBeNull();
    expect(tracker.refusal(null)).toBeNull();
  });

  it('explains every code of the guard, and an unknown one in general words', () => {
    for (const reason of [
      'scope',
      'structure',
      'manage',
      'read-only',
      'placeholder',
      'redacted',
      'identifier',
      'step',
      'invariant',
    ])
      expect(refusalKey(reason), reason).not.toBe('notice.refused.other');
    expect(refusalKey('something-new')).toBe('notice.refused.other');
  });
});

describe('work set aside', () => {
  it('reports the items added, with their number, and not those removed', () => {
    const tracker = new NoticeTracker(null, { count: 1, items: [item('rebase')] });
    const notice = tracker.recovered({
      count: 3,
      items: [item('rebase'), item('permission_denied'), item('permission_denied')],
    });
    expect(notice).toMatchObject({
      kind: 'rejection',
      key: 'notice.rejected.permission',
      count: 2,
    });
    expect(tracker.recovered({ count: 1, items: [item('rebase')] })).toBeNull();
  });

  it('explains the rejection codes of 05 §5.8 and the reasons of the sync client', () => {
    expect(rejectionKey('permission_denied')).toBe('notice.rejected.permission');
    expect(rejectionKey('read_only')).toBe('notice.rejected.readOnly');
    expect(rejectionKey('rebase')).toBe('notice.rejected.rebase');
    expect(rejectionKey('reload')).toBe('notice.rejected.reload');
    expect(rejectionKey('internal')).toBe('notice.rejected.other');
  });
});

describe('the words of a notice', () => {
  it('come from the source table and name no content', () => {
    const tr = new Strings().current;
    const keys = Object.keys(EN_GB).filter((k) => k.startsWith('notice.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      const text = tr.text(key, { count: 2 });
      expect(text, key).not.toMatch(/\{(?!count)/);
      expect(text, key).not.toMatch(/region:|story:|field:/);
    }
    expect(tr.t('notice.rejected.permission', { count: 1 })).toMatch(
      /^A change could not be saved/,
    );
    expect(tr.t('notice.rejected.permission', { count: 3 })).toMatch(/^3 changes/);
  });
});

function item(reason: string) {
  return { reason, commit: null, text: 'own words', seq: 1 };
}
