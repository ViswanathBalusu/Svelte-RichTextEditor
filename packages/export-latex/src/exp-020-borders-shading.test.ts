/**
 * Paragraph borders and shading in the converter's output (Node.js only): EXP-020 criterion 2.
 * The tests read main.tex, styles.tex and the diagnostics, and the class files for the macros the
 * converter writes. The drawing itself is checked on a compiled PDF in
 * `exp-020-borders-shading.compile.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockLines, codes, doc, para, run, type J } from '../test/docs.ts';

const classDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'class');
const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;
const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});
const side = (color: string, extra: J = {}): J => ({ style: 'single', width: 20, color, ...extra });

/** The body of the style macro a paragraph calls, from styles.tex. */
function macroBody(lines: string[], styles: string): string {
  const name = /\\(DES[a-zA-Z]+)/.exec(lines.join('\n'))?.[1];
  if (!name) throw new Error('the paragraph writes no style macro');
  const def = styles.split('\n').find((l) => l.startsWith(`\\def\\${name}{`));
  if (!def) throw new Error(`no definition of ${name}`);
  return def;
}

describe('EXP-020 criterion 2: borders and shading of a style reach the class', () => {
  const boxed = style('Boxed', {
    shading: { fill: '#FFEE00' },
    borders: {
      top: side('#FF0000', { space: 80 }),
      bottom: side('#FF0000', { style: 'double' }),
      left: side('#0000FF', { style: 'dashed', width: 12 }),
      right: { style: 'dotted' },
    },
  });

  it('writes the style shading and one border list, and no "not drawn" diagnostic', async () => {
    const p = para('Boxed.', { style: 'Boxed' });
    const bundle = await run(doc([p], { styles: [boxed] }));
    const styles = bundle.files['styles.tex']!;
    const macro = macroBody(blockLines(bundle, idOf(p)), styles);
    expect(macro).toContain('\\DEshade{FFEE00}');
    expect(macro).toContain('\\DEbord{1}');
    // side:style:width:space:colour, widths and spaces in twips; no width is 8, no colour is black
    expect(styles).toContain(
      '\\DEdefborders{1}{t:s:20:80:FF0000;b:d:20:0:FF0000;l:a:12:0:0000FF;r:o:8:0:000000}',
    );
    // the list is defined before the style macro that names it
    expect(styles.indexOf('\\DEdefborders{1}')).toBeLessThan(styles.indexOf(macro));
    expect(codes(bundle)).not.toContain('paragraph_shading');
    expect(codes(bundle)).not.toContain('paragraph_borders');
  });

  it('lets direct attributes replace or remove the borders and shading of the style', async () => {
    const other = para('Other.', {
      style: 'Boxed',
      shading: { fill: '#00FF00' },
      borders: { top: side('#00FF00') },
    });
    const same = para('Same list.', { borders: { top: side('#00FF00') } });
    const plain = para('Plain.', {});
    const bundle = await run(doc([other, same, plain], { styles: [boxed] }));
    const otherLines = blockLines(bundle, idOf(other)).join('\n');
    expect(otherLines).toContain('\\DEshade{00FF00}');
    expect(otherLines).toContain('\\DEbord{2}');
    // one list per distinct set of borders
    expect(blockLines(bundle, idOf(same)).join('\n')).toContain('\\DEbord{2}');
    expect(bundle.files['styles.tex']!.match(/\\DEdefborders\{/g)).toHaveLength(2);
    const plainLines = blockLines(bundle, idOf(plain)).join('\n');
    expect(plainLines).not.toContain('\\DEbord{');
    expect(plainLines).not.toContain('\\DEshade{');
  });

  it('writes no list for borders that are all off, and names a between border it does not draw', async () => {
    const off = para('Off.', { borders: { top: { style: 'none' }, bottom: null } });
    const between = para('Between.', {
      borders: { top: side('#000000'), between: side('#000000') },
    });
    const bundle = await run(doc([off, between]));
    expect(blockLines(bundle, idOf(off)).join('\n')).not.toContain('\\DEbord{');
    expect(bundle.files['styles.tex']).toContain('\\DEdefborders{1}{t:s:20:0:000000}');
    const d = bundle.diagnostics.find((x) => x.code === 'paragraph_border_between');
    expect(d?.blockId).toBe(idOf(between));
  });

  it('defines the macros in the class and the drawing in the Lua module', () => {
    const cls = readFileSync(join(classDir, 'docedit.cls'), 'utf8');
    const lua = readFileSync(join(classDir, 'docedit.lua'), 'utf8');
    for (const macro of ['DEshade', 'DEnoshade', 'DEbord', 'DEnobord', 'DEdefborders'])
      expect(cls, macro).toMatch(new RegExp(`\\\\newcommand\\*\\\\${macro}\\b`));
    expect(cls).toContain('\\DE@attr@shade=\\DE@shadev \\DE@attr@bord=\\DE@bord');
    expect(lua).toContain('function docedit.defborders(k, spec)');
    expect(lua).toContain('function docedit.decoration(para, w, h, d, first, last)');
    // the drawing is an artifact, so a tagged PDF does not read it
    expect(lua).toContain('"/Artifact BMC q"');
  });
});
