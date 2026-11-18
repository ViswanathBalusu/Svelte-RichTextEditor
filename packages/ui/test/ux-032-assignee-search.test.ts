/**
 * The assignee search (UX-032 criterion 1) and the rule that the editor lists no tasks across
 * documents (criterion 4). The search asks the host's `searchPrincipals` for people, keeps the
 * results of the newest query only, offers `user:` principals and nothing else, and is not offered
 * without a `searchPrincipals`. No command of the shell lists tasks: the host builds that from the
 * `dep.task.assigned` webhook.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { builtinCommands } from '../src/commands/builtin.ts';
import type { PrincipalInfo, PrincipalQuery } from '../src/core-api.ts';
import { createAssigneeSearch } from '../src/shell/assignee-search.ts';

const ADA: PrincipalInfo = { principal: 'user:u1', name: 'Ada Lovelace' };
const GRACE: PrincipalInfo = { principal: 'user:u2', name: 'Grace Hopper' };
const LEGAL: PrincipalInfo = { principal: 'group:legal', name: 'Legal team' };

describe('createAssigneeSearch', () => {
  it('asks for people with the purpose participant, shows them, and chooses one', async () => {
    const seen: PrincipalQuery[] = [];
    const search = createAssigneeSearch({
      docId: 'd1',
      searchPrincipals: async (q) => {
        seen.push(q);
        return [ADA, LEGAL, GRACE];
      },
    });
    expect(search.offered).toBe(true);
    expect(await search.update('  a ')).toBe(true);
    expect(seen).toEqual([{ text: 'a', docId: 'd1', purpose: 'participant', kinds: ['user'] }]);
    // A group the host returned anyway is not offered: a task goes to a person.
    expect(search.state().results).toEqual([ADA, GRACE]);
    expect(search.state().active).toBe(0);
    search.move(1);
    expect(search.state().active).toBe(1);
    search.move(1);
    expect(search.state().active).toBe(0);
    expect(search.choose()).toEqual(ADA);
    expect(search.state().open).toBe(false);
  });

  it('is not offered without searchPrincipals, and an empty text closes the list', async () => {
    const none = createAssigneeSearch({ docId: 'd1' });
    expect(none.offered).toBe(false);
    expect(await none.update('x')).toBe(false);
    expect(none.choose()).toBeNull();
    const search = createAssigneeSearch({ docId: 'd1', searchPrincipals: async () => [ADA] });
    expect(await search.update('a')).toBe(true);
    expect(await search.update('   ')).toBe(false);
    expect(search.state().open).toBe(false);
  });

  it('a failing host shows an empty list, not an error', async () => {
    const search = createAssigneeSearch({
      docId: 'd1',
      searchPrincipals: async () => {
        throw new Error('directory unavailable');
      },
    });
    expect(await search.update('a')).toBe(true);
    expect(search.state()).toEqual({ open: true, results: [], active: null });
  });

  it('shows the results of the newest query whatever order the answers come in (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
        async (order) => {
          const releases: Array<() => void> = [];
          const search = createAssigneeSearch({
            docId: 'd1',
            searchPrincipals: (q) =>
              new Promise((resolve) => {
                const n = Number(q.text);
                releases[n] = () => resolve([{ principal: `user:q${n}`, name: `Query ${n}` }]);
              }),
          });
          const asked = [0, 1, 2].map((n) => search.update(String(n)));
          for (const n of order) releases[n]?.();
          await Promise.all(asked);
          // The last query, 2, wins; the others were stale.
          expect(search.state().results).toEqual([{ principal: 'user:q2', name: 'Query 2' }]);
        },
      ),
    );
  });
});

describe('the editor lists no tasks across documents (UX-032 criterion 4)', () => {
  it('has no command that lists or opens tasks', () => {
    const ids = builtinCommands().map((c) => c.id);
    expect(ids.length).toBeGreaterThan(50);
    expect(ids.filter((id) => /task/i.test(id))).toEqual([]);
  });
});
