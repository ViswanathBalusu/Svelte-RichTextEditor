// FE-107 criterion 6: the announcement text comes from the shell's catalogue (UX-064), in the
// current locale and with the host's replacement strings, not from a table of the element's own.
import type { ResolveUsers } from '@docedit/protocol';
import { Strings } from '@docedit/ui/strings';
import { describe, expect, it } from 'vitest';
import { ANNOUNCE_EN, ANNOUNCE_KEYS, Announcer, type AnnounceTranslate } from '../src/announcer.ts';
import { manualFrames } from './support.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An announcer fed by `strings`, as the element feeds it from the mounted shell. */
function fed(strings: Strings, resolveUsers: ResolveUsers | null = null) {
  const frames = manualFrames();
  const sent: string[] = [];
  const translate: AnnounceTranslate = (key, params) =>
    strings.current.has(key) ? strings.current.text(key, params) : null;
  const announcer = new Announcer({
    sink: (text) => sent.push(text),
    schedule: frames.schedule,
    resolveUsers,
    initialSync: 'saved',
    translate,
  });
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 50 && (frames.pending() > 0 || announcer.pending > 0); i++) {
      await tick();
      frames.flush();
    }
  };
  return { announcer, sent, drain };
}

describe('announcement text and the catalogue (FE-107 criterion 6)', () => {
  it('has every sentence in the catalogue, with the source text the fallback table has', () => {
    const strings = new Strings();
    for (const [field, key] of Object.entries(ANNOUNCE_KEYS)) {
      expect(strings.has(key), `${key} is missing from the catalogue`).toBe(true);
      // The placeholders stay in the text: no parameters are given.
      expect(strings.current.text(key)).toBe(ANNOUNCE_EN[field as keyof typeof ANNOUNCE_EN]);
    }
  });

  it('says each kind of notice in the words of the catalogue', async () => {
    const strings = new Strings();
    const { announcer, sent, drain } = fed(strings, async (ids) =>
      ids.map((id) => ({ id, name: 'Grace' })),
    );
    announcer.notify({ kind: 'sync', sync: 'saving' });
    announcer.notify({ kind: 'sync', sync: 'readonly' });
    announcer.notify({ kind: 'rejected', where: 'the body', reason: 'Read-only.' });
    announcer.notify({ kind: 'recovered', count: 3 });
    announcer.notify({ kind: 'presence', change: 'left', userId: 'u1' });
    await drain();
    expect(sent).toEqual([
      'Saving changes.',
      'This document is read-only.',
      'An edit was not applied at the body. Read-only.',
      'Edits set aside for recovery: 3.',
      'Grace left the document.',
    ]);
  });

  it('follows a host replacement string, also for a sentence made after the change', async () => {
    const strings = new Strings();
    const { announcer, sent, drain } = fed(strings);
    announcer.notify({ kind: 'sync', sync: 'saving' });
    await drain();
    strings.setOverrides({ 'announce.sync.saved': 'Everything is stored.' });
    announcer.notify({ kind: 'sync', sync: 'saved' });
    await drain();
    expect(sent).toEqual(['Saving changes.', 'Everything is stored.']);
  });

  it('follows the locale: a pseudo-locale changes every sentence', async () => {
    const strings = new Strings();
    await strings.setLocale('en-XA');
    const { announcer, sent, drain } = fed(strings, null);
    announcer.notify({ kind: 'sync', sync: 'unsaved' });
    announcer.notify({ kind: 'presence', change: 'arrived', userId: 'u1' });
    await drain();
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(ANNOUNCE_EN.unsaved);
    expect(sent[1]).not.toBe(ANNOUNCE_EN.arrived);
    // The placeholder is still filled in the accented text.
    expect(sent[1]).not.toContain('{name}');
    expect(sent[1]).toContain(strings.current.text('announce.presence.unknown'));
  });

  it('falls back to the source table where the catalogue has no such key', async () => {
    const frames = manualFrames();
    const sent: string[] = [];
    const announcer = new Announcer({
      sink: (text) => sent.push(text),
      schedule: frames.schedule,
      resolveUsers: null,
      initialSync: 'saved',
      translate: () => null,
    });
    announcer.notify({ kind: 'sync', sync: 'unsaved' });
    await tick();
    frames.flush();
    expect(sent).toEqual([ANNOUNCE_EN.unsaved]);
  });
});
