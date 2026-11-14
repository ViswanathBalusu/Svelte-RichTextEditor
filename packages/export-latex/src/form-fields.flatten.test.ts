/**
 * Form fields flattened into the PDF (Node.js only): EXP-033 criteria 1, 3, 4 and 5. The tests read
 * main.tex of the converter's bundle through `blockLines`; nothing here compiles, so the printed
 * PDF is not inspected. Criteria 2 (checkbox glyph through `enumLookup`), 6 (a value wider than its
 * field), 7 (values at a `seq`) and 8 (no live PDF form fields in the PDF) are not covered here
 * (see the story's Notes in docs/stories/EXP-export.md).
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { dimen, kvValue, text } from './emit.ts';

/** The id of a paragraph built by `para`. */
const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

/** A `form_field` inline node with a fixed width of 2880 twips (144 pt). */
function field(key: string, kind: string, attrs: J = {}): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind, label: `Label ${key}`, width: 2880, value: null, ...attrs },
  };
}

/** The line of main.tex that holds the flattened field `\DEff` of the given block. */
function fieldLine(lines: string[]): string {
  const line = lines.find((l) => l.includes('\\DEff{'));
  if (line === undefined) throw new Error('no flattened field in the block');
  return line;
}

const BOX = `${dimen(2880)}`;

describe('EXP-033 flattened form-field values (criterion 1: text, number, date, checkbox, choice)', () => {
  it('writes a text value at the fixed width, tagged with its label, and an empty field as blank of that width', async () => {
    const filled = para('Name: ', {}, [field('name', 'text', { value: 'Ada Lovelace' })]);
    const empty = para('Ref: ', {}, [field('ref', 'text', { label: 'Ref' })]);
    const b = await run(doc([filled, empty]));
    const f = fieldLine(blockLines(b, idOfPara(filled)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Label name')}}{${text('Ada Lovelace')}}`);
    const e = fieldLine(blockLines(b, idOfPara(empty)));
    expect(e).toContain(`\\DEff{1}{${BOX}}{${kvValue('Ref')}}{${text('')}}`);
  });

  it('writes a number with its decimals, prefix and suffix, a date as stored, a choice by label and a checkbox as a glyph', async () => {
    const amount = para('', {}, [
      field('amount', 'number', {
        value: '1234.5',
        format: { decimals: 2, prefix: 'USD ', suffix: ' net' },
      }),
    ]);
    const when = para('', {}, [field('when', 'date', { value: '2026-03-05' })]);
    const colour = para('', {}, [
      field('colour', 'choice', {
        value: 'r',
        options: [
          { id: 'r', label: 'Red' },
          { id: 'g', label: 'Green' },
        ],
      }),
    ]);
    const agree = para('', {}, [field('agree', 'checkbox', { value: true })]);
    const b = await run(doc([amount, when, colour, agree]));
    expect(fieldLine(blockLines(b, idOfPara(amount)))).toContain(`{${text('USD 1234.50 net')}}`);
    expect(fieldLine(blockLines(b, idOfPara(when)))).toContain(`{${text('2026-03-05')}}`);
    expect(fieldLine(blockLines(b, idOfPara(colour)))).toContain(`{${text('Red')}}`);
    expect(fieldLine(blockLines(b, idOfPara(agree)))).toContain(`{${text('☒')}}`);
  });
});

describe('EXP-033 criterion 3: a formValue field prints the flattened value of its target', () => {
  it('prints the value of the form field named by the target key', async () => {
    const p = para('Echo: ', {}, [
      field('name', 'text', { value: 'Ada' }),
      { type: 'field', attrs: { id: nid('fl'), kind: 'formValue', target: 'field:name' } },
    ]);
    const b = await run(doc([p]));
    const line = blockLines(b, idOfPara(p)).join('\n');
    // The form field is the atom at offset 6, the formValue field the atom at offset 7.
    expect(line).toContain(`\\DEa{7}{${text('Ada')}}`);
  });

  it('prints nothing for the target when fields are blank (criterion 4 for the formValue case)', async () => {
    const p = para('Echo: ', {}, [
      field('name', 'text', { value: 'Ada' }),
      { type: 'field', attrs: { id: nid('fl'), kind: 'formValue', target: 'field:name' } },
    ]);
    const b = await run(doc([p]), { fields: 'blank' });
    const line = blockLines(b, idOfPara(p)).join('\n');
    expect(line).not.toContain('Ada');
    expect(line).toContain(`\\DEa{7}{}`);
  });
});

describe('EXP-033 criterion 4: fields blank prints the fields without their values', () => {
  it('writes the label and width with an empty body', async () => {
    const p = para('Name: ', {}, [field('name', 'text', { value: 'Ada Lovelace' })]);
    const b = await run(doc([p]), { fields: 'blank' });
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`\\DEff{1}{${BOX}}{${kvValue('Label name')}}{}`);
    expect(f).not.toContain('Ada');
  });
});

describe('EXP-033 criterion 5: a value with TeX special characters goes through the text emitter', () => {
  it('writes the value exactly as the text emitter writes it, so it prints literally', async () => {
    const hostile = '\\input{x} $&#_%^~{}';
    const p = para('', {}, [field('raw', 'text', { value: hostile })]);
    const b = await run(doc([p]));
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`{${text(hostile)}}`);
    expect(f).not.toContain(`{${hostile}}`);
    expect(f).not.toMatch(/\\input\{/);
  });
});
