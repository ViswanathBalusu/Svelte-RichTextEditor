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

  it('says why a column, a merge or a split was refused in suggestion mode (FE-045 criterion 5)', () => {
    const tracker = new NoticeTracker(null, undefined);
    const notice = tracker.refusal({ n: 1, reason: 'suggestion', scopes: ['body'] });
    expect(notice).toMatchObject({ kind: 'refusal', key: 'notice.refused.suggestion' });
    const words = new Strings().current;
    expect(words.t('notice.refused.suggestion')).toContain('suggestion mode cannot record it');
    // The words carry no scope: the notice does not say where the change was tried (ADR 0019).
    expect(words.t('notice.refused.suggestion')).not.toContain('body');
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
      'suggestion',
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

  it('tells a fill that lost to another change of the same field that someone else changed it (FRW-010)', () => {
    const tracker = new NoticeTracker(null, { count: 0, items: [] });
    const tr = new Strings().current;
    const notice = tracker.recovered({
      count: 1,
      items: [{ ...item('conflict'), fields: ['f1'] }],
    });
    expect(notice).toMatchObject({ kind: 'rejection', key: 'notice.rejected.fieldConflict' });
    expect(tr.t('notice.rejected.fieldConflict', { count: 1 })).toMatch(
      /changed by someone else.*current value/,
    );
    // A conflict that named no field keeps the general words.
    const general = tracker.recovered({
      count: 2,
      items: [{ ...item('conflict'), fields: ['f1'] }, item('conflict')],
    });
    expect(general).toMatchObject({ key: 'notice.rejected.conflict' });
  });

  it('tells a fill that a rule of the document stopped in the rule’s own words (FRW-023)', () => {
    const tracker = new NoticeTracker(null, { count: 0, items: [] });
    const tr = new Strings().current;
    const withMessage = tracker.recovered({
      count: 1,
      items: [
        { ...item('permission_denied'), rule: { id: 'r_amount', message: 'Enter at least 10.' } },
      ],
    });
    expect(withMessage).toMatchObject({
      kind: 'rejection',
      key: 'notice.rejected.rule',
      params: { rule: 'Enter at least 10.' },
    });
    expect(tr.t('notice.rejected.rule', { count: 1, ...withMessage!.params })).toMatch(
      /a rule of this document stopped it: Enter at least 10\./,
    );
    // A rule with no message of its own is named by its identifier.
    const bare = tracker.recovered({
      count: 2,
      items: [
        { ...item('permission_denied'), rule: { id: 'r_amount', message: 'Enter at least 10.' } },
        { ...item('permission_denied'), rule: { id: 'rHideName', message: null } },
      ],
    });
    expect(bare).toMatchObject({ key: 'notice.rejected.rule', params: { rule: 'rHideName' } });
    // A permission refusal that named no rule keeps the general words.
    const plain = tracker.recovered({
      count: 3,
      items: [
        { ...item('permission_denied'), rule: { id: 'r_amount', message: 'Enter at least 10.' } },
        { ...item('permission_denied'), rule: { id: 'rHideName', message: null } },
        item('permission_denied'),
      ],
    });
    expect(plain).toMatchObject({ key: 'notice.rejected.permission' });
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
      // `skipped` is the second number of the replace report (FE-060 criterion 3).
      // `rule` is the rule's own words (FRW-023 criterion 5).
      // `char` and `family` are the symbol the person just inserted and the host's font name (FE-136).
      const text = tr.text(key, {
        count: 2,
        skipped: 1,
        rule: 'Enter at least 10.',
        char: 'ω',
        family: 'Test Face',
      });
      expect(text, key).not.toMatch(/\{/);
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
