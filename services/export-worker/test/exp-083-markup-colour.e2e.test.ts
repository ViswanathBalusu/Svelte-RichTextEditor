/**
 * EXP-083 criterion 1 (lane V-EXP-081-096): with `suggestions` set to `markup`, the insertion and
 * the deletion are rendered in colour. The bundle is compiled in the real Podman sandbox, as the
 * worker compiles it, and the PDF's page content must set the insertion colour (#1F5FAD) and the
 * deletion colour (#B3261E) before the text they mark; the text of both is still in the PDF.
 *
 * Needs Podman, the worker image and `pdftotext` (skips otherwise).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildBundle, compileFiles } from '../src/bundle-io.ts';
import { imageFontManifest } from '../src/fonts.ts';
import { planJob } from '../src/profile.ts';
import { compileInSandbox, IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { demoDocument } from './documents.ts';
import { fillColours, hasFillColour, hexToRgb } from './pdf-colours.ts';
import { pdftotextAvailable, pdfText, squash } from './pdf-text.ts';

vi.setConfig({ testTimeout: 420_000, hookTimeout: 180_000 });

const ready = await sandboxReady();

type Node = { type?: string; content?: Node[] } & Record<string, unknown>;

/** The demonstration document, with one deletion ("old ") and one insertion ("new ") in a paragraph. */
function markedDocument() {
  const envelope = structuredClone(demoDocument().envelope);
  const find = (node: Node): Node | null => {
    if (node.type === 'paragraph' && JSON.stringify(node).includes('The end of the document.'))
      return node;
    for (const child of node.content ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const paragraph = find(envelope.doc as Node)!;
  paragraph.content = [
    { type: 'text', text: 'Keep ' },
    {
      type: 'text',
      text: 'old ',
      marks: [{ type: 'del', attrs: { id: 'sDel083c00000001', user: 'alice' } }],
    },
    {
      type: 'text',
      text: 'new ',
      marks: [{ type: 'ins', attrs: { id: 'sIns083c00000002', user: 'alice' } }],
    },
    { type: 'text', text: 'text.' },
  ];
  return envelope;
}

describe.skipIf(!ready.ok)(`EXP-083 markup colours in the PDF (${ready.reason})`, () => {
  it.skipIf(!pdftotextAvailable())(
    'sets the insertion and deletion colours in the compiled PDF, and keeps both texts (EXP-083 criterion 1)',
    async () => {
      const planned = planJob({ profile: 'preview', suggestions: 'markup' }, 'en');
      if (!planned.ok) throw new Error(`the plan refused: ${JSON.stringify(planned.diagnostics)}`);
      const plan = planned.plan;
      expect(plan.suggestions).toBe('markup');
      const fonts = await imageFontManifest(IMAGE);
      const bundle = await buildBundle(markedDocument(), {
        fonts,
        tagging: 'off',
        pdfStandard: 'none',
        renderer: 'node',
        layout: 'line',
        profile: plan.profile,
        seq: 0,
        chainHead: null,
        title: 'Document',
        instant: '2026-11-13T00:00:00.000Z',
        timeZone: plan.timeZone,
        date: '13 November 2026',
        fields: plan.fields,
        ...(plan.suggestions ? { suggestions: plan.suggestions } : {}),
      });
      expect(bundle.ok, JSON.stringify(bundle.diagnostics)).not.toBe(false);
      // A non-colour cue (criterion 4): the insertion is underlined and the deletion struck through.
      const source = Object.values(bundle.files).join('\n');
      expect(source).toMatch(/\\DEc\{1F5FAD\}\{\\DEul\{\\DEr\{\d+\}\{new /);
      expect(source).toMatch(/\\DEc\{B3261E\}\{\\DEst\{\\DEr\{\d+\}\{old /);
      const compiled = await compileInSandbox(
        { ...compileFiles(bundle), ...(bundle.assets ?? {}) },
        {
          minPasses: plan.minPasses,
          maxPasses: plan.maxPasses,
          sourceDateEpoch: 1_788_000_000,
          name: `docedit-v-exp-081-096-s83c-${Date.now().toString(36)}`,
        },
      );
      expect(compiled.ok, compiled.log.slice(-2000)).toBe(true);
      const pdf = compiled.pdf!;
      expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe('%PDF-');

      const colours = fillColours(pdf);
      expect(hasFillColour(colours, hexToRgb('#1F5FAD')), 'the insertion colour is set').toBe(true);
      expect(hasFillColour(colours, hexToRgb('#B3261E')), 'the deletion colour is set').toBe(true);

      const text = squash(pdfText(pdf)!);
      expect(text).toContain('old');
      expect(text).toContain('new');
    },
  );
});
