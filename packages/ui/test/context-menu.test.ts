/**
 * The context menu's commands (UX-008; 13 §4). The menu is generated from the registry: it lists the
 * offered commands whose entries name a target the menu opened on, lists a command the access does
 * not allow as disabled with its reason (UX-004), and shows the items an extension adds on its
 * declared targets (UX-051). The opening, the keys and the focus of the menu are the component's
 * and are not tested here; they were not run in a browser in this round.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createCommandRegistry,
  immediateScheduler,
  shellCommands,
  type CommandEntry,
  type ContextTarget,
} from '../src/commands/index.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { contextMenuGroups } from '../src/shell/toolbar-groups.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const TARGETS: readonly ContextTarget[] = ['text', 'table', 'picture', 'story', 'field', 'comment'];

/** The shell registers its own commands as App.svelte does; the comments entry is one of them. */
function menuFor(core: FakeCore, targets: readonly ContextTarget[]) {
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  const none = () => false;
  const comments = shellCommands({
    toggleOutline: none,
    openPane: none,
    requestShare: none,
  }).comments;
  if (registry.backs(comments)) registry.register(comments);
  const commands = registry.view.get().commands;
  return { registry, commands, groups: contextMenuGroups(commands, targets) };
}

describe('the menu lists the commands of the targets it opened on (UX-008, criterion 1, the logic)', () => {
  it('offers text commands on text and comment commands only on a comment', () => {
    const onText = menuFor(new FakeCore({ access: EDIT }), ['text']).groups.flatMap(
      (g) => g.commands,
    );
    expect(onText.map((c) => c.id)).toContain('format.bold');
    expect(onText.map((c) => c.id)).not.toContain('view.comments');

    const onComment = menuFor(new FakeCore({ access: EDIT, features: ['comments'] }), [
      'comment',
    ]).groups.flatMap((g) => g.commands);
    expect(onComment.map((c) => c.id)).toEqual(['view.comments']);
  });

  it('lists a comment command only where the comments feature is announced', () => {
    const quiet = menuFor(new FakeCore({ access: EDIT }), ['comment']).groups.flatMap(
      (g) => g.commands,
    );
    expect(quiet).toEqual([]);
  });

  it('lists exactly the offered commands that name one of the targets, and only those (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...TARGETS), { minLength: 1, maxLength: 6 }),
        fc.constantFrom(EDIT, VIEW),
        fc.constantFrom<readonly string[]>([], ['comments']),
        (targets, access, features) => {
          const { commands, groups } = menuFor(
            new FakeCore({ access, features: [...features] }),
            targets,
          );
          const expected = commands
            .filter((c) => c.offered && c.entry.contextMenu?.some((t) => targets.includes(t)))
            .map((c) => c.id)
            .sort();
          const listed = groups.flatMap((g) => g.commands);
          expect(listed.map((c) => c.id).sort()).toEqual(expected);
          for (const c of listed) {
            expect(c.entry.contextMenu?.some((t) => targets.includes(t))).toBe(true);
          }
        },
      ),
    );
  });
});

describe('a command the access does not allow is listed disabled, with its reason (UX-008, criterion 3; UX-004)', () => {
  it('lists bold on text as disabled with the reason for a viewer, and still offers it', () => {
    const { groups } = menuFor(new FakeCore({ access: VIEW }), ['text']);
    const bold = groups.flatMap((g) => g.commands).find((c) => c.id === 'format.bold');
    expect(bold).toBeDefined();
    expect(bold).toMatchObject({
      offered: true,
      enabled: false,
      reason: 'no-access',
      reasonKey: 'reason.access.view',
    });
    expect(EN_GB[bold!.reasonKey as keyof typeof EN_GB]).toBeTruthy();
  });

  it('gives every disabled item in the menu a reason key, for any access (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...TARGETS), { minLength: 1, maxLength: 6 }),
        fc.constantFrom(EDIT, VIEW),
        (targets, access) => {
          const { groups } = menuFor(new FakeCore({ access }), targets);
          for (const c of groups.flatMap((g) => g.commands)) {
            if (!c.enabled) expect(c.reasonKey).not.toBeNull();
          }
        },
      ),
    );
  });
});

describe('extensions add items on their declared targets (UX-008, criterion 4; UX-051)', () => {
  const sample: CommandEntry = {
    id: 'ext.table.sample',
    label: 'command.format.bold',
    group: 'format',
    changesContent: false,
    capability: 'editing',
    contextMenu: ['table'],
    run: () => true,
  };

  it('shows an extension item on its target and not on others, and drops it when removed', () => {
    const core = new FakeCore({ access: EDIT });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    const ids = (targets: readonly ContextTarget[]) =>
      contextMenuGroups(registry.view.get().commands, targets)
        .flatMap((g) => g.commands)
        .map((c) => c.id);

    expect(ids(['table'])).not.toContain('ext.table.sample');
    const remove = registry.register(sample);
    expect(ids(['table'])).toContain('ext.table.sample');
    expect(ids(['text'])).not.toContain('ext.table.sample');
    remove();
    expect(ids(['table'])).not.toContain('ext.table.sample');
  });
});
