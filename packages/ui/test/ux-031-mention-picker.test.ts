/**
 * The mention picker's controller (UX-031 criteria 1, 2, 3 and 6). Controller level only: no
 * rendering, no combobox and no keyboard binding are tested here (criterion 5 stays open).
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { PrincipalInfo, PrincipalQuery, UserInfo } from '../src/core-api.ts';
import { createMentionPicker, mentionTrigger, CLOSED } from '../src/shell/mention-picker.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ANN: PrincipalInfo = { principal: 'user:ann', name: 'Ann Lee' };
const BEN: PrincipalInfo = { principal: 'user:ben', name: 'Ben Ord' };

describe('the mention trigger (UX-031 criterion 1)', () => {
  it('reads an @ at the start or after whitespace, followed by a name fragment', () => {
    expect(mentionTrigger('hi @an', 6)).toEqual({ start: 3, fragment: 'an' });
    expect(mentionTrigger('@an', 3)).toEqual({ start: 0, fragment: 'an' });
  });

  it('is not a trigger inside a word, with no fragment, or across whitespace', () => {
    expect(mentionTrigger('mail@example', 12)).toBeNull();
    expect(mentionTrigger('hi @', 4)).toBeNull();
    expect(mentionTrigger('a @b c', 6)).toBeNull();
    expect(mentionTrigger('@an', 9)).toBeNull();
  });
});

describe('typing a trigger searches, lists and inserts a mention (UX-031 criterion 1)', () => {
  it('calls searchPrincipals, lists the results and inserts a node with the principal only', async () => {
    const search = vi.fn(async (_q: PrincipalQuery) => [ANN, BEN]);
    const picker = createMentionPicker({ docId: 'doc-1', searchPrincipals: search });

    const shown = await picker.update('hi @an', 6);
    expect(shown).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      text: 'an',
      docId: 'doc-1',
      purpose: 'mention',
    });
    expect(picker.state()).toEqual({ open: true, results: [ANN, BEN], active: 0 });

    const chosen = picker.choose('hi @an', 6, 1);
    expect(chosen).not.toBeNull();
    expect(chosen?.parts).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', principal: 'user:ben' },
    ]);
    expect(chosen?.caret).toBe(3);
    expect(picker.state()).toEqual(CLOSED);
  });

  it('closes without a trigger and asks nothing', async () => {
    const search = vi.fn(async () => [ANN]);
    const picker = createMentionPicker({ docId: 'd', searchPrincipals: search });
    expect(await picker.update('plain text', 10)).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(picker.state()).toEqual(CLOSED);
  });
});

describe('stale results are ignored (UX-031 criterion 2)', () => {
  it('shows the newest query even when the older answer arrives last', async () => {
    const pending: Array<ReturnType<typeof deferred<PrincipalInfo[]>>> = [];
    const picker = createMentionPicker({
      docId: 'd',
      searchPrincipals: () => {
        const d = deferred<PrincipalInfo[]>();
        pending.push(d);
        return d.promise;
      },
    });
    const first = picker.update('@a', 2);
    const second = picker.update('@an', 3);
    pending[1]!.resolve([ANN]);
    expect(await second).toBe(true);
    pending[0]!.resolve([BEN]);
    expect(await first).toBe(false);
    expect(picker.state().results).toEqual([ANN]);
  });

  it('shows the results of the last query whatever order the answers arrive in (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
        async (count, keys) => {
          const pending: Array<ReturnType<typeof deferred<PrincipalInfo[]>>> = [];
          const picker = createMentionPicker({
            docId: 'd',
            searchPrincipals: () => {
              const d = deferred<PrincipalInfo[]>();
              pending.push(d);
              return d.promise;
            },
          });
          const updates: Array<Promise<boolean>> = [];
          for (let i = 0; i < count; i++) {
            updates.push(picker.update(`@${'n'.repeat(i + 1)}`, i + 2));
          }
          const order = Array.from({ length: count }, (_, i) => i).sort(
            (a, b) => (keys[a] ?? 0) - (keys[b] ?? 0) || a - b,
          );
          for (const i of order) {
            pending[i]!.resolve([{ principal: `user:q${i}`, name: `Q${i}` }]);
          }
          const outcomes = await Promise.all(updates);
          expect(outcomes[count - 1]).toBe(true);
          expect(outcomes.slice(0, count - 1).every((o) => o === false)).toBe(true);
          expect(picker.state().results).toEqual([
            { principal: `user:q${count - 1}`, name: `Q${count - 1}` },
          ]);
        },
      ),
    );
  });
});

describe('a mention shows a name from resolveUsers and stores only the principal (UX-031 criterion 3)', () => {
  it('resolves the name of a user through resolveUsers and keeps the node to its identifier', async () => {
    const resolveUsers = vi.fn(async (ids: readonly string[]): Promise<Array<UserInfo | null>> =>
      ids.map((id) => (id === 'ann' ? { id: 'ann', name: 'Ann Lee' } : null)),
    );
    const picker = createMentionPicker({
      docId: 'd',
      searchPrincipals: async () => [],
      resolveUsers,
    });
    expect(await picker.displayName('user:ann')).toBe('Ann Lee');
    expect(resolveUsers).toHaveBeenCalledWith(['ann']);
    expect(await picker.displayName('user:nobody')).toBeNull();
  });

  it('a group name comes from the search results, since groups have no resolveUsers', async () => {
    const picker = createMentionPicker({
      docId: 'd',
      searchPrincipals: async () => [{ principal: 'group:editors', name: 'Editors' }],
    });
    await picker.update('@ed', 3);
    expect(await picker.displayName('group:editors')).toBe('Editors');
  });
});

describe('without searchPrincipals mentions are not offered (UX-031 criterion 6)', () => {
  it('does not offer mentions, asks nothing and leaves plain text alone', async () => {
    const picker = createMentionPicker({ docId: 'd' });
    expect(picker.offered).toBe(false);
    expect(await picker.update('hello @an', 9)).toBe(false);
    expect(picker.state()).toEqual(CLOSED);
    expect(picker.choose('hello @an', 9, 0)).toBeNull();
  });
});

describe('the keyboard moves the active result', () => {
  it('wraps at both ends and closes on request', async () => {
    const picker = createMentionPicker({ docId: 'd', searchPrincipals: async () => [ANN, BEN] });
    await picker.update('@', 1);
    await picker.update('@a', 2);
    expect(picker.state().active).toBe(0);
    picker.move(-1);
    expect(picker.state().active).toBe(1);
    picker.move(1);
    expect(picker.state().active).toBe(0);
    picker.close();
    expect(picker.state()).toEqual(CLOSED);
  });
});
