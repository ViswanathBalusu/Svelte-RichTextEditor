/**
 * FE-062 criterion 1 in a real browser (lane U-FE-049-064): a run with a `fontFamily` mark is drawn
 * with the alias the font lookup gives for its family, and the document keeps the family name.
 * A family the lookup does not know keeps its name in the CSS, as before FE-062.
 *
 * Runs through `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
const ALIAS = `docedit-font-${'a'.repeat(64)}`;

/** Gives the first three characters of the body paragraph "Alpha" a family mark; returns where they start. */
function markFirstRun(core: EditorCore, family: string): { from: number } {
  const view = viewsOf(core).view;
  if (!view) throw new Error('the body view is not mounted');
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    if (from >= 0) return false;
    if (node.isText && node.text?.includes('Alpha')) {
      from = pos;
      return false;
    }
    return true;
  });
  const to = from + 3;
  const mark = view.state.schema.marks['fontFamily'];
  if (!mark) throw new Error('the schema has no fontFamily mark');
  view.dispatch(view.state.tr.addMark(from, to, mark.create({ value: family })));
  return { from };
}

describe.skipIf(!isBrowser)(
  'font family marks draw with the manifest alias (FE-062 criterion 1)',
  () => {
    it('renders a family the lookup knows with the alias and keeps the family name in the document', async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const core = new EditorCore({
        doc: spikeDocument(),
        access: ownerAccess(),
        schedule: (run) => queueMicrotask(run),
        fontAlias: (family) => (family === 'Noto Serif' ? ALIAS : undefined),
      });
      const unmount = core.mountBody(host);
      try {
        const { from } = markFirstRun(core, 'Noto Serif');
        await new Promise((r) => setTimeout(r, 20));
        const view = viewsOf(core).view!;
        const styled = Array.from(view.dom.querySelectorAll<HTMLElement>('span')).filter(
          (s) => s.style.fontFamily !== '',
        );
        expect(styled.length).toBeGreaterThan(0);
        expect(styled.some((s) => s.style.fontFamily.includes(ALIAS))).toBe(true);
        expect(styled.some((s) => s.style.fontFamily.includes('Noto Serif'))).toBe(false);
        // The document keeps the family name, not the alias.
        const mark = view.state.doc.nodeAt(from)!.marks.find((m) => m.type.name === 'fontFamily');
        expect(mark?.attrs['value']).toBe('Noto Serif');
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    });

    it('keeps the family name in the CSS when the lookup does not know the family', async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const core = new EditorCore({
        doc: spikeDocument(),
        access: ownerAccess(),
        schedule: (run) => queueMicrotask(run),
        fontAlias: () => undefined,
      });
      const unmount = core.mountBody(host);
      try {
        markFirstRun(core, 'Aptos');
        await new Promise((r) => setTimeout(r, 20));
        const view = viewsOf(core).view!;
        const styled = Array.from(view.dom.querySelectorAll<HTMLElement>('span')).filter(
          (s) => s.style.fontFamily !== '',
        );
        expect(styled.some((s) => s.style.fontFamily.includes('Aptos'))).toBe(true);
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    });
  },
);
