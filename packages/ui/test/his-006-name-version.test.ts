/**
 * The command to name a version (HIS-006 criterion 6): `history.nameVersion` of `commands/builtin.ts`
 * is in the command registry, is gated by the `history` feature, opens the dialog for a name and a
 * note, and writes no content (so a locked document keeps it). The dialog's own behaviour, its
 * refusal and the list that shows the new version are checked in a browser run
 * (`e2e/his-006-name-version.spec.ts`). The strings are external (definition of done).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCommandRegistry, immediateScheduler } from '../src/commands/index.ts';
import { shellCommands1b, type ShellCommandHost1b } from '../src/commands/builtin.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { FakeCore } from './support/fake-core.ts';

const ID = 'history.nameVersion';

function setup(features: readonly string[]) {
  const opened: string[] = [];
  const host = {
    openDialog: (name: string) => {
      opened.push(name);
      return true;
    },
  } as unknown as ShellCommandHost1b;
  const core = new FakeCore({ extended: true, features });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  const entry = shellCommands1b(host)[ID]!;
  if (registry.backs(entry)) registry.register(entry);
  return { registry, opened, entry };
}

describe('the command to name a version (HIS-006 criterion 6)', () => {
  it('is an entry of the registry with a label, the history feature and the version-history row', () => {
    const { entry } = setup(['history']);
    expect(entry).toMatchObject({
      id: ID,
      feature: 'history',
      capability: 'version-history',
      changesContent: false,
    });
    expect(EN_GB[entry.label as keyof typeof EN_GB]).toBe('Name this version');
  });

  it('opens the dialog for a name and a note when the history feature is announced', () => {
    const { registry, opened } = setup(['history']);
    expect(registry.exec(ID)).toEqual({ ran: true, reason: null });
    expect(opened).toEqual(['version']);
  });

  it('does not run without the history feature', () => {
    const { registry, opened } = setup([]);
    expect(registry.exec(ID).ran).toBe(false);
    expect(opened).toEqual([]);
  });

  it('is registered by the shell only with a port that can name versions', () => {
    const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
    expect(app).toMatch(/core\.history\?\.createVersion\) add\(host1b\['history\.nameVersion'\]\)/);
  });

  it('has every string of the dialog in the source strings', () => {
    for (const key of [
      'dialog.version.title',
      'dialog.version.name',
      'dialog.version.note',
      'dialog.version.empty',
      'dialog.version.save',
      'dialog.version.forbidden',
      'dialog.version.failed',
      'announce.version.named',
    ])
      expect(EN_GB, key).toHaveProperty([key]);
  });
});
