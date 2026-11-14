/**
 * A host-built toolbar on the registry (UX-005; 13 §4; 05 §8.1): `queryCommand` reports the state
 * the built-in toolbar shows, `exec` passes the same guards as typing, a refused or unknown command
 * changes nothing and says so, and a state change is published with the identifiers that changed.
 * The toolbar and `exec` read the same registry instance (Toolbar.svelte, registry.test.ts).
 * `toolbar="none"` in a browser and the glue's example toolbar are not tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  bindCommandStateEvent,
  createCommandRegistry,
  immediateScheduler,
} from '../src/commands/index.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

function bold(core: FakeCore) {
  core.selection.set({ ...core.selection.get(), empty: false, marks: ['bold'] });
}

describe('queryCommand reports what the built-in toolbar shows (UX-005, criterion 2)', () => {
  it('reports a bold selection as active and enabled, as the toolbar snapshot does', () => {
    const core = new FakeCore({ extended: true, access: EDIT, mode: 'edit' });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    bold(core);
    const hostState = registry.state('format.bold');
    const toolbarItem = registry.view.get().commands.find((c) => c.id === 'format.bold');
    expect(hostState).toMatchObject({ enabled: true, active: true, offered: true });
    expect(toolbarItem).toMatchObject({ enabled: hostState.enabled, active: hostState.active });
  });
});

describe('exec passes the same guards as typing (UX-005, criterion 3)', () => {
  it('runs an enabled command through the core, as the toolbar does', () => {
    const core = new FakeCore({ extended: true, access: EDIT, mode: 'edit' });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('format.bold')).toEqual({ ran: true, reason: null });
    expect(core.callsOf('run').map((c) => c.args[0])).toEqual(['bold']);
  });

  it('refuses a content command in view mode, with the mode as the reason, and changes nothing', () => {
    const core = new FakeCore({
      extended: true,
      access: EDIT,
      mode: 'view',
      modes: ['edit', 'view'],
    });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('format.bold')).toEqual({ ran: false, reason: 'mode' });
    expect(core.callsOf('run')).toHaveLength(0);
  });

  it('refuses a content command without edit rights, with the access as the reason', () => {
    const core = new FakeCore({ extended: true, access: VIEW, mode: 'edit' });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('format.bold')).toEqual({ ran: false, reason: 'no-access' });
    expect(core.callsOf('run')).toHaveLength(0);
  });
});

describe('a refused or unknown command runs nothing and says so (UX-005, criterion 4)', () => {
  it('reports an unknown identifier as not run', () => {
    const core = new FakeCore({ extended: true, access: EDIT, mode: 'edit' });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('format.nothingLikeThis')).toEqual({ ran: false, reason: 'unknown' });
    expect(core.calls).toHaveLength(0);
  });

  it('reports a command the query says is not enabled as not run', () => {
    const core = new FakeCore({ extended: true, access: EDIT, mode: 'edit' });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.state('edit.undo').enabled).toBe(false);
    expect(registry.exec('edit.undo')).toEqual({ ran: false, reason: 'not-applicable' });
    expect(core.callsOf('run')).toHaveLength(0);
  });
});

describe('de-command-state lists the commands whose state changed (UX-005, criterion 5)', () => {
  it('publishes the identifiers of the changed commands, and no content', () => {
    const core = new FakeCore({ extended: true, access: EDIT, mode: 'edit' });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    void registry.view.get();
    const target = new EventTarget();
    const details: unknown[] = [];
    target.addEventListener('de-command-state', (e) => details.push((e as CustomEvent).detail));
    const stop = bindCommandStateEvent(registry, target);
    bold(core);
    stop();
    expect(details).toHaveLength(1);
    const detail = details[0] as { commands: string[] };
    expect(detail.commands).toContain('format.bold');
    expect(Object.keys(detail)).toEqual(['commands']);
  });
});
