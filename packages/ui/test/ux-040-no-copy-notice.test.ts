/**
 * UX-040 criterion 2, the telling half (lane U-UX-031-045, round 11): a copy, cut or drag refused
 * by `no-copy` is explained in plain words, not with the general "change not made" message. The
 * engine refuses the copy (FE-055, core `copySelection`) and records the reason `no-copy`; the shell
 * turns that refusal into a notice here. Node.js only; the browser run is not in this file.
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { Strings } from '../src/i18n/strings.ts';
import { NoticeTracker, refusalKey } from '../src/shell/notices.ts';

describe('a copy refused by no-copy (UX-040 criterion 2)', () => {
  it('maps the no-copy refusal to its own message, not to the general one', () => {
    expect(refusalKey('no-copy')).toBe('notice.refused.noCopy');
    expect(refusalKey('no-copy')).not.toBe('notice.refused.other');
  });

  it('reports a new no-copy refusal once, with its plain words', () => {
    const tracker = new NoticeTracker(null, undefined);
    const notice = tracker.refusal({ n: 1, reason: 'no-copy', scopes: [] });
    expect(notice).toMatchObject({ kind: 'refusal', key: 'notice.refused.noCopy', count: 1 });
    expect(tracker.refusal({ n: 1, reason: 'no-copy', scopes: [] })).toBeNull();
    const text = new Strings().current.text('notice.refused.noCopy', {});
    expect(text).toMatch(/^Nothing was copied: your access does not allow copying/);
    expect(text).toMatch(/not a security boundary/);
  });

  it('says in its text that restrictions are not a security boundary, and names no content', () => {
    const text = EN_GB['notice.refused.noCopy'];
    expect(text).toMatch(/deter casual copying/);
    expect(text).not.toMatch(/\{/);
    expect(text).not.toMatch(/region:|story:|field:/);
  });
});
