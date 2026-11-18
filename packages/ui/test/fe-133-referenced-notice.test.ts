/**
 * FE-133 criterion 5, the telling half (lane w1, 2026-11-17): a deletion refused because a
 * cross-reference still names its target is explained in plain words, with the number of references,
 * and the notice offers the `showReferences` command. The engine records the refusal with the reason
 * `referenced` (packages/engine/test/fe-133-heading-and-references.test.ts). Node.js only.
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { Strings } from '../src/i18n/strings.ts';
import { NoticeTracker, refusalKey } from '../src/shell/notices.ts';

describe('a deletion a cross-reference names (FE-133 criterion 5)', () => {
  it('has its own message, not the general one', () => {
    expect(refusalKey('referenced')).toBe('notice.refused.referenced');
  });

  it('reports a new refusal once, with the number of references and the offer to show them', () => {
    const tracker = new NoticeTracker(null, undefined);
    const notice = tracker.refusal({ n: 1, reason: 'referenced', scopes: [], count: 3 });
    expect(notice).toMatchObject({
      kind: 'refusal',
      key: 'notice.refused.referenced',
      count: 3,
      action: 'showReferences',
    });
    expect(tracker.refusal({ n: 1, reason: 'referenced', scopes: [], count: 3 })).toBeNull();
    expect(tracker.refusal({ n: 2, reason: 'referenced', scopes: [], count: 1 })?.count).toBe(1);
  });

  it('offers nothing for other refusals', () => {
    const tracker = new NoticeTracker(null, undefined);
    expect(tracker.refusal({ n: 1, reason: 'scope', scopes: ['body'] })?.action).toBeUndefined();
  });

  it('says in plain words that a cross-reference still points there, singular and plural', () => {
    const strings = new Strings().current;
    expect(strings.text('notice.refused.referenced', { count: 1 })).toBe(
      'That change was not made: a cross-reference still points to what you tried to delete.',
    );
    expect(strings.text('notice.refused.referenced', { count: 3 })).toBe(
      'That change was not made: 3 cross-references still point to what you tried to delete.',
    );
    expect(EN_GB['notice.action.showReferences']).toBe('Show references');
  });
});
