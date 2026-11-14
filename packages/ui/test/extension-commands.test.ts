/**
 * Extension commands, toolbar groups, context-menu items and shortcuts (UX-051; 13 §7.1). An
 * extension contributes through the same registry as the built-in commands, so these tests register
 * entries the way an extension will (the manifest path is UX-050, not built). Ticked here:
 * the contributed group and items appear in both toolbar layouts and on their declared targets
 * (criterion 2), a colliding shortcut is refused and names its holder (criterion 3), and a
 * duplicate identifier is rejected (criterion 4). Not claimed: criterion 1 (command search is not
 * built; exec is tested here) and criterion 5 (an extension's own string table is not built: the
 * label check takes the table passed in, which the test sets).
 */
import { describe, expect, it } from 'vitest';
import {
  CommandRegistrationError,
  canonicalKey,
  createCommandRegistry,
  immediateScheduler,
  type CommandEntry,
} from '../src/commands/index.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { contextMenuGroups, toolbarCommands, toolbarGroups } from '../src/shell/toolbar-groups.ts';
import { EDIT, FakeCore } from './support/fake-core.ts';

/** A string key the test's extension table holds; the built-in table does not know it. */
const EXT_KEY = 'ext.sample.label';

function registryWith() {
  const core = new FakeCore({ access: EDIT, features: [] });
  return createCommandRegistry(core, {
    scheduler: immediateScheduler(),
    hasString: (key) => key === EXT_KEY || Object.hasOwn(EN_GB, key),
  });
}

function sample(over: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: 'ext.sample.insertTag',
    label: EXT_KEY,
    group: 'ext-sample',
    capability: 'ext.sample',
    changesContent: true,
    contextMenu: ['table'],
    run: () => true,
    ...over,
  };
}

describe('an extension command is read from the same registry (UX-051, criterion 1, part)', () => {
  it('is found by identifier, shown as offered and enabled, and runs through exec', () => {
    const registry = registryWith();
    const removed = registry.register(sample());
    expect(registry.get('ext.sample.insertTag')?.label).toBe(EXT_KEY);
    expect(registry.state('ext.sample.insertTag')).toMatchObject({ offered: true, enabled: true });
    expect(registry.exec('ext.sample.insertTag')).toEqual({ ran: true, reason: null });
    removed();
    expect(registry.exec('ext.sample.insertTag')).toEqual({ ran: false, reason: 'unknown' });
  });
});

describe('a contributed group and context-menu items appear where they are declared (UX-051, criterion 2)', () => {
  it('shows the group in the compact row and in the full layout, from the entry itself', () => {
    const registry = registryWith();
    registry.register(sample());
    const commands = registry.view.get().commands;
    expect(toolbarCommands(commands, []).map((c) => c.id)).toContain('ext.sample.insertTag');
    const full = toolbarGroups(commands);
    expect(full.map((g) => g.name)).toContain('ext-sample');
    expect(full.find((g) => g.name === 'ext-sample')?.commands.map((c) => c.id)).toEqual([
      'ext.sample.insertTag',
    ]);
  });

  it('offers the context-menu item on its declared targets only', () => {
    const registry = registryWith();
    registry.register(sample({ contextMenu: ['table'] }));
    const commands = registry.view.get().commands;
    const onTable = contextMenuGroups(commands, ['table']).flatMap((g) =>
      g.commands.map((c) => c.id),
    );
    const onText = contextMenuGroups(commands, ['text']).flatMap((g) =>
      g.commands.map((c) => c.id),
    );
    // Built-in table commands are listed too; the check is on the contributed item alone.
    expect(onTable).toContain('ext.sample.insertTag');
    expect(onText).not.toContain('ext.sample.insertTag');
  });

  it('a toolbar:false contribution stays off the compact toolbar', () => {
    const registry = registryWith();
    registry.register(sample({ toolbar: false }));
    const commands = registry.view.get().commands;
    expect(toolbarCommands(commands, []).map((c) => c.id)).not.toContain('ext.sample.insertTag');
  });

  it('a contribution removed at run time leaves the layouts without a reload', () => {
    const registry = registryWith();
    const removed = registry.register(sample());
    removed();
    const commands = registry.view.get().commands;
    expect(toolbarGroups(commands).map((g) => g.name)).not.toContain('ext-sample');
  });
});

describe('a colliding shortcut is refused and names its holder (UX-051, criterion 3)', () => {
  it('refuses a key a built-in command binds, names it, and changes nothing', () => {
    const registry = registryWith();
    expect(registry.get('format.bold')?.keys).toContain('Mod-b');
    let refusal: unknown;
    try {
      registry.register(sample({ keys: ['Mod-b'] }));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CommandRegistrationError);
    expect((refusal as Error).message).toContain('format.bold');
    expect(registry.get('ext.sample.insertTag')).toBeUndefined();
    expect(registry.commandForKey(canonicalKey('Mod-b', registry.apple) ?? '')).toBe('format.bold');
  });

  it('refuses a key another extension already holds and keeps the first binding', () => {
    const registry = registryWith();
    registry.register(sample({ id: 'ext.first.tag', keys: ['Mod-Alt-j'] }));
    expect(() => registry.register(sample({ id: 'ext.second.tag', keys: ['Mod-Alt-j'] }))).toThrow(
      /ext\.first\.tag/,
    );
    const key = canonicalKey('Mod-Alt-j', registry.apple) ?? '';
    expect(registry.commandForKey(key)).toBe('ext.first.tag');
    expect(registry.get('ext.second.tag')).toBeUndefined();
  });
});

describe('a duplicate identifier is rejected (UX-051, criterion 4)', () => {
  it('refuses an extension command whose identifier is already registered and keeps the first', () => {
    const registry = registryWith();
    registry.register(sample());
    expect(() => registry.register(sample({ run: () => false, group: 'other' }))).toThrow(
      CommandRegistrationError,
    );
    expect(registry.get('ext.sample.insertTag')?.group).toBe('ext-sample');
  });

  it('refuses an extension command that reuses a built-in identifier', () => {
    const registry = registryWith();
    expect(() => registry.register(sample({ id: 'format.bold' }))).toThrow(/already registered/);
    expect(registry.get('format.bold')?.group).toBe('format');
  });

  it('refuses an identifier that is an alias of a registered command', () => {
    const registry = registryWith();
    expect(() =>
      registry.register(sample({ id: 'ext.sample.other', aliases: ['format.bold'] })),
    ).toThrow(CommandRegistrationError);
  });
});
