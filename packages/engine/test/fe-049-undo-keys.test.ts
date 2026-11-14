/**
 * FE-049 criterion 7: Mod-z, Mod-Shift-z and Mod-y run undo and redo through the command registry
 * (`DocumentCore.run`), not through ProseMirror's history commands directly. The keys are pressed
 * through the state's own key handlers, as the view calls them (no browser in Node.js).
 */
import { describe, expect, it, vi } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, type } from './support.ts';

/** A key press as a keydown event on a non-Mac platform (Mod is Control). */
function press(core: object, key: string, mods: { shift?: boolean }): boolean {
  const state = internals(core as Parameters<typeof internals>[0]).state;
  const event = {
    key,
    code: `Key${key.toUpperCase()}`,
    keyCode: key.toUpperCase().charCodeAt(0),
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: mods.shift === true,
  };
  // The view is only read for `state` and `dispatch`; the core's command reads its own state.
  const view = { state, dispatch: () => {} };
  for (const plugin of state.plugins) {
    const handle = plugin.props.handleKeyDown;
    // ProseMirror calls a plugin's prop with the plugin as `this` (EditorView.someProp).
    if (handle && handle.call(plugin, view as never, event as never)) return true;
  }
  return false;
}

describe('undo and redo keys run through the command registry (FE-049 criterion 7)', () => {
  it('Mod-z runs undo, Mod-Shift-z and Mod-y run redo, through DocumentCore.run', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const a = await join(service, docId, 'eddie', 'editor');
    try {
      const run = vi.spyOn(a.core, 'run');
      caret(a.core, IDS.mid, 'end');
      type(a.core, ' U-FE-049-064');

      expect(press(a.core, 'z', {})).toBe(true);
      expect(run).toHaveBeenLastCalledWith('undo');

      expect(press(a.core, 'Z', { shift: true })).toBe(true);
      expect(run).toHaveBeenLastCalledWith('redo');

      expect(press(a.core, 'y', {})).toBe(true);
      expect(run).toHaveBeenLastCalledWith('redo');

      expect(run.mock.calls.map((c) => c[0])).toEqual(['undo', 'redo', 'redo']);
    } finally {
      a.detach();
      await service.dispose();
    }
  });
});
