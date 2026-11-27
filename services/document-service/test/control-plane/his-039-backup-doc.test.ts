// HIS-039 criterion 3: the operator document gives the rule for how long purged content stays in
// backups and the table the operator fills in for a deployment (owner decision 277: the operator
// sets the schedule and the retention; the product documents the rule and ships no figures).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(
  fileURLToPath(new URL('../../docs/purge-and-backups.md', import.meta.url)),
  'utf8',
);
const backups = doc.slice(doc.indexOf('## Backups'), doc.indexOf('## Thinning old payloads'));

describe('HIS-039 backups, documented for the operator', () => {
  it('states the rule: purge time plus the retention of the backup that holds the document', () => {
    expect(backups).toMatch(/purge time \+ the retention of your oldest backup/);
  });

  it('has a table for the backup frequency, the retention and the time to age out', () => {
    for (const row of [
      'Backup frequency',
      'Retention of backups',
      'Time to age out after a purge',
    ]) {
      expect(backups).toMatch(new RegExp(`^\\| ${row} \\|.*\\(operator fills in\\)`, 'm'));
    }
  });

  it('names owner decision 277 and ships no backup figure of its own', () => {
    expect(backups).toContain('owner decision 277');
    const rows = backups.split('\n').filter((l) => /^\| (Backup frequency|Retention of)/.test(l));
    for (const row of rows) expect(row).not.toMatch(/\d/);
  });

  it('says that a restore brings purged documents back and the purge must run again', () => {
    expect(backups).toMatch(/restored backup brings purged documents back/);
  });
});
