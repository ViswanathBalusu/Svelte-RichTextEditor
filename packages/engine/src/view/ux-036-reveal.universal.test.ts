/**
 * Next and previous bring a suggestion into view (UX-036 criterion 1; lane w3). `revealSuggestion`
 * selects the suggestion's words and the body scrolls to them even though the editing surface has
 * no focus. The document is not changed.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit); in Node.js there is no DOM, so the suite is skipped there.
 */
import { describe, expect, it, vi } from 'vitest';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: unknown[];
}

function suggestedDocument() {
  const env = styledDocument();
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === STYLE_IDS.after) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  const para = find(env.doc as unknown as JsonNode)!;
  para.content = [
    { type: 'text', text: 'Late ' },
    {
      type: 'text',
      text: 'addition',
      marks: [{ type: 'ins', attrs: { id: 'sLate000000000001', user: 'sam' } }],
    },
  ];
  return env;
}

describe.skipIf(!isBrowser)('a suggestion is brought into view (UX-036 criterion 1)', () => {
  it('selects the suggestion and scrolls the body to it, with no change of the document', async () => {
    const scroller = document.createElement('div');
    scroller.style.cssText = 'height:60px;overflow:auto;';
    const host = document.createElement('div');
    scroller.append(host);
    document.body.append(scroller);
    const core = new EditorCore({
      doc: suggestedDocument(),
      access: styledEditorAccess(),
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      const surface = document.querySelector<HTMLElement>('.de-editing-surface');
      if (!surface) throw new Error('the body surface was not mounted');
      const ic = internals(core);
      const before = ic.state.doc;
      scroller.scrollTop = 0;
      const items = core.suggestionItems();
      expect(items.map((s) => [s.id, s.kind, s.user, s.text])).toEqual([
        ['sLate000000000001', 'ins', 'sam', 'addition'],
      ]);
      expect(core.stepSuggestion(1)?.id).toBe('sLate000000000001');
      expect(ic.state.doc.textBetween(ic.state.selection.from, ic.state.selection.to)).toBe(
        'addition',
      );
      await vi.waitFor(() => {
        const mark = surface.querySelector<HTMLElement>('[data-suggestion-id="sLate000000000001"]');
        expect(mark).not.toBeNull();
        const box = scroller.getBoundingClientRect();
        const at = mark!.getBoundingClientRect();
        expect(at.top).toBeGreaterThanOrEqual(box.top - 1);
        expect(at.bottom).toBeLessThanOrEqual(box.bottom + 1);
      });
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(ic.state.doc.eq(before)).toBe(true);
    } finally {
      unmount();
      core.destroy();
      scroller.remove();
    }
  });
});
