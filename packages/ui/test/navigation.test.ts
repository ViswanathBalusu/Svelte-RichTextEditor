/**
 * The command that moves to the next region the user may edit (PRM-027 criteria 3 and 4). The
 * core answers `hasNextEditableRegion` and runs `nextEditableRegion`; here the core is the fake,
 * so these tests cover what the shell decides from the answer: that the command is offered as
 * disabled when no further region is editable, and that a permission change updates its state.
 * Where the caret ends up (criterion 2) is the core's, and is not claimed here.
 */
import { describe, expect, it } from 'vitest';
import { createCommandRegistry, immediateScheduler } from '../src/commands/index.ts';
import type { AccessObject, AccessSummary, RegionSummary } from '../src/core-api.ts';
import { FakeCore } from './support/fake-core.ts';

const COMMAND = 'navigate.nextEditableRegion';
const FULL = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

const REGIONS: RegionSummary[] = [
  { id: 'r1', title: 'Parties', policy: 'restricted', order: 0, state: 'draft' },
  { id: 'r2', title: 'Terms', policy: 'restricted', order: 1, state: 'draft' },
  { id: 'r3', title: 'Price', policy: 'restricted', order: 2, state: 'draft' },
];

/** The reader's rights in the body and in each region, with `editable` regions they may edit. */
function rights(editable: readonly string[]): AccessObject {
  const scopes: Record<string, readonly string[]> = { body: FULL };
  for (const r of REGIONS) scopes[`region:${r.id}`] = editable.includes(r.id) ? FULL : READ;
  return { rev: 1, docRole: 'editor', caps: ['view', 'comment', 'suggest', 'edit'], scopes };
}

/** The access the core publishes for a caret in `scope` ('body' or a region identifier). */
function caretAccess(editable: readonly string[], scope: string): AccessSummary {
  const id = scope === 'body' ? null : scope;
  const may = id === null || editable.includes(id);
  return {
    scope: id === null ? 'body' : `region:${id}`,
    caps: may ? [...FULL] : [...READ],
    limit: may ? null : 'region',
  };
}

function setup(editable: readonly string[], caret: string) {
  const core = new FakeCore({
    extended: true,
    regions: REGIONS,
    permissions: rights(editable),
    access: caretAccess(editable, caret),
  });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return { core, registry };
}

/**
 * A `perm.changed` that alters only regions after the caret: the core publishes new rights, and
 * the caret's access summary stays as it was, so nothing but `permissions` notifies.
 */
function permissionChange(core: FakeCore, editable: readonly string[]): void {
  core.permissions!.set(rights(editable));
}

function enabled(registry: ReturnType<typeof createCommandRegistry>): boolean | undefined {
  return registry.view.get().commands.find((c) => c.id === COMMAND)?.enabled;
}

describe('next editable region: the command is offered (PRM-027, criterion 3)', () => {
  it('is enabled while a later region may be edited', () => {
    const { registry } = setup(['r1', 'r3'], 'r1');
    expect(registry.state(COMMAND).enabled).toBe(true);
  });

  it('is reported as not enabled when no further region may be edited', () => {
    const { core, registry } = setup(['r1', 'r3'], 'r3');
    expect(registry.state(COMMAND).enabled).toBe(false);
    expect(registry.exec(COMMAND).ran).toBe(false);
    expect(core.callsOf('runNamed')).toHaveLength(0);
  });

  it('is not enabled when the reader may edit no region at all', () => {
    const { core, registry } = setup([], 'body');
    expect(core.query('hasNextEditableRegion')).toBe(false);
    expect(registry.state(COMMAND).enabled).toBe(false);
  });

  it('asks the core for the answer and does not work it out from the region list', () => {
    const { core, registry } = setup(['r2'], 'body');
    registry.state(COMMAND);
    expect(core.queryCounts.get('hasNextEditableRegion')).toBeGreaterThan(0);
  });
});

describe('next editable region: permission changes update it (PRM-027, criterion 4)', () => {
  it('turns off when the last editable region after the caret loses edit, and back on when it returns', () => {
    const { core, registry } = setup(['r1', 'r3'], 'r1');
    const access = core.access!.get();
    expect(enabled(registry)).toBe(true);

    permissionChange(core, ['r1']);
    expect(core.access!.get()).toBe(access);
    expect(enabled(registry)).toBe(false);
    expect(registry.state(COMMAND).enabled).toBe(false);

    permissionChange(core, ['r1', 'r3']);
    expect(core.access!.get()).toBe(access);
    expect(enabled(registry)).toBe(true);
    expect(registry.state(COMMAND).enabled).toBe(true);
  });

  it('reports the change to the surfaces as a changed command, with only the rights changed', () => {
    const { core, registry } = setup(['r1', 'r3'], 'r1');
    registry.view.get();
    const changed: string[][] = [];
    registry.onStateChange((ids) => changed.push([...ids]));
    permissionChange(core, ['r1']);
    expect(changed.flat()).toContain(COMMAND);
    expect(enabled(registry)).toBe(false);
  });
});
