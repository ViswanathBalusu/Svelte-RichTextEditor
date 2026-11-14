/**
 * A static guard for BE-016 criterion 4 (a migration on partitioned tables leaves the partition
 * count alone). The criterion is a runtime property and needs a database (see the story's Notes);
 * this test only checks the migration files: the hash-partition count of `doc_commits` and
 * `doc_commit_payloads` is set once, by the baseline (BE-008), and no later migration touches the
 * partitioning of those tables. It runs in the Node.js suite with the other migration checks.
 */
import { describe, expect, it } from 'vitest';
import { loadMigrations } from './migrate.ts';

const BASELINE = '0002_documents_and_log';

describe('hash partitioning of the log tables (BE-016 criterion 4, static guard)', () => {
  it('sets the partition count only in the baseline, with the BE-008 constant', async () => {
    const migrations = await loadMigrations();
    const setting = migrations.filter((m) => /partitions\s+constant\s+int\s*:=/i.test(m.sql));
    expect(setting.map((m) => m.version)).toEqual([BASELINE]);
    const sql = setting[0]!.sql;
    expect(sql).toMatch(/partitions\s+constant\s+int\s*:=\s*64\s*;/);
  });

  it('keeps later migrations off the partitioning of the log tables', async () => {
    const migrations = await loadMigrations();
    const later = migrations.filter((m) => m.version !== BASELINE);
    expect(later.length).toBeGreaterThan(0);
    const forbidden: [string, RegExp][] = [
      ['a hash partitioning', /partition\s+by\s+hash/i],
      ['an attach of a partition', /attach\s+partition/i],
      ['a detach of a partition', /detach\s+partition/i],
      ['a modulus', /\bmodulus\b/i],
      ['a drop of a log table', /drop\s+table[^;]*\bdoc_commit(s|_payloads)?\b/i],
      ['a rename of a log table', /alter\s+table[^;]*\bdoc_commit(s|_payloads)?\b[^;]*rename/i],
    ];
    const hits: string[] = [];
    for (const m of later)
      for (const [what, re] of forbidden) if (re.test(m.sql)) hits.push(`${m.version}: ${what}`);
    expect(hits).toEqual([]);
  });

  it('partitions the two log tables in the baseline and nowhere else', async () => {
    const migrations = await loadMigrations();
    const creators = migrations
      .filter((m) => /partition\s+by\s+hash\s*\(\s*doc_id\s*\)/i.test(m.sql))
      .map((m) => m.version);
    expect(creators).toEqual([BASELINE]);
    const base = migrations.find((m) => m.version === BASELINE)!.sql;
    expect(base).toMatch(
      /create\s+table\s+doc_commits\b[\s\S]*?partition\s+by\s+hash\s*\(\s*doc_id\s*\)/i,
    );
    expect(base).toMatch(
      /create\s+table\s+doc_commit_payloads\b[\s\S]*?partition\s+by\s+hash\s*\(\s*doc_id\s*\)/i,
    );
  });
});
