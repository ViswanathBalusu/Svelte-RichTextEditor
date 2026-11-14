/**
 * The converter's side of EXP-055 criterion 4 (Node.js only, no sandbox): every text run restarts
 * the class's counter with `\DEr{offset}`, an inline atom (an equation) counts as one unit, and an
 * anchor (a bookmark target) counts as zero. The class's Lua code counts inside a run; the run
 * offsets written here are what it starts from. The compile side is in
 * `exp-055-057-line-offsets.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, run, type J } from '../test/docs.ts';

describe('EXP-055 criterion 4 (converter side): atoms count one, anchors none', () => {
  it('starts the run after an inline equation one unit later, and the run after an anchor at the same offset', async () => {
    const pid = nid('p');
    const p: J = {
      type: 'paragraph',
      attrs: { id: pid },
      content: [
        { type: 'text', text: 'ab' },
        { type: 'equation', attrs: { latex: 'x^2' } },
        { type: 'text', text: 'cd' },
        { type: 'anchor', attrs: { id: nid('an'), name: 'exp-055-mark' } },
        { type: 'text', text: 'ef' },
      ],
    };
    const b = await run(doc([p]), {
      profile: 'preview',
      title: 'exp-055-offsets',
      instant: '2026-11-06T10:00:00.000Z',
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'line',
    } as never);
    const main = b.files['main.tex']!;
    // 'ab' at 0, the equation atom at 2 (one unit), 'cd' at 3, the anchor adds nothing, 'ef' at 5.
    expect(main).toMatch(/\\DEr\{0\}\{ab\}/);
    expect(main).toMatch(/\\DEa\{2\}\{/);
    expect(main).toMatch(/\\DEr\{3\}\{cd\}/);
    expect(main).toMatch(/\\DEr\{5\}\{ef\}/);
    expect(main).not.toMatch(/\\DEr\{6\}/);
  });
});
