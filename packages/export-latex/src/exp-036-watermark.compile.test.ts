/**
 * Watermark in the compiled PDF (Node.js only, sandbox): EXP-036 criterion 2. The converter's
 * bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`, and each
 * page's text is read back with `pdftotext` (split at its form feeds).
 *
 * - Criterion 2: a watermark of a page setup appears on every page that uses the setup, and the
 *   text is escaped through the `text` emitter (`&` and `%` print literally); a page setup with no
 *   watermark prints none.
 *
 * Criterion 3 (the watermark is out of the tagged reading order) is not tested here.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady, type Compiled } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

const pageSetup = (id: string, attrs: J): J => ({
  type: 'page_setup',
  attrs: { id, ...A4, ...attrs },
});

const INSTANT_OPTIONS = {
  profile: 'preview',
  title: 'exp-036-watermark',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
  layout: 'block',
} as const;

async function compiled(name: string, envelope: ReturnType<typeof doc>): Promise<Compiled> {
  const c = await convertAndCompile(envelope, { ...INSTANT_OPTIONS, title: name } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  return c;
}

/** The text of each page, from `pdftotext`'s form feeds, without the empty trailing page. */
function pages(c: Compiled): string[] {
  const text = pdfText(c.compile.pdf!);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  const parts = text.split('\f');
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts.pop();
  return parts;
}

describe.skipIf(!ready)(
  'EXP-036 criterion 2: a watermark prints on every page of its page setup',
  () => {
    it('prints the watermark, escaped through the text emitter, on each page of the setup', async () => {
      const body = [
        para('One.'),
        para('Two.', { pageBreakBefore: true }),
        para('Three.', { pageBreakBefore: true }),
      ];
      const c = await compiled(
        'exp-036-watermark-every-page',
        doc(body, { pageSetups: [pageSetup('ps1', { watermark: 'Draft & 50% copy' })] }),
      );
      const texts = pages(c);
      expect(texts).toHaveLength(3);
      for (const p of texts) expect(p).toContain('Draft & 50% copy');
    }, 300_000);

    it('prints no watermark on the pages of a setup that has none', async () => {
      const body = [
        para('One.'),
        para('Two.', { pageBreakBefore: true }),
        { type: 'section_break', attrs: { id: 'sb-ps2', pageSetup: 'ps2' } },
        para('Three.'),
        para('Four.', { pageBreakBefore: true }),
      ];
      const c = await compiled(
        'exp-036-watermark-two-setups',
        doc(body, {
          pageSetups: [pageSetup('ps1', { watermark: 'Draft & 50% copy' }), pageSetup('ps2', {})],
        }),
      );
      const texts = pages(c);
      expect(texts.length).toBeGreaterThanOrEqual(4);
      expect(texts[0]).toContain('Draft & 50% copy');
      expect(texts[texts.length - 1]).not.toContain('Draft & 50% copy');
    }, 300_000);
  },
);
