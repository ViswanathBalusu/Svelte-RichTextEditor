/**
 * EXP-032 criterion 3 (Node.js only): a right or decimal tab in justified text is set approximately,
 * and the job's diagnostics say so. Nothing here compiles; the diagnostic is read from the
 * converter's bundle.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';

const tabs = (align: string): J[] => [{ position: 2880, align, leader: 'none' }];
const body = (alignment: string, tabAlign: string | null): J =>
  para('', { align: alignment, ...(tabAlign === null ? {} : { tabs: tabs(tabAlign) }) }, [
    { type: 'text', text: 'Item' },
    { type: 'tab' },
    { type: 'text', text: '9.99' },
  ]);

const approx = (d: { code: string }): boolean => d.code === 'tab_approximate';

describe('EXP-032 criterion 3: right and decimal tabs in justified text are reported', () => {
  it.each(['right', 'decimal'])(
    'warns for a %s tab in a justified paragraph, naming the block',
    async (tabAlign) => {
      const p = body('justify', tabAlign);
      const b = await run(doc([p]));
      const d = b.diagnostics.find(approx);
      expect(d?.severity).toBe('warning');
      expect(d?.blockId).toBe((p['attrs'] as J)['id']);
    },
  );

  it('warns for a right tab in a distributed paragraph too', async () => {
    const b = await run(doc([body('distribute', 'right')]));
    expect(b.diagnostics.some(approx)).toBe(true);
  });

  it('does not warn for a left or centre tab in justified text', async () => {
    const b = await run(doc([body('justify', 'left'), body('justify', 'center')]));
    expect(b.diagnostics.some(approx)).toBe(false);
  });

  it('does not warn for a right tab in a paragraph that is not justified', async () => {
    const b = await run(doc([body('start', 'right')]));
    expect(b.diagnostics.some(approx)).toBe(false);
  });
});
