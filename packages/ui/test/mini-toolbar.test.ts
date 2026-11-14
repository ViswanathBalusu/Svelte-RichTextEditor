/**
 * The mini toolbar's items (UX-010; 13 §2, §4): nothing without a selection, formatting commands
 * from the registry for a selection the user may change, and no editing command where the access
 * or the mode does not allow a change (criterion 4). Its placement and keyboard use are the
 * surface's and are not tested here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  immediateScheduler,
  miniToolbarItems,
} from '../src/commands/index.ts';
import type { SelectionSummary } from '../src/core-api.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const SELECTION: SelectionSummary = {
  empty: false,
  scope: 'body',
  region: null,
  style: 'Normal',
  marks: [],
};

function items(options: ConstructorParameters<typeof FakeCore>[0], empty: boolean) {
  const core = new FakeCore({ extended: true, ...options });
  core.selection.set({ ...core.selection.get(), ...SELECTION, empty });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return miniToolbarItems(registry.view.get().commands, empty).map((v) => v.id);
}

describe('the mini toolbar offers formatting for a selection the user may change (UX-010)', () => {
  it('offers the common formatting commands of the registry', () => {
    const ids = items({ access: EDIT, mode: 'edit' }, false);
    expect(ids).toEqual(expect.arrayContaining(['format.bold', 'format.italic']));
    expect(ids.every((id) => id.startsWith('format.'))).toBe(true);
  });

  it('offers nothing without a selection', () => {
    expect(items({ access: EDIT, mode: 'edit' }, true)).toEqual([]);
  });

  it('offers no editing command to a user who may only view (criterion 4)', () => {
    expect(items({ access: VIEW, mode: 'edit' }, false)).toEqual([]);
  });

  it('offers no editing command in view mode, even with edit rights (criterion 4)', () => {
    expect(items({ access: EDIT, mode: 'view', modes: ['edit', 'view'] }, false)).toEqual([]);
  });

  it('property: no offered item changes content when the change is refused', () => {
    fc.assert(
      fc.property(fc.constantFrom(VIEW, EDIT), fc.constantFrom('edit', 'view'), (access, mode) => {
        const core = new FakeCore({
          extended: true,
          access,
          mode: mode as 'edit' | 'view',
          modes: ['edit', 'view'],
        });
        core.selection.set({ ...core.selection.get(), ...SELECTION });
        const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
        const offered = miniToolbarItems(registry.view.get().commands, false);
        const refused = access === VIEW || mode === 'view';
        for (const view of offered) {
          if (refused) expect(view.entry.changesContent).toBe(false);
        }
      }),
      { numRuns: 40 },
    );
  });
});
