/**
 * FE-136 criterion 3 in a real browser: the web view shows the entries of a table of contents and
 * of a list of figures, and draws them again as headings and captions change. The entries are
 * generated (nothing is written into the document), carry the level and the list label of a
 * heading, and give no page number.
 *
 * Run with `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
const ASSET = 'a'.repeat(32);
const TOC = 'tocA000000000001';
const LOF = 'tocB000000000001';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!isBrowser)('a table of contents shows generated entries (FE-136 c3)', () => {
  it('lists the headings and the figure captions, and follows changes to them', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: spikeDocument(),
      access: ownerAccess(),
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      const view = viewsOf(core).view!;
      const { schema } = view.state;
      const bodyEnd = (): number => {
        let end = -1;
        view.state.doc.forEach((child, offset) => {
          if (child.type.name === 'body') end = offset + child.nodeSize - 1;
        });
        return end;
      };
      const posOf = (id: string): number => {
        let found = -1;
        view.state.doc.descendants((n, pos) => {
          if (found < 0 && n.attrs['id'] === id) found = pos;
          return found < 0;
        });
        return found;
      };
      const toc = (id: string, attrs: Record<string, unknown>) =>
        schema.nodes['toc']!.create({ id, minLevel: 1, maxLevel: 3, of: 'headings', ...attrs });
      view.dispatch(view.state.tr.insert(bodyEnd(), toc(TOC, {})));
      view.dispatch(view.state.tr.insert(bodyEnd(), toc(LOF, { of: 'Figure' })));
      await settle();

      const list = (name: string): HTMLElement =>
        Array.from(host.querySelectorAll<HTMLElement>('.de-toc')).find(
          (e) => e.getAttribute('aria-label') === name,
        )!;
      const entries = (name: string): string[] =>
        Array.from(list(name).querySelectorAll<HTMLElement>('.de-toc-entry')).map(
          (e) => `${e.getAttribute('data-level')}|${e.textContent}`,
        );

      // The spike document has one heading, "Scope" (style Heading1, outline level 1).
      expect(entries('Table of contents')).toEqual(['1|Scope']);
      expect(list('List of figures').textContent).toBe('List of figures: no captions yet');

      // A new heading is added: the list follows.
      const heading = schema.nodes['paragraph']!.create(
        { id: 'pNewHead0000001', style: 'Heading1' },
        [schema.text('Second part')],
      );
      view.dispatch(view.state.tr.insert(posOf(TOC), heading));
      await settle();
      expect(entries('Table of contents')).toEqual(['1|Scope', '1|Second part']);

      // Its text is edited: the entry follows.
      const at = posOf('pNewHead0000001');
      view.dispatch(
        view.state.tr.insertText(
          ' two',
          at + 1 + 'Second part'.length,
          at + 1 + 'Second part'.length,
        ),
      );
      await settle();
      expect(entries('Table of contents')).toEqual(['1|Scope', '1|Second part two']);

      // The list of figures follows a new captioned figure, with the computed number.
      const figure = schema.nodes['figure']!.create(
        { id: 'figC000000000001', asset: ASSET, width: 1440, height: 720 },
        [
          schema.nodes['caption']!.create(null, [
            schema.text('Figure '),
            schema.nodes['field']!.create({ kind: 'seq', name: 'Figure', cached: null }),
            schema.text(': a chart'),
          ]),
        ],
      );
      view.dispatch(view.state.tr.insert(posOf(TOC), figure));
      await settle();
      expect(entries('List of figures')).toEqual(['1|Figure 1: a chart']);

      // A heading removed: gone from the list. The entries are not in the document.
      const gone = posOf('pNewHead0000001');
      view.dispatch(view.state.tr.delete(gone, gone + view.state.doc.nodeAt(gone)!.nodeSize));
      await settle();
      expect(entries('Table of contents')).toEqual(['1|Scope']);
      expect(view.state.doc.textContent).not.toContain('Figure 1: a chart: a chart');
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
