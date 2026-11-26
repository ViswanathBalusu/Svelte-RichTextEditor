/**
 * The proofing findings in a mounted body view (UX-041 criteria 1, 3 and 7): the decorations of
 * `proofingDecorations` are drawn as elements of the editing surface, each names its finding, a
 * finding is removed from the surface when its text changes, and the document is not changed.
 *
 * Runs in real browser engines through `pnpm test:browsers`; in Node.js there is no DOM, so the
 * suite is skipped there (the findings are tested in test/ux-041-proofing.test.ts).
 */
import { loadProofing } from '../core.ts';
import type { ProofingFinding } from '@docedit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { PROOF_CURRENT_CLASS, PROOF_SPELLING_CLASS } from '../proofing-decorations.ts';
import { EditorCore } from './web.ts';

// The proofing controller is a chunk of its own (UX-070); load it so that attaching a port is synchronous.
await loadProofing();

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('proofing findings in the body view (UX-041)', () => {
  it('draws a finding over its text, marks the current one, and drops it when the text changes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      const surface = document.querySelector<HTMLElement>('.de-editing-surface');
      if (!surface) throw new Error('the body surface was not mounted');
      const before = JSON.stringify(core.getContent());
      core.attachProofing(
        {
          check: (request) =>
            Promise.resolve(
              request.blocks.flatMap((b): ProofingFinding[] => {
                const at = b.text.indexOf('Plain');
                return at < 0
                  ? []
                  : [
                      {
                        blockId: b.blockId,
                        from: at,
                        to: at + 5,
                        kind: 'spelling',
                        message: 'Unknown word',
                        suggestions: ['Plane'],
                      },
                    ];
              }),
            ),
          addWord: () => Promise.resolve(),
        },
        { debounceMs: 1 },
      );
      const spans = () => surface.querySelectorAll(`.${PROOF_SPELLING_CLASS}`);
      await vi.waitFor(() => expect(spans()).toHaveLength(1));
      expect(spans()[0]!.textContent).toBe('Plain');
      expect(spans()[0]!.getAttribute('data-de-finding')).toContain(STYLE_IDS.plain);
      expect(JSON.stringify(core.getContent())).toBe(before);

      expect(core.proofingStep(1)).toBe(true);
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${PROOF_CURRENT_CLASS}`)).toHaveLength(1),
      );

      // The author changes the text under the finding: it is not drawn on the changed text.
      const ic = internals(core);
      let at = -1;
      ic.state.doc.descendants((node, pos) => {
        if (at < 0 && node.attrs['id'] === STYLE_IDS.plain) at = pos + 1;
        return at < 0;
      });
      ic.dispatch(ic.state.tr.insertText('X', at + 2));
      await vi.waitFor(() => expect(spans()).toHaveLength(0));
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
