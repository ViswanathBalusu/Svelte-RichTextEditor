/**
 * One registry entry, read by every logic surface from the same registry instance (UX-003,
 * criterion 1). The surfaces tested here are the functions the shell calls: the toolbar commands and
 * groups (`shell/toolbar-groups.ts`), the context menu, the mini toolbar, command search, access keys
 * and `exec()`. Rendering of the full toolbar and the mini toolbar is not run here, so criterion 1
 * stays open in the story; this file checks that the logic reads one entry and follows its removal
 * and its run-time registration.
 */
import { describe, expect, it } from 'vitest';
import {
  accessKeysAt,
  createCommandRegistry,
  immediateScheduler,
  pressAccessKey,
  searchCommands,
  type CommandEntry,
  type CommandRegistry,
} from '../src/commands/index.ts';
import { miniToolbarItems } from '../src/commands/mini-toolbar.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import { contextMenuGroups, toolbarCommands, toolbarGroups } from '../src/shell/toolbar-groups.ts';
import { EDIT, FakeCore } from './support/fake-core.ts';

const translate = sourceTranslator();
const ID = 'ext.surface-check';

function entry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: ID,
    label: 'command.format.bold',
    group: 'format',
    accessKey: 'q',
    contextMenu: ['text'],
    changesContent: false,
    capability: 'editing',
    run: () => true,
    ...overrides,
  };
}

function setup() {
  const core = new FakeCore({ extended: true, access: EDIT });
  const registry: CommandRegistry = createCommandRegistry(core, {
    scheduler: immediateScheduler(),
  });
  return { registry };
}

/** Every surface's answer for the identifier, read from the one registry instance. */
function surfacesSeeing(registry: CommandRegistry, id: string) {
  const commands = registry.view.get().commands;
  const toolbar = toolbarCommands(commands, []).some((c) => c.id === id);
  const group = toolbarGroups(toolbarCommands(commands, [])).find((g) =>
    g.commands.some((c) => c.id === id),
  );
  const contextMenu = contextMenuGroups(commands, ['text']).some((g) =>
    g.commands.some((c) => c.id === id),
  );
  const mini = miniToolbarItems(commands, false).some((c) => c.id === id);
  const search = searchCommands(registry, 'bold', { translate }).hits.some((h) => h.id === id);
  const access = accessKeysAt(registry, 'format').get('q')?.id === id;
  return { toolbar, groupName: group?.name ?? null, contextMenu, mini, search, access };
}

describe('one registered entry is read by every logic surface of one registry (UX-003, criterion 1)', () => {
  it('shows a registered entry on the toolbar, the context menu, the mini toolbar, search and access keys', () => {
    const { registry } = setup();
    // The mini toolbar offers formatting that changes the text (mini-toolbar.ts), so this entry does.
    registry.register(entry({ changesContent: true }));
    expect(surfacesSeeing(registry, ID)).toEqual({
      toolbar: true,
      groupName: 'format',
      contextMenu: true,
      mini: true,
      search: true,
      access: true,
    });
  });

  it('runs the same entry through exec, and the surfaces agree on the result', () => {
    const { registry } = setup();
    const calls: string[] = [];
    registry.register(
      entry({
        run: () => {
          calls.push(ID);
          return true;
        },
      }),
    );
    expect(registry.exec(ID)).toEqual({ ran: true, reason: null });
    expect(pressAccessKey(registry, 'format', 'q').id).toBe(ID);
    expect(calls).toEqual([ID, ID]);
  });

  it('removes the entry from every surface when it is unregistered, without a rebuild', () => {
    const { registry } = setup();
    registry.register(entry());
    expect(registry.unregister(ID)).toBe(true);
    expect(surfacesSeeing(registry, ID)).toEqual({
      toolbar: false,
      groupName: null,
      contextMenu: false,
      mini: false,
      search: false,
      access: false,
    });
    expect(registry.exec(ID).ran).toBe(false);
  });

  it('offers a content command on the mini toolbar with edit access, and nothing when the selection is empty', () => {
    const { registry } = setup();
    registry.register(entry({ changesContent: true }));
    const commands = registry.view.get().commands;
    expect(commands.find((c) => c.id === ID)?.offered).toBe(true);
    expect(miniToolbarItems(commands, false).some((c) => c.id === ID)).toBe(true);
    expect(miniToolbarItems(commands, true)).toEqual([]);
  });
});
