/**
 * Shortcut alternatives (UX-013 criterion 2; UX-023 criterion 3). Where a browser reserves a key,
 * the shortcut table names the alternative, and the registry binds that alternative as well, on
 * every platform the table covers. The table is checked by `buildShortcutTable`, which reports
 * every problem, and the binding is checked through the registry's own key lookup.
 */
import { describe, expect, it } from 'vitest';
import {
  builtinCommands,
  createCommandRegistry,
  immediateScheduler,
} from '../src/commands/index.ts';
import { canonicalKey } from '../src/commands/keys.ts';
import { buildShortcutTable } from '../src/shortcuts/build.ts';
import { SHORTCUT_TABLE, type ShortcutRow } from '../src/shortcuts/table.ts';
import { FakeCore } from './support/fake-core.ts';

const commands = builtinCommands().map((c) => ({ id: c.id, keys: c.keys ?? [] }));

/**
 * The keys that stand in for a key a browser reserves: the row's alternative, or another of the
 * row's own keys (the same rule as `build.ts`).
 */
function alternativesFor(row: ShortcutRow, reserved: string): string[] {
  return [...row.alternative, ...row.keys.filter((k) => k !== reserved)];
}

describe('the shortcut table (UX-013, criterion 2)', () => {
  it('builds without a problem from the built-in commands', () => {
    expect(buildShortcutTable(commands).problems).toEqual([]);
  });

  it('resolves each browser conflict with a key the shell binds', () => {
    let resolved = 0;
    for (const row of SHORTCUT_TABLE)
      for (const conflict of row.conflicts) {
        if (conflict.resolution !== 'alternative') continue;
        resolved++;
        expect(alternativesFor(row, conflict.key), row.id).not.toEqual([]);
      }
    expect(resolved).toBeGreaterThan(0);
  });

  for (const apple of [false, true]) {
    const platform = apple ? 'Apple platforms' : 'Windows and Linux';

    it(`binds the alternative to the same command on ${platform}`, () => {
      // The core's commands, as the element registers them; shell commands need the shell's host.
      const registry = createCommandRegistry(new FakeCore({ extended: true }), {
        apple,
        scheduler: immediateScheduler(),
        reservedKeys: [],
      });
      const bound = new Set(registry.list().map((e) => e.id));
      let checked = 0;

      for (const row of SHORTCUT_TABLE) {
        if (row.kind !== 'command' || !bound.has(row.id)) continue;
        for (const conflict of row.conflicts) {
          if (conflict.resolution !== 'alternative') continue;
          for (const key of alternativesFor(row, conflict.key)) {
            const canonical = canonicalKey(key, apple);
            expect(canonical, `${row.id}: ${key}`).not.toBeNull();
            expect(registry.commandForKey(canonical!), `${row.id}: ${key}`).toBe(row.id);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});
