/**
 * The ribbon layout's tabs and groups (`toolbar="ribbon"`, ADR 0490; 13 §3). They are the logic of
 * `shell/ribbon-groups.ts`: each shown command in exactly one group of one tab, none dropped, the
 * tabs in their order, a contextual group as a tab of its own after them and only while the
 * selection is in its object, and a group the registry does not know still reachable. The tablist
 * and the roving focus are the component's and are in `e2e/ribbon.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createCommandRegistry,
  immediateScheduler,
  type CommandEntry,
  type CommandView,
} from '../src/commands/index.ts';
import { RIBBON_TABS, ribbonTabs } from '../src/shell/ribbon-groups.ts';
import { toolbarCommands } from '../src/shell/toolbar-groups.ts';
import { BUILT_IN_ICONS, parseIcon } from '../src/icons/icons.ts';
import { RIBBON_ICONS, ribbonIconName } from '../src/icons/ribbon-icons.ts';
import { toolbarMode } from '../src/shell/settings.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const CONTEXTS = ['table', 'picture', 'story', 'field'] as const;

function viewFor(core: FakeCore, extra: readonly CommandEntry[] = []): readonly CommandView[] {
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  for (const entry of extra) registry.register(entry);
  return registry.view.get().commands;
}

function entry(id: string, group: string, icon?: string): CommandEntry {
  return {
    id,
    label: 'command.format.bold',
    group,
    ...(icon ? { icon } : {}),
    changesContent: false,
    capability: 'editing',
    run: () => true,
  };
}

describe('the toolbar attribute takes ribbon (ADR 0490)', () => {
  it('reads ribbon, and still reads anything unknown as compact', () => {
    expect(toolbarMode('ribbon')).toBe('ribbon');
    expect(toolbarMode('compact')).toBe('compact');
    expect(toolbarMode('full')).toBe('full');
    expect(toolbarMode('none')).toBe('none');
    expect(toolbarMode('Ribbon')).toBe('compact');
    expect(toolbarMode(null)).toBe('compact');
  });
});

describe('every shown command is in one group of one tab, and none is lost', () => {
  it('places each command once (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(EDIT, VIEW),
        fc.uniqueArray(fc.constantFrom(...CONTEXTS), { maxLength: 4 }),
        (access, contexts) => {
          const shown = toolbarCommands(viewFor(new FakeCore({ access })), contexts);
          const placed = ribbonTabs(shown).flatMap((t) =>
            t.groups.flatMap((g) => g.commands.map((c) => c.id)),
          );
          expect([...placed].sort()).toEqual(shown.map((c) => c.id).sort());
          expect(new Set(placed).size).toBe(placed.length);
        },
      ),
    );
  });

  it('keeps a command of a group the registry does not know, in a tab named for that group', () => {
    const shown = toolbarCommands(
      viewFor(new FakeCore({ access: EDIT }), [entry('ext.x', 'tools')]),
      [],
    );
    const tab = ribbonTabs(shown).find((t) => t.id === 'tools');
    expect(tab?.ownGroup).toBe(true);
    expect(tab?.contextual).toBe(false);
    expect(tab?.groups.flatMap((g) => g.commands.map((c) => c.id))).toEqual(['ext.x']);
  });
});

describe('the tabs and their order', () => {
  it('lists the task tabs in order, and only those with commands', () => {
    const shown = toolbarCommands(viewFor(new FakeCore({ access: EDIT })), []);
    const ids = ribbonTabs(shown)
      .filter((t) => !t.ownGroup)
      .map((t) => t.id);
    const ranks = ids.map((id) => (RIBBON_TABS as readonly string[]).indexOf(id));
    expect(ranks.every((r) => r >= 0)).toBe(true);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ids[0]).toBe('home');
  });

  it('puts the editing and formatting commands on Home, and a field on Insert', () => {
    const shown = toolbarCommands(viewFor(new FakeCore({ access: EDIT })), []);
    const tabs = ribbonTabs(shown);
    const home = tabs.find((t) => t.id === 'home')!;
    const ids = home.groups.flatMap((g) => g.commands.map((c) => c.id));
    expect(ids).toContain('edit.undo');
    expect(ids).toContain('format.bold');
    const font = home.groups.find((g) => g.key === 'font')!;
    expect(font.commands.map((c) => c.id)).toContain('format.italic');
    const insert = tabs.find((t) => t.id === 'insert');
    if (insert)
      for (const c of insert.groups.flatMap((g) => g.commands)) expect(c.id).not.toMatch(/^edit\./);
  });

  it('moves footnotes, captions and citations to References', () => {
    const shown = toolbarCommands(viewFor(new FakeCore({ access: EDIT })), []);
    const references = ribbonTabs(shown).find((t) => t.id === 'references');
    const ids = references?.groups.flatMap((g) => g.commands.map((c) => c.id)) ?? [];
    for (const id of ids)
      expect(id).toMatch(/^(insert\.(footnote|caption|crossReference|citation)|view\.sources)$/);
  });

  it('shows a contextual group as a tab of its own, after the task tabs, and only for its context', () => {
    const extra = CONTEXTS.map((c) => entry(`${c}.sample`, c));
    const none = ribbonTabs(toolbarCommands(viewFor(new FakeCore({ access: EDIT }), extra), []));
    expect(none.filter((t) => t.contextual)).toEqual([]);
    const withTable = ribbonTabs(
      toolbarCommands(viewFor(new FakeCore({ access: EDIT }), extra), ['table']),
    );
    const contextual = withTable.filter((t) => t.contextual);
    expect(contextual.map((t) => t.id)).toEqual(['table']);
    expect(withTable.indexOf(contextual[0]!)).toBe(withTable.length - 1);
  });
});

describe('the icons of the ribbon', () => {
  it('uses the icon a command names, else one for the built-in commands that name none', () => {
    const commands = viewFor(new FakeCore({ access: EDIT }), [entry('ext.icon', 'format', 'bold')]);
    expect(ribbonIconName(commands.find((c) => c.id === 'ext.icon')!)).toBe('bold');
  });

  it('draws every ribbon icon as valid path data that does not repeat a built-in name', () => {
    for (const [name, drawing] of Object.entries(RIBBON_ICONS)) {
      expect(parseIcon(drawing), name).not.toBeNull();
      expect(Object.hasOwn(BUILT_IN_ICONS, name), name).toBe(false);
      expect(new Set(drawing.paths).size, `${name} repeats a path`).toBe(drawing.paths.length);
    }
  });

  it('gives every toolbar command of the built-in set a drawing', () => {
    const shown = toolbarCommands(viewFor(new FakeCore({ access: EDIT })), []);
    for (const c of shown) {
      const name = ribbonIconName(c);
      const drawn = name !== undefined && (name in BUILT_IN_ICONS || name in RIBBON_ICONS);
      expect(drawn, `${c.id} has no icon in the ribbon (${name})`).toBe(true);
    }
  });
});
