/**
 * FE-044 criterion 5, the shell side: a block command the core refuses in suggestion mode (here
 * `markRegion`, behind the `insert.region` entry) is unavailable and its reason is shown as text.
 * The core's refusal (`reason: 'suggestion'`) is tested in `packages/engine/test/fe-044-block-unavailable.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  immediateScheduler,
  type CommandRegistry,
} from '../src/commands/index.ts';
import type { AccessObject, Capability } from '../src/core-api.ts';
import { builtinCommands } from '../src/commands/builtin.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { FakeCore } from './support/fake-core.ts';

const COMMAND = 'insert.region';
const DOCUMENT_CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'structure',
  'manage',
];

function setup(): { core: FakeCore; registry: CommandRegistry } {
  const core = new FakeCore({ extended: true });
  core.selection.set({ empty: false, scope: 'body', region: null, style: 'Normal', marks: [] });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  for (const entry of builtinCommands()) {
    if (entry.id === COMMAND && registry.backs(entry)) registry.register(entry);
  }
  return { core, registry };
}

function document(caps: readonly Capability[]): AccessObject {
  return { rev: 1, docRole: 'editor', caps, scopes: { body: ['view', 'edit'] } };
}

describe('FE-044 criterion 5: a block command refused in suggestion mode shows its reason', () => {
  it('disables the command with the suggestion reason and names it in the shell words', () => {
    const { core, registry } = setup();
    core.permissions?.set(document(DOCUMENT_CAPS));
    Object.assign(core, {
      query: (name: string) => (name === 'canMarkRegion' ? false : undefined),
      queryReason: (name: string) => (name === 'canMarkRegion' ? 'suggestion' : null),
    });
    expect(registry.state(COMMAND)).toMatchObject({
      offered: true,
      enabled: false,
      reasonKey: 'reason.query.suggestion',
    });
    expect(EN_GB['reason.query.suggestion']).toMatch(/suggestion/i);
    expect(EN_GB['reason.query.suggestion']).not.toBe(EN_GB['reason.notApplicable']);
  });

  it('does not run the command, and the document is not changed by the attempt', () => {
    const { core, registry } = setup();
    core.permissions?.set(document(DOCUMENT_CAPS));
    Object.assign(core, {
      query: (name: string) => (name === 'canMarkRegion' ? false : undefined),
      queryReason: (name: string) => (name === 'canMarkRegion' ? 'suggestion' : null),
    });
    expect(registry.exec(COMMAND)).toMatchObject({ ran: false, reason: 'not-applicable' });
    expect(core.callsOf('runNamed').filter((c) => c.args[0] === 'markRegion')).toEqual([]);
  });
});
