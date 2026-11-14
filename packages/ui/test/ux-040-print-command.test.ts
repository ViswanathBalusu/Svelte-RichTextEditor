/**
 * UX-040 criterion 3, the print command (lane V-UX-031-045, round 17): under `no-print` the
 * `document.print` command is disabled with the reason `reason.query.no-print`, `exec` refuses it
 * without calling the host, and removing the restriction enables it again. The shell's wiring is
 * mirrored here the way App.svelte does it (the `shell.printAllowed` query from `commandDecision`,
 * and the entry registered only when the host can print). Node.js only; the browser run is not
 * in this file.
 */
import { describe, expect, it } from 'vitest';
import {
  SHELL_QUERY_NAMES,
  ShellQueries,
  createCommandRegistry,
  immediateScheduler,
  shellCommands1b,
  type ShellCommandHost1b,
} from '../src/commands/index.ts';
import { commandDecision } from '../src/commands/output-restrictions.ts';
import { FakeCore } from './support/fake-core.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';

const EDITOR_ACCESS = {
  rev: 2,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
  restrictions: [] as string[],
} as const;

function hostWithPrint(calls: string[], withPrint: boolean): ShellCommandHost1b {
  const ok = (name: string) => () => {
    calls.push(name);
    return true;
  };
  const host: ShellCommandHost1b = {
    togglePane: ok('togglePane'),
    find: ok('find'),
    painter: ok('painter'),
    applyFormat: ok('applyFormat'),
    openDialog: ok('openDialog'),
    zoom: ok('zoom'),
    setMode: ok('setMode'),
    setView: ok('setView'),
    closeStory: ok('closeStory'),
    commandSearch: ok('commandSearch'),
  };
  if (withPrint) host.print = ok('print');
  return host;
}

/** The registry the shell builds, with the print command registered only when the host has one. */
function shellRegistry(restrictions: readonly string[], withPrint: boolean) {
  const calls: string[] = [];
  const core = new FakeCore({
    extended: true,
    features: ['exports'],
    permissions: { ...EDITOR_ACCESS, restrictions: [...restrictions] } as never,
  });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  const shellQueries = new ShellQueries(SHELL_QUERY_NAMES);
  const setPrint = (list: readonly string[]) => {
    const decision = commandDecision('document.print', list);
    shellQueries.set(
      'shell.printAllowed',
      decision.allowed,
      decision.allowed ? null : decision.reason,
    );
  };
  setPrint(restrictions);
  registry.addSource(shellQueries);
  const entries = shellCommands1b(hostWithPrint(calls, withPrint));
  if (withPrint && registry.backs(entries['document.print']!))
    registry.register(entries['document.print']!);
  return { registry, calls, shellQueries, setPrint };
}

describe('the print command under no-print (UX-040 criterion 3)', () => {
  it('is disabled with its reason, and exec refuses it without calling the host', () => {
    const { registry, calls } = shellRegistry(['no-print'], true);
    const state = registry.state('document.print');
    expect(state.enabled).toBe(false);
    expect(state.reasonKey).toBe('reason.query.no-print');
    expect(registry.exec('document.print')).toMatchObject({ ran: false });
    expect(calls).not.toContain('print');
  });

  it('is enabled and runs the host print when the restriction is absent', () => {
    const { registry, calls } = shellRegistry([], true);
    expect(registry.state('document.print').enabled).toBe(true);
    expect(registry.exec('document.print')).toEqual({ ran: true, reason: null });
    expect(calls).toContain('print');
  });

  it('enables the command again when the restriction is removed, without rebuilding the registry', () => {
    const { registry, shellQueries, setPrint } = shellRegistry(['no-print'], true);
    expect(registry.state('document.print').enabled).toBe(false);
    setPrint([]);
    expect(registry.state('document.print').enabled).toBe(true);
    shellQueries.set('shell.printAllowed', true, null);
    expect(registry.state('document.print').enabled).toBe(true);
  });

  it('is not offered when the host gives no print, so nothing is refused or run', () => {
    const { registry, calls } = shellRegistry([], false);
    expect(registry.get('document.print')).toBeUndefined();
    expect(registry.exec('document.print').ran).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is not refused by no-export, which is a different restriction', () => {
    expect(commandDecision('document.print', ['no-export'])).toEqual({ allowed: true });
  });

  it('has its label and its reason in the string catalogue', () => {
    expect(EN_GB['command.document.print']).toBe('Print');
    expect(EN_GB['reason.query.no-print']).toMatch(/does not allow printing/);
  });
});
