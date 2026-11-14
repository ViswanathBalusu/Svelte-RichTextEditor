/**
 * Marking a region as the user has it (PRM-033 criteria 2, 3 and 4): the `insert.region` command
 * of `commands/builtin.ts`, evaluated by the registry with `markRegionSource` of `commands/queries.ts`.
 * Each test reads the registry's state and runs `exec`, the path the toolbar and command search use.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createCommandRegistry,
  immediateScheduler,
  regionMarkBlock,
  type CommandRegistry,
} from '../src/commands/index.ts';
import type { AccessObject, Capability } from '../src/core-api.ts';
import { builtinCommands } from '../src/commands/builtin.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { EDIT, FakeCore } from './support/fake-core.ts';

const COMMAND = 'insert.region';
const DOCUMENT_CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'structure',
  'manage',
];

/** A body selection of whole blocks, outside any region: the case the core answers for. */
function setup(): { core: FakeCore; registry: CommandRegistry } {
  const core = new FakeCore({ extended: true });
  core.selection.set({ empty: false, scope: 'body', region: null, style: 'Normal', marks: [] });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  // `insert.region` is a shell command of the host's surfaces (`builtinCommands`), not a core one.
  for (const entry of builtinCommands()) {
    if (entry.id === COMMAND && registry.backs(entry)) registry.register(entry);
  }
  return { core, registry };
}

function document(caps: readonly Capability[]): AccessObject {
  return { rev: 1, docRole: 'editor', caps, scopes: { body: ['view', 'edit'] } };
}

function markedTitles(core: FakeCore): unknown[] {
  return core
    .callsOf('runNamed')
    .filter((c) => c.args[0] === 'markRegion')
    .map((c) => (c.args[1] as { title: string }).title);
}

describe('marking a region on whole blocks (PRM-033, criterion 2)', () => {
  it('is enabled for a user with `structure` and `edit` on whole blocks of the body', () => {
    const { core, registry } = setup();
    core.permissions?.set(document(DOCUMENT_CAPS));
    expect(registry.state(COMMAND)).toMatchObject({
      offered: true,
      enabled: true,
      reasonKey: null,
    });
    expect(markedTitles(core)).toEqual([]);
  });

  it('says why the selection cannot become a region when it lies inside one', () => {
    const { core, registry } = setup();
    core.permissions?.set(document(DOCUMENT_CAPS));
    Object.assign(core, {
      query: (name: string) => (name === 'canMarkRegion' ? false : undefined),
      queryReason: (name: string) => (name === 'canMarkRegion' ? 'nested' : null),
    });
    expect(registry.state(COMMAND)).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.nested',
    });
    expect(EN_GB['reason.query.nested']).toBeDefined();
  });
});

describe('the document limit is explained (PRM-033, criterion 3)', () => {
  it('states the limit in the shell words when the core calls its reason `limit`', () => {
    const { core, registry } = setup();
    core.permissions?.set(document(DOCUMENT_CAPS));
    Object.assign(core, {
      query: (name: string) => (name === 'canMarkRegion' ? false : undefined),
      queryReason: (name: string) => (name === 'canMarkRegion' ? 'limit' : null),
    });
    expect(registry.state(COMMAND)).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.regionLimit',
    });
    expect(registry.exec(COMMAND)).toMatchObject({ ran: false });
    expect(EN_GB['reason.query.regionLimit']).toBeDefined();
  });
});

describe('without `structure` (PRM-033, criterion 4)', () => {
  it('disables the command with the structure reason, and never asks the core to mark', () => {
    const { core, registry } = setup();
    core.permissions?.set(document(['view', 'comment', 'suggest', 'edit', 'manage']));
    expect(registry.state(COMMAND)).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.structure',
    });
    expect(registry.exec(COMMAND).ran).toBe(false);
    expect(core.callsOf('runNamed').filter((c) => c.args[0] === 'markRegion')).toEqual([]);
  });

  it('enables the command exactly when `structure` and `edit` both hold (property)', () => {
    const { core, registry } = setup();
    fc.assert(
      fc.property(fc.subarray(DOCUMENT_CAPS as Capability[]), (caps) => {
        core.permissions?.set(document(caps));
        core.access?.set({
          scope: 'body',
          caps: caps.filter((c) => c !== 'structure' && c !== 'manage'),
          limit: null,
        });
        const state = registry.state(COMMAND);
        expect(state.enabled).toBe(caps.includes('structure') && caps.includes('edit'));
        if (!state.enabled) expect(EN_GB[state.reasonKey as keyof typeof EN_GB]).toBeDefined();
      }),
    );
  });

  it('refuses in a header, footer or footnote whatever the document grants', () => {
    const core = new FakeCore({ extended: true });
    core.selection.set({ empty: false, scope: 'body', region: null, style: 'Normal', marks: [] });
    core.permissions?.set(document(DOCUMENT_CAPS));
    core.access?.set({ ...EDIT, scope: 'story:header' });
    expect(regionMarkBlock(core)).toBe('subeditor');
  });
});
