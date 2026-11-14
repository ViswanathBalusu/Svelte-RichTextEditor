/**
 * The full toolbar's groups and the compact row (UX-007 criteria 1, 2 and 3; 13 §3). The groups are
 * the logic of `shell/toolbar-groups.ts`: each command in exactly one group, the group its entry
 * names; the groups in task order and the contextual ones last; a contextual group only while the
 * selection is in its object; and one entry, shown the same way in both layouts. Focus, the tabs
 * pattern and the toolbar attribute are the component's and are not tested here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createCommandRegistry,
  immediateScheduler,
  type CommandEntry,
  type CommandView,
} from '../src/commands/index.ts';
import { GROUP_ORDER } from '../src/commands/builtin.ts';
import { isContextual, toolbarCommands, toolbarGroups } from '../src/shell/toolbar-groups.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const CONTEXTS = ['table', 'picture', 'story', 'field'] as const;

function viewFor(core: FakeCore): readonly CommandView[] {
  return createCommandRegistry(core, { scheduler: immediateScheduler() }).view.get().commands;
}

/** A rank for a group name: task groups first, then the contextual ones, then anything else. */
function groupRank(name: string): number {
  const task = (GROUP_ORDER as readonly string[]).indexOf(name);
  if (task >= 0) return task;
  return isContextual(name) ? GROUP_ORDER.length : GROUP_ORDER.length + 1;
}

describe('every command is in exactly one group, the one its entry names (UX-007, criterion 1)', () => {
  it('puts each shown command in one group only, under the group its entry names (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(EDIT, VIEW),
        fc.uniqueArray(fc.constantFrom(...CONTEXTS), { maxLength: 4 }),
        fc.constantFrom<readonly string[]>([], ['comments']),
        (access, contexts, features) => {
          const commands = viewFor(new FakeCore({ access, features: [...features] }));
          const shown = toolbarCommands(commands, contexts);
          const groups = toolbarGroups(shown);
          const placed = groups.flatMap((g) => g.commands.map((c) => c.id));
          expect([...placed].sort()).toEqual(shown.map((c) => c.id).sort());
          expect(new Set(placed).size).toBe(placed.length);
          for (const g of groups) for (const c of g.commands) expect(c.entry.group).toBe(g.name);
        },
      ),
    );
  });

  it('lists the groups in task order, with the contextual groups after them (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(EDIT, VIEW),
        fc.uniqueArray(fc.constantFrom(...CONTEXTS), { maxLength: 4 }),
        (access, contexts) => {
          const groups = toolbarGroups(
            toolbarCommands(viewFor(new FakeCore({ access })), contexts),
          );
          const ranks = groups.map((g) => groupRank(g.name));
          expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        },
      ),
    );
  });
});

describe('a contextual group is shown only in its object (UX-007, criterion 2, the logic)', () => {
  it('offers a contextual group only for a context the selection is in (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...CONTEXTS), { maxLength: 4 }), (contexts) => {
        const groups = toolbarGroups(
          toolbarCommands(viewFor(new FakeCore({ access: EDIT })), contexts),
        );
        for (const g of groups) if (g.contextual) expect(contexts).toContain(g.name);
      }),
    );
  });

  it('shows no contextual group when the selection is in none of them', () => {
    const groups = toolbarGroups(toolbarCommands(viewFor(new FakeCore({ access: EDIT })), []));
    expect(groups.filter((g) => g.contextual)).toEqual([]);
  });
});

describe('one entry, the same in the compact row and the full layout (UX-007, criterion 3)', () => {
  it('shows every command of the compact row in the full layout, as the same entry (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(EDIT, VIEW),
        fc.uniqueArray(fc.constantFrom(...CONTEXTS), { maxLength: 4 }),
        (access, contexts) => {
          const commands = viewFor(new FakeCore({ access }));
          const compact = toolbarCommands(commands, contexts);
          const full = toolbarGroups(compact).flatMap((g) => g.commands);
          expect(full).toHaveLength(compact.length);
          for (const c of full) expect(compact).toContain(c);
        },
      ),
    );
  });

  it('shows a command registered at run time in both layouts, from the entry that was registered', () => {
    const core = new FakeCore({ access: EDIT });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    const entry: CommandEntry = {
      id: 'ext.sample',
      label: 'command.format.bold',
      group: 'format',
      changesContent: false,
      capability: 'editing',
      run: () => true,
    };
    registry.register(entry);
    const commands = registry.view.get().commands;
    const compact = toolbarCommands(commands, []);
    const full = toolbarGroups(compact).flatMap((g) => g.commands);
    const inCompact = compact.find((c) => c.id === 'ext.sample');
    const inFull = full.find((c) => c.id === 'ext.sample');
    expect(inCompact?.entry).toBe(entry);
    expect(inFull?.entry).toBe(entry);
    expect(toolbarGroups(compact).find((g) => g.name === 'format')?.commands).toContain(inFull);
  });
});
