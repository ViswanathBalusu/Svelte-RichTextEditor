/**
 * Block changes other than paragraphs, rows and tables are unavailable in suggestion mode, and say
 * why (FE-044 criterion 5; 02 §5.2; 03 §5). The core is headless, in review mode, for `alice`, and
 * the commands run through `queryCommand` and `run` as the element runs them. The document must not
 * change when `run` refuses.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { editorAccess } from './fixtures.ts';
import { microtask } from './support.ts';

const BLOCK_COMMANDS = ['insertSectionBreak', 'insertToc', 'markRegion'] as const;

function core(mode: 'edit' | 'review'): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc: spikeDocument(),
    schedule: microtask,
    mode,
    user: 'alice',
    access: editorAccess(),
    generateId: () => `b${String(++n).padStart(15, '0')}`,
  });
}

describe('FE-044 criterion 5: block changes are unavailable in suggestion mode', () => {
  it('queryCommand says `suggestion` for a block command in review mode and not in edit mode', () => {
    const review = core('review');
    for (const name of BLOCK_COMMANDS) {
      expect(review.queryCommand(name)).toEqual({
        enabled: false,
        active: false,
        reason: 'suggestion',
      });
    }
    const edit = core('edit');
    for (const name of BLOCK_COMMANDS) {
      expect(edit.queryCommand(name).reason).not.toBe('suggestion');
    }
  });

  it('run refuses a block command in review mode and the document does not change', () => {
    const c = core('review');
    const before = JSON.stringify(c.getContent());
    for (const name of BLOCK_COMMANDS) {
      expect(c.run(name)).toBe(false);
    }
    expect(JSON.stringify(c.getContent())).toBe(before);
  });
});
