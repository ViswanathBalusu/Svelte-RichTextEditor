/**
 * FND-008: a group of the source string table that loads on demand is not in the catalogue until
 * the code that shows it has loaded; a translator made earlier sees it as soon as it has (the table
 * is live), and a host's replacement for one of its keys is not reported as unknown meanwhile. This
 * file does not import the whole table (`en-GB.ts`), so the groups are only what it loads itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { Strings } from '../src/i18n/strings.ts';
import { isSourceKey } from '../src/i18n/source.ts';

describe('a group of the source table loaded on demand (FND-008)', () => {
  it('is added to the catalogue when its module is evaluated, and a translator made before sees it', async () => {
    const strings = new Strings();
    const before = strings.current;
    expect(before.t('toolbar.label')).toBe('Editing');
    // Before: a key of the group is unknown and shows itself, as an unknown key does.
    expect(strings.has('history.unavailable')).toBe(false);
    expect(before.text('history.unavailable')).toBe('history.unavailable');

    const { EN_GB_HISTORY_PANE } = await import('../src/i18n/late/historyPane.ts');
    const text = EN_GB_HISTORY_PANE['history.unavailable'];
    expect(typeof text).toBe('string');
    expect(strings.has('history.unavailable')).toBe(true);
    expect(before.text('history.unavailable')).toBe(text);
    expect(strings.current.text('history.unavailable')).toBe(text);
  });

  it('takes a host replacement for a key of a group that has not loaded, without reporting it', () => {
    const onUnknown = vi.fn();
    const strings = new Strings({
      overrides: { 'comment.mention.added': 'Notes', 'nothing.like.it': 'x' },
      onUnknown,
    });
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith(['nothing.like.it']);
    // The replacement is used once the key is looked up, whether or not the group has loaded.
    expect(strings.current.text('comment.mention.added')).toBe('Notes');
  });

  it('knows a key of a group by its first part before the group has loaded', () => {
    expect(isSourceKey('toolbar.label')).toBe(true);
    expect(isSourceKey('rule.anything')).toBe(true);
    expect(isSourceKey('zzz.anything')).toBe(false);
  });
});
