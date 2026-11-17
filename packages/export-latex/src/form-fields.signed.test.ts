/**
 * EXP-034 criteria 2 to 4 (Node.js only): a dateSigned field prints the date the server stored, a
 * formula field prints its stored value, and an empty signature field prints a labelled empty box of
 * the field's width. The tests read main.tex of the converter's bundle through `blockLines`; nothing
 * compiles here. Criterion 1 (the signature picture) is in `exp-034-signature.test.ts`.
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

describe('EXP-034 criterion 2: a dateSigned field prints the date the server stored', () => {
  const dated = (value: string | null, attrs: J = {}): J =>
    para('Signed on ', {}, [field('on', 'dateSigned', { label: 'Signed on', value, ...attrs })]);

  it('prints the stored date as it is, whatever time zone or instant the job names', async () => {
    const p = dated('2026-12-31');
    // A job time zone far from UTC must not move the stored date: the server already set it in the workflow's zone.
    const b = await run(doc([p]), {
      instant: '2026-12-31T23:30:00.000Z',
      timeZone: 'Pacific/Kiritimati',
    });
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Signed on')}}{${text('2026-12-31')}}`);
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(false);
  });

  it('prints no date when none is stored: neither the instant of the job nor a client date is used', async () => {
    const p = dated(null);
    const b = await run(doc([p]), { instant: '2026-06-01T10:00:00.000Z', timeZone: 'UTC' });
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`{${text('')}}`);
    expect(f).not.toContain('2026');
  });

  it('does not reformat the stored date with a date pattern of the field', async () => {
    const p = dated('2026-11-06', { format: { datePattern: 'dd MMMM yyyy' } });
    const b = await run(doc([p]));
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`{${text('2026-11-06')}}`);
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
