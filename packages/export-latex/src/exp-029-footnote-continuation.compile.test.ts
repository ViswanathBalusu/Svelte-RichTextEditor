/**
 * Footnote continuation in `layout.json` (Node.js only, sandbox): EXP-029 criterion 3. The class's
 * Lua code writes `main.layout` in the export worker's sandbox (Podman); `test/harness.ts` parses it
 * and joins it with the converter's `map.json`, so this test reads the object the job would serve.
 *
 * - Criterion 3: a footnote whose text continues on the next page. The body holds one short
 *   paragraph with a long footnote, so the footnote's text runs past the first page and the body
 *   ends there. The page that holds only the rest of the footnote opens with `footnoteContinuation`.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A footnote whose one paragraph holds `words` numbered words, so it spans more than one page. */
function longFootnote(words: number): J {
  const text = Array.from({ length: words }, (_v, i) => `note${i}`).join(' ');
  return {
    type: 'footnote',
    attrs: { id: nid('f') },
    content: [{ type: 'paragraph', attrs: { id: nid('q') }, content: [{ type: 'text', text }] }],
  };
}

describe.skipIf(!ready)(
  'EXP-029 criterion 3: a footnote that continues on the next page is reported as such',
  () => {
    it('opens the page that holds only the rest of the footnote with footnoteContinuation', async () => {
      const body: J = {
        type: 'paragraph',
        attrs: { id: nid('p') },
        content: [{ type: 'text', text: 'Intro with a long note.' }, longFootnote(900)],
      };
      const c = await convertAndCompile(
        doc([body]),
        {
          profile: 'preview',
          title: 'exp-029-footnote-continuation',
          instant: INSTANT,
          timeZone: 'Europe/London',
          suggestions: 'accept',
          layout: 'line',
        } as never,
        { minPasses: 2 },
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-029-footnote-continuation', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);
      const layout = c.layout!;
      expect(layout.pages.length).toBeGreaterThanOrEqual(2);
      // The first page holds the body text, so it opens with text.
      expect(layout.pages[0]!.opensWith).toBe('text');
      // Later pages hold only footnote text: they open with the footnote's continuation.
      expect(layout.pages[1]!.opensWith).toBe('footnoteContinuation');
    }, 240_000);
  },
);
