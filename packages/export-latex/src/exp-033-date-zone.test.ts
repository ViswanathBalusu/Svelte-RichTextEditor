/**
 * EXP-033 criterion 2, the date part (Node.js only; no compile): a `date` field is a calendar day,
 * so its pattern is applied to the stored day in UTC whatever time zone the export job names
 * (owner decision 148 of 2026-11-15, ADR 0045 q5). The zone must not move the day, even a zone far
 * east or west of UTC.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { text } from './emit.ts';

function dateField(value: string, datePattern: string): J {
  return {
    type: 'form_field',
    attrs: {
      id: nid('ff'),
      key: 'when',
      kind: 'date',
      label: 'When',
      width: 2880,
      value,
      format: { datePattern },
    },
  };
}

const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

describe('EXP-033 criterion 2: a date field prints the stored day in UTC', () => {
  for (const timeZone of [
    'UTC',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'America/Los_Angeles',
  ]) {
    it(`prints 05/03/2026 for the stored day 2026-03-05 in the job zone ${timeZone}`, async () => {
      const p = para('', {}, [dateField('2026-03-05', 'dd/MM/yyyy')]);
      const b = await run(doc([p]), {
        instant: '2026-03-05T23:30:00.000Z',
        timeZone,
      });
      const line = blockLines(b, idOfPara(p)).join('\n');
      expect(line).toContain(text('05/03/2026'));
      expect(line).not.toContain('2026-03-05');
    });
  }

  it('prints the stored form when there is no pattern', async () => {
    const p = para('', {}, [dateField('2026-03-05', '')]);
    const b = await run(doc([p]), { timeZone: 'Pacific/Kiritimati' });
    expect(blockLines(b, idOfPara(p)).join('\n')).toContain('2026-03-05');
  });
});
