/**
 * EXP-042 criterion 4 (bundle level, Node.js only): generated identifiers never collide inside one
 * bundle. Each distinct anchor gets its own number and each distinct paragraph style gets its own
 * macro name, so no two inputs share a name. The documents come from `test/docs.ts`; nothing here
 * compiles, so the check is on the text of the bundle.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';

const N = 150;

describe('EXP-042 generated identifiers are unique in one bundle (criterion 4)', () => {
  it('numbers each anchor once: N distinct anchors give N distinct \\DEanchor numbers', async () => {
    const body = Array.from({ length: N }, (_, i) =>
      para('', {}, [{ type: 'anchor', attrs: { name: `mark${i}` } }]),
    );
    const b = await run(doc([...body, para('End.')]));
    const numbers = [...b.files['main.tex']!.matchAll(/\\DEanchor\{(\d+)\}/g)].map((m) => m[1]!);
    expect(numbers.length).toBe(N);
    expect(new Set(numbers).size).toBe(N);
  });

  it('names each paragraph style with its own macro: N styles give N distinct \\DES names', async () => {
    const styles = Array.from({ length: N }, (_, i) => ({
      type: 'style_def',
      attrs: { id: `Style${i}`, kind: 'paragraph', name: `Style ${i}`, builtIn: false },
    }));
    const body = Array.from({ length: N }, (_, i) => para(`Text ${i}.`, { style: `Style${i}` }));
    const b = await run(doc(body, { styles }));
    const names = (text: string): string[] =>
      [...text.matchAll(/\\DES([A-Za-z]+)\b/g)].map((m) => m[1]!);
    const defined = new Set(names(b.files['styles.tex']!));
    const used = new Set(names(b.files['main.tex']!));
    // One macro per style the document defines (EXP-013 criterion 1): the N styles and the Normal
    // style the test helper adds.
    expect(defined.size).toBe(N + 1);
    expect([...used].every((n) => defined.has(n))).toBe(true);
  });
});
