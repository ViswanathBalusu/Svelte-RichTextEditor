/**
 * The share command (UX-039, criterion 3) and the format painter in a scope the user may not change
 * (UX-009, criterion 3). The commands run through the same registry as every surface, so the access
 * rule of UX-004 is the one under test. Dispatching `de-share-request`, the host's dialog and the
 * focus handling are the element's and the component's, and are not tested here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCommandRegistry,
  immediateScheduler,
  shellCommands,
  shellCommands1b,
  type CommandEntry,
  type CommandRegistry,
} from '../src/commands/index.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

/** Registers the painter entry as App.svelte does: only when the core backs it (ADR 0052). */
function withPainter(registry: CommandRegistry, core: FakeCore): CommandEntry {
  const none = () => false;
  const entry = shellCommands1b({
    togglePane: none,
    find: none,
    painter: none,
    // As App.svelte gives it: the core applies the copied formatting.
    applyFormat: () => core.runNamed('pasteFormat'),
    openDialog: none,
    zoom: none,
    setMode: none,
    setView: none,
    closeStory: none,
    commandSearch: none,
  })['format.applyFormat']!;
  expect(registry.backs(entry)).toBe(true);
  registry.register(entry);
  return entry;
}

function hostSpies() {
  return {
    toggleOutline: vi.fn((): boolean => true),
    openPane: vi.fn((): boolean => true),
    requestShare: vi.fn((): boolean => true),
  };
}

describe('the share button opens the host dialog and nothing else (UX-039, criterion 3)', () => {
  it('asks the host to share and opens no pane, so region grants and participants stay in the permissions pane', () => {
    const host = hostSpies();
    const { share } = shellCommands(host);
    expect(share.run({ core: new FakeCore(), args: undefined })).toBe(true);
    expect(host.requestShare).toHaveBeenCalledTimes(1);
    expect(host.openPane).not.toHaveBeenCalled();
    expect(host.toggleOutline).not.toHaveBeenCalled();
  });

  it('is enabled for a viewer, since sharing changes no content', () => {
    const core = new FakeCore({ access: VIEW });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    registry.register(shellCommands(hostSpies()).share);
    expect(registry.state('document.share')).toMatchObject({ offered: true, enabled: true });
    expect(registry.exec('document.share')).toEqual({ ran: true, reason: null });
  });

  it('has a label that is a string of the source table', () => {
    const label = shellCommands(hostSpies()).share.label;
    expect(EN_GB[label as keyof typeof EN_GB]).toBeTruthy();
  });
});

describe('the format painter in a scope the user may not change (UX-009, criterion 3)', () => {
  it('refuses to apply the copied formatting, changes nothing and gives the reason', () => {
    const core = new FakeCore({ extended: true, access: VIEW });
    core.copiedFormat = ['bold'];
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    withPainter(registry, core);

    const before = core.selection.get();
    const state = registry.state('format.applyFormat');
    expect(state).toMatchObject({
      offered: true,
      enabled: false,
      reason: 'no-access',
      reasonKey: 'reason.access.view',
    });
    expect(EN_GB[state.reasonKey as keyof typeof EN_GB]).toBeTruthy();

    expect(registry.exec('format.applyFormat')).toEqual({ ran: false, reason: 'no-access' });
    expect(core.calls.filter((c) => c.method === 'runNamed')).toEqual([]);
    expect(core.selection.get()).toEqual(before);
  });

  it('applies the copied formatting in a scope the user may change', () => {
    const core = new FakeCore({ extended: true, access: EDIT });
    core.copiedFormat = ['bold'];
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    withPainter(registry, core);
    expect(registry.state('format.applyFormat')).toMatchObject({ enabled: true, reason: null });
    expect(registry.exec('format.applyFormat')).toEqual({ ran: true, reason: null });
    expect(core.calls.filter((c) => c.method === 'runNamed').map((c) => c.args[0])).toEqual([
      'pasteFormat',
    ]);
  });
});
