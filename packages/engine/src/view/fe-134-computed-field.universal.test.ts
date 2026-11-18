/**
 * FE-134 criterion 3 in a real browser: the web view shows the caption number of a `seq` field and
 * the text of a `ref` field as the model's shared label computation gives them (`computeLabels`,
 * CDM-042), so they follow the content when a captioned figure is inserted or removed before them.
 * Nothing is written into the document: `cached` keeps its text (owner decision 90, 2026-11-15).
 *
 * Run with `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM). The PDF
 * side is packages/export-latex/src/fe-134-numbers.compile.test.ts, which compiles the same
 * document.
 */
import { computeLabels, referenceText } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const FIG_A = 'figA000000000001';
const FIG_B = 'figB000000000001';
const ASSET = 'a'.repeat(32);

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!isBrowser)('caption numbers and references follow the content (FE-134 c3)', () => {
  it('shows computed texts, and leaves cached as it was', async () => {
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
      const figure = (id: string): PMNode =>
        schema.nodes['figure']!.create({ id, asset: ASSET, width: 1440, height: 720 }, [
          schema.nodes['caption']!.create(null, [
            schema.text('Figure '),
            schema.nodes['field']!.create({ kind: 'seq', name: 'Figure', cached: '1' }),
          ]),
        ]);
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

      // Figure B, and a reference to it in the paragraph after it; both texts are cached as 1.
      view.dispatch(view.state.tr.insert(bodyEnd(), figure(FIG_B)));
      const ref = schema.nodes['field']!.create({
        kind: 'ref',
        target: `node:${FIG_B}`,
        format: null,
        cached: '1',
      });
      const para = schema.nodes['paragraph']!.create({ id: null }, [schema.text('See '), ref]);
      view.dispatch(view.state.tr.insert(bodyEnd(), para));
      await settle();

      const fields = (): string[] =>
        Array.from(
          host.querySelectorAll<HTMLElement>(
            '.de-field[data-kind="seq"], .de-field[data-kind="ref"]',
          ),
        ).map((e) => e.textContent ?? '');
      const expected = (): { seq: string; ref: string | null } => {
        const labels = computeLabels(view.state.doc);
        return {
          seq: labels.sequences.get(FIG_B)![0]!.text,
          ref: referenceText(labels, `node:${FIG_B}`),
        };
      };
      expect(fields()).toEqual(['1', '1']);

      // Figure A before B: B is now figure 2, and so is the reference to it.
      view.dispatch(view.state.tr.insert(posOf(FIG_B), figure(FIG_A)));
      await settle();
      expect(expected().seq).toBe('2');
      expect(expected().ref).toBe('2');
      // Figure A's own number, figure B's number, the reference.
      expect(fields()).toEqual(['1', '2', '2']);
      // The document still holds the text it was given.
      const cachedTexts: unknown[] = [];
      view.state.doc.descendants((n) => {
        if (n.type.name === 'field' && n.attrs['kind'] !== 'page')
          cachedTexts.push(n.attrs['cached']);
        return true;
      });
      expect(cachedTexts).toEqual(['1', '1', '1']);

      // Remove figure A: the numbers go back.
      const at = posOf(FIG_A);
      view.dispatch(view.state.tr.delete(at, at + view.state.doc.nodeAt(at)!.nodeSize));
      await settle();
      expect(fields()).toEqual(['1', '1']);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
