/**
 * Figure captions and alignment (Node.js only): EXP-028 criterion 2. A caption with a `seq` field
 * prints the literal label of the shared algorithm, and the figure's `align` selects the class's
 * alignment code (0 start, 1 centre, 2 end, the table in blocks.ts). The tests read main.tex of the
 * converter's bundle; they do not compile, so the position of the label in the PDF is not checked.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, run, type J } from '../test/docs.ts';

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** An inline field node. */
const field = (attrs: J): J => ({ type: 'field', attrs: { id: nid('f'), ...attrs } });

/** A figure with no picture (so no asset is needed), an alternative text, and a caption. */
function figure(attrs: J, caption: J[]): J {
  return {
    type: 'figure',
    attrs: { id: nid('f'), width: 1440, height: 1440, alt: 'A map', ...attrs },
    content: [{ type: 'caption', content: caption }],
  };
}

/** Counter commands that would print a number from TeX rather than from the shared algorithm. */
const COUNTER =
  /\\(arabic|alph|Alph|roman|Roman|value|the|stepcounter|refstepcounter|setcounter|addtocounter)\b/;

describe('EXP-028 criterion 2: a caption prints its seq label as literal text', () => {
  it('prints the literal label of a seq field in the caption, the first figure printing 1', async () => {
    const f = figure({}, [
      { type: 'text', text: 'Figure ' },
      field({ kind: 'seq', name: 'Figure' }),
    ]);
    const b = await run(doc([f]));
    const lines = blockLines(b, idOf(f)).join('\n');
    expect(lines).toMatch(/\\DEa\{\d+\}\{1\}/);
    expect(lines).not.toMatch(COUNTER);
  });

  it('prints the second caption label as 2, after the first figure', async () => {
    const f1 = figure({}, [
      { type: 'text', text: 'Figure ' },
      field({ kind: 'seq', name: 'Figure' }),
    ]);
    const f2 = figure({}, [
      { type: 'text', text: 'Figure ' },
      field({ kind: 'seq', name: 'Figure' }),
    ]);
    const b = await run(doc([f1, f2]));
    expect(blockLines(b, idOf(f2)).join('\n')).toMatch(/\\DEa\{\d+\}\{2\}/);
    expect(bundleHasCounter(b.files['main.tex']!)).toBe(false);
  });

  it('writes the figure alignment as the class code of its align value (property)', async () => {
    const CODE: Record<string, string> = { start: '0', center: '1', end: '2' };
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('start', 'center', 'end', undefined), async (align) => {
        const f = figure(align === undefined ? {} : { align }, [{ type: 'text', text: 'Caption' }]);
        const b = await run(doc([f]));
        const want = CODE[align ?? 'start'];
        expect(blockLines(b, idOf(f)).join('\n')).toMatch(
          new RegExp(`\\\\DEfig\\{\\d+\\}\\{[01]\\}\\{${want}\\}\\{`),
        );
      }),
      { numRuns: 15 },
    );
  });

  it('keeps the caption text in the same figure call as the picture', async () => {
    const f = figure({ align: 'center' }, [
      { type: 'text', text: 'Map of ' },
      field({ kind: 'seq', name: 'Figure' }),
    ]);
    const b = await run(doc([f]));
    const lines = blockLines(b, idOf(f)).join('\n');
    expect(lines).toMatch(/\\DEfig\{\d+\}\{0\}\{1\}\{/);
    expect(lines).toMatch(/\\DEcap\{/);
  });
});

function bundleHasCounter(main: string): boolean {
  return COUNTER.test(main);
}
