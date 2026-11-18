/**
 * A mention of someone who cannot see the content is refused with a message (owner decision 35,
 * docs/owner-decisions-2026-11-15.md): the service's working code `mention_hidden` maps to its own
 * refusal, which the comment box shows with the text kept.
 */
import { describe, expect, it } from 'vitest';
import { serverRefusal } from '../src/shell/comment-create.ts';

describe('serverRefusal for a hidden mention', () => {
  it('maps mention_hidden to mentionHidden and leaves the other codes as they were', () => {
    expect(serverRefusal('mention_hidden')).toBe('mentionHidden');
    expect(serverRefusal('permission_denied')).toBe('permissionsChanged');
    expect(serverRefusal('stale_base')).toBe('baseSeqOutOfWindow');
    expect(serverRefusal('quota_exceeded')).toBe('threadLimit');
    expect(serverRefusal('anything else')).toBe('failed');
  });
});
