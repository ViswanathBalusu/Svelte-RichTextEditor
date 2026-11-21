/**
 * FE-046 criterion 2: the time of a suggestion is the server time of the commit that introduced it
 * (decision 109 of `docs/owner-decisions-2026-11-15.md`; HIS-042). The core asks the history port,
 * once for each suggestion, keeps a time and asks again after a failure; without a port it knows
 * no time and the card names the author alone.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';

async function attached(history?: {
  suggestionIntroduction(docId: string, id: string): Promise<{ time: string }>;
}) {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const backend = service.backend({ sub: 'grace' }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    ...(history ? { history } : {}),
  });
  return { core, docId, detach };
}

describe('the time of a suggestion (FE-046 criterion 2)', () => {
  it('asks the history port for the document and the suggestion, once, and keeps the time', async () => {
    const asked: string[] = [];
    const { core, docId, detach } = await attached({
      suggestionIntroduction: (doc, id) => {
        asked.push(`${doc}/${id}`);
        return Promise.resolve({ time: '2026-11-12T10:30:00Z' });
      },
    });
    expect(await core.suggestionTime('sgOne00000000001')).toBe('2026-11-12T10:30:00Z');
    expect(await core.suggestionTime('sgOne00000000001')).toBe('2026-11-12T10:30:00Z');
    expect(await core.suggestionTime('sgTwo00000000001')).toBe('2026-11-12T10:30:00Z');
    expect(asked).toEqual([`${docId}/sgOne00000000001`, `${docId}/sgTwo00000000001`]);
    detach();
  });

  it('gives no time without a port, and after a failed answer asks again', async () => {
    const none = await attached();
    expect(await none.core.suggestionTime('sgOne00000000001')).toBeNull();
    none.detach();

    let calls = 0;
    const { core, detach } = await attached({
      suggestionIntroduction: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error('forbidden'))
          : Promise.resolve({ time: '2026-11-12T10:30:00Z' });
      },
    });
    expect(await core.suggestionTime('sgOne00000000001')).toBeNull();
    // Let the failed answer clear its entry, then ask again.
    await Promise.resolve();
    await Promise.resolve();
    expect(await core.suggestionTime('sgOne00000000001')).toBe('2026-11-12T10:30:00Z');
    expect(calls).toBe(2);
    detach();
  });

  it('keeps the shell’s words for the card and counts each change', () => {
    const core = new DocumentCore({
      doc: { cdm: 1, requires: [], doc: contractDocument().doc },
      schedule: (run) => queueMicrotask(run),
    });
    expect(core.suggestionCardFormat).toBeNull();
    const format = (user: string, time: string | null) => `${user} ${time ?? ''}`;
    core.setSuggestionCard(format);
    expect(core.suggestionCardFormat).toBe(format);
    expect(core.suggestionCardChanged.get()).toBe(1);
    core.setSuggestionCard(null);
    expect(core.suggestionCardChanged.get()).toBe(2);
  });
});
