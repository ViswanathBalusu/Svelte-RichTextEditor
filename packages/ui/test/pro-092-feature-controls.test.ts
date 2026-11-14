/**
 * PRO-092 criterion 4 (lane U-PRO-086-102, round 3): when the backend lacks an optional port, the
 * user interface answers "not available" for the feature that port carries, and the control is not
 * offered. The built-in commands carry the feature names of the optional ports (`comments`,
 * `history`, `sign`, ...), and the header, mode switcher and status bar show only commands that
 * are `offered`. A positive control gives the same commands their feature, so the negative answer
 * is not the result of a broken table.
 */
import { describe, expect, it } from 'vitest';
import {
  builtinCommands,
  createCommandRegistry,
  immediateScheduler,
  SHELL_QUERY_NAMES,
  ShellQueries,
} from '../src/commands/index.ts';
import { FakeCore } from './support/fake-core.ts';

const ALL_OPTIONAL_FEATURES = [
  'presence',
  'history',
  'comments',
  'assets',
  'exports',
  'imports',
  'fonts',
  'leases',
  'fields',
  'workflow',
  'proofing',
  'assistant',
  'sign',
  'rules',
];

function gatedCommands() {
  return builtinCommands().filter((c) => c.feature !== undefined);
}

/** A registry with the built-in commands that carry a feature, registered as the shell does. */
function setup(features: readonly string[]) {
  const core = new FakeCore({ features, extended: true });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  // The shell answers its own queries (App.svelte: ShellQueries), `shell.commentAllowed` among them.
  registry.addSource(new ShellQueries(SHELL_QUERY_NAMES));
  // The field-insert commands come from a source. The others are registered when the registry does
  // not hold them, without their queries: the shell's own query sources are not in this fake, and
  // the feature gate is checked before any query.
  for (const entry of gatedCommands()) {
    if (registry.state(entry.id).reason !== 'unknown') continue;
    const { enabled: _enabled, active: _active, ...withoutQueries } = entry;
    registry.register(withoutQueries);
  }
  return { core, registry };
}

describe('PRO-092 criterion 4: a backend without an optional port offers no control for it', () => {
  it('has built-in commands gated by the features of the optional ports', () => {
    const ids = gatedCommands().map((c) => c.id);
    expect(ids).toContain('view.comments');
    expect(ids).toContain('view.catchUp');
  });

  it('answers "not available" for every gated command when no feature is announced', () => {
    const { registry } = setup([]);
    for (const entry of gatedCommands()) {
      const state = registry.state(entry.id);
      expect(state, entry.id).toMatchObject({
        offered: false,
        enabled: false,
        reason: 'unannounced',
      });
      expect(registry.exec(entry.id).ran, entry.id).toBe(false);
    }
  });

  it('answers "not available" for the comments and history controls of a backend with only presence', () => {
    // The in-memory mock announces `regions`, `suggest-enforced` and `presence`, and no other
    // optional feature (packages/backend-mock/src/service.ts). Its header must show neither.
    const { registry } = setup(['regions', 'suggest-enforced', 'presence']);
    expect(registry.state('view.comments')).toMatchObject({
      offered: false,
      reason: 'unannounced',
    });
    expect(registry.state('view.catchUp')).toMatchObject({
      offered: false,
      reason: 'unannounced',
    });
  });

  it('offers the same controls once their feature is announced (positive control)', () => {
    const { registry } = setup(ALL_OPTIONAL_FEATURES);
    for (const entry of gatedCommands()) {
      expect(registry.state(entry.id)?.reason, entry.id).not.toBe('unannounced');
    }
  });

  it('brings a control back when the feature is announced later, without a reload', () => {
    const { core, registry } = setup([]);
    expect(registry.state('view.comments')).toMatchObject({ reason: 'unannounced' });
    core.features!.set(['comments']);
    expect(registry.state('view.comments')?.reason).not.toBe('unannounced');
  });
});
