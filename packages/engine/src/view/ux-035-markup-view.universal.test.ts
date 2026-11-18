/**
 * The markup views drawn in a mounted body view (UX-035; 13 §5; lane w3). The shipped `element.css`
 * gives the rules, and the test reads the computed style in the browser. An insertion, a deletion
 * and a deleted block each look as the view says: `all` draws every change with a line that is not
 * colour; `simple` hides deletions and bars the changes; `none` is the accepted text; `original` is
 * the rejected text. Choosing a view applies no transaction. The words for assistive technology are
 * drawn out of sight before each change.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`; in Node.js
 * there is no DOM, so the suite is skipped there. The classes are tested in
 * test/ux-035-markup-view.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';
// The shipped style sheet of the element, as text: the cues come from the real rules.
import elementCss from '../../../element/src/styles/element.css?raw';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('the markup views in the body view (UX-035)', () => {
  it('draws each view as the story says, writes the words for assistive technology, and sends nothing', async () => {
    const style = document.createElement('style');
    style.textContent = elementCss;
    document.head.append(style);
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
      const ic = internals(core);
      const { schema } = ic;

      let from = -1;
      let quote = -1;
      ic.state.doc.descendants((node, pos) => {
        if (from < 0 && node.attrs['id'] === STYLE_IDS.plain) from = pos + 1;
        if (quote < 0 && node.attrs['id'] === STYLE_IDS.quote) quote = pos;
        return true;
      });
      if (ic.state.doc.textBetween(from, from + 2).length !== 2)
        throw new Error('paragraph too short');
      ic.dispatch(
        ic.state.tr
          .addMark(from, from + 1, schema.marks['ins']!.create({ id: 'ins-ux035', user: 'alice' }))
          .addMark(
            from + 1,
            from + 2,
            schema.marks['del']!.create({ id: 'del-ux035', user: 'bob' }),
          )
          .addNodeMark(quote, schema.marks['del']!.create({ id: 'bdel-ux035', user: 'carol' })),
      );
      core.setSuggestionLabel((kind, user) =>
        kind === 'ins' ? `Inserted by ${user}` : `Deleted by ${user}`,
      );

      const find = (selector: string) => surface.querySelector<HTMLElement>(selector);
      const shown = (el: Element | null) => el !== null && getComputedStyle(el).display !== 'none';

      // all: every change, with its words for assistive technology drawn out of sight.
      await vi.waitFor(() => expect(find('.de-suggest-ins')).not.toBeNull());
      const ins = find('.de-suggest-ins')!;
      const del = find('.de-suggest-del:not(p, h1, h2, blockquote)')!;
      expect(getComputedStyle(ins).textDecorationLine).toContain('underline');
      expect(getComputedStyle(del).textDecorationLine).toContain('line-through');
      const words = getComputedStyle(ins, '::before');
      expect(words.content).toContain('Inserted by alice');
      expect(words.position).toBe('absolute');
      expect(words.width).toBe('1px');
      expect(getComputedStyle(del, '::before').content).toContain('Deleted by bob');
      const quoteEl = find(`[data-suggestion-id="bdel-ux035"]`);
      expect(quoteEl).not.toBeNull();
      expect(quoteEl!.classList.contains('de-suggest-del')).toBe(true);

      const before = ic.state;

      // simple: the deletions are out of the text but leave a bar, and the insertion carries a bar.
      core.setMarkupView('simple');
      await vi.waitFor(() => expect(find('.de-suggest-changed')).not.toBeNull());
      const changed = find('.de-suggest-changed')!;
      expect(changed.dataset['suggestionId']).toBe('ins-ux035');
      expect(getComputedStyle(changed).borderInlineStartWidth).toBe('3px');
      expect(getComputedStyle(changed).borderInlineStartStyle).toBe('solid');
      const gone = find('[data-suggestion-id="del-ux035"]')!;
      expect(gone.classList.contains('de-suggest-gone')).toBe(true);
      expect(getComputedStyle(gone).borderInlineStartWidth).toBe('3px');
      expect(gone.getBoundingClientRect().width).toBeLessThanOrEqual(4);
      const goneBlock = find('[data-suggestion-id="bdel-ux035"]')!;
      expect(getComputedStyle(goneBlock).borderBlockStartWidth).toBe('3px');
      expect(goneBlock.getBoundingClientRect().height).toBeLessThanOrEqual(4);

      // none: the accepted text; nothing is drawn on the insertion, the deletions are hidden.
      core.setMarkupView('none');
      await vi.waitFor(() => expect(find('.de-suggest-changed')).toBeNull());
      const plain = find('[data-suggestion-id="ins-ux035"]');
      expect(plain).toBeNull();
      expect(shown(find('[data-suggestion-id="del-ux035"]'))).toBe(false);
      expect(shown(find('[data-suggestion-id="bdel-ux035"]'))).toBe(false);

      // original: the rejected text; the insertion is hidden, the deletions are back and plain.
      core.setMarkupView('original');
      await vi.waitFor(() => expect(find('.de-suggest-restored')).not.toBeNull());
      expect(shown(find('[data-suggestion-id="ins-ux035"]'))).toBe(false);
      const restored = find('.de-suggest-restored:not(p, h1, h2, blockquote)')!;
      expect(shown(restored)).toBe(true);
      expect(getComputedStyle(restored).textDecorationLine).toBe('none');
      expect(shown(find('[data-suggestion-id="bdel-ux035"]'))).toBe(true);

      // Back to all; and none of the choices applied a transaction.
      core.setMarkupView('all');
      await vi.waitFor(() => expect(find('.de-suggest-ins')).not.toBeNull());
      expect(ic.state).toBe(before);
    } finally {
      unmount();
      core.destroy();
      host.remove();
      style.remove();
    }
  });
});
