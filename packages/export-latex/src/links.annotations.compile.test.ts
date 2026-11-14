/**
 * Link annotations of the compiled PDF (Node.js only, sandbox): EXP-030 criterion 3. The converter's
 * bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`. The PDF's
 * objects are read as text, and every Flate stream is inflated, so an action held in an object
 * stream is seen too.
 *
 * - Criterion 3: no link annotation carries a launch, script or file action. The positive controls
 *   (a URI action and a GoTo action, from the http and in-document links) are checked first, so the
 *   inspection is known to read annotations.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A text node carrying a link mark with the given target. */
function link(text: string, href: string): J {
  return { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] };
}

/**
 * The PDF as text: the raw file, then the inflated contents of every Flate stream, so that objects
 * inside object streams are included. Streams that do not inflate are skipped.
 */
function pdfObjectText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const body = Buffer.from(raw.slice(start, end), 'latin1');
    try {
      parts.push(inflateSync(body).toString('latin1'));
    } catch {
      // Not a Flate stream, or not inflatable; its dictionary is still in the raw text.
    }
  }
  return parts.join('\n');
}

/** Action subtypes and keys that a link annotation must not carry (EXP-030 criterion 3). */
const FORBIDDEN = [
  /\/S\s*\/Launch\b/,
  /\/S\s*\/JavaScript\b/,
  /\/S\s*\/GoToR\b/,
  /\/S\s*\/GoToE\b/,
  /\/S\s*\/SubmitForm\b/,
  /\/S\s*\/ImportData\b/,
  /\/S\s*\/Rendition\b/,
  /\/S\s*\/RichMediaExecute\b/,
  /\/JS\b/,
  /\/JavaScript\b/,
];

describe.skipIf(!ready)(
  'EXP-030 criterion 3: no link annotation carries a launch, script or file action',
  () => {
    it('has URI and GoTo link actions, and none of the forbidden actions, for a document with every link kind', async () => {
      const body = [
        para('', {}, [link('Site', 'https://example.com/page')]),
        para('', {}, [link('Mail', 'mailto:ada@example.com')]),
        para('', {}, [
          { type: 'anchor', attrs: { id: nid('an'), name: 'intro' } },
          { type: 'text', text: 'Intro' },
        ]),
        para('', {}, [link('Back', '#intro')]),
        para('', {}, [
          link('Run', 'run:calc.exe'),
          link(' and ', 'file:///etc/passwd'),
          link(' or ', 'javascript:alert(1)'),
        ]),
      ];
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'exp-030-annotations',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-030-annotations', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      const objects = pdfObjectText(c.compile.pdf);

      // Positive controls: the annotations are visible to this inspection.
      expect(objects).toMatch(/\/S\s*\/URI\b/);
      expect(objects).toMatch(/\/S\s*\/GoTo\b/);

      // Criterion 3: none of the forbidden action types or script keys is present.
      for (const re of FORBIDDEN) expect(objects, `forbidden ${re}`).not.toMatch(re);
    }, 300_000);
  },
);
