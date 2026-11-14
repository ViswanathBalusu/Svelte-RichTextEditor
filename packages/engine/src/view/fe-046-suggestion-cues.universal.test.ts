/**
 * The suggestion cues of inline marks in a mounted body view (FE-046 criterion 1; lane V-FE-033-048).
 * An insertion, a deletion and a formatting change each have a different line that is not colour
 * (underline, strike-through, overline), and each author has a tone: a colour and a second cue, the
 * line style. The shipped `element.css` gives the rules; the test reads the computed style in the
 * browser.
 *
 * Block marks are not covered here: a block `ins` or `del` added by a node mark was not drawn by the
 * view in this test (see the FE-046 Notes; the row case is the known defect in suggestion-rows).
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`; in Node.js
 * there is no DOM, so the suite is skipped there. The classes and tones are tested in
 * test/fe-046-markup-views.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { AUTHOR_TONES, authorTone } from '../suggestion-markup.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';
// The shipped style sheet of the element, as text: the cues come from the real rules.
import elementCss from '../../../element/src/styles/element.css?raw';

const isBrowser = typeof document !== 'undefined';
const STYLES = ['solid', 'dashed', 'dotted', 'wavy'];
// The colours of the four tones in element.css, as the browser reports them.
const COLOURS = ['rgb(26, 127, 55)', 'rgb(130, 80, 223)', 'rgb(188, 76, 0)', 'rgb(9, 105, 218)'];

describe.skipIf(!isBrowser)('suggestion cues in the body view (FE-046 criterion 1)', () => {
  it('draws each inline kind with its own line, and each author with a tone of colour and line style', async () => {
    expect(AUTHOR_TONES).toBe(STYLES.length);
    expect(AUTHOR_TONES).toBe(COLOURS.length);
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
      ic.state.doc.descendants((node, pos) => {
        if (from < 0 && node.attrs['id'] === STYLE_IDS.plain) from = pos + 1;
        return from < 0;
      });
      if (ic.state.doc.textBetween(from, from + 3).length !== 3)
        throw new Error('paragraph too short');
      ic.dispatch(
        ic.state.tr
          .addMark(from, from + 1, schema.marks['ins']!.create({ id: 'ins-fe046', user: 'alice' }))
          .addMark(
            from + 1,
            from + 2,
            schema.marks['del']!.create({ id: 'del-fe046', user: 'bob' }),
          )
          .addMark(
            from + 2,
            from + 3,
            schema.marks['fmt']!.create({
              id: 'fmt-fe046',
              user: 'alice',
              before: { attrs: { style: 'Normal' } },
            }),
          ),
      );

      await vi.waitFor(() =>
        expect(
          surface.querySelectorAll('.de-suggest-ins, .de-suggest-del, .de-suggest-fmt'),
        ).toHaveLength(3),
      );
      const ins = surface.querySelector<HTMLElement>('.de-suggest-ins')!;
      const del = surface.querySelector<HTMLElement>('.de-suggest-del')!;
      const fmt = surface.querySelector<HTMLElement>('.de-suggest-fmt')!;

      // The kind is a line that is not colour.
      expect(getComputedStyle(ins).textDecorationLine).toContain('underline');
      expect(getComputedStyle(del).textDecorationLine).toContain('line-through');
      expect(getComputedStyle(fmt).textDecorationLine).toContain('overline');

      // The author's tone: the colour and the second cue (the line style) of the tone's rule.
      expect(ins.dataset['suggestionTone']).toBe(String(authorTone('alice')));
      expect(del.dataset['suggestionTone']).toBe(String(authorTone('bob')));
      expect(getComputedStyle(ins).textDecorationStyle).toBe(STYLES[authorTone('alice')]);
      expect(getComputedStyle(del).textDecorationStyle).toBe(STYLES[authorTone('bob')]);
      expect(getComputedStyle(ins).textDecorationColor).toBe(COLOURS[authorTone('alice')]);
      expect(getComputedStyle(del).textDecorationColor).toBe(COLOURS[authorTone('bob')]);
    } finally {
      unmount();
      core.destroy();
      host.remove();
      style.remove();
    }
  });
});
