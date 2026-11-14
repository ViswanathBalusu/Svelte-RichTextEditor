/**
 * The shortcut reference rows (UX-013 criterion 6). The reference is generated from the registry's
 * offered commands with keys and from the shell's rows of the shortcut table, and from nothing
 * written by hand. The pane renders these rows (`panes/ShortcutsPane.svelte`); the rendering is not
 * run here, only the rows the pane is given.
 */
import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  immediateScheduler,
  type CommandEntry,
  type CommandRegistry,
} from '../src/commands/index.ts';
import type { StringKey } from '../src/i18n/en-GB.ts';
import { SHORTCUT_TABLE, boundKeys } from '../src/shortcuts/table.ts';
import { shortcutReferenceRows, type ReferenceStrings } from '../src/shortcuts/reference.ts';
import { EDIT, FakeCore } from './support/fake-core.ts';

/** Strings that show which key each text came from, so that a literal cannot pass as a label. */
const strings: ReferenceStrings = {
  text: (key: string) => `text:${key}`,
  t: (key: StringKey) => `t:${key}`,
};

const EXTENSION_ID = 'ext.reference-check';

function registryWith(): CommandRegistry {
  return createCommandRegistry(new FakeCore({ access: EDIT, extended: true }), {
    scheduler: immediateScheduler(),
  });
}

function extensionEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: EXTENSION_ID,
    label: 'command.format.bold',
    group: 'format',
    keys: ['Mod-Alt-7'],
    changesContent: false,
    capability: 'editing',
    run: () => true,
    ...overrides,
  };
}

describe('the shortcut reference is generated from the registry and the table (UX-013, criterion 6)', () => {
  it('lists each offered command that has keys, with its label from the string tables', () => {
    const registry = registryWith();
    const rows = shortcutReferenceRows(registry.view.get().commands, strings);
    const undo = rows.find((r) => r.id === 'edit.undo');
    expect(undo).toBeDefined();
    expect(undo?.label).toMatch(/^text:command\./);
    expect(undo?.keys).toEqual(boundKeys('edit.undo', ['Mod-z']));
    expect(undo?.when).toBe('t:shortcuts.always');
  });

  it('lists a command registered after start-up with its keys, and drops it when it is removed', () => {
    const registry = registryWith();
    registry.register(extensionEntry());
    const added = shortcutReferenceRows(registry.view.get().commands, strings).find(
      (r) => r.id === EXTENSION_ID,
    );
    expect(added?.keys).toEqual(['Mod-Alt-7']);
    expect(added?.label).toBe('text:command.format.bold');

    registry.unregister(EXTENSION_ID);
    const after = shortcutReferenceRows(registry.view.get().commands, strings);
    expect(after.some((r) => r.id === EXTENSION_ID)).toBe(false);
  });

  it('leaves out a command that has no keys', () => {
    const registry = registryWith();
    // A command with no keys: the entry is built without the `keys` property at all.
    const { keys: _keys, ...withoutKeys } = extensionEntry({ id: 'ext.no-keys' });
    registry.register(withoutKeys);
    const rows = shortcutReferenceRows(registry.view.get().commands, strings);
    expect(rows.some((r) => r.id === 'ext.no-keys')).toBe(false);
  });

  it('shows the shell rows of the table with their keys, alternatives and conditions', () => {
    const rows = shortcutReferenceRows(registryWith().view.get().commands, strings);
    for (const row of SHORTCUT_TABLE.filter((r) => r.kind === 'shell')) {
      const shown = rows.find((r) => r.id === row.id);
      expect(shown, row.id).toBeDefined();
      expect(shown?.keys).toEqual([...row.keys, ...row.alternative]);
      expect(shown?.when).toBe(row.when ? `t:${row.when}` : 't:shortcuts.always');
    }
  });

  it('shows the alternative the table binds next to the command keys', () => {
    const rows = shortcutReferenceRows(registryWith().view.get().commands, strings);
    const withAlternative = SHORTCUT_TABLE.filter(
      (r) => r.kind === 'command' && r.alternative.length > 0,
    );
    expect(withAlternative.length).toBeGreaterThan(0);
    for (const row of withAlternative) {
      // The keys the reference uses for a command: its keys and the table's alternative.
      expect(boundKeys(row.id, row.keys)).toEqual(expect.arrayContaining([...row.alternative]));
      // When the command is offered in the fake build, the reference shows the alternative.
      const shown = rows.find((r) => r.id === row.id);
      if (shown !== undefined)
        expect(shown.keys).toEqual(expect.arrayContaining([...row.alternative]));
    }
  });
});
