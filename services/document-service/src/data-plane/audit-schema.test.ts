/**
 * The shape of `audit_events` as migration 0031 writes it (BE-014 criteria 1, 2 and 4). These are
 * static checks of the migration text: that the table is partitioned by range on `at`, that the
 * service role can select and insert but holds no update or delete, that a trigger refuses both
 * for every role, that `data` is a small object, and that no column can hold document text.
 * Whether PostgreSQL refuses an update at run time, and whether the scheduled job of BE-052 creates
 * the partitions, are not covered here (they need a database and the scheduler); see the story.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../migrations/0031_audit_events.sql', import.meta.url), 'utf8')
  // Drop comment lines, then collapse whitespace and lower-case, so the checks read the statements.
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const table = /create table audit_events \((.*?)\) partition by range \(at\);/.exec(sql)?.[1] ?? '';

describe('audit_events shape (BE-014)', () => {
  it('is partitioned by range on at, with the tenant, time and identifier as its key (criterion 1)', () => {
    expect(table).not.toBe('');
    expect(sql).toMatch(/\) partition by range \(at\);/);
    expect(sql).toMatch(/primary key \(tenant_id, at, id\)/);
  });

  it('creates the monthly partitions with docedit_audit_partitions, which the service also calls (criterion 1)', () => {
    expect(sql).toMatch(
      /create function docedit_audit_partitions\(p_from timestamptz, p_months int\)/,
    );
    expect(sql).toMatch(/select docedit_audit_partitions\(now\(\) - interval '1 month', 5\);/);
    expect(sql).toMatch(
      /grant execute on function docedit_audit_partitions\(timestamptz, int\) to docedit_app;/,
    );
  });

  it('gives the service role select and insert only, with no update or delete grant (criterion 2)', () => {
    expect(sql).toMatch(/grant select, insert on audit_events to docedit_app;/);
    expect(sql).not.toMatch(/grant [a-z, ]*\b(update|delete)\b[a-z, ]* on audit_events/);
  });

  it('refuses update and delete for every role through a trigger (criterion 2)', () => {
    expect(sql).toMatch(
      /create trigger audit_events_append_only before update or delete on audit_events/,
    );
    expect(sql).toMatch(/raise exception 'audit_events is append-only'/);
  });

  it('keeps a small object in data and no column that can hold document text (criterion 4)', () => {
    expect(table).toMatch(
      /data jsonb not null check \(jsonb_typeof\(data\) = 'object' and octet_length\(data::text\) <= 4096\)/,
    );
    const columns = table
      .split(/,(?![^()]*\))/)
      .map((c) => c.trim().split(' ')[0])
      .filter((c): c is string => !!c && !['primary'].includes(c));
    expect(columns).toEqual(['id', 'tenant_id', 'doc_id', 'actor', 'kind', 'data', 'at']);
    for (const forbidden of ['text', 'content', 'body', 'steps', 'payload', 'message']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('protects the table as every tenant table is protected (BE-011)', () => {
    expect(sql).toMatch(/select docedit_protect\('audit_events'\);/);
  });
});
