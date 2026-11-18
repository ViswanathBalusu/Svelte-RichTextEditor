/**
 * UX-040 criterion 5, the help-text half: every user-facing text that names an output restriction
 * says that restrictions deter casual copying and are not a security boundary (13 section 3). The
 * integration guide's half is in apps/reference-host/test/integration-guide.restrictions.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';

const KEYS = ['reason.query.no-export', 'reason.query.no-print', 'notice.refused.noCopy'] as const;

describe('restriction texts (UX-040 criterion 5)', () => {
  for (const key of KEYS) {
    it(`${key} says restrictions are not a security boundary`, () => {
      const text = EN_GB[key];
      expect(text).toContain('Restrictions deter casual copying');
      expect(text).toContain('not a security boundary');
    });
  }

  it('the reasons still name the refused action', () => {
    expect(EN_GB['reason.query.no-export']).toMatch(/does not allow export/);
    expect(EN_GB['reason.query.no-print']).toMatch(/does not allow printing/);
  });
});
