/**
 * FE-053 criterion 3, the telling half: a pasted picture whose upload failed, or that the asset
 * service did not accept, is explained in plain words, not with the general "change not made"
 * message. The engine records the reason (`upload-failed`, `invalid-size`); the shell turns that
 * refusal into a notice here. Node.js only.
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { NoticeTracker, refusalKey } from '../src/shell/notices.ts';

describe('a pasted picture that was not added (FE-053 criterion 3)', () => {
  it('maps each upload refusal to its own message, not to the general one', () => {
    expect(refusalKey('upload-failed')).toBe('notice.refused.uploadFailed');
    expect(refusalKey('invalid-size')).toBe('notice.refused.pictureSize');
  });

  it('reports a new upload failure once', () => {
    const tracker = new NoticeTracker(null, undefined);
    const notice = tracker.refusal({ n: 1, reason: 'upload-failed', scopes: [] });
    expect(notice).toMatchObject({
      kind: 'refusal',
      key: 'notice.refused.uploadFailed',
      count: 1,
    });
    expect(tracker.refusal({ n: 1, reason: 'upload-failed', scopes: [] })).toBeNull();
  });

  it('says the picture was not added, and names no file, asset or region', () => {
    for (const key of ['notice.refused.uploadFailed', 'notice.refused.pictureSize'] as const) {
      const text = EN_GB[key];
      expect(text).toMatch(/^The picture was not added/);
      expect(text).not.toMatch(/\{|region:|story:|asset:/);
    }
  });
});
