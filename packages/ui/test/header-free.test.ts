/**
 * With the header hidden, the editor is still fully usable (UX-014 criterion 1): the mode, the
 * panes and the share request are reached through the command registry and `exec`, and nothing
 * the registry needs comes from the header component. The shell's commands are registered here the
 * way App.svelte registers them; the hidden header is not drawn, so only the registry is involved.
 */
import { describe, expect, it } from 'vitest';
import {
  SHELL_QUERY_NAMES,
  ShellQueries,
  createCommandRegistry,
  immediateScheduler,
  shellCommands,
  shellCommands1b,
  type ShellCommandHost,
  type ShellCommandHost1b,
} from '../src/commands/index.ts';
import { EDIT, FakeCore } from './support/fake-core.ts';

function hostsWithCalls() {
  const calls: string[] = [];
  const ok = (name: string) => () => {
    calls.push(name);
    return true;
  };
  const host1a: ShellCommandHost = {
    toggleOutline: ok('toggleOutline'),
    openPane: (name) => {
      calls.push(`openPane:${name}`);
      return true;
    },
    requestShare: ok('requestShare'),
  };
  const host1b: ShellCommandHost1b = {
    togglePane: (id) => {
      calls.push(`togglePane:${id}`);
      return true;
    },
    find: ok('find'),
    painter: ok('painter'),
    applyFormat: ok('applyFormat'),
    openDialog: (name) => {
      calls.push(`openDialog:${name}`);
      return true;
    },
    zoom: (step) => {
      calls.push(`zoom:${step}`);
      return true;
    },
    setMode: (mode) => {
      calls.push(`setMode:${mode}`);
      return true;
    },
    setView: (view) => {
      calls.push(`setView:${view}`);
      return true;
    },
    closeStory: ok('closeStory'),
    commandSearch: ok('commandSearch'),
  };
  return { calls, host1a, host1b };
}

function registryWithShell() {
  const core = new FakeCore({ access: EDIT });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  // The shell answers its own queries (App.svelte: ShellQueries), with the modes the build offers.
  const shellQueries = new ShellQueries(SHELL_QUERY_NAMES);
  for (const mode of ['edit', 'review', 'view', 'fill'])
    shellQueries.set(`shell.modeAvailable.${mode}`, true);
  registry.addSource(shellQueries);
  const { calls, host1a, host1b } = hostsWithCalls();
  // As App.svelte does: an entry the core does not back is not registered.
  for (const entry of [
    ...Object.values(shellCommands(host1a)),
    ...Object.values(shellCommands1b(host1b)),
  ])
    if (registry.backs(entry)) registry.register(entry);
  return { registry, calls };
}

describe('the header hidden: the mode, the panes and share work through commands and exec (UX-014, criterion 1)', () => {
  it('runs the share request through exec', () => {
    const { registry, calls } = registryWithShell();
    expect(registry.exec('document.share')).toEqual({ ran: true, reason: null });
    expect(calls).toContain('requestShare');
  });

  it('opens and toggles a pane through exec, and says whether it ran', () => {
    const { registry, calls } = registryWithShell();
    expect(registry.exec('view.outline')).toEqual({ ran: true, reason: null });
    expect(registry.exec('view.permissions')).toEqual({ ran: true, reason: null });
    expect(calls).toEqual(expect.arrayContaining(['toggleOutline', 'togglePane:permissions']));
  });

  it('switches the mode through exec and reports the switch to the core host', () => {
    const { registry, calls } = registryWithShell();
    expect(registry.exec('mode.review')).toEqual({ ran: true, reason: null });
    expect(calls).toContain('setMode:review');
  });

  it('offers the header commands on the registry alone, so nothing needs the header to be drawn', () => {
    const { registry } = registryWithShell();
    for (const id of ['document.share', 'view.outline', 'mode.view']) {
      expect(registry.state(id)).toMatchObject({ offered: true });
    }
  });
});
