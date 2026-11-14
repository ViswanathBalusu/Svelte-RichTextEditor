/**
 * EXP-033 criterion 2, the checkbox part (Node.js only): a checkbox prints a glyph that the value
 * selects through the fixed table of `enumLookup`; the value itself is never written. Documents come
 * from `test/docs.ts`, and the tests read main.tex through `blockLines`.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { text } from './emit.ts';

/** A `form_field` inline node of kind checkbox with the given value. */
function checkbox(value: unknown): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key: 'agree', kind: 'checkbox', label: 'Agree', width: 2880, value },
  };
}

const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

describe('EXP-033 criterion 2: a checkbox glyph is chosen through the fixed table', () => {
  it('prints the checked glyph for true and the unchecked glyph for false', async () => {
    const yes = para('', {}, [checkbox(true)]);
    const no = para('', {}, [checkbox(false)]);
    const b = await run(doc([yes, no]));
    expect(blockLines(b, idOfPara(yes)).join('\n')).toContain(text('☒'));
    expect(blockLines(b, idOfPara(no)).join('\n')).toContain(text('☐'));
    expect(blockLines(b, idOfPara(no)).join('\n')).not.toContain(text('☒'));
  });

  it('prints nothing for an empty value, as before the table', async () => {
    const empty = para('', {}, [checkbox(null)]);
    const b = await run(doc([empty]));
    const line = blockLines(b, idOfPara(empty)).join('\n');
    expect(line).not.toContain('☒');
    expect(line).not.toContain('☐');
  });

  it('never writes a value that is not a boolean, and prints the unchecked glyph for it', async () => {
    const odd = para('', {}, [checkbox('<script>\\write18{x}')]);
    const b = await run(doc([odd]));
    const line = blockLines(b, idOfPara(odd)).join('\n');
    expect(line).toContain(text('☐'));
    expect(line).not.toContain('write18');
    expect(line).not.toContain('script');
  });

  it('prints the glyph through a formValue field that targets a checkbox', async () => {
    const p = para('Echo: ', {}, [
      checkbox(true),
      { type: 'field', attrs: { id: nid('fl'), kind: 'formValue', target: 'field:agree' } },
    ]);
    const b = await run(doc([p]));
    expect(blockLines(b, idOfPara(p)).join('\n')).toContain(`\\DEa{7}{${text('☒')}}`);
  });
});
