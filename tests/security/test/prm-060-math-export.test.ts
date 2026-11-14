/**
 * PRM-060 criterion 1 (07 §16 threat row 1; 09 §6.3; EXP-049; invariant I8): an equation that is
 * oversized, or that paints outside its box to cover another region in the PDF, is bounded and
 * cleaned when the document is exported. Lane U-PRM-052-067. This file is in the security pack,
 * so the pack runs the export path of EXP-049 as well as the gate of SEC-034.
 *
 * The converter runs the gate on every equation (`blocks.ts`). A refused equation is replaced by a
 * placeholder and warns `math_refused`; none of its LaTeX reaches any file of the bundle. Node.js
 * only: nothing is compiled here (the compile test is in the sandbox suite).
 */
import { describe, expect, it } from 'vitest';
import {
  blockLines,
  codes,
  doc,
  nid,
  run,
  type J,
} from '../../../packages/export-latex/test/docs.ts';

const CLASS_FILES = { 'docedit.cls': '% class\n', 'docedit.lua': '-- lua\n' };

function display(id: string, latex: string): J {
  return { type: 'equation_block', attrs: { id, latex, numbered: false } };
}

function allText(files: Record<string, unknown>): string {
  return Object.values(files)
    .map((v) => (typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array)))
    .join('\n');
}

describe('PRM-060 criterion 1: a painting or oversized equation is bounded and cleaned at export', () => {
  const refused: Array<[string, string]> = [
    ['a paint command that covers another region', '\\rlap{\\rule{20cm}{20cm}} x'],
    ['an oversized horizontal space', 'a\\hspace{500cm}b'],
  ];

  for (const [name, latex] of refused) {
    it(`replaces ${name} by a placeholder, warns math_refused, and writes none of its LaTeX`, async () => {
      const id = nid('e');
      const b = await run(doc([display(id, latex)]), { classFiles: CLASS_FILES });
      expect(codes(b)).toContain('math_refused');
      expect(blockLines(b, id).join('\n')).toContain('DEplaceholder');
      const text = allText(b.files as Record<string, unknown>);
      expect(text).not.toContain('\\rlap');
      expect(text).not.toContain('\\hspace{500cm}');
    });
  }

  it('lets a plain equation through and warns nothing', async () => {
    const id = nid('e');
    const b = await run(doc([display(id, 'a+b=c')]), { classFiles: CLASS_FILES });
    expect(codes(b)).not.toContain('math_refused');
    expect(blockLines(b, id).join('\n')).toContain('a+b=c');
  });
});
