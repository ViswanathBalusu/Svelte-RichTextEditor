/**
 * EXP-034 criteria 3 and 4 (Node.js only): a formula field prints its stored value, and an empty
 * signature field prints a labelled empty box of the field's width. The tests read main.tex of the
 * converter's bundle through `blockLines`; nothing compiles here. Criterion 1 (the signature picture
 * from the asset) and criterion 2 (the signing date in the workflow's time zone) are not covered:
 * the converter prints a signature as a `form_value_not_printed` warning, and a date as its stored
 * string (see the story's Notes in docs/stories/EXP-export.md).
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { dimen, kvValue, text } from './emit.ts';

const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

function field(key: string, kind: string, attrs: J = {}): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind, label: `Label ${key}`, width: 2880, value: null, ...attrs },
  };
}

function fieldLine(lines: string[]): string {
  const line = lines.find((l) => l.includes('\\DEff{'));
  if (line === undefined) throw new Error('no flattened field in the block');
  return line;
}

const BOX = `${dimen(2880)}`;

describe('EXP-034 criterion 3: a formula field prints its stored value', () => {
  it('prints the stored value of a formula field at the field width, tagged with its label', async () => {
    const p = para('Total: ', {}, [
      field('total', 'formula', { label: 'Total', value: '1,234.50' }),
    ]);
    const b = await run(doc([p]));
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Total')}}{${text('1,234.50')}}`);
  });

  it('prints an empty formula field as blank, not as a placeholder', async () => {
    const p = para('Total: ', {}, [field('total', 'formula', { label: 'Total', value: null })]);
    const b = await run(doc([p]));
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Total')}}{${text('')}}`);
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(false);
  });
});

describe('EXP-034 criterion 4: an empty signature field prints a labelled empty box of its width', () => {
  it('writes the field macro with the label, the width and no value', async () => {
    const p = para('Signed: ', {}, [
      field('sig', 'signature', { label: 'Signature of the tenant', value: null }),
    ]);
    const b = await run(doc([p]));
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Signature of the tenant')}}{${text('')}}`);
  });

  it('does the same for an empty initials field, and reports no value warning for it', async () => {
    const p = para('Initials: ', {}, [
      field('ini', 'initials', { label: 'Initials', value: null }),
    ]);
    const b = await run(doc([p]));
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Initials')}}{${text('')}}`);
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(false);
  });
});
