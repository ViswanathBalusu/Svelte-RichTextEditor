/**
 * Acting on an accessibility issue (UX-067, criteria 2 and 3). Each kind of issue offers one field or
 * command, and an issue in a scope this user cannot change is marked as not fixable, with the people
 * who can fix it (UX-004; 07 section 4).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHECK_KINDS, type CheckIssue, type CheckKind } from '../src/shell/accessibility-check.ts';
import { FIX_FOR, fixability, type FixAccess } from '../src/shell/accessibility-fix.ts';

const kind: fc.Arbitrary<CheckKind> = fc.constantFrom(...CHECK_KINDS);
const blockId = fc.uuid();
const words = fc.string({ maxLength: 40 });

describe('each kind of issue offers a fix (UX-067, criterion 2)', () => {
  it('maps every kind of the checker to one named field or command', () => {
    expect(Object.keys(FIX_FOR).sort()).toEqual([...CHECK_KINDS].sort());
    expect(FIX_FOR).toEqual({
      'alt-text': 'picture.altText',
      'table-header': 'table.headerRow',
      'link-text': 'link.text',
      'heading-order': 'style.headingLevel',
      contrast: 'format.colour',
    });
  });

  it('offers the fix for the issue kind when the user may edit the block (property)', () => {
    fc.assert(
      fc.property(kind, blockId, (k, id) => {
        const issue: CheckIssue = { kind: k, blockId: id, detail: {} };
        const access: FixAccess = { mayEdit: () => true, whoCanFix: () => 'never asked' };
        expect(fixability(issue, access)).toEqual({ fixable: true, fix: FIX_FOR[k], blockId: id });
      }),
    );
  });
});

describe('fixability relays the access it is given (UX-067, criterion 3; the scope wiring is in accessibility-run.test.ts)', () => {
  it('is not fixable by this user and carries the words for who can fix it (property)', () => {
    fc.assert(
      fc.property(kind, blockId, words, (k, id, who) => {
        const issue: CheckIssue = { kind: k, blockId: id, detail: {} };
        const access: FixAccess = {
          mayEdit: (b) => b !== id,
          whoCanFix: (b) => (b === id ? who : ''),
        };
        expect(fixability(issue, access)).toEqual({
          fixable: false,
          fix: FIX_FOR[k],
          blockId: id,
          who,
        });
      }),
    );
  });
});
