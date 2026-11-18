/**
 * FE-135 criterion 6 in a real browser: a continuous section break whose page setup changes a
 * margin has a visible note after its mark, saying that the PDF will report it as unsupported
 * (03 §10). The note appears when the margin is changed, goes when it is changed back, and is not
 * document content. A next-page break with the same change has no note.
 *
 * Run with `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';
import { SECTION_WARNING_TEXT } from './section-warning-view.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

async function rig(
  start: 'continuous' | 'nextPage',
): Promise<{ host: HTMLElement; core: EditorCore; sectionSetup: string; done(): void }> {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: spikeDocument(),
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  const view = viewsOf(core).view!;
  let at = -1;
  view.state.doc.descendants((n, pos) => {
    if (at < 0 && n.attrs['id'] === SPIKE_IDS.intro) at = pos;
    return at < 0;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1 + 3)));
  expect(core.run('insertSectionBreak', { section: { start } })).toBe(true);
  let sectionSetup = '';
  view.state.doc.descendants((n) => {
    if (n.type.name === 'section_break') sectionSetup = String(n.attrs['pageSetup']);
    return true;
  });
  await settle();
  return {
    host,
    core,
    sectionSetup,
    done: () => {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

const notes = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('.de-section-warning'));

describe.skipIf(!isBrowser)(
  'a continuous section break that changes margins warns (FE-135 c6)',
  () => {
    it('shows a note after the break when a margin changes, and takes it away when it is restored', async () => {
      const r = await rig('continuous');
      try {
        expect(notes(r.host)).toHaveLength(0);
        expect(
          r.core.run('setPageSetup', {
            pageSetup: { id: r.sectionSetup, changes: { marginTop: 2880 } },
          }),
        ).toBe(true);
        await settle();
        const found = notes(r.host);
        expect(found).toHaveLength(1);
        const note = found[0]!;
        expect(note.textContent).toBe(SECTION_WARNING_TEXT);
        expect(note.getAttribute('role')).toBe('note');
        // It stands right after the break's mark, and it is not document content.
        expect(note.previousElementSibling?.matches('hr.de-section-break')).toBe(true);
        expect(note.closest('[contenteditable="false"]')).toBe(note);
        expect(viewsOf(r.core).view!.state.doc.textContent).not.toContain('PDF will report');

        expect(
          r.core.run('setPageSetup', {
            pageSetup: { id: r.sectionSetup, changes: { marginTop: 1440 } },
          }),
        ).toBe(true);
        await settle();
        expect(notes(r.host)).toHaveLength(0);
      } finally {
        r.done();
      }
    });

    it('shows no note for a next-page break with the same change', async () => {
      const r = await rig('nextPage');
      try {
        expect(
          r.core.run('setPageSetup', {
            pageSetup: { id: r.sectionSetup, changes: { marginTop: 2880 } },
          }),
        ).toBe(true);
        await settle();
        expect(notes(r.host)).toHaveLength(0);
      } finally {
        r.done();
      }
    });
  },
);
